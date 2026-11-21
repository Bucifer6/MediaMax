import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ImportConfig, ImportOptions, ImportSource } from '@mediamax/shared';
import { requireAdmin } from '../http.js';
import { getImportConfig, getJob, previewImport, saveImportConfig, sourceOf, startImport, testConnection } from '../services/import/index.js';

const flag = (v: string | undefined, def: boolean) => (v === undefined ? def : v === '1' || v === 'true');

/**
 * Admin → Import from another server (Emby, Jellyfin, Plex). All admin-only. `/admin/import/:source/*` is the API;
 * the original `/admin/emby-import/*` paths stay as aliases for source = emby.
 */
export default async function serverImportRoutes(app: FastifyInstance) {
  const origin = (req: FastifyRequest) => `${req.protocol}://${req.host}`;

  const routes = (prefix: string, src: (req: FastifyRequest) => ImportSource) => {
    app.get(`${prefix}/config`, async (req) => {
      requireAdmin(req);
      return getImportConfig(src(req));
    });

    app.put<{ Body: Partial<ImportConfig> }>(`${prefix}/config`, async (req) => {
      const a = requireAdmin(req);
      return saveImportConfig(src(req), req.body ?? {}, a.user);
    });

    /** The body may carry unsaved form values ("••••" = the stored key/token). */
    app.post<{ Body: { url?: string; apiKey?: string } }>(`${prefix}/test`, async (req) => {
      requireAdmin(req);
      return testConnection(src(req), { url: req.body?.url, apiKey: req.body?.apiKey });
    });

    /** Dry run: reads the source and reports what an import would do; changes nothing. `quick=1`: counts only. */
    app.get<{ Querystring: Record<string, string | undefined> }>(`${prefix}/preview`, async (req) => {
      requireAdmin(req);
      const q = req.query;
      const o: ImportOptions = {
        updateExisting: flag(q.updateExisting, false), mergeExisting: flag(q.mergeExisting, true), includeDisabled: flag(q.includeDisabled, true),
        importWatched: flag(q.importWatched, true), importResume: flag(q.importResume, true), importFavorites: flag(q.importFavorites, true),
        importPlaylists: flag(q.importPlaylists, true), importCollections: flag(q.importCollections, true), importHistory: flag(q.importHistory, true),
      };
      return previewImport(src(req), o, flag(q.quick, false));
    });
  };

  routes('/admin/import/:source', (req) => sourceOf((req.params as { source?: string }).source));
  routes('/admin/emby-import', () => 'emby');

  app.post<{ Params: { source: string }; Body: ImportOptions }>('/admin/import/:source/run', async (req) => {
    const a = requireAdmin(req);
    return startImport(sourceOf(req.params.source), a.user, req.body ?? {}, origin(req));
  });
  app.post<{ Body: ImportOptions }>('/admin/emby-import/run', async (req) => {
    const a = requireAdmin(req);
    return startImport('emby', a.user, req.body ?? {}, origin(req));
  });

  /** The running import, or the last finished one (with its set-password links), or null. Any source. */
  for (const path of ['/admin/import/job', '/admin/emby-import/job']) {
    app.get(path, async (req) => {
      requireAdmin(req);
      return getJob();
    });
  }
}
