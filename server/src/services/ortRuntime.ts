/**
 * onnxruntime-web (the browser runtime for AI stem separation) is not installed with Kinora: it is ~150 MB and only
 * needed by servers that turn AI karaoke on. The first time it is needed, the server downloads the pinned npm tarball,
 * checks it against the SHA-512 integrity hash from package-lock.json, and keeps only the browser files
 * (`package/dist/ort*.mjs|wasm`) under `<data>/stems/ort/<version>/`. Files are extracted into a temporary folder and
 * moved into place only after the hash matches, so a bad or tampered download is never served.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { Readable, Transform, type Writable } from 'node:stream';
import { config } from '../config.js';
import { logger } from '../util/log.js';
import { extractTar } from './stems.js';

const log = logger('ort');

export const ORT_VERSION = '1.23.2';
export const ORT_URL = `https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-${ORT_VERSION}.tgz`;
/** npm integrity of the tarball above (sha512, base64), as recorded in package-lock.json. */
export const ORT_INTEGRITY = 'sha512-T09JUtMn+CZLk3mFwqiH0lgQf+4S7+oYHHtk6uhaYAAJI95bTcKi5bOOZYwORXfS/RLZCjDDEXGWIuOCAFlEjg==';
const MAX_BYTES = 200 * 1024 * 1024;
/** Browser files we keep: dist/ort*.mjs and dist/ort*.wasm (top level of dist only). */
const KEEP = /^package\/dist\/(ort[\w.-]*\.(?:mjs|wasm))$/;

export interface OrtDownloadState {
  state: 'idle' | 'downloading' | 'ready' | 'error';
  received: number;
  total: number;
  error: string | null;
  version: string;
}

export const ortRuntimeDir = (dataDir = config.dataDir) => path.join(dataDir, 'stems', 'ort', ORT_VERSION);
const isReady = (dir: string) => fs.existsSync(path.join(dir, '.complete')) && fs.existsSync(path.join(dir, 'ort.webgpu.min.mjs'));

const finished = (s: Writable) =>
  new Promise<void>((resolve, reject) => {
    s.once('finish', () => resolve());
    s.once('error', reject);
  });

export function createOrtRuntime({ dataDir = config.dataDir, fetchImpl = globalThis.fetch, url = ORT_URL, integrity = ORT_INTEGRITY } = {}) {
  const dir = ortRuntimeDir(dataDir);
  let current: Promise<void> | null = null;
  const st: OrtDownloadState = { state: isReady(dir) ? 'ready' : 'idle', received: 0, total: 0, error: null, version: ORT_VERSION };

  async function download() {
    const dash = integrity.indexOf('-');
    const algo = integrity.slice(0, dash);
    const expected = integrity.slice(dash + 1);
    if (algo !== 'sha512' || !expected) throw new Error('Invalid integrity value');
    const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
    await fs.promises.mkdir(tmp, { recursive: true });
    const writers: Promise<void>[] = [];
    let open: Writable | null = null;
    const closeOpen = () => {
      open?.end();
      open = null;
    };
    try {
      const res = await fetchImpl(url, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
      st.total = Number(res.headers.get('content-length')) || 0;
      if (st.total > MAX_BYTES) throw new Error('Download is larger than expected');
      const hash = crypto.createHash('sha512');
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          st.received += chunk.length;
          if (st.received > MAX_BYTES) return cb(new Error('Download is larger than expected'));
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      const gunzip = Readable.fromWeb(res.body as never).pipe(counter).pipe(zlib.createGunzip());
      // extractTar writes an entry's whole body before asking about the next one, so the previous file is complete
      // whenever pick() is called again.
      await extractTar(gunzip as unknown as AsyncIterable<Buffer>, (name) => {
        closeOpen();
        const m = KEEP.exec(name);
        if (!m) return null;
        const out = fs.createWriteStream(path.join(tmp, path.basename(m[1])));
        writers.push(finished(out));
        open = out;
        return out;
      });
      closeOpen();
      await Promise.all(writers);
      const got = hash.digest('base64');
      if (got !== expected) throw new Error('Download is corrupt (SHA-512 mismatch)');
      if (!fs.existsSync(path.join(tmp, 'ort.webgpu.min.mjs'))) throw new Error('Download did not contain the expected files');
      fs.writeFileSync(path.join(tmp, '.complete'), JSON.stringify({ version: ORT_VERSION, integrity, at: Date.now() }));
      await fs.promises.rm(dir, { recursive: true, force: true });
      await fs.promises.mkdir(path.dirname(dir), { recursive: true });
      await fs.promises.rename(tmp, dir);
      log.info(`onnxruntime-web ${ORT_VERSION} downloaded for AI karaoke`);
    } catch (e) {
      closeOpen();
      await Promise.allSettled(writers);
      await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
  }

  return {
    dir,
    status(): OrtDownloadState {
      if (st.state !== 'downloading') st.state = isReady(dir) ? 'ready' : st.error ? 'error' : 'idle';
      return { ...st };
    },
    /** Starts the download if needed; resolves when the runtime is ready, rejects when the download fails. */
    ensure(): Promise<void> {
      if (isReady(dir)) return Promise.resolve();
      if (!current) {
        st.state = 'downloading';
        st.received = 0;
        st.total = 0;
        st.error = null;
        current = download()
          .then(() => {
            st.state = 'ready';
          })
          .catch((e: Error) => {
            st.state = 'error';
            st.error = e.message;
            log.warn(`onnxruntime-web download failed: ${e.message}`);
            throw e;
          })
          .finally(() => {
            current = null;
          });
      }
      return current;
    },
  };
}

let runtime: ReturnType<typeof createOrtRuntime> | null = null;
export const ortRuntime = () => (runtime ??= createOrtRuntime());
