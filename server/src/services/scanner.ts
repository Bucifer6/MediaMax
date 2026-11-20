import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Library, LibraryType, SubtitleStream } from '@mediamax/shared';
import { db, type Row } from '../db.js';
import { config } from '../config.js';
import { stableId } from '../util/ids.js';
import { nowIso, parseJson, pool, sortTitle } from '../util/misc.js';
import { logger } from '../util/log.js';
import { probe, normLang, type ProbeResult } from './probe.js';
import { registerImage } from './images.js';
import { readNfo, type NfoData } from './metadata/nfo.js';
import {
  AUDIO_EXT, IMAGE_EXT, SUB_EXT, VIDEO_EXT, ext, isExtra, parseEpisodeName, parseMovieName, parseSeasonFolder, parseShowFolder,
  parseSubtitleName, stripExt,
} from './parser.js';
import { events, bus } from './events.js';
import { enrichLibrary } from './metadata/index.js';
import { logActivity } from './activity.js';
import { downloadedSubs } from './opensubtitles.js';
import { applyPluginMetadata } from './plugins.js';

const log = logger('scanner');

/* ------------------------------ helpers ---------------------------- */

interface FileEntry {
  path: string;
  rel: string;
  root: string;
  size: number;
  mtime: number;
}

function walk(root: string, accept: (e: string) => boolean): FileEntry[] {
  const out: FileEntry[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      log.warn(`Cannot read ${dir}: ${(e as Error).message}`);
      continue;
    }
    if (entries.some((e) => e.name === '.mediamaxignore' || e.name === '.plexignore' || e.name === '.ignore')) continue;
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === '@eaDir' || e.name === '#recycle' || e.name === '$RECYCLE.BIN') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory() || (e.isSymbolicLink() && safeIsDir(p))) stack.push(p);
      else if (accept(ext(e.name))) {
        try {
          const st = fs.statSync(p);
          out.push({ path: p, rel: path.relative(root, p), root, size: st.size, mtime: Math.floor(st.mtimeMs) });
        } catch {
          /* vanished */
        }
      }
    }
  }
  return out;
}

function safeIsDir(p: string) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function findFile(dir: string, names: string[]): string | null {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const lower = new Map(files.map((f) => [f.toLowerCase(), f]));
  for (const n of names) {
    const hit = lower.get(n.toLowerCase());
    if (hit) return path.join(dir, hit);
  }
  return null;
}

const imgNames = (bases: string[]) => bases.flatMap((b) => ['jpg', 'jpeg', 'png', 'webp', 'tbn'].map((e) => `${b}.${e}`));

/** Upsert a structural item. Metadata fields are only written on creation or when not yet enriched/locked. */
function ensureItem(fields: Row & { id: string; library_id: string; type: string; title: string }): Row {
  const existing = db.get('SELECT * FROM items WHERE id = ?', fields.id);
  const now = nowIso();
  if (!existing) {
    db.insert('items', { sort_title: sortTitle(fields.title), added_at: now, updated_at: now, ...fields });
    return db.get('SELECT * FROM items WHERE id = ?', fields.id)!;
  }
  const locked = new Set(parseJson<string[]>(existing.locked_fields, []));
  const patch: Row = {};
  const structural = ['parent_id', 'grandparent_id', 'path', 'library_id'];
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'id' || v === undefined) continue;
    if (structural.includes(k)) {
      if (existing[k] !== v) patch[k] = v;
      continue;
    }
    if (k === 'idx' || k === 'parent_idx') {
      if (existing[k] !== v && v !== null) patch[k] = v;
      continue;
    }
    // Don't clobber enriched metadata or user-locked fields.
    const camel = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (locked.has(camel) || locked.has(k)) continue;
    if (existing.metadata_fetched_at && ['title', 'overview', 'year', 'genres', 'people', 'studios', 'community_rating', 'content_rating', 'tagline', 'original_title', 'release_date'].includes(k)) continue;
    if (['poster', 'backdrop', 'logo', 'thumb'].includes(k) && existing[k] && !v) continue;
    if (existing[k] !== v && v !== null) patch[k] = v;
  }
  if (patch.title && !locked.has('sortTitle')) patch.sort_title = sortTitle(patch.title);
  if (Object.keys(patch).length) {
    patch.updated_at = now;
    db.update('items', fields.id, patch);
  }
  return { ...existing, ...patch };
}

