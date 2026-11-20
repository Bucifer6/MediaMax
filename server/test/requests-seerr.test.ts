/**
 * Overseerr parity: request permissions (+ legacy migration), quotas, auto-approve, edit-before-approve, bulk actions,
 * blacklist, lifecycle notifications (in-app + agents), issues, watchlist auto-request.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { ArrInstance, User } from '@mediamax/shared';

/* ------------------------------------------------------------------ */
/* Mock servers: TMDB, Radarr ×2, Sonarr, a notification receiver      */
/* ------------------------------------------------------------------ */

interface Mock { url: string; calls: { method: string; path: string; body: any; headers: http.IncomingHttpHeaders }[]; close: () => Promise<void> }
type Handler = (body: any, q: URLSearchParams, path: string) => unknown;

async function mockServer(route: (method: string, path: string) => Handler | undefined): Promise<Mock> {
  const calls: Mock['calls'] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://x');
      const body = data ? (() => { try { return JSON.parse(data); } catch { return data; } })() : null;
      calls.push({ method: req.method ?? 'GET', path: u.pathname + u.search, body, headers: req.headers });
      const h = route(req.method ?? 'GET', u.pathname);
      if (!h) return void res.writeHead(404).end('{"message":"NotFound"}');
      const out = h(body, u.searchParams, u.pathname);
      res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' }).end(out === null || out === undefined ? '' : JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => new Promise((r) => server.close(() => r())) };
}

const SHOW_SEASONS = [0, 1, 2, 3].map((n) => ({ season_number: n, name: n ? `Season ${n}` : 'Specials', episode_count: 2, air_date: `202${n}-01-01` }));
const tmdbMock = await mockServer((method, p) => {
  if (method !== 'GET') return undefined;
  let m = p.match(/^\/3\/movie\/(\d+)$/);
  if (m) return () => ({ id: Number(m![1]), title: `Movie ${m![1]}`, release_date: '2020-01-01', vote_average: m![1] === '900' ? 8.6 : 6.1, genres: [], credits: {}, images: {}, release_dates: { results: [] } });
  m = p.match(/^\/3\/tv\/(\d+)$/);
  if (m) return () => ({ id: Number(m![1]), name: `Show ${m![1]}`, first_air_date: '2021-01-01', vote_average: 7, seasons: SHOW_SEASONS, external_ids: { tvdb_id: 1234 }, credits: {}, images: {}, content_ratings: { results: [] } });
  if (/^\/3\/tv\/\d+\/external_ids$/.test(p)) return () => ({ tvdb_id: 1234 });
  if (/^\/3\/(trending|movie|tv)\//.test(p)) return () => ({ page: 1, total_pages: 1, results: [{ id: 501, media_type: 'movie', title: 'Trending Movie', release_date: '2024-01-01' }, { id: 666, media_type: 'movie', title: 'Banned Movie', release_date: '2024-01-01' }] });
  return undefined;
});
process.env.MEDIAMAX_TMDB_API_BASE = `${tmdbMock.url}/3`;

const KEY = 'k';
const arrRoutes = (kind: 'radarr' | 'sonarr') => (method: string, p: string): Handler | undefined => {
  const path = p.replace(/^\/api\/v3/, '');
  const table: Record<string, Handler> = {
    'GET /qualityprofile': () => [{ id: 1, name: 'HD' }, { id: 4, name: 'UHD' }],
    'GET /rootfolder': () => [{ path: `/${kind}`, freeSpace: 1 }],
    'GET /tag': () => [{ id: 7, label: 'requests' }],
    'GET /system/status': () => ({ appName: kind === 'radarr' ? 'Radarr' : 'Sonarr', version: '5' }),
    'GET /languageprofile': () => [{ id: 2, name: 'English' }],
    'POST /command': () => ({ id: 1 }),
    'GET /movie/lookup/tmdb': (_b, q) => ({ title: `Movie ${q.get('tmdbId')}`, tmdbId: Number(q.get('tmdbId')), year: 2020 }),
    'POST /movie': (b) => ({ ...b, id: 50 }),
    'GET /movie': (_b, q) => [{ id: 77, tmdbId: Number(q.get('tmdbId')) }],
    'GET /series/lookup': () => [{ title: 'Show', tvdbId: 1234, seasons: [0, 1, 2, 3].map((n) => ({ seasonNumber: n })) }],
    'POST /series': (b) => ({ ...b, id: 51 }),
    'GET /series': () => [{ id: 88, tvdbId: 1234 }],
    'GET /queue': () => ({ records: [] }),
  };
  if (method === 'DELETE' && /^\/(movie|series)\/\d+$/.test(path)) return () => null;
  return table[`${method} ${path}`];
};
const radarrA = await mockServer(arrRoutes('radarr'));
const radarrB = await mockServer(arrRoutes('radarr'));
const sonarr = await mockServer(arrRoutes('sonarr'));
const receiver = await mockServer((method) => (method === 'POST' ? () => null : undefined));

// Tiny SMTP server for the email agent.
const smtpMessages: string[] = [];
const smtp = net.createServer((sock) => {
  let data = false;
  let buf = '';
  sock.write('220 mock ESMTP\r\n');
  sock.on('data', (d) => {
    buf += d.toString();
    if (data) {
      if (buf.endsWith('\r\n.\r\n')) {
        smtpMessages.push(buf);
        buf = '';
        data = false;
        sock.write('250 queued\r\n');
      }
      return;
    }
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (/^EHLO/i.test(line)) sock.write('250-mock\r\n250 AUTH PLAIN LOGIN\r\n');
      else if (/^AUTH PLAIN/i.test(line)) sock.write('235 ok\r\n');
      else if (/^(MAIL|RCPT)/i.test(line)) sock.write('250 ok\r\n');
      else if (/^DATA/i.test(line)) {
        data = true;
        sock.write('354 go\r\n');
      } else if (/^QUIT/i.test(line)) sock.end('221 bye\r\n');
    }
  });
});
await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));

