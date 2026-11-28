import type { FastifyInstance } from 'fastify';
import type { CreateEpgSourceRequest, SetChannelMatchRequest, UpdateEpgSourceRequest } from '@mediamax/shared';
import { requireAdmin } from '../http.js';
import * as epg from '../services/livetv/epg/epg.js';
import { EPG_PRESETS } from '../services/livetv/epg/presets.js';
import { toInt } from '../util/misc.js';

/** TV guide providers and channel ↔ guide matching (admin only). Registered from routes/livetv.ts. */
export default async function epgRoutes(app: FastifyInstance) {
  app.get('/livetv/epg-sources', async (req) => {
    requireAdmin(req);
    return epg.listEpgSources();
  });
  app.post<{ Body: CreateEpgSourceRequest }>('/livetv/epg-sources', async (req) => {
    requireAdmin(req);
    return epg.createEpgSource(req.body);
  });
  app.get<{ Params: { id: string } }>('/livetv/epg-sources/:id', async (req) => {
    requireAdmin(req);
    return epg.getEpgSource(req.params.id);
  });
  for (const method of ['patch', 'put'] as const) {
    app[method]<{ Params: { id: string }; Body: UpdateEpgSourceRequest }>('/livetv/epg-sources/:id', async (req) => {
      requireAdmin(req);
      return epg.updateEpgSource(req.params.id, req.body ?? {});
    });
  }
  app.delete<{ Params: { id: string } }>('/livetv/epg-sources/:id', async (req) => {
    requireAdmin(req);
    epg.deleteEpgSource(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/livetv/epg-sources/:id/refresh', async (req) => {
    requireAdmin(req);
    epg.manualRefresh(req.params.id);
    return { ok: true };
  });

  /* Schedules Direct account management. */
  app.get<{ Params: { id: string } }>('/livetv/epg-sources/:id/sd/status', async (req) => {
    requireAdmin(req);
    return epg.sdStatus(req.params.id);
  });
  app.get<{ Params: { id: string }; Querystring: { country?: string; postalcode?: string } }>('/livetv/epg-sources/:id/sd/headends', async (req) => {
    requireAdmin(req);
    return epg.sdHeadends(req.params.id, String(req.query.country ?? '').toUpperCase(), String(req.query.postalcode ?? ''));
  });
  app.put<{ Params: { id: string; lineup: string } }>('/livetv/epg-sources/:id/sd/lineups/:lineup', async (req) => {
    requireAdmin(req);
    return epg.sdChangeLineup(req.params.id, req.params.lineup, true);
  });
  app.delete<{ Params: { id: string; lineup: string } }>('/livetv/epg-sources/:id/sd/lineups/:lineup', async (req) => {
    requireAdmin(req);
    return epg.sdChangeLineup(req.params.id, req.params.lineup, false);
  });

  /** Find epgshare01 guides that carry the live channels and add them (they then match automatically). */
  app.post('/livetv/epg-sources/auto', async (req) => {
    requireAdmin(req);
    return epg.autoGuides();
  });
  app.get('/livetv/epg-presets', async (req) => {
    requireAdmin(req);
    return EPG_PRESETS;
  });
  app.get<{ Querystring: { q?: string; epgSourceId?: string; limit?: string } }>('/livetv/epg-channels', async (req) => {
    requireAdmin(req);
    return epg.searchGuideChannels({ q: req.query.q, epgSourceId: req.query.epgSourceId, limit: toInt(req.query.limit, 50, 1, 200) });
  });
  app.get<{ Querystring: { epgSourceId?: string; epgChannelId?: string; offsetHours?: string } }>('/livetv/epg-preview', async (req) => {
    requireAdmin(req);
    epg.getEpgSourceRow(String(req.query.epgSourceId ?? ''));
    return epg.previewGuideChannel(String(req.query.epgSourceId), String(req.query.epgChannelId ?? ''), Number(req.query.offsetHours ?? 0) || 0);
  });

  /* Matching. */
  app.get<{ Querystring: { filter?: string; sourceId?: string; search?: string; offset?: string; limit?: string } }>('/livetv/matching', async (req) => {
    requireAdmin(req);
    const q = req.query;
    return epg.listMatching({ filter: q.filter, sourceId: q.sourceId, search: q.search, offset: toInt(q.offset, 0, 0), limit: toInt(q.limit, 200, 1, 1000) });
  });
  app.put<{ Params: { id: string }; Body: SetChannelMatchRequest }>('/livetv/channels/:id/match', async (req) => {
    requireAdmin(req);
    return epg.setChannelMatch(req.params.id, req.body ?? {});
  });
  app.post<{ Body: { sourceId?: string; minConfidence?: number } }>('/livetv/matching/accept-all', async (req) => {
    requireAdmin(req);
    return epg.acceptAllSuggestions(req.body ?? {});
  });
  app.post('/livetv/matching/rematch', async (req) => {
    requireAdmin(req);
    epg.matchAllGuides();
    epg.resolveMatches();
    return { ok: true };
  });
}
