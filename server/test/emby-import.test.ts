import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { EmbyImportJob } from '@mediamax/shared';

/* ------------------------------------------------------------------ */
/* Stub Emby server                                                    */
/* ------------------------------------------------------------------ */

const KEY = 'emby-secret-api-key-123';
const ticks = (ms: number) => ms * 10000;

const FOLDERS = [
  { Name: 'Movies', ItemId: 'f1', Locations: ['D:\\Movies'] },
  { Name: 'TV', ItemId: 'f2', Locations: ['/data/tv'] },
  { Name: 'Kids', ItemId: 'f3', Locations: ['/srv/emby/kids'] },
  { Name: 'Music', ItemId: 'f4', Locations: ['/srv/music'] },
];

const policy = (p: Record<string, unknown> = {}) => ({
  IsAdministrator: false, IsHidden: false, IsDisabled: false, EnableRemoteAccess: true, EnableLiveTvAccess: true, EnableContentDownloading: true,
  EnableAllFolders: true, EnabledFolders: [], SimultaneousStreamLimit: 0, MaxParentalRating: null, ...p,
});
const USERS: { Id: string; Name: string; Policy: ReturnType<typeof policy>; LastActivityDate?: string }[] = [
  { Id: 'u-alice', Name: 'Alice', Policy: policy({ IsAdministrator: true }), LastActivityDate: '2026-11-01T10:00:00.0000000Z' },
  {
    Id: 'u-bob', Name: 'bob', Policy: policy({
      EnableAllFolders: false, EnabledFolders: ['f2', 'f3', 'f4'], SimultaneousStreamLimit: 2, EnableRemoteAccess: false, IsHidden: true,
      EnableLiveTvAccess: false, EnableContentDownloading: false, MaxParentalRating: 7,
    }),
  },
  { Id: 'u-carol', Name: 'Carol', Policy: policy({ IsDisabled: true }) },
  { Id: 'u-dave', Name: 'dave', Policy: policy() },
];

const SERIES = { Id: 'ser1', Name: 'Breaking Bad', Type: 'Series', ProductionYear: 2008, ProviderIds: { Tvdb: '81189' }, Path: '/data/tv/Breaking Bad' };
const MATRIX = { Id: 'em1', Name: 'The Matrix', Type: 'Movie', ProductionYear: 1999, ProviderIds: { Tmdb: '603', Imdb: 'tt0133093' }, Path: 'D:\\Movies\\The Matrix (1999)\\The Matrix.mkv' };
const HEAT = { Id: 'em2', Name: 'Heat', Type: 'Movie', ProductionYear: 1995, ProviderIds: {}, Path: 'D:\\Movies\\Heat (1995)\\Heat.mkv' };
const ALIEN = { Id: 'em3', Name: 'Alien', Type: 'Movie', ProductionYear: 1979, ProviderIds: {}, Path: 'D:\\Elsewhere\\alien.mkv' };
const NOPE = { Id: 'em4', Name: 'Not On Kinora', Type: 'Movie', ProductionYear: 2001, ProviderIds: { Tmdb: '999999' }, Path: 'D:\\Movies\\Nope\\nope.mkv' };
const EP1 = { Id: 'ee1', Name: 'Pilot', Type: 'Episode', SeriesId: 'ser1', SeriesName: 'Breaking Bad', ParentIndexNumber: 1, IndexNumber: 1, ProviderIds: {}, Path: '/srv/other/bb-s01e01.mkv' };
const EP2 = { Id: 'ee2', Name: 'Cat in the Bag', Type: 'Episode', SeriesId: 'ser1', SeriesName: 'Breaking Bad', ParentIndexNumber: 1, IndexNumber: 2, ProviderIds: {}, Path: '/srv/other/bb-s01e02.mkv' };
const ud = (o: Record<string, unknown>) => ({ Played: false, PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, ...o });

