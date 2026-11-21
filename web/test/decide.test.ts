// Movie Match swipe physics, roulette reel layout, sleep timer and still-watching helpers (run: npm test -w web).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dragHint, dragTransform, fadeFactor, filtersToParams, flyOut, joinUrl, keyVote, normalizeCode, paramsToFilters, planReel, reelEase, sleepMsLeft, stillWatchingDue, swipeVote,
} from '../src/utils/decide.ts';

test('swipe: distance or flick decides, otherwise spring back', () => {
  const w = 400;
  assert.equal(swipeVote({ dx: 150, dy: 10, vx: 0, vy: 0, width: w }), 'yes');
  assert.equal(swipeVote({ dx: -150, dy: 10, vx: 0, vy: 0, width: w }), 'no');
  assert.equal(swipeVote({ dx: 10, dy: -160, vx: 0, vy: 0, width: w }), 'super');
  assert.equal(swipeVote({ dx: 40, dy: 0, vx: 0.9, vy: 0, width: w }), 'yes', 'a fast flick counts');
  assert.equal(swipeVote({ dx: 40, dy: 0, vx: 0.1, vy: 0, width: w }), null);
  assert.equal(swipeVote({ dx: 5, dy: -40, vx: 0, vy: -1, width: w }), 'super');
});

test('swipe: drag transform rotates with distance, hint and fly-out', () => {
  assert.match(dragTransform(100, 0, 400), /rotate\(5\.50deg\)/);
  assert.match(dragTransform(-1000, 0, 400), /rotate\(-18\.00deg\)/);
  assert.deepEqual(dragHint(0, 0, 400), { vote: null, strength: 0 });
  assert.equal(dragHint(200, 0, 400).vote, 'yes');
  assert.equal(dragHint(0, -50, 400).vote, 'super');
  assert.ok(flyOut('yes', 400, 600).x > 400);
  assert.ok(flyOut('no', 400, 600).x < -400);
  assert.ok(flyOut('super', 400, 600).y < -600);
  assert.equal(keyVote('ArrowRight'), 'yes');
  assert.equal(keyVote('ArrowLeft'), 'no');
  assert.equal(keyVote('ArrowUp'), 'super');
  assert.equal(keyVote('ArrowDown'), null);
});

test('join codes and links', () => {
  assert.equal(normalizeCode(' ab-c d2x9z '), 'ABCD2X');
  assert.equal(normalizeCode('o0i1AB'), 'AB');
  assert.equal(joinUrl('https://media.example/', 'ABC234'), 'https://media.example/match/join/ABC234');
});

test('reel: the pick lands centred, after enough decoys, never at the edge', () => {
  const p = planReel('pick', ['a', 'b', 'c', 'pick'], { cardW: 100, gap: 10, viewport: 500, laps: 3, jitter: 0.5 });
  assert.equal(p.order[p.targetIndex], 'pick');
  assert.ok(p.targetIndex >= 24);
  assert.equal(p.order.filter((x) => x === 'pick').length, 1, 'only one pick card in the strip');
  assert.ok(p.order.length > p.targetIndex + 1, 'cards after the pick');
  // Centre of the pick card is at the viewport centre.
  assert.equal(p.targetIndex * 110 + 50 + p.finalX, 250);
  const lone = planReel('pick', [], { cardW: 100, gap: 10, viewport: 500 });
  assert.equal(lone.order[lone.targetIndex], 'pick');
  assert.equal(reelEase(0), 0);
  assert.equal(reelEase(1), 1);
  for (let t = 0; t < 1; t += 0.05) assert.ok(reelEase(t + 0.05) >= reelEase(t), 'monotonic');
});

test('sleep timer: fade and time left', () => {
  assert.equal(fadeFactor(60_000), 1);
  assert.equal(fadeFactor(15_000), 0.5);
  assert.equal(fadeFactor(-5), 0);
  assert.equal(sleepMsLeft({ kind: 'minutes', minutes: 30 }, 0, 10 * 60_000, null), 20 * 60_000);
  assert.equal(sleepMsLeft({ kind: 'end' }, 0, 0, 5000), 5000);
  assert.equal(sleepMsLeft({ kind: 'items', count: 2 }, 0, 0, 5000), null);
});

test('still watching mirrors the server rule', () => {
  const s = { enabled: true, afterItems: 2, afterMinutes: 240 };
  assert.equal(stillWatchingDue(s, 1, 0), false);
  assert.equal(stillWatchingDue(s, 2, 0), true);
  assert.equal(stillWatchingDue(s, 0, 4 * 3600_000), true);
  assert.equal(stillWatchingDue({ ...s, enabled: false }, 5, 1e10), false);
});

test('roulette filters round-trip through the URL', () => {
  const f = { kind: 'series' as const, libraryIds: ['l1'], genres: ['Comedy', 'Drama'], maxRuntimeMin: 30, decade: 1990, minRating: 7, unwatchedOnly: true, fromMyList: false, mood: 'laugh' as const, weighted: false, randomEpisode: true };
  assert.deepEqual(paramsToFilters(filtersToParams(f)), f);
  assert.equal(paramsToFilters(new URLSearchParams('mood=evil')).mood, null);
  assert.equal(paramsToFilters(new URLSearchParams()).kind, 'movie');
});
