// Browsing and playing must not make blocking filesystem calls on media folders: with the library on a slow or
// sleeping NAS, one synchronous stat or copy stalls every request (the tray shows "Starting...", remote apps drop).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createUser, issueToken } = await import('../src/services/auth.ts');
const { buildApp } = await import('../src/app.ts');
const { scanLibrary } = await import('../src/services/scanner.ts');
const { db } = await import('../src/db.ts');

const app = await buildApp();
after(() => app.close());

const admin = await createUser({ username: 'nas-admin', password: 'pass1234', isAdmin: true });
const tok = issueToken(admin.id, { deviceId: 'nas', deviceName: 'test', platform: 'web' }).token;
const headers = { authorization: `Bearer ${tok}` };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-nas-'));
const movieDir = path.join(root, 'Some Movie (2020)');
fs.mkdirSync(movieDir, { recursive: true });
fs.writeFileSync(path.join(movieDir, 'Some Movie (2020).mkv'), Buffer.alloc(4096, 1));
fs.writeFileSync(path.join(movieDir, 'poster.jpg'), 'img');
db.run('INSERT INTO libraries (id, name, type, paths, fetch_metadata, created_at) VALUES (?, ?, ?, ?, 0, ?)', 'nas-lib', 'nas-lib', 'movies', JSON.stringify([root]), '2026-01-01');
await scanLibrary('nas-lib');

const SYNC = ['existsSync', 'statSync', 'lstatSync', 'readdirSync', 'readFileSync', 'realpathSync', 'accessSync', 'openSync', 'copyFileSync'] as const;
async function syncCallsUnderRoot(fn: () => Promise<void>): Promise<string[]> {
  const orig = new Map(SYNC.map((n) => [n, (fs as any)[n]]));
  const seen: string[] = [];
  for (const n of SYNC) {
    (fs as any)[n] = function (p: any, ...rest: any[]) {
      if (String(p).startsWith(root)) seen.push(`${n} ${p}`);
      return orig.get(n).call(this, p, ...rest);
    };
  }
  try {
    await fn();
  } finally {
    for (const n of SYNC) (fs as any)[n] = orig.get(n);
  }
  return seen;
}

test('artwork next to the media is copied on first use without blocking calls on the media folder', async () => {
  const id = db.get<{ id: string }>('SELECT id FROM images WHERE source = ?', path.join(movieDir, 'poster.jpg'))?.id;
  assert.ok(id, 'poster registered');
  db.run('UPDATE images SET cached = NULL WHERE id = ?', id); // as after an import: no copy yet
  const blocked = await syncCallsUnderRoot(async () => {
    const r = await app.inject({ url: `/api/v1/images/${id}` });
    assert.equal(r.statusCode, 200);
  });
  assert.deepEqual(blocked, []);
  assert.ok(db.get<{ cached: string | null }>('SELECT cached FROM images WHERE id = ?', id)?.cached, 'copy recorded');
});

test('direct play (with and without a range) makes no blocking calls on the media folder; a missing file is a 404', async () => {
  const m = db.get<{ id: string }>("SELECT m.id FROM media m JOIN items i ON i.id = m.item_id WHERE i.library_id = 'nas-lib'");
  assert.ok(m);
  const blocked = await syncCallsUnderRoot(async () => {
    const ranged = await app.inject({ url: `/api/v1/stream/direct/${m.id}`, headers: { ...headers, range: 'bytes=0-99' } });
    assert.equal(ranged.statusCode, 206);
    assert.equal(ranged.rawPayload.length, 100);
    const full = await app.inject({ url: `/api/v1/stream/direct/${m.id}`, headers });
    assert.equal(full.statusCode, 200);
    assert.equal(full.headers['content-length'], '4096');
  });
  assert.deepEqual(blocked, []);
  fs.rmSync(path.join(movieDir, 'Some Movie (2020).mkv'));
  const gone = await app.inject({ url: `/api/v1/stream/direct/${m.id}`, headers });
  assert.equal(gone.statusCode, 404);
});
