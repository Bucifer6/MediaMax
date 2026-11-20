import type { FastifyInstance } from 'fastify';
import type { DjMixRequest, DjStatus } from '@mediamax/shared';
import { requireAdmin, requireUser } from '../http.js';
import { assertCanSee } from '../services/items.js';
import { analyseTrack, analysisStatus, getAnalysis } from '../services/dj/analysis.js';
import { buildMix } from '../services/dj/mix.js';
import { runTask } from '../services/tasks.js';
import { badRequest } from '../util/errors.js';

/** DJ mode: track analysis (BPM/key/energy/mix points) and automatic, beat- and key-aware mixes. */
export default async function djRoutes(app: FastifyInstance) {
  app.get('/dj/status', async (req): Promise<DjStatus> => {
    requireUser(req);
    return analysisStatus();
  });

  app.post('/dj/analyze', async (req) => {
    requireAdmin(req);
    void runTask('dj-analysis').catch(() => {});
    return { ok: true };
  });

  // Analysis for one track; analysed on demand (≈0.5 s) when it hasn't been yet.
  app.get<{ Params: { id: string } }>('/items/:id/analysis', async (req) => {
    const { user } = requireUser(req);
    const row = assertCanSee(user, req.params.id);
    if (row.type !== 'track') throw badRequest('Only music tracks can be analysed');
    return getAnalysis(req.params.id) ?? (await analyseTrack(req.params.id));
  });

  app.post<{ Body: DjMixRequest }>('/dj/mix', async (req) => {
    const { user } = requireUser(req);
    const body = req.body ?? {};
    if (body.history && (!Array.isArray(body.history) || body.history.length > 2000)) throw badRequest('history must be a list of up to 2000 item ids');
    if (body.genres && !Array.isArray(body.genres)) throw badRequest('genres must be a list');
    // Make sure the track we're mixing out of has been analysed, so the first transition is beat-matched.
    const last = body.history?.[body.history.length - 1];
    if (last && !getAnalysis(last)) {
      try {
        if (assertCanSee(user, last).type === 'track') await analyseTrack(last);
      } catch {
        /* unknown or hidden item: ignore */
      }
    }
    return buildMix(user, body);
  });
}