const DATA: Record<string, { played: any[]; resumable: any[]; favorites: any[]; playlists: { pl: any; items: any[] }[] }> = {
  'u-alice': { played: [{ ...MATRIX, UserData: ud({ Played: true, PlayCount: 2, LastPlayedDate: '2026-10-01T20:00:00.0000000Z' }) }], resumable: [], favorites: [], playlists: [] },
  'u-bob': {
    played: [
      { ...MATRIX, UserData: ud({ Played: true, PlayCount: 3, LastPlayedDate: '2026-09-01T20:00:00.0000000Z' }) },
      { ...HEAT, UserData: ud({ Played: true, PlayCount: 1 }) },
      { ...ALIEN, UserData: ud({ Played: true, PlayCount: 1 }) },
      { ...NOPE, UserData: ud({ Played: true, PlayCount: 1 }) },
      { ...EP1, UserData: ud({ Played: true, PlayCount: 1 }) },
    ],
    resumable: [{ ...EP2, UserData: ud({ PlaybackPositionTicks: ticks(600000), LastPlayedDate: '2026-10-05T21:00:00.0000000Z' }) }],
    favorites: [{ ...SERIES, UserData: ud({ IsFavorite: true }) }, { ...MATRIX, UserData: ud({ IsFavorite: true }) }],
    playlists: [{ pl: { Id: 'pl1', Name: 'Bob mix', Type: 'Playlist' }, items: [MATRIX, HEAT, NOPE] }],
  },
  'u-carol': { played: [{ ...HEAT, UserData: ud({ Played: true, PlayCount: 1 }) }], resumable: [], favorites: [], playlists: [] },
  'u-dave': {
    played: [{ ...MATRIX, UserData: ud({ Played: true, PlayCount: 1 }) }],
    // Watched on Kinora already (play count 5): an older Emby resume point must not un-watch it.
    resumable: [{ ...HEAT, UserData: ud({ PlaybackPositionTicks: ticks(120000), LastPlayedDate: '2020-01-01T00:00:00.0000000Z' }) }],
    favorites: [], playlists: [],
  },
};
const BOXSETS = [{ bs: { Id: 'bs1', Name: 'Heist Classics', Type: 'BoxSet' }, items: [HEAT, NOPE] }];

