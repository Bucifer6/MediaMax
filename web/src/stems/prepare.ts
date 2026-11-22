/**
 * Prepare AI karaoke stems for a track. When the server separates (StemsStatus.engine 'server': onnxruntime-node, the
 * GPU where it has one), this queues the track there and follows the job. Otherwise it separates in this browser:
 * make sure the server has the model, decode the track at 44.1 kHz, run HT-Demucs in a Web Worker (WebGPU or WASM),
 * and upload the stems block by block. Either way every device can then play the server's karaoke mix.
 * Adapted from OpenDJ (MIT, github.com/Bucifer6/OpenDJ) — stems.js.
 */
import type { StemsStatus, TrackStems } from '@mediamax/shared';
import { karaokeApi } from '../api/karaoke';
import { API_BASE, withToken } from '../api/client';
import { MODEL_RATE, STEMS } from './dsp.js';

export type PreparePhase = 'waiting' | 'runtime-download' | 'model-download' | 'decoding' | 'loading-model' | 'separating' | 'saving';
export interface PrepareProgress {
  phase: PreparePhase;
  done: number;
  total: number;
  backend?: string;
  /** Where the separation runs. */
  where?: 'server' | 'browser';
  /** Place in the server's queue (1 = next) while waiting. */
  position?: number;
}

const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Download the model to the server if needed, reporting progress. */
export async function ensureModel(onProgress: (p: PrepareProgress) => void, signal?: AbortSignal): Promise<StemsStatus> {
  let st = await karaokeApi.stemsStatus();
  if (!st.enabled) throw new Error('AI stem separation is turned off on this server');
  if (!st.ort) {
    // First use: the server downloads the AI runtime (onnxruntime-web) once.
    await karaokeApi.downloadOrt();
    for (;;) {
      if (signal?.aborted) throw abortError();
      await sleep(700);
      st = await karaokeApi.stemsStatus();
      if (st.ort) break;
      const d = st.ortDownload;
      if (!d || d.state === 'error' || d.state === 'idle') throw new Error(d?.error || 'Could not download the AI runtime (onnxruntime-web)');
      onProgress({ phase: 'runtime-download', done: d.received, total: d.total });
    }
  }
  if (st.model?.ready) return st;
  if (!st.model?.downloading) await karaokeApi.downloadModel();
  for (;;) {
    if (signal?.aborted) throw abortError();
    await sleep(700);
    st = await karaokeApi.stemsStatus();
    if (st.model?.ready) return st;
    if (!st.model?.downloading) throw new Error(st.model?.error || 'Model download failed');
    onProgress({ phase: 'model-download', done: st.model.downloading.received, total: st.model.downloading.total });
  }
}

/**
 * Queue the track on the server and follow its job until the stems are saved. Aborting cancels the job. Also resumes
 * following a job that is already queued or running (the request is a no-op then).
 */
export async function prepareOnServer(itemId: string, onProgress: (p: PrepareProgress) => void, signal?: AbortSignal): Promise<TrackStems> {
  const cancel = () => void karaokeApi.cancelOnServer(itemId).catch(() => {});
  signal?.addEventListener('abort', cancel);
  try {
    let t = await karaokeApi.prepareOnServer(itemId);
    for (;;) {
      if (t.job) onProgress({ phase: t.job.phase, done: t.job.done, total: t.job.total, backend: t.job.backend, position: t.job.position, where: 'server' });
      else if (t.ready) return t;
      else throw new Error(t.error || 'The server stopped separating this track');
      await sleep(1000);
      if (signal?.aborted) throw abortError();
      t = await karaokeApi.trackStems(itemId);
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

/** Decode the track (server-side converted to 44.1 kHz stereo FLAC) into two Float32 channels. */
async function decode(itemId: string, signal?: AbortSignal) {
  const res = await fetch(withToken(`${API_BASE}/items/${encodeURIComponent(itemId)}/stems/source`), { signal });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? `HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  const ctx = new OfflineAudioContext(2, 1, MODEL_RATE);
  const buf = await ctx.decodeAudioData(ab);
  const left = new Float32Array(buf.getChannelData(0));
  const right = buf.numberOfChannels > 1 ? new Float32Array(buf.getChannelData(1)) : null;
  return { left, right, length: buf.length };
}

/**
 * Separate and upload. `stub` runs a deterministic band-splitting stand-in instead of the model (tests / demos).
 * Rejects with an AbortError when `signal` aborts.
 */
export async function prepareStems(itemId: string, onProgress: (p: PrepareProgress) => void, { signal, stub = false }: { signal?: AbortSignal; stub?: boolean } = {}): Promise<TrackStems> {
  if (!stub && (await karaokeApi.stemsStatus()).engine === 'server') return prepareOnServer(itemId, onProgress, signal);
  const st = stub ? null : await ensureModel(onProgress, signal);
  onProgress({ phase: 'decoding', done: 0, total: 0 });
  const audio = await decode(itemId, signal);
  if (signal?.aborted) throw abortError();
  onProgress({ phase: 'loading-model', done: 0, total: 0 });
  const w = new Worker(new URL('./stems.worker.ts', import.meta.url), { type: 'module' });
  const kill = () => w.terminate();
  signal?.addEventListener('abort', kill);
  let token: string | null = null;
  try {
    const ready = await new Promise<{ backend: string }>((resolve, reject) => {
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') resolve(m);
        else if (m.type === 'model-progress') onProgress({ phase: 'loading-model', done: m.received, total: m.total });
        else if (m.type === 'error') reject(new Error(m.message));
      };
      w.onerror = (e) => reject(new Error(e.message || 'The separation worker failed to start'));
      signal?.addEventListener('abort', () => reject(abortError()));
      const hc = navigator.hardwareConcurrency || 2;
      w.postMessage({
        type: 'init', stub,
        ortBase: new URL(karaokeApi.ortBase(), location.href).href,
        modelUrl: new URL(karaokeApi.modelUrl(), location.href).href,
        threads: Math.max(1, Math.min(4, hc - 2)),
        backend: 'auto',
      });
    });
    const model = stub ? 'stub-bands' : st?.model?.id ?? 'model';
    token = (await karaokeApi.beginStems(itemId, { model, sampleRate: MODEL_RATE, frames: audio.length, backend: ready.backend })).token;
    const tk = token;
    let uploads = Promise.resolve();
    let uploadError: Error | null = null;
    await new Promise<void>((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(abortError()));
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') onProgress({ phase: 'separating', done: m.done, total: m.total, backend: ready.backend });
        else if (m.type === 'block') {
          uploads = uploads
            .then(async () => {
              if (uploadError) return;
              for (let s = 0; s < STEMS.length; s++) await karaokeApi.putStemPart(itemId, tk, STEMS[s], m.frame, m.stems[s]);
            })
            .catch((err) => {
              uploadError = err;
              reject(err);
            });
        } else if (m.type === 'done') resolve();
        else if (m.type === 'error') reject(new Error(m.message));
      };
      const transfer = [audio.left.buffer, ...(audio.right ? [audio.right.buffer] : [])];
      w.postMessage({ type: 'separate', id: itemId, left: audio.left, right: audio.right, length: audio.length, overlap: 0.25 }, transfer);
    });
    onProgress({ phase: 'saving', done: 0, total: 0 });
    await uploads;
    if (uploadError) throw uploadError;
    return await karaokeApi.finishStems(itemId, tk);
  } catch (e) {
    if (token) karaokeApi.deleteStems(itemId).catch(() => {});
    throw e;
  } finally {
    signal?.removeEventListener('abort', kill);
    w.terminate();
  }
}
