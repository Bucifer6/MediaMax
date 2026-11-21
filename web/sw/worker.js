/* Kinora service worker. Built by web/sw/plugin.ts: VERSION, PRECACHE and the helpers in web/sw/core.js are
 * prepended at build time. Its only job is to show a branded "server offline" page instead of the browser's error
 * page, and to serve the hashed app files from cache. See docs/FEATURES.md → "Offline page". */
/* global VERSION, PRECACHE, cacheName, staleCaches, classify, OFFLINE_STATUSES */

const CACHE = cacheName(VERSION);
const scopeUrl = (p) => new URL(p, self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Bypass the HTTP cache so the precache matches this build exactly.
    await cache.addAll(PRECACHE.map((p) => new Request(scopeUrl(p), { cache: 'reload' })));
    // A new build takes over at once. Pages are always loaded from the network, so this never mixes builds:
    // a still-open old page that asks for an old chunk gets it from the network (or reloads, see App.tsx lazyPage).
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await Promise.all(staleCaches(await caches.keys(), VERSION).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

async function offlinePage() {
  const cache = await caches.open(CACHE);
  const page = await cache.match(scopeUrl('offline.html'));
  return page ?? new Response('Server offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

async function navigate(request) {
  try {
    const res = await fetch(request);
    return OFFLINE_STATUSES.includes(res.status) ? offlinePage() : res;
  } catch {
    return offlinePage();
  }
}

async function cacheFirst(request, store) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (store && res.ok && res.type === 'basic') await cache.put(request, res.clone()).catch(() => undefined);
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const kind = classify({ method: req.method, mode: req.mode, url: req.url, hasAuth: req.headers.has('authorization') }, self.registration.scope, PRECACHE);
  if (kind === 'navigate') event.respondWith(navigate(req));
  else if (kind === 'asset') event.respondWith(cacheFirst(req, true));
  else if (kind === 'shell') event.respondWith(cacheFirst(req, false));
  // 'network': no respondWith, the browser fetches it normally (API, media, streams, images, anything else).
});

self.addEventListener('message', (event) => {
  if (event.data === 'version' && event.ports[0]) event.ports[0].postMessage(VERSION);
});
