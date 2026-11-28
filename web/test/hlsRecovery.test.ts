import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hlsRecovery } from '../src/player/hlsRecovery.ts';

function fixture() {
  const calls: string[] = [];
  const recovery = hlsRecovery({ media: () => calls.push('media'), network: () => calls.push('load'), fatal: (s) => calls.push(s) });
  return { calls, recovery };
}

test('closing the player cancels a queued network retry and ignores later errors', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { calls, recovery } = fixture();
  recovery.error('networkError', 'network');
  recovery.destroy();
  t.mock.timers.tick(10_000);
  recovery.error('mediaError', 'media');
  assert.deepEqual(calls, []);
});

test('network retries back off, coalesce duplicate errors and stop after three attempts', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { calls, recovery } = fixture();
  for (let n = 1; n <= 3; n++) {
    recovery.error('networkError', 'offline');
    recovery.error('networkError', 'duplicate');
    t.mock.timers.tick(n * 1000 - 1);
    assert.equal(calls.length, n - 1);
    t.mock.timers.tick(1);
    assert.equal(calls.length, n);
  }
  recovery.error('networkError', 'offline');
  recovery.error('networkError', 'duplicate');
  t.mock.timers.tick(30_000);
  assert.deepEqual(calls, ['load', 'load', 'load', 'offline']);
});

test('media recovery remains bounded and terminal errors cancel pending loads', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { calls, recovery } = fixture();
  recovery.error('mediaError', 'decode');
  recovery.error('mediaError', 'decode');
  recovery.error('mediaError', 'decode');
  recovery.error('mediaError', 'again');
  assert.deepEqual(calls, ['media', 'media', 'decode']);
  const other = fixture();
  other.recovery.error('networkError', 'offline');
  other.recovery.error('otherError', 'fatal');
  t.mock.timers.tick(10_000);
  assert.deepEqual(other.calls, ['fatal']);
});

test('mixed failures share the existing total retry budget', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { calls, recovery } = fixture();
  recovery.error('mediaError', 'decode');
  recovery.error('networkError', 'offline');
  t.mock.timers.tick(2000);
  recovery.error('mediaError', 'decode');
  assert.deepEqual(calls, ['media', 'load', 'decode']);
});
