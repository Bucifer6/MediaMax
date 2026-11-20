/**
 * Bandwidth probe: a timed download of random bytes from GET /playback/bandwidth-test, sized so it takes about half a
 * second, plus the last measurement remembered per server and network (localStorage), so playback can start at a
 * fitting quality without waiting.
 */
import { getToken } from '../api/client';

const KEY = 'mm.bandwidth';
/** A remembered measurement younger than this is used without probing again. */
export const FRESH_MS = 10 * 60 * 1000;

interface Stored {
  bps: number;
  at: number;
}

/** Network identity for the cache: server origin + connection type, when the browser exposes it. */
function networkKey(): string {
  const c = (navigator as unknown as { connection?: { type?: string; effectiveType?: string } }).connection;
  return `${window.location.origin}|${c?.type ?? ''}|${c?.effectiveType ?? ''}`;
}

function readAll(): Record<string, Stored> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Stored>;
  } catch {
    return {};
  }
}

export function rememberedBandwidth(maxAgeMs = FRESH_MS): number | null {
  const s = readAll()[networkKey()];
  return s && Date.now() - s.at < maxAgeMs && s.bps > 0 ? s.bps : null;
}

export function rememberBandwidth(bps: number) {
  if (!(bps > 0)) return;
  try {
    const all = readAll();
    all[networkKey()] = { bps: Math.round(bps), at: Date.now() };
    // Keep the 8 most recent networks.
    const entries = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 8);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* storage blocked */
  }
}

async function timedDownload(bytes: number, signal?: AbortSignal): Promise<{ bytes: number; ms: number }> {
  const token = getToken();
  const res = await fetch(`/api/v1/playback/bandwidth-test?bytes=${bytes}&_=${Date.now()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    cache: 'no-store',
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Bandwidth test failed (${res.status})`);
  // Time from the first body byte to the last, so server latency doesn't count as slow throughput.
  const reader = res.body.getReader();
  let got = 0;
  let first = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!first) first = performance.now();
    got += value.byteLength;
  }
  return { bytes: got, ms: Math.max(1, performance.now() - first) };
}

/**
 * Measure throughput (bits/s): a small warm-up request, then one sized to take ~0.6 s at the warm-up rate (capped).
 * Total time stays around a second even on slow links. Remembers the result.
 */
export async function measureBandwidth(opts: { targetMs?: number; maxBytes?: number; signal?: AbortSignal } = {}): Promise<number> {
  const targetMs = opts.targetMs ?? 600;
  const maxBytes = opts.maxBytes ?? 16 * 1024 * 1024;
  const warm = await timedDownload(96 * 1024, opts.signal);
  let bps = (warm.bytes * 8 * 1000) / warm.ms;
  // A warm-up that took most of the budget is measurement enough (slow link).
  if (warm.ms < targetMs / 2) {
    const size = Math.max(128 * 1024, Math.min(maxBytes, Math.round(((bps / 8) * targetMs) / 1000)));
    const main = await timedDownload(size, opts.signal);
    bps = (main.bytes * 8 * 1000) / main.ms;
  }
  rememberBandwidth(bps);
  return bps;
}

/** Remembered value when fresh, else a probe (time-boxed: falls back to a stale value or null). */
export async function initialBandwidth(timeoutMs = 2500): Promise<{ bps: number | null; source: 'remembered' | 'probe' | 'none' }> {
  const fresh = rememberedBandwidth();
  if (fresh) return { bps: fresh, source: 'remembered' };
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return { bps: await measureBandwidth({ signal: ctrl.signal }), source: 'probe' };
  } catch {
    const stale = rememberedBandwidth(Infinity);
    return { bps: stale, source: stale ? 'remembered' : 'none' };
  } finally {
    window.clearTimeout(t);
  }
}
