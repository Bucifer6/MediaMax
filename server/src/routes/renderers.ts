import fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ManualRendererRequest, RendererCommandRequest, RendererPlayRequest, RendererSettings } from '@mediamax/shared';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAdmin, requireUser } from '../http.js';
import { forbidden, notFound, HttpError } from '../util/errors.js';
import { isLocalAddress } from '../services/dlna.js';
import { remoteInputArgs, subtitleVtt } from '../services/playback.js';
import { hasFilter } from '../services/transcoder.js';
import { getSettings } from '../services/settings.js';
import { REMOTE_PROTOCOLS } from '../util/misc.js';
import { logActivity } from '../services/activity.js';
import { sendFileRange } from './playback.js';
import {
  addManual, adminView, discover, listRenderers, playOnRenderer, removeManual, rendererCommand, rendererIcon, rendererSettings, rendererState, rendererTranscodes,
  saveRendererSettings, sessionSubtitleUrl, streamTarget, touchStream,
} from '../services/renderers/index.js';
import { SOFTWARE_TONEMAP, transcodeArgs, verifyStream, vttToSrt } from '../services/renderers/stream.js';
import { dlnaFeatures } from '../services/renderers/xml.js';
import { fileExists } from '../util/fileAsync.js';

const ACTIONS = new Set(['pause', 'resume', 'stop', 'seek', 'volume', 'next', 'previous']);
let lastDiscover = 0;

/** Live transcodes per session key: a renderer that reconnects replaces its previous process. */
const procs = new Map<string, Set<ReturnType<typeof spawn>>>();

export default async function rendererRoutes(app: FastifyInstance) {
  app.get('/renderers', async (req) => {
    requireUser(req);
    return listRenderers();
  });

  app.post('/renderers/discover', async (req) => {
    requireUser(req);
    if (!rendererSettings().enabled) return [];
    if (Date.now() - lastDiscover > 10000) {
      lastDiscover = Date.now();
      await discover();
    }
    return listRenderers();
  });

  app.get<{ Params: { id: string } }>('/renderers/:id/state', async (req) => rendererState(requireUser(req), req.params.id));

  app.post<{ Params: { id: string }; Body: RendererPlayRequest }>('/renderers/:id/play', async (req) => rendererPlay(req));

  app.post<{ Params: { id: string; action: string }; Body: RendererCommandRequest }>('/renderers/:id/:action', async (req) => {
    const a = requireUser(req);
    if (!ACTIONS.has(req.params.action)) throw notFound();
    return rendererCommand(a, req.params.id, req.params.action, req.body ?? {});
  });

  app.get<{ Params: { id: string } }>('/renderers/:id/icon', async (req, reply) => {
    requireUser(req);
    const icon = await rendererIcon(req.params.id);
    return reply.type(icon.type).header('Cache-Control', 'private, max-age=86400').header('Content-Security-Policy', "default-src 'none'; sandbox").send(icon.body);
  });

  /* -------------------------------- admin ------------------------------ */
  app.get('/admin/renderers', async (req) => {
    requireAdmin(req);
    return adminView();
  });
  app.put<{ Body: Partial<RendererSettings> }>('/admin/renderers/settings', async (req) => {
    const a = requireAdmin(req);
    const s = saveRendererSettings(req.body ?? {});
    logActivity('settings.renderers', `Play to devices ${s.enabled ? 'enabled' : 'disabled'}`, { userId: a.user.id, userName: a.user.displayName });
    return adminView();
  });
  app.post<{ Body: ManualRendererRequest }>('/admin/renderers/manual', async (req) => {
    const a = requireAdmin(req);
    const v = await addManual(req.body ?? ({} as ManualRendererRequest));
    logActivity('renderers.add', `Added a ${req.body?.kind === 'kodi' ? 'Kodi' : 'DLNA'} device for Play to`, { userId: a.user.id, userName: a.user.displayName });
    return v;
  });
  app.delete<{ Params: { id: string } }>('/admin/renderers/manual/:id', async (req) => {
    requireAdmin(req);
    return removeManual(req.params.id);
  });

  /* ---------------- device-facing streams (signed, no login, LAN only) ---------------- */
  app.get<{ Params: { key: string; file: string } }>('/renderers/stream/:key/:file', async (req, reply) => deviceStream(req, reply));
}

