/**
 * Seeds a Vibe data folder with a synthetic large install, straight into SQLite (no media files needed).
 *
 *   node scripts/perf/seed.mjs <dataDir> [--scale=1]
 *
 * Scale 1 ≈ the "big home server" target: 20k movies, 2k shows / ~60k episodes, ~30k people, 80 users with watch
 * history, 3,000 IPTV channels with a 3-day guide (~430k programmes), 200 real (tiny) artwork files.
 * The server must have been booted once on the folder (schema + admin account); see run.mjs, which does that.
 * Writes <dataDir>/perf-manifest.json with sample ids and per-user tokens for the benchmark.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const dataDir = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) {
  console.error('usage: node scripts/perf/seed.mjs <dataDir> [--scale=1]');
  process.exit(2);
}
const scale = Number(process.argv.find((a) => a.startsWith('--scale='))?.split('=')[1] ?? 1);
const N = {
  movies: Math.round(20000 * scale),
  shows: Math.round(2000 * scale),
  seasonsPerShow: 4,
  episodesPerSeason: 8, // 2k shows × 4 × ~7.5 avg ≈ 60k episodes
  people: Math.round(30000 * scale),
  users: 80,
  channels: Math.round(3000 * scale),
  guideHours: 72,
  images: 200,
};

let seed = 1234567;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (a) => a[Math.floor(rnd() * a.length)];
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const id = (p, n) => `${p}${n.toString(36).padStart(6, '0')}`;
const iso = (t) => new Date(t).toISOString();
const NOW = Date.now();
const DAY = 86400000;

const WORDS = 'shadow river night star iron glass silent last broken golden lost hidden dark wild crimson frozen secret winter summer burning electric quiet empty endless distant falling rising hollow paper stone ocean desert city garden mirror machine dream ghost echo signal storm thunder velvet neon silver black white red blue green north south east west kingdom empire legacy protocol horizon frontier'.split(' ');
const GENRES = ['Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Music', 'Mystery', 'Romance', 'Science Fiction', 'Thriller', 'War', 'Western'];
const STUDIOS = ['Northlight', 'Bluefin Pictures', 'Parallax', 'Harbor Films', 'Meridian', 'Copperline', 'Sable Studios', 'Lantern', 'Atlas Works', 'Grey Owl'];
const RATINGS = ['G', 'PG', 'PG-13', 'R', 'R', 'PG-13', 'NC-17', null, 'TV-MA', 'TV-14', 'TV-PG'];
const FIRST = 'James Mary John Patricia Robert Jennifer Michael Linda William Elizabeth David Barbara Richard Susan Joseph Jessica Thomas Sarah Charles Karen Chris Nancy Daniel Lisa Matthew Betty Anthony Sandra Mark Ashley Paul Emily Steven Donna Andrew Michelle Kenneth Carol Josh Amanda Kevin Melissa Brian Deborah George Stephanie Tim Rebecca Ron Laura'.split(' ');
const LAST = 'Smith Johnson Williams Brown Jones Garcia Miller Davis Rodriguez Martinez Hernandez Lopez Gonzalez Wilson Anderson Thomas Taylor Moore Jackson Martin Lee Perez Thompson White Harris Sanchez Clark Ramirez Lewis Robinson Walker Young Allen King Wright Scott Torres Nguyen Hill Flores Green Adams Nelson Baker Hall Rivera Campbell Mitchell Carter Roberts'.split(' ');

const title = () => {
  const n = int(1, 3);
  const w = [];
  for (let i = 0; i < n; i++) w.push(pick(WORDS));
  const t = w.join(' ');
  return (rnd() < 0.3 ? 'The ' : '') + t.charAt(0).toUpperCase() + t.slice(1);
};
const sortTitle = (t) => t.toLowerCase().replace(/^(the|a|an)\s+/, '');

const dbFile = path.join(dataDir, 'mediamax.db');
if (!fs.existsSync(dbFile)) throw new Error(`No database at ${dbFile}: boot the server on this folder first`);
const db = new DatabaseSync(dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF; PRAGMA foreign_keys = OFF;');

/* ----------------------------- artwork ----------------------------- */
const artDir = path.join(dataDir, 'perf-art');
fs.mkdirSync(artDir, { recursive: true });
const imgIds = [];
{
  // One real 600x900 JPEG, copied N times (distinct files → distinct image ids and resize cache entries).
  const base = path.join(artDir, 'base.jpg');
  if (!fs.existsSync(base)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=600x900', '-frames:v', '1', '-q:v', '4', base]);
  const ins = db.prepare('INSERT OR IGNORE INTO images (id, source, cached, created_at) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < N.images; i++) {
    const f = path.join(artDir, `art${i}.jpg`);
    if (!fs.existsSync(f)) fs.copyFileSync(base, f);
    const imgId = `perfimg${i.toString().padStart(4, '0')}`;
    ins.run(imgId, f, f, iso(NOW));
    imgIds.push(imgId);
  }
}

/* ---------------------------- libraries ---------------------------- */
const drives = Array.from({ length: 10 }, (_, i) => `/mnt/drive${i + 1}`);
const libMovies = 'perflibmovies';
const libShows = 'perflibshows';
db.prepare('INSERT INTO libraries (id, name, type, paths, fetch_metadata, sort_order, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)').run(libMovies, 'Movies', 'movies', JSON.stringify(drives.map((d) => `${d}/Movies`)), 1, iso(NOW));
db.prepare('INSERT INTO libraries (id, name, type, paths, fetch_metadata, sort_order, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)').run(libShows, 'TV Shows', 'shows', JSON.stringify(drives.map((d) => `${d}/TV`)), 2, iso(NOW));

const people = Array.from({ length: N.people }, (_, i) => `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}${i >= FIRST.length * LAST.length ? ` ${Math.floor(i / (FIRST.length * LAST.length)) + 1}` : ''}`);
const castFor = () => {
  const out = [];
  for (let k = 0; k < 12; k++) out.push({ name: pick(people), kind: 'actor', role: `${pick(FIRST)}` });
  out.push({ name: pick(people), kind: 'director' });
  out.push({ name: pick(people), kind: 'writer' });
  return JSON.stringify(out);
};
const genresFor = () => JSON.stringify([...new Set([pick(GENRES), pick(GENRES), ...(rnd() < 0.4 ? [pick(GENRES)] : [])])]);
const audio = JSON.stringify([
  { index: 1, codec: 'eac3', channels: 6, language: 'eng', title: 'English 5.1', default: true },
  { index: 2, codec: 'aac', channels: 2, language: 'spa', title: 'Spanish', default: false },
]);
const subs = JSON.stringify([
  { index: 3, codec: 'subrip', language: 'eng', title: 'English', forced: false, default: false, external: false },
  { index: 4, codec: 'subrip', language: 'spa', title: 'Spanish', forced: false, default: false, external: false },
]);

const insItem = db.prepare(`INSERT INTO items (id, library_id, type, title, sort_title, year, overview, tagline, community_rating, content_rating, duration_ms,
  genres, studios, people, poster, backdrop, thumb, parent_id, grandparent_id, idx, parent_idx, added_at, release_date, external_ids, path, extra, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`);
const insMedia = db.prepare(`INSERT INTO media (id, item_id, path, container, duration_ms, size, bitrate, width, height, video_codec, hdr, audio, subs, mtime, probed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const overview = () => Array.from({ length: 30 }, () => pick(WORDS)).join(' ') + '.';

const movieIds = [];
const showIds = [];
const seasonIds = [];
const episodeIds = [];
const episodesByShow = new Map();
console.log(`seeding ${N.movies} movies, ${N.shows} shows…`);
db.exec('BEGIN');
for (let i = 0; i < N.movies; i++) {
  const mid = id('pm', i);
  const t = title();
  const year = int(1950, 2026);
  const added = NOW - Math.floor(Math.pow(rnd(), 2) * 5 * 365 * DAY);
  const dur = int(80, 180) * 60000;
  insItem.run(mid, libMovies, 'movie', t, sortTitle(t), year, overview(), 'A tagline.', Math.round(rnd() * 90 + 10) / 10, pick(RATINGS), dur,
    genresFor(), JSON.stringify([pick(STUDIOS)]), castFor(), pick(imgIds), pick(imgIds), null, null, null, null, null, iso(added), `${year}-0${int(1, 9)}-1${int(0, 9)}`,
    JSON.stringify({ tmdb: String(100000 + i), imdb: `tt${(1000000 + i)}` }), `${pick(drives)}/Movies/${t} (${year})/${t}.mkv`, iso(added));
  const uhd = rnd() < 0.2;
  insMedia.run(`${mid}m`, mid, `${pick(drives)}/Movies/${t} (${year}) ${i}/${t}.mkv`, 'mkv', dur, int(2, 40) * 1e9, int(4, 60) * 1e6, uhd ? 3840 : 1920, uhd ? 2160 : 1080, uhd ? 'hevc' : 'h264', uhd ? 1 : 0, audio, subs, NOW, iso(added));
  movieIds.push(mid);
}
for (let s = 0; s < N.shows; s++) {
  const sid = id('ps', s);
  const t = title();
  const year = int(1990, 2025);
  const showAdded = NOW - Math.floor(Math.pow(rnd(), 2) * 5 * 365 * DAY);
  insItem.run(sid, libShows, 'show', t, sortTitle(t), year, overview(), null, Math.round(rnd() * 90 + 10) / 10, pick(RATINGS), null,
    genresFor(), JSON.stringify([pick(STUDIOS)]), castFor(), pick(imgIds), pick(imgIds), null, null, null, null, null, iso(showAdded), `${year}-01-01`,
    JSON.stringify({ tvdb: String(300000 + s) }), `${pick(drives)}/TV/${t}`, iso(showAdded));
  showIds.push(sid);
  const eps = [];
  const seasons = int(1, N.seasonsPerShow * 2 - 1);
  for (let sn = 1; sn <= seasons; sn++) {
    const seid = `${sid}s${sn}`;
    insItem.run(seid, libShows, 'season', `Season ${sn}`, `season ${String(sn).padStart(3, '0')}`, year + sn - 1, null, null, null, null, null,
      '[]', '[]', '[]', null, null, null, sid, null, sn, null, iso(showAdded), null, '{}', null, iso(showAdded));
    seasonIds.push(seid);
    const ne = int(N.episodesPerSeason - 4, N.episodesPerSeason + 3);
    for (let e = 1; e <= ne; e++) {
      const eid = `${seid}e${e}`;
      const added = showAdded + (sn * 10 + e) * DAY * 0.5;
      const et = title();
      insItem.run(eid, libShows, 'episode', et, sortTitle(et), year + sn - 1, overview(), null, null, null, int(20, 60) * 60000,
        '[]', '[]', '[]', null, null, pick(imgIds), seid, sid, e, sn, iso(Math.min(added, NOW)), `${year + sn - 1}-0${int(1, 9)}-1${int(0, 9)}`, '{}', `${pick(drives)}/TV/${t}/S${sn}E${e}.mkv`, iso(Math.min(added, NOW)));
      insMedia.run(`${eid}m`, eid, `${pick(drives)}/TV/${t} ${s}/Season ${sn}/S${sn}E${e}.mkv`, 'mkv', 45 * 60000, int(5, 30) * 1e8, int(3, 12) * 1e6, 1920, 1080, 'h264', 0, audio, subs, NOW, iso(added));
      eps.push(eid);
      episodeIds.push(eid);
    }
  }
  episodesByShow.set(sid, eps);
}
db.exec('COMMIT');
console.log(`  ${episodeIds.length} episodes, ${seasonIds.length} seasons`);

/* ------------------------------ users ------------------------------ */
const admin = db.prepare('SELECT * FROM users WHERE is_admin = 1 LIMIT 1').get();
if (!admin) throw new Error('No admin account: run setup first');
const tokens = { [admin.id]: null };
const insUser = db.prepare(`INSERT INTO users (id, username, display_name, password_hash, is_admin, max_rating, library_ids, created_at, last_seen_at, hide_unrated)
  VALUES (?, ?, ?, ?, 0, ?, NULL, ?, ?, 0)`);
const insDevice = db.prepare('INSERT INTO devices (id, token_hash, user_id, device_id, device_name, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const users = [{ id: admin.id, admin: true, restricted: false }];
const userTokens = [];
db.exec('BEGIN');
{
  const at = `perf-token-admin-${crypto.randomBytes(8).toString('hex')}`;
  insDevice.run('perfdevadmin', sha256(at), admin.id, 'perf-admin', 'Perf harness', 'web', iso(NOW), iso(NOW));
  userTokens.push({ userId: admin.id, token: at, admin: true });
}
for (let u = 1; u < N.users; u++) {
  const uid = id('pu', u);
  // Every 8th user is a restricted (PG-13) profile: exercises the parental-control SQL path.
  const restricted = u % 8 === 0;
  insUser.run(uid, `perfuser${u}`, `Perf User ${u}`, admin.password_hash, restricted ? 'PG-13' : null, iso(NOW - 400 * DAY), iso(NOW));
  const tok = `perf-token-${u}-${crypto.randomBytes(8).toString('hex')}`;
  insDevice.run(`perfdev${u}`, sha256(tok), uid, `perf-${u}`, `Perf device ${u}`, 'web', iso(NOW), iso(NOW));
  users.push({ id: uid, admin: false, restricted });
  userTokens.push({ userId: uid, token: tok, admin: false, restricted });
}
db.exec('COMMIT');

/* ------------------------ watch history ---------------------------- */
console.log('seeding user data / play history…');
const insUd = db.prepare(`INSERT OR REPLACE INTO user_data (user_id, item_id, played, play_count, position_ms, favorite, last_played_at, rating) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const insHist = db.prepare('INSERT INTO play_history (user_id, item_id, started_at, ended_at, duration_ms, method, platform) VALUES (?, ?, ?, ?, ?, ?, ?)');
const insWl = db.prepare('INSERT OR IGNORE INTO watchlist (user_id, item_id, added_at) VALUES (?, ?, ?)');
const insFavCh = db.prepare('INSERT OR IGNORE INTO channel_favorites (user_id, channel_id) VALUES (?, ?)');
let udRows = 0;
let histRows = 0;
db.exec('BEGIN');
for (const u of users) {
  // ~250 watched movies, a few in progress, a few favourites
  for (let k = 0; k < 250; k++) {
    const m = pick(movieIds);
    const when = NOW - Math.floor(rnd() * 365 * DAY);
    const inProgress = k < 6;
    insUd.run(u.id, m, inProgress ? 0 : 1, inProgress ? 0 : 1, inProgress ? int(10, 70) * 60000 : 0, k % 25 === 0 ? 1 : 0, iso(when), k % 10 === 0 ? int(4, 10) : null);
    insHist.run(u.id, m, iso(when), iso(when + 90 * 60000), 90 * 60000, pick(['direct', 'direct', 'transcode', 'remux']), pick(['web', 'tizen', 'webos', 'android']));
    udRows++;
    histRows++;
  }
  // ~8 shows in progress: the first N episodes watched in order (drives Next Up / Continue Watching)
  for (let k = 0; k < 8; k++) {
    const show = pick(showIds);
    const eps = episodesByShow.get(show);
    const upTo = int(1, eps.length - 1);
    let when = NOW - Math.floor(rnd() * 60 * DAY);
    for (let e = 0; e < upTo; e++) {
      when += int(1, 20) * 3600000;
      insUd.run(u.id, eps[e], 1, 1, 0, 0, iso(Math.min(when, NOW)), null);
      insHist.run(u.id, eps[e], iso(Math.min(when, NOW)), iso(Math.min(when, NOW) + 45 * 60000), 45 * 60000, 'direct', 'web');
      udRows++;
      histRows++;
    }
    if (k < 2) insUd.run(u.id, eps[upTo], 0, 0, 12 * 60000, 0, iso(NOW - k * 3600000), null);
  }
  for (let k = 0; k < 30; k++) insWl.run(u.id, pick(rnd() < 0.7 ? movieIds : showIds), iso(NOW - k * DAY));
}
db.exec('COMMIT');
console.log(`  ${udRows} user_data rows, ${histRows} play_history rows`);

/* ------------------------ live TV + guide -------------------------- */
console.log(`seeding ${N.channels} channels with a ${N.guideHours}h guide…`);
const srcId = 'perfsrc';
db.prepare(`INSERT INTO live_sources (id, name, type, url, enabled, proxy_streams, import_vod, import_series, refresh_hours, created_at)
  VALUES (?, 'Perf IPTV', 'm3u', 'http://127.0.0.1:9/playlist.m3u', 1, 1, 0, 0, 12, ?)`).run(srcId, iso(NOW));
const cats = Array.from({ length: 40 }, (_, i) => `perfcat${i}`);
const insCat = db.prepare('INSERT INTO channel_categories (id, source_id, remote_id, kind, name, hidden, sort_order) VALUES (?, ?, ?, ?, ?, 0, ?)');
cats.forEach((c, i) => insCat.run(c, srcId, String(i), 'live', `Category ${i}`, i));
const insCh = db.prepare(`INSERT INTO channels (id, source_id, remote_id, number, name, logo, category_id, stream_url, epg_channel_id, hidden, custom, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '{}', ?)`);
const insProg = db.prepare('INSERT INTO programs (id, source_id, epg_channel_id, title, subtitle, description, start, end, category, icon, episode_num, is_new) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)');
const channelIds = [];
let progRows = 0;
const guideStart = Math.floor((NOW - 6 * 3600000) / 1800000) * 1800000;
db.exec('BEGIN');
for (let c = 0; c < N.channels; c++) {
  const cid = id('pc', c);
  const epgId = `perf.ch${c}.tv`;
  insCh.run(cid, srcId, String(c), c + 1, `Channel ${c + 1} ${pick(WORDS)}`, pick(imgIds), pick(cats), `http://127.0.0.1:9/live/${c}.ts`, epgId, c);
  channelIds.push(cid);
  let t = guideStart;
  let p = 0;
  while (t < guideStart + N.guideHours * 3600000) {
    const len = pick([30, 30, 60, 60, 90, 120]) * 60000;
    insProg.run(`${cid}p${p++}`, srcId, epgId, title(), rnd() < 0.5 ? title() : null, overview(), iso(t), iso(t + len), pick(GENRES), rnd() < 0.1 ? 1 : 0);
    t += len;
    progRows++;
  }
}
for (const u of users) for (let k = 0; k < 10; k++) insFavCh.run(u.id, pick(channelIds));
db.exec('COMMIT');
console.log(`  ${progRows} programmes`);

/* --------------------------- activity log -------------------------- */
const insAct = db.prepare('INSERT INTO activity (at, user_id, user_name, type, message, severity) VALUES (?, ?, ?, ?, ?, ?)');
db.exec('BEGIN');
for (let k = 0; k < 20000; k++) insAct.run(iso(NOW - k * 600000), pick(users).id, 'someone', pick(['playback.start', 'playback.stop', 'auth.login', 'library.scan']), 'Synthetic activity', 'info');
db.exec('COMMIT');

db.exec('ANALYZE');
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();

// Pick sample ids whose shows have several seasons, and an episode in the middle.
const sampleShow = showIds[7];
const sampleEps = episodesByShow.get(sampleShow);
const manifest = {
  scale, counts: { movies: movieIds.length, shows: showIds.length, seasons: seasonIds.length, episodes: episodeIds.length, people: N.people, users: users.length, channels: channelIds.length, programmes: progRows, userData: udRows, playHistory: histRows },
  libraries: { movies: libMovies, shows: libShows },
  sample: { movie: movieIds[1234 % movieIds.length], show: sampleShow, season: `${sampleShow}s1`, episode: sampleEps[Math.floor(sampleEps.length / 2)], image: imgIds[3], channel: channelIds[10] },
  movieIds: movieIds.filter((_, i) => i % 97 === 0),
  showIds: showIds.filter((_, i) => i % 13 === 0),
  imageIds: imgIds,
  tokens: userTokens,
  genres: GENRES,
};
fs.writeFileSync(path.join(dataDir, 'perf-manifest.json'), JSON.stringify(manifest, null, 1));
console.log('seed done', manifest.counts);
