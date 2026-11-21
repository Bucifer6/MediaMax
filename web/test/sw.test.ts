// Service worker routing + cache versioning, and TV "Press Back again to exit" (run: npm test -w web).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cacheName, classify, precacheList, staleCaches, CACHE_PREFIX } from '../sw/core.js';
import { createBackToExit, exitApp, isHomeScreen, EXIT_WINDOW_MS } from '../src/tv/backExit.ts';
import { isTvWrapper, offlineBrand } from '../src/sw/register.ts';

const SCOPE = 'https://media.example.com/';
const PRE = precacheList({
  entryAssets: ['assets/index-abc.js', 'assets/react-def.js', 'assets/index-xyz.css', 'favicon.svg', 'manifest.webmanifest'],
  publicFiles: ['favicon.svg', 'favicon.ico', 'favicon-32.png', 'icon-192.png', 'apple-touch-icon.png', 'og-image.png', 'brand/mark.svg', 'brand/wordmark-dark.svg'],
});
const kind = (url: string, extra: Partial<{ method: string; mode: string; hasAuth: boolean }> = {}, scope = SCOPE) =>
  classify({ method: 'GET', mode: 'no-cors', url, ...extra }, scope, PRE);

test('precache: only the offline page, entry assets and static icons (never index.html, API or media)', () => {
  assert.deepEqual(PRE, [
    'apple-touch-icon.png', 'assets/index-abc.js', 'assets/index-xyz.css', 'assets/react-def.js', 'brand/mark.svg', 'brand/wordmark-dark.svg',
    'favicon-32.png', 'favicon.ico', 'favicon.svg', 'icon-192.png', 'offline.html', 'offline.js',
  ]);
  assert.ok(!PRE.includes('index.html') && !PRE.includes('og-image.png') && !PRE.includes('manifest.webmanifest'));
});

test('classify: API, streams, HLS, images from /api, Subsonic, DLNA and anything authenticated are never handled', () => {
  for (const u of [
    'api/v1/items/1', 'api/v1/images/abc?w=300', 'api/v1/stream/abc/master.m3u8', 'api/v1/hls/abc/seg-001.m4s', 'api/v1/branding/logo.png',
    'api/v1/system/info', 'rest/ping.view', 'dlna/description.xml', 'health', 'sw.js', 'manifest.webmanifest',
  ]) {
    assert.equal(kind(SCOPE + u), 'network', u);
    assert.equal(kind(SCOPE + u, { mode: 'navigate' }), 'network', `navigate ${u}`);
  }
  assert.equal(kind(SCOPE + 'assets/index-abc.js', { hasAuth: true }), 'network');
  assert.equal(kind(SCOPE + 'assets/index-abc.js', { method: 'POST' }), 'network');
  assert.equal(kind(SCOPE + 'og-image.png'), 'network');
  assert.equal(kind('https://fonts.gstatic.com/s/x.woff2'), 'network');
  assert.equal(kind('https://other.example.com/assets/index-abc.js'), 'network');
});

test('classify: navigations network-first, hashed assets cache-first, shell files from the precache', () => {
  assert.equal(kind(SCOPE, { mode: 'navigate' }), 'navigate');
  assert.equal(kind(SCOPE + 'item/123?x=1', { mode: 'navigate' }), 'navigate');
  assert.equal(kind(SCOPE + 'assets/Settings-DCG1_nyY.js'), 'asset');
  assert.equal(kind(SCOPE + 'assets/index-abc.js?v=1'), 'network');
  assert.equal(kind(SCOPE + 'offline.js'), 'shell');
  assert.equal(kind(SCOPE + 'brand/mark.svg'), 'shell');
});

test('classify: works under a reverse-proxy base path', () => {
  const scope = 'https://example.com/mediamax/';
  assert.equal(kind(scope + 'library/1', { mode: 'navigate' }, scope), 'navigate');
  assert.equal(kind(scope + 'assets/index-abc.js', {}, scope), 'asset');
  assert.equal(kind(scope + 'api/v1/items', { mode: 'navigate' }, scope), 'network');
  assert.equal(kind('https://example.com/other-app/', { mode: 'navigate' }, scope), 'network');
});

test('caches are versioned per build and old ones are deleted', () => {
  assert.equal(cacheName('abc123'), `${CACHE_PREFIX}abc123`);
  assert.deepEqual(staleCaches(['mm-shell-old1', 'mm-shell-abc123', 'mm-shell-old2', 'someone-else'], 'abc123'), ['mm-shell-old1', 'mm-shell-old2']);
});