function nfoFields(n: NfoData | null): Row {
  if (!n) return {};
  const f: Row = {};
  if (n.title) f.title = n.title;
  if (n.originalTitle) f.original_title = n.originalTitle;
  if (n.year) f.year = n.year;
  if (n.overview) f.overview = n.overview;
  if (n.tagline) f.tagline = n.tagline;
  if (n.rating) f.community_rating = n.rating;
  if (n.contentRating) f.content_rating = n.contentRating;
  if (n.genres?.length) f.genres = JSON.stringify(n.genres);
  if (n.studios?.length) f.studios = JSON.stringify(n.studios);
  if (n.people?.length) f.people = JSON.stringify(n.people);
  if (n.releaseDate) f.release_date = n.releaseDate;
  if (n.ids && Object.values(n.ids).some(Boolean)) f.external_ids = JSON.stringify(n.ids);
  if (n.trailer && /^https?:/.test(n.trailer)) f.trailer_url = n.trailer;
  return f;
}

function sidecarSubs(videoPath: string): SubtitleStream[] {
  const dir = path.dirname(videoPath);
  const base = stripExt(path.basename(videoPath));
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const subsDirs = ['subs', 'subtitles', 'Subs', 'Subtitles'].map((d) => path.join(dir, d)).filter(safeIsDir);
  const candidates = [...files.map((f) => path.join(dir, f)), ...subsDirs.flatMap((d) => fs.readdirSync(d).map((f) => path.join(d, f)))];
  const out: (SubtitleStream & { path: string })[] = [];
  let n = 0;
  for (const p of candidates) {
    const e = ext(p);
    if (!SUB_EXT.has(e)) continue;
    const fname = path.basename(p);
    const inSubDir = path.dirname(p) !== dir;
    const info = parseSubtitleName(fname, inSubDir ? stripExt(fname).split('.')[0] : base) ?? (inSubDir ? parseSubtitleName(fname, '') : null);
    if (!info) continue;
    out.push({ index: 1000 + n++, codec: e === 'srt' ? 'subrip' : e, language: normLang(info.language), title: info.title, default: info.default, forced: info.forced, external: true, path: p });
  }
  return out;
}

/** Upsert the media row for a file, probing when new or changed. Returns probe result (fresh or cached). */
async function upsertMedia(itemId: string, f: FileEntry, force = false, preProbed?: ProbeResult | null): Promise<{ mediaId: string; probe: ProbeResult | null; changed: boolean }> {
  const existing = db.get('SELECT * FROM media WHERE path = ?', f.path);
  const id = existing?.id ?? stableId('media', f.path);
  const subsSide = [...sidecarSubs(f.path), ...downloadedSubs(id, 2000)];
  if (existing && existing.mtime === f.mtime && existing.size === f.size && !force && existing.probed_at) {
    // Keep sidecar subtitles fresh even when the file itself is unchanged.
    const embedded = parseJson<SubtitleStream[]>(existing.subs, []).filter((s) => !s.external);
    db.run('UPDATE media SET item_id = ?, subs = ? WHERE id = ?', itemId, JSON.stringify([...embedded, ...subsSide]), id);
    return { mediaId: id, probe: null, changed: false };
  }
  let pr: ProbeResult | null = preProbed ?? null;
  if (!pr) try {
    pr = await probe(f.path, f.path);
  } catch (e) {
    log.warn(`Probe failed for ${f.path}: ${(e as Error).message}`);
  }
  const row: Row = {
    id, item_id: itemId, path: f.path, remote_url: null, container: pr?.container ?? ext(f.path), duration_ms: pr?.durationMs ?? null,
    size: f.size, bitrate: pr?.bitrate ?? null, width: pr?.width ?? null, height: pr?.height ?? null, video_codec: pr?.videoCodec ?? null,
    hdr: pr?.hdr ?? false, audio: JSON.stringify(pr?.audio ?? []), subs: JSON.stringify([...(pr?.subs ?? []), ...subsSide]),
    mtime: f.mtime, probed_at: pr ? nowIso() : null, chapters: JSON.stringify(pr?.chapters ?? []),
  };
  db.upsert('media', row);
  return { mediaId: id, probe: pr, changed: true };
}

function itemDuration(itemId: string) {
  const d = db.get<{ d: number | null }>('SELECT MAX(duration_ms) d FROM media WHERE item_id = ?', itemId)?.d;
  if (d) db.run('UPDATE items SET duration_ms = ? WHERE id = ? AND (duration_ms IS NULL OR duration_ms != ?)', d, itemId, d);
}

