/**
 * Speech-to-text engines for automatic subtitles and their tools:
 *  - whisper.cpp: the `whisper-cli` program (older builds: `main`) from the admin's path, the one-click download, or
 *    PATH; ggml models (tiny/base/small/medium) downloaded on request into <data>/ai/whisper/models.
 *  - an OpenAI-compatible /audio/transcriptions API (a self-hosted faster-whisper server, or a hosted one).
 * Every child process runs at low priority so playback and transcoding keep the CPU.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import type { AutoSubtitleSettings, AutoSubtitleStatus, WhisperEngineReport, WhisperModelSize } from '@mediamax/shared';
import { config } from '../../config.js';
import { logger } from '../../util/log.js';
import { readZip } from '../../util/zip.js';
import { findOnPath } from '../subtitleProviders/tools.js';
import { openaiUrl } from '../ai/llm.js';
import { buildWhisperArgs, parseVerboseJson, parseWhisperJson, type Cue } from './srt.js';
import { warnIgnoredProgramSetting } from '../../util/programSettings.js';

const log = logger('auto-subtitles');

export const whisperDir = () => path.join(config.dataDir, 'ai', 'whisper');
const binDir = () => path.join(whisperDir(), 'bin');
const modelsDir = () => path.join(whisperDir(), 'models');

/** Official ggml models (whisper.cpp's Hugging Face repo). Sizes are approximate, for the progress bar and a sanity check. */
export const WHISPER_MODELS: Record<WhisperModelSize, { file: string; mb: number; note: string }> = {
  tiny: { file: 'ggml-tiny.bin', mb: 75, note: 'Fastest, rough: names and quiet speech suffer. About 20-40x faster than real time on a modern 6-core CPU.' },
  base: { file: 'ggml-base.bin', mb: 142, note: 'Good balance for a CPU: about 10-20x real time (a 2-hour film in ~6-12 min).' },
  small: { file: 'ggml-small.bin', mb: 466, note: 'Clearly better accuracy: about 3-6x real time (a 2-hour film in ~20-40 min).' },
  medium: { file: 'ggml-medium.bin', mb: 1500, note: 'Best of these, slow on a CPU: about 1-2x real time (a 2-hour film in 1-2 hours). Night runs only.' },
};
export const modelUrl = (size: WhisperModelSize) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${WHISPER_MODELS[size].file}`;

const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

/**
 * whisper.cpp program: VIBE_WHISPER → the copy "Download whisper.cpp" fetched → PATH. Only the environment can name a
 * program (like FFmpeg); a path saved in the web settings by earlier versions is ignored, with a log line.
 */
export function resolveWhisperBinary(s: AutoSubtitleSettings): string | null {
  warnIgnoredProgramSetting('whisper.cpp program path', s.whisperPath, 'VIBE_WHISPER', 'whisper-cli');
  const fromEnv = process.env.MEDIAMAX_WHISPER;
  if (fromEnv) return fs.existsSync(fromEnv) ? fromEnv : findOnPath([fromEnv]);
  for (const n of ['whisper-cli', 'main']) {
    const p = path.join(binDir(), exe(n));
    if (fs.existsSync(p)) return p;
  }
  return findOnPath(['whisper-cli', 'whisper-cpp', 'whisper.cpp']);
}

export function resolveModel(s: AutoSubtitleSettings): string {
  return s.modelPath || path.join(modelsDir(), WHISPER_MODELS[s.model].file);
}

export function engineReport(s: AutoSubtitleSettings): WhisperEngineReport {
  const problems: string[] = [];
  if (s.engine === 'api') {
    if (!s.apiUrl) problems.push('Set the speech-to-text API URL.');
    return { engine: 'api', ready: !problems.length, binary: null, model: s.apiModel || 'whisper-1', modelPresent: !!s.apiUrl, problems };
  }
  const binary = resolveWhisperBinary(s);
  const model = resolveModel(s);
  const modelPresent = fs.existsSync(model);
  if (!binary) problems.push(process.env.MEDIAMAX_WHISPER ? `whisper.cpp was not found at ${process.env.MEDIAMAX_WHISPER} (VIBE_WHISPER).` : process.platform === 'win32' ? 'whisper.cpp is not installed: use "Download whisper.cpp", or set the VIBE_WHISPER environment variable to its path.' : 'whisper.cpp is not installed: install it (e.g. "brew install whisper-cpp", or build it), or set the VIBE_WHISPER environment variable to its path.');
  if (!modelPresent) problems.push(s.modelPath ? `The model file ${s.modelPath} does not exist.` : `The ${s.model} model is not downloaded yet.`);
  return { engine: 'whisper-cpp', ready: !problems.length, binary, model, modelPresent, problems };
}

/** CPU threads for whisper: the setting, else half the cores (at least 1, at most 8). */
export const whisperThreads = (s: AutoSubtitleSettings) => (s.threads > 0 ? s.threads : Math.max(1, Math.min(8, Math.floor((os.availableParallelism?.() ?? os.cpus().length) / 2))));

/* ----------------------------- processes ----------------------------- */

export interface LowRun { ok: boolean; code: number | null; stderr: string; aborted: boolean }

/** Spawn at the lowest priority (nice 19 / IDLE class on Windows); killed on timeout or abort. */
export function runLowPriority(bin: string, args: string[], opts: { timeoutMs: number; signal?: AbortSignal; onStderr?: (chunk: string) => void } ): Promise<LowRun> {
  return new Promise((resolve) => {
    let stderr = '';
    let aborted = false;
    let p: ReturnType<typeof spawn>;
    try {
      p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ ok: false, code: null, stderr: (e as Error).message, aborted: false });
      return;
    }
    try {
      if (p.pid) os.setPriority(p.pid, os.constants.priority.PRIORITY_LOW);
    } catch {
      /* not permitted: run at normal priority */
    }
    const kill = () => {
      aborted = true;
      p.kill('SIGKILL');
    };
    const timer = setTimeout(kill, opts.timeoutMs);
    opts.signal?.addEventListener('abort', kill, { once: true });
    p.stderr?.on('data', (d: Buffer) => {
      const s = d.toString();
      stderr = (stderr + s).slice(-4000);
      opts.onStderr?.(s);
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stderr: e.message, aborted });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', kill);
      resolve({ ok: code === 0 && !aborted, code, stderr, aborted });
    });
  });
}

export interface TranscribeRequest {
  wav: string;
  offsetMs: number;
  language: string | null;
  translateToEnglish: boolean;
  prompt?: string | null;
  signal?: AbortSignal;
}

export interface Transcriber {
  (r: TranscribeRequest): Promise<{ cues: Cue[]; language: string | null }>;
}

/** whisper.cpp on one chunk (16 kHz mono WAV). */
export function whisperCppTranscriber(s: AutoSubtitleSettings): Transcriber {
  return async (r) => {
    const bin = resolveWhisperBinary(s);
    if (!bin) throw new Error('whisper.cpp is not installed');
    const outBase = r.wav.replace(/\.wav$/i, '');
    const args = buildWhisperArgs({ model: resolveModel(s), input: r.wav, outBase, language: r.language, translate: r.translateToEnglish, threads: whisperThreads(s), prompt: r.prompt });
    const res = await runLowPriority(bin, args, { timeoutMs: 3 * 3600_000, signal: r.signal });
    if (!res.ok) throw new Error(res.aborted ? 'stopped' : `whisper.cpp failed: ${res.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300) || `exit ${res.code}`}`);
    const json = JSON.parse(fs.readFileSync(`${outBase}.json`, 'utf8'));
    fs.rmSync(`${outBase}.json`, { force: true });
    return parseWhisperJson(json, r.offsetMs);
  };
}

/** OpenAI-compatible /audio/transcriptions (or /audio/translations for English) on one chunk. */
export function apiTranscriber(s: AutoSubtitleSettings, fetchImpl: typeof fetch = fetch): Transcriber {
  return async (r) => {
    if (!s.apiUrl) throw new Error('No speech-to-text API configured');
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(r.wav)], { type: 'audio/wav' }), path.basename(r.wav));
    form.append('model', s.apiModel || 'whisper-1');
    form.append('response_format', 'verbose_json');
    if (r.language && !r.translateToEnglish) form.append('language', r.language);
    if (r.prompt) form.append('prompt', r.prompt.slice(0, 200));
    const headers: Record<string, string> = {};
    if (s.apiKey) headers.authorization = `Bearer ${s.apiKey}`;
    const res = await fetchImpl(openaiUrl(s.apiUrl, r.translateToEnglish ? 'audio/translations' : 'audio/transcriptions'), { method: 'POST', headers, body: form, signal: r.signal ?? AbortSignal.timeout(30 * 60_000) });
    if (!res.ok) throw new Error(`Speech-to-text API HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return parseVerboseJson(await res.json(), r.offsetMs);
  };
}

