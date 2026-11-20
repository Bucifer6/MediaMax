import type {
  ArrCalendarEntry, ArrHealthResponse, ArrHealthSection, ArrInstance, ArrItemInfo, ArrItemMatch, ArrKind, ArrListResponse, ArrQueueItem,
  ArrSearchRequest, ArrSection, ArrWantedEntry,
} from '@mediamax/shared';
import { db } from '../../db.js';
import { badRequest, notFound } from '../../util/errors.js';
import { parseJson } from '../../util/misc.js';
import { logger } from '../../util/log.js';
import { ARR_LABEL, arrFetch, cached, enabledInstances, getInstance, instanceRef, invalidate } from './client.js';

const log = logger('arr');

/** The *arr kinds that download things (Bazarr only fetches subtitles). */
export const DOWNLOADERS: ArrKind[] = ['radarr', 'sonarr', 'lidarr', 'readarr'];

const ckey = (what: string, i: ArrInstance) => `${what}:${i.id}:${i.url}`;

/** Run `fn` for each instance; one failing instance never breaks the others. */
async function perInstance<T>(what: string, kinds: ArrKind[], ttlMs: number, fn: (i: ArrInstance) => Promise<T[]>): Promise<ArrListResponse<T>> {
  const sections = await Promise.all(enabledInstances(kinds).map(async (i): Promise<ArrSection<T>> => {
    try {
      return { instance: instanceRef(i), ok: true, error: null, items: await cached(ckey(what, i), ttlMs, () => fn(i)) };
    } catch (e) {
      return { instance: instanceRef(i), ok: false, error: (e as Error).message, items: [] };
    }
  }));
  return { sections, fetchedAt: new Date().toISOString() };
}

const str = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
const pad = (n: number) => String(n).padStart(2, '0');
const epCode = (e: any) => (e?.seasonNumber != null && e?.episodeNumber != null ? `S${pad(e.seasonNumber)}E${pad(e.episodeNumber)}` : null);
const records = (body: any): any[] => (Array.isArray(body) ? body : Array.isArray(body?.records) ? body.records : []);

/* ------------------------------- queue ------------------------------ */

export function mapQueueRecord(kind: ArrKind, r: any): ArrQueueItem {
  const size = Number(r.size) || 0;
  const left = Number(r.sizeleft ?? r.sizeLeft) || 0;
  const warnings: string[] = [];
  for (const m of r.statusMessages ?? []) for (const msg of m.messages ?? []) warnings.push(m.title && m.title !== msg ? `${m.title}: ${msg}` : msg);
  if (r.errorMessage) warnings.push(String(r.errorMessage));
  let title = r.title ?? 'Unknown';
  let subtitle: string | null = null;
  const ids: ArrQueueItem['ids'] = {};
  if (kind === 'radarr') {
    if (r.movie?.title) title = `${r.movie.title}${r.movie.year ? ` (${r.movie.year})` : ''}`;
    ids.tmdbId = str(r.movie?.tmdbId);
  } else if (kind === 'sonarr') {
    if (r.series?.title) title = r.series.title;
    subtitle = [epCode(r.episode), r.episode?.title].filter(Boolean).join(' · ') || null;
    ids.tvdbId = str(r.series?.tvdbId);
  } else if (kind === 'lidarr') {
    if (r.artist?.artistName) title = r.artist.artistName;
    subtitle = r.album?.title ?? null;
    ids.foreignArtistId = str(r.artist?.foreignArtistId);
    ids.foreignAlbumId = str(r.album?.foreignAlbumId);
  } else if (kind === 'readarr') {
    if (r.book?.title) title = r.book.title;
    subtitle = r.author?.authorName ?? null;
    ids.foreignBookId = str(r.book?.foreignBookId);
  }
  return {
    id: Number(r.id), title, subtitle, quality: r.quality?.quality?.name ?? null,
    progress: size > 0 ? Math.max(0, Math.min(100, Math.round(((size - left) / size) * 1000) / 10)) : 0,
    size, sizeLeft: left, timeLeft: r.timeleft ?? r.timeLeft ?? null, estimatedCompletion: r.estimatedCompletionTime ?? null,
    status: String(r.status ?? 'unknown'), trackedState: r.trackedDownloadState ?? r.trackedDownloadStatus ?? null, warnings,
    protocol: r.protocol ?? null, downloadClient: r.downloadClient ?? null, ids,
  };
}

