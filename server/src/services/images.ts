import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { db } from '../db.js';
import { config } from '../config.js';
import { stableId } from '../util/ids.js';
import { nowIso } from '../util/misc.js';
import { notFound } from '../util/errors.js';
import { logger } from '../util/log.js';
import { safeFetch } from '../util/net.js';
import { fileExists } from '../util/fileAsync.js';

const log = logger('images');

/**
 * Images are registered by source (absolute local path or http(s) URL) and
 * exposed as `/api/v1/images/:id`. Remote images are fetched once and cached;
 * resized variants (`?w=`) are produced with ffmpeg and cached too.
 */
const LOCAL_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tbn', '.avif', '.bmp', '.heic', '.heif', '.tiff']);
const isLocalImagePath = (p: string) => path.isAbsolute(p) && LOCAL_IMAGE_EXT.has(path.extname(p).toLowerCase());

/**
 * Register an image found by the server itself: a local file (scanner, uploads, generated thumbnails)
 * or a URL from a trusted metadata provider. Local paths must be image files.
 */
export function registerImage(source: string | null | undefined): string | null {
  if (!source) return null;
  if (!/^https?:\/\//i.test(source) && !isLocalImagePath(source)) return null;
  const id = stableId('img', source);
  db.run('INSERT OR IGNORE INTO images (id, source, created_at) VALUES (?, ?, ?)', id, source, nowIso());
  if (!/^https?:\/\//i.test(source) && !refreshing.has(id)) {
    const p = refreshLocalCopy(id, source).finally(() => refreshing.delete(id));
    refreshing.set(id, p);
  }
  return id;
}

/** Copy checks still running (resolveImage waits for one so it never serves a copy that is about to be dropped). */
const refreshing = new Map<string, Promise<void>>();

/** Media-folder artwork is copied into the data dir on first use (see resolveImage). */
const isInDataDir = (p: string) => path.resolve(p).startsWith(config.dataDir + path.sep);

/**
 * The copy of media-folder artwork in the data dir, made on first use. Fully asynchronous: the original is usually
 * on a NAS or another PC, and a blocking check or copy there froze the whole server for minutes while the share
 * woke up (each poster on a home screen is one request). Resolves to null when the original is missing.
 */
async function cacheLocalCopy(id: string, source: string): Promise<string | null> {
  if (!(await fileExists(source))) return null;
  if (isInDataDir(source)) return source;
  try {
    const dest = path.join(config.imageCacheDir, 'local', id.slice(0, 2), id + path.extname(source).toLowerCase());
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(source, dest);
    db.run('UPDATE images SET cached = ? WHERE id = ?', dest, id);
    return dest;
  } catch {
    return source;
  }
}

/** How long a request waits for artwork on a slow share before answering "unavailable" (the copy carries on). */
export const LOCAL_ARTWORK_WAIT_MS = 8000;
const copying = new Map<string, Promise<string | null>>();

/** cacheLocalCopy, once per image at a time, waited for at most LOCAL_ARTWORK_WAIT_MS. */
async function localArtwork(id: string, source: string, waitMs = LOCAL_ARTWORK_WAIT_MS): Promise<string> {
  let p = copying.get(id);
  if (!p) {
    p = cacheLocalCopy(id, source).finally(() => copying.delete(id));
    copying.set(id, p);
  }
  let timer: NodeJS.Timeout | undefined;
  const slow = new Promise<'slow'>((r) => (timer = setTimeout(() => r('slow'), waitMs)));
  const file = await Promise.race([p, slow]).finally(() => clearTimeout(timer));
  if (file === 'slow') throw notFound('Image unavailable: its disk is not responding');
  if (!file) throw notFound('Image file missing');
  return file;
}
/** Tests only. */
export const _localArtwork = localArtwork;

/**
 * Called while scanning (the disk is awake then): drop the copy if the original artwork changed. Asynchronous: the
 * original is usually on a network share, and a blocking stat there can stall every request for seconds.
 */
async function refreshLocalCopy(id: string, source: string) {
  const row = db.get<{ cached: string | null }>('SELECT cached FROM images WHERE id = ?', id);
  if (!row?.cached) return;
  const cached = row.cached;
  try {
    const [src, copy] = await Promise.all([fs.promises.stat(source), fs.promises.stat(cached)]);
    if (src.mtimeMs > copy.mtimeMs) {
      await fs.promises.rm(cached, { force: true });
      db.run('UPDATE images SET cached = NULL WHERE id = ? AND cached = ?', id, cached);
      const wDir = path.join(config.imageCacheDir, 'w');
      for (const f of (await fs.promises.readdir(wDir)).filter((f) => f.startsWith(id + '_'))) await fs.promises.rm(path.join(wDir, f), { force: true });
    }
  } catch {
    /* source gone or cache dir missing */
  }
}

/**
 * Register an image URL that came from third-party content (IPTV playlists, podcast feeds).
 * Only http(s) is accepted — never a local path — and `untrusted` images are fetched through the
 * SSRF guard (no private/loopback addresses).
 */
export function registerRemoteImage(url: string | null | undefined, opts: { untrusted?: boolean } = {}): string | null {
  if (!url || !/^https?:\/\//i.test(url.trim())) return null;
  const id = stableId('img', url.trim());
  db.run('INSERT OR IGNORE INTO images (id, source, created_at, untrusted) VALUES (?, ?, ?, ?)', id, url.trim(), nowIso(), opts.untrusted ? 1 : 0);
  if (opts.untrusted) db.run('UPDATE images SET untrusted = 1 WHERE id = ?', id);
  return id;
}

/** Async existence check: the image route runs for every card on screen, so it never blocks on the disk. */
const exists = (p: string) => fs.promises.access(p).then(() => true, () => false);

export const imageUrl = (id: string | null | undefined): string | null => (id ? `/api/v1/images/${id}` : null);

const inflight = new Map<string, Promise<string>>();

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.ico': 'image/x-icon', '.tbn': 'image/jpeg' };
export const mimeFor = (p: string) => MIME[path.extname(p).toLowerCase()] ?? 'image/jpeg';

async function fetchWithUserInfo(url: string): Promise<Response> {
  const { TunerHttp, splitUserInfo } = await import('./livetv/tuners/http.js');
  const p = splitUserInfo(url);
  return new TunerHttp({ username: p.username, password: p.password }).fetch(p.url, { timeoutMs: 20000 });
}

async function fetchRemote(id: string, url: string, untrusted: boolean): Promise<string> {
  const ext = (path.extname(new URL(url).pathname).toLowerCase().match(/^\.(jpe?g|png|webp|gif|avif)$/)?.[0]) ?? '.jpg';
  const dest = path.join(config.imageCacheDir, id.slice(0, 2), id + ext);
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const init = { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Kinora/1.0' } };
  // Tuner boxes (TVHeadend imagecache, OpenWebif picons) may need the device login: Basic or Digest, kept out of fetch's URL.
  const res = !untrusted && /^https?:\/\/[^/@]+@/i.test(url) ? await fetchWithUserInfo(url) : untrusted ? await safeFetch(url, init) : await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // Remote images must be raster images — never SVG/HTML (script on our origin).
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!type.startsWith('image/') || type.includes('svg')) throw new Error(`Not a raster image (${type || 'unknown type'})`);
  if (Number(res.headers.get('content-length') ?? 0) > 20 * 1024 * 1024) throw new Error('Image too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 20 * 1024 * 1024) throw new Error('Image too large');
  fs.writeFileSync(dest, buf);
  db.run('UPDATE images SET cached = ? WHERE id = ?', dest, id);
  return dest;
}

/**
 * At most this many ffmpeg resizes at once: a fresh poster grid asks for dozens of sizes in parallel, and one
 * ffmpeg per request (~50 MB each) would swamp a small NAS. Waiters queue in order.
 */
export const RESIZE_CONCURRENCY = Math.max(2, os.availableParallelism());
let resizing = 0;
const resizeQueue: (() => void)[] = [];
async function withResizeSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (resizing >= RESIZE_CONCURRENCY) await new Promise<void>((r) => resizeQueue.push(r));
  else resizing++;
  try {
    return await fn();
  } finally {
    // Hand the slot straight to the next waiter (the count stays the same), or free it.
    const next = resizeQueue.shift();
    if (next) next();
    else resizing--;
  }
}
/** Tests only. */
export const _resizeStats = () => ({ running: resizing, queued: resizeQueue.length });

function resize(src: string, dest: string, width: number): Promise<void> {
  return withResizeSlot(() => runResize(src, dest, width));
}

function runResize(src: string, dest: string, width: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(config.ffmpeg, ['-v', 'error', '-y', '-i', src, '-vf', `scale='min(${width},iw)':-2`, '-frames:v', '1', ...(dest.endsWith('.png') ? ['-compression_level', '6'] : ['-q:v', '3']), dest]);
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

export async function resolveImage(id: string, width?: number): Promise<{ path: string; mime: string }> {
  await refreshing.get(id);
  const row = db.get('SELECT * FROM images WHERE id = ?', id);
  if (!row) throw notFound('Image not found');
  let file: string;
  if (/^https?:\/\//.test(row.source)) {
    if (row.cached && (await exists(row.cached))) file = row.cached;
    else {
      let p = inflight.get(id);
      if (!p) {
        p = fetchRemote(id, row.source, !!row.untrusted).finally(() => inflight.delete(id));
        inflight.set(id, p);
      }
      try {
        file = await p;
      } catch (e) {
        log.debug(`Remote image failed ${row.source}`, e);
        throw notFound('Image unavailable');
      }
    }
  } else if (row.cached && (await exists(row.cached))) {
    // Artwork next to the media (poster.jpg, folder.jpg…) is served from its copy in the data dir, so browsing
    // never wakes a sleeping NAS disk. The scanner refreshes the copy when the original changes.
    file = row.cached;
  } else {
    if (!isLocalImagePath(row.source)) throw notFound('Image file missing');
    file = await localArtwork(id, row.source);
  }
  const ext = path.extname(file).toLowerCase();
  if (ext === '.svg') throw notFound('Image unavailable');
  if (width && width > 0 && width < 3000 && ext !== '.gif') {
    const w = Math.ceil(width / 80) * 80; // bucket sizes to keep cache small
    // Keep transparency: PNG/WebP sources (clear logos, channel logos) are resized to PNG, everything else to JPEG.
    const alpha = ext === '.png' || ext === '.webp';
    const dest = path.join(config.imageCacheDir, 'w', `${id}_${w}.${alpha ? 'png' : 'jpg'}`);
    if (!(await exists(dest))) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const key = dest;
      let p = inflight.get(key) as Promise<any> | undefined;
      if (!p) {
        p = resize(file, dest, w).finally(() => inflight.delete(key));
        inflight.set(key, p);
      }
      try {
        await p;
      } catch {
        return { path: file, mime: mimeFor(file) };
      }
    }
    return { path: dest, mime: alpha ? 'image/png' : 'image/jpeg' };
  }
  return { path: file, mime: mimeFor(file) };
}

export function pruneImageCache(maxAgeDays = 60) {
  const cutoff = Date.now() - maxAgeDays * 86400000;
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (fs.statSync(p).atimeMs < cutoff) fs.rmSync(p, { force: true });
    }
  };
  walk(path.join(config.imageCacheDir, 'w'));
}
