/**
 * Server-side AI stem separation: a queue of tracks and one child process (child.ts) that runs HT-Demucs with
 * onnxruntime-node, one track at a time. The runtime (ortNode.ts) and the model (stems.ts) are downloaded on first use;
 * finished stems go through the same FLAC cache as browser uploads (StemStore.installRaw), so every client plays them
 * the same way. The child is started for the first job and stopped after a few idle minutes (the model takes a few
 * hundred MB of memory); a cancel kills it.
 *
 * Adapted from OpenDJ (MIT, github.com/Bucifer6/OpenDJ) — server/stems.js (native separation queue).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { KaraokeSettings, StemsJob } from '@mediamax/shared';
import { config } from '../../config.js';
import { logger } from '../../util/log.js';
import { STEM_RATE, StemsError, type StemStore } from '../stems.js';
import { findOrtNode, ortNodeRuntime } from '../ortNode.js';
import { isSea } from 'node:sea';
import type { InitMessage, JobMessage } from './child.js';

const log = logger('stems');
const IDLE_MS = 3 * 60e3;
const ERROR_TTL = 6 * 3600e3;
const MAX_FRAMES = STEM_RATE * 60 * 90;

/** The child's entry: child.ts under tsx (development, tests), child.js in the compiled server. */
const childEntry = () => {
  const self = fileURLToPath(import.meta.url);
  return path.join(path.dirname(self), `child${path.extname(self) || '.js'}`);
};

interface Job extends StemsJob {
  id: string;
  file: string;
}

export interface SeparationDeps {
  store: StemStore;
  settings: () => Partial<KaraokeSettings>;
  ffmpeg?: string;
  /** Tests: the deterministic band-splitting stand-in instead of the model (no runtime or model needed). */
  stub?: boolean;
  /** Tests: the runtime / model steps (defaults: ortNode.ts and the stem store's model download). */
  ensureRuntime?: () => Promise<{ module: string } | null>;
  ensureModel?: (s: Partial<KaraokeSettings>, onProgress: (done: number, total: number) => void) => Promise<string>;
}

export interface SeparationQueue {
  /** Queue a track (no-op when it is queued or running). `file` is the track's audio file. */
  enqueue(id: string, file: string): StemsJob;
  /** The job for a track, or null. */
  job(id: string): StemsJob | null;
  /** Why the last attempt for a track failed, or null. */
  error(id: string): string | null;
  /** Cancel a queued or running job; true when there was one. */
  cancel(id: string): boolean;
  size(): number;
  lastBackend(): string | null;
  /** Why the GPU is not used any more (it failed earlier), or null. */
  gpuProblem(): string | null;
  /** Resolves when the queue is empty and nothing runs (tests). */
  idle(): Promise<void>;
  close(): void;
}

