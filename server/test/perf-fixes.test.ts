// Performance fixes: async password hashing (and the Subsonic verification cache), bounded sign-in lockout maps,
// no-op rescans that write nothing, a global limit on ffmpeg image resizes, and the sort-by-year index.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const { db } = await import('../src/db.ts');
const { config } = await import('../src/config.ts');
const auth = await import('../src/services/auth.ts');
const { Pending, sweepExpired, SWEEP_AT } = await import('../src/util/lockout.ts');
const { _subsonicAuthCache } = await import('../src/routes/subsonic.ts');
const { scanLibrary } = await import('../src/services/scanner.ts');
const images = await import('../src/services/images.ts');
const { buildApp } = await import('../src/app.ts');

const app = await buildApp();
const user = await auth.createUser({ username: 'pf-user', password: 'pass1234' });
after(() => app.close());

test('hashSecret / verifySecret: async, same stored format, wrong secrets and other formats fail', async () => {
  const h = await auth.hashSecret('pass1234');
  assert.match(h, /^scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(await auth.verifySecret('pass1234', h), true);
  assert.equal(await auth.verifySecret('pass12345', h), false);
  assert.equal(await auth.verifySecret('pass1234', null), false);
  assert.equal(await auth.verifySecret('pass1234', 'bcrypt$x$y'), false);
  // Hashes stored by the old synchronous code still verify (same parameters and layout).
  const crypto = await import('node:crypto');
  const salt = crypto.randomBytes(16);
  const legacy = `scrypt$${salt.toString('base64')}$${crypto.scryptSync('old-pass', salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64')}`;
  assert.equal(await auth.verifySecret('old-pass', legacy), true);
});

test('hashing does not block the event loop', async () => {
  let ticks = 0;
  const iv = setInterval(() => ticks++, 1);
  await Promise.all([auth.hashSecret('a-password'), auth.hashSecret('b-password'), auth.hashSecret('c-password')]);
  clearInterval(iv);
  assert.ok(ticks > 3, `timers ran while hashing (${ticks})`);
});

test('concurrent wrong passwords cannot overshoot the 5-attempt lockout', async () => {
  await auth.createUser({ username: 'pf-burst', password: 'right-pass' });
  const res = await Promise.allSettled(Array.from({ length: 9 }, () => auth.login('pf-burst', 'wrong-pass', { deviceId: 'x' })));
  const codes = res.map((r) => (r.status === 'rejected' ? (r.reason as { statusCode: number }).statusCode : 200));
  assert.equal(codes.filter((c) => c === 401).length, 5, codes.join(','));
  assert.equal(codes.filter((c) => c === 429).length, 4, codes.join(','));
  await assert.rejects(auth.login('pf-burst', 'right-pass', { deviceId: 'x' }), (e: { statusCode: number }) => e.statusCode === 429);
});

test('lockout maps: expired entries are swept past the size limit, live ones are kept; pending attempts count', async () => {
  const m = new Map<string, { n: number; until: number }>();
  for (let i = 0; i < SWEEP_AT; i++) m.set(`old${i}`, { n: 1, until: Date.now() - 1 });
  m.set('live', { n: 3, until: Date.now() + 60000 });
  sweepExpired(m);
  assert.deepEqual([...m.keys()], ['live']);
  const small = new Map([['old', { n: 1, until: Date.now() - 1 }]]);
  sweepExpired(small);
  assert.equal(small.size, 1, 'small maps are left alone');

  const p = new Pending();
  let release!: () => void;
  const run = p.run('k', () => new Promise<void>((r) => (release = r)));
  assert.equal(p.count('k'), 1);
  release();
  await run;
  assert.equal(p.count('k'), 0);
  await assert.rejects(p.run('k', async () => { throw new Error('x'); }));
  assert.equal(p.count('k'), 0, 'released on failure too');
});

test('subsonic: successful u/p checks are cached; failures are not; a password change invalidates', async () => {
  _subsonicAuthCache.clear();
  const ping = async (p: string) => (await app.inject({ url: `/rest/ping.view?u=pf-user&p=${encodeURIComponent(p)}&f=json` })).json()['subsonic-response'].status;
  assert.equal(await ping('wrong'), 'failed');
  assert.equal(_subsonicAuthCache.size(), 0, 'failures are not cached');
  assert.equal(await ping('pass1234'), 'ok');
  assert.equal(_subsonicAuthCache.size(), 1);
  assert.equal(await ping(`enc:${Buffer.from('pass1234').toString('hex')}`), 'ok');
  assert.equal(_subsonicAuthCache.size(), 1, 'same secret, same entry');
  await auth.updateUser(user.id, { password: 'new-pass-1' }, user.id);
  assert.equal(await ping('pass1234'), 'failed', 'old password stops working at once');
  assert.equal(await ping('new-pass-1'), 'ok');
  db.run('UPDATE users SET disabled = 1 WHERE id = ?', user.id);
  assert.equal(await ping('new-pass-1'), 'failed', 'a disabled account is refused even when cached');
  db.run('UPDATE users SET disabled = 0 WHERE id = ?', user.id);
});

test('a no-op rescan writes no media rows', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-noop-'));
  const dir = path.join(root, 'Film (2020)');
  fs.mkdirSync(dir);
  assert.equal(spawnSync(config.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:d=1', '-pix_fmt', 'yuv420p', path.join(dir, 'Film (2020).mp4')]).status, 0);
  fs.copyFileSync(path.join(dir, 'Film (2020).mp4'), path.join(dir, 'Film (2020) - Extended Edition.mp4'));
  db.insert('libraries', { id: 'pf-lib', name: 'Films', type: 'movies', paths: JSON.stringify([root]), fetch_metadata: 0, created_at: new Date().toISOString() });
  await scanLibrary('pf-lib');
  const before = db.all('SELECT id, item_id, subs, edition FROM media ORDER BY id');
  assert.equal(before.length, 2);
  const changes = () => db.get<{ n: number }>('SELECT total_changes() n')!.n;
  const c0 = changes();
  await scanLibrary('pf-lib');
  const mediaWrites = changes() - c0;
  assert.ok(mediaWrites <= 2, `only the library row is touched (${mediaWrites} changes)`);
  assert.deepEqual(db.all('SELECT id, item_id, subs, edition FROM media ORDER BY id'), before);
  // A new sidecar subtitle is still picked up.
  fs.writeFileSync(path.join(dir, 'Film (2020).en.srt'), '1\n00:00:01,000 --> 00:00:02,000\nHi\n');
  await scanLibrary('pf-lib');
  assert.ok(db.all('SELECT subs FROM media').some((r) => r.subs.includes('"external":true')), 'sidecar subtitle added');
  fs.rmSync(root, { recursive: true, force: true });
});

test('image resizes run at most RESIZE_CONCURRENCY ffmpeg processes at once; each size is made once', async (tt) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-resize-'));
  const fake = path.join(work, 'ffmpeg');
  // Last argument is the output file; take a moment like a real resize.
  fs.writeFileSync(fake, '#!/bin/sh\nfor a; do out="$a"; done\nsleep 0.15\necho resized > "$out"\n');
  fs.chmodSync(fake, 0o755);
  const real = config.ffmpeg;
  config.ffmpeg = fake;
  tt.after(() => (config.ffmpeg = real));
  const ids = Array.from({ length: images.RESIZE_CONCURRENCY * 2 + 3 }, (_, i) => {
    const f = path.join(work, `p${i}.jpg`);
    fs.writeFileSync(f, 'jpg');
    return images.registerImage(f)!;
  });
  let maxRunning = 0;
  let sawQueue = false;
  const iv = setInterval(() => {
    const s = images._resizeStats();
    maxRunning = Math.max(maxRunning, s.running);
    if (s.queued) sawQueue = true;
  }, 5);
  // Every id twice: the second request for the same size shares the first one's ffmpeg.
  const res = await Promise.all([...ids, ...ids].map((id) => images.resolveImage(id, 300)));
  clearInterval(iv);
  assert.ok(res.every((r) => r.mime === 'image/jpeg' && r.path.includes(`${path.sep}w${path.sep}`)), 'all resized');
  assert.ok(maxRunning <= images.RESIZE_CONCURRENCY, `max running ${maxRunning}`);
  assert.ok(sawQueue, 'extra resizes waited for a slot');
  assert.deepEqual(images._resizeStats(), { running: 0, queued: 0 });
  fs.rmSync(work, { recursive: true, force: true });
});

test('sort by year, newest first, walks the items_lib_type_year index (no temp b-tree)', () => {
  const plan = db.all("EXPLAIN QUERY PLAN SELECT i.id FROM items i WHERE i.library_id = ? AND i.type IN (?) AND NOT (i.type = 'video' AND i.parent_id IS NOT NULL) ORDER BY COALESCE(i.year, 0) DESC, i.sort_title LIMIT 60 OFFSET 0", 'pf-lib', 'movie')
    .map((r) => r.detail).join(' | ');
  assert.match(plan, /items_lib_type_year/);
  assert.doesNotMatch(plan, /TEMP B-TREE/);
});