const calls: string[] = [];
function page(list: any[], q: URLSearchParams) {
  const start = Number(q.get('StartIndex') ?? 0);
  const limit = Number(q.get('Limit') ?? 1000);
  return { Items: list.slice(start, start + limit), TotalRecordCount: list.length };
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  calls.push(u.pathname + u.search);
  const send = (body: unknown, status = 200) => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  if (req.headers['x-emby-token'] !== KEY) return void res.writeHead(401).end('Access token is invalid or expired.');
  const q = u.searchParams;
  if (u.pathname === '/System/Info') return send({ Id: 'emby-server-1', ServerName: 'Old Emby', Version: '4.8.10.0' });
  if (u.pathname === '/Users') return send(USERS);
  if (u.pathname === '/Library/VirtualFolders') return send(FOLDERS);
  let m = u.pathname.match(/^\/Users\/([^/]+)\/Items$/);
  if (m) {
    const d = DATA[m[1]];
    if (!d) return send({ Items: [], TotalRecordCount: 0 });
    if (q.get('Ids')) return send({ Items: q.get('Ids')!.split(',').map((id) => (id === 'ser1' ? SERIES : null)).filter(Boolean) });
    if (q.get('ParentId')) return send(page(BOXSETS.find((b) => b.bs.Id === q.get('ParentId'))?.items ?? [], q));
    const types = q.get('IncludeItemTypes') ?? '';
    if (types === 'Playlist') return send(page(d.playlists.map((p) => p.pl), q));
    if (types === 'BoxSet') return send(page(BOXSETS.map((b) => b.bs), q));
    const f = q.get('Filters');
    return send(page(f === 'IsPlayed' ? d.played : f === 'IsResumable' ? d.resumable : f === 'IsFavorite' ? d.favorites : [], q));
  }
  m = u.pathname.match(/^\/Playlists\/([^/]+)\/Items$/);
  if (m) {
    const pl = DATA[q.get('UserId') ?? '']?.playlists.find((p) => p.pl.Id === m![1]);
    return send(page(pl?.items ?? [], q));
  }
  send({ message: 'not found' }, 404);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const EMBY_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/* ------------------------------------------------------------------ */
/* Kinora fixtures                                                   */
/* ------------------------------------------------------------------ */

const { db } = await import('../src/db.ts');
const auth = await import('../src/services/auth.ts');
const emby = await import('../src/services/embyImport.ts');
const links = await import('../src/services/passwordLinks.ts');
const { SECRET_MASK } = await import('../src/services/settings.ts');
const { buildApp } = await import('../src/app.ts');
const app = await buildApp();
after(async () => {
  await app.close();
  await new Promise<void>((r) => server.close(() => r()));
});

const now = new Date().toISOString();
for (const [id, name, type, p] of [['lib-movies', 'Films', 'movies', '/mnt/d/Movies'], ['lib-tv', 'Television', 'shows', '/data/tv'], ['lib-kids', 'Kids', 'movies', '/data/kids']]) {
  db.insert('libraries', { id, name, type, paths: JSON.stringify([p]), created_at: now });
}
const item = (id: string, library_id: string, type: string, title: string, extra: Record<string, unknown> = {}) =>
  db.insert('items', { id, library_id, type, title, sort_title: title.toLowerCase(), added_at: now, updated_at: now, ...extra });
item('m-matrix', 'lib-movies', 'movie', 'The Matrix', { year: 1999, external_ids: JSON.stringify({ tmdb: '603' }), path: '/mnt/d/Movies/The Matrix (1999)' });
item('m-heat', 'lib-movies', 'movie', 'Heat', { year: 1995, path: '/mnt/d/Movies/Heat (1995)' });
item('m-alien', 'lib-movies', 'movie', 'Alien', { year: 1979, path: '/mnt/d/Movies/Alien (1979)' });
item('s-bb', 'lib-tv', 'show', 'Breaking Bad', { year: 2008, external_ids: JSON.stringify({ tvdb: '81189' }), path: '/data/tv/Breaking Bad' });
item('se-bb1', 'lib-tv', 'season', 'Season 1', { parent_id: 's-bb', idx: 1 });
item('e-bb1', 'lib-tv', 'episode', 'Pilot', { parent_id: 'se-bb1', grandparent_id: 's-bb', parent_idx: 1, idx: 1, path: '/data/tv/Breaking Bad/S01E01.mkv' });
item('e-bb2', 'lib-tv', 'episode', 'Cat in the Bag', { parent_id: 'se-bb1', grandparent_id: 's-bb', parent_idx: 1, idx: 2, path: '/data/tv/Breaking Bad/S01E02.mkv' });
db.insert('media', { id: 'md-matrix', item_id: 'm-matrix', path: '/mnt/d/Movies/The Matrix (1999)/The Matrix.mkv' });
db.insert('media', { id: 'md-heat', item_id: 'm-heat', path: '/mnt/d/Movies/Heat (1995)/Heat.mkv' });

const admin = auth.createUser({ username: 'mmadmin', password: 'pass1234', isAdmin: true });
const viewer = auth.createUser({ username: 'viewer', password: 'pass1234' });
const dave = auth.createUser({ username: 'dave', password: 'davepass1' });
db.run('INSERT INTO user_data (user_id, item_id, played, play_count, last_played_at) VALUES (?, ?, 1, 5, ?)', dave.id, 'm-heat', '2026-01-01T00:00:00.000Z');
const dev = (id: string) => ({ deviceId: id, deviceName: 'test', platform: 'web' as const });
const adminTok = auth.issueToken(admin.id, dev('a')).token;
const viewerTok = auth.issueToken(viewer.id, dev('v')).token;
const as = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });

