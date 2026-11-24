// QA regressions: API keys can't do credential-level actions, malformed input gives 400 (not 500), converted podcast
// downloads go through the SSRF guard, and the Live TV connection limit holds under concurrent requests.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

const { db } = await import('../src/db.ts');
const { config } = await import('../src/config.ts');
const { createUser, issueToken, createApiKey } = await import('../src/services/auth.ts');
const invites = await import('../src/services/invites.ts');
const live = await import('../src/services/livetv/livetv.ts');
const { buildApp } = await import('../src/app.ts');

const owner = createUser({ username: 'hardowner', password: 'pass1234', isAdmin: true });
const viewer = createUser({ username: 'hardviewer', password: 'pass1234' });
const otok = issueToken(owner.id, { deviceId: 'h-o', deviceName: 'test', platform: 'web' }).token;
const vtok = issueToken(viewer.id, { deviceId: 'h-v', deviceName: 'test', platform: 'web' }).token;
const key = createApiKey(owner.id, 'homepage widget').key;
const app = await buildApp();
const servers: http.Server[] = [];
after(async () => {
  await app.close();
  for (const s of servers) s.close();
});
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const withKey = { 'x-api-key': key };

async function listen(handler: http.RequestListener): Promise<number> {
  const srv = http.createServer(handler);
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return (srv.address() as { port: number }).port;
}

/* ------------------------------ API keys ----------------------------- */

test('an API key cannot approve a device link (which would mint a full session)', async () => {
  const link = (await app.inject({ method: 'POST', url: '/api/v1/auth/link/request', payload: { deviceId: 'evil', deviceName: 'evil' } })).json();
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/link/approve', headers: withKey, payload: { code: link.code } });
  assert.equal(r.statusCode, 403, r.body);
  const poll = (await app.inject({ url: `/api/v1/auth/link/poll?pollToken=${link.pollToken}` })).json();
  assert.ok(!poll.token, 'no session was issued');
  // A signed-in device still can.
  const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/link/approve', headers: bearer(otok), payload: { code: link.code } });
  assert.equal(ok.statusCode, 200, ok.body);
});

test('an API key cannot manage 2FA, API keys or the password', async () => {
  for (const [method, url, payload] of [
    ['POST', '/api/v1/auth/me/2fa/setup', undefined],
    ['POST', '/api/v1/auth/me/2fa/enable', { code: '000000' }],
    ['POST', '/api/v1/auth/me/2fa/disable', { code: '000000' }],
    ['GET', '/api/v1/auth/api-keys', undefined],
    ['POST', '/api/v1/auth/api-keys', { name: 'k2' }],
    ['DELETE', '/api/v1/auth/api-keys/whatever', undefined],
    ['PATCH', '/api/v1/auth/me', { currentPassword: 'pass1234', password: 'another-pass' }],
    ['PATCH', '/api/v1/auth/me', { pin: '1234' }],
  ] as const) {
    const r = await app.inject({ method, url, headers: withKey, ...(payload ? { payload } : {}) });
    assert.equal(r.statusCode, 403, `${method} ${url}: ${r.body}`);
  }
  assert.equal(db.get<{ totp_enabled: number }>('SELECT totp_enabled FROM users WHERE id = ?', owner.id)!.totp_enabled ? 1 : 0, 0);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'hardowner', password: 'pass1234' } });
  assert.equal(login.statusCode, 200, login.body);
  // The integrations API keys exist for keep working, and a device session can still manage keys.
  assert.equal((await app.inject({ url: '/api/v1/auth/me', headers: withKey })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/v1/status/now-playing', headers: withKey })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/v1/auth/api-keys', headers: bearer(otok) })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/me/2fa/setup', headers: bearer(otok) })).statusCode, 200);
});

test('a repeated api_key parameter does not break every route', async () => {
  for (const url of ['/health?api_key=a&api_key=b', '/api/v1/system/info?api_key=a&api_key=b']) {
    const r = await app.inject({ url });
    assert.equal(r.statusCode, 200, `${url}: ${r.body}`);
  }
  const r = await app.inject({ url: '/api/v1/auth/me', headers: { 'x-api-key': [key, key] } as any });
  assert.equal(r.statusCode, 401, r.body);
});

/* ---------------------------- input types ---------------------------- */

test('malformed input types give 400 (or are ignored), never 500', async () => {
  db.run("INSERT INTO libraries (id, name, type, paths, fetch_metadata, created_at) VALUES ('hard-movies', 'Movies', 'movies', '[]', 0, '2026-01-01')");
  const now = new Date().toISOString();
  db.insert('items', { id: 'hard-m1', library_id: 'hard-movies', type: 'movie', title: 'Alpha', sort_title: 'alpha', added_at: now, updated_at: now });
  const inv = invites.createInvite(owner, {}, 'http://x');
  const cases: [string, string, unknown, number[]][] = [
    ['GET', '/api/v1/items?sort=constructor', undefined, [200]],
    ['GET', '/api/v1/items?sort=__proto__', undefined, [200]],
    ['GET', '/api/v1/items?sort=toString', undefined, [200]],
    ['GET', '/api/v1/items?libraryId=a&libraryId=b', undefined, [200, 400]],
    ['GET', '/api/v1/items?letter=a&letter=b', undefined, [200, 400]],
    ['GET', '/api/v1/requests?sort=constructor', undefined, [200]],
    ['POST', '/api/v1/auth/login', { username: 'hardviewer', password: { a: 1 } }, [400]],
    ['POST', '/api/v1/auth/login', { username: ['hardviewer'], password: 'x' }, [400]],
    ['POST', `/api/v1/invites/${inv.code}/accept`, { username: 'newbie', password: [1, 2, 3, 4, 5, 6, 7, 8] }, [400]],
    ['POST', `/api/v1/invites/${inv.code}/accept`, { username: { a: 1 }, password: 'pass1234' }, [400]],
    ['POST', '/api/v1/auth/profile-login', { userId: { x: 1 } }, [400]],
  ];
  for (const [method, url, payload, ok] of cases) {
    const headers = url.includes('/auth/') || url.includes('/invites/') ? {} : bearer(vtok);
    const r = await app.inject({ method: method as 'GET', url, headers, ...(payload ? { payload: payload as object } : {}) });
    assert.ok(ok.includes(r.statusCode), `${method} ${url} ${JSON.stringify(payload ?? '')} -> ${r.statusCode} ${r.body.slice(0, 120)}`);
  }
  // An unknown sort still sorts by title and returns the items.
  const r = await app.inject({ url: '/api/v1/items?sort=constructor&libraryId=hard-movies', headers: bearer(otok) });
  assert.deepEqual(r.json().items.map((i: { title: string }) => i.title), ['Alpha']);
});

