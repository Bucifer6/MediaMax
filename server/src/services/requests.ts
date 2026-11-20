/**
 * Media requests (Overseerr/Jellyseerr parity, built in): Discover via TMDB (movies/shows) and Lidarr/Readarr (music/books),
 * per-user permissions (none / request / auto) and quotas, an approval workflow with edit-before-approve, a request timeline
 * with comments, a blacklist, and sending approved requests to Radarr/Sonarr/Lidarr/Readarr.
 */
import type {
  ArrInstance, ArrKind, ArrOptions, ArrQueueItem, BlacklistEntry, BulkRequestAction, BulkRequestResult, CreateMediaRequest, DiscoverResponse,
  DiscoverResult, EditMediaRequest, MediaRequest, RequestActivity, RequestArrChoices, RequestArrOverrides, RequestListQuery, RequestMediaType,
  RequestOptions, RequestSeasonInfo, RequestStatus, RequestTvInfo, SeasonMode, User,
} from '@mediamax/shared';
import { db, type Row } from '../db.js';
import { newId } from '../util/ids.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../util/errors.js';
import { nowIso, parseJson } from '../util/misc.js';
import { getSettings } from './settings.js';
import { getBranding } from './branding.js';
import { registerImage, registerRemoteImage, imageUrl } from './images.js';
import { bus, events } from './events.js';
import { logActivity } from './activity.js';
import { logger } from '../util/log.js';
import * as tmdb from './metadata/tmdb.js';
import { ARR_LABEL, arrFetch, arrOptions as arrOptionsFor, enabledInstances, instanceFor, invalidate } from './arr/client.js';
import { commandBody, DOWNLOADERS, getQueue } from './arr/dashboard.js';
import { allQuotaStatus, canManageRequests, effectivePermissions, quotaKind, quotaStatus, requestLevel } from './requestPerms.js';

const log = logger('requests');

const VIDEO_TYPES: RequestMediaType[] = ['movie', 'show'];
const ALL_TYPES: RequestMediaType[] = ['movie', 'show', 'artist', 'album', 'book'];
const TYPE_WORD: Record<RequestMediaType, string> = { movie: 'movies', show: 'shows', artist: 'music', album: 'music', book: 'books' };

/** The *arr a request type goes to. */
export const arrKindFor = (t: RequestMediaType): ArrKind => (t === 'movie' ? 'radarr' : t === 'show' ? 'sonarr' : t === 'book' ? 'readarr' : 'lidarr');

function assertOn() {
  if (!getBranding().features.requests || !getSettings().requests.enabled) throw forbidden('Requests are turned off on this server');
}
function assertEnabled() {
  assertOn();
  if (!tmdb.tmdbEnabled()) throw badRequest('Requests need a TMDB API key (Admin → Settings → Metadata)');
}
export function assertManager(user: User) {
  if (!canManageRequests(user)) throw forbidden('Managing requests needs the "Manage requests" permission');
}

export const userRef = (id: string | null) => {
  if (!id) return null;
  const u = db.get('SELECT id, display_name FROM users WHERE id = ?', id);
  return u ? { id: u.id, displayName: u.display_name } : { id, displayName: 'Deleted user' };
};

interface RequestOpts {
  seasonMode?: SeasonMode;
  monitor?: 'all' | 'future';
  tvdbId?: string | null;
  /** Quota units (seasons for shows). */
  units?: number;
  /** Seasons this request covers once resolved against TMDB (shows). */
  resolvedSeasons?: number[];
  arr?: RequestArrOverrides;
  declineReason?: string | null;
  rating?: number | null;
}

const SELECT_REQ = `SELECT m.*, (SELECT COUNT(*) FROM request_activity a WHERE a.request_id = m.id AND a.kind = 'comment') comment_count FROM media_requests m`;

function toRequest(r: Row, viewer?: User | null): MediaRequest {
  const o = parseJson<RequestOpts>(r.options, {});
  const seasons = parseJson<number[]>(r.seasons, []);
  const manager = viewer ? canManageRequests(viewer) : false;
  return {
    id: r.id, tmdbId: r.tmdb_id, externalId: r.tmdb_id, mediaType: r.media_type, title: r.title, subtitle: r.subtitle ?? null, year: r.year ?? null, posterUrl: imageUrl(r.poster),
    seasons, seasonMode: o.seasonMode ?? (seasons.length ? 'specific' : 'all'), monitor: r.media_type === 'artist' ? o.monitor ?? 'all' : null,
    also4k: !!r.also_4k, download: null,
    status: r.status, requestedBy: userRef(r.requested_by)!, requestedAt: r.requested_at,
    decidedBy: userRef(r.decided_by), decidedAt: r.decided_at ?? null, note: r.note ?? null, itemId: r.item_id ?? null, error: r.error ?? null,
    arr: manager ? o.arr ?? null : null, quotaUnits: o.units ?? 1, commentCount: r.comment_count ?? 0, declineReason: o.declineReason ?? null,
  };
}
const getRow = (id: string) => db.get(`${SELECT_REQ} WHERE m.id = ?`, id);
const out = (id: string, viewer?: User | null) => toRequest(getRow(id)!, viewer);

function setOpts(id: string, patch: Partial<RequestOpts>) {
  const r = db.get('SELECT options FROM media_requests WHERE id = ?', id);
  db.run('UPDATE media_requests SET options = ?, updated_at = ? WHERE id = ?', JSON.stringify({ ...parseJson<RequestOpts>(r?.options, {}), ...patch }), nowIso(), id);
}

/** Add an entry to a request's timeline. */
export function logRequest(requestId: string, kind: RequestActivity['kind'], userId: string | null, body: string | null = null) {
  db.insert('request_activity', { id: newId(), request_id: requestId, user_id: userId, kind, body, created_at: nowIso() });
  db.run('UPDATE media_requests SET updated_at = ? WHERE id = ?', nowIso(), requestId);
}

/* ------------------------------ availability ------------------------------ */

const showItemFor = (tmdbId: string) => db.get<{ id: string }>(`SELECT id FROM items WHERE type = 'show' AND json_extract(external_ids, '$.tmdb') = ? LIMIT 1`, String(tmdbId))?.id ?? null;

/** Episodes per season of a library show. */
function libraryEpisodes(showId: string | null): Map<number, number> {
  if (!showId) return new Map();
  return new Map(db.all<{ s: number; n: number }>(`SELECT parent_idx s, COUNT(*) n FROM items WHERE type = 'episode' AND grandparent_id = ? AND parent_idx IS NOT NULL GROUP BY parent_idx`, showId).map((x) => [x.s, x.n]));
}

