import { db, type Row } from '../../db.js';
import { nowIso, parseJson, sortTitle } from '../../util/misc.js';
import { stableId } from '../../util/ids.js';
import { registerImage } from '../images.js';
import { logger } from '../../util/log.js';
import * as tmdb from './tmdb.js';
import { applyPluginMetadata } from '../plugins.js';
import { saveSchedule } from '../schedule.js';
import { applyBuiltinProviders, episodeOrderOf, isLocalImage, prefersArtFrom, providerReady, providersFor } from './builtin.js';

const log = logger('metadata');

/** Fields TMDB sets (reported to the built-in providers so a Fix-match refresh doesn't overwrite them again). */
const TMDB_FIELDS = ['title', 'originalTitle', 'overview', 'tagline', 'year', 'releaseDate', 'communityRating', 'contentRating', 'genres', 'studios', 'people', 'trailerUrl'];

/** TMDB artwork replaces remote art only when TMDB is the admin's preferred source; local art always stays. */
const takeArt = (item: Row, kind: 'poster' | 'backdrop' | 'logo', locked: Set<string>, url: string | null | undefined) =>
  !!url && !locked.has(kind) && (!item[kind] || (prefersArtFrom(item.type, 'tmdb') && !isLocalImage(item[kind])));

function applyMeta(item: Row, meta: tmdb.RemoteMeta, touched?: Set<string>) {
  const locked = new Set(parseJson<string[]>(item.locked_fields, []));
  const ids = { ...parseJson<Record<string, string>>(item.external_ids, {}), tmdb: meta.tmdbId, ...(meta.imdbId ? { imdb: meta.imdbId } : {}), ...(meta.tvdbId ? { tvdb: meta.tvdbId } : {}) };
  const patch: Row = { external_ids: JSON.stringify(ids), metadata_fetched_at: nowIso(), updated_at: nowIso() };
  const set = (field: string, col: string, v: unknown) => {
    if (locked.has(field) || v === undefined || v === null || (Array.isArray(v) && !v.length)) return;
    patch[col] = Array.isArray(v) ? JSON.stringify(v) : v;
  };
  set('title', 'title', meta.title);
  if (patch.title && !locked.has('sortTitle')) patch.sort_title = sortTitle(meta.title);
  set('originalTitle', 'original_title', meta.originalTitle);
  set('overview', 'overview', meta.overview);
  set('tagline', 'tagline', meta.tagline);
  set('year', 'year', meta.year);
  set('releaseDate', 'release_date', meta.releaseDate);
  set('communityRating', 'community_rating', meta.rating);
  set('contentRating', 'content_rating', meta.contentRating);
  set('genres', 'genres', meta.genres);
  set('studios', 'studios', meta.studios);
  set('people', 'people', meta.people);
  set('trailerUrl', 'trailer_url', meta.trailerUrl);
  // Local artwork wins over remote unless missing.
  if (takeArt(item, 'poster', locked, meta.poster)) patch.poster = registerImage(meta.poster);
  if (takeArt(item, 'backdrop', locked, meta.backdrop)) patch.backdrop = registerImage(meta.backdrop);
  if (takeArt(item, 'logo', locked, meta.logo)) patch.logo = registerImage(meta.logo);
  // Kept in the extra JSON (no columns needed): the original language drives the "Original" audio preference; the
  // studios / networks with logos are shown on detail pages (logos registered as images, served by the proxy).
  const extra = parseJson<Record<string, unknown>>(item.extra, {});
  const nextExtra = { ...extra };
  if (meta.originalLanguage && /^[a-z]{2,3}$/i.test(meta.originalLanguage)) nextExtra.originalLanguage = meta.originalLanguage.toLowerCase();
  if (meta.companies?.length) nextExtra.companies = meta.companies.map((c) => ({ id: c.id, name: c.name, kind: c.kind, logo: registerImage(c.logo) }));
  if (JSON.stringify(nextExtra) !== JSON.stringify(extra)) patch.extra = JSON.stringify(nextExtra);
  if (meta.rating && !locked.has('ratings')) patch.ratings = JSON.stringify({ ...parseJson<Record<string, number>>(item.ratings, {}), tmdb: meta.rating });
  db.update('items', item.id, patch);
  Object.assign(item, patch);
  if (touched) {
    const vals: Record<string, unknown> = {
      title: meta.title, originalTitle: meta.originalTitle, overview: meta.overview, tagline: meta.tagline, year: meta.year, releaseDate: meta.releaseDate,
      communityRating: meta.rating, contentRating: meta.contentRating, genres: meta.genres, studios: meta.studios, people: meta.people, trailerUrl: meta.trailerUrl,
    };
    for (const f of TMDB_FIELDS) if (vals[f] != null && vals[f] !== '' && !(Array.isArray(vals[f]) && !(vals[f] as unknown[]).length)) touched.add(f);
    for (const k of ['poster', 'backdrop', 'logo']) if (patch[k]) touched.add(k);
  }
}

