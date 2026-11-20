#!/usr/bin/env node
/**
 * End-to-end user journeys: real server, real browser, generated demo media, mocked outside services.
 *
 *   npm run build && node scripts/e2e-journeys.mjs
 *
 * Boots a fresh MediaMax (server/dist + web/dist) on --port (default 18770) with an empty data folder, then walks
 * through what people actually do, as different personas, in Chromium:
 *
 *   first-run  setup wizard → admin → five libraries → scan → home; Network page in Direct mode
 *   admin      users (request permissions + quota), invites + sign-up, kids profile with PIN, branding, every
 *              server-settings tab, *arr (mock Radarr/Sonarr), notification agent test (mock webhook), Live TV
 *              (mock Xtream) + guide, downloads, activity
 *   viewer     browse / search / item pages, video player (HLS, subtitles, audio tracks, quality, stats, resume),
 *              music player + lyrics, DJ, Live TV, My List, Discover → request → approval → notification, issues,
 *              help centre, profiles, settings, ListenBrainz (mock)
 *   tv         /?tv=1 at 1920×1080 with the D-pad only
 *   phone      390×844: every main page without horizontal scrolling
 *   kids       kids profile & non-admin edge cases (admin deep links, request without permission, quota)
 *   errors     server stopped mid-session → offline state → recovers; 404 items; expired session → login?next=
 *
 * Every page is watched for page errors, console errors and unexpected 4xx/5xx responses; a journey fails on any.
 * No outside network is needed: TMDB, Radarr, Sonarr, ListenBrainz, webhooks and the IPTV provider are local mocks.
 *
 * Options:
 *   --work=<dir>    media + data folder (default: <tmp>/mediamax-e2e; generated media is reused between runs)
 *   --port=<n>      server port (default 18770)
 *   --only=a,b      run only these journeys (first-run always runs; the others need its server)
 *   --shots=<dir>   where screenshots go (default <work>/shots), file names start with e2e-
 *   --keep          leave the server running at the end (Ctrl+C to stop)
 *
 * Needs ffmpeg and the `playwright` package with Chromium.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Renderer } from './screenshots/lib/artwork.mjs';
import { generateMedia } from './screenshots/lib/media.mjs';
import { startMock, XTREAM_USER, XTREAM_PASS } from './screenshots/lib/mock.mjs';
import { client, waitFor, sleep } from './screenshots/lib/server.mjs';
import { MOVIES, SHOWS } from './screenshots/lib/catalog.mjs';
import { startServiceMocks, LB_TOKEN, ARR_KEY, DISCOVER_MOVIES } from './e2e/mocks.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d = null) => {
  const a = process.argv.find((x) => x === `--${k}` || x.startsWith(`--${k}=`));
  return a == null ? d : a.includes('=') ? a.slice(a.indexOf('=') + 1) : true;
};
process.removeAllListeners('warning');
process.on('warning', (w) => w.name !== 'ExperimentalWarning' && console.warn(w));

const WORK = path.resolve(String(arg('work', path.join(os.tmpdir(), 'mediamax-e2e'))));
const PORT = Number(arg('port', 18770));
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.resolve(String(arg('shots', path.join(WORK, 'shots'))));
const ONLY = arg('only') ? String(arg('only')).split(',') : null;
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${m}`);

const PASS = { admin: 'admin-pass-123', viewer: 'viewer-pass-123', invited: 'invited-pass-123' };

/* ------------------------------------------------------------------ */
/* Media                                                               */
/* ------------------------------------------------------------------ */

function ff(...args) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
}

