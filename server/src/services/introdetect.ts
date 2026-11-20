import { spawn } from 'node:child_process';
import type { Marker } from '@mediamax/shared';
import { db } from '../db.js';
import { config } from '../config.js';
import { parseJson } from '../util/misc.js';
import { logger } from '../util/log.js';

const log = logger('introdetect');

/** Seconds of audio represented by one chromaprint point. */
const POINT_SEC = 0.1238;
const MAX_BIT_ERRORS = 8;
const MIN_INTRO_SEC = 15;
const MAX_INTRO_SEC = 150;
const SCAN_INTRO_SEC = 600;
const SCAN_CREDITS_SEC = 420;

export function fingerprint(file: string, startSec: number, durationSec: number): Promise<Uint32Array> {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (startSec > 0) args.push('-ss', String(startSec));
    args.push('-t', String(durationSec), '-i', file, '-vn', '-ac', '1', '-ar', '11025', '-f', 'chromaprint', '-fp_format', 'raw', '-');
    const p = spawn(config.ffmpeg, args);
    const chunks: Buffer[] = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('error', reject);
    p.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`chromaprint failed (${code})`));
      const buf = Buffer.concat(chunks);
      const arr = new Uint32Array(Math.floor(buf.length / 4));
      for (let i = 0; i < arr.length; i++) arr[i] = buf.readUInt32LE(i * 4);
      resolve(arr);
    });
  });
}

function popcount(x: number) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * Find the longest shared region between two fingerprints.
 * Uses an inverted index to vote for candidate alignments, then scans each
 * candidate for the longest run of near-identical points.
 */
export function findSharedRegion(a: Uint32Array, b: Uint32Array): { aStart: number; aEnd: number; bStart: number; bEnd: number } | null {
  const index = new Map<number, number[]>();
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    const list = index.get(k);
    if (list) list.push(i);
    else index.set(k, [i]);
  }
  const votes = new Map<number, number>();
  for (let j = 0; j < b.length; j++) {
    const list = index.get(b[j]);
    if (!list) continue;
    for (const i of list) votes.set(i - j, (votes.get(i - j) ?? 0) + 1);
  }
  const candidates = [...votes.entries()].filter(([, n]) => n >= 3).sort((x, y) => y[1] - x[1]).slice(0, 12).map(([off]) => off);
  let best: { aStart: number; aEnd: number; bStart: number; bEnd: number } | null = null;
  const gapTolerance = Math.round(1.0 / POINT_SEC); // allow ~1s of noise inside a match
  for (const off of candidates) {
    const startJ = Math.max(0, -off);
    const endJ = Math.min(b.length, a.length - off);
    let runStart = -1;
    let lastGood = -1;
    for (let j = startJ; j < endJ; j++) {
      const good = popcount(a[j + off] ^ b[j]) <= MAX_BIT_ERRORS;
      if (good) {
        if (runStart < 0) runStart = j;
        lastGood = j;
      }
      if (runStart >= 0 && (!good && j - lastGood > gapTolerance || j === endJ - 1)) {
        const len = lastGood - runStart + 1;
        if (!best || len > best.bEnd - best.bStart) best = { aStart: runStart + off, aEnd: lastGood + off + 1, bStart: runStart, bEnd: lastGood + 1 };
        runStart = -1;
      }
    }
  }
  if (!best) return null;
  const sec = (best.bEnd - best.bStart) * POINT_SEC;
  return sec >= MIN_INTRO_SEC ? best : null;
}

interface Ep {
  id: string;
  path: string;
  durationSec: number;
  markers: Marker[];
}

