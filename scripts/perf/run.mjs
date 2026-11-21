/**
 * Kinora server benchmark.
 *
 *   npm run perf                      # = node scripts/perf/run.mjs
 *   node scripts/perf/run.mjs --label=after --scale=1 [--build] [--only=home,search] [--quick]
 *
 * 1. Seeds (once, cached) a synthetic large install: see seed.mjs. The pristine seed is copied to a fresh working
 *    folder for every run, so new migrations/indexes never leak into a later "before" run.
 * 2. Boots the built server (server/dist) with MEDIAMAX_PERF=1 (per-request query counts + slow-query log).
 * 3. Times the hot endpoints: a sequential pass (latency + SQLite statements per request), then concurrency
 *    levels 1/10/50 with requests spread over the 80 seeded users. Prints a table and writes
 *    scripts/perf/results/<label>.json (compare two with compare.mjs).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, client } from '../screenshots/lib/server.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=') ?? d;
const flag = (k) => process.argv.includes(`--${k}`);
const label = arg('label', 'run');
/** Checkout whose built server is measured (default: this one). Lets you benchmark an older build side by side. */
const serverRepo = path.resolve(arg('repo', repo));
const scale = Number(arg('scale', '1'));
const only = arg('only', '')?.split(',').filter(Boolean);
const quick = flag('quick');
const LEVELS = (arg('levels', quick ? '1,10' : '1,10,50')).split(',').map(Number);
const PER_LEVEL = Number(arg('requests', quick ? '60' : '200'));
/** A level stops early after this long (slow endpoints would otherwise take minutes per level). */
const LEVEL_BUDGET_MS = Number(arg('budget', quick ? '5000' : '15000'));

if (flag('build') || !fs.existsSync(path.join(repo, 'server/dist/index.js'))) {
  execFileSync('npm', ['run', 'build', '-w', 'shared'], { cwd: repo, stdio: 'inherit' });
  execFileSync('npm', ['run', 'build', '-w', 'server'], { cwd: repo, stdio: 'inherit' });
}

/* ------------------------------ seed ------------------------------- */
const cacheRoot = arg('cache', path.join(os.tmpdir(), 'mediamax-perf'));
const pristine = path.join(cacheRoot, `seed-${scale}`);
if (!fs.existsSync(path.join(pristine, 'perf-manifest.json'))) {
  fs.rmSync(pristine, { recursive: true, force: true });
  fs.mkdirSync(pristine, { recursive: true });
  console.log(`seeding ${pristine} …`);
  const s = await bootServer({ repo, data: pristine });
  await client(s.base).post('/setup', { username: 'admin', password: 'perf-admin-pass', serverName: 'Perf' });
  await s.stop();
  const t = Date.now();
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(repo, 'scripts/perf/seed.mjs'), pristine, `--scale=${scale}`], { stdio: 'inherit' });
  console.log(`seeded in ${((Date.now() - t) / 1000).toFixed(1)}s`);
}
const work = path.join(cacheRoot, `work-${label}`);
fs.rmSync(work, { recursive: true, force: true });
fs.cpSync(pristine, work, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(work, 'perf-manifest.json'), 'utf8'));

/* ------------------------------ boot ------------------------------- */
const bootT = Date.now();
const server = await bootServer({ repo: serverRepo, data: work, env: { MEDIAMAX_PERF: '1', MEDIAMAX_PERF_SLOW_MS: '15', MEDIAMAX_LOG_LEVEL: 'info' } });
const bootMs = Date.now() - bootT;
const base = server.base;
// Never leave a server behind (it would keep loading the machine and skew the next run).
const killServer = () => {
  try {
    server.proc.kill('SIGKILL');
  } catch { /* gone */ }
};
process.on('exit', killServer);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));
process.on('uncaughtException', (e) => {
  console.error(e);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error(e);
  process.exit(1);
});
const users = manifest.tokens.filter((t) => !t.admin && !t.restricted);
const restricted = manifest.tokens.filter((t) => t.restricted);
const admin = manifest.tokens.find((t) => t.admin);
let rr = 0;
const nextUser = () => users[rr++ % users.length];
const S = manifest.sample;