/** Things the screenshot catalogue doesn't have: a movie with two audio tracks + SRT and ASS subtitles, and a song with word-timed lyrics. */
function extraMedia(root) {
  const done = path.join(root, 'extra.done');
  if (fs.existsSync(done)) return;
  const movie = path.join(root, 'extra', 'Movies', 'Subtitle Proving Ground (2024)');
  fs.mkdirSync(movie, { recursive: true });
  const base = path.join(movie, 'Subtitle Proving Ground (2024)');
  ff('-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-f', 'lavfi', '-i', 'sine=frequency=550:sample_rate=48000',
    '-t', '90', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=English Stereo', '-metadata:s:a:1', 'language=spa', '-metadata:s:a:1', 'title=Español', base + '.mkv');
  let srt = '';
  for (let i = 0; i < 44; i++) {
    const s = i * 2;
    const t = (x) => `00:${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
    srt += `${i + 1}\n${t(s)},000 --> ${t(s + 1)},800\nSRT line ${i + 1}\n\n`;
  }
  fs.writeFileSync(base + '.en.srt', srt);
  let ass = '[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: 720\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,48,&H0000FFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,20,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
  for (let i = 0; i < 44; i++) {
    const s = i * 2;
    const t = (x) => `0:${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}.00`;
    ass += `Dialogue: 0,${t(s)},${t(s + 1)},Default,,0,0,0,,{\\i1}ASS line ${i + 1}{\\i0}\n`;
  }
  fs.writeFileSync(base + '.es.ass', ass);
  fs.writeFileSync(path.join(movie, 'movie.nfo'), '<?xml version="1.0" encoding="UTF-8"?>\n<movie><title>Subtitle Proving Ground</title><year>2024</year><mpaa>PG</mpaa><plot>A test card with two audio tracks and two subtitle formats.</plot><genre>Documentary</genre><runtime>2</runtime></movie>\n');

  const album = path.join(root, 'extra', 'Music', 'The Lyric Lanterns', 'Singalong Sessions');
  fs.mkdirSync(album, { recursive: true });
  ff('-f', 'lavfi', '-i', 'sine=frequency=262:sample_rate=44100:d=45', '-f', 'lavfi', '-i', 'sine=frequency=392:sample_rate=44100:d=45', '-filter_complex', 'amix=inputs=2,volume=0.3',
    '-metadata', 'title=Morning Echo', '-metadata', 'artist=The Lyric Lanterns', '-metadata', 'album_artist=The Lyric Lanterns', '-metadata', 'album=Singalong Sessions', '-metadata', 'track=1/1', '-metadata', 'date=2024', '-metadata', 'genre=Pop',
    '-c:a', 'libmp3lame', '-b:a', '96k', path.join(album, '01 - Morning Echo.mp3'));
  const words = ['Wake', 'up', 'to', 'the', 'morning', 'echo'];
  let lrc = '[ti:Morning Echo]\n[ar:The Lyric Lanterns]\n';
  for (let l = 0; l < 10; l++) {
    const start = 2 + l * 4;
    const stamp = (x) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${(x % 60).toFixed(2).padStart(5, '0')}`;
    lrc += `[${stamp(start)}]` + words.map((w, i) => `<${stamp(start + i * 0.5)}>${w} `).join('').trimEnd() + `<${stamp(start + 3.4)}>\n`;
  }
  fs.writeFileSync(path.join(album, '01 - Morning Echo.lrc'), lrc);
  fs.writeFileSync(done, new Date().toISOString());
}

async function prepareMedia(browser) {
  fs.mkdirSync(WORK, { recursive: true });
  const portFile = path.join(WORK, 'mock-port');
  const reuse = fs.existsSync(path.join(WORK, 'media.done')) && fs.existsSync(portFile);
  let xtream;
  try {
    xtream = await startMock(path.join(WORK, 'assets'), reuse ? Number(fs.readFileSync(portFile, 'utf8')) : 0);
  } catch {
    // The old port is taken; artwork URLs baked into NFOs then 404, which only costs cast headshots.
    xtream = await startMock(path.join(WORK, 'assets'), 0);
  }
  fs.writeFileSync(portFile, String(xtream.server.address().port));
  if (!reuse) {
    log('Generating demo media (first run only, a few minutes)…');
    const renderer = new Renderer(browser, WORK, '');
    await renderer.open();
    await generateMedia({ root: WORK, renderer, assetBase: xtream.base, log });
    await renderer.page.close();
    fs.writeFileSync(path.join(WORK, 'media.done'), new Date().toISOString());
  }
  extraMedia(WORK);
  return xtream;
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

class Server {
  constructor(env) {
    this.env = env;
    this.data = path.join(WORK, 'e2e-data');
    this.log = '';
  }
  async start({ fresh = false } = {}) {
    if (fresh) fs.rmSync(this.data, { recursive: true, force: true });
    this.proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/dist/index.js'], {
      cwd: repo,
      env: { ...process.env, MEDIAMAX_DATA: this.data, MEDIAMAX_PORT: String(PORT), MEDIAMAX_HOST: '127.0.0.1', MEDIAMAX_NO_SCHEDULER: '1', ...this.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', (d) => (this.log += d));
    this.proc.stderr.on('data', (d) => (this.log += d));
    await waitFor(async () => (await fetch(`${BASE}/api/v1/system/info`)).ok, 40000, 'server start');
  }
  stop() {
    const proc = this.proc;
    return new Promise((r) => {
      if (!proc || proc.exitCode != null) return r();
      const kill = setTimeout(() => proc.kill('SIGKILL'), 5000);
      proc.once('exit', () => {
        clearTimeout(kill);
        r();
      });
      proc.kill('SIGTERM');
    });
  }
}

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

const results = [];
let current = null;

/** Responses that are expected and fine (the UI handles them). */
const EXPECTED = [
  /\/api\/v1\/auth\/me$/, // probed on boot when the token is stale
  /\/api\/v1\/images\/[^?]+(\?.*)?$/, // cast headshots from the mock when its port moved
  /\/favicon\.ico$/,
  /\/items\/[^/]+\/trickplay(\?.*)?$/, // "no thumbnails yet" is a 404 by design
];

class Journey {
  constructor(name) {
    this.name = name;
    this.steps = [];
    this.problems = [];
    this.allow = [];
  }
  /** Allow responses / console errors matching `re` for the rest of the current step. */
  expect(re) {
    this.allow.push(re);
  }
  note(msg) {
    if (this.allow.some((re) => re.test(msg))) return;
    if (!this.problems.includes(msg)) this.problems.push(msg);
  }
}

async function journey(name, fn) {
  if (ONLY && name !== 'first-run' && !ONLY.includes(name)) return;
  current = new Journey(name);
  results.push(current);
  log(`▶ ${name}`);
  try {
    await fn(current);
  } catch (e) {
    current.error = e;
    log(`  ✗ ${name}: ${e.message.split('\n')[0]}`);
  }
  for (const c of contexts.splice(0)) await c.close().catch(() => undefined);
  current.ok = !current.error && !current.steps.some((s) => !s.ok) && !current.problems.length;
  log(`${current.ok ? '✓' : '✗'} ${name}${current.problems.length ? ` (${current.problems.length} page problems)` : ''}`);
}

async function step(name, fn) {
  const s = { name, ok: true };
  current.steps.push(s);
  const before = current.allow.length;
  try {
    await fn();
    log(`  ✓ ${name}`);
  } catch (e) {
    s.ok = false;
    s.error = e.message.split('\n').slice(0, 3).join(' | ');
    log(`  ✗ ${name}: ${s.error}`);
    for (const p of pages) await shot(p, `fail-${current.name}-${name}`).catch(() => undefined);
  } finally {
    current.allow.length = before;
  }
}

const contexts = [];
const pages = new Set();
let browser;

/** A browser context for a persona. `token` signs in by storing it like the app does. */
async function open({ token = null, width = 1440, height = 900, mobile = false, tv = false, label = 'page', storage = {} } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, locale: 'en-GB', timezoneId: 'Europe/London', colorScheme: 'dark' });
  contexts.push(ctx);
  await ctx.addInitScript(({ token, storage }) => {
    try {
      if (token && !sessionStorage.getItem('e2e.init')) localStorage.setItem('mm.token', token);
      for (const [k, v] of Object.entries(storage)) if (localStorage.getItem(k) == null) localStorage.setItem(k, v);
      sessionStorage.setItem('e2e.init', '1');
    } catch { /* ignore */ }
  }, { token, storage });
  const page = await ctx.newPage();
  page.label = label;
  pages.add(page);
  page.on('close', () => pages.delete(page));
  page.on('pageerror', (e) => current?.note(`[${label}] page error on ${rel(page.url())}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource/.test(t)) return; // reported via the response listener with the URL
    if (/play\(\) request was interrupted|NotAllowedError|AbortError/.test(t)) return;
    current?.note(`[${label}] console error on ${rel(page.url())}: ${t.slice(0, 240)}`);
  });
  page.on('response', (r) => {
    const st = r.status();
    if (st < 400) return;
    const u = r.url();
    if (!u.startsWith(BASE)) return;
    if (st < 500 && EXPECTED.some((re) => re.test(u.replace(BASE, '')))) return;
    current?.note(`[${label}] HTTP ${st} ${r.request().method()} ${rel(u)}`);
  });
  page.on('requestfailed', (r) => {
    const f = r.failure()?.errorText ?? '';
    if (/ERR_ABORTED|ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE|ERR_CONNECTION_RESET|ERR_NETWORK_CHANGED/.test(f)) return;
    if (!r.url().startsWith(BASE)) return;
    current?.note(`[${label}] request failed ${rel(r.url())}: ${f}`);
  });
  return page;
}

const rel = (u) => u.replace(BASE, '') || '/';

async function shot(page, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `e2e-${name.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}.png`);
  await page.screenshot({ path: file });
  return file;
}

async function settle(page, ms = 300) {
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
  await page.waitForFunction(() => ![...document.querySelectorAll('.page-loader, .skeleton')].some((s) => s.getBoundingClientRect().width > 0), null, { timeout: 10000 }).catch(() => undefined);
  await sleep(ms);
}

async function go(page, p) {
  await page.goto(BASE + p, { waitUntil: 'domcontentloaded' });
  await settle(page);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Wait for a toast containing `text` (regex or string). */
async function toast(page, text, timeout = 10000) {
  await page.locator('.toast', { hasText: text }).first().waitFor({ timeout });
}

/** Document must not scroll sideways. */
async function noHorizontalScroll(page, where) {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  assert(r.sw <= r.cw + 1, `${where}: page scrolls sideways (${r.sw}px content in a ${r.cw}px viewport)`);
}

/** The element with keyboard focus must be visibly marked (outline, box-shadow or a focus class). */
async function focusVisible(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return { ok: false, why: 'nothing focused' };
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const visible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
    const marked = (x) => {
      const st = getComputedStyle(x);
      return (st.outlineStyle !== 'none' && parseFloat(st.outlineWidth) > 0) || (st.boxShadow && st.boxShadow !== 'none') || st.transform !== 'none';
    };
    // Cards draw their focus ring on the artwork inside them.
    const ring = marked(el) || /focus/.test(el.className?.toString?.() ?? '') || [...el.querySelectorAll('.card-art, .ps-avatar, .profile-avatar')].some(marked);
    return { ok: visible && !!ring, why: `${el.tagName}.${el.className} visible=${visible} outline=${s.outlineStyle}/${s.outlineWidth} shadow=${s.boxShadow}`, label: el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 40) };
  });
}

/* ------------------------------------------------------------------ */
/* Journeys                                                            */
/* ------------------------------------------------------------------ */

const S = {}; // shared state between journeys: tokens, ids

async function firstRun() {
  const page = await open({ label: 'setup' });
  await step('wizard appears on a fresh server', async () => {
    await go(page, '/');
    await page.getByRole('heading', { name: 'Welcome to MediaMax' }).waitFor();
    await shot(page, 'first-run-welcome');
  });
  await step('create the admin account', async () => {
    await page.getByLabel('Server name').fill('Journey Media');
    await page.getByRole('button', { name: /Get started/ }).click();
    await page.getByLabel('Username').fill('admin');
    await page.getByLabel('Password', { exact: true }).fill('short');
    await page.getByLabel('Confirm password').fill('short');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByText('Use at least 6 characters').waitFor();
    await page.getByLabel('Password', { exact: true }).fill(PASS.admin);
    await page.getByLabel('Confirm password').fill(PASS.admin + 'x');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByText('Passwords don’t match').waitFor();
    await page.getByLabel('Confirm password').fill(PASS.admin);
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('heading', { name: 'Add your first library' }).waitFor();
  });
  await step('add movies, shows, music, photos and audiobooks', async () => {
    const libs = [['Movies', 'Movies', ['media/Movies', 'extra/Movies']], ['TV Shows', 'TV Shows', ['media/TV']], ['Music', 'Music', ['media/Music', 'extra/Music']], ['Photos', 'Photos', ['media/Photos']], ['Audiobooks', 'Audiobooks', ['media/Audiobooks']]];
    for (const [type, name, dirs] of libs) {
      await page.locator('.type-option', { hasText: new RegExp(`^${type}$`) }).click();
      await page.getByLabel('Name').fill(name);
      const input = page.getByPlaceholder('/media/movies');
      for (const d of dirs) {
        await input.fill(path.join(WORK, d));
        await input.press('Enter');
      }
      const meta = page.getByRole('checkbox', { name: /Fetch online metadata/ });
      if (await meta.isChecked()) await meta.uncheck();
      await page.locator('form button.btn-primary').click();
      await page.locator('.added-list .badge', { hasText: name }).waitFor();
    }
    await shot(page, 'first-run-libraries');
    await page.getByRole('button', { name: /Continue/ }).click();
    await page.getByRole('heading', { name: 'Live TV & IPTV' }).waitFor();
    await page.getByRole('button', { name: /Skip for now/ }).click();
    await page.getByRole('heading', { name: "You're all set" }).waitFor();
    await page.getByRole('button', { name: /Enter Journey Media/ }).click();
  });
  await step('scan finishes and home fills up', async () => {
    S.admin = client(BASE, await page.evaluate(() => localStorage.getItem('mm.token')));
    assert(S.admin.token, 'no token stored after setup');
    await waitFor(async () => {
      const libs = await S.admin.get('/libraries');
      return libs.length === 5 && libs.every((l) => !l.scanning && l.itemCount > 0);
    }, 240000, 'library scans');
    await go(page, '/');
    await page.locator('.row-title').first().waitFor({ timeout: 20000 });
    const rows = await page.locator('.row-title').allTextContents();
    assert(rows.length >= 2, `home has only ${rows.length} rows: ${rows.join(', ')}`);
    assert(await page.locator('.sidebar').getByText('Audiobooks').count(), 'Audiobooks library missing from the sidebar');
    await shot(page, 'first-run-home');
  });
  await step('Network page shows Direct mode by default', async () => {
    await go(page, '/admin/network');
    const active = page.locator('.net-mode.active');
    await active.waitFor();
    assert(/Direct/.test(await active.textContent()), 'Direct mode is not the selected mode');
    assert(await page.locator('input[name="net-mode"]').first().isChecked(), 'Direct radio not checked');
  });
}

async function login(page, username, password, next = '/') {
  await go(page, `/login?next=${encodeURIComponent(next)}`);
  await page.locator('.login-card, .profiles').first().waitFor();
  const other = page.getByRole('button', { name: 'Sign in with a username' });
  if (await other.count()) await other.first().click();
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
}

/** Mark "What's new" as seen through the API (the viewer journey tests the card itself). */
async function seenWhatsNew(c) {
  const v = (await (await fetch(`${BASE}/api/v1/system/info`)).json()).version;
  await c.patch('/auth/me', { preferences: { whatsNewSeen: v } });
}

async function admin() {
  const page = await open({ token: S.admin.token, label: 'admin' });
  const ids = async (q) => (await S.admin.get(`/items?${q}&limit=200`)).items;
  S.movies = await ids('type=movie');
  S.shows = await ids('type=show');
  S.movie = (t) => S.movies.find((m) => m.title === t);

  await step("what's new card shows once and can be dismissed", async () => {
    await go(page, '/');
    const card = page.locator('.whats-new');
    await card.waitFor({ timeout: 10000 });
    assert(/What's new in Journey Media/.test(await card.locator('h2').textContent()), 'card title does not use the server name');
    await card.getByRole('button', { name: 'Got it' }).click();
    await card.waitFor({ state: 'detached' });
    await page.reload();
    await settle(page, 800);
    assert(!(await card.count()), "what's new card came back after dismissing it");
  });

  await step('create a viewer with request permissions and a quota', async () => {
    await go(page, '/admin/users');
    await page.getByRole('button', { name: 'Add user' }).click();
    const dlg = page.locator('.modal');
    await page.getByRole('dialog', { name: /user/i }).waitFor();
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      assert(await page.evaluate(() => !!document.activeElement?.closest('.modal')), `Tab #${i + 1} left the open dialog`);
    }
    await dlg.getByLabel('Username').fill('viewer');
    await dlg.getByLabel('Display name').fill('Val Viewer');
    await dlg.getByLabel(/^Password/).fill(PASS.viewer);
    await dlg.getByRole('radiogroup', { name: 'Movies', exact: true }).getByRole('radio', { name: 'Request' }).click();
    await dlg.getByRole('radiogroup', { name: 'Shows', exact: true }).getByRole('radio', { name: 'Request' }).click();
    await dlg.getByRole('checkbox', { name: /^Custom quota/ }).check();
    await dlg.getByLabel('Movies limit').fill('2');
    await dlg.getByLabel('Movies days').fill('7');
    await dlg.getByRole('button', { name: 'Create user' }).click();
    await page.locator('table').getByText('Val Viewer').waitFor();
    const u = (await S.admin.get('/users')).find((x) => x.username === 'viewer');
    assert(u, 'viewer not created');
    assert(u.requestPermissions?.movie === 'request', `movie permission is ${u.requestPermissions?.movie}`);
    assert(u.requestQuotas?.movie?.limit === 2, `movie quota is ${JSON.stringify(u.requestQuotas?.movie)}`);
    S.viewerId = u.id;
    await shot(page, 'admin-users');
  });

  await step('create a user with no request permission', async () => {
    const r = await S.admin.post('/users', { username: 'norequests', displayName: 'Nora NoRequests', password: PASS.viewer, requestPermissions: { movie: 'none', show: 'none', movie4k: 'none', show4k: 'none', music: 'none', book: 'none', manageRequests: false, reportIssues: true, watchlistAutoRequest: false } });
    S.noReqId = r.id;
  });

  await step('invite link: create, open signed out, sign up', async () => {
    await go(page, '/admin/invites');
    await page.getByRole('button', { name: 'New invite' }).first().click();
    const dlg = page.locator('.modal');
    await dlg.getByLabel('Note').fill('For Iris');
    await dlg.getByRole('button', { name: 'Create invite' }).click();
    const url = (await page.locator('.invite-url').first().textContent()).trim();
    assert(/\/invite\//.test(url), `invite URL looks wrong: ${url}`);
    const guest = await open({ label: 'invitee' });
    await guest.goto(BASE + new URL(url).pathname);
    await guest.getByRole('heading', { name: /invited to Journey Media/ }).waitFor();
    await guest.getByLabel('Display name').fill('Iris Invited');
    await guest.getByLabel('Username').fill('iris');
    await guest.getByLabel(/^Password/).fill(PASS.invited);
    await guest.getByLabel('Confirm password').fill(PASS.invited);
    await guest.getByRole('button', { name: 'Create account' }).click();
    await guest.waitForURL((u) => !u.pathname.startsWith('/invite'), { timeout: 15000 });
    await settle(guest);
    assert(await guest.locator('.sidebar').count(), 'invited user did not land in the app');
    await guest.close();
    await go(page, '/admin/invites');
    assert(/1\s*(\/\s*\S+)?\s*used/.test(await page.locator('.invite-card').first().textContent()), 'invite does not show one use');
  });

  await step('kids profile with a PIN; switch to it and back', async () => {
    await go(page, '/settings/profiles');
    await page.locator('.ps-add').click();
    const dlg = page.locator('.modal');
    await dlg.getByLabel('Name').fill('Kiddo');
    await dlg.getByRole('checkbox', { name: /^Kids profile/ }).check();
    await dlg.getByLabel('Profile PIN').fill('2468');
    await dlg.getByRole('button', { name: 'Add profile' }).click();
    await page.locator('.ps-card', { hasText: 'Kiddo' }).waitFor();
    await go(page, '/profiles');
    await page.getByRole('heading', { name: "Who's watching?" }).waitFor();
    await page.locator('.profile, .pp-profile, button', { hasText: 'Kiddo' }).first().click();
    for (const d of '2468') await page.locator('.pin-key', { hasText: new RegExp(`^${d}$`) }).click();
    await page.waitForURL((u) => u.pathname === '/', { timeout: 10000 });
    await settle(page, 800);
    S.kidsToken = await page.evaluate(() => localStorage.getItem('mm.token'));
    await shot(page, 'admin-kids-home');
    const sidebar = await page.locator('.sidebar').textContent();
    assert(!/Admin/.test(sidebar), 'kids profile sees the Admin link');
    assert(!/Discover|Requests/.test(sidebar), 'kids profile sees Discover/Requests');
    // Back to the owner.
    await go(page, '/profiles');
    await page.locator('.profile, .pp-profile, button', { hasText: /Admin|admin/ }).first().click();
    await page.waitForURL((u) => u.pathname === '/', { timeout: 10000 });
    S.admin = client(BASE, await page.evaluate(() => localStorage.getItem('mm.token')));
    await settle(page);
    assert(/Admin/.test(await page.locator('.sidebar').textContent()), 'owner profile lost the Admin link');
  });

  await step('branding: theme, name and logo show up in the app', async () => {
    await go(page, '/admin/branding');
    await page.getByRole('tab', { name: /Text/ }).click();
    await page.getByLabel('Server name').fill('Journey Cinema');
    await page.getByRole('tab', { name: /Theme/ }).click();
    const themes = page.locator('.preset-main');
    const n = await themes.count();
    assert(n > 3, `only ${n} themes`);
    await themes.nth(2).click();
    const themeName = (await themes.nth(2).locator('.preset-name').textContent()).replace(' •', '');
    await page.getByRole('button', { name: /Make default/ }).click();
    await page.getByRole('tab', { name: /Assets/ }).click();
    const logo = path.join(WORK, 'assets', 'logos', fs.readdirSync(path.join(WORK, 'assets', 'logos'))[0]);
    await page.locator('.asset-card', { hasText: 'Square or compact mark' }).first().locator('input[type=file]').setInputFiles(logo);
    await settle(page, 1000);
    await page.getByRole('button', { name: /Publish/ }).click();
    await toast(page, /./);
    const b = await S.admin.get('/branding');
    assert(b.serverName === 'Journey Cinema', `server name is ${b.serverName}`);
    assert(b.logoUrl, 'logo not saved');
    const viewer = await open({ label: 'viewer-branding' });
    await login(viewer, 'viewer', PASS.viewer);
    await settle(viewer, 600);
    const logoImg = viewer.locator('.sidebar-brand img.img-loaded');
    await logoImg.waitFor({ timeout: 10000 });
    assert((await logoImg.getAttribute('alt')) === 'Journey Cinema', `logo alt text is "${await logoImg.getAttribute('alt')}"`);
    assert((await viewer.title()).includes('Journey Cinema'), `document title is "${await viewer.title()}"`);
    S.viewer = client(BASE, await viewer.evaluate(() => localStorage.getItem('mm.token')));
    await shot(viewer, 'admin-branding-as-viewer');
    log(`    theme now ${themeName}`);
    await viewer.close();
  });

  await step('server settings: every tab opens; General + Metadata save', async () => {
    await go(page, '/admin/settings');
    const tabs = await page.getByRole('tab').allTextContents();
    assert(tabs.length >= 15, `only ${tabs.length} tabs`);
    for (const t of tabs) {
      await page.getByRole('tab', { name: t, exact: true }).click();
      await settle(page, 200);
      assert(!(await page.locator('.empty-state:has-text("Something")').count()), `tab ${t} shows an error`);
    }
    await page.getByRole('tab', { name: 'General', exact: true }).click();
    await page.getByLabel('TMDB API key').fill('e2e-tmdb-key');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await toast(page, 'Settings saved');
    assert((await S.admin.get('/settings')).tmdbApiKey, 'TMDB key not saved');
  });

  await step('transcoding: Detect hardware runs and reports', async () => {
    await page.getByRole('tab', { name: 'Transcoding', exact: true }).click();
    await page.getByRole('button', { name: /Detect hardware|Re-run detection/ }).click();
    await page.locator('.hwd-use, .hwd-card, .hwd').first().waitFor({ timeout: 90000 });
    await shot(page, 'admin-hw-detect');
  });

  await step('*arr: add mock Radarr and Sonarr, test both', async () => {
    await page.getByRole('tab', { name: 'Media automation (*arr)', exact: true }).click();
    for (const [kind, label] of [['radarr', 'Radarr'], ['sonarr', 'Sonarr']]) {
      await page.getByRole('button', { name: 'Add instance' }).click();
      const dlg = page.locator('.modal');
      await dlg.getByRole('group', { name: 'App' }).getByRole('button', { name: label }).click();
      await dlg.getByLabel('URL').fill(`${S.mocks.base}/${kind}`);
      await dlg.getByLabel('API key').fill(ARR_KEY);
      await dlg.getByRole('button', { name: /Test/ }).click();
      await dlg.getByLabel('Quality profile').waitFor({ timeout: 10000 });
      await dlg.locator('.btn-primary').last().click();
      await dlg.waitFor({ state: 'detached' });
    }
    await page.getByRole('button', { name: 'Save changes' }).click();
    await toast(page, 'Settings saved');
    const arr = (await S.admin.get('/settings')).arr ?? [];
    assert(arr.length === 2, `expected 2 *arr instances, got ${arr.length}`);
    for (const b of await page.locator('.arr-card button, .arr-instance button', { hasText: 'Test' }).all()) await b.click();
    await settle(page, 1000);
    await shot(page, 'admin-arr');
  });

  await step('requests on; notification agent Test reaches the mock webhook', async () => {
    await page.getByRole('tab', { name: 'Requests', exact: true }).click();
    const on = page.getByRole('checkbox', { name: /^Enable requests|^Requests/ }).first();
    if (await on.count() && !(await on.isChecked())) await on.check();
    await page.getByRole('tab', { name: 'Notifications', exact: true }).click();
    await page.getByRole('button', { name: 'Add notification agent' }).click();
    await page.getByRole('menuitem', { name: 'JSON webhook' }).click();
    const agent = page.locator('.agent').last();
    await agent.getByLabel('URL').fill(`${S.mocks.base}/hook`);
    const before = S.mocks.calls.filter((c) => c.path === '/hook').length;
    await agent.getByRole('button', { name: 'Test' }).click();
    await toast(page, /test sent/);
    assert(S.mocks.calls.filter((c) => c.path === '/hook').length > before, 'webhook mock received nothing');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await toast(page, 'Settings saved');
  });

  await step('karaoke & lyrics, trickplay and DLNA tabs save', async () => {
    for (const t of ['Karaoke & lyrics', 'Trickplay', 'DLNA', 'Cinema mode', 'AI DJ', 'DVR']) {
      await page.getByRole('tab', { name: t, exact: true }).click();
      const sw = page.locator('.tab-panel input.switch, .settings-card input.switch, input.switch').first();
      if (!(await sw.count())) continue;
      const was = await sw.isChecked();
      await sw.setChecked(!was);
      await page.getByRole('button', { name: 'Save changes' }).click();
      await toast(page, 'Settings saved');
      await sw.setChecked(was);
      await page.getByRole('button', { name: 'Save changes' }).click();
      await toast(page, 'Settings saved');
    }
  });

  for (const [p, title] of [['/admin/smarthome', 'Smart home'], ['/admin/storage', 'Storage'], ['/admin/network', 'Network'], ['/admin/security', 'Security'], ['/admin/downloads', 'Downloads'], ['/admin/tasks', 'Scheduled tasks'], ['/admin/devices', 'Devices'], ['/admin/stats', 'Statistics'], ['/admin/backups', 'Backups'], ['/admin/plugins', 'Plugins'], ['/admin/remote', 'Remote access'], ['/admin/renderers', 'Play to devices']]) {
    await step(`${title} page loads`, async () => {
      await go(page, p);
      await page.getByRole('heading', { name: new RegExp(title) }).first().waitFor();
      assert(!(await page.locator('.empty-state h3', { hasText: /Something|went wrong|Couldn/ }).count()), `${p} shows an error state`);
    });
  }

  await step('network & HTTPS: save without changes', async () => {
    await go(page, '/admin/network');
    const save = page.getByRole('button', { name: /^Save/ }).first();
    if (await save.isEnabled()) {
      await save.click();
      await toast(page, /saved/i);
    }
  });

  await step('activity & logs; diagnostics download', async () => {
    await go(page, '/admin/activity');
    await page.getByRole('heading', { name: /Activity/ }).first().waitFor();
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByRole('button', { name: /Download diagnostics/ }).click()]);
    const file = await dl.path();
    assert(file && fs.statSync(file).size > 200, 'diagnostics file is empty');
    await toast(page, /Diagnostics downloaded/);
  });

  await step('Live TV: add the mock Xtream source, channels and guide appear', async () => {
    await go(page, '/admin/livetv');
    await page.getByRole('button', { name: /Add source/ }).first().click();
    const dlg = page.locator('.modal');
    await dlg.locator('.type-option', { hasText: /Xtream/ }).click();
    await dlg.getByRole('textbox', { name: 'Name', exact: true }).fill('Mock IPTV');
    await dlg.getByLabel(/Server URL|URL/).first().fill(S.xtream.base);
    await dlg.getByLabel('Username').fill(XTREAM_USER);
    await dlg.getByLabel('Password').fill(XTREAM_PASS);
    await dlg.getByRole('button', { name: /Test/ }).click();
    await dlg.locator('.test-result, .source-test, .badge-success, .form-ok').first().waitFor({ timeout: 20000 }).catch(() => undefined);
    await dlg.locator('button.btn-primary', { hasText: /Add source/ }).click();
    await dlg.waitFor({ state: 'detached', timeout: 20000 });
    S.channels = await waitFor(async () => {
      const r = await S.admin.get('/livetv/channels?limit=100');
      return r.items?.length >= 10 ? r.items : null;
    }, 60000, 'channels');
    await waitFor(async () => ((await S.admin.get('/livetv/guide')).programs?.length ?? 0) > 20, 60000, 'guide data');
    await go(page, '/admin/guide');
    await page.getByRole('heading', { name: 'TV guide' }).first().waitFor();
    await page.getByRole('tab', { name: 'Guide matching' }).click();
    await page.getByRole('button', { name: /Re-run matching/ }).click();
    await page.locator('.epg-match-table tbody tr').first().waitFor({ timeout: 15000 });
    const rows = await page.locator('.epg-match-table tbody tr').count();
    assert(rows >= 10, `only ${rows} channels in guide matching`);
    const unmatched = await page.getByRole('tab', { name: /^Unmatched/ }).textContent();
    assert(/\(0\)/.test(unmatched), `guide matching left channels unmatched: ${unmatched}`);
    await shot(page, 'admin-guide');
  });

  await step('DJ analysis and trickplay thumbnails (background tasks)', async () => {
    await S.admin.post('/dj/analyze');
    await S.admin.put('/settings', { trickplay: { enabled: true, intervalSeconds: 10, width: 320 } });
    await S.admin.post('/tasks/trickplay/run');
    const sub = S.movie('Subtitle Proving Ground');
    await waitFor(async () => {
      const s = await S.admin.get('/dj/status');
      return !s.running && s.analyzed >= s.total && s.total > 0;
    }, 240000, 'DJ analysis');
    await waitFor(async () => !!(await S.admin.get(`/items/${sub.id}/trickplay`).catch(() => null))?.sheets ?? false, 120000, 'trickplay for the test movie').catch((e) => log('    ' + e.message));
  });
}

