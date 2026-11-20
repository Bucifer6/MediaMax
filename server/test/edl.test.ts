import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEdl } from '../src/util/edl.js';

test('parseEdl keeps cut/commercial segments and ignores mute/scene', () => {
  const m = parseEdl('12.5\t95.04\t3\n100 105 1\n# comment\n300.0 420.5 0\n500 500.2 3\n700 760\n');
  assert.deepEqual(m, [
    { type: 'commercial', startMs: 12500, endMs: 95040 },
    { type: 'commercial', startMs: 300000, endMs: 420500 },
    { type: 'commercial', startMs: 700000, endMs: 760000 },
  ]);
});

test('parseEdl tolerates CRLF and junk', () => {
  assert.deepEqual(parseEdl('garbage\r\n1 3 3\r\n'), [{ type: 'commercial', startMs: 1000, endMs: 3000 }]);
});