const ORIGIN = 'http://mediamax.test';
async function runToEnd(opts = {}): Promise<EmbyImportJob> {
  const job = emby.startImport(admin, opts, ORIGIN);
  for (let i = 0; i < 400 && emby.getJob()?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
  const done = emby.getJob()!;
  assert.equal(done.id, job.id);
  assert.equal(done.status, 'done', done.error ?? undefined);
  return done;
}
const userRow = (username: string) => db.get('SELECT * FROM users WHERE username = ?', username)!;
const udRow = (userId: string, itemId: string) => db.get('SELECT * FROM user_data WHERE user_id = ? AND item_id = ?', userId, itemId);

/* ------------------------------------------------------------------ */
/* Settings & secrets                                                  */
/* ------------------------------------------------------------------ */

test('settings: the API key is write-only (masked on GET, the mask keeps it)', async () => {
  let res = await app.inject({ method: 'PUT', url: '/api/v1/admin/emby-import/config', headers: as(adminTok), payload: JSON.stringify({ url: `${EMBY_URL}/`, apiKey: KEY, pathMappings: [{ from: 'D:\\Movies', to: '/mnt/d/Movies' }, { from: '', to: 'x' }] }) });
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.includes(KEY));
  assert.equal(res.json().apiKey, SECRET_MASK);
  assert.equal(res.json().url, EMBY_URL, 'trailing slash trimmed');
  assert.equal(res.json().pathMappings.length, 1, 'empty mappings dropped');

  res = await app.inject({ method: 'GET', url: '/api/v1/admin/emby-import/config', headers: as(adminTok) });
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.includes(KEY), 'GET settings never returns the key');
  assert.equal(res.json().apiKey, SECRET_MASK);

  // Saving the form back with the mask keeps the stored key.
  res = await app.inject({ method: 'PUT', url: '/api/v1/admin/emby-import/config', headers: as(adminTok), payload: JSON.stringify({ ...res.json(), apiKey: SECRET_MASK }) });
  assert.equal(res.statusCode, 200);
  assert.equal(emby.connection().apiKey, KEY);

  // Non-admins can't read or change it.
  for (const [method, url] of [['GET', '/api/v1/admin/emby-import/config'], ['PUT', '/api/v1/admin/emby-import/config'], ['GET', '/api/v1/admin/emby-import/preview'], ['POST', '/api/v1/admin/emby-import/run'], ['GET', '/api/v1/admin/emby-import/job']] as const) {
    assert.equal((await app.inject({ method, url, headers: as(viewerTok), payload: method === 'GET' ? undefined : '{}' })).statusCode, 403, `${method} ${url}`);
  }
  assert.ok(!(await app.inject({ method: 'GET', url: '/api/v1/system/info' })).body.includes(KEY));
});

