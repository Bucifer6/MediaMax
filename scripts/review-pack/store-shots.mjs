#!/usr/bin/env node
/**
 * Store screenshots and a preview video recorded from Kinora's own UI, showing only the review pack.
 *
 *   npm run build                                   # server + web app
 *   node scripts/review-pack/build-review-pack.mjs --work=/tmp/kinora-pack --no-zip
 *   node scripts/review-pack/store-shots.mjs --pack=/tmp/kinora-pack/kinora-review-pack-0.1.0
 *
 * It boots a throwaway Kinora on 127.0.0.1:7960 (data in a temp folder), serves the pack's fixtures on :7961, runs the
 * same seeder as the review server, signs in as the reviewer and captures:
 *
 *   docs/store/screenshots/tv/        1920×1080  TV mode (?tv=1) = what the Samsung, LG and VIDAA apps show
 *   docs/store/screenshots/web/       2880×1800  the web app in a desktop browser (website, docs, press)
 *   docs/store/screenshots/phone-web/ 1320×2868  the web app in a phone browser (website only: not the native app)
 *   dist/store/kinora-tv-preview.mp4  ~25 s, 1920×1080, 30 fps, H.264 High@4.0 ~10 Mbit/s + AAC 256 kbit/s stereo
 *
 * Options: --only=tv,web,phone,video   --out=<dir> (screenshots)   --keep (leave the server running; Ctrl+C stops)
 * Needs: the `playwright` package with Chromium (or CHROMIUM_PATH), ffmpeg.
 */
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './lib/art.mjs';
import { ff } from './lib/media.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const arg = (k) => {
  const a = process.argv.find((x) => x === `--${k}` || x.startsWith(`--${k}=`));
  return a == null ? null : a.includes('=') ? a.slice(a.indexOf('=') + 1) : true;
};
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 7960;
const FIX_PORT = 7961;
const BASE = `http://127.0.0.1:${PORT}`;
const only = arg('only') ? String(arg('only')).split(',') : ['tv', 'web', 'phone', 'video'];
const outDir = path.resolve(repo, String(arg('out') ?? 'docs/store/screenshots'));
const videoOut = path.join(repo, 'dist', 'store', 'kinora-tv-preview.mp4');

const MIME = { '.xml': 'application/xml', '.m3u': 'audio/x-mpegurl', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.mp3': 'audio/mpeg', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json' };

/** Minimal static server: /pack → pack/fixtures, /gen → generated fixtures, /live → HLS loops. */
function fixturesServer(map) {
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const [, top, ...rest] = u.split('/');
    const root = map[top];
    const file = root && path.join(root, ...rest);
    if (!file || !file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'content-length': fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => srv.listen(FIX_PORT, '127.0.0.1', () => r(srv)));
}

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(400);
  }
  throw new Error(`Timed out waiting for ${what}${last ? ` (${last.message})` : ''}`);
}