after(async () => {
  for (const m of [tmdbMock, radarrA, radarrB, sonarr, receiver]) await m.close();
  smtp.close();
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const { db } = await import('../src/db.ts');
const settings = await import('../src/services/settings.ts');
const auth = await import('../src/services/auth.ts');
const perms = await import('../src/services/requestPerms.ts');
const requests = await import('../src/services/requests.ts');
const notifications = await import('../src/services/notifications.ts');
const { initRequestNotifications } = await import('../src/services/requestEvents.ts');
const { buildApp } = await import('../src/app.ts');
initRequestNotifications();

const now = new Date().toISOString();
const inst = (id: string, kind: 'radarr' | 'sonarr', url: string, extra: Partial<ArrInstance> = {}): ArrInstance => ({ id, kind, name: id, url, apiKey: KEY, enabled: true, ...extra });
const admin = auth.createUser({ username: 'admin', password: 'pass1234', isAdmin: true });
// Legacy users: created before permissions existed (no request_perms stored).
db.insert('users', { id: 'legacy-auto', username: 'legacyauto', display_name: 'Legacy Auto', is_admin: 0, allow_request_4k: 1, preferences: '{}', created_at: now });
db.insert('users', { id: 'legacy-plain', username: 'legacyplain', display_name: 'Legacy Plain', is_admin: 0, preferences: '{}', created_at: now });
settings.updateSettings({
  tmdbApiKey: 'test-key',
  requests: { ...settings.getSettings().requests, enabled: true, autoApproveUserIds: ['legacy-auto'], weeklyLimit: 50 },
  arr: [inst('radarrA', 'radarr', radarrA.url), inst('radarrB', 'radarr', radarrB.url), inst('sonarr', 'sonarr', sonarr.url)],
});
db.insert('libraries', { id: 'lib-tv', name: 'TV', type: 'shows', paths: JSON.stringify(['/tv']), created_at: now });
db.insert('libraries', { id: 'lib-movies', name: 'Movies', type: 'movies', paths: JSON.stringify(['/m']), created_at: now });

const app = await buildApp();
after(() => app.close());
const tokenFor = (u: User) => auth.issueToken(u.id, { deviceId: `dev-${u.id}`, deviceName: 'test', platform: 'web' } as any).token;
const call = (u: User, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as any, url: `/api/v1${url}`, headers: { authorization: `Bearer ${tokenFor(u)}` }, ...(payload !== undefined ? { payload: payload as any } : {}) });
const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};
const fresh = (u: User) => auth.getUser(u.id);

