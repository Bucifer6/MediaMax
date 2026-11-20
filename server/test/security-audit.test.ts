// Regression tests for the security audit: route-table auth, remote-streaming policy, session revocation,
// SSRF (DNS rebinding, self-hosted ListenBrainz), link-code limits, ffmpeg filter escaping, secret masking,
// WebSocket limits, access-log redaction and the web app's CSP.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';

// A web build to serve (index.html), so the CSP header can be checked.
const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-web-'));
fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>MediaMax</title>');
process.env.MEDIAMAX_WEB_DIR = webDir;

const { createUser, issueToken, updateUser, authenticate, _resetLinks, LINK_LIMITS } = await import('../src/services/auth.ts');
const { getSettings, updateSettings, publicSettings, SECRET_MASK } = await import('../src/services/settings.ts');
const { buildApp, routeTable, webAppCsp } = await import('../src/app.ts');
const { safeFetch, setResolverForTests, isPrivateAddress } = await import('../src/util/net.ts');
const { lbFetch } = await import('../src/services/listenbrainz.ts');
const { escapeFilterPath } = await import('../src/services/transcoder.ts');
const { caddyfile, DEFAULT_NETWORK } = await import('../src/services/network.ts');
const { deviceInputArgs } = await import('../src/routes/renderers.ts');
const { setWsRecheckMs } = await import('../src/routes/ws.ts');
const { db } = await import('../src/db.ts');

setWsRecheckMs(200);
const app = await buildApp();
after(async () => {
  await app.close();
  fs.rmSync(webDir, { recursive: true, force: true });
});

const admin = createUser({ username: 'sec-admin', password: 'pass1234', isAdmin: true });
const viewer = createUser({ username: 'sec-viewer', password: 'pass1234' });
const homeOnly = createUser({ username: 'sec-home', password: 'pass1234', allowRemote: false });
const dev = (id: string) => ({ deviceId: id, deviceName: 'test', platform: 'web' as const });
const adminTok = issueToken(admin.id, dev('a')).token;
const viewerTok = issueToken(viewer.id, dev('v')).token;
const homeTok = issueToken(homeOnly.id, dev('h')).token;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
void adminTok;

/* ------------------------------------------------------------------ route table ------------------------------------------------------------------ */

/** Routes that answer without a MediaMax session, on purpose (each has its own protection where it needs one). */
const PUBLIC = new Set([
  'GET /health', 'GET /manifest.webmanifest', 'GET /*', 'HEAD /*',
  'GET /api/v1/system/info', 'POST /api/v1/setup', // setup refuses once a user exists
  'GET /api/v1/branding', 'GET /api/v1/branding/assets/:file', 'GET /api/v1/branding/custom.css',
  'POST /api/v1/auth/login', 'GET /api/v1/auth/profiles', 'POST /api/v1/auth/profile-login',
  'GET /api/v1/auth/oidc/start', 'GET /api/v1/auth/oidc/callback',
  'POST /api/v1/auth/link/request', 'GET /api/v1/auth/link/poll', // the poll token is the secret
  'GET /api/v1/invites/:code/preview', 'POST /api/v1/invites/:code/accept', // the invite code is the secret
  'GET /api/v1/images/:id', 'GET /api/v1/avatars', 'GET /api/v1/avatars/:file',
  'GET /api/v1/help', 'GET /api/v1/help/search', 'GET /api/v1/help/whats-new', 'GET /api/v1/help/:slug', // admin articles filtered
  'GET /api/v1/ws', // authenticates the socket itself (tested below)
  'POST /api/v1/arr/webhook/:token', // the random token in the path is the secret
  'GET /api/v1/renderers/stream/:key/:file', // HMAC-signed, expiring, LAN only
  'GET /api/v1/stems/ort/:file', // public onnxruntime-web files
  // plugin namespace: each plugin route declares public/user/admin, enforced by the dispatcher
  'GET /api/v1/plugins/:id/*', 'POST /api/v1/plugins/:id/*', 'PUT /api/v1/plugins/:id/*', 'PATCH /api/v1/plugins/:id/*', 'DELETE /api/v1/plugins/:id/*',
  // DLNA: no login by protocol design, refused unless enabled and the TCP peer is on the LAN with no proxy headers
  'GET /dlna/description.xml', 'GET /dlna/ContentDirectory.xml', 'GET /dlna/ConnectionManager.xml', 'POST /dlna/control/ContentDirectory',
  'POST /dlna/control/ConnectionManager', 'SUBSCRIBE /dlna/event/:service', 'UNSUBSCRIBE /dlna/event/:service', 'GET /dlna/stream/:file', 'GET /dlna/subtitle/:mediaId/:file',
  'GET /rest/:method', 'POST /rest/:method', // Subsonic: its own u/p or apiKey auth
]);