/* --------------------------- converted SSRF --------------------------- */

test('a converted podcast download goes through the SSRF guard and the protocol whitelist', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-hard-'));
  const secret = path.join(dir, 'secret.mp3');
  assert.equal(spawnSync(config.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=d=3', secret]).status, 0);
  const hits: string[] = [];
  const port = await listen((req, res) => {
    hits.push(req.url!);
    res.setHeader('content-type', 'application/vnd.apple.mpegurl');
    res.end(`#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\nfile://${secret}\n#EXT-X-ENDLIST\n`);
  });
  const now = new Date().toISOString();
  db.insert('libraries', { id: 'hard-pod', name: 'Podcasts', type: 'podcasts', paths: '[]', created_at: now });
  db.insert('items', { id: 'hard-ep1', library_id: 'hard-pod', type: 'podcastepisode', title: 'Ep', sort_title: 'ep', added_at: now, updated_at: now });
  db.insert('media', { id: 'hard-pm1', item_id: 'hard-ep1', path: null, remote_url: `http://127.0.0.1:${port}/list.m3u8`, container: 'mp3' });

  for (const q of ['', '?quality=480p']) {
    const r = await app.inject({ url: `/api/v1/stream/download/hard-ep1${q}`, headers: bearer(otok) });
    assert.equal(r.statusCode, 400, `${q}: ${r.body}`);
    assert.equal(r.json().error, 'blocked_url');
  }
  assert.deepEqual(hits, [], 'the private address was never contacted');

  // Even where private feeds are allowed, a playlist can't make ffmpeg read local files (REMOTE_PROTOCOLS whitelist;
  // ffmpeg's own default for http-nested inputs also refuses file:, so this is defence in depth).
  process.env.MEDIAMAX_ALLOW_PRIVATE_URLS = '1';
  try {
    const r = await app.inject({ url: '/api/v1/stream/download/hard-ep1?quality=480p', headers: bearer(otok) });
    assert.ok(hits.length > 0);
    assert.ok(r.rawPayload.length < 1000, `no converted audio from the local file (${r.rawPayload.length} bytes)`);
  } finally {
    delete process.env.MEDIAMAX_ALLOW_PRIVATE_URLS;
  }
});

/* ------------------------- Live TV connection cap ------------------------ */

test('concurrent restreams cannot exceed a source\'s max_connections', async () => {
  let upstream = 0;
  const port = await listen((_req, res) => {
    upstream++;
    setTimeout(() => {
      res.setHeader('content-type', 'video/mp2t');
      res.end('x'.repeat(188));
    }, 300);
  });
  const now = new Date().toISOString();
  db.insert('live_sources', { id: 'hard-src', name: 'IPTV', type: 'm3u', url: 'http://x', max_connections: 1, proxy_streams: 1, created_at: now });
  db.insert('channels', { id: 'hard-c1', source_id: 'hard-src', remote_id: '1', name: 'One', stream_url: `http://127.0.0.1:${port}/1.ts` });
  db.insert('channels', { id: 'hard-c2', source_id: 'hard-src', remote_id: '2', name: 'Two', stream_url: `http://127.0.0.1:${port}/2.ts` });
  const [a, b] = await Promise.all([
    app.inject({ url: '/api/v1/livetv/stream/hard-c1', headers: bearer(vtok) }),
    app.inject({ url: '/api/v1/livetv/stream/hard-c2', headers: bearer(vtok) }),
  ]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 503]);
  assert.equal(upstream, 1, 'only one provider connection was opened');
  assert.equal(live.activeUpstreams('hard-src'), 0, 'slots are released when the streams end');
  const c = await app.inject({ url: '/api/v1/livetv/stream/hard-c1', headers: bearer(vtok) });
  assert.equal(c.statusCode, 200, c.body);
  assert.equal(live.activeUpstreams('hard-src'), 0);

  // A provider that fails to open frees the reserved slot.
  db.run("UPDATE channels SET stream_url = 'http://127.0.0.1:1/dead.ts' WHERE id = 'hard-c2'");
  const d = await app.inject({ url: '/api/v1/livetv/stream/hard-c2', headers: bearer(vtok) });
  assert.equal(d.statusCode, 502, d.body);
  assert.equal(live.activeUpstreams('hard-src'), 0);
});