/* ------------------------------ scanners --------------------------- */

interface ScanCtx {
  lib: Row;
  seenMedia: Set<string>;
  seenItems: Set<string>;
  newItems: string[];
  force: boolean;
  progress: (done: number, total: number) => void;
}

async function scanMovies(ctx: ScanCtx, files: FileEntry[]) {
  let done = 0;
  await pool(files, 4, async (f) => {
    const dir = path.dirname(f.path);
    const inOwnFolder = dir !== f.root;
    const folderParse = inOwnFolder ? parseMovieName(path.basename(dir)) : null;
    const fileParse = parseMovieName(path.basename(f.path));
    // Prefer the folder name when it looks like "Title (Year)".
    const p = folderParse?.year ? folderParse : fileParse.year || !folderParse ? fileParse : folderParse;
    const key = inOwnFolder && folderParse?.title ? dir : `${p.title.toLowerCase()}|${p.year ?? ''}`;
    const id = stableId(ctx.lib.id, 'movie', key);
    const nfoPath = findFile(dir, [`${stripExt(path.basename(f.path))}.nfo`, ...(inOwnFolder ? ['movie.nfo'] : [])]);
    const nfo = nfoPath ? readNfo(nfoPath) : null;
    const base = stripExt(path.basename(f.path));
    const poster = findFile(dir, imgNames([`${base}-poster`, ...(inOwnFolder ? ['poster', 'folder', 'cover', 'movie'] : [])]));
    const backdrop = findFile(dir, imgNames([`${base}-fanart`, `${base}-backdrop`, ...(inOwnFolder ? ['fanart', 'backdrop', 'background', 'art'] : [])]));
    const logo = findFile(dir, imgNames([`${base}-logo`, `${base}-clearlogo`, ...(inOwnFolder ? ['logo', 'clearlogo'] : [])]));
    const ids = { ...(p.tmdbId ? { tmdb: p.tmdbId } : {}), ...(p.imdbId ? { imdb: p.imdbId } : {}) };
    const existed = !!db.get('SELECT 1 FROM items WHERE id = ?', id);
    ensureItem({
      id, library_id: ctx.lib.id, type: 'movie', title: p.title || base, year: p.year, path: key,
      ...(Object.keys(ids).length ? { external_ids: JSON.stringify(ids) } : {}),
      ...nfoFields(nfo),
      poster: registerImage(poster), backdrop: registerImage(backdrop), logo: registerImage(logo),
    });
    if (!existed) ctx.newItems.push(id);
    const m = await upsertMedia(id, f, ctx.force);
    ctx.seenMedia.add(m.mediaId);
    ctx.seenItems.add(id);
    itemDuration(id);
    ctx.progress(++done, files.length);
  });
}

