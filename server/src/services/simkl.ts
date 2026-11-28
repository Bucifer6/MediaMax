import type { SimklPin, SimklStatus, TrackingSyncResult, User } from '@mediamax/shared';
import { db } from '../db.js';
import { badRequest, HttpError } from '../util/errors.js';
import { parseJson, sleep } from '../util/misc.js';
import { logger } from '../util/log.js';
import { getSettings } from './settings.js';
import { bus } from './events.js';
import { getUser } from './auth.js';
import { runImport, type OutsideIds } from './tracking.js';

const log = logger('simkl');

/**
 * SIMKL (simkl.com): two-way watch tracking for movies, shows and anime.
 *  - Sign-in: the PIN flow (the viewer enters a code at simkl.com/pin); only the admin's client id is needed.
 *  - Push (on by default): plays marked watched go to SIMKL history; My List additions go to "Plan to watch".
 *  - Pull (on by default, every 6 h and on "Sync now"): watched titles, watched episodes and Plan to watch → My List.
 * Requests are made by the server; nothing is sent until a viewer connects their own account.
 */

const api = () => (process.env.MEDIAMAX_SIMKL_API_BASE ?? 'https://api.simkl.com').replace(/\/+$/, '');
const clientId = () => getSettings().simkl?.clientId || null;