test('built worker: versioned and wired up (after npm run build)', { skip: !fs.existsSync(new URL('../dist/sw.js', import.meta.url)) }, () => {
  const sw = fs.readFileSync(new URL('../dist/sw.js', import.meta.url), 'utf8');
  const version = /const VERSION = "([0-9a-f]{12})"/.exec(sw)?.[1];
  assert.ok(version, 'no build version');
  assert.match(sw, /skipWaiting\(\)/);
  assert.match(sw, /clients\.claim\(\)/);
  assert.match(sw, /staleCaches\(await caches\.keys\(\), VERSION\)/);
  assert.ok(!/^export /m.test(sw), 'export left in the classic worker script');
  const pre: string[] = JSON.parse(/const PRECACHE = (\[.*\]);/.exec(sw)![1]);
  for (const p of pre) assert.ok(fs.existsSync(new URL(`../dist/${p}`, import.meta.url)), `precached file missing from dist: ${p}`);
  const html = fs.readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
  for (const m of html.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)) assert.ok(pre.includes(m[1]), `entry asset not precached: ${m[1]}`);
  assert.ok(!fs.readFileSync(new URL('../dist/offline.html', import.meta.url), 'utf8').includes('%BASE%'));
});

test('Back on TV home: first press arms, a second within 2 s exits, a late one arms again', () => {
  let t = 1000;
  const b = createBackToExit(() => t);
  assert.equal(b.press(), 'arm');
  t += EXIT_WINDOW_MS - 1;
  assert.equal(b.press(), 'exit');
  assert.equal(b.press(), 'arm');
  t += EXIT_WINDOW_MS + 1;
  assert.equal(b.press(), 'arm');
  b.reset();
  assert.equal(b.press(), 'arm');
});

test('home screen detection', () => {
  assert.ok(isHomeScreen('/'));
  assert.ok(isHomeScreen('/mediamax/', '/mediamax/'));
  assert.ok(isHomeScreen('/mediamax', '/mediamax/'));
  for (const p of ['/item/1', '/library/x', '/settings/playback', '/livetv']) assert.ok(!isHomeScreen(p), p);
});

test('exit uses the platform exit: Tizen, webOS, else the browser', () => {
  const calls: string[] = [];
  const base = { history: { length: 3, back: () => calls.push('back') }, close: () => calls.push('close'), navigator: { userAgent: 'Mozilla/5.0' } };
  assert.equal(exitApp({ ...base, tizen: { application: { getCurrentApplication: () => ({ exit: () => calls.push('tizen') }) } } }), 'tizen');
  assert.equal(exitApp({ ...base, webOS: { platformBack: () => calls.push('platformBack') } }), 'webos');
  assert.equal(exitApp({ ...base, navigator: { userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV)' } }), 'webos');
  assert.equal(exitApp(base), 'history');
  assert.equal(exitApp({ ...base, history: { length: 1, back: () => calls.push('back') } }), 'close');
  assert.deepEqual(calls, ['tizen', 'platformBack', 'close', 'back', 'close']);
  // A Tizen API that throws falls back instead of breaking Back.
  assert.equal(exitApp({ ...base, tizen: { application: { getCurrentApplication: () => { throw new Error('denied'); } } } }), 'history');
});

test('service worker is not registered in the TV wrapper apps', () => {
  assert.ok(isTvWrapper('Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0)', {}));
  assert.ok(isTvWrapper('Mozilla/5.0 (Web0S; Linux/SmartTV)', {}));
  assert.ok(isTvWrapper('Mozilla/5.0', { tizen: {} }));
  assert.ok(!isTvWrapper('Mozilla/5.0 (X11; Linux x86_64) Chrome/130', {}));
  assert.ok(!isTvWrapper('Mozilla/5.0 (Linux; Android 12; AFTKA) Chrome/120', {}));
});

test('offline page branding: name, logo and theme colours', () => {
  const colors = { primary: '#f00', primaryText: '#fff', background: '#000', surface: '#111', surfaceAlt: '#222', text: '#eee', textMuted: '#999', accent: '#0af', border: '#333', success: '#0f0', warning: '#ff0', danger: '#f00', overlay: '#0008' };
  const b = offlineBrand({ serverName: 'Smith Cinema', logoUrl: '/api/v1/branding/files/logo.png', logoWideUrl: null, splash: { backgroundColor: '#000', logoUrl: null } } as never, { mode: 'light', colors } as never);
  assert.deepEqual(b, { name: 'Smith Cinema', logo: '/api/v1/branding/files/logo.png', mode: 'light', colors: { bg: '#000', text: '#eee', muted: '#999', accent: '#0af', primary: '#f00', primaryText: '#fff' } });
});
