import { db, type Row } from '../../db.js';
import { nowIso, parseJson, sortTitle } from '../../util/misc.js';
import { stableId } from '../../util/ids.js';
import { registerImage } from '../images.js';
import { logger } from '../../util/log.js';
import * as tmdb from './tmdb.js';

const log = logger('metadata');

function applyMeta(item: Row, meta: tmdb.RemoteMeta) {
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
  if (!item.poster && meta.poster && !locked.has('poster')) patch.poster = registerImage(meta.poster);
  if (!item.backdrop && meta.backdrop && !locked.has('backdrop')) patch.backdrop = registerImage(meta.backdrop);
  if (!item.logo && meta.logo && !locked.has('logo')) patch.logo = registerImage(meta.logo);
  db.update('items', item.id, patch);
}

async function enrichMovie(item: Row) {
  const ids = parseJson<Record<string, string>>(item.external_ids, {});
  let id: string | null = ids.tmdb ?? null;
  if (!id && ids.imdb) id = (await tmdb.findByImdb(ids.imdb)).movie ?? null;
  if (!id) id = await tmdb.searchMovie(item.title, item.year);
  if (!id) {
    db.run('UPDATE items SET metadata_fetched_at = ? WHERE id = ?', nowIso(), item.id);
    return;
  }
  const meta = await tmdb.movieDetails(id);
  if (!meta) return;
  applyMeta(item, meta);
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
}

async function enrichShow(item: Row) {
  const ids = parseJson<Record<string, string>>(item.external_ids, {});
  let id: string | null = ids.tmdb ?? null;
  if (!id && ids.imdb) id = (await tmdb.findByImdb(ids.imdb)).tv ?? null;
  if (!id) id = await tmdb.searchTv(item.title, item.year);
  if (!id) {
    db.run('UPDATE items SET metadata_fetched_at = ? WHERE id = ?', nowIso(), item.id);
    return;
  }
  const meta = await tmdb.tvDetails(id);
  if (!meta) return;
  applyMeta(item, meta);
  if (meta.contentRating) {
    db.run('UPDATE items SET content_rating = ? WHERE (parent_id = ? OR grandparent_id = ?) AND content_rating IS NULL', meta.contentRating, item.id, item.id);
  }
  const seasons = db.all('SELECT * FROM items WHERE parent_id = ? AND type = ?', item.id, 'season');
  for (const season of seasons) {
    const sd = await tmdb.seasonDetails(id, season.idx ?? 1);
    if (!sd) continue;
    const sp: Row = { metadata_fetched_at: nowIso() };
    if (!season.poster && sd.poster) sp.poster = registerImage(sd.poster);
    if (sd.overview) sp.overview = sd.overview;
    if (sd.name && !/^season \d+$/i.test(sd.name) && season.idx !== 0) sp.title = sd.name;
    db.update('items', season.id, sp);
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
}

export async function refreshItem(itemId: string) {
  const item = db.get('SELECT * FROM items WHERE id = ?', itemId);
  if (!item) return;
  if (!tmdb.tmdbEnabled()) return;
  try {
    if (item.type === 'movie') await enrichMovie(item);
    else if (item.type === 'show') await enrichShow(item);
    else if (item.type === 'season' || item.type === 'episode') {
      const showId = item.type === 'season' ? item.parent_id : item.grandparent_id;
      const show = showId && db.get('SELECT * FROM items WHERE id = ?', showId);
      if (show) await enrichShow(show);
    }
  } catch (e) {
    log.warn(`Metadata refresh failed for ${item.title}`, (e as Error).message);
  }
}

export async function enrichLibrary(libId: string, opts: { refresh?: boolean; onProgress?: (done: number, total: number) => void } = {}) {
  if (!tmdb.tmdbEnabled()) return;
  const lib = db.get('SELECT type FROM libraries WHERE id = ?', libId);
  if (!lib || (lib.type !== 'movies' && lib.type !== 'shows')) return;
  const type = lib.type === 'movies' ? 'movie' : 'show';
  // Shows are re-checked when they have episodes without metadata (new episodes).
  const rows = opts.refresh
    ? db.all('SELECT * FROM items WHERE library_id = ? AND type = ?', libId, type)
    : type === 'show'
      ? db.all(`SELECT * FROM items s WHERE library_id = ? AND type = 'show' AND (metadata_fetched_at IS NULL OR EXISTS (SELECT 1 FROM items e WHERE e.grandparent_id = s.id AND e.metadata_fetched_at IS NULL))`, libId)
      : db.all('SELECT * FROM items WHERE library_id = ? AND type = ? AND metadata_fetched_at IS NULL', libId, type);
  let done = 0;
  for (const r of rows) {
    try {
      if (type === 'movie') await enrichMovie(r);
      else await enrichShow(r);
    } catch (e) {
      log.warn(`Enrich failed for ${r.title}`, (e as Error).message);
    }
    opts.onProgress?.(++done, rows.length);
  }
}
