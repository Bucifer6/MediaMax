import type { Item, LbRecommendationList, LbRecommendations, LbRecommendedTrack, ListenBrainzStatus, ListenBrainzUpdate, User } from '@mediamax/shared';
import { db } from '../db.js';
import { config } from '../config.js';
import { nowIso, parseJson, sleep } from '../util/misc.js';
import { logger } from '../util/log.js';
import { badRequest, HttpError } from '../util/errors.js';
import { assertPublicUrl, safeFetch } from '../util/net.js';
import { bus } from './events.js';
import { SECRET_MASK } from './settings.js';
import { baseUrl, norm, userAgent } from './metadata/http.js';
import { listenCounts, registerScrobbler, type ScrobbleTrack } from './scrobble.js';
import { createContainer, selectItems, withCredits } from './items.js';
import { requestLevel } from './requestPerms.js';
import { instanceFor } from './arr/client.js';
import { isMbid } from './music/tags.js';

/**
 * ListenBrainz (api.listenbrainz.org or a self-hosted server), per user with their own token:
 * - "playing now" when a track starts, a "single" listen once half of it or 4 minutes were played;
 * - listens that can't be sent (offline, rate limited, server down) wait in listenbrainz_queue and go out as
 *   "import" batches later, honouring X-RateLimit-Remaining / X-RateLimit-Reset-In;
 * - optional love/hate feedback from favourites and ratings;
 * - the user's generated playlists and collaborative-filtering recommendations, matched to library tracks.
 * Only the user's own listens, MBIDs and track names are sent, and only once they connect a token.
 */

const log = logger('listenbrainz');
const MAX_BATCH = 100;
const MAX_QUEUE = 5000;

interface Account { user_id: string; token: string; username: string | null; server_url: string | null; scrobble: number; feedback: number; last_error: string | null }

export class LbError extends Error {
  constructor(message: string, readonly status: number | null, readonly retryable: boolean) {
    super(message);
  }
}

const apiBase = (a: { server_url: string | null }) => (a.server_url || baseUrl('listenbrainz')).replace(/\/+$/, '');

/* ------------------------------ HTTP + limits ----------------------------- */

const limits = new Map<string, { remaining: number; resetAt: number }>();
/** Max time we wait for a rate-limit window inline before giving up (the queue retries later). */
let maxInlineWaitMs = 10_000;
export const setLbMaxInlineWait = (ms: number) => (maxInlineWaitMs = ms);

/**
 * A self-hosted server URL set by someone who isn't an administrator is untrusted: every request goes through the
 * SSRF guard (redirects and DNS answers included), not only the check when the URL is saved.
 */
function untrustedServer(a: { server_url: string | null; user_id?: string }): boolean {
  if (!a.server_url) return false;
  const owner = a.user_id ? db.get<{ is_admin: number }>('SELECT is_admin FROM users WHERE id = ?', a.user_id) : null;
  return !owner?.is_admin;
}

