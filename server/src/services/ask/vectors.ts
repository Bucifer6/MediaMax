/**
 * Semantic search vectors: float32 embeddings of plots/taglines stored as SQLite blobs (item_embeddings), searched by
 * brute-force cosine in a worker thread so the event loop never blocks (80k × 384 dims ≈ 30M multiply-adds, ~30 ms).
 * Vectors are L2-normalised when stored, so cosine = dot product.
 */
import { Worker } from 'node:worker_threads';
import { db } from '../../db.js';

export function normalise(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

export const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
export const fromBlob = (b: Uint8Array) => {
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
};

export function storeVector(itemId: string, model: string, hash: string, v: Float32Array) {
  const n = normalise(v);
  db.upsert('item_embeddings', { item_id: itemId, model, hash, dims: n.length, vec: toBlob(n), updated_at: new Date().toISOString() }, 'item_id');
  dirty = true;
}

export const vectorCount = (model: string) => db.get<{ n: number }>('SELECT COUNT(*) n FROM item_embeddings WHERE model = ?', model)?.n ?? 0;

/* ------------------------------ worker ------------------------------ */

// Plain JS so it runs from both the TypeScript sources (tests) and the build without a separate file.
const WORKER_SRC = `
const { parentPort } = require('node:worker_threads');
let ids = [], index = new Map(), dims = 0, mat = new Float32Array(0);
parentPort.on('message', (m) => {
  if (m.type === 'load') {
    ids = m.ids; dims = m.dims; mat = new Float32Array(m.buffer);
    index = new Map(ids.map((id, i) => [id, i]));
    parentPort.postMessage({ id: m.id, ok: true });
    return;
  }
  if (m.type === 'query') {
    const q = new Float32Array(m.vec);
    const rows = m.candidates ? m.candidates.map((id) => index.get(id)).filter((i) => i !== undefined) : null;
    const n = rows ? rows.length : ids.length;
    const k = Math.min(m.k, n);
    const top = [];
    let min = -Infinity;
    for (let r = 0; r < n; r++) {
      const i = rows ? rows[r] : r;
      const off = i * dims;
      let s = 0;
      for (let d = 0; d < dims; d++) s += mat[off + d] * q[d];
      if (top.length < k) { top.push([i, s]); if (top.length === k) { top.sort((a, b) => a[1] - b[1]); min = top[0][1]; } }
      else if (s > min) { top[0] = [i, s]; top.sort((a, b) => a[1] - b[1]); min = top[0][1]; }
    }
    top.sort((a, b) => b[1] - a[1]);
    parentPort.postMessage({ id: m.id, hits: top.map(([i, s]) => [ids[i], s]) });
  }
});`;

let worker: Worker | null = null;
let loadedModel: string | null = null;
let dirty = true;
let seq = 0;
const pending = new Map<number, (v: any) => void>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(WORKER_SRC, { eval: true });
  worker.unref();
  worker.on('message', (m: { id: number }) => {
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  });
  worker.on('error', () => {
    worker = null;
    loadedModel = null;
    for (const r of pending.values()) r({ hits: [] });
    pending.clear();
  });
  return worker;
}

function call<T>(msg: Record<string, unknown>, transfer: ArrayBuffer[] = []): Promise<T> {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    getWorker().postMessage({ ...msg, id }, transfer);
  });
}

/** (Re)load every vector of `model` into the worker when the table changed. */
async function ensureLoaded(model: string): Promise<number> {
  if (!dirty && loadedModel === model) return -1;
  const rows = db.all<{ item_id: string; dims: number; vec: Uint8Array }>('SELECT item_id, dims, vec FROM item_embeddings WHERE model = ?', model);
  const dims = rows[0]?.dims ?? 0;
  const ok = rows.filter((r) => r.dims === dims && r.vec.byteLength === dims * 4);
  const buf = new Float32Array(ok.length * dims);
  ok.forEach((r, i) => buf.set(fromBlob(r.vec), i * dims));
  await call({ type: 'load', ids: ok.map((r) => r.item_id), dims, buffer: buf.buffer }, [buf.buffer]);
  loadedModel = model;
  dirty = false;
  return ok.length;
}

/** Top-k most similar items (cosine), optionally only among `candidates`. */
export async function searchVectors(model: string, query: Float32Array, k = 200, candidates?: string[]): Promise<Map<string, number>> {
  await ensureLoaded(model);
  const q = normalise(query);
  const r = await call<{ hits: [string, number][] }>({ type: 'query', vec: q.buffer, k, candidates: candidates ?? null }, [q.buffer as ArrayBuffer]);
  return new Map(r.hits);
}

/** Stored vector of one item (for "like <title>"). */
export function itemVector(itemId: string, model: string): Float32Array | null {
  const r = db.get<{ vec: Uint8Array }>('SELECT vec FROM item_embeddings WHERE item_id = ? AND model = ?', itemId, model);
  return r ? fromBlob(r.vec) : null;
}

export const markVectorsDirty = () => {
  dirty = true;
};

export async function closeVectorWorker() {
  await worker?.terminate();
  worker = null;
  loadedModel = null;
}
