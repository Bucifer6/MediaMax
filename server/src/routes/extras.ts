import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { requireAdmin, requireUser } from '../http.js';
import { assertCanSee, getItem } from '../services/items.js';
import { sheetPath, trickplayInfo } from '../services/trickplay.js';
import { serverStats, userStats } from '../services/stats.js';
import { deleteDownloadedSubtitle, downloadSubtitle, searchSubtitles } from '../services/opensubtitles.js';
import { disconnect, setScrobble, startDeviceAuth, traktStatus } from '../services/trakt.js';
import { notFound, badRequest } from '../util/errors.js';
import { toInt } from '../util/misc.js';
import { getLyrics } from '../services/lyrics.js';

export default async function extraRoutes(app: FastifyInstance) {
  /* ------------------------------ trickplay ------------------------- */
  app.get<{ Params: { id: string }; Querystring: { mediaId?: string } }>('/items/:id/trickplay', async (req) => {
    const a = requireUser(req);
    assertCanSee(a.user, req.params.id);
    const m = req.query.mediaId
      ? db.get('SELECT id FROM media WHERE id = ? AND item_id = ?', req.query.mediaId, req.params.id)
      : db.get('SELECT id FROM media WHERE item_id = ? ORDER BY COALESCE(width,0) DESC LIMIT 1', req.params.id);
    const info = m ? trickplayInfo(m.id, a.token) : null;
    if (!info) throw notFound('No preview thumbnails for this item yet');
    return info;
  });
  app.get<{ Params: { mediaId: string; file: string } }>('/trickplay/:mediaId/:file', async (req, reply) => {
    const { user } = requireUser(req);
    const m = db.get('SELECT item_id FROM media WHERE id = ?', req.params.mediaId);
    if (!m) throw notFound();
    assertCanSee(user, m.item_id);
    const p = sheetPath(req.params.mediaId, parseInt(req.params.file, 10));
    if (!p) throw notFound();
    reply.type('image/jpeg').header('Cache-Control', 'private, max-age=604800');
    return fs.createReadStream(p);
  });

  /* -------------------------------- lyrics -------------------------- */
  app.get<{ Params: { id: string } }>('/items/:id/lyrics', async (req) => {
    const { user } = requireUser(req);
    assertCanSee(user, req.params.id);
    const l = await getLyrics(req.params.id);
    if (!l) throw notFound('No lyrics for this track');
    return l;
  });

  /* -------------------------------- stats --------------------------- */
  app.get<{ Querystring: { year?: string } }>('/stats/me', async (req) => {
    const { user } = requireUser(req);
    return userStats(user.id, req.query.year ? toInt(req.query.year, new Date().getFullYear(), 2000, 2100) : null);
  });
  app.get<{ Params: { id: string }; Querystring: { year?: string } }>('/stats/users/:id', async (req) => {
    requireAdmin(req);
    return userStats(req.params.id, req.query.year ? toInt(req.query.year, new Date().getFullYear(), 2000, 2100) : null);
  });
  app.get<{ Querystring: { days?: string } }>('/stats/server', async (req) => {
    requireAdmin(req);
    return serverStats(toInt(req.query.days, 30, 1, 366));
  });

  /* ------------------------------ subtitles ------------------------- */
  app.get<{ Params: { id: string }; Querystring: { languages?: string } }>('/items/:id/subtitles/search', async (req) => {
    const { user } = requireUser(req);
    assertCanSee(user, req.params.id);
    const langs = (req.query.languages ?? user.preferences.subtitleLanguage ?? 'en').split(',').map((s) => s.trim()).filter(Boolean);
    return searchSubtitles(req.params.id, langs);
  });
  app.post<{ Params: { id: string }; Body: { fileId: string; language: string; hearingImpaired?: boolean; forced?: boolean } }>('/items/:id/subtitles/download', async (req) => {
    const { user } = requireUser(req);
    assertCanSee(user, req.params.id);
    if (!req.body?.fileId) throw badRequest('fileId required');
    await downloadSubtitle(req.params.id, String(req.body.fileId), req.body.language, req.body);
    return getItem(user, req.params.id, true);
  });
  app.delete<{ Params: { id: string; index: string } }>('/items/:id/subtitles/:index', async (req) => {
    const a = requireAdmin(req);
    const m = db.get('SELECT id FROM media WHERE item_id = ? ORDER BY COALESCE(width,0) DESC LIMIT 1', req.params.id);
    if (!m) throw notFound();
    deleteDownloadedSubtitle(m.id, toInt(req.params.index, -1));
    return getItem(a.user, req.params.id, true);
  });

  /* -------------------------------- trakt --------------------------- */
  app.get('/trakt', async (req) => traktStatus(requireUser(req).user.id));
  app.post('/trakt/connect', async (req) => startDeviceAuth(requireUser(req).user.id));
  app.patch<{ Body: { scrobble: boolean } }>('/trakt', async (req) => {
    const { user } = requireUser(req);
    setScrobble(user.id, !!req.body?.scrobble);
    return traktStatus(user.id);
  });
  app.delete('/trakt', async (req) => {
    const { user } = requireUser(req);
    disconnect(user.id);
    return traktStatus(user.id);
  });
}
