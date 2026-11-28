import type { TraktComment, TraktDeviceCode, TraktStatus, TrackingSyncResult, User } from '@mediamax/shared';
import { db, type Row } from '../db.js';
import { getSettings } from './settings.js';
import { bus } from './events.js';
import { badRequest, HttpError } from '../util/errors.js';
import { parseJson, sleep } from '../util/misc.js';
import { logger } from '../util/log.js';
import type { PlaySession } from './playback.js';
import { getUser } from './auth.js';
import { runImport, type OutsideIds } from './tracking.js';
import { providerFetch } from './metadata/http.js';

const log = logger('trakt');
/** MEDIAMAX_TRAKT_API_BASE: tests and self-hosted mirrors. */
const api = () => (process.env.MEDIAMAX_TRAKT_API_BASE ?? 'https://api.trakt.tv').replace(/\/+$/, '');

const appCreds = () => {
  const t = getSettings().trakt;
  return t.clientId && t.clientSecret ? { id: t.clientId, secret: t.clientSecret } : null;
};

export function traktStatus(userId: string): TraktStatus {
  const acc = db.get('SELECT * FROM trakt_accounts WHERE user_id = ?', userId);
  return {
    available: !!appCreds(), connected: !!acc, username: acc?.username ?? null, scrobble: acc ? !!acc.scrobble : false,
    pull: acc ? !!acc.pull : false, push: acc ? !!acc.push : false, lastPullAt: acc?.last_pull_at ?? null, lastPull: parseJson<TrackingSyncResult | null>(acc?.last_pull, null),
  };
}

async function post(path: string, body: unknown, token?: string): Promise<Response> {
  const app = appCreds();
  if (!app) throw badRequest('Trakt is not configured on this server');
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': app.id, 'User-Agent': 'Kinora' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(api() + path, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
}

