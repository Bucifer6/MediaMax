/**
 * Service worker routing rules, kept pure so they can be unit-tested (web/test/sw.test.ts). The Vite plugin
 * (web/sw/plugin.ts) inlines this file into dist/sw.js (with the `export` keywords removed).
 *
 * What the worker may touch is deliberately tiny: the offline page, the hashed build assets and the static icons.
 * API responses, media, streams, HLS segments, artwork from /api and anything carrying credentials always go
 * straight to the network and are never stored.
 */

export const CACHE_PREFIX = 'mm-shell-';

/** The one cache a build uses: versioned by the build hash, so a new build never reads an old build's files. */
export const cacheName = (version) => CACHE_PREFIX + version;

/** Caches left by older builds (deleted when the new worker activates). Other caches on the origin are left alone. */
export const staleCaches = (names, version) => names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== cacheName(version));

/** Server paths (relative to the app's base path) that are never handled: API, Subsonic, DLNA, health, the worker. */
const BYPASS = /^(api|rest|dlna)(\/|$)|^(health|sw\.js|manifest\.webmanifest)$/;

/** Gateway errors from a reverse proxy mean the server itself is down: show the offline page for navigations. */
export const OFFLINE_STATUSES = [502, 503, 504];

/**
 * How the worker handles a request:
 *   'navigate' → network first; the offline page only when the network fails (or a proxy says the server is down)
 *   'asset'    → hashed build file: cache first (the name changes whenever the content does)
 *   'shell'    → a precached static file (offline page, icons): cache first within this build's cache
 *   'network'  → not handled at all (the browser fetches it as if there were no worker)
 *
 * @param {{ method: string, mode: string, url: string, hasAuth?: boolean }} req
 * @param {string} scope the registration scope, e.g. "https://media.example.com/" or "https://example.com/mediamax/"
 * @param {string[]} precache paths relative to the scope
 */
export function classify(req, scope, precache = []) {
  if (req.method !== 'GET' || req.hasAuth) return 'network';
  const url = new URL(req.url);
  const base = new URL(scope);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return 'network';
  const rel = url.pathname.slice(base.pathname.length);
  if (BYPASS.test(rel)) return 'network';
  if (req.mode === 'navigate') return 'navigate';
  if (url.search) return 'network';
  if (/^assets\/[^/]+$/.test(rel)) return 'asset';
  if (precache.includes(rel)) return 'shell';
  return 'network';
}

/**
 * The precache list for a build: the offline page and its script, the entry files index.html loads (JS, CSS,
 * modulepreloads) and the static icons/brand art. Lazy route chunks are cached the first time they are used.
 *
 * @param {{ entryAssets: string[], publicFiles: string[] }} build paths relative to the base path
 */
export function precacheList({ entryAssets, publicFiles }) {
  const shell = publicFiles.filter((f) => /^(favicon[^/]*|apple-touch-icon\.png|icon-[^/]+\.png|brand\/[^/]+\.svg)$/.test(f));
  return [...new Set(['offline.html', 'offline.js', ...entryAssets.filter((a) => /^assets\/[^/]+\.(js|css|woff2?)$/.test(a)), ...shell])].sort();
}
