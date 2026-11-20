import type { ArrInstance, ArrInstanceRef, ArrKind, ArrOptions, ArrTestRequest } from '@mediamax/shared';
import { getSettings, SECRET_MASK } from '../settings.js';
import { badRequest, HttpError, notFound } from '../../util/errors.js';

/**
 * HTTP client for Radarr/Sonarr/Lidarr/Readarr/Bazarr.
 *
 * Like the original Radarr/Sonarr integration this uses plain `fetch` (not the SSRF-guarded `safeFetch`):
 * *arr URLs are configured by an admin and are almost always on the LAN, so private addresses must work.
 */

export const ARR_LABEL: Record<ArrKind, string> = { radarr: 'Radarr', sonarr: 'Sonarr', lidarr: 'Lidarr', readarr: 'Readarr', bazarr: 'Bazarr' };

/** API prefix per kind: Radarr/Sonarr v3, Lidarr/Readarr v1, Bazarr unversioned. */
export const apiPrefix = (kind: ArrKind) => (kind === 'radarr' || kind === 'sonarr' ? '/api/v3' : kind === 'bazarr' ? '/api' : '/api/v1');

type Conn = Pick<ArrInstance, 'kind' | 'url' | 'apiKey'>;

export function baseUrl(url: string): string {
  const base = String(url ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]/i.test(base)) throw badRequest('Service URL must start with http:// or https://');
  return base;
}

/** Call an *arr API. `path` is relative to the kind's API prefix (e.g. "/queue"). */
export async function arrFetch<T = any>(inst: Conn, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const base = baseUrl(inst.url);
  if (!inst.apiKey) throw badRequest(`No API key set for this ${ARR_LABEL[inst.kind]} instance`);
  const { timeoutMs, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(`${base}${apiPrefix(inst.kind)}${path}`, {
      ...rest,
      headers: { 'X-Api-Key': inst.apiKey, 'Content-Type': 'application/json', Accept: 'application/json', ...(rest.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs ?? 20000),
    });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string; errors?: { code?: string }[] } };
    const code = err.cause?.code ?? err.cause?.errors?.[0]?.code;
    const FRIENDLY: Record<string, string> = { ECONNREFUSED: 'connection refused', ENOTFOUND: 'host not found', EAI_AGAIN: 'host not found', ETIMEDOUT: 'timed out', EHOSTUNREACH: 'host unreachable', ECONNRESET: 'connection reset' };
    const msg = err.name === 'TimeoutError' ? 'timed out' : code ? FRIENDLY[code] ?? code : err.cause?.message ?? err.message;
    throw new HttpError(502, `Can't reach ${ARR_LABEL[inst.kind]}: ${msg}`, 'arr_unreachable');
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    if (res.status === 401) throw new HttpError(502, `${ARR_LABEL[inst.kind]} rejected the API key`, 'arr_unauthorized');
    const msg = Array.isArray(body) ? body.map((e: any) => e.errorMessage ?? e.message).filter(Boolean).join('; ') : body?.message ?? body?.error ?? null;
    throw new HttpError(502, msg || `${ARR_LABEL[inst.kind]} answered HTTP ${res.status}`, res.status === 404 ? 'arr_not_found' : 'arr_error');
  }
  if (typeof body === 'string' && /<html/i.test(body)) throw new HttpError(502, `That URL answered with a web page, not the ${ARR_LABEL[inst.kind]} API (check the URL base)`, 'arr_error');
  return body as T;
}

/* ---------------------------- instances ----------------------------- */

export const allInstances = (): ArrInstance[] => getSettings().arr ?? [];
export const enabledInstances = (kinds?: ArrKind[]): ArrInstance[] =>
  allInstances().filter((i) => i.enabled && i.url && i.apiKey && (!kinds || kinds.includes(i.kind)));

export function getInstance(id: string): ArrInstance {
  const inst = allInstances().find((i) => i.id === id);
  if (!inst) throw notFound('*arr instance not found');
  return inst;
}

