// Phone remote helpers: touch-pad gestures, keyboard diffing, trickplay tiles, position estimate (run: npm test -w web).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyGesture, estimatePosition, swipeSteps, textDiff, trickplayTile, SWIPE_STEP } from '../src/remote/gesture.ts';

test('tap = OK, swipe = direction, slow long press = nothing', () => {
  assert.equal(classifyGesture(3, -4, 120), 'ok');
  assert.equal(classifyGesture(2, 2, 900), null);
  assert.equal(classifyGesture(120, 20, 200), 'right');
  assert.equal(classifyGesture(-90, 40, 200), 'left');
  assert.equal(classifyGesture(10, 80, 200), 'down');
  assert.equal(classifyGesture(-30, -100, 200), 'up');
  assert.equal(classifyGesture(20, 18, 200), null, 'too small to be a swipe, too big to be a tap');
});

test('continuous swipe emits one step per SWIPE_STEP along the dominant axis', () => {
  assert.equal(swipeSteps(SWIPE_STEP - 1, 0), null);
  assert.deepEqual(swipeSteps(SWIPE_STEP * 2 + 5, 10), { key: 'right', n: 2 });
  assert.deepEqual(swipeSteps(5, -SWIPE_STEP), { key: 'up', n: 1 });
});

test('keyboard field diff → backspaces + appended text', () => {
  assert.deepEqual(textDiff('', 'sta'), { backspaces: 0, text: 'sta' });
  assert.deepEqual(textDiff('star', 'star wars'), { backspaces: 0, text: ' wars' });
  assert.deepEqual(textDiff('star wars', 'star'), { backspaces: 5, text: '' });
  assert.deepEqual(textDiff('stir', 'star'), { backspaces: 2, text: 'ar' }, 'autocorrect replaces the tail');
  assert.deepEqual(textDiff('abc', 'abc'), { backspaces: 0, text: '' });
});

test('trickplay tile position across sheets', () => {
  const tp = { mediaId: 'm', intervalMs: 10_000, width: 160, height: 90, columns: 10, rows: 10, count: 150, sheets: ['/s0.jpg', '/s1.jpg'] };
  assert.deepEqual(trickplayTile(tp, 0), { url: '/s0.jpg', x: 0, y: 0, w: 160, h: 90 });
  assert.deepEqual(trickplayTile(tp, 125_000), { url: '/s0.jpg', x: 2 * 160, y: 1 * 90, w: 160, h: 90 });
  assert.deepEqual(trickplayTile(tp, 1_005_000), { url: '/s1.jpg', x: 0, y: 0, w: 160, h: 90 });
  assert.equal(trickplayTile(tp, 99_999_999)!.url, '/s1.jpg', 'clamped to the last thumbnail');
  assert.equal(trickplayTile({ ...tp, count: 0 }, 0), null);
});

test('position estimate between state reports', () => {
  assert.equal(estimatePosition({ positionMs: 60_000, paused: false, durationMs: 100_000 }, 1000, 6000), 65_000);
  assert.equal(estimatePosition({ positionMs: 60_000, paused: true, durationMs: 100_000 }, 1000, 6000), 60_000);
  assert.equal(estimatePosition({ positionMs: 99_000, paused: false, durationMs: 100_000 }, 0, 10_000), 100_000);
  assert.equal(estimatePosition(null, 0), 0);
});
