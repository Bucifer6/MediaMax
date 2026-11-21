// Unit tests for src/state/smartDownloads.ts (smart download decisions).
// Run with `npm test` in apps/mobile (Node's built-in test runner with TypeScript type stripping).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SMART_SETTINGS, canTransfer, estimateBytes, evictionFor, localCleanup, mergeServerState, queueSync, smartActions, watchedDue } from '../src/state/smartDownloads.ts';

const GB = 1024 ** 3;
const ep = (id, size = GB, extra = {}) => ({ id, type: 'episode', grandparentId: 'show', durationMs: 2_400_000, media: [{ size }], ...extra });
const rec = (id, o = {}) => ({ id, state: 'done', bytes: GB, total: GB, createdAt: '2026-01-01T00:00:00Z', item: ep(id), positionMs: 0, ...o });
const rule = (o = {}) => ({ id: 'r1', showId: 'show', keepCount: 3, deleteWatchedAfterHours: 24, wifiOnly: true, chargingOnly: false, quality: 'original', ...o });
const wifi = { online: true, wifi: true, charging: false };
const cell = { online: true, wifi: false, charging: true };
const plan = (items, o = {}) => ({ rules: [rule(o.rule)], want: [{ ruleId: 'r1', showId: 'show', items }], have: [], remove: o.remove ?? [], generatedAt: '' });

test('transfers wait for Wi-Fi, charging, a connection, or the pause switch', () => {
  assert.deepEqual(canTransfer(DEFAULT_SMART_SETTINGS, wifi), { ok: true });
  assert.deepEqual(canTransfer(DEFAULT_SMART_SETTINGS, cell), { ok: false, waitingFor: 'wifi' });
  assert.deepEqual(canTransfer({ ...DEFAULT_SMART_SETTINGS, wifiOnly: false }, cell), { ok: true });
  assert.deepEqual(canTransfer({ ...DEFAULT_SMART_SETTINGS, wifiOnly: false }, cell, rule()), { ok: false, waitingFor: 'wifi' }, 'the rule itself is Wi-Fi only');
  assert.deepEqual(canTransfer(DEFAULT_SMART_SETTINGS, wifi, rule({ chargingOnly: true })), { ok: false, waitingFor: 'charging' });
  assert.deepEqual(canTransfer({ ...DEFAULT_SMART_SETTINGS, paused: true }, wifi), { ok: false, waitingFor: 'paused' });
  assert.deepEqual(canTransfer(DEFAULT_SMART_SETTINGS, { online: false, wifi: false, charging: false }), { ok: false, waitingFor: 'offline' });
});

test('plan → actions: queue what is missing, delete what the server says', () => {
  const a = smartActions({ records: [rec('e1', { watched: true })], plan: plan([ep('e2'), ep('e3'), ep('e4')], { remove: [{ itemId: 'e1', reason: 'watched' }, { itemId: 'not-here', reason: 'gone' }] }), settings: DEFAULT_SMART_SETTINGS, cond: wifi });
  assert.deepEqual(a.queue.map((q) => q.item.id), ['e2', 'e3', 'e4']);
  assert.deepEqual(a.remove, [{ id: 'e1', reason: 'watched' }]);
  assert.equal(a.waitingFor, null);
  const onCell = smartActions({ records: [], plan: plan([ep('e2')]), settings: DEFAULT_SMART_SETTINGS, cond: cell });
  assert.deepEqual(onCell.queue, []);
  assert.equal(onCell.waitingFor, 'wifi');
});

test('storage limit: oldest-watched evicted first; unwatched never; stop when it cannot fit', () => {
  const records = [
    rec('old', { watched: true, watchedAt: '2026-01-02T00:00:00Z' }),
    rec('newer', { watched: true, watchedAt: '2026-01-05T00:00:00Z' }),
    rec('unwatched'),
  ];
  assert.deepEqual(evictionFor(records, 4 * GB, GB), []);
  assert.deepEqual(evictionFor(records, 3 * GB, GB), ['old']);
  assert.deepEqual(evictionFor(records, 3 * GB, 2 * GB), ['old', 'newer']);
  assert.equal(evictionFor(records, 2 * GB, 3 * GB), null, 'would need to delete unwatched downloads');
  const settings = { ...DEFAULT_SMART_SETTINGS, storageLimitGb: 3 };
  const a = smartActions({ records, plan: plan([ep('e2'), ep('e3'), ep('e4')]), settings, cond: wifi });
  assert.deepEqual(a.queue.map((q) => q.item.id), ['e2', 'e3'], 'third episode does not fit');
  assert.deepEqual(a.remove, [{ id: 'old', reason: 'storage' }, { id: 'newer', reason: 'storage' }]);
  assert.equal(a.waitingFor, 'storage');
});

test('size estimates for converted downloads', () => {
  assert.equal(estimateBytes(ep('x', 123)), 123);
  assert.equal(Math.round(estimateBytes(ep('x', 123), '720p') / 1e6), Math.round(((4160 * 1000 * 2400) / 8) / 1e6));
});

test('offline watched cleanup and server state merge', () => {
  const now = Date.parse('2026-01-03T00:00:00Z');
  assert.equal(watchedDue({ watched: true, watchedAt: '2026-01-01T00:00:00Z' }, 24, now), true);
  assert.equal(watchedDue({ watched: true, watchedAt: '2026-01-02T12:00:00Z' }, 24, now), false);
  assert.equal(watchedDue({ watched: true, watchedAt: '2026-01-02T12:00:00Z' }, 0, now), true);
  assert.equal(watchedDue({ watched: true }, null, now), false);
  const records = [rec('a', { watched: true, watchedAt: '2026-01-01T00:00:00Z' }), rec('b', { watched: true, watchedAt: '2026-01-01T00:00:00Z', item: ep('b', GB, { grandparentId: 'other' }) })];
  assert.deepEqual(localCleanup(records, [rule()], now), ['a'], 'only shows with a rule');
  assert.deepEqual(mergeServerState(rec('a'), { itemId: 'a', played: true, lastPlayedAt: 'T', positionMs: 0, gone: false }), { watched: true, watchedAt: 'T' });
  assert.deepEqual(mergeServerState(rec('a'), { itemId: 'a', played: false, lastPlayedAt: null, positionMs: 5000, gone: false }), { positionMs: 5000 });
  assert.equal(mergeServerState(rec('a', { pendingSync: true }), { itemId: 'a', played: true, lastPlayedAt: 'T', positionMs: 0, gone: false }), null, 'unsynced local change wins');
});

test('sync queue keeps one entry per item, newest wins', () => {
  let q = queueSync([], { itemId: 'a', positionMs: 100, at: '1' });
  q = queueSync(q, { itemId: 'b', played: true, at: '2' });
  q = queueSync(q, { itemId: 'a', played: true, at: '3' });
  assert.deepEqual(q, [{ itemId: 'b', played: true, at: '2' }, { itemId: 'a', positionMs: 100, played: true, at: '3' }]);
  q = queueSync(q, { itemId: 'a', positionMs: 900, at: '4' });
  assert.equal(q.find((x) => x.itemId === 'a').played, undefined, 'rewatching after marking watched');
});