/** ffmpeg input options for a renderer conversion: remote media (IPTV VOD, podcasts) only over network protocols. */
export function deviceInputArgs(m: { path?: string | null; remote_url?: string | null; item_id?: string }): string[] {
  return m.remote_url && !m.path ? [...remoteInputArgs(m as never), ...REMOTE_PROTOCOLS] : [];
}

function rendererPlay(req: FastifyRequest<{ Params: { id: string }; Body: RendererPlayRequest }>) {
  return playOnRenderer(requireUser(req), req.params.id, req.body ?? ({} as RendererPlayRequest));
}

async function deviceStream(req: FastifyRequest<{ Params: { key: string; file: string } }>, reply: FastifyReply) {
  // req.ip honours only trusted proxies, so a forwarded internet client can't pass as LAN.
  if (!isLocalAddress(req.ip)) throw forbidden('Device streams are only available on the local network');
  const token = req.params.file.replace(/\.[a-z0-9]{1,5}$/i, '');
  const c = verifyStream(token);
  if (!c || c.s !== req.params.key) throw forbidden('Invalid or expired stream link');
  const target = streamTarget(c.s, c.m);
  if (!target) throw notFound('This playback has ended');
  touchStream(target.session);
  const m = db.get('SELECT * FROM media WHERE id = ?', c.m);
  if (!m) throw notFound();
  reply.header('Cache-Control', 'no-store').header('transferMode.dlna.org', 'Streaming');

  if (c.f === 'srt') {
    const vtt = fs.readFileSync(await subtitleVtt(c.m, Number(c.a)), 'utf8');
    return reply.type('text/srt; charset=utf-8').header('transferMode.dlna.org', 'Interactive').send(vttToSrt(vtt, c.t * 1000));
  }
  const fmt = target.entry.format;
  const sub = sessionSubtitleUrl(target.session);
  if (sub && req.headers['getcaptioninfo.sec']) reply.header('CaptionInfo.sec', sub);

  if (c.f === 'direct') {
    if (!m.path || !(await fileExists(m.path))) throw notFound('File is missing');
    reply.header('contentFeatures.dlna.org', dlnaFeatures({ pn: fmt.pn, transcoded: false }));
    return sendFileRange(req, reply, m.path, fmt.mime);
  }

  // Live conversion: no length, no byte ranges (seeks restart the conversion at a time offset).
  reply.header('contentFeatures.dlna.org', dlnaFeatures({ pn: fmt.pn, transcoded: true })).type(fmt.mime);
  if (req.method === 'HEAD') return reply.send();
  const range = String(req.headers.range ?? '');
  const rm = range.match(/bytes=(\d+)-/);
  if (rm && Number(rm[1]) > 0) {
    // Renderers probing the end of a live stream: there is no end yet.
    reply.status(416).header('Content-Range', 'bytes */*');
    return reply.send();
  }
  const input = m.path ?? m.remote_url;
  if (!input) throw notFound();
  const max = getSettings().transcoding.maxConcurrent;
  const mine = procs.get(c.s) ?? new Set();
  for (const p of mine) p.kill('SIGKILL'); // the device reconnected: drop its old conversion
  const others = [...rendererTranscodes.entries()].filter(([k]) => k !== c.s).reduce((a, [, n]) => a + n, 0);
  if (others >= max) throw new HttpError(503, 'Transcoder busy', 'transcoder_busy');
  const args = transcodeArgs({
    input, inputArgs: deviceInputArgs(m), f: c.f, startSec: c.t, audioIndex: c.a, copyVideo: fmt.copyVideo,
    bitrate: Math.min(getSettings().transcoding.defaultBitrate || 8000, 12000), sourceHeight: m.height, hdr: !!m.hdr,
    toneMap: m.hdr && getSettings().transcoding.toneMapHdr && hasFilter('zscale') ? SOFTWARE_TONEMAP : null,
  });
  const p = spawn(config.ffmpeg, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  mine.add(p);
  procs.set(c.s, mine);
  rendererTranscodes.set(c.s, mine.size);
  const release = () => {
    mine.delete(p);
    if (mine.size) rendererTranscodes.set(c.s, mine.size);
    else {
      rendererTranscodes.delete(c.s);
      procs.delete(c.s);
    }
  };
  p.on('exit', release);
  p.on('error', release);
  req.raw.on('close', () => p.kill('SIGKILL'));
  // Keep the play session alive while the device is pulling data.
  const keep = setInterval(() => touchStream(target.session), 30000);
  p.on('exit', () => clearInterval(keep));
  return reply.send(p.stdout);
}
