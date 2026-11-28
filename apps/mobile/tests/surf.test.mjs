// Live TV channel surfing (run: npm test in apps/mobile).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelLabel, matchNumber, stepChannel, surfList } from '../src/player/surf.ts';

const ch = (id, number, extra = {}) => ({ id, number, name: `Ch ${id}`, ...extra });
const all = [ch('a', 1), ch('b', 2, { favorite: true }), ch('c', 3), ch('r1', 50, { radio: true }), ch('r2', 51, { radio: true, favorite: true }), ch('d', 4, { favorite: true })];

test('surfing stays on TV or on radio, whichever is on', () => {
  assert.deepEqual(surfList(all, all[0], false).map((c) => c.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(surfList(all, all[3], false).map((c) => c.id), ['r1', 'r2']);
  assert.deepEqual(surfList(all, null, false).map((c) => c.id), ['a', 'b', 'c', 'd'], 'nothing known yet: TV');
});

test('favourites only: favourites plus the channel that is on; all channels when there are no favourites', () => {
  assert.deepEqual(surfList(all, all[0], true).map((c) => c.id), ['a', 'b', 'd']);
  assert.deepEqual(surfList(all, all[1], true).map((c) => c.id), ['b', 'd']);
  const noFavs = all.map((c) => ({ ...c, favorite: false }));
  assert.equal(surfList(noFavs, noFavs[0], true).length, 4);
});

test('stepping wraps around and starts at an end from an unknown channel', () => {
  const list = surfList(all, all[0], false);
  assert.equal(stepChannel(list, 'a', 1)?.id, 'b');
  assert.equal(stepChannel(list, 'a', -1)?.id, 'd');
  assert.equal(stepChannel(list, 'd', 1)?.id, 'a');
  assert.equal(stepChannel(list, 'zzz', 1)?.id, 'a');
  assert.equal(stepChannel(list, 'zzz', -1)?.id, 'd');
  assert.equal(stepChannel([], 'a', 1), null);
});

test('number entry previews the channel you are heading for', () => {
  const list = [ch('one', 1), ch('ten', 10), ch('twelve', 12), ch('hundred', 105)];
  assert.deepEqual(matchNumber(list, '1'), { exact: list[0], preview: list[0] });
  assert.deepEqual(matchNumber(list, '10'), { exact: list[1], preview: list[1] });
  assert.deepEqual(matchNumber(list, '105'), { exact: list[3], preview: list[3] });
  assert.deepEqual(matchNumber([ch('ten', 10), ch('twelve', 12)], '1'), { exact: null, preview: list[1] });
  assert.deepEqual(matchNumber(list, '9'), { exact: null, preview: null });
  assert.equal(channelLabel({ number: 12, name: 'Pro TV' }), '12 · Pro TV');
  assert.equal(channelLabel({ number: null, name: 'Kiss FM' }), 'Kiss FM');
});
