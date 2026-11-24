/**
 * onnxruntime-node (the native AI runtime the server's stem separation uses) is not installed with Vibe: the npm
 * package is ~300 MB with the binaries of every platform, and only servers that turn AI karaoke on need it. The first
 * time it is needed, the server downloads the pinned npm tarballs of onnxruntime-node and its only runtime dependency
 * onnxruntime-common, checks each against the SHA-512 integrity hash from the npm registry, and keeps only the
 * JavaScript and the binaries for this platform (bin/napi-v6/<platform>/<arch>/) under
 * `<data>/stems/ort-node/<version>/node_modules/`. Files are extracted into a temporary folder and moved into place
 * only after both hashes match, so a bad or tampered download is never loaded.
 *
 * Builds exist for Windows x64 / arm64 (with DirectML for the GPU), Linux x64 / arm64 (glibc) and macOS arm64
 * (CoreML). Elsewhere the browser separates instead (web/src/stems/). MEDIAMAX_ORT_NODE_DIR may point at a folder
 * holding node_modules/onnxruntime-node (air-gapped servers), and an onnxruntime-node installed next to Vibe by hand
 * is used too.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Readable, Transform, type Writable } from 'node:stream';
import { config } from '../config.js';
import { logger } from '../util/log.js';
import { extractTar } from './stems.js';

const log = logger('ort-node');

export const ORT_NODE_VERSION = '1.31.1';
/** npm tarballs and their integrity (sha512, base64) as published on registry.npmjs.org. */
export const ORT_NODE_PACKAGES = [
  {
    name: 'onnxruntime-node',
    url: `https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-${ORT_NODE_VERSION}.tgz`,
    integrity: 'sha512-ijnSghbDHVWaQ2nDPmVccPlCHI8kH1Mx1aJ4a/qzRP16bBcVs4E3EqZQKZCkhWnbqN1tuQWxagimFtDpbPYYQw==',
  },
  {
    name: 'onnxruntime-common',
    url: `https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-${ORT_NODE_VERSION}.tgz`,
    integrity: 'sha512-F+nnYNiQtmNJ95V6R/isBJqiVpdANCrsMEg1OaF+Bkbl3GAtzWLR7Ng17Ld0QtYtYJyotOHPJzOQn1Y6PLZjpg==',
  },
] as const;
const MAX_BYTES = 400 * 1024 * 1024;

/** Platforms onnxruntime-node ships binaries for. */
const BUILDS: Record<string, string[]> = { win32: ['x64', 'arm64'], linux: ['x64', 'arm64'], darwin: ['arm64'] };

/** Why this platform can't run onnxruntime-node, or null when it can. */
export function platformUnsupported(platform: string = process.platform, arch: string = process.arch, glibc: boolean = isGlibc()): string | null {
  if (!BUILDS[platform]?.includes(arch)) return `No native AI runtime build for ${platform}/${arch}`;
  if (platform === 'linux' && !glibc) return 'The native AI runtime needs glibc (this Linux uses musl, e.g. Alpine)';
  return null;
}
function isGlibc(): boolean {
  if (process.platform !== 'linux') return true;
  const r = (process.report?.getReport?.() ?? {}) as { header?: { glibcVersionRuntime?: string } };
  return !!r.header?.glibcVersionRuntime;
}

export interface OrtNodeState {
  state: 'idle' | 'downloading' | 'ready' | 'error' | 'unsupported';
  received: number;
  total: number;
  error: string | null;
  version: string;
}

export const ortNodeDir = (dataDir = config.dataDir) => path.join(dataDir, 'stems', 'ort-node', ORT_NODE_VERSION);
const isReady = (dir: string) =>
  fs.existsSync(path.join(dir, '.complete')) && fs.existsSync(path.join(dir, 'node_modules', 'onnxruntime-node', 'package.json'));

/**
 * Archive member → path to keep (relative to the package folder), or null to skip. Keeps package.json, the compiled
 * JavaScript (dist/, without source maps and type declarations) and, for onnxruntime-node, this platform's binaries.
 */
export function keepMember(pkg: string, name: string, platform: string = process.platform, arch: string = process.arch): string | null {
  if (!name.startsWith('package/') || name.includes('..') || name.endsWith('/')) return null;
  const rel = name.slice('package/'.length);
  if (rel === 'package.json' || rel === 'LICENSE' || rel === 'LICENSE.txt') return rel;
  if (rel.startsWith('dist/') && /\.(c?js|mjs|json)$/.test(rel)) return rel;
  const bin = `bin/napi-v6/${platform}/${arch}/`;
  if (pkg === 'onnxruntime-node' && rel.startsWith(bin) && !rel.slice(bin.length).includes('/')) return rel;
  return null;
}

const finished = (s: Writable) =>
  new Promise<void>((resolve, reject) => {
    s.once('finish', () => resolve());
    s.once('error', reject);
  });

