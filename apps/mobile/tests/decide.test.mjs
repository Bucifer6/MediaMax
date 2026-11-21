// Movie Match / marathon helpers shared by the native screens (run: npm test in apps/mobile).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCode, stillWatchingDue, swipeVote } from '../src/api/decide.ts';

test('join codes', () => {
  assert.equal(normalizeCode(' ab-c d2x9z '), 'ABCD2X');
  assert.equal(normalizeCode('o0i1AB'), 'AB');
});

test('swipe release → vote', () => {
  assert.equal(swipeVote(150, 0, 0, 0, 360), 'yes');
  assert.equal(swipeVote(-150, 0, 0, 0, 360), 'no');
  assert.equal(swipeVote(0, -160, 0, 0, 360), 'super');
  assert.equal(swipeVote(40, 0, 1, 0, 360), 'yes');
  assert.equal(swipeVote(20, 5, 0.1, 0, 360), null);
});

test('still watching rule', () => {
  const s = { enabled: true, afterItems: 2, afterMinutes: 240 };
  assert.equal(stillWatchingDue(s, 2, 0), true);
  assert.equal(stillWatchingDue(s, 1, 0), false);
  assert.equal(stillWatchingDue({ ...s, enabled: false }, 9, 1e10), false);
});