/** Library item matching a request: by TMDB id for movies/shows, by name for music and books. */
export function findAvailable(id: string, type: RequestMediaType, names: { title?: string; subtitle?: string | null } = {}): string | null {
  if (type === 'movie' || type === 'show') {
    return db.get<{ id: string }>(`SELECT id FROM items WHERE type = ? AND json_extract(external_ids, '$.tmdb') = ? LIMIT 1`, type === 'movie' ? 'movie' : 'show', String(id))?.id ?? null;
  }
  if (!names.title) return null;
  if (type === 'artist') return db.get<{ id: string }>(`SELECT id FROM items WHERE type = 'artist' AND title = ? COLLATE NOCASE LIMIT 1`, names.title)?.id ?? null;
  if (type === 'album') {
    return db.get<{ id: string }>(
      `SELECT a.id FROM items a LEFT JOIN items p ON p.id = a.parent_id WHERE a.type = 'album' AND a.title = ? COLLATE NOCASE AND (? IS NULL OR p.title = ? COLLATE NOCASE) LIMIT 1`,
      names.title, names.subtitle ?? null, names.subtitle ?? null)?.id ?? null;
  }
  return db.get<{ id: string }>(`SELECT id FROM items WHERE type IN ('audiobook','book') AND title = ? COLLATE NOCASE LIMIT 1`, names.title)?.id ?? null;
}

/** Seasons covered by open (pending/approved/processing) requests for a show; null in the set = "all seasons". */
function requestedSeasons(tmdbId: string, excludeId?: string): { seasons: Set<number>; all: boolean; pending: Set<number> } {
  const res = { seasons: new Set<number>(), all: false, pending: new Set<number>() };
  for (const r of db.all("SELECT id, status, seasons, options FROM media_requests WHERE tmdb_id = ? AND media_type = 'show' AND status IN ('pending','approved','processing')", tmdbId)) {
    if (r.id === excludeId) continue;
    const o = parseJson<RequestOpts>(r.options, {});
    const list = o.resolvedSeasons ?? parseJson<number[]>(r.seasons, []);
    if (!list.length) res.all = true;
    for (const n of list) {
      res.seasons.add(n);
      if (r.status === 'pending') res.pending.add(n);
    }
  }
  return res;
}

/** GET /requests/tv/:tmdbId: seasons with library/request status for the request dialog. */
export async function tvInfo(tmdbId: string): Promise<RequestTvInfo> {
  assertEnabled();
  if (!/^\d+$/.test(tmdbId)) throw badRequest('Invalid TMDB id');
  const t = await tmdb.tvSeasons(tmdbId);
  if (!t) throw notFound('Show not found on TMDB');
  const itemId = showItemFor(tmdbId);
  const lib = libraryEpisodes(itemId);
  const req = requestedSeasons(tmdbId);
  const seasons: RequestSeasonInfo[] = t.seasons.filter((s) => s.seasonNumber > 0).map((s) => {
    const have = lib.get(s.seasonNumber) ?? 0;
    const status = have > 0 && have >= s.episodeCount ? 'available'
      : req.all || req.seasons.has(s.seasonNumber) ? (req.pending.has(s.seasonNumber) ? 'pending' : 'requested')
        : have > 0 ? 'partial' : 'missing';
    return { seasonNumber: s.seasonNumber, name: s.name, episodeCount: s.episodeCount, airDate: s.airDate, libraryEpisodes: have, status };
  });
  return { tmdbId, title: t.title, seasons, itemId };
}

/* ------------------------------ blacklist ------------------------------ */

const blKey = (type: string, id: string) => `${type}:${id}`;
const blacklistSet = () => new Set(db.all('SELECT media_type, external_id FROM request_blacklist').map((r) => blKey(r.media_type, r.external_id)));
export const isBlacklisted = (type: RequestMediaType, id: string) => !!db.get('SELECT 1 FROM request_blacklist WHERE media_type = ? AND external_id = ?', type, String(id));

export function listBlacklist(user: User): BlacklistEntry[] {
  assertManager(user);
  return db.all('SELECT * FROM request_blacklist ORDER BY created_at DESC').map((r) => ({
    mediaType: r.media_type, externalId: r.external_id, title: r.title, reason: r.reason ?? null, createdBy: userRef(r.created_by), createdAt: r.created_at,
  }));
}

export function addToBlacklist(user: User, b: { mediaType: RequestMediaType; externalId: string; title?: string; reason?: string }): BlacklistEntry {
  assertManager(user);
  if (!ALL_TYPES.includes(b?.mediaType)) throw badRequest('mediaType must be movie, show, artist, album or book');
  const id = String(b.externalId ?? '').trim();
  if (!/^[\w.:-]{1,100}$/.test(id)) throw badRequest('Invalid id');
  db.upsert('request_blacklist', {
    media_type: b.mediaType, external_id: id, title: String(b.title ?? '').trim().slice(0, 300) || id, reason: b.reason ? String(b.reason).slice(0, 500) : null,
    created_by: user.id, created_at: nowIso(),
  }, 'media_type,external_id');
  logActivity('request.blacklist', `${user.displayName} blacklisted ${b.title ?? id}`, { userId: user.id, userName: user.displayName });
  return listBlacklist(user).find((x) => x.mediaType === b.mediaType && x.externalId === id)!;
}

export function removeFromBlacklist(user: User, mediaType: string, externalId: string) {
  assertManager(user);
  db.run('DELETE FROM request_blacklist WHERE media_type = ? AND external_id = ?', mediaType, externalId);
}

/* ------------------------------ options & discover ------------------------------ */

/** What the request form can offer to this user. */
export function requestOptions(user: User): RequestOptions {
  const has = (k: ArrKind) => enabledInstances([k]).length > 0;
  const p = effectivePermissions(user);
  return {
    movies: p.movie !== 'none', shows: p.show !== 'none', music: has('lidarr') && p.music !== 'none', books: has('readarr') && p.book !== 'none',
    can4k: { movie: p.movie4k !== 'none' && p.movie !== 'none' && !!instanceFor('radarr', true), show: p.show4k !== 'none' && p.show !== 'none' && !!instanceFor('sonarr', true) },
    tmdb: tmdb.tmdbEnabled(),
    permissions: p, quotas: allQuotaStatus(user), canManage: canManageRequests(user), hideAvailable: !!getSettings().requests.hideAvailable,
  };
}

function openRequests() {
  return new Map(db.all("SELECT id, tmdb_id, media_type, status FROM media_requests WHERE status != 'declined' ORDER BY requested_at").map((x) => [`${x.media_type}:${x.tmdb_id}`, x]));
}

/**
 * Turn TMDB list results into Discover cards for a viewer: library/request status, blacklist (hidden unless the viewer
 * manages requests), the viewer's watchlist, and optionally hide titles already in the library.
 */
export function decorate(user: User, list: tmdb.TmdbListResult[], opts: { hideAvailable?: boolean } = {}): DiscoverResult[] {
  const open = openRequests();
  const bl = blacklistSet();
  const manager = canManageRequests(user);
  const wl = new Set(db.all('SELECT media_type, external_id FROM discover_watchlist WHERE user_id = ?', user.id).map((r) => `${r.media_type}:${r.external_id}`));
  const outList: DiscoverResult[] = [];
  for (const m of list) {
    const blacklisted = bl.has(blKey(m.mediaType, m.id));
    if (blacklisted && !manager) continue;
    const req = open.get(`${m.mediaType}:${m.id}`);
    const availableItemId = findAvailable(m.id, m.mediaType);
    if (opts.hideAvailable && availableItemId) continue;
    outList.push({
      tmdbId: m.id, externalId: m.id, mediaType: m.mediaType, title: m.title, year: m.year, overview: m.overview, rating: m.rating,
      posterUrl: imageUrl(registerImage(m.poster)), backdropUrl: imageUrl(registerImage(m.backdrop)),
      availableItemId, requestId: req?.id ?? null, requestStatus: (req?.status as RequestStatus) ?? null,
      blacklisted, onWatchlist: wl.has(`${m.mediaType}:${m.id}`), partiallyAvailable: m.mediaType === 'show' && !!availableItemId,
    });
  }
  return outList;
}