/* ------------------------------------------------------------------ */

test('legacy allowRequest4k + autoApproveUserIds migrate into permissions; quotas seed from weeklyLimit', () => {
  const a = auth.getUser('legacy-auto');
  assert.deepEqual([a.requestPermissions!.movie, a.requestPermissions!.show, a.requestPermissions!.music, a.requestPermissions!.movie4k, a.requestPermissions!.show4k], ['auto', 'auto', 'auto', 'auto', 'auto']);
  const p = auth.getUser('legacy-plain');
  assert.deepEqual([p.requestPermissions!.movie, p.requestPermissions!.movie4k], ['request', 'none']);
  assert.equal(p.requestPermissions!.manageRequests, false);
  // Nothing was stored: still derived from the old fields.
  assert.equal(db.get("SELECT request_perms FROM users WHERE id = 'legacy-auto'")!.request_perms, null);
  assert.deepEqual(perms.defaultQuotas().movie, { limit: 50, days: 7 });
  // An old client toggling only allowRequest4k writes real permissions.
  const u = auth.updateUser('legacy-plain', { allowRequest4k: true }, admin.id);
  assert.equal(u.requestPermissions!.movie4k, 'request');
  assert.equal(u.allowRequest4k, true);
  assert.ok(db.get("SELECT request_perms FROM users WHERE id = 'legacy-plain'")!.request_perms);
});

test('new users get the default permissions; invite templates and explicit values override', () => {
  settings.updateSettings({ requests: { ...settings.getSettings().requests, defaultPermissions: { ...perms.DEFAULT_PERMISSIONS, movie: 'auto', book: 'none' } } });
  const u = auth.createUser({ username: 'newbie', password: 'pass1234' });
  assert.equal(u.requestPermissions!.movie, 'auto');
  assert.equal(u.requestPermissions!.book, 'none');
  const v = auth.createUser({ username: 'custom', password: 'pass1234', requestPermissions: { show: 'none' } });
  assert.equal(v.requestPermissions!.show, 'none');
  assert.equal(v.requestPermissions!.movie, 'auto');
  settings.updateSettings({ requests: { ...settings.getSettings().requests, defaultPermissions: perms.DEFAULT_PERMISSIONS } });
});

