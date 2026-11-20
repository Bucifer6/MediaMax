import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ArrInstance, ArrKind } from '@mediamax/shared';

/* ------------------------------------------------------------------ */
/* Mock *arr server                                                    */
/* ------------------------------------------------------------------ */

const KEY = 'secret-key';
const soon = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
const APP: Record<string, string> = { radarr: 'Radarr', sonarr: 'Sonarr', lidarr: 'Lidarr', readarr: 'Readarr', bazarr: 'Bazarr' };

interface Mock { url: string; calls: { method: string; path: string; body: any }[]; close: () => Promise<void> }

function routes(kind: ArrKind): Record<string, (body: any, q: URLSearchParams) => unknown> {
  const common = {
    'GET /system/status': () => ({ appName: APP[kind], version: kind === 'lidarr' || kind === 'readarr' ? '2.5.0' : '5.14.0' }),
    'GET /qualityprofile': () => [{ id: 1, name: 'HD-1080p' }, { id: 4, name: 'Ultra-HD' }],
    'GET /rootfolder': () => [{ path: `/${kind}-root`, freeSpace: 5e11 }],
    'GET /tag': () => [{ id: 7, label: 'requests' }],
    'GET /metadataprofile': () => [{ id: 1, name: 'None' }, { id: 2, name: 'Standard' }],
    'GET /health': () => [{ source: 'IndexerStatusCheck', type: 'warning', message: 'All indexers are unavailable', wikiUrl: 'https://wiki.servarr.com/x' }],
    'GET /diskspace': () => [{ path: '/data', label: 'data', freeSpace: 2e11, totalSpace: 1e12 }],
    'POST /command': (b: any) => ({ id: 99, name: b?.name }),
  };
  if (kind === 'radarr') return {
    ...common,
    'GET /queue': () => ({ records: [{ id: 1, movieId: 5, title: 'Dune.Part.Two.2024.2160p', movie: { title: 'Dune: Part Two', year: 2024, tmdbId: 693134 }, quality: { quality: { name: 'Bluray-2160p' } }, size: 1000, sizeleft: 580, timeleft: '00:12:00', status: 'downloading', trackedDownloadState: 'downloading', statusMessages: [], protocol: 'torrent', downloadClient: 'qBittorrent' }] }),
    'GET /calendar': () => [{ id: 5, title: 'Upcoming Movie', year: 2026, digitalRelease: soon(3), hasFile: false, monitored: true }, { id: 6, title: 'Far Future', inCinemas: soon(90) }],
    'GET /wanted/missing': () => ({ records: [{ id: 8, title: 'Missing Movie', year: 2020, digitalRelease: '2020-05-01' }] }),
    'GET /movie/lookup/tmdb': () => ({ title: 'Test Movie', tmdbId: 1, year: 2020 }),
    'POST /movie': (b: any) => ({ ...b, id: 50 }),
  };
  if (kind === 'sonarr') return {
    ...common,
    'GET /queue': () => ({ records: [{ id: 2, seriesId: 3, title: 'Show.S01E02', series: { title: 'The Show', tvdbId: 1234 }, episode: { seasonNumber: 1, episodeNumber: 2, title: 'Two' }, quality: { quality: { name: 'WEBDL-1080p' } }, size: 500, sizeleft: 500, timeleft: null, status: 'queued', statusMessages: [{ title: 'Show.S01E02', messages: ['No files found are eligible for import'] }] }] }),
    'GET /calendar': () => [{ id: 11, seriesId: 3, seasonNumber: 2, episodeNumber: 1, title: 'Premiere', airDateUtc: soon(2), hasFile: false, monitored: true, series: { title: 'The Show' } }],
    'GET /wanted/missing': () => ({ records: [{ id: 12, seasonNumber: 1, episodeNumber: 3, title: 'Three', airDateUtc: '2025-01-01T00:00:00Z', series: { title: 'The Show' } }] }),
    'GET /series/lookup': () => [{ title: 'The Show', tvdbId: 1234, seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }, { seasonNumber: 2 }, { seasonNumber: 3 }] }],
    'POST /series': (b: any) => ({ ...b, id: 51 }),
  };
  if (kind === 'lidarr') return {
    ...common,
    'GET /queue': () => ({ records: [{ id: 3, artistId: 9, albumId: 10, title: 'Artist - Album', artist: { artistName: 'Test Artist', foreignArtistId: 'mb-artist-1' }, album: { title: 'First Album', foreignAlbumId: 'mb-album-1' }, quality: { quality: { name: 'FLAC' } }, size: 200, sizeleft: 50, timeleft: '00:01:00', status: 'downloading' }] }),
    'GET /calendar': () => [{ id: 21, title: 'New Album', releaseDate: soon(5), artist: { artistName: 'Test Artist' }, monitored: true }],
    'GET /wanted/missing': () => ({ records: [{ id: 22, title: 'Old Album', releaseDate: '2001-01-01', artist: { artistName: 'Test Artist' } }] }),
    'GET /artist/lookup': (_b: any, q: URLSearchParams) => (/test|lidarr:mb-artist-1/i.test(q.get('term') ?? '') ? [{ artistName: 'Test Artist', foreignArtistId: 'mb-artist-1', overview: 'A band', images: [{ coverType: 'poster', remoteUrl: 'https://img.example/artist.jpg' }] }] : []),
    'GET /album/lookup': (_b: any, q: URLSearchParams) => (/test|lidarr:mb-album-1/i.test(q.get('term') ?? '') ? [{ title: 'First Album', foreignAlbumId: 'mb-album-1', releaseDate: '2019-03-01T00:00:00Z', artist: { artistName: 'Test Artist', foreignArtistId: 'mb-artist-1' }, images: [{ coverType: 'cover', url: 'https://img.example/album.jpg' }] }] : []),
    'POST /artist': (b: any) => ({ ...b, id: 52 }),
    'POST /album': (b: any) => ({ ...b, id: 53 }),
  };
  if (kind === 'readarr') return {
    ...common,
    'GET /queue': () => ({ records: [] }),
    'GET /calendar': () => [],
    'GET /wanted/missing': () => ({ records: [] }),
    'GET /book/lookup': (_b: any, q: URLSearchParams) => (/dune/i.test(q.get('term') ?? '') ? [{ title: 'Dune', foreignBookId: '44767458', releaseDate: '1965-08-01', author: { authorName: 'Frank Herbert' }, images: [{ coverType: 'cover', url: 'https://img.example/dune.jpg' }] }] : []),
    'POST /book': (b: any) => ({ ...b, id: 54 }),
  };
  return {
    'GET /system/status': () => ({ data: { bazarr_version: '1.4.5' } }),
    'GET /system/health': () => ({ data: [{ object: 'Sonarr', issue: 'Cannot reach Sonarr' }] }),
    'PATCH /movies': () => null,
    'PATCH /series': () => null,
  };
}