export async function discover(user: User, q: string, type: 'movie' | 'show' | 'all', page: number, opts: { hideAvailable?: boolean } = {}): Promise<DiscoverResponse> {
  assertEnabled();
  const r = await tmdb.discover(q, type, Math.max(1, Math.min(50, page || 1)));
  return { page: r.page, totalPages: r.totalPages, results: decorate(user, r.results, opts) };
}

/* --------------------------- music & books -------------------------- */

const coverOf = (images: any[] | undefined, types: string[]) => {
  for (const t of types) {
    const img = (images ?? []).find((i) => i?.coverType === t);
    const url = img?.remoteUrl ?? img?.url;
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url;
  }
  return null;
};
const yearOf = (d: unknown) => (typeof d === 'string' && /^\d{4}/.test(d) ? Number(d.slice(0, 4)) : null);
const ratingOf = (r: any) => (typeof r?.value === 'number' && r.value > 0 ? Math.round(r.value * 10) / 10 : null);

/** Lidarr/Readarr lookup results as Discover cards. */
export function mapLookup(type: 'artist' | 'album' | 'book', x: any): Omit<DiscoverResult, 'availableItemId' | 'requestId' | 'requestStatus'> | null {
  if (type === 'artist') {
    if (!x?.foreignArtistId) return null;
    const poster = coverOf(x.images, ['poster', 'cover', 'fanart']);
    return { tmdbId: x.foreignArtistId, externalId: x.foreignArtistId, mediaType: 'artist', title: x.artistName ?? 'Unknown artist', subtitle: x.disambiguation || (x.artistType ?? null), year: null, overview: x.overview ?? null, rating: ratingOf(x.ratings), posterUrl: imageUrl(registerRemoteImage(poster, { untrusted: true })), backdropUrl: null };
  }
  if (type === 'album') {
    if (!x?.foreignAlbumId) return null;
    const poster = coverOf(x.images, ['cover', 'poster', 'disc']);
    return { tmdbId: x.foreignAlbumId, externalId: x.foreignAlbumId, mediaType: 'album', title: x.title ?? 'Unknown album', subtitle: x.artist?.artistName ?? null, year: yearOf(x.releaseDate), overview: x.overview ?? null, rating: ratingOf(x.ratings), posterUrl: imageUrl(registerRemoteImage(poster, { untrusted: true })), backdropUrl: null };
  }
  if (!x?.foreignBookId) return null;
  const poster = coverOf(x.images, ['cover', 'poster']);
  return { tmdbId: String(x.foreignBookId), externalId: String(x.foreignBookId), mediaType: 'book', title: x.title ?? 'Unknown book', subtitle: x.author?.authorName ?? x.authorTitle?.replace(/\s+\S+$/, '') ?? null, year: yearOf(x.releaseDate), overview: x.overview ?? null, rating: ratingOf(x.ratings), posterUrl: imageUrl(registerRemoteImage(poster, { untrusted: true })), backdropUrl: null };
}

/** Search Lidarr (artists + albums) or Readarr (books) through their own lookup, no TMDB needed. */
export async function discoverArr(user: User, kind: 'music' | 'books', q: string): Promise<DiscoverResponse> {
  assertOn();
  const term = q.trim();
  const inst = instanceFor(kind === 'music' ? 'lidarr' : 'readarr');
  if (!inst) throw badRequest(`No ${kind === 'music' ? 'Lidarr' : 'Readarr'} instance is configured`);
  if (effectivePermissions(user)[kind === 'music' ? 'music' : 'book'] === 'none') throw forbidden(`You don't have permission to request ${kind}`);
  if (!term) return { results: [], page: 1, totalPages: 1 };
  const t = encodeURIComponent(term);
  let found: ReturnType<typeof mapLookup>[] = [];
  if (kind === 'music') {
    const [artists, albums] = await Promise.all([
      arrFetch<any[]>(inst, `/artist/lookup?term=${t}`),
      arrFetch<any[]>(inst, `/album/lookup?term=${t}`).catch(() => []),
    ]);
    found = [...(artists ?? []).slice(0, 20).map((x) => mapLookup('artist', x)), ...(albums ?? []).slice(0, 30).map((x) => mapLookup('album', x))];
  } else {
    found = (await arrFetch<any[]>(inst, `/book/lookup?term=${t}`) ?? []).slice(0, 40).map((x) => mapLookup('book', x));
  }
  const open = openRequests();
  const bl = blacklistSet();
  const manager = canManageRequests(user);
  return {
    page: 1, totalPages: 1,
    results: found.filter((x): x is NonNullable<typeof x> => !!x).flatMap((m) => {
      const blacklisted = bl.has(blKey(m.mediaType, m.externalId));
      if (blacklisted && !manager) return [];
      const req = open.get(`${m.mediaType}:${m.externalId}`);
      return [{ ...m, availableItemId: findAvailable(m.externalId, m.mediaType, m), requestId: req?.id ?? null, requestStatus: (req?.status as RequestStatus) ?? null, blacklisted }];
    }),
  };
}

/** Find one artist/album/book in Lidarr/Readarr by its foreign id. */
async function lookupOne(inst: ArrInstance, type: 'artist' | 'album' | 'book', id: string, titleHint?: string): Promise<any | null> {
  const endpoint = type === 'artist' ? '/artist/lookup' : type === 'album' ? '/album/lookup' : '/book/lookup';
  const match = (x: any) => String(type === 'artist' ? x?.foreignArtistId : type === 'album' ? x?.foreignAlbumId : x?.foreignBookId) === String(id);
  const terms = type === 'book' ? [titleHint, `readarr:${id}`] : [`lidarr:${id}`, titleHint];
  for (const term of terms) {
    if (!term) continue;
    const list = await arrFetch<any[]>(inst, `${endpoint}?term=${encodeURIComponent(term)}`).catch(() => []);
    const hit = (list ?? []).find(match);
    if (hit) return hit;
  }
  return null;
}

/* ------------------------------ listing ------------------------------ */

const queueKey = (type: RequestMediaType, id: string) => `${type}:${id}`;

function queueKeys(kind: ArrKind, q: ArrQueueItem): string[] {
  if (kind === 'radarr' && q.ids.tmdbId) return [queueKey('movie', q.ids.tmdbId)];
  if (kind === 'sonarr' && q.ids.tvdbId) return [`tvdb:${q.ids.tvdbId}`];
  if (kind === 'lidarr') return [q.ids.foreignArtistId && queueKey('artist', q.ids.foreignArtistId), q.ids.foreignAlbumId && queueKey('album', q.ids.foreignAlbumId)].filter(Boolean) as string[];
  if (kind === 'readarr' && q.ids.foreignBookId) return [queueKey('book', q.ids.foreignBookId)];
  return [];
}