let viewer: User;
let manager: User;
let blocked: User;
test('permission enforcement: 403 for kinds a user may not request, approve needs manage permission', async () => {
  viewer = auth.createUser({ username: 'viewer', password: 'pass1234' });
  manager = auth.createUser({ username: 'manager', password: 'pass1234', requestPermissions: { manageRequests: true } });
  blocked = auth.createUser({ username: 'blocked', password: 'pass1234', requestPermissions: { movie: 'none', reportIssues: false } });
  const r = await call(blocked, 'POST', '/requests', { mediaType: 'movie', tmdbId: '100' });
  assert.equal(r.statusCode, 403);
  assert.equal(r.json().code ?? r.json().error, r.json().code ?? r.json().error);
  assert.match(r.body, /permission/);
  const opts = (await call(blocked, 'GET', '/requests/options')).json();
  assert.equal(opts.movies, false);
  assert.equal(opts.permissions.movie, 'none');
  // 4K needs its own permission.
  settings.updateSettings({ arr: [...settings.getSettings().arr, inst('radarr4k', 'radarr', radarrA.url, { is4k: true })] });
  const r4 = await call(viewer, 'POST', '/requests', { mediaType: 'movie', tmdbId: '101', also4k: true });
  assert.equal(r4.statusCode, 403);
  assert.match(r4.body, /4K/);

  const ok = await call(viewer, 'POST', '/requests', { mediaType: 'movie', tmdbId: '101' });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().status, 'pending');
  const id = ok.json().id;
  assert.equal((await call(viewer, 'POST', `/requests/${id}/approve`)).statusCode, 403);
  assert.equal((await call(viewer, 'POST', `/requests/${id}/decline`, { reason: 'x' })).statusCode, 403);
  assert.equal((await call(viewer, 'PATCH', `/requests/${id}`, { also4k: true })).statusCode, 403);
  // Non-managers only see their own requests.
  assert.ok((await call(blocked, 'GET', '/requests')).json().every((x: any) => x.requestedBy.id === blocked.id));
  assert.ok((await call(manager, 'GET', '/requests')).json().some((x: any) => x.id === id));
  const approved = await call(manager, 'POST', `/requests/${id}/approve`);
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.json().status, 'processing');
  assert.ok(radarrA.calls.some((c) => c.method === 'POST' && c.path.endsWith('/movie') && c.body.tmdbId === 101));
});

test('auto-approve by permission (and the global rating rule)', async () => {
  const auto = auth.createUser({ username: 'auto', password: 'pass1234', requestPermissions: { movie: 'auto' } });
  const r = await requests.createRequest(fresh(auto), { mediaType: 'movie', tmdbId: '102' });
  assert.equal(r.status, 'processing');
  assert.equal(r.decidedBy?.id, auto.id);
  // Rating rule: ≥ 8.5 on TMDB is approved for anyone who may request.
  settings.updateSettings({ requests: { ...settings.getSettings().requests, autoApproveMinRating: 8.5 } });
  const hi = await requests.createRequest(fresh(viewer), { mediaType: 'movie', tmdbId: '900' });
  assert.equal(hi.status, 'processing');
  const lo = await requests.createRequest(fresh(viewer), { mediaType: 'movie', tmdbId: '103' });
  assert.equal(lo.status, 'pending');
  settings.updateSettings({ requests: { ...settings.getSettings().requests, autoApproveMinRating: 0 } });
  // The timeline records creation and approval.
  const act = requests.requestActivity(admin, hi.id).map((a) => a.kind);
  assert.deepEqual(act.slice(0, 3), ['created', 'approved', 'processing']);
});

test('quotas: TV counts seasons, declined requests do not count, the window rolls', async () => {
  const q = auth.createUser({ username: 'quota', password: 'pass1234', requestQuotas: { movie: { limit: 1, days: 7 }, show: { limit: 3, days: 7 }, music: { limit: 0, days: 7 }, book: { limit: 0, days: 7 } } });
  const a = await requests.createRequest(fresh(q), { mediaType: 'show', tmdbId: '200', seasonMode: 'specific', seasons: [1, 2] });
  assert.equal(a.quotaUnits, 2);
  assert.equal(perms.quotaStatus(fresh(q), 'show').remaining, 1);
  await assert.rejects(requests.createRequest(fresh(q), { mediaType: 'show', tmdbId: '201', seasonMode: 'specific', seasons: [1, 2] }), (e: any) => e.statusCode === 429 && /1 more season/.test(e.message));
  // "All seasons" of a 3-season show = 3 units.
  await assert.rejects(requests.createRequest(fresh(q), { mediaType: 'show', tmdbId: '202' }), (e: any) => e.statusCode === 429);
  await requests.createRequest(fresh(q), { mediaType: 'show', tmdbId: '203', seasonMode: 'first' });
  assert.equal(perms.quotaStatus(fresh(q), 'show').remaining, 0);
  // Movies: 1 per week.
  const m = await requests.createRequest(fresh(q), { mediaType: 'movie', tmdbId: '300' });
  const http429 = await call(q, 'POST', '/requests', { mediaType: 'movie', tmdbId: '301' });
  assert.equal(http429.statusCode, 429);
  // Declined requests don't count.
  requests.declineRequest(admin, m.id, 'nope');
  assert.equal(perms.quotaStatus(fresh(q), 'movie').remaining, 1);
  // Rolling window: requests older than 7 days fall out.
  db.run("UPDATE media_requests SET requested_at = ? WHERE requested_by = ? AND media_type = 'show'", new Date(Date.now() - 8 * 86400000).toISOString(), q.id);
  assert.equal(perms.quotaStatus(fresh(q), 'show').remaining, 3);
  // Managers are exempt by default; exempt users report remaining = null.
  assert.equal(perms.quotaStatus(fresh(manager), 'movie').exempt, true);
  assert.equal(perms.quotaStatus(admin, 'movie').remaining, null);
  const opts = (await call(q, 'GET', '/requests/options')).json();
  assert.equal(opts.quotas.show.limit, 3);
});

