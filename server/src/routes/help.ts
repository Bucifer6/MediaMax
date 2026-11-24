import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { HelpArticle, HelpIndex, HelpSearchResponse, HelpWhatsNew } from '@mediamax/shared';
import { config } from '../config.js';
import { requireAdmin } from '../http.js';
import { getBranding } from '../services/branding.js';
import { helpArticle, helpIndex, helpSearch, helpWhatsNew } from '../services/help.js';
import { diagnosticsZip } from '../services/diagnostics.js';
import { logActivity } from '../services/activity.js';
import { HttpError, notFound } from '../util/errors.js';

/**
 * Help Centre (articles in server/help, see docs/HELP.md) and the admin diagnostics bundle.
 *
 * Help is readable without signing in (the login screen and the phone/TV apps link to it), but admin-only
 * articles exist only for administrators: anyone else gets 404 for them and never sees them in the index or search.
 */
export default async function helpRoutes(app: FastifyInstance) {
  const ctx = (req: FastifyRequest) => ({ isAdmin: !!req.auth?.user.isAdmin, product: getBranding().serverName || 'Vibe' });

  /** Articles only change with the server version and the product name: cache per audience with an ETag. */
  function cached<T>(req: FastifyRequest, reply: FastifyReply, key: string, body: () => T): T | FastifyReply {
    const { isAdmin, product } = ctx(req);
    const etag = `"${crypto.createHash('sha1').update(`${config.version}|${product}|${isAdmin ? 'a' : 'u'}|${key}`).digest('base64url').slice(0, 20)}"`;
    reply.header('ETag', etag).header('Cache-Control', 'private, max-age=300').header('Vary', 'Authorization');
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();
    return body();
  }

  app.get('/help', async (req, reply) => {
    const { isAdmin, product } = ctx(req);
    return cached<HelpIndex>(req, reply, 'index', () => helpIndex(isAdmin, product));
  });

  app.get<{ Querystring: { q?: string } }>('/help/search', async (req): Promise<HelpSearchResponse> => {
    const { isAdmin, product } = ctx(req);
    return helpSearch(String(req.query.q ?? ''), isAdmin, product);
  });

  app.get('/help/whats-new', async (req, reply) => {
    const { product } = ctx(req);
    const w = helpWhatsNew(product);
    if (!w) throw notFound('No release notes');
    return cached<HelpWhatsNew>(req, reply, 'whats-new', () => w);
  });

  app.get<{ Params: { slug: string } }>('/help/:slug', async (req, reply) => {
    const { isAdmin, product } = ctx(req);
    const a = helpArticle(req.params.slug, isAdmin, product);
    if (!a) throw notFound('Article not found');
    return cached<HelpArticle>(req, reply, `a:${a.slug}`, () => a);
  });

  /* Admin → Activity & logs → Download diagnostics. One bundle per admin every 30 seconds. */
  const lastRun = new Map<string, number>();
  app.get('/admin/diagnostics.zip', async (req, reply) => {
    const a = requireAdmin(req);
    const now = Date.now();
    const prev = lastRun.get(a.user.id) ?? 0;
    if (now - prev < 30_000) {
      reply.header('Retry-After', String(Math.ceil((30_000 - (now - prev)) / 1000)));
      throw new HttpError(429, 'A diagnostics bundle was just created. Try again in a few seconds.', 'rate_limited');
    }
    lastRun.set(a.user.id, now);
    const zip = diagnosticsZip();
    logActivity('server', 'Diagnostics bundle downloaded', { userId: a.user.id, userName: a.user.displayName });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    reply.header('Content-Type', 'application/zip').header('Content-Disposition', `attachment; filename="diagnostics-${stamp}.zip"`).header('Cache-Control', 'no-store');
    return reply.send(zip);
  });
}