export const transcriberFor = (s: AutoSubtitleSettings): Transcriber => (s.engine === 'api' ? apiTranscriber(s) : whisperCppTranscriber(s));

/* ----------------------------- downloads ----------------------------- */

const dl: AutoSubtitleStatus['download'] = { state: 'idle', what: null, received: 0, total: 0, error: null };
let dlRunning: Promise<void> | null = null;
export const downloadState = () => ({ ...dl });

async function fetchToFile(url: string, dest: string, maxBytes: number, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(url, { redirect: 'follow', headers: { 'user-agent': 'media-server' } });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
  dl.total = Number(res.headers.get('content-length')) || 0;
  if (dl.total > maxBytes) throw new Error('Download is larger than expected');
  const tmp = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(tmp);
  const hash = crypto.createHash('sha256');
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      dl.received += chunk.length;
      if (dl.received > maxBytes) throw new Error('Download is larger than expected');
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fs.renameSync(tmp, dest);
  return hash.digest('hex');
}

function runDownload(what: string, job: () => Promise<void>): Promise<void> {
  if (dlRunning) return dlRunning;
  Object.assign(dl, { state: 'downloading', what, received: 0, total: 0, error: null });
  dlRunning = job()
    .then(() => {
      dl.state = 'ready';
    })
    .catch((e: Error) => {
      dl.state = 'error';
      dl.error = e.message;
      log.warn(`${what} download failed: ${e.message}`);
    })
    .finally(() => {
      dlRunning = null;
    });
  return dlRunning;
}

