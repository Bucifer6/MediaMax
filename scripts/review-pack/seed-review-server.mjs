#!/usr/bin/env node
/**
 * Seeds (and keeps resetting) a Kinora server for app-store review, using only the public REST API.
 *
 *   node seed-review-server.mjs            # once
 *   REVIEW_RESET_HOURS=6 node seed-review-server.mjs   # again every 6 hours (what the compose "seed" service does)
 *
 * It is idempotent. Each run:
 *   1. runs first-time setup (server name + admin account) if the server is new, else signs in as that admin;
 *   2. sets the demo branding and turns off the features that would show third-party content (requests/Discover,
 *      IPTV VOD) or that a reviewer doesn't need (DVR);
 *   3. adds the Movies, TV Shows, Music, Audiobooks and Photos libraries from the review pack (metadata fetching off,
 *      so nothing is looked up online) and rescans them;
 *   4. writes the podcast feed, the Live TV playlist and a fresh 7-day guide into the fixtures folder, subscribes to
 *      the podcast and adds the test channels (when REVIEW_LIVETV is not 0);
 *   5. creates the reviewer account or puts it back as it should be: password, permissions, enabled, no 2FA.
 *
 * Settings (environment variables):
 *   KINORA_URL              Kinora as this script reaches it            (default http://kinora:8484)
 *   REVIEW_ADMIN_USERNAME   admin account created at setup             (default review-admin)
 *   REVIEW_ADMIN_PASSWORD   required
 *   REVIEW_USERNAME         the account App Review signs in with       (default appreview)
 *   REVIEW_PASSWORD         required
 *   REVIEW_SERVER_NAME      shown on the sign-in screen                (default Kinora Demo)
 *   REVIEW_PACK_DIR         unzipped review pack                       (default: the folder above this script)
 *   REVIEW_MEDIA_ROOT       the pack's library/ folder as Kinora sees it (default /media)
 *   REVIEW_FIXTURES_DIR     writable folder served by the fixtures web server (default /fixtures/gen)
 *   REVIEW_FIXTURES_URL     that web server as Kinora reaches it       (default http://fixtures)
 *   REVIEW_LIVETV           1 = add the generated test channels         (default 1)
 *   REVIEW_PUBLIC_URL       e.g. https://kinora-review.example.com (optional; shown in links the server makes)
 *   REVIEW_RESET_HOURS      repeat every N hours; 0 = run once          (default 0)
 *
 * No dependencies beyond Node 22 or newer (it runs inside the Kinora image in the compose file).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { podcastFeed, m3uPlaylist, xmltvGuide } from './lib/fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = (k, d) => (process.env[k] != null && process.env[k] !== '' ? process.env[k] : d);
const cfg = {
  base: env('KINORA_URL', 'http://kinora:8484').replace(/\/+$/, ''),
  adminUser: env('REVIEW_ADMIN_USERNAME', 'review-admin'),
  adminPass: env('REVIEW_ADMIN_PASSWORD'),
  user: env('REVIEW_USERNAME', 'appreview'),
  pass: env('REVIEW_PASSWORD'),
  serverName: env('REVIEW_SERVER_NAME', 'Kinora Demo'),
  pack: path.resolve(env('REVIEW_PACK_DIR', path.join(here, '..'))),
  mediaRoot: env('REVIEW_MEDIA_ROOT', '/media'),
  fixturesDir: env('REVIEW_FIXTURES_DIR', '/fixtures/gen'),
  fixturesUrl: env('REVIEW_FIXTURES_URL', 'http://fixtures').replace(/\/+$/, ''),
  liveTv: env('REVIEW_LIVETV', '1') !== '0',
  publicUrl: env('REVIEW_PUBLIC_URL', null),
  resetHours: Number(env('REVIEW_RESET_HOURS', '0')) || 0,
};

const log = (m) => console.log(`${new Date().toISOString()} [review-seed] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEVICE = { 'X-Kinora-Device-Id': 'review-seed', 'X-Kinora-Device-Name': 'Review server seeder', 'X-Kinora-Platform': 'web' };

/** Password rules for the reviewer: long enough that bots won't guess it, no characters that are hard to type on a TV. */
export function checkPassword(p, who) {
  if (!p) throw new Error(`${who} is not set`);
  if (p.length < 12) throw new Error(`${who} must be at least 12 characters`);
  if (/^change-?me/i.test(p) || /^<.*>$/.test(p)) throw new Error(`${who} is still the placeholder from .env.example`);
}