/** Attach live download progress from the *arr queues to approved/processing requests. */
async function withDownloads(list: MediaRequest[]): Promise<MediaRequest[]> {
  const active = list.filter((r) => r.status === 'processing' || r.status === 'approved');
  if (!active.length || !enabledInstances(DOWNLOADERS).length) return list;
  const queue = await getQueue({ timeoutMs: 6000 }).catch(() => null);
  if (!queue) return list;
  const byKey = new Map<string, { items: ArrQueueItem[]; instance: string }>();
  for (const s of queue.sections) for (const q of s.items) for (const k of queueKeys(s.instance.kind, q)) {
    const e = byKey.get(k) ?? { items: [], instance: s.instance.name };
    e.items.push(q);
    byKey.set(k, e);
  }
  if (!byKey.size) return list;
  const tvdb = new Map(db.all(`SELECT id, options FROM media_requests WHERE id IN (${active.map(() => '?').join(',')})`, ...active.map((r) => r.id)).map((r) => [r.id, parseJson<RequestOpts>(r.options, {}).tvdbId ?? null]));
  return list.map((r) => {
    if (r.status !== 'processing' && r.status !== 'approved') return r;
    const key = r.mediaType === 'show' ? (tvdb.get(r.id) ? `tvdb:${tvdb.get(r.id)}` : null) : queueKey(r.mediaType, r.externalId);
    const hit = key ? byKey.get(key) : null;
    if (!hit) return r;
    const size = hit.items.reduce((n, q) => n + q.size, 0);
    const left = hit.items.reduce((n, q) => n + q.sizeLeft, 0);
    const progress = size > 0 ? Math.round(((size - left) / size) * 100) : Math.round(hit.items[0].progress);
    const status = hit.items.length > 1 ? `${hit.items.length} downloads` : hit.items[0].status;
    return { ...r, download: { progress, status, timeLeft: hit.items[0].timeLeft, instance: hit.instance } };
  });
}

const SORTS: Record<NonNullable<RequestListQuery['sort']>, string> = {
  requested: 'm.requested_at', updated: 'COALESCE(m.updated_at, m.decided_at, m.requested_at)', title: 'm.title COLLATE NOCASE', status: 'm.status',
};

/** Requests list: managers see everyone's (filterable by user), others only their own. */
export async function listRequests(user: User, filter: RequestListQuery): Promise<MediaRequest[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const manager = canManageRequests(user);
  if (!manager || filter.mine) where.push('m.requested_by = ?'), params.push(user.id);
  else if (filter.userId) where.push('m.requested_by = ?'), params.push(String(filter.userId));
  if (filter.status) where.push('m.status = ?'), params.push(String(filter.status));
  if (filter.mediaType) {
    if (filter.mediaType === 'artist' || filter.mediaType === 'album') where.push("m.media_type IN ('artist','album')");
    else where.push('m.media_type = ?'), params.push(String(filter.mediaType));
  }
  const sort = SORTS[filter.sort as keyof typeof SORTS] ?? SORTS.requested;
  const order = filter.order === 'asc' ? 'ASC' : filter.order === 'desc' ? 'DESC' : filter.sort === 'title' ? 'ASC' : 'DESC';
  const list = db.all(`${SELECT_REQ} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${sort} ${order} LIMIT 500`, ...(params as any[])).map((r) => toRequest(r, user));
  return withDownloads(list);
}

export function getRequest(user: User, id: string): MediaRequest {
  const r = getRow(id);
  if (!r) throw notFound('Request not found');
  if (r.requested_by !== user.id && !canManageRequests(user)) throw notFound('Request not found');
  return toRequest(r, user);
}

/* ------------------------------ timeline & comments ------------------------------ */

export function requestActivity(user: User, id: string): RequestActivity[] {
  getRequest(user, id);
  return db.all('SELECT * FROM request_activity WHERE request_id = ? ORDER BY created_at, rowid', id).map((a) => ({
    id: a.id, kind: a.kind, user: userRef(a.user_id), body: a.body ?? null, createdAt: a.created_at,
  }));
}

export function addComment(user: User, id: string, body: string): RequestActivity {
  const req = getRequest(user, id);
  const text = String(body ?? '').trim().slice(0, 2000);
  if (!text) throw badRequest('Write a comment');
  logRequest(id, 'comment', user.id, text);
  bus.emit('request.comment', { request: req, user, body: text });
  return requestActivity(user, id).pop()!;
}

/* ------------------------------ creating ----------------------------- */

const levelError = (type: RequestMediaType) => new HttpError(403, `You don't have permission to request ${TYPE_WORD[type]}`, 'request_permission');

