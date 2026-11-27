import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { lowPriority } from '../util/lowPriority.js';
import type { DateAddedSource, ExtraType, Library, LibraryType, SubtitleStream } from '@mediamax/shared';
import { db, type Row } from '../db.js';
import { config } from '../config.js';
import { stableId } from '../util/ids.js';
import { nowIso, parseJson, pool, sortTitle } from '../util/misc.js';
import { logger } from '../util/log.js';
import { withTimeout } from '../util/timeout.js';
import { displayName, isValidUtf8Name } from '../util/fsnames.js';
import { probe, type ProbeResult } from './probe.js';
import { registerImage } from './images.js';
import { readNfoAsync, type NfoData } from './metadata/nfo.js';
import { importSidecarEdlAsync } from './edl.js';
import { parseReplayGain, gainTags } from '../util/replaygain.js';
import {
  AUDIO_EXT, IMAGE_EXT, VIDEO_EXT, ext, isExtra, parseEpisodeName, parseMovieName, parseSeasonFolder, parseShowFolder,
  stripExt,
} from './parser.js';
import { events, bus } from './events.js';
import { enrichLibrary } from './metadata/index.js';
import { logActivity } from './activity.js';
import { externalSubsAsync } from './subtitleProviders/storage.js';
import { applyPluginMetadata } from './plugins.js';
import { mbTagSubset, parseMbTags, tagsWithId3, type MbTags } from './music/tags.js';
import { rebuildCredits } from './music/credits.js';
import { autoIdentifyAfterScan } from './music/acoustid.js';

const log = logger('scanner');

/* ------------------------------ helpers ---------------------------- */

interface FileEntry {
  path: string;
  rel: string;
  root: string;
  size: number;
  mtime: number;
  /** Creation time in ms; 0 where the filesystem does not record one. */
  birthtime: number;
}

/** A file (or a folder of media files) left out of a scan because its name is not valid UTF-8. */
export interface SkippedName {
  /** Printable path: invalid bytes shown as \xNN. */
  path: string;
  /** Media files inside, for a skipped folder. */
  files?: number;
}

const IGNORED_NAMES = new Set(['@eaDir', '#recycle', '$RECYCLE.BIN']);
const isIgnoredName = (n: string) => n.startsWith('.') || IGNORED_NAMES.has(n);

/** Count media files below a folder whose own name can't be used (walked by raw bytes, without blocking). */
async function countMediaBelow(dir: Buffer, accept: (e: string) => boolean, depth = 0): Promise<number> {
  if (depth > 20) return 0;
  let entries: fs.Dirent<Buffer>[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true, encoding: 'buffer' });
  } catch {
    return 0;
  }
  let n = 0;
  for (const e of entries) {
    const name = e.name.toString('utf8');
    if (isIgnoredName(name)) continue;
    const p = Buffer.concat([dir, Buffer.from(path.sep), e.name]);
    if (e.isDirectory() || (e.isSymbolicLink() && (await isDir(p)))) n += await countMediaBelow(p, accept, depth + 1);
    else if (accept(ext(name))) n++;
  }
  return n;
}

/**
 * Every media file under `root`. Asynchronous (readdir/stat run on libuv's thread pool) so walking ten drives of
 * media doesn't freeze the server. Names are read as raw bytes: a string readdir silently turns legacy-codepage bytes
 * into U+FFFD, giving paths that don't exist; such names are reported in `skipped` instead.
 */
interface WalkOpts {
  /** Folder to start from (default: the root). Paths stay relative to the root. */
  start?: string;
  /** Only the files directly in the start folder, no sub-folders. */
  shallow?: boolean;
  /** Real paths already walked (or not to walk into). */
  visited?: Set<string>;
  /** Folders (and files) that could not be read: what was under them must not count as deleted. */
  failed?: string[];
}

const STAT_CONCURRENCY = 16;

/** `fn` over `items`, at most `limit` at once; results in input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k]);
    }
  }));
  return out;
}

async function walk(root: string, accept: (e: string) => boolean, skipped: SkippedName[] = [], o: WalkOpts = {}): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  const stack = [o.start ?? root];
  // Real paths of the folders walked so far: symlinked folders are followed, but a link back up the tree ("loop -> .")
  // or two links to one folder must not import the same files again (or loop until the path gets too long).
  const visited = o.visited ?? new Set<string>();
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent<Buffer>[];
    try {
      const real = await fs.promises.realpath(dir);
      if (visited.has(real)) continue;
      visited.add(real);
      entries = await fs.promises.readdir(dir, { withFileTypes: true, encoding: 'buffer' });
    } catch (e) {
      // EACCES, or a transient EIO on a network share: its files are unknown, not gone (a folder that vanished is gone).
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') o.failed?.push(dir);
      log.warn(`Cannot read ${dir}: ${(e as Error).message}`);
      continue;
    }
    if (entries.some((e) => IGNORE_MARKERS.includes(e.name.toString('utf8')))) continue;
    const files: string[] = [];
    for (const e of entries) {
      const raw = e.name;
      const lossy = raw.toString('utf8');
      if (isIgnoredName(lossy)) continue;
      if (!isValidUtf8Name(raw)) {
        const rawPath = Buffer.concat([Buffer.from(dir + path.sep), raw]);
        const shown = path.join(dir, displayName(raw));
        if (e.isDirectory() || (e.isSymbolicLink() && (await isDir(rawPath)))) {
          const files = await countMediaBelow(rawPath, accept);
          if (files) skipped.push({ path: shown + path.sep, files });
        } else if (accept(ext(lossy))) skipped.push({ path: shown });
        continue;
      }
      const p = path.join(dir, lossy);
      if (e.isDirectory() || (e.isSymbolicLink() && (await isDir(p)))) {
        if (!o.shallow) stack.push(p);
      } else if (accept(ext(lossy))) files.push(p);
    }
    // Keep the order of a synchronous walk (directory listing order) while statting a folder's files in parallel, at
    // most STAT_CONCURRENCY at once: each pending stat holds a libuv thread, and on a share that stopped answering a
    // folder of a thousand files would otherwise leave no thread for anything else (static files, HLS segments).
    const stats = await mapLimit(files, STAT_CONCURRENCY, (p) => fs.promises.stat(p).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') o.failed?.push(p);
      return null;
    }));
    files.forEach((p, k) => {
      const st = stats[k];
      if (st) out.push({ path: p, rel: path.relative(root, p), root, size: st.size, mtime: Math.floor(st.mtimeMs), birthtime: Math.floor(st.birthtimeMs || 0) });
    });
  }
  return out;
}

/** Warn about skipped names without flooding the log: the first few one by one, then a summary. */
function logSkippedNames(libName: string, skipped: SkippedName[]) {
  if (!skipped.length) return;
  const MAX = 10;
  for (const s of skipped.slice(0, MAX)) {
    log.warn(`Library "${libName}": skipped ${s.files ? `folder (${s.files} media file${s.files === 1 ? '' : 's'})` : 'file'} with a name that is not valid UTF-8 (legacy character set?) - rename it to import: ${s.path}`);
  }
  if (skipped.length > MAX) log.warn(`Library "${libName}": ...and ${skipped.length - MAX} more file(s)/folder(s) with names that are not valid UTF-8 (listed under Admin > Libraries)`);
}

