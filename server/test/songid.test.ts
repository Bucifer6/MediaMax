// "What's this song?": the server-side pipeline (ffmpeg cuts ~12 s around the position → fpcalc → AcoustID lookup →
// your music library), its cache and rate limit, the microphone fallback, and the paired-TV route. ffmpeg, fpcalc
// and AcoustID are local stand-ins; no real network calls.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-songid-'));
const ARGS_LOG = path.join(TMP, 'ffmpeg-args.log');
// Stand-in ffmpeg: logs its arguments and writes a WAV-sized file to the output path (the last argument).
const ffmpeg = path.join(TMP, 'ffmpeg');
fs.writeFileSync(ffmpeg, `#!/bin/sh\necho "$@" >> "${ARGS_LOG}"\nfor last; do :; done\nhead -c 4096 /dev/zero > "$last"\n`, { mode: 0o755 });
// Stand-in fpcalc.
const fpcalc = path.join(TMP, 'fpcalc');
fs.writeFileSync(fpcalc, '#!/bin/sh\nif [ "$1" = "-version" ]; then echo "fpcalc version 1.5.1"; exit 0; fi\necho \'{"duration": 12.0, "fingerprint": "AQADtSnippet"}\'\n', { mode: 0o755 });
process.env.MEDIAMAX_FPCALC = fpcalc;

const { db } = await import('../src/db.ts');
const { config } = await import('../src/config.ts');
(config as { ffmpeg: string }).ffmpeg = ffmpeg;
const { createUser, issueToken, authenticate } = await import('../src/services/auth.ts');
const { updateMusicSettings } = await import('../src/services/music/settings.ts');
const { setProviderHttpOptions } = await import('../src/services/metadata/http.ts');
const acoustid = await import('../src/services/music/acoustid.ts');
const songid = await import('../src/services/songid.ts');
const { buildApp } = await import('../src/app.ts');

const REC = '11111111-1111-4111-8111-111111111111';
const RG = '22222222-2222-4222-8222-222222222222';
const ART = '33333333-3333-4333-8333-333333333333';
let lookups: URLSearchParams[] = [];
const mock = http.createServer((req, res) => {
  const u = new URL(req.url!, 'http://x');
  if (u.pathname === '/acoustid/v2/lookup') {
    lookups.push(u.searchParams);
    const fp = u.searchParams.get('fingerprint');
    const results = fp === 'AQADtSnippet'
      ? [{ id: '44444444-4444-4444-8444-444444444444', score: 0.91, recordings: [{ id: REC, title: 'Song In The Film', duration: 201, artists: [{ id: ART, name: 'The Band' }], releasegroups: [{ id: RG, title: 'Soundtrack', type: 'Album' }] }] }]
      : [];
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', results }));
    return;
  }
  res.writeHead(404).end();
});
mock.listen(0, '127.0.0.1');
await new Promise((r) => mock.once('listening', r));
setProviderHttpOptions('acoustid', { base: `http://127.0.0.1:${(mock.address() as AddressInfo).port}/acoustid`, minIntervalMs: 0 });
after(() => mock.close());

const viewer = await createUser({ username: 'song-viewer', password: 'pw-123456' });
const tok = issueToken(viewer.id, { deviceId: 'song-phone', deviceName: 'Phone', platform: 'web' }).token;
const now = new Date().toISOString();
const movieFile = path.join(TMP, 'Film.2020.mkv');
fs.writeFileSync(movieFile, 'not really a film');
db.run("INSERT INTO libraries (id, name, type, paths, fetch_metadata, created_at) VALUES ('s-movies', 'Movies', 'movies', '[]', 0, ?), ('s-music', 'Music', 'music', '[]', 0, ?)", now, now);
db.insert('items', { id: 's-film', library_id: 's-movies', type: 'movie', title: 'Film', sort_title: 'film', duration_ms: 6_000_000, added_at: now, updated_at: now });
db.insert('media', { id: 's-film-m', item_id: 's-film', path: movieFile, duration_ms: 6_000_000 });
db.insert('items', { id: 's-art', library_id: 's-music', type: 'artist', title: 'The Band', sort_title: 'band', added_at: now, updated_at: now });
db.insert('items', { id: 's-alb', library_id: 's-music', type: 'album', title: 'Soundtrack', sort_title: 'soundtrack', parent_id: 's-art', poster: 'albumart', added_at: now, updated_at: now });
db.insert('items', { id: 's-trk', library_id: 's-music', type: 'track', title: 'Song In The Film', sort_title: 'song', parent_id: 's-alb', grandparent_id: 's-art',
  external_ids: JSON.stringify({ musicbrainzRecording: REC }), added_at: now, updated_at: now });

test('not set up: a clear reason, no work done', async () => {
  updateMusicSettings({ acoustid: { apiKey: '', autoIdentify: false, autoApplyScore: 0 } });
  await acoustid.detectFingerprinter(true);
  const r = await songid.identifyAt(viewer, viewer, 's-film', 60_000);
  assert.equal(r.available, false);
  assert.match(r.reason!, /AcoustID/);
  assert.equal(fs.existsSync(ARGS_LOG), false);
  updateMusicSettings({ acoustid: { apiKey: 'song-key', autoIdentify: false, autoApplyScore: 0 } });
});

