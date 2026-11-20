// The post-sign-in ?next= target stays inside the app (run: npm test -w web).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeNext } from '../src/utils/safeNext.ts';

test('safeNext keeps in-app paths', () => {
  assert.equal(safeNext('/'), '/');
  assert.equal(safeNext('/item/abc?tab=cast#x'), '/item/abc?tab=cast#x');
  assert.equal(safeNext('/search?q=a%2F%2Fb'), '/search?q=a%2F%2Fb');
});

test('safeNext rejects off-site and script targets', () => {
  for (const bad of [null, undefined, '', 'https://evil.example/', '//evil.example', '/\\evil.example', '\\\\evil.example', 'javascript:alert(1)', '/\t/evil.example', 'item/abc']) {
    assert.equal(safeNext(bad as string), '/', String(bad));
  }
});