/* ---------------------------- scenarios ---------------------------- */
const iso = (t) => new Date(t).toISOString();
const halfHour = Math.floor(Date.now() / 1800000) * 1800000;
const pickOf = (a, i) => a[i % a.length];
/** Each scenario: name, url(i) → path, who: 'user' | 'admin' | 'none', headers?(i). */
const SCENARIOS = [
  { name: 'auth: /system/info (no auth)', url: () => '/api/v1/system/info', who: 'none' },
  { name: 'auth: /auth/me (token lookup)', url: () => '/api/v1/auth/me', who: 'user' },
  { name: 'home', url: () => '/api/v1/home', who: 'user' },
  { name: 'home (restricted profile)', url: () => '/api/v1/home', who: 'restricted' },
  { name: 'browse movies: title p1', url: () => `/api/v1/items?libraryId=${manifest.libraries.movies}&type=movie&sort=title&order=asc&limit=60&offset=0`, who: 'user' },
  { name: 'browse movies: title deep page', url: (i) => `/api/v1/items?libraryId=${manifest.libraries.movies}&type=movie&sort=title&order=asc&limit=60&offset=${6000 + (i % 50) * 60}`, who: 'user' },
  { name: 'browse movies: added desc', url: () => `/api/v1/items?libraryId=${manifest.libraries.movies}&type=movie&sort=addedAt&order=desc&limit=60&offset=0`, who: 'user' },
  { name: 'browse movies: rating desc', url: () => `/api/v1/items?libraryId=${manifest.libraries.movies}&type=movie&sort=rating&order=desc&limit=60&offset=0`, who: 'user' },
  { name: 'browse movies: genre filter', url: (i) => `/api/v1/items?libraryId=${manifest.libraries.movies}&type=movie&sort=title&genre=${encodeURIComponent(pickOf(manifest.genres, i))}&limit=60`, who: 'user' },
  { name: 'browse movies: unwatched', url: () => `/api/v1/items?libraryId=${manifest.libraries.movies}&type=movie&sort=title&played=false&limit=60`, who: 'user' },
  { name: 'browse movies: letter M', url: () => `/api/v1/items?libraryId=${manifest.libraries.movies}&type=movie&sort=title&letter=M&limit=60`, who: 'user' },
  { name: 'browse shows: title p1', url: () => `/api/v1/items?libraryId=${manifest.libraries.shows}&type=show&sort=title&limit=60`, who: 'user' },
  { name: 'browse movies (restricted)', url: () => `/api/v1/items?libraryId=${manifest.libraries.movies}&type=movie&sort=title&limit=60`, who: 'restricted' },
  { name: 'genres list', url: () => `/api/v1/genres?libraryId=${manifest.libraries.movies}`, who: 'user' },
  { name: 'item: movie', url: (i) => `/api/v1/items/${pickOf(manifest.movieIds, i)}`, who: 'user' },
  { name: 'item: movie similar', url: (i) => `/api/v1/items/${pickOf(manifest.movieIds, i)}/similar?limit=16`, who: 'user' },
  { name: 'item: show', url: (i) => `/api/v1/items/${pickOf(manifest.showIds, i)}`, who: 'user' },
  { name: 'item: show seasons', url: (i) => `/api/v1/items/${pickOf(manifest.showIds, i)}/children?sort=index&order=asc&limit=200`, who: 'user' },
  { name: 'item: show next-up', url: (i) => `/api/v1/items/${pickOf(manifest.showIds, i)}/next`, who: 'user' },
  { name: 'item: season episodes', url: () => `/api/v1/items/${S.season}/children?sort=index&order=asc&limit=500`, who: 'user' },
  { name: 'item: episode', url: () => `/api/v1/items/${S.episode}`, who: 'user' },
  { name: 'search "shadow"', url: () => '/api/v1/search?q=shadow&limit=30', who: 'user' },
  { name: 'search "Smith" (people)', url: () => '/api/v1/search?q=Smith&limit=30', who: 'user' },
  { name: 'watchlist', url: () => '/api/v1/watchlist?limit=60', who: 'user' },
  { name: 'guide 6h x 500ch', url: (i) => `/api/v1/livetv/guide?start=${iso(halfHour - 1800000)}&end=${iso(halfHour + 6 * 3600000)}&offset=${(i % 4) * 500}&limit=500`, who: 'user' },
  { name: 'guide 6h x 60ch (web page)', url: () => `/api/v1/livetv/guide?start=${iso(halfHour - 1800000)}&end=${iso(halfHour + 6 * 3600000)}&offset=0&limit=60`, who: 'user' },
  { name: 'channels (now/next) 200', url: () => '/api/v1/livetv/channels?limit=200', who: 'user' },
  { name: 'admin: system stats', url: () => '/api/v1/system/stats', who: 'admin' },
  { name: 'admin: stats/server 30d', url: () => '/api/v1/stats/server?days=30', who: 'admin' },
  { name: 'admin: sessions', url: () => '/api/v1/sessions', who: 'admin' },
  { name: 'admin: activity', url: () => '/api/v1/activity?limit=8&offset=0', who: 'admin' },
  { name: 'admin: users', url: () => '/api/v1/users', who: 'admin' },
  { name: 'image: cached w=300', url: (i) => `/api/v1/images/${pickOf(manifest.imageIds, i)}?w=300`, who: 'none', binary: true },
  { name: 'image: cached w=300 revalidate', url: (i) => `/api/v1/images/${pickOf(manifest.imageIds, i)}?w=300`, who: 'none', binary: true, revalidate: true },
  { name: 'static: main JS chunk', url: () => mainJs, who: 'none', binary: true, gzip: true, skipIfMissing: true },
].filter((s) => !only.length || only.some((o) => s.name.includes(o)));

