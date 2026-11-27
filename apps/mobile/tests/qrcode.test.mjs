// QR encoder used for TV pairing (run: npm test in apps/mobile).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeQr } from '../src/utils/qrcode.ts';

test('a pairing URL encodes to a square matrix with the three finder patterns', () => {
  const m = encodeQr('https://vibe.example.org/pair?c=ABC123&t=0123456789abcdef0123456789abcdef', 'M');
  const n = m.length;
  assert.ok(n >= 21 && (n - 17) % 4 === 0, `size ${n} is a QR version size`);
  assert.ok(m.every((r) => r.length === n));
  // Finder pattern corners: dark 7x7 outer ring at top-left, top-right and bottom-left.
  for (const [y, x] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    assert.equal(m[y][x], true);
    assert.equal(m[y + 6][x + 6], true);
    assert.equal(m[y + 1][x + 1], false, 'white ring');
    assert.equal(m[y + 3][x + 3], true, 'dark centre');
  }
});
