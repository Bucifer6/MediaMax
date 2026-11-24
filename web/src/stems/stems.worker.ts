/// <reference lib="webworker" />
/**
 * Stem separation worker: ONNX Runtime Web (WebGPU when available, else WASM) runs HT-Demucs chunk by chunk.
 * Finished audio is posted back block by block as Int16 (the page uploads it to the server), so neither the UI
 * thread nor the audio thread does heavy work and a long track never sits in memory as four float stems.
 * onnxruntime-web is loaded at run time from the Vibe server (/api/v1/stems/ort/, same origin), not bundled.
 *
 * in : { type: 'init', ortBase, modelUrl, threads, backend: 'auto'|'webgpu'|'wasm', stub }
 *      { type: 'separate', id, left, right, length, overlap }
 * out: { type: 'model-progress', received, total } { type: 'ready', backend, threads, kind, loadMs }
 *      { type: 'progress', id, done, total } { type: 'block', id, frame, frames, stems: Int16Array[4] (STEMS order) }
 *      { type: 'done', id, ms, chunks } { type: 'error', id?, message }
 * Adapted from OpenDJ (MIT, github.com/Bucifer6/OpenDJ) — public/js/stems/stems-worker.js.
 */
import { DEMUCS_SOURCES, interleaveInt16, separateChunked, STEMS } from './dsp.js';
import { createRunner, createStubSession, StubTensor, type Runner, type TensorCtor } from './model.js';

declare const self: DedicatedWorkerGlobalScope;
let runner: Runner | null = null;
let info: { backend: string; threads: number; kind: string } | null = null;
const order = STEMS.map((n) => (DEMUCS_SOURCES as readonly string[]).indexOf(n));

async function fetchModel(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Model: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const out = new Uint8Array(total);
  let got = 0, last = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.set(value, got);
    got += value.length;
    if (got - last > 4e6) {
      last = got;
      self.postMessage({ type: 'model-progress', received: got, total });
    }
  }
  return got === total ? out : out.subarray(0, got);
}

async function init(m: { ortBase: string; modelUrl: string; threads: number; backend: string; stub?: boolean }) {
  const t0 = performance.now();
  if (m.stub) {
    runner = createRunner(createStubSession(), StubTensor as unknown as TensorCtor);
    info = { backend: 'stub', threads: 1, kind: runner.kind };
  } else {
    const ort = await import(/* @vite-ignore */ `${m.ortBase}ort.webgpu.min.mjs`);
    ort.env.wasm.wasmPaths = m.ortBase;
    // Multi-threaded WASM needs SharedArrayBuffer, i.e. a cross-origin isolated page.
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, m.threads || 1) : 1;
    ort.env.logLevel = 'error';
    const bytes = await fetchModel(m.modelUrl);
    const opts = { graphOptimizationLevel: 'all' };
    let session = null;
    let backend = 'wasm';
    const nav = navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } };
    const gpuOk = m.backend !== 'wasm' && !!nav.gpu && (await nav.gpu.requestAdapter().then((a) => !!a, () => false));
    if (gpuOk) {
      try {
        session = await ort.InferenceSession.create(bytes, { ...opts, executionProviders: ['webgpu'] });
        backend = 'webgpu';
      } catch (e) {
        console.warn('[stems] WebGPU unavailable, using WASM:', (e as Error).message);
      }
    }
    if (!session) session = await ort.InferenceSession.create(bytes, { ...opts, executionProviders: ['wasm'] });
    runner = createRunner(session, ort.Tensor);
    info = { backend, threads: backend === 'wasm' ? ort.env.wasm.numThreads : 0, kind: runner.kind };
  }
  self.postMessage({ type: 'ready', ...info, loadMs: Math.round(performance.now() - t0) });
}

async function separate(m: { id: string; left: Float32Array; right: Float32Array | null; length: number; overlap?: number }) {
  if (!runner) throw new Error('Model not loaded');
  const r = runner;
  const t0 = performance.now();
  const res = await separateChunked({
    channels: [m.left, m.right || m.left], length: m.length, segment: r.segment, overlap: m.overlap ?? 0.25, sources: r.sources.length,
    runChunk: r.runChunk,
    onProgress: (done, total) => self.postMessage({ type: 'progress', id: m.id, done, total }),
    onBlock: ({ frame, frames, data }) => {
      const stems = order.map((k) => interleaveInt16(data, 2, frames, k * 2 * frames));
      self.postMessage({ type: 'block', id: m.id, frame, frames, stems }, stems.map((s) => s.buffer));
    },
  });
  self.postMessage({ type: 'done', id: m.id, ms: Math.round(performance.now() - t0), chunks: res.chunks, ...info });
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.type === 'init') await init(m);
    else if (m.type === 'separate') await separate(m);
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: (err as Error)?.message || String(err) });
  }
};