test('partially available shows: only missing seasons are requested; season status for the dialog', async () => {
  db.insert('items', { id: 'show-400', library_id: 'lib-tv', type: 'show', title: 'Show 400', sort_title: 'show 400', external_ids: JSON.stringify({ tmdb: '400' }), added_at: now, updated_at: now });
  for (const e of [1, 2]) db.insert('items', { id: `ep-400-1-${e}`, library_id: 'lib-tv', type: 'episode', title: `E${e}`, sort_title: `e${e}`, parent_idx: 1, idx: e, grandparent_id: 'show-400', added_at: now, updated_at: now });
  const info = await requests.tvInfo('400');
  assert.deepEqual(info.seasons.map((s) => s.status), ['available', 'missing', 'missing']);
  const r = await requests.createRequest(fresh(viewer), { mediaType: 'show', tmdbId: '400' });
  assert.equal(r.seasonMode, 'specific');
  assert.deepEqual(r.seasons, [2, 3]);
  assert.equal(r.quotaUnits, 2);
  const info2 = await requests.tvInfo('400');
  assert.deepEqual(info2.seasons.map((s) => s.status), ['available', 'pending', 'pending']);
  await assert.rejects(requests.createRequest(fresh(viewer), { mediaType: 'show', tmdbId: '400', seasonMode: 'specific', seasons: [2] }), /already available or requested/);
  // Not available until every requested season has episodes.
  assert.equal(requests.checkAvailability() >= 0, true);
  assert.equal(requests.getRequest(admin, r.id).status, 'pending');
});

test('edit before approve: instance, quality profile, root folder, tags, language profile and seasons reach the *arr', async () => {
  const r = await requests.createRequest(fresh(viewer), { mediaType: 'movie', tmdbId: '104' });
  const choices = await requests.requestArrChoices(admin, r.id);
  assert.deepEqual(choices.instances.map((i) => i.id).sort(), ['radarr4k', 'radarrA', 'radarrB']);
  assert.equal(choices.instances[0].options.qualityProfiles.length, 2);
  const edited = await call(manager, 'POST', `/requests/${r.id}/approve`, { arr: { instanceId: 'radarrB', qualityProfileId: 4, rootFolderPath: '/movies-custom', tags: [7] } });
  assert.equal(edited.statusCode, 200);
  const post = radarrB.calls.find((c) => c.method === 'POST' && c.path.endsWith('/movie') && c.body.tmdbId === 104);
  assert.ok(post, 'sent to the chosen instance');
  assert.equal(post!.body.qualityProfileId, 4);
  assert.equal(post!.body.rootFolderPath, '/movies-custom');
  assert.deepEqual(post!.body.tags, [7]);
  assert.ok(!radarrA.calls.some((c) => c.method === 'POST' && c.body?.tmdbId === 104));
  // Show: change seasons and language profile, then approve.
  const s = await requests.createRequest(fresh(viewer), { mediaType: 'show', tmdbId: '500' });
  assert.throws(() => requests.editRequest(fresh(viewer), s.id, { seasons: [2] }), /Manage requests/);
  requests.editRequest(admin, s.id, { seasonMode: 'specific', seasons: [2], arr: { languageProfileId: 2, rootFolderPath: '/tv-kids' } });
  await requests.approveRequest(admin, s.id);
  const series = sonarr.calls.find((c) => c.method === 'POST' && c.path.endsWith('/series'));
  assert.ok(series);
  assert.equal(series!.body.languageProfileId, 2);
  assert.equal(series!.body.rootFolderPath, '/tv-kids');
  assert.deepEqual(series!.body.seasons.filter((x: any) => x.monitored).map((x: any) => x.seasonNumber), [2]);
  assert.ok(requests.requestActivity(admin, s.id).some((a) => a.kind === 'edited' && /seasons 2/.test(a.body ?? '')));
});

