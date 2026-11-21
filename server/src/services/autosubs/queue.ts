/**
 * "Generate missing subtitles": the job queue and pipeline for automatic (AI) subtitles.
 *
 * A subtitle provider of last resort: only media that still lacks a wanted language after the download task had its
 * chance (12 h after it was added, when download providers are set up) is queued. One job at a time, at low process
 * priority, only inside the admin's night window. Every step leaves files in <cache>/ai-subtitles/<job> (audio, chunk
 * plan, one JSON per transcribed chunk), so a job stopped at dawn or by a restart resumes where it was.
 *
 * Pipeline: pick the dialogue track → 16 kHz mono WAV → silences → chunks → whisper per chunk (offsets added) →
 * tidy cues → translate with the language model when the spoken language differs (or whisper's own translation when
 * English is wanted) → SRT → the subtitle clean-up step → saved like a download, labelled "Auto-generated (AI)".
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AudioStream, AutoSubtitleJob, AutoSubtitleSettings, AutoSubtitleStatus, SubtitleStream } from '@mediamax/shared';
import { db } from '../../db.js';
import { config } from '../../config.js';
import { newId } from '../../util/ids.js';
import { parseJson } from '../../util/misc.js';
import { logger } from '../../util/log.js';
import { getSettings } from '../settings.js';
import { normLang } from '../probe.js';
import { aiSettings, featureEnabled, llmAvailable } from '../ai/llm.js';
import { cleanSubtitle } from '../subtitleProviders/cleanup.js';
import { lang2 } from '../subtitleProviders/lang.js';
import { refreshMediaSubs, saveSubtitle, setProviderLabel } from '../subtitleProviders/storage.js';
import { activeProviders } from '../subtitleProviders/index.js';
import { assembleSrt, planChunks, tidyCues, type Chunk, type Cue, type Silence } from './srt.js';
import { cutChunk, detectSilences, extractAudio, pickAudioStream, wavDurationMs } from './audio.js';
import { downloadState, engineReport, transcriberFor, type Transcriber } from './engine.js';
import { translateCues } from './translate.js';

const log = logger('auto-subtitles');

export const AI_PROVIDER_ID = 'ai-whisper';
export const AI_LABEL = 'Auto-generated (AI)';
setProviderLabel(AI_PROVIDER_ID, AI_LABEL);

const workRoot = () => path.join(config.cacheDir, 'ai-subtitles');
const workDir = (jobId: string) => path.join(workRoot(), jobId.replace(/[^\w-]/g, '_'));

/** Is `now` inside the HH:MM window (server local time)? Windows may cross midnight; equal ends = always. */
export function inWindow(start: string, end: string, now = new Date()): boolean {
  const toMin = (s: string) => {
    const [h, m] = s.split(':').map(Number);
    return h * 60 + m;
  };
  const a = toMin(start);
  const b = toMin(end);
  if (a === b) return true;
  const t = now.getHours() * 60 + now.getMinutes();
  return a < b ? t >= a && t < b : t >= a || t < b;
}

const wantedLanguages = (s: AutoSubtitleSettings) => (s.languages.length ? s.languages : getSettings().subtitles?.languages ?? []).map((l) => lang2(l)).filter((l) => l !== 'und');

/* ------------------------------ queue ------------------------------ */

function rowToJob(r: Record<string, any>): AutoSubtitleJob {
  const title = r.type === 'episode' && r.show_title
    ? `${r.show_title} · S${String(r.parent_idx ?? 0).padStart(2, '0')}E${String(r.idx ?? 0).padStart(2, '0')} · ${r.title}`
    : `${r.title ?? '(removed)'}${r.year ? ` (${r.year})` : ''}`;
  return {
    id: r.id, itemId: r.item_id, mediaId: r.media_id, title, language: r.language, status: r.status, phase: r.phase ?? null,
    progress: r.progress ?? 0, etaSeconds: r.eta_s ?? null, spokenLanguage: r.spoken_language ?? null, translated: !!r.translated,
    cues: r.cues ?? null, error: r.error ?? null, createdAt: r.created_at, startedAt: r.started_at ?? null, finishedAt: r.finished_at ?? null,
  };
}

const JOB_SELECT = `SELECT j.*, i.title, i.year, i.type, i.idx, i.parent_idx, s.title show_title FROM ai_subtitle_jobs j
  LEFT JOIN items i ON i.id = j.item_id LEFT JOIN items s ON s.id = i.grandparent_id`;