export async function createRequest(user: User, req: CreateMediaRequest, via: 'user' | 'watchlist' = 'user'): Promise<MediaRequest> {
  const type = req.mediaType;
  if (!ALL_TYPES.includes(type)) throw badRequest('mediaType must be movie, show, artist, album or book');
  const video = VIDEO_TYPES.includes(type);
  if (video) assertEnabled();
  else assertOn();
  const extId = String(req.externalId ?? req.tmdbId ?? '').trim();
  if (video ? !/^\d+$/.test(extId) : !/^[\w.:-]{1,100}$/.test(extId)) throw badRequest(video ? 'Invalid TMDB id' : 'Invalid id');
  const s = getSettings().requests;
  let seasonMode: SeasonMode = type === 'show' ? (['all', 'first', 'latest', 'specific'].includes(req.seasonMode as string) ? req.seasonMode! : req.seasons?.length ? 'specific' : 'all') : 'all';
  let seasons = type === 'show' && seasonMode === 'specific' ? [...new Set((req.seasons ?? []).filter((n) => Number.isInteger(n) && n >= 0))].slice(0, 100).sort((a, b) => a - b) : [];
  if (seasonMode === 'specific' && !seasons.length) throw badRequest('Pick at least one season');
  const also4k = !!req.also4k;
  if (also4k && !video) throw badRequest('4K requests are for movies and shows');
  // Permissions: the base kind, then the 4K copy.
  if (requestLevel(user, type) === 'none') throw levelError(type);
  if (also4k) {
    if (requestLevel(user, type, true) === 'none') throw new HttpError(403, 'You are not allowed to request 4K copies', 'request_permission');
    if (!instanceFor(arrKindFor(type), true)) throw badRequest(`No 4K ${ARR_LABEL[arrKindFor(type)]} instance is configured`);
  }
  if (isBlacklisted(type, extId)) throw new HttpError(403, 'This title has been blacklisted by the server admin', 'blacklisted');

  // Metadata: TMDB for movies/shows, the Lidarr/Readarr lookup for music and books.
  let meta: { title: string; subtitle: string | null; year: number | null; poster: string | null; tvdbId?: string | null; rating?: number | null };
  let units = 1;
  let resolvedSeasons: number[] | undefined;
  if (video) {
    const m = type === 'movie' ? await tmdb.movieDetails(extId) : await tmdb.tvDetails(extId);
    if (!m) throw notFound('Title not found on TMDB');
    meta = { title: m.title, subtitle: null, year: m.year ?? null, poster: registerImage(m.poster), tvdbId: m.tvdbId ?? null, rating: m.rating ?? null };
  } else {
    const inst = instanceFor(arrKindFor(type));
    if (!inst) throw badRequest(`No ${ARR_LABEL[arrKindFor(type)]} instance is configured`);
    const x = await lookupOne(inst, type as 'artist' | 'album' | 'book', extId, req.title);
    const m = x ? mapLookup(type as 'artist' | 'album' | 'book', x) : null;
    if (!m) throw notFound(`${ARR_LABEL[arrKindFor(type)]} couldn't find that ${type}`);
    meta = { title: m.title, subtitle: type === 'artist' ? null : m.subtitle ?? null, year: m.year, poster: m.posterUrl?.split('/').pop() ?? null };
  }

  if (type === 'show') {
    // Shows: request only seasons that aren't in the library or already requested (partially available shows).
    const info = await tmdb.tvSeasons(extId).catch(() => null);
    const regular = (info?.seasons ?? []).filter((x) => x.seasonNumber > 0);
    if (regular.length) {
      const lib = libraryEpisodes(showItemFor(extId));
      const open = requestedSeasons(extId);
      const want = [...pickSeasons(regular.map((x) => x.seasonNumber), seasonMode, seasons)];
      const free = want.filter((n) => {
        const have = lib.get(n) ?? 0;
        const total = regular.find((x) => x.seasonNumber === n)?.episodeCount ?? 0;
        return !(have > 0 && have >= total) && !open.all && !open.seasons.has(n);
      });
      if (!free.length) throw conflict(want.length > 1 ? 'Those seasons are already available or requested' : 'That season is already available or requested');
      if (free.length !== want.length) {
        seasonMode = 'specific';
        seasons = free;
      }
      resolvedSeasons = free;
      units = free.length;
    } else {
      if (findAvailable(extId, type, meta)) throw conflict('That title is already in the library');
      if (db.get("SELECT 1 FROM media_requests WHERE tmdb_id = ? AND media_type = 'show' AND status IN ('pending','approved','processing')", extId)) throw conflict('Someone has already requested this');
      units = seasonMode === 'specific' ? seasons.length : 1;
    }
  } else {
    if (findAvailable(extId, type, meta)) throw conflict('That title is already in the library');
    if (db.get("SELECT 1 FROM media_requests WHERE tmdb_id = ? AND media_type = ? AND status IN ('pending','approved','processing')", extId, type)) {
      throw conflict('Someone has already requested this');
    }
  }

  // Quota (seasons for shows), over a rolling window.
  const qk = quotaKind(type);
  const q = quotaStatus(user, qk);
  if (q.remaining !== null && q.remaining < units) {
    const what = qk === 'show' ? 'seasons' : qk === 'movie' ? 'movies' : qk === 'music' ? 'music requests' : 'books';
    throw new HttpError(429, q.remaining > 0 && qk === 'show'
      ? `You can request ${q.remaining} more season${q.remaining === 1 ? '' : 's'} in the next ${q.days} days (limit ${q.limit})`
      : `You've reached your limit of ${q.limit} ${what} per ${q.days} days`, 'request_limit');
  }

  const id = newId();
  const options: RequestOpts = {
    seasonMode, units, ...(resolvedSeasons ? { resolvedSeasons } : {}), ...(type === 'artist' ? { monitor: req.monitor === 'future' ? 'future' : 'all' } : {}),
    ...(meta.tvdbId ? { tvdbId: meta.tvdbId } : {}), ...(meta.rating != null ? { rating: meta.rating } : {}),
  };
  const now = nowIso();
  db.insert('media_requests', {
    id, tmdb_id: extId, media_type: type, title: meta.title, subtitle: meta.subtitle, year: meta.year ?? null, poster: meta.poster,
    seasons: JSON.stringify(seasons), status: 'pending', also_4k: also4k, options: JSON.stringify(options),
    requested_by: user.id, requested_at: now, updated_at: now, note: req.note ? String(req.note).slice(0, 500) : null,
  });
  const label = `${meta.title}${meta.subtitle ? ` by ${meta.subtitle}` : ''}${meta.year ? ` (${meta.year})` : ''}${also4k ? ' (+4K)' : ''}`;
  logActivity('request.create', `${user.displayName} requested ${label}`, { userId: user.id, userName: user.displayName });
  logRequest(id, 'created', user.id, via === 'watchlist' ? 'Added to watchlist' : req.note ? String(req.note).slice(0, 500) : null);
  // Auto-approve: the user's permission for this kind, or the global rating rule for movies/shows.
  const minRating = Number(s.autoApproveMinRating) || 0;
  const auto = requestLevel(user, type, also4k) === 'auto' || (video && minRating > 0 && (meta.rating ?? 0) >= minRating);
  bus.emit('request.created', { ...toRequest(getRow(id)!), autoApproved: auto });
  if (auto) return doApprove(user, id, true);
  return out(id, user);
}

/* ------------------------------ deciding ----------------------------- */

/** Validate overrides against the configured instances. */
function cleanOverrides(kind: ArrKind, ov: RequestArrOverrides | undefined, prev: RequestArrOverrides | undefined): RequestArrOverrides {
  const next: RequestArrOverrides = { ...(prev ?? {}) };
  if (!ov) return next;
  const check = (id: string | null | undefined, want4k: boolean) => {
    if (!id) return null;
    const inst = enabledInstances([kind]).find((i) => i.id === id);
    if (!inst) throw badRequest(`No enabled ${ARR_LABEL[kind]} instance with that id`);
    if (want4k && !inst.is4k) throw badRequest(`${inst.name} isn't a 4K instance`);
    return inst.id;
  };
  if (ov.instanceId !== undefined) next.instanceId = check(ov.instanceId, false);
  if (ov.instance4kId !== undefined) next.instance4kId = check(ov.instance4kId, true);
  const num = (v: unknown) => (v == null || v === '' ? null : Number.isInteger(Number(v)) ? Number(v) : null);
  if (ov.qualityProfileId !== undefined) next.qualityProfileId = num(ov.qualityProfileId);
  if (ov.languageProfileId !== undefined) next.languageProfileId = num(ov.languageProfileId);
  if (ov.rootFolderPath !== undefined) next.rootFolderPath = ov.rootFolderPath ? String(ov.rootFolderPath).slice(0, 500) : null;
  if (ov.tags !== undefined) next.tags = Array.isArray(ov.tags) ? ov.tags.map(Number).filter((n) => Number.isInteger(n)).slice(0, 50) : null;
  return next;
}

/** PATCH /requests/:id: change seasons, 4K and the *arr target before approving. */
export function editRequest(user: User, id: string, e: EditMediaRequest): MediaRequest {
  assertManager(user);
  const r = getRow(id);
  if (!r) throw notFound('Request not found');
  if (!['pending', 'failed', 'declined'].includes(r.status)) throw badRequest(`Request is already ${r.status}`);
  const o = parseJson<RequestOpts>(r.options, {});
  const patch: Row = {};
  const changes: string[] = [];
  if (r.media_type === 'show' && (e.seasonMode !== undefined || e.seasons !== undefined)) {
    const mode: SeasonMode = ['all', 'first', 'latest', 'specific'].includes(e.seasonMode as string) ? e.seasonMode! : e.seasons?.length ? 'specific' : (o.seasonMode ?? 'all');
    const seasons = mode === 'specific' ? [...new Set((e.seasons ?? []).filter((n) => Number.isInteger(n) && n >= 0))].sort((a, b) => a - b) : [];
    if (mode === 'specific' && !seasons.length) throw badRequest('Pick at least one season');
    patch.seasons = JSON.stringify(seasons);
    o.seasonMode = mode;
    o.resolvedSeasons = mode === 'specific' ? seasons : undefined;
    o.units = mode === 'specific' ? seasons.length : o.units ?? 1;
    changes.push(mode === 'specific' ? `seasons ${seasons.join(', ')}` : `${mode} seasons`);
  }
  if (e.also4k !== undefined) {
    if (e.also4k && !VIDEO_TYPES.includes(r.media_type)) throw badRequest('4K requests are for movies and shows');
    if (e.also4k && !instanceFor(arrKindFor(r.media_type), true)) throw badRequest(`No 4K ${ARR_LABEL[arrKindFor(r.media_type)]} instance is configured`);
    patch.also_4k = !!e.also4k;
    changes.push(e.also4k ? 'also 4K' : 'no 4K');
  }
  if (e.arr) {
    o.arr = cleanOverrides(arrKindFor(r.media_type), e.arr, o.arr);
    changes.push('download settings');
  }
  patch.options = JSON.stringify(o);
  patch.updated_at = nowIso();
  db.update('media_requests', id, patch);
  if (changes.length) logRequest(id, 'edited', user.id, changes.join('; '));
  return out(id, user);
}

