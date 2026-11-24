// Instant play: warm slots (adoption, expiry, caps), the decision cache, and POST /playback/:id/prepare end to end
// (no session / history leak, warm job adopted by the next start, metered / busy / direct cases).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const { WarmSlots, PlanCache, canWarm, bandwidthBucket, stableJson } = await import('../src/services/warmup.ts');

/* ------------------------------ unit: WarmSlots ------------------------------ */

function fakeJob(name: string) {
  return { name, stopped: 0, isDead: false, stop() { this.stopped++; }, dead() { return this.isDead; } };
}
function harness(maxJobs = 2, ttlMs = 40000) {
  let now = 1000;
  const timers: { fn: () => void; at: number; cancelled: boolean }[] = [];
  const events: string[] = [];
  const slots = new WarmSlots<ReturnType<typeof fakeJob>>({
    maxJobs, ttlMs, now: () => now,
    schedule: (fn, ms) => {
      const t = { fn, at: now + ms, cancelled: false };
      timers.push(t);
      return { cancel: () => { t.cancelled = true; } };
    },
    onEvent: (ev, e) => events.push(`${ev}:${e.device}`),
  });
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers) if (!t.cancelled && t.at <= now) {
      t.cancelled = true;
      t.fn();
    }
  };
  const put = (device: string, key: string, kind: 'remux' | 'transcode' = 'remux', job = fakeJob(`${device}:${key}`)) =>
    ({ entry: slots.put({ key, device, userId: 'u', itemId: 'i', kind, job, startSegment: 0 }), job });
  return { slots, advance, put, events };
}

test('a warm job is adopted by a start with the same key, and is not stopped', () => {
  const h = harness();
  const { job } = h.put('dev1', 'k1');
  const got = h.slots.take('dev1', 'k1');
  assert.equal(got?.job, job);
  assert.equal(job.stopped, 0);
  assert.equal(h.slots.size, 0);
  h.advance(60000);
  assert.equal(job.stopped, 0, 'adopted jobs are not expired by the warm timer');
});

test('an unused warm job expires after the TTL; prepare again keeps it alive', () => {
  const h = harness(2, 40000);
  const { job } = h.put('dev1', 'k1');
  h.advance(30000);
  assert.ok(h.slots.refresh('dev1', 'k1'), 'refresh while still warm');
  h.advance(30000);
  assert.equal(job.stopped, 0, 'refreshed: still alive 60 s after creation');
  h.advance(11000);
  assert.equal(job.stopped, 1, 'stopped 40 s after the last refresh');
  assert.equal(h.slots.take('dev1', 'k1'), null);
  assert.deepEqual(h.events, ['expired:dev1']);
});

test('start with another key (or another item) stops the warm job instead of adopting it', () => {
  const h = harness();
  const { job } = h.put('dev1', 'k1');
  assert.equal(h.slots.take('dev1', 'k2'), null);
  assert.equal(job.stopped, 1);
  assert.equal(h.slots.size, 0);
});

test('a dead warm job (ffmpeg failed) is not adopted', () => {
  const h = harness();
  const { job } = h.put('dev1', 'k1');
  job.isDead = true;
  assert.equal(h.slots.take('dev1', 'k1'), null);
  assert.equal(job.stopped, 1);
});

test('caps: one warm job per device, N server-wide', () => {
  const h = harness(2);
  const a = h.put('dev1', 'k1');
  const b = h.put('dev1', 'k2');
  assert.equal(a.job.stopped, 1, 'a second prepare on the same device replaces the first');
  assert.equal(h.slots.size, 1);
  h.put('dev2', 'k3');
  assert.equal(h.slots.hasRoom('dev3'), false);
  const c = h.put('dev3', 'k4');
  assert.equal(c.entry, null, 'server-wide cap reached');
  assert.equal(h.slots.hasRoom('dev1'), true, 'a device can always replace its own slot');
  assert.equal(b.job.stopped, 0);
});

