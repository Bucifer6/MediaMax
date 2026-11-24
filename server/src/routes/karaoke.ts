/**
 * Lyrics editing / offsets and karaoke stems.
 *
 *   PUT    /items/:id/lyrics              admin: save edited lyrics (LRC or lines), optionally write the .lrc sidecar
 *   DELETE /items/:id/lyrics              admin: forget the edit (back to sidecar / tags / LRCLIB)
 *   PUT    /items/:id/lyrics/offset       any user: their own per-track offset { offsetMs }
 *   GET    /stems/status                  model / runtime status
 *   POST   /stems/model/download|cancel   admin
 *   DELETE /stems/model                   admin
 *   GET    /stems/model                   admin: the verified model bytes (the browser worker runs it)
 *   GET    /stems/ort/:file               onnxruntime-web files, served same-origin
 *   GET    /items/:id/stems               stem status for a track (with the server job while one is queued / running)
 *   POST   /items/:id/stems/prepare       admin: separate on the server (queued; onnxruntime-node, GPU where there is one)
 *   DELETE /items/:id/stems/prepare       admin: cancel that
 *   POST   /items/:id/stems/begin         admin: start an upload { frames, sampleRate, model, backend } → { token }
 *   PUT    /items/:id/stems/part          admin: ?token&stem&frame, body = interleaved stereo s16le
 *   POST   /items/:id/stems/finish        admin: ?token → FLAC stems
 *   DELETE /items/:id/stems               admin
 *   GET    /items/:id/stems/:stem         one stem (FLAC, ranges)
 *   GET    /items/:id/karaoke.mp3         server-side mix ?vocals=0..100&inst=0..100 (cached, seekable)
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { KaraokeSettings, NativeStemsStatus, SaveLyricsRequest, SaveLyricsResponse, StemsStatus, TrackStems } from '@mediamax/shared';
import { requireAdmin, requireUser } from '../http.js';
import { assertCanSee } from '../services/items.js';
import { badRequest, notFound } from '../util/errors.js';
import { deleteEdit, getLyrics, saveEdit, setUserOffset } from '../services/lyrics.js';
import { ortRuntime } from '../services/ortRuntime.js';
import { createStemStore, findOrtDir, mixLevel, ortVersion, STEM_NAMES, STEM_RATE, type StemStore } from '../services/stems.js';
import { isSea } from 'node:sea';
import { createSeparationQueue, type SeparationQueue } from '../services/separation/native.js';
import { findOrtNode, ORT_NODE_VERSION, ortNodeRuntime, platformUnsupported } from '../services/ortNode.js';
import { getSettings } from '../services/settings.js';
import { sendFileRange } from './playback.js';
import { assertRemoteAllowed } from '../services/playback.js';
import { spawn } from 'node:child_process';
import { db } from '../db.js';
import { config } from '../config.js';

let store: StemStore | null = null;
/** The process-wide stem store (created lazily under the data dir). */
export function stemStore(): StemStore {
  return (store ??= createStemStore());
}

let queue: SeparationQueue | null = null;
/** The process-wide server separation queue. */
export function separationQueue(): SeparationQueue {
  return (queue ??= createSeparationQueue({ store: stemStore(), settings: karaoke }));
}
/** Tests: use another queue (e.g. the stub model). */
export function setSeparationQueue(q: SeparationQueue | null) {
  queue?.close();
  queue = q;
}

/**
 * The standalone (single-executable) build can't fork the separation child: its binary always runs the embedded
 * server, so a fork would start a second server instance. Separation runs in the browser there instead.
 */
const SEA_UNSUPPORTED = isSea() ? 'The standalone build separates in the browser (server-side separation needs the Docker or Node install)' : null;

/** Where "Prepare" separates for these settings: the server when the native runtime can run here (or is forced). */
export function stemsEngine(k: Partial<KaraokeSettings>): 'server' | 'browser' {
  if (k.stemsEngine === 'browser' || SEA_UNSUPPORTED) return 'browser';
  if (k.stemsEngine === 'server') return 'server';
  return platformUnsupported() === null || findOrtNode() ? 'server' : 'browser';
}

function nativeStatus(isAdmin: boolean): NativeStemsStatus {
  const found = SEA_UNSUPPORTED ? null : findOrtNode();
  const reason = SEA_UNSUPPORTED ?? (found ? null : platformUnsupported());
  const d = ortNodeRuntime().status();
  return {
    supported: !reason, reason, ready: !!found, version: found?.version ?? ORT_NODE_VERSION,
    ...(isAdmin ? { download: { state: d.state, received: d.received, total: d.total, error: d.error } } : {}),
    lastBackend: queue?.lastBackend() ?? null,
    gpuProblem: queue?.gpuProblem() ?? null,
    queued: queue?.size() ?? 0,
  };
}

