/**
 * Sentence embeddings for Ask's semantic matching.
 *  - 'local': all-MiniLM-L6-v2 (quantised ONNX, ~23 MB, 384 dims, English) downloaded on first use and run with the
 *    onnxruntime-web WebAssembly build that AI karaoke already downloads (it runs in Node too). ~10-30 ms per text on
 *    a CPU, single thread.
 *  - 'api': the language-model server's embeddings endpoint (Ollama /api/embed or OpenAI-compatible /embeddings),
 *    e.g. a multilingual model such as "nomic-embed-text" or "bge-m3" (better for Romanian queries).
 * Plus the "Build search embeddings" task that fills item_embeddings for movies and shows.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { db } from '../../db.js';
import { config } from '../../config.js';
import { logger } from '../../util/log.js';
import { aiSettings, llmEmbed } from '../ai/llm.js';
import { ortRuntime } from '../ortRuntime.js';
import { storeVector, vectorCount, markVectorsDirty } from './vectors.js';

const log = logger('ask');

export const LOCAL_MODEL_ID = 'minilm-l6-v2';
const LOCAL_FILES = {
  model: { url: 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx', name: 'model_quantized.onnx', maxMb: 60 },
  vocab: { url: 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/vocab.txt', name: 'vocab.txt', maxMb: 2 },
};
export const localModelDir = () => path.join(config.dataDir, 'ai', 'embeddings', LOCAL_MODEL_ID);

/** Model id the vectors are stored under for the current settings (vectors of other models are ignored). */
export function currentModelId(): string | null {
  const a = aiSettings().ask;
  if (a.embeddingSource === 'api') return a.embeddingModel ? `api:${a.embeddingModel}` : null;
  return LOCAL_MODEL_ID;
}

/* ------------------------------ tokenizer ------------------------------ */

/** BERT WordPiece (uncased): lower case, strip accents, split punctuation, greedy longest-match sub-words. */
export class WordPiece {
  private vocab = new Map<string, number>();
  constructor(vocabText: string, private maxLen = 128) {
    vocabText.split(/\r?\n/).forEach((t, i) => t && this.vocab.set(t, i));
  }
  private id = (t: string) => this.vocab.get(t) ?? this.vocab.get('[UNK]') ?? 100;
  basic(text: string): string[] {
    const t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\u0000-\u001f]/g, ' ');
    return t.split(/\s+/).flatMap((w) => w.split(/([\p{P}\p{S}])/u)).filter((w) => w && w.trim());
  }
  encode(text: string): number[] {
    const ids = [this.id('[CLS]')];
    for (const word of this.basic(text)) {
      if (word.length > 100) {
        ids.push(this.id('[UNK]'));
        continue;
      }
      const pieces: number[] = [];
      let start = 0;
      let bad = false;
      while (start < word.length) {
        let end = word.length;
        let found: number | undefined;
        while (start < end) {
          const sub = (start > 0 ? '##' : '') + word.slice(start, end);
          found = this.vocab.get(sub);
          if (found !== undefined) break;
          end--;
        }
        if (found === undefined) {
          bad = true;
          break;
        }
        pieces.push(found);
        start = end;
      }
      ids.push(...(bad ? [this.id('[UNK]')] : pieces));
      if (ids.length >= this.maxLen - 1) break;
    }
    return [...ids.slice(0, this.maxLen - 1), this.id('[SEP]')];
  }
}

/** Mean of token vectors where the attention mask is 1. */
export function meanPool(hidden: Float32Array, tokens: number, dims: number): Float32Array {
  const out = new Float32Array(dims);
  for (let t = 0; t < tokens; t++) for (let d = 0; d < dims; d++) out[d] += hidden[t * dims + d];
  for (let d = 0; d < dims; d++) out[d] /= Math.max(1, tokens);
  return out;
}

/* ------------------------------ local model ------------------------------ */

let local: Promise<{ run: (text: string) => Promise<Float32Array> }> | null = null;
let localError: string | null = null;
export const localEmbedError = () => localError;