let mainJs = null;
try {
  const html = await (await fetch(`${base}/`)).text();
  mainJs = html.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1] ?? null;
} catch { /* web not built */ }

const etags = new Map();
let transportErrors = 0;
function headersFor(sc, i) {
  const h = { 'X-Kinora-Device-Id': 'perf' };
  const tok = sc.who === 'user' ? nextUser().token : sc.who === 'restricted' ? restricted[i % restricted.length].token : sc.who === 'admin' ? admin.token : null;
  if (tok) h.Authorization = `Bearer ${tok}`;
  h['Accept-Encoding'] = 'gzip, deflate, br';
  if (sc.revalidate) {
    const u = sc.url(i);
    const e = etags.get(u);
    if (e) h['If-None-Match'] = e;
  }
  return h;
}

async function one(sc, i) {
  const url = sc.url(i);
  const t = performance.now();
  let res;
  try {
    res = await fetch(base + url, { headers: headersFor(sc, i) });
  } catch (e) {
    // A kept-alive socket the server closed while idle (long waits under load): count it and retry once.
    transportErrors++;
    res = await fetch(base + url, { headers: headersFor(sc, i) });
  }
  const body = Buffer.from(await res.arrayBuffer());
  const ms = performance.now() - t;
  if (res.status >= 400) throw new Error(`${sc.name}: ${url} → ${res.status} ${body.toString().slice(0, 200)}`);
  const et = res.headers.get('etag');
  if (et && !etags.has(url)) etags.set(url, et);
  return { ms, status: res.status, bytes: body.length, wire: Number(res.headers.get('content-length') ?? body.length), encoding: res.headers.get('content-encoding'), q: Number(res.headers.get('x-mm-queries') ?? NaN), serverMs: Number(res.headers.get('x-mm-time') ?? NaN) };
}