const routes = () => {
  const seen = new Map<string, { method: string; url: string }>();
  for (const r of routeTable) if (r.method !== 'HEAD' && r.method !== 'OPTIONS') seen.set(`${r.method} ${r.url}`, r);
  return [...seen.entries()];
};
const fill = (url: string) => url.replace(/:(\w+)/g, 'x1').replace(/\*/g, 'x1');
const call = (method: string, url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: method as any, url, headers: { 'content-type': 'application/json', ...headers }, payload: method === 'GET' || method === 'DELETE' ? undefined : '{}' });

test('route table: every route needs a session unless it is on the public allow-list', async () => {
  const list = routes();
  assert.ok(list.length > 300, `only ${list.length} routes found`);
  const open: string[] = [];
  for (const [key, r] of list) {
    if (PUBLIC.has(key)) continue;
    const res = await call(r.method, fill(r.url));
    if (res.statusCode !== 401) open.push(`${key} → ${res.statusCode}`);
  }
  assert.deepEqual(open, [], `routes reachable without signing in:\n${open.join('\n')}`);
  // The allow-list only names routes that exist (a renamed route must be re-reviewed).
  const keys = new Set(list.map(([k]) => k));
  for (const k of PUBLIC) assert.ok(keys.has(k) || k === 'GET /*' || k === 'HEAD /*', `allow-listed route no longer exists: ${k}`);
});

test('route table: admin areas refuse a signed-in non-admin', async () => {
  const ADMIN_PREFIXES = ['/api/v1/admin/', '/api/v1/users', '/api/v1/settings', '/api/v1/system/logs', '/api/v1/system/browse', '/api/v1/system/stats',
    '/api/v1/activity', '/api/v1/tasks', '/api/v1/sessions', '/api/v1/metrics', '/api/v1/invites', '/api/v1/livetv/sources', '/api/v1/livetv/epg-sources',
    '/api/v1/integrations/', '/api/v1/storage', '/api/v1/notify/', '/api/v1/stats/server', '/api/v1/arr/queue', '/api/v1/arr/health', '/api/v1/branding/looks'];
  const wrong: string[] = [];
  let n = 0;
  for (const [key, r] of routes()) {
    if (PUBLIC.has(key) || !ADMIN_PREFIXES.some((p) => r.url.startsWith(p)) || r.url.startsWith('/api/v1/users/:id/avatar') && r.method === 'GET') continue;
    n++;
    const res = await call(r.method, fill(r.url), bearer(viewerTok));
    if (res.statusCode !== 403) wrong.push(`${key} → ${res.statusCode}`);
  }
  assert.ok(n > 60, `only ${n} admin routes checked`);
  assert.deepEqual(wrong, [], `admin routes open to a normal user:\n${wrong.join('\n')}`);
});

