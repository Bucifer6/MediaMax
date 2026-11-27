// Artwork and media on a NAS or another PC must never be touched synchronously while serving a request: on a share
// that is asleep or slow, one blocking call held the whole server (every request, stream and the health check) for
// minutes. A home screen requests dozens of posters at once, so the freezes followed every client that opened it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as images from '../src/services/images.js';
import { sendFileRange } from '../src/routes/playback.js';
import { config } from '../src/config.js';
import { db } from '../src/db.js';
import { forgetServableRoots } from '../src/util/servablePaths.js';

const share = fs.mkdtempSync(path.join(os.tmpdir(), 'kinora-share-'));
// The "share" is a library folder, like \NAS\Media\Movies on a real server.
db.run('INSERT INTO libraries (id, name, type, paths, created_at) VALUES (?, ?, ?, ?, ?)', 'nas-lib', 'Movies', 'movies', JSON.stringify([share]), new Date().toISOString());
forgetServableRoots();

/** Make every synchronous fs call on `dir` fail the test while `fn` runs. */
async function withoutSyncFsOn<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const names = ['existsSync', 'statSync', 'lstatSync', 'accessSync', 'copyFileSync', 'readFileSync', 'openSync', 'readdirSync'] as const;
  const real = Object.fromEntries(names.map((n) => [n, (fs as any)[n]]));
  const calls: string[] = [];
  for (const n of names) {
    (fs as any)[n] = (p: unknown, ...rest: unknown[]) => {
      if (typeof p === 'string' && path.resolve(p).startsWith(dir)) calls.push(`${n}(${p})`);
      return real[n](p, ...rest);
    };
  }
  try {
    const r = await fn();
    assert.deepEqual(calls, [], 'no synchronous file access on the share');
    return r;
  } finally {
    for (const n of names) (fs as any)[n] = real[n];
  }
}

test('a poster next to the media is checked and copied without blocking, then served from the data dir', async () => {
  const poster = path.join(share, 'Movie (2024)', 'poster.jpg');
  fs.mkdirSync(path.dirname(poster), { recursive: true });
  fs.writeFileSync(poster, 'jpg');
  const id = images.registerImage(poster)!;
  const r = await withoutSyncFsOn(share, () => images.resolveImage(id));
  assert.ok(r.path.startsWith(config.imageCacheDir), `served from the cache copy: ${r.path}`);
  assert.equal(fs.readFileSync(r.path, 'utf8'), 'jpg');
});

test('missing artwork on the share is a 404, found without blocking', async () => {
  const id = images.registerImage(path.join(share, 'Gone (2020)', 'poster.jpg'))!;
  await withoutSyncFsOn(share, () => assert.rejects(images.resolveImage(id), (e: any) => e.statusCode === 404 && /missing/.test(e.message)));
});

test('a share that does not answer in time gives "unavailable" instead of holding the request; the copy still lands', async () => {
  const poster = path.join(share, 'Slow (2021)', 'folder.jpg');
  fs.mkdirSync(path.dirname(poster), { recursive: true });
  fs.writeFileSync(poster, 'slow-jpg');
  const id = images.registerImage(poster)!;
  // No time at all to answer: the request is told the disk is not responding...
  await assert.rejects(images._localArtwork(id, poster, 0), (e: any) => e.statusCode === 404 && /not responding/.test(e.message));
  // ...while the copy carries on, so the next request is served from the data dir.
  await new Promise((r) => setTimeout(r, 200));
  const r = await images.resolveImage(id);
  assert.ok(r.path.startsWith(config.imageCacheDir), r.path);
});

test('files outside every library and the data folder are never read', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kinora-outside-'));
  const poster = path.join(outside, 'poster.jpg');
  fs.writeFileSync(poster, 'secret');
  const id = images.registerImage(poster)!;
  await assert.rejects(images.resolveImage(id), (e: any) => e.statusCode === 404);
  // A sibling folder whose name merely starts like the library's is outside too.
  const sibling = share + '2';
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, 'poster.jpg'), 'x');
  await assert.rejects(images.resolveImage(images.registerImage(path.join(sibling, 'poster.jpg'))!), (e: any) => e.statusCode === 404);
  const req = { headers: {} } as any;
  const reply = { header: () => reply, status: () => reply, send: () => reply } as any;
  await assert.rejects(sendFileRange(req, reply, poster, 'image/jpeg'), (e: any) => e.statusCode === 404);
  await assert.rejects(sendFileRange(req, reply, path.join(share, '..', path.basename(outside), 'poster.jpg'), 'image/jpeg'), (e: any) => e.statusCode === 404);
  fs.rmSync(outside, { recursive: true, force: true });
  fs.rmSync(sibling, { recursive: true, force: true });
});

test('direct play of a file missing from the share is a 404, without a blocking stat', async () => {
  const missing = path.join(share, 'Movie (2024)', 'movie.mkv');
  const req = { headers: {} } as any;
  const reply = { header: () => reply, status: () => reply, send: () => reply } as any;
  await withoutSyncFsOn(share, () => assert.rejects(sendFileRange(req, reply, missing, 'video/x-matroska'), (e: any) => e.statusCode === 404));
});