async function call(token, method, p, body) {
  const res = await fetch(`${cfg.base}/api/v1${p}`, {
    method,
    headers: { ...DEVICE, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`${method} ${p} → ${res.status}: ${text.slice(0, 300)}`), { status: res.status });
  return text ? JSON.parse(text) : null;
}
const api = (token) => ({
  get: (p) => call(token, 'GET', p),
  post: (p, b = {}) => call(token, 'POST', p, b),
  put: (p, b) => call(token, 'PUT', p, b),
  patch: (p, b) => call(token, 'PATCH', p, b),
  del: (p) => call(token, 'DELETE', p),
});

async function waitForServer() {
  for (let i = 0; ; i++) {
    try {
      return await call(null, 'GET', '/system/info');
    } catch (e) {
      if (i % 10 === 0) log(`waiting for Kinora at ${cfg.base} (${e.message})`);
      await sleep(3000);
    }
  }
}

async function adminSession(info) {
  if (info.setupRequired) {
    log(`first-time setup: server "${cfg.serverName}", admin "${cfg.adminUser}"`);
    const r = await call(null, 'POST', '/setup', { serverName: cfg.serverName, username: cfg.adminUser, password: cfg.adminPass });
    return api(r.token);
  }
  const r = await call(null, 'POST', '/auth/login', { username: cfg.adminUser, password: cfg.adminPass });
  if (!r?.token) throw new Error('Admin sign-in did not return a token (is two-factor turned on for the review admin? Turn it off for this account.)');
  return api(r.token);
}

const LIBRARIES = [
  ['Movies', 'movies', 'Movies'],
  ['TV Shows', 'shows', 'TV'],
  ['Music', 'music', 'Music'],
  ['Audiobooks', 'audiobooks', 'Audiobooks'],
  ['Photos', 'photos', 'Photos'],
  ['Open Movies (CC BY)', 'movies', 'Movies (CC BY)'],
];

async function ensureLibraries(admin) {
  const have = await admin.get('/libraries');
  for (const [name, type, dir] of LIBRARIES) {
    const local = path.join(cfg.pack, 'library', dir);
    if (!fs.existsSync(local)) continue; // optional extras only when they were built
    const paths = [path.posix.join(cfg.mediaRoot, dir)];
    const lib = have.find((l) => l.name === name);
    if (!lib) {
      log(`adding library ${name}`);
      await admin.post('/libraries', { name, type, paths, fetchMetadata: false });
    } else if (lib.fetchMetadata !== false || JSON.stringify(lib.paths) !== JSON.stringify(paths)) {
      await admin.patch(`/libraries/${lib.id}`, { paths, fetchMetadata: false });
    }
  }
  await admin.post('/libraries/scan', {});
  const t0 = Date.now();
  await sleep(1500);
  while (Date.now() - t0 < 15 * 60000) {
    const libs = (await admin.get('/libraries')).filter((l) => l.type !== 'podcasts' && !String(l.type).startsWith('iptv'));
    if (libs.every((l) => !l.scanning)) {
      log(`libraries: ${libs.map((l) => `${l.name} ${l.itemCount ?? '?'}`).join(', ')}`);
      return;
    }
    await sleep(2000);
  }
  log('scans still running after 15 minutes; carrying on');
}

async function configure(admin) {
  await admin.put('/branding', {
    serverName: cfg.serverName,
    loginMessage: 'Demo server for app review. Every film, song, story and photo here was generated by the Kinora project or is in the public domain (CC0).',
    features: { liveTv: cfg.liveTv, iptvVod: false, dvr: false, requests: false, music: true, photos: true, downloads: true, syncPlay: true, linkCodes: true, profilePicker: false },
  });
  const s = await admin.get('/settings');
  const patch = { requests: { ...s.requests, enabled: false } };
  if (cfg.publicUrl) patch.publicUrl = cfg.publicUrl;
  if (s.trickplay) patch.trickplay = { ...s.trickplay, enabled: true };
  await admin.put('/settings', patch);
}

function writeFixtures() {
  fs.mkdirSync(cfg.fixturesDir, { recursive: true });
  const write = (name, text) => {
    const tmp = path.join(cfg.fixturesDir, `.${name}.tmp`);
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, path.join(cfg.fixturesDir, name));
  };
  const show = JSON.parse(fs.readFileSync(path.join(cfg.pack, 'fixtures', 'podcast', 'show.json'), 'utf8'));
  write('podcast.xml', podcastFeed({ base: `${cfg.fixturesUrl}/pack/podcast`, show, episodes: show.episodes }));
  const channels = JSON.parse(fs.readFileSync(path.join(cfg.pack, 'fixtures', 'livetv', 'channels.json'), 'utf8'));
  write('guide.xml', xmltvGuide({ channels }));
  write('channels.m3u', m3uPlaylist({ streamBase: `${cfg.fixturesUrl}/live`, logoBase: `${cfg.fixturesUrl}/pack/livetv/logos`, channels }));
  return { show, channels };
}