test('backup restore authorises before reading the file', async () => {
  const dir = path.join(getSettings() && (await import('../src/config.ts')).config.dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mediamax-2020-01-01T00-00-00-manual.tar.gz'), 'x');
  const r = await call('POST', '/api/v1/admin/backups/mediamax-2020-01-01T00-00-00-manual.tar.gz/restore');
  assert.equal(r.statusCode, 401);
  const missing = await call('POST', '/api/v1/admin/backups/mediamax-nope-manual.tar.gz/restore');
  assert.equal(missing.statusCode, 401, 'no existence oracle for anonymous callers');
});

/* --------------------------------------------------------------- remote streaming --------------------------------------------------------------- */

test('"allow remote streaming" off: media endpoints refuse internet clients, not only new sessions', async () => {
  const internet = { remoteAddress: '203.0.113.7' };
  const lan = { remoteAddress: '192.168.1.20' };
  for (const url of ['/api/v1/stream/direct/m1', '/api/v1/stream/download/i1', '/api/v1/livetv/stream/c1', '/api/v1/items/i1/karaoke.mp3', '/api/v1/items/i1/stems/vocals']) {
    const r = await app.inject({ url, headers: bearer(homeTok), ...internet });
    assert.equal(r.statusCode, 403, `${url} from the internet`);
    assert.equal(r.json().error, 'remote_not_allowed', url);
    const home = await app.inject({ url, headers: bearer(homeTok), ...lan });
    assert.notEqual(home.statusCode, 403, `${url} on the LAN`);
    const other = await app.inject({ url, headers: bearer(viewerTok), ...internet });
    assert.notEqual(other.statusCode, 403, `${url} for a user allowed to stream remotely`);
  }
  const sub = await app.inject({ url: '/rest/stream.view?u=sec-home&p=pass1234&id=x&f=json', ...internet });
  assert.equal(sub.json()['subsonic-response'].error.code, 50);
  const subLan = await app.inject({ url: '/rest/stream.view?u=sec-home&p=pass1234&id=x&f=json', ...lan });
  assert.notEqual(subLan.json()['subsonic-response'].error.code, 50);
});

/* --------------------------------------------------------------- sessions --------------------------------------------------------------- */

test('changing your own password signs your other devices out (and keeps this one)', async () => {
  const u = createUser({ username: 'sec-pw', password: 'oldpass1' });
  const here = issueToken(u.id, dev('pw-here')).token;
  const other = issueToken(u.id, dev('pw-other')).token;
  const r = await app.inject({ method: 'PATCH', url: '/api/v1/auth/me', headers: bearer(here), payload: { currentPassword: 'oldpass1', password: 'newpass2' } });
  assert.equal(r.statusCode, 200);
  assert.ok(authenticate(here), 'the device that changed it stays signed in');
  assert.equal(authenticate(other), null, 'other devices are signed out');
  // A display-name change alone signs nobody out.
  const third = issueToken(u.id, dev('pw-third')).token;
  await app.inject({ method: 'PATCH', url: '/api/v1/auth/me', headers: bearer(here), payload: { displayName: 'X' } });
  assert.ok(authenticate(third));
});

test('link codes: capped per client address, a device asking again replaces its code', async () => {
  _resetLinks();
  const ask = (deviceId: string, ip = '198.51.100.9') => app.inject({ method: 'POST', url: '/api/v1/auth/link/request', payload: { deviceId }, remoteAddress: ip });
  for (let i = 0; i < 3; i++) assert.equal((await ask('tv-same')).statusCode, 200, 'the same device can refresh its code');
  for (let i = 0; i < LINK_LIMITS.perIp - 1; i++) assert.equal((await ask(`tv-${i}`)).statusCode, 200);
  assert.equal((await ask('tv-extra')).statusCode, 429);
  assert.equal((await ask('tv-elsewhere', '198.51.100.10')).statusCode, 200, 'other clients are unaffected');
  _resetLinks();
});

test('WebSocket: closed when the session is revoked, oversized messages refused', async () => {
  const { WebSocket } = await import('ws');
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as any).port;
  const t = issueToken(viewer.id, dev('ws-1')).token;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?token=${t}`);
  await once(ws, 'message');
  db.run('DELETE FROM devices WHERE device_id = ?', 'ws-1');
  const [code] = (await once(ws, 'close')) as [number];
  assert.equal(code, 4001);

  const t2 = issueToken(viewer.id, dev('ws-2')).token;
  const big = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?token=${t2}`);
  await once(big, 'message');
  big.send(JSON.stringify({ type: 'ping', pad: 'x'.repeat(200 * 1024) }));
  const [code2] = (await once(big, 'close')) as [number];
  assert.equal(code2, 1009, 'message too big');
});

/* ------------------------------------------------------------------- SSRF ------------------------------------------------------------------- */

async function localServer(handler: http.RequestListener) {
  const hits: string[] = [];
  const srv = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  return { port: (srv.address() as any).port as number, hits, close: () => new Promise((r) => srv.close(r)) };
}

test('safeFetch pins the checked address: DNS rebinding to the LAN is refused before connecting', async () => {
  const s = await localServer((_q, r) => r.end('secret'));
  let calls = 0;
  // First answer (the check) is public, the next ones (the connection) point at loopback.
  setResolverForTests(async () => (calls++ === 0 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]));
  try {
    await assert.rejects(safeFetch(`http://rebind.test:${s.port}/`), /not allowed/);
    assert.ok(calls >= 2, 'the connection resolved the name again through the guard');
    assert.deepEqual(s.hits, []);
  } finally {
    setResolverForTests(null);
    await s.close();
  }
});