export function createOrtNodeRuntime({ dataDir = config.dataDir, fetchImpl = globalThis.fetch, packages = ORT_NODE_PACKAGES as readonly { name: string; url: string; integrity: string }[], unsupported = platformUnsupported() } = {}) {
  const dir = ortNodeDir(dataDir);
  let current: Promise<void> | null = null;
  const st: OrtNodeState = { state: unsupported ? 'unsupported' : isReady(dir) ? 'ready' : 'idle', received: 0, total: 0, error: unsupported, version: ORT_NODE_VERSION };

  async function fetchPackage(pkg: { name: string; url: string; integrity: string }, into: string) {
    const dash = pkg.integrity.indexOf('-');
    if (pkg.integrity.slice(0, dash) !== 'sha512') throw new Error('Invalid integrity value');
    const expected = pkg.integrity.slice(dash + 1);
    const res = await fetchImpl(pkg.url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Download of ${pkg.name} failed (HTTP ${res.status})`);
    st.total += Number(res.headers.get('content-length')) || 0;
    const hash = crypto.createHash('sha512');
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        st.received += chunk.length;
        if (st.received > MAX_BYTES) return cb(new Error('Download is larger than expected'));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    const writers: Promise<void>[] = [];
    let open: Writable | null = null;
    const closeOpen = () => {
      open?.end();
      open = null;
    };
    try {
      const gunzip = Readable.fromWeb(res.body as never).pipe(counter).pipe(zlib.createGunzip());
      await extractTar(gunzip as unknown as AsyncIterable<Buffer>, (name) => {
        closeOpen();
        const rel = keepMember(pkg.name, name);
        if (!rel) return null;
        const file = path.join(into, pkg.name, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const out = fs.createWriteStream(file);
        writers.push(finished(out));
        open = out;
        return out;
      });
      closeOpen();
      await Promise.all(writers);
    } catch (e) {
      closeOpen();
      await Promise.allSettled(writers);
      throw e;
    }
    if (hash.digest('base64') !== expected) throw new Error(`Download of ${pkg.name} is corrupt (SHA-512 mismatch)`);
  }

  async function download() {
    const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
    const mods = path.join(tmp, 'node_modules');
    await fs.promises.mkdir(mods, { recursive: true });
    try {
      for (const p of packages) await fetchPackage(p, mods);
      if (!fs.existsSync(path.join(mods, 'onnxruntime-node', 'package.json'))) throw new Error('Download did not contain the expected files');
      fs.writeFileSync(path.join(tmp, '.complete'), JSON.stringify({ version: ORT_NODE_VERSION, platform: process.platform, arch: process.arch, at: Date.now() }));
      await fs.promises.rm(dir, { recursive: true, force: true });
      await fs.promises.mkdir(path.dirname(dir), { recursive: true });
      await fs.promises.rename(tmp, dir);
      log.info(`onnxruntime-node ${ORT_NODE_VERSION} downloaded for AI stem separation (${process.platform}/${process.arch})`);
    } catch (e) {
      await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
  }

  return {
    dir,
    status(): OrtNodeState {
      if (st.state !== 'downloading' && st.state !== 'unsupported') st.state = isReady(dir) ? 'ready' : st.error ? 'error' : 'idle';
      return { ...st };
    },
    ready: () => !unsupported && isReady(dir),
    /** Starts the download if needed; resolves when the runtime is ready, rejects when the download fails. */
    ensure(): Promise<void> {
      if (unsupported) return Promise.reject(new Error(unsupported));
      if (isReady(dir)) return Promise.resolve();
      if (!current) {
        Object.assign(st, { state: 'downloading', received: 0, total: 0, error: null });
        current = download()
          .then(() => {
            st.state = 'ready';
          })
          .catch((e: Error) => {
            st.state = 'error';
            st.error = e.message;
            log.warn(`onnxruntime-node download failed: ${e.message}`);
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

let runtime: ReturnType<typeof createOrtNodeRuntime> | null = null;
export const ortNodeRuntime = () => (runtime ??= createOrtNodeRuntime());

/**
 * Where to load onnxruntime-node from: MEDIAMAX_ORT_NODE_DIR (a folder with node_modules/onnxruntime-node), the
 * downloaded copy, or a package installed by hand next to Vibe. Returns the module path to `require()` (the
 * separation process loads it) and its version, or null when none is there.
 */
export function findOrtNode(explicit = process.env.MEDIAMAX_ORT_NODE_DIR, dataDir = config.dataDir): { module: string; version: string } | null {
  const at = (base: string) => {
    try {
      const req = createRequire(path.join(base, 'noop.js'));
      const pkg = req.resolve('onnxruntime-node/package.json');
      return { module: req.resolve('onnxruntime-node'), version: String(JSON.parse(fs.readFileSync(pkg, 'utf8')).version) };
    } catch {
      return null;
    }
  };
  if (explicit) return at(path.resolve(explicit));
  const d = ortNodeDir(dataDir);
  if (isReady(d)) {
    const r = at(d);
    if (r) return r;
  }
  return at(path.dirname(fileURLToPath(import.meta.url)));
}
