import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { db } from '../db.js';
import { config } from '../config.js';
import { stableId } from '../util/ids.js';
import { nowIso } from '../util/misc.js';
import { notFound } from '../util/errors.js';
import { logger } from '../util/log.js';
import { safeFetch } from '../util/net.js';

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
  return id;
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

export const imageUrl = (id: string | null | undefined): string | null => (id ? `/api/v1/images/${id}` : null);

const inflight = new Map<string, Promise<string>>();

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.ico': 'image/x-icon', '.tbn': 'image/jpeg' };
export const mimeFor = (p: string) => MIME[path.extname(p).toLowerCase()] ?? 'image/jpeg';

async function fetchRemote(id: string, url: string, untrusted: boolean): Promise<string> {
  const ext = (path.extname(new URL(url).pathname).toLowerCase().match(/^\.(jpe?g|png|webp|gif|avif)$/)?.[0]) ?? '.jpg';
  const dest = path.join(config.imageCacheDir, id.slice(0, 2), id + ext);
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const init = { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'MediaMax/1.0' } };
  const res = untrusted ? await safeFetch(url, init) : await fetch(url, init);
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

function resize(src: string, dest: string, width: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(config.ffmpeg, ['-v', 'error', '-y', '-i', src, '-vf', `scale='min(${width},iw)':-2`, '-frames:v', '1', '-q:v', '3', dest]);
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

export async function resolveImage(id: string, width?: number): Promise<{ path: string; mime: string }> {
  const row = db.get('SELECT * FROM images WHERE id = ?', id);
  if (!row) throw notFound('Image not found');
  let file: string;
  if (/^https?:\/\//.test(row.source)) {
    if (row.cached && fs.existsSync(row.cached)) file = row.cached;
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
  } else {
    file = row.source;
    if (!isLocalImagePath(file) || !fs.existsSync(file)) throw notFound('Image file missing');
  }
  const ext = path.extname(file).toLowerCase();
  if (ext === '.svg') throw notFound('Image unavailable');
  if (width && width > 0 && width < 3000 && ext !== '.gif') {
    const w = Math.ceil(width / 80) * 80; // bucket sizes to keep cache small
    const dest = path.join(config.imageCacheDir, 'w', `${id}_${w}.jpg`);
    if (!fs.existsSync(dest)) {
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
    return { path: dest, mime: 'image/jpeg' };
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
