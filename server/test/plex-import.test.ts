import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ImportJob } from '@mediamax/shared';

/* ------------------------------------------------------------------ */
/* Stub Plex Media Server + stub plex.tv                               */
/* ------------------------------------------------------------------ */

const OWNER_TOKEN = 'plex-owner-token-AAAA';
const BOB_TOKEN = 'plex-shared-token-BBBB';
const MID = 'machine-1234';
const OWNER_ID = 100;
const BOB_ID = 200;
const KID_ID = 300;
const CAROL_ID = 400;

const SECTIONS = [
  { key: '1', title: 'Movies', type: 'movie', Location: [{ id: 1, path: '/plexdata/movies' }] },
  { key: '2', title: 'TV Shows', type: 'show', Location: [{ id: 2, path: '/plexdata/tv' }] },
  { key: '3', title: 'Music', type: 'artist', Location: [{ id: 3, path: '/plexdata/music' }] },
];
const part = (file: string) => [{ Part: [{ file }] }];
const MATRIX = { ratingKey: '11', type: 'movie', title: 'The Matrix', year: 1999, guid: 'plex://movie/5d776', Guid: [{ id: 'imdb://tt0133093' }, { id: 'tmdb://603' }], Media: part('/plexdata/movies/The Matrix (1999)/The Matrix.mkv') };
const HEAT = { ratingKey: '12', type: 'movie', title: 'Heat', year: 1995, guid: 'plex://movie/5d777', Guid: [], Media: part('/plexdata/movies/Heat (1995)/Heat.mkv') };
// Legacy agent: the IMDb id is only in `guid`.
const ALIEN = { ratingKey: '13', type: 'movie', title: 'Alien', year: 1979, guid: 'com.plexapp.agents.imdb://tt0078748?lang=en', Media: part('/elsewhere/alien.mkv') };
const NOPE = { ratingKey: '14', type: 'movie', title: 'Not On MediaMax', year: 2001, Guid: [{ id: 'tmdb://999999' }], Media: part('/plexdata/movies/nope.mkv') };
const BB = { ratingKey: '20', type: 'show', title: 'Breaking Bad', year: 2008, Guid: [{ id: 'tvdb://81189' }] };
const ep = (rk: string, i: number, title: string) => ({
  ratingKey: rk, type: 'episode', title, grandparentRatingKey: '20', grandparentTitle: 'Breaking Bad', grandparentGuid: 'plex://show/abc', parentIndex: 1, index: i, Guid: [], Media: part(`/plexdata/tv/bb/s01e0${i}.mkv`),
});
const EP1 = ep('21', 1, 'Pilot');
const EP2 = ep('22', 2, 'Cat in the Bag');
const MOVIES = [MATRIX, HEAT, ALIEN, NOPE];
const EPISODES = [EP1, EP2];

/** Per-token view state (owner and bob each see their own viewCount / viewOffset). */
const VIEW: Record<string, Record<string, { viewCount?: number; viewOffset?: number; lastViewedAt?: number }>> = {
  [OWNER_TOKEN]: { 11: { viewCount: 2, lastViewedAt: 1790000000 }, 22: { viewOffset: 600000, lastViewedAt: 1790100000 } },
  [BOB_TOKEN]: { 12: { viewCount: 1, lastViewedAt: 1790200000 }, 13: { viewOffset: 120000, lastViewedAt: 1790300000 }, 14: { viewCount: 1 } },
};
const HISTORY = [
  { ratingKey: '11', type: 'movie', title: 'The Matrix', viewedAt: 1789000000, accountID: 1 },
  { ratingKey: '11', type: 'movie', title: 'The Matrix', viewedAt: 1790000000, accountID: 1 },
  { ratingKey: '12', type: 'movie', title: 'Heat', viewedAt: 1790200000, accountID: BOB_ID },
  // The managed kid has no shared-server token: watched comes from here.
  { ratingKey: '11', type: 'movie', title: 'The Matrix', viewedAt: 1788000000, accountID: KID_ID },
  { ratingKey: '11', type: 'movie', title: 'The Matrix', viewedAt: 1788500000, accountID: KID_ID },
  { ratingKey: '21', type: 'episode', title: 'Pilot', grandparentTitle: 'Breaking Bad', viewedAt: 1788600000, accountID: KID_ID },
  { ratingKey: '999', type: 'movie', title: 'Deleted Film', viewedAt: 1788700000, accountID: KID_ID },
  { ratingKey: '31', type: 'track', title: 'A song', viewedAt: 1788800000, accountID: KID_ID },
];
const PLAYLISTS: Record<string, { pl: any; items: any[] }[]> = {
  [OWNER_TOKEN]: [{ pl: { ratingKey: '50', title: 'Owner faves', playlistType: 'video' }, items: [MATRIX, EP1] }],
  [BOB_TOKEN]: [{ pl: { ratingKey: '51', title: 'Bob picks', playlistType: 'video' }, items: [HEAT, NOPE] }],
};
const COLLECTIONS: Record<string, { col: any; items: any[] }[]> = { 1: [{ col: { ratingKey: '60', title: 'Heist Classics' }, items: [HEAT, NOPE] }] };