const QUEUE_PATH: Record<string, string> = {
  radarr: '/queue?pageSize=200&includeMovie=true&includeUnknownMovieItems=true',
  sonarr: '/queue?pageSize=200&includeSeries=true&includeEpisode=true&includeUnknownSeriesItems=true',
  lidarr: '/queue?pageSize=200&includeArtist=true&includeAlbum=true&includeUnknownArtistItems=true',
  readarr: '/queue?pageSize=200&includeAuthor=true&includeBook=true&includeUnknownAuthorItems=true',
};

export function getQueue(opts: { timeoutMs?: number } = {}): Promise<ArrListResponse<ArrQueueItem>> {
  return perInstance('queue', DOWNLOADERS, 10000, async (i) =>
    records(await arrFetch(i, QUEUE_PATH[i.kind], { timeoutMs: opts.timeoutMs })).map((r) => mapQueueRecord(i.kind, r)));
}

/* ------------------------------ calendar ---------------------------- */

const day = (d: Date) => d.toISOString().slice(0, 10);

export function mapCalendar(kind: ArrKind, list: any[], from: Date, to: Date): ArrCalendarEntry[] {
  const inRange = (d: string | null | undefined) => !!d && new Date(d) >= new Date(day(from)) && new Date(d) <= to;
  const out: ArrCalendarEntry[] = [];
  for (const x of list ?? []) {
    if (kind === 'radarr') {
      const candidates: [string, string | undefined][] = [['Digital release', x.digitalRelease], ['Physical release', x.physicalRelease], ['In cinemas', x.inCinemas]];
      const hit = candidates.filter(([, d]) => inRange(d)).sort((a, b) => String(a[1]).localeCompare(String(b[1])))[0];
      if (!hit) continue;
      out.push({ id: x.id, title: `${x.title}${x.year ? ` (${x.year})` : ''}`, subtitle: null, date: hit[1]!, releaseType: hit[0], hasFile: !!x.hasFile, monitored: x.monitored !== false });
    } else if (kind === 'sonarr') {
      const d = x.airDateUtc ?? x.airDate;
      if (!d) continue;
      out.push({ id: x.id, title: x.series?.title ?? 'Unknown show', subtitle: [epCode(x), x.title].filter(Boolean).join(' · ') || null, date: d, releaseType: 'Airs', hasFile: !!x.hasFile, monitored: x.monitored !== false });
    } else if (kind === 'lidarr') {
      if (!x.releaseDate) continue;
      out.push({ id: x.id, title: x.title, subtitle: x.artist?.artistName ?? null, date: x.releaseDate, releaseType: 'Album release', hasFile: (x.statistics?.trackFileCount ?? 0) > 0, monitored: x.monitored !== false });
    } else if (kind === 'readarr') {
      if (!x.releaseDate) continue;
      out.push({ id: x.id, title: x.title, subtitle: x.author?.authorName ?? x.authorTitle ?? null, date: x.releaseDate, releaseType: 'Book release', hasFile: (x.statistics?.bookFileCount ?? 0) > 0, monitored: x.monitored !== false });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export function getCalendar(days = 14): Promise<ArrListResponse<ArrCalendarEntry>> {
  const from = new Date();
  const to = new Date(Date.now() + days * 86400000);
  const q = `start=${day(from)}&end=${day(to)}`;
  const extra: Record<string, string> = { radarr: '', sonarr: '&includeSeries=true', lidarr: '&includeArtist=true', readarr: '&includeAuthor=true' };
  return perInstance(`calendar${days}`, DOWNLOADERS, 30000, async (i) => mapCalendar(i.kind, records(await arrFetch(i, `/calendar?${q}${extra[i.kind]}`)), from, to));
}

/* ------------------------------- wanted ----------------------------- */

export function mapWanted(kind: ArrKind, list: any[]): ArrWantedEntry[] {
  return (list ?? []).slice(0, 50).map((x): ArrWantedEntry => {
    if (kind === 'radarr') return { id: x.id, title: `${x.title}${x.year ? ` (${x.year})` : ''}`, subtitle: x.studio ?? null, date: x.digitalRelease ?? x.physicalRelease ?? x.inCinemas ?? null };
    if (kind === 'sonarr') return { id: x.id, title: x.series?.title ?? 'Unknown show', subtitle: [epCode(x), x.title].filter(Boolean).join(' · ') || null, date: x.airDateUtc ?? x.airDate ?? null };
    if (kind === 'lidarr') return { id: x.id, title: x.title, subtitle: x.artist?.artistName ?? null, date: x.releaseDate ?? null };
    return { id: x.id, title: x.title, subtitle: x.author?.authorName ?? x.authorTitle ?? null, date: x.releaseDate ?? null };
  });
}

const WANTED_PATH: Record<string, string> = {
  radarr: '/wanted/missing?page=1&pageSize=50&sortKey=movieMetadata.digitalRelease&sortDirection=descending&monitored=true',
  sonarr: '/wanted/missing?page=1&pageSize=50&sortKey=episodes.airDateUtc&sortDirection=descending&includeSeries=true&monitored=true',
  lidarr: '/wanted/missing?page=1&pageSize=50&sortKey=releaseDate&sortDirection=descending&includeArtist=true&monitored=true',
  readarr: '/wanted/missing?page=1&pageSize=50&sortKey=releaseDate&sortDirection=descending&includeAuthor=true&monitored=true',
};

export function getWanted(): Promise<ArrListResponse<ArrWantedEntry>> {
  return perInstance('wanted', DOWNLOADERS, 30000, async (i) => {
    try {
      return mapWanted(i.kind, records(await arrFetch(i, WANTED_PATH[i.kind])));
    } catch (e) {
      // Radarr before v5 has no /wanted/missing: derive it from the movie list.
      if (i.kind !== 'radarr' || (e as { code?: string }).code !== 'arr_not_found') throw e;
      const movies = await arrFetch<any[]>(i, '/movie');
      return mapWanted('radarr', (movies ?? []).filter((m) => m.monitored && !m.hasFile && m.isAvailable !== false));
    }
  });
}

/* ------------------------------- health ----------------------------- */

const LEVELS = new Set(['ok', 'notice', 'warning', 'error']);

export async function getHealth(): Promise<ArrHealthResponse> {
  const sections = await Promise.all(enabledInstances().map(async (i): Promise<ArrHealthSection> => {
    const base: ArrHealthSection = { instance: instanceRef(i), ok: false, error: null, version: null, checks: [], disks: [] };
    try {
      return await cached(ckey('health', i), 30000, async () => {
        if (i.kind === 'bazarr') {
          const [status, health] = await Promise.all([arrFetch(i, '/system/status'), arrFetch(i, '/system/health').catch(() => ({ data: [] }))]);
          return {
            ...base, ok: true, version: status?.data?.bazarr_version ?? null,
            checks: (health?.data ?? []).map((h: any) => ({ source: String(h.object ?? 'Bazarr'), type: 'warning' as const, message: String(h.issue ?? ''), wikiUrl: null })),
          };
        }
        const [status, health, disks] = await Promise.all([
          arrFetch(i, '/system/status'), arrFetch<any[]>(i, '/health'), arrFetch<any[]>(i, '/diskspace').catch(() => []),
        ]);
        return {
          ...base, ok: true, version: status?.version ?? null,
          checks: (health ?? []).map((h) => ({ source: String(h.source ?? ''), type: LEVELS.has(h.type) ? h.type : 'warning', message: String(h.message ?? ''), wikiUrl: h.wikiUrl ?? null })),
          disks: (disks ?? []).map((d) => ({ path: d.path, label: d.label || null, freeSpace: Number(d.freeSpace) || 0, totalSpace: Number(d.totalSpace) || 0 })),
        };
      });
    } catch (e) {
      return { ...base, error: (e as Error).message };
    }
  }));
  return { sections, fetchedAt: new Date().toISOString() };
}

/* ------------------------------- search ----------------------------- */

const DEFAULT_COMMAND: Record<string, NonNullable<ArrSearchRequest['command']>> = { radarr: 'MoviesSearch', sonarr: 'EpisodeSearch', lidarr: 'AlbumSearch', readarr: 'BookSearch' };
const COMMANDS: Record<string, NonNullable<ArrSearchRequest['command']>[]> = {
  radarr: ['MoviesSearch'], sonarr: ['EpisodeSearch', 'SeriesSearch', 'SeasonSearch'], lidarr: ['AlbumSearch', 'ArtistSearch'], readarr: ['BookSearch', 'AuthorSearch'],
};

/** The JSON body of an *arr command. */
export function commandBody(command: NonNullable<ArrSearchRequest['command']>, ids: number[], seasonNumber?: number): Record<string, unknown> {
  switch (command) {
    case 'MoviesSearch': return { name: command, movieIds: ids };
    case 'EpisodeSearch': return { name: command, episodeIds: ids };
    case 'SeriesSearch': return { name: command, seriesId: ids[0] };
    case 'SeasonSearch': return { name: command, seriesId: ids[0], seasonNumber };
    case 'AlbumSearch': return { name: command, albumIds: ids };
    case 'ArtistSearch': return { name: command, artistId: ids[0] };
    case 'BookSearch': return { name: command, bookIds: ids };
    case 'AuthorSearch': return { name: command, authorId: ids[0] };
  }
}

export async function search(instanceId: string, req: ArrSearchRequest): Promise<{ ok: true; command: string; commandId: number | null }> {
  const inst = getInstance(instanceId);
  if (!inst.enabled) throw badRequest('That instance is turned off');
  if (inst.kind === 'bazarr') throw badRequest('Use the Bazarr subtitle search for Bazarr');
  const ids = (Array.isArray(req?.ids) ? req.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500);
  if (!ids.length) throw badRequest('ids required');
  const command = req.command ?? DEFAULT_COMMAND[inst.kind];
  if (!COMMANDS[inst.kind].includes(command)) throw badRequest(`${ARR_LABEL[inst.kind]} doesn't support ${command}`);
  const out = await arrFetch(inst, '/command', { method: 'POST', body: JSON.stringify(commandBody(command, ids, req.seasonNumber)) });
  invalidate(`queue:${inst.id}`);
  invalidate(`wanted:${inst.id}`);
  return { ok: true, command, commandId: out?.id ?? null };
}

/* ---------------------- library item ↔ *arr match ------------------- */

function itemRow(itemId: string) {
  const it = db.get('SELECT id, type, title, parent_id, grandparent_id, external_ids FROM items WHERE id = ?', itemId);
  if (!it) throw notFound('Item not found');
  return it;
}

/** Find a movie/show/artist in the configured *arr instances (admin item page). */
export async function itemInfo(itemId: string): Promise<ArrItemInfo> {
  let it = itemRow(itemId);
  const episode = it.type === 'episode' || it.type === 'season';
  if (it.type === 'episode') it = itemRow(it.grandparent_id ?? it.parent_id);
  else if (it.type === 'season') it = itemRow(it.parent_id);
  if (it.type === 'album' || it.type === 'track') {
    let a = it;
    while (a && a.type !== 'artist' && a.parent_id) a = itemRow(a.parent_id);
    it = a;
  }
  const ids = parseJson<Record<string, string>>(it.external_ids, {});
  const kind: ArrKind | null = it.type === 'movie' ? 'radarr' : it.type === 'show' ? 'sonarr' : it.type === 'artist' ? 'lidarr' : null;
  const bazarr = (it.type === 'movie' || it.type === 'show' || episode) && enabledInstances(['bazarr']).length > 0;
  if (!kind) return { matches: [], bazarr: false };
  const matches: ArrItemMatch[] = [];
  await Promise.all(enabledInstances([kind]).map(async (i) => {
    try {
      const m = await findInArr(i, it.title, ids);
      if (m) matches.push(m);
    } catch (e) {
      log.debug(`Lookup in ${i.name} failed: ${(e as Error).message}`);
    }
  }));
  return { matches: matches.sort((a, b) => Number(a.instance.is4k) - Number(b.instance.is4k)), bazarr };
}

export async function findInArr(i: ArrInstance, title: string, ids: Record<string, string>): Promise<ArrItemMatch | null> {
  const web = i.url.replace(/\/+$/, '');
  if (i.kind === 'radarr') {
    if (!ids.tmdb) return null;
    const list = await arrFetch<any[]>(i, `/movie?tmdbId=${encodeURIComponent(ids.tmdb)}`, { timeoutMs: 8000 });
    const m = (list ?? []).find((x) => String(x.tmdbId) === String(ids.tmdb));
    if (!m) return null;
    return { instance: instanceRef(i), arrId: m.id, title: m.title, webUrl: `${web}/movie/${encodeURIComponent(m.titleSlug ?? m.tmdbId)}`, searchCommand: 'MoviesSearch', hasFile: !!m.hasFile };
  }
  if (i.kind === 'sonarr') {
    const list = ids.tvdb
      ? await arrFetch<any[]>(i, `/series?tvdbId=${encodeURIComponent(ids.tvdb)}`, { timeoutMs: 8000 })
      : await arrFetch<any[]>(i, '/series', { timeoutMs: 8000 });
    const m = (list ?? []).find((x) => (ids.tvdb ? String(x.tvdbId) === String(ids.tvdb) : ids.tmdb && String(x.tmdbId) === String(ids.tmdb)));
    if (!m) return null;
    return { instance: instanceRef(i), arrId: m.id, title: m.title, webUrl: `${web}/series/${encodeURIComponent(m.titleSlug ?? m.id)}`, searchCommand: 'SeriesSearch', hasFile: (m.statistics?.episodeFileCount ?? 0) > 0 };
  }
  if (i.kind === 'lidarr') {
    const list = await arrFetch<any[]>(i, '/artist', { timeoutMs: 8000 });
    const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const m = (list ?? []).find((x) => (ids.musicbrainz && x.foreignArtistId === ids.musicbrainz) || norm(String(x.artistName ?? '')) === norm(title));
    if (!m) return null;
    return { instance: instanceRef(i), arrId: m.id, title: m.artistName, webUrl: `${web}/artist/${encodeURIComponent(m.foreignArtistId ?? m.id)}`, searchCommand: 'ArtistSearch', hasFile: (m.statistics?.trackFileCount ?? 0) > 0 };
  }
  return null;
}

/* ------------------------------- Bazarr ----------------------------- */

/** Ask Bazarr to search missing subtitles for a movie, or for the show an episode/season belongs to. */
export async function bazarrSearch(itemId: string): Promise<{ ok: true; message: string }> {
  const bazarr = enabledInstances(['bazarr'])[0];
  if (!bazarr) throw badRequest('No Bazarr instance is configured');
  let it = itemRow(itemId);
  if (it.type === 'episode') it = itemRow(it.grandparent_id ?? it.parent_id);
  else if (it.type === 'season') it = itemRow(it.parent_id);
  const kind: ArrKind | null = it.type === 'movie' ? 'radarr' : it.type === 'show' ? 'sonarr' : null;
  if (!kind) throw badRequest('Bazarr handles movies and TV episodes only');
  const ids = parseJson<Record<string, string>>(it.external_ids, {});
  let match: ArrItemMatch | null = null;
  for (const i of enabledInstances([kind])) {
    match = await findInArr(i, it.title, ids).catch(() => null);
    if (match) break;
  }
  if (!match) throw notFound(`"${it.title}" isn't in ${ARR_LABEL[kind]}, so Bazarr doesn't know it`);
  const q = kind === 'radarr' ? `/movies?radarrid=${match.arrId}&action=search-missing` : `/series?seriesid=${match.arrId}&action=search-missing`;
  await arrFetch(bazarr, q, { method: 'PATCH' });
  return { ok: true, message: `Bazarr is searching subtitles for ${match.title}` };
}