/** GET /requests/:id/arr-options: instances with their profiles/folders/tags for the edit-before-approve form. */
export async function requestArrChoices(user: User, id: string): Promise<RequestArrChoices> {
  assertManager(user);
  const r = getRow(id);
  if (!r) throw notFound('Request not found');
  const kind = arrKindFor(r.media_type);
  const instances = await Promise.all(enabledInstances([kind]).map(async (i) => ({
    id: i.id, name: i.name || ARR_LABEL[kind], is4k: !!i.is4k,
    defaults: { qualityProfileId: i.qualityProfileId ?? null, rootFolderPath: i.rootFolderPath ?? null, languageProfileId: i.languageProfileId ?? null, tags: i.tags ?? [] },
    options: await arrOptionsFor(i).catch((e) => ({ ok: false, message: (e as Error).message, qualityProfiles: [], rootFolders: [] } as ArrOptions)),
  })));
  return { kind, instances };
}

export async function approveRequest(user: User, id: string, edits?: EditMediaRequest): Promise<MediaRequest> {
  assertManager(user);
  if (edits && (edits.seasons !== undefined || edits.seasonMode !== undefined || edits.also4k !== undefined || edits.arr)) editRequest(user, id, edits);
  return doApprove(user, id, false);
}

async function doApprove(actor: User, id: string, auto: boolean): Promise<MediaRequest> {
  const r = getRow(id);
  if (!r) throw notFound('Request not found');
  if (!['pending', 'failed', 'declined'].includes(r.status)) throw badRequest(`Request is already ${r.status}`);
  const retry = r.status === 'failed';
  db.run("UPDATE media_requests SET status = 'approved', decided_by = ?, decided_at = ?, updated_at = ?, error = NULL WHERE id = ?", actor.id, nowIso(), nowIso(), id);
  logRequest(id, retry ? 'retried' : 'approved', actor.id, auto ? 'Approved automatically' : null);
  const kind = arrKindFor(r.media_type);
  const ov = parseJson<RequestOpts>(r.options, {}).arr ?? {};
  const pick = (iid: string | null | undefined, want4k: boolean) => (iid ? enabledInstances([kind]).find((i) => i.id === iid) ?? null : instanceFor(kind, want4k));
  const main = pick(ov.instanceId, false);
  const uhd = r.also_4k ? pick(ov.instance4kId, true) : null;
  const targets = [main, uhd].filter((x, i, a): x is ArrInstance => !!x && a.findIndex((y) => y?.id === x.id) === i);
  let failed = false;
  if (targets.length) {
    const errors: string[] = [];
    let sent = 0;
    for (const inst of targets) {
      try {
        await sendToArr(inst, r, inst === main ? ov : {});
        sent++;
      } catch (e) {
        errors.push(`${inst.name}: ${(e as Error).message}`);
        log.warn(`Sending "${r.title}" to ${inst.name} failed: ${(e as Error).message}`);
      }
    }
    if (sent) {
      db.run("UPDATE media_requests SET status = 'processing', error = ? WHERE id = ?", errors.length ? errors.join('; ') : null, id);
      logRequest(id, 'processing', null, `Sent to ${targets.filter((_, i) => i < sent + errors.length).map((t) => t.name).join(' and ')}`);
    } else {
      db.run("UPDATE media_requests SET status = 'failed', error = ? WHERE id = ?", errors.join('; '), id);
      logRequest(id, 'failed', null, errors.join('; '));
      failed = true;
    }
    invalidate('queue:');
  }
  const res = out(id, actor);
  events.toUser(r.requested_by, { type: 'library.updated', libraryId: '' });
  bus.emit('request.updated', res);
  bus.emit('request.approved', { request: res, actor, auto });
  if (failed) bus.emit('request.failed', { request: res, actor });
  return res;
}

export function declineRequest(user: User, id: string, reason?: string): MediaRequest {
  assertManager(user);
  const r = getRow(id);
  if (!r) throw notFound('Request not found');
  if (!['pending', 'failed', 'approved'].includes(r.status)) throw badRequest(`Request is already ${r.status}`);
  const why = reason ? String(reason).trim().slice(0, 500) || null : null;
  db.run("UPDATE media_requests SET status = 'declined', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?", user.id, nowIso(), nowIso(), id);
  setOpts(id, { declineReason: why });
  logRequest(id, 'declined', user.id, why);
  const res = out(id, user);
  bus.emit('request.updated', res);
  bus.emit('request.declined', { request: res, actor: user, reason: why });
  return res;
}

/** Remove a title from Radarr/Sonarr (files are kept). Lidarr/Readarr are left alone. */
async function removeFromArr(r: Row): Promise<string[]> {
  const kind = arrKindFor(r.media_type);
  if (kind !== 'radarr' && kind !== 'sonarr') return [];
  const removed: string[] = [];
  const o = parseJson<RequestOpts>(r.options, {});
  const tvdb = kind === 'sonarr' ? o.tvdbId ?? (await tmdb.tvExternalIds(r.tmdb_id).catch(() => ({ tvdb: null }))).tvdb : null;
  for (const inst of enabledInstances([kind])) {
    try {
      const list = kind === 'radarr'
        ? await arrFetch<any[]>(inst, `/movie?tmdbId=${encodeURIComponent(r.tmdb_id)}`)
        : tvdb ? await arrFetch<any[]>(inst, `/series?tvdbId=${encodeURIComponent(tvdb)}`) : [];
      const hit = (Array.isArray(list) ? list : []).find((x) => String(kind === 'radarr' ? x.tmdbId : x.tvdbId) === String(kind === 'radarr' ? r.tmdb_id : tvdb));
      if (!hit?.id) continue;
      await arrFetch(inst, `/${kind === 'radarr' ? 'movie' : 'series'}/${hit.id}?deleteFiles=false&addImportExclusion=false`, { method: 'DELETE' });
      removed.push(inst.name);
    } catch (e) {
      log.warn(`Removing "${r.title}" from ${inst.name} failed: ${(e as Error).message}`);
    }
  }
  invalidate('queue:');
  return removed;
}