const pmsCalls: string[] = [];
const pmsTokens = new Set<string>();
const json = (res: http.ServerResponse, body: unknown, status = 200) => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
function container(res: http.ServerResponse, list: any[], q: URLSearchParams, key: 'Metadata' | 'Directory' = 'Metadata') {
  const start = Number(q.get('X-Plex-Container-Start') ?? 0);
  const size = q.has('X-Plex-Container-Size') ? Number(q.get('X-Plex-Container-Size')) : list.length;
  const slice = list.slice(start, start + size);
  json(res, { MediaContainer: { size: slice.length, totalSize: list.length, offset: start, [key]: slice.length ? slice : undefined } });
}
const pms = http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  pmsCalls.push(u.pathname + u.search);
  if (u.search.includes('Token')) return json(res, { error: 'token in the query string' }, 400);
  if (req.headers.accept !== 'application/json') return void res.writeHead(406).end('<xml/>');
  if (u.pathname === '/identity') return json(res, { MediaContainer: { size: 0, claimed: true, machineIdentifier: MID, version: '1.41.2.9200' } });
  const token = String(req.headers['x-plex-token'] ?? '');
  if (token !== OWNER_TOKEN && token !== BOB_TOKEN) return void res.writeHead(401).end('Unauthorized');
  pmsTokens.add(token);
  const q = u.searchParams;
  const isOwner = token === OWNER_TOKEN;
  if (u.pathname === '/') return json(res, { MediaContainer: { friendlyName: 'Living Room Plex', machineIdentifier: MID, version: '1.41.2.9200' } });
  if (u.pathname === '/library/sections') return container(res, isOwner ? SECTIONS : SECTIONS.slice(0, 1), q, 'Directory');
  let m = u.pathname.match(/^\/library\/sections\/(\d+)\/all$/);
  if (m) {
    const key = m[1];
    if (!isOwner && key !== '1') return void res.writeHead(403).end('Forbidden');
    const type = q.get('type');
    let list: any[] = key === '1' && type === '1' ? MOVIES : key === '2' && type === '2' ? [BB] : key === '2' && type === '4' ? EPISODES : [];
    // Guids only when asked; per-token view state.
    list = list.map((x) => {
      const v = VIEW[token]?.[x.ratingKey] ?? {};
      const o: any = { ...x, ...v };
      if (q.get('includeGuids') !== '1') delete o.Guid;
      return o;
    });
    if (q.get('unwatched') === '0') list = list.filter((x) => (x.viewCount ?? 0) > 0);
    if (q.get('inProgress') === '1') list = list.filter((x) => (x.viewOffset ?? 0) > 0);
    return container(res, list, q);
  }
  if (u.pathname === '/status/sessions/history/all') {
    if (!isOwner) return void res.writeHead(403).end('Forbidden');
    const acc = q.get('accountID');
    return container(res, HISTORY.filter((h) => !acc || String(h.accountID) === acc), q);
  }
  if (u.pathname === '/playlists') return container(res, (PLAYLISTS[token] ?? []).map((p) => p.pl), q);
  m = u.pathname.match(/^\/playlists\/(\d+)\/items$/);
  if (m) return container(res, (PLAYLISTS[token] ?? []).find((p) => p.pl.ratingKey === m![1])?.items ?? [], q);
  m = u.pathname.match(/^\/library\/sections\/(\d+)\/collections$/);
  if (m) return container(res, (COLLECTIONS[m[1]] ?? []).map((c) => c.col), q);
  m = u.pathname.match(/^\/library\/collections\/(\d+)\/children$/);
  if (m) return container(res, Object.values(COLLECTIONS).flat().find((c) => c.col.ratingKey === m![1])?.items ?? [], q);
  json(res, { error: 'not found' }, 404);
});