test('reclaim frees transcoder capacity from other devices, oldest first', () => {
  const h = harness(5);
  const a = h.put('dev1', 'k1', 'transcode');
  h.advance(10);
  const b = h.put('dev2', 'k2', 'transcode');
  h.advance(10);
  const r = h.put('dev3', 'k3', 'remux');
  // 2 real transcodes after the new start, max 3: one warm transcode must go (the oldest, dev1).
  assert.equal(h.slots.reclaim(2, 3), 1);
  assert.equal(a.job.stopped, 1);
  assert.equal(b.job.stopped, 0);
  assert.equal(r.job.stopped, 0, 'remuxes do not use the transcoder budget');
  // The starting device's own warm job is never reclaimed.
  assert.equal(h.slots.reclaim(3, 3, 'dev2'), 0);
  assert.equal(h.slots.reclaim(3, 3), 1);
  assert.equal(b.job.stopped, 1);
});

test('canWarm: never warm a transcode when the transcoder is busy', () => {
  assert.deepEqual(canWarm('transcode', { runningTranscodes: 1, warmTranscodes: 0, maxConcurrent: 2, slotFree: true }), { ok: true });
  assert.deepEqual(canWarm('transcode', { runningTranscodes: 2, warmTranscodes: 0, maxConcurrent: 2, slotFree: true }), { ok: false, reason: 'busy' });
  assert.deepEqual(canWarm('transcode', { runningTranscodes: 1, warmTranscodes: 1, maxConcurrent: 2, slotFree: true }), { ok: false, reason: 'busy' });
  assert.deepEqual(canWarm('remux', { runningTranscodes: 9, warmTranscodes: 0, maxConcurrent: 2, slotFree: true }), { ok: true });
  assert.deepEqual(canWarm('remux', { runningTranscodes: 0, warmTranscodes: 0, maxConcurrent: 2, slotFree: false }), { ok: false, reason: 'capacity' });
});

test('PlanCache: TTL, validation, LRU size, invalidation', () => {
  let now = 0;
  let valid = true;
  const c = new PlanCache<{ id: string }>({ ttlMs: 1000, maxEntries: 2, now: () => now, validate: () => valid });
  c.set('a', { id: 'a' });
  assert.equal(c.get('a')?.id, 'a');
  now = 1500;
  assert.equal(c.get('a'), null, 'expired');
  c.set('a', { id: 'a' });
  valid = false;
  assert.equal(c.get('a'), null, 'invalidated by the validator');
  valid = true;
  c.set('a', { id: 'a' });
  c.set('b', { id: 'b' });
  c.get('a');
  c.set('c', { id: 'c' });
  assert.equal(c.get('b'), null, 'least recently used dropped');
  assert.ok(c.get('a') && c.get('c'));
  assert.equal(c.invalidate((p) => p.id === 'a'), 1);
  assert.equal(c.size, 1);
});

test('key helpers: bandwidth jitter shares a bucket; key order does not matter', () => {
  assert.equal(bandwidthBucket(30000), bandwidthBucket(31000));
  assert.notEqual(bandwidthBucket(30000), bandwidthBucket(20000));
  assert.equal(bandwidthBucket(null), null);
  assert.equal(stableJson({ b: 1, a: [1, { y: 2, x: undefined, z: null }] }), stableJson({ a: [1, { z: null, y: 2 }], b: 1 }));
});

/* --------------------------- integration: prepare --------------------------- */

const { db } = await import('../src/db.ts');
const { config } = await import('../src/config.ts');
const { createUser, issueToken } = await import('../src/services/auth.ts');
const { scanLibrary } = await import('../src/services/scanner.ts');
const { listSessions, getSession, warmSlots, planCache, stopAllSessions, warmTuning } = await import('../src/services/playback.ts');
const { getSettings, updateSettings } = await import('../src/services/settings.ts');
const { buildApp } = await import('../src/app.ts');

