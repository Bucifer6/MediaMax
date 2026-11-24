/**
 * Ordered provider chains with silent fallback (Admin → AI): every language-model and speech call tries the enabled
 * providers in order. A provider that fails (network error, timeout, 5xx, 429, 401/402/403 auth or quota, unusable
 * output) cools down — 1 → 5 → 15 → 60 min, or the server's Retry-After — and the next one is tried; after the last,
 * the caller's built-in fallback runs (templates / device voice / no talk). Nothing is ever thrown at listeners:
 * failures are logged and kept as provider health and a fallback log for the admin page.
 */
import type { AiFallbackEvent, AiProviderHealth } from '@mediamax/shared';
import { logger } from '../../util/log.js';

const log = logger('ai');

/** A provider call failed in a way that should move on to the next provider. */
export class ProviderError extends Error {
  constructor(message: string, readonly status?: number, readonly retryAfterMs?: number) {
    super(message);
  }
}

/** Retry-After (seconds or an HTTP date) in ms, capped at a day. */
export function retryAfterMs(h: string | null | undefined, now = Date.now()): number | undefined {
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s) && s >= 0) return Math.min(86400000, s * 1000);
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, Math.min(86400000, t - now)) : undefined;
}

/** Throw a ProviderError for a non-2xx response (with a short, key-free reason). */
export async function checkResponse(res: Response): Promise<Response> {
  if (res.ok) return res;
  const body = await res.text().catch(() => '');
  const detail = body.replace(/\s+/g, ' ').slice(0, 160);
  const kind = res.status === 429 ? 'rate limited' : res.status === 401 || res.status === 403 ? 'not authorised' : res.status === 402 ? 'quota / payment' : res.status >= 500 ? 'server error' : 'rejected';
  throw new ProviderError(`HTTP ${res.status} (${kind})${detail ? `: ${detail}` : ''}`, res.status, retryAfterMs(res.headers.get('retry-after')));
}

const COOLDOWN_MIN = [1, 5, 15, 60];

interface State {
  failures: number;
  cooldownUntil: number;
  lastError?: string;
  lastErrorAt?: number;
  lastUsedAt?: number;
  /** Success timestamps (last 24 h). */
  ok: number[];
  day: string;
  today: number;
  name: string;
}

const states = new Map<string, State>();
const events: AiFallbackEvent[] = [];
const lastSkipLog = new Map<string, number>();
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

function state(kind: 'llm' | 'tts', id: string, name: string): State {
  const k = `${kind}:${id}`;
  let s = states.get(k);
  if (!s) states.set(k, (s = { failures: 0, cooldownUntil: 0, ok: [], day: '', today: 0, name }));
  s.name = name;
  return s;
}

export interface ChainProvider {
  id: string;
  name: string;
  enabled: boolean;
  dailyCap?: number | null;
}

export interface ChainOptions {
  /** Feature name for the fallback log. */
  feature: string;
  /** Explicit admin test: ignore cooldown and caps, don't record health changes as fallbacks. */
  force?: boolean;
  now?: () => number;
}

function record(e: AiFallbackEvent) {
  events.unshift(e);
  if (events.length > 200) events.length = 200;
}

/**
 * Run `call` against each usable provider in order until one returns a value. Returns null when every provider
 * failed or was skipped (the caller then uses its built-in fallback). Never throws.
 */
