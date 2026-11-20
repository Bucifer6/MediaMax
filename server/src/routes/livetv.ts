import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { ChannelQuery, CreateLiveSourceRequest, CreateRecordingRequest, CreateRecordingRuleRequest, LivePlayRequest, UpdateLiveSourceRequest } from '@mediamax/shared';
import { db } from '../db.js';
import { requireAdmin, requireUser, remoteAddr } from '../http.js';
import * as live from '../services/livetv/livetv.js';
import * as dvr from '../services/dvr.js';
import { touchSession, getSession } from '../services/playback.js';
import { forbidden, notFound } from '../util/errors.js';
import { toInt } from '../util/misc.js';
import { getSettings } from '../services/settings.js';

export default async function liveRoutes(app: FastifyInstance) {
  /* ------------------------------ sources --------------------------- */
  app.get('/livetv/sources', async (req) => {
    requireAdmin(req);
    return live.listSources();
  });
  app.post<{ Body: CreateLiveSourceRequest }>('/livetv/sources', async (req) => {
    requireAdmin(req);
    return live.createSource(req.body);
  });
  app.post<{ Body: CreateLiveSourceRequest }>('/livetv/sources/test', async (req) => {
    requireAdmin(req);
    return live.testSource(req.body);
  });
  app.patch<{ Params: { id: string }; Body: UpdateLiveSourceRequest }>('/livetv/sources/:id', async (req) => {
    requireAdmin(req);
    return live.updateSource(req.params.id, req.body ?? {});
  });
  app.delete<{ Params: { id: string } }>('/livetv/sources/:id', async (req) => {
    requireAdmin(req);
    live.deleteSource(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/livetv/sources/:id/refresh', async (req) => {
    requireAdmin(req);
    live.getSourceRow(req.params.id);
    void live.refreshSource(req.params.id);
    return { ok: true };
  });

  /* ------------------------- categories/channels -------------------- */
  app.get<{ Querystring: { sourceId?: string } }>('/livetv/categories', async (req) => live.listCategories(requireUser(req).user, req.query.sourceId));
  app.patch<{ Params: { id: string }; Body: { hidden?: boolean; sortOrder?: number; name?: string } }>('/livetv/categories/:id', async (req) => {
    requireAdmin(req);
    return live.updateCategory(req.params.id, req.body ?? {});
  });
  app.get<{ Querystring: ChannelQuery & Record<string, string> }>('/livetv/channels', async (req) => {
    const q = req.query;
    return live.listChannels(requireUser(req).user, { ...q, limit: toInt(q.limit, 200, 1, 2000), offset: toInt(q.offset, 0, 0), favorite: q.favorite as any, withEpg: q.withEpg === undefined ? true : String(q.withEpg) !== 'false' });
  });
  app.get<{ Params: { id: string } }>('/livetv/channels/:id', async (req) => live.getChannel(requireUser(req).user, req.params.id));
  app.patch<{ Params: { id: string }; Body: { number?: number; name?: string; hidden?: boolean; epgChannelId?: string; logoUrl?: string } }>('/livetv/channels/:id', async (req) => {
    const a = requireAdmin(req);
    live.updateChannel(req.params.id, req.body ?? {});
    return live.getChannel(a.user, req.params.id);
  });
  app.post<{ Params: { id: string } }>('/livetv/channels/:id/favorite', async (req) => live.setChannelFavorite(requireUser(req).user, req.params.id, true));
  app.delete<{ Params: { id: string } }>('/livetv/channels/:id/favorite', async (req) => live.setChannelFavorite(requireUser(req).user, req.params.id, false));
  app.get<{ Params: { id: string }; Querystring: { start?: string; end?: string } }>('/livetv/channels/:id/programs', async (req) => live.channelPrograms(requireUser(req).user, req.params.id, req.query.start, req.query.end));
  app.get<{ Querystring: { start?: string; end?: string; categoryId?: string; favorite?: string; offset?: string; limit?: string; sourceId?: string } }>('/livetv/guide', async (req) => {
    const q = req.query;
    return live.guide(requireUser(req).user, { ...q, offset: toInt(q.offset, 0, 0), limit: toInt(q.limit, 300, 1, 1000) });
  });

  app.post<{ Params: { id: string }; Body: LivePlayRequest & { deviceProfile?: { containers?: string[] } } }>('/livetv/channels/:id/play', async (req) => live.playChannel(requireUser(req), req.params.id, req.body ?? {}, remoteAddr(req)));

  /** Raw MPEG-TS restream through the server (hides provider credentials). */
  app.get<{ Params: { channelId: string }; Querystring: { session?: string; catchupStart?: string; duration?: string } }>('/livetv/stream/:channelId', async (req, reply) => {
    const a = requireUser(req);
    const r = live.accessibleChannelRow(a.user, req.params.channelId);
    if (req.query.session) {
      const s = getSession(req.query.session);
      if (s && s.ctx.user.id !== a.user.id) throw forbidden();
    }
    if (req.query.catchupStart && !r.has_archive) throw forbidden('This channel does not support catch-up');
    const src = live.getSourceRow(r.source_id);
    if (!src.proxy_streams) throw forbidden('This source is not restreamed by the server');
    live.checkConnectionLimit(src);
    const start = req.query.catchupStart ? new Date(req.query.catchupStart) : null;
    if (start && (Number.isNaN(start.getTime()) || start.getTime() > Date.now())) throw forbidden('Invalid catch-up time');
    const url = live.channelStreamUrl(r, start ? { start, durationMin: toInt(req.query.duration, 60, 1, 600) } : undefined);
    const ctrl = new AbortController();
    const res = await fetch(url, { headers: { 'User-Agent': live.channelUserAgent(r) }, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok || !res.body) throw notFound(`Provider returned ${res.status}`);
    live.trackUpstream(r.source_id, 1);
    const keepAlive = req.query.session ? setInterval(() => touchSession(req.query.session!), 20000) : null;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      live.trackUpstream(r.source_id, -1);
      if (keepAlive) clearInterval(keepAlive);
      ctrl.abort();
    };
    req.raw.on('close', release);
    const body = Readable.fromWeb(res.body as any);
    body.on('end', release);
    body.on('error', release);
    reply.header('Content-Type', 'video/mp2t').header('Cache-Control', 'no-store');
    return reply.send(body);
  });

  /* -------------------------------- DVR ----------------------------- */
  app.get<{ Querystring: { status?: string } }>('/dvr/recordings', async (req) => dvr.listRecordings(requireUser(req).user, req.query.status));
  app.post<{ Body: CreateRecordingRequest }>('/dvr/recordings', async (req) => dvr.scheduleRecording(requireUser(req).user, req.body));
  app.delete<{ Params: { id: string } }>('/dvr/recordings/:id', async (req) => {
    dvr.cancelRecording(requireUser(req).user, req.params.id);
    return { ok: true };
  });
  app.get('/dvr/defaults', async (req) => {
    requireUser(req);
    const d = getSettings().dvr;
    return { paddingBeforeMin: d.paddingBeforeMin, paddingAfterMin: d.paddingAfterMin };
  });
  app.get('/dvr/rules', async (req) => dvr.listRules(requireUser(req).user));
  app.post<{ Body: CreateRecordingRuleRequest }>('/dvr/rules', async (req) => dvr.createRule(requireUser(req).user, req.body));
  app.patch<{ Params: { id: string }; Body: Partial<CreateRecordingRuleRequest> }>('/dvr/rules/:id', async (req) => dvr.updateRule(requireUser(req).user, req.params.id, req.body ?? {}));
  app.delete<{ Params: { id: string } }>('/dvr/rules/:id', async (req) => {
    dvr.deleteRule(requireUser(req).user, req.params.id);
    return { ok: true };
  });
}
