// The folder picker's ".." target (run: npm test -w web).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parentOf } from '../src/utils/paths.ts';

test('parentOf walks up POSIX and Windows paths to the top level', () => {
  assert.equal(parentOf(''), null);
  assert.equal(parentOf('/'), null);
  assert.equal(parentOf('/media/movies'), '/media');
  assert.equal(parentOf('/media'), '/');
  assert.equal(parentOf('D:\\'), '', 'a drive goes up to the drive list');
  assert.equal(parentOf('D:\\Movies'), 'D:');
  assert.equal(parentOf('D:\\Movies\\Action'), 'D:\\Movies');
});

test('parentOf goes from a network share back to the drive list, never to the bare server', () => {
  assert.equal(parentOf('\\\\nas\\media\\Movies\\2024'), '\\\\nas\\media\\Movies');
  assert.equal(parentOf('\\\\nas\\media\\Movies'), '\\\\nas\\media');
  assert.equal(parentOf('\\\\nas\\media'), '');
  assert.equal(parentOf('\\\\nas\\media\\'), '');
});
