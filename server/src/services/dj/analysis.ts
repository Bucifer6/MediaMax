import { spawn } from 'node:child_process';
import os from 'node:os';
import type { TrackAnalysis } from '@mediamax/shared';
import { db } from '../../db.js';
import { config } from '../../config.js';
import { logger } from '../../util/log.js';
import { nowIso } from '../../util/misc.js';
import { chroma, energyScore, estimateKey, estimateTempo, loudness, mixPoints, onsetEnvelope, timbre } from './dsp.js';
import { detectPhrases, trackCues } from './phrases.js';

const log = logger('dj');
/**
 * Bump when the algorithm changes so tracks are re-analysed. Older analyses stay usable until then: they are
 * upgraded lazily (on demand when a mix uses them, plus a throttled batch per background run), never all at once.
 * v3: phrase structure + downbeat.
 */
export const ANALYSIS_VERSION = 3;
/** Background runs re-analyse at most this many outdated (but still usable) tracks; new/changed files are not capped. */
export const UPGRADE_PER_RUN = 150;

/** Columns added after the original table (added in place so no schema migration number is needed). */
let columnsReady = false;
export function ensureAnalysisColumns() {
  if (columnsReady) return;
  const have = new Set(db.all<{ name: string }>('PRAGMA table_info(track_analysis)').map((c) => c.name));
  if (!have.has('phrases')) db.exec('ALTER TABLE track_analysis ADD COLUMN phrases TEXT');
  if (!have.has('downbeat_ms')) db.exec('ALTER TABLE track_analysis ADD COLUMN downbeat_ms INTEGER');
  columnsReady = true;
}
const RATE = 11025;
/** Longest stretch decoded per track (long DJ sets/podcasts are capped). */
const MAX_SECONDS = 15 * 60;

/** Decode a file to mono float PCM at 11025 Hz. */
export function decodePcm(file: string, maxSeconds = MAX_SECONDS): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const p = spawn(config.ffmpeg, ['-v', 'error', '-nostdin', '-threads', '1', '-i', file, '-t', String(maxSeconds), '-map', '0:a:0', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    // Background work: decode at low CPU priority so playback and transcodes on a small NAS come first.
    try {
      if (p.pid) os.setPriority(p.pid, os.constants.priority.PRIORITY_LOW);
    } catch {
      /* not permitted on this platform */
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let err = '';
    p.stdout.on('data', (c: Buffer) => {
      chunks.push(c);
      size += c.length;
    });
    p.stderr.on('data', (d) => (err = (err + d).slice(-500)));
    const t = setTimeout(() => p.kill('SIGKILL'), 120000);
    p.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0 && !size) return reject(new Error(err.trim() || `ffmpeg exited with ${code}`));
      const buf = Buffer.concat(chunks, size);
      const aligned = new Uint8Array(buf.length - (buf.length % 4));
      aligned.set(buf.subarray(0, aligned.length));
      resolve(new Float32Array(aligned.buffer));
    });
  });
}

/** Run the full analysis on PCM (exported for tests). */
export function analysePcm(pcm: Float32Array, durationMs?: number) {
  const dur = durationMs ?? Math.round((pcm.length / RATE) * 1000);
  const l = loudness(pcm, RATE);
  const { env, fps } = onsetEnvelope(pcm, RATE);
  const tempo = estimateTempo(env, fps);
  const key = estimateKey(chroma(pcm, RATE));
  const points = mixPoints(l, Math.min(dur, Math.round((pcm.length / RATE) * 1000)));
  // Tracks longer than the decoded window: the real ending lies beyond what we heard.
  if (dur > (pcm.length / RATE) * 1000 + 2000) {
    points.cueOutMs = dur;
    points.outroStartMs = null;
  }
  const beatOffsetMs = tempo.beatOffsetMs != null ? tempo.beatOffsetMs + 90 : null;
  const structure = tempo.bpm && beatOffsetMs != null
    ? detectPhrases(pcm, RATE, tempo.bpm, beatOffsetMs, { startMs: points.cueInMs, endMs: Math.min(points.cueOutMs, Math.round((pcm.length / RATE) * 1000)) })
    : { phrases: [], downbeatMs: null as number | null };
  return {
    bpm: tempo.bpm, bpmConfidence: tempo.confidence, beatOffsetMs, key: key.key, camelot: key.camelot,
    energy: energyScore(l.meanDb, env, fps), timbre: timbre(pcm, RATE), loudnessDb: Math.round(l.meanDb * 10) / 10, durationMs: dur, ...points,
    downbeatMs: structure.downbeatMs, phrases: structure.phrases.length ? structure.phrases : null,
  };
}

