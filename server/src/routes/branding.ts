import { logActivity } from '../services/activity.js';
import { applyLook, listLooks } from '../services/looks.js';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Branding, BrandingAssetKind, Theme } from '@mediamax/shared';
import { requireAdmin } from '../http.js';
import { brandingCss, deleteBrandingAsset, deleteTheme, getBranding, saveBrandingAsset, updateBranding, upsertTheme } from '../services/branding.js';
import { config } from '../config.js';
import { badRequest, notFound } from '../util/errors.js';
import { mimeFor } from '../services/images.js';

export default async function brandingRoutes(app: FastifyInstance) {
  app.get('/branding', async (_req, reply) => {
    reply.header('Cache-Control', 'no-cache');
    return getBranding();
  });
  app.put<{ Body: Partial<Branding> }>('/branding', async (req) => {
    requireAdmin(req);
    return updateBranding(req.body ?? {});
  });
  app.post<{ Params: { kind: BrandingAssetKind } }>('/branding/assets/:kind', async (req) => {
    requireAdmin(req);
    const file = await req.file();
    if (!file) throw badRequest('No file uploaded (field "file")');
    return saveBrandingAsset(req.params.kind, file.filename, await file.toBuffer());
  });
  app.delete<{ Params: { kind: BrandingAssetKind } }>('/branding/assets/:kind', async (req) => {
    requireAdmin(req);
    return deleteBrandingAsset(req.params.kind);
  });
  app.get<{ Params: { file: string } }>('/branding/assets/:file', async (req, reply) => {
    const name = path.basename(req.params.file);
    const p = path.join(config.assetsDir, name);
    if (!fs.existsSync(p)) throw notFound();
    reply.header('Cache-Control', 'public, max-age=31536000, immutable').header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox").type(mimeFor(p));
    return fs.createReadStream(p);
  });
  app.get('/branding/looks', async (req) => {
    requireAdmin(req);
    return listLooks();
  });
  app.post<{ Params: { id: string } }>('/branding/looks/:id/apply', async (req) => {
    const a = requireAdmin(req);
    const b = applyLook(req.params.id);
    logActivity('branding', `Starter look "${req.params.id}" applied`, { userId: a.user.id, userName: a.user.displayName });
    return b;
  });
  app.post<{ Body: Theme }>('/branding/themes', async (req) => {
    requireAdmin(req);
    return upsertTheme(req.body);
  });
  app.put<{ Params: { id: string }; Body: Theme }>('/branding/themes/:id', async (req) => {
    requireAdmin(req);
    return upsertTheme(req.body, req.params.id);
  });
  app.delete<{ Params: { id: string } }>('/branding/themes/:id', async (req) => {
    requireAdmin(req);
    return deleteTheme(req.params.id);
  });
  app.get('/branding/custom.css', async (_req, reply) => {
    reply.type('text/css').header('Cache-Control', 'no-cache');
    return brandingCss();
  });
}
