/**
 * Karaoke stems: AI model download/cache, onnxruntime-web files, the per-track stem cache and server-side mixes.
 *
 * Separation itself runs in an administrator's browser (web/src/stems/stems.worker.ts, onnxruntime-web, WebGPU or
 * WASM); the server only downloads/verifies the model, stores the stems the browser uploads, and renders mixes with
 * FFmpeg so any client — TVs and phones that can't run the model — can play "instrumental", "vocals only" or
 * "karaoke (vocals at x %)" as an ordinary seekable audio file.
 *
 *   <data>/stems/models/<sha256>.onnx(.json)          the downloaded model (verified)
 *   <data>/stems/<itemId>/{vocals,drums,bass,other}.flac + meta.json
 *   <data>/stems/<itemId>/mix-v<vocals>-i<inst>.mp3   rendered mixes (cached)
 *
 * Adapted from OpenDJ (MIT, github.com/Bucifer6/OpenDJ) — server/stems.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Transform, type Writable } from 'node:stream';
import type { KaraokeSettings, StemName, StemsModelStatus, TrackStems } from '@mediamax/shared';
import { config } from '../config.js';
import { logger } from '../util/log.js';
import { HttpError } from '../util/errors.js';

const log = logger('stems');

export const STEM_NAMES: StemName[] = ['vocals', 'drums', 'bass', 'other'];
export const STEM_RATE = 44100;
const ID_RE = /^[\w-]{1,64}$/;
const isHex64 = (s: unknown) => /^[0-9a-f]{64}$/i.test(String(s ?? ''));
const MAX_MODEL_BYTES = 2 * 2 ** 30;

export class StemsError extends HttpError {
  constructor(msg: string, status = 400) {
    super(status, msg, 'stems');
  }
}

export interface ModelSpec {
  id: string;
  name: string;
  url: string;
  entry: string | null;
  sha256: string | null;
  archiveSha256: string | null;
  bytes: number | null;
  downloadBytes: number | null;
  licence: string;
  homepage: string | null;
  custom: boolean;
}

/**
 * Default model: HT-Demucs v4 (4 stems; Meta's facebookresearch/demucs, MIT) exported to ONNX with the STFT outside
 * the graph, as published in the npm package "demucs" 1.0.0 (github.com/bakkot/demucs-js). npm tarball URLs are
 * immutable; both the archive and the extracted model are SHA-256 checked. Same model and pins as OpenDJ.
 */
export const DEFAULT_MODEL: Readonly<ModelSpec> = Object.freeze({
  id: 'htdemucs-v4',
  name: 'HT-Demucs v4 (vocals, drums, bass, other)',
  url: 'https://registry.npmjs.org/demucs/-/demucs-1.0.0.tgz',
  archiveSha256: '83aadd00d48cd2a0c2e81e2a35616f4fa41a41f5c07efcc4a5c1959377b4ec42',
  entry: 'package/htdemucs.onnx',
  sha256: 'da9e5101ee0804d04933974b59d8aae9c862e80e14f2f24e7c74cae76bdbe748',
  bytes: 174263526,
  downloadBytes: 98176342,
  licence: 'Demucs (code and pretrained HT-Demucs weights) by Meta Platforms, MIT licence (facebookresearch/demucs). The ONNX export\'s packager notes the weights may be meant for personal and research use; check before commercial use.',
  homepage: 'https://github.com/facebookresearch/demucs',
  custom: false,
});