async function scanShows(ctx: ScanCtx, files: FileEntry[]) {
  let done = 0;
  const showCache = new Map<string, string>();
  const seasonCache = new Map<string, string>();
  // Process sequentially per show folder to avoid races creating parents; probe in parallel.
  await pool(files, 4, async (f) => {
    const parts = f.rel.split(path.sep);
    const showFolder = parts.length > 1 ? parts[0] : null;
    const ep = parseEpisodeName(path.basename(f.path));
    const showName = showFolder ?? ep.show ?? 'Unknown Show';
    const showDir = showFolder ? path.join(f.root, showFolder) : f.root;
    const showKey = showFolder ? showDir : `${f.root}|${showName.toLowerCase()}`;
    const showId = stableId(ctx.lib.id, 'show', showKey);
    if (!showCache.has(showId)) {
      showCache.set(showId, showId);
      const sp = parseShowFolder(showName);
      const nfo = showFolder ? readNfo(path.join(showDir, 'tvshow.nfo')) : null;
      const ids = { ...(sp.tvdbId ? { tvdb: sp.tvdbId } : {}), ...(sp.tmdbId ? { tmdb: sp.tmdbId } : {}) };
      const existed = !!db.get('SELECT 1 FROM items WHERE id = ?', showId);
      ensureItem({
        id: showId, library_id: ctx.lib.id, type: 'show', title: sp.title || showName, year: sp.year, path: showKey,
        ...(Object.keys(ids).length ? { external_ids: JSON.stringify(ids) } : {}),
        ...nfoFields(nfo),
        poster: showFolder ? registerImage(findFile(showDir, imgNames(['poster', 'folder', 'cover', 'show']))) : null,
        backdrop: showFolder ? registerImage(findFile(showDir, imgNames(['fanart', 'backdrop', 'background', 'art']))) : null,
        logo: showFolder ? registerImage(findFile(showDir, imgNames(['logo', 'clearlogo']))) : null,
      });
      if (!existed) ctx.newItems.push(showId);
    }
    ctx.seenItems.add(showId);
    // Season: from folder ("Season 2") or episode tag.
    const seasonFolder = parts.length > 2 ? parts[parts.length - 2] : null;
    let seasonNum = seasonFolder ? parseSeasonFolder(seasonFolder) : null;
    if (seasonNum === null) seasonNum = ep.season ?? 1;
    const seasonId = stableId(showId, 'season', seasonNum);
    if (!seasonCache.has(seasonId)) {
      seasonCache.set(seasonId, seasonId);
      const pad = String(seasonNum).padStart(2, '0');
      const seasonDir = seasonFolder ? path.dirname(f.path) : null;
      const poster = (seasonDir && findFile(seasonDir, imgNames(['poster', 'folder', 'cover']))) || (showFolder ? findFile(showDir, imgNames([`season${pad}-poster`, `season${seasonNum}-poster`, seasonNum === 0 ? 'season-specials-poster' : '__none'])) : null);
      ensureItem({
        id: seasonId, library_id: ctx.lib.id, type: 'season', title: seasonNum === 0 ? 'Specials' : `Season ${seasonNum}`, idx: seasonNum,
        parent_id: showId, path: seasonDir ?? `${showKey}|s${seasonNum}`, poster: registerImage(poster),
      });
    }
    ctx.seenItems.add(seasonId);
    const epNum = ep.episode ?? null;
    const epKey = epNum !== null ? `e${epNum}` : `f:${stripExt(path.basename(f.path)).toLowerCase()}`;
    const epId = stableId(seasonId, 'episode', epKey);
    const base = stripExt(path.basename(f.path));
    const nfo = readNfo(path.join(path.dirname(f.path), `${base}.nfo`));
    const thumb = findFile(path.dirname(f.path), imgNames([`${base}-thumb`, base]));
    const existed = !!db.get('SELECT 1 FROM items WHERE id = ?', epId);
    ensureItem({
      id: epId, library_id: ctx.lib.id, type: 'episode', title: ep.title || (epNum !== null ? `Episode ${epNum}` : base),
      idx: epNum, parent_idx: seasonNum, parent_id: seasonId, grandparent_id: showId, path: f.path,
      release_date: ep.airDate, thumb: registerImage(thumb), ...nfoFields(nfo),
      ...(ep.episodeEnd ? { extra: JSON.stringify({ episodeEnd: ep.episodeEnd }) } : {}),
    });
    if (!existed) ctx.newItems.push(epId);
    const m = await upsertMedia(epId, f, ctx.force);
    ctx.seenMedia.add(m.mediaId);
    ctx.seenItems.add(epId);
    itemDuration(epId);
    ctx.progress(++done, files.length);
  });
}

function extractCover(file: string, dest: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(config.ffmpeg, ['-v', 'error', '-y', '-i', file, '-an', '-map', '0:v:0', '-frames:v', '1', dest]);
    p.on('error', () => resolve(false));
    p.on('exit', (c) => resolve(c === 0 && fs.existsSync(dest)));
  });
}