/** State of the <video> on the page. */
const videoState = (page) => page.evaluate(() => {
  const v = document.querySelector('video');
  return v ? { t: v.currentTime, paused: v.paused, ready: v.readyState, src: v.currentSrc, err: v.error?.message ?? null, w: v.videoWidth } : null;
});

async function waitPlaying(page, minT = 1, timeout = 45000) {
  await page.waitForFunction((minT) => {
    const v = document.querySelector('video');
    return v && !v.paused && v.currentTime >= minT && v.readyState >= 2;
  }, minT, { timeout });
}

/** Wake the auto-hiding player controls (a pointer move, like a real viewer). */
async function showControls(page) {
  const vp = page.viewportSize();
  await page.mouse.move(vp.width / 2, vp.height / 2);
  await page.mouse.move(vp.width / 2 + 20, vp.height / 2 + 20);
  await sleep(150);
}

/** Show the player controls and open one of the control-bar menus. */
async function playerMenu(page, label) {
  await showControls(page);
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.locator('.popover, .option-list').first().waitFor();
}

async function viewer() {
  const page = await open({ label: 'viewer' });
  const M = (t) => S.movie(t)?.id;
  const subMovie = M('Subtitle Proving Ground');
  assert(subMovie, 'subtitle test movie was not scanned');

  await step('sign in with username + password; dismiss what’s new with ×', async () => {
    await login(page, 'viewer', PASS.viewer);
    await settle(page, 800);
    const card = page.locator('.whats-new');
    await card.waitFor({ timeout: 10000 });
    await card.getByRole('button', { name: "Dismiss what's new" }).click();
    await card.waitFor({ state: 'detached' });
    S.viewer = client(BASE, await page.evaluate(() => localStorage.getItem('mm.token')));
  });

  await step('browse the movie library: sort, filter, open a title', async () => {
    const lib = (await S.viewer.get('/libraries')).find((l) => l.type === 'movies');
    await go(page, `/library/${lib.id}`);
    const cards = page.locator('.library-grid-wrap .card');
    await cards.first().waitFor();
    const n = await cards.count();
    assert(n >= 15, `only ${n} movie cards`);
    const sort = page.getByLabel('Sort by');
    const opts = await sort.locator('option').allTextContents();
    for (const o of opts.slice(0, 4)) {
      await sort.selectOption({ label: o });
      await settle(page, 200);
      assert(await cards.count() >= 15, `sort "${o}" lost items`);
    }
    const genre = page.getByLabel('Genre');
    const genres = await genre.locator('option').allTextContents();
    if (genres.length > 1) {
      await genre.selectOption({ label: genres[1] });
      await settle(page, 300);
      const k = await cards.count();
      assert(k >= 1 && k < n, `genre filter "${genres[1]}" shows ${k} of ${n}`);
      await genre.selectOption({ index: 0 });
    }
    await shot(page, 'viewer-library');
  });

  await step('search finds movies, shows and music', async () => {
    await go(page, '/search?q=neon');
    await page.getByText('Neon Meridian').first().waitFor();
    await go(page, '/search?q=harbor');
    await page.getByText('Harbor Lights').first().waitFor();
    await go(page, '/search?q=zzzzzzqqq');
    await page.locator('.empty-state').first().waitFor();
  });

  await step('item pages: movie, show, season, episode, album, artist, audiobook, photo', async () => {
    const pick = async (q) => (await S.viewer.get(`/items?${q}&limit=1`)).items[0];
    const show = S.shows.find((s) => s.title === 'The Quiet Frontier');
    const season = (await S.viewer.get(`/items?parentId=${show.id}&type=season&limit=5`)).items[0] ?? (await pick(`ancestorId=${show.id}&type=season`));
    const episode = await pick(`ancestorId=${show.id}&type=episode&sort=index`);
    const targets = [['movie', M('Neon Meridian')], ['show', show.id], ['season', season?.id], ['episode', episode?.id], ['album', (await pick('type=album')).id], ['artist', (await pick('type=artist')).id], ['audiobook', (await pick('type=audiobook')).id], ['photo', (await pick('type=photo')).id]];
    for (const [kind, id] of targets) {
      assert(id, `no ${kind} to open`);
      await go(page, `/item/${id}`);
      await page.locator('.detail, .photo-viewer, .page').first().waitFor();
      assert(!(await page.locator('.empty-state h3', { hasText: /Something went wrong|not found/i }).count()), `${kind} page shows an error`);
      const h = await page.locator('h1').first().evaluate((e) => e.textContent?.trim() || e.querySelector('img')?.alt || e.getAttribute('aria-label') || '').catch(() => '');
      assert(h, `${kind} page has no title`);
      await shot(page, `viewer-item-${kind}`);
    }
    S.episode = episode;
  });

  await step('404 item URL shows a not-found page with a way home', async () => {
    current.expect(/items\/does-not-exist/);
    await go(page, '/item/does-not-exist');
    await page.getByRole('heading', { name: 'Title not found' }).waitFor();
    await page.getByRole('link', { name: 'Go home' }).click();
    await page.waitForURL(BASE + '/');
  });

  await step('My List: add from the item page, see it on My List', async () => {
    await go(page, `/item/${M('Static Bloom')}`);
    await page.getByRole('button', { name: /My List/ }).first().click();
    await settle(page, 400);
    await go(page, '/my-list');
    await page.getByText('Static Bloom').first().waitFor();
  });

  await step('play a movie: HLS/direct starts, stats overlay explains why, help links work', async () => {
    await go(page, `/play/${subMovie}`);
    await waitPlaying(page, 1);
    const v = await videoState(page);
    assert(v.w > 0, 'video has no picture');
    await page.keyboard.press('i');
    const stats = page.getByRole('dialog', { name: 'Playback statistics' });
    await stats.waitFor();
    const text = await stats.textContent();
    assert(/Playback/.test(text) && /Resolution/.test(text), 'stats overlay incomplete');
    const why = stats.locator('.stats-why a');
    if (await why.count()) {
      const href = await why.first().getAttribute('href');
      assert(href?.startsWith('/help'), `stats help link goes to ${href}`);
    }
    await shot(page, 'viewer-player-stats');
    await stats.getByRole('button', { name: 'Close stats' }).click();
  });

  await step('subtitles render from our overlay: SRT then ASS', async () => {
    await playerMenu(page, 'Subtitles');
    const opts = page.locator('.option-list .option');
    const labels = await opts.allTextContents();
    const srt = labels.findIndex((l) => /English/i.test(l));
    const ass = labels.findIndex((l) => /Spanish|Español|ASS/i.test(l));
    assert(srt > 0 && ass > 0, `subtitle options: ${labels.join(' | ')}`);
    await opts.nth(srt).click();
    await page.waitForFunction(() => /SRT line/.test(document.querySelector('.mm-subs-layer')?.textContent ?? ''), null, { timeout: 15000 });
    await shot(page, 'viewer-subs-srt');
    await playerMenu(page, 'Subtitles');
    await page.locator('.option-list .option').nth(ass).click();
    // ASS goes through libass (WebAssembly, drawn on a canvas); the overlay says which renderer is active.
    await page.waitForFunction(() => {
      const l = document.querySelector('.mm-subs-layer');
      return l && /ass/.test(l.getAttribute('data-renderer') ?? '') && !/SRT line/.test(l.textContent ?? '');
    }, null, { timeout: 15000 });
    await sleep(2500);
    await shot(page, 'viewer-subs-ass');
  });

  await step('audio track switch keeps playing', async () => {
    await playerMenu(page, 'Audio');
    const opts = page.locator('.audio-popover .option-list .option');
    assert((await opts.count()) === 2, `expected 2 audio tracks, got ${await opts.count()}`);
    await opts.nth(1).click();
    await sleep(1500);
    const t = (await videoState(page)).t;
    await waitPlaying(page, t + 1, 30000);
  });

  await step('quality: manual then back to Auto', async () => {
    await playerMenu(page, 'Quality');
    const opts = page.locator('.option-list .option');
    const labels = await opts.allTextContents();
    assert(/Auto/.test(labels[0]), `first quality option is ${labels[0]}`);
    await opts.nth(Math.min(3, labels.length - 1)).click();
    await sleep(1500);
    await waitPlaying(page, (await videoState(page)).t + 1, 40000);
    await playerMenu(page, 'Quality');
    await page.locator('.option-list .option').first().click();
    await sleep(1500);
    await waitPlaying(page, (await videoState(page)).t + 1, 40000);
  });

  await step('seek bar: hover shows a preview, click seeks', async () => {
    await page.mouse.move(700, 500);
    const bar = page.getByRole('slider', { name: /./ }).filter({ has: page.locator('.seek-track') }).first();
    const seek = (await bar.count()) ? bar : page.locator('.seekbar').first();
    const box = await seek.boundingBox();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
    await page.locator('.seek-tooltip').first().waitFor();
    const thumb = await page.locator('.trickplay-thumb').count();
    await shot(page, 'viewer-seek-preview');
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
    await page.waitForFunction(() => document.querySelector('video')?.currentTime > 45, null, { timeout: 20000 });
    if (!thumb) log('    (no trickplay thumbnails on the seek preview)');
  });

  await step('resume position is saved', async () => {
    await sleep(2000);
    await showControls(page);
    await page.getByRole('button', { name: 'Back' }).first().click();
    await page.waitForURL((u) => !u.pathname.startsWith('/play'), { timeout: 10000 });
    const it = await waitFor(async () => {
      const i = await S.viewer.get(`/items/${subMovie}`);
      return (i.userData?.positionMs ?? 0) > 30000 ? i : null;
    }, 15000, 'saved position');
    await go(page, `/item/${subMovie}`);
    await page.getByRole('button', { name: /Resume/ }).first().waitFor();
    log(`    resume at ${Math.round(it.userData.positionMs / 1000)} s`);
  });

  await step('episode player offers the next episode', async () => {
    await go(page, `/play/${S.episode.id}`);
    await waitPlaying(page, 0.5);
    await page.mouse.move(700, 500);
    await page.getByRole('button', { name: 'Next', exact: true }).waitFor({ timeout: 10000 });
    await page.keyboard.press('Escape');
    await page.waitForURL((u) => !u.pathname.startsWith('/play'), { timeout: 10000 });
  });

  await step('music: play an album, queue, lyrics with word highlight, karaoke quick mode, visualiser', async () => {
    const album = (await S.viewer.get('/items?type=album&limit=50')).items.find((a) => a.title === 'Singalong Sessions');
    assert(album, 'lyrics album missing');
    await go(page, `/item/${album.id}`);
    await page.getByRole('button', { name: /^Play/ }).first().click();
    const mini = page.getByRole('region', { name: 'Music player' }).or(page.locator('[aria-label="Music player"]'));
    await mini.first().waitFor();
    await page.waitForFunction(() => /^0:0[1-9]|^0:[1-5]\d/.test(document.querySelector('.mini-time')?.textContent?.trim() ?? ''), null, { timeout: 30000 });
    await page.getByRole('button', { name: 'Queue' }).first().click();
    await page.getByText('Morning Echo').first().waitFor();
    await page.getByRole('button', { name: 'Close queue' }).click();
    await page.getByRole('button', { name: 'Open the full-screen player' }).click();
    const np = page.getByRole('dialog', { name: 'Now playing' });
    await np.waitFor();
    await np.getByRole('tab', { name: /Lyrics/ }).click();
    await np.locator('.lyric-line.current .kw').first().waitFor({ timeout: 15000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.lyric-line.current .kw')].some((s) => parseFloat(s.style.getPropertyValue('--fill')) > 0), null, { timeout: 10000 });
    await shot(page, 'viewer-lyrics');
    await np.getByRole('tab', { name: /Karaoke/ }).click();
    await np.locator('.karaoke-view, .np-karaoke').first().waitFor();
    await np.getByRole('tab', { name: /Visuali/ }).click();
    const style = np.getByRole('radiogroup', { name: 'Visualiser style' });
    await style.waitFor();
    const first = await style.getByRole('radio', { checked: true }).textContent();
    await style.getByRole('button', { name: 'Next style' }).click();
    const second = await style.getByRole('radio', { checked: true }).textContent();
    assert(first !== second, 'visualiser style did not change');
    await shot(page, 'viewer-visualiser');
    await np.getByRole('button', { name: 'Close now playing' }).click();
    await page.getByRole('button', { name: 'Karaoke and vocals' }).click();
    const k = page.getByRole('dialog', { name: 'Karaoke' });
    await k.locator('.karaoke-toggle input').check();
    await k.getByText('Quick').waitFor();
    await k.locator('.karaoke-toggle input').uncheck();
    // The mini player's three columns must not overlap (the right-hand controls used to cover repeat + time).
    const overlap = await page.evaluate(() => {
      const c = document.querySelector('.mini-center')?.getBoundingClientRect();
      const r = document.querySelector('.mini-right')?.getBoundingClientRect();
      const l = document.querySelector('.mini-left')?.getBoundingClientRect();
      return c && r && l ? Math.max(0, c.right - r.left, l.right - c.left) : 0;
    });
    await shot(page, 'viewer-miniplayer');
    assert(overlap <= 1, `mini player controls overlap by ${Math.round(overlap)} px`);
    await page.getByRole('button', { name: 'Pause' }).first().click();
  });

  await step('DJ: start a mix, transitions are labelled', async () => {
    await go(page, '/dj');
    await page.getByRole('button', { name: /Start the mix/ }).click();
    await page.locator('.dj-deck-main').first().waitFor({ timeout: 30000 });
    await page.locator('.dj-transition .dj-style').first().waitFor({ timeout: 30000 });
    const label = await page.locator('.dj-transition .dj-style').first().textContent();
    assert(label?.trim(), 'transition has no label');
    await shot(page, 'viewer-dj');
    await page.getByRole('button', { name: /End mix/ }).click();
  });

  await step('Live TV: list, play a channel, guide, record', async () => {
    await go(page, '/livetv');
    await page.locator('.channel-row').first().waitFor();
    await page.locator('.channel-row-main').first().click();
    await page.waitForURL(/\/watch\/live\//);
    await waitPlaying(page, 1, 45000);
    await page.mouse.move(700, 500);
    const rec = page.getByRole('button', { name: /^Record/ });
    if (await rec.count()) {
      current.expect(/\/dvr/); // viewers may not have DVR permission
      await rec.first().click();
      await page.locator('.toast').first().waitFor();
    }
    await shot(page, 'viewer-live');
    await page.getByRole('button', { name: 'Back' }).first().click();
    await go(page, '/livetv/guide');
    await page.locator('.guide, .epg, [class*="guide"]').first().waitFor();
    await shot(page, 'viewer-guide');
  });

  await step('Discover → request a movie (needs approval)', async () => {
    await go(page, '/discover');
    const target = DISCOVER_MOVIES[0];
    const card = page.locator('.discover-card, .card', { hasText: target.title }).first();
    await card.waitFor({ timeout: 15000 });
    await card.getByRole('button', { name: /Request/ }).first().click();
    const dlg = page.locator('.modal');
    await dlg.getByRole('button', { name: /Request \(needs approval\)/ }).click();
    await dlg.waitFor({ state: 'detached' });
    await go(page, '/requests');
    const row = page.locator('.req-row', { hasText: target.title });
    await row.waitFor();
    assert(/Pending/i.test(await row.textContent()), `request is not shown as pending: ${await row.textContent()}`);
    S.requestTitle = target.title;
  });

  await step('admin approves → status changes → viewer is notified', async () => {
    const adminPage = await open({ token: S.admin.token, label: 'admin-approve' });
    await go(adminPage, '/requests');
    const row = adminPage.locator('.req-row', { hasText: S.requestTitle }).first();
    await row.getByRole('button', { name: 'Approve' }).first().click();
    await toast(adminPage, /Approved/);
    await adminPage.close();
    assert(S.mocks.calls.some((c) => c.method === 'POST' && c.path === '/radarr/api/v3/movie'), 'Radarr mock got no POST /movie');
    await go(page, '/requests');
    await page.locator('.req-row', { hasText: S.requestTitle }).filter({ hasText: /approved|processing|available/i }).waitFor();
    await page.getByRole('button', { name: /Notifications/ }).first().click();
    await page.getByText(new RegExp(S.requestTitle)).first().waitFor({ timeout: 10000 });
    await shot(page, 'viewer-notifications');
    await page.keyboard.press('Escape');
  });

  await step('report an issue → admin resolves it', async () => {
    await go(page, `/item/${M('Crimson Freight')}`);
    await page.getByRole('button', { name: /Report an issue|Report/ }).first().click();
    const dlg = page.getByRole('dialog', { name: 'Report an issue' }).or(page.locator('.modal'));
    await dlg.first().getByLabel('Describe the problem').fill('Audio drifts out of sync after ten minutes.');
    await dlg.first().getByRole('button', { name: /Report|Send|Submit/ }).last().click();
    await toast(page, /./);
    const issue = await waitFor(async () => (await S.admin.get('/issues')).items?.find?.((i) => /drifts/.test(i.message)) ?? (await S.admin.get('/issues')).find?.((i) => /drifts/.test(i.message)), 10000, 'issue');
    const adminPage = await open({ token: S.admin.token, label: 'admin-issues' });
    await go(adminPage, `/issues/${issue.id}`);
    await adminPage.getByRole('button', { name: /Resolve|Mark resolved/ }).first().click();
    await adminPage.locator('.badge', { hasText: /resolved/i }).first().waitFor();
    await adminPage.close();
    await go(page, `/issues/${issue.id}`);
    await page.locator('.badge', { hasText: /resolved/i }).first().waitFor();
  });

  await step('Help Centre: search, article, ? shortcuts', async () => {
    await go(page, '/help');
    await page.getByLabel('Search help').fill('subtitles');
    await page.getByRole('region', { name: 'Search results' }).or(page.locator('[aria-label="Search results"]')).first().locator('a').first().click();
    await page.locator('.md h1, article h1, h1').first().waitFor();
    await go(page, '/');
    await page.keyboard.press('?');
    await page.getByRole('dialog').filter({ hasText: /Keyboard shortcuts/i }).first().waitFor();
    await shot(page, 'viewer-shortcuts');
    await page.keyboard.press('Escape');
  });

  await step('settings: subtitle style, audio comforts, playback save', async () => {
    await go(page, '/settings/playback');
    const before = (await S.viewer.get('/auth/me')).preferences;
    const selects = page.locator('.settings-card select');
    const n = await selects.count();
    assert(n > 2, `only ${n} selects on the playback page`);
    for (let i = 0; i < Math.min(n, 6); i++) {
      const s = selects.nth(i);
      if (!(await s.isEnabled())) continue;
      const count = await s.locator('option').count();
      if (count > 1) await s.selectOption({ index: count - 1 });
      await sleep(300);
    }
    const save = page.getByRole('button', { name: /^Save/ });
    if (await save.count()) for (const b of await save.all()) if (await b.isEnabled()) await b.click();
    await sleep(1000);
    const after = (await S.viewer.get('/auth/me')).preferences;
    assert(JSON.stringify(before) !== JSON.stringify(after), 'playback settings did not change the stored preferences');
  });

  await step('ListenBrainz: connect against a mock server', async () => {
    await go(page, '/settings/services');
    await page.getByPlaceholder('Paste your token').fill(LB_TOKEN);
    await page.getByRole('button', { name: /Connect/ }).first().click();
    await page.getByText('e2e-listener').first().waitFor({ timeout: 10000 });
  });
}

/* -------------------------------- TV mode -------------------------------- */

/** A trusted remote-control key press (Chromium's input pipeline, like a real remote), by key name + keyCode. */
async function remote(page, key, keyCode) {
  const cdp = page.cdp ?? (page.cdp = await page.context().newCDPSession(page));
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: '', windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: '', windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  await sleep(150);
}

const active = (page) => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  return { tag: el.tagName, href: el.getAttribute('href'), label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 50), inMain: !!el.closest('main') };
});