/** Download a ggml model. Checks the ggml file magic and a plausible size (the files are not signed). */
export function downloadModel(size: WhisperModelSize, fetchImpl: typeof fetch = fetch): Promise<void> {
  const info = WHISPER_MODELS[size];
  return runDownload(`whisper ${size} model`, async () => {
    const dest = path.join(modelsDir(), info.file);
    const sha = await fetchToFile(modelUrl(size), dest, info.mb * 1.3 * 1024 * 1024, fetchImpl);
    const fd = fs.openSync(dest, 'r');
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    const st = fs.statSync(dest);
    // ggml files start with the magic 0x67676d6c ("lmgg" on disk, little endian).
    if (head.readUInt32LE(0) !== 0x67676d6c || st.size < info.mb * 0.7 * 1024 * 1024) {
      fs.rmSync(dest, { force: true });
      throw new Error('The downloaded file is not a whisper.cpp model');
    }
    fs.writeFileSync(`${dest}.sha256`, sha);
    log.info(`Downloaded the whisper ${size} model (${Math.round(st.size / 1048576)} MB, sha256 ${sha.slice(0, 12)}…)`);
  });
}

/** Release asset for this platform: whisper.cpp publishes ready-made binaries for Windows only. */
export function releaseAssetName(platform = process.platform, arch = process.arch): string | null {
  if (platform === 'win32') return arch === 'ia32' ? 'whisper-bin-Win32.zip' : 'whisper-bin-x64.zip';
  return null;
}

/**
 * Download the official whisper.cpp release for this platform (GitHub, ggml-org/whisper.cpp) into <data>/ai/whisper/bin.
 * Verifies the asset digest GitHub publishes when present.
 */
export function downloadWhisperBinary(fetchImpl: typeof fetch = fetch): Promise<void> {
  const asset = releaseAssetName();
  if (!asset) return Promise.reject(new Error('whisper.cpp only publishes ready-made programs for Windows. On Linux/macOS install it from your package manager (e.g. "brew install whisper-cpp") or build it, then set its path.'));
  return runDownload('whisper.cpp', async () => {
    const rel = await fetchImpl('https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest', { headers: { accept: 'application/vnd.github+json', 'user-agent': 'media-server' } });
    if (!rel.ok) throw new Error(`GitHub HTTP ${rel.status}`);
    const j = (await rel.json()) as { tag_name?: string; assets?: { name: string; browser_download_url: string; digest?: string | null }[] };
    const a = j.assets?.find((x) => x.name === asset);
    if (!a) throw new Error(`The latest release (${j.tag_name ?? '?'}) has no ${asset}`);
    const zipPath = path.join(whisperDir(), asset);
    const sha = await fetchToFile(a.browser_download_url, zipPath, 300 * 1024 * 1024, fetchImpl);
    if (a.digest && a.digest.startsWith('sha256:') && a.digest.slice(7).toLowerCase() !== sha) {
      fs.rmSync(zipPath, { force: true });
      throw new Error('Download is corrupt (SHA-256 mismatch)');
    }
    const files = readZip(fs.readFileSync(zipPath));
    const tmp = `${binDir()}.tmp-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    let found = false;
    for (const [name, data] of files) {
      const base = path.basename(name);
      if (!/\.(exe|dll)$/i.test(base)) continue;
      fs.writeFileSync(path.join(tmp, base), data);
      if (/^(whisper-cli|main)\.exe$/i.test(base)) found = true;
    }
    fs.rmSync(zipPath, { force: true });
    if (!found) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new Error('The release did not contain whisper-cli.exe');
    }
    fs.rmSync(binDir(), { recursive: true, force: true });
    fs.renameSync(tmp, binDir());
    fs.writeFileSync(path.join(binDir(), '.release'), JSON.stringify({ tag: j.tag_name, asset, sha256: sha, at: new Date().toISOString() }));
    log.info(`Downloaded whisper.cpp ${j.tag_name ?? ''}`);
  });
}