async function download(url: string, dest: string, maxMb: number) {
  if (fs.existsSync(dest)) return;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}) for ${path.basename(dest)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxMb * 1024 * 1024 || buf.length < 1000) throw new Error(`Unexpected size for ${path.basename(dest)}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(`${dest}.part`, buf);
  fs.renameSync(`${dest}.part`, dest);
  fs.writeFileSync(`${dest}.sha256`, crypto.createHash('sha256').update(buf).digest('hex'));
}

function loadLocal() {
  return (local ??= (async () => {
    const dir = localModelDir();
    await download(LOCAL_FILES.vocab.url, path.join(dir, LOCAL_FILES.vocab.name), LOCAL_FILES.vocab.maxMb);
    await download(LOCAL_FILES.model.url, path.join(dir, LOCAL_FILES.model.name), LOCAL_FILES.model.maxMb);
    const rt = ortRuntime();
    await rt.ensure();
    const ort = await import(pathToFileURL(path.join(rt.dir, 'ort.wasm.min.mjs')).href);
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = `${rt.dir}${path.sep}`;
    ort.env.logLevel = 'error';
    const session = await ort.InferenceSession.create(fs.readFileSync(path.join(dir, LOCAL_FILES.model.name)));
    const tok = new WordPiece(fs.readFileSync(path.join(dir, LOCAL_FILES.vocab.name), 'utf8'));
    const needsTypes = session.inputNames.includes('token_type_ids');
    return {
      run: async (text: string) => {
        const ids = tok.encode(text);
        const n = ids.length;
        const feeds: Record<string, unknown> = {
          input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, n]),
          attention_mask: new ort.Tensor('int64', new BigInt64Array(n).fill(1n), [1, n]),
        };
        if (needsTypes) feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(n), [1, n]);
        const out = await session.run(feeds);
        const t = out.last_hidden_state ?? out[session.outputNames[0]];
        return meanPool(t.data as Float32Array, n, t.dims[2]);
      },
    };
  })().catch((e: Error) => {
    local = null;
    localError = e.message;
    throw e;
  }));
}

/** Embed texts with the configured source. Null when embeddings are off / unavailable. */
export async function embedTexts(texts: string[]): Promise<Float32Array[] | null> {
  const a = aiSettings().ask;
  if (!texts.length) return [];
  if (a.embeddingSource === 'api') return llmEmbed(texts, a.embeddingModel);
  try {
    const m = await loadLocal();
    const out: Float32Array[] = [];
    for (const t of texts) out.push(await m.run(t));
    localError = null;
    return out;
  } catch (e) {
    log.warn(`Local embeddings unavailable: ${(e as Error).message}`);
    return null;
  }
}

/* ------------------------------ build task ------------------------------ */

export function itemText(r: { title: string; tagline: string | null; overview: string | null; genres: string; year: number | null }): string {
  let genres = '';
  try {
    genres = (JSON.parse(r.genres || '[]') as string[]).join(', ');
  } catch {
    /* ignore */
  }
  return [r.title + (r.year ? ` (${r.year})` : ''), r.tagline, genres, r.overview].filter(Boolean).join('. ').slice(0, 1200);
}

export const embeddingsEnabled = () => aiSettings().features.ask && aiSettings().ask.embeddings && !!currentModelId();

export function embeddingProgress(): { count: number; total: number } {
  const model = currentModelId();
  const total = db.get<{ n: number }>("SELECT COUNT(*) n FROM items WHERE type IN ('movie','show') AND overview IS NOT NULL")?.n ?? 0;
  return { count: model ? vectorCount(model) : 0, total };
}

/** Embed movies/shows that have no vector for the current model (or whose text changed). Resumable by nature. */
export async function buildEmbeddings(progress: (p: number) => void = () => {}, embed = embedTexts, limit = 100_000): Promise<number> {
  const model = currentModelId();
  if (!model) return 0;
  const rows = db.all<{ id: string; title: string; tagline: string | null; overview: string | null; genres: string; year: number | null; hash: string | null }>(
    `SELECT i.id, i.title, i.tagline, i.overview, i.genres, i.year, e.hash FROM items i LEFT JOIN item_embeddings e ON e.item_id = i.id AND e.model = ?
     WHERE i.type IN ('movie','show') AND i.overview IS NOT NULL LIMIT ?`, model, limit);
  const todo = rows.map((r) => ({ r, text: itemText(r) })).map((x) => ({ ...x, hash: crypto.createHash('sha1').update(x.text).digest('hex').slice(0, 16) })).filter((x) => x.hash !== x.r.hash);
  let done = 0;
  for (let i = 0; i < todo.length; i += 16) {
    const batch = todo.slice(i, i + 16);
    const vecs = await embed(batch.map((b) => b.text));
    if (!vecs) throw new Error(localError ?? 'The embedding model is not available');
    batch.forEach((b, k) => vecs[k] && storeVector(b.r.id, model, b.hash, vecs[k]));
    done += batch.length;
    progress(Math.round((done / todo.length) * 100));
    // Yield so requests keep flowing while a big library is embedded.
    await new Promise((r) => setImmediate(r));
  }
  if (done) markVectorsDirty();
  log.info(`Search embeddings: ${done} item(s) updated (${model})`);
  return done;
}