const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN;
};
const r1 = (n) => Math.round(n * 10) / 10;

// Warm the image resize cache (we benchmark cached thumbnails, not ffmpeg).
await Promise.all(manifest.imageIds.map((idd) => fetch(`${base}/api/v1/images/${idd}?w=300`).then((r) => r.arrayBuffer())));

const results = [];
for (const sc of SCENARIOS) {
  if (sc.skipIfMissing && !mainJs) continue;
  // warm-up + sequential pass: latency and statements per request
  await one(sc, 0);
  if (sc.revalidate) await one(sc, 1);
  const seq = [];
  for (let i = 0; i < (quick ? 8 : 20); i++) seq.push(await one(sc, i));
  const row = {
    name: sc.name,
    seqP50: r1(pct(seq.map((x) => x.ms), 50)),
    seqP95: r1(pct(seq.map((x) => x.ms), 95)),
    serverP50: r1(pct(seq.map((x) => x.serverMs), 50)),
    queries: r1(seq.reduce((a, x) => a + x.q, 0) / seq.length),
    bytes: Math.round(seq.reduce((a, x) => a + x.bytes, 0) / seq.length),
    wire: Math.round(seq.reduce((a, x) => a + x.wire, 0) / seq.length),
    status: seq[seq.length - 1].status,
    encoding: seq[seq.length - 1].encoding,
    levels: {},
  };
  for (const c of LEVELS) {
    const n = Math.max(PER_LEVEL, c * 4);
    const lat = [];
    let next = 0;
    const t0 = performance.now();
    await Promise.all(Array.from({ length: c }, async () => {
      while (next < n && !(performance.now() - t0 > LEVEL_BUDGET_MS && next >= c * 2)) {
        const i = next++;
        lat.push((await one(sc, i)).ms);
      }
    }));
    const wall = performance.now() - t0;
    row.levels[c] = { p50: r1(pct(lat, 50)), p95: r1(pct(lat, 95)), rps: Math.round((lat.length / wall) * 1000), n: lat.length };
  }
  results.push(row);
  const lv = LEVELS.map((c) => `c${c} p50 ${row.levels[c].p50} p95 ${row.levels[c].p95} (${row.levels[c].rps}/s)`).join(' | ');
  console.log(`${sc.name.padEnd(36)} seq p50 ${String(row.seqP50).padStart(7)}ms  q ${String(row.queries).padStart(6)}  ${String(row.wire).padStart(8)}B${row.encoding ? ` ${row.encoding}` : ''}  | ${lv}`);
}

const slow = {};
for (const m of server.log.matchAll(/slow query ([\d.]+)ms: (.*)/g)) {
  const k = m[2].slice(0, 200);
  const e = (slow[k] ??= { n: 0, max: 0, total: 0 });
  e.n++;
  e.total += Number(m[1]);
  e.max = Math.max(e.max, Number(m[1]));
}
const slowTop = Object.entries(slow).sort((a, b) => b[1].total - a[1].total).slice(0, 15).map(([sql, v]) => ({ sql, ...v, total: Math.round(v.total) }));
await server.stop();

const out = { label, transportErrors, date: new Date().toISOString(), node: process.version, cpus: os.cpus().length, cpu: os.cpus()[0]?.model, scale, counts: manifest.counts, bootMs, levels: LEVELS, results, slowTop };
const dir = path.join(repo, 'scripts/perf/results');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `${label}.json`), JSON.stringify(out, null, 1));
console.log(`\nboot ${bootMs}ms · slowest statements:`);
for (const s of slowTop.slice(0, 8)) console.log(`  ${s.n}× max ${s.max.toFixed(0)}ms total ${s.total}ms  ${s.sql.slice(0, 160)}`);
console.log(`\nwrote scripts/perf/results/${label}.json`);
fs.rmSync(work, { recursive: true, force: true });
