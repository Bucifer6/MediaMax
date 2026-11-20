/**
 * Prepare AI karaoke stems for a track in this browser: make sure the server has the model, decode the track at
 * 44.1 kHz, run HT-Demucs in a Web Worker (WebGPU or WASM), and upload the stems block by block. Afterwards every
 * device can play the server's karaoke mix. Adapted from OpenDJ (MIT, github.com/Bucifer6/OpenDJ) — stems.js.
 */
import type { StemsStatus, TrackStems } from '@mediamax/shared';
import { karaokeApi } from '../api/karaoke';
import { API_BASE, withToken } from '../api/client';
import { MODEL_RATE, STEMS } from './dsp';

export type PreparePhase = 'model-download' | 'decoding' | 'loading-model' | 'separating' | 'saving';
export interface PrepareProgress {
  phase: PreparePhase;
  done: number;
  total: number;
  backend?: string;
}

const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Download the model to the server if needed, reporting progress. */
export async function ensureModel(onProgress: (p: PrepareProgress) => void, signal?: AbortSignal): Promise<StemsStatus> {
  let st = await karaokeApi.stemsStatus();
  if (!st.enabled) throw new Error('AI stem separation is turned off on this server');
  if (!st.ort) throw new Error('The server is missing onnxruntime-web (an optional npm package)');
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
