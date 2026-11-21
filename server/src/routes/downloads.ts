import type { FastifyInstance } from 'fastify';
import type { DownloadPlanRequest, DownloadRuleInput, OfflineSyncEntry } from '@mediamax/shared';
import { requireUser } from '../http.js';
import { deleteRule, devicePlan, listRules, putRule, syncOffline } from '../services/smartDownloads.js';

/** Smart downloads (services/smartDownloads.ts): per-device show rules, the device plan, offline progress sync. */
export default async function downloadRoutes(app: FastifyInstance) {
  // The user's rules on every device (web "Downloads" page), or only this device's (?scope=device).
  app.get<{ Querystring: { scope?: 'device' | 'all' } }>('/downloads/rules', async (req) => listRules(requireUser(req), req.query.scope === 'device' ? 'device' : 'all'));
  // Create / update this device's rule for a show.
  app.put<{ Params: { showId: string }; Body: DownloadRuleInput }>('/downloads/rules/:showId', async (req) => putRule(requireUser(req), req.params.showId, req.body ?? ({} as DownloadRuleInput)));
  app.delete<{ Params: { id: string } }>('/downloads/rules/:id', async (req) => {
    deleteRule(requireUser(req), req.params.id);
    return { ok: true };
  });
  // What this device should have now (next N unwatched per rule), the state of what it has, and what to delete.
  app.post<{ Body: DownloadPlanRequest }>('/downloads/plan', async (req) => devicePlan(requireUser(req), req.body?.have ?? []));
  // Offline progress / watched changes, newest change wins.
  app.post<{ Body: { entries: OfflineSyncEntry[] } }>('/downloads/sync', async (req) => syncOffline(requireUser(req), req.body?.entries ?? []));
}