test('file pipeline: 12 s centred on the position, selected audio track, AcoustID lookup, library match, cache', async () => {
  const r = await songid.identifyAt(viewer, viewer, 's-film', 3_600_000, 2);
  assert.equal(r.available, true, r.reason ?? '');
  assert.equal(r.source, 'file');
  assert.equal(r.cached, false);
  const args = fs.readFileSync(ARGS_LOG, 'utf8').trim().split('\n').at(-1)!.split(' ');
  assert.equal(args[args.indexOf('-ss') + 1], '3594.000', 'starts 6 s before the position');
  assert.equal(args[args.indexOf('-t') + 1], '12.000');
  assert.equal(args[args.indexOf('-i') + 1], movieFile);
  assert.equal(args[args.indexOf('-map') + 1], '0:2', 'the audio track the TV is playing');
  const q = lookups.at(-1)!;
  assert.equal(q.get('client'), 'song-key');
  assert.equal(q.get('fingerprint'), 'AQADtSnippet');
  assert.equal(q.get('duration'), '12');
  assert.deepEqual(r.match && { title: r.match.title, artists: r.match.artists, album: r.match.album, mbid: r.match.recordingMbid }, { title: 'Song In The Film', artists: ['The Band'], album: 'Soundtrack', mbid: REC });
  assert.equal(r.match!.libraryTrack?.id, 's-trk');
  assert.equal(r.match!.libraryTrack?.albumId, 's-alb');
  assert.equal(r.match!.coverUrl, '/api/v1/images/albumart', 'your library’s album art first');
  // Same title, same moment: cached (no second ffmpeg run).
  const runs = fs.readFileSync(ARGS_LOG, 'utf8').trim().split('\n').length;
  const again = await songid.identifyAt(viewer, viewer, 's-film', 3_605_000, 2);
  assert.equal(again.cached, true);
  assert.equal(fs.readFileSync(ARGS_LOG, 'utf8').trim().split('\n').length, runs);
  // Near the start the snippet starts at 0; no temp files are left behind.
  await songid.identifyAt(viewer, viewer, 's-film', 1000);
  const a2 = fs.readFileSync(ARGS_LOG, 'utf8').trim().split('\n').at(-1)!.split(' ');
  assert.equal(a2[a2.indexOf('-ss') + 1], '0.000');
  assert.equal(a2[a2.indexOf('-map') + 1], '0:a:0');
  assert.equal(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(`mm-songid-${process.pid}-`)).length, 0);
});

test('library match falls back to title + artist; no match leaves libraryTrack empty and uses Cover Art Archive', async () => {
  assert.equal(songid.libraryMatch(viewer, { recordingMbid: null, title: 'song in the film', artists: [{ name: 'the band', mbid: null, joinPhrase: '' }] })?.id, 's-trk');
  assert.equal(songid.libraryMatch(viewer, { recordingMbid: null, title: 'Song In The Film', artists: [{ name: 'Someone Else', mbid: null, joinPhrase: '' }] }), null);
  // A user without access to the music library gets no library match.
  const kid = await createUser({ username: 'song-kid', password: 'pw-123456' });
  db.run('UPDATE users SET library_ids = ? WHERE id = ?', JSON.stringify(['s-movies']), kid.id);
  const k = authenticate(issueToken(kid.id, { deviceId: 'kid' }).token)!.user;
  assert.equal(songid.libraryMatch(k, { recordingMbid: REC, title: 'Song In The Film', artists: [] }), null);
});

test('access, missing file, rate limit', async () => {
  const kid = await createUser({ username: 'song-kid2', password: 'pw-123456' });
  db.run('UPDATE users SET library_ids = ? WHERE id = ?', JSON.stringify(['s-music']), kid.id);
  const k = authenticate(issueToken(kid.id, { deviceId: 'kid2' }).token)!.user;
  await assert.rejects(songid.identifyAt(k, k, 's-film', 0), /not found/i);
  db.insert('items', { id: 's-remote', library_id: 's-movies', type: 'movie', title: 'Remote', sort_title: 'remote', added_at: now, updated_at: now });
  const nofile = await songid.identifyAt(viewer, viewer, 's-remote', 0);
  assert.equal(nofile.available, false);
  assert.match(nofile.reason!, /microphone/);
  songid._resetSongId();
  const per = songid.SONG_ID.perMinute;
  songid.SONG_ID.perMinute = 2;
  await songid.identifyAt(viewer, viewer, 's-film', 100_000);
  await songid.identifyAt(viewer, viewer, 's-film', 200_000);
  await assert.rejects(songid.identifyAt(viewer, viewer, 's-film', 300_000), /Too many/);
  songid.SONG_ID.perMinute = per;
  songid._resetSongId();
});

test('microphone fallback and HTTP routes', async () => {
  const app = await buildApp();
  after(() => app.close());
  const boundary = 'xxBOUNDARYxx';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="rec.webm"\r\nContent-Type: audio/webm\r\n\r\n`),
    Buffer.alloc(20_000, 1),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const mic = await app.inject({ method: 'POST', url: '/api/v1/songid/clip', headers: { authorization: `Bearer ${tok}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
  assert.equal(mic.statusCode, 200, mic.body);
  assert.equal(mic.json().source, 'microphone');
  assert.equal(mic.json().match.title, 'Song In The Film');
  const own = await app.inject({ method: 'POST', url: '/api/v1/songid/items/s-film', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, payload: { positionMs: 900_000 } });
  assert.equal(own.statusCode, 200, own.body);
  assert.equal(own.json().positionMs, 900_000);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/songid/items/s-film', payload: {} })).statusCode, 401);
  // A TV that isn't yours and isn't paired: refused.
  const other = await createUser({ username: 'song-tvowner', password: 'pw-123456' });
  const tvRow = authenticate(issueToken(other.id, { deviceId: 'song-tv' }).token)!.deviceRowId;
  const r = await app.inject({ method: 'POST', url: `/api/v1/pair/targets/${tvRow}/identify-song`, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, payload: {} });
  assert.equal(r.statusCode, 403);
});
