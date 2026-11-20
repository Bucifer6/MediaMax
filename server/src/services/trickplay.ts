import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { TrickplayInfo } from '@mediamax/shared';
import { db } from '../db.js';
import { config } from '../config.js';
import { getSettings } from './settings.js';
import { logger } from '../util/log.js';

const log = logger('trickplay');
const COLS = 10;
const ROWS = 10;

interface Manifest {
  intervalMs: number;
  width: number;
  height: number;
  columns: number;
  rows: number;
  count: number;
  sheets: number;
  mtime: number;
}

const dirFor = (mediaId: string) => path.join(config.dataDir, 'trickplay', mediaId);

function readManifest(mediaId: string): Manifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dirFor(mediaId), 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function trickplayInfo(mediaId: string, token: string): TrickplayInfo | null {
  const m = readManifest(mediaId);
  if (!m) return null;
  const q = `?token=${encodeURIComponent(token)}`;
  return {
    mediaId, intervalMs: m.intervalMs, width: m.width, height: m.height, columns: m.columns, rows: m.rows, count: m.count,
    sheets: Array.from({ length: m.sheets }, (_, i) => `/api/v1/trickplay/${mediaId}/${i}.jpg${q}`),
  };
}

export function sheetPath(mediaId: string, n: number): string | null {
  const p = path.join(dirFor(mediaId), `${n}.jpg`);
  return fs.existsSync(p) ? p : null;
}

/** Generate sprite sheets for one media file. Uses keyframe-only decoding so it is fast even for 4K. */
export function generate(mediaId: string, file: string, durationMs: number, width: number, height: number | null, mtime: number): Promise<boolean> {
  const s = getSettings().trickplay;
  const interval = Math.max(2, s.intervalSeconds);
  const w = Math.max(120, Math.min(480, s.width));
  const h = height && width ? Math.round(((height / (width || 1)) * w) / 2) * 2 : Math.round((w * 9) / 16 / 2) * 2;
  const dir = dirFor(mediaId);
  const tmp = dir + '.tmp';
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-skip_frame', 'nokey', '-i', file, '-an', '-sn',
    '-vf', `fps=1/${interval},scale=${w}:${h},tile=${COLS}x${ROWS}`, '-fps_mode', 'vfr', '-q:v', '5', path.join(tmp, '%d.jpg')];
  return new Promise((resolve) => {
    const p = spawn(config.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err = (err + d).slice(-1000)));
    p.on('error', () => resolve(false));
    p.on('exit', (code) => {
      const files = fs.existsSync(tmp) ? fs.readdirSync(tmp).filter((f) => f.endsWith('.jpg')) : [];
      if (code !== 0 || !files.length) {
        log.debug(`Trickplay failed for ${file}: ${err.trim()}`);
        fs.rmSync(tmp, { recursive: true, force: true });
        return resolve(false);
      }
      // ffmpeg numbers from 1; rename to 0-based.
      for (const f of files) fs.renameSync(path.join(tmp, f), path.join(tmp, `${parseInt(f, 10) - 1}.jpg.tmp`));
      for (const f of fs.readdirSync(tmp)) fs.renameSync(path.join(tmp, f), path.join(tmp, f.replace(/\.tmp$/, '')));
      const count = Math.floor(durationMs / 1000 / interval) + 1;
      const manifest: Manifest = { intervalMs: interval * 1000, width: w, height: h, columns: COLS, rows: ROWS, count, sheets: files.length, mtime };
      fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest));
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(tmp, dir);
      resolve(true);
    });
  });
}

/** Background task: generate for every local video missing (or with stale) thumbnails. */
export async function generateMissing(progress: (p: number) => void, limit = 500): Promise<number> {
  if (!getSettings().trickplay.enabled) return 0;
  const rows = db.all(`SELECT m.id, m.path, m.duration_ms, m.width, m.height, m.mtime FROM media m JOIN items i ON i.id = m.item_id
    WHERE m.path IS NOT NULL AND m.video_codec IS NOT NULL AND m.duration_ms > 60000 AND i.type IN ('movie','episode','video') ORDER BY i.added_at DESC`);
  const todo = rows.filter((r) => {
    const m = readManifest(r.id);
    return !m || m.mtime !== r.mtime || m.intervalMs !== getSettings().trickplay.intervalSeconds * 1000;
  }).slice(0, limit);
  let done = 0;
  for (let i = 0; i < todo.length; i++) {
    const r = todo[i];
    if (await generate(r.id, r.path, r.duration_ms, r.width, r.height, r.mtime)) done++;
    progress(Math.round(((i + 1) / todo.length) * 100));
  }
  // Remove thumbnails for media that no longer exist.
  const root = path.join(config.dataDir, 'trickplay');
  if (fs.existsSync(root)) {
    const ids = new Set(rows.map((r) => r.id));
    for (const d of fs.readdirSync(root)) if (!ids.has(d.replace(/\.tmp$/, ''))) fs.rmSync(path.join(root, d), { recursive: true, force: true });
  }
  return done;
}
