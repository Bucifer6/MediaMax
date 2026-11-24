import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DjSession, Item } from '@mediamax/shared';
import {
  appendTracks, isMiss, NO_MATCH_FALLBACK, reasonLabel, segmentOf, sessionHistory, switchAck, switchQueue, yourDjReducer, type YourDjState,
} from '../src/player/yourDj';

const item = (id: string): Item => ({ id, type: 'track', title: id } as unknown as Item);
const session = (id: string, segId: string, kind: DjSession['segment']['kind'], ids: string[], reasons: Record<string, string> = {}, extra: Partial<DjSession> = {}): DjSession => ({
  id, segment: { id: segId, kind, title: segId === 's1' ? 'On repeat' : 'Back to 2019', reason: 'Songs you love lately' }, items: ids.map(item), analyses: {}, reasons, ...extra,
});

test('start: segment, per-track reasons and segment mapping', () => {
  const s = yourDjReducer(null, { type: 'start', session: session('x', 's1', 'on-repeat', ['a', 'b'], { a: 'You played this 12 times this month' }) })!;
  assert.equal(s.sessionId, 'x');
  assert.equal(s.segmentId, 's1');
  assert.equal(segmentOf(s, 'a')?.title, 'On repeat');
  assert.equal(segmentOf(s, 'zzz'), null);
  assert.equal(reasonLabel(s, 'a'), 'On repeat · you played this 12 times this month');
  // Falls back to the segment's reason.
  assert.equal(reasonLabel(s, 'b'), 'On repeat · songs you love lately');
  assert.equal(s.turn, 0);
});

test('reason label: "Throwback · big for you in 2019", and no doubled kind', () => {
  let s = yourDjReducer(null, { type: 'start', session: session('x', 's2', 'throwbacks', ['t'], { t: 'Big for you in 2019' }) })!;
  assert.equal(reasonLabel(s, 't'), 'Throwback · big for you in 2019');
  s = yourDjReducer(s, { type: 'more', session: session('x', 's2', 'throwbacks', ['u'], { u: 'Throwback to your summer of 2019' }) })!;
  assert.equal(reasonLabel(s, 'u'), 'Throwback to your summer of 2019');
});

test('more: queues up behind without a turn; switch: a new segment and a turn', () => {
  let s = yourDjReducer(null, { type: 'start', session: session('x', 's1', 'on-repeat', ['a', 'b']) })!;
  s = yourDjReducer(s, { type: 'more', session: session('x', 's1', 'on-repeat', ['c']) })!;
  assert.equal(s.turn, 0);
  assert.equal(segmentOf(s, 'c')?.id, 's1');
  s = yourDjReducer(s, { type: 'busy', busy: 'switch' })!;
  assert.equal(s.busy, 'switch');
  s = yourDjReducer(s, { type: 'switch', session: session('x', 's2', 'throwbacks', ['d', 'e'], { d: 'Big for you in 2019' }) })!;
  assert.equal(s.busy, null);
  assert.equal(s.turn, 1);
  assert.equal(s.segmentId, 's2');
  assert.equal(segmentOf(s, 'a')?.id, 's1', 'earlier tracks keep their segment');
  assert.equal(segmentOf(s, 'd')?.id, 's2');
});

test('request with no match: a gentle message, the set carries on unchanged', () => {
  let s = yourDjReducer(null, { type: 'start', session: session('x', 's1', 'on-repeat', ['a']) })!;
  s = yourDjReducer(s, { type: 'busy', busy: 'request' })!;
  const before = s;
  s = yourDjReducer(s, { type: 'request', result: { ok: false, message: 'Nothing like that within your play rules, so I kept the vibe going.' } })!;
  assert.equal(s.message, 'Nothing like that within your play rules, so I kept the vibe going.');
  assert.equal(s.busy, null);
  assert.equal(s.turn, before.turn);
  assert.equal(s.segmentId, before.segmentId);
  // Empty message: our own gentle line.
  s = yourDjReducer(s, { type: 'request', result: { ok: false, message: '' } })!;
  assert.equal(s.message, NO_MATCH_FALLBACK);
  s = yourDjReducer(s, { type: 'dismiss' })!;
  assert.equal(s.message, null);
  // A match: new segment, turn, message cleared.
  s = yourDjReducer(s, { type: 'request', result: session('x', 'r1', 'request', ['q']) })!;
  assert.equal(s.turn, before.turn + 1);
  assert.equal(segmentOf(s, 'q')?.kind, 'request');
  assert.equal(isMiss({ ok: false, message: 'x' }), true);
  assert.equal(isMiss(session('x', 'r', 'request', [])), false);
});

test('a session note (rules leave little to choose from) shows as the gentle message', () => {
  const s = yourDjReducer(null, { type: 'start', session: session('x', 's1', 'on-repeat', ['a'], {}, { note: 'Your play rules leave only a few songs.' }) })!;
  assert.equal(s.message, 'Your play rules leave only a few songs.');
});

test('end and actions without a session', () => {
  assert.equal(yourDjReducer(null, { type: 'switch', session: session('x', 's', 'mood', []) }), null);
  const s = yourDjReducer(null, { type: 'start', session: session('x', 's1', 'on-repeat', ['a']) });
  assert.equal(yourDjReducer(s, { type: 'end' }), null);
});

test('queue helpers: switch replaces what is coming up, more appends without duplicates', () => {
  const q = ['a', 'b', 'c', 'd'].map(item);
  assert.deepEqual(switchQueue(q, 1, ['x', 'a', 'y'].map(item)).map((i) => i.id), ['a', 'b', 'x', 'y']);
  assert.deepEqual(switchQueue(q, 1, ['a', 'b'].map(item)).map((i) => i.id), ['a', 'b', 'c', 'd'], 'nothing new: queue unchanged');
  assert.deepEqual(appendTracks(q, ['d', 'e', 'e'].map(item)).map((i) => i.id), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(sessionHistory(q, 2), ['a', 'b', 'c']);
  assert.deepEqual(sessionHistory(q, -1), []);
});

test('switch acknowledgement', () => {
  assert.equal(switchAck({ id: 's', kind: 'throwbacks', title: 'Back to 2019', reason: 'The songs you had on repeat that year.' }), 'Switching it up. Back to 2019: The songs you had on repeat that year.');
  assert.equal(switchAck({ id: 's', kind: 'mood', title: 'Late night', reason: '' }), 'Switching it up. Late night.');
});

// Make sure the state type is what Now Playing reads.
const _typed: YourDjState | null = null;
void _typed;

test('Home: Your DJ sits below Continue Watching / Next Up, follows Customize Home order and hiding', async () => {
  const { placeYourDj } = await import('../src/player/yourDj');
  const rows = [{ id: 'continue', type: 'continue' }, { id: 'nextup', type: 'nextup' }, { id: 'lib-recent:1', type: 'library-recent' }, { id: 'trending', type: 'trending' }];
  assert.equal(placeYourDj(rows, [], []), 2);
  assert.equal(placeYourDj(rows, [], ['your-dj']), -1);
  assert.equal(placeYourDj(rows, ['continue', 'your-dj', 'nextup', 'lib-recent', 'trending'], []), 1);
  assert.equal(placeYourDj(rows, ['your-dj', 'continue'], []), 0);
  assert.equal(placeYourDj(rows, ['continue', 'nextup', 'lib-recent', 'trending', 'your-dj'], []), 4);
  // Rows missing from the saved order come after it (as the server orders them).
  assert.equal(placeYourDj(rows, ['continue', 'nextup', 'your-dj'], []), 2);
  assert.equal(placeYourDj([], [], []), 0);
});