test('connection test reports the server and rejects a wrong key', async () => {
  const ok = await app.inject({ method: 'POST', url: '/api/v1/admin/emby-import/test', headers: as(adminTok), payload: JSON.stringify({ apiKey: SECRET_MASK }) });
  assert.equal(ok.json().ok, true, ok.json().message);
  assert.equal(ok.json().version, '4.8.10.0');
  assert.equal(ok.json().users, 4);
  const bad = await emby.testConnection({ apiKey: 'wrong' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /rejected the API key/);
  const down = await emby.testConnection({ url: 'http://127.0.0.1:1' });
  assert.equal(down.ok, false);
  assert.match(down.message, /Can't reach Emby/);
});

/* ------------------------------------------------------------------ */
/* Mapping units                                                       */
/* ------------------------------------------------------------------ */

test('path mapping, rating and user mapping', () => {
  const maps = [{ from: 'D:\\Movies', to: '/mnt/d/Movies' }, { from: 'D:\\Movies\\4K', to: '/mnt/uhd' }];
  assert.equal(emby.mapPath('D:\\Movies\\Heat (1995)\\Heat.mkv', maps), '/mnt/d/Movies/Heat (1995)/Heat.mkv');
  assert.equal(emby.mapPath('d:\\movies\\4K\\Dune.mkv', maps), '/mnt/uhd/Dune.mkv', 'longest prefix wins, case-insensitive');
  assert.equal(emby.mapPath('D:\\MoviesExtra\\x.mkv', maps), 'D:/MoviesExtra/x.mkv', 'only whole path segments match');
  assert.equal(emby.embyRating(null), null);
  assert.equal(emby.embyRating(5), 'PG');
  assert.equal(emby.embyRating(7), 'PG-13');
  assert.equal(emby.embyRating(16), '16');
  assert.equal(emby.safeUsername('José Ü', 'abcdef123'), 'Jos_ _');

  const libs = emby.mapLibraries(FOLDERS, [{ from: 'D:\\Movies', to: '/mnt/d/Movies' }]);
  assert.deepEqual(libs.map((l) => [l.name, l.libraryId, l.method]), [['Movies', 'lib-movies', 'path'], ['TV', 'lib-tv', 'path'], ['Kids', 'lib-kids', 'name'], ['Music', null, null]]);

  const bob = emby.mapUser(USERS[1] as any, FOLDERS, libs);
  assert.deepEqual(bob.libraryIds, ['lib-tv', 'lib-kids']);
  assert.deepEqual(bob.unmappedFolders, ['Music']);
  assert.equal(bob.maxStreams, 2);
  assert.equal(bob.allowRemote, false);
  assert.equal(bob.allowLiveTv, false);
  assert.equal(bob.allowDownloads, false);
  assert.equal(bob.hiddenFromLogin, true);
  assert.equal(bob.maxContentRating, 'PG-13');
  const alice = emby.mapUser(USERS[0] as any, FOLDERS, libs);
  assert.equal(alice.isAdmin, true);
  assert.equal(alice.libraryIds, null, 'EnableAllFolders → all libraries');
  assert.equal(alice.maxStreams, null, 'Emby 0 streams = unlimited');
});

/* ------------------------------------------------------------------ */
/* Preview (dry run)                                                   */
/* ------------------------------------------------------------------ */

test('preview: users, library mapping and match counts, without changing anything', async () => {
  const before = db.get<{ n: number }>('SELECT COUNT(*) n FROM users')!.n;
  const res = await app.inject({ method: 'GET', url: '/api/v1/admin/emby-import/preview', headers: as(adminTok) });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(!res.body.includes(KEY));
  const p = res.json();
  assert.equal(p.server.name, 'Old Emby');
  assert.equal(p.users.length, 4);
  const by = Object.fromEntries(p.users.map((u: any) => [u.username, u]));
  assert.equal(by.Alice.action, 'create');
  assert.equal(by.bob.action, 'create');
  assert.equal(by.Carol.action, 'create');
  assert.equal(by.dave.action, 'merge');
  assert.equal(by.dave.existingUserId, dave.id);
  assert.deepEqual(by.bob.libraries, ['Television', 'Kids']);
  // Matrix + S01E01 by provider id (episode via the series' TVDB id + numbers), Heat by path, Alien by title+year, one unmatched.
  assert.deepEqual(by.bob.watched, { total: 5, matched: 4, byProviderId: 2, byPath: 1, byTitle: 1 });
  assert.equal(by.bob.resume.matched, 1);
  assert.deepEqual(by.bob.favorites, { total: 2, matched: 2, byProviderId: 2, byPath: 0, byTitle: 0 });
  assert.equal(by.bob.playlists, 1);
  assert.deepEqual([by.bob.playlistItems.total, by.bob.playlistItems.matched], [3, 2]);
  assert.equal(p.collections, 1);
  assert.deepEqual([p.collectionItems.total, p.collectionItems.matched], [2, 1]);
  assert.ok(p.unmatchedSamples.includes('Movie: Not On Kinora (2001)'));
  assert.deepEqual([p.totals.create, p.totals.merge], [3, 1]);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) n FROM users')!.n, before, 'a preview creates nobody');
  assert.equal(udRow(dave.id, 'm-matrix'), undefined, 'a preview writes no watch data');

  const q = await app.inject({ method: 'GET', url: '/api/v1/admin/emby-import/preview?includeDisabled=0&mergeExisting=0', headers: as(adminTok) });
  const by2 = Object.fromEntries(q.json().users.map((u: any) => [u.username, u]));
  assert.equal(by2.Carol.action, 'skip');
  assert.equal(by2.dave.action, 'skip');
});

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

let firstJob: EmbyImportJob;

test('import: creates accounts with mapped permissions, set-password links and watch data', async () => {
  firstJob = await runToEnd();
  const r = Object.fromEntries(firstJob.results.map((x) => [x.username, x]));
  assert.equal(r.Alice.status, 'created');
  assert.equal(r.bob.status, 'created');
  assert.equal(r.Carol.status, 'created');
  assert.equal(r.dave.status, 'merged');

  const bob = userRow('bob');
  assert.deepEqual(JSON.parse(bob.library_ids), ['lib-tv', 'lib-kids']);
  assert.equal(bob.allow_remote, 0);
  assert.equal(bob.allow_live_tv, 0);
  assert.equal(bob.allow_downloads, 0);
  assert.equal(bob.max_streams, 2);
  assert.equal(bob.show_on_signin, 0);
  assert.equal(bob.max_rating, 'PG-13');
  assert.equal(bob.is_admin, 0);
  assert.ok(bob.password_hash, 'an (unusable) password is set so the account is never passwordless');
  assert.match(r.bob.message ?? '', /Music/);
  const alice = userRow('Alice');
  assert.equal(alice.is_admin, 1);
  assert.equal(alice.library_ids, null);
  assert.equal(userRow('Carol').disabled, 1);
  assert.ok(!auth.publicProfiles().some((p) => p.username === 'bob'), 'hidden in Emby → hidden from the sign-in picker');

  // Links: for new, enabled accounts only.
  assert.match(r.Alice.setPasswordUrl ?? '', /^http:\/\/mediamax\.test\/set-password\/[\w-]{40,}$/);
  assert.ok(r.bob.setPasswordUrl);
  assert.equal(r.Carol.setPasswordUrl, null);
  assert.equal(r.dave.setPasswordUrl, null, 'existing accounts keep their password');
  assert.ok(!JSON.stringify(firstJob).includes(KEY));

  // Watch data.
  assert.equal(udRow(bob.id, 'm-matrix').played, 1);
  assert.equal(udRow(bob.id, 'm-matrix').play_count, 3);
  assert.equal(udRow(bob.id, 'm-matrix').favorite, 1);
  assert.equal(udRow(bob.id, 'm-matrix').last_played_at, '2026-09-01T20:00:00.000Z');
  assert.equal(udRow(bob.id, 'm-heat').played, 1);
  assert.equal(udRow(bob.id, 'm-alien').played, 1);
  assert.equal(udRow(bob.id, 'e-bb1').played, 1);
  assert.equal(udRow(bob.id, 'e-bb2').position_ms, 600000);
  assert.equal(udRow(bob.id, 'e-bb2').played, 0);
  assert.equal(udRow(bob.id, 's-bb').favorite, 1);
  assert.deepEqual([r.bob.watched, r.bob.resume, r.bob.favorites, r.bob.playlists, r.bob.unmatched], [4, 1, 2, 1, 2]);

  // Never downgrade: dave's Heat stays watched with its play count.
  assert.equal(udRow(dave.id, 'm-heat').played, 1);
  assert.equal(udRow(dave.id, 'm-heat').play_count, 5);
  assert.equal(udRow(dave.id, 'm-heat').position_ms, 0);
  assert.equal(udRow(dave.id, 'm-matrix').played, 1);

  // Playlist (owned by bob) and collection, with matched items only.
  const pl = db.get("SELECT * FROM items WHERE type = 'playlist' AND owner_id = ?", bob.id)!;
  assert.equal(pl.title, 'Bob mix');
  assert.deepEqual(db.all<{ item_id: string }>('SELECT item_id FROM collection_items WHERE collection_id = ? ORDER BY sort', pl.id).map((x) => x.item_id), ['m-matrix', 'm-heat']);
  const col = db.get("SELECT * FROM items WHERE type = 'collection' AND title = 'Heist Classics'")!;
  assert.deepEqual(db.all<{ item_id: string }>('SELECT item_id FROM collection_items WHERE collection_id = ?', col.id).map((x) => x.item_id), ['m-heat']);
  assert.deepEqual(firstJob.collections, { created: 1, updated: 0, items: 1 });

  assert.ok(db.get("SELECT 1 FROM activity WHERE type = 'emby.import' AND message LIKE 'Emby import finished%'"));
  const job = await app.inject({ method: 'GET', url: '/api/v1/admin/emby-import/job', headers: as(adminTok) });
  assert.equal(job.json().id, firstJob.id);
});

test('set-password link: preview, choose a password, sign in; single use', async () => {
  const url = firstJob.results.find((r) => r.username === 'Alice')!.setPasswordUrl!;
  const token = url.split('/').pop()!;
  const pv = await app.inject({ method: 'GET', url: `/api/v1/auth/password-link/${token}` });
  assert.equal(pv.statusCode, 200);
  assert.equal(pv.json().valid, true);
  assert.equal(pv.json().username, 'Alice');
  const short = await app.inject({ method: 'POST', url: `/api/v1/auth/password-link/${token}`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ password: 'short' }) });
  assert.equal(short.statusCode, 400);
  const ok = await app.inject({ method: 'POST', url: `/api/v1/auth/password-link/${token}`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ password: 'alice-new-pass' }) });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.ok(ok.json().token);
  assert.equal(auth.login('Alice', 'alice-new-pass', dev('x')).user.username, 'Alice');
  const again = await app.inject({ method: 'POST', url: `/api/v1/auth/password-link/${token}`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ password: 'another-pass' }) });
  assert.equal(again.statusCode, 403);
  assert.equal(links.previewPasswordLink(token).valid, false);
  assert.equal(links.previewPasswordLink('x'.repeat(43)).valid, false);
});

