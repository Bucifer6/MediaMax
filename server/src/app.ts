import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { HttpError } from './util/errors.js';
import { logger } from './util/log.js';
import { authHook } from './http.js';
import { dbPerf } from './db.js';
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
import securityRoutes from './routes/security.js';
import networkRoutes from './routes/network.js';
import { initNetwork, trustProxy } from './services/network.js';
import discoveryRoutes from './routes/discovery.js';
import metadataRoutes from './routes/metadata.js';

const log = logger('http');

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
/** Text responses worth compressing. HLS playlists and media are left alone (some TV players mishandle encoded playlists). */
const COMPRESSIBLE = /^(application\/(json|javascript|xml|manifest\+json)|text\/(html|css|plain|xml|javascript|vtt)|image\/svg\+xml)/i;

/**
 * Compress buffered text responses (API JSON, index.html, XML) for clients that accept it: Brotli at a fast level, else
 * gzip. Streamed bodies (media, images, files sent from disk, segments) are never touched; static assets are served
 * pre-compressed from the build (web/dist/assets/*.br|.gz).
 */
export async function compressPayload(req: { method: string; headers: Record<string, string | string[] | undefined> }, reply: { statusCode: number; getHeader(n: string): unknown; header(n: string, v: string): unknown; removeHeader(n: string): unknown }, payload: unknown): Promise<unknown> {
  if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return payload;
  if (req.method === 'HEAD' || reply.statusCode < 200 || reply.statusCode === 204 || reply.statusCode === 206 || reply.statusCode === 304) return payload;
  if (reply.getHeader('content-encoding')) return payload;
  const len = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length;
  // Below ~8 KB the saving is a fraction of a millisecond on any network, less than the compression costs.
  if (len < 8 * 1024) return payload;
  if (!COMPRESSIBLE.test(String(reply.getHeader('content-type') ?? ''))) return payload;
  const ae = String(req.headers['accept-encoding'] ?? '');
  const enc = /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : null;
  if (!enc) return payload;
  // Big bodies (a full TV guide is megabytes) use the fastest level: still ~7× smaller, in a few ms on a worker thread.
  const big = len > 512 * 1024;
  const body = enc === 'br'
    ? await brotli(payload, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: big ? 1 : 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: len } })
    : await gzip(payload, { level: big ? 1 : 5 });
  const vary = String(reply.getHeader('vary') ?? '');
  reply.header('Vary', vary ? (/accept-encoding/i.test(vary) ? vary : `${vary}, Accept-Encoding`) : 'Accept-Encoding');
  reply.header('Content-Encoding', enc);
  reply.removeHeader('content-length');
  return body;
}

/** index.html, re-read only when the file changes (a rebuild while the server runs still needs no restart). */
let indexCache: { mtimeMs: number; size: number; html: string } | null = null;
function readIndex(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!indexCache || indexCache.mtimeMs !== st.mtimeMs || indexCache.size !== st.size) indexCache = { mtimeMs: st.mtimeMs, size: st.size, html: fs.readFileSync(file, 'utf8') };
    return indexCache.html;
  } catch {
    return null;
  }
}

/**
 * Content-Security-Policy of the web app (index.html). Scripts only from our origin (+ the Google Cast sender SDK),
 * no inline script or eval; WebAssembly (libass subtitles, AI stems) and blob: workers (hls.js, mpegts.js) allowed.
 * Styles may be inline (React style props) and web fonts (a theme's font URL, any https host). Images/media may come from anywhere (admin-set
 * logos, LAN picons). Frames: plugin pages (same origin) and trailers. ws/wss for this host are listed explicitly
 * because older TV browsers don't treat 'self' as covering WebSockets; child-src is the CSP2 fallback for workers.
 */
export function webAppCsp(host?: string): string {
  const h = host && /^[\w.:[\]-]+$/.test(host) ? host : null;
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' https://www.gstatic.com",
    "worker-src 'self' blob:",
    "child-src 'self' blob: https:",
    "frame-src 'self' https:",
    "style-src 'self' 'unsafe-inline' https:",
    "font-src 'self' data: https:",
    "img-src 'self' data: blob: https: http:",
    "media-src 'self' data: blob: https: http:",
    `connect-src 'self'${h ? ` ws://${h} wss://${h}` : ''} https://www.gstatic.com`,
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
}

/** Every registered route (method + path), for the route-table auth test. */
export const routeTable: { method: string; url: string }[] = [];

