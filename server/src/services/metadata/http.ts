import crypto from 'node:crypto';
import type { MetadataProviderId } from '@mediamax/shared';
import { db } from '../../db.js';
import { config } from '../../config.js';
import { logger } from '../../util/log.js';
import { sleep } from '../../util/misc.js';

const log = logger('metadata-http');

/**
 * Outbound HTTP for the built-in metadata providers: one place for base URLs (overridable for tests),
 * the User-Agent, timeouts, per-provider rate limits, retries on 429/503 and the response cache.
 */

const DEFAULT_BASE: Record<string, string> = {
  tvdb: 'https://api4.thetvdb.com/v4',
  fanart: 'https://webservice.fanart.tv/v3',
  audiodb: 'https://www.theaudiodb.com/api/v1/json',
  audnexus: 'https://api.audnex.us',
  openlibrary: 'https://openlibrary.org',
  openlibraryCovers: 'https://covers.openlibrary.org',
  googlebooks: 'https://www.googleapis.com/books/v1',
  lrclib: 'https://lrclib.net/api',
  omdb: 'https://www.omdbapi.com',
  musicbrainz: 'https://musicbrainz.org/ws/2',
  coverart: 'https://coverartarchive.org',
};

/** Env overrides, e.g. MEDIAMAX_TVDB_API_BASE (used by tests and for self-hosted mirrors). */
const ENV: Record<string, string> = {
  tvdb: 'MEDIAMAX_TVDB_API_BASE',
  fanart: 'MEDIAMAX_FANART_API_BASE',
  audiodb: 'MEDIAMAX_AUDIODB_API_BASE',
  audnexus: 'MEDIAMAX_AUDNEXUS_API_BASE',
  openlibrary: 'MEDIAMAX_OPENLIBRARY_API_BASE',
  openlibraryCovers: 'MEDIAMAX_OPENLIBRARY_COVERS_BASE',
  googlebooks: 'MEDIAMAX_GOOGLEBOOKS_API_BASE',
  lrclib: 'MEDIAMAX_LRCLIB_API_BASE',
  omdb: 'MEDIAMAX_OMDB_API_BASE',
  musicbrainz: 'MEDIAMAX_MUSICBRAINZ_API_BASE',
  coverart: 'MEDIAMAX_COVERART_API_BASE',
};

/** Minimum gap between two requests to the same service (client-side rate limit). */
const MIN_INTERVAL_MS: Record<string, number> = {
  tvdb: 100,
  fanart: 100,
  audiodb: 2000, // free tier: 30 requests/minute
  audnexus: 150,
  openlibrary: 400,
  googlebooks: 200,
  lrclib: 100,
  omdb: 100, // plus the 1,000 requests/day cap below
  musicbrainz: 1100, // MusicBrainz: max 1 request/second per client
  coverart: 250,
};

/** Hard daily caps of free tiers (counted per server process). */
const DAILY_CAP: Record<string, number> = { omdb: 1000 };

const overrides: Record<string, { base?: string; minIntervalMs?: number }> = {};

/** Internal: override a provider's base URL and/or rate limit (tests). */
export function setProviderHttpOptions(id: string, o: { base?: string; minIntervalMs?: number } | null) {
  if (o) overrides[id] = { ...overrides[id], ...o };
  else delete overrides[id];
}

export const baseUrl = (id: string): string => (overrides[id]?.base ?? process.env[ENV[id]] ?? DEFAULT_BASE[id]).replace(/\/+$/, '');

/** MusicBrainz and Open Library ask clients to identify themselves; no user data goes in here. */
export const userAgent = () => `MediaMax/${config.version} ( self-hosted media server )`;

const gates = new Map<string, Promise<unknown>>();
const lastAt = new Map<string, number>();
const daily = new Map<string, { day: string; n: number }>();

/** Serialise requests per service and keep at least the minimum interval between them. */
function gate<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = gates.get(id) ?? Promise.resolve();
  const run = prev.then(async () => {
    const min = overrides[id]?.minIntervalMs ?? MIN_INTERVAL_MS[id] ?? 100;
    const wait = (lastAt.get(id) ?? 0) + min - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt.set(id, Date.now());
    return fn();
  });
  gates.set(id, run.catch(() => undefined));
  return run;
}

export class ProviderError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
  }
}

export interface FetchOptions {
  /** Rate-limit / override bucket, defaults to the provider. */
  service?: string;
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: unknown;
  /** Cache lifetime in hours; 0 disables the cache (tests, logins). Defaults to the admin setting. */
  ttlHours?: number;
  timeoutMs?: number;
  /** Return the redirect target instead of following it (Cover Art Archive). */
  manualRedirect?: boolean;
}

export interface FetchResult<T> {
  status: number;
  data: T | null;
  cached: boolean;
  location?: string | null;
}

let defaultTtlHours = 24 * 7;
export const setDefaultCacheTtl = (h: number) => (defaultTtlHours = Math.max(0, h));
const NEGATIVE_TTL_HOURS = 24;