async function enrichMovie(item: Row, touched?: Set<string>): Promise<boolean> {
  const ids = parseJson<Record<string, string>>(item.external_ids, {});
  let id: string | null = ids.tmdb ?? null;
  if (!id && ids.imdb) id = (await tmdb.findByImdb(ids.imdb)).movie ?? null;
  if (!id) id = await tmdb.searchMovie(item.title, item.year);
  if (!id) {
    db.run('UPDATE items SET metadata_fetched_at = ? WHERE id = ?', nowIso(), item.id);
    return false;
  }
  const meta = await tmdb.movieDetails(id);
  if (!meta) return false;
  applyMeta(item, meta, touched);
  // Automatic box-set collections (Emby-style).
  if (meta.collection) {
    const cid = 'tc' + stableId('tmdb-collection', meta.collection.id);
    if (!db.get('SELECT 1 FROM items WHERE id = ?', cid)) {
      const now = nowIso();
      db.insert('items', {
        id: cid, library_id: null, type: 'collection', title: meta.collection.name, sort_title: sortTitle(meta.collection.name),
        poster: registerImage(meta.collection.poster), backdrop: registerImage(meta.collection.backdrop), added_at: now, updated_at: now,
        external_ids: JSON.stringify({ tmdb: meta.collection.id }), extra: JSON.stringify({ auto: true }),
      });
    }
    const n = db.get<{ n: number }>('SELECT COUNT(*) n FROM collection_items WHERE collection_id = ?', cid)!.n;
    db.run('INSERT OR IGNORE INTO collection_items (collection_id, item_id, sort) VALUES (?, ?, ?)', cid, item.id, item.year ?? n + 1);
  }
  return true;
}

async function enrichShow(item: Row, touched?: Set<string>): Promise<boolean> {
  const ids = parseJson<Record<string, string>>(item.external_ids, {});
  let id: string | null = ids.tmdb ?? null;
  if (!id && ids.imdb) id = (await tmdb.findByImdb(ids.imdb)).tv ?? null;
  if (!id) id = await tmdb.searchTv(item.title, item.year);
  if (!id) {
    db.run('UPDATE items SET metadata_fetched_at = ? WHERE id = ?', nowIso(), item.id);
    return false;
  }
  const meta = await tmdb.tvDetails(id);
  if (!meta) return false;
  applyMeta(item, meta, touched);
  // DVD / absolute ordering: episodes are matched by TheTVDB instead (TMDB only knows the aired order).
  const tvdbEpisodes = episodeOrderOf(item) !== 'aired' && providerReady('tvdb');
  if (meta.schedule) saveSchedule(item.id, meta.schedule);
  if (meta.contentRating) {
    db.run('UPDATE items SET content_rating = ? WHERE (parent_id = ? OR grandparent_id = ?) AND content_rating IS NULL', meta.contentRating, item.id, item.id);
  }
  const seasons = db.all('SELECT * FROM items WHERE parent_id = ? AND type = ?', item.id, 'season');
  for (const season of seasons) {
    const sd = await tmdb.seasonDetails(id, season.idx ?? 1);
    if (!sd) continue;
    const sp: Row = { metadata_fetched_at: nowIso() };
    const seasonLocked = parseJson<string[]>(season.locked_fields, []);
    if (sd.poster && !seasonLocked.includes('poster') && (!season.poster || (prefersArtFrom('show', 'tmdb') && !isLocalImage(season.poster)))) sp.poster = registerImage(sd.poster);
    if (sd.overview) sp.overview = sd.overview;
    if (sd.name && !/^season \d+$/i.test(sd.name) && season.idx !== 0) sp.title = sd.name;
    db.update('items', season.id, sp);
    if (tvdbEpisodes) continue;
    const eps = db.all('SELECT * FROM items WHERE parent_id = ? AND type = ?', season.id, 'episode');
    for (const ep of eps) {
      const re = sd.episodes.find((e) => e.episode === ep.idx);
      if (!re) continue;
      const locked = new Set(parseJson<string[]>(ep.locked_fields, []));
      const p: Row = { metadata_fetched_at: nowIso(), updated_at: nowIso() };
      if (!locked.has('title') && re.title) {
        p.title = re.title;
        p.sort_title = sortTitle(re.title);
      }
      if (!locked.has('overview') && re.overview) p.overview = re.overview;
      if (re.airDate) p.release_date = re.airDate;
      if (re.airDate) p.year = +re.airDate.slice(0, 4);
      if (re.rating) p.community_rating = Math.round(re.rating * 10) / 10;
      if (re.people.length) p.people = JSON.stringify(re.people);
      if (!ep.thumb && re.still) p.thumb = registerImage(re.still);
      db.update('items', ep.id, p);
    }
  }
  return true;
}

