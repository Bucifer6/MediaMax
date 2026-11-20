import type {
  ArrInstance, ArrKind, ArrOptions, ArrQueueItem, CreateMediaRequest, DiscoverResponse, DiscoverResult, MediaRequest, RequestMediaType,
  RequestOptions, RequestStatus, SeasonMode, User,
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

const log = logger('requests');

const VIDEO_TYPES: RequestMediaType[] = ['movie', 'show'];
const ALL_TYPES: RequestMediaType[] = ['movie', 'show', 'artist', 'album', 'book'];

/** The *arr a request type goes to. */
export const arrKindFor = (t: RequestMediaType): ArrKind => (t === 'movie' ? 'radarr' : t === 'show' ? 'sonarr' : t === 'book' ? 'readarr' : 'lidarr');

function assertOn() {
  if (!getBranding().features.requests || !getSettings().requests.enabled) throw forbidden('Requests are turned off on this server');
}
function assertEnabled() {
  assertOn();
  if (!tmdb.tmdbEnabled()) throw badRequest('Requests need a TMDB API key (Admin → Settings → Metadata)');
}

const userRef = (id: string | null) => {
  if (!id) return null;
  const u = db.get('SELECT id, display_name FROM users WHERE id = ?', id);
  return u ? { id: u.id, displayName: u.display_name } : { id, displayName: 'Deleted user' };
};

interface RequestOpts {
  seasonMode?: SeasonMode;
  monitor?: 'all' | 'future';
  tvdbId?: string | null;
}

function toRequest(r: Row): MediaRequest {
  const o = parseJson<RequestOpts>(r.options, {});
  const seasons = parseJson<number[]>(r.seasons, []);
  return {
    id: r.id, tmdbId: r.tmdb_id, externalId: r.tmdb_id, mediaType: r.media_type, title: r.title, subtitle: r.subtitle ?? null, year: r.year ?? null, posterUrl: imageUrl(r.poster),
    seasons, seasonMode: o.seasonMode ?? (seasons.length ? 'specific' : 'all'), monitor: r.media_type === 'artist' ? o.monitor ?? 'all' : null,
    also4k: !!r.also_4k, download: null,
    status: r.status, requestedBy: userRef(r.requested_by)!, requestedAt: r.requested_at,
    decidedBy: userRef(r.decided_by), decidedAt: r.decided_at ?? null, note: r.note ?? null, itemId: r.item_id ?? null, error: r.error ?? null,
  };
}
const getRow = (id: string) => db.get('SELECT * FROM media_requests WHERE id = ?', id);

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

/** What the request form can offer to this user. */
export function requestOptions(user: User): RequestOptions {
  const has = (k: ArrKind) => enabledInstances([k]).length > 0;
  const may4k = user.isAdmin || !!user.allowRequest4k;
  return {
    movies: true, shows: true, music: has('lidarr'), books: has('readarr'),
    can4k: { movie: may4k && !!instanceFor('radarr', true), show: may4k && !!instanceFor('sonarr', true) },
    tmdb: tmdb.tmdbEnabled(),
  };
}

function openRequests() {
  return new Map(db.all("SELECT id, tmdb_id, media_type, status FROM media_requests WHERE status != 'declined'").map((x) => [`${x.media_type}:${x.tmdb_id}`, x]));
}

export async function discover(user: User, q: string, type: 'movie' | 'show' | 'all', page: number): Promise<DiscoverResponse> {
  assertEnabled();
  const r = await tmdb.discover(q, type, Math.max(1, Math.min(50, page || 1)));
  const open = openRequests();
  return {
    page: r.page, totalPages: r.totalPages,
    results: r.results.map((m) => {
      const req = open.get(`${m.mediaType}:${m.id}`);
      return {
        tmdbId: m.id, externalId: m.id, mediaType: m.mediaType, title: m.title, year: m.year, overview: m.overview, rating: m.rating,
        posterUrl: imageUrl(registerImage(m.poster)), backdropUrl: imageUrl(registerImage(m.backdrop)),
        availableItemId: findAvailable(m.id, m.mediaType), requestId: req?.id ?? null, requestStatus: (req?.status as RequestStatus) ?? null,
      };
    }),
  };
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
  return {
    page: 1, totalPages: 1,
    results: found.filter((x): x is NonNullable<typeof x> => !!x).map((m) => {
      const req = open.get(`${m.mediaType}:${m.externalId}`);
      return { ...m, availableItemId: findAvailable(m.externalId, m.mediaType, m), requestId: req?.id ?? null, requestStatus: (req?.status as RequestStatus) ?? null };
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

export async function listRequests(user: User, filter: { status?: string; mine?: boolean }): Promise<MediaRequest[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!user.isAdmin || filter.mine) where.push('requested_by = ?'), params.push(user.id);
  if (filter.status) where.push('status = ?'), params.push(filter.status);
  const list = db.all(`SELECT * FROM media_requests ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY requested_at DESC LIMIT 500`, ...(params as any[])).map(toRequest);
  return withDownloads(list);
}

/* ------------------------------ creating ----------------------------- */

export async function createRequest(user: User, req: CreateMediaRequest): Promise<MediaRequest> {
  const type = req.mediaType;
  if (!ALL_TYPES.includes(type)) throw badRequest('mediaType must be movie, show, artist, album or book');
  const video = VIDEO_TYPES.includes(type);
  if (video) assertEnabled();
  else assertOn();
  const extId = String(req.externalId ?? req.tmdbId ?? '').trim();
  if (video ? !/^\d+$/.test(extId) : !/^[\w.:-]{1,100}$/.test(extId)) throw badRequest(video ? 'Invalid TMDB id' : 'Invalid id');
  const s = getSettings().requests;
  const seasonMode: SeasonMode = type === 'show' ? (['all', 'first', 'latest', 'specific'].includes(req.seasonMode as string) ? req.seasonMode! : req.seasons?.length ? 'specific' : 'all') : 'all';
  const seasons = type === 'show' && seasonMode === 'specific' ? [...new Set((req.seasons ?? []).filter((n) => Number.isInteger(n) && n >= 0))].slice(0, 100).sort((a, b) => a - b) : [];
  if (seasonMode === 'specific' && !seasons.length) throw badRequest('Pick at least one season');
  const also4k = !!req.also4k;
  if (also4k) {
    if (!video) throw badRequest('4K requests are for movies and shows');
    if (!user.isAdmin && !user.allowRequest4k) throw forbidden('You are not allowed to request 4K copies');
    if (!instanceFor(arrKindFor(type), true)) throw badRequest(`No 4K ${ARR_LABEL[arrKindFor(type)]} instance is configured`);
  }

  // Metadata: TMDB for movies/shows, the Lidarr/Readarr lookup for music and books.
  let meta: { title: string; subtitle: string | null; year: number | null; poster: string | null; tvdbId?: string | null };
  if (video) {
    const m = type === 'movie' ? await tmdb.movieDetails(extId) : await tmdb.tvDetails(extId);
    if (!m) throw notFound('Title not found on TMDB');
    meta = { title: m.title, subtitle: null, year: m.year ?? null, poster: registerImage(m.poster), tvdbId: m.tvdbId ?? null };
  } else {
    const inst = instanceFor(arrKindFor(type));
    if (!inst) throw badRequest(`No ${ARR_LABEL[arrKindFor(type)]} instance is configured`);
    const x = await lookupOne(inst, type as 'artist' | 'album' | 'book', extId, req.title);
    const m = x ? mapLookup(type as 'artist' | 'album' | 'book', x) : null;
    if (!m) throw notFound(`${ARR_LABEL[arrKindFor(type)]} couldn't find that ${type}`);
    meta = { title: m.title, subtitle: type === 'artist' ? null : m.subtitle ?? null, year: m.year, poster: m.posterUrl?.split('/').pop() ?? null };
  }

  if (findAvailable(extId, type, meta)) throw conflict('That title is already in the library');
  if (db.get("SELECT 1 FROM media_requests WHERE tmdb_id = ? AND media_type = ? AND status IN ('pending','approved','processing')", extId, type)) {
    throw conflict('Someone has already requested this');
  }
  if (!user.isAdmin && s.weeklyLimit > 0) {
    const n = db.get<{ n: number }>('SELECT COUNT(*) n FROM media_requests WHERE requested_by = ? AND requested_at > ?', user.id, new Date(Date.now() - 7 * 86400000).toISOString())!.n;
    if (n >= s.weeklyLimit) throw new HttpError(429, `You've reached your limit of ${s.weeklyLimit} requests this week`, 'request_limit');
  }
  const id = newId();
  const options: RequestOpts = { seasonMode, ...(type === 'artist' ? { monitor: req.monitor === 'future' ? 'future' : 'all' } : {}), ...(meta.tvdbId ? { tvdbId: meta.tvdbId } : {}) };
  db.insert('media_requests', {
    id, tmdb_id: extId, media_type: type, title: meta.title, subtitle: meta.subtitle, year: meta.year ?? null, poster: meta.poster,
    seasons: JSON.stringify(seasons), status: 'pending', also_4k: also4k, options: JSON.stringify(options),
    requested_by: user.id, requested_at: nowIso(), note: req.note ? String(req.note).slice(0, 500) : null,
  });
  const label = `${meta.title}${meta.subtitle ? ` by ${meta.subtitle}` : ''}${meta.year ? ` (${meta.year})` : ''}${also4k ? ' (+4K)' : ''}`;
  logActivity('request.create', `${user.displayName} requested ${label}`, { userId: user.id, userName: user.displayName });
  bus.emit('request.created', toRequest(getRow(id)!));
  if (user.isAdmin || s.autoApproveUserIds.includes(user.id)) return approveRequest(user, id);
  return toRequest(getRow(id)!);
}

/* ------------------------------ deciding ----------------------------- */

export async function approveRequest(admin: User, id: string): Promise<MediaRequest> {
  const r = getRow(id);
  if (!r) throw notFound('Request not found');
  if (!['pending', 'failed', 'declined'].includes(r.status)) throw badRequest(`Request is already ${r.status}`);
  db.run("UPDATE media_requests SET status = 'approved', decided_by = ?, decided_at = ?, error = NULL WHERE id = ?", admin.id, nowIso(), id);
  const kind = arrKindFor(r.media_type);
  const main = instanceFor(kind);
  const uhd = r.also_4k ? instanceFor(kind, true) : null;
  const targets = [main, uhd].filter((x, i, a): x is ArrInstance => !!x && a.findIndex((y) => y?.id === x.id) === i);
  if (targets.length) {
    const errors: string[] = [];
    let sent = 0;
    for (const inst of targets) {
      try {
        await sendToArr(inst, r);
        sent++;
      } catch (e) {
        errors.push(`${inst.name}: ${(e as Error).message}`);
        log.warn(`Sending "${r.title}" to ${inst.name} failed: ${(e as Error).message}`);
      }
    }
    if (sent) db.run("UPDATE media_requests SET status = 'processing', error = ? WHERE id = ?", errors.length ? errors.join('; ') : null, id);
    else db.run("UPDATE media_requests SET status = 'failed', error = ? WHERE id = ?", errors.join('; '), id);
    invalidate('queue:');
  }
  const out = toRequest(getRow(id)!);
  events.toUser(r.requested_by, { type: 'library.updated', libraryId: '' });
  bus.emit('request.updated', out);
  return out;
}

export function declineRequest(admin: User, id: string, note?: string): MediaRequest {
  const r = getRow(id);
  if (!r) throw notFound('Request not found');
  db.run("UPDATE media_requests SET status = 'declined', decided_by = ?, decided_at = ?, note = COALESCE(?, note) WHERE id = ?", admin.id, nowIso(), note ? String(note).slice(0, 500) : null, id);
  const out = toRequest(getRow(id)!);
  bus.emit('request.updated', out);
  return out;
}

export function deleteRequest(user: User, id: string) {
  const r = getRow(id);
  if (!r) throw notFound('Request not found');
  if (!user.isAdmin && (r.requested_by !== user.id || r.status !== 'pending')) throw forbidden('You can only withdraw your own pending requests');
  db.run('DELETE FROM media_requests WHERE id = ?', id);
}

/** Mark approved/processing requests as available once the title shows up in a library. */
export function checkAvailability(): number {
  let n = 0;
  for (const r of db.all("SELECT * FROM media_requests WHERE status IN ('approved','processing','failed','pending')")) {
    const item = findAvailable(r.tmdb_id, r.media_type, { title: r.title, subtitle: r.subtitle });
    if (!item) continue;
    db.run("UPDATE media_requests SET status = 'available', item_id = ?, error = NULL WHERE id = ?", item, r.id);
    const out = toRequest(getRow(r.id)!);
    bus.emit('request.available', out);
    events.toUser(r.requested_by, { type: 'library.updated', libraryId: '' });
    n++;
  }
  return n;
}

bus.on('library.new', () => setTimeout(() => checkAvailability(), 2000));

/* ------------------------- sending to the *arrs ---------------------- */

async function sendToArr(inst: ArrInstance, r: Row) {
  const o = parseJson<RequestOpts>(r.options, {});
  if (r.media_type === 'movie') return addToRadarr(inst, r.tmdb_id);
  if (r.media_type === 'show') return addToSonarr(inst, r.tmdb_id, o.seasonMode ?? 'all', parseJson<number[]>(r.seasons, []), o.tvdbId ?? null);
  if (r.media_type === 'artist') return addArtist(inst, r.tmdb_id, r.title, o.monitor ?? 'all');
  if (r.media_type === 'album') return addAlbum(inst, r.tmdb_id, r.title);
  if (r.media_type === 'book') return addBook(inst, r.tmdb_id, r.title);
}

/** Quality profile, root folder (and metadata profile for Lidarr/Readarr): the instance's choice or the first one. */
async function defaultsFor(inst: ArrInstance) {
  const qualityProfileId = inst.qualityProfileId ?? (await arrFetch<any[]>(inst, '/qualityprofile'))[0]?.id;
  const rootFolderPath = inst.rootFolderPath ?? (await arrFetch<any[]>(inst, '/rootfolder'))[0]?.path;
  let metadataProfileId: number | undefined;
  if (inst.kind === 'lidarr' || inst.kind === 'readarr') {
    metadataProfileId = inst.metadataProfileId ?? (await arrFetch<any[]>(inst, '/metadataprofile').catch(() => []))?.find((p) => p.name !== 'None')?.id;
  }
  if (!qualityProfileId || !rootFolderPath) throw new Error(`Choose a quality profile and root folder for ${inst.name}`);
  return { qualityProfileId, rootFolderPath, metadataProfileId, tags: inst.tags ?? [] };
}

const already = (e: unknown) => /already been added|already exists|already in use/i.test((e as Error).message);
const searchOnAdd = (inst: ArrInstance) => inst.searchOnAdd !== false;

async function addToRadarr(inst: ArrInstance, tmdbId: string) {
  const movie = await arrFetch(inst, `/movie/lookup/tmdb?tmdbId=${encodeURIComponent(tmdbId)}`);
  if (!movie) throw new Error('Radarr could not find this movie');
  if (movie.id) {
    if (searchOnAdd(inst) && !movie.hasFile) await arrFetch(inst, '/command', { method: 'POST', body: JSON.stringify(commandBody('MoviesSearch', [movie.id])) });
    return;
  }
  const d = await defaultsFor(inst);
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

async function addToSonarr(inst: ArrInstance, tmdbId: string, mode: SeasonMode, seasons: number[], knownTvdb: string | null) {
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
  const d = await defaultsFor(inst);
  const seasonList = (series.seasons ?? []).map((s: any) => ({ ...s, monitored: want.has(s.seasonNumber) }));
  const body: Record<string, unknown> = {
    ...series, seasons: seasonList, qualityProfileId: d.qualityProfileId, rootFolderPath: d.rootFolderPath, tags: d.tags,
    monitored: true, seasonFolder: inst.seasonFolders !== false,
    addOptions: { searchForMissingEpisodes: searchOnAdd(inst), ...(mode === 'all' ? { monitor: inst.monitor || 'all' } : {}) },
  };
  if (inst.languageProfileId) body.languageProfileId = inst.languageProfileId;
  try {
    await arrFetch(inst, '/series', { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
    if (!already(e)) throw e;
  }
}

async function addArtist(inst: ArrInstance, mbid: string, title: string, monitor: 'all' | 'future') {
  const artist = await lookupOne(inst, 'artist', mbid, title);
  if (!artist) throw new Error('Lidarr could not find this artist');
  if (artist.id) {
    if (monitor === 'all' && searchOnAdd(inst)) await arrFetch(inst, '/command', { method: 'POST', body: JSON.stringify(commandBody('ArtistSearch', [artist.id])) });
    return;
  }
  const d = await defaultsFor(inst);
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

async function addAlbum(inst: ArrInstance, mbid: string, title: string) {
  const album = await lookupOne(inst, 'album', mbid, title);
  if (!album) throw new Error('Lidarr could not find this album');
  if (album.id) {
    await arrFetch(inst, '/album/monitor', { method: 'PUT', body: JSON.stringify({ albumIds: [album.id], monitored: true }) });
    if (searchOnAdd(inst)) await arrFetch(inst, '/command', { method: 'POST', body: JSON.stringify(commandBody('AlbumSearch', [album.id])) });
    return;
  }
  const d = await defaultsFor(inst);
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

async function addBook(inst: ArrInstance, foreignBookId: string, title: string) {
  const book = await lookupOne(inst, 'book', foreignBookId, title);
  if (!book) throw new Error('Readarr could not find this book');
  if (book.id) {
    await arrFetch(inst, '/book/monitor', { method: 'PUT', body: JSON.stringify({ bookIds: [book.id], monitored: true }) });
    if (searchOnAdd(inst)) await arrFetch(inst, '/command', { method: 'POST', body: JSON.stringify(commandBody('BookSearch', [book.id])) });
    return;
  }
  const d = await defaultsFor(inst);
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
