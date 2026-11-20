import type { ArrOptions, ArrService, CreateMediaRequest, DiscoverResponse, MediaRequest, RequestMediaType, RequestStatus, User } from '@mediamax/shared';
import { db, type Row } from '../db.js';
import { newId } from '../util/ids.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../util/errors.js';
import { nowIso, parseJson } from '../util/misc.js';
import { getSettings } from './settings.js';
import { getBranding } from './branding.js';
import { registerImage, imageUrl } from './images.js';
import { bus, events } from './events.js';
import { logActivity } from './activity.js';
import { logger } from '../util/log.js';
import * as tmdb from './metadata/tmdb.js';

const log = logger('requests');

function assertEnabled() {
  if (!getBranding().features.requests || !getSettings().requests.enabled) throw forbidden('Requests are turned off on this server');
  if (!tmdb.tmdbEnabled()) throw badRequest('Requests need a TMDB API key (Admin → Settings → Metadata)');
}

const userRef = (id: string | null) => {
  if (!id) return null;
  const u = db.get('SELECT id, display_name FROM users WHERE id = ?', id);
  return u ? { id: u.id, displayName: u.display_name } : { id, displayName: 'Deleted user' };
};

function toRequest(r: Row): MediaRequest {
  return {
    id: r.id, tmdbId: r.tmdb_id, mediaType: r.media_type, title: r.title, year: r.year ?? null, posterUrl: imageUrl(r.poster),
    seasons: parseJson<number[]>(r.seasons, []), status: r.status, requestedBy: userRef(r.requested_by)!, requestedAt: r.requested_at,
    decidedBy: userRef(r.decided_by), decidedAt: r.decided_at ?? null, note: r.note ?? null, itemId: r.item_id ?? null, error: r.error ?? null,
  };
}

/** Library item matching a TMDB id (movies or shows). */
export function findAvailable(tmdbId: string, type: RequestMediaType): string | null {
  return db.get<{ id: string }>(`SELECT id FROM items WHERE type = ? AND json_extract(external_ids, '$.tmdb') = ? LIMIT 1`, type === 'movie' ? 'movie' : 'show', String(tmdbId))?.id ?? null;
}

export async function discover(user: User, q: string, type: 'movie' | 'show' | 'all', page: number): Promise<DiscoverResponse> {
  assertEnabled();
  const r = await tmdb.discover(q, type, Math.max(1, Math.min(50, page || 1)));
  const open = new Map(db.all("SELECT id, tmdb_id, media_type, status FROM media_requests WHERE status != 'declined'").map((x) => [`${x.media_type}:${x.tmdb_id}`, x]));
  return {
    page: r.page, totalPages: r.totalPages,
    results: r.results.map((m) => {
      const req = open.get(`${m.mediaType}:${m.id}`);
      return {
        tmdbId: m.id, mediaType: m.mediaType, title: m.title, year: m.year, overview: m.overview, rating: m.rating,
        posterUrl: imageUrl(registerImage(m.poster)), backdropUrl: imageUrl(registerImage(m.backdrop)),
        availableItemId: findAvailable(m.id, m.mediaType), requestId: req?.id ?? null, requestStatus: (req?.status as RequestStatus) ?? null,
      };
    }),
  };
}

export function listRequests(user: User, filter: { status?: string; mine?: boolean }): MediaRequest[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!user.isAdmin || filter.mine) where.push('requested_by = ?'), params.push(user.id);
  if (filter.status) where.push('status = ?'), params.push(filter.status);
  return db.all(`SELECT * FROM media_requests ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY requested_at DESC LIMIT 500`, ...(params as any[])).map(toRequest);
}

