// API client: reads retry after a network failure, writes don't (run: npm test in apps/mobile).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, MediaMaxClient, isNetworkError } from '../src/api/client.ts';

const device = { deviceId: 'd', deviceName: 'Test', platform: 'android', appVersion: '1' };
const client = new MediaMaxClient({ baseUrl: 'http://server.test', token: 't', device });

/** Replace fetch with one that fails `failures` times, then answers `{ ok: true }`. */
function stubFetch(failures) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init?.method });
    if (calls.length <= failures) throw new TypeError('Network request failed');
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  return calls;
}

test('a GET that fails at the network level is retried and then succeeds', async () => {
  const calls = stubFetch(2);
  assert.deepEqual(await client.get('/system/info'), { ok: true });
  assert.equal(calls.length, 3);
});

test('a GET still failing after the retries reports a network error', async () => {
  const calls = stubFetch(10);
  await assert.rejects(client.get('/system/info'), (e) => isNetworkError(e) && e instanceof ApiError);
  assert.equal(calls.length, 3);
});

test('a POST is not retried (it may have reached the server)', async () => {
  const calls = stubFetch(1);
  await assert.rejects(client.post('/playback/x', {}), (e) => isNetworkError(e));
  assert.equal(calls.length, 1);
});

test('aborting stops the retries', async () => {
  const calls = stubFetch(10);
  const ctrl = new AbortController();
  const pending = client.get('/system/info', undefined, ctrl.signal);
  setTimeout(() => ctrl.abort(), 100);
  await assert.rejects(pending);
  assert.equal(calls.length, 1);
});