async function scanMusic(ctx: ScanCtx, files: FileEntry[]) {
  let done = 0;
  const coverDir = path.join(config.cacheDir, 'covers');
  fs.mkdirSync(coverDir, { recursive: true });
  const albumArtDone = new Set<string>();
  await pool(files, 4, async (f) => {
    const m0 = db.get('SELECT * FROM media WHERE path = ?', f.path);
    const unchanged = m0 && m0.mtime === f.mtime && m0.size === f.size && m0.probed_at && !ctx.force;
    let pr: ProbeResult | null = null;
    let tags: Record<string, string> = {};
    if (unchanged) {
      const cached = db.get('SELECT extra FROM items WHERE id = ?', m0.item_id);
      tags = parseJson<{ tags?: Record<string, string> }>(cached?.extra, {}).tags ?? {};
    } else {
      try {
        pr = await probe(f.path, f.path);
        tags = pr.tags;
      } catch (e) {
        log.warn(`Probe failed for ${f.path}: ${(e as Error).message}`);
      }
    }
    const parts = f.rel.split(path.sep);
    const folderArtist = parts.length >= 3 ? parts[parts.length - 3] : parts.length === 2 ? parts[0] : 'Unknown Artist';
    const folderAlbum = parts.length >= 2 ? parts[parts.length - 2] : 'Unknown Album';
    const artistName = tags.album_artist || tags.albumartist || tags['album artist'] || tags.artist || folderArtist;
    const albumName = tags.album || folderAlbum;
    const trackNo = parseInt(tags.track ?? '', 10) || parseEpisodeName(path.basename(f.path)).episode || null;
    const discNo = parseInt(tags.disc ?? tags.discnumber ?? '', 10) || 1;
    const year = parseInt((tags.date ?? tags.year ?? '').slice(0, 4), 10) || null;
    const genre = tags.genre ? tags.genre.split(/[;/]/).map((g) => g.trim()).filter(Boolean) : [];
    const artistId = stableId(ctx.lib.id, 'artist', artistName.toLowerCase());
    const albumId = stableId(artistId, 'album', albumName.toLowerCase());
    const albumDir = path.dirname(f.path);
    ensureItem({ id: artistId, library_id: ctx.lib.id, type: 'artist', title: artistName, path: `artist:${artistName.toLowerCase()}`,
      poster: registerImage(parts.length >= 3 ? findFile(path.join(f.root, ...parts.slice(0, parts.length - 2)), imgNames(['artist', 'folder', 'poster'])) : null),
      backdrop: registerImage(parts.length >= 3 ? findFile(path.join(f.root, ...parts.slice(0, parts.length - 2)), imgNames(['fanart', 'backdrop'])) : null) });
    const albumExisted = !!db.get('SELECT 1 FROM items WHERE id = ?', albumId);
    let cover = findFile(albumDir, imgNames(['cover', 'folder', 'front', 'album', 'albumart']));
    if (!cover && !albumArtDone.has(albumId) && pr?.coverArtIndex != null) {
      albumArtDone.add(albumId);
      const dest = path.join(coverDir, `${albumId}.jpg`);
      if (fs.existsSync(dest) || (await extractCover(f.path, dest))) cover = dest;
    } else if (!cover && fs.existsSync(path.join(coverDir, `${albumId}.jpg`))) cover = path.join(coverDir, `${albumId}.jpg`);
    ensureItem({ id: albumId, library_id: ctx.lib.id, type: 'album', title: albumName, year, parent_id: artistId, path: `album:${artistId}:${albumName.toLowerCase()}`,
      poster: registerImage(cover), ...(genre.length ? { genres: JSON.stringify(genre) } : {}) });
    if (!albumExisted) ctx.newItems.push(albumId);
    const trackId = stableId(albumId, 'track', f.path);
    ensureItem({
      id: trackId, library_id: ctx.lib.id, type: 'track', title: tags.title || stripExt(path.basename(f.path)).replace(/^\d+[\s.-]+/, ''),
      idx: trackNo, parent_idx: discNo, parent_id: albumId, grandparent_id: artistId, path: f.path, year,
      ...(genre.length ? { genres: JSON.stringify(genre) } : {}),
      extra: JSON.stringify({ tags: { artist: tags.artist ?? null, album: tags.album ?? null, title: tags.title ?? null, track: tags.track ?? null, disc: tags.disc ?? null, date: tags.date ?? null, genre: tags.genre ?? null, album_artist: tags.album_artist ?? null } }),
    });
    const res = await upsertMedia(trackId, f, ctx.force, pr);
    if (m0 && m0.item_id !== trackId) db.run('DELETE FROM items WHERE id = ? AND NOT EXISTS (SELECT 1 FROM media WHERE item_id = ?)', m0.item_id, m0.item_id);
    ctx.seenMedia.add(res.mediaId);
    ctx.seenItems.add(trackId).add(albumId).add(artistId);
    itemDuration(trackId);
    ctx.progress(++done, files.length);
  });
  // Album durations.
  db.run(`UPDATE items SET duration_ms = (SELECT SUM(duration_ms) FROM items t WHERE t.parent_id = items.id) WHERE library_id = ? AND type = 'album'`, ctx.lib.id);
}

/**
 * Audiobooks: "Author/Book Title/01 - Part.mp3", "Author/Book Title.m4b", or "Book Title/part.mp3".
 * Each book is an `audiobook` item with `bookpart` children (one per file); chapters come from the files.
 */