async function ensurePodcast(admin) {
  const feedUrl = `${cfg.fixturesUrl}/gen/podcast.xml`;
  const subs = await admin.get('/podcasts');
  const sub = subs.find((p) => p.feedUrl === feedUrl);
  if (sub) await admin.post(`/podcasts/${sub.id}/refresh`, {}).catch((e) => log(`podcast refresh: ${e.message}`));
  else {
    log('subscribing to the demo podcast');
    await admin.post('/podcasts', { feedUrl, autoDownload: false });
  }
}

async function ensureLiveTv(admin) {
  const name = 'Kinora Test Channels';
  const sources = await admin.get('/livetv/sources');
  const src = sources.find((s) => s.name === name);
  const want = { url: `${cfg.fixturesUrl}/gen/channels.m3u`, epgUrl: `${cfg.fixturesUrl}/gen/guide.xml` };
  if (!cfg.liveTv) {
    if (src) await admin.del(`/livetv/sources/${src.id}`);
    return;
  }
  if (!src) {
    log('adding the generated Live TV test channels');
    await admin.post('/livetv/sources', { name, type: 'm3u', ...want, proxyStreams: true, importVod: false, importSeries: false, refreshIntervalHours: 12 });
  } else {
    if (src.url !== want.url || src.epgUrl !== want.epgUrl) await admin.patch(`/livetv/sources/${src.id}`, want);
    await admin.post(`/livetv/sources/${src.id}/refresh`, {}).catch((e) => log(`live TV refresh: ${e.message}`));
  }
}

/** The reviewer: a normal (not admin) account, allowed to stream from outside the LAN, no DVR. */
export function reviewerPolicy(liveTv) {
  return { isAdmin: false, allowRemote: true, allowLiveTv: liveTv, allowDownloads: true, allowTranscode: true, allowDvr: false, allowRequest4k: false, maxStreams: 3, maxContentRating: null, libraryIds: null, showOnSignIn: false, disabled: false };
}

async function ensureReviewer(admin) {
  const users = await admin.get('/users');
  const u = users.find((x) => x.username.toLowerCase() === cfg.user.toLowerCase());
  const policy = reviewerPolicy(cfg.liveTv);
  if (!u) {
    log(`creating reviewer account "${cfg.user}"`);
    const { disabled: _d, ...create } = policy;
    await admin.post('/users', { username: cfg.user, displayName: 'App Review', password: cfg.pass, ...create });
    return;
  }
  if (u.isAdmin) throw new Error(`"${cfg.user}" is an admin account; use a different REVIEW_USERNAME`);
  await admin.patch(`/users/${u.id}`, { displayName: 'App Review', password: cfg.pass, ...policy });
  if (u.totpEnabled) await admin.del(`/users/${u.id}/2fa`).catch((e) => log(`2FA reset: ${e.message}`));
  log(`reviewer "${cfg.user}" reset (password, permissions${u.totpEnabled ? ', 2FA off' : ''})`);
}

async function verifyReviewer(version) {
  const r = await call(null, 'POST', '/auth/login', { username: cfg.user, password: cfg.pass });
  // Subtitles on (English) so the subtitle feature is visible at once; skip the "What's new" card for this version.
  await api(r.token).patch('/auth/me', { preferences: { subtitleMode: 'always', subtitleLanguage: 'en', ...(version ? { whatsNewSeen: version } : {}) } }).catch((e) => log(`reviewer preferences: ${e.message}`));
  const me = await api(r.token).get('/auth/me');
  const home = await api(r.token).get('/home');
  const rows = (home.rows ?? home).length;
  await api(r.token).post('/auth/logout', {}).catch(() => undefined);
  log(`check: "${me.username}" can sign in; home has ${rows} rows`);
}

export async function seedOnce() {
  checkPassword(cfg.adminPass, 'REVIEW_ADMIN_PASSWORD');
  checkPassword(cfg.pass, 'REVIEW_PASSWORD');
  if (cfg.adminUser.toLowerCase() === cfg.user.toLowerCase()) throw new Error('REVIEW_USERNAME must differ from REVIEW_ADMIN_USERNAME');
  const info = await waitForServer();
  const admin = await adminSession(info);
  await configure(admin);
  writeFixtures();
  await ensureLibraries(admin);
  await ensurePodcast(admin).catch((e) => log(`podcast: ${e.message}`));
  await ensureLiveTv(admin).catch((e) => log(`live TV: ${e.message}`));
  await ensureReviewer(admin);
  await verifyReviewer(info.version);
}

async function main() {
  for (;;) {
    try {
      await seedOnce();
      log('done');
    } catch (e) {
      log(`failed: ${e.message}`);
      if (!cfg.resetHours) process.exit(1);
    }
    if (!cfg.resetHours) return;
    log(`next reset in ${cfg.resetHours} h`);
    await sleep(cfg.resetHours * 3600000);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