export async function deleteRequest(user: User, id: string, opts: { removeFromArr?: boolean } = {}): Promise<{ ok: true; removedFrom: string[] }> {
  const r = getRow(id);
  if (!r) throw notFound('Request not found');
  const manager = canManageRequests(user);
  if (!manager && (r.requested_by !== user.id || r.status !== 'pending')) throw forbidden('You can only withdraw your own pending requests');
  const removedFrom = manager && opts.removeFromArr ? await removeFromArr(r) : [];
  db.run('DELETE FROM media_requests WHERE id = ?', id);
  db.run('UPDATE discover_watchlist SET request_id = NULL WHERE request_id = ?', id);
  return { ok: true, removedFrom };
}

/** POST /requests/bulk: approve / decline / retry / delete several requests. */
export async function bulkRequests(user: User, b: BulkRequestAction): Promise<BulkRequestResult> {
  assertManager(user);
  const ids = Array.isArray(b?.ids) ? [...new Set(b.ids.map(String))].slice(0, 200) : [];
  if (!['approve', 'decline', 'delete', 'retry'].includes(b?.action)) throw badRequest('action must be approve, decline, retry or delete');
  const res: BulkRequestResult = { ok: [], failed: [] };
  for (const id of ids) {
    try {
      if (b.action === 'approve' || b.action === 'retry') {
        const r = await approveRequest(user, id);
        if (r.status === 'failed') throw new Error(r.error ?? 'Sending failed');
      } else if (b.action === 'decline') declineRequest(user, id, b.note);
      else await deleteRequest(user, id, { removeFromArr: !!b.removeFromArr });
      res.ok.push(id);
    } catch (e) {
      res.failed.push({ id, error: (e as Error).message });
    }
  }
  return res;
}

/** Recently requested titles (Discover row). */
export function recentlyRequested(user: User, limit = 20): DiscoverResult[] {
  const bl = blacklistSet();
  return db.all("SELECT * FROM media_requests WHERE media_type IN ('movie','show') AND status != 'declined' ORDER BY requested_at DESC LIMIT ?", limit * 2)
    .filter((r, i, a) => a.findIndex((x) => x.media_type === r.media_type && x.tmdb_id === r.tmdb_id) === i && !bl.has(blKey(r.media_type, r.tmdb_id)))
    .slice(0, limit)
    .map((r) => ({
      tmdbId: r.tmdb_id, externalId: r.tmdb_id, mediaType: r.media_type, title: r.title, year: r.year ?? null, overview: null, rating: null,
      posterUrl: imageUrl(r.poster), backdropUrl: null, availableItemId: r.item_id ?? findAvailable(r.tmdb_id, r.media_type), requestId: r.id, requestStatus: r.status,
      onWatchlist: !!db.get('SELECT 1 FROM discover_watchlist WHERE user_id = ? AND media_type = ? AND external_id = ?', user.id, r.media_type, r.tmdb_id),
    }));
}

/** Mark approved/processing requests as available once the title (all requested seasons) shows up in a library. */
export function checkAvailability(): number {
  let n = 0;
  for (const r of db.all("SELECT * FROM media_requests WHERE status IN ('approved','processing','failed','pending')")) {
    const item = findAvailable(r.tmdb_id, r.media_type, { title: r.title, subtitle: r.subtitle });
    if (!item) continue;
    if (r.media_type === 'show') {
      const want = parseJson<RequestOpts>(r.options, {}).resolvedSeasons ?? parseJson<number[]>(r.seasons, []);
      const lib = libraryEpisodes(item);
      if (want.length && !want.every((s) => (lib.get(s) ?? 0) > 0)) continue;
    }
    db.run("UPDATE media_requests SET status = 'available', item_id = ?, error = NULL, updated_at = ? WHERE id = ?", item, nowIso(), r.id);
    logRequest(r.id, 'available', null, null);
    const res = out(r.id);
    bus.emit('request.available', res);
    events.toUser(r.requested_by, { type: 'library.updated', libraryId: '' });
    n++;
  }
  return n;
}

bus.on('library.new', () => setTimeout(() => {
  try {
    checkAvailability();
  } catch (e) {
    log.warn('Availability check failed', (e as Error).message);
  }
}, 2000));

/* ------------------------- sending to the *arrs ---------------------- */

async function sendToArr(inst: ArrInstance, r: Row, ov: RequestArrOverrides = {}) {
  const o = parseJson<RequestOpts>(r.options, {});
  if (r.media_type === 'movie') return addToRadarr(inst, r.tmdb_id, ov);
  if (r.media_type === 'show') return addToSonarr(inst, r.tmdb_id, o.seasonMode ?? 'all', o.resolvedSeasons?.length && o.seasonMode !== 'all' ? o.resolvedSeasons : parseJson<number[]>(r.seasons, []), o.tvdbId ?? null, ov);
  if (r.media_type === 'artist') return addArtist(inst, r.tmdb_id, r.title, o.monitor ?? 'all', ov);
  if (r.media_type === 'album') return addAlbum(inst, r.tmdb_id, r.title, ov);
  if (r.media_type === 'book') return addBook(inst, r.tmdb_id, r.title, ov);
}

/** Quality profile, root folder, tags (and metadata profile for Lidarr/Readarr): the manager's override, the instance's choice, or the first one. */
async function defaultsFor(inst: ArrInstance, ov: RequestArrOverrides = {}) {
  const qualityProfileId = ov.qualityProfileId ?? inst.qualityProfileId ?? (await arrFetch<any[]>(inst, '/qualityprofile'))[0]?.id;
  const rootFolderPath = ov.rootFolderPath ?? inst.rootFolderPath ?? (await arrFetch<any[]>(inst, '/rootfolder'))[0]?.path;
  let metadataProfileId: number | undefined;
  if (inst.kind === 'lidarr' || inst.kind === 'readarr') {
    metadataProfileId = inst.metadataProfileId ?? (await arrFetch<any[]>(inst, '/metadataprofile').catch(() => []))?.find((p) => p.name !== 'None')?.id;
  }
  if (!qualityProfileId || !rootFolderPath) throw new Error(`Choose a quality profile and root folder for ${inst.name}`);
  return { qualityProfileId, rootFolderPath, metadataProfileId, tags: ov.tags ?? inst.tags ?? [], languageProfileId: ov.languageProfileId ?? inst.languageProfileId ?? null };
}

const already = (e: unknown) => /already been added|already exists|already in use/i.test((e as Error).message);
const searchOnAdd = (inst: ArrInstance) => inst.searchOnAdd !== false;

async function addToRadarr(inst: ArrInstance, tmdbId: string, ov: RequestArrOverrides) {
  const movie = await arrFetch(inst, `/movie/lookup/tmdb?tmdbId=${encodeURIComponent(tmdbId)}`);
  if (!movie) throw new Error('Radarr could not find this movie');
  if (movie.id) {
    if (searchOnAdd(inst) && !movie.hasFile) await arrFetch(inst, '/command', { method: 'POST', body: JSON.stringify(commandBody('MoviesSearch', [movie.id])) });
    return;
  }
  const d = await defaultsFor(inst, ov);
  try {
    await arrFetch(inst, '/movie', {
      method: 'POST',
      body: JSON.stringify({ ...movie, qualityProfileId: d.qualityProfileId, rootFolderPath: d.rootFolderPath, tags: d.tags, monitored: true, minimumAvailability: 'released', addOptions: { monitor: inst.monitor || 'movieOnly', searchForMovie: searchOnAdd(inst) } }),
    });
  } catch (e) {
    if (!already(e)) throw e;
  }
}

