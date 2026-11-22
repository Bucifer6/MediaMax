/**
 * Native AI stem separation, run as a child process of the Kinora server (native.ts forks it). Same model and the same
 * DSP as the browser worker (shared/src/stems/), but ONNX Runtime for Node: native multi-threaded CPU everywhere, and
 * the GPU where the platform has one (DirectML on Windows, CoreML on macOS, CUDA on Linux when its libraries are
 * installed). A separate process at below-normal priority, so neither the server's event loop nor playback waits for
 * it, and a cancel simply kills it.
 *
 * in  (IPC): { type: 'init', ortModule, model, backend: 'auto'|'gpu'|'cpu', threads, stub }
 *            { type: 'job', id, ffmpeg, file, dir, overlap, maxFrames }
 * out (IPC): { type: 'ready', backend, threads, loadMs } { type: 'progress', id, phase, done, total, backend }
 *            { type: 'gpu-failed', backend, message } (the track is redone on the CPU)
 *            { type: 'done', id, frames, ms, chunks, backend, threads } { type: 'error', id?, message }
 * A job writes <dir>/{vocals,drums,bass,other}.raw: interleaved stereo s16le, 44.1 kHz, the whole track.
 *
 * Adapted from OpenDJ (MIT, github.com/Bucifer6/OpenDJ) — server/stems-child.js.
 */
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { DEMUCS_SOURCES, interleaveInt16, MODEL_RATE, separateChunked, STEMS } from './dsp.js';
import { createRunner, createStubSession, StubTensor, type Runner, type SessionLike, type TensorCtor } from './model.js';
import { chunkLooksValid, gpuProviders } from './checks.js';

export interface InitMessage {
  type: 'init';
  ortModule?: string | null;
  model?: string | null;
  backend?: 'auto' | 'gpu' | 'cpu';
  threads?: number;
  stub?: boolean;
}
export interface JobMessage {
  type: 'job';
  id: string;
  ffmpeg: string;
  file: string;
  dir: string;
  overlap?: number;
  maxFrames?: number;
}

interface OrtLike {
  InferenceSession: { create(model: string, opts: Record<string, unknown>): Promise<SessionLike> };
  Tensor: TensorCtor;
  listSupportedBackends?: () => { name: string }[];
}

const send = (m: Record<string, unknown>) => process.send?.(m);
const order = STEMS.map((n) => (DEMUCS_SOURCES as readonly string[]).indexOf(n));
let runner: Runner | null = null;
let info: { backend: string; threads: number; loadMs?: number } = { backend: 'cpu', threads: 0 };
let ort: OrtLike | null = null;
let gpuFailed = false;
let initMsg: InitMessage | null = null;

async function load(m: InitMessage, { cpuOnly = false } = {}) {
  const t0 = Date.now();
  if (m.stub) {
    runner = createRunner(createStubSession(), StubTensor as unknown as TensorCtor);
    info = { backend: 'stub', threads: 1, loadMs: 0 };
    return;
  }
  if (!m.ortModule || !m.model) throw new Error('The native AI runtime or the model is missing');
  ort ||= createRequire(import.meta.url)(m.ortModule) as OrtLike;
  const threads = Math.max(1, Math.floor(Number(m.threads)) || Math.max(1, (os.availableParallelism?.() || os.cpus().length) - 2));
  const opts = { graphOptimizationLevel: 'all', intraOpNumThreads: threads, interOpNumThreads: 1 };
  let session: SessionLike | null = null;
  let backend = 'cpu';
  if (!cpuOnly && m.backend !== 'cpu') {
    for (const ep of gpuProviders(process.platform, ort.listSupportedBackends?.() || [])) {
      try {
        session = await ort.InferenceSession.create(m.model, { ...opts, executionProviders: [ep] });
        backend = ep;
        break;
      } catch (e) {
        process.stderr.write(`[stems] ${ep} unavailable, using the CPU: ${(e as Error).message}\n`);
      }
    }
  }
  if (!session) session = await ort.InferenceSession.create(m.model, { ...opts, executionProviders: ['cpu'] });
  const r = createRunner(session, ort.Tensor);
  if (backend !== 'cpu') {
    const run = r.runChunk;
    r.runChunk = async (mix) => {
      const out = await run(mix);
      if (!chunkLooksValid(mix, out, r.sources.length)) throw new Error(`the ${backend} GPU backend returned invalid audio`);
      return out;
    };
  }
  runner = r;
  info = { backend, threads: backend === 'cpu' ? threads : 0, loadMs: Date.now() - t0 };
}

