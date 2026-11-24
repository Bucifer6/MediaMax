import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderHomeRows } from '../src/utils/homeRows.ts';

const rows = [
  { id: 'top10', type: 'top10' },
  { id: 'recent:b', type: 'library-recent' },
  { id: 'nextup', type: 'nextup' },
  { id: 'recommended', type: 'recommended' },
  { id: 'recent:a', type: 'library-recent' },
  { id: 'continue', type: 'continue' },
] as const;

test('Continue Watching, Next Up and Recently Added lead Home by default', () => {
  assert.deepEqual(orderHomeRows([...rows], false).map((r) => r.id), ['continue', 'nextup', 'recent:b', 'recent:a', 'top10', 'recommended']);
});

test("a profile's own order is kept as the server sent it", () => {
  assert.deepEqual(orderHomeRows([...rows], true).map((r) => r.id), rows.map((r) => r.id));
});
