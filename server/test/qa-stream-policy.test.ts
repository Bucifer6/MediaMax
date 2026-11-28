import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { db } from '../src/db.js';
import { authenticate, createUser, issueToken, updateUser } from '../src/services/auth.js';
import { getSession, registerSession, stopAllSessions } from '../src/services/playback.js';

const now = new Date().toISOString();
db.run('INSERT INTO libraries (id, name, type, paths, created_at) VALUES (?, ?, ?, ?, ?)', 'qa-policy-lib', 'Policy library', 'movies', '[]', now);
db.run('INSERT INTO items (id, library_id, type, title, sort_title, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  'qa-policy-film', 'qa-policy-lib', 'movie', 'Policy film', 'policy film', now, now);
const owner = await createUser({ username: 'qa-policy-owner', password: 'testpass123', libraryIds: ['qa-policy-lib'], allowRemote: true });
const outsider = await createUser({ username: 'qa-policy-other', password: 'testpass123' });
const token = issueToken(owner.id, { deviceId: 'policy-device', deviceName: 'QA', platform: 'web' }).token;
const otherToken = issueToken(outsider.id, { deviceId: 'other-device', deviceName: 'QA', platform: 'web' }).token;
const app = await buildApp();
after(async () => { stopAllSessions(); await app.close(); });

function session() {
  return registerSession({
    ctx: authenticate(token)!, itemId: 'qa-policy-film', channelId: null, mediaId: null,
    method: 'transcode', job: null,
    abr: { tick() {}, stop() {}, master: () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nr0.m3u8\n' } as any,
    title: 'Policy film', subtitle: null, posterUrl: null, durationMs: 10_000, remoteAddr: '192.168.1.20',
  });
}
const request = (id: string, path = 'stream/hls', from = '192.168.1.20', auth = token) => app.inject({
  url: `/api/v1/${path}/${id}/master.m3u8`, remoteAddress: from, headers: { authorization: `Bearer ${auth}` },
});

test('active HLS sessions enforce current remote-streaming policy on both URL aliases', async () => {
  const s = session();
  assert.equal((await request(s.id)).statusCode, 200);
  await updateUser(owner.id, { allowRemote: false });
  for (const alias of ['stream/hls', 'livetv/hls']) {
    const r = await request(s.id, alias, '203.0.113.7');
    assert.equal(r.statusCode, 403, `${alias}: ${r.body}`);
    assert.equal(r.json().error, 'remote_not_allowed');
  }
  assert.equal((await request(s.id)).statusCode, 200, 'home playback remains allowed');
  await updateUser(owner.id, { allowRemote: true });
});

test('removing library access prevents reading an already-running HLS session', async () => {
  const s = session();
  assert.equal((await request(s.id)).statusCode, 200);
  await updateUser(owner.id, { libraryIds: [] });
  const r = await request(s.id);
  assert.ok(r.statusCode === 403 || r.statusCode === 404, `got ${r.statusCode}: ${r.body}`);
  await updateUser(owner.id, { libraryIds: ['qa-policy-lib'] });
});

test('another user cannot keep an HLS encoder alive by requesting its session URL', async () => {
  const s = session();
  s.lastActivity = 1;
  assert.equal((await request(s.id, 'stream/hls', '192.168.1.20', otherToken)).statusCode, 403);
  assert.equal(getSession(s.id)!.lastActivity, 1, 'authorization must precede touching the session');
});

test('direct file requests only refresh their own matching playback session', async () => {
  const file = path.join(config.cacheDir, 'qa-policy.mp4');
  fs.mkdirSync(config.cacheDir, { recursive: true });
  fs.writeFileSync(file, 'qa');
  db.run('INSERT INTO media (id, item_id, path, container, size) VALUES (?, ?, ?, ?, ?)', 'qa-policy-media', 'qa-policy-film', file, 'mp4', 2);
  const s = session();
  s.mediaId = 'qa-policy-media';
  s.lastActivity = 1;
  const url = `/api/v1/stream/direct/qa-policy-media?session=${s.id}`;
  const other = await app.inject({ url, headers: { authorization: `Bearer ${otherToken}` } });
  assert.equal(other.statusCode, 200, 'the other user may independently read an allowed film');
  assert.equal(s.lastActivity, 1, 'their request must not keep another user\'s session alive');
  const own = await app.inject({ url, headers: { authorization: `Bearer ${token}` } });
  assert.equal(own.statusCode, 200);
  assert.ok(s.lastActivity > 1, 'the owner\'s matching session is refreshed');
  s.mediaId = 'different-media';
  s.lastActivity = 1;
  await app.inject({ url, headers: { authorization: `Bearer ${token}` } });
  assert.equal(s.lastActivity, 1, 'a different media stream must not refresh this session');
});