const tvCalls: string[] = [];
const plexTv = http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  tvCalls.push(u.pathname);
  if (req.headers['x-plex-token'] !== OWNER_TOKEN) return void res.writeHead(401).end('Unauthorized');
  const xml = (s: string) => void res.writeHead(200, { 'content-type': 'application/xml' }).end(`<?xml version="1.0" encoding="UTF-8"?>\n${s}`);
  if (u.pathname === '/api/v2/user') return json(res, { id: OWNER_ID, uuid: 'own-uuid', username: 'ownerx', title: 'Owner X', email: 'owner@example.com' });
  if (u.pathname === '/api/users') {
    return xml(`<MediaContainer friendlyName="myPlex" identifier="com.plexapp.plugins.myplex" size="3">
  <User id="${BOB_ID}" title="Bob B" username="bob" email="bob@example.com" home="0" restricted="0" allowSync="1" allowTuners="0" filterMovies="contentRating=G%2CPG%2CPG-13" filterTelevision="">
    <Server id="9" serverId="77" machineIdentifier="${MID}" name="Living Room Plex" lastSeenAt="1790000000" numLibraries="1" allLibraries="0" owned="1" pending="0"/>
  </User>
  <User id="${KID_ID}" title="Kiddo" username="" email="" home="1" restricted="1" allowSync="0" allowTuners="0" filterMovies="" filterTelevision="">
  </User>
  <User id="${CAROL_ID}" title="Carol" username="carol" email="carol@example.com" home="0" restricted="0">
    <Server id="10" serverId="78" machineIdentifier="other-server" name="Cabin Plex" numLibraries="2" allLibraries="1" owned="1" pending="0"/>
  </User>
</MediaContainer>`);
  }
  if (u.pathname === `/api/servers/${MID}/shared_servers`) {
    return xml(`<MediaContainer friendlyName="myPlex" machineIdentifier="${MID}" size="1">
  <SharedServer id="999" username="bob" email="bob@example.com" userID="${BOB_ID}" accessToken="${BOB_TOKEN}" name="Living Room Plex" allowSync="1" allowTuners="0" owned="0" allLibraries="0">
    <Section id="5001" key="1" title="Movies" type="movie" shared="1"/>
    <Section id="5002" key="2" title="TV Shows" type="show" shared="0"/>
  </SharedServer>
</MediaContainer>`);
  }
  res.writeHead(404).end('Not found');
});
await new Promise<void>((r) => pms.listen(0, '127.0.0.1', r));
await new Promise<void>((r) => plexTv.listen(0, '127.0.0.1', r));
const PMS_URL = `http://127.0.0.1:${(pms.address() as AddressInfo).port}`;
// plex.tv goes through the SSRF guard: allow the loopback stub.
process.env.MEDIAMAX_PLEX_TV_URL = `http://127.0.0.1:${(plexTv.address() as AddressInfo).port}`;
process.env.MEDIAMAX_ALLOW_PRIVATE_URLS = '1';

/* ------------------------------------------------------------------ */
/* MediaMax fixtures                                                   */
/* ------------------------------------------------------------------ */

