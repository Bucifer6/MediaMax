import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { sendFileRange } from '../src/routes/playback.js';
import { byteRange } from '../src/util/byteRange.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-range-'));
const file = path.join(root, 'media.mp4');
fs.writeFileSync(file, '0123456789');
fs.writeFileSync(path.join(root, 'empty.mp4'), '');
const app = Fastify();
app.get('/media', (req, reply) => sendFileRange(req, reply, file, 'video/mp4', 'Film.mp4', [root]));
app.get('/empty', (req, reply) => sendFileRange(req, reply, path.join(root, 'empty.mp4'), 'video/mp4', undefined, [root]));
app.get('/directory', (req, reply) => sendFileRange(req, reply, root, 'video/mp4', undefined, [path.dirname(root)]));
after(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('direct file ranges return exact bytes, lengths and inclusive bounds', async () => {
  for (const [range, body, bounds] of [
    ['bytes=0-0', '0', '0-0'], ['bytes=2-5', '2345', '2-5'],
    ['bytes=7-', '789', '7-9'], ['bytes=-3', '789', '7-9'],
    ['bytes=-20', '0123456789', '0-9'], ['bytes=8-999999999999999999999', '89', '8-9'],
    ['bytes=-999999999999999999999', '0123456789', '0-9'], ['BYTES=1-2', '12', '1-2'],
  ]) {
    const r = await app.inject({ url: '/media', headers: { range } });
    assert.equal(r.statusCode, 206, range);
    assert.equal(r.body, body, range);
    assert.equal(r.headers['content-range'], `bytes ${bounds}/10`);
    assert.equal(r.headers['content-length'], String(body.length));
    assert.match(String(r.headers['content-disposition']), /Film.mp4/);
  }
});

test('malformed and multipart ranges are ignored as a whole, never treated as one partial range', async () => {
  for (const range of ['bytes=-', 'junkbytes=0-1', 'bytes=0-1junk', 'bytes=0-1,4-5', 'items=0-1', 'bytes=5-2']) {
    const r = await app.inject({ url: '/media', headers: { range } });
    assert.equal(r.statusCode, 200, range);
    assert.equal(r.body, '0123456789');
    assert.equal(r.headers['content-range'], undefined);
  }
});

test('valid ranges outside the file return 416 with the representation size', async () => {
  for (const range of ['bytes=10-', 'bytes=999999999999999999999-', 'bytes=-0']) {
    const r = await app.inject({ url: '/media', headers: { range } });
    assert.equal(r.statusCode, 416, range);
    assert.equal(r.headers['content-range'], 'bytes */10');
    assert.equal(r.body, '');
  }
  for (const range of ['bytes=0-', 'bytes=-1']) {
    const r = await app.inject({ url: '/empty', headers: { range } });
    assert.equal(r.statusCode, 416);
    assert.equal(r.headers['content-range'], 'bytes */0');
  }
});

test('HEAD ignores Range and sends full metadata without opening a file stream', async () => {
  const create = fs.createReadStream;
  fs.createReadStream = (() => { throw new Error('HEAD opened a file stream'); }) as typeof create;
  try {
    const r = await app.inject({ method: 'HEAD', url: '/media', headers: { range: 'bytes=0-1' } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['content-length'], '10');
    assert.equal(r.headers['content-range'], undefined);
    assert.equal(r.body, '');
  } finally {
    fs.createReadStream = create;
  }
});

test('If-Range resumes only for the matching modification date', async () => {
  const full = await app.inject('/media');
  const modified = String(full.headers['last-modified']);
  assert.ok(Number.isFinite(Date.parse(modified)));
  for (const validator of [modified, 'Mon, 01 Jan 1990 00:00:00 GMT', 'invalid', '"unknown-etag"', 'W/"unknown"']) {
    const r = await app.inject({ url: '/media', headers: { range: 'bytes=5-', 'if-range': validator } });
    assert.equal(r.statusCode, validator === modified ? 206 : 200, validator);
    assert.equal(r.body, validator === modified ? '56789' : '0123456789');
  }
});

test('empty files and directory paths do not produce invalid file streams', async () => {
  const r = await app.inject('/empty');
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['content-length'], '0');
  assert.equal(r.body, '');
  assert.equal((await app.inject('/directory')).statusCode, 404);
  assert.equal(byteRange('bytes=0-1', Number.MAX_SAFE_INTEGER + 1), null);
});