const user = await createUser({ username: 'warmuser', password: 'pw-123456' });
warmTuning.minIntervalMs = 0;
const tokA = issueToken(user.id, { deviceId: 'warm-a', deviceName: 'A', platform: 'web' }).token;
const tokB = issueToken(user.id, { deviceId: 'warm-b', deviceName: 'B', platform: 'web' }).token;
const app = await buildApp();
after(async () => {
  stopAllSessions();
  await app.close();
});
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-warm-'));
const mk = (name: string, vcodec: string[], size = '320x240') => assert.equal(spawnSync(config.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=24:d=20`, '-f', 'lavfi', '-i', 'sine=d=20', '-shortest', '-pix_fmt', 'yuv420p', ...vcodec, '-c:a', 'aac', path.join(root, name)]).status, 0);
mk('Direct One (2021).mp4', ['-c:v', 'libx264', '-preset', 'ultrafast']);
mk('Remux One (2021).mkv', ['-c:v', 'libx264', '-preset', 'ultrafast']);
mk('Transcode One (2021).mkv', ['-c:v', 'mpeg4'], '1280x720');
db.run("INSERT INTO libraries (id, name, type, paths, fetch_metadata, created_at) VALUES ('warm-movies', 'Movies', 'movies', ?, 0, '2026-01-01')", JSON.stringify([root]));
await scanLibrary('warm-movies');
const idOf = (prefix: string) => db.get<{ id: string }>("SELECT id FROM items WHERE library_id = 'warm-movies' AND title LIKE ?", `${prefix}%`)!.id;
const historyCount = () => db.get<{ n: number }>('SELECT COUNT(*) n FROM play_history WHERE user_id = ?', user.id)!.n;
const prepare = (tok: string, itemId: string, body: object = {}) => app.inject({ method: 'POST', url: `/api/v1/playback/${itemId}/prepare`, headers: auth(tok), payload: body });
const start = (tok: string, itemId: string, body: object = {}) => app.inject({ method: 'POST', url: `/api/v1/playback/${itemId}`, headers: auth(tok), payload: body });
const stopSessionReq = (tok: string, sid: string) => app.inject({ method: 'DELETE', url: `/api/v1/playback/sessions/${sid}`, headers: auth(tok) });

test('prepare (remux) warms a job without a session, history or stream-limit use; start adopts it', async () => {
  const id = idOf('Remux One');
  const h0 = historyCount();
  const r = await prepare(tokA, id, { startMs: 0 });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().method, 'remux');
  assert.equal(r.json().warm, 'job');
  assert.equal(listSessions().length, 0, 'no session from prepare');
  assert.equal(historyCount(), h0, 'no history from prepare');
  assert.equal(warmSlots.size, 1);
  const warmJobId = warmSlots.entries()[0].job.spawned.job.id;
  // Preparing again (still hovering) keeps the same job.
  assert.equal((await prepare(tokA, id, { startMs: 0 })).json().warm, 'job');
  assert.equal(warmSlots.entries()[0].job.spawned.job.id, warmJobId);

  const s = await start(tokA, id, { startMs: 0 });
  assert.equal(s.statusCode, 200, s.body);
  const sid = s.json().sessionId;
  assert.equal(getSession(sid)?.job?.id, warmJobId, 'the warm job became the session job');
  assert.equal(warmSlots.size, 0);
  assert.equal(historyCount(), h0 + 1);
  // The adopted stream plays.
  const m = await app.inject({ method: 'GET', url: `/api/v1/stream/hls/${sid}/master.m3u8`, headers: auth(tokA) });
  assert.equal(m.statusCode, 200);
  assert.match(m.body, /#EXTINF/);
  await stopSessionReq(tokA, sid);
});

test('a start with a different request does not adopt the warm job (and stops it)', async () => {
  const id = idOf('Remux One');
  await prepare(tokA, id, {});
  const warm = warmSlots.entries()[0].job.spawned.job;
  const s = await start(tokA, id, { audioStreamIndex: 99, forceTranscode: true });
  assert.equal(s.statusCode, 200, s.body);
  assert.notEqual(getSession(s.json().sessionId)?.job?.id, warm.id);
  assert.equal(warm.killed, true, 'unused warm job stopped');
  assert.equal(warmSlots.size, 0);
  await stopSessionReq(tokA, s.json().sessionId);
});

test('prepare: direct play only caches the decision and returns a preload URL; metered clients get no job', async () => {
  const d = await prepare(tokA, idOf('Direct One'));
  assert.equal(d.statusCode, 200, d.body);
  assert.equal(d.json().method, 'direct');
  assert.equal(d.json().warm, 'decision');
  assert.match(d.json().preloadUrl, /^\/api\/v1\/stream\/direct\/.+\?token=/);
  const m = await prepare(tokA, idOf('Remux One'), { metered: true });
  assert.equal(m.json().warm, 'decision');
  assert.equal(m.json().reason, 'metered');
  assert.equal(warmSlots.size, 0);
  assert.equal(listSessions().length, 0);
});

test('prepare never warms a transcode while the transcoder is busy; a real start reclaims warm capacity', async () => {
  const prev = getSettings().transcoding;
  updateSettings({ transcoding: { ...prev, maxConcurrent: 1 } });
  try {
    const t = idOf('Transcode One');
    // Device A warms a transcode (transcoder idle).
    const w = await prepare(tokA, t);
    assert.equal(w.json().method, 'transcode');
    assert.equal(w.json().warm, 'job');
    // Device B starts a real transcode: A's warm job gives way instead of B getting "server busy".
    const s = await start(tokB, t);
    assert.equal(s.statusCode, 200, s.body);
    assert.equal(warmSlots.size, 0, 'warm transcode reclaimed');
    // Now the transcoder is busy: A only gets the decision.
    const busy = await prepare(tokA, t, { startMs: 4000 });
    assert.equal(busy.json().warm, 'decision');
    assert.equal(busy.json().reason, 'busy');
    await stopSessionReq(tokB, s.json().sessionId);
  } finally {
    updateSettings({ transcoding: { ...getSettings().transcoding, maxConcurrent: prev.maxConcurrent } });
  }
});

test('adaptive transcode: the warm rendition manager is adopted', async () => {
  const t = idOf('Transcode One');
  const body = { adaptive: true, measuredBandwidth: 20000, startMs: 0 };
  assert.equal((await prepare(tokA, t, body)).json().warm, 'job');
  const warm = warmSlots.entries()[0].job.spawned;
  assert.ok(warm.abr, 'adaptive warm job');
  const s = await start(tokA, t, body);
  assert.equal(s.statusCode, 200, s.body);
  assert.equal(getSession(s.json().sessionId)?.abr, warm.abr);
  assert.ok(s.json().renditions?.length > 1);
  await stopSessionReq(tokA, s.json().sessionId);
});

test('decision cache: reused by start, invalidated by settings changes and a rescanned file', async () => {
  const id = idOf('Direct One');
  planCache.invalidate();
  await prepare(tokA, id);
  assert.equal(planCache.size, 1);
  const [key] = [...(planCache as any).map.keys()];
  assert.ok(planCache.get(key), 'cached');
  // Settings change: a new settings object, every plan is stale.
  updateSettings({ transcoding: { ...getSettings().transcoding } });
  assert.equal(planCache.get(key), null, 'stale after a settings change');
  await prepare(tokA, id);
  assert.ok(planCache.get(key));
  // The file was rescanned (new mtime / probe data).
  db.run("UPDATE media SET mtime = COALESCE(mtime, 0) + 1 WHERE item_id = ?", id);
  assert.equal(planCache.get(key), null, 'stale after the media row changed');
  // A different device (or request) has its own plan.
  await prepare(tokA, id);
  await prepare(tokB, id);
  assert.equal(planCache.size, 2);
  assert.equal(listSessions().length, 0);
});

test('a device flicking through items does not churn encoders (one new warm job per second)', async () => {
  warmTuning.minIntervalMs = 1000;
  await new Promise((r) => setTimeout(r, 1100)); // past earlier tests' warm jobs on this device
  try {
    assert.equal((await prepare(tokA, idOf('Remux One'), { startMs: 0 })).json().warm, 'job');
    const r = await prepare(tokA, idOf('Transcode One'), { startMs: 0 });
    assert.equal(r.json().warm, 'decision');
    assert.equal(r.json().reason, 'capacity');
    // The same item again only refreshes the warm job (no new encoder): allowed.
    assert.equal((await prepare(tokA, idOf('Remux One'), { startMs: 0 })).json().warm, 'job');
  } finally {
    warmTuning.minIntervalMs = 0;
    warmSlots.clear();
  }
});