/** The model the settings ask for: the default, or { url[#entry], sha256 } from the admin settings. */
export function modelSpec(s: Partial<KaraokeSettings> = {}, fallback: Readonly<ModelSpec> = DEFAULT_MODEL): ModelSpec {
  const raw = String(s.stemsModelUrl ?? '').trim();
  if (!raw || raw === fallback.url) return { ...fallback };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new StemsError('The stems model URL is not valid');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new StemsError('The stems model URL must be http(s)');
  const entry = decodeURIComponent(u.hash.replace(/^#(entry=)?/, '')) || null; // archive member: https://…/x.tgz#package/model.onnx
  u.hash = '';
  const sha256 = isHex64(s.stemsModelSha256) ? String(s.stemsModelSha256).toLowerCase() : null;
  const archive = /\.(tgz|tar\.gz)$/i.test(u.pathname) || !!entry;
  return {
    id: 'custom', name: path.basename(entry || u.pathname) || 'Custom model', url: u.href, entry: archive ? entry : null,
    sha256, archiveSha256: null, bytes: null, downloadBytes: null, licence: 'Custom model: check its licence.', homepage: null, custom: true,
  };
}

/** Cache file name: the expected hash, or a hash of the URL for unpinned custom models (trust on first use). */
export const modelKey = (spec: ModelSpec) => spec.sha256 || `url-${crypto.createHash('sha256').update(spec.url + '#' + (spec.entry || '')).digest('hex').slice(0, 32)}`;

/** Streams a .tar (already gunzipped) and writes only `entry` to `out`. Handles the ustar prefix and pax paths. */
export async function extractTarEntry(readable: AsyncIterable<Buffer>, entry: string, out: Writable): Promise<boolean> {
  let buf: Buffer = Buffer.alloc(0);
  let state: 'header' | 'body' | 'pad' | 'end' = 'header';
  let remain = 0;
  let pad = 0;
  let current: 'want' | 'pax' | 'skip' | null = null;
  let paxPath: string | null = null;
  let found = false;
  let paxBody: Buffer[] = [];
  const want = entry.replace(/^\.\//, '');
  const str = (b: Buffer, a: number, n: number) => b.subarray(a, a + n).toString('utf8').replace(/\0.*$/s, '');
  for await (const chunk of readable) {
    if (state === 'end') continue; // drain
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (state === 'header') {
        if (buf.length < 512) break;
        const h = buf.subarray(0, 512);
        buf = buf.subarray(512);
        if (h.every((x) => x === 0)) {
          state = 'end';
          break;
        }
        const type = String.fromCharCode(h[156] || 48);
        const size = parseInt(str(h, 124, 12).trim() || '0', 8);
        const prefix = str(h, 257, 6).startsWith('ustar') ? str(h, 345, 155) : '';
        let name = (prefix ? prefix + '/' : '') + str(h, 0, 100);
        if (paxPath) {
          name = paxPath;
          paxPath = null;
        }
        remain = size;
        pad = (512 - (size % 512)) % 512;
        current = type === 'x' ? 'pax' : (type === '0' || type === '\0' || type === '7') && name.replace(/^\.\//, '') === want ? 'want' : 'skip';
        paxBody = [];
        state = 'body';
      }
      if (state === 'body') {
        if (remain > 0) {
          if (!buf.length) break;
          const n = Math.min(remain, buf.length);
          const part = buf.subarray(0, n);
          buf = buf.subarray(n);
          remain -= n;
          if (current === 'want') {
            found = true;
            if (!out.write(part)) await new Promise((r) => out.once('drain', r));
          } else if (current === 'pax') paxBody.push(Buffer.from(part));
          if (remain > 0) break;
        }
        if (current === 'pax') {
          const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(Buffer.concat(paxBody).toString('utf8'));
          if (m) paxPath = m[1];
        }
        state = 'pad';
      }
      if (state === 'pad') {
        if (buf.length < pad) {
          pad -= buf.length;
          buf = Buffer.alloc(0);
          break;
        }
        buf = buf.subarray(pad);
        pad = 0;
        state = 'header';
      }
    }
  }
  return found;
}

/** Minimal 16-bit PCM WAV header. */
export function wavHeader(dataBytes: number, sampleRate = STEM_RATE, channels = 2): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** onnxruntime-web's dist folder (MEDIAMAX_ORT_DIR overrides; null when the optional package is not installed). */
export function findOrtDir(explicit = process.env.MEDIAMAX_ORT_DIR): string | null {
  const ok = (d: string | null | undefined) => !!d && fs.existsSync(path.join(d, 'ort.webgpu.min.mjs'));
  if (explicit) return ok(explicit) ? path.resolve(explicit) : null;
  try {
    // The package's exports hide package.json; its main entry lives in dist/ next to the browser files.
    const main = createRequire(import.meta.url).resolve('onnxruntime-web');
    const d = path.dirname(main);
    return ok(d) ? d : null;
  } catch {
    return null;
  }
}
export const ortVersion = (dir: string | null) => {
  if (!dir) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, '..', 'package.json'), 'utf8')).version as string;
  } catch {
    return null;
  }
};