const { db } = await import('../src/db.ts');
const auth = await import('../src/services/auth.ts');
const imp = await import('../src/services/import/index.ts');
const plex = await import('../src/services/import/plex.ts');
const { SECRET_MASK } = await import('../src/services/settings.ts');
const { buildApp } = await import('../src/app.ts');
const app = await buildApp();
after(async () => {
  await app.close();
  await new Promise<void>((r) => pms.close(() => r()));
  await new Promise<void>((r) => plexTv.close(() => r()));
});

const now = new Date().toISOString();
for (const [id, name, type, p] of [['lib-movies', 'Films', 'movies', '/mnt/movies'], ['lib-tv', 'Television', 'shows', '/mnt/tv']]) {
  db.insert('libraries', { id, name, type, paths: JSON.stringify([p]), created_at: now });
}
const item = (id: string, library_id: string, type: string, title: string, extra: Record<string, unknown> = {}) =>
  db.insert('items', { id, library_id, type, title, sort_title: title.toLowerCase(), added_at: now, updated_at: now, ...extra });
item('m-matrix', 'lib-movies', 'movie', 'The Matrix', { year: 1999, external_ids: JSON.stringify({ tmdb: '603' }), duration_ms: 8160000 });
item('m-heat', 'lib-movies', 'movie', 'Heat', { year: 1995 });
item('m-alien', 'lib-movies', 'movie', 'Alien', { year: 1980, external_ids: JSON.stringify({ imdb: 'tt0078748' }) });
item('s-bb', 'lib-tv', 'show', 'Breaking Bad', { year: 2008, external_ids: JSON.stringify({ tvdb: '81189' }) });
item('e-bb1', 'lib-tv', 'episode', 'Pilot', { grandparent_id: 's-bb', parent_idx: 1, idx: 1, duration_ms: 3480000 });
item('e-bb2', 'lib-tv', 'episode', 'Cat in the Bag', { grandparent_id: 's-bb', parent_idx: 1, idx: 2 });
db.insert('media', { id: 'md-heat', item_id: 'm-heat', path: '/mnt/movies/Heat (1995)/Heat.mkv' });

const admin = auth.createUser({ username: 'mmadmin', password: 'pass1234', isAdmin: true });
const viewer = auth.createUser({ username: 'viewer', password: 'pass1234' });
const dev = (id: string) => ({ deviceId: id, deviceName: 'test', platform: 'web' as const });
const adminTok = auth.issueToken(admin.id, dev('a')).token;
const viewerTok = auth.issueToken(viewer.id, dev('v')).token;
const as = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });
const ORIGIN = 'http://mediamax.test';
const noTokens = (s: string) => !s.includes(OWNER_TOKEN) && !s.includes(BOB_TOKEN);

