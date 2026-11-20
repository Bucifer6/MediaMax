import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAdmin, extractToken } from '../http.js';
import * as plugins from '../services/plugins.js';
import { forbidden, notFound, unauthorized, badRequest } from '../util/errors.js';
import { mimeFor } from '../services/images.js';

const UI_MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

export default async function pluginRoutes(app: FastifyInstance) {
  /* ------------------------------ management ------------------------ */
  app.get('/admin/plugins', async (req) => plugins.listPlugins(requireAdmin(req).token));
  app.get<{ Querystring: { refresh?: string } }>('/admin/plugins/catalog', async (req) => {
    requireAdmin(req);
    return plugins.catalog(req.query.refresh === 'true');
  });
  app.post<{ Body: { id: string; version?: string } }>('/admin/plugins/install', async (req) => {
    const a = requireAdmin(req);
    if (!req.body?.id) throw badRequest('id required');
    return plugins.installFromCatalog(req.body.id, req.body.version, a.user, a.token);
  });
  app.post('/admin/plugins/upload', async (req) => {
    const a = requireAdmin(req);
    const file = await req.file({ limits: { fileSize: 50 * 1024 * 1024 } });
    if (!file) throw badRequest('Upload a .tar.gz plugin package (field "file")');
    return plugins.installUpload(await file.toBuffer(), a.user, a.token);
  });
  app.post<{ Params: { id: string } }>('/admin/plugins/:id/enable', async (req) => {
    const a = requireAdmin(req);
    return plugins.setEnabled(req.params.id, true, a.user, a.token);
  });
  app.post<{ Params: { id: string } }>('/admin/plugins/:id/disable', async (req) => {
    const a = requireAdmin(req);
    return plugins.setEnabled(req.params.id, false, a.user, a.token);
  });
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/admin/plugins/:id/settings', async (req) => {
    const a = requireAdmin(req);
    return plugins.updateSettings(req.params.id, req.body ?? {}, a.token);
  });
  app.delete<{ Params: { id: string } }>('/admin/plugins/:id', async (req) => {
    const a = requireAdmin(req);
    await plugins.uninstall(req.params.id, a.user);
    return { ok: true };
  });

  /* --------------------------- plugin namespace --------------------- */
  // Admin page assets (sandboxed: plugin pages can't script the main app's origin storage).
  app.get<{ Params: { id: string; '*': string } }>('/plugins/:id/ui/*', async (req, reply) => {
    requireAdmin(req);
    const file = plugins.pluginUiFile(req.params.id, req.params['*'] || 'index.html');
    if (!file) throw notFound();
    const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
    reply.header('Content-Security-Policy', "sandbox allow-scripts allow-forms; default-src 'self' 'unsafe-inline' data: blob:; connect-src 'self'")
      .header('Cache-Control', 'no-cache').type(UI_MIME[ext] ?? mimeFor(file));
    return fs.createReadStream(file);
  });

  const dispatch = async (req: FastifyRequest<{ Params: { id: string; '*': string } }>, reply: FastifyReply) => {
    const route = plugins.findRoute(req.params.id, req.method, req.params['*'] ?? '');
    if (!route) throw notFound('No such plugin route');
    if (route.auth !== 'public' && !req.auth) throw unauthorized();
    if (route.auth === 'admin' && !req.auth?.user.isAdmin) throw forbidden();
    void extractToken;
    const result = await route.handler({
      method: req.method, path: req.params['*'] ?? '', params: route.params, query: (req.query ?? {}) as Record<string, string>,
      body: req.body, user: req.auth?.user ?? null, headers: req.headers,
    });
    if (result === undefined) return reply.status(204).send();
    return result;
  };
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    app.route({ method, url: '/plugins/:id/*', handler: dispatch });
  }
}