/** Detect intro and credits markers for every episode in a season. */
export async function detectSeason(seasonId: string, force = false): Promise<number> {
  const rows = db.all(
    `SELECT i.id, i.markers, m.path, m.duration_ms FROM items i JOIN media m ON m.item_id = i.id
     WHERE i.parent_id = ? AND i.type = 'episode' AND m.path IS NOT NULL GROUP BY i.id ORDER BY i.idx`, seasonId);
  const eps: Ep[] = rows.map((r) => ({ id: r.id, path: r.path, durationSec: (r.duration_ms ?? 0) / 1000, markers: parseJson<Marker[]>(r.markers, []) }));
  const todo = force ? eps : eps.filter((e) => !e.markers.some((m) => m.type === 'intro'));
  if (eps.length < 2 || !todo.length) return 0;
  const intros = new Map<string, Uint32Array>();
  const credits = new Map<string, Uint32Array>();
  for (const e of eps) {
    try {
      intros.set(e.id, await fingerprint(e.path, 0, Math.min(SCAN_INTRO_SEC, e.durationSec * 0.4 || SCAN_INTRO_SEC)));
      if (e.durationSec > 900) credits.set(e.id, await fingerprint(e.path, Math.max(0, e.durationSec - SCAN_CREDITS_SEC), SCAN_CREDITS_SEC));
    } catch (err) {
      log.debug(`Fingerprint failed for ${e.path}: ${(err as Error).message}`);
    }
  }
  let updated = 0;
  for (const e of todo) {
    const fa = intros.get(e.id);
    if (!fa) continue;
    const markers = e.markers.filter((m) => (force ? m.type !== 'intro' && m.type !== 'credits' : true));
    // Compare with up to 3 neighbours, keep the best (longest plausible) match.
    const others = eps.filter((o) => o.id !== e.id && intros.has(o.id)).slice(0, 4);
    let intro: { start: number; end: number } | null = null;
    for (const o of others) {
      const r = findSharedRegion(fa, intros.get(o.id)!);
      if (!r) continue;
      const start = r.aStart * POINT_SEC;
      const end = r.aEnd * POINT_SEC;
      if (end - start > MAX_INTRO_SEC) continue;
      if (!intro || end - start > intro.end - intro.start) intro = { start, end };
    }
    if (intro && !markers.some((m) => m.type === 'intro')) {
      markers.push({ type: 'intro', startMs: Math.round((intro.start < 3 ? 0 : intro.start) * 1000), endMs: Math.round(intro.end * 1000) });
    }
    const ca = credits.get(e.id);
    if (ca && !markers.some((m) => m.type === 'credits')) {
      let cred: { start: number } | null = null;
      for (const o of eps.filter((x) => x.id !== e.id && credits.has(x.id)).slice(0, 3)) {
        const r = findSharedRegion(ca, credits.get(o.id)!);
        if (!r) continue;
        const start = Math.max(0, e.durationSec - SCAN_CREDITS_SEC) + r.aStart * POINT_SEC;
        if (!cred || start < cred.start) cred = { start };
      }
      if (cred) markers.push({ type: 'credits', startMs: Math.round(cred.start * 1000), endMs: Math.round(e.durationSec * 1000) });
    }
    if (markers.length !== e.markers.length || force) {
      db.run('UPDATE items SET markers = ? WHERE id = ?', JSON.stringify(markers), e.id);
      updated++;
    }
  }
  return updated;
}

export async function detectAll(onProgress?: (p: number) => void, filter?: (mediaPath: string) => boolean): Promise<number> {
  const all = db.all<{ id: string; path: string | null }>(
    `SELECT s.id, (SELECT m.path FROM items e JOIN media m ON m.item_id = e.id WHERE e.parent_id = s.id AND m.path IS NOT NULL LIMIT 1) path FROM items s WHERE s.type = 'season' AND EXISTS (SELECT 1 FROM items e JOIN media m ON m.item_id = e.id WHERE e.parent_id = s.id AND m.path IS NOT NULL
       AND (e.markers = '[]' OR e.markers NOT LIKE '%intro%'))`);
  // Optional disk filter (disk-friendly mode runs one disk's share at a time).
  const seasons = filter ? all.filter((x) => x.path && filter(x.path)) : all;
  let total = 0;
  for (let i = 0; i < seasons.length; i++) {
    try {
      total += await detectSeason(seasons[i].id);
    } catch (e) {
      log.warn(`Intro detection failed for season ${seasons[i].id}`, (e as Error).message);
    }
    onProgress?.(Math.round(((i + 1) / seasons.length) * 100));
  }
  return total;
}