/** GET with the user's token; null on 404, throws on other errors. */
async function get<T>(path: string, token: string): Promise<T | null> {
  const app = appCreds();
  if (!app) throw badRequest('Trakt is not configured on this server');
  const res = await fetch(api() + path, {
    headers: { 'trakt-api-version': '2', 'trakt-api-key': app.id, Authorization: `Bearer ${token}`, 'User-Agent': 'Vibe' }, signal: AbortSignal.timeout(30000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(502, `Trakt returned HTTP ${res.status}`, 'provider_error');
  return (await res.json()) as T;
}

const pending = new Map<string, { cancel: boolean }>();

export async function startDeviceAuth(userId: string): Promise<TraktDeviceCode> {
  const app = appCreds();
  if (!app) throw badRequest('Trakt is not configured on this server');
  const res = await post('/oauth/device/code', { client_id: app.id });
  if (!res.ok) throw new HttpError(502, `Trakt returned HTTP ${res.status}`, 'provider_error');
  const j: any = await res.json();
  const prev = pending.get(userId);
  if (prev) prev.cancel = true;
  const state = { cancel: false };
  pending.set(userId, state);
  // Poll in the background until the user approves, the code expires, or another attempt replaces this one.
  void (async () => {
    const deadline = Date.now() + j.expires_in * 1000;
    let interval = j.interval * 1000;
    while (!state.cancel && Date.now() < deadline) {
      await sleep(interval);
      try {
        const r = await post('/oauth/device/token', { code: j.device_code, client_id: app.id, client_secret: app.secret });
        if (r.status === 200) {
          const t: any = await r.json();
          await saveTokens(userId, t);
          log.info(`Trakt connected for user ${userId}`);
          break;
        }
        if (r.status === 429) interval += 1000;
        else if ([404, 409, 410, 418].includes(r.status)) break;
      } catch {
        /* network blip: keep polling */
      }
    }
    if (pending.get(userId) === state) pending.delete(userId);
  })();
  return { userCode: j.user_code, verificationUrl: j.verification_url, expiresAt: new Date(Date.now() + j.expires_in * 1000).toISOString(), intervalSeconds: j.interval };
}

async function saveTokens(userId: string, t: any) {
  let username: string | null = null;
  try {
    const app = appCreds()!;
    const r = await fetch(`${api()}/users/settings`, { headers: { 'trakt-api-version': '2', 'trakt-api-key': app.id, Authorization: `Bearer ${t.access_token}` }, signal: AbortSignal.timeout(10000) });
    if (r.ok) username = ((await r.json()) as any)?.user?.username ?? null;
  } catch {
    /* optional */
  }
  const expires = new Date(((t.created_at ?? Date.now() / 1000) + t.expires_in) * 1000).toISOString();
  db.upsert('trakt_accounts', { user_id: userId, access_token: t.access_token, refresh_token: t.refresh_token, expires_at: expires, ...(username ? { username } : {}), scrobble: 1 }, 'user_id');
}

export function disconnect(userId: string) {
  db.run('DELETE FROM trakt_accounts WHERE user_id = ?', userId);
}

export function setScrobble(userId: string, on: boolean) {
  db.run('UPDATE trakt_accounts SET scrobble = ? WHERE user_id = ?', on, userId);
}

export function setPull(userId: string, on: boolean) {
  db.run('UPDATE trakt_accounts SET pull = ? WHERE user_id = ?', on, userId);
}

export function setPush(userId: string, on: boolean) {
  db.run('UPDATE trakt_accounts SET push = ? WHERE user_id = ?', on, userId);
}

async function accessToken(acc: Row): Promise<string | null> {
  if (Date.parse(acc.expires_at) - Date.now() > 86400000) return acc.access_token;
  const app = appCreds();
  if (!app) return null;
  const r = await post('/oauth/token', { refresh_token: acc.refresh_token, client_id: app.id, client_secret: app.secret, redirect_uri: 'urn:ietf:wg:oauth:2.0:oob', grant_type: 'refresh_token' });
  if (!r.ok) {
    log.warn(`Trakt token refresh failed for ${acc.user_id}: HTTP ${r.status}`);
    return null;
  }
  const t: any = await r.json();
  await saveTokens(acc.user_id, t);
  return t.access_token;
}

/** Build a Trakt media object (movie or episode) for an item. */
function traktMedia(itemId: string): Record<string, unknown> | null {
  const i = db.get('SELECT * FROM items WHERE id = ?', itemId);
  if (!i) return null;
  const ids = parseJson<Record<string, string>>(i.external_ids, {});
  const clean = (o: Record<string, string>) => {
    const out: Record<string, string | number> = {};
    if (o.tmdb) out.tmdb = Number(o.tmdb);
    if (o.imdb) out.imdb = o.imdb;
    if (o.tvdb) out.tvdb = Number(o.tvdb);
    return out;
  };
  if (i.type === 'movie') {
    const id = clean(ids);
    return Object.keys(id).length ? { movie: { title: i.title, year: i.year, ids: id } } : i.title ? { movie: { title: i.title, year: i.year } } : null;
  }
  if (i.type === 'episode' && i.grandparent_id) {
    const show = db.get('SELECT title, year, external_ids FROM items WHERE id = ?', i.grandparent_id);
    const sid = clean(parseJson(show?.external_ids, {}));
    if (!show || !Object.keys(sid).length || i.parent_idx == null || i.idx == null) return null;
    return { show: { title: show.title, year: show.year, ids: sid }, episode: { season: i.parent_idx, number: i.idx } };
  }
  return null;
}

async function scrobble(userId: string, action: 'start' | 'pause' | 'stop', itemId: string, progress: number) {
  const acc = db.get('SELECT * FROM trakt_accounts WHERE user_id = ? AND scrobble = 1', userId);
  if (!acc || !appCreds()) return;
  const media = traktMedia(itemId);
  if (!media) return;
  try {
    const token = await accessToken(acc);
    if (!token) return;
    const r = await post(`/scrobble/${action}`, { ...media, progress: Math.max(0, Math.min(100, progress)) }, token);
    if (!r.ok && r.status !== 409) log.debug(`Trakt scrobble ${action} → HTTP ${r.status}`);
  } catch (e) {
    log.debug(`Trakt scrobble failed: ${(e as Error).message}`);
  }
}

async function addHistory(userId: string, itemIds: string[]) {
  const acc = db.get('SELECT * FROM trakt_accounts WHERE user_id = ? AND scrobble = 1', userId);
  if (!acc || !appCreds()) return;
  const movies: unknown[] = [];
  const shows: unknown[] = [];
  for (const id of itemIds.slice(0, 200)) {
    const m = traktMedia(id) as any;
    if (m?.movie) movies.push({ ...m.movie, watched_at: new Date().toISOString() });
    else if (m?.show) shows.push({ ...m.show, seasons: [{ number: m.episode.season, episodes: [{ number: m.episode.number, watched_at: new Date().toISOString() }] }] });
  }
  if (!movies.length && !shows.length) return;
  try {
    const token = await accessToken(acc);
    if (token) await post('/sync/history', { movies, shows }, token);
  } catch (e) {
    log.debug(`Trakt history sync failed: ${(e as Error).message}`);
  }
}

/* ------------------------------- pull sync ------------------------------- */

interface TIds { imdb?: string | null; tmdb?: number | null; tvdb?: number | null }
const ids = (i: TIds | undefined): OutsideIds => ({ imdb: i?.imdb ?? null, tmdb: i?.tmdb ?? null, tvdb: i?.tvdb ?? null });

interface WatchedMovie { last_watched_at?: string; movie?: { ids?: TIds } }
interface WatchedShow { show?: { ids?: TIds }; seasons?: { number: number; episodes?: { number: number; last_watched_at?: string }[] }[] }
interface Playback { progress?: number; paused_at?: string; type?: string; movie?: { ids?: TIds; runtime?: number }; episode?: { season: number; number: number; runtime?: number }; show?: { ids?: TIds } }
interface ListEntry { listed_at?: string; rated_at?: string; rating?: number; type?: string; movie?: { ids?: TIds }; show?: { ids?: TIds }; episode?: { season: number; number: number } }

const durationOf = (itemId: string) => db.get<{ d: number | null }>('SELECT MAX(duration_ms) d FROM media WHERE item_id = ?', itemId)?.d ?? 0;

const running = new Set<string>();

/**
 * Pull the viewer's Trakt data into their library: watched movies and episodes, resume points, the watchlist
 * (My List) and ratings. Only adds; titles not in the viewer's libraries are counted, not created.
 */
export async function pullFromTrakt(userId: string): Promise<TrackingSyncResult> {
  const acc = db.get('SELECT * FROM trakt_accounts WHERE user_id = ?', userId);
  if (!acc) throw badRequest('Connect Trakt first');
  if (running.has(userId)) throw new HttpError(409, 'A Trakt sync is already running', 'busy');
  running.add(userId);
  try {
    const token = await accessToken(acc);
    if (!token) throw new HttpError(502, 'Trakt sign-in has expired: connect again', 'provider_error');
    const [movies, shows, playback, watchlist, ratings] = await Promise.all([
      get<WatchedMovie[]>('/sync/watched/movies', token),
      get<WatchedShow[]>('/sync/watched/shows', token),
      get<Playback[]>('/sync/playback', token),
      get<ListEntry[]>('/sync/watchlist', token),
      get<ListEntry[]>('/sync/ratings', token),
    ]);
    const user = getUser(userId);
    const result = runImport(user, (imp, index) => {
      for (const m of movies ?? []) {
        const id = index.movie(ids(m.movie?.ids));
        if (id) imp.watched(id, m.last_watched_at);
        else imp.missing();
      }
      for (const s of shows ?? []) {
        const showId = index.show(ids(s.show?.ids));
        if (!showId) {
          imp.missing();
          continue;
        }
        for (const season of s.seasons ?? []) {
          for (const e of season.episodes ?? []) {
            const ep = index.episode(showId, season.number, e.number);
            if (ep) imp.watched(ep, e.last_watched_at);
          }
        }
      }
      for (const p of playback ?? []) {
        const itemId = p.type === 'movie' ? index.movie(ids(p.movie?.ids)) : p.episode ? (() => {
          const showId = index.show(ids(p.show?.ids));
          return showId ? index.episode(showId, p.episode!.season, p.episode!.number) : null;
        })() : null;
        if (!itemId) continue;
        const dur = durationOf(itemId) || ((p.type === 'movie' ? p.movie?.runtime : p.episode?.runtime) ?? 0) * 60000;
        if (dur && p.progress && p.progress < 95) imp.resume(itemId, (dur * p.progress) / 100, p.paused_at);
      }
      const entryItem = (e: ListEntry) => {
        if (e.type === 'movie') return index.movie(ids(e.movie?.ids));
        if (e.type === 'show') return index.show(ids(e.show?.ids));
        if (e.type === 'episode' && e.episode) {
          const showId = index.show(ids(e.show?.ids));
          return showId ? index.episode(showId, e.episode.season, e.episode.number) : null;
        }
        return null;
      };
      for (const w of watchlist ?? []) {
        const id = entryItem(w);
        if (id) imp.watchlist(id, w.listed_at);
        else if (w.type === 'movie' || w.type === 'show') imp.missing();
      }
      for (const r of ratings ?? []) {
        const id = entryItem(r);
        if (id && r.rating) imp.rating(id, r.rating);
      }
    });
    db.run('UPDATE trakt_accounts SET last_pull_at = ?, last_pull = ? WHERE user_id = ?', new Date().toISOString(), JSON.stringify(result), userId);
    log.info(`Trakt sync for ${user.displayName}: ${result.watched} watched, ${result.resumed} resumed, ${result.watchlist} to My List, ${result.rated} rated`);
    return result;
  } finally {
    running.delete(userId);
  }
}

/** Scheduled task: pull for every account that has pull on. */
export async function pullAllTrakt(): Promise<number> {
  if (!appCreds()) return 0;
  let n = 0;
  for (const r of db.all<{ user_id: string }>('SELECT user_id FROM trakt_accounts WHERE pull = 1')) {
    try {
      await pullFromTrakt(r.user_id);
      n++;
    } catch (e) {
      log.warn(`Trakt sync failed for ${r.user_id}: ${(e as Error).message}`);
    }
  }
  return n;
}

/* --------------------------- push: My List, ratings --------------------------- */

async function pushList(userId: string, path: string, itemId: string, extra: Record<string, unknown> = {}) {
  const acc = db.get('SELECT * FROM trakt_accounts WHERE user_id = ? AND push = 1', userId);
  if (!acc || !appCreds()) return;
  const i = db.get<{ type: string }>('SELECT type FROM items WHERE id = ?', itemId);
  let body: Record<string, unknown> | null = null;
  if (i?.type === 'show') {
    const show = db.get<{ title: string; year: number | null; external_ids: string }>('SELECT title, year, external_ids FROM items WHERE id = ?', itemId)!;
    const sid = parseJson<Record<string, string>>(show.external_ids, {});
    const id: Record<string, string | number> = {};
    if (sid.tmdb) id.tmdb = Number(sid.tmdb);
    if (sid.imdb) id.imdb = sid.imdb;
    if (sid.tvdb) id.tvdb = Number(sid.tvdb);
    if (Object.keys(id).length) body = { shows: [{ title: show.title, year: show.year, ids: id, ...extra }] };
  } else {
    const m = traktMedia(itemId) as any;
    if (m?.movie) body = { movies: [{ ...m.movie, ...extra }] };
    // Episodes go nested under their show (Trakt matches them by season and number).
    else if (m?.show) body = { shows: [{ ...m.show, seasons: [{ number: m.episode.season, episodes: [{ number: m.episode.number, ...extra }] }] }] };
  }
  if (!body) return;
  try {
    const token = await accessToken(acc);
    if (token) {
      const r = await post(path, body, token);
      if (!r.ok) log.debug(`Trakt ${path} → HTTP ${r.status}`);
    }
  } catch (e) {
    log.debug(`Trakt ${path} failed: ${(e as Error).message}`);
  }
}

/* ------------------------------ community comments ------------------------------ */

/**
 * Trakt comments and reviews for a movie, show or episode (public: only the app's client id is needed). Cached for
 * six hours. Spoilers are flagged, not hidden: the client blurs them.
 */
export async function itemComments(itemId: string, sort: 'likes' | 'newest' = 'likes'): Promise<TraktComment[]> {
  const app = appCreds();
  if (!app) return [];
  const i = db.get<{ type: string; external_ids: string; grandparent_id: string | null; parent_idx: number | null; idx: number | null }>(
    'SELECT type, external_ids, grandparent_id, parent_idx, idx FROM items WHERE id = ?', itemId);
  if (!i) return [];
  const own = parseJson<Record<string, string>>(i.external_ids, {});
  let path: string | null = null;
  if (i.type === 'movie' && own.imdb) path = `/movies/${encodeURIComponent(own.imdb)}/comments/${sort}`;
  else if (i.type === 'show' && own.imdb) path = `/shows/${encodeURIComponent(own.imdb)}/comments/${sort}`;
  else if (i.type === 'episode' && i.grandparent_id && i.parent_idx != null && i.idx != null) {
    const show = parseJson<Record<string, string>>(db.get<{ external_ids: string }>('SELECT external_ids FROM items WHERE id = ?', i.grandparent_id)?.external_ids, {});
    if (show.imdb) path = `/shows/${encodeURIComponent(show.imdb)}/seasons/${i.parent_idx}/episodes/${i.idx}/comments/${sort}`;
  }
  if (!path) return [];
  const r = await providerFetch<any[]>('trakt', `${api()}${path}?limit=30`, {
    headers: { 'trakt-api-version': '2', 'trakt-api-key': app.id }, ttlHours: 6, timeoutMs: 10000,
  }).catch(() => ({ data: null }));
  return (r.data ?? []).filter((c) => c && typeof c.comment === 'string').map((c) => ({
    id: Number(c.id) || 0,
    comment: String(c.comment).slice(0, 5000),
    spoiler: !!c.spoiler,
    review: !!c.review,
    likes: Number(c.likes) || 0,
    createdAt: String(c.created_at ?? ''),
    user: String(c.user?.username ?? c.user?.name ?? 'Trakt user'),
    rating: typeof c.user_stats?.rating === 'number' ? c.user_stats.rating : typeof c.user_rating === 'number' ? c.user_rating : null,
  }));
}

const pct = (s: PlaySession) => (s.durationMs ? (s.positionMs / s.durationMs) * 100 : 0);

export function initTrakt() {
  bus.on('playback.start', (s: PlaySession) => s.itemId && void scrobble(s.ctx.user.id, 'start', s.itemId, pct(s)));
  bus.on('playback.resume', (s: PlaySession) => s.itemId && void scrobble(s.ctx.user.id, 'start', s.itemId, pct(s)));
  bus.on('playback.pause', (s: PlaySession) => s.itemId && void scrobble(s.ctx.user.id, 'pause', s.itemId, pct(s)));
  bus.on('playback.stop', (s: PlaySession) => s.itemId && void scrobble(s.ctx.user.id, 'stop', s.itemId, pct(s)));
  bus.on('items.played', ({ user, itemIds }: { user: User; itemIds: string[] }) => void addHistory(user.id, itemIds));
  // Two-way (when the viewer turned "push" on): My List and ratings changed here go to Trakt too. Imports write the
  // database directly, so they never loop back.
  bus.on('watchlist.changed', ({ user, itemId, on }: { user: User; itemId: string; on: boolean }) => void pushList(user.id, on ? '/sync/watchlist' : '/sync/watchlist/remove', itemId));
  bus.on('rating.changed', ({ user, itemId, rating }: { user: User; itemId: string; rating: number | null }) =>
    void (rating == null || rating < 1 ? pushList(user.id, '/sync/ratings/remove', itemId) : pushList(user.id, '/sync/ratings', itemId, { rating: Math.max(1, Math.min(10, Math.round(rating))), rated_at: new Date().toISOString() })));
}