async function scanAudiobooks(ctx: ScanCtx, files: FileEntry[]) {
  let done = 0;
  const coverDir = path.join(config.cacheDir, 'covers');
  fs.mkdirSync(coverDir, { recursive: true });
  // Group files by book.
  const books = new Map<string, FileEntry[]>();
  for (const f of files) {
    const parts = f.rel.split(path.sep);
    const single = parts.length <= 2 && ['m4b', 'm4a'].includes(ext(f.path));
    const key = single ? f.path : path.dirname(f.path);
    const list = books.get(key) ?? [];
    list.push(f);
    books.set(key, list);
  }
  for (const [key, list] of books) {
    list.sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }));
    const first = list[0];
    let pr: ProbeResult | null = null;
    try {
      pr = await probe(first.path, first.path);
    } catch {
      /* tags optional */
    }
    const tags = pr?.tags ?? {};
    const rel = path.relative(first.root, key).split(path.sep);
    const isFile = key === first.path;
    const folderTitle = stripExt(rel[rel.length - 1] ?? 'Unknown book');
    // Author/Series/01 - Book  →  author = first folder, series = middle folder.
    const folderAuthor = rel.length >= 3 ? rel[0] : rel.length >= 2 ? rel[rel.length - 2] : null;
    const folderSeries = rel.length >= 3 ? rel[rel.length - 2] : null;
    const tagSeries = tags.series || tags.mvnm || tags['movementname'] || tags.grouping || null;
    const tagSeriesIdx = parseFloat(tags['series-part'] || tags.mvin || tags['movement'] || '') || null;
    const folderIdx = parseFloat(rel[rel.length - 1]?.match(/^(?:book\s*)?(\d+(?:\.\d+)?)\b/i)?.[1] ?? '') || null;
    const series = tagSeries ? { name: tagSeries, index: tagSeriesIdx } : folderSeries ? { name: folderSeries, index: folderIdx } : null;
    const title = tags.album || (isFile ? tags.title : null) || folderTitle.replace(/^\d{4}\s*-\s*/, '');
    const author = tags.album_artist || tags.artist || folderAuthor || 'Unknown author';
    const narrator = tags.composer || tags.narrator || null;
    const year = parseInt((tags.date ?? tags.year ?? '').slice(0, 4), 10) || null;
    const bookId = stableId(ctx.lib.id, 'audiobook', key);
    const existed = !!db.get('SELECT 1 FROM items WHERE id = ?', bookId);
    const dir = isFile ? path.dirname(key) : key;
    let cover = findFile(dir, imgNames(isFile ? [stripExt(path.basename(key)), 'cover', 'folder'] : ['cover', 'folder', 'front', 'book']));
    if (!cover && pr?.coverArtIndex != null) {
      const dest = path.join(coverDir, `${bookId}.jpg`);
      if (fs.existsSync(dest) || (await extractCover(first.path, dest))) cover = dest;
    }
    const descFile = findFile(dir, ['desc.txt', 'description.txt']);
    const people = [{ name: author, role: 'Author', kind: 'writer' }, ...(narrator ? [{ name: narrator, role: 'Narrator', kind: 'actor' }] : [])];
    ensureItem({
      id: bookId, library_id: ctx.lib.id, type: 'audiobook', title, year, path: key, poster: registerImage(cover),
      people: JSON.stringify(people), studios: JSON.stringify(tags.publisher ? [tags.publisher] : []),
      genres: JSON.stringify(tags.genre ? tags.genre.split(/[;/,]/).map((g) => g.trim()).filter(Boolean) : ['Audiobook']),
      overview: descFile ? fs.readFileSync(descFile, 'utf8').trim().slice(0, 4000) : tags.comment || tags.description || null,
      extra: JSON.stringify({ parentTitle: author, author, narrator, ...(series ? { series } : {}) }),
    });
    if (!existed) ctx.newItems.push(bookId);
    ctx.seenItems.add(bookId);
    let n = 0;
    for (const f of list) {
      n++;
      const partId = stableId(bookId, 'part', f.path);
      const ptags = f === first ? tags : {};
      ensureItem({
        id: partId, library_id: ctx.lib.id, type: 'bookpart', title: list.length === 1 ? title : ptags.title || stripExt(path.basename(f.path)).replace(/^\d+[\s._-]+/, '') || `Part ${n}`,
        idx: n, parent_id: bookId, path: f.path,
      });
      const m = await upsertMedia(partId, f, ctx.force, f === first ? pr : null);
      ctx.seenMedia.add(m.mediaId);
      ctx.seenItems.add(partId);
      itemDuration(partId);
      ctx.progress(++done, files.length);
    }
    db.run(`UPDATE items SET duration_ms = (SELECT SUM(duration_ms) FROM items p WHERE p.parent_id = ?) WHERE id = ?`, bookId, bookId);
  }
}