export async function buildApp(): Promise<FastifyInstance> {
  // Only honour X-Forwarded-* from trusted proxies (default: loopback/private networks), so internet clients can't
  // spoof their address. Admin → Network changes the list live; MEDIAMAX_TRUSTED_PROXIES overrides it.
  initNetwork();
  const app = Fastify({ logger: false, trustProxy, bodyLimit: 50 * 1024 * 1024, routerOptions: { maxParamLength: 500 } });
  app.addHook('onRoute', (r) => {
    for (const m of [r.method].flat()) routeTable.push({ method: m, url: r.url });
  });
  await app.register(cors, { origin: true, credentials: true, exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'] });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
  // Client messages are small JSON events (remote control, SyncPlay): don't buffer ws's 100 MiB default per message.
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

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
  if (dbPerf.enabled) {
    // scripts/perf: statements run per request (exact when requests don't overlap) and handler time.
    app.addHook('onRequest', async (req) => {
      (req as any).perfQ = dbPerf.queries;
      (req as any).perfT = performance.now();
    });
    app.addHook('onSend', async (req, reply) => {
      reply.header('X-MM-Queries', String(dbPerf.queries - ((req as any).perfQ ?? 0)));
      reply.header('X-MM-Time', ((performance.now() - ((req as any).perfT ?? 0))).toFixed(2));
    });
  }
  app.addHook('onRequest', authHook);
  app.addHook('onSend', async (req, reply, payload) => compressPayload(req, reply, payload));
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
    await api.register((await import('./routes/streaming.js')).default);
    await api.register(liveRoutes);
    await api.register(wsRoutes);
    await api.register(extraRoutes);
    await api.register(pluginRoutes);
    await api.register(djRoutes);
    await api.register(securityRoutes);
    await api.register(networkRoutes);
    await api.register(discoveryRoutes);
    await api.register(metadataRoutes);
    await api.register((await import('./routes/arr.js')).default);
    await api.register((await import('./routes/requests.js')).default);
    await api.register((await import('./routes/transcoding.js')).default);
    await api.register((await import('./routes/smarthome.js')).default);
    await api.register((await import('./routes/renderers.js')).default);
    await api.register((await import('./routes/profiles.js')).default);
    await api.register((await import('./routes/help.js')).default);
    await api.register((await import('./routes/music.js')).default);
    await api.register((await import('./routes/karaoke.js')).default);
    await api.register((await import('./routes/serverImport.js')).default);
    await api.register((await import('./routes/pair.js')).default);
    await api.register((await import('./routes/wrapped.js')).default);
    await api.register((await import('./routes/decide.js')).default);
    await api.register((await import('./routes/ai.js')).default);
    await api.register((await import('./routes/downloads.js')).default);
  }, { prefix: '/api/v1' });

  await app.register(dlnaRoutes);
  await app.register(subsonicRoutes);
  app.get('/health', async () => ({ ok: true }));
  app.get('/manifest.webmanifest', async (_req, reply) => reply.type('application/manifest+json').header('Cache-Control', 'no-cache').send(JSON.stringify((await import('./services/branding.js')).webManifest())));

  // Web client (SPA) — served if built.
  if (fs.existsSync(path.join(config.webDir, 'index.html'))) {
    // Files are resolved per request (no startup index), so rebuilding the web app needs no restart.
    // Hashed assets are immutable; index.html is never cached.
    await app.register(fastifyStatic, {
      root: config.webDir, wildcard: false, serve: false, preCompressed: true,
      // We set Cache-Control per file below; @fastify/static's own default (max-age=0) used to overwrite it, so the
      // hashed, immutable assets were revalidated on every page load.
      cacheControl: false,
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
      let isFile = false;
      if (rel !== '/' && file.startsWith(config.webDir + path.sep)) {
        try {
          isFile = fs.statSync(file).isFile();
        } catch {
          /* missing */
        }
      }
      if (isFile) {
        reply.header('Cache-Control', rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
        return reply.sendFile(path.relative(config.webDir, file));
      }
      // Unknown asset paths must 404 (not return HTML), so the client can detect stale chunks.
      if (rel.startsWith('/assets/')) return reply.status(404).send('Not found');
      const html = readIndex(path.join(config.webDir, 'index.html'));
      if (html == null) return reply.status(503).send('Web client is being rebuilt, try again in a moment');
      return reply.type('text/html').header('Cache-Control', 'no-cache').header('Content-Security-Policy', webAppCsp(req.host)).send(html);
    });
  } else {
    app.get('/', async (_req, reply) => reply.type('text/html').send('<h1>Kinora server is running</h1><p>The web client has not been built. Run <code>npm run build</code>.</p>'));
  }
  return app;
}