export async function runChain<P extends ChainProvider, T>(
  kind: 'llm' | 'tts', providers: P[], call: (p: P) => Promise<T | null>, opts: ChainOptions,
): Promise<{ value: T; provider: P } | null> {
  const now = opts.now ?? Date.now;
  const misses: { from: string; reason: string; quiet: boolean }[] = [];
  const flush = (to: string) => {
    for (const m of misses) {
      if (m.quiet) {
        // Skips (cooling down, daily cap) are logged at most once a minute per provider and reason.
        const k = `${kind}:${m.from}:${m.reason}`;
        if ((lastSkipLog.get(k) ?? 0) > now() - 60000) continue;
        lastSkipLog.set(k, now());
      }
      record({ at: new Date(now()).toISOString(), feature: opts.feature, from: m.from, to, reason: m.reason });
    }
    misses.length = 0;
  };
  for (const p of providers) {
    if (!p.enabled) continue;
    const s = state(kind, p.id, p.name);
    const t = now();
    if (s.day !== dayOf(t)) {
      s.day = dayOf(t);
      s.today = 0;
    }
    if (!opts.force) {
      if (s.cooldownUntil > t) {
        misses.push({ from: p.id, reason: 'cooling down', quiet: true });
        continue;
      }
      if (p.dailyCap && s.today >= p.dailyCap) {
        misses.push({ from: p.id, reason: 'daily cap reached', quiet: true });
        continue;
      }
    }
    flush(p.id);
    let value: T | null = null;
    let err: ProviderError | null = null;
    try {
      s.today++;
      value = await call(p);
      if (value == null) err = new ProviderError('invalid output');
    } catch (e) {
      const x = e as Error & { name?: string };
      err = e instanceof ProviderError ? e : new ProviderError(x.name === 'TimeoutError' || x.name === 'AbortError' ? 'timeout' : `network error: ${x.message}`.slice(0, 200));
    }
    const at = now();
    s.lastUsedAt = at;
    if (!err && value != null) {
      s.failures = 0;
      s.cooldownUntil = 0;
      s.ok.push(at);
      if (s.ok.length > 20000 || (s.ok[0] ?? at) < at - 86400000) s.ok = s.ok.filter((x) => x > at - 86400000);
      return { value, provider: p };
    }
    s.failures++;
    s.lastError = err!.message;
    s.lastErrorAt = at;
    // Auth / quota problems won't fix themselves in a minute: start further up the back-off.
    const step = Math.min(COOLDOWN_MIN.length - 1, s.failures - 1 + (err!.status === 401 || err!.status === 402 || err!.status === 403 ? 2 : 0));
    const backoff = COOLDOWN_MIN[step] * 60000;
    s.cooldownUntil = at + Math.max(backoff, err!.retryAfterMs ?? 0);
    const msg = `${kind === 'llm' ? 'Language model' : 'Speech'} provider "${p.name}" failed (${err!.message}); cooling down for ${Math.round((s.cooldownUntil - at) / 60000)} min, trying the next one`;
    if (opts.force) log.info(msg);
    else log.warn(msg);
    if (!opts.force) misses.push({ from: p.id, reason: err!.message.slice(0, 120), quiet: false });
  }
  if (misses.some((m) => !m.quiet)) log.info(`${opts.feature}: every ${kind === 'llm' ? 'language model' : 'voice'} failed or is cooling down; using the built-in fallback`);
  flush('builtin');
  return null;
}

/** Health of the configured providers (in chain order). */
export function providerHealth(kind: 'llm' | 'tts', providers: ChainProvider[], now = Date.now()): AiProviderHealth[] {
  return providers.map((p) => {
    const s = states.get(`${kind}:${p.id}`);
    const iso = (t?: number) => (t ? new Date(t).toISOString() : undefined);
    const cooling = !!s && s.cooldownUntil > now;
    return {
      id: p.id, kind, name: p.name,
      ok: p.enabled && !cooling && !(s && s.failures > 0 && !cooling && (s.lastErrorAt ?? 0) > (s.ok[s.ok.length - 1] ?? 0)),
      ...(s?.lastError ? { lastError: s.lastError, lastErrorAt: iso(s.lastErrorAt) } : {}),
      ...(cooling ? { cooldownUntil: iso(s!.cooldownUntil) } : {}),
      ...(s?.lastUsedAt ? { lastUsedAt: iso(s.lastUsedAt) } : {}),
      calls24h: s ? s.ok.filter((x) => x > now - 86400000).length : 0,
      callsToday: s && s.day === dayOf(now) ? s.today : 0,
    };
  });
}

export const fallbackEvents = (): AiFallbackEvent[] => events.slice(0, 200);

/** Tests: forget all health and events. */
export function resetChainState() {
  states.clear();
  events.length = 0;
  lastSkipLog.clear();
}