async function runToEnd(opts = {}): Promise<ImportJob> {
  const job = imp.startImport('plex', admin, opts, ORIGIN);
  for (let i = 0; i < 400 && imp.getJob()?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
  const done = imp.getJob()!;
  assert.equal(done.id, job.id);
  assert.equal(done.status, 'done', done.error ?? undefined);
  return done;
}
const userRow = (username: string) => db.get('SELECT * FROM users WHERE username = ?', username)!;
const udRow = (userId: string, itemId: string) => db.get('SELECT * FROM user_data WHERE user_id = ? AND item_id = ?', userId, itemId);
const count = (sql: string, ...p: unknown[]) => db.get<{ n: number }>(sql, ...p)!.n;

/* ------------------------------------------------------------------ */

test('plex settings: the token is write-only; non-admins are refused', async () => {
  let res = await app.inject({ method: 'PUT', url: '/api/v1/admin/import/plex/config', headers: as(adminTok), payload: JSON.stringify({ url: `${PMS_URL}/`, apiKey: OWNER_TOKEN, pathMappings: [{ from: '/plexdata', to: '/mnt' }] }) });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(noTokens(res.body));
  res = await app.inject({ method: 'GET', url: '/api/v1/admin/import/plex/config', headers: as(adminTok) });
  assert.ok(noTokens(res.body), 'GET never returns the token');
  assert.equal(res.json().apiKey, SECRET_MASK);
  assert.equal(res.json().url, PMS_URL);
  for (const [method, url] of [['GET', '/api/v1/admin/import/plex/config'], ['GET', '/api/v1/admin/import/plex/preview'], ['POST', '/api/v1/admin/import/plex/run'], ['GET', '/api/v1/admin/import/job']] as const) {
    assert.equal((await app.inject({ method, url, headers: as(viewerTok), payload: method === 'GET' ? undefined : '{}' })).statusCode, 403, `${method} ${url}`);
  }
});

test('plex connection test: server name and users (friends of other servers left out)', async () => {
  const ok = await app.inject({ method: 'POST', url: '/api/v1/admin/import/plex/test', headers: as(adminTok), payload: JSON.stringify({ apiKey: SECRET_MASK }) });
  assert.equal(ok.json().ok, true, ok.json().message);
  assert.equal(ok.json().serverName, 'Living Room Plex');
  assert.equal(ok.json().users, 3, 'owner, bob, kid (not carol)');
  assert.ok(noTokens(ok.body));
  const bad = await imp.testConnection('plex', { apiKey: 'nope' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /Plex rejected the token/);
  assert.ok(pmsCalls.every((c) => !c.includes('Token')), 'tokens only ever go in headers');
});

test('plex guid parsing and rating filters', () => {
  assert.deepEqual(plex.plexIds(MATRIX as any), { imdb: 'tt0133093', tmdb: '603' });
  assert.deepEqual(plex.plexIds(ALIEN as any), { imdb: 'tt0078748' });
  assert.deepEqual(plex.plexIds({ type: 'show', guid: 'com.plexapp.agents.thetvdb://81189?lang=en' } as any), { tvdb: '81189' });
  assert.deepEqual(plex.plexIds({ type: 'episode', guid: 'com.plexapp.agents.thetvdb://81189/1/1?lang=en' } as any), {}, "a legacy episode guid is the show's id");
  assert.deepEqual(plex.plexFilterRating(['contentRating=G%2CPG%2CPG-13']), { rating: 'PG-13', deny: false });
  assert.deepEqual(plex.plexFilterRating(['contentRating=PG', 'contentRating=TV-14|label=kids']), { rating: 'PG', deny: false }, 'strictest across filters');
  assert.deepEqual(plex.plexFilterRating(['contentRating!=R']), { rating: null, deny: true });
});

test('plex quick preview uses count-only requests', async () => {
  pmsCalls.length = 0;
  const res = await app.inject({ method: 'GET', url: '/api/v1/admin/import/plex/preview?quick=1', headers: as(adminTok) });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(noTokens(res.body));
  const p = res.json();
  assert.equal(p.quick, true);
  const by = Object.fromEntries(p.users.map((u: any) => [u.username, u]));
  assert.deepEqual([by.ownerx.watched.total, by.ownerx.resume.total, by.ownerx.history.total, by.ownerx.playlists], [1, 1, 2, 1]);
  assert.deepEqual([by.bob.watched.total, by.bob.resume.total, by.bob.playlists], [2, 1, 1]);
  assert.deepEqual([by.Kiddo.watched.total], [5]);
  assert.equal(p.collections, 1);
  assert.ok(pmsCalls.filter((c) => c.startsWith('/library/sections/')).every((c) => c.includes('X-Plex-Container-Size=0')), 'no item lists in a quick preview');
});

test('plex full preview: users, permissions, libraries and matches by guid / path / title', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/admin/import/plex/preview', headers: as(adminTok) });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(noTokens(res.body));
  const p = res.json();
  assert.equal(p.server.name, 'Living Room Plex');
  assert.deepEqual(p.libraries.map((l: any) => [l.name, l.libraryId, l.method]), [['Movies', 'lib-movies', 'path'], ['TV Shows', 'lib-tv', 'path'], ['Music', null, null]]);
  assert.deepEqual(p.users.map((u: any) => u.username), ['ownerx', 'bob', 'Kiddo']);
  const by = Object.fromEntries(p.users.map((u: any) => [u.username, u]));
  assert.equal(by.ownerx.isAdmin, true);
  assert.equal(by.ownerx.libraries, null);
  assert.deepEqual(by.bob.libraries, ['Films'], 'only the shared section');
  assert.equal(by.bob.maxContentRating, 'PG-13');
  assert.equal(by.bob.allowDownloads, true);
  assert.equal(by.bob.allowLiveTv, false);
  assert.equal(by.bob.hidden, true, 'friends are not on the sign-in screen');
  assert.equal(by.Kiddo.maxContentRating, 'PG');
  assert.equal(by.Kiddo.hidden, false);
  assert.match(by.Kiddo.notes.join(), /play history only/);
  // Owner: Matrix by guid; resume on S01E02 via the show's TVDB id + numbers.
  assert.deepEqual(by.ownerx.watched, { total: 1, matched: 1, byProviderId: 1, byPath: 0, byTitle: 0 });
  assert.deepEqual([by.ownerx.resume.matched, by.ownerx.resume.byProviderId], [1, 1]);
  // Bob (his own token): Heat by path, Not On MediaMax unmatched; Alien resume by the legacy IMDb guid.
  assert.deepEqual(by.bob.watched, { total: 2, matched: 1, byProviderId: 0, byPath: 1, byTitle: 0 });
  assert.deepEqual([by.bob.resume.matched, by.bob.resume.byProviderId], [1, 1]);
  assert.deepEqual([by.bob.playlistItems.total, by.bob.playlistItems.matched], [2, 1]);
  // Kid (no token): watched from history: Matrix, Pilot, a deleted film (tracks ignored).
  assert.deepEqual([by.Kiddo.watched.total, by.Kiddo.watched.matched], [3, 2]);
  assert.equal(by.Kiddo.resume.total, 0);
  assert.ok(p.unmatchedSamples.includes('Movie: Not On MediaMax (2001)'));
  assert.deepEqual([p.collections, p.collectionItems.matched], [1, 1]);
  assert.match(p.notes.join(), /no favourites/);
  assert.ok(pmsTokens.has(BOB_TOKEN), "bob's own token read his state");
});

let first: ImportJob;
test('plex import: accounts, shared-user tokens, managed-user history fallback, history rows, playlists, collections', async () => {
  first = await runToEnd();
  assert.equal(first.source, 'plex');
  assert.ok(noTokens(JSON.stringify(first)));
  assert.ok(noTokens((await app.inject({ method: 'GET', url: '/api/v1/admin/import/job', headers: as(adminTok) })).body));
  const r = Object.fromEntries(first.results.map((x) => [x.username, x]));
  assert.deepEqual(Object.keys(r).sort(), ['Kiddo', 'bob', 'ownerx']);
  assert.ok(r.bob.setPasswordUrl);
  assert.ok(r.Kiddo.setPasswordUrl);

  const owner = userRow('ownerx');
  const bob = userRow('bob');
  const kid = userRow('Kiddo');
  assert.equal(owner.is_admin, 1);
  assert.equal(owner.display_name, 'Owner X');
  assert.equal(bob.is_admin, 0);
  assert.deepEqual(JSON.parse(bob.library_ids), ['lib-movies']);
  assert.equal(bob.max_rating, 'PG-13');
  assert.equal(bob.allow_downloads, 1);
  assert.equal(bob.allow_live_tv, 0);
  assert.equal(bob.show_on_signin, 0);
  assert.equal(kid.max_rating, 'PG');
  assert.equal(kid.show_on_signin, 1);
  assert.equal(kid.allow_downloads, 0);
  assert.ok(!('email' in owner), 'MediaMax stores no e-mail address');

  // Owner (owner token): watched + resume + history from accountID 1.
  assert.equal(udRow(owner.id, 'm-matrix').played, 1);
  assert.equal(udRow(owner.id, 'm-matrix').play_count, 2);
  assert.equal(udRow(owner.id, 'm-matrix').last_played_at, new Date(1790000000 * 1000).toISOString());
  assert.equal(udRow(owner.id, 'e-bb2').position_ms, 600000);
  assert.equal(r.ownerx.history, 2);
  // Bob (shared-server token): his own watched and resume, not the owner's.
  assert.equal(udRow(bob.id, 'm-heat').played, 1);
  assert.equal(udRow(bob.id, 'm-alien').position_ms, 120000);
  assert.equal(udRow(bob.id, 'm-matrix'), undefined);
  assert.equal(r.bob.history, 1);
  // Kid (no token): watched from history with play count and last viewing; no resume.
  assert.equal(udRow(kid.id, 'm-matrix').played, 1);
  assert.equal(udRow(kid.id, 'm-matrix').play_count, 2);
  assert.equal(udRow(kid.id, 'm-matrix').last_played_at, new Date(1788500000 * 1000).toISOString());
  assert.equal(udRow(kid.id, 'e-bb1').played, 1);
  assert.equal(r.Kiddo.history, 3);
  const h = db.get("SELECT * FROM play_history WHERE user_id = ? AND item_id = 'e-bb1'", kid.id)!;
  assert.equal(h.started_at, new Date(1788600000 * 1000).toISOString());
  assert.equal(h.duration_ms, 3480000, "no Plex duration: the item's runtime");
  assert.equal(h.platform, 'plex');
  assert.match(r.Kiddo.message ?? '', /play history only/);

  // Playlists per user token, collections server-wide; matched items only.
  const opl = db.get("SELECT * FROM items WHERE type = 'playlist' AND owner_id = ?", owner.id)!;
  assert.equal(opl.title, 'Owner faves');
  assert.deepEqual(db.all<{ item_id: string }>('SELECT item_id FROM collection_items WHERE collection_id = ? ORDER BY sort', opl.id).map((x) => x.item_id), ['m-matrix', 'e-bb1']);
  const bpl = db.get("SELECT * FROM items WHERE type = 'playlist' AND owner_id = ?", bob.id)!;
  assert.deepEqual(db.all<{ item_id: string }>('SELECT item_id FROM collection_items WHERE collection_id = ?', bpl.id).map((x) => x.item_id), ['m-heat']);
  assert.equal(count("SELECT COUNT(*) n FROM items WHERE type = 'playlist' AND owner_id = ?", kid.id), 0);
  assert.deepEqual(first.collections, { created: 1, updated: 0, items: 1 });
  assert.ok(db.get("SELECT 1 FROM activity WHERE type = 'plex.import' AND message LIKE 'Plex import finished%'"));
  assert.ok(tvCalls.includes(`/api/servers/${MID}/shared_servers`));
});

test('plex re-run is idempotent', async () => {
  const before = {
    users: count('SELECT COUNT(*) n FROM users'), history: count('SELECT COUNT(*) n FROM play_history'),
    playlists: count("SELECT COUNT(*) n FROM items WHERE type = 'playlist'"), items: count('SELECT COUNT(*) n FROM collection_items'),
  };
  VIEW[OWNER_TOKEN][11].viewCount = 1; // lower on Plex: must not lower here
  const job = await runToEnd();
  assert.ok(job.results.every((x) => x.status === 'merged'), JSON.stringify(job.results.map((x) => x.status)));
  assert.ok(job.results.every((x) => x.history === 0));
  assert.deepEqual({
    users: count('SELECT COUNT(*) n FROM users'), history: count('SELECT COUNT(*) n FROM play_history'),
    playlists: count("SELECT COUNT(*) n FROM items WHERE type = 'playlist'"), items: count('SELECT COUNT(*) n FROM collection_items'),
  }, before);
  assert.equal(udRow(userRow('ownerx').id, 'm-matrix').play_count, 2);
  assert.deepEqual(job.collections, { created: 0, updated: 1, items: 1 });
  // Only one import at a time, whatever the source.
  imp.startImport('plex', admin, {}, ORIGIN);
  assert.throws(() => imp.startImport('emby', admin, {}, ORIGIN), /already running|Enter the address/);
  for (let i = 0; i < 400 && imp.getJob()?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
});
