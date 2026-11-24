// MusicBrainz / ListenBrainz / AcoustID: Picard tags read from real files (ffmpeg-generated FLAC, MP3, M4A), MBID-first
// grouping, recording fill from a release, multi-artist credits, ListenBrainz listens + offline queue + recommendations,
// AcoustID identification, OpenSubsonic fields, discography / missing albums / related artists and Lidarr requests.
// Every external service is a local mock; no real network calls.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { ArrInstance, User } from '@mediamax/shared';

process.env.MEDIAMAX_DATA ??= path.join(os.tmpdir(), `mediamax-mb-${process.pid}`);
delete process.env.TMDB_API_KEY;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-mbtest-'));

const { db } = await import('../src/db.ts');
const { config } = await import('../src/config.ts');
const { probe } = await import('../src/services/probe.ts');
const tags = await import('../src/services/music/tags.ts');
const credits = await import('../src/services/music/credits.ts');
const mbsvc = await import('../src/services/music/musicbrainz.ts');
const acoustid = await import('../src/services/music/acoustid.ts');
const { updateMusicSettings } = await import('../src/services/music/settings.ts');
const lb = await import('../src/services/listenbrainz.ts');
const scrobble = await import('../src/services/scrobble.ts');
const { setProviderHttpOptions } = await import('../src/services/metadata/http.ts');
const { updateMetadataSettings } = await import('../src/services/metadata/config.ts');
const builtin = await import('../src/services/metadata/builtin.ts');
const { scanLibrary } = await import('../src/services/scanner.ts');
const { stableId } = await import('../src/util/ids.ts');
const items = await import('../src/services/items.ts');
const auth = await import('../src/services/auth.ts');
const settings = await import('../src/services/settings.ts');
const requests = await import('../src/services/requests.ts');
const { buildApp } = await import('../src/app.ts');

/* --------------------------------- mock services -------------------------------- */

interface Hit { method: string; path: string; body: any; headers: http.IncomingHttpHeaders }
const hits: Hit[] = [];
type Reply = { status?: number; json?: unknown; headers?: Record<string, string> };
let lbMode: 'ok' | 'down' | 'ratelimit' = 'ok';
const R = (n: string) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n.repeat(12)}`;
const ID = {
  nirvana1: R('1'), nirvana2: R('2'), beyonce: R('3'), adele: R('4'), rel21: R('5'), rel21dlx: R('6'), relBleach: R('7'), recA: R('8'), artA: R('9'), artB: R('a'),
  rg25: R('5').replace(/^5/, 'b'), rg21: R('b'), relFill: R('c'), rgFill: R('d'), rec1: R('e'), rec2: R('f'),
};
const REL_FILL = {
  id: ID.relFill, title: 'Fill Album', status: 'Official', barcode: '0123456789012',
  'label-info': [{ 'catalog-number': 'CAT-1', label: { name: 'Fill Records' } }],
  'release-group': { id: ID.rgFill, title: 'Fill Album', 'primary-type': 'Album', 'secondary-types': ['Live'], 'first-release-date': '1997-06-16' },
  media: [{
    position: 1, tracks: [
      { id: R('0').replace(/^0/, '1a'.slice(0, 1)), position: 1, number: '1', title: 'Opening', length: 200000, recording: { id: ID.rec1, title: 'Opening', length: 200000 }, 'artist-credit': [{ name: 'Fill Artist', joinphrase: ' feat. ', artist: { id: ID.artA, name: 'Fill Artist' } }, { name: 'Guest', joinphrase: '', artist: { id: ID.artB, name: 'Guest' } }] },
      { id: R('1').replace(/^1/, '2'), position: 2, number: '2', title: 'Second Song', length: 180000, recording: { id: ID.rec2, title: 'Second Song', length: 180000 }, 'artist-credit': [{ name: 'Fill Artist', joinphrase: '', artist: { id: ID.artA, name: 'Fill Artist' } }] },
      { id: R('2').replace(/^2/, '3'), position: 3, number: '3', title: 'Third', length: 100000, recording: { id: R('9').replace(/^9/, 'a'), title: 'Third', length: 100000 } },
    ],
  }],
};
const REL_GROUPS = Array.from({ length: 130 }, (_, i) => ({ id: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`, title: `Filler ${i}`, 'primary-type': 'Single', 'secondary-types': [], 'first-release-date': `19${String(i % 90 + 10)}-01-01` }));
const DISCO = [
  { id: ID.rg21, title: '21', 'primary-type': 'Album', 'secondary-types': [], 'first-release-date': '2011-01-24' },
  { id: R('5').replace(/^5/, 'b'), title: '25', 'primary-type': 'Album', 'secondary-types': [], 'first-release-date': '2015-11-20' },
  { id: R('6').replace(/^6/, 'c'), title: '19', 'primary-type': 'Album', 'secondary-types': [], 'first-release-date': '2008-01-28' },
  { id: R('7').replace(/^7/, 'd'), title: 'Live at the Royal Albert Hall', 'primary-type': 'Album', 'secondary-types': ['Live'], 'first-release-date': '2011-11-28' },
  { id: R('8').replace(/^8/, 'e'), title: 'Hello', 'primary-type': 'Single', 'secondary-types': [], 'first-release-date': '2015-10-23' },
  { id: R('9').replace(/^9/, 'f'), title: 'Remixes EP', 'primary-type': 'EP', 'secondary-types': [], 'first-release-date': '2012-01-01' },
];