async function main() {
  const pack = path.resolve(String(arg('pack') ?? ''));
  if (!arg('pack') || !fs.existsSync(path.join(pack, 'library'))) throw new Error('Pass --pack=<unzipped review pack folder> (build it with build-review-pack.mjs --no-zip)');
  if (!fs.existsSync(path.join(repo, 'server/dist/index.js')) || !fs.existsSync(path.join(repo, 'web/dist/index.html'))) throw new Error('Run npm run build first');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kinora-store-shots-'));
  const cleanup = [];
  try {
    // Fixtures + live loops
    const gen = path.join(work, 'gen');
    const live = path.join(work, 'live');
    fs.mkdirSync(gen, { recursive: true });
    const srv = await fixturesServer({ pack: path.join(pack, 'fixtures'), gen, live });
    cleanup.push(() => new Promise((r) => srv.close(r)));
    for (const f of fs.readdirSync(path.join(pack, 'fixtures', 'livetv')).filter((x) => x.endsWith('.ts'))) {
      const id = path.basename(f, '.ts');
      fs.mkdirSync(path.join(live, id), { recursive: true });
      const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-stream_loop', '-1', '-i', path.join(pack, 'fixtures', 'livetv', f), '-c', 'copy', '-f', 'hls', '-hls_time', '4', '-hls_list_size', '6', '-hls_flags', 'delete_segments+omit_endlist+temp_file', path.join(live, id, 'index.m3u8')], { stdio: 'ignore' });
      cleanup.push(async () => p.kill('SIGKILL'));
    }

    // Kinora
    const data = path.join(work, 'data');
    const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/dist/index.js'], {
      cwd: repo,
      env: { ...process.env, MEDIAMAX_DATA: data, MEDIAMAX_PORT: String(PORT), MEDIAMAX_HOST: '127.0.0.1', MEDIAMAX_NO_WATCH: '1', MEDIAMAX_ALLOW_PRIVATE_URLS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    server.stdout.on('data', (d) => (serverLog += d));
    server.stderr.on('data', (d) => (serverLog += d));
    cleanup.unshift(() => new Promise((r) => {
      if (server.exitCode != null) return r();
      server.once('exit', r);
      server.kill('SIGTERM');
      setTimeout(() => server.kill('SIGKILL'), 5000);
    }));
    await waitFor(async () => (await fetch(`${BASE}/api/v1/system/info`)).ok, 60000, 'Kinora to start').catch((e) => {
      throw new Error(`${e.message}\n${serverLog.slice(-2000)}`);
    });
    log(`Kinora on ${BASE}`);

    // Seed exactly like the review server (the seeder reads its settings from the environment when imported).
    const creds = { REVIEW_ADMIN_USERNAME: 'review-admin', REVIEW_ADMIN_PASSWORD: `shots-${Math.random().toString(36).slice(2)}-admin`, REVIEW_USERNAME: 'appreview', REVIEW_PASSWORD: `shots-${Math.random().toString(36).slice(2)}-review` };
    Object.assign(process.env, creds, { KINORA_URL: BASE, REVIEW_PACK_DIR: pack, REVIEW_MEDIA_ROOT: path.join(pack, 'library'), REVIEW_FIXTURES_DIR: gen, REVIEW_FIXTURES_URL: `http://127.0.0.1:${FIX_PORT}`, REVIEW_LIVETV: '1', REVIEW_RESET_HOURS: '0' });
    const { seedOnce } = await import('./seed-review-server.mjs');
    await seedOnce();

    const login = async (u, p) => (await (await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Kinora-Device-Id': 'store-shots', 'X-Kinora-Device-Name': 'Living Room TV', 'X-Kinora-Platform': 'web' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
    const token = await login(creds.REVIEW_USERNAME, creds.REVIEW_PASSWORD);
    const api = async (p, init = {}) => {
      const r = await fetch(`${BASE}/api/v1${p}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
      if (!r.ok) throw new Error(`${p} → ${r.status} ${await r.text()}`);
      const t = await r.text();
      return t ? JSON.parse(t) : null;
    };
    const items = (await api('/items?type=movie,show,album,audiobook&limit=100')).items;
    const id = (title) => items.find((i) => i.title === title)?.id ?? (() => { throw new Error(`No item "${title}"`); })();
    const ids = { aurora: id('Aurora Drift'), lumen: id('Lumen'), paper: id('Paper Orbit'), show: id('Pixel Tides'), album: id('First Light') };
    const eps = (await api(`/items?ancestorId=${ids.show}&type=episode&sort=index&limit=10`)).items.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    ids.ep1 = eps[0]?.id;
    ids.ep2 = eps[1]?.id;
    const libs = await api('/libraries');
    ids.photos = libs.find((l) => l.type === 'photos')?.id;
    ids.book = items.find((i) => i.type === 'audiobook')?.id ?? (await api('/items?type=audiobook&limit=5')).items[0]?.id;
    // A little viewing history so the home screen shows Continue watching and Next up, as it would for a real user.
    const dur = async (i) => (await api(`/items/${i}`)).durationMs ?? 60000;
    await api(`/items/${ids.paper}/progress`, { method: 'POST', body: JSON.stringify({ positionMs: Math.round((await dur(ids.paper)) * 0.45), durationMs: await dur(ids.paper), state: 'stopped' }) });
    if (ids.ep1) await api(`/items/${ids.ep1}/played`, { method: 'POST' });
    if (ids.ep2) await api(`/items/${ids.ep2}/progress`, { method: 'POST', body: JSON.stringify({ positionMs: 20000, durationMs: await dur(ids.ep2), state: 'stopped' }) });
    await api(`/items/${ids.album}/favorite`, { method: 'POST' });
    await api(`/items/${ids.lumen}/watchlist`, { method: 'POST' }).catch(() => undefined);
    log(`Seeded; reviewer signed in. Items: ${JSON.stringify(ids)}`);

    const browser = await launchBrowser(['--autoplay-policy=no-user-gesture-required']);
    cleanup.unshift(() => browser.close());
    const shots = new Shots({ browser, token, outDir });
    if (only.includes('tv')) await shots.tv(ids);
    if (only.includes('web')) await shots.web(ids);
    if (only.includes('phone')) await shots.phone(ids);
    if (only.includes('video')) await shots.video(ids, pack);
    if (shots.problems.length) console.warn(`\nThings to look at:\n - ${[...new Set(shots.problems)].join('\n - ')}`);
    if (arg('keep')) {
      log(`Holding ${BASE} (reviewer token in localStorage mm.token: ${token}). Ctrl+C to stop.`);
      await new Promise((r) => process.once('SIGINT', r));
    }
  } finally {
    for (const fn of cleanup) await fn().catch?.(() => undefined);
    fs.rmSync(work, { recursive: true, force: true });
  }
  log('Done.');
}

const CSS = `*, *::before, *::after { caret-color: transparent !important; } ::-webkit-scrollbar { display: none !important; } html { scrollbar-width: none !important; }`;

class Shots {
  constructor(o) {
    Object.assign(this, o);
    this.problems = [];
  }

  async context({ width, height, dsf = 1, mobile = false, tv = false, video = null }) {
    const ctx = await this.browser.newContext({ viewport: { width, height }, deviceScaleFactor: dsf, isMobile: mobile, hasTouch: mobile, locale: 'en-GB', timezoneId: 'Europe/London', colorScheme: 'dark', ...(video ? { recordVideo: video } : {}) });
    await ctx.addInitScript(({ token, css, tv }) => {
      try {
        localStorage.setItem('mm.token', token);
        localStorage.setItem('mm.fx', tv ? 'auto' : 'full');
        if (tv) localStorage.setItem('mm.tv', '1');
      } catch {}
      const add = () => {
        const s = document.createElement('style');
        s.textContent = css;
        document.head.appendChild(s);
      };
      if (document.head) add();
      else document.addEventListener('DOMContentLoaded', add);
    }, { token: this.token, css: CSS, tv });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => this.problems.push(`${page.url().replace(BASE, '')}: ${e.message}`));
    return { ctx, page };
  }

  async settle(page, extra = 800) {
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
    await page.evaluate(async () => {
      await document.fonts.ready;
      const imgs = [...document.images].filter((i) => { const r = i.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width > 0; });
      imgs.forEach((i) => (i.loading = 'eager'));
      await Promise.race([Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; })))), new Promise((r) => setTimeout(r, 8000))]);
    });
    await page.waitForFunction(() => ![...document.querySelectorAll('.spinner, .skeleton, .page-loader')].some((s) => { const r = s.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.top < innerHeight; }), null, { timeout: 12000 }).catch(() => this.problems.push(`${page.url()}: still loading`));
    await sleep(extra);
  }

  async go(page, p, extra) {
    await page.goto(BASE + p, { waitUntil: 'domcontentloaded' });
    await this.settle(page, extra);
  }

  async snap(page, dir, name, { jpeg = true } = {}) {
    const file = path.join(this.outDir, dir, `${name}.${jpeg ? 'jpg' : 'png'}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await page.mouse.move(-10, -10).catch(() => undefined);
    await page.screenshot({ path: file, type: jpeg ? 'jpeg' : 'png', ...(jpeg ? { quality: 88 } : {}), animations: 'disabled' });
    log(`  ✓ ${path.relative(repo, file)} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
  }

  async playing(page, what) {
    await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.readyState >= 2 && v.currentTime > 1.5; }, null, { timeout: 45000 }).catch(() => this.problems.push(`${what}: video never started`));
  }

  /** Focus a poster card in TV mode with the D-pad, the way a remote would. */
  async focusCard(page, rights = 1) {
    for (let i = 0; i < 10; i++) {
      if (await page.evaluate(() => document.activeElement?.matches?.('a.card'))) break;
      await page.keyboard.press('ArrowDown');
      await sleep(300);
    }
    for (let i = 0; i < rights; i++) {
      await page.keyboard.press('ArrowRight');
      await sleep(300);
    }
  }

  async tv(ids) {
    log('TV mode (1920×1080)…');
    const { ctx, page } = await this.context({ width: 1920, height: 1080, tv: true });
    await this.go(page, '/?tv=1', 3000);
    await this.snap(page, 'tv', '01-home');
    await this.go(page, `/item/${ids.lumen}`, 1500);
    await this.snap(page, 'tv', '02-movie-4k-hdr');
    await this.go(page, `/item/${ids.show}`, 1500);
    await this.snap(page, 'tv', '03-series');
    await page.goto(`${BASE}/play/${ids.aurora}?start=58000`, { waitUntil: 'domcontentloaded' });
    await this.playing(page, 'tv player');
    await sleep(2500);
    await page.keyboard.press('ArrowUp');
    await sleep(900);
    await this.snap(page, 'tv', '04-player');
    await this.go(page, '/livetv/guide', 2000);
    await this.snap(page, 'tv', '05-live-tv-guide');
    await this.go(page, `/item/${ids.album}`, 1500);
    await this.snap(page, 'tv', '06-music');
    if (ids.photos) {
      await this.go(page, `/library/${ids.photos}`, 1500);
      await this.snap(page, 'tv', '07-photos');
    }
    await ctx.close();
  }

  async web(ids) {
    log('Web app, desktop (1440×900 @2x)…');
    const { ctx, page } = await this.context({ width: 1440, height: 900, dsf: 2 });
    await this.go(page, '/', 2500);
    await this.snap(page, 'web', '01-home');
    await this.go(page, `/item/${ids.lumen}`, 1500);
    await this.snap(page, 'web', '02-movie-4k-hdr');
    await this.go(page, `/item/${ids.show}`, 1500);
    await this.snap(page, 'web', '03-series');
    await page.goto(`${BASE}/play/${ids.aurora}?start=58000`, { waitUntil: 'domcontentloaded' });
    await this.playing(page, 'web player');
    await sleep(1500);
    await page.mouse.move(720, 600);
    await sleep(600);
    await page.screenshot({ path: path.join(this.outDir, 'web', '04-player.jpg'), type: 'jpeg', quality: 88 });
    log('  ✓ web/04-player.jpg');
    await this.go(page, `/item/${ids.album}`, 1500);
    await this.snap(page, 'web', '05-music');
    await this.go(page, '/podcasts', 1500);
    await this.snap(page, 'web', '06-podcasts');
    if (ids.book) {
      await this.go(page, `/item/${ids.book}`, 1500);
      await this.snap(page, 'web', '07-audiobook');
    }
    if (ids.photos) {
      await this.go(page, `/library/${ids.photos}`, 1500);
      await this.snap(page, 'web', '08-photos');
    }
    await this.go(page, '/livetv/guide', 2000);
    await this.snap(page, 'web', '09-live-tv-guide');
    await ctx.close();
  }

  async phone(ids) {
    log('Web app in a phone browser (440×956 @3x = 1320×2868)…');
    const { ctx, page } = await this.context({ width: 440, height: 956, dsf: 3, mobile: true });
    await this.go(page, '/', 2500);
    await this.snap(page, 'phone-web', '01-home');
    await this.go(page, `/item/${ids.lumen}`, 1500);
    await this.snap(page, 'phone-web', '02-movie');
    await this.go(page, `/item/${ids.album}`, 1500);
    await this.snap(page, 'phone-web', '03-music');
    await ctx.close();
  }

  /** ~25 s of TV mode: browse with the D-pad, open a film, play it, then the guide and an album. CDP screencast frames → H.264. */
  async video(ids, pack) {
    log('Preview video (TV mode)…');
    const { ctx, page } = await this.context({ width: 1920, height: 1080, tv: true });
    const frames = path.join(os.tmpdir(), `kinora-preview-${process.pid}`);
    fs.rmSync(frames, { recursive: true, force: true });
    fs.mkdirSync(frames, { recursive: true });
    const cdp = await ctx.newCDPSession(page);
    const list = [];
    // Page loads and the player's buffering spinner are cut out: frames arriving while `rec` is off are dropped,
    // and each cut starts a new segment so the frame before it isn't held on screen for the gap.
    let rec = true;
    let seg = 0;
    const cut = async (fn) => { rec = false; await fn(); seg++; rec = true; };
    cdp.on('Page.screencastFrame', async (f) => {
      if (rec) {
        const file = path.join(frames, `f${String(list.length).padStart(5, '0')}.jpg`);
        fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
        list.push({ file, t: f.metadata.timestamp, seg });
      }
      await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
    const start = Date.now();
    // A cheap "ticker" on every page keeps the screencast emitting frames even when the page is still.
    await page.addInitScript(() => addEventListener('DOMContentLoaded', () => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:99999'; document.body.appendChild(d); let k = 0; setInterval(() => { d.style.background = (k++ % 2) ? '#000' : '#010101'; }, 33); }));
    await cut(() => this.go(page, '/?tv=1', 2500));
    await sleep(2200);
    await this.focusCard(page, 0);
    for (let i = 0; i < 3; i++) { await page.keyboard.press('ArrowRight'); await sleep(700); }
    await page.keyboard.press('ArrowDown'); await sleep(900);
    await page.keyboard.press('ArrowRight'); await sleep(900);
    const visit = async (p, extra, hold) => { await cut(async () => { await page.goto(`${BASE}${p}`, { waitUntil: 'domcontentloaded' }); await this.settle(page, extra); }); await sleep(hold); };
    await visit(`/item/${ids.aurora}`, 600, 2200);
    await cut(async () => { await page.goto(`${BASE}/play/${ids.aurora}?start=6000`, { waitUntil: 'domcontentloaded' }); await this.playing(page, 'video player'); });
    await sleep(5500);
    await visit(`/item/${ids.lumen}`, 600, 2500);
    await visit('/livetv/guide', 600, 900);
    for (let i = 0; i < 3; i++) { await page.keyboard.press('ArrowDown'); await sleep(500); }
    await sleep(1200);
    await visit(`/item/${ids.album}`, 600, 2600);
    await cdp.send('Page.stopScreencast');
    await ctx.close();
    const total = (Date.now() - start) / 1000;
    if (list.length < 30) throw new Error(`Only ${list.length} screencast frames captured`);
    // Concat with real frame timings, then 30 fps CFR. Trim to 27 s at most (App Store: 15–30 s).
    const durs = list.map((f, i) => (list[i + 1] && list[i + 1].seg === f.seg ? Math.min(0.5, list[i + 1].t - f.t) : 1 / 30));
    const concat = list.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, durs[i]).toFixed(4)}`).join('\n') + `\nfile '${list.at(-1).file}'\n`;
    fs.writeFileSync(path.join(frames, 'list.txt'), concat);
    const len = Math.min(27, Math.max(15, Math.floor(durs.reduce((a, b) => a + b, 0))));
    const track = fs.readdirSync(path.join(pack, 'library', 'Music', 'Glasshouse Signals', 'First Light')).find((f) => f.startsWith('01 - '));
    fs.mkdirSync(path.dirname(videoOut), { recursive: true });
    await ff(['-f', 'concat', '-safe', '0', '-i', path.join(frames, 'list.txt'), '-ss', '20', '-i', path.join(pack, 'library', 'Music', 'Glasshouse Signals', 'First Light', track),
      '-filter_complex', `[0:v]fps=30,scale=1920:1080:flags=lanczos,format=yuv420p,fade=t=in:st=0:d=0.5,fade=t=out:st=${len - 0.8}:d=0.8[v];[1:a]atrim=0:${len},asetpts=N/SR/TB,aresample=48000,afade=t=in:st=0:d=1,afade=t=out:st=${len - 2}:d=2,volume=0.8[a]`,
      '-map', '[v]', '-map', '[a]', '-t', String(len), '-c:v', 'libx264', '-profile:v', 'high', '-level:v', '4.0', '-preset', 'slow', '-b:v', '10M', '-maxrate', '12M', '-bufsize', '20M', '-r', '30', '-g', '60',
      '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', videoOut]);
    fs.rmSync(frames, { recursive: true, force: true });
    log(`  ✓ ${path.relative(repo, videoOut)} (${len} s from ${total.toFixed(0)} s recorded, ${list.length} frames, ${(fs.statSync(videoOut).size / 1048576).toFixed(1)} MB)`);
  }
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