/** Whether a path (a symlink's target) is a folder, without blocking; false when it can't be read. */
const isDir = (p: string | Buffer) => fs.promises.stat(p).then((st) => st.isDirectory(), () => false);

/**
 * Folder listings for findFile, kept for one scan (artwork lookups list the same folder several times per file).
 * The scan writes no files into media folders, so a listing can't go stale because of the scan itself.
 */
const scanListings = new AsyncLocalStorage<Map<string, Map<string, string> | null>>();

/** Async existence check: on a sleeping or unreachable network share a blocking one can freeze the server for minutes. */
const exists = (p: string) => fs.promises.access(p).then(() => true, () => false);

/**
 * How long a library root gets to answer before it counts as offline. Windows waits on an SMB share whose PC is asleep
 * for a minute or more; the scan reports it (and skips it, or keeps its items) instead of waiting that long.
 */
export const rootTiming = { timeoutMs: 15000 };

const withinRootTimeout = <T>(p: Promise<T>, fallback: T, onTimeout?: () => void) => withTimeout(p, rootTiming.timeoutMs, fallback, onTimeout);

/** Root existence check with a time limit: an unreachable share is reported offline rather than waited for. */
const rootExists = (p: string) =>
  withinRootTimeout(exists(p), false, () => log.warn(`Library path not responding after ${rootTiming.timeoutMs / 1000}s (network share offline or asleep?): ${p}`));

/**
 * List, without blocking, the folders findFile will look in for a file's artwork and NFOs: its own folder and the ones
 * above it up to the library root (show, season, artist and album folders). Each folder is listed once per scan.
 */
async function prefetchListings(f: FileEntry): Promise<void> {
  const cache = scanListings.getStore();
  if (!cache) return;
  const dirs: string[] = [];
  for (let d = path.dirname(f.path); ; d = path.dirname(d)) {
    dirs.push(d);
    if (d === f.root || path.dirname(d) === d || !d.startsWith(f.root)) break;
  }
  await Promise.all(dirs.filter((d) => !cache.has(d)).map(async (d) => {
    let lower: Map<string, string> | null;
    try {
      const names = (await fs.promises.readdir(d, { encoding: 'buffer' })).filter(isValidUtf8Name).map((b) => b.toString('utf8'));
      lower = new Map(names.map((n) => [n.toLowerCase(), n]));
    } catch {
      lower = null;
    }
    if (!cache.has(d)) cache.set(d, lower);
  }));
}

/** The NFO named `name` in `dir`, read without blocking; null when the folder listing has no such file. */
async function nfoIn(dir: string, names: string[]): Promise<NfoData | null> {
  const p = findFile(dir, names);
  return p ? readNfoAsync(p) : null;
}

/**
 * A file named one of `names` (any case) in `dir`, from the listing prefetchListings made: every folder looked in is
 * the file's own or one above it, so it was listed (asynchronously) beforehand. It never lists a folder itself: a
 * blocking readdir on a sleeping network share froze the whole server.
 */
function findFile(dir: string, names: string[]): string | null {
  const lower = scanListings.getStore()?.get(dir);
  if (lower === undefined) log.debug(`No folder listing for ${dir} (not prefetched)`);
  if (!lower) return null;
  for (const n of names) {
    const hit = lower.get(n.toLowerCase());
    if (hit) return path.join(dir, hit);
  }
  return null;
}

/**
 * Bounds of the paths below a folder, for `path >= lo AND path < hi`: exact and case-sensitive (LIKE treats % and _
 * in folder names as wildcards and ignores ASCII case), and it can use the path index. Every path in the range starts
 * with "dir/": the bounds differ only in the separator, and no character sorts between it and the next one.
 */
