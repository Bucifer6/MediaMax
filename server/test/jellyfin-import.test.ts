import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ImportJob } from '@mediamax/shared';

/* ------------------------------------------------------------------ */
/* Stub Jellyfin 10.10 server                                          */
/* ------------------------------------------------------------------ */

const KEY = 'jellyfin-secret-api-key-456';
const ticks = (ms: number) => ms * 10000;

// Jellyfin lists libraries by GUID (no dashes) and policies refer to them with dashes.
const G_MOVIES = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const G_TV = '1a2b3c4d5e6f708192a3b4c5d6e7f809';
const dashed = (g: string) => `${g.slice(0, 8)}-${g.slice(8, 12)}-${g.slice(12, 16)}-${g.slice(16, 20)}-${g.slice(20)}`;
const FOLDERS = [
  { Name: 'Movies', ItemId: G_MOVIES, Locations: ['/media/movies'] },
  { Name: 'Shows', ItemId: G_TV, Locations: ['/media/tv'] },
];

const policy = (p: Record<string, unknown> = {}) => ({
  IsAdministrator: false, IsHidden: false, IsDisabled: false, EnableRemoteAccess: true, EnableLiveTvAccess: true, EnableContentDownloading: true,
  EnableAllFolders: true, EnabledFolders: [], MaxActiveSessions: 0, MaxParentalRating: null, BlockedTags: [], ...p,
});
const U_ADMIN = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';
const U_KID = '11111111222233334444555555555555';
const USERS = [
  { Id: U_ADMIN, Name: 'jfadmin', Policy: policy({ IsAdministrator: true }), LastActivityDate: '2026-11-01T10:00:00.0000000Z' },
  {
    Id: U_KID, Name: 'kiddo', Policy: policy({
      EnableAllFolders: false, EnabledFolders: [dashed(G_TV)], MaxActiveSessions: 2, EnableRemoteAccess: false, IsHidden: true,
      EnableLiveTvAccess: false, EnableContentDownloading: false, MaxParentalRating: 13, BlockedTags: ['horror'],
    }),
  },
];

const SERIES = { Id: 'jser1', Name: 'Breaking Bad', Type: 'Series', ProductionYear: 2008, ProviderIds: { Tvdb: '81189' }, Path: '/media/tv/Breaking Bad' };
const MATRIX = { Id: 'jm1', Name: 'The Matrix', Type: 'Movie', ProductionYear: 1999, ProviderIds: { Tmdb: '603' }, Path: '/media/movies/The Matrix (1999)/The Matrix.mkv' };
const HEAT = { Id: 'jm2', Name: 'Heat', Type: 'Movie', ProductionYear: 1995, ProviderIds: {}, Path: '/media/movies/Heat (1995)/Heat.mkv' };
const ALIEN = { Id: 'jm3', Name: 'Alien', Type: 'Movie', ProductionYear: 1979, ProviderIds: {}, Path: '/nowhere/alien.mkv' };
const EP1 = { Id: 'je1', Name: 'Pilot', Type: 'Episode', SeriesId: 'jser1', SeriesName: 'Breaking Bad', ParentIndexNumber: 1, IndexNumber: 1, ProviderIds: {}, Path: '/x/e1.mkv' };
const EP2 = { Id: 'je2', Name: 'Cat in the Bag', Type: 'Episode', SeriesId: 'jser1', SeriesName: 'Breaking Bad', ParentIndexNumber: 1, IndexNumber: 2, ProviderIds: {}, Path: '/x/e2.mkv' };
const ALL = [SERIES, MATRIX, HEAT, ALIEN, EP1, EP2];
const ud = (o: Record<string, unknown>) => ({ Played: false, PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, ...o });