const toAnalysis = (r: any): TrackAnalysis => {
  const a: TrackAnalysis = {
    itemId: r.item_id, bpm: r.bpm, bpmConfidence: r.bpm_confidence, beatOffsetMs: r.beat_offset_ms, key: r.key_name, camelot: r.camelot, energy: r.energy,
    loudnessDb: r.loudness_db, cueInMs: r.cue_in_ms, cueOutMs: r.cue_out_ms, introEndMs: r.intro_end_ms, outroStartMs: r.outro_start_ms,
    durationMs: r.duration_ms, analyzedAt: r.analyzed_at, timbre: r.timbre ? JSON.parse(r.timbre) : null,
    downbeatMs: r.downbeat_ms ?? null, phrases: r.phrases ? JSON.parse(r.phrases) : null,
  };
  a.cues = trackCues(a);
  return a;
};

/** The few analysis fields mix ordering scores on (no phrases), for whole-library candidate lists. */
export interface MixFeatures {
  bpm: number | null;
  bpmConfidence: number;
  camelot: string | null;
  energy: number;
  timbre: number[] | null;
}

export function getMixFeatures(ids: string[]): Map<string, MixFeatures> {
  const out = new Map<string, MixFeatures>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of db.all<{ item_id: string; bpm: number | null; bpm_confidence: number; camelot: string | null; energy: number; timbre: string | null }>(
      `SELECT item_id, bpm, bpm_confidence, camelot, energy, timbre FROM track_analysis WHERE error IS NULL AND item_id IN (${chunk.map(() => '?').join(',')})`, ...chunk)) {
      out.set(r.item_id, { bpm: r.bpm, bpmConfidence: r.bpm_confidence, camelot: r.camelot, energy: r.energy, timbre: r.timbre ? JSON.parse(r.timbre) : null });
    }
  }
  return out;
}

/** True when a stored analysis predates the current algorithm (still usable, upgraded lazily). */
export function analysisOutdated(itemId: string): boolean {
  const r = db.get<{ version: number }>('SELECT version FROM track_analysis WHERE item_id = ? AND error IS NULL', itemId);
  return !!r && r.version < ANALYSIS_VERSION;
}

export function getAnalysis(itemId: string): TrackAnalysis | null {
  ensureAnalysisColumns();
  const r = db.get('SELECT * FROM track_analysis WHERE item_id = ? AND error IS NULL', itemId);
  return r ? toAnalysis(r) : null;
}

export function getAnalyses(ids: string[]): Map<string, TrackAnalysis> {
  ensureAnalysisColumns();
  const out = new Map<string, TrackAnalysis>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of db.all(`SELECT * FROM track_analysis WHERE error IS NULL AND item_id IN (${chunk.map(() => '?').join(',')})`, ...chunk)) out.set(r.item_id, toAnalysis(r));
  }
  return out;
}

/** True when the last attempt on the current file failed (undecodable, too short): not retried until the file changes. */
export function analysisFailed(itemId: string): boolean {
  const r = db.get<{ ok: number }>(
    `SELECT 1 ok FROM track_analysis a JOIN media m ON m.item_id = a.item_id WHERE a.item_id = ? AND a.error IS NOT NULL AND a.version >= ? AND a.media_mtime IS m.mtime LIMIT 1`,
    itemId, ANALYSIS_VERSION);
  return !!r;
}

/** On-demand analyses (API requests): one per track at a time, at most this many decodes in parallel. */
const ON_DEMAND_SLOTS = 2;
const inflight = new Map<string, Promise<TrackAnalysis | null>>();
let activeOnDemand = 0;
const slotWaiters: (() => void)[] = [];

/**
 * Analyse a track for an API request: the stored analysis when it is current, else analyse it now (deduplicated
 * per track and throttled). Null when it cannot be analysed (not a local file, undecodable, shorter than 5 s).
 */
export async function analyseOnDemand(itemId: string): Promise<TrackAnalysis | null> {
  const have = getAnalysis(itemId);
  if (have && !analysisOutdated(itemId) && !analysisStale(itemId)) return have;
  if (!have && analysisFailed(itemId)) return null;
  let p = inflight.get(itemId);
  if (!p) {
    p = (async () => {
      if (activeOnDemand >= ON_DEMAND_SLOTS) await new Promise<void>((r) => slotWaiters.push(r));
      activeOnDemand++;
      try {
        return (await analyseTrack(itemId)) ?? getAnalysis(itemId);
      } finally {
        activeOnDemand--;
        slotWaiters.shift()?.();
        inflight.delete(itemId);
      }
    })();
    inflight.set(itemId, p);
  }
  return p;
}

/** True when the file changed since it was analysed. */
function analysisStale(itemId: string): boolean {
  return !!db.get(`SELECT 1 FROM track_analysis a JOIN media m ON m.item_id = a.item_id WHERE a.item_id = ? AND a.media_mtime IS NOT m.mtime LIMIT 1`, itemId);
}

