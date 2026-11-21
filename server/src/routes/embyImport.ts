import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { EmbyImportConfig, EmbyImportOptions } from '@mediamax/shared';
import { requireAdmin } from '../http.js';
import { getImportConfig, getJob, previewImport, saveImportConfig, startImport, testConnection } from '../services/embyImport.js';

const flag = (v: string | undefined, def: boolean) => (v === undefined ? def : v === '1' || v === 'true');

/** Admin → Import from Emby. All admin-only. */
export default async function embyImportRoutes(app: FastifyInstance) {
  const origin = (req: FastifyRequest) => `${req.protocol}://${req.host}`;

  app.get('/admin/emby-import/config', async (req) => {
    requireAdmin(req);
    return getImportConfig();
  });

  app.put<{ Body: Partial<EmbyImportConfig> }>('/admin/emby-import/config', async (req) => {
    const a = requireAdmin(req);
    return saveImportConfig(req.body ?? {}, a.user);
  });

  /** The body may carry unsaved form values ("••••" = the stored key). */
  app.post<{ Body: { url?: string; apiKey?: string } }>('/admin/emby-import/test', async (req) => {
    requireAdmin(req);
    return testConnection({ url: req.body?.url, apiKey: req.body?.apiKey });
  });

  /** Dry run: reads Emby and reports what an import would do; changes nothing. */
  app.get<{ Querystring: Record<string, string | undefined> }>('/admin/emby-import/preview', async (req) => {
    requireAdmin(req);
    const q = req.query;
    const o: EmbyImportOptions = {
      updateExisting: flag(q.updateExisting, false), mergeExisting: flag(q.mergeExisting, true), includeDisabled: flag(q.includeDisabled, true),
      importWatched: flag(q.importWatched, true), importResume: flag(q.importResume, true), importFavorites: flag(q.importFavorites, true),
      importPlaylists: flag(q.importPlaylists, true), importCollections: flag(q.importCollections, true),
    };
    return previewImport(o);
  });

  app.post<{ Body: EmbyImportOptions }>('/admin/emby-import/run', async (req) => {
    const a = requireAdmin(req);
    return startImport(a.user, req.body ?? {}, origin(req));
  });

  /** The running import, or the last finished one (with its set-password links), or null. */
  app.get('/admin/emby-import/job', async (req) => {
    requireAdmin(req);
    return getJob();
  });
}