async function scanFlat(ctx: ScanCtx, files: FileEntry[], type: 'photo' | 'video') {
  let done = 0;
  await pool(files, type === 'photo' ? 8 : 4, async (f) => {
    const id = stableId(ctx.lib.id, type, f.path);
    const existed = !!db.get('SELECT 1 FROM items WHERE id = ?', id);
    const folder = path.basename(path.dirname(f.path));
    const date = new Date(f.mtime).toISOString();
    const p = type === 'video' ? parseMovieName(path.basename(f.path)) : null;
    ensureItem({
      id, library_id: ctx.lib.id, type, title: p?.title || stripExt(path.basename(f.path)), year: p?.year ?? new Date(f.mtime).getFullYear(), path: f.path,
      release_date: date.slice(0, 10), extra: JSON.stringify({ parentTitle: folder === path.basename(f.root) ? null : folder }),
      ...(type === 'photo' ? { poster: registerImage(f.path), thumb: registerImage(f.path) } : {}),
    });
    if (!existed) ctx.newItems.push(id);
    if (type === 'video') {
      const m = await upsertMedia(id, f, ctx.force);
      ctx.seenMedia.add(m.mediaId);
      itemDuration(id);
    } else {
      const mid = stableId('media', f.path);
      db.upsert('media', { id: mid, item_id: id, path: f.path, container: ext(f.path), size: f.size, mtime: f.mtime, probed_at: nowIso() });
      ctx.seenMedia.add(mid);
    }
    ctx.seenItems.add(id);
    ctx.progress(++done, files.length);
  });
}

/* ------------------------------ public ----------------------------- */

const scanning = new Map<string, Promise<void>>();
export const isScanning = (libId: string) => scanning.has(libId);

const ACCEPT: Record<string, (e: string) => boolean> = {
  movies: (e) => VIDEO_EXT.has(e),
  shows: (e) => VIDEO_EXT.has(e),
  videos: (e) => VIDEO_EXT.has(e),
  music: (e) => AUDIO_EXT.has(e),
  audiobooks: (e) => AUDIO_EXT.has(e),
  photos: (e) => IMAGE_EXT.has(e),
};

export function scanLibrary(libId: string, opts: { refreshMetadata?: boolean; force?: boolean } = {}): Promise<void> {
  const running = scanning.get(libId);
  if (running) return running;
  const p = doScan(libId, opts).finally(() => scanning.delete(libId));
  scanning.set(libId, p);
  return p;
}