test('safeFetch still works for allowed hosts: gzip, redirects, POST → 303 → GET', async () => {
  const s = await localServer((q, r) => {
    if (q.url === '/old') return r.writeHead(302, { location: '/feed' }).end();
    if (q.url === '/submit') return r.writeHead(303, { location: '/done' }).end();
    if (q.url === '/done') return r.end(q.method);
    r.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'application/rss+xml', etag: '"e1"' }).end(zlib.gzipSync('<rss>ok</rss>'));
  });
  process.env.MEDIAMAX_ALLOW_PRIVATE_URLS = '1';
  setResolverForTests(async () => [{ address: '127.0.0.1', family: 4 }]);
  try {
    const r = await safeFetch(`http://feed.test:${s.port}/old`, { headers: { 'User-Agent': 'x' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('etag'), '"e1"');
    assert.equal(await r.text(), '<rss>ok</rss>');
    const p = await safeFetch(`http://feed.test:${s.port}/submit`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(await p.text(), 'GET');
    const nm = await safeFetch(`http://feed.test:${s.port}/done`, { method: 'HEAD' });
    assert.equal(nm.status, 200);
  } finally {
    delete process.env.MEDIAMAX_ALLOW_PRIVATE_URLS;
    setResolverForTests(null);
    await s.close();
  }
});

test('private address detection covers IPv4-compatible, site-local and NAT64 IPv6 forms', () => {
  for (const ip of ['::127.0.0.1', '::7f00:1', 'fec0::1', '64:ff9b::a00:1', '::ffff:7f00:1', '::ffff:10.0.0.1']) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '8.8.4.4']) assert.ok(!isPrivateAddress(ip), ip);
});

test("a non-admin's self-hosted ListenBrainz URL can't reach the LAN; an admin's can", async () => {
  const s = await localServer((_q, r) => r.writeHead(200, { 'content-type': 'application/json' }).end('{"valid":true,"user_name":"x"}'));
  try {
    const base = `http://127.0.0.1:${s.port}`;
    await assert.rejects(lbFetch({ token: 't', server_url: base, user_id: viewer.id }, '/1/validate-token'));
    await assert.rejects(lbFetch({ token: 't', server_url: base }, '/1/validate-token'), undefined, 'unknown owner = untrusted');
    assert.deepEqual(s.hits, []);
    const ok = await lbFetch({ token: 't', server_url: base, user_id: admin.id }, '/1/validate-token');
    assert.equal(ok.data.valid, true);
    assert.equal(s.hits.length, 1);
  } finally {
    await s.close();
  }
});

/* ---------------------------------------------------------------- injection ---------------------------------------------------------------- */

