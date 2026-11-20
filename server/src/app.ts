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

const log = logger('http');

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 50 * 1024 * 1024, routerOptions: { maxParamLength: 500 } });
  await app.register(cors, { origin: true, credentials: true, exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'] });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
  await app.register(websocket);

  app.decorateRequest('auth', null);
  app.addHook('onRequest', authHook);

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.code, message: err.message, statusCode: err.statusCode });
    if (err.validation) return reply.status(400).send({ error: 'bad_request', message: err.message, statusCode: 400 });
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) log.error(`${req.method} ${req.url} failed`, err);
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
  }, { prefix: '/api/v1' });

  app.get('/health', async () => ({ ok: true }));

  // Web client (SPA) — served if built.
  if (fs.existsSync(path.join(config.webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: config.webDir, wildcard: false, maxAge: '1h' });
    const indexHtml = fs.readFileSync(path.join(config.webDir, 'index.html'), 'utf8');
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'not_found', message: 'Not found', statusCode: 404 });
      const file = path.join(config.webDir, decodeURIComponent(req.url.split('?')[0]));
      if (file.startsWith(config.webDir) && fs.existsSync(file) && fs.statSync(file).isFile()) return reply.sendFile(path.relative(config.webDir, file));
      return reply.type('text/html').header('Cache-Control', 'no-cache').send(indexHtml);
    });
  } else {
    app.get('/', async (_req, reply) => reply.type('text/html').send('<h1>MediaMax server is running</h1><p>The web client has not been built. Run <code>npm run build</code>.</p>'));
  }
  return app;
}