function route(method: string, p: string, q: URLSearchParams, body: any, headers: http.IncomingHttpHeaders): Reply {
  /* MusicBrainz */
  if (p.startsWith('/mb/ws/2/')) {
    const m = p.slice('/mb/ws/2'.length);
    if (m === `/release/${ID.relFill}`) return { json: REL_FILL };
    if (m === `/release-group/${ID.rgFill}`) return { json: { ...REL_FILL['release-group'], genres: [{ name: 'rock', count: 3 }] } };
    if (m === '/release-group' && q.get('artist') === ID.adele) {
      const off = Number(q.get('offset') ?? 0);
      const all = [...DISCO, ...REL_GROUPS];
      return { json: { 'release-group-count': all.length, 'release-group-offset': off, 'release-groups': all.slice(off, off + Number(q.get('limit') ?? 25)) } };
    }
    if (m === `/artist/${ID.nirvana1}`) {
      return { json: { id: ID.nirvana1, name: 'Nirvana', relations: [
        { type: 'member of band', direction: 'backward', 'target-type': 'artist', begin: '1987', end: '1994', ended: true, attributes: ['lead vocals', 'guitar'], artist: { id: R('0'), name: 'Kurt Cobain' } },
        { type: 'member of band', direction: 'backward', 'target-type': 'artist', begin: '1990', end: '1994', ended: true, attributes: ['drums (drum set)'], artist: { id: ID.beyonce, name: 'Beyonce' } },
        { type: 'collaboration', direction: 'forward', 'target-type': 'artist', artist: { id: R('d'), name: 'Some Collab' } },
        { type: 'tribute', direction: 'backward', 'target-type': 'artist', artist: { id: R('e'), name: 'Tribute Band' } },
        { type: 'member of band', direction: 'forward', 'target-type': 'artist', artist: { id: R('f'), name: 'Supergroup' } },
        { type: 'involved with', direction: 'forward', 'target-type': 'url', url: { resource: 'https://x' } },
      ] } };
    }
    return { status: 404, json: { error: 'Not Found' } };
  }
  if (p.startsWith('/labs/similar-artists/json')) {
    return { json: [{ artist_mbid: ID.nirvana1, name: 'Nirvana', score: 999 }, { artist_mbid: ID.adele, name: 'Adele', score: 50 }, { artist_mbid: R('c'), name: 'Pixies', score: 80 }] };
  }
  /* ListenBrainz */
  if (p.startsWith('/lb/')) {
    if (lbMode === 'down') return { status: 503, json: { code: 503, error: 'down' } };
    if (lbMode === 'ratelimit') return { status: 429, json: { code: 429, error: 'rate limited' }, headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-In': '1', 'X-RateLimit-Limit': '30' } };
    const rl = { 'X-RateLimit-Remaining': '29', 'X-RateLimit-Reset-In': '10', 'X-RateLimit-Limit': '30' };
    if (String(headers.authorization) !== 'Token good-token') return { status: 401, json: { code: 401, error: 'Invalid authorization token.' } };
    const m = p.slice(3);
    if (m === '/1/validate-token') return { json: { code: 200, valid: true, user_name: 'lbuser' }, headers: rl };
    if (m === '/1/submit-listens' && method === 'POST') return { json: { status: 'ok' }, headers: rl };
    if (m === '/1/feedback/recording-feedback') return { json: { status: 'ok' }, headers: rl };
    if (m === '/1/user/lbuser/playlists/createdfor') {
      const pl = (id: string, title: string, patch: string) => ({ playlist: { identifier: `https://listenbrainz.org/playlist/${id}`, title, extension: { 'https://musicbrainz.org/doc/jspf#playlist': { additional_metadata: { algorithm_metadata: { source_patch: patch } } } } } });
      return { json: { playlists: [pl('pl-jams', 'Weekly Jams for lbuser, week of 2026-11-16', 'weekly-jams'), pl('pl-explore', 'Weekly Exploration for lbuser', 'weekly-exploration'), pl('pl-old', 'Weekly Jams (older)', 'weekly-jams')] } };
    }
    if (m === '/1/playlist/pl-jams') {
      return { json: { playlist: { title: 'Weekly Jams for lbuser', track: [
        { identifier: [`https://musicbrainz.org/recording/${ID.recA}`], title: 'Duet', creator: 'Artist A feat. Artist B', album: 'Feat Album', extension: { 'https://musicbrainz.org/doc/jspf#track': { artist_identifiers: [`https://musicbrainz.org/artist/${ID.artA}`] } } },
        { identifier: 'https://musicbrainz.org/recording/00000000-1111-4111-8111-000000000000', title: 'Day Song', creator: 'Queen', album: null },
        { identifier: 'https://musicbrainz.org/recording/00000000-2222-4222-8222-000000000000', title: 'Not In Library', creator: 'Stranger', extension: { 'https://musicbrainz.org/doc/jspf#track': { artist_identifiers: ['https://musicbrainz.org/artist/00000000-3333-4333-8333-000000000000'] } } },
      ] } } };
    }
    if (m === '/1/playlist/pl-explore') return { json: { playlist: { title: 'Weekly Exploration for lbuser', track: [] } } };
    if (m === '/1/cf/recommendation/user/lbuser/recording') return { json: { payload: { mbids: [{ recording_mbid: ID.recA, score: 1.2 }, { recording_mbid: '00000000-4444-4444-8444-000000000000', score: 0.9 }] } } };
    if (m === '/1/metadata/recording/') return { json: { [ID.recA]: { recording: { name: 'Duet' }, artist: { name: 'Artist A feat. Artist B', artists: [{ artist_mbid: ID.artA }] } }, '00000000-4444-4444-8444-000000000000': { recording: { name: 'Unknown Gem' }, artist: { name: 'Nobody' } } } };
    return { status: 404, json: { error: 'nope' } };
  }
  /* AcoustID */
  if (p === '/acoustid/v2/lookup') {
    if (q.get('client') !== 'acoustid-key') return { json: { status: 'error', error: { code: 4, message: 'invalid API key' } } };
    return { json: { status: 'ok', results: [
      { id: R('1').replace(/^1/, '9'), score: 0.62, recordings: [{ id: R('2').replace(/^2/, '9'), title: 'Maybe', artists: [{ id: ID.artB, name: 'Other' }] }] },
      { id: R('3').replace(/^3/, '9'), score: 0.97, recordings: [{ id: ID.recA, title: 'Identified Song', duration: 2, artists: [{ id: ID.artA, name: 'Queen', joinphrase: ' & ' }, { id: ID.artB, name: 'ABBA' }], releasegroups: [{ id: ID.rg21, title: 'Hits', type: 'Album' }] }] },
      { id: R('4').replace(/^4/, '9'), score: 0.5 },
    ] } };
  }
  /* Lidarr */
  if (p.startsWith('/lidarr/api/v1')) {
    const m = p.slice('/lidarr/api/v1'.length);
    if (m === '/qualityprofile') return { json: [{ id: 1, name: 'Lossless' }] };
    if (m === '/metadataprofile') return { json: [{ id: 1, name: 'None' }, { id: 2, name: 'Standard' }] };
    if (m === '/rootfolder') return { json: [{ path: '/music', freeSpace: 1 }] };
    if (m === '/tag') return { json: [] };
    if (m === '/album/lookup') {
      const term = q.get('term') ?? '';
      return { json: term === `lidarr:${ID.rg25}` ? [{ title: '25', foreignAlbumId: ID.rg25, releaseDate: '2015-11-20T00:00:00Z', artist: { artistName: 'Adele', foreignArtistId: ID.adele } }] : [] };
    }
    if (m === '/album' && method === 'POST') return { status: 201, json: { ...body, id: 70 } };
    if (m === '/command') return { status: 201, json: { id: 1 } };
    if (m === '/queue') return { json: { records: [] } };
    return { status: 404, json: { message: 'NotFound' } };
  }
  return { status: 404, json: {} };
}

let server: http.Server;
let base = '';
before(async () => {
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://x');
      const body = data ? (() => { try { return JSON.parse(data); } catch { return data; } })() : null;
      hits.push({ method: req.method ?? 'GET', path: u.pathname + u.search, body, headers: req.headers });
      const r = route(req.method ?? 'GET', u.pathname, u.searchParams, body, req.headers);
      res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json', ...(r.headers ?? {}) });
      res.end(r.json === undefined ? '' : JSON.stringify(r.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const [id, p] of Object.entries({ musicbrainz: '/mb/ws/2', coverart: '/caa', listenbrainz: '/lb', listenbrainzLabs: '/labs', acoustid: '/acoustid' })) setProviderHttpOptions(id, { base: base + p, minIntervalMs: 0 });
  updateMetadataSettings({ providers: { musicbrainz: { enabled: true, apiKey: null } } as any });
});
after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const hitsFor = (prefix: string) => hits.filter((h) => h.path.startsWith(prefix));
const now = () => new Date().toISOString();
function item(fields: Record<string, unknown>) {
  db.insert('items', { sort_title: String(fields.title).toLowerCase(), added_at: now(), updated_at: now(), ...fields });
  return fields.id as string;
}
const row = (id: string) => db.get('SELECT * FROM items WHERE id = ?', id)!;

/** A one-second tone with the given tags. */
function audio(file: string, meta: Record<string, string>, extra: string[] = [], seconds = 1) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=d=${seconds}`];
  for (const [k, v] of Object.entries(meta)) args.push('-metadata', `${k}=${v}`);
  const r = spawnSync(config.ffmpeg, [...args, ...extra, file]);
  assert.equal(r.status, 0, `ffmpeg failed: ${r.stderr}`);
  return file;
}

/* ID3v2.4 frame helpers (for what ffmpeg can't write: UFID and multi-valued TXXX). */
const syncsafe = (n: number) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
const frame = (id: string, body: Buffer) => Buffer.concat([Buffer.from(id, 'latin1'), syncsafe(body.length), Buffer.from([0, 0]), body]);
const id3 = (frames: Buffer[]) => {
  const all = Buffer.concat(frames);
  return Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([4, 0, 0]), syncsafe(all.length), all]);
};

let admin: User;
let listener: User;
before(async () => {
  admin = await auth.createUser({ username: 'mbadmin', password: 'pass1234', isAdmin: true });
  listener = await auth.createUser({ username: 'listener', password: 'pass1234' });
});

/* ------------------------------------ tags ------------------------------------ */

test('Picard tags from a real FLAC (Vorbis comments, multi-value ids and names)', async () => {
  const f = audio(path.join(TMP, 'tags', 't.flac'), {
    artist: 'Artist A feat. Artist B', ARTISTS: 'Artist A;Artist B', MUSICBRAINZ_TRACKID: ID.recA, MUSICBRAINZ_RELEASETRACKID: ID.rec1,
    MUSICBRAINZ_ALBUMID: ID.rel21, MUSICBRAINZ_RELEASEGROUPID: ID.rg21, MUSICBRAINZ_ARTISTID: `${ID.artA};${ID.artB}`, MUSICBRAINZ_ALBUMARTISTID: ID.artA,
    MUSICBRAINZ_WORKID: ID.rec2, ACOUSTID_ID: ID.nirvana2, RELEASETYPE: 'album;live', RELEASESTATUS: 'official', ORIGINALDATE: '1999-05-01',
    BARCODE: '5099749534728', CATALOGNUMBER: 'XL-1', LABEL: 'XL Recordings', MUSICBRAINZ_ALBUMID_BAD: 'not-a-uuid',
  });
  const pr = await probe(f, f);
  const mb = tags.parseMbTags(tags.tagsWithId3(f, pr.tags));
  assert.equal(mb.recording, ID.recA);
  assert.equal(mb.releaseTrack, ID.rec1);
  assert.equal(mb.release, ID.rel21);
  assert.equal(mb.releaseGroup, ID.rg21);
  assert.deepEqual(mb.artists, [ID.artA, ID.artB]);
  assert.deepEqual(mb.albumArtists, [ID.artA]);
  assert.equal(mb.work, ID.rec2);
  assert.equal(mb.acoustid, ID.nirvana2);
  assert.deepEqual(mb.releaseTypes, ['album', 'live']);
  assert.equal(mb.releaseStatus, 'official');
  assert.equal(mb.originalYear, 1999);
  assert.equal(mb.originalDate, '1999-05-01');
  assert.equal(mb.barcode, '5099749534728');
  assert.equal(mb.catalogNumber, 'XL-1');
  assert.equal(mb.label, 'XL Recordings');
  assert.deepEqual(mb.artistNames, ['Artist A', 'Artist B']);
});

test('Picard tags from a real MP3: ID3v2.4 TXXX via ffprobe, plus UFID and every TXXX value read directly', async () => {
  // ffmpeg writes TXXX frames for unknown keys.
  const f = audio(path.join(TMP, 'tags', 'a.mp3'), {
    'MusicBrainz Album Id': ID.rel21, 'MusicBrainz Release Group Id': ID.rg21, 'MusicBrainz Album Type': 'single', 'MusicBrainz Album Artist Id': ID.adele,
    'MusicBrainz Release Track Id': ID.rec1, 'Acoustid Id': ID.nirvana2, ARTISTS: 'AC/DC',
  }, ['-id3v2_version', '4']);
  const pr = await probe(f, f);
  assert.ok(Object.keys(pr.tags).some((k) => /musicbrainz album id/i.test(k)), 'ffprobe exposes TXXX by description');
  const mb = tags.parseMbTags(tags.tagsWithId3(f, pr.tags));
  assert.equal(mb.release, ID.rel21);
  assert.equal(mb.releaseGroup, ID.rg21);
  assert.deepEqual(mb.releaseTypes, ['single']);
  assert.deepEqual(mb.albumArtists, [ID.adele]);
  assert.equal(mb.releaseTrack, ID.rec1);
  assert.equal(mb.acoustid, ID.nirvana2);
  assert.deepEqual(mb.artistNames, ['AC/DC'], '"/" only splits names when the MBID count says so');

  // Picard's UFID (recording id) and a multi-valued TXXX — ffprobe shows neither fully.
  const raw = path.join(TMP, 'tags', 'raw.mp3');
  audio(raw, {}, ['-write_id3v2', '0']);
  const tagBuf = id3([
    frame('TIT2', Buffer.concat([Buffer.from([3]), Buffer.from('Raw Song', 'utf8')])),
    frame('UFID', Buffer.concat([Buffer.from('http://musicbrainz.org\0', 'latin1'), Buffer.from(ID.recA, 'latin1')])),
    frame('TXXX', Buffer.concat([Buffer.from([3]), Buffer.from(`MusicBrainz Artist Id\0${ID.artA}\0${ID.artB}`, 'utf8')])),
    frame('TXXX', Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from('ARTISTS\0Artist A\0Artist B', 'utf16le')])),
  ]);
  const withTag = path.join(TMP, 'tags', 'ufid.mp3');
  fs.writeFileSync(withTag, Buffer.concat([tagBuf, fs.readFileSync(raw)]));
  const pr2 = await probe(withTag, withTag);
  assert.equal(pr2.tags.title, 'Raw Song');
  assert.equal(tags.parseMbTags(pr2.tags).recording, null, 'ffprobe alone misses the UFID');
  const extra = tags.readId3Extras(withTag);
  assert.equal(extra.ufid, ID.recA);
  const mb2 = tags.parseMbTags(tags.tagsWithId3(withTag, pr2.tags));
  assert.equal(mb2.recording, ID.recA);
  assert.deepEqual(mb2.artists, [ID.artA, ID.artB]);
  assert.deepEqual(mb2.artistNames, ['Artist A', 'Artist B']);
});

test('Picard tags from a real M4A ("MusicBrainz Track Id" keys) and iTunes freeform names', async () => {
  const f = audio(path.join(TMP, 'tags', 'a.m4a'), { 'MusicBrainz Track Id': ID.recA, 'MusicBrainz Album Id': ID.rel21, 'MusicBrainz Artist Id': ID.artA, 'MusicBrainz Release Group Id': ID.rg21 }, ['-c:a', 'aac', '-movflags', '+use_metadata_tags']);
  const pr = await probe(f, f);
  const mb = tags.parseMbTags(pr.tags);
  assert.equal(mb.recording, ID.recA, 'MP4 "MusicBrainz Track Id" is the recording id');
  assert.equal(mb.release, ID.rel21);
  assert.equal(mb.releaseGroup, ID.rg21);
  assert.deepEqual(mb.artists, [ID.artA]);
  // Keys as other tools spell them.
  assert.equal(tags.normKey('----:com.apple.iTunes:MusicBrainz Album Id'), 'musicbrainzalbumid');
  assert.equal(tags.normKey('MUSICBRAINZ_ALBUMID'), 'musicbrainzalbumid');
  assert.equal(tags.parseMbTags({ 'MusicBrainz Album Id': 'garbage' }).release, null, 'invalid UUIDs are ignored');
});

/* ----------------------------------- credits ----------------------------------- */

test('multi-artist credits: tags, MusicBrainz credits, and the careful fallback split', () => {
  const mb = tags.parseMbTags({ ARTISTS: 'A;B;C', MUSICBRAINZ_ARTISTID: `${ID.artA};${ID.artB};${ID.adele}` });
  const c = credits.creditsFromTags('A feat. B & C', mb)!;
  assert.deepEqual(c.map((x) => [x.name, x.mbid, x.joinPhrase]), [['A', ID.artA, ' feat. '], ['B', ID.artB, ' & '], ['C', ID.adele, '']]);
  assert.equal(c.map((x) => x.name + x.joinPhrase).join(''), 'A feat. B & C', 'join phrases rebuild the tagged string');
  // Ids without names: split the display string when the count matches.
  const c2 = credits.creditsFromTags('Jay-Z x Kanye West', tags.parseMbTags({ MUSICBRAINZ_ARTISTID: `${ID.artA}/${ID.artB}` }))!;
  assert.deepEqual(c2.map((x) => [x.name, x.joinPhrase]), [['Jay-Z', ' x '], ['Kanye West', '']]);
  assert.deepEqual(credits.creditsFromMb([{ name: 'X', joinphrase: ', ', artist: { id: ID.artA } }, { name: 'Y', joinphrase: '' }])!.map((x) => x.mbid), [ID.artA, null]);
  // Fallback: only when every part is a library artist and the whole string isn't one.
  const lib = new Set(['simon & garfunkel', 'simon', 'garfunkel', 'queen', 'abba']);
  const known = (n: string) => lib.has(n.toLowerCase());
  assert.equal(credits.fallbackCredits('Simon & Garfunkel', known), null, '"Simon & Garfunkel" is an artist: never split');
  assert.equal(credits.fallbackCredits('Earth, Wind & Fire', known), null, 'unknown parts: no split');
  assert.deepEqual(credits.fallbackCredits('Queen & ABBA', known)!.map((x) => [x.name, x.joinPhrase]), [['Queen', ' & '], ['ABBA', '']]);
});

/* -------------------------------- scan + grouping ------------------------------- */

let libDir = '';
test('scan: MBIDs keep same-name artists and editions apart, merge name variants, and untagged files group as before', async () => {
  libDir = path.join(TMP, 'music');
  const flac = (rel: string, meta: Record<string, string>) => audio(path.join(libDir, rel), meta);
  flac('Nirvana/Bleach/01 - Blew.flac', { title: 'Blew', artist: 'Nirvana', album_artist: 'Nirvana', album: 'Bleach', track: '1', MUSICBRAINZ_ALBUMARTISTID: ID.nirvana1, MUSICBRAINZ_ALBUMID: ID.relBleach });
  flac('Nirvana (UK)/Local Anaesthetic/01 - Rainbow.flac', { title: 'Rainbow', artist: 'Nirvana', album_artist: 'Nirvana', album: 'Local Anaesthetic', track: '1', MUSICBRAINZ_ALBUMARTISTID: ID.nirvana2 });
  flac('Queen/Greatest Hits/01 - Bohemian.flac', { title: 'Bohemian Rhapsody', artist: 'Queen', album_artist: 'Queen', album: 'Greatest Hits', track: '1' });
  flac('ABBA/Greatest Hits/01 - SOS.flac', { title: 'SOS', artist: 'ABBA', album_artist: 'ABBA', album: 'Greatest Hits', track: '1' });
  flac('Adele/21/01 - Rolling.flac', { title: 'Rolling in the Deep', artist: 'Adele', album_artist: 'Adele', album: '21', track: '1', MUSICBRAINZ_ALBUMARTISTID: ID.adele, MUSICBRAINZ_ALBUMID: ID.rel21, MUSICBRAINZ_RELEASEGROUPID: ID.rg21, RELEASETYPE: 'album' });
  flac('Adele/21 (Deluxe)/01 - Rolling.flac', { title: 'Rolling in the Deep', artist: 'Adele', album_artist: 'Adele', album: '21', track: '1', MUSICBRAINZ_ALBUMARTISTID: ID.adele, MUSICBRAINZ_ALBUMID: ID.rel21dlx, MUSICBRAINZ_RELEASEGROUPID: ID.rg21 });
  flac('Adele/21 (Deluxe)/02 - Hometown.flac', { title: 'Hometown Glory', artist: 'Adele', album_artist: 'Adele', album: '21', track: '2', MUSICBRAINZ_ALBUMARTISTID: ID.adele, MUSICBRAINZ_ALBUMID: ID.rel21dlx });
  flac('Beyonce/Dangerously/01.flac', { title: 'Crazy', artist: 'Beyonce', album_artist: 'Beyonce', album: 'Dangerously', MUSICBRAINZ_ALBUMARTISTID: ID.beyonce });
  flac('Beyoncé/Lemonade/01.flac', { title: 'Formation', artist: 'Beyoncé', album_artist: 'Beyoncé', album: 'Lemonade', MUSICBRAINZ_ALBUMARTISTID: ID.beyonce });
  flac('Various/Feat Album/01.flac', { title: 'Duet', artist: 'Artist A feat. Artist B', album_artist: 'Various Artists', album: 'Feat Album', ARTISTS: 'Artist A;Artist B', MUSICBRAINZ_ARTISTID: `${ID.artA};${ID.artB}`, MUSICBRAINZ_TRACKID: ID.recA });
  flac('Various/Feat Album/02.flac', { title: 'Day Song', artist: 'Queen & ABBA', album_artist: 'Various Artists', album: 'Feat Album', track: '2' });
  flac('Simon & Garfunkel/Bookends/01.flac', { title: 'America', artist: 'Simon & Garfunkel', album: 'Bookends' });
  audio(path.join(libDir, 'Folder Artist/Folder Album/01 - Untagged.flac'), {});

  db.insert('libraries', { id: 'lib-scan', name: 'Music', type: 'music', paths: JSON.stringify([libDir]), fetch_metadata: 0, created_at: now() });
  await scanLibrary('lib-scan');

  const artists = db.all("SELECT * FROM items WHERE library_id = 'lib-scan' AND type = 'artist'");
  const named = (t: string) => artists.filter((a) => a.title === t);
  assert.equal(named('Nirvana').length, 2, 'two artists called Nirvana (different MBIDs) stay apart');
  assert.deepEqual(named('Nirvana').map((a) => JSON.parse(a.external_ids).musicbrainzArtist).sort(), [ID.nirvana1, ID.nirvana2].sort());
  const albums = db.all("SELECT a.*, p.title artist FROM items a JOIN items p ON p.id = a.parent_id WHERE a.library_id = 'lib-scan' AND a.type = 'album'");
  assert.equal(albums.filter((a) => a.title === 'Greatest Hits').length, 2, 'same album name by different artists stays apart');
  const twentyOne = albums.filter((a) => a.title === '21');
  assert.equal(twentyOne.length, 2, 'standard and deluxe editions (different release MBIDs) stay apart');
  assert.deepEqual(twentyOne.map((a) => JSON.parse(a.external_ids).musicbrainzRelease).sort(), [ID.rel21, ID.rel21dlx].sort());
  const dlx = twentyOne.find((a) => JSON.parse(a.external_ids).musicbrainzRelease === ID.rel21dlx)!;
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) n FROM items WHERE parent_id = ? AND type = 'track'", dlx.id)!.n, 2);
  const std = twentyOne.find((a) => JSON.parse(a.external_ids).musicbrainzRelease === ID.rel21)!;
  assert.equal(JSON.parse(std.external_ids).musicbrainzReleaseGroup, ID.rg21);
  assert.deepEqual(JSON.parse(std.extra).music.releaseTypes, ['album']);
  const bey = artists.filter((a) => JSON.parse(a.external_ids).musicbrainzArtist === ID.beyonce);
  assert.equal(bey.length, 1, '"Beyonce" and "Beyoncé" share an MBID: one artist');
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) n FROM items WHERE parent_id = ? AND type = 'album'", bey[0].id)!.n, 2);
  // Untagged: grouped by folder name with the same ids as before MusicBrainz support.
  const folder = named('Folder Artist')[0];
  assert.equal(folder.id, stableId('lib-scan', 'artist', 'folder artist'));
  assert.equal(JSON.parse(folder.external_ids).musicbrainzArtist, undefined);
  // Track ids and credits.
  const duet = db.get("SELECT * FROM items WHERE library_id = 'lib-scan' AND title = 'Duet'")!;
  assert.equal(JSON.parse(duet.external_ids).musicbrainzRecording, ID.recA);
  const dc = credits.creditsFor([duet.id]).get(duet.id)!;
  assert.deepEqual(dc.map((c) => [c.name, c.joinPhrase, c.mbid]), [['Artist A', ' feat. ', ID.artA], ['Artist B', '', ID.artB]]);
  const day = db.get("SELECT * FROM items WHERE library_id = 'lib-scan' AND title = 'Day Song'")!;
  const qc = credits.creditsFor([day.id]).get(day.id)!;
  assert.deepEqual(qc.map((c) => c.name), ['Queen', 'ABBA'], 'untagged "Queen & ABBA" splits: both are library artists');
  assert.ok(qc.every((c) => c.artistId), 'credits link to library artists');
  const america = db.get("SELECT * FROM items WHERE library_id = 'lib-scan' AND title = 'America'")!;
  assert.deepEqual(credits.creditsFor([america.id]).get(america.id)!.map((c) => c.name), ['Simon & Garfunkel']);
  // Search finds tracks by featured artists; the item shows the tagged artist string and credits.
  const found = items.searchItems(admin, 'Artist B').filter((i) => i.type === 'track');
  assert.deepEqual(found.map((i) => i.title), ['Duet']);
  assert.equal(found[0].music?.displayArtist, 'Artist A feat. Artist B');
  assert.equal(found[0].music?.credits?.length, 2);
  // "Appears on" for Queen (album artist of its own album, credited on a Various Artists track).
  const queen = named('Queen')[0];
  const d = await mbsvc.discography(admin, queen.id);
  assert.deepEqual(d.appearsOn.map((i) => i.title), ['Day Song']);
});

test('rescan keeps ids stable and an upgraded library (no tag version) re-reads tags once', async () => {
  const before = db.all("SELECT id FROM items WHERE library_id = 'lib-scan' ORDER BY id").map((r) => r.id);
  // Simulate a library scanned by an older version: tags without MusicBrainz data.
  const t = db.get("SELECT id, extra FROM items WHERE library_id = 'lib-scan' AND title = 'Duet'")!;
  const ex = JSON.parse(t.extra);
  delete ex.mbTags;
  delete ex.tagv;
  db.run('UPDATE items SET extra = ?, external_ids = ? WHERE id = ?', JSON.stringify(ex), '{}', t.id);
  db.run('DELETE FROM track_artists WHERE track_id = ?', t.id);
  await scanLibrary('lib-scan');
  const after = db.all("SELECT id FROM items WHERE library_id = 'lib-scan' ORDER BY id").map((r) => r.id);
  assert.deepEqual(after, before);
  assert.equal(JSON.parse(row(t.id).external_ids).musicbrainzRecording, ID.recA, 'the rescan filled the MBID from the file');
  assert.equal(credits.creditsFor([t.id]).get(t.id)!.length, 2);
});

/* ------------------------------ release → recordings ----------------------------- */

test('track recording MBIDs are filled from the release tracklist (number + duration / title), tags win', async () => {
  db.insert('libraries', { id: 'lib-fill', name: 'Fill', type: 'music', paths: '[]', fetch_metadata: 1, created_at: now() });
  item({ id: 'art-fill', library_id: 'lib-fill', type: 'artist', title: 'Fill Artist' });
  const alb = item({ id: 'alb-fill', library_id: 'lib-fill', type: 'album', title: 'Fill Album', parent_id: 'art-fill', external_ids: JSON.stringify({ musicbrainzRelease: ID.relFill }) });
  item({ id: 'trk-f1', library_id: 'lib-fill', type: 'track', title: 'Opening', idx: 1, parent_idx: 1, duration_ms: 201500, parent_id: alb, grandparent_id: 'art-fill' });
  // Wrong number in the tags but the title and length match track 2.
  item({ id: 'trk-f2', library_id: 'lib-fill', type: 'track', title: 'Second Song (Remastered)', idx: 7, parent_idx: 1, duration_ms: 179000, parent_id: alb, grandparent_id: 'art-fill' });
  // Already tagged: kept.
  item({ id: 'trk-f3', library_id: 'lib-fill', type: 'track', title: 'Third', idx: 3, parent_idx: 1, duration_ms: 100000, parent_id: alb, grandparent_id: 'art-fill', external_ids: JSON.stringify({ musicbrainzRecording: ID.recA }) });
  // Number matches but the length is far off and the title differs: not matched.
  item({ id: 'trk-f4', library_id: 'lib-fill', type: 'track', title: 'Bonus', idx: 2, parent_idx: 2, duration_ms: 400000, parent_id: alb, grandparent_id: 'art-fill' });
  const before = hitsFor('/mb/ws/2/').length;
  await builtin.applyBuiltinProviders(alb, { only: ['musicbrainz'] });
  const mbHits = hitsFor('/mb/ws/2/').slice(before);
  assert.ok(!mbHits.some((h) => h.path.includes('query=')), 'a tagged release needs no search');
  assert.equal(mbHits.filter((h) => h.path.startsWith(`/mb/ws/2/release/${ID.relFill}`)).length, 1, 'one release request per album');
  assert.equal(JSON.parse(row('trk-f1').external_ids).musicbrainzRecording, ID.rec1);
  assert.equal(JSON.parse(row('trk-f2').external_ids).musicbrainzRecording, ID.rec2);
  assert.equal(JSON.parse(row('trk-f3').external_ids).musicbrainzRecording, ID.recA, 'tagged ids are kept');
  assert.equal(JSON.parse(row('trk-f4').external_ids).musicbrainzRecording, undefined);
  const a = row(alb);
  assert.equal(JSON.parse(a.external_ids).musicbrainzReleaseGroup, ID.rgFill);
  const facts = JSON.parse(a.provider_meta).mb;
  assert.deepEqual(facts.types, ['album', 'live']);
  assert.equal(facts.label, 'Fill Records');
  assert.equal(facts.catalogNumber, 'CAT-1');
  assert.equal(facts.firstYear, 1997);
  const it = items.getItem(admin, alb, false);
  assert.deepEqual(it.music?.releaseTypes, ['album', 'live']);
  assert.equal(it.music?.label, 'Fill Records');
  // MusicBrainz artist credits on the tracks.
  assert.deepEqual(credits.creditsFor(['trk-f1']).get('trk-f1')!.map((c) => c.name + c.joinPhrase).join(''), 'Fill Artist feat. Guest');
  // Nothing left to fill: no new release request.
  db.run("UPDATE items SET external_ids = json_set(external_ids, '$.musicbrainzRecording', ?) WHERE id = 'trk-f4'", ID.rec2);
  const n = hitsFor(`/mb/ws/2/release/${ID.relFill}`).length;
  await builtin.applyBuiltinProviders(alb, { only: ['musicbrainz'] });
  assert.equal(hitsFor(`/mb/ws/2/release/${ID.relFill}`).length, n, 'lookups already satisfied are skipped');
});

/* --------------------------- discography / related artists -------------------------- */

test('missing albums: release groups minus owned ones (by MBID, then title + year), paginated, filtered by type', async () => {
  const adele = db.get("SELECT * FROM items WHERE library_id = 'lib-scan' AND type = 'artist' AND title = 'Adele'")!;
  // An owned album without a release-group id, matched by title + year.
  item({ id: 'alb-19', library_id: 'lib-scan', type: 'album', title: '19', year: 2008, parent_id: adele.id });
  // A live album in the library goes into the Live section.
  item({ id: 'alb-live', library_id: 'lib-scan', type: 'album', title: 'Live Thing', year: 2012, parent_id: adele.id, extra: JSON.stringify({ music: { releaseTypes: ['album', 'live'] } }) });
  updateMusicSettings({ missingHide: { singles: true, eps: false, compilations: true, live: true, other: true } });
  const d = await mbsvc.discography(admin, adele.id);
  assert.equal(d.artistMbid, ID.adele);
  assert.equal(d.missingError, null);
  assert.deepEqual(d.missing.map((m) => m.title), ['25', 'Remixes EP'], 'owned 21 (MBID) and 19 (title+year) are not missing; singles and live hidden');
  assert.match(d.missing[0].coverUrl, /\/release-group\/.+\/front-250$/);
  const pages = hitsFor('/mb/ws/2/release-group?').filter((h) => h.path.includes(`artist=${ID.adele}`));
  assert.ok(pages.length >= 2, 'paginates through all release groups');
  assert.ok(pages.every((h) => h.path.includes('type=album%7Cep%7Csingle')));
  assert.deepEqual(d.sections.map((s) => s.type), ['album', 'live']);
  assert.ok(d.sections[0].items.some((i) => i.title === '21'));
  // Cached for a week: a second call makes no requests.
  const n = hits.length;
  await mbsvc.discography(admin, adele.id);
  assert.equal(hits.length, n);
  // Pure diff.
  const miss = mbsvc.missingFrom([{ id: 'x', title: 'The Album', primaryType: 'Album', secondaryTypes: [], firstReleaseDate: '2000' }, { id: 'y', title: 'Comp', primaryType: 'Album', secondaryTypes: ['compilation'], firstReleaseDate: null }], [{ rg: null, title: 'The Album!', year: null }], ['compilation']);
  assert.deepEqual(miss.map((m) => m.id), []);
  assert.equal(mbsvc.sectionOf(['single']), 'single');
  assert.equal(mbsvc.sectionOf(['album', 'soundtrack']), 'soundtrack');
  assert.equal(mbsvc.sectionOf(undefined), 'album');
});

test('related artists from MusicBrainz relationships (+ ListenBrainz similar artists), linked to the library', async () => {
  const nirvana = db.all("SELECT * FROM items WHERE library_id = 'lib-scan' AND type = 'artist' AND title = 'Nirvana'").find((a) => JSON.parse(a.external_ids).musicbrainzArtist === ID.nirvana1)!;
  const r = await mbsvc.relatedArtists(admin, nirvana.id);
  assert.deepEqual(r.members.map((m) => m.name), ['Kurt Cobain', 'Beyonce']);
  assert.match(r.members[0].detail!, /lead vocals, guitar · 1987–1994/);
  assert.ok(r.members[1].itemId, 'a member who is in the library links to it (by MBID)');
  assert.equal(r.members[0].itemId, null);
  assert.deepEqual(r.memberOf.map((m) => m.name), ['Supergroup']);
  assert.deepEqual(r.collaborations.map((m) => m.name), ['Some Collab']);
  assert.deepEqual(r.related.map((m) => [m.name, m.detail]), [['Tribute Band', 'tribute']]);
  assert.deepEqual(r.similar.map((m) => m.name), ['Pixies', 'Adele'], 'similar artists by score, without the artist itself');
  assert.ok(r.similar[1].itemId);
  const lab = hitsFor('/labs/similar-artists/json')[0];
  assert.ok(lab.path.includes(`artist_mbids=${ID.nirvana1}`) && lab.path.includes('algorithm=session_based'));
  // No MBID: graceful.
  const folder = db.get("SELECT id FROM items WHERE library_id = 'lib-scan' AND title = 'Folder Artist'")!;
  assert.match((await mbsvc.relatedArtists(admin, folder.id)).error!, /no MusicBrainz id/);
});

/* ---------------------------------- ListenBrainz ---------------------------------- */

test('ListenBrainz rules: half the track or 4 minutes', () => {
  assert.equal(scrobble.listenCounts(300000, 150000), true);
  assert.equal(scrobble.listenCounts(300000, 149999), false);
  assert.equal(scrobble.listenCounts(600000, 240000), true, '4 minutes is enough for long tracks');
  assert.equal(scrobble.listenCounts(600000, 239000), false);
  assert.equal(scrobble.listenCounts(null, 239000), false, 'unknown length needs 4 minutes');
  assert.equal(scrobble.listenCounts(20000, 15000), true);
  assert.equal(scrobble.listenCounts(20000, 15000, 30000), false, 'Last.fm skips tracks under 30 s');
});

let duetId = '';
test('listen payload: track_metadata + additional_info with MBIDs, Kinora as player/client, no music_service', () => {
  duetId = db.get("SELECT id FROM items WHERE library_id = 'lib-scan' AND title = 'Duet'")!.id;
  const t = scrobble.trackForScrobble(duetId)!;
  const l = lb.buildListen(t, 1700000000) as any;
  assert.equal(l.listened_at, 1700000000);
  assert.equal(l.track_metadata.artist_name, 'Artist A feat. Artist B');
  assert.equal(l.track_metadata.track_name, 'Duet');
  assert.equal(l.track_metadata.release_name, 'Feat Album');
  const ai = l.track_metadata.additional_info;
  assert.equal(ai.recording_mbid, ID.recA);
  assert.deepEqual(ai.artist_mbids, [ID.artA, ID.artB]);
  assert.equal(ai.media_player, 'Kinora');
  assert.equal(ai.submission_client, 'Kinora');
  assert.ok(ai.submission_client_version);
  assert.ok(ai.duration_ms > 0);
  assert.equal('music_service' in ai, false);
  assert.equal('listened_at' in lb.buildListen(t), false, 'playing_now has no timestamp');
  // Release MBID from the album.
  const rolling = db.all("SELECT i.id, p.external_ids pe FROM items i JOIN items p ON p.id = i.parent_id WHERE i.library_id = 'lib-scan' AND i.title = 'Hometown Glory'")[0];
  const t2 = scrobble.trackForScrobble(rolling.id)!;
  assert.equal(lb.buildListen(t2).track_metadata ? (lb.buildListen(t2) as any).track_metadata.additional_info.release_mbid : null, ID.rel21dlx);
  assert.equal((lb.buildListen(t2) as any).track_metadata.additional_info.tracknumber, 2);
});

test('ListenBrainz connect (token validated, write-only), listens, offline queue, rate limits, import batches', async () => {
  await assert.rejects(lb.lbConnect(listener, { token: 'bad-token' }), /not valid|401|Invalid/);
  // Non-admins can't point Kinora at a LAN address.
  await assert.rejects(lb.lbConnect(listener, { token: 'good-token', serverUrl: 'http://127.0.0.1:9/lb' }), /not allowed|private/);
  const st = await lb.lbConnect(listener, { token: 'good-token' });
  assert.equal(st.connected, true);
  assert.equal(st.username, 'lbuser');
  assert.equal(st.token, '••••');
  lb.initListenBrainz();

  lbMode = 'ok';
  const t = scrobble.trackForScrobble(duetId)!;
  await lb.lbNowPlaying(listener.id, t);
  const np = hitsFor('/lb/1/submit-listens').at(-1)!;
  assert.equal(np.body.listen_type, 'playing_now');
  assert.equal(np.headers.authorization, 'Token good-token');
  assert.equal('listened_at' in np.body.payload[0], false);

  assert.equal(await lb.lbListen(listener.id, t, Date.now() - 60000, 400), 'skipped', 'too short to count');
  assert.equal(await lb.lbListen(listener.id, t, 1700000000000, 240000), 'sent');
  const single = hitsFor('/lb/1/submit-listens').at(-1)!;
  assert.equal(single.body.listen_type, 'single');
  assert.equal(single.body.payload[0].listened_at, 1700000000);

  // Server down: listens wait in the queue.
  lbMode = 'down';
  assert.equal(await lb.lbListen(listener.id, t, 1700000100000, 240000), 'queued');
  assert.equal(await lb.lbListen(listener.id, t, 1700000200000, 240000), 'queued');
  assert.equal(lb.lbStatus(listener.id).pending, 2);
  assert.equal(await lb.flushQueue(listener.id), 0, 'still down: retried, nothing sent');
  const attempts = () => db.get<{ a: number }>('SELECT MAX(attempts) a FROM listenbrainz_queue WHERE user_id = ?', listener.id)!.a;
  const a0 = attempts();
  assert.ok(a0 >= 1);

  // Rate limited: nothing sent, the window from X-RateLimit-Reset-In is respected without another request.
  lbMode = 'ratelimit';
  assert.equal(await lb.flushQueue(listener.id), 0);
  assert.equal(attempts(), a0 + 1);
  lbMode = 'ok';
  lb.setLbMaxInlineWait(0);
  const n = hitsFor('/lb/').length;
  assert.equal(await lb.flushQueue(listener.id), 0);
  assert.equal(hitsFor('/lb/').length, n, 'no request inside the rate-limit window');
  lb.setLbMaxInlineWait(10_000);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(await lb.flushQueue(listener.id), 2);
  const imp = hitsFor('/lb/1/submit-listens').at(-1)!;
  assert.equal(imp.body.listen_type, 'import');
  assert.deepEqual(imp.body.payload.map((p: any) => p.listened_at), [1700000100, 1700000200], 'oldest first, one batch');
  assert.equal(lb.lbStatus(listener.id).pending, 0);

  // The shared dispatcher (players, DJ mix, Subsonic) reaches ListenBrainz.
  await scrobble.dispatchListen(listener.id, duetId, 1700000300000, 999999);
  assert.equal(hitsFor('/lb/1/submit-listens').at(-1)!.body.payload[0].listened_at, 1700000300);

  // Favourites → love feedback (opt-in).
  await lb.lbConnect(listener, { feedback: true });
  assert.equal(lb.feedbackScore(true, null), 1);
  assert.equal(lb.feedbackScore(false, 8), 1);
  assert.equal(lb.feedbackScore(false, 2), -1);
  assert.equal(lb.feedbackScore(false, 6), 0);
  items.setFavorite(listener, duetId, true);
  await new Promise((r) => setTimeout(r, 100));
  const fb = hitsFor('/lb/1/feedback/recording-feedback').at(-1)!;
  assert.deepEqual(fb.body, { recording_mbid: ID.recA, score: 1 });
});

test('ListenBrainz recommendations: generated playlists + CF, matched by recording MBID then artist/title; save as playlist', async () => {
  const r = await lb.lbRecommendations(listener, true);
  assert.equal(r.error, null);
  assert.deepEqual(r.lists.map((l) => l.kind), ['weekly-jams', 'weekly-exploration', 'cf'], 'newest playlist of each kind');
  const jams = r.lists[0];
  assert.deepEqual(jams.tracks.map((t) => t.match), ['mbid', 'fuzzy', null]);
  assert.equal(jams.tracks[0].item?.title, 'Duet');
  assert.equal(jams.tracks[1].item?.title, 'Day Song', 'artist + title fallback (credited artist "Queen")');
  assert.equal(jams.tracks[2].item, null);
  assert.deepEqual(jams.tracks[2].artistMbids, ['00000000-3333-4333-8333-000000000000'], 'missing tracks keep artist MBIDs for a Lidarr request');
  const cf = r.lists[2];
  assert.equal(cf.tracks[0].item?.title, 'Duet');
  assert.equal(cf.tracks[1].title, 'Unknown Gem');
  const saved = await lb.lbSaveAsPlaylist(listener, 'pl-jams');
  assert.equal(saved.count, 2);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) n FROM collection_items WHERE collection_id = ?', saved.id)!.n, 2);
  assert.equal(row(saved.id).owner_id, listener.id);
  // Not connected.
  assert.equal((await lb.lbRecommendations(admin)).connected, false);
});

/* ------------------------------------ AcoustID ------------------------------------ */

test('AcoustID: fpcalc present/absent, lookup with the app key, candidates by score, apply stores in the DB only', async () => {
  const untagged = db.get("SELECT i.id, m.path FROM items i JOIN media m ON m.item_id = i.id WHERE i.library_id = 'lib-scan' AND i.title LIKE 'Untagged%'")!;
  const fileBefore = fs.readFileSync(untagged.path);
  // Absent: no fpcalc and no chromaprint-enabled ffmpeg.
  const realFfmpeg = config.ffmpeg;
  process.env.MEDIAMAX_FPCALC = path.join(TMP, 'no-such-fpcalc');
  (config as any).ffmpeg = path.join(TMP, 'no-such-ffmpeg');
  const none = await acoustid.detectFingerprinter(true);
  assert.equal(none.available, false);
  assert.match(none.detail, /libchromaprint-tools|fpcalc/);
  (config as any).ffmpeg = realFfmpeg;
  updateMusicSettings({ acoustid: { apiKey: 'acoustid-key', autoIdentify: false, autoApplyScore: 0 } });
  const res0 = await acoustid.identifyTrack(untagged.id);
  if (!res0.available) assert.match(res0.reason!, /fpcalc|chromaprint|Chromaprint/i);
  // Present: a stand-in fpcalc.
  const fake = path.join(TMP, 'fpcalc');
  fs.writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "-version" ]; then echo "fpcalc version 1.5.1"; exit 0; fi\necho \'{"duration": 2.0, "fingerprint": "AQADtFakeFingerprint"}\'\n', { mode: 0o755 });
  process.env.MEDIAMAX_FPCALC = fake;
  const fp = await acoustid.detectFingerprinter(true);
  assert.deepEqual([fp.available, fp.tool], [true, 'fpcalc']);
  const res = await acoustid.identifyTrack(untagged.id);
  assert.equal(res.available, true);
  const look = hitsFor('/acoustid/v2/lookup').at(-1)!;
  const q = new URL(look.path, 'http://x').searchParams;
  assert.equal(q.get('client'), 'acoustid-key');
  assert.equal(q.get('meta'), 'recordings releasegroups compress');
  assert.equal(q.get('fingerprint'), 'AQADtFakeFingerprint');
  assert.equal(q.get('duration'), '2');
  assert.deepEqual(res.candidates.map((c) => c.score), [0.97, 0.62, 0.5]);
  const best = res.candidates[0];
  assert.equal(best.title, 'Identified Song');
  assert.deepEqual(best.releaseGroup, { mbid: ID.rg21, title: 'Hits', type: 'album' });
  assert.equal(acoustid.countUntagged() >= 1, true);
  acoustid.applyIdentification(untagged.id, best);
  const r = row(untagged.id);
  assert.equal(r.title, 'Identified Song');
  assert.equal(JSON.parse(r.external_ids).musicbrainzRecording, ID.recA);
  assert.equal(JSON.parse(r.provider_meta).identified.artist, 'Queen & ABBA');
  assert.deepEqual(credits.creditsFor([untagged.id]).get(untagged.id)!.map((c) => c.name), ['Queen', 'ABBA']);
  assert.ok(fs.readFileSync(untagged.path).equals(fileBefore), 'the media file is untouched');
  // A rescan keeps the identification.
  await scanLibrary('lib-scan');
  assert.equal(row(untagged.id).title, 'Identified Song');
  // Bad key → clear error.
  updateMusicSettings({ acoustid: { apiKey: 'wrong' } as any });
  await assert.rejects(acoustid.lookup('AQAD', 2), /invalid API key/);
  updateMusicSettings({ acoustid: { apiKey: '••••' } as any });
  // Auto-apply above the threshold for the admin task.
  updateMusicSettings({ acoustid: { apiKey: 'acoustid-key', autoIdentify: true, autoApplyScore: 0.9 } });
  db.run("UPDATE items SET provider_meta = '{}', external_ids = '{}', title = 'Untagged' WHERE id = ?", untagged.id);
  db.run('DELETE FROM acoustid_results');
  const out = await acoustid.identifyUntagged();
  assert.ok(out.checked >= 1 && out.applied >= 1);
  assert.equal(row(untagged.id).title, 'Identified Song');
  delete process.env.MEDIAMAX_FPCALC;
});

/* ------------------------------------ Subsonic ------------------------------------ */

test('OpenSubsonic: musicBrainzId, artists/albumArtists, releaseTypes, originalReleaseDate, recordLabels (JSON and XML); scrobble reaches ListenBrainz', async () => {
  const app = await buildApp();
  try {
    const q = (m: string, extra: string) => app.inject({ method: 'GET', url: `/rest/${m}.view?u=listener&p=pass1234&v=1.16.1&c=test&${extra}` });
    const feat = db.get("SELECT id FROM items WHERE library_id = 'lib-scan' AND type = 'album' AND title = 'Feat Album'")!.id;
    const j = (await q('getAlbum', `id=${feat}&f=json`)).json()['subsonic-response'];
    assert.equal(j.status, 'ok');
    const duet = j.album.song.find((s: any) => s.title === 'Duet');
    assert.equal(duet.musicBrainzId, ID.recA);
    assert.equal(duet.displayArtist, 'Artist A feat. Artist B');
    assert.deepEqual(duet.artists.map((a: any) => a.name), ['Artist A', 'Artist B']);
    assert.equal(duet.albumArtists[0].name, 'Various Artists');
    const fill = (await q('getAlbum', 'id=alb-fill&f=json')).json()['subsonic-response'].album;
    assert.deepEqual(fill.releaseTypes, ['Album', 'Live']);
    assert.deepEqual(fill.recordLabels, [{ name: 'Fill Records' }]);
    assert.deepEqual(fill.originalReleaseDate, { year: 1997, month: 6, day: 16 });
    const std = db.all("SELECT id, external_ids FROM items WHERE library_id = 'lib-scan' AND type = 'album' AND title = '21'").find((a) => JSON.parse(a.external_ids).musicbrainzRelease === ID.rel21)!;
    const a21 = (await q('getAlbum', `id=${std.id}&f=json`)).json()['subsonic-response'].album;
    assert.equal(a21.musicBrainzId, ID.rel21);
    const adele = db.get("SELECT id FROM items WHERE library_id = 'lib-scan' AND type = 'artist' AND title = 'Adele'")!.id;
    assert.equal((await q('getArtist', `id=${adele}&f=json`)).json()['subsonic-response'].artist.musicBrainzId, ID.adele);
    // XML: attributes and child elements.
    const xml = (await q('getAlbum', `id=${feat}`)).body;
    assert.match(xml, new RegExp(`musicBrainzId="${ID.recA}"`));
    assert.match(xml, /<artists [^>]*name="Artist A"/);
    assert.match(xml, /<albumArtists [^>]*name="Various Artists"/);
    const xmlArtist = (await q('getArtist', `id=${adele}`)).body;
    assert.match(xmlArtist, new RegExp(`<artist [^>]*musicBrainzId="${ID.adele}"`));
    // search3 finds songs by a featured artist.
    const s = (await q('search3', 'query=Artist%20B&f=json')).json()['subsonic-response'].searchResult3;
    assert.deepEqual(s.song.map((x: any) => x.title), ['Duet']);
    // Subsonic scrobbles go through the same dispatcher.
    const n = hitsFor('/lb/1/submit-listens').length;
    await q('scrobble', `id=${duetId}&submission=false`);
    await q('scrobble', `id=${duetId}&submission=true&time=1700000400000`);
    await new Promise((r) => setTimeout(r, 150));
    const sent = hitsFor('/lb/1/submit-listens').slice(n);
    assert.deepEqual(sent.map((h) => h.body.listen_type), ['playing_now', 'single']);
    assert.equal(sent[1].body.payload[0].listened_at, 1700000400);
    // HTTP routes.
    const tokenFor = (u: User) => auth.issueToken(u.id, { deviceId: `dev-${u.id}`, deviceName: 'test', platform: 'web' } as any).token;
    const disc = await app.inject({ method: 'GET', url: `/api/v1/music/artists/${adele}/discography`, headers: { authorization: `Bearer ${tokenFor(listener)}` } });
    assert.equal(disc.statusCode, 200);
    assert.ok(disc.json().sections.length);
    const st = await app.inject({ method: 'GET', url: '/api/v1/listenbrainz', headers: { authorization: `Bearer ${tokenFor(listener)}` } });
    assert.equal(st.json().token, '••••');
    const ms = await app.inject({ method: 'GET', url: '/api/v1/admin/music', headers: { authorization: `Bearer ${tokenFor(admin)}` } });
    assert.equal(ms.json().settings.acoustid.apiKey, '••••');
    const forbidden = await app.inject({ method: 'GET', url: '/api/v1/admin/music', headers: { authorization: `Bearer ${tokenFor(listener)}` } });
    assert.equal(forbidden.statusCode, 403);
  } finally {
    await app.close();
  }
});

/* ------------------------------------- Lidarr ------------------------------------- */

test('Lidarr: a missing album is requested by its release-group MBID (lidarr: lookup, foreignAlbumId)', async () => {
  const inst: ArrInstance = { id: 'lidarr', kind: 'lidarr', name: 'Lidarr', url: `${base}/lidarr`, apiKey: 'k', enabled: true } as ArrInstance;
  settings.updateSettings({ arr: [inst], requests: { ...settings.getSettings().requests, enabled: true } });
  const r = await requests.createRequest(admin, { mediaType: 'album', externalId: ID.rg25, title: '25' });
  assert.equal(r.status, 'processing', r.error ?? '');
  assert.ok(hitsFor('/lidarr/api/v1/album/lookup').some((h) => decodeURIComponent(h.path).includes(`term=lidarr:${ID.rg25}`)));
  const post = hits.find((h) => h.method === 'POST' && h.path === '/lidarr/api/v1/album')!;
  assert.equal(post.body.foreignAlbumId, ID.rg25);
  // The library album with that release group counts as available.
  assert.ok(requests.findAvailable(ID.rg21, 'album'));
  const adele = db.get("SELECT id FROM items WHERE library_id = 'lib-scan' AND type = 'artist' AND title = 'Adele'")!.id;
  const d = await mbsvc.discography(admin, adele);
  assert.equal(d.canRequest, true);
});