export function createSeparationQueue(deps: SeparationDeps): SeparationQueue {
  const ffmpeg = deps.ffmpeg ?? config.ffmpeg;
  const queue: Job[] = [];
  const errors = new Map<string, { message: string; at: number }>();
  let running: Job | null = null;
  let child: ChildProcess | null = null;
  let childKey = '';
  let ready: Promise<void> | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let lastBackend: string | null = null;
  /** A GPU backend failed or returned invalid audio: use the CPU until the server restarts. */
  let gpuBroken: string | null = null;
  let pumping = false;
  let closed = false;
  let waiters: (() => void)[] = [];
  /** Settles the current job's promise from child messages. */
  let onMessage: ((m: any) => void) | null = null;
  let onExit: ((why: string) => void) | null = null;
  /** Rejects the running job's wait for the child (cancel). */
  let abortJob: (() => void) | null = null;

  const settle = () => {
    if (!running && !queue.length) {
      const w = waiters;
      waiters = [];
      w.forEach((f) => f());
    }
  };

  const stopChild = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    const c = child;
    child = null;
    ready = null;
    childKey = '';
    if (c && c.exitCode === null) c.kill();
  };

  const startChild = (init: InitMessage) => {
    const key = JSON.stringify(init);
    if (child && childKey === key && ready) return ready;
    stopChild();
    // A standalone binary would run another full server instead of the child (see routes/karaoke.ts).
    if (isSea()) throw new Error('Server-side separation is not available in the standalone build');
    const c = fork(childEntry(), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    child = c;
    childKey = key;
    let stderr = '';
    c.stderr?.on('data', (d) => {
      stderr = (stderr + d).slice(-4000);
      for (const line of String(d).split('\n')) if (line.trim()) log.info(line.trim());
    });
    // Only the live child talks to the current job: a child stopped by a cancel may still exit / send late.
    c.on('message', (m: any) => {
      if (child !== c) return;
      if (m?.type === 'gpu-failed') {
        gpuBroken = `${m.backend}: ${m.message}`;
        log.warn(`Stem separation: the GPU (${m.backend}) failed (${m.message}); using the CPU until the server restarts`);
        childKey = ''; // the next job restarts the child on the CPU
        return;
      }
      onMessage?.(m);
    });
    c.on('exit', (code, signal) => {
      if (child !== c) return;
      child = null;
      ready = null;
      childKey = '';
      onExit?.(`The separation process stopped (${signal ?? `exit ${code}`})${stderr.trim() ? `: ${stderr.trim().split('\n').pop()}` : ''}`);
    });
    ready = new Promise<void>((resolve, reject) => {
      onMessage = (m) => {
        if (m?.type === 'ready') {
          lastBackend = m.backend;
          log.info(`Stem separation ready on ${m.backend}${m.threads ? ` (${m.threads} threads)` : ''}${m.loadMs != null ? `, model loaded in ${m.loadMs} ms` : ''}`);
          resolve();
        } else if (m?.type === 'error') reject(new Error(m.message));
      };
      onExit = (why) => reject(new Error(why));
    });
    ready.catch(() => {});
    c.send(init);
    return ready;
  };

  const scheduleIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(stopChild, IDLE_MS);
    idleTimer.unref?.();
  };

  const ensureRuntime = deps.ensureRuntime ?? (async () => {
    const found = findOrtNode();
    if (found) return found;
    await ortNodeRuntime().ensure();
    return findOrtNode();
  });
  const ensureModel = deps.ensureModel ?? (async (s, onProgress) => {
    const st = deps.store.startDownload(s);
    if (!st.ready) {
      const poll = setInterval(() => {
        const d = deps.store.modelStatus(s)?.downloading;
        if (d) onProgress(d.received, d.total);
      }, 500);
      try {
        await deps.store.downloadDone();
      } finally {
        clearInterval(poll);
      }
    }
    const f = deps.store.modelFile(s);
    if (!f) throw new Error(deps.store.modelStatus(s)?.error || 'The stems model could not be downloaded');
    return f;
  });

  async function runJob(j: Job) {
    const s = deps.settings();
    let init: InitMessage;
    if (deps.stub) init = { type: 'init', stub: true };
    else {
      j.phase = 'runtime-download';
      const ort = await ensureRuntime();
      if (!ort) throw new Error('The native AI runtime (onnxruntime-node) is not available on this server');
      j.phase = 'model-download';
      const model = await ensureModel(s, (done, total) => Object.assign(j, { done, total }));
      init = { type: 'init', ortModule: ort.module, model, backend: s.stemsBackend === 'cpu' || gpuBroken ? 'cpu' : 'auto', threads: Math.max(0, Math.min(256, Math.floor(Number(s.stemsThreads) || 0))) };
    }
    if (j !== running) return;
    Object.assign(j, { phase: 'loading-model', done: 0, total: 0 });
    await startChild(init);
    if (j !== running) return;
    const dir = path.join(deps.store.root, `.native-${j.id}-${crypto.randomBytes(4).toString('hex')}`);
    await fs.promises.mkdir(dir, { recursive: true });
    try {
      const done = await new Promise<{ frames: number; backend: string }>((resolve, reject) => {
        onMessage = (m) => {
          if (m?.id !== j.id) return;
          if (m.type === 'progress') Object.assign(j, { phase: m.phase, done: m.done, total: m.total, ...(m.backend ? { backend: m.backend } : {}) });
          else if (m.type === 'done') resolve(m);
          else if (m.type === 'error') reject(new Error(m.message));
        };
        onExit = (why) => reject(new Error(why));
        abortJob = () => reject(new Error('Cancelled'));
        const msg: JobMessage = { type: 'job', id: j.id, ffmpeg, file: j.file, dir, overlap: 0.25, maxFrames: MAX_FRAMES };
        child!.send(msg);
      });
      if (j !== running) return;
      lastBackend = done.backend;
      Object.assign(j, { phase: 'saving', done: 0, total: 0, backend: done.backend });
      await deps.store.installRaw(j.id, dir, { frames: done.frames, model: deps.stub ? 'stub-bands' : deps.store.modelStatus(s)?.id ?? 'model', backend: done.backend });
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (!closed && queue.length) {
        const j = queue.shift()!;
        running = j;
        Object.assign(j, { state: 'running', phase: 'waiting', position: undefined });
        const t0 = Date.now();
        try {
          await runJob(j);
          if (running === j) log.info(`Stems prepared on the server for ${j.id} (${j.backend ?? 'cpu'}, ${Math.round((Date.now() - t0) / 1000)} s)`);
        } catch (e) {
          if (running === j) {
            const message = (e as Error).message || String(e);
            errors.set(j.id, { message, at: Date.now() });
            log.warn(`Server stem separation failed for ${j.id}: ${message}`);
          }
        } finally {
          if (running === j) running = null;
          onMessage = null;
          onExit = null;
          abortJob = null;
        }
      }
    } finally {
      pumping = false;
      if (!closed) scheduleIdle();
      settle();
    }
  }

  const view = (j: Job): StemsJob => {
    const v: StemsJob = { state: j.state, phase: j.phase, done: j.done, total: j.total };
    if (j.state === 'queued') v.position = queue.indexOf(j) + 1;
    if (j.backend) v.backend = j.backend;
    return v;
  };

  return {
    enqueue(id, file) {
      if (closed) throw new StemsError('The server is shutting down', 503);
      if (running?.id === id) return view(running);
      const q = queue.find((x) => x.id === id);
      if (q) return view(q);
      if (!fs.existsSync(file)) throw new StemsError('The track file is missing', 404);
      errors.delete(id);
      const j: Job = { id, file, state: 'queued', phase: 'waiting', done: 0, total: 0 };
      queue.push(j);
      if (idleTimer) clearTimeout(idleTimer);
      void pump();
      return view(j);
    },
    job(id) {
      const j = running?.id === id ? running : queue.find((x) => x.id === id);
      return j ? view(j) : null;
    },
    error(id) {
      const e = errors.get(id);
      if (e && Date.now() - e.at > ERROR_TTL) errors.delete(id);
      return errors.get(id)?.message ?? null;
    },
    cancel(id) {
      const i = queue.findIndex((x) => x.id === id);
      if (i >= 0) {
        queue.splice(i, 1);
        settle();
        return true;
      }
      if (running?.id === id) {
        running = null;
        const abort = abortJob ?? onExit;
        stopChild();
        abort?.('Cancelled'); // the job's wait ends; its temp folder is removed in runJob
        return true;
      }
      return false;
    },
    size: () => queue.length + (running ? 1 : 0),
    lastBackend: () => lastBackend,
    gpuProblem: () => gpuBroken,
    idle() {
      if (!running && !queue.length) return Promise.resolve();
      return new Promise((r) => waiters.push(r));
    },
    close() {
      closed = true;
      queue.length = 0;
      running = null;
      const abort = abortJob ?? onExit;
      stopChild();
      abort?.('Closed');
      settle();
    },
  };
}