function under(dir: string): [string, string] {
  return [dir + path.sep, dir + String.fromCharCode(path.sep.charCodeAt(0) + 1)];
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

/** Upsert the media row for a file, probing when new or changed. Returns probe result (fresh or cached). */
async function upsertMedia(itemId: string, f: FileEntry, force = false, preProbed?: ProbeResult | null): Promise<{ mediaId: string; probe: ProbeResult | null; changed: boolean }> {
  const existing = db.get('SELECT * FROM media WHERE path = ?', f.path);
  const id = existing?.id ?? stableId('media', f.path);
  // The folder listing the artwork lookups already made (null: the folder could not be read; undefined: not listed).
  const listed = scanListings.getStore()?.get(path.dirname(f.path));
  const subsSide = await (listed === null ? externalSubsAsync(id, null) : externalSubsAsync(id, f.path, listed ? [...listed.values()] : undefined));
  if (existing && existing.mtime === f.mtime && existing.size === f.size && !force && existing.probed_at) {
    // Keep sidecar subtitles fresh even when the file itself is unchanged.
    const embedded = parseJson<SubtitleStream[]>(existing.subs, []).filter((s) => !s.external);
    const subs = JSON.stringify([...embedded, ...subsSide]);
    // Only when something changed: a no-op rescan must not rewrite every media row.
    db.run('UPDATE media SET item_id = ?, subs = ? WHERE id = ? AND (item_id IS NOT ? OR subs IS NOT ?)', itemId, subs, id, itemId, subs);
    await importSidecarEdlAsync(itemId, f.path);
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
    hdr: pr?.hdr ?? false, video_range: pr?.videoRange ? JSON.stringify(pr.videoRange) : null, audio: JSON.stringify(pr?.audio ?? []), subs: JSON.stringify([...(pr?.subs ?? []), ...subsSide]),
    mtime: f.mtime, probed_at: pr ? nowIso() : null, chapters: JSON.stringify(pr?.chapters ?? []),
  };
  db.upsert('media', row);
  await importSidecarEdlAsync(itemId, f.path);
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
    await prefetchListings(f);
    const dir = path.dirname(f.path);
    const inOwnFolder = dir !== f.root;
    const folderParse = inOwnFolder ? parseMovieName(path.basename(dir)) : null;
    const fileParse = parseMovieName(path.basename(f.path));
    // Prefer the folder name when it looks like "Title (Year)".
    const p = folderParse?.year ? folderParse : fileParse.year || !folderParse ? fileParse : folderParse;
    // The folder is the movie's own folder (all its files are versions of it) when its name was chosen, or when the
    // file names the same title ("Avatar/Avatar (2009).mkv"). Otherwise it's a shared folder ("Marvel/Iron Man (2008).mp4",
    // "Marvel/Thor (2011).mp4"): each title + year is its own movie.
    const sameTitle = (a: string, b: string) => a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') === b.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const ownFolder = inOwnFolder && !!folderParse?.title && (p === folderParse || sameTitle(folderParse.title, fileParse.title));
    const key = ownFolder ? dir : `${p.title.toLowerCase()}|${p.year ?? ''}`;
    const id = stableId(ctx.lib.id, 'movie', key);
    const nfo = await nfoIn(dir, [`${stripExt(path.basename(f.path))}.nfo`, ...(ownFolder ? ['movie.nfo'] : [])]);
    const base = stripExt(path.basename(f.path));
    const poster = findFile(dir, imgNames([`${base}-poster`, ...(ownFolder ? ['poster', 'folder', 'cover', 'movie'] : [])]));
    const backdrop = findFile(dir, imgNames([`${base}-fanart`, `${base}-backdrop`, ...(ownFolder ? ['fanart', 'backdrop', 'background', 'art'] : [])]));
    const logo = findFile(dir, imgNames([`${base}-logo`, `${base}-clearlogo`, ...(ownFolder ? ['logo', 'clearlogo'] : [])]));
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
    const edition = fileParse.edition ?? stripExt(path.basename(f.path)).match(/\s-\s(director'?s cut|extended(?: edition| cut)?|theatrical(?: cut)?|unrated|ultimate edition|imax|remastered|final cut)\s*$/i)?.[1] ?? null;
    db.run('UPDATE media SET edition = ? WHERE id = ? AND edition IS NOT ?', edition, m.mediaId, edition);
    ctx.seenMedia.add(m.mediaId);
    ctx.seenItems.add(id);
    itemDuration(id);
    ctx.progress(++done, files.length);
  });
}

const EXTRA_FOLDERS: [RegExp, ExtraType][] = [
  [/^trailers?$/i, 'trailer'], [/^featurettes?$/i, 'featurette'], [/^behind the scenes$/i, 'behindthescenes'], [/^deleted scenes$/i, 'deleted'],
  [/^interviews?$/i, 'interview'], [/^scenes$/i, 'scene'], [/^shorts$/i, 'short'], [/^(extras?|other)$/i, 'other'],
];
const EXTRA_SUFFIX: Record<string, ExtraType> = { trailer: 'trailer', featurette: 'featurette', behindthescenes: 'behindthescenes', deleted: 'deleted', interview: 'interview', scene: 'scene', short: 'short', other: 'other' };

/**
 * Local extras (Plex/Jellyfin naming): "Movie (2010)/Trailers/x.mkv", "Movie (2010)/Extras/x.mkv",
 * "Movie (2010)/Movie (2010)-trailer.mkv", "Show/Featurettes/x.mkv". Attached to the owning movie/show as videos.
 */
async function scanExtras(ctx: ScanCtx, extras: FileEntry[]) {
  for (const f of extras) {
    if (/[-._ ]sample$/i.test(stripExt(path.basename(f.path))) || /(^|[\\/])samples?([\\/]|$)/i.test(f.rel)) continue;
    let dir = path.dirname(f.path);
    let extraType: ExtraType | null = null;
    const folder = path.basename(dir);
    const hit = EXTRA_FOLDERS.find(([re]) => re.test(folder));
    if (hit) {
      extraType = hit[1];
      dir = path.dirname(dir);
    } else {
      const suffix = stripExt(path.basename(f.path)).match(/-(trailer|featurette|behindthescenes|deleted|interview|scene|short|other)$/i)?.[1]?.toLowerCase();
      if (suffix) extraType = EXTRA_SUFFIX[suffix];
    }
    if (!extraType) continue;
    // Owner: the movie keyed by its folder, or the show keyed by its top folder.
    const owner = db.get<{ id: string }>("SELECT id FROM items WHERE library_id = ? AND type IN ('movie','show') AND path = ?", ctx.lib.id, dir)
      ?? db.get<{ id: string }>("SELECT i.id FROM items i JOIN media m ON m.item_id = i.id WHERE i.library_id = ? AND i.type = 'movie' AND m.path >= ? AND m.path < ? LIMIT 1", ctx.lib.id, ...under(dir));
    if (!owner) continue;
    const id = stableId(ctx.lib.id, 'extra', f.path);
    const title = stripExt(path.basename(f.path)).replace(/-(trailer|featurette|behindthescenes|deleted|interview|scene|short|other)$/i, '').replace(/[._]/g, ' ').trim();
    const LABEL: Record<ExtraType, string> = { trailer: 'Trailer', featurette: 'Featurette', behindthescenes: 'Behind the Scenes', deleted: 'Deleted Scene', interview: 'Interview', scene: 'Scene', short: 'Short', other: 'Extra' };
    // Folder-based extras keep their file name; suffix-based ones ("Movie (2010)-trailer") get a readable label.
    ensureItem({ id, library_id: ctx.lib.id, type: 'video', title: hit ? title : LABEL[extraType], parent_id: owner.id, path: f.path, extra: JSON.stringify({ extraType }) });
    const m = await upsertMedia(id, f, ctx.force);
    ctx.seenMedia.add(m.mediaId);
    ctx.seenItems.add(id);
    itemDuration(id);
  }
}

async function scanShows(ctx: ScanCtx, files: FileEntry[]) {
  let done = 0;
  // A show is created once; the other episodes of it wait for that (its NFO is read asynchronously) before their season.
  const showCache = new Map<string, Promise<void>>();
  const seasonCache = new Map<string, string>();
  // Process sequentially per show folder to avoid races creating parents; probe in parallel.
  await pool(files, 4, async (f) => {
    await prefetchListings(f);
    const parts = f.rel.split(path.sep);
    const showFolder = parts.length > 1 ? parts[0] : null;
    const ep = parseEpisodeName(path.basename(f.path));
    const showName = showFolder ?? ep.show ?? 'Unknown Show';
    const showDir = showFolder ? path.join(f.root, showFolder) : f.root;
    const showKey = showFolder ? showDir : `${f.root}|${showName.toLowerCase()}`;
    const showId = stableId(ctx.lib.id, 'show', showKey);
    let show = showCache.get(showId);
    if (!show) {
      show = (async () => {
        const sp = parseShowFolder(showName);
        const nfo = showFolder ? await nfoIn(showDir, ['tvshow.nfo']) : null;
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
      })();
      showCache.set(showId, show);
    }
    await show;
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
    const nfo = await nfoIn(path.dirname(f.path), [`${base}.nfo`]);
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
    const p = lowPriority(spawn(config.ffmpeg, ['-v', 'error', '-y', '-i', file, '-an', '-map', '0:v:0', '-frames:v', '1', dest]));
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
    await prefetchListings(f);
    const m0 = db.get('SELECT * FROM media WHERE path = ?', f.path);
    const unchanged = m0 && m0.mtime === f.mtime && m0.size === f.size && m0.probed_at && !ctx.force;
    let pr: ProbeResult | null = null;
    let tags: Record<string, string> = {};
    let mbRaw: Record<string, string> = {};
    const cachedExtra = unchanged ? parseJson<{ tags?: Record<string, string>; mbTags?: Record<string, string>; tagv?: number }>(db.get('SELECT extra FROM items WHERE id = ?', m0.item_id)?.extra, {}) : null;
    if (cachedExtra && cachedExtra.tagv === MUSIC_TAG_VERSION) {
      tags = cachedExtra.tags ?? {};
      mbRaw = cachedExtra.mbTags ?? {};
    } else {
      // New or changed files, and files scanned before MusicBrainz tags were read (one re-probe fills their MBIDs).
      try {
        pr = await probe(f.path, f.path);
        tags = pr.tags;
        mbRaw = mbTagSubset(await tagsWithId3(f.path, pr.tags));
      } catch (e) {
        log.warn(`Probe failed for ${f.path}: ${(e as Error).message}`);
        if (cachedExtra) tags = cachedExtra.tags ?? {};
      }
    }
    const mb = parseMbTags(mbRaw);
    const parts = f.rel.split(path.sep);
    const folderArtist = parts.length >= 3 ? parts[parts.length - 3] : parts.length === 2 ? parts[0] : 'Unknown Artist';
    const folderAlbum = parts.length >= 2 ? parts[parts.length - 2] : 'Unknown Album';
    const artistName = tags.album_artist || tags.albumartist || tags['album artist'] || tags.artist || folderArtist;
    const albumName = tags.album || folderAlbum;
    const trackNo = parseInt(tags.track ?? '', 10) || parseEpisodeName(path.basename(f.path)).episode || null;
    const discNo = parseInt(tags.disc ?? tags.discnumber ?? '', 10) || 1;
    const year = parseInt((tags.date ?? tags.year ?? '').slice(0, 4), 10) || null;
    const genre = tags.genre ? tags.genre.split(/[;/]/).map((g) => g.trim()).filter(Boolean) : [];
    // MusicBrainz ids (Picard tags) decide grouping when present; libraries without them group by name as before.
    const hasAlbumArtistTag = !!(tags.album_artist || tags.albumartist || tags['album artist']);
    const artistMbid = mb.albumArtists[0] ?? (!hasAlbumArtistTag && mb.artists.length === 1 ? mb.artists[0] : null);
    const artistId = resolveMusicArtist(ctx.lib.id, artistName, artistMbid);
    const albumId = resolveMusicAlbum(artistId, albumName, mb.release);
    const albumDir = path.dirname(f.path);
    // Name variants merged by MBID ("Beyonce" / "Beyoncé") keep the title the artist was first seen with.
    const artistTitle = artistId !== stableId(ctx.lib.id, 'artist', artistName.toLowerCase()) ? db.get<{ title: string }>('SELECT title FROM items WHERE id = ?', artistId)?.title ?? artistName : artistName;
    ensureItem({ id: artistId, library_id: ctx.lib.id, type: 'artist', title: artistTitle, path: `artist:${artistTitle.toLowerCase()}`,
      poster: registerImage(parts.length >= 3 ? findFile(path.join(f.root, ...parts.slice(0, parts.length - 2)), imgNames(['artist', 'folder', 'poster'])) : null),
      backdrop: registerImage(parts.length >= 3 ? findFile(path.join(f.root, ...parts.slice(0, parts.length - 2)), imgNames(['fanart', 'backdrop'])) : null) });
    if (artistMbid) setTagIds(artistId, { musicbrainzArtist: artistMbid }, { mbTag: true });
    const albumExisted = !!db.get('SELECT 1 FROM items WHERE id = ?', albumId);
    // Create the album before any await so concurrent tracks of the same release find it by MBID.
    ensureItem({ id: albumId, library_id: ctx.lib.id, type: 'album', title: albumName, year, parent_id: artistId, path: `album:${artistId}:${albumName.toLowerCase()}` });
    if (mb.release || mb.releaseGroup) setTagIds(albumId, { musicbrainzRelease: mb.release, musicbrainzReleaseGroup: mb.releaseGroup }, null);
    setAlbumMusic(albumId, mb, discNo);
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
      extra: JSON.stringify({ tags: { artist: tags.artist ?? null, album: tags.album ?? null, title: tags.title ?? null, track: tags.track ?? null, disc: tags.disc ?? null, date: tags.date ?? null, genre: tags.genre ?? null, album_artist: tags.album_artist ?? null, ...gainTags(tags) }, replayGain: parseReplayGain(tags), ...(Object.keys(mbRaw).length ? { mbTags: mbRaw } : {}), tagv: MUSIC_TAG_VERSION }),
    });
    if (mb.recording || mb.releaseTrack || mb.work || mb.acoustid) setTagIds(trackId, { musicbrainzRecording: mb.recording, musicbrainzReleaseTrack: mb.releaseTrack, musicbrainzWork: mb.work, acoustid: mb.acoustid }, null);
    const res = await upsertMedia(trackId, f, ctx.force, pr);
    if (m0 && m0.item_id !== trackId) {
      // The track moved (e.g. to its own album once MBIDs split two editions): keep its play history and playlist entries.
      db.run('UPDATE OR IGNORE user_data SET item_id = ? WHERE item_id = ?', trackId, m0.item_id);
      db.run('UPDATE OR IGNORE collection_items SET item_id = ? WHERE item_id = ?', trackId, m0.item_id);
      db.run('DELETE FROM items WHERE id = ? AND NOT EXISTS (SELECT 1 FROM media WHERE item_id = ?)', m0.item_id, m0.item_id);
    }
    ctx.seenMedia.add(res.mediaId);
    ctx.seenItems.add(trackId).add(albumId).add(artistId);
    itemDuration(trackId);
    ctx.progress(++done, files.length);
  });
  // Album durations.
  db.run(`UPDATE items SET duration_ms = (SELECT SUM(duration_ms) FROM items t WHERE t.parent_id = items.id) WHERE library_id = ? AND type = 'album'`, ctx.lib.id);
  // Track → credited artists ("A feat. B & C"), now that every artist of the library exists.
  try {
    rebuildCredits(ctx.lib.id);
  } catch (e) {
    log.warn(`Artist credits: ${(e as Error).message}`);
  }
}