/**
 * Refresh one item: TMDB (movies/shows), then the enabled built-in providers in priority order, then plugin providers.
 * Seasons and episodes refresh their show. `replace` (after Fix match) lets providers overwrite unlocked fields.
 */
export async function refreshItem(itemId: string, opts: { replace?: boolean } = {}) {
  const item = db.get('SELECT * FROM items WHERE id = ?', itemId);
  if (!item) return;
  let target = item;
  if (item.type === 'season' || item.type === 'episode') {
    const showId = item.type === 'season' ? item.parent_id : item.grandparent_id;
    target = (showId && db.get('SELECT * FROM items WHERE id = ?', showId)) || item;
  }
  const touched = new Set<string>();
  if (tmdb.tmdbEnabled()) {
    try {
      if (target.type === 'movie') await enrichMovie(target, touched);
      else if (target.type === 'show') await enrichShow(target, touched);
    } catch (e) {
      log.warn(`Metadata refresh failed for ${item.title}`, (e as Error).message);
    }
  }
  try {
    await applyBuiltinProviders(target.id, { replace: opts.replace, touched });
  } catch (e) {
    log.warn(`Provider refresh failed for ${item.title}`, (e as Error).message);
  }
  await applyPluginMetadata(itemId);
}

const LIB_TYPES: Record<string, string[]> = { movies: ['movie'], shows: ['show'], music: ['artist', 'album'], audiobooks: ['audiobook'] };

/**
 * Fetch metadata for a library: TMDB for movies/shows plus the built-in providers for every supported type
 * (movies, shows, artists, albums, audiobooks). Without `refresh`, only items that were never fetched (or shows with new episodes).
 */
export async function enrichLibrary(libId: string, opts: { refresh?: boolean; onProgress?: (done: number, total: number) => void } = {}) {
  const lib = db.get('SELECT type FROM libraries WHERE id = ?', libId);
  const types = lib ? LIB_TYPES[lib.type] : undefined;
  if (!types) return;
  const useTmdb = tmdb.tmdbEnabled() && (lib!.type === 'movies' || lib!.type === 'shows');
  const builtinTypes = types.filter((t) => providersFor(t as any).length);
  if (!useTmdb && !builtinTypes.length) return;
  const typeList = types.map((t) => `'${t}'`).join(',');
  const newEpisodes = `(i.type = 'show' AND EXISTS (SELECT 1 FROM items e WHERE e.grandparent_id = i.id AND e.metadata_fetched_at IS NULL))`;
  const needTmdb = useTmdb ? (opts.refresh ? '1' : `(i.metadata_fetched_at IS NULL OR ${newEpisodes})`) : '0';
  const needBuiltin = builtinTypes.length
    ? opts.refresh ? `i.type IN (${builtinTypes.map((t) => `'${t}'`).join(',')})` : `(i.type IN (${builtinTypes.map((t) => `'${t}'`).join(',')}) AND (i.providers_fetched_at IS NULL OR ${newEpisodes}))`
    : '0';
  // Artists before albums, so album lookups can use the artist's MBID-backed name match.
  const rows = db.all(
    `SELECT i.*, ${needTmdb} need_tmdb, ${needBuiltin} need_builtin FROM items i
     WHERE i.library_id = ? AND i.type IN (${typeList}) AND (${needTmdb} OR ${needBuiltin})
     ORDER BY CASE i.type WHEN 'artist' THEN 0 ELSE 1 END, i.sort_title`, libId);
  let done = 0;
  for (const r of rows) {
    const touched = new Set<string>();
    try {
      if (r.need_tmdb) {
        if (r.type === 'movie') await enrichMovie(r, touched);
        else if (r.type === 'show') await enrichShow(r, touched);
      }
    } catch (e) {
      log.warn(`Enrich failed for ${r.title}`, (e as Error).message);
    }
    if (r.need_builtin || r.need_tmdb) {
      try {
        await applyBuiltinProviders(r.id);
      } catch (e) {
        log.warn(`Provider enrich failed for ${r.title}`, (e as Error).message);
      }
    }
    // The scanner runs plugin providers for new music/audiobooks itself.
    if (r.type === 'movie' || r.type === 'show' || opts.refresh) await applyPluginMetadata(r.id);
    opts.onProgress?.(++done, rows.length);
  }
}