let writes = 0;
function cacheKey(provider: string, method: string, url: string, body: unknown) {
  return crypto.createHash('sha256').update(`${provider}\n${method}\n${url}\n${body ? JSON.stringify(body) : ''}`).digest('hex');
}

/**
 * Fetch JSON from a provider. 404s are returned (and cached) as `{ status: 404, data: null }`;
 * network errors and other failures throw ProviderError (never cached).
 */
export async function providerFetch<T = any>(provider: MetadataProviderId | string, url: string, opts: FetchOptions = {}): Promise<FetchResult<T>> {
  const service = opts.service ?? provider;
  const method = opts.method ?? 'GET';
  const ttl = opts.ttlHours ?? defaultTtlHours;
  const key = cacheKey(service, method, url, opts.body);
  if (ttl > 0) {
    const row = db.get<{ status: number; body: string | null; expires_at: number }>('SELECT status, body, expires_at FROM metadata_cache WHERE key = ?', key);
    if (row && row.expires_at > Date.now()) {
      if (row.status === 200 || row.status === 404) {
        let data: T | null = null;
        try {
          data = row.body ? (JSON.parse(row.body) as T) : null;
        } catch {
          /* corrupt entry: refetch */
        }
        if (row.status === 404 || data !== null) return { status: row.status, data, cached: true, location: (data as any)?.__location ?? null };
      }
    }
  }
  const cap = DAILY_CAP[service];
  if (cap) {
    const day = new Date().toISOString().slice(0, 10);
    const d = daily.get(service);
    if (!d || d.day !== day) daily.set(service, { day, n: 0 });
    if (daily.get(service)!.n >= cap) throw new ProviderError(`${service}: daily request limit (${cap}) reached`, 429);
  }
  const headers: Record<string, string> = { 'User-Agent': userAgent(), Accept: 'application/json', ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await gate(service, () => {
        if (cap) daily.get(service)!.n++;
        return fetch(url, {
          method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          redirect: opts.manualRedirect ? 'manual' : 'follow', signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
        });
      });
      if (res.status === 429 || res.status === 503) {
        const ra = Number(res.headers.get('retry-after'));
        await sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt, 10000));
        lastErr = new ProviderError(`${service}: rate limited (HTTP ${res.status})`, res.status);
        continue;
      }
      if (opts.manualRedirect && res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        const out = { __location: location };
        if (ttl > 0) store(key, service, 200, out, ttl);
        return { status: res.status, data: out as T, cached: false, location };
      }
      if (res.status === 404) {
        await res.body?.cancel().catch(() => undefined);
        if (ttl > 0) store(key, service, 404, null, Math.min(ttl, NEGATIVE_TTL_HOURS));
        return { status: 404, data: null, cached: false };
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new ProviderError(`${service}: HTTP ${res.status}`, res.status);
      }
      if (method === 'HEAD') return { status: res.status, data: null, cached: false };
      const text = await res.text();
      let data: T;
      try {
        data = JSON.parse(text) as T;
      } catch {
        throw new ProviderError(`${service}: invalid JSON response`, res.status);
      }
      if (ttl > 0) store(key, service, 200, data, ttl);
      return { status: res.status, data, cached: false };
    } catch (e) {
      if (e instanceof ProviderError && e.status !== null && e.status !== 429 && e.status !== 503 && e.status < 500) throw e;
      lastErr = e as Error;
      if (attempt < 2) await sleep(300 * (attempt + 1));
    }
  }
  throw lastErr instanceof ProviderError ? lastErr : new ProviderError(`${service}: ${lastErr?.message ?? 'request failed'}`);
}

function store(key: string, provider: string, status: number, data: unknown, ttlHours: number) {
  try {
    db.run('INSERT OR REPLACE INTO metadata_cache (key, provider, status, body, expires_at) VALUES (?, ?, ?, ?, ?)',
      key, provider, status, data === null ? null : JSON.stringify(data), Date.now() + ttlHours * 3600_000);
    if (++writes % 500 === 0) pruneCache();
  } catch (e) {
    log.debug(`cache write failed: ${(e as Error).message}`);
  }
}

export function pruneCache() {
  db.run('DELETE FROM metadata_cache WHERE expires_at < ?', Date.now());
}

export function clearCache(provider?: string) {
  if (provider) db.run('DELETE FROM metadata_cache WHERE provider = ?', provider);
  else db.run('DELETE FROM metadata_cache');
}

export function cacheStats(): { entries: number; bytes: number } {
  const r = db.get<{ n: number; b: number | null }>('SELECT COUNT(*) n, SUM(LENGTH(body)) b FROM metadata_cache')!;
  return { entries: r.n, bytes: r.b ?? 0 };
}

/** Build a URL with query params (skips empty values). */
export function url(base: string, path: string, params: Record<string, string | number | null | undefined> = {}): string {
  const u = new URL(base + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  return u.toString();
}

/** Normalise names for fuzzy comparisons ("The Beatles" ≈ "beatles"). */
export const norm = (s: string | null | undefined) =>
  (s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/^the\s+/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
