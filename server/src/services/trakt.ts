import type { TraktDeviceCode, TraktStatus, User } from '@mediamax/shared';
import { db, type Row } from '../db.js';
import { getSettings } from './settings.js';
import { bus } from './events.js';
import { badRequest, HttpError } from '../util/errors.js';
import { parseJson, sleep } from '../util/misc.js';
import { logger } from '../util/log.js';
import type { PlaySession } from './playback.js';

const log = logger('trakt');
const API = 'https://api.trakt.tv';

const appCreds = () => {
  const t = getSettings().trakt;
  return t.clientId && t.clientSecret ? { id: t.clientId, secret: t.clientSecret } : null;
};

export function traktStatus(userId: string): TraktStatus {
  const acc = db.get('SELECT * FROM trakt_accounts WHERE user_id = ?', userId);
  return { available: !!appCreds(), connected: !!acc, username: acc?.username ?? null, scrobble: acc ? !!acc.scrobble : false };
}

async function post(path: string, body: unknown, token?: string): Promise<Response> {
  const app = appCreds();
  if (!app) throw badRequest('Trakt is not configured on this server');
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': app.id, 'User-Agent': 'Kinora' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(API + path, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
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
    const r = await fetch(`${API}/users/settings`, { headers: { 'trakt-api-version': '2', 'trakt-api-key': app.id, Authorization: `Bearer ${t.access_token}` }, signal: AbortSignal.timeout(10000) });
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

const pct = (s: PlaySession) => (s.durationMs ? (s.positionMs / s.durationMs) * 100 : 0);

export function initTrakt() {
  bus.on('playback.start', (s: PlaySession) => s.itemId && void scrobble(s.ctx.user.id, 'start', s.itemId, pct(s)));
  bus.on('playback.resume', (s: PlaySession) => s.itemId && void scrobble(s.ctx.user.id, 'start', s.itemId, pct(s)));
  bus.on('playback.pause', (s: PlaySession) => s.itemId && void scrobble(s.ctx.user.id, 'pause', s.itemId, pct(s)));
  bus.on('playback.stop', (s: PlaySession) => s.itemId && void scrobble(s.ctx.user.id, 'stop', s.itemId, pct(s)));
  bus.on('items.played', ({ user, itemIds }: { user: User; itemIds: string[] }) => void addHistory(user.id, itemIds));
}