const DATA: Record<string, { played: any[]; resumable: any[]; favorites: any[]; playlists: { pl: any; items: any[] }[] }> = {
  [U_ADMIN]: {
    played: [{ ...MATRIX, UserData: ud({ Played: true, PlayCount: 4, LastPlayedDate: '2026-10-01T20:00:00.0000000Z' }) }, { ...HEAT, UserData: ud({ Played: true, PlayCount: 1 }) }],
    resumable: [{ ...ALIEN, UserData: ud({ PlaybackPositionTicks: ticks(900000), LastPlayedDate: '2026-10-02T20:00:00.0000000Z' }) }],
    favorites: [{ ...MATRIX, UserData: ud({ IsFavorite: true }) }],
    playlists: [{ pl: { Id: 'jpl1', Name: 'Admin mix', Type: 'Playlist' }, items: [HEAT, MATRIX] }],
  },
  [U_KID]: {
    played: [{ ...EP1, UserData: ud({ Played: true, PlayCount: 2, LastPlayedDate: '2026-09-01T18:00:00.0000000Z' }) }],
    resumable: [{ ...EP2, UserData: ud({ PlaybackPositionTicks: ticks(300000), LastPlayedDate: '2026-09-02T18:00:00.0000000Z' }) }],
    favorites: [{ ...SERIES, UserData: ud({ IsFavorite: true }) }],
    playlists: [],
  },
};
const BOXSETS = [{ bs: { Id: 'jbs1', Name: 'Sci-fi', Type: 'BoxSet' }, items: [MATRIX, ALIEN] }];
// Playback Reporting rows (UserId stored without dashes; local time, no zone; PlayDuration in seconds).
const REPORT = [
  { DateCreated: '2026-10-01 20:00:00.1234567', UserId: U_ADMIN, ItemId: 'jm1', PlayDuration: 7800, ClientName: 'Jellyfin Web' },
  { DateCreated: '2026-10-03 21:00:00.0000000', UserId: U_ADMIN, ItemId: 'jm2', PlayDuration: 600, ClientName: 'Android TV' },
  { DateCreated: '2026-10-04 21:00:00.0000000', UserId: U_ADMIN, ItemId: 'deadbeef', PlayDuration: 600, ClientName: 'Android TV' },
  { DateCreated: '2026-09-01 18:00:00.0000000', UserId: U_KID, ItemId: 'je1', PlayDuration: 2700, ClientName: 'Roku' },
];

