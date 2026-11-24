// QA regressions through the HTTP API: unreadable media, user deletion ends playback sessions.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const { db } = await import('../src/db.ts');
const { config } = await import('../src/config.ts');
const { createUser, issueToken } = await import('../src/services/auth.ts');
const { scanLibrary } = await import('../src/services/scanner.ts');
const { listSessions } = await import('../src/services/playback.ts');
const { buildApp } = await import('../src/app.ts');

const admin = await createUser({ username: 'qaadmin', password: 'pw-123456', isAdmin: true });
const viewer = await createUser({ username: 'qaviewer', password: 'pw-123456' });
const atok = issueToken(admin.id, { deviceId: 'qa-a', deviceName: 'test', platform: 'web' }).token;
const vtok = issueToken(viewer.id, { deviceId: 'qa-v', deviceName: 'test', platform: 'web' }).token;
const app = await buildApp();
after(() => app.close());
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-qa-api-'));
fs.writeFileSync(path.join(root, 'Empty (2020).mkv'), '');
assert.equal(spawnSync(config.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=2', '-f', 'lavfi', '-i', 'sine=d=2', '-shortest', '-pix_fmt', 'yuv420p', path.join(root, 'Good (2021).mp4')]).status, 0);
db.run("INSERT INTO libraries (id, name, type, paths, fetch_metadata, created_at) VALUES ('qa-movies', 'Movies', 'movies', ?, 0, '2026-01-01')", JSON.stringify([root]));
await scanLibrary('qa-movies');
const idOf = (title: string) => db.get<{ id: string }>("SELECT id FROM items WHERE library_id = 'qa-movies' AND title = ?", title)!.id;

test('playing an empty / unreadable file gives a clear 422 instead of a broken stream', async () => {
  const r = await app.inject({ method: 'POST', url: `/api/v1/playback/${idOf('Empty')}`, headers: auth(vtok), payload: {} });
  assert.equal(r.statusCode, 422, r.body);
  assert.match(r.json().message ?? r.body, /could not be read/);
  const ok = await app.inject({ method: 'POST', url: `/api/v1/playback/${idOf('Good')}`, headers: auth(vtok), payload: {} });
  assert.equal(ok.statusCode, 200, ok.body);
});

test('deleting a user ends its playback sessions', async () => {
  assert.ok(listSessions().some((s) => s.userId === viewer.id), 'viewer has a session');
  const r = await app.inject({ method: 'DELETE', url: `/api/v1/users/${viewer.id}`, headers: auth(atok) });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(!listSessions().some((s) => s.userId === viewer.id), 'session stopped');
});