export async function lbFetch<T = any>(a: { token: string | null; server_url: string | null; user_id?: string }, path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<{ status: number; data: T | null }> {
  const base = apiBase(a);
  const lim = limits.get(base);
  if (lim && lim.remaining <= 0 && lim.resetAt > Date.now()) {
    const wait = lim.resetAt - Date.now();
    if (wait > maxInlineWaitMs) throw new LbError('ListenBrainz rate limit reached', 429, true);
    await sleep(wait);
  }
  let res: Response;
  try {
    res = await (untrustedServer(a) ? safeFetch : fetch)(base + path, {
      method: init.method ?? 'GET',
      headers: { 'User-Agent': userAgent(), Accept: 'application/json', ...(a.token ? { Authorization: `Token ${a.token}` } : {}), ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new LbError(`ListenBrainz unreachable: ${(e as Error).message}`, null, true);
  }
  const remaining = Number(res.headers.get('x-ratelimit-remaining'));
  const resetIn = Number(res.headers.get('x-ratelimit-reset-in'));
  if (Number.isFinite(remaining) && res.headers.has('x-ratelimit-remaining')) limits.set(base, { remaining, resetAt: Date.now() + (Number.isFinite(resetIn) ? resetIn : 10) * 1000 });
  if (res.status === 429) {
    limits.set(base, { remaining: 0, resetAt: Date.now() + (Number.isFinite(resetIn) && resetIn > 0 ? resetIn : 10) * 1000 });
    await res.body?.cancel().catch(() => undefined);
    throw new LbError('ListenBrainz rate limit reached', 429, true);
  }
  if (res.status === 204) return { status: 204, data: null };
  const text = await res.text();
  const data = text ? (parseJson<T | null>(text, null)) : null;
  if (!res.ok) {
    const msg = (data as any)?.error ?? `HTTP ${res.status}`;
    throw new LbError(`ListenBrainz: ${msg}`, res.status, res.status >= 500);
  }
  return { status: res.status, data };
}

/* ------------------------------- accounts ------------------------------ */

const accountOf = (userId: string) => db.get<Account>('SELECT * FROM listenbrainz_accounts WHERE user_id = ?', userId);

export function lbStatus(userId: string): ListenBrainzStatus {
  const a = accountOf(userId);
  const pending = db.get<{ n: number }>('SELECT COUNT(*) n FROM listenbrainz_queue WHERE user_id = ?', userId)!.n;
  return {
    connected: !!a, username: a?.username ?? null, token: a ? SECRET_MASK : null, serverUrl: a?.server_url ?? null,
    scrobble: a ? !!a.scrobble : true, feedback: a ? !!a.feedback : false, pending, lastError: a?.last_error ?? null,
  };
}

async function normServerUrl(user: User, raw: string | null | undefined): Promise<string | null> {
  const s = (raw ?? '').trim().replace(/\/+$/, '');
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw badRequest('Invalid server URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw badRequest('The server URL must start with http:// or https://');
  // Only admins may point Kinora at addresses on the local network (a LAN-hosted ListenBrainz).
  if (!user.isAdmin) await assertPublicUrl(s);
  return s;
}

/** Validate the token with /1/validate-token and store it. */
export async function lbConnect(user: User, body: ListenBrainzUpdate): Promise<ListenBrainzStatus> {
  const cur = accountOf(user.id);
  const token = body.token === undefined || body.token === SECRET_MASK ? cur?.token ?? null : (body.token ?? '').trim() || null;
  const serverUrl = body.serverUrl === undefined ? cur?.server_url ?? null : await normServerUrl(user, body.serverUrl);
  if (!token) throw badRequest('Paste your ListenBrainz user token (listenbrainz.org → Settings → User token)');
  const tokenChanged = !cur || token !== cur.token || serverUrl !== cur.server_url;
  let username = cur?.username ?? null;
  if (tokenChanged) {
    let r;
    try {
      r = await lbFetch<{ valid: boolean; user_name?: string; message?: string }>({ token, server_url: serverUrl, user_id: user.id }, `/1/validate-token`);
    } catch (e) {
      throw new HttpError(502, (e as Error).message, 'listenbrainz_unreachable');
    }
    if (!r.data?.valid) throw badRequest('ListenBrainz says this token is not valid');
    username = r.data.user_name ?? null;
  }
  db.upsert('listenbrainz_accounts', {
    user_id: user.id, token, username, server_url: serverUrl,
    scrobble: body.scrobble === undefined ? cur?.scrobble ?? 1 : body.scrobble ? 1 : 0,
    feedback: body.feedback === undefined ? cur?.feedback ?? 0 : body.feedback ? 1 : 0,
    last_error: tokenChanged ? null : cur?.last_error ?? null, connected_at: cur && !tokenChanged ? (cur as any).connected_at : nowIso(),
  }, 'user_id');
  recCache.delete(user.id);
  if (tokenChanged) void flushQueue(user.id);
  return lbStatus(user.id);
}

export function lbDisconnect(userId: string): ListenBrainzStatus {
  db.run('DELETE FROM listenbrainz_accounts WHERE user_id = ?', userId);
  db.run('DELETE FROM listenbrainz_queue WHERE user_id = ?', userId);
  recCache.delete(userId);
  return lbStatus(userId);
}

/* ------------------------------- listens -------------------------------- */

/** The listen payload ListenBrainz expects (track_metadata + additional_info with MBIDs). */
export function buildListen(t: ScrobbleTrack, listenedAt?: number): Record<string, unknown> {
  const info: Record<string, unknown> = {
    media_player: 'Kinora', media_player_version: config.version,
    submission_client: 'Kinora', submission_client_version: config.version,
  };
  if (isMbid(t.recordingMbid)) info.recording_mbid = t.recordingMbid;
  if (isMbid(t.releaseMbid)) info.release_mbid = t.releaseMbid;
  if (isMbid(t.releaseGroupMbid)) info.release_group_mbid = t.releaseGroupMbid;
  if (isMbid(t.releaseTrackMbid)) info.track_mbid = t.releaseTrackMbid;
  const artists = t.artistMbids.filter(isMbid);
  if (artists.length) info.artist_mbids = artists;
  if (t.workMbids.length) info.work_mbids = t.workMbids.filter(isMbid);
  if (t.trackNumber) info.tracknumber = t.trackNumber;
  if (t.durationMs) info.duration_ms = t.durationMs;
  const tm: Record<string, unknown> = { artist_name: t.artist, track_name: t.title, additional_info: info };
  if (t.album) tm.release_name = t.album;
  return listenedAt !== undefined ? { listened_at: listenedAt, track_metadata: tm } : { track_metadata: tm };
}

const enabledAccount = (userId: string) => db.get<Account>('SELECT * FROM listenbrainz_accounts WHERE user_id = ? AND scrobble = 1', userId);

function enqueue(userId: string, listen: Record<string, unknown>, err: string | null) {
  db.run('INSERT INTO listenbrainz_queue (user_id, listened_at, payload, last_error, created_at) VALUES (?, ?, ?, ?, ?)', userId, Number(listen.listened_at) || Math.floor(Date.now() / 1000), JSON.stringify(listen), err, nowIso());
  db.run('DELETE FROM listenbrainz_queue WHERE user_id = ? AND id NOT IN (SELECT id FROM listenbrainz_queue WHERE user_id = ? ORDER BY id DESC LIMIT ?)', userId, userId, MAX_QUEUE);
}

const setError = (userId: string, e: string | null) => db.run('UPDATE listenbrainz_accounts SET last_error = ? WHERE user_id = ?', e, userId);

export async function lbNowPlaying(userId: string, t: ScrobbleTrack) {
  const a = enabledAccount(userId);
  if (!a) return;
  try {
    await lbFetch(a, '/1/submit-listens', { method: 'POST', body: { listen_type: 'playing_now', payload: [buildListen(t)] } });
  } catch (e) {
    log.debug(`playing_now: ${(e as Error).message}`);
  }
}

/** Submit a finished listen (if it counts); on failure it waits in the queue. */
export async function lbListen(userId: string, t: ScrobbleTrack, startedAt: number, listenedMs: number): Promise<'sent' | 'queued' | 'skipped' | 'dropped'> {
  if (!listenCounts(t.durationMs, listenedMs)) return 'skipped';
  const a = enabledAccount(userId);
  if (!a) return 'skipped';
  const listen = buildListen(t, Math.floor(startedAt / 1000));
  const pending = db.get<{ n: number }>('SELECT COUNT(*) n FROM listenbrainz_queue WHERE user_id = ?', userId)!.n;
  if (pending) {
    // Keep the order: this one goes behind the waiting ones.
    enqueue(userId, listen, null);
    void flushQueue(userId);
    return 'queued';
  }
  try {
    await lbFetch(a, '/1/submit-listens', { method: 'POST', body: { listen_type: 'single', payload: [listen] } });
    if (a.last_error) setError(userId, null);
    return 'sent';
  } catch (e) {
    const err = e as LbError;
    if (err.status === 400) {
      log.warn(`listen rejected: ${err.message}`);
      return 'dropped';
    }
    if (err.status === 401) setError(userId, 'ListenBrainz rejected the token — reconnect it in Settings');
    enqueue(userId, listen, err.message);
    return 'queued';
  }
}

const flushing = new Map<string, Promise<number>>();
/** Send waiting listens as "import" batches (oldest first). Stops at the first retryable failure. */
export async function flushQueue(userId?: string): Promise<number> {
  const users = userId ? [userId] : db.all<{ user_id: string }>('SELECT DISTINCT user_id FROM listenbrainz_queue').map((r) => r.user_id);
  let sent = 0;
  for (const uid of users) {
    // One flush per user at a time: wait for a running one, then go again (the queue may have changed).
    const running = flushing.get(uid);
    if (running) await running.catch(() => 0);
    const p = flushUser(uid);
    flushing.set(uid, p);
    try {
      sent += await p;
    } finally {
      if (flushing.get(uid) === p) flushing.delete(uid);
    }
  }
  return sent;
}

async function flushUser(uid: string): Promise<number> {
  let sent = 0;
  {
    const a = enabledAccount(uid);
    if (!a) return 0;
    try {
      for (;;) {
        const rows = db.all<{ id: number; payload: string }>('SELECT id, payload FROM listenbrainz_queue WHERE user_id = ? ORDER BY id LIMIT ?', uid, MAX_BATCH);
        if (!rows.length) break;
        try {
          await lbFetch(a, '/1/submit-listens', { method: 'POST', body: { listen_type: 'import', payload: rows.map((r) => JSON.parse(r.payload)) } });
          db.run(`DELETE FROM listenbrainz_queue WHERE id IN (${rows.map(() => '?').join(',')})`, ...rows.map((r) => r.id));
          sent += rows.length;
          if (a.last_error) setError(uid, null);
        } catch (e) {
          const err = e as LbError;
          if (err.status === 400) {
            // One bad listen must not block the rest: send them one by one, dropping the rejected ones.
            for (const r of rows) {
              try {
                await lbFetch(a, '/1/submit-listens', { method: 'POST', body: { listen_type: 'import', payload: [JSON.parse(r.payload)] } });
                sent++;
                db.run('DELETE FROM listenbrainz_queue WHERE id = ?', r.id);
              } catch (e2) {
                if ((e2 as LbError).status === 400) db.run('DELETE FROM listenbrainz_queue WHERE id = ?', r.id);
                else throw e2;
              }
            }
            continue;
          }
          db.run(`UPDATE listenbrainz_queue SET attempts = attempts + 1, last_error = ? WHERE id IN (${rows.map(() => '?').join(',')})`, err.message, ...rows.map((r) => r.id));
          if (err.status === 401) setError(uid, 'ListenBrainz rejected the token — reconnect it in Settings');
          break;
        }
      }
    } catch (e) {
      log.debug(`queue flush: ${(e as Error).message}`);
    }
  }
  return sent;
}

/* ------------------------------- feedback ------------------------------- */

const lastFeedback = new Map<string, number>();
/** Favourite or ≥4★ (8/10) → love (1); 1★ → hate (-1); otherwise 0 (clears earlier feedback). */
export function feedbackScore(favorite: boolean, rating: number | null): 1 | 0 | -1 {
  if (favorite || (rating !== null && rating >= 8)) return 1;
  if (rating !== null && rating > 0 && rating <= 2) return -1;
  return 0;
}

async function onUserData(ev: { userId: string; itemId: string }) {
  const a = db.get<Account>('SELECT * FROM listenbrainz_accounts WHERE user_id = ? AND feedback = 1', ev.userId);
  if (!a) return;
  const t = db.get<{ mbid: string | null; favorite: number | null; rating: number | null }>(
    `SELECT json_extract(i.external_ids, '$.musicbrainzRecording') mbid, ud.favorite, ud.rating FROM items i LEFT JOIN user_data ud ON ud.item_id = i.id AND ud.user_id = ? WHERE i.id = ? AND i.type = 'track'`, ev.userId, ev.itemId);
  if (!t || !isMbid(t.mbid)) return;
  const score = feedbackScore(!!t.favorite, t.rating ?? null);
  const key = `${ev.userId}:${t.mbid}`;
  if ((lastFeedback.get(key) ?? 0) === score && score === 0) return;
  if (lastFeedback.get(key) === score) return;
  try {
    await lbFetch(a, '/1/feedback/recording-feedback', { method: 'POST', body: { recording_mbid: t.mbid, score } });
    lastFeedback.set(key, score);
  } catch (e) {
    log.debug(`feedback: ${(e as Error).message}`);
  }
}

/* ---------------------------- recommendations --------------------------- */

const recCache = new Map<string, { at: number; lists: LbRecommendationList[] }>();
const MB_REC = /musicbrainz\.org\/recording\/([0-9a-f-]{36})/i;
const MB_ART = /musicbrainz\.org\/artist\/([0-9a-f-]{36})/i;

interface RawRec { recordingMbid: string | null; title: string; artist: string; artistMbids: string[]; album: string | null }

function kindOf(title: string, patch: string | undefined): LbRecommendationList['kind'] {
  const s = `${patch ?? ''} ${title}`.toLowerCase();
  if (s.includes('exploration')) return 'weekly-exploration';
  if (s.includes('weekly-jams') || s.includes('weekly jams')) return 'weekly-jams';
  if (s.includes('daily-jams') || s.includes('daily jams')) return 'daily-jams';
  return 'other';
}

/** JSPF playlist tracks → raw recommendations. */
export function jspfTracks(pl: any): RawRec[] {
  return (pl?.track ?? []).map((t: any) => {
    const ids = ([] as string[]).concat(t.identifier ?? []);
    const rec = ids.map((i) => MB_REC.exec(i)?.[1]).find(Boolean) ?? null;
    const ext = t.extension?.['https://musicbrainz.org/doc/jspf#track'] ?? {};
    const artistMbids = ((ext.artist_identifiers ?? []) as string[]).map((i) => MB_ART.exec(i)?.[1]).filter(Boolean) as string[];
    return { recordingMbid: rec?.toLowerCase() ?? null, title: String(t.title ?? ''), artist: String(t.creator ?? ''), artistMbids, album: t.album ?? null };
  }).filter((t: RawRec) => t.title || t.recordingMbid);
}

/** Match recommendations to library tracks the user can see: by recording MBID, else artist + title. */
export function matchToLibrary(user: User, recs: RawRec[]): LbRecommendedTrack[] {
  const mbids = [...new Set(recs.map((r) => r.recordingMbid).filter(isMbid))];
  const byMbid = new Map<string, Item>();
  for (let i = 0; i < mbids.length; i += 300) {
    const chunk = mbids.slice(i, i + 300);
    for (const it of selectItems(user, `i.type = 'track' AND json_extract(i.external_ids, '$.musicbrainzRecording') IN (${chunk.map(() => '?').join(',')})`, chunk)) {
      const m = it.externalIds.musicbrainzRecording;
      if (m && !byMbid.has(m)) byMbid.set(m, it);
    }
  }
  let fuzzyLookups = 0;
  const out = recs.map((r): LbRecommendedTrack => {
    const hit = r.recordingMbid ? byMbid.get(r.recordingMbid) : undefined;
    if (hit) return { ...r, item: hit, match: 'mbid' };
    if (r.title && r.artist && fuzzyLookups++ < 150) {
      const cands = selectItems(user, "i.type = 'track' AND i.title = ? COLLATE NOCASE", [r.title], 'LIMIT 20');
      const loose = cands.length ? cands : selectItems(user, "i.type = 'track' AND i.title LIKE ?", [`${r.title.slice(0, 60)}%`], 'LIMIT 20');
      const a = norm(r.artist);
      withCredits(loose);
      const f = loose.find((it) => norm(it.title) === norm(r.title) && [it.music?.displayArtist, it.grandparentTitle, ...(it.music?.credits ?? []).map((c) => c.name)].some((n) => {
        const x = norm(n);
        return !!x && (x === a || a.startsWith(x) || x.startsWith(a));
      }));
      if (f) return { ...r, item: f, match: 'fuzzy' };
    }
    return { ...r, item: null, match: null };
  });
  return out;
}

async function fetchLists(a: Account): Promise<{ lists: { id: string; title: string; kind: LbRecommendationList['kind']; recs: RawRec[] }[]; error: string | null }> {
  const lists: { id: string; title: string; kind: LbRecommendationList['kind']; recs: RawRec[] }[] = [];
  let error: string | null = null;
  const user = encodeURIComponent(a.username ?? '');
  try {
    const r = await lbFetch(a, `/1/user/${user}/playlists/createdfor?count=25`);
    const seen = new Set<string>();
    for (const p of r.data?.playlists ?? []) {
      const pl = p.playlist ?? p;
      const id = String(pl.identifier ?? '').split('/').filter(Boolean).pop() ?? '';
      const patch = pl.extension?.['https://musicbrainz.org/doc/jspf#playlist']?.additional_metadata?.algorithm_metadata?.source_patch;
      const kind = kindOf(String(pl.title ?? ''), patch);
      if (!id || kind === 'other' || seen.has(kind)) continue;
      seen.add(kind);
      const full = await lbFetch(a, `/1/playlist/${encodeURIComponent(id)}`);
      lists.push({ id, title: String(full.data?.playlist?.title ?? pl.title ?? 'ListenBrainz playlist'), kind, recs: jspfTracks(full.data?.playlist) });
    }
  } catch (e) {
    error = (e as Error).message;
  }
  try {
    const r = await lbFetch(a, `/1/cf/recommendation/user/${user}/recording?count=50`);
    const mbids: string[] = (r.data?.payload?.mbids ?? []).map((m: any) => m.recording_mbid).filter(isMbid);
    if (mbids.length) {
      // Names for the recordings (also used for the fuzzy match and for showing what's missing).
      const meta = await lbFetch(a, `/1/metadata/recording/?recording_mbids=${mbids.slice(0, 50).join(',')}&inc=artist%20release`).catch(() => ({ data: null }));
      const recs = mbids.map((m) => {
        const x = (meta.data as any)?.[m] ?? {};
        return {
          recordingMbid: m, title: String(x.recording?.name ?? ''), artist: String(x.artist?.name ?? ''),
          artistMbids: (x.artist?.artists ?? []).map((y: any) => y.artist_mbid).filter(isMbid), album: x.release?.name ?? null,
        };
      });
      lists.push({ id: 'cf', title: 'Recommended for you', kind: 'cf', recs });
    }
  } catch (e) {
    error ??= (e as Error).message;
  }
  return { lists, error };
}

export async function lbRecommendations(user: User, refresh = false): Promise<LbRecommendations> {
  const a = accountOf(user.id);
  const canRequest = requestLevel(user, 'artist') !== 'none' && !!instanceFor('lidarr');
  if (!a) return { connected: false, lists: [], error: null, canRequest };
  if (!a.username) return { connected: true, lists: [], error: 'Reconnect ListenBrainz to load recommendations', canRequest };
  const cached = recCache.get(user.id);
  if (cached && !refresh && Date.now() - cached.at < 3600_000) return { connected: true, lists: cached.lists, error: null, canRequest };
  const { lists, error } = await fetchLists(a);
  const mapped: LbRecommendationList[] = lists.map((l) => ({ id: l.id, title: l.title, kind: l.kind, tracks: matchToLibrary(user, l.recs) }));
  if (!error) recCache.set(user.id, { at: Date.now(), lists: mapped });
  return { connected: true, lists: mapped, error, canRequest };
}

/** Save the in-library tracks of a recommendation list as a Kinora playlist. */
export async function lbSaveAsPlaylist(user: User, listId: string): Promise<{ id: string; count: number }> {
  const recs = await lbRecommendations(user);
  const list = recs.lists.find((l) => l.id === listId);
  if (!list) throw badRequest('That ListenBrainz list is no longer available');
  const ids = [...new Set(list.tracks.map((t) => t.item?.id).filter(Boolean) as string[])];
  if (!ids.length) throw badRequest('None of these tracks are in your library');
  const date = new Date().toISOString().slice(0, 10);
  return { id: createContainer('playlist', `${list.title} (ListenBrainz, ${date})`, user.id, ids), count: ids.length };
}

/* --------------------------------- init --------------------------------- */

let timer: NodeJS.Timeout | null = null;
export function initListenBrainz() {
  registerScrobbler({
    id: 'listenbrainz',
    nowPlaying: (userId, t) => lbNowPlaying(userId, t),
    listen: async (userId, t, startedAt, listenedMs) => void (await lbListen(userId, t, startedAt, listenedMs)),
  });
  bus.on('userdata.changed', (ev: { userId: string; itemId: string }) => void onUserData(ev).catch(() => undefined));
  if (!timer) {
    timer = setInterval(() => void flushQueue().catch(() => undefined), 5 * 60_000);
    timer.unref();
  }
}