const stub = { reporting: true, legacyItemsGone: true };
const calls: { path: string; auth: string | undefined; legacy: string | undefined }[] = [];
const sqls: string[] = [];
function page(list: any[], q: URLSearchParams) {
  const start = Number(q.get('StartIndex') ?? 0);
  const limit = Number(q.get('Limit') ?? 1000);
  return { Items: list.slice(start, start + limit), TotalRecordCount: list.length };
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  calls.push({ path: u.pathname + u.search, auth: req.headers.authorization, legacy: req.headers['x-emby-token'] as string | undefined });
  const send = (body: unknown, status = 200) => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  // Jellyfin accepts the MediaBrowser Authorization header, or the legacy X-Emby-Token.
  const token = /Token="([^"]+)"/.exec(req.headers.authorization ?? '')?.[1] ?? req.headers['x-emby-token'];
  if (token !== KEY) return void res.writeHead(401).end('Unauthorized');
  // ASP.NET binds query names case-insensitively.
  const q = new URLSearchParams([...u.searchParams].map(([k, v]) => [k.toLowerCase(), v]));
  const get = (k: string) => q.get(k.toLowerCase());
  if (u.pathname === '/System/Info') return send({ Id: 'jf-1', ServerName: 'Jelly', Version: '10.10.3', ProductName: 'Jellyfin Server' });
  if (u.pathname === '/Users') return send(USERS);
  if (u.pathname === '/Library/VirtualFolders') return send(FOLDERS);
  if (u.pathname === '/user_usage_stats/submit_custom_query' && req.method === 'POST') {
    if (!stub.reporting) return send({ message: 'not found' }, 404);
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const sql = String(JSON.parse(body).CustomQueryString);
      sqls.push(sql);
      const uid = /= '([0-9a-f]+)'/.exec(sql)?.[1];
      const rows = REPORT.filter((r) => !uid || r.UserId === uid);
      if (/COUNT\(\*\)/i.test(sql)) return send({ colums: ['COUNT(*)'], results: [[String(rows.length)]], message: '' });
      const offset = Number(/OFFSET (\d+)/.exec(sql)?.[1] ?? 0);
      send({ colums: ['DateCreated', 'ItemId', 'PlayDuration', 'ClientName'], results: rows.slice(offset).map((r) => [r.DateCreated, r.ItemId, String(r.PlayDuration), r.ClientName]), message: '' });
    });
    return;
  }
  // 10.9+: /Users/{id}/Items is gone; /Items?userId= replaces it.
  let m = u.pathname.match(/^\/Users\/([^/]+)\/Items$/);
  if (m && stub.legacyItemsGone) return send({ message: 'not found' }, 404);
  const userId = m ? m[1] : u.pathname === '/Items' ? get('userId') : null;
  if (userId !== null) {
    const d = DATA[userId ?? ''];
    if (!d) return send({ Items: [], TotalRecordCount: 0 });
    // Emby-only field names would be rejected by Jellyfin.
    if ((get('Fields') ?? '').includes('UserData')) return send({ message: 'bad field' }, 400);
    if (get('Ids')) return send({ Items: get('Ids')!.split(',').map((id) => ALL.find((x) => x.Id === id)).filter(Boolean) });
    if (get('ParentId')) return send(page(BOXSETS.find((b) => b.bs.Id === get('ParentId'))?.items ?? [], q));
    const types = get('IncludeItemTypes') ?? '';
    if (types === 'Playlist') return send(page(d.playlists.map((p) => p.pl), q));
    if (types === 'BoxSet') return send(page(BOXSETS.map((b) => b.bs), q));
    const f = get('Filters');
    return send(page(f === 'IsPlayed' ? d.played : f === 'IsResumable' ? d.resumable : f === 'IsFavorite' ? d.favorites : [], q));
  }
  m = u.pathname.match(/^\/Playlists\/([^/]+)\/Items$/);
  if (m) {
    const pl = DATA[get('userId') ?? '']?.playlists.find((p) => p.pl.Id === m![1]);
    return send(page(pl?.items ?? [], q));
  }
  send({ message: 'not found' }, 404);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const JF_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/* ------------------------------------------------------------------ */
/* Kinora fixtures                                                   */
/* ------------------------------------------------------------------ */

const { db } = await import('../src/db.ts');
const auth = await import('../src/services/auth.ts');
const imp = await import('../src/services/import/index.ts');
const { mapEmbyUser, embyFolder } = await import('../src/services/import/emby.ts');
const { mapFolders } = await import('../src/services/import/common.ts');
const { SECRET_MASK } = await import('../src/services/settings.ts');
const { buildApp } = await import('../src/app.ts');
const app = await buildApp();
after(async () => {
  await app.close();
  await new Promise<void>((r) => server.close(() => r()));
});

const now = new Date().toISOString();
for (const [id, name, type, p] of [['lib-movies', 'Films', 'movies', '/mnt/movies'], ['lib-tv', 'Television', 'shows', '/mnt/tv']]) {
  db.insert('libraries', { id, name, type, paths: JSON.stringify([p]), created_at: now });
}
const item = (id: string, library_id: string, type: string, title: string, extra: Record<string, unknown> = {}) =>
  db.insert('items', { id, library_id, type, title, sort_title: title.toLowerCase(), added_at: now, updated_at: now, ...extra });
