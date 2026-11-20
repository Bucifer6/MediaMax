import type { FastifyInstance } from 'fastify';
import type { ApplyMatchRequest, MatchSearchResponse, MetadataProviderId, MetadataSettings, MetadataSettingsResponse, MetadataTestResult } from '@mediamax/shared';
import { requireAdmin } from '../http.js';
import { getItem } from '../services/items.js';
import { refreshItem } from '../services/metadata/index.js';
import { applyMatch, metadataAdminState, searchMatch, testProvider } from '../services/metadata/builtin.js';
import { ALL_IDS, updateMetadataSettings } from '../services/metadata/config.js';
import { clearCache } from '../services/metadata/http.js';
import { logActivity } from '../services/activity.js';
import { badRequest } from '../util/errors.js';

/** Built-in metadata providers (Server settings → Metadata) and "Fix match". All admin-only. */
export default async function metadataRoutes(app: FastifyInstance) {
  app.get('/admin/metadata', async (req): Promise<MetadataSettingsResponse> => {
    requireAdmin(req);
    return metadataAdminState();
  });

  app.put<{ Body: Partial<MetadataSettings> }>('/admin/metadata', async (req): Promise<MetadataSettingsResponse> => {
    const a = requireAdmin(req);
    updateMetadataSettings(req.body ?? {});
    logActivity('settings', 'Metadata provider settings updated', { userId: a.user.id, userName: a.user.displayName });
    return metadataAdminState();
  });

  /** Live test; the body may carry an unsaved key/PIN from the form ("••••" = the stored one). */
  app.post<{ Params: { id: string }; Body: { apiKey?: string | null; pin?: string | null } }>('/admin/metadata/:id/test', async (req): Promise<MetadataTestResult> => {
    requireAdmin(req);
    if (!ALL_IDS.includes(req.params.id as MetadataProviderId)) throw badRequest('Unknown provider');
    return testProvider(req.params.id as MetadataProviderId, { apiKey: req.body?.apiKey, pin: req.body?.pin });
  });

  app.delete<{ Querystring: { provider?: string } }>('/admin/metadata/cache', async (req) => {
    requireAdmin(req);
    clearCache(req.query.provider || undefined);
    return { ok: true };
  });

  /* ------------------------------ Fix match ------------------------------ */
  app.get<{ Params: { id: string }; Querystring: { provider?: string; q?: string; year?: string } }>('/items/:id/match', async (req): Promise<MatchSearchResponse> => {
    requireAdmin(req);
    const y = req.query.year;
    return searchMatch(req.params.id, { provider: req.query.provider, query: req.query.q, year: y === undefined ? undefined : y === '' ? null : Number(y) || null });
  });

  app.post<{ Params: { id: string }; Body: ApplyMatchRequest }>('/items/:id/match', async (req) => {
    const a = requireAdmin(req);
    const b = req.body ?? ({} as ApplyMatchRequest);
    if (!b.provider || !b.id) throw badRequest('provider and id are required');
    await applyMatch(req.params.id, b.provider, String(b.id), refreshItem);
    const item = getItem(a.user, req.params.id, true);
    logActivity('metadata', `Fixed match of "${item.title}" (${b.provider} ${b.id})`, { userId: a.user.id, userName: a.user.displayName });
    return item;
  });
}