/** Bump to make the next scan re-read the tags of unchanged music files (v2: MusicBrainz tags). */
const MUSIC_TAG_VERSION = 2;

/**
 * Artist item for a name + optional MusicBrainz artist id. Without an MBID: the name-based id (as always).
 * With one: the library artist that already has it (name variants merge), else the name-based id unless that one
 * belongs to a different MBID from tags (two artists sharing a name stay apart).
 */
export function resolveMusicArtist(libraryId: string, name: string, mbid: string | null): string {
  const nameId = stableId(libraryId, 'artist', name.toLowerCase());
  if (!mbid) return nameId;
  const byMb = db.get<{ id: string }>("SELECT id FROM items WHERE library_id = ? AND type = 'artist' AND json_extract(external_ids, '$.musicbrainzArtist') = ? LIMIT 1", libraryId, mbid);
  if (byMb) return byMb.id;
  const ex = db.get<{ external_ids: string; extra: string }>('SELECT external_ids, extra FROM items WHERE id = ?', nameId);
  if (!ex) return nameId;
  const exMb = parseJson<Record<string, string>>(ex.external_ids, {}).musicbrainzArtist;
  // An MBID found by a name search (not from tags) yields to the tagged one.
  if (!exMb || exMb === mbid || !parseJson<{ mbTag?: boolean }>(ex.extra, {}).mbTag) return nameId;
  return stableId(libraryId, 'artist', 'mbid', mbid);
}