test('re-run is idempotent: no duplicate users, playlists or play counts; fresh links only for unclaimed accounts', async () => {
  const users = db.get<{ n: number }>('SELECT COUNT(*) n FROM users')!.n;
  const bob = userRow('bob');
  const job = await runToEnd();
  const r = Object.fromEntries(job.results.map((x) => [x.username, x]));
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) n FROM users')!.n, users);
  assert.equal(r.bob.status, 'merged');
  assert.equal(r.bob.userId, bob.id);
  assert.equal(udRow(bob.id, 'm-matrix').play_count, 3);
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) n FROM items WHERE type = 'playlist' AND owner_id = ?", bob.id)!.n, 1);
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) n FROM items WHERE type = 'collection' AND title = 'Heist Classics'")!.n, 1);
  assert.deepEqual(job.collections, { created: 0, updated: 1, items: 1 });
  assert.equal(r.Alice.setPasswordUrl, null, 'Alice already chose her password');
  assert.ok(r.bob.setPasswordUrl, 'bob has not: he gets a new link');
  // The previous link stops working once a new one is issued.
  const oldBob = firstJob.results.find((x) => x.username === 'bob')!.setPasswordUrl!.split('/').pop()!;
  assert.equal(links.previewPasswordLink(oldBob).valid, false);
  // Permissions were not touched without "update existing".
  db.run('UPDATE users SET max_streams = 9 WHERE id = ?', bob.id);
  await runToEnd();
  assert.equal(userRow('bob').max_streams, 9);
});

