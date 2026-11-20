import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DownloadQuality, PlaybackRequest, ProgressReport } from '@mediamax/shared';
import { db } from '../db.js';
import { requireAdmin, requireUser, remoteAddr } from '../http.js';
import { assertRemoteAllowed, transcodeCount, getSession, listSessions, sessionProgress, startPlayback, stopSession, subtitleVtt, touchSession } from '../services/playback.js';
import { assertCanSee } from '../services/items.js';
import { liveJobBySession } from '../services/livetv/livetv.js';
import { badRequest, forbidden, notFound, HttpError } from '../util/errors.js';
import { getSettings } from '../services/settings.js';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { safeFetch } from '../util/net.js';
import { logActivity } from '../services/activity.js';
import { renditionRequest } from '../services/abr.js';
import { doviMasterForJob } from '../services/dovi.js';
import { serveSubtitle } from './streaming.js';

const MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', ts: 'video/mp2t', m2ts: 'video/mp2t', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic',
};

export function sendFileRange(req: FastifyRequest, reply: FastifyReply, file: string, mime: string, download?: string) {
  const stat = fs.statSync(file);
  const size = stat.size;
  reply.header('Accept-Ranges', 'bytes').header('Content-Type', mime).header('Cache-Control', 'private, max-age=3600');
  if (download) reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(download)}`);
  const range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : size - parseInt(m[2], 10);
      let end = m[1] && m[2] ? parseInt(m[2], 10) : size - 1;
      if (Number.isNaN(start) || start < 0) start = 0;
      if (end >= size) end = size - 1;
      if (start >= size || start > end) {
        reply.status(416).header('Content-Range', `bytes */${size}`);
        return reply.send();
      }
      reply.status(206).header('Content-Range', `bytes ${start}-${end}/${size}`).header('Content-Length', end - start + 1);
      return reply.send(fs.createReadStream(file, { start, end }));
    }
  }
  reply.header('Content-Length', size);
  return reply.send(fs.createReadStream(file));
}

/** Proxy a remote (IPTV) file preserving Range semantics, without exposing provider credentials. */
async function proxyRemote(req: FastifyRequest, reply: FastifyReply, url: string, userAgent: string, mime: string, untrusted = false) {
  const headers: Record<string, string> = { 'User-Agent': userAgent };
  if (req.headers.range) headers.Range = req.headers.range;
  const ctrl = new AbortController();
  req.raw.on('close', () => ctrl.abort());
  const res = untrusted ? await safeFetch(url, { headers, signal: ctrl.signal }) : await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
  if (!res.ok && res.status !== 206) throw notFound(`Provider returned ${res.status}`);
  reply.status(res.status);
  for (const h of ['content-length', 'content-range', 'accept-ranges']) {
    const v = res.headers.get(h);
    if (v) reply.header(h, v);
  }
  reply.header('Content-Type', res.headers.get('content-type')?.startsWith('video') ? res.headers.get('content-type')! : mime);
  return reply.send(res.body ? Readable.fromWeb(res.body as any) : '');
}

/** Remote media from user-added podcast feeds must go through the SSRF guard. */
const isUntrustedMedia = (itemId: string) => db.get<{ type: string }>('SELECT l.type FROM items i JOIN libraries l ON l.id = i.library_id WHERE i.id = ?', itemId)?.type === 'podcasts';

const QUALITY: Record<string, { height: number; bitrate: number }> = {
  '1080p': { height: 1080, bitrate: 8000 },
  '720p': { height: 720, bitrate: 4000 },
  '480p': { height: 480, bitrate: 1500 },
};

/**
 * Stream a device-friendly H.264/AAC MP4 (fragmented, so it can be written while encoding).
 * Used by mobile apps for offline downloads of files their platform can't play (e.g. MKV on iOS).
 */
/** Active converted downloads, counted against the transcoding limit (global + per user). */
export const activeConversions = new Map<string, number>();
const conversionTotal = () => [...activeConversions.values()].reduce((a, b) => a + b, 0);

function convertedDownload(req: FastifyRequest, reply: FastifyReply, m: Record<string, any>, baseName: string, quality: string, userId: string) {
  const q = QUALITY[quality];
  const max = getSettings().transcoding.maxConcurrent;
  if (transcodeCount() + conversionTotal() >= max) throw new HttpError(503, 'The server is busy converting other media. Try again shortly or download the original file.', 'transcoder_busy');
  if ((activeConversions.get(userId) ?? 0) >= 2) throw new HttpError(429, 'You already have 2 converted downloads in progress.', 'too_many');
  activeConversions.set(userId, (activeConversions.get(userId) ?? 0) + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const n = (activeConversions.get(userId) ?? 1) - 1;
    if (n <= 0) activeConversions.delete(userId);
    else activeConversions.set(userId, n);
  };
  const input = m.path ?? m.remote_url;
  const isAudio = !m.video_codec;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', input, '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-map_metadata', '0'];
  if (!isAudio) {
    const copyVideo = m.video_codec === 'h264' && (m.height ?? 0) <= q.height && (m.bitrate ?? Infinity) <= q.bitrate * 1.5;
    if (copyVideo) args.push('-c:v', 'copy');
    else args.push('-vf', `scale=-2:'min(${q.height},ih)',format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${q.bitrate}k`, '-maxrate', `${q.bitrate}k`, '-bufsize', `${q.bitrate * 2}k`, '-profile:v', 'high');
  }
  args.push('-c:a', 'aac', '-ac', '2', '-b:a', '160k', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  const p = spawn(config.ffmpeg, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  p.on('exit', release);
  p.on('error', release);
  req.raw.on('close', () => {
    p.kill('SIGKILL');
    release();
  });
  reply.header('Content-Type', isAudio ? 'audio/mp4' : 'video/mp4')
    .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${baseName} - ${quality}.${isAudio ? 'm4a' : 'mp4'}`)}`)
    .header('Cache-Control', 'no-store');
  if (m.duration_ms) reply.header('X-MediaMax-Duration-Ms', String(m.duration_ms));
  return reply.send(p.stdout);
}

export default async function playbackRoutes(app: FastifyInstance) {
  app.post<{ Params: { itemId: string }; Body: PlaybackRequest }>('/playback/:itemId', async (req) => startPlayback(requireUser(req), req.params.itemId, req.body ?? {}, remoteAddr(req)));

  app.post<{ Params: { sessionId: string }; Body: ProgressReport }>('/playback/sessions/:sessionId/progress', async (req) => {
    const b = req.body ?? ({} as ProgressReport);
    return sessionProgress(requireUser(req), req.params.sessionId, Number(b.positionMs) || 0, b.state ?? 'playing', b.durationMs);
  });

  app.delete<{ Params: { sessionId: string } }>('/playback/sessions/:sessionId', async (req) => {
    const a = requireUser(req);
    const s = getSession(req.params.sessionId);
    if (s && s.ctx.user.id !== a.user.id && !a.user.isAdmin) throw forbidden();
    stopSession(req.params.sessionId);
    return { ok: true };
  });

  app.get('/sessions', async (req) => {
    requireAdmin(req);
    return listSessions();
  });

  app.delete<{ Params: { id: string }; Querystring: { reason?: string } }>('/sessions/:id', async (req) => {
    const a = requireAdmin(req);
    const s = getSession(req.params.id);
    if (!s) throw notFound('Session not found');
    stopSession(req.params.id, req.query.reason || 'Stopped by the server administrator');
    logActivity('session.kill', `Stopped ${s.ctx.user.displayName}'s stream of ${s.title}`, { userId: a.user.id, userName: a.user.displayName, severity: 'warning' });
    return { ok: true };
  });

  /* ------------------------------ streams --------------------------- */
  app.get<{ Params: { mediaId: string }; Querystring: { session?: string } }>('/stream/direct/:mediaId', async (req, reply) => {
    const { user } = requireUser(req);
    assertRemoteAllowed(user, remoteAddr(req));
    const m = db.get('SELECT * FROM media WHERE id = ?', req.params.mediaId);
    if (!m) throw notFound('Media not found');
    assertCanSee(user, m.item_id);
    if (req.query.session) touchSession(req.query.session);
    const mime = MIME[(m.container ?? path.extname(m.path ?? '').slice(1)).toLowerCase()] ?? 'application/octet-stream';
    if (m.path) {
      if (!fs.existsSync(m.path)) throw notFound('File is missing from disk');
      return sendFileRange(req, reply, m.path, mime);
    }
    const ua = db.get<{ user_agent: string | null }>('SELECT s.user_agent FROM live_sources s JOIN libraries l ON l.source_id = s.id JOIN items i ON i.library_id = l.id WHERE i.id = ?', m.item_id)?.user_agent;
    return proxyRemote(req, reply, m.remote_url, ua || 'MediaMax/1.0', mime, isUntrustedMedia(m.item_id));
  });

  const hlsHandler = async (req: FastifyRequest<{ Params: { sessionId: string; file: string } }>, reply: FastifyReply) => {
    const a = requireUser(req);
    const s = touchSession(req.params.sessionId);
    if (!s) throw notFound('Playback session has ended');
    if (s.ctx.user.id !== a.user.id) throw forbidden();
    const file = req.params.file;
    const q = `?token=${encodeURIComponent(a.token)}`;
    // Adaptive transcode: master playlist of renditions + per-rendition playlists/segments (abr.ts).
    if (s.abr) {
      if (s.state === 'buffering' && file.endsWith('.m3u8')) s.state = 'playing';
      if (file === 'master.m3u8') {
        reply.header('Cache-Control', 'no-cache').type('application/vnd.apple.mpegurl');
        return s.abr.master(q);
      }
      const r = await renditionRequest(s.abr, file, q);
      if (!r) throw notFound();
      if (r.kind === 'playlist') {
        reply.header('Cache-Control', 'no-cache').type('application/vnd.apple.mpegurl');
        return r.body;
      }
      reply.type(r.type).header('Cache-Control', 'private, max-age=600');
      return fs.createReadStream(r.path);
    }
    const job = s.job ?? liveJobBySession.get(s.id);
    if (!job) throw notFound('No stream for this session');
    reply.header('Cache-Control', 'no-cache');
    // Dolby Vision remux: a real master playlist (DV CODECS / SUPPLEMENTAL-CODECS / VIDEO-RANGE) over ffmpeg's media playlist.
    if (file === 'master.m3u8' && job.opts.mode === 'remux' && job.opts.dolbyVision) {
      reply.type('application/vnd.apple.mpegurl');
      if (s.state === 'buffering') s.state = 'playing';
      return doviMasterForJob(job.opts.dolbyVision, () => job.initSegment(), `stream.m3u8${q}`);
    }
    if (file.endsWith('.m3u8')) {
      reply.type('application/vnd.apple.mpegurl');
      if (s.state === 'buffering') s.state = 'playing';
      if (job.opts.mode === 'transcode') return job.vodPlaylist(q);
      if (job.opts.mode === 'live') {
        await job.waitForPlaylist();
        return job.rewrittenPlaylist(q);
      }
      // Remux: serve ffmpeg's event playlist.
      await job.waitForPlaylist();
      return job.rewrittenPlaylist(q);
    }
    if (file === 'init.mp4' && job.segmentType === 'fmp4') {
      const initPath = await job.initSegment();
      reply.type('video/mp4').header('Cache-Control', 'private, max-age=600');
      return fs.createReadStream(initPath);
    }
    const m = file.match(/^seg(\d+)\.(ts|m4s)$/);
    if (!m || m[2] !== job.segmentExt) throw notFound();
    const n = parseInt(m[1], 10);
    let segPath: string;
    if (job.opts.mode === 'transcode') segPath = await job.waitForSegment(n);
    else {
      segPath = job.segmentPath(n);
      const deadline = Date.now() + 20000;
      while (!fs.existsSync(segPath) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 150));
      if (!fs.existsSync(segPath)) throw notFound('Segment not available');
    }
    reply.type(job.segmentType === 'fmp4' ? 'video/mp4' : 'video/mp2t').header('Cache-Control', 'private, max-age=600');
    return fs.createReadStream(segPath);
  };
  app.get<{ Params: { sessionId: string; file: string } }>('/stream/hls/:sessionId/:file', hlsHandler);
  app.get<{ Params: { sessionId: string; file: string } }>('/livetv/hls/:sessionId/:file', hlsHandler);

  // WebVTT (default, legacy) or the original format for the clients' own renderers: .srt / .ass / .ssa / .sup (streaming.ts).
  app.get<{ Params: { mediaId: string; index: string }; Querystring: { partial?: string } }>('/stream/subtitles/:mediaId/:index', serveSubtitle);

  app.get<{ Params: { itemId: string }; Querystring: { mediaId?: string; quality?: DownloadQuality } }>('/stream/download/:itemId', async (req, reply) => {
    const { user } = requireUser(req);
    if (!user.allowDownloads && !user.isAdmin) throw forbidden('Downloads are not enabled for your account');
    assertRemoteAllowed(user, remoteAddr(req));
    const item = assertCanSee(user, req.params.itemId);
    const m = req.query.mediaId ? db.get('SELECT * FROM media WHERE id = ? AND item_id = ?', req.query.mediaId, item.id) : db.get('SELECT * FROM media WHERE item_id = ? ORDER BY COALESCE(width,0) DESC LIMIT 1', item.id);
    if (!m) throw notFound('No media to download');
    const ext = (m.container ?? path.extname(m.path ?? '').slice(1) ?? 'mp4').toLowerCase();
    const mime = MIME[ext] ?? 'application/octet-stream';
    const quality = req.query.quality && req.query.quality !== 'original' ? req.query.quality : null;
    if (quality) {
      if (!['1080p', '720p', '480p'].includes(quality)) throw badRequest('quality must be original, 1080p, 720p or 480p');
      if (!user.allowTranscode && !user.isAdmin) throw forbidden('Converted downloads need transcoding permission');
      return convertedDownload(req, reply, m, `${item.title}${item.year ? ` (${item.year})` : ''}`.replace(/[\\/:*?"<>|]/g, ''), quality, user.id);
    }
    const name = `${item.title}${item.year ? ` (${item.year})` : ''}.${ext}`.replace(/[\\/:*?"<>|]/g, '');
    if (m.path) return sendFileRange(req, reply, m.path, mime, name);
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    return proxyRemote(req, reply, m.remote_url, 'MediaMax/1.0', mime, isUntrustedMedia(item.id));
  });
}