item('m-matrix', 'lib-movies', 'movie', 'The Matrix', { year: 1999, external_ids: JSON.stringify({ tmdb: '603' }), duration_ms: 8160000 });
item('m-heat', 'lib-movies', 'movie', 'Heat', { year: 1995, duration_ms: 10200000 });
item('m-alien', 'lib-movies', 'movie', 'Alien', { year: 1979 });
item('s-bb', 'lib-tv', 'show', 'Breaking Bad', { year: 2008, external_ids: JSON.stringify({ tvdb: '81189' }) });
item('e-bb1', 'lib-tv', 'episode', 'Pilot', { grandparent_id: 's-bb', parent_idx: 1, idx: 1 });
item('e-bb2', 'lib-tv', 'episode', 'Cat in the Bag', { grandparent_id: 's-bb', parent_idx: 1, idx: 2 });
db.insert('media', { id: 'md-heat', item_id: 'm-heat', path: '/mnt/movies/Heat (1995)/Heat.mkv' });

const admin = await auth.createUser({ username: 'mmadmin', password: 'pass1234', isAdmin: true });
const dev = (id: string) => ({ deviceId: id, deviceName: 'test', platform: 'web' as const });
const adminTok = auth.issueToken(admin.id, dev('a')).token;
const as = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });
const ORIGIN = 'http://mediamax.test';

