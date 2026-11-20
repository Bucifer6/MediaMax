import { spawn } from 'node:child_process';
import type { TrackAnalysis } from '@mediamax/shared';
import { db } from '../../db.js';
import { config } from '../../config.js';
import { logger } from '../../util/log.js';
import { nowIso } from '../../util/misc.js';
import { chroma, energyScore, estimateKey, estimateTempo, loudness, mixPoints, onsetEnvelope } from './dsp.js';

const log = logger('dj');
/** Bump when the algorithm changes so tracks are re-analysed. */
export const ANALYSIS_VERSION = 1;
const RATE = 11025;
/** Longest stretch decoded per track (long DJ sets/podcasts are capped). */
const MAX_SECONDS = 15 * 60;

/** Decode a file to mono float PCM at 11025 Hz. */
export function decodePcm(file: string, maxSeconds = MAX_SECONDS): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const p = spawn(config.ffmpeg, ['-v', 'error', '-nostdin', '-i', file, '-t', String(maxSeconds), '-map', '0:a:0', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  return {
    bpm: tempo.bpm, bpmConfidence: tempo.confidence, beatOffsetMs: tempo.beatOffsetMs != null ? tempo.beatOffsetMs + 90 : null, key: key.key, camelot: key.camelot,
    energy: energyScore(l.meanDb, env, fps), loudnessDb: Math.round(l.meanDb * 10) / 10, durationMs: dur, ...points,
  };
}

const toAnalysis = (r: any): TrackAnalysis => ({
  itemId: r.item_id, bpm: r.bpm, bpmConfidence: r.bpm_confidence, beatOffsetMs: r.beat_offset_ms, key: r.key_name, camelot: r.camelot, energy: r.energy,
  loudnessDb: r.loudness_db, cueInMs: r.cue_in_ms, cueOutMs: r.cue_out_ms, introEndMs: r.intro_end_ms, outroStartMs: r.outro_start_ms,
  durationMs: r.duration_ms, analyzedAt: r.analyzed_at,
});

export function getAnalysis(itemId: string): TrackAnalysis | null {
  const r = db.get('SELECT * FROM track_analysis WHERE item_id = ? AND error IS NULL', itemId);
  return r ? toAnalysis(r) : null;
}

export function getAnalyses(ids: string[]): Map<string, TrackAnalysis> {
  const out = new Map<string, TrackAnalysis>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of db.all(`SELECT * FROM track_analysis WHERE error IS NULL AND item_id IN (${chunk.map(() => '?').join(',')})`, ...chunk)) out.set(r.item_id, toAnalysis(r));
  }
  return out;
}

/** Analyse one track (by item id) and store the result. */
export async function analyseTrack(itemId: string): Promise<TrackAnalysis | null> {
  const m = db.get<{ path: string; mtime: number; duration_ms: number | null }>("SELECT m.path, m.mtime, m.duration_ms FROM media m JOIN items i ON i.id = m.item_id WHERE i.id = ? AND i.type = 'track' AND m.path IS NOT NULL LIMIT 1", itemId);
  if (!m) return null;
  try {
    const pcm = await decodePcm(m.path);
    if (pcm.length < RATE * 5) throw new Error('Too short to analyse');
    const a = analysePcm(pcm, m.duration_ms ?? undefined);
    db.run(
      `INSERT OR REPLACE INTO track_analysis (item_id, media_mtime, version, bpm, bpm_confidence, beat_offset_ms, key_name, camelot, energy, loudness_db, cue_in_ms, cue_out_ms, intro_end_ms, outro_start_ms, duration_ms, analyzed_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      itemId, m.mtime, ANALYSIS_VERSION, a.bpm, a.bpmConfidence, a.beatOffsetMs, a.key, a.camelot, a.energy, a.loudnessDb, a.cueInMs, a.cueOutMs, a.introEndMs, a.outroStartMs, a.durationMs, nowIso(),
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

let running = false;
export const analysisRunning = () => running;

export function analysisStatus() {
  const total = db.get<{ n: number }>("SELECT COUNT(*) n FROM items i WHERE i.type = 'track' AND EXISTS (SELECT 1 FROM media m WHERE m.item_id = i.id AND m.path IS NOT NULL)")?.n ?? 0;
  const pending = db.get<{ n: number }>(`SELECT COUNT(DISTINCT i.id) n ${PENDING_SQL}`)?.n ?? 0;
  return { analyzed: Math.max(0, total - pending), total, running };
}

/** Analyse every new/changed track (two at a time). */
export async function analyseAll(onProgress?: (p: number) => void, limit = Infinity): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const ids = db.all<{ id: string }>(`SELECT DISTINCT i.id ${PENDING_SQL} ORDER BY i.added_at DESC`).map((r) => r.id).slice(0, limit === Infinity ? undefined : limit);
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
