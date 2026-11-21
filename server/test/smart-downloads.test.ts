// Smart downloads: rules per device, "next N unwatched" evaluation, watched cleanup, access rules, offline sync.
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
const { watchedCleanupDue, normalizeRuleInput } = await import('../src/services/smartDownloads.ts');
const { buildApp } = await import('../src/app.ts');

const user = createUser({ username: 'sdl-user', password: 'pw-123456' });
const kid = createUser({ username: 'sdl-kid', password: 'pw-123456', maxContentRating: 'TV-PG' } as any);
const nodl = createUser({ username: 'sdl-nodl', password: 'pw-123456', allowDownloads: false } as any);
const phone = issueToken(user.id, { deviceId: 'phone-1', deviceName: 'Phone', platform: 'ios' }).token;
const tablet = issueToken(user.id, { deviceId: 'tablet-1', deviceName: 'Tablet', platform: 'android' }).token;
const kidTok = issueToken(kid.id, { deviceId: 'kid-phone', deviceName: 'Kid phone', platform: 'ios' }).token;
const nodlTok = issueToken(nodl.id, { deviceId: 'nodl-phone', deviceName: 'P', platform: 'ios' }).token;
const app = await buildApp();
after(() => app.close());
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (tok: string, method: string, url: string, payload?: object) => app.inject({ method: method as any, url: `/api/v1${url}`, headers: auth(tok), payload });

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-sdl-'));
const season = path.join(root, 'Smart Show (2020)', 'Season 01');
fs.mkdirSync(season, { recursive: true });
const sample = path.join(root, 'sample.mkv');
assert.equal(spawnSync(config.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=10:d=1', '-c:v', 'libx264', '-preset', 'ultrafast', sample]).status, 0);
for (let e = 1; e <= 8; e++) fs.copyFileSync(sample, path.join(season, `Smart.Show.S01E0${e}.mkv`));
fs.rmSync(sample);
db.run("INSERT INTO libraries (id, name, type, paths, fetch_metadata, created_at) VALUES ('sdl-tv', 'TV', 'shows', ?, 0, '2026-01-01')", JSON.stringify([root]));
await scanLibrary('sdl-tv');
const showId = db.get<{ id: string }>("SELECT id FROM items WHERE library_id = 'sdl-tv' AND type = 'show'")!.id;
const ep = (n: number) => db.get<{ id: string }>("SELECT id FROM items WHERE grandparent_id = ? AND type = 'episode' AND idx = ?", showId, n)!.id;
const markPlayed = (uid: string, n: number, at: string) =>
  db.run('INSERT INTO user_data (user_id, item_id, played, play_count, position_ms, last_played_at) VALUES (?, ?, 1, 1, 0, ?) ON CONFLICT (user_id, item_id) DO UPDATE SET played = 1, last_played_at = excluded.last_played_at', uid, ep(n), at);

test('rules are per device and visible to the user’s other devices', async () => {
  const r = await call(phone, 'PUT', `/downloads/rules/${showId}`, { keepCount: 3, deleteWatchedAfterHours: 24 });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().keepCount, 3);
  assert.equal(r.json().wifiOnly, true, 'Wi-Fi only by default');
  assert.equal(r.json().deviceName, 'Phone');
  assert.equal((await call(phone, 'PUT', `/downloads/rules/${showId}`, { keepCount: 4 })).statusCode, 400, 'only 1/3/5/10');
  assert.equal((await call(phone, 'PUT', `/downloads/rules/${ep(1)}`, { keepCount: 3 })).statusCode, 400, 'rules follow shows');
  // Updating keeps one rule per device + show.
  assert.equal((await call(phone, 'PUT', `/downloads/rules/${showId}`, { keepCount: 5, deleteWatchedAfterHours: 24 })).json().keepCount, 5);
  const all = (await call(tablet, 'GET', '/downloads/rules')).json();
  assert.equal(all.length, 1);
  assert.equal(all[0].current, false, 'seen from the tablet: another device’s rule');
  assert.equal((await call(tablet, 'GET', '/downloads/rules?scope=device')).json().length, 0);
  assert.equal((await call(nodlTok, 'PUT', `/downloads/rules/${showId}`, { keepCount: 1 })).statusCode, 403, 'downloads not allowed');
});

test('plan: the next N unwatched episodes from the next-up one, in order', async () => {
  await call(phone, 'PUT', `/downloads/rules/${showId}`, { keepCount: 3, deleteWatchedAfterHours: 24 });
  let plan = (await call(phone, 'POST', '/downloads/plan', { have: [] })).json();
  assert.deepEqual(plan.want[0].items.map((i: any) => i.index), [1, 2, 3]);
  markPlayed(user.id, 1, new Date().toISOString());
  markPlayed(user.id, 2, new Date().toISOString());
  plan = (await call(phone, 'POST', '/downloads/plan', { have: [ep(1), ep(2), ep(3)] })).json();
  assert.deepEqual(plan.want[0].items.map((i: any) => i.index), [3, 4, 5]);
  // Watched just now, delete after 24 h: nothing to delete yet.
  assert.deepEqual(plan.remove, []);
  assert.equal(plan.have.find((h: any) => h.itemId === ep(1)).played, true);
  assert.ok((await call(phone, 'GET', '/downloads/rules?scope=device')).json()[0].lastSyncAt, 'sync time recorded');
  // Rewatching from the middle: an in-progress episode is next up.
  db.run('INSERT INTO user_data (user_id, item_id, position_ms, last_played_at) VALUES (?, ?, 5000, ?) ON CONFLICT (user_id, item_id) DO UPDATE SET position_ms = 5000', user.id, ep(6), new Date().toISOString());
  plan = (await call(phone, 'POST', '/downloads/plan', { have: [] })).json();
  assert.deepEqual(plan.want[0].items.map((i: any) => i.index), [6, 7, 8]);
  db.run('DELETE FROM user_data WHERE user_id = ? AND item_id = ?', user.id, ep(6));
});

test('watched cleanup: episodes watched longer ago than the rule allows are removed', async () => {
  const old = new Date(Date.now() - 30 * 3600_000).toISOString();
  markPlayed(user.id, 1, old);
  const plan = (await call(phone, 'POST', '/downloads/plan', { have: [ep(1), ep(2), ep(3)] })).json();
  assert.deepEqual(plan.remove, [{ itemId: ep(1), reason: 'watched' }], 'E01 watched 30 h ago; E02 only just now');
  assert.equal(watchedCleanupDue({ played: true, lastPlayedAt: old }, 24), true);
  assert.equal(watchedCleanupDue({ played: true, lastPlayedAt: old }, 48), false);
  assert.equal(watchedCleanupDue({ played: true, lastPlayedAt: old }, null), false, 'null = keep watched');
  assert.equal(watchedCleanupDue({ played: false, lastPlayedAt: old }, 0), false);
  assert.deepEqual(normalizeRuleInput({ keepCount: 10, deleteWatchedAfterHours: 99999 }).deleteWatchedAfterHours, 720);
});

test('access: hidden episodes are never planned, hidden items are reported gone', async () => {
  db.run("UPDATE items SET content_rating = 'TV-MA' WHERE id = ?", ep(2));
  const r = await call(kidTok, 'PUT', `/downloads/rules/${showId}`, { keepCount: 3 });
  assert.equal(r.statusCode, 200, r.body);
  const plan = (await call(kidTok, 'POST', '/downloads/plan', { have: [ep(2), 'no-such-item'] })).json();
  assert.ok(!plan.want[0].items.some((i: any) => i.id === ep(2)), 'TV-MA episode skipped for a TV-PG profile');
  assert.deepEqual(plan.want[0].items.map((i: any) => i.index), [1, 3, 4]);
  assert.deepEqual(plan.remove.map((x: any) => x.reason), ['gone', 'gone']);
  // Someone else's rule can't be deleted.
  const mine = (await call(phone, 'GET', '/downloads/rules')).json()[0];
  assert.equal((await call(kidTok, 'DELETE', `/downloads/rules/${mine.id}`)).statusCode, 404);
  db.run('UPDATE items SET content_rating = NULL WHERE id = ?', ep(2));
});

test('offline sync: newest change wins in both directions', async () => {
  const t = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
  db.run('DELETE FROM user_data WHERE user_id = ?', user.id);
  // Watched offline (no server change since): applied.
  let r = (await call(phone, 'POST', '/downloads/sync', { entries: [{ itemId: ep(4), played: true, at: t(-1) }, { itemId: ep(5), positionMs: 600, durationMs: 1000, at: t(-2) }] })).json();
  assert.deepEqual(r.applied.sort(), [ep(4), ep(5)].sort());
  assert.equal(r.state.find((s: any) => s.itemId === ep(4)).played, true);
  // The server saw newer activity on E06 than the offline change: skipped, server state returned.
  db.run('INSERT INTO user_data (user_id, item_id, position_ms, last_played_at) VALUES (?, ?, 9000, ?)', user.id, ep(6), t(0));
  r = (await call(phone, 'POST', '/downloads/sync', { entries: [{ itemId: ep(6), positionMs: 100, at: t(-3) }, { itemId: 'nope', played: true, at: t(-1) }] })).json();
  assert.deepEqual(r.applied, []);
  assert.deepEqual(r.skipped.sort(), [ep(6), 'nope'].sort());
  assert.equal(r.state.find((s: any) => s.itemId === ep(6)).positionMs, 9000);
  // Marked unwatched offline after watching.
  r = (await call(phone, 'POST', '/downloads/sync', { entries: [{ itemId: ep(4), played: false, at: t(1) }] })).json();
  assert.deepEqual(r.applied, [ep(4)]);
  assert.equal(r.state[0].played, false);
});

test('deleting a rule from another device (web page)', async () => {
  const rule = (await call(tablet, 'GET', '/downloads/rules')).json().find((x: any) => x.deviceId === 'phone-1');
  assert.equal((await call(tablet, 'DELETE', `/downloads/rules/${rule.id}`)).statusCode, 200);
  assert.equal((await call(phone, 'POST', '/downloads/plan', { have: [] })).json().rules.length, 0);
});