/** Decode any file FFmpeg reads to planar float 44.1 kHz stereo. */
function decode(ffmpeg: string, file: string, maxFrames = 0): Promise<{ left: Float32Array; right: Float32Array; length: number }> {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-map', '0:a:0', '-vn', '-f', 'f32le', '-ac', '2', '-ar', String(MODEL_RATE), '-'];
    const p = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let err = '';
    let tooLong = false;
    p.stdout.on('data', (c: Buffer) => {
      bytes += c.length;
      if (maxFrames && bytes > maxFrames * 8) {
        tooLong = true;
        p.kill();
        return;
      }
      chunks.push(c);
    });
    p.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    p.on('error', reject);
    p.on('close', (code) => {
      if (tooLong) return reject(new Error(`The track is too long for stems (max. ${Math.round(maxFrames / MODEL_RATE / 60)} minutes)`));
      if (code !== 0) return reject(new Error(`Could not decode the track: ${err.trim().split('\n').pop() || `ffmpeg exited with ${code}`}`));
      const length = Math.floor(bytes / 8);
      if (!length) return reject(new Error('The track has no audio'));
      // De-interleave straight from the chunks (no concatenated copy of the whole track; chunks may split a sample).
      const left = new Float32Array(length);
      const right = new Float32Array(length);
      const carry = Buffer.alloc(8);
      let have = 0;
      let i = 0;
      for (const c of chunks) {
        let o = 0;
        if (have) {
          const n = Math.min(8 - have, c.length);
          c.copy(carry, have, 0, n);
          have += n;
          o = n;
          if (have < 8) continue;
          if (i < length) {
            left[i] = carry.readFloatLE(0);
            right[i++] = carry.readFloatLE(4);
          }
          have = 0;
        }
        for (; o + 8 <= c.length && i < length; o += 8) {
          left[i] = c.readFloatLE(o);
          right[i++] = c.readFloatLE(o + 4);
        }
        if (o < c.length) {
          c.copy(carry, 0, o);
          have = c.length - o;
        }
      }
      chunks.length = 0;
      resolve({ left, right, length });
    });
  });
}

async function job(m: JobMessage) {
  const t0 = Date.now();
  send({ type: 'progress', id: m.id, phase: 'decoding', done: 0, total: 0 });
  const audio = await decode(m.ffmpeg, m.file, m.maxFrames);
  const fds = STEMS.map((s) => fs.openSync(`${m.dir}/${s}.raw`, 'w'));
  const pos = STEMS.map(() => 0);
  let lastSent = 0;
  const run = () => {
    const r = runner!;
    return separateChunked({
      channels: [audio.left, audio.right], length: audio.length, segment: r.segment, overlap: m.overlap ?? 0.25, sources: r.sources.length,
      runChunk: r.runChunk,
      onProgress: (done, total) => {
        const now = Date.now();
        if (done === 0 || done === total || now - lastSent > 500) {
          lastSent = now;
          send({ type: 'progress', id: m.id, phase: 'separating', done, total, backend: info.backend });
        }
      },
      onBlock: ({ frames, data }) => {
        order.forEach((k, s) => {
          const pcm = interleaveInt16(data, 2, frames, k * 2 * frames);
          fs.writeSync(fds[s], new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 0, pcm.byteLength, pos[s]);
          pos[s] += pcm.byteLength;
        });
      },
    });
  };
  try {
    let r;
    try {
      r = await run();
    } catch (e) {
      // A GPU provider that loads but fails on the first chunk (driver, memory): redo the track on the CPU.
      if (info.backend === 'cpu' || info.backend === 'stub' || gpuFailed || !initMsg) throw e;
      process.stderr.write(`[stems] ${info.backend} failed (${(e as Error).message}), using the CPU\n`);
      send({ type: 'gpu-failed', backend: info.backend, message: (e as Error).message });
      gpuFailed = true;
      await load(initMsg, { cpuOnly: true });
      for (const fd of fds) fs.ftruncateSync(fd, 0);
      pos.fill(0);
      r = await run();
    }
    send({ type: 'done', id: m.id, frames: audio.length, ms: Date.now() - t0, chunks: r.chunks, backend: info.backend, threads: info.threads });
  } finally {
    for (const fd of fds) fs.closeSync(fd);
  }
}

// One message at a time: a job never starts before the model is loaded.
let chain = Promise.resolve();
process.on('message', (m: InitMessage | JobMessage) => {
  chain = chain.then(async () => {
    try {
      if (m.type === 'init') {
        initMsg = m;
        await load(m, { cpuOnly: gpuFailed });
        send({ type: 'ready', ...info });
      } else if (m.type === 'job') {
        if (!runner) throw new Error('Model not loaded');
        await job(m);
      }
    } catch (e) {
      send({ type: 'error', id: (m as JobMessage).id, message: (e as Error)?.message || String(e) });
    }
  });
});
process.on('disconnect', () => process.exit(0));
try {
  os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
} catch {
  /* not permitted: normal priority */
}