test('bulk approve/decline and delete with "also remove from Radarr"', async () => {
  const a = await requests.createRequest(fresh(viewer), { mediaType: 'movie', tmdbId: '105' });
  const b = await requests.createRequest(fresh(viewer), { mediaType: 'movie', tmdbId: '106' });
  const c = await requests.createRequest(fresh(viewer), { mediaType: 'movie', tmdbId: '107' });
  const res = (await call(manager, 'POST', '/requests/bulk', { ids: [a.id, b.id], action: 'decline', note: 'Not this one' })).json();
  assert.deepEqual(res.ok.sort(), [a.id, b.id].sort());
  assert.equal(requests.getRequest(admin, a.id).declineReason, 'Not this one');
  assert.equal((await call(viewer, 'POST', '/requests/bulk', { ids: [c.id], action: 'approve' })).statusCode, 403);
  await requests.approveRequest(admin, c.id);
  const del = await call(admin, 'DELETE', `/requests/${c.id}?removeFromArr=true`);
  assert.equal(del.statusCode, 200);
  assert.ok(del.json().removedFrom.length >= 1);
  assert.ok(radarrA.calls.some((x) => x.method === 'DELETE' && /\/movie\/77/.test(x.path)));
  // Filters and sorting.
  const declined = (await call(admin, 'GET', `/requests?status=declined&mediaType=movie&userId=${viewer.id}&sort=title&order=asc`)).json();
  assert.ok(declined.length >= 2 && declined.every((x: any) => x.status === 'declined' && x.requestedBy.id === viewer.id));
});

test('blacklist: managers only; blacklisted titles cannot be requested and are hidden from Discover', async () => {
  assert.equal((await call(viewer, 'POST', '/requests/blacklist', { mediaType: 'movie', externalId: '666', title: 'Banned Movie' })).statusCode, 403);
  assert.equal((await call(manager, 'POST', '/requests/blacklist', { mediaType: 'movie', externalId: '666', title: 'Banned Movie', reason: 'Not on this server' })).statusCode, 200);
  const r = await call(viewer, 'POST', '/requests', { mediaType: 'movie', tmdbId: '666' });
  assert.equal(r.statusCode, 403);
  assert.match(r.body, /blacklisted/);
  const disc = (await call(viewer, 'GET', '/discover')).json();
  assert.ok(disc.results.some((x: any) => x.tmdbId === '501'));
  assert.ok(!disc.results.some((x: any) => x.tmdbId === '666'));
  const forManager = (await call(manager, 'GET', '/discover')).json();
  assert.equal(forManager.results.find((x: any) => x.tmdbId === '666').blacklisted, true);
  assert.equal((await call(manager, 'DELETE', '/requests/blacklist/movie/666')).statusCode, 200);
  assert.equal((await call(admin, 'GET', '/requests/blacklist')).json().length, 0);
});