test('ffmpeg filter paths: quotes, commas, colons and brackets in file names stay part of the name', () => {
  assert.equal(escapeFilterPath('/m/a.srt', false), '/m/a.srt');
  assert.equal(escapeFilterPath("/m/it's,[x]:y;z.srt", false), "/m/it\\\\\\'s\\,\\[x\\]\\\\:y\\;z.srt");
  assert.equal(escapeFilterPath('C:\\Media\\a.srt', true), 'C\\\\:/Media/a.srt');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-sub-"));
  try {
    const names = ["it's.srt", "x',drawbox=t=fill,'.srt", 'a:b[c],d;e.srt', 'back\\slash.srt'];
    const probe = spawnSync('ffmpeg', ['-version']);
    if (probe.status !== 0) return; // no ffmpeg here: the string checks above still ran
    for (const n of names) {
      fs.writeFileSync(path.join(dir, n), '1\n00:00:00,000 --> 00:00:01,000\nhi\n');
      const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.2', '-vf', `scale=32:32,subtitles=${escapeFilterPath(path.join(dir, n), false)},format=yuv420p`, '-f', 'null', '-'], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${n}: ${r.stderr}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderer conversions of remote media only use network protocols', () => {
  const args = deviceInputArgs({ path: null, remote_url: 'http://provider.example/vod/1.mp4', item_id: 'x' });
  const i = args.indexOf('-protocol_whitelist');
  assert.ok(i >= 0 && !args[i + 1].split(',').includes('file'));
  assert.deepEqual(deviceInputArgs({ path: '/media/a.mkv', remote_url: null }), []);
});

/* ----------------------------------------------------------------- secrets ----------------------------------------------------------------- */

test('settings: client secrets, passwords and API keys are write-only', () => {
  updateSettings({ tmdbApiKey: 'tmdb-secret', openSubtitles: { ...getSettings().openSubtitles, apiKey: 'os-key', password: 'os-pass' }, trakt: { clientId: 'cid', clientSecret: 'trakt-secret' }, lastfm: { apiKey: 'lfm', sharedSecret: 'lfm-secret' }, oidc: { ...getSettings().oidc, clientSecret: 'oidc-secret' } });
  const pub = publicSettings();
  const text = JSON.stringify(pub);
  for (const s of ['tmdb-secret', 'os-key', 'os-pass', 'trakt-secret', 'lfm-secret', 'oidc-secret']) assert.ok(!text.includes(s), s);
  assert.equal(pub.trakt.clientId, 'cid', 'non-secret ids stay visible');
  // The admin UI saves the form as it got it: masked values keep the stored secret.
  updateSettings(pub);
  const s = getSettings();
  assert.equal(s.tmdbApiKey, 'tmdb-secret');
  assert.equal(s.openSubtitles.password, 'os-pass');
  assert.equal(s.trakt.clientSecret, 'trakt-secret');
  assert.equal(s.lastfm.sharedSecret, 'lfm-secret');
  assert.equal(s.oidc.clientSecret, 'oidc-secret');
  updateSettings({ oidc: { ...pub.oidc, clientSecret: 'changed' } });
  assert.equal(getSettings().oidc.clientSecret, 'changed');
  assert.equal(SECRET_MASK, '••••');
});

test('built-in HTTPS access log redacts every credential that can appear in a URL or header', () => {
  const c = caddyfile({ ...DEFAULT_NETWORK, mode: 'builtin', builtinHttps: { ...DEFAULT_NETWORK.builtinHttps, domain: 'media.example.com' } }, 8484, '/x.log');
  for (const k of ['token', 'api_key', 'apiKey', 'pollToken', 'p', 't', 's']) assert.match(c, new RegExp(`replace ${k} REDACTED`));
  assert.match(c, /request>headers>X-Api-Key delete/);
  assert.match(c, /request>headers>X-Mediamax-Token delete/);
  const deploy = fs.readFileSync(new URL('../../deploy/caddy/Caddyfile', import.meta.url), 'utf8');
  assert.match(deploy, /replace apiKey REDACTED/);
  const nginx = fs.readFileSync(new URL('../../deploy/nginx/mediamax-common.conf', import.meta.url), 'utf8');
  assert.match(nginx, /token\|api_key\|apiKey\|pollToken/);
});

test('SSO: an ID token without the issuer claim is refused', async () => {
  const oidc = await import('../src/services/oidc.ts');
  updateSettings({ oidc: { ...getSettings().oidc, enabled: true, issuer: 'https://idp.test', clientId: 'mm', clientSecret: null, autoCreateUsers: true } });
  const real = globalThis.fetch;
  let idToken = '';
  globalThis.fetch = (async (u: string) => {
    const url = String(u);
    const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/.well-known/openid-configuration')) return json({ issuer: 'https://idp.test', authorization_endpoint: 'https://idp.test/auth', token_endpoint: 'https://idp.test/token' });
    if (url === 'https://idp.test/token') return json({ id_token: idToken });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
  try {
    for (const [iss, ok] of [[undefined, false], ['https://evil.test', false], ['https://idp.test', true]] as const) {
      const { url, state } = await oidc.startLogin('https://media.test', 'https://media.test/login', dev('sso'));
      const nonce = new URL(url).searchParams.get('nonce');
      idToken = jwt({ ...(iss ? { iss } : {}), aud: 'mm', nonce, sub: 'alice', preferred_username: 'alice', exp: Math.floor(Date.now() / 1000) + 300 });
      const dest = await oidc.finishLogin(state, 'code', state);
      assert.equal(dest.includes('#token='), ok, `${iss}: ${dest}`);
    }
  } finally {
    globalThis.fetch = real;
    updateSettings({ oidc: { ...getSettings().oidc, enabled: false } });
  }
});

/* ----------------------------------------------------------------- headers ----------------------------------------------------------------- */

test('the web app is served with a Content-Security-Policy', async () => {
  const r = await app.inject({ url: '/library/x', headers: { host: 'media.example.com' } });
  assert.equal(r.statusCode, 200);
  const csp = String(r.headers['content-security-policy']);
  assert.equal(csp, webAppCsp('media.example.com'));
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval' https:\/\/www\.gstatic\.com(;|$)/);
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp) && !/script-src[^;]*'unsafe-eval'/.test(csp));
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.match(csp, /connect-src 'self' ws:\/\/media\.example\.com wss:\/\/media\.example\.com/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  // A forged Host can't smuggle extra directives.
  assert.ok(!webAppCsp("evil; script-src *").includes('script-src *'));
});

void updateUser;