/**
 * Explore the D-pad focus graph from the first focused element: focus each reachable element, press the four
 * arrows, follow where focus goes. Returns visible focusable elements in <main> that no arrow path reaches.
 */
async function unreachable(page) {
  await page.evaluate(() => {
    const SEL = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    let n = 0;
    for (const el of document.querySelectorAll(SEL)) el.setAttribute('data-e2e-f', String(n++));
  });
  const all = await page.evaluate(() => [...document.querySelectorAll('main [data-e2e-f]:not([tabindex="-1"])')].filter((el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05 && !el.closest('[aria-hidden="true"], [inert]');
  }).map((el) => el.getAttribute('data-e2e-f')));
  const start = await page.evaluate(() => document.activeElement?.getAttribute('data-e2e-f'));
  const seen = new Set(start ? [start] : []);
  const queue = start ? [start] : [];
  let presses = 0;
  while (queue.length && presses < 900) {
    const id = queue.shift();
    for (const key of ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft']) {
      await page.evaluate((id) => document.querySelector(`[data-e2e-f="${id}"]`)?.focus({ preventScroll: false }), id);
      await page.keyboard.press(key);
      presses++;
      const to = await page.evaluate(() => document.activeElement?.getAttribute('data-e2e-f'));
      if (to && !seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }
  return page.evaluate((ids) => ids.map((id) => document.querySelector(`[data-e2e-f="${id}"]`)).filter(Boolean).map((el) => {
    return `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40)}"`;
  }), all.filter((id) => !seen.has(id)));
}

async function tv() {
  await seenWhatsNew(S.viewer);
  const page = await open({ token: S.viewer.token, width: 1920, height: 1080, label: 'tv' });
  const channels = S.channels;

  await step('TV mode turns on with ?tv=1 and focus starts in the content', async () => {
    await go(page, '/?tv=1');
    assert(await page.evaluate(() => document.documentElement.classList.contains('tv')), 'html.tv not set');
    await page.keyboard.press('ArrowDown');
    const a = await active(page);
    assert(a?.inMain, `first focus is not in the page content: ${JSON.stringify(a)}`);
    const f = await focusVisible(page);
    assert(f.ok, `focus not visible: ${f.why}`);
    await shot(page, 'tv-home-focus');
  });

  await step('D-pad: every move keeps a visible focus; home → item → play → back', async () => {
    const path = [];
    for (const k of ['ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
      await page.keyboard.press(k);
      await sleep(250);
      const f = await focusVisible(page);
      assert(f.ok, `after ${k}: ${f.why}`);
      path.push(f.label);
    }
    // Walk down to a poster card and open it.
    let a = await active(page);
    for (let i = 0; i < 12 && !(a?.href ?? '').startsWith('/item/'); i++) {
      await page.keyboard.press('ArrowDown');
      await sleep(200);
      a = await active(page);
    }
    assert((a?.href ?? '').startsWith('/item/'), `never reached a title card (at ${JSON.stringify(a)})`);
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/item\//);
    await settle(page, 600);
    const onItem = await active(page);
    assert(/Play|Resume|Continue/i.test(onItem?.label ?? ''), `item page focus is on "${onItem?.label}", not Play`);
    await shot(page, 'tv-item');
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/play\//, { timeout: 15000 });
    await waitPlaying(page, 1);
    await remote(page, 'MediaPlayPause', 179);
    await sleep(500);
    assert((await videoState(page)).paused, 'MediaPlayPause did not pause');
    await remote(page, 'MediaPlayPause', 179);
    await waitPlaying(page, (await videoState(page)).t + 0.5);
    await remote(page, 'Info', 457);
    await page.getByRole('dialog', { name: 'Playback statistics' }).waitFor({ timeout: 5000 });
    await remote(page, 'Info', 457);
    await remote(page, 'ColorF0Red', 403);
    await sleep(500);
    const t0 = (await videoState(page)).t;
    for (const d of ['5']) await page.keyboard.press(d);
    await sleep(800);
    const t1 = (await videoState(page)).t;
    assert(Math.abs(t1 - t0) > 5, `digit 5 did not jump (from ${t0.toFixed(1)} to ${t1.toFixed(1)})`);
    await shot(page, 'tv-player');
    await page.keyboard.press('Backspace');
    await page.waitForURL((u) => !u.pathname.startsWith('/play'), { timeout: 10000 });
    await page.keyboard.press('Backspace');
    await page.waitForURL((u) => u.pathname === '/', { timeout: 10000 });
  });

  await step('no focusable element on home is unreachable by D-pad', async () => {
    await go(page, '/');
    await page.keyboard.press('ArrowDown');
    const lost = await unreachable(page);
    assert(!lost.length, `unreachable on home: ${lost.slice(0, 8).join(', ')}${lost.length > 8 ? ` … (+${lost.length - 8})` : ''}`);
  });

  for (const [what, p] of [['an item page', `/item/${S.movie('Neon Meridian').id}`], ['a show page', `/item/${S.shows[0].id}`], ['Live TV', '/livetv'], ['playback settings', '/settings/playback'], ['the movie library', `/library/${(await S.viewer.get('/libraries')).find((l) => l.type === 'movies').id}`]]) {
    await step(`no focusable element on ${what} is unreachable by D-pad`, async () => {
      await go(page, p);
      await sleep(400);
      if (!(await active(page))) await page.keyboard.press('ArrowDown');
      const lost = await unreachable(page);
      assert(!lost.length, `unreachable on ${what}: ${lost.slice(0, 8).join(', ')}${lost.length > 8 ? ` … (+${lost.length - 8})` : ''}`);
    });
  }

  await step('Live TV: channel up/down, digits, guide key', async () => {
    await go(page, '/livetv');
    const inRow = () => page.evaluate(() => !!document.activeElement?.closest('.channel-row'));
    for (let i = 0; i < 8 && !(await inRow()); i++) {
      await page.keyboard.press('ArrowDown');
      if (await page.evaluate(() => document.activeElement?.classList.contains('cat'))) await page.keyboard.press('ArrowRight');
    }
    assert(await inRow(), `D-pad never reached the channel list (at ${JSON.stringify(await active(page))})`);
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/watch\/live\//, { timeout: 10000 });
    await waitPlaying(page, 0.5, 45000);
    const first = page.url();
    await remote(page, 'ChannelUp', 427);
    await page.waitForURL((u) => u.href !== first, { timeout: 10000 });
    const second = page.url();
    await remote(page, 'ChannelDown', 428);
    await page.waitForURL((u) => u.href !== second, { timeout: 10000 });
    await page.keyboard.press('3');
    await page.waitForURL((u) => u.href.includes(channels.find((c) => String(c.number) === '3')?.id ?? '§'), { timeout: 10000 }).catch(() => { throw new Error(`digit 3 did not tune channel 3 (at ${rel(page.url())})`); });
    await shot(page, 'tv-live');
    await remote(page, 'Guide', 458);
    await page.waitForURL(/\/livetv\/guide/, { timeout: 10000 });
    await settle(page, 500);
    await page.keyboard.press('ArrowDown');
    const f = await focusVisible(page);
    assert(f.ok, `guide focus not visible: ${f.why}`);
    await shot(page, 'tv-guide');
  });

  await step('music screensaver appears when idle and any key closes it', async () => {
    await S.viewer.patch('/auth/me', { preferences: { musicScreensaverMinutes: 1 } });
    const album = (await S.viewer.get('/items?type=album&limit=50')).items.find((x) => x.title === 'Singalong Sessions');
    await go(page, `/item/${album.id}`);
    await page.keyboard.press('Enter'); // Play is focused
    await page.waitForFunction(() => /^0:0[1-9]|^0:[1-5]\d/.test(document.querySelector('.mini-time')?.textContent?.trim() ?? ''), null, { timeout: 30000 });
    await page.clock.install();
    await page.clock.fastForward('02:00');
    await page.locator('.now-playing.screensaver').waitFor({ timeout: 15000 });
    await shot(page, 'tv-screensaver');
    await page.keyboard.press('ArrowDown');
    await page.locator('.now-playing.screensaver').waitFor({ state: 'detached', timeout: 5000 });
    await page.getByRole('button', { name: 'Pause' }).first().click();
  });
}

/* -------------------------------- phone -------------------------------- */

async function phone() {
  const page = await open({ token: S.viewer.token, width: 390, height: 844, mobile: true, label: 'phone' });
  const lib = await S.viewer.get('/libraries');
  const pages = ['/', '/search', '/search?q=the', '/discover', '/requests', '/my-list', '/livetv', '/livetv/guide', '/calendar', '/dj', '/playlists', '/collections', '/help', '/settings/profile', '/settings/playback', '/settings/services', '/profiles',
    ...lib.map((l) => `/library/${l.id}`), `/item/${S.movie('Neon Meridian').id}`, `/item/${S.shows[0].id}`];
  await step('every main page fits 390 px without sideways scrolling', async () => {
    const bad = [];
    for (const p of pages) {
      await go(page, p);
      try {
        await noHorizontalScroll(page, p);
      } catch (e) {
        bad.push(e.message);
        await shot(page, `phone-overflow-${p}`);
      }
    }
    assert(!bad.length, bad.join('; '));
  });

  await step('menu drawer and bottom navigation work', async () => {
    await go(page, '/');
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.locator('.drawer-open .sidebar, .sidebar').getByText('My List').click();
    await page.waitForURL(/\/my-list/);
    await page.locator('.bottom-nav').getByText('Search').click();
    await page.waitForURL(/\/search/);
    await page.locator('.bottom-nav a').first().click();
    await page.waitForURL(BASE + '/');
  });

  await step('player controls are on screen and big enough to tap', async () => {
    await go(page, `/play/${S.movie('Subtitle Proving Ground').id}`);
    await waitPlaying(page, 0.5);
    await page.tap('video').catch(() => page.mouse.click(195, 300));
    await sleep(300);
    const bad = await page.evaluate(() => [...document.querySelectorAll('.player-controls button, .pc-left button, .pc-right button')].filter((b) => {
      const r = b.getBoundingClientRect();
      if (r.width === 0) return false;
      return r.left < -1 || r.right > innerWidth + 1 || r.width < 32 || r.height < 32;
    }).map((b) => `${b.getAttribute('aria-label')} ${Math.round(b.getBoundingClientRect().left)}..${Math.round(b.getBoundingClientRect().right)} (${Math.round(b.getBoundingClientRect().width)}px)`));
    await shot(page, 'phone-player');
    assert(!bad.length, `controls off-screen or too small: ${bad.join(', ')}`);
    await playerMenu(page, 'Subtitles');
    const pop = await page.locator('.popover').first().boundingBox();
    assert(pop && pop.x >= 0 && pop.x + pop.width <= 391, `subtitle menu is off-screen (${JSON.stringify(pop)})`);
  });

  await step('admin pages fit a phone too', async () => {
    const adminPage = await open({ token: S.admin.token, width: 390, height: 844, mobile: true, label: 'phone-admin' });
    const bad = [];
    for (const p of ['/admin', '/admin/libraries', '/admin/users', '/admin/livetv', '/admin/guide', '/admin/branding', '/admin/settings', '/admin/activity', '/admin/security', '/admin/network', '/admin/storage', '/admin/invites', '/requests', '/issues']) {
      await go(adminPage, p);
      try {
        await noHorizontalScroll(adminPage, p);
      } catch (e) {
        bad.push(e.message);
        await shot(adminPage, `phone-overflow-${p}`);
      }
    }
    assert(!bad.length, bad.join('; '));
  });
}

/* -------------------------------- kids & permissions -------------------------------- */

async function kids() {
  // A fresh owner session on another "device", switched to the kids profile (switching revokes the old session).
  const owner = client(BASE, (await (await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: PASS.admin }) })).json()).token);
  const kiddo = (await owner.get('/auth/account/profiles')).find((p) => p.displayName === 'Kiddo');
  S.kidsToken = (await owner.post(`/auth/profiles/${kiddo.id}/switch`, { pin: '2468' })).token;
  const kidsPage = await open({ token: S.kidsToken, label: 'kids' });
  const rRated = S.movies.find((m) => m.contentRating === 'R');
  assert(rRated, 'no R-rated movie in the catalogue');

  await step('kids profile: R-rated titles are hidden everywhere', async () => {
    await go(kidsPage, `/search?q=${encodeURIComponent(rRated.title.split(' ').slice(-1)[0])}`);
    await settle(kidsPage, 600);
    assert(!(await kidsPage.getByText(rRated.title).count()), `${rRated.title} (R) shows up in kids search`);
    const lib = (await S.admin.get('/libraries')).find((l) => l.type === 'movies');
    await go(kidsPage, `/library/${lib.id}`);
    await kidsPage.locator('.library-grid-wrap .card').first().waitFor();
    assert(!(await kidsPage.locator('.library-grid-wrap').getByText(rRated.title).count()), `${rRated.title} (R) in the kids movie library`);
    current.expect(new RegExp(`/items/${rRated.id}`));
    await go(kidsPage, `/item/${rRated.id}`);
    await kidsPage.getByRole('heading', { name: 'Title not found' }).waitFor();
    await shot(kidsPage, 'kids-r-rated-deeplink');
  });

  await step('kids profile: admin and request URLs redirect, no crash', async () => {
    for (const p of ['/admin', '/admin/users', '/admin/settings', '/discover', '/requests']) {
      await go(kidsPage, p);
      await settle(kidsPage, 300);
      const url = new URL(kidsPage.url());
      const crashed = await kidsPage.getByText('Something broke').count();
      assert(!crashed, `${p} crashed`);
      assert(!url.pathname.startsWith('/admin'), `${p} stayed on an admin page`);
      if (p === '/discover' || p === '/requests') {
        const body = await kidsPage.locator('main').textContent();
        assert(url.pathname !== p || /not available|can't|cannot|isn't|turned off|ask/i.test(body), `${p} opened for a kids profile without explanation`);
      }
    }
  });

  await step('a user without request permission gets a clear message', async () => {
    const p = await open({ label: 'norequests' });
    await login(p, 'norequests', PASS.viewer);
    await go(p, '/discover');
    await settle(p, 500);
    const body = await p.locator('main').textContent();
    assert(/permission|not allowed|can't request|cannot request|no request/i.test(body) || (await p.locator('.discover-card button:disabled, .card button:disabled').count()) > 0,
      'no hint that this user may not request');
    current.expect(/\/api\/v1\/requests$/);
    const r = await fetch(`${BASE}/api/v1/requests`, { method: 'POST', headers: { Authorization: `Bearer ${await p.evaluate(() => localStorage.getItem('mm.token'))}`, 'content-type': 'application/json' }, body: JSON.stringify({ mediaType: 'movie', tmdbId: String(DISCOVER_MOVIES[1].id) }) });
    assert(r.status === 403, `API allowed a request without permission (${r.status})`);
    await shot(p, 'norequests-discover');
  });

  await step('over quota: a clear message, not a silent failure', async () => {
    const p = await open({ token: S.viewer.token, label: 'quota' });
    current.expect(/\/api\/v1\/requests$/);
    for (const m of DISCOVER_MOVIES.slice(1, 3)) {
      await go(p, '/discover');
      const card = p.locator('.discover-card, .card', { hasText: m.title }).first();
      await card.waitFor({ timeout: 15000 });
      const btn = card.getByRole('button', { name: /Request/ }).first();
      if (await btn.isDisabled()) break;
      await btn.click();
      const dlg = p.locator('.modal');
      const go2 = dlg.getByRole('button', { name: /^Request/ }).last();
      await go2.waitFor();
      if (await go2.isDisabled()) break;
      await go2.click();
      await sleep(1200);
      if (await dlg.count()) break;
    }
    const msg = (await p.locator('.toast, .modal').allTextContents()).join(' ');
    assert(/used all 2 movie requests|quota|limit/i.test(msg), `no quota message after hitting the movie limit (${msg.slice(0, 160)})`);
    const btn = p.locator('.modal').getByRole('button', { name: /^Request/ }).last();
    assert(await btn.isDisabled(), 'the Request button is still enabled over quota');
    await shot(p, 'quota');
  });
}