test('notifications: new → managers + agents, declined with reason / available → requester, failed → managers; email agent', async () => {
  settings.updateSettings({
    notificationAgents: [
      { id: 'disc', kind: 'discord', name: 'Discord', enabled: true, events: ['request.pending', 'request.declined', 'request.available', 'request.failed'], config: { webhookUrl: `${receiver.url}/discord` } },
      { id: 'hook', kind: 'webhook', name: 'Hook', enabled: true, events: ['request.declined'], config: { url: `${receiver.url}/hook` } },
      { id: 'mail', kind: 'email', name: 'Mail', enabled: true, events: ['request.available'], config: { host: '127.0.0.1', port: String((smtp.address() as AddressInfo).port), from: 'mm@example.com', to: 'admin@example.com', username: 'u', password: 'p' } },
    ],
  });
  // Secrets are masked on read and kept on save.
  const pub = settings.publicSettings().notificationAgents;
  assert.equal(pub[0].config.webhookUrl, '••••');
  settings.updateSettings({ notificationAgents: pub });
  assert.equal(settings.getSettings().notificationAgents[0].config.webhookUrl, `${receiver.url}/discord`);

  const before = receiver.calls.length;
  const r = await requests.createRequest(fresh(viewer), { mediaType: 'movie', tmdbId: '108', note: 'please' });
  assert.ok(await until(() => receiver.calls.slice(before).some((c) => c.path === '/discord' && /New request: Movie 108/.test(c.body.embeds[0].title))));
  assert.ok(notifications.listNotifications(manager).items.some((n) => n.kind === 'request' && /Movie 108/.test(n.title) && n.link === `/requests?id=${r.id}`));
  assert.ok(notifications.listNotifications(admin).items.some((n) => /Movie 108/.test(n.title)));

  requests.declineRequest(fresh(manager), r.id, 'Already on Netflix');
  const n = notifications.listNotifications(viewer).items.find((x) => /declined/.test(x.title));
  assert.equal(n?.body, 'Reason: Already on Netflix');
  assert.ok(await until(() => receiver.calls.some((c) => c.path === '/hook' && c.body.event === 'request.declined' && c.body.reason === 'Already on Netflix')));

  // Available → requester (in-app), Discord and email.
  const avail = await requests.createRequest(fresh(viewer), { mediaType: 'movie', tmdbId: '109' });
  db.insert('items', { id: 'mov-109', library_id: 'lib-movies', type: 'movie', title: 'Movie 109', sort_title: 'movie 109', external_ids: JSON.stringify({ tmdb: '109' }), added_at: now, updated_at: now });
  requests.checkAvailability();
  assert.equal(requests.getRequest(admin, avail.id).status, 'available');
  assert.ok(notifications.listNotifications(viewer).items.some((x) => /Movie 109 \(2020\) is now available/.test(x.title) && x.itemId === 'mov-109'));
  assert.ok(await until(() => smtpMessages.some((m) => /Subject: Now available: Movie 109/.test(m))));

  // Failed → managers.
  const f = await requests.createRequest(fresh(viewer), { mediaType: 'movie', tmdbId: '110' });
  settings.updateSettings({ arr: settings.getSettings().arr.map((a) => (a.kind === 'radarr' ? { ...a, url: 'http://127.0.0.1:1' } : a)) });
  const failed = await requests.approveRequest(admin, f.id);
  assert.equal(failed.status, 'failed');
  assert.ok(notifications.listNotifications(manager).items.some((x) => /Request failed: Movie 110/.test(x.title)));
  settings.updateSettings({ arr: settings.getSettings().arr.map((a) => (a.id === 'radarrA' || a.id === 'radarr4k' ? { ...a, url: radarrA.url } : a.id === 'radarrB' ? { ...a, url: radarrB.url } : a)) });
  // Retry works once Radarr is back.
  assert.equal((await call(manager, 'POST', `/requests/${f.id}/retry`)).json().status, 'processing');

  // Comments go to the other side.
  requests.addComment(fresh(viewer), f.id, 'Any news?');
  assert.ok(notifications.listNotifications(manager).items.some((x) => /commented/.test(x.title)));
  // The Test button.
  const t = (await call(admin, 'POST', '/notify/agents/test', { id: 'disc', kind: 'discord', name: 'Discord', config: { webhookUrl: '••••' } })).json();
  assert.equal(t.ok, true);
});