export function runFfmpeg(args: string[], bin = config.ffmpeg): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}: ${err.trim().split('\n').pop()}`))));
  });
}

/** Clamp a percent level to a cache-friendly step (5 %). */
export const mixLevel = (v: unknown, def: number) => {
  const n = v === undefined || v === null || v === '' ? def : Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n / 5) * 5)) : def;
};

/** FFmpeg filter that mixes the four stems: vocals × v, the instrumental stems × i (levels 0–100). */
export function mixFilter(vocals: number, inst: number): string {
  const g = (p: number) => (p / 100).toFixed(2);
  return `[0:a]volume=${g(vocals)}[v];[1:a]volume=${g(inst)}[d];[2:a]volume=${g(inst)}[b];[3:a]volume=${g(inst)}[o];[v][d][b][o]amix=inputs=4:normalize=0:duration=longest[out]`;
}

export interface StemStore {
  root: string;
  modelStatus(s: Partial<KaraokeSettings>): StemsModelStatus | null;
  modelFile(s: Partial<KaraokeSettings>): string | null;
  startDownload(s: Partial<KaraokeSettings>): { ready: boolean; started?: boolean; downloading?: { received: number; total: number } };
  /** Resolves when the download in progress (if any) ends. */
  downloadDone(): Promise<void>;
  cancelDownload(): void;
  deleteModel(s: Partial<KaraokeSettings>): Promise<void>;
  status(id: string): TrackStems;
  begin(id: string, body: { frames?: unknown; sampleRate?: unknown; model?: unknown; backend?: unknown }): Promise<{ token: string }>;
  part(id: string, token: string, stem: string, frame: number, body: Buffer): Promise<void>;
  finish(id: string, token: string): Promise<TrackStems>;
  remove(id: string): Promise<void>;
  stemFile(id: string, stem: string): string;
  mix(id: string, vocals: number, inst: number): Promise<string>;
  close(): void;
}

/** Open the stem store under `dataDir`. `fetchImpl` is injectable for tests. */
export function createStemStore({ dataDir = config.dataDir, fetchImpl = globalThis.fetch, ffmpeg = config.ffmpeg, defaultModel = DEFAULT_MODEL }: { dataDir?: string; fetchImpl?: typeof fetch; ffmpeg?: string; defaultModel?: Readonly<ModelSpec> } = {}): StemStore {
  const root = path.join(dataDir, 'stems');
  const modelsDir = path.join(root, 'models');
  fs.mkdirSync(modelsDir, { recursive: true });
  const trackDir = (id: string) => path.join(root, id);
  const checkId = (id: string) => {
    if (!ID_RE.test(id)) throw new StemsError('Bad track id');
    return id;
  };
  const spec = (s: Partial<KaraokeSettings>) => modelSpec(s, defaultModel);

  /* ---------------- model ---------------- */
  let download: { spec: ModelSpec; received: number; total: number; ctrl: AbortController; promise: Promise<void> } | null = null;
  let lastError: string | null = null;
  const modelPath = (sp: ModelSpec) => path.join(modelsDir, `${modelKey(sp)}.onnx`);
  const modelMeta = (sp: ModelSpec): { sha256: string; bytes: number } | null => {
    try {
      return JSON.parse(fs.readFileSync(modelPath(sp) + '.json', 'utf8'));
    } catch {
      return null;
    }
  };
  const modelReady = (sp: ModelSpec) => fs.existsSync(modelPath(sp)) && !!modelMeta(sp);

  async function fetchModel(sp: ModelSpec, ctrl: AbortController) {
    const target = modelPath(sp);
    const part = `${target}.${crypto.randomBytes(4).toString('hex')}.part`;
    try {
      const res = await fetchImpl(sp.url, { signal: ctrl.signal, redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`Model download failed: HTTP ${res.status}`);
      const len = Number(res.headers.get('content-length')) || 0;
      if (len > MAX_MODEL_BYTES) throw new Error('Model file is too large');
      if (len && download) download.total = len;
      const archiveHash = crypto.createHash('sha256');
      const fileHash = crypto.createHash('sha256');
      let fileBytes = 0;
      const out = fs.createWriteStream(part);
      const counted = async function* (body: AsyncIterable<Uint8Array>) {
        let got = 0;
        for await (const c of body) {
          const b = Buffer.from(c);
          got += b.length;
          if (download) download.received = got;
          archiveHash.update(b);
          if (got > MAX_MODEL_BYTES) throw new Error('Model file is too large');
          yield b;
        }
      };
      const hashOut = new Transform({
        transform(c, _e, cb) {
          fileHash.update(c);
          fileBytes += c.length;
          cb(null, c);
        },
      });
      hashOut.pipe(out);
      const outDone = new Promise<void>((resolve, reject) => {
        out.on('finish', resolve);
        out.on('error', reject);
      });
      const src = counted(res.body as unknown as AsyncIterable<Uint8Array>);
      if (sp.entry) {
        const gunzip = zlib.createGunzip();
        const feed = (async () => {
          for await (const c of src) if (!gunzip.write(c)) await new Promise((r) => gunzip.once('drain', r));
          gunzip.end();
        })();
        feed.catch((e) => gunzip.destroy(e));
        const found = await extractTarEntry(gunzip as unknown as AsyncIterable<Buffer>, sp.entry, hashOut);
        await feed;
        if (!found) throw new Error(`"${sp.entry}" is not in the downloaded archive`);
      } else {
        for await (const c of src) if (!hashOut.write(c)) await new Promise((r) => hashOut.once('drain', r));
      }
      hashOut.end();
      await outDone;
      const aHex = archiveHash.digest('hex');
      const fHex = fileHash.digest('hex');
      if (sp.archiveSha256 && aHex !== sp.archiveSha256) throw new Error('Model download is corrupt (archive SHA-256 mismatch)');
      if (sp.sha256 && fHex !== sp.sha256) throw new Error('Model download is corrupt (SHA-256 mismatch)');
      if (fileBytes < 1024) throw new Error('Model download is empty');
      await fs.promises.rename(part, target);
      fs.writeFileSync(target + '.json', JSON.stringify({ url: sp.url, entry: sp.entry, sha256: fHex, bytes: fileBytes, pinned: !!sp.sha256, at: Date.now() }));
      lastError = null;
      log.info(`Stems model ready (${(fileBytes / 1e6).toFixed(0)} MB, sha256 ${fHex.slice(0, 12)}…)`);
    } catch (e) {
      lastError = ctrl.signal.aborted ? 'Download cancelled' : (e as Error).message;
      log.warn(`Stems model download failed: ${lastError}`);
      throw e;
    } finally {
      await fs.promises.rm(part, { force: true }).catch(() => {});
    }
  }

  /* ---------------- per-track uploads ---------------- */
  const uploads = new Map<string, { token: string; dir: string; frames: number; sampleRate: number; model: string; backend: string; at: number }>();
  const readMeta = (id: string): Record<string, any> | null => {
    try {
      return JSON.parse(fs.readFileSync(path.join(trackDir(id), 'meta.json'), 'utf8'));
    } catch {
      return null;
    }
  };
  const dropUpload = async (id: string) => {
    const u = uploads.get(id);
    if (!u) return;
    uploads.delete(id);
    await fs.promises.rm(u.dir, { recursive: true, force: true }).catch(() => {});
  };
  const upload = (id: string, token: string) => {
    const u = uploads.get(id);
    if (!u || u.token !== token) throw new StemsError('No such stems upload (cancelled or expired)', 409);
    u.at = Date.now();
    return u;
  };
  // Stale uploads (tab closed mid-separation) are removed after an hour; leftovers from a crash at start.
  const sweep = setInterval(() => {
    for (const [id, u] of uploads) if (Date.now() - u.at > 3600e3) void dropUpload(id);
  }, 600e3);
  sweep.unref?.();
  for (const n of fs.readdirSync(root)) if (n.startsWith('.upload-')) void fs.promises.rm(path.join(root, n), { recursive: true, force: true }).catch(() => {});

  const mixing = new Map<string, Promise<string>>();

  return {
    root,
    modelStatus(s) {
      let sp: ModelSpec;
      try {
        sp = spec(s);
      } catch (e) {
        return { id: 'invalid', name: 'Invalid model URL', url: String(s.stemsModelUrl ?? ''), licence: '', homepage: null, custom: true, bytes: null, sha256: null, verified: false, ready: false, downloading: null, error: (e as Error).message };
      }
      const meta = modelReady(sp) ? modelMeta(sp) : null;
      return {
        id: sp.id, name: sp.name, url: sp.url, licence: sp.licence, homepage: sp.homepage, custom: sp.custom,
        bytes: meta?.bytes ?? sp.bytes, sha256: meta?.sha256 ?? sp.sha256,
        verified: !!meta && !!sp.sha256 && meta.sha256 === sp.sha256, ready: !!meta,
        downloading: download && download.spec.url === sp.url ? { received: download.received, total: download.total } : null,
        error: lastError,
      };
    },
    modelFile(s) {
      const sp = spec(s);
      return modelReady(sp) ? modelPath(sp) : null;
    },
    startDownload(s) {
      const sp = spec(s);
      if (modelReady(sp)) return { ready: true };
      if (!download) {
        lastError = null;
        const ctrl = new AbortController();
        const d = { spec: sp, received: 0, total: sp.downloadBytes ?? 0, ctrl, promise: Promise.resolve() };
        download = d;
        d.promise = fetchModel(sp, ctrl).catch(() => {}).finally(() => {
          if (download === d) download = null;
        });
      }
      return { ready: false, started: true, downloading: { received: download!.received, total: download!.total } };
    },
    async downloadDone() {
      await download?.promise;
    },
    cancelDownload() {
      download?.ctrl.abort();
    },
    async deleteModel(s) {
      const sp = spec(s);
      await fs.promises.rm(modelPath(sp), { force: true });
      await fs.promises.rm(modelPath(sp) + '.json', { force: true });
    },
    status(id) {
      checkId(id);
      const meta = readMeta(id);
      return { itemId: id, ready: !!meta, preparing: uploads.has(id), ...(meta ? { model: meta.model, backend: meta.backend, format: meta.format, frames: meta.frames, sampleRate: meta.sampleRate, at: meta.at } : {}) };
    },
    async begin(id, body) {
      checkId(id);
      const sampleRate = Math.floor(Number(body.sampleRate)) || STEM_RATE;
      const frames = Math.floor(Number(body.frames));
      if (!(frames > 0 && frames <= sampleRate * 60 * 90)) throw new StemsError('Bad length (max. 90 minutes)');
      if (sampleRate !== STEM_RATE) throw new StemsError(`Stems must be ${STEM_RATE} Hz`);
      await dropUpload(id);
      const token = crypto.randomBytes(12).toString('hex');
      const dir = path.join(root, `.upload-${id}-${token.slice(0, 8)}`);
      await fs.promises.mkdir(dir, { recursive: true });
      for (const s of STEM_NAMES) await fs.promises.writeFile(path.join(dir, `${s}.raw`), '');
      uploads.set(id, { token, dir, frames, sampleRate, model: String(body.model ?? 'unknown').slice(0, 80), backend: String(body.backend ?? '').slice(0, 40), at: Date.now() });
      return { token };
    },
    async part(id, token, stem, frame, body) {
      const u = upload(checkId(id), token);
      if (!STEM_NAMES.includes(stem as StemName)) throw new StemsError('Unknown stem');
      if (!Buffer.isBuffer(body) || !body.length || body.length % 4) throw new StemsError('Send 16-bit stereo PCM (application/octet-stream)');
      if (!Number.isSafeInteger(frame) || frame < 0 || frame + body.length / 4 > u.frames) throw new StemsError('Part is outside the track');
      const fh = await fs.promises.open(path.join(u.dir, `${stem}.raw`), 'r+');
      try {
        await fh.write(body, 0, body.length, frame * 4);
      } finally {
        await fh.close();
      }
    },
    async finish(id, token) {
      const u = upload(checkId(id), token);
      for (const s of STEM_NAMES) {
        const raw = path.join(u.dir, `${s}.raw`);
        const st = await fs.promises.stat(raw);
        if (st.size !== u.frames * 4) throw new StemsError(`Stem "${s}" is incomplete (${st.size} of ${u.frames * 4} bytes)`);
        await runFfmpeg(['-y', '-f', 's16le', '-ar', String(u.sampleRate), '-ac', '2', '-i', raw, '-c:a', 'flac', '-compression_level', '5', path.join(u.dir, `${s}.flac`)], ffmpeg);
        await fs.promises.rm(raw, { force: true });
      }
      const meta = { model: u.model, backend: u.backend, format: 'flac', sampleRate: u.sampleRate, frames: u.frames, stems: STEM_NAMES, at: Date.now() };
      await fs.promises.writeFile(path.join(u.dir, 'meta.json'), JSON.stringify(meta));
      const dest = trackDir(id);
      await fs.promises.rm(dest, { recursive: true, force: true });
      await fs.promises.rename(u.dir, dest);
      uploads.delete(id);
      return this.status(id);
    },
    async remove(id) {
      checkId(id);
      await dropUpload(id);
      await fs.promises.rm(trackDir(id), { recursive: true, force: true });
    },
    stemFile(id, stem) {
      checkId(id);
      if (!STEM_NAMES.includes(stem as StemName)) throw new StemsError('Unknown stem', 404);
      const meta = readMeta(id);
      if (!meta) throw new StemsError('No stems for this track', 404);
      return path.join(trackDir(id), `${stem}.${meta.format}`);
    },
    mix(id, vocals, inst) {
      checkId(id);
      const meta = readMeta(id);
      if (!meta) return Promise.reject(new StemsError('No stems for this track yet', 404));
      const file = path.join(trackDir(id), `mix-v${vocals}-i${inst}.mp3`);
      if (fs.existsSync(file)) return Promise.resolve(file);
      const running = mixing.get(file);
      if (running) return running;
      const tmp = `${file}.${crypto.randomBytes(3).toString('hex')}.tmp.mp3`;
      const inputs = STEM_NAMES.flatMap((s) => ['-i', path.join(trackDir(id), `${s}.${meta.format}`)]);
      const p = runFfmpeg(['-y', ...inputs, '-filter_complex', mixFilter(vocals, inst), '-map', '[out]', '-c:a', 'libmp3lame', '-q:a', '2', '-ar', String(meta.sampleRate || STEM_RATE), tmp], ffmpeg)
        .then(async () => {
          await fs.promises.rename(tmp, file);
          return file;
        })
        .catch(async (e) => {
          await fs.promises.rm(tmp, { force: true }).catch(() => {});
          throw e;
        })
        .finally(() => mixing.delete(file));
      mixing.set(file, p);
      return p;
    },
    close() {
      clearInterval(sweep);
      download?.ctrl.abort();
    },
  };
}