/* -------------------------------- error states -------------------------------- */

async function errors() {
  const page = await open({ token: S.viewer.token, label: 'errors' });
  let restarted = true;
  await step('server stops mid-session → offline state; recovers on restart', async () => {
    await go(page, '/');
    await page.locator('.ws-status.on').waitFor();
    current.expect(/.*/); // everything fails while the server is down
    restarted = false;
    await S.server.stop();
    await page.locator('.ws-status:not(.on)').waitFor({ timeout: 15000 });
    await page.locator('.sidebar').getByRole('link', { name: 'Movies', exact: true }).click();
    await sleep(1500);
    await shot(page, 'offline-navigate');
    const txt = await page.locator('main').textContent();
    assert(/reach|offline|connect|network|server/i.test(txt), `no offline message after navigating (page says: ${txt.slice(0, 120)})`);
    await S.server.start();
    restarted = true;
    // The open page comes back: live updates reconnect by themselves, and "Try again" reloads the library.
    await page.locator('.ws-status.on').waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: /Retry|Try again/ }).first().click();
    await page.locator('.library-grid-wrap .card').first().waitFor({ timeout: 15000 });
    await go(page, '/');
    await page.locator('.row-title').first().waitFor();
  });

  if (!restarted) await S.server.start();
  await step('expired session → login with return path, then back', async () => {
    const p = await open({ label: 'expired' });
    await login(p, 'viewer', PASS.viewer);
    const t = await p.evaluate(() => localStorage.getItem('mm.token'));
    const target = `/item/${S.movie('Orbital Hearts').id}`;
    await go(p, target);
    // Sign this session out from elsewhere.
    current.expect(/401/);
    current.expect(/\/api\/v1\//);
    await fetch(`${BASE}/api/v1/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${t}` } });
    await p.getByRole('button', { name: /Mark watched|Add to favourites/ }).first().click();
    await p.waitForURL(/\/login\?next=/, { timeout: 10000 });
    const next = new URL(p.url()).searchParams.get('next');
    assert(next === target, `return path is ${next}, expected ${target}`);
    await p.locator('.login-card, .profiles').first().waitFor();
    const other = p.getByRole('button', { name: 'Sign in with a username' });
    if (await other.count()) await other.first().click();
    await p.getByLabel('Username').fill('viewer');
    await p.getByLabel('Password').fill(PASS.viewer);
    await p.getByRole('button', { name: /^Sign in/ }).click();
    await p.waitForURL((u) => u.pathname === target, { timeout: 10000 });
  });
}