/** Analyse one track (by item id) and store the result. */
export async function analyseTrack(itemId: string): Promise<TrackAnalysis | null> {
  const m = db.get<{ path: string; mtime: number; duration_ms: number | null }>("SELECT m.path, m.mtime, m.duration_ms FROM media m JOIN items i ON i.id = m.item_id WHERE i.id = ? AND i.type = 'track' AND m.path IS NOT NULL LIMIT 1", itemId);
  if (!m) return null;
  ensureAnalysisColumns();
  try {
    const pcm = await decodePcm(m.path);
    if (pcm.length < RATE * 5) throw new Error('Too short to analyse');
    await new Promise((r) => setImmediate(r)); // let pending requests run before the (synchronous) DSP
    const a = analysePcm(pcm, m.duration_ms ?? undefined);
    db.run(
      `INSERT OR REPLACE INTO track_analysis (item_id, media_mtime, version, bpm, bpm_confidence, beat_offset_ms, key_name, camelot, energy, loudness_db, cue_in_ms, cue_out_ms, intro_end_ms, outro_start_ms, duration_ms, analyzed_at, timbre, phrases, downbeat_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      itemId, m.mtime, ANALYSIS_VERSION, a.bpm, a.bpmConfidence, a.beatOffsetMs, a.key, a.camelot, a.energy, a.loudnessDb, a.cueInMs, a.cueOutMs, a.introEndMs, a.outroStartMs, a.durationMs, nowIso(), a.timbre ? JSON.stringify(a.timbre) : null,
      a.phrases ? JSON.stringify(a.phrases) : null, a.downbeatMs,
    );
    return getAnalysis(itemId);
  } catch (e) {
    db.run(
      "INSERT OR REPLACE INTO track_analysis (item_id, media_mtime, version, analyzed_at, error) VALUES (?, ?, ?, ?, ?)",
      itemId, m.mtime, ANALYSIS_VERSION, nowIso(), (e as Error).message.slice(0, 300),
    );
    log.warn(`Analysis failed for ${m.path}: ${(e as Error).message}`);
    return null;
  }
}

const PENDING_SQL = `FROM items i JOIN media m ON m.item_id = i.id
  LEFT JOIN track_analysis a ON a.item_id = i.id
  WHERE i.type = 'track' AND m.path IS NOT NULL AND (a.item_id IS NULL OR a.version < ${ANALYSIS_VERSION} OR a.media_mtime IS NOT m.mtime)`;
/** Pending because the file is new or changed (not just an older algorithm version). Failed attempts are not retried until the file changes. */
const NEEDS_FULL = `(a.item_id IS NULL OR a.media_mtime IS NOT m.mtime)`;

let running = false;

export function analysisStatus() {
  const total = db.get<{ n: number }>("SELECT COUNT(*) n FROM items i WHERE i.type = 'track' AND EXISTS (SELECT 1 FROM media m WHERE m.item_id = i.id AND m.path IS NOT NULL)")?.n ?? 0;
  // Outdated-but-usable analyses count as analysed (they are upgraded lazily).
  const pending = db.get<{ n: number }>(`SELECT COUNT(DISTINCT i.id) n ${PENDING_SQL} AND ${NEEDS_FULL}`)?.n ?? 0;
  return { analyzed: Math.max(0, total - pending), total, running };
}

/** Analyse every new/changed track (two at a time). */
export async function analyseAll(onProgress?: (p: number) => void, limit = Infinity, filter?: (mediaPath: string) => boolean, upgradeCap = UPGRADE_PER_RUN): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    // New/changed files first and uncapped; tracks that only have an older-version analysis are upgraded a
    // batch at a time so a version bump never re-analyses the whole library in one go.
    const rows = db.all<{ id: string; path: string; needs_full: number }>(`SELECT i.id, MIN(m.path) path, MAX(${NEEDS_FULL}) needs_full ${PENDING_SQL} GROUP BY i.id ORDER BY needs_full DESC, i.added_at DESC`)
      .filter((r) => !filter || filter(r.path));
    const fresh = rows.filter((r) => r.needs_full).map((r) => r.id);
    const upgrades = rows.filter((r) => !r.needs_full).map((r) => r.id).slice(0, upgradeCap);
    const ids = [...fresh, ...upgrades].slice(0, limit === Infinity ? undefined : limit);
    let done = 0;
    const queue = [...ids];
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        await analyseTrack(id);
        onProgress?.(Math.round((++done / ids.length) * 100));
      }
    };
    await Promise.all([worker(), worker()]);
    if (ids.length) log.info(`Analysed ${ids.length} track(s) for DJ mode`);
    return ids.length;
  } finally {
    running = false;
  }
}

/** Upgrade outdated analyses of tracks a mix is about to use, one at a time in the background (fire-and-forget). */
const upgradeQueue = new Set<string>();
let upgrading = false;
export function upgradeLazily(ids: string[], max = 8) {
  ensureAnalysisColumns();
  for (const id of ids) {
    if (upgradeQueue.size >= 200) break;
    if (analysisOutdated(id)) upgradeQueue.add(id);
    if (--max <= 0) break;
  }
  if (upgrading || !upgradeQueue.size) return;
  upgrading = true;
  void (async () => {
    try {
      for (const id of upgradeQueue) {
        upgradeQueue.delete(id);
        if (running) break; // the background task is on it
        await analyseTrack(id);
      }
    } finally {
      upgrading = false;
    }
  })();
}