function headers(token?: string): Record<string, string> {
  const id = clientId();
  if (!id) throw badRequest('SIMKL is not configured on this server');
  return { 'simkl-api-key': id, 'Content-Type': 'application/json', 'User-Agent': 'Vibe', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

async function call<T>(method: 'GET' | 'POST', path: string, token?: string, body?: unknown): Promise<T> {
  const res = await fetch(api() + path, { method, headers: headers(token), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (res.status === 401) throw new HttpError(502, 'SIMKL sign-in has expired: connect again', 'provider_error');
  if (!res.ok) throw new HttpError(502, `SIMKL returned HTTP ${res.status}`, 'provider_error');
  const text = await res.text();
  try {
    return (text ? JSON.parse(text) : null) as T;
  } catch {
    throw new HttpError(502, 'SIMKL sent an unreadable reply', 'provider_error');
  }
}

export function simklStatus(userId: string): SimklStatus {
  const acc = db.get('SELECT * FROM simkl_accounts WHERE user_id = ?', userId);
  return {
    available: !!clientId(), connected: !!acc, push: acc ? !!acc.push : false, pull: acc ? !!acc.pull : false,
    lastPullAt: acc?.last_pull_at ?? null, lastPull: parseJson<TrackingSyncResult | null>(acc?.last_pull, null),
  };
}

const pending = new Map<string, { cancel: boolean }>();

/** Start the PIN sign-in; the server polls in the background until the viewer approves or the code expires. */
export async function startSimklPin(userId: string): Promise<SimklPin> {
  const id = clientId();
  if (!id) throw badRequest('SIMKL is not configured on this server');
  const j = await call<{ result?: string; user_code?: string; verification_url?: string; verification_uri?: string; expires_in?: number; interval?: number }>(
    'GET', `/oauth/pin?client_id=${encodeURIComponent(id)}&redirect=${encodeURIComponent('urn:ietf:wg:oauth:2.0:oob')}`);
  if (j?.result !== 'OK' || !j.user_code) throw new HttpError(502, 'SIMKL did not return a code', 'provider_error');
  const userCode = j.user_code;
  const expiresIn = Math.max(60, Number(j.expires_in) || 900);
  const interval = Math.max(2, Number(j.interval) || 5);
  const prev = pending.get(userId);
  if (prev) prev.cancel = true;
  const state = { cancel: false };
  pending.set(userId, state);
  void (async () => {
    const deadline = Date.now() + expiresIn * 1000;
    while (!state.cancel && Date.now() < deadline) {
      await sleep(interval * 1000);
      try {
        const r = await call<{ result?: string; access_token?: string }>('GET', `/oauth/pin/${encodeURIComponent(userCode)}?client_id=${encodeURIComponent(id)}`);
        if (state.cancel) break;
        if (r?.result === 'OK' && r.access_token) {
          db.upsert('simkl_accounts', { user_id: userId, access_token: r.access_token, push: 1, pull: 1 }, 'user_id');
          log.info(`SIMKL connected for user ${userId}`);
          break;
        }
      } catch {
        /* pending or a network blip: keep polling */
      }
    }
    if (pending.get(userId) === state) pending.delete(userId);
  })();
  return { userCode, verificationUrl: j.verification_url ?? j.verification_uri ?? 'https://simkl.com/pin', expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(), intervalSeconds: interval };
}

/** Stop waiting for a PIN the viewer cancelled. */
export function cancelSimklPin(userId: string) {
  const p = pending.get(userId);
  if (p) p.cancel = true;
}

export function disconnectSimkl(userId: string) {
  const p = pending.get(userId);
  if (p) p.cancel = true;
  db.run('DELETE FROM simkl_accounts WHERE user_id = ?', userId);
}

export function setSimklOptions(userId: string, o: { push?: boolean; pull?: boolean }) {
  if (typeof o.push === 'boolean') db.run('UPDATE simkl_accounts SET push = ? WHERE user_id = ?', o.push, userId);
  if (typeof o.pull === 'boolean') db.run('UPDATE simkl_accounts SET pull = ? WHERE user_id = ?', o.pull, userId);
}

/* --------------------------------- pull --------------------------------- */

interface SIds { imdb?: string; tmdb?: string | number; tvdb?: string | number; simkl?: number }
interface SEntry {
  status?: string;
  last_watched_at?: string | null;
  added_to_watchlist_at?: string | null;
  movie?: { ids?: SIds };
  show?: { ids?: SIds };
  seasons?: { number: number; episodes?: { number: number; watched_at?: string | null }[] }[];
}
const sids = (i: SIds | undefined): OutsideIds => ({ imdb: i?.imdb ?? null, tmdb: i?.tmdb ?? null, tvdb: i?.tvdb ?? null });

const running = new Set<string>();

export async function pullFromSimkl(userId: string): Promise<TrackingSyncResult> {
  const acc = db.get('SELECT * FROM simkl_accounts WHERE user_id = ?', userId);
  if (!acc) throw badRequest('Connect SIMKL first');
  if (running.has(userId)) throw new HttpError(409, 'A SIMKL sync is already running', 'busy');
  running.add(userId);
  try {
    const [m, s, a] = await Promise.all([
      call<{ movies?: SEntry[] } | null>('GET', '/sync/all-items/movies?episode_watched_at=yes', acc.access_token),
      call<{ shows?: SEntry[] } | null>('GET', '/sync/all-items/shows?episode_watched_at=yes', acc.access_token),
      call<{ anime?: SEntry[] } | null>('GET', '/sync/all-items/anime?episode_watched_at=yes', acc.access_token),
    ]);
    const user = getUser(userId);
    const result = runImport(user, (imp, index) => {
      for (const e of m?.movies ?? []) {
        const id = index.movie(sids(e.movie?.ids));
        if (!id) {
          imp.missing();
          continue;
        }
        if (e.status === 'completed') imp.watched(id, e.last_watched_at);
        else if (e.status === 'plantowatch') imp.watchlist(id, e.added_to_watchlist_at);
      }
      for (const e of [...(s?.shows ?? []), ...(a?.anime ?? [])]) {
        const showId = index.show(sids(e.show?.ids));
        if (!showId) {
          imp.missing();
          continue;
        }
        if (e.status === 'plantowatch') imp.watchlist(showId, e.added_to_watchlist_at);
        for (const season of e.seasons ?? []) {
          for (const ep of season.episodes ?? []) {
            const epId = index.episode(showId, season.number, ep.number);
            if (epId) imp.watched(epId, ep.watched_at);
          }
        }
      }
    });
    db.run('UPDATE simkl_accounts SET last_pull_at = ?, last_pull = ? WHERE user_id = ?', new Date().toISOString(), JSON.stringify(result), userId);
    return result;
  } finally {
    running.delete(userId);
  }
}

export async function pullAllSimkl(): Promise<number> {
  if (!clientId()) return 0;
  let n = 0;
  for (const r of db.all<{ user_id: string }>('SELECT user_id FROM simkl_accounts WHERE pull = 1')) {
    try {
      await pullFromSimkl(r.user_id);
      n++;
    } catch (e) {
      log.warn(`SIMKL sync failed for ${r.user_id}: ${(e as Error).message}`);
    }
  }
  return n;
}

/* --------------------------------- push --------------------------------- */

function idsOf(externalIds: string | null): Record<string, string | number> | null {
  const x = parseJson<Record<string, string>>(externalIds, {});
  const out: Record<string, string | number> = {};
  if (x.imdb) out.imdb = x.imdb;
  if (x.tmdb) out.tmdb = Number(x.tmdb);
  if (x.tvdb) out.tvdb = Number(x.tvdb);
  return Object.keys(out).length ? out : null;
}

/** The SIMKL body part for one item: movies[] or shows[] (episodes nested under their show). */
export function simklEntry(itemId: string, extra: Record<string, unknown> = {}): { movies?: unknown[]; shows?: unknown[] } | null {
  const i = db.get<{ type: string; external_ids: string; grandparent_id: string | null; parent_idx: number | null; idx: number | null }>(
    'SELECT type, external_ids, grandparent_id, parent_idx, idx FROM items WHERE id = ?', itemId);
  if (!i) return null;
  if (i.type === 'movie') {
    const ids = idsOf(i.external_ids);
    return ids ? { movies: [{ ids, ...extra }] } : null;
  }
  if (i.type === 'show') {
    const ids = idsOf(i.external_ids);
    return ids ? { shows: [{ ids, ...extra }] } : null;
  }
  if (i.type === 'episode' && i.grandparent_id && i.parent_idx != null && i.idx != null) {
    const ids = idsOf(db.get<{ external_ids: string }>('SELECT external_ids FROM items WHERE id = ?', i.grandparent_id)?.external_ids ?? null);
    return ids ? { shows: [{ ids, seasons: [{ number: i.parent_idx, episodes: [{ number: i.idx, ...extra }] }] }] } : null;
  }
  return null;
}

async function push(userId: string, path: string, parts: ({ movies?: unknown[]; shows?: unknown[] } | null)[]) {
  const acc = db.get('SELECT * FROM simkl_accounts WHERE user_id = ? AND push = 1', userId);
  if (!acc || !clientId()) return;
  const body = { movies: parts.flatMap((p) => p?.movies ?? []), shows: parts.flatMap((p) => p?.shows ?? []) };
  if (!body.movies.length && !body.shows.length) return;
  try {
    await call('POST', path, acc.access_token, body);
  } catch (e) {
    log.debug(`SIMKL ${path} failed: ${(e as Error).message}`);
  }
}

export function initSimkl() {
  bus.on('items.played', ({ user, itemIds }: { user: User; itemIds: string[] }) => {
    const at = new Date().toISOString();
    void push(user.id, '/sync/history', itemIds.slice(0, 200).map((id) => simklEntry(id, { watched_at: at })));
  });
  bus.on('watchlist.changed', ({ user, itemId, on }: { user: User; itemId: string; on: boolean }) => {
    if (on) void push(user.id, '/sync/add-to-list', [simklEntry(itemId, { to: 'plantowatch' })]);
  });
}