export async function createRequest(user: User, req: CreateMediaRequest): Promise<MediaRequest> {
  assertEnabled();
  if (req.mediaType !== 'movie' && req.mediaType !== 'show') throw badRequest('mediaType must be movie or show');
  if (!/^\d+$/.test(String(req.tmdbId))) throw badRequest('Invalid TMDB id');
  const available = findAvailable(req.tmdbId, req.mediaType);
  if (available) throw conflict('That title is already in the library');
  if (db.get("SELECT 1 FROM media_requests WHERE tmdb_id = ? AND media_type = ? AND status IN ('pending','approved','processing')", req.tmdbId, req.mediaType)) {
    throw conflict('Someone has already requested this');
  }
  const s = getSettings().requests;
  if (!user.isAdmin && s.weeklyLimit > 0) {
    const n = db.get<{ n: number }>('SELECT COUNT(*) n FROM media_requests WHERE requested_by = ? AND requested_at > ?', user.id, new Date(Date.now() - 7 * 86400000).toISOString())!.n;
    if (n >= s.weeklyLimit) throw new HttpError(429, `You've reached your limit of ${s.weeklyLimit} requests this week`, 'request_limit');
  }
  const meta = req.mediaType === 'movie' ? await tmdb.movieDetails(req.tmdbId) : await tmdb.tvDetails(req.tmdbId);
  if (!meta) throw notFound('Title not found on TMDB');
  const id = newId();
  db.insert('media_requests', {
    id, tmdb_id: String(req.tmdbId), media_type: req.mediaType, title: meta.title, year: meta.year ?? null, poster: registerImage(meta.poster),
    seasons: JSON.stringify((req.seasons ?? []).filter((n) => Number.isInteger(n) && n >= 0).slice(0, 100)), status: 'pending',
    requested_by: user.id, requested_at: nowIso(), note: req.note ? String(req.note).slice(0, 500) : null,
  });
  logActivity('request.create', `${user.displayName} requested ${meta.title}${meta.year ? ` (${meta.year})` : ''}`, { userId: user.id, userName: user.displayName });
  bus.emit('request.created', toRequest(db.get('SELECT * FROM media_requests WHERE id = ?', id)!));
  if (user.isAdmin || s.autoApproveUserIds.includes(user.id)) return approveRequest(user, id);
  return toRequest(db.get('SELECT * FROM media_requests WHERE id = ?', id)!);
}

export async function approveRequest(admin: User, id: string): Promise<MediaRequest> {
  const r = db.get('SELECT * FROM media_requests WHERE id = ?', id);
  if (!r) throw notFound('Request not found');
  if (!['pending', 'failed', 'declined'].includes(r.status)) throw badRequest(`Request is already ${r.status}`);
  db.run("UPDATE media_requests SET status = 'approved', decided_by = ?, decided_at = ?, error = NULL WHERE id = ?", admin.id, nowIso(), id);
  const s = getSettings().requests;
  const svc = r.media_type === 'movie' ? s.radarr : s.sonarr;
  if (svc?.url && svc.apiKey) {
    try {
      if (r.media_type === 'movie') await addToRadarr(svc, r.tmdb_id);
      else await addToSonarr(svc, r.tmdb_id, parseJson<number[]>(r.seasons, []));
      db.run("UPDATE media_requests SET status = 'processing' WHERE id = ?", id);
    } catch (e) {
      db.run("UPDATE media_requests SET status = 'failed', error = ? WHERE id = ?", (e as Error).message, id);
      log.warn(`Sending "${r.title}" to ${r.media_type === 'movie' ? 'Radarr' : 'Sonarr'} failed: ${(e as Error).message}`);
    }
  }
  const out = toRequest(db.get('SELECT * FROM media_requests WHERE id = ?', id)!);
  events.toUser(r.requested_by, { type: 'library.updated', libraryId: '' });
  bus.emit('request.updated', out);
  return out;
}

export function declineRequest(admin: User, id: string, note?: string): MediaRequest {
  const r = db.get('SELECT * FROM media_requests WHERE id = ?', id);
  if (!r) throw notFound('Request not found');
  db.run("UPDATE media_requests SET status = 'declined', decided_by = ?, decided_at = ?, note = COALESCE(?, note) WHERE id = ?", admin.id, nowIso(), note ? String(note).slice(0, 500) : null, id);
  const out = toRequest(db.get('SELECT * FROM media_requests WHERE id = ?', id)!);
  bus.emit('request.updated', out);
  return out;
}

export function deleteRequest(user: User, id: string) {
  const r = db.get('SELECT * FROM media_requests WHERE id = ?', id);
  if (!r) throw notFound('Request not found');
  if (!user.isAdmin && (r.requested_by !== user.id || r.status !== 'pending')) throw forbidden('You can only withdraw your own pending requests');
  db.run('DELETE FROM media_requests WHERE id = ?', id);
}

