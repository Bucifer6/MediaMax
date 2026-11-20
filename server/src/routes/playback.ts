import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PlaybackRequest, ProgressReport } from '@mediamax/shared';
import { db } from '../db.js';
import { requireAdmin, requireUser, remoteAddr } from '../http.js';
import { getSession, listSessions, sessionProgress, startPlayback, stopSession, subtitleVtt, touchSession } from '../services/playback.js';
import { assertCanSee } from '../services/items.js';
import { liveJobBySession } from '../services/livetv/livetv.js';
import { forbidden, notFound } from '../util/errors.js';
import { logActivity } from '../services/activity.js';

const MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', ts: 'video/mp2t', m2ts: 'video/mp2t', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic',
};

function sendFileRange(req: FastifyRequest, reply: FastifyReply, file: string, mime: string, download?: string) {
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
async function proxyRemote(req: FastifyRequest, reply: FastifyReply, url: string, userAgent: string, mime: string) {
  const headers: Record<string, string> = { 'User-Agent': userAgent };
  if (req.headers.range) headers.Range = req.headers.range;
  const ctrl = new AbortController();
  req.raw.on('close', () => ctrl.abort());
  const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
  if (!res.ok && res.status !== 206) throw notFound(`Provider returned ${res.status}`);
  reply.status(res.status);
  for (const h of ['content-length', 'content-range', 'accept-ranges']) {
    const v = res.headers.get(h);
    if (v) reply.header(h, v);
  }
  reply.header('Content-Type', res.headers.get('content-type')?.startsWith('video') ? res.headers.get('content-type')! : mime);
  return reply.send(res.body ? Readable.fromWeb(res.body as any) : '');
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
    return proxyRemote(req, reply, m.remote_url, ua || 'MediaMax/1.0', mime);
  });

  const hlsHandler = async (req: FastifyRequest<{ Params: { sessionId: string; file: string } }>, reply: FastifyReply) => {
    const a = requireUser(req);
    const s = touchSession(req.params.sessionId);
    if (!s) throw notFound('Playback session has ended');
    if (s.ctx.user.id !== a.user.id) throw forbidden();
    const job = s.job ?? liveJobBySession.get(s.id);
    if (!job) throw notFound('No stream for this session');
    const file = req.params.file;
    const q = `?token=${encodeURIComponent(a.token)}`;
    reply.header('Cache-Control', 'no-cache');
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
    const m = file.match(/^seg(\d+)\.ts$/);
    if (!m) throw notFound();
    const n = parseInt(m[1], 10);
    let segPath: string;
    if (job.opts.mode === 'transcode') segPath = await job.waitForSegment(n);
    else {
      segPath = job.segmentPath(n);
      const deadline = Date.now() + 20000;
      while (!fs.existsSync(segPath) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 150));
      if (!fs.existsSync(segPath)) throw notFound('Segment not available');
    }
    reply.type('video/mp2t').header('Cache-Control', 'private, max-age=600');
    return fs.createReadStream(segPath);
  };
  app.get<{ Params: { sessionId: string; file: string } }>('/stream/hls/:sessionId/:file', hlsHandler);
  app.get<{ Params: { sessionId: string; file: string } }>('/livetv/hls/:sessionId/:file', hlsHandler);

  app.get<{ Params: { mediaId: string; index: string } }>('/stream/subtitles/:mediaId/:index', async (req, reply) => {
    const { user } = requireUser(req);
    const m = db.get('SELECT item_id FROM media WHERE id = ?', req.params.mediaId);
    if (!m) throw notFound();
    assertCanSee(user, m.item_id);
    const idx = parseInt(req.params.index.replace(/\.vtt$/, ''), 10);
    const file = await subtitleVtt(req.params.mediaId, idx);
    reply.type('text/vtt; charset=utf-8').header('Cache-Control', 'private, max-age=86400');
    return fs.createReadStream(file);
  });

  app.get<{ Params: { itemId: string }; Querystring: { mediaId?: string } }>('/stream/download/:itemId', async (req, reply) => {
    const { user } = requireUser(req);
    if (!user.allowDownloads && !user.isAdmin) throw forbidden('Downloads are not enabled for your account');
    const item = assertCanSee(user, req.params.itemId);
    const m = req.query.mediaId ? db.get('SELECT * FROM media WHERE id = ? AND item_id = ?', req.query.mediaId, item.id) : db.get('SELECT * FROM media WHERE item_id = ? ORDER BY COALESCE(width,0) DESC LIMIT 1', item.id);
    if (!m) throw notFound('No media to download');
    const ext = (m.container ?? path.extname(m.path ?? '').slice(1) ?? 'mp4').toLowerCase();
    const mime = MIME[ext] ?? 'application/octet-stream';
    const name = `${item.title}${item.year ? ` (${item.year})` : ''}.${ext}`.replace(/[\\/:*?"<>|]/g, '');
    if (m.path) return sendFileRange(req, reply, m.path, mime, name);
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    return proxyRemote(req, reply, m.remote_url, 'MediaMax/1.0', mime);
  });
}