/** Album item under an artist: by release MBID when tagged (deluxe and standard editions stay apart), else by name. */
export function resolveMusicAlbum(artistId: string, name: string, releaseMbid: string | null): string {
  const nameId = stableId(artistId, 'album', name.toLowerCase());
  if (!releaseMbid) return nameId;
  const byMb = db.get<{ id: string }>("SELECT id FROM items WHERE parent_id = ? AND type = 'album' AND json_extract(external_ids, '$.musicbrainzRelease') = ? LIMIT 1", artistId, releaseMbid);
  if (byMb) return byMb.id;
  const ex = db.get<{ external_ids: string }>('SELECT external_ids FROM items WHERE id = ?', nameId);
  if (!ex) return nameId;
  const exRel = parseJson<Record<string, string>>(ex.external_ids, {}).musicbrainzRelease;
  if (!exRel || exRel === releaseMbid) return nameId;
  return stableId(artistId, 'album', 'mbrel', releaseMbid);
}

/** Merge ids read from tags into an item's external_ids (tags win over ids found by searching). */
function setTagIds(itemId: string, ids: Record<string, string | null>, extraFlags: Record<string, unknown> | null) {
  const row = db.get<{ external_ids: string; extra: string }>('SELECT external_ids, extra FROM items WHERE id = ?', itemId);
  if (!row) return;
  const cur = parseJson<Record<string, string>>(row.external_ids, {});
  const next = { ...cur };
  for (const [k, v] of Object.entries(ids)) if (v) next[k] = v;
  const patch: Row = {};
  if (JSON.stringify(next) !== JSON.stringify(cur)) patch.external_ids = JSON.stringify(next);
  if (extraFlags) {
    const ex = parseJson<Record<string, unknown>>(row.extra, {});
    const merged = { ...ex, ...extraFlags };
    if (JSON.stringify(merged) !== JSON.stringify(ex)) patch.extra = JSON.stringify(merged);
  }
  if (Object.keys(patch).length) db.update('items', itemId, patch);
}