async function runToEnd(opts = {}): Promise<ImportJob> {
  const job = imp.startImport('jellyfin', admin, opts, ORIGIN);
  for (let i = 0; i < 400 && imp.getJob()?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
  const done = imp.getJob()!;
  assert.equal(done.id, job.id);
  assert.equal(done.status, 'done', done.error ?? undefined);
  return done;
}
const userRow = (username: string) => db.get('SELECT * FROM users WHERE username = ?', username)!;
const udRow = (userId: string, itemId: string) => db.get('SELECT * FROM user_data WHERE user_id = ? AND item_id = ?', userId, itemId);
const historyCount = () => db.get<{ n: number }>("SELECT COUNT(*) n FROM play_history WHERE method = 'import'")!.n;

/* ------------------------------------------------------------------ */

test('jellyfin settings: key masked on GET, connection test uses the MediaBrowser header', async () => {
  let res = await app.inject({ method: 'PUT', url: '/api/v1/admin/import/jellyfin/config', headers: as(adminTok), payload: JSON.stringify({ url: JF_URL, apiKey: KEY, pathMappings: [{ from: '/media/movies', to: '/mnt/movies' }] }) });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(!res.body.includes(KEY));
  res = await app.inject({ method: 'GET', url: '/api/v1/admin/import/jellyfin/config', headers: as(adminTok) });
  assert.ok(!res.body.includes(KEY), 'GET never returns the key');
  assert.equal(res.json().apiKey, SECRET_MASK);
  // Emby's settings are separate.
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/import/emby/config', headers: as(adminTok) })).json().url, '');
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/import/nope/config', headers: as(adminTok) })).statusCode, 400);

  const ok = await app.inject({ method: 'POST', url: '/api/v1/admin/import/jellyfin/test', headers: as(adminTok), payload: JSON.stringify({ apiKey: SECRET_MASK }) });
  assert.equal(ok.json().ok, true, ok.json().message);
  assert.equal(ok.json().version, '10.10.3');
  assert.equal(ok.json().users, 2);
  assert.match(calls.at(-1)!.auth ?? '', /^MediaBrowser .*Token="jellyfin-secret-api-key-456"/);
  const bad = await imp.testConnection('jellyfin', { apiKey: 'wrong' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /Jellyfin rejected the API key/);
});

test('jellyfin user mapping: GUID folders, MaxActiveSessions, age-scored rating, blocked tags, hidden', () => {
  const folders = FOLDERS.map(embyFolder);
  const libs = mapFolders(folders, [{ from: '/media/movies', to: '/mnt/movies' }]);
  assert.deepEqual(libs.map((l) => [l.name, l.libraryId, l.method]), [['Movies', 'lib-movies', 'path'], ['Shows', null, null]]);
  const libsByName = mapFolders(folders, [{ from: '/media/movies', to: '/mnt/movies' }, { from: '/media/tv', to: '/mnt/tv' }]);
  const kid = mapEmbyUser('jellyfin', USERS[1] as any, folders, libsByName);
  assert.deepEqual(kid.libraryIds, ['lib-tv'], 'dashed GUID in the policy matches the library ItemId');
  assert.equal(kid.maxStreams, 2);
  assert.equal(kid.maxContentRating, 'PG-13');
  assert.equal(kid.allowRemote, false);
  assert.equal(kid.allowLiveTv, false);
  assert.equal(kid.allowDownloads, false);
  assert.equal(kid.hiddenFromLogin, true);
  assert.match(kid.notes!.join(), /Blocked tags not imported: horror/);
  const adm = mapEmbyUser('jellyfin', USERS[0] as any, folders, libsByName);
  assert.equal(adm.isAdmin, true);
  assert.equal(adm.maxStreams, null, 'MaxActiveSessions 0 = unlimited');
});

test('jellyfin preview: quick (count-only) and full, with Playback Reporting history', async () => {
  await app.inject({ method: 'PUT', url: '/api/v1/admin/import/jellyfin/config', headers: as(adminTok), payload: JSON.stringify({ pathMappings: [{ from: '/media/movies', to: '/mnt/movies' }, { from: '/media/tv', to: '/mnt/tv' }] }) });
  calls.length = 0;
  const quick = await app.inject({ method: 'GET', url: '/api/v1/admin/import/jellyfin/preview?quick=1', headers: as(adminTok) });
  assert.equal(quick.statusCode, 200, quick.body);
  const q = quick.json();
  assert.equal(q.quick, true);
  const qa = q.users.find((u: any) => u.username === 'jfadmin');
  assert.equal(qa.watched.total, 2);
  assert.equal(qa.resume.total, 1);
  assert.equal(qa.history.total, 3);
  assert.equal(q.collections, 1);
  assert.ok(calls.filter((c) => c.path.includes('Filters=')).every((c) => c.path.includes('Limit=0')), 'quick preview only asks for counts');
  assert.ok(calls.some((c) => c.path.startsWith('/Items?')), 'switched to /Items?userId= after the 404');

  const full = (await app.inject({ method: 'GET', url: '/api/v1/admin/import/jellyfin/preview', headers: as(adminTok) })).json();
  assert.equal(full.quick, false);
  assert.ok(!JSON.stringify(full).includes(KEY));
  const a = full.users.find((u: any) => u.username === 'jfadmin');
  assert.deepEqual(a.watched, { total: 2, matched: 2, byProviderId: 1, byPath: 1, byTitle: 0 });
  assert.deepEqual([a.resume.matched, a.resume.byTitle], [1, 1]);
  assert.deepEqual([a.history.total, a.history.matched], [3, 2], 'the deleted item is not matched');
  const k = full.users.find((u: any) => u.username === 'kiddo');
  assert.deepEqual(k.libraries, ['Television']);
  assert.equal(k.hidden, true);
  assert.deepEqual([k.watched.matched, k.resume.matched, k.favorites.matched], [1, 1, 1]);
  assert.deepEqual(full.notes, []);
  assert.ok(sqls.every((s) => !/;|--/.test(s)), 'only single, comment-free statements');
});

let first: ImportJob;
test('jellyfin import: users, watch data with play counts, resume ticks, history rows', async () => {
  first = await runToEnd();
  const r = Object.fromEntries(first.results.map((x) => [x.username, x]));
  assert.equal(first.source, 'jellyfin');
  assert.equal(r.jfadmin.status, 'created');
  assert.equal(r.kiddo.status, 'created');
  assert.ok(r.kiddo.setPasswordUrl);
  assert.ok(db.get("SELECT 1 FROM password_links WHERE purpose = 'jellyfin-import'"));
  const ja = userRow('jfadmin');
  const kid = userRow('kiddo');
  assert.equal(ja.is_admin, 1);
  assert.equal(kid.max_streams, 2);
  assert.equal(kid.max_rating, 'PG-13');
  assert.equal(kid.show_on_signin, 0);
  assert.equal(ja.show_on_signin, 1);
  assert.match(r.kiddo.message ?? '', /Blocked tags/);

  assert.equal(udRow(ja.id, 'm-matrix').play_count, 4);
  assert.equal(udRow(ja.id, 'm-matrix').favorite, 1);
  assert.equal(udRow(ja.id, 'm-matrix').last_played_at, '2026-10-01T20:00:00.000Z');
  assert.equal(udRow(ja.id, 'm-alien').position_ms, 900000);
  assert.equal(udRow(kid.id, 'e-bb1').played, 1);
  assert.equal(udRow(kid.id, 'e-bb1').play_count, 2);
  assert.equal(udRow(kid.id, 'e-bb2').position_ms, 300000);
  assert.equal(udRow(kid.id, 's-bb').favorite, 1);

  // History: Matrix (duration from the plugin), Heat, kid's pilot; the deleted item is skipped.
  assert.equal(r.jfadmin.history, 2);
  assert.equal(r.kiddo.history, 1);
  const h = db.get("SELECT * FROM play_history WHERE user_id = ? AND item_id = 'm-matrix'", ja.id)!;
  assert.equal(h.duration_ms, 7800000);
  assert.equal(h.platform, 'jellyfin');
  assert.ok(h.ended_at > h.started_at);
  const pl = db.get("SELECT * FROM items WHERE type = 'playlist' AND owner_id = ?", ja.id)!;
  assert.equal(pl.title, 'Admin mix');
  assert.deepEqual(first.collections, { created: 1, updated: 0, items: 2 });
  assert.ok(!JSON.stringify(first).includes(KEY));
  assert.ok(db.get("SELECT 1 FROM activity WHERE type = 'jellyfin.import' AND message LIKE 'Jellyfin import finished%'"));
  assert.ok(db.get("SELECT 1 FROM import_map WHERE source = 'jellyfin' AND kind = 'user' AND source_id = ?", U_KID));
});

test('jellyfin re-run is idempotent (no duplicate history, users, playlists; counts not lowered)', async () => {
  const users = db.get<{ n: number }>('SELECT COUNT(*) n FROM users')!.n;
  const hist = historyCount();
  DATA[U_ADMIN].played[0].UserData.PlayCount = 1; // lower on the source: must not lower here
  const job = await runToEnd();
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) n FROM users')!.n, users);
  assert.equal(historyCount(), hist);
  assert.ok(job.results.every((x) => x.status === 'merged'));
  assert.equal(job.results.find((x) => x.username === 'jfadmin')!.history, 0);
  assert.equal(udRow(userRow('jfadmin').id, 'm-matrix').play_count, 4);
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) n FROM items WHERE type = 'playlist'")!.n, 1);
  assert.deepEqual(job.collections, { created: 0, updated: 1, items: 2 });
});

test('jellyfin without the Playback Reporting plugin: history skipped cleanly; legacy items route still works', async () => {
  stub.reporting = false;
  stub.legacyItemsGone = false;
  calls.length = 0;
  const p = await imp.previewImport('jellyfin', {});
  assert.match(p.notes.join(), /Playback Reporting plugin not found/);
  assert.ok(p.users.every((u) => u.history.total === 0));
  assert.equal(p.users.find((u) => u.username === 'jfadmin')!.watched.matched, 2);
  assert.ok(calls.some((c) => c.path.startsWith(`/Users/${U_ADMIN}/Items?`)));
  const job = await runToEnd();
  assert.match(job.notes.join(), /Playback Reporting plugin not found/);
  assert.ok(job.results.every((x) => x.status === 'merged'));
});