test('update existing: permissions are re-applied from Emby; the acting admin is never demoted', async () => {
  USERS[1].Policy.SimultaneousStreamLimit = 3;
  // An Emby non-admin with the same username as the Kinora admin running the import.
  USERS.push({ Id: 'u-mmadmin', Name: 'mmadmin', Policy: policy() });
  DATA['u-mmadmin'] = { played: [{ ...ALIEN, UserData: ud({ Played: true, PlayCount: 1 }) }], resumable: [], favorites: [], playlists: [] };
  const job = await runToEnd({ updateExisting: true, userIds: ['u-bob', 'u-mmadmin'] });
  assert.equal(job.results.length, 2);
  const r = Object.fromEntries(job.results.map((x) => [x.username, x]));
  assert.equal(r.bob.status, 'updated');
  assert.equal(userRow('bob').max_streams, 3);
  assert.equal(r.mmadmin.status, 'updated');
  assert.match(r.mmadmin.message ?? '', /Permissions not changed/);
  assert.equal(userRow('mmadmin').is_admin, 1);
  assert.equal(udRow(admin.id, 'm-alien').played, 1, 'watch data still merged');
});

test('only one import at a time', async () => {
  emby.startImport(admin, {}, ORIGIN);
  assert.throws(() => emby.startImport(admin, {}, ORIGIN), /already running/);
  for (let i = 0; i < 400 && emby.getJob()?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(emby.getJob()?.status, 'done');
});