/** Release facts from tags on the album (extra.music): types, status, original year, label, catalogue no., barcode, disc titles. */
function setAlbumMusic(albumId: string, mb: MbTags, disc: number) {
  const row = db.get<{ extra: string }>('SELECT extra FROM items WHERE id = ?', albumId);
  if (!row) return;
  const ex = parseJson<Record<string, any>>(row.extra, {});
  const cur = ex.music ?? {};
  const m: Record<string, unknown> = { ...cur };
  if (mb.releaseTypes.length) m.releaseTypes = mb.releaseTypes;
  if (mb.releaseStatus) m.releaseStatus = mb.releaseStatus;
  if (mb.originalYear) m.originalYear = mb.originalYear;
  if (mb.originalDate) m.originalDate = mb.originalDate;
  if (mb.label) m.label = mb.label;
  if (mb.catalogNumber) m.catalogNumber = mb.catalogNumber;
  if (mb.barcode) m.barcode = mb.barcode;
  if (mb.compilation) m.compilation = true;
  if (mb.discSubtitle) m.discTitles = { ...(cur.discTitles ?? {}), [String(disc)]: mb.discSubtitle };
  if (JSON.stringify(m) !== JSON.stringify(cur)) db.update('items', albumId, { extra: JSON.stringify({ ...ex, music: m }) });
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
    await prefetchListings(first);
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
    const desc = descFile ? await fs.promises.readFile(descFile, 'utf8').catch(() => null) : null;
    const people = [{ name: author, role: 'Author', kind: 'writer' }, ...(narrator ? [{ name: narrator, role: 'Narrator', kind: 'actor' }] : [])];
    ensureItem({
      id: bookId, library_id: ctx.lib.id, type: 'audiobook', title, year, path: key, poster: registerImage(cover),
      people: JSON.stringify(people), studios: JSON.stringify(tags.publisher ? [tags.publisher] : []),
      genres: JSON.stringify(tags.genre ? tags.genre.split(/[;/,]/).map((g) => g.trim()).filter(Boolean) : ['Audiobook']),
      overview: desc != null ? desc.trim().slice(0, 4000) : tags.comment || tags.description || null,
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

/* ---------------------------- date added --------------------------- */

const DATE_ADDED: DateAddedSource[] = ['scan', 'created', 'modified'];
export const isDateAddedSource = (v: unknown): v is DateAddedSource => DATE_ADDED.includes(v as DateAddedSource);
export const libraryDateAdded = (v: unknown): DateAddedSource => (isDateAddedSource(v) ? v : 'scan');

/**
 * The date added a file gets under a rule, in ms (null = keep the scan time). `created` falls back to the modification
 * time when the filesystem records no creation time (birthtime 0, as on some Linux filesystems); never in the future.
 */
export function fileAddedMs(rule: DateAddedSource, f: { birthtime: number; mtime: number }, now = Date.now()): number | null {
  if (rule === 'scan') return null;
  const t = rule === 'created' && f.birthtime > 0 ? f.birthtime : f.mtime;
  if (!Number.isFinite(t) || t <= 0) return null;
  return Math.min(t, now);
}

const LEAF_TYPES = "('movie','episode','track','photo','video','bookpart')";
/** Parents take the earliest date of these children; inner levels first, so shows see their seasons' new dates. */
const PARENT_LEVELS: [string, string][] = [['season', 'episode'], ['album', 'track'], ['audiobook', 'bookpart'], ['show', 'season'], ['artist', 'album']];

/**
 * Apply a library's "date added" rule. `since` = only items added at or after it (the ones a scan just created),
 * null = every item (Recalculate date added). `files` saves a stat per file during a scan. Returns items changed.
 */
export async function applyDateAdded(libId: string, since: string | null, files?: Map<string, { birthtime: number; mtime: number }>): Promise<number> {
  const lib = db.get<{ type: string; date_added: string }>('SELECT type, date_added FROM libraries WHERE id = ?', libId);
  if (!lib || lib.type.startsWith('iptv-') || lib.type === 'podcasts') return 0;
  const rule = libraryDateAdded(lib.date_added);
  if (rule === 'scan') return 0;
  const now = Date.now();
  const sinceSql = since ? ' AND i.added_at >= ?' : '';
  const sinceParams = since ? [since] : [];
  const rows = db.all<{ id: string; path: string; added_at: string }>(
    `SELECT i.id, m.path, i.added_at FROM items i JOIN media m ON m.item_id = i.id WHERE i.library_id = ? AND i.type IN ${LEAF_TYPES} AND m.path IS NOT NULL${sinceSql}`,
    libId, ...sinceParams);
  // Items with several files (movie versions) take the earliest file.
  const best = new Map<string, { ms: number; cur: string }>();
  // Files the scan didn't stat (all of them for Recalculate date added) are statted without blocking, a few at a time:
  // they're often on a network share. The rows are then handled in their original order, as before.
  const stats = new Map<string, { birthtime: number; mtime: number } | null>();
  const toStat = [...new Set(rows.filter((r) => !files?.get(r.path)).map((r) => r.path))];
  await pool(toStat, 8, async (p) => {
    const s = await fs.promises.stat(p).catch(() => null);
    stats.set(p, s ? { birthtime: Math.floor(s.birthtimeMs || 0), mtime: Math.floor(s.mtimeMs) } : null);
  });
  for (const r of rows) {
    const st = files?.get(r.path) ?? stats.get(r.path) ?? null;
    if (!st) continue;
    const ms = fileAddedMs(rule, st, now);
    if (ms === null) continue;
    const b = best.get(r.id);
    if (!b || ms < b.ms) best.set(r.id, { ms, cur: r.added_at });
  }
  let changed = 0;
  db.tx(() => {
    for (const [id, b] of best) {
      const iso = new Date(b.ms).toISOString();
      if (iso === b.cur) continue;
      db.run('UPDATE items SET added_at = ? WHERE id = ?', iso, id);
      changed++;
    }
    for (const [parent, child] of PARENT_LEVELS) {
      const r = db.run(
        `UPDATE items SET added_at = (SELECT MIN(c.added_at) FROM items c WHERE c.parent_id = items.id AND c.type = '${child}')
         WHERE library_id = ? AND type = '${parent}'${since ? ' AND added_at >= ?' : ''}
           AND EXISTS (SELECT 1 FROM items c WHERE c.parent_id = items.id AND c.type = '${child}')
           AND added_at IS NOT (SELECT MIN(c.added_at) FROM items c WHERE c.parent_id = items.id AND c.type = '${child}')`,
        libId, ...sinceParams);
      changed += Number(r.changes);
    }
  });
  return changed;
}

/** Re-apply the "date added" rule to every item of one library (or all libraries) without rescanning. */
export async function recalculateDateAdded(libId?: string): Promise<number> {
  const ids = libId ? [libId] : db.all<{ id: string }>('SELECT id FROM libraries').map((l) => l.id);
  let n = 0;
  for (const id of ids) n += await applyDateAdded(id, null);
  if (n) for (const id of ids) events.broadcast({ type: 'library.updated', libraryId: id });
  return n;
}

/* ------------------------------ public ----------------------------- */

const scanning = new Map<string, Promise<void>>();
/** Skipped names kept per library for the admin page (the count is always exact). */
const MAX_SKIPPED_LISTED = 200;
export const isScanning = (libId: string) => scanning.has(libId);

const ACCEPT: Record<string, (e: string) => boolean> = {
  movies: (e) => VIDEO_EXT.has(e),
  shows: (e) => VIDEO_EXT.has(e),
  videos: (e) => VIDEO_EXT.has(e),
  music: (e) => AUDIO_EXT.has(e),
  audiobooks: (e) => AUDIO_EXT.has(e),
  photos: (e) => IMAGE_EXT.has(e),
};

export interface ScanOptions {
  refreshMetadata?: boolean;
  force?: boolean;
  /**
   * Only these files/folders changed (watcher scans): walk just the library folders that hold them and remove only
   * media below those. Each path is widened to its top-level folder under the library root (a show, a movie folder,
   * an artist), so grouping comes out as a full scan's; the root itself (or a file directly in it) means the files
   * directly in the root. Paths outside the roots, or more than MAX_SCAN_PATHS folders, fall back to a full scan.
   */
  paths?: string[];
}

/** Scans requested while one runs for the same library: one follow-up scan with their options merged. */
const followUps = new Map<string, { opts: ScanOptions; promise: Promise<void> }>();
const MAX_SCAN_PATHS = 50;

function mergeScanOptions(a: ScanOptions, b: ScanOptions): ScanOptions {
  return {
    refreshMetadata: !!(a.refreshMetadata || b.refreshMetadata),
    force: !!(a.force || b.force),
    // A full scan covers any partial one.
    ...(a.paths && b.paths ? { paths: [...new Set([...a.paths, ...b.paths])] } : {}),
  };
}

/**
 * Scan a library. A request while a scan of it runs doesn't share that scan (its walk may have passed the change
 * already): it gets one more scan once the running one ends, shared by every request made meanwhile.
 */
export function scanLibrary(libId: string, opts: ScanOptions = {}): Promise<void> {
  const running = scanning.get(libId);
  if (!running) {
    const p = scanListings.run(new Map(), () => doScan(libId, opts)).finally(() => scanning.delete(libId));
    scanning.set(libId, p);
    return p;
  }
  const queued = followUps.get(libId);
  if (queued) {
    queued.opts = mergeScanOptions(queued.opts, opts);
    return queued.promise;
  }
  const next: { opts: ScanOptions; promise: Promise<void> } = { opts, promise: null! };
  const go = () => {
    followUps.delete(libId);
    return scanLibrary(libId, next.opts);
  };
  next.promise = running.then(go, go);
  followUps.set(libId, next);
  return next.promise;
}

/** What a partial scan covers: top-level folders walked fully, roots of which only the files directly inside. */
interface ScanScope { deep: string[]; shallow: string[] }

/** The folders a partial scan walks, or null for a full scan. */
async function scanScope(roots: string[], changed: string[]): Promise<ScanScope | null> {
  const deep = new Set<string>();
  const shallow = new Set<string>();
  for (const raw of changed) {
    const p = path.resolve(raw);
    const root = roots.find((r) => p === r || p.startsWith(r + path.sep));
    if (!root) return null;
    if (p === root) {
      shallow.add(root);
      continue;
    }
    const top = path.join(root, path.relative(root, p).split(path.sep)[0]);
    // gone (null): whatever was below it is removed
    const st = await fs.promises.lstat(top).catch(() => null);
    // A symlinked folder may point anywhere in the library (even back at the root): a full walk sorts out duplicates.
    if (st?.isSymbolicLink()) return null;
    deep.add(top);
    // A file directly in the root, or something there that vanished (file or folder, no way to tell): root files too.
    if (!st?.isDirectory()) shallow.add(root);
  }
  if (deep.size + shallow.size > MAX_SCAN_PATHS) return null;
  return { deep: [...deep], shallow: [...shallow] };
}

const IGNORE_MARKERS = ['.mediamaxignore', '.plexignore', '.ignore'];

async function doScan(libId: string, opts: ScanOptions) {
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
  const startedIso = new Date(started).toISOString();
  // Checked in parallel and without blocking: a library spread over several NAS shares, one of them asleep or offline,
  // used to freeze the whole server (every request, the tray's health check) while each path timed out in turn.
  const libPaths = parseJson<string[]>(lib.paths, []);
  const present = await Promise.all(libPaths.map(rootExists));
  const paths = libPaths.filter((p, k) => {
    if (!present[k]) log.warn(`Library path missing: ${p}`);
    return present[k];
  });
  const scope = opts.paths ? await scanScope(paths.map((p) => path.resolve(p)), opts.paths) : null;
  log.info(`Scanning library "${lib.name}" (${type})${scope ? `: ${[...scope.deep, ...scope.shallow.map((r) => `${r} (files only)`)].join(', ')}` : ''}`);
  events.toAdmins({ type: 'library.scan', libraryId: libId, status: 'started', progress: 0 });
  const accept = ACCEPT[type] ?? ((e: string) => VIDEO_EXT.has(e));
  const skipped: SkippedName[] = [];
  const allFiles: FileEntry[] = [];
  const failed: string[] = [];
  for (const root of paths) {
    if (!scope) {
      allFiles.push(...(await walk(root, accept, skipped, { failed })));
      continue;
    }
    const r = path.resolve(root);
    const deep = scope.deep.filter((d) => path.dirname(d) === r);
    if (!deep.length && !scope.shallow.includes(r)) continue;
    let rootEntries: string[];
    let realRoot: string;
    try {
      rootEntries = await fs.promises.readdir(r);
      realRoot = await fs.promises.realpath(r);
    } catch (e) {
      failed.push(r);
      log.warn(`Cannot read ${r}: ${(e as Error).message}`);
      continue;
    }
    // A full scan imports nothing below an ignore marker in the root.
    if (rootEntries.some((n) => IGNORE_MARKERS.includes(n))) continue;
    // The root counts as walked, as in a full scan (a link inside pointing back at it is not followed).
    const visited = new Set([realRoot]);
    if (scope.shallow.includes(r)) allFiles.push(...(await walk(root, accept, skipped, { shallow: true, failed })));
    for (const d of deep) if (await exists(d)) allFiles.push(...(await walk(root, accept, skipped, { start: d, visited, failed })));
  }
  // Media a partial scan may remove: only below the folders it walked.
  const inScope = (p: string) => !scope || scope.deep.some((d) => p.startsWith(d + path.sep)) || scope.shallow.includes(path.dirname(p));
  logSkippedNames(lib.name, skipped);
  // Kept with the library (like last_scan_at) so the admin page can show it after a restart. A partial scan only
  // replaces the entries below the folders it walked.
  let skippedAll = skipped;
  let skippedCount = skipped.length;
  if (scope) {
    const prev = parseJson<{ count: number; paths: SkippedName[] } | null>(lib.skipped_names, null);
    const kept = (prev?.paths ?? []).filter((x) => !inScope(x.path.replace(/[\\/]$/, '')));
    skippedAll = [...kept, ...skipped];
    skippedCount = Math.max(skippedAll.length, (prev?.count ?? 0) - ((prev?.paths.length ?? 0) - kept.length) + skipped.length);
  }
  db.run('UPDATE libraries SET skipped_names = ? WHERE id = ?', skippedCount ? JSON.stringify({ count: skippedCount, paths: skippedAll.slice(0, MAX_SKIPPED_LISTED) }) : null, libId);
  const files = allFiles.filter((f) => type === 'photos' || type === 'music' || type === 'audiobooks' || !isExtra(f.rel));
  const extraFiles = type === 'movies' || type === 'shows' ? allFiles.filter((f) => isExtra(f.rel)) : [];
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
    // Extras (trailers, featurettes…) are attached after the main pass so their owners exist.
    if (type === 'movies') {
      await scanMovies(ctx, files);
      if (extraFiles.length) await scanExtras(ctx, extraFiles);
    } else if (type === 'shows') {
      await scanShows(ctx, files);
      if (extraFiles.length) await scanExtras(ctx, extraFiles);
    }
    else if (type === 'music') await scanMusic(ctx, files);
    else if (type === 'audiobooks') await scanAudiobooks(ctx, files);
    else if (type === 'photos') await scanFlat(ctx, files, 'photo');
    else await scanFlat(ctx, files, 'video');
    scanListings.getStore()?.clear(); // done with artwork lookups: free the folder listings

    // Remove vanished media / items — but only if all library roots are reachable (avoid wiping on unmounted drives).
    // An empty root counts as unreachable: an unmounted NAS share usually leaves its empty mount-point folder behind,
    // and treating that as "everything was deleted" would drop every item along with everyone's watch history.
    const roots = parseJson<string[]>(lib.paths, []);
    // A root that doesn't answer in time counts as unreachable too: nothing is removed.
    const rootOk = (p: string) => withinRootTimeout(fs.promises.readdir(p).then((e) => e.length > 0, () => false), false);
    const allRootsOk = roots.length > 0 && (await Promise.all(roots.map(rootOk))).every(Boolean);
    if (!allRootsOk && (await Promise.all(roots.map(rootExists))).some(Boolean)) log.warn(`Library "${lib.name}": a folder is missing or empty (unmounted?), so nothing was removed`);
    if (allRootsOk) {
      // Below a folder that could not be read nothing is known, so nothing there counts as deleted.
      const unreadable = (p: string | null) => !!p && failed.some((f) => p === f || p.startsWith(f + path.sep));
      if (failed.length) log.warn(`Library "${lib.name}": ${failed.length} folder(s)/file(s) could not be read; their items are kept until a scan can read them`);
      db.tx(() => {
        const media = db.all<{ id: string; path: string | null }>('SELECT m.id, m.path FROM media m JOIN items i ON i.id = m.item_id WHERE i.library_id = ?', libId);
        for (const m of media) {
          if (ctx.seenMedia.has(m.id) || unreadable(m.path) || (scope && !(m.path && inScope(m.path)))) continue;
          db.run('DELETE FROM media WHERE id = ?', m.id);
        }
        const leafTypes = "('movie','episode','track','photo','video','bookpart')";
        db.run(`DELETE FROM items WHERE library_id = ? AND type IN ${leafTypes} AND NOT EXISTS (SELECT 1 FROM media m WHERE m.item_id = items.id)`, libId);
        db.run(`DELETE FROM items WHERE library_id = ? AND type IN ('season','album','audiobook') AND NOT EXISTS (SELECT 1 FROM items c WHERE c.parent_id = items.id)`, libId);
        db.run(`DELETE FROM items WHERE library_id = ? AND type IN ('show','artist') AND NOT EXISTS (SELECT 1 FROM items c WHERE c.parent_id = items.id)`, libId);
      });
    }
    // Items found by this scan take their date added from their files (per the library's rule).
    await applyDateAdded(libId, startedIso, new Map(allFiles.map((f) => [f.path, f])));
    events.toAdmins({ type: 'library.scan', libraryId: libId, status: 'progress', progress: 85, message: 'Fetching metadata' });
    if (lib.fetch_metadata) {
      await enrichLibrary(libId, { refresh: !!opts.refreshMetadata, onProgress: (d, t) => events.toAdmins({ type: 'library.scan', libraryId: libId, status: 'progress', progress: 85 + Math.round((d / Math.max(t, 1)) * 15), message: `Metadata ${d}/${t}` }) });
    }
    db.run('UPDATE libraries SET last_scan_at = ? WHERE id = ?', nowIso(), libId);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    log.info(`Scan of "${lib.name}" finished in ${secs}s: ${files.length} files, ${ctx.newItems.length} new items`);
    // Metadata-provider plugins fill gaps for new music/audiobooks/videos (movies/shows were handled by enrichLibrary).
    if (type !== 'movies' && type !== 'shows') for (const id of ctx.newItems.slice(0, 500)) await applyPluginMetadata(id);
    // AcoustID for untagged tracks (only when the admin enabled automatic identification).
    if (type === 'music') void autoIdentifyAfterScan().catch((e) => log.debug(`AcoustID: ${(e as Error).message}`));
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

export function toLibrary(r: Row): Library {
  const count = db.get<{ n: number }>(
    `SELECT COUNT(*) n FROM items WHERE library_id = ? AND type IN ('movie','show','artist','photo','video','audiobook','podcast')`, r.id)!.n;
  return {
    id: r.id, name: r.name, type: r.type, paths: parseJson(r.paths, []), sourceId: r.source_id ?? null, itemCount: count,
    lastScanAt: r.last_scan_at ?? null, scanning: isScanning(r.id), skippedNames: parseJson<Library['skippedNames']>(r.skipped_names, null), fetchMetadata: !!r.fetch_metadata, sortOrder: r.sort_order, createdAt: r.created_at,
    dateAdded: libraryDateAdded(r.date_added),
  };
}