async function doScan(libId: string, opts: { refreshMetadata?: boolean; force?: boolean }) {
  const lib = db.get('SELECT * FROM libraries WHERE id = ?', libId);
  if (!lib) return;
  const type = lib.type as LibraryType;
  if (type.startsWith('iptv-')) {
    bus.emit('iptv.refreshLibrary', lib.source_id);
    return;
  }
  if (type === 'podcasts') {
    // Folder-less: "scanning" means refreshing the subscribed feeds. Never run removal logic here.
    bus.emit('podcasts.refresh');
    return;
  }
  const started = Date.now();
  log.info(`Scanning library "${lib.name}" (${type})`);
  events.toAdmins({ type: 'library.scan', libraryId: libId, status: 'started', progress: 0 });
  const paths = parseJson<string[]>(lib.paths, []).filter((p) => {
    if (!fs.existsSync(p)) {
      log.warn(`Library path missing: ${p}`);
      return false;
    }
    return true;
  });
  const accept = ACCEPT[type] ?? ((e: string) => VIDEO_EXT.has(e));
  const files = paths.flatMap((root) => walk(root, accept)).filter((f) => type === 'photos' || type === 'music' || !isExtra(f.rel));
  let lastEmit = 0;
  const ctx: ScanCtx = {
    lib, seenMedia: new Set(), seenItems: new Set(), newItems: [], force: !!opts.force,
    progress: (done, total) => {
      if (Date.now() - lastEmit > 750 || done === total) {
        lastEmit = Date.now();
        events.toAdmins({ type: 'library.scan', libraryId: libId, status: 'progress', progress: total ? Math.round((done / total) * 80) : 80, message: `${done}/${total} files` });
      }
    },
  };
  try {
    if (type === 'movies') await scanMovies(ctx, files);
    else if (type === 'shows') await scanShows(ctx, files);
    else if (type === 'music') await scanMusic(ctx, files);
    else if (type === 'audiobooks') await scanAudiobooks(ctx, files);
    else if (type === 'photos') await scanFlat(ctx, files, 'photo');
    else await scanFlat(ctx, files, 'video');

    // Remove vanished media / items — but only if all library roots are reachable (avoid wiping on unmounted drives).
    const roots = parseJson<string[]>(lib.paths, []);
    const allRootsOk = roots.length > 0 && roots.every((p) => fs.existsSync(p));
    if (allRootsOk) {
      db.tx(() => {
        const media = db.all<{ id: string; item_id: string }>('SELECT m.id, m.item_id FROM media m JOIN items i ON i.id = m.item_id WHERE i.library_id = ?', libId);
        for (const m of media) if (!ctx.seenMedia.has(m.id)) db.run('DELETE FROM media WHERE id = ?', m.id);
        const leafTypes = "('movie','episode','track','photo','video','bookpart')";
        db.run(`DELETE FROM items WHERE library_id = ? AND type IN ${leafTypes} AND NOT EXISTS (SELECT 1 FROM media m WHERE m.item_id = items.id)`, libId);
        db.run(`DELETE FROM items WHERE library_id = ? AND type IN ('season','album','audiobook') AND NOT EXISTS (SELECT 1 FROM items c WHERE c.parent_id = items.id)`, libId);
        db.run(`DELETE FROM items WHERE library_id = ? AND type IN ('show','artist') AND NOT EXISTS (SELECT 1 FROM items c WHERE c.parent_id = items.id)`, libId);
      });
    }
    events.toAdmins({ type: 'library.scan', libraryId: libId, status: 'progress', progress: 85, message: 'Fetching metadata' });
    if (lib.fetch_metadata) {
      await enrichLibrary(libId, { refresh: !!opts.refreshMetadata, onProgress: (d, t) => events.toAdmins({ type: 'library.scan', libraryId: libId, status: 'progress', progress: 85 + Math.round((d / Math.max(t, 1)) * 15), message: `Metadata ${d}/${t}` }) });
    }
    db.run('UPDATE libraries SET last_scan_at = ? WHERE id = ?', nowIso(), libId);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    log.info(`Scan of "${lib.name}" finished in ${secs}s: ${files.length} files, ${ctx.newItems.length} new items`);
    // Metadata-provider plugins fill gaps for new music/audiobooks/videos (movies/shows were handled by enrichLibrary).
    if (type !== 'movies' && type !== 'shows') for (const id of ctx.newItems.slice(0, 500)) await applyPluginMetadata(id);
    if (ctx.newItems.length) {
      logActivity('library.scan', `${ctx.newItems.length} new item(s) added to ${lib.name}`);
      bus.emit('library.new', { libraryId: libId, itemIds: ctx.newItems });
    }
  } catch (e) {
    log.error(`Scan of "${lib.name}" failed`, e);
    logActivity('library.scan', `Scan of ${lib.name} failed: ${(e as Error).message}`, { severity: 'error' });
  } finally {
    events.toAdmins({ type: 'library.scan', libraryId: libId, status: 'finished', progress: 100 });
    events.broadcast({ type: 'library.updated', libraryId: libId });
  }
}

/** Scan a single file path into whichever library contains it (used by DVR + file watcher). */
export async function scanPath(filePath: string) {
  const libs = db.all('SELECT * FROM libraries');
  const lib = libs.find((l) => parseJson<string[]>(l.paths, []).some((p) => filePath.startsWith(p + path.sep) || filePath === p));
  if (lib) await scanLibrary(lib.id);
}

export function toLibrary(r: Row): Library {
  const count = db.get<{ n: number }>(
    `SELECT COUNT(*) n FROM items WHERE library_id = ? AND type IN ('movie','show','artist','photo','video','audiobook','podcast')`, r.id)!.n;
  return {
    id: r.id, name: r.name, type: r.type, paths: parseJson(r.paths, []), sourceId: r.source_id ?? null, itemCount: count,
    lastScanAt: r.last_scan_at ?? null, scanning: isScanning(r.id), fetchMetadata: !!r.fetch_metadata, sortOrder: r.sort_order, createdAt: r.created_at,
  };
}