test('issues: report, visibility, comments, resolve/reopen, permission', async () => {
  db.insert('items', { id: 'ep-400-1-3', library_id: 'lib-tv', type: 'episode', title: 'E3', sort_title: 'e3', parent_idx: 1, idx: 3, grandparent_id: 'show-400', added_at: now, updated_at: now });
  const created = await call(viewer, 'POST', '/issues', { itemId: 'ep-400-1-3', kind: 'subtitle', message: 'Subtitles are out of sync' });
  assert.equal(created.statusCode, 200);
  const issue = created.json();
  assert.equal(issue.rootItemId, 'show-400');
  assert.equal(issue.title, 'Show 400');
  assert.deepEqual([issue.season, issue.episode], [1, 3]);
  assert.ok(notifications.listNotifications(manager).items.some((n) => n.kind === 'issue' && n.link === `/issues/${issue.id}`));
  assert.equal((await call(blocked, 'POST', '/issues', { itemId: 'mov-109', kind: 'video', message: 'x' })).statusCode, 403);
  const other = auth.createUser({ username: 'other', password: 'pass1234' });
  assert.equal((await call(other, 'GET', `/issues/${issue.id}`)).statusCode, 404);
  assert.equal((await call(other, 'GET', '/issues')).json().length, 0);
  assert.equal((await call(manager, 'GET', '/issues?status=open')).json().length, 1);
  assert.equal((await call(other, 'POST', `/issues/${issue.id}/resolve`)).statusCode, 404);
  const commented = (await call(manager, 'POST', `/issues/${issue.id}/comments`, { body: 'Looking into it' })).json();
  assert.equal(commented.comments.length, 1);
  assert.ok(notifications.listNotifications(viewer).items.some((n) => /replied/.test(n.title)));
  const resolved = (await call(manager, 'POST', `/issues/${issue.id}/resolve`)).json();
  assert.equal(resolved.status, 'resolved');
  assert.ok(notifications.listNotifications(viewer).items.some((n) => /Issue resolved/.test(n.title)));
  assert.equal((await call(viewer, 'POST', `/issues/${issue.id}/reopen`)).json().status, 'open');
  assert.equal((await call(viewer, 'DELETE', `/issues/${issue.id}`)).statusCode, 403); // has comments
  assert.equal((await call(manager, 'DELETE', `/issues/${issue.id}`)).statusCode, 200);
});

test('bulk user permissions and watchlist auto-request', async () => {
  const res = await call(admin, 'PATCH', '/users/bulk', { userIds: [viewer.id, blocked.id], requestPermissions: { show: 'auto', watchlistAutoRequest: true } });
  assert.equal(res.statusCode, 200);
  const [v, b] = res.json();
  assert.equal(v.requestPermissions.show, 'auto');
  assert.equal(b.requestPermissions.show, 'auto');
  assert.equal(b.requestPermissions.movie, 'none'); // untouched
  assert.equal((await call(viewer, 'PATCH', '/users/bulk', { userIds: [viewer.id], requestPermissions: { manageRequests: true } })).statusCode, 403);

  const w = (await call(viewer, 'POST', '/discover/watchlist', { mediaType: 'show', tmdbId: '700' })).json();
  assert.ok(w.requestId);
  assert.equal(requests.getRequest(admin, w.requestId).status, 'processing'); // show: auto
  const wb = (await call(blocked, 'POST', '/discover/watchlist', { mediaType: 'movie', tmdbId: '701' })).json();
  assert.equal(wb.requestId, null);
  assert.match(wb.autoRequestError, /permission/);
  assert.equal((await call(viewer, 'GET', '/discover/watchlist')).json().length, 1);
});