const JOURNEYS = { admin, viewer, tv, phone, kids, errors };

async function main() {
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  const xtream = await prepareMedia(browser);
  const mocks = await startServiceMocks();
  S.mocks = mocks;
  S.xtream = xtream;
  const server = new Server({ MEDIAMAX_ALLOW_PRIVATE_URLS: '1', MEDIAMAX_TMDB_API_BASE: `${mocks.base}/3`, MEDIAMAX_LISTENBRAINZ_API_BASE: `${mocks.base}/lb`, MEDIAMAX_LISTENBRAINZ_LABS_BASE: `${mocks.base}/lb`, MEDIAMAX_NO_WATCH: '1' });
  S.server = server;
  let exit = 0;
  try {
    await server.start({ fresh: true });
    log(`MediaMax on ${BASE} (data ${server.data})`);
    await journey('first-run', firstRun);
    if (results[0].steps.every((s) => s.ok)) {
      for (const [name, fn] of Object.entries(JOURNEYS)) await journey(name, fn);
    }
  } finally {
    console.log('\n──────── Results ────────');
    for (const j of results) {
      console.log(`${j.ok ? 'PASS' : 'FAIL'}  ${j.name}  (${j.steps.filter((s) => s.ok).length}/${j.steps.length} steps)`);
      for (const s of j.steps) if (!s.ok) console.log(`        ✗ ${s.name}: ${s.error}`);
      if (j.error) console.log(`        ✗ aborted: ${j.error.message.split('\n')[0]}`);
      for (const p of j.problems) console.log(`        ! ${p}`);
    }
    exit = results.length && results.every((j) => j.ok) ? 0 : 1;
    fs.writeFileSync(path.join(WORK, 'server.log'), server.log);
    if (arg('keep')) {
      log(`Keeping the server on ${BASE} (Ctrl+C to stop)`);
      await new Promise((r) => process.once('SIGINT', r));
    }
    await browser.close().catch(() => undefined);
    await server.stop();
    await mocks.close();
    await xtream.close();
  }
  process.exit(exit);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
