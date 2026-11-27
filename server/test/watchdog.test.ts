import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { inflightSummary, startWatchdog, trackRequests } from '../src/util/watchdog.js';
import { readId3Extras } from '../src/services/music/tags.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('requests in progress are listed (path only, no query) and forgotten when they finish', async () => {
  const app = Fastify();
  trackRequests(app);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  app.get('/slow', async () => {
    await held;
    return { ok: true };
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as { port: number }).port;
  const pending = fetch(`http://127.0.0.1:${port}/slow?token=secret`);
  await sleep(100);
  const during = inflightSummary();
  assert.match(during, /^GET \/slow \(\d+\.\d s\)$/);
  assert.doesNotMatch(during, /secret/);
  release();
  assert.equal((await pending).status, 200);
  await sleep(50);
  assert.equal(inflightSummary(), 'none');
  await app.close();
});

test('a blocked main thread is reported in the log file by the watchdog thread while it is still blocked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinora-watchdog-'));
  const file = path.join(dir, 'mediamax.log');
  startWatchdog(dir, 600);
  await sleep(1200); // worker up, first heartbeats sent
  // Block the event loop (a named function, so the captured stack can be checked).
  function blockMainThreadForTest(ms: number) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* busy */
    }
  }
  blockMainThreadForTest(4000);
  // The report is written during the stall, not after it: check before yielding to the event loop again.
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  assert.match(text, /watchdog: Main thread stack: blockMainThreadForTest \(watchdog\.test\.ts:\d+\)/, text);
  assert.match(text, /watchdog: The server has not responded for \d+ s \(main thread blocked\)\. Last known memory: heap \d+ MB of \d+ MB, process \d+ MB\. Requests in progress: none/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readId3Extras is asynchronous and never throws on a missing file', async () => {
  const r = readId3Extras(path.join(os.tmpdir(), 'kinora-no-such-file.mp3'));
  assert.ok(r instanceof Promise, 'a synchronous read on a network share would block the whole server');
  assert.deepEqual(await r, {});
});