/** The instance requests of a kind go to: the first enabled non-4K one (or the 4K one when `want4k`). */
export function instanceFor(kind: ArrKind, want4k = false): ArrInstance | null {
  const list = enabledInstances([kind]);
  if (want4k) return list.find((i) => i.is4k) ?? null;
  return list.find((i) => !i.is4k) ?? list[0] ?? null;
}

export const instanceRef = (i: ArrInstance): ArrInstanceRef => ({ id: i.id, kind: i.kind, name: i.name || ARR_LABEL[i.kind], is4k: !!i.is4k, url: i.url.replace(/\/+$/, '') });

/* ------------------------------ test -------------------------------- */

/** Resolve the connection for a test call: "••••" (or empty) with an id uses the stored key. */
export function testConn(req: ArrTestRequest): Conn {
  const kind = req.kind;
  if (!ARR_LABEL[kind]) throw badRequest('Unknown *arr kind');
  let apiKey = String(req.apiKey ?? '').trim();
  if ((!apiKey || apiKey === SECRET_MASK) && req.id) apiKey = allInstances().find((i) => i.id === req.id)?.apiKey ?? '';
  if (!req.url || !apiKey) throw badRequest('url and apiKey are required');
  return { kind, url: req.url, apiKey };
}

/** Test a connection and load the pickers for the settings form (profiles, root folders, tags). */
export async function arrOptions(conn: Conn): Promise<ArrOptions> {
  const empty: ArrOptions = { ok: false, message: '', qualityProfiles: [], rootFolders: [] };
  try {
    const status = await arrFetch(conn, '/system/status', { timeoutMs: 10000 });
    if (conn.kind === 'bazarr') {
      const v = status?.data?.bazarr_version ?? null;
      return { ...empty, ok: true, message: v ? `Bazarr ${v}` : 'Connected', appName: 'Bazarr', version: v };
    }
    const appName = status?.appName ?? ARR_LABEL[conn.kind];
    const version = status?.version ?? null;
    if (appName && String(appName).toLowerCase() !== conn.kind) {
      return { ...empty, message: `That's ${appName}, not ${ARR_LABEL[conn.kind]}`, appName, version };
    }
    const music = conn.kind === 'lidarr' || conn.kind === 'readarr';
    const soft = <T,>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
    const [profiles, roots, tags, meta, langs] = await Promise.all([
      arrFetch<any[]>(conn, '/qualityprofile'),
      arrFetch<any[]>(conn, '/rootfolder'),
      soft(arrFetch<any[]>(conn, '/tag'), []),
      music ? soft(arrFetch<any[]>(conn, '/metadataprofile'), []) : Promise.resolve([]),
      conn.kind === 'sonarr' && /^3\./.test(String(version ?? '')) ? soft(arrFetch<any[]>(conn, '/languageprofile'), []) : Promise.resolve(null),
    ]);
    return {
      ok: true, message: `${appName} ${version ?? ''}`.trim(), appName, version,
      qualityProfiles: (profiles ?? []).map((p: any) => ({ id: p.id, name: p.name })),
      rootFolders: (roots ?? []).map((r: any) => ({ path: r.path, freeSpace: r.freeSpace ?? null })),
      tags: (tags ?? []).map((t: any) => ({ id: t.id, label: t.label })),
      ...(music ? { metadataProfiles: (meta ?? []).map((p: any) => ({ id: p.id, name: p.name })) } : {}),
      ...(langs ? { languageProfiles: langs.map((p: any) => ({ id: p.id, name: p.name })) } : {}),
    };
  } catch (e) {
    return { ...empty, message: (e as Error).message };
  }
}

/* ------------------------------ cache ------------------------------- */

const cache = new Map<string, { at: number; value: Promise<unknown> }>();

/** Short in-memory cache for dashboard calls (failures are not cached). */
export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = fn();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  if (cache.size > 500) for (const [k, v] of cache) if (Date.now() - v.at > 60000) cache.delete(k);
  return value;
}

/** Drop cached dashboard data (all, or keys starting with a prefix such as "queue:"). */
export function invalidate(prefix = '') {
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
}
