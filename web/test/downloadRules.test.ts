// Settings → Downloads helpers (src/utils/downloadRules.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupRulesByDevice, ruleSummary } from '../src/utils/downloadRules.ts';

const rule = (o: object) => ({ id: 'r', showId: 's', showTitle: 'B', posterUrl: null, deviceId: 'd1', deviceName: 'Phone', platform: 'ios', keepCount: 3, deleteWatchedAfterHours: 24, wifiOnly: true, chargingOnly: false, quality: 'original', createdAt: '', updatedAt: '', lastSyncAt: null, ...o }) as any;

test('rules grouped per device, sorted', () => {
  const g = groupRulesByDevice([rule({ id: '1', showTitle: 'Zed' }), rule({ id: '2', deviceId: 'd2', deviceName: 'Am tablet', platform: 'android' }), rule({ id: '3', showTitle: 'Alpha' })]);
  assert.deepEqual(g.map((x) => x.deviceName), ['Am tablet', 'Phone']);
  assert.deepEqual(g[1].rules.map((r) => r.showTitle), ['Alpha', 'Zed']);
});

test('rule summary', () => {
  assert.equal(ruleSummary(rule({})), 'Next 3 unwatched · Wi-Fi only · deletes watched episodes after 24 h');
  assert.equal(ruleSummary(rule({ keepCount: 10, wifiOnly: false, quality: '720p', deleteWatchedAfterHours: null })), 'Next 10 unwatched · 720p · keeps watched episodes');
  assert.equal(ruleSummary(rule({ deleteWatchedAfterHours: 168 })).endsWith('after 7 days'), true);
});
