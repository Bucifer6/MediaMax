import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { HttpError } from './util/errors.js';
import { logger } from './util/log.js';
import { authHook } from './http.js';
import systemRoutes from './routes/system.js';
import brandingRoutes from './routes/branding.js';
import authRoutes from './routes/auth.js';
import libraryRoutes from './routes/library.js';
import playbackRoutes from './routes/playback.js';
import liveRoutes from './routes/livetv.js';
import wsRoutes from './routes/ws.js';
import extraRoutes from './routes/extras.js';
import dlnaRoutes from './routes/dlna.js';
import pluginRoutes from './routes/plugins.js';
import subsonicRoutes from './routes/subsonic.js';
import djRoutes from './routes/dj.js';

const log = logger('http');

export async function buildApp(): Promise<FastifyInstance> {
  // Only honour X-Forwarded-* from proxies on loopback/private networks (or an explicit list), so
  // internet clients can't spoof their address. Override with MEDIAMAX_TRUSTED_PROXIES (comma list / CIDRs).
  const trustProxy = process.env.MEDIAMAX_TRUSTED_PROXIES?.split(',').map((s) => s.trim()).filter(Boolean) ?? ['loopback', 'linklocal', 'uniquelocal'];
  const app = Fastify({ logger: false, trustProxy, bodyLimit: 50 * 1024 * 1024, routerOptions: { maxParamLength: 500 } });
  await app.register(cors, { origin: true, credentials: true, exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'] });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
  await app.register(websocket);

  // Accept an empty body on JSON requests (many clients send Content-Type on bodiless POSTs).
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = String(body ?? '').trim();
    if (!text) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }), undefined);
    }
  });
  app.decorateRequest('auth', null);
  app.addHook('onRequest', authHook);
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    if (!reply.hasHeader('X-Frame-Options')) reply.header('X-Frame-Options', 'SAMEORIGIN');
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.code, message: err.message, statusCode: err.statusCode });
    if (err.validation) return reply.status(400).send({ error: 'bad_request', message: err.message, statusCode: 400 });
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) log.error(`${req.method} ${req.url.replace(/([?&](token|api_key|password)=)[^&]+/gi, '$1***')} failed`, err);
    return reply.status(status).send({ error: status >= 500 ? 'internal_error' : 'error', message: status >= 500 ? 'Something went wrong on the server' : err.message, statusCode: status });
  });

  await app.register(async (api) => {
    await api.register(systemRoutes);
    await api.register(brandingRoutes);
    await api.register(authRoutes);
    await api.register(libraryRoutes);
    await api.register(playbackRoutes);
    await api.register(liveRoutes);
    await api.register(wsRoutes);
    await api.register(extraRoutes);
    await api.register(pluginRoutes);
    await api.register(djRoutes);
  }, { prefix: '/api/v1' });

  await app.register(dlnaRoutes);
  await app.register(subsonicRoutes);
  app.get('/health', async () => ({ ok: true }));

  // Web client (SPA) — served if built.
  if (fs.existsSync(path.join(config.webDir, 'index.html'))) {
    // Files are resolved per request (no startup index), so rebuilding the web app needs no restart.
    // Hashed assets are immutable; index.html is never cached.
    await app.register(fastifyStatic, {
      root: config.webDir, wildcard: false, serve: false,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'not_found', message: 'Not found', statusCode: 404 });
      if (req.method !== 'GET' && req.method !== 'HEAD') return reply.status(404).send({ error: 'not_found', message: 'Not found', statusCode: 404 });
      let rel = '';
      try {
        rel = decodeURIComponent(req.url.split('?')[0]);
      } catch {
        /* malformed */
      }
      const file = path.resolve(config.webDir, '.' + rel);
      if (rel !== '/' && file.startsWith(config.webDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        reply.header('Cache-Control', rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
        return reply.sendFile(path.relative(config.webDir, file));
      }
      // Unknown asset paths must 404 (not return HTML), so the client can detect stale chunks.
      if (rel.startsWith('/assets/')) return reply.status(404).send('Not found');
      const index = path.join(config.webDir, 'index.html');
      if (!fs.existsSync(index)) return reply.status(503).send('Web client is being rebuilt, try again in a moment');
      return reply.type('text/html').header('Cache-Control', 'no-cache').send(fs.readFileSync(index, 'utf8'));
    });
  } else {
    app.get('/', async (_req, reply) => reply.type('text/html').send('<h1>MediaMax server is running</h1><p>The web client has not been built. Run <code>npm run build</code>.</p>'));
  }
  return app;
}