/** Mark approved/processing requests as available once the title shows up in a library. */
export function checkAvailability(): number {
  let n = 0;
  for (const r of db.all("SELECT * FROM media_requests WHERE status IN ('approved','processing','failed','pending')")) {
    const item = findAvailable(r.tmdb_id, r.media_type);
    if (!item) continue;
    db.run("UPDATE media_requests SET status = 'available', item_id = ?, error = NULL WHERE id = ?", item, r.id);
    const out = toRequest(db.get('SELECT * FROM media_requests WHERE id = ?', r.id)!);
    bus.emit('request.available', out);
    events.toUser(r.requested_by, { type: 'library.updated', libraryId: '' });
    n++;
  }
  return n;
}

bus.on('library.new', () => setTimeout(() => checkAvailability(), 2000));

/* ---------------------------- Radarr/Sonarr ------------------------- */

async function arr(svc: Pick<ArrService, 'url' | 'apiKey'>, path: string, init: RequestInit = {}): Promise<any> {
  const base = svc.url.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw badRequest('Service URL must start with http:// or https://');
  const res = await fetch(`${base}/api/v3${path}`, { ...init, headers: { 'X-Api-Key': svc.apiKey, 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = Array.isArray(body) ? body.map((e: any) => e.errorMessage ?? e.message).filter(Boolean).join('; ') : body?.message ?? `HTTP ${res.status}`;
    throw new HttpError(502, msg || `HTTP ${res.status}`, 'arr_error');
  }
  return body;
}

async function addToRadarr(svc: ArrService, tmdbId: string) {
  const movie = await arr(svc, `/movie/lookup/tmdb?tmdbId=${encodeURIComponent(tmdbId)}`);
  if (!movie) throw new Error('Radarr could not find this movie');
  if (movie.id) return; // already managed by Radarr
  const profiles = svc.qualityProfileId ?? (await arr(svc, '/qualityprofile'))[0]?.id;
  const root = svc.rootFolder ?? (await arr(svc, '/rootfolder'))[0]?.path;
  if (!profiles || !root) throw new Error('Configure a quality profile and root folder for Radarr');
  try {
    await arr(svc, '/movie', { method: 'POST', body: JSON.stringify({ ...movie, qualityProfileId: profiles, rootFolderPath: root, monitored: true, minimumAvailability: 'released', addOptions: { searchForMovie: svc.searchOnAdd } }) });
  } catch (e) {
    if (!/already been added|already exists/i.test((e as Error).message)) throw e;
  }
}

async function addToSonarr(svc: ArrService, tmdbId: string, seasons: number[]) {
  const ext = await tmdb.tvExternalIds(tmdbId);
  if (!ext.tvdb) throw new Error('This show has no TVDB id, which Sonarr needs');
  const found = await arr(svc, `/series/lookup?term=${encodeURIComponent('tvdb:' + ext.tvdb)}`);
  const series = Array.isArray(found) ? found[0] : null;
  if (!series) throw new Error('Sonarr could not find this show');
  if (series.id) return;
  const profiles = svc.qualityProfileId ?? (await arr(svc, '/qualityprofile'))[0]?.id;
  const root = svc.rootFolder ?? (await arr(svc, '/rootfolder'))[0]?.path;
  if (!profiles || !root) throw new Error('Configure a quality profile and root folder for Sonarr');
  const want = new Set(seasons);
  const seasonList = (series.seasons ?? []).map((s: any) => ({ ...s, monitored: seasons.length ? want.has(s.seasonNumber) : s.seasonNumber > 0 }));
  try {
    await arr(svc, '/series', { method: 'POST', body: JSON.stringify({ ...series, seasons: seasonList, qualityProfileId: profiles, rootFolderPath: root, monitored: true, seasonFolder: true, addOptions: { searchForMissingEpisodes: svc.searchOnAdd, monitor: seasons.length ? 'none' : 'all' } }) });
  } catch (e) {
    if (!/already been added|already exists/i.test((e as Error).message)) throw e;
  }
}

/** Test a Radarr/Sonarr connection and list its quality profiles + root folders. */
export async function arrOptions(svc: Pick<ArrService, 'url' | 'apiKey'>): Promise<ArrOptions> {
  try {
    const [profiles, roots] = await Promise.all([arr(svc, '/qualityprofile'), arr(svc, '/rootfolder')]);
    return {
      ok: true, message: 'Connected',
      qualityProfiles: (profiles ?? []).map((p: any) => ({ id: p.id, name: p.name })),
      rootFolders: (roots ?? []).map((r: any) => ({ path: r.path, freeSpace: r.freeSpace ?? null })),
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message, qualityProfiles: [], rootFolders: [] };
  }
}