/** Season numbers to monitor for a mode ("all" → every regular season). */
export function pickSeasons(available: number[], mode: SeasonMode, specific: number[]): Set<number> {
  const regular = available.filter((n) => n > 0).sort((a, b) => a - b);
  if (mode === 'first') return new Set(regular.slice(0, 1));
  if (mode === 'latest') return new Set(regular.slice(-1));
  if (mode === 'specific') return new Set(specific);
  return new Set(regular);
}

async function addToSonarr(inst: ArrInstance, tmdbId: string, mode: SeasonMode, seasons: number[], knownTvdb: string | null, ov: RequestArrOverrides) {
  const tvdb = knownTvdb ?? (await tmdb.tvExternalIds(tmdbId)).tvdb;
  if (!tvdb) throw new Error('This show has no TVDB id, which Sonarr needs');
  const found = await arrFetch<any[]>(inst, `/series/lookup?term=${encodeURIComponent('tvdb:' + tvdb)}`);
  const series = Array.isArray(found) ? found[0] : null;
  if (!series) throw new Error('Sonarr could not find this show');
  const want = pickSeasons((series.seasons ?? []).map((s: any) => s.seasonNumber), mode, seasons);
  if (series.id) {
    // Already in Sonarr: monitor the requested seasons too, then search them.
    const next = { ...series, monitored: true, seasons: (series.seasons ?? []).map((s: any) => ({ ...s, monitored: s.monitored || want.has(s.seasonNumber) })) };
    await arrFetch(inst, `/series/${series.id}`, { method: 'PUT', body: JSON.stringify(next) });
    if (searchOnAdd(inst)) {
      for (const n of want) await arrFetch(inst, '/command', { method: 'POST', body: JSON.stringify(commandBody('SeasonSearch', [series.id], n)) });
    }
    return;
  }
  const d = await defaultsFor(inst, ov);
  const seasonList = (series.seasons ?? []).map((s: any) => ({ ...s, monitored: want.has(s.seasonNumber) }));
  const body: Record<string, unknown> = {
    ...series, seasons: seasonList, qualityProfileId: d.qualityProfileId, rootFolderPath: d.rootFolderPath, tags: d.tags,
    monitored: true, seasonFolder: inst.seasonFolders !== false,
    addOptions: { searchForMissingEpisodes: searchOnAdd(inst), ...(mode === 'all' ? { monitor: inst.monitor || 'all' } : {}) },
  };
  if (d.languageProfileId) body.languageProfileId = d.languageProfileId;
  try {
    await arrFetch(inst, '/series', { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
    if (!already(e)) throw e;
  }
}

async function addArtist(inst: ArrInstance, mbid: string, title: string, monitor: 'all' | 'future', ov: RequestArrOverrides) {
  const artist = await lookupOne(inst, 'artist', mbid, title);
  if (!artist) throw new Error('Lidarr could not find this artist');
  if (artist.id) {
    if (monitor === 'all' && searchOnAdd(inst)) await arrFetch(inst, '/command', { method: 'POST', body: JSON.stringify(commandBody('ArtistSearch', [artist.id])) });
    return;
  }
  const d = await defaultsFor(inst, ov);
  try {
    await arrFetch(inst, '/artist', {
      method: 'POST',
      body: JSON.stringify({
        ...artist, qualityProfileId: d.qualityProfileId, metadataProfileId: d.metadataProfileId, rootFolderPath: d.rootFolderPath, tags: d.tags,
        monitored: true, monitorNewItems: monitor === 'future' ? 'new' : 'all',
        addOptions: { monitor: monitor === 'future' ? 'future' : 'all', searchForMissingAlbums: searchOnAdd(inst) },
      }),
    });
  } catch (e) {
    if (!already(e)) throw e;
  }
}

async function addAlbum(inst: ArrInstance, mbid: string, title: string, ov: RequestArrOverrides) {
  const album = await lookupOne(inst, 'album', mbid, title);
  if (!album) throw new Error('Lidarr could not find this album');
  if (album.id) {
    await arrFetch(inst, '/album/monitor', { method: 'PUT', body: JSON.stringify({ albumIds: [album.id], monitored: true }) });
    if (searchOnAdd(inst)) await arrFetch(inst, '/command', { method: 'POST', body: JSON.stringify(commandBody('AlbumSearch', [album.id])) });
    return;
  }
  const d = await defaultsFor(inst, ov);
  const artist = {
    ...(album.artist ?? {}), qualityProfileId: d.qualityProfileId, metadataProfileId: d.metadataProfileId, rootFolderPath: d.rootFolderPath, tags: d.tags,
    monitored: true, monitorNewItems: 'none', addOptions: { monitor: 'none', searchForMissingAlbums: false },
  };
  try {
    await arrFetch(inst, '/album', { method: 'POST', body: JSON.stringify({ ...album, monitored: true, artist, addOptions: { searchForNewAlbum: searchOnAdd(inst) } }) });
  } catch (e) {
    if (!already(e)) throw e;
  }
}

async function addBook(inst: ArrInstance, foreignBookId: string, title: string, ov: RequestArrOverrides) {
  const book = await lookupOne(inst, 'book', foreignBookId, title);
  if (!book) throw new Error('Readarr could not find this book');
  if (book.id) {
    await arrFetch(inst, '/book/monitor', { method: 'PUT', body: JSON.stringify({ bookIds: [book.id], monitored: true }) });
    if (searchOnAdd(inst)) await arrFetch(inst, '/command', { method: 'POST', body: JSON.stringify(commandBody('BookSearch', [book.id])) });
    return;
  }
  const d = await defaultsFor(inst, ov);
  const author = {
    ...(book.author ?? {}), qualityProfileId: d.qualityProfileId, metadataProfileId: d.metadataProfileId, rootFolderPath: d.rootFolderPath, tags: d.tags,
    monitored: true, monitorNewItems: 'none', addOptions: { monitor: 'none', searchForMissingBooks: false },
  };
  try {
    await arrFetch(inst, '/book', { method: 'POST', body: JSON.stringify({ ...book, monitored: true, author, addOptions: { searchForNewBook: searchOnAdd(inst) } }) });
  } catch (e) {
    if (!already(e)) throw e;
  }
}

/**
 * Legacy POST /requests/arr/test ({ url, apiKey }): test a Radarr or Sonarr connection.
 * The kind is taken from `kind`, or detected from the app's own status.
 */
export async function arrOptions(svc: { url: string; apiKey: string; kind?: ArrKind }): Promise<ArrOptions> {
  let kind: ArrKind = svc.kind ?? 'radarr';
  if (!svc.kind) {
    try {
      const st = await arrFetch({ kind: 'radarr', url: svc.url, apiKey: svc.apiKey }, '/system/status', { timeoutMs: 10000 });
      if (String(st?.appName).toLowerCase() === 'sonarr') kind = 'sonarr';
    } catch {
      /* arrOptionsFor reports the error */
    }
  }
  return arrOptionsFor({ kind, url: svc.url, apiKey: svc.apiKey });
}
