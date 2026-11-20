import fs from 'node:fs';
import path from 'node:path';
import { client, waitFor, sleep } from './server.mjs';
import { USERS, MOVIES, SHOWS } from './catalog.mjs';
import { XTREAM_USER, XTREAM_PASS } from './mock.mjs';

const DAY = 86400000;
const HOUR = 3600000;

/** Realistic sign-in noise for the security page (documentation-range IPs only) and a reverse-proxy access log. */
export function seedLogs(dataDir, now = Date.now()) {
  const logs = path.join(dataDir, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const lines = [];
  const attackers = [
    ['203.0.113.47', 60, ['admin', 'root', 'administrator', 'test'], 'password'],
    ['198.51.100.23', 34, ['admin', 'sam', 'guest'], 'password'],
    ['203.0.113.118', 18, ['admin'], 'api_key'],
    ['198.51.100.201', 12, ['alex', 'admin'], 'subsonic'],
    ['192.0.2.66', 9, ['kids'], 'pin'],
    ['203.0.113.9', 6, ['sam'], 'totp'],
  ];
  for (const [ip, n, users, reason] of attackers) {
    const burst = now - rnd() * 20 * HOUR;
    for (let i = 0; i < n; i++) {
      const t = i < n * 0.7 ? burst + i * rnd() * 40000 : now - rnd() * 7 * DAY;
      const user = reason === 'api_key' ? null : pick(users);
      lines.push([t, `mediamax[security] AUTH_FAIL ip=${ip}${user ? ` user="${user}"` : ''} reason=${reason}`]);
    }
    if (n > 30) lines.push([burst + n * 20000, `mediamax[security] AUTH_LOCKED ip=${ip} user="admin"`]);
  }
  for (let i = 0; i < 40; i++) lines.push([now - rnd() * DAY, `mediamax[security] AUTH_OK ip=192.168.1.${pick([20, 31, 44, 52])} user="${pick(['sam', 'alex', 'kids'])}"`]);
  lines.sort((a, b) => a[0] - b[0]);
  fs.writeFileSync(path.join(logs, 'security.log'), lines.map(([t, l]) => `${new Date(t).toISOString()} ${l}`).join('\n') + '\n');

  // nginx "combined" access log for the proxy panel
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p2 = (n) => String(n).padStart(2, '0');
  const ts = (t) => {
    const d = new Date(t);
    return `${p2(d.getUTCDate())}/${mon[d.getUTCMonth()]}/${d.getUTCFullYear()}:${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000`;
  };
  const access = [];
  const good = ['192.0.2.10', '192.0.2.24', '198.51.100.7', '203.0.113.200'];
  const paths = [['GET', '/api/v1/home', 200, 18000], ['GET', '/api/v1/images/abc?w=300', 200, 42000], ['GET', '/api/v1/stream/direct/m1', 206, 2400000], ['GET', '/api/v1/items?type=movie', 200, 30000], ['GET', '/', 200, 1200], ['GET', '/assets/index.js', 304, 0], ['POST', '/api/v1/playback/sessions/s1/progress', 200, 40], ['GET', '/api/v1/livetv/guide', 200, 52000]];
  for (let i = 0; i < 2400; i++) {
    const t = now - Math.pow(rnd(), 0.8) * DAY;
    const [m, p, st, b] = pick(paths);
    access.push([t, `${pick(good)} - - [${ts(t)}] "${m} ${p} HTTP/2.0" ${rnd() < 0.004 ? 502 : st} ${Math.round(b * (0.5 + rnd()))} "-" "Mozilla/5.0"`]);
  }
  for (const [ip, n] of attackers) for (let i = 0; i < n * 2; i++) {
    const t = now - rnd() * DAY;
    access.push([t, `${ip} - - [${ts(t)}] "${pick(['POST /api/v1/auth/login', 'GET /wp-login.php', 'GET /.env', 'GET /rest/ping.view'])} HTTP/1.1" ${pick([401, 401, 404, 403])} 120 "-" "python-requests/2.31"`]);
  }
  access.sort((a, b) => a[0] - b[0]);
  fs.writeFileSync(path.join(logs, 'access.log'), access.map((x) => x[1]).join('\n') + '\n');
  return path.join(logs, 'access.log');
}

/** Setup, libraries, users, history, DJ analysis and Live TV. Returns ids and tokens the screenshots need. */
export async function seedServer({ base, media, data, mockBase, avatars, log }) {
  const setup = await (await fetch(`${base}/api/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serverName: 'MediaMax Demo', username: USERS.admin.username, password: USERS.admin.password }) })).json();
  if (!setup.token) throw new Error('Setup failed: ' + JSON.stringify(setup));
  const admin = client(base, setup.token);
  await admin.patch('/auth/me', { displayName: USERS.admin.displayName, preferences: { autoplayPreviews: false } });

  log('Creating libraries and scanning…');
  for (const [name, type, dir] of [['Movies', 'movies', 'Movies'], ['TV Shows', 'shows', 'TV'], ['Music', 'music', 'Music'], ['Audiobooks', 'audiobooks', 'Audiobooks'], ['Photos', 'photos', 'Photos']]) {
    await admin.post('/libraries', { name, type, paths: [path.join(media, dir)], fetchMetadata: false });
  }
  await waitFor(async () => {
    const libs = await admin.get('/libraries');
    return libs.length >= 5 && libs.every((l) => !l.scanning && l.itemCount > 0);
  }, 180000, 'library scans');
  // Some probes fail at random under load (ffprobe output is read before the pipe drains, see the report), which
  // leaves items without a duration. Re-scanning probes only those files again.
  for (let attempt = 0; attempt < 5; attempt++) {
    const missing = (await admin.get('/items?type=movie,episode,track&limit=500')).items.filter((i) => !i.durationMs);
    if (!missing.length) break;
    log(`  re-probing ${missing.length} files…`);
    for (const lib of await admin.get('/libraries')) {
      await admin.post(`/libraries/${lib.id}/scan`, {});
      await sleep(800);
      await waitFor(async () => !(await admin.get('/libraries')).find((l) => l.id === lib.id)?.scanning, 120000, 'rescan');
    }
  }

  // Users
  const alexUser = await admin.post('/users', { username: USERS.alex.username, displayName: USERS.alex.displayName, password: USERS.alex.password });
  const kidsUser = await admin.post('/users', { username: USERS.kids.username, displayName: USERS.kids.displayName, password: USERS.kids.password, maxContentRating: USERS.kids.maxContentRating, allowLiveTv: true });
  const login = async (u) => client(base, (await (await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-MediaMax-Device-Id': `demo-${u.username}`, 'X-MediaMax-Device-Name': u.username === 'kids' ? 'Living Room TV' : 'Alex iPad', 'X-MediaMax-Platform': u.username === 'kids' ? 'tv' : 'ios' }, body: JSON.stringify({ username: u.username, password: u.password }) })).json()).token);
  const alex = await login(USERS.alex);
  const kids = await login(USERS.kids);
  for (const [id, file] of [[setup.user.id, avatars.sam], [alexUser.id, avatars.alex], [kidsUser.id, avatars.kids]]) await admin.upload(`/users/${id}/avatar`, file).catch((e) => log('  avatar upload skipped: ' + e.message));

  // Look-ups
  const all = (await admin.get('/items?type=movie,show&limit=200')).items;
  const byTitle = (t) => {
    const it = all.find((i) => i.title === t);
    if (!it) throw new Error(`Missing item ${t}`);
    return it.id;
  };
  const M = Object.fromEntries(MOVIES.map((m) => [m.slug, byTitle(m.title)]));
  const S = Object.fromEntries(SHOWS.map((s) => [s.slug, byTitle(s.title)]));
  const episodes = async (showId) => (await admin.get(`/items?ancestorId=${showId}&type=episode&sort=index&limit=100`)).items.sort((a, b) => (a.parentIndex ?? 0) - (b.parentIndex ?? 0) || (a.index ?? 0) - (b.index ?? 0));
  const E = { frontier: await episodes(S['quiet-frontier']), harbor: await episodes(S['harbor-lights']), bakery: await episodes(S['night-shift-bakery']) };
  const albums = (await admin.get('/items?type=album&limit=50')).items;
  const tracks = (await admin.get('/items?type=track&limit=200')).items;
  const dur = async (id) => (await admin.get(`/items/${id}`)).durationMs ?? 6000000;
  const progress = async (c, id, frac) => c.post(`/items/${id}/progress`, { positionMs: Math.round((await dur(id)) * frac), durationMs: await dur(id), state: 'stopped' });

  log('Building viewing history…');
  // Sam (admin): sci-fi and crime fan.
  for (const id of [M['rainwater-alley'], M['orbital-hearts'], M['last-lighthouse-kepler']]) await admin.post(`/items/${id}/played`);
  for (const e of E.frontier.slice(0, 3)) await admin.post(`/items/${e.id}/played`);
  for (const e of E.bakery.slice(0, 2)) await admin.post(`/items/${e.id}/played`);
  for (const e of E.harbor.slice(0, 2)) await admin.post(`/items/${e.id}/played`);
  await progress(admin, E.harbor[2].id, 0.38);
  await progress(admin, M['lemon-trees'], 0.71);
  await progress(admin, M['velvet-ledger'], 0.22);
  await progress(admin, M['signal-drift'], 0.46);
  for (const id of [M['last-lighthouse-kepler'], M['rainwater-alley'], S['quiet-frontier']]) await admin.post(`/items/${id}/favorite`);
  await admin.post(`/items/${M['last-lighthouse-kepler']}/rating`, { rating: 10 });
  for (const id of [M['cartographers-gambit'], S['harbor-lights'], M['static-bloom'], M['paper-kites'], M['crimson-freight'], M['hollow-choir'], M['neon-meridian']]) await admin.post(`/items/${id}/watchlist`);
  const afterglow = albums.find((a) => a.title === 'Afterglow Avenue');
  if (afterglow) await admin.post(`/items/${afterglow.id}/favorite`);
  for (const t of tracks.filter((t) => t.grandparentTitle === 'Neon Cartography' || t.parentTitle === 'Low Sun Sessions').slice(0, 5)) await admin.post(`/items/${t.id}/favorite`);

  // Alex: thrillers and horror.
  for (const id of [M['neon-meridian'], M['static-bloom'], M['birch-house'], M['crimson-freight'], M['hotel-ostrava'], M['rainwater-alley'], M['signal-drift']]) await alex.post(`/items/${id}/played`);
  for (const e of E.frontier.slice(0, 5)) await alex.post(`/items/${e.id}/played`);
  for (const e of E.harbor) await alex.post(`/items/${e.id}/played`);
  await progress(alex, M['hollow-choir'], 0.33);
  await alex.post(`/items/${M['neon-meridian']}/favorite`);
  await alex.post(`/items/${M['velvet-ledger']}/watchlist`);

  // Kids: family titles.
  for (const id of [M['pip-moon-machine'], M['sock-rebellion'], M['paper-kites']]) await kids.post(`/items/${id}/played`);
  await kids.post(`/items/${M['pip-moon-machine']}/favorite`);
  await progress(kids, M['sock-rebellion'], 0.4).catch(() => undefined);

  // DJ analysis
  log('Analysing music for the DJ…');
  await admin.post('/dj/analyze');
  await waitFor(async () => {
    const s = await admin.get('/dj/status');
    return !s.running && s.analyzed >= s.total && s.total > 0;
  }, 240000, 'DJ analysis');

  // Live TV
  log('Adding the Live TV provider…');
  await admin.post('/livetv/sources', { name: 'Demo IPTV', type: 'xtream', url: mockBase, username: XTREAM_USER, password: XTREAM_PASS, proxyStreams: true, importVod: false, importSeries: false });
  const channels = await waitFor(async () => {
    const r = await admin.get('/livetv/channels?limit=100');
    return r.items?.length >= 10 ? r.items : null;
  }, 60000, 'Live TV channels');
  await waitFor(async () => {
    const g = await admin.get('/livetv/guide');
    return (g.programs?.length ?? 0) > 20;
  }, 60000, 'EPG').catch((e) => log('  ' + e.message));
  for (const c of channels.filter((c) => /News|Pulse|Wildscape/.test(c.name))) await admin.post(`/livetv/channels/${c.id}/favorite`).catch(() => undefined);

  // Direct DB touches for things the API can't backdate: spread "date added", play history for charts and Top 10,
  // and upcoming episodes for the calendar (there is no TMDB in the demo).
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(data, 'mediamax.db'));
  const iso = (ms) => new Date(ms).toISOString();
  const now = Date.now();
  MOVIES.forEach((m, i) => db.prepare('UPDATE items SET added_at = ? WHERE id = ?').run(iso(now - (m.slug === 'neon-meridian' ? 0.2 : 1 + ((i * 7) % 40)) * DAY), M[m.slug]));
  for (const [k, list] of Object.entries(E)) list.forEach((e, i) => db.prepare('UPDATE items SET added_at = ? WHERE id = ?').run(iso(now - (i >= 3 ? (6 - i) * 1.3 + (k === 'bakery' ? 0.5 : k === 'harbor' ? 1 : 0) : 30 + i) * DAY), e.id));
  const users = { sam: setup.user.id, alex: alexUser.id, kids: kidsUser.id };
  const ins = db.prepare('INSERT INTO play_history (user_id, item_id, started_at, ended_at, duration_ms, method, platform) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const plays = [
    ['sam', [M['last-lighthouse-kepler'], M['rainwater-alley'], M['orbital-hearts'], M['signal-drift'], M['lemon-trees'], M['velvet-ledger']]],
    ['alex', [M['neon-meridian'], M['static-bloom'], M['birch-house'], M['crimson-freight'], M['hotel-ostrava'], M['rainwater-alley'], M['hollow-choir'], M['signal-drift']]],
    ['kids', [M['pip-moon-machine'], M['sock-rebellion'], M['paper-kites']]],
  ];
  let k = 0;
  for (const [u, ids] of plays) for (const id of ids) {
    const t = now - (0.3 + ((k++ * 5) % 13) * 0.45) * DAY;
    ins.run(users[u], id, iso(t), iso(t + 95 * 60000), 95 * 60000, k % 3 ? 'DirectPlay' : 'Transcode', ['web', 'ios', 'tv'][k % 3]);
  }
  for (const [u, list] of [['sam', [...E.frontier.slice(0, 3), ...E.bakery.slice(0, 2), ...E.harbor.slice(0, 3)]], ['alex', [...E.frontier.slice(0, 5), ...E.harbor]]]) {
    list.forEach((e, i) => {
      const t = now - (0.2 + i * 0.6) * DAY;
      ins.run(users[u], e.id, iso(t), iso(t + 45 * 60000), 45 * 60000, 'DirectPlay', u === 'sam' ? 'web' : 'ios');
    });
  }
  // Older history (last 30 days) so the admin charts have shape.
  const pool = Object.values(M);
  for (let i = 0; i < 70; i++) {
    const t = now - (2 + (i * 37) % 28 + (i % 5) * 0.13) * DAY;
    ins.run(Object.values(users)[i % 3], pool[(i * 7) % pool.length], iso(t), iso(t + 80 * 60000), (40 + (i % 6) * 15) * 60000, i % 4 ? 'DirectPlay' : 'Transcode', ['web', 'ios', 'tv', 'android'][i % 4]);
  }
  for (let i = 0; i < 60; i++) {
    const t = now - ((i * 13) % 20) * DAY - (i % 7) * HOUR;
    const tr = tracks[(i * 5) % tracks.length];
    if (tr) ins.run(users.sam, tr.id, iso(t), iso(t + 50000), 50000 + 140000, 'DirectPlay', 'web');
  }
  const day = (n) => new Date(now + n * DAY).toISOString().slice(0, 10);
  const sch = db.prepare('INSERT OR REPLACE INTO show_schedule (show_id, status, in_production, last_air_date, next_air_date, next_season, next_episode, next_title, next_overview, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)');
  sch.run(S['quiet-frontier'], 'Returning Series', day(-5), day(2), 3, 1, 'Ghosts of the Halcyon', 'A signal from the ship’s abandoned lower decks wakes the crew.', iso(now));
  sch.run(S['harbor-lights'], 'Returning Series', day(-9), day(5), 3, 1, 'Spring Tide', 'A storm surge uncovers a boat buried in the dunes for forty years.', iso(now));
  sch.run(S['night-shift-bakery'], 'Returning Series', day(-3), day(11), 3, 1, 'Grand Reopening', 'The bakery reopens after the renovation, and nothing is where it used to be.', iso(now));
  db.close();

  return {
    token: setup.token, adminId: setup.user.id, admin, alex, kids, alexId: alexUser.id, kidsId: kidsUser.id,
    M, S, E, albums, tracks, channels,
  };
}

/**
 * Everything the feature screenshots need on top of seedServer: profiles, requests (some waiting for approval) and
 * issues, *arr instances with a download queue, Home Assistant over MQTT, disk spin-down, Play to devices, trickplay.
 * `mocks` is scripts/e2e/mocks.mjs (TMDB, Radarr, Sonarr); `devices` and `mqtt` come from lib/devices.mjs.
 */
export async function seedFeatures({ base, admin, alex, kids, alexId, M, S, mocks, devices, mqtt, arrKey, log }) {
  const version = (await (await fetch(`${base}/api/v1/system/info`)).json()).version;
  for (const c of [admin, alex, kids]) await c.patch('/auth/me', { preferences: { whatsNewSeen: version } });

  log('Requests, issues and downloads…');
  await admin.put('/settings', {
    tmdbApiKey: 'demo-tmdb-key',
    requests: { enabled: true },
    arr: [
      { id: 'radarr-demo', kind: 'radarr', name: 'Radarr', url: `${mocks.base}/radarr`, apiKey: arrKey, enabled: true, qualityProfileId: 1, rootFolderPath: '/radarr', tags: [] },
      { id: 'sonarr-demo', kind: 'sonarr', name: 'Sonarr', url: `${mocks.base}/sonarr`, apiKey: arrKey, enabled: true, qualityProfileId: 1, rootFolderPath: '/sonarr', languageProfileId: 2, tags: [] },
    ],
  });
  await admin.patch(`/users/${alexId}`, { requestPermissions: { movie: 'request', show: 'request', reportIssues: true } });
  const req = (c, body) => c.post('/requests', body).catch((e) => log('  request skipped: ' + e.message));
  await req(admin, { mediaType: 'movie', tmdbId: '9004', title: 'Parallel Postcards' });
  const copper = await req(alex, { mediaType: 'movie', tmdbId: '9002', title: 'Copper Tide' });
  if (copper?.id) await admin.post(`/requests/${copper.id}/approve`).catch((e) => log('  approve skipped: ' + e.message));
  await req(alex, { mediaType: 'show', tmdbId: '9502', title: 'Midnight Cartographers', seasonMode: 'all' });
  await req(alex, { mediaType: 'movie', tmdbId: '9001', title: 'The Glass Orchard', note: 'Saw the trailer, looks beautiful!' });
  await req(alex, { mediaType: 'movie', tmdbId: '9008', title: 'Gravity Garden' });

  const issue = await alex.post('/issues', { itemId: M['crimson-freight'], kind: 'audio', message: 'The dialogue drifts out of sync after about twenty minutes.' }).catch((e) => log('  issue skipped: ' + e.message));
  if (issue?.id) await admin.post(`/issues/${issue.id}/comments`, { body: 'Thanks! Re-muxing the file tonight, I will let you know.' }).catch(() => undefined);
  const ep = (await admin.get(`/items?ancestorId=${S['harbor-lights']}&type=episode&sort=index&limit=10`)).items[1];
  if (ep) await alex.post('/issues', { itemId: ep.id, kind: 'subtitle', message: 'English subtitles are missing for this episode.' }).catch(() => undefined);
  const resolved = await alex.post('/issues', { itemId: M['velvet-ledger'], kind: 'video', message: 'Picture freezes at 1:02:10.' }).catch(() => null);
  if (resolved?.id) await admin.post(`/issues/${resolved.id}/resolve`).catch(() => undefined);

  log('Profiles…');
  for (const p of [{ displayName: 'Jamie', avatarId: 'robot' }, { displayName: 'Robin', avatarId: 'owl' }, { displayName: 'Mia', avatarId: 'panda', isKids: true, pin: '2468', kidsTheme: true }]) {
    await admin.post('/profiles', p).catch((e) => log('  profile skipped: ' + e.message));
  }

  log('Smart home, storage and Play to devices…');
  await admin.put('/integrations/home-assistant', { mqtt: { enabled: true, brokerUrl: mqtt.url, username: 'homeassistant', password: 'demo-mqtt', baseTopic: 'mediamax', discoveryPrefix: 'homeassistant', perDeviceSensors: true, tls: false, tlsInsecure: false } });
  await waitFor(async () => (await admin.get('/integrations/home-assistant')).status?.mqtt?.state === 'connected', 15000, 'MQTT connection').catch((e) => log('  ' + e.message));
  await admin.post('/integrations/home-assistant/discovery').catch((e) => log('  discovery skipped: ' + e.message));
  await admin.put('/storage', { diskFriendly: true, windowStart: '02:00', windowEnd: '06:00', piggyback: true, checkDiskState: true, watchMode: 'native' });
  await admin.put('/admin/renderers/settings', { enabled: true, mdns: false });
  for (const d of [
    { kind: 'dlna', descriptionUrl: `${devices.base}/tv/desc.xml` },
    { kind: 'kodi', host: '127.0.0.1', port: devices.port, name: 'Den Kodi' },
    { kind: 'dlna', descriptionUrl: `${devices.base}/speaker/desc.xml` },
  ]) await admin.post('/admin/renderers/manual', d).catch((e) => log('  device skipped: ' + e.message));

  log('Trickplay thumbnails…');
  await admin.put('/settings', { trickplay: { enabled: true, intervalSeconds: 10, width: 320 } });
  await admin.post('/tasks/trickplay/run').catch((e) => log('  trickplay task: ' + e.message));
  await waitFor(async () => !!(await admin.get(`/items/${M['crimson-freight']}/trickplay`).catch(() => null))?.sheets, 240000, 'trickplay thumbnails').catch((e) => log('  ' + e.message));
}

export { sleep };
