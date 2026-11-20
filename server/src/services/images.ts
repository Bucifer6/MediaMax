import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { db } from '../db.js';
import { config } from '../config.js';
import { stableId } from '../util/ids.js';
import { nowIso } from '../util/misc.js';
import { notFound } from '../util/errors.js';
import { logger } from '../util/log.js';

const log = logger('images');

/**
 * Images are registered by source (absolute local path or http(s) URL) and
 * exposed as `/api/v1/images/:id`. Remote images are fetched once and cached;
 * resized variants (`?w=`) are produced with ffmpeg and cached too.
 */
export function registerImage(source: string | null | undefined): string | null {
  if (!source) return null;
  const id = stableId('img', source);
  db.run('INSERT OR IGNORE INTO images (id, source, created_at) VALUES (?, ?, ?)', id, source, nowIso());
  return id;
}

export const imageUrl = (id: string | null | undefined): string | null => (id ? `/api/v1/images/${id}` : null);

const inflight = new Map<string, Promise<string>>();

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.ico': 'image/x-icon', '.tbn': 'image/jpeg' };
export const mimeFor = (p: string) => MIME[path.extname(p).toLowerCase()] ?? 'image/jpeg';

async function fetchRemote(id: string, url: string): Promise<string> {
  const ext = (path.extname(new URL(url).pathname).toLowerCase().match(/^\.(jpe?g|png|webp|gif|svg|avif)$/)?.[0]) ?? '.jpg';
  const dest = path.join(config.imageCacheDir, id.slice(0, 2), id + ext);
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'MediaMax/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
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
        p = fetchRemote(id, row.source).finally(() => inflight.delete(id));
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
    if (!fs.existsSync(file)) throw notFound('Image file missing');
  }
  const ext = path.extname(file).toLowerCase();
  if (width && width > 0 && width < 3000 && ext !== '.svg' && ext !== '.gif') {
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