export function getJob(id: string): AutoSubtitleJob | null {
  const r = db.get(`${JOB_SELECT} WHERE j.id = ?`, id);
  return r ? rowToJob(r) : null;
}

function updateJob(id: string, patch: Record<string, unknown>) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  db.run(`UPDATE ai_subtitle_jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => patch[k] as never), id);
}

/** Queue one item/language (admin "Generate with AI"). Re-queues a finished or failed job. */
export function enqueue(itemId: string, language: string, source: 'manual' | 'task' = 'manual'): AutoSubtitleJob {
  const media = db.get<{ id: string }>('SELECT id FROM media WHERE item_id = ? AND path IS NOT NULL ORDER BY COALESCE(width,0) DESC LIMIT 1', itemId);
  if (!media) throw new Error('This title has no local media file');
  const lang = lang2(language);
  if (!/^[a-z]{2}$/.test(lang)) throw new Error('Invalid language');
  const existing = db.get<{ id: string; status: string }>('SELECT id, status FROM ai_subtitle_jobs WHERE media_id = ? AND language = ?', media.id, lang);
  const priority = source === 'manual' ? 10 : 0;
  if (existing) {
    if (existing.status !== 'running') updateJob(existing.id, { status: 'queued', error: null, phase: null, priority: Math.max(priority, 0), finished_at: null, ...(existing.status !== 'queued' ? { progress: 0, eta_s: null } : {}) });
    return getJob(existing.id)!;
  }
  const id = newId();
  db.insert('ai_subtitle_jobs', { id, item_id: itemId, media_id: media.id, language: lang, status: 'queued', source, priority, created_at: new Date().toISOString() });
  return getJob(id)!;
}

export function cancelJob(id: string) {
  if (current?.jobId === id) current.ctrl.abort();
  const dir = workDir(id);
  db.run('DELETE FROM ai_subtitle_jobs WHERE id = ?', id);
  fs.rmSync(dir, { recursive: true, force: true });
}

const hasLanguage = (subs: SubtitleStream[], lang: string) => {
  const l3 = normLang(lang);
  return subs.some((s) => s.language && (s.language === l3 || lang2(s.language) === lang) && !s.forced);
};

/** Queue media missing a wanted language (newest first). Returns how many jobs were added. */
export function enqueueMissing(limit = 200, now = Date.now()): number {
  const s = aiSettings().autoSubtitles;
  const langs = wantedLanguages(s);
  if (!langs.length) return 0;
  // Last resort: give the download task 12 hours first when it can actually download.
  const graceIso = new Date(now - (activeProviders().length ? 12 * 3600_000 : 0)).toISOString();
  const libFilter = s.libraryIds.length ? `AND i.library_id IN (${s.libraryIds.map(() => '?').join(',')})` : '';
  const rows = db.all<{ id: string; mid: string; subs: string }>(
    `SELECT i.id, m.id mid, m.subs FROM items i JOIN media m ON m.item_id = i.id JOIN libraries l ON l.id = i.library_id
     WHERE i.type IN ('movie','episode') AND m.path IS NOT NULL AND l.type IN ('movies','shows') AND i.added_at <= ? ${libFilter}
     ORDER BY i.added_at DESC LIMIT 5000`, graceIso, ...s.libraryIds);
  let added = 0;
  for (const r of rows) {
    if (added >= limit) break;
    const subs = parseJson<SubtitleStream[]>(r.subs, []);
    for (const lang of langs) {
      if (hasLanguage(subs, lang)) continue;
      if (db.get('SELECT 1 FROM ai_subtitle_jobs WHERE media_id = ? AND language = ?', r.mid, lang)) continue;
      db.insert('ai_subtitle_jobs', { id: newId(), item_id: r.id, media_id: r.mid, language: lang, status: 'queued', source: 'task', priority: 0, created_at: new Date().toISOString() });
      added++;
    }
  }
  return added;
}

/* ----------------------------- pipeline ----------------------------- */

export interface PipelineDeps {
  transcribe: Transcriber;
  extract: (input: string, ordinal: number, out: string, signal?: AbortSignal) => Promise<void>;
  duration: (wav: string) => number;
  silences: (wav: string, durationMs: number, signal?: AbortSignal) => Promise<Silence[]>;
  cut: (wav: string, startMs: number, endMs: number, out: string, signal?: AbortSignal) => Promise<void>;
  translate: (cues: Cue[], from: string | null, to: string, onProgress: (done: number, total: number) => void) => Promise<Cue[]>;
  canTranslate: () => boolean;
  /** Checked between chunks: false pauses the job (it resumes on the next run). */
  keepGoing: () => boolean;
  now?: () => number;
}

export function defaultDeps(opts: { ignoreWindow?: boolean } = {}): PipelineDeps {
  const s = aiSettings().autoSubtitles;
  return {
    transcribe: transcriberFor(s),
    extract: extractAudio,
    duration: wavDurationMs,
    silences: detectSilences,
    cut: cutChunk,
    translate: (cues, from, to, onProgress) => translateCues(cues, from, to, { onProgress }),
    canTranslate: () => aiSettings().autoSubtitles.translate && llmAvailable('autoSubtitles'),
    keepGoing: () => featureEnabled('autoSubtitles') && (opts.ignoreWindow || inWindow(aiSettings().autoSubtitles.windowStart, aiSettings().autoSubtitles.windowEnd)),
  };
}

interface WorkState { ordinal: number; trackLanguage: string | null; spoken: string | null; durationMs: number; chunks: Chunk[] }

const readJson = <T,>(file: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
};

export class SkipJob extends Error {}
class Paused extends Error {}

/** Run (or resume) one job. Resolves to the final status. */
export async function processJob(jobId: string, deps: PipelineDeps, signal?: AbortSignal): Promise<AutoSubtitleJob['status'] | 'paused'> {
  const job = db.get<{ id: string; item_id: string; media_id: string; language: string; started_at: string | null }>('SELECT * FROM ai_subtitle_jobs WHERE id = ?', jobId);
  if (!job) throw new Error('Job not found');
  const media = db.get<{ path: string | null; audio: string; subs: string }>('SELECT path, audio, subs FROM media WHERE id = ?', job.media_id);
  const now = deps.now ?? Date.now;
  const runStart = now();
  updateJob(jobId, { status: 'running', started_at: job.started_at ?? new Date(runStart).toISOString(), error: null });
  const phase = (p: string, progress?: number, eta?: number | null) => updateJob(jobId, { phase: p, ...(progress != null ? { progress: Math.max(0, Math.min(99, Math.round(progress))) } : {}), ...(eta !== undefined ? { eta_s: eta == null ? null : Math.round(eta) } : {}) });
  const dir = workDir(jobId);
  try {
    if (!media?.path || !fs.existsSync(media.path)) throw new SkipJob('The media file is missing');
    if (hasLanguage(parseJson<SubtitleStream[]>(media.subs, []), job.language)) throw new SkipJob('A subtitle in this language exists now');
    fs.mkdirSync(dir, { recursive: true });
    const stateFile = path.join(dir, 'state.json');
    let st = readJson<WorkState>(stateFile);
    const wav = path.join(dir, 'audio.wav');
    if (!st || !fs.existsSync(wav)) {
      const track = pickAudioStream(parseJson<AudioStream[]>(media.audio, []));
      if (!track) throw new SkipJob('The file has no audio track');
      phase('extracting audio', 1, null);
      await deps.extract(media.path, track.ordinal, wav, signal);
      const durationMs = deps.duration(wav);
      if (durationMs < 1000) throw new SkipJob('The audio track is empty');
      phase('finding pauses', 3);
      const silences = await deps.silences(wav, durationMs, signal);
      st = { ordinal: track.ordinal, trackLanguage: track.language, spoken: track.language, durationMs, chunks: planChunks(durationMs, silences) };
      fs.writeFileSync(stateFile, JSON.stringify(st));
    }
    const want = job.language;
    // Whisper translates to English by itself; anything else needs the language model.
    const needsLlm = (spoken: string | null) => !!spoken && spoken !== want && want !== 'en';
    if (needsLlm(st.spoken) && !deps.canTranslate()) throw new SkipJob(`Needs a language model to translate from ${st.spoken} to ${want} (Admin → AI)`);
    const total = st.chunks.reduce((a, c) => a + (c.endMs - c.startMs), 0) || 1;
    let doneMs = 0;
    let doneThisRun = 0;
    let prompt: string | null = null;
    for (const c of st.chunks) {
      const file = path.join(dir, `chunk-${c.index}.json`);
      const saved = readJson<{ cues: Cue[] }>(file);
      if (saved) {
        doneMs += c.endMs - c.startMs;
        prompt = saved.cues.at(-1)?.text ?? prompt;
        continue;
      }
      if (signal?.aborted) throw new Paused();
      if (!deps.keepGoing()) throw new Paused();
      const elapsed = (now() - runStart) / 1000;
      const eta = doneThisRun > 0 ? (elapsed / doneThisRun) * (total - doneMs) : null;
      phase(`transcribing ${c.index + 1}/${st.chunks.length}`, 5 + (doneMs / total) * (needsLlm(st.spoken) ? 75 : 93), eta);
      const chunkWav = path.join(dir, `chunk-${c.index}.wav`);
      await deps.cut(wav, c.startMs, c.endMs, chunkWav, signal);
      let r = await deps.transcribe({ wav: chunkWav, offsetMs: c.startMs, language: st.spoken, translateToEnglish: want === 'en' && !!st.spoken && st.spoken !== 'en', prompt, signal });
      if (!st.spoken) {
        // Unknown spoken language: whisper detected it on this first chunk.
        st.spoken = r.language ?? null;
        fs.writeFileSync(stateFile, JSON.stringify(st));
        if (needsLlm(st.spoken) && !deps.canTranslate()) throw new SkipJob(`Needs a language model to translate from ${st.spoken} to ${want} (Admin → AI)`);
        if (want === 'en' && st.spoken && st.spoken !== 'en') r = await deps.transcribe({ wav: chunkWav, offsetMs: c.startMs, language: st.spoken, translateToEnglish: true, prompt, signal });
      }
      fs.rmSync(chunkWav, { force: true });
      fs.writeFileSync(file, JSON.stringify({ cues: r.cues }));
      updateJob(jobId, { spoken_language: st.spoken });
      prompt = r.cues.at(-1)?.text ?? prompt;
      doneMs += c.endMs - c.startMs;
      doneThisRun += c.endMs - c.startMs;
    }
    let cues = tidyCues(st.chunks.flatMap((c) => readJson<{ cues: Cue[] }>(path.join(dir, `chunk-${c.index}.json`))?.cues ?? []));
    if (!cues.length) throw new SkipJob('No speech was recognised');
    let translated = false;
    if (needsLlm(st.spoken)) {
      const tFile = path.join(dir, `translated-${want}.json`);
      const saved = readJson<{ cues: Cue[] }>(tFile);
      if (saved && saved.cues.length === cues.length) cues = saved.cues;
      else {
        if (!deps.canTranslate()) throw new SkipJob(`Needs a language model to translate from ${st.spoken} to ${want} (Admin → AI)`);
        const t0 = now();
        cues = await deps.translate(cues, st.spoken, want, (done, all) => {
          const rate = (now() - t0) / 1000 / Math.max(1, done);
          phase(`translating ${done}/${all}`, 80 + (done / all) * 18, rate * (all - done));
        });
        fs.writeFileSync(tFile, JSON.stringify({ cues }));
      }
      translated = true;
    }
    // Same clean-up as downloaded subtitles (encoding, Romanian comma-below diacritics, line endings).
    const cleaned = cleanSubtitle(Buffer.from(assembleSrt(cues), 'utf8'), want, 'srt');
    saveSubtitle({
      mediaId: job.media_id, videoPath: media.path, data: Buffer.from(cleaned.text, 'utf8'), ext: 'srt', language: want, flag: 'std',
      provider: AI_PROVIDER_ID, fileId: `${jobId}`, release: `whisper${st.spoken ? ` (${st.spoken}${translated ? ` → ${want}` : ''})` : ''}`, score: null, synced: false, mode: 'data',
    });
    refreshMediaSubs(job.media_id);
    updateJob(jobId, { status: 'done', phase: null, progress: 100, eta_s: null, cues: cues.length, translated: translated || (want === 'en' && st.spoken !== 'en') ? 1 : 0, finished_at: new Date(now()).toISOString() });
    fs.rmSync(dir, { recursive: true, force: true });
    log.info(`Generated ${want} subtitles for ${job.item_id} (${cues.length} cues${translated ? `, translated from ${st.spoken}` : ''})`);
    return 'done';
  } catch (e) {
    if (e instanceof Paused || (signal?.aborted && !(e instanceof SkipJob))) {
      updateJob(jobId, { status: 'queued', phase: 'paused (resumes in the next window)', eta_s: null });
      return 'paused';
    }
    const skip = e instanceof SkipJob;
    updateJob(jobId, { status: skip ? 'skipped' : 'error', phase: null, eta_s: null, error: (e as Error).message.slice(0, 500), finished_at: new Date(now()).toISOString() });
    if (!skip) log.warn(`Automatic subtitles failed for ${job.item_id}: ${(e as Error).message}`);
    // Keep the work files after an error so a retry resumes; a skip has nothing worth keeping.
    if (skip) fs.rmSync(dir, { recursive: true, force: true });
    return skip ? 'skipped' : 'error';
  }
}

/* ------------------------------ runner ------------------------------ */

let current: { jobId: string | null; ctrl: AbortController } | null = null;

export const isRunning = () => !!current;

/** Stop the running job; it goes back to the queue and resumes from its last finished chunk. */
export function stopAutoSubtitles() {
  current?.ctrl.abort();
}

/**
 * The scheduled task: queue what's missing, then process jobs one by one while inside the night window (or always
 * with `ignoreWindow`, for an admin's "Run now").
 */
export async function runAutoSubtitles(progress: (p: number) => void = () => {}, opts: { ignoreWindow?: boolean; deps?: PipelineDeps; maxJobs?: number } = {}): Promise<number> {
  if (!featureEnabled('autoSubtitles') || current) return 0;
  const ctrl = new AbortController();
  current = { jobId: null, ctrl };
  let done = 0;
  try {
    const deps = opts.deps ?? defaultDeps(opts);
    if (!deps.keepGoing()) return 0;
    if (!opts.deps && !engineReport(aiSettings().autoSubtitles).ready) {
      log.info(`Automatic subtitles are not ready: ${engineReport(aiSettings().autoSubtitles).problems.join(' ')}`);
      return 0;
    }
    enqueueMissing();
    // A job left "running" by a restart resumes first.
    db.run("UPDATE ai_subtitle_jobs SET status = 'queued' WHERE status = 'running'");
    const startCount = db.get<{ n: number }>("SELECT COUNT(*) n FROM ai_subtitle_jobs WHERE status = 'queued'")?.n ?? 0;
    const max = opts.maxJobs ?? Infinity;
    for (let n = 0; n < max; n++) {
      if (ctrl.signal.aborted || !deps.keepGoing()) break;
      const next = db.get<{ id: string }>("SELECT id FROM ai_subtitle_jobs WHERE status = 'queued' ORDER BY priority DESC, CASE WHEN progress > 0 THEN 0 ELSE 1 END, created_at LIMIT 1");
      if (!next) break;
      current.jobId = next.id;
      const r = await processJob(next.id, deps, ctrl.signal);
      if (r === 'paused') break;
      if (r === 'done') done++;
      progress(Math.min(99, Math.round(((n + 1) / Math.max(1, startCount)) * 100)));
    }
    return done;
  } finally {
    current = null;
  }
}

export function autoSubtitleStatus(): AutoSubtitleStatus {
  const s = aiSettings().autoSubtitles;
  const running = db.get(`${JOB_SELECT} WHERE j.status = 'running' LIMIT 1`);
  return {
    enabled: featureEnabled('autoSubtitles'),
    engine: engineReport(s),
    inWindow: inWindow(s.windowStart, s.windowEnd),
    running: running ? rowToJob(running) : null,
    queued: db.all(`${JOB_SELECT} WHERE j.status = 'queued' ORDER BY j.priority DESC, j.created_at LIMIT 100`).map(rowToJob),
    recent: db.all(`${JOB_SELECT} WHERE j.status IN ('done','error','skipped') ORDER BY j.finished_at DESC LIMIT 50`).map(rowToJob),
    download: downloadState(),
  };
}

/** Clear finished/failed/skipped jobs from the list (they may then be queued again by the task). */
export function clearFinished(status: 'done' | 'error' | 'skipped' | 'all' = 'all') {
  if (status === 'all') db.run("DELETE FROM ai_subtitle_jobs WHERE status IN ('error','skipped')");
  else db.run('DELETE FROM ai_subtitle_jobs WHERE status = ?', status);
}