/** A track's stems with the server job (if any) and the last server error. */
function trackStems(id: string): TrackStems {
  const s = stemStore().status(id);
  const job = queue?.job(id) ?? null;
  return { ...s, preparing: s.preparing || !!job, job, error: job ? null : queue?.error(id) ?? null };
}

const karaoke = () => getSettings().karaoke ?? { stemsEnabled: false, stemsModelUrl: null, stemsModelSha256: null, writeLrcSidecars: false };

export default async function karaokeRoutes(app: FastifyInstance) {
  app.addHook('onClose', async () => setSeparationQueue(null));
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 64 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  /* -------------------------------- lyrics -------------------------------- */
  app.put<{ Params: { id: string }; Body: SaveLyricsRequest }>('/items/:id/lyrics', async (req): Promise<SaveLyricsResponse> => {
    const { user } = requireAdmin(req);
    const row = assertCanSee(user, req.params.id);
    if (row.type !== 'track') throw badRequest('Lyrics can only be saved for music tracks');
    const r = saveEdit(req.params.id, req.body ?? {}, user.id);
    const l = await getLyrics(req.params.id, user.id);
    return { ...(l as SaveLyricsResponse), canEdit: true, wroteSidecar: r.wroteSidecar, sidecarError: r.sidecarError };
  });
  app.delete<{ Params: { id: string } }>('/items/:id/lyrics', async (req) => {
    const { user } = requireAdmin(req);
    assertCanSee(user, req.params.id);
    deleteEdit(req.params.id);
    return { ok: true };
  });
  app.put<{ Params: { id: string }; Body: { offsetMs: number } }>('/items/:id/lyrics/offset', async (req) => {
    const { user } = requireUser(req);
    assertCanSee(user, req.params.id);
    if (!Number.isFinite(Number(req.body?.offsetMs))) throw badRequest('offsetMs must be a number');
    return { offsetMs: setUserOffset(user.id, req.params.id, Number(req.body.offsetMs)) };
  });

  /* -------------------------------- stems --------------------------------- */
  const needEnabled = () => {
    if (!karaoke().stemsEnabled) throw badRequest('AI stem separation is turned off (Server settings → Karaoke & lyrics)');
  };
  app.get('/stems/status', async (req): Promise<StemsStatus> => {
    const { user } = requireUser(req);
    const k = karaoke();
    const ort = findOrtDir();
    return {
      enabled: !!k.stemsEnabled,
      model: k.stemsEnabled ? stemStore().modelStatus(k) : null,
      ort: !!ort, ortVersion: ortVersion(ort),
      ortDownload: user.isAdmin ? ortRuntime().status() : undefined,
      format: 'flac', sampleRate: STEM_RATE, stemNames: STEM_NAMES,
      canPrepare: user.isAdmin && !!k.stemsEnabled,
      engine: stemsEngine(k),
      native: nativeStatus(user.isAdmin),
    };
  });
  // The browser runtime is fetched on first use (ortRuntime.ts); downloading the model starts it too.
  const startOrt = () => {
    if (!findOrtDir()) ortRuntime().ensure().catch(() => {});
  };
  app.post('/stems/ort/download', async (req) => {
    requireAdmin(req);
    needEnabled();
    startOrt();
    return ortRuntime().status();
  });
  app.post('/stems/model/download', async (req) => {
    requireAdmin(req);
    needEnabled();
    if (stemsEngine(karaoke()) === 'server') ortNodeRuntime().ensure().catch(() => {});
    else startOrt();
    return stemStore().startDownload(karaoke());
  });
  app.post('/stems/model/cancel', async (req) => {
    requireAdmin(req);
    stemStore().cancelDownload();
    return { ok: true };
  });
  app.delete('/stems/model', async (req) => {
    requireAdmin(req);
    await stemStore().deleteModel(karaoke());
    return { ok: true };
  });
  app.get('/stems/model', async (req, reply) => {
    requireAdmin(req);
    needEnabled();
    const f = stemStore().modelFile(karaoke());
    if (!f) throw notFound('The stems model has not been downloaded yet');
    return sendFileRange(req, reply, f, 'application/octet-stream');
  });
  app.get<{ Params: { file: string } }>('/stems/ort/:file', async (req, reply) => {
    const dir = findOrtDir();
    const name = req.params.file;
    if (!dir) throw notFound('The AI runtime (onnxruntime-web) has not been downloaded yet');
    if (!/^ort[\w.-]*\.(mjs|wasm)$/.test(name) || name.includes('..') || !fs.existsSync(path.join(dir, name))) throw notFound();
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    return sendFileRange(req, reply, path.join(dir, name), name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8');
  });

  app.get<{ Params: { id: string } }>('/items/:id/stems', async (req) => {
    const { user } = requireUser(req);
    assertCanSee(user, req.params.id);
    return trackStems(req.params.id);
  });
  app.post<{ Params: { id: string } }>('/items/:id/stems/prepare', async (req): Promise<TrackStems> => {
    const { user } = requireAdmin(req);
    needEnabled();
    const row = assertCanSee(user, req.params.id);
    if (row.type !== 'track') throw badRequest('Stems can only be prepared for music tracks');
    if (stemsEngine(karaoke()) !== 'server') throw badRequest('This server separates stems in the browser (Server settings → Karaoke & lyrics)');
    const m = db.get<{ path: string | null }>('SELECT path FROM media WHERE item_id = ? AND path IS NOT NULL LIMIT 1', req.params.id);
    if (!m?.path) throw notFound('This track has no local file');
    separationQueue().enqueue(req.params.id, m.path);
    return trackStems(req.params.id);
  });
  app.delete<{ Params: { id: string } }>('/items/:id/stems/prepare', async (req) => {
    const { user } = requireAdmin(req);
    assertCanSee(user, req.params.id);
    return { cancelled: queue?.cancel(req.params.id) ?? false };
  });
  app.post<{ Params: { id: string }; Body: { frames: number; sampleRate: number; model?: string; backend?: string } }>('/items/:id/stems/begin', async (req) => {
    const { user } = requireAdmin(req);
    needEnabled();
    const row = assertCanSee(user, req.params.id);
    if (row.type !== 'track') throw badRequest('Stems can only be prepared for music tracks');
    return stemStore().begin(req.params.id, req.body ?? {});
  });
  // The track decoded to 44.1 kHz stereo FLAC for the separation worker (any source format the browser can't decode).
  app.get<{ Params: { id: string } }>('/items/:id/stems/source', async (req, reply) => {
    const { user } = requireAdmin(req);
    needEnabled();
    assertCanSee(user, req.params.id);
    const m = db.get<{ path: string | null }>('SELECT path FROM media WHERE item_id = ? AND path IS NOT NULL LIMIT 1', req.params.id);
    if (!m?.path) throw notFound('This track has no local file');
    const p = spawn(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', m.path, '-map', '0:a:0', '-ac', '2', '-ar', String(STEM_RATE), '-c:a', 'flac', '-compression_level', '0', '-f', 'flac', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    req.raw.on('close', () => p.kill('SIGKILL'));
    reply.header('Content-Type', 'audio/flac').header('Cache-Control', 'no-store');
    return reply.send(p.stdout);
  });
  app.put<{ Params: { id: string }; Querystring: { token?: string; stem?: string; frame?: string } }>('/items/:id/stems/part', async (req) => {
    requireAdmin(req);
    await stemStore().part(req.params.id, String(req.query.token ?? ''), String(req.query.stem ?? ''), Number(req.query.frame), req.body as Buffer);
    return { ok: true };
  });
  app.post<{ Params: { id: string }; Querystring: { token?: string } }>('/items/:id/stems/finish', async (req) => {
    requireAdmin(req);
    return stemStore().finish(req.params.id, String(req.query.token ?? ''));
  });
  app.delete<{ Params: { id: string } }>('/items/:id/stems', async (req) => {
    const { user } = requireAdmin(req);
    assertCanSee(user, req.params.id);
    queue?.cancel(req.params.id);
    await stemStore().remove(req.params.id);
    return { ok: true };
  });
  app.get<{ Params: { id: string; stem: string } }>('/items/:id/stems/:stem', async (req, reply) => {
    const { user } = requireUser(req);
    assertRemoteAllowed(user, req.ip);
    assertCanSee(user, req.params.id);
    return sendFileRange(req, reply, stemStore().stemFile(req.params.id, req.params.stem), 'audio/flac');
  });
  app.get<{ Params: { id: string }; Querystring: { vocals?: string; inst?: string } }>('/items/:id/karaoke.mp3', async (req, reply) => {
    const { user } = requireUser(req);
    assertRemoteAllowed(user, req.ip);
    assertCanSee(user, req.params.id);
    const file = await stemStore().mix(req.params.id, mixLevel(req.query.vocals, 15), mixLevel(req.query.inst, 100));
    return sendFileRange(req, reply, file, 'audio/mpeg');
  });
}
