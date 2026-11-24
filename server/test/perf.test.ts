/**
 * Behaviour kept by the performance work (scripts/perf): two-step paged item queries, batched Next Up, response
 * compression, artwork revalidation, and the transcoder's segment bookkeeping.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const { db } = await import('../src/db.ts');
const { config } = await import('../src/config.ts');
const items = await import('../src/services/items.ts');
const { createUser, issueToken } = await import('../src/services/auth.ts');
const { buildApp } = await import('../src/app.ts');
const { TranscodeJob, pollDelay } = await import('../src/services/transcoder.ts');
const { pool, yieldToEventLoop } = await import('../src/util/misc.ts');

const now = new Date().toISOString();
db.insert('libraries', { id: 'plib', name: 'Movies', type: 'movies', paths: '[]', created_at: now });
db.insert('libraries', { id: 'pshows', name: 'Shows', type: 'shows', paths: '[]', created_at: now });
for (let i = 0; i < 30; i++) {
  db.insert('items', {
    id: `pm${i}`, library_id: 'plib', type: 'movie', title: `Film ${String(i).padStart(2, '0')}`, sort_title: `film ${String(i).padStart(2, '0')}`,
    added_at: new Date(Date.parse(now) - i * 60000).toISOString(), updated_at: now, community_rating: (i % 10) + 0.5, content_rating: i % 3 ? 'PG' : 'R',
    genres: JSON.stringify(i % 2 ? ['Drama'] : ['Comedy']), people: JSON.stringify([{ name: i === 7 ? 'Quentin "Q" Doe' : `Actor ${i}`, kind: 'actor' }]),
  });
}
// A show with two seasons of three episodes.
db.insert('items', { id: 'psh', library_id: 'pshows', type: 'show', title: 'Show', sort_title: 'show', added_at: now, updated_at: now });
for (const sn of [1, 2]) {
  db.insert('items', { id: `psh${sn}`, library_id: 'pshows', type: 'season', title: `Season ${sn}`, sort_title: `season ${sn}`, parent_id: 'psh', idx: sn, added_at: now, updated_at: now });
  for (const e of [1, 2, 3]) db.insert('items', { id: `pe${sn}${e}`, library_id: 'pshows', type: 'episode', title: `E${e}`, sort_title: `e${e}`, parent_id: `psh${sn}`, grandparent_id: 'psh', idx: e, parent_idx: sn, added_at: now, updated_at: now });
}
const viewer = await createUser({ username: 'perfviewer', password: 'password123', isAdmin: false });
const kid = await createUser({ username: 'perfkid', password: 'password123', isAdmin: false, maxContentRating: 'PG' } as any);
const token = issueToken(viewer.id, { deviceId: 'perf', deviceName: 'perf', platform: 'web' }).token;

const app = await buildApp();
after(() => app.close());

test('paged browse returns the same pages as one big sorted query', () => {
  const all = items.queryItems(viewer, { libraryId: 'plib', type: 'movie', sort: 'rating', order: 'desc', limit: 500 }).items.map((i) => i.id);
  const paged: string[] = [];
  for (let off = 0; off < 30; off += 7) paged.push(...items.queryItems(viewer, { libraryId: 'plib', type: 'movie', sort: 'rating', order: 'desc', limit: 7, offset: off }).items.map((i) => i.id));
  assert.deepEqual(paged, all);
  assert.equal(all.length, 30);
  const page = items.queryItems(viewer, { libraryId: 'plib', type: 'movie', sort: 'title', limit: 5, offset: 10 });
  assert.equal(page.total, 30);
  assert.deepEqual(page.items.map((i) => i.title), ['Film 10', 'Film 11', 'Film 12', 'Film 13', 'Film 14']);
  // Past the end: empty page, correct total.
  const end = items.queryItems(viewer, { libraryId: 'plib', type: 'movie', limit: 5, offset: 40 });
  assert.deepEqual([end.items.length, end.total], [0, 30]);
  // Parental controls still apply inside a single library.
  const kids = items.queryItems(kid, { libraryId: 'plib', type: 'movie', limit: 500 });
  assert.equal(kids.total, 20);
  assert.ok(kids.items.every((i) => i.contentRating === 'PG'));
});

test('favourite / played filters and the favourites row', () => {
  items.setFavorite(viewer, 'pm3', true);
  items.setPlayed(viewer, 'pm4', true);
  assert.deepEqual(items.queryItems(viewer, { libraryId: 'plib', type: 'movie', favorite: true }).items.map((i) => i.id), ['pm3']);
  assert.deepEqual(items.queryItems(viewer, { libraryId: 'plib', type: 'movie', played: true }).items.map((i) => i.id), ['pm4']);
  assert.equal(items.queryItems(viewer, { libraryId: 'plib', type: 'movie', played: false }).total, 29);
  const fav = items.buildHome(viewer).find((r) => r.type === 'favorites');
  assert.deepEqual(fav?.items.map((i) => i.id), ['pm3']);
});

test('Next Up picks the episode after the furthest watched one, across seasons', () => {
  items.setPlayed(viewer, 'pe11', true);
  items.setPlayed(viewer, 'pe12', true);
  assert.deepEqual(items.nextUp(viewer).map((i) => i.id), ['pe13']);
  items.setPlayed(viewer, 'pe13', true);
  assert.deepEqual(items.nextUp(viewer).map((i) => i.id), ['pe21']);
  // The returned item carries the viewer's data and its show title, like any other list item.
  const [ep] = items.nextUp(viewer);
  assert.equal(ep.grandparentTitle, 'Show');
  assert.equal(ep.userData.played, false);
});

test('search: people match by name, including names with characters JSON escapes', () => {
  assert.deepEqual(items.searchItems(viewer, 'Actor 12').map((i) => i.id), ['pm12']);
  assert.deepEqual(items.searchItems(viewer, '"Q"').map((i) => i.id), ['pm7']);
  assert.deepEqual(items.searchItems(viewer, 'Film 02').map((i) => i.id), ['pm2']);
});

test('JSON responses are compressed for clients that accept it, never for streams', async () => {
  const plain = await app.inject({ method: 'GET', url: '/api/v1/items?libraryId=plib&limit=30', headers: { authorization: `Bearer ${token}` } });
  assert.equal(plain.headers['content-encoding'], undefined);
  const br = await app.inject({ method: 'GET', url: '/api/v1/items?libraryId=plib&limit=30', headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'gzip, br' } });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.match(String(br.headers.vary), /Accept-Encoding/);
  assert.deepEqual(JSON.parse(zlib.brotliDecompressSync(br.rawPayload).toString()), plain.json());
  const gz = await app.inject({ method: 'GET', url: '/api/v1/items?libraryId=plib&limit=30', headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'gzip' } });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.deepEqual(JSON.parse(zlib.gunzipSync(gz.rawPayload).toString()), plain.json());
  // Small bodies are left alone.
  const small = await app.inject({ method: 'GET', url: '/api/v1/items/pm1', headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'br' } });
  assert.equal(small.statusCode, 200);
  assert.equal(small.headers['content-encoding'], undefined);
});

test('artwork: ETag revalidation answers 304 without a body', async () => {
  const file = path.join(config.dataDir, 'perf-poster.png');
  // 1×1 PNG
  fs.writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  db.run('INSERT INTO images (id, source, cached, created_at) VALUES (?, ?, ?, ?)', 'perfimg', file, file, now);
  const first = await app.inject({ method: 'GET', url: '/api/v1/images/perfimg' });
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['content-type'], 'image/png');
  const etag = String(first.headers.etag);
  assert.match(etag, /^W\/".+"$/);
  assert.match(String(first.headers['cache-control']), /max-age=604800/);
  const again = await app.inject({ method: 'GET', url: '/api/v1/images/perfimg', headers: { 'if-none-match': etag } });
  assert.equal(again.statusCode, 304);
  assert.equal(again.rawPayload.length, 0);
  // A changed file gets a new ETag.
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  const changed = await app.inject({ method: 'GET', url: '/api/v1/images/perfimg', headers: { 'if-none-match': etag } });
  assert.equal(changed.statusCode, 200);
});

test('transcoder: latest segment is tracked incrementally; finished VOD segments are served at once', async () => {
  const job = new TranscodeJob('perfjob', { mode: 'transcode', input: '/nonexistent.mkv', startSec: 0, durationSec: 60 } as any);
  fs.mkdirSync(job.dir, { recursive: true });
  try {
    (job as any).startNumber = 0;
    (job as any).latestKnown = -1;
    assert.equal(job.latestSegment(), -1);
    for (const n of [0, 1, 2]) fs.writeFileSync(job.segmentPath(n), 'x');
    assert.equal(job.latestSegment(), 2);
    fs.writeFileSync(job.segmentPath(3), 'x');
    assert.equal(job.latestSegment(), 3);
    // Segment 3 exists and seg 4 doesn't: with temp_file output it is complete, so no wait for seg 4.
    const t = Date.now();
    assert.equal(await job.waitForSegment(3, 2000), job.segmentPath(3));
    assert.ok(Date.now() - t < 500);
  } finally {
    fs.rmSync(job.dir, { recursive: true, force: true });
  }
  assert.equal(pollDelay(0), 40);
  assert.equal(pollDelay(5000), 100);
  assert.equal(pollDelay(20000), 200);
});

test('pool yields to the event loop during long synchronous runs', async () => {
  let timerFired = false;
  setTimeout(() => (timerFired = true), 0);
  let firedDuring = false;
  await pool(Array.from({ length: 400 }, (_, i) => i), 4, async () => {
    const until = Date.now() + 1;
    while (Date.now() < until) { /* busy */ }
    if (timerFired) firedDuring = true;
  });
  assert.ok(firedDuring, 'a timer ran while the pool was still working');
  await yieldToEventLoop(0);
});
