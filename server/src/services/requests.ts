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