async function mockArr(kind: ArrKind): Promise<Mock> {
  const calls: Mock['calls'] = [];
  const table = routes(kind);
  const prefix = kind === 'radarr' || kind === 'sonarr' ? '/api/v3' : kind === 'bazarr' ? '/api' : '/api/v1';
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://x');
      const body = data ? JSON.parse(data) : null;
      calls.push({ method: req.method ?? 'GET', path: u.pathname + u.search, body });
      if (req.headers['x-api-key'] !== KEY) return void res.writeHead(401).end('{"error":"Unauthorized"}');
      const h = table[`${req.method} ${u.pathname.slice(prefix.length)}`];
      if (!u.pathname.startsWith(prefix) || !h) return void res.writeHead(404).end('{"message":"NotFound"}');
      const out = h(body, u.searchParams);
      res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' }).end(out === null ? '' : JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => new Promise((r) => server.close(() => r())) };
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const { db } = await import('../src/db.ts');
// The legacy single Radarr config, as stored before the *arr suite existed.
db.upsert('settings', { key: 'server', value: JSON.stringify({ requests: { enabled: true, autoApproveUserIds: [], weeklyLimit: 10, radarr: { url: 'http://old-radarr:7878', apiKey: 'legacy-key', qualityProfileId: 4, rootFolder: '/movies', searchOnAdd: true }, sonarr: null } }) }, 'key');

const settings = await import('../src/services/settings.ts');
const { createUser } = await import('../src/services/auth.ts');
const client = await import('../src/services/arr/client.ts');
const dash = await import('../src/services/arr/dashboard.ts');
const hook = await import('../src/services/arr/webhook.ts');
const requests = await import('../src/services/requests.ts');

const mocks = {
  radarr: await mockArr('radarr'), radarr4k: await mockArr('radarr'), sonarr: await mockArr('sonarr'), lidarr: await mockArr('lidarr'), readarr: await mockArr('readarr'), bazarr: await mockArr('bazarr'),
};
after(async () => {
  for (const m of Object.values(mocks)) await m.close();
});

const inst = (id: string, kind: ArrKind, url: string, extra: Partial<ArrInstance> = {}): ArrInstance => ({ id, kind, name: id, url, apiKey: KEY, enabled: true, ...extra });
const now = new Date().toISOString();
for (const [id, type, p] of [['lib-movies', 'movies', '/data/movies'], ['lib-tv', 'shows', '/data/tv'], ['lib-music', 'music', '/data/music'], ['lib-books', 'audiobooks', '/data/books']]) {
  db.insert('libraries', { id, name: id, type, paths: JSON.stringify([p]), created_at: now });
}
const admin = createUser({ username: 'admin', password: 'pass1234', isAdmin: true });
const viewer = createUser({ username: 'viewer', password: 'pass1234' });

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

test('legacy Radarr/Sonarr settings migrate once into arr[]', () => {
  const s = settings.getSettings();
  assert.equal(s.arr.length, 1);
  assert.equal(s.arr[0].kind, 'radarr');
  assert.equal(s.arr[0].url, 'http://old-radarr:7878');
  assert.equal(s.arr[0].apiKey, 'legacy-key');
  assert.equal(s.arr[0].qualityProfileId, 4);
  assert.equal(s.arr[0].rootFolderPath, '/movies');
  // Persisted, with the old fields left in place as a fallback.
  const stored = JSON.parse(db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'server'")!.value);
  assert.equal(stored.arr.length, 1);
  assert.equal(stored.requests.radarr.url, 'http://old-radarr:7878');
  assert.equal(settings.legacyArrInstances(stored.requests).length, 1);
});

test('API keys are write-only: reads mask them, saving the mask keeps the key', () => {
  const id = settings.getSettings().arr[0].id;
  const pub = settings.publicSettings();
  assert.equal(pub.arr[0].apiKey, settings.SECRET_MASK);
  assert.equal(pub.requests.radarr?.apiKey, settings.SECRET_MASK);
  settings.updateSettings({ arr: [{ ...pub.arr[0], name: 'Old Radarr' }] });
  assert.equal(settings.getSettings().arr[0].apiKey, 'legacy-key');
  assert.equal(settings.getSettings().arr[0].name, 'Old Radarr');
  assert.equal(settings.getSettings().arr[0].id, id);
  // Bad kinds are dropped; ids are generated.
  settings.updateSettings({ arr: [{ kind: 'nope' } as any, { kind: 'sonarr', url: 'http://s:8989/', apiKey: 'k' } as any] });
  const a = settings.getSettings().arr;
  assert.equal(a.length, 1);
  assert.equal(a[0].url, 'http://s:8989');
  assert.ok(a[0].id);
});

test('configure the mock instances', () => {
  settings.updateSettings({
    arr: [
      inst('radarr', 'radarr', mocks.radarr.url, { pathMappings: [{ remotePath: '/movies', localPath: '/data/movies' }] }),
      inst('radarr4k', 'radarr', mocks.radarr4k.url, { is4k: true }),
      inst('sonarr', 'sonarr', mocks.sonarr.url, { pathMappings: [{ remotePath: '/tv', localPath: '/data/tv' }] }),
      inst('lidarr', 'lidarr', mocks.lidarr.url, { pathMappings: [{ remotePath: '/music', localPath: '/data/music' }] }),
      inst('readarr', 'readarr', mocks.readarr.url, { pathMappings: [{ remotePath: 'D:\\Books', localPath: '/data/books' }] }),
      inst('bazarr', 'bazarr', mocks.bazarr.url),
      inst('down', 'sonarr', 'http://127.0.0.1:1', { name: 'Broken Sonarr' }),
    ],
  });
  assert.equal(settings.getSettings().arr.length, 7);
  assert.equal(client.instanceFor('radarr')?.id, 'radarr');
  assert.equal(client.instanceFor('radarr', true)?.id, 'radarr4k');
});

/* ------------------------------------------------------------------ */
/* Test buttons                                                        */
/* ------------------------------------------------------------------ */

test('test connection loads profiles, root folders, tags (and metadata profiles for Lidarr)', async () => {
  const r = await client.arrOptions({ kind: 'radarr', url: mocks.radarr.url, apiKey: KEY });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.version, '5.14.0');
  assert.deepEqual(r.qualityProfiles.map((p) => p.id), [1, 4]);
  assert.equal(r.rootFolders[0].path, '/radarr-root');
  assert.equal(r.tags?.[0].label, 'requests');
  assert.ok(mocks.radarr.calls.some((c) => c.path === '/api/v3/system/status'));

  const l = await client.arrOptions({ kind: 'lidarr', url: mocks.lidarr.url, apiKey: KEY });
  assert.equal(l.ok, true);
  assert.equal(l.metadataProfiles?.length, 2);
  assert.ok(mocks.lidarr.calls.some((c) => c.path === '/api/v1/system/status'));

  const b = await client.arrOptions({ kind: 'bazarr', url: mocks.bazarr.url, apiKey: KEY });
  assert.equal(b.ok, true);
  assert.equal(b.version, '1.4.5');
  assert.ok(mocks.bazarr.calls.some((c) => c.path === '/api/system/status'));

  assert.equal((await client.arrOptions({ kind: 'sonarr', url: mocks.radarr.url, apiKey: KEY })).ok, false, 'wrong app is rejected');
  const bad = await client.arrOptions({ kind: 'radarr', url: mocks.radarr.url, apiKey: 'wrong' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /API key/);
  assert.equal((await client.arrOptions({ kind: 'radarr', url: 'http://127.0.0.1:1', apiKey: KEY })).ok, false);
  // A saved instance can be tested with the masked key.
  assert.equal(client.testConn({ id: 'radarr', kind: 'radarr', url: mocks.radarr.url, apiKey: settings.SECRET_MASK }).apiKey, KEY);
});

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

test('queue aggregates every instance; a dead instance fails on its own', async () => {
  const q = await dash.getQueue();
  const by = (id: string) => q.sections.find((s) => s.instance.id === id)!;
  assert.equal(by('radarr').ok, true);
  const movie = by('radarr').items[0];
  assert.equal(movie.title, 'Dune: Part Two (2024)');
  assert.equal(movie.progress, 42);
  assert.equal(movie.quality, 'Bluray-2160p');
  assert.equal(movie.ids.tmdbId, '693134');
  const ep = by('sonarr').items[0];
  assert.equal(ep.subtitle, 'S01E02 · Two');
  assert.deepEqual(ep.warnings, ['Show.S01E02: No files found are eligible for import']);
  assert.equal(by('lidarr').items[0].ids.foreignAlbumId, 'mb-album-1');
  assert.equal(by('down').ok, false);
  assert.ok(by('down').error);
  assert.ok(!q.sections.some((s) => s.instance.kind === 'bazarr'), 'Bazarr has no queue');
  assert.ok(mocks.sonarr.calls.some((c) => c.path.startsWith('/api/v3/queue?') && c.path.includes('includeSeries=true') && c.path.includes('includeEpisode=true')));
  assert.ok(mocks.lidarr.calls.some((c) => c.path.startsWith('/api/v1/queue?')));
  // Cached: a second call doesn't hit the instance again.
  const before = mocks.radarr.calls.length;
  await dash.getQueue();
  assert.equal(mocks.radarr.calls.length, before);
});

test('calendar, wanted and health', async () => {
  const cal = await dash.getCalendar(14);
  const rad = cal.sections.find((s) => s.instance.id === 'radarr')!;
  assert.deepEqual(rad.items.map((x) => x.title), ['Upcoming Movie (2026)'], 'releases beyond 14 days are dropped');
  assert.equal(rad.items[0].releaseType, 'Digital release');
  assert.equal(cal.sections.find((s) => s.instance.id === 'sonarr')!.items[0].subtitle, 'S02E01 · Premiere');
  assert.equal(cal.sections.find((s) => s.instance.id === 'lidarr')!.items[0].subtitle, 'Test Artist');

  const w = await dash.getWanted();
  assert.equal(w.sections.find((s) => s.instance.id === 'radarr')!.items[0].id, 8);
  assert.equal(w.sections.find((s) => s.instance.id === 'sonarr')!.items[0].subtitle, 'S01E03 · Three');

  const h = await dash.getHealth();
  const r = h.sections.find((s) => s.instance.id === 'radarr')!;
  assert.equal(r.checks[0].type, 'warning');
  assert.equal(r.disks[0].totalSpace, 1e12);
  const bz = h.sections.find((s) => s.instance.kind === 'bazarr')!;
  assert.equal(bz.ok, true);
  assert.equal(bz.checks[0].message, 'Cannot reach Sonarr');
  assert.equal(h.sections.find((s) => s.instance.id === 'down')!.ok, false);
});

test('search sends the right *arr command', async () => {
  const cases: [string, number[], string, string, unknown][] = [
    ['radarr', [8], 'MoviesSearch', 'movieIds', [8]],
    ['sonarr', [12], 'EpisodeSearch', 'episodeIds', [12]],
    ['lidarr', [22], 'AlbumSearch', 'albumIds', [22]],
    ['readarr', [5], 'BookSearch', 'bookIds', [5]],
  ];
  for (const [id, ids, name, field, value] of cases) {
    const out = await dash.search(id, { ids });
    assert.equal(out.command, name);
    const call = (mocks as any)[id].calls.at(-1);
    assert.equal(call.method, 'POST');
    assert.ok(call.path.endsWith('/command'));
    assert.equal(call.body.name, name);
    assert.deepEqual(call.body[field], value);
  }
  await assert.rejects(dash.search('radarr', { ids: [] }));
  await assert.rejects(dash.search('radarr', { ids: [1], command: 'AlbumSearch' }));
});

/* ------------------------------------------------------------------ */
/* Requests: music, books, 4K, seasons, live progress                  */
/* ------------------------------------------------------------------ */

test('request options follow the configured instances and the 4K permission', () => {
  const a = requests.requestOptions(admin);
  assert.equal(a.music, true);
  assert.equal(a.books, true);
  assert.equal(a.can4k.movie, true);
  assert.equal(a.can4k.show, false, 'no 4K Sonarr');
  assert.equal(requests.requestOptions(viewer).can4k.movie, false);
  assert.equal(requests.requestOptions({ ...viewer, requestPermissions: { ...viewer.requestPermissions!, movie4k: 'request' } }).can4k.movie, true);
});

test('Discover music and books through Lidarr/Readarr lookups', async () => {
  const m = await requests.discoverArr(viewer, 'music', 'test');
  assert.deepEqual(m.results.map((r) => `${r.mediaType}:${r.externalId}`), ['artist:mb-artist-1', 'album:mb-album-1']);
  assert.equal(m.results[1].subtitle, 'Test Artist');
  assert.equal(m.results[1].year, 2019);
  assert.ok(m.results[0].posterUrl?.startsWith('/api/v1/images/'));
  const b = await requests.discoverArr(viewer, 'books', 'dune');
  assert.equal(b.results[0].title, 'Dune');
  assert.equal(b.results[0].subtitle, 'Frank Herbert');
  assert.ok(mocks.readarr.calls.some((c) => c.path === '/api/v1/book/lookup?term=dune'));
});

test('requesting an artist, an album and a book adds them to Lidarr/Readarr', async () => {
  const artist = await requests.createRequest(admin, { mediaType: 'artist', externalId: 'mb-artist-1', title: 'Test Artist', monitor: 'future' });
  assert.equal(artist.status, 'processing', artist.error ?? '');
  assert.equal(artist.monitor, 'future');
  const post = mocks.lidarr.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/artist')!;
  assert.equal(post.body.foreignArtistId, 'mb-artist-1');
  assert.equal(post.body.addOptions.monitor, 'future');
  assert.equal(post.body.metadataProfileId, 2, 'skips the "None" metadata profile');
  assert.equal(post.body.rootFolderPath, '/lidarr-root');

  const album = await requests.createRequest(admin, { mediaType: 'album', externalId: 'mb-album-1', title: 'First Album' });
  assert.equal(album.status, 'processing', album.error ?? '');
  assert.equal(album.subtitle, 'Test Artist');
  const ap = mocks.lidarr.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/album')!;
  assert.equal(ap.body.monitored, true);
  assert.equal(ap.body.artist.addOptions.monitor, 'none');

  const book = await requests.createRequest(viewer, { mediaType: 'book', externalId: '44767458', title: 'Dune' });
  assert.equal(book.status, 'pending', 'viewer requests wait for approval');
  const approved = await requests.approveRequest(admin, book.id);
  assert.equal(approved.status, 'processing', approved.error ?? '');
  assert.ok(mocks.readarr.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/book'));

  await assert.rejects(requests.createRequest(viewer, { mediaType: 'artist', externalId: 'mb-artist-1' }), /already requested/);
  await assert.rejects(requests.createRequest(viewer, { mediaType: 'album', externalId: 'mb-album-1', also4k: true }), /4K/);
});

test('requests show live download progress from the queue', async () => {
  client.invalidate();
  const list = await requests.listRequests(admin, {});
  const artist = list.find((r) => r.mediaType === 'artist')!;
  assert.ok(artist.download, 'artist matched in the Lidarr queue');
  assert.equal(artist.download!.progress, 75);
  assert.equal(artist.download!.instance, 'lidarr');
  assert.equal(list.find((r) => r.mediaType === 'book')!.download, null);
});

test('season selection: all / first / latest / specific', () => {
  const s = [0, 1, 2, 3];
  assert.deepEqual([...requests.pickSeasons(s, 'all', [])], [1, 2, 3]);
  assert.deepEqual([...requests.pickSeasons(s, 'first', [])], [1]);
  assert.deepEqual([...requests.pickSeasons(s, 'latest', [])], [3]);
  assert.deepEqual([...requests.pickSeasons(s, 'specific', [2])], [2]);
});

test('requests become available once the album shows up in the library', () => {
  db.insert('items', { id: 'art1', library_id: 'lib-music', type: 'artist', title: 'Test Artist', sort_title: 'test artist', added_at: now, updated_at: now });
  db.insert('items', { id: 'alb1', library_id: 'lib-music', type: 'album', title: 'First Album', sort_title: 'first album', parent_id: 'art1', added_at: now, updated_at: now });
  assert.equal(requests.checkAvailability(), 2);
  const all = db.all("SELECT media_type, status, item_id FROM media_requests WHERE media_type IN ('artist','album') ORDER BY media_type");
  assert.deepEqual(all.map((r) => [r.media_type, r.status, r.item_id]), [['album', 'available', 'alb1'], ['artist', 'available', 'art1']]);
});

/* ------------------------------------------------------------------ */
/* Webhooks                                                            */
/* ------------------------------------------------------------------ */

const scans: string[] = [];
hook._configure({ debounceMs: 60, scan: async (id) => void scans.push(id) });

test('webhook token: random, constant-time compare, regenerable', () => {
  const info = hook.webhookInfo();
  assert.ok(info.token.length >= 32);
  assert.equal(info.path, `/api/v1/arr/webhook/${info.token}`);
  assert.equal(hook.tokenMatches(info.token), true);
  assert.equal(hook.tokenMatches(info.token + 'x'), false);
  assert.equal(hook.tokenMatches(''), false);
  const next = hook.regenerateWebhookToken();
  assert.notEqual(next, info.token);
  assert.equal(hook.tokenMatches(info.token), false);
});

test('path mapping', () => {
  const m = [{ remotePath: '/movies', localPath: '/data/movies' }, { remotePath: '/movies/4k', localPath: '/mnt/uhd' }];
  assert.equal(hook.mapPath('/movies/Dune (2021)', m), '/data/movies/Dune (2021)');
  assert.equal(hook.mapPath('/movies/4k/Dune (2021)', m), '/mnt/uhd/Dune (2021)', 'longest prefix wins');
  assert.equal(hook.mapPath('/moviesextra/x', m), '/moviesextra/x', 'only whole path segments');
  assert.equal(hook.mapPath('D:\\Books\\Frank Herbert', [{ remotePath: 'd:\\books', localPath: '/data/books' }]), '/data/books/Frank Herbert');
});

const radarrImport = {
  eventType: 'Download', instanceName: 'radarr', isUpgrade: false,
  movie: { id: 5, title: 'Dune', year: 2021, folderPath: '/movies/Dune (2021)', tmdbId: 438631 },
  movieFile: { id: 9, relativePath: 'Dune (2021).mkv', path: '/movies/Dune (2021)/Dune (2021).mkv' },
};
const sonarrEpisode = (n: number) => ({
  eventType: 'Download', instanceName: 'sonarr',
  series: { id: 3, title: 'The Show', path: '/tv/The Show', tvdbId: 1234 },
  episodes: [{ id: 100 + n, seasonNumber: 2, episodeNumber: n }],
  episodeFile: { id: 200 + n, relativePath: `Season 02/The Show - S02E${String(n).padStart(2, '0')}.mkv`, path: `/tv/The Show/Season 02/The Show - S02E${String(n).padStart(2, '0')}.mkv` },
});

test('webhook payloads: affected folders for each *arr', () => {
  assert.deepEqual(hook.affectedPaths(radarrImport), ['/movies/Dune (2021)']);
  assert.deepEqual(hook.affectedPaths(sonarrEpisode(1)), ['/tv/The Show', '/tv/The Show/Season 02']);
  // Radarr file delete with only a relative path.
  assert.deepEqual(hook.affectedPaths({ eventType: 'MovieFileDelete', movie: { folderPath: '/movies/X' }, movieFile: { relativePath: 'X.mkv' } }), ['/movies/X']);
  assert.deepEqual(hook.affectedPaths({ eventType: 'Download', artist: { name: 'A', path: '/music/A' }, trackFiles: [{ path: '/music/A/Album/01.flac' }] }), ['/music/A', '/music/A/Album']);
  assert.deepEqual(hook.affectedPaths({ eventType: 'Download', author: { name: 'F', path: 'D:\\Books\\F' }, bookFiles: [{ path: 'D:\\Books\\F\\Dune\\dune.m4b' }] }), ['D:\\Books\\F', 'D:\\Books\\F\\Dune']);
  assert.equal(hook.payloadKind(radarrImport), 'radarr');
  assert.equal(hook.payloadKind(sonarrEpisode(1)), 'sonarr');
  assert.equal(hook.payloadKind({ artist: {} }), 'lidarr');
  assert.equal(hook.payloadKind({ author: {} }), 'readarr');
});

test('Radarr import → one targeted rescan of the movie library, then the availability check', async () => {
  scans.length = 0;
  const r = hook.handleWebhook(radarrImport);
  assert.deepEqual(r.paths, ['/data/movies/Dune (2021)']);
  assert.deepEqual(r.libraries, ['lib-movies']);
  await hook._flush();
  assert.deepEqual(scans, ['lib-movies']);
  const log = db.get<{ message: string }>("SELECT message FROM activity WHERE type = 'arr.webhook' ORDER BY id DESC LIMIT 1")!;
  assert.match(log.message, /imported Dune; rescanning lib-movies/);
});

test('a Sonarr season pack burst collapses into a single scan', async () => {
  scans.length = 0;
  for (let n = 1; n <= 12; n++) hook.handleWebhook(sonarrEpisode(n));
  hook.handleWebhook({ eventType: 'Rename', series: { id: 3, title: 'The Show', path: '/tv/The Show' } });
  hook.handleWebhook({ eventType: 'EpisodeFileDelete', series: { id: 3, title: 'The Show', path: '/tv/The Show' }, episodeFile: { relativePath: 'Season 02/old.mkv' } });
  await hook._flush();
  assert.deepEqual(scans, ['lib-tv']);
});

test('Lidarr, Readarr (Windows paths) and deletes trigger scans; Test/Grab/unknown folders do not', async () => {
  scans.length = 0;
  hook.handleWebhook({ eventType: 'Download', instanceName: 'lidarr', artist: { name: 'Test Artist', path: '/music/Test Artist' }, albums: [{ title: 'First Album' }], trackFiles: [{ path: '/music/Test Artist/First Album/01.flac' }] });
  hook.handleWebhook({ eventType: 'Download', instanceName: 'readarr', author: { name: 'Frank Herbert', path: 'D:\\Books\\Frank Herbert' }, book: { title: 'Dune' }, bookFiles: [{ path: 'D:\\Books\\Frank Herbert\\Dune\\Dune.m4b' }] });
  hook.handleWebhook({ eventType: 'MovieDelete', movie: { title: 'Gone', folderPath: '/movies/Gone (1999)' } });
  assert.deepEqual(hook.handleWebhook({ eventType: 'Test', movie: { title: 'Test', folderPath: '/movies/Test' } }).libraries, []);
  assert.deepEqual(hook.handleWebhook({ eventType: 'Grab', series: { title: 'The Show', path: '/tv/The Show' } }).libraries, []);
  const nowhere = hook.handleWebhook({ eventType: 'Download', movie: { title: 'Elsewhere', folderPath: '/somewhere/else' } });
  assert.deepEqual(nowhere.libraries, []);
  await hook._flush();
  assert.deepEqual([...scans].sort(), ['lib-books', 'lib-movies', 'lib-music']);
  assert.ok(db.get("SELECT 1 FROM activity WHERE type = 'arr.webhook' AND message LIKE '%webhook test received%'"));
  assert.ok(db.get("SELECT 1 FROM activity WHERE type = 'arr.webhook' AND severity = 'warning' AND message LIKE '%no library contains /somewhere/else%'"));
});

test('webhook route: bad token is rejected, good token is accepted', async () => {
  const { buildApp } = await import('../src/app.ts');
  const app = await buildApp();
  try {
    const bad = await app.inject({ method: 'POST', url: '/api/v1/arr/webhook/nope', payload: { eventType: 'Test' } });
    assert.equal(bad.statusCode, 401);
    const ok = await app.inject({ method: 'POST', url: `/api/v1/arr/webhook/${hook.webhookToken()}`, payload: { eventType: 'Test', movie: { title: 'x' } } });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().event, 'Test');
    const unauth = await app.inject({ method: 'GET', url: '/api/v1/arr/queue' });
    assert.equal(unauth.statusCode, 401);
  } finally {
    await app.close();
  }
});

test('Bazarr: subtitle search for a movie goes through its Radarr id', async () => {
  db.insert('items', { id: 'mov1', library_id: 'lib-movies', type: 'movie', title: 'Test Movie', sort_title: 'test movie', external_ids: JSON.stringify({ tmdb: '1' }), added_at: now, updated_at: now });
  // Radarr answers /movie?tmdbId= with the movie it manages.
  const orig = mocks.radarr;
  const extra = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/v3/movie?tmdbId=1')) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([{ id: 77, tmdbId: 1, title: 'Test Movie', titleSlug: 'test-movie-1', hasFile: true }]));
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((r) => extra.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(extra.address() as AddressInfo).port}`;
    settings.updateSettings({ arr: settings.getSettings().arr.map((i) => (i.id === 'radarr' ? { ...i, url, apiKey: settings.SECRET_MASK } : i)) });
    const info = await dash.itemInfo('mov1');
    assert.equal(info.bazarr, true);
    assert.equal(info.matches[0].arrId, 77);
    assert.equal(info.matches[0].webUrl, `${url}/movie/test-movie-1`);
    assert.equal(info.matches[0].searchCommand, 'MoviesSearch');
    const out = await dash.bazarrSearch('mov1');
    assert.match(out.message, /Test Movie/);
    assert.ok(mocks.bazarr.calls.some((c) => c.method === 'PATCH' && c.path === '/api/movies?radarrid=77&action=search-missing'));
  } finally {
    settings.updateSettings({ arr: settings.getSettings().arr.map((i) => (i.id === 'radarr' ? { ...i, url: orig.url, apiKey: settings.SECRET_MASK } : i)) });
    await new Promise((r) => extra.close(() => r(null)));
  }
});
