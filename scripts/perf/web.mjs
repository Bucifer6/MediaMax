/**
 * Web client (and TV app) benchmark with Playwright against the seeded large library (see run.mjs / seed.mjs).
 *
 *   node scripts/perf/web.mjs [--label=after] [--repo=<checkout with built server + web>] [--cpu=4] [--runs=3]
 *
 * Measures, with Chromium and optional CPU throttling (4× ≈ a TV):
 *  - Home: first contentful paint, time until the first rows are on screen, JS/CSS transferred, long tasks.
 *  - Library grid (20k movies): scrolls through ~1,200 cards (infinite loading), frame rate and long tasks.
 *  - TV guide: scrolls down through channels (paged loading), frame rate and long tasks.
 *  - Navigation: Home → title detail (click a poster) → player UI mounted (click Play).
 * Writes scripts/perf/results/web-<label>.json.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { bootServer } from '../screenshots/lib/server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=') ?? d;
const label = arg('label', 'run');
const serverRepo = path.resolve(arg('repo', repo));
const cpu = Number(arg('cpu', '4'));
const runs = Number(arg('runs', '3'));
/** Comma list of sections to run: home,library,guide (default all). */
const sections = arg('only', 'home,library,guide').split(',');
const cacheRoot = arg('cache', path.join(os.tmpdir(), 'mediamax-perf'));
const pristine = path.join(cacheRoot, `seed-${arg('scale', '1')}`);
if (!fs.existsSync(path.join(pristine, 'perf-manifest.json'))) {
  console.error(`No seeded data at ${pristine}: run node scripts/perf/run.mjs once first (or pass --cache=).`);
  process.exit(2);
}
const work = path.join(cacheRoot, `web-${label}`);
fs.rmSync(work, { recursive: true, force: true });
fs.cpSync(pristine, work, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(work, 'perf-manifest.json'), 'utf8'));
const user = manifest.tokens.find((t) => !t.admin && !t.restricted);

const server = await bootServer({ repo: serverRepo, data: work });
process.on('exit', () => {
  try {
    server.proc.kill('SIGKILL');
  } catch { /* gone */ }
});
const browser = await chromium.launch();
const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
const r0 = (n) => Math.round(n);

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctx.addInitScript(([token]) => {
    try {
      localStorage.setItem('mm.token', token);
      localStorage.setItem('mm.whatsNewSeen', '999');
      localStorage.setItem('mm.library.presentation', 'covers'); // keep the grid benchmark comparable
    } catch { /* ignore */ }
    window.__lt = [];
    window.__seen = {};
    try {
      const sels = ['.splash', '.home .skeleton, .programme .skeleton', '.programme .story-title, .home-rows a.card[href^="/item/"]', '.grid a.card[href^="/item/"]', '.guide-row .guide-prog', '.detail-actions button', '.player .player-video-host'];
      new MutationObserver(() => {
        for (const sel of sels) if (!(sel in window.__seen) && document.querySelector(sel)) window.__seen[sel] = Math.round(performance.now());
      }).observe(document, { childList: true, subtree: true });
    } catch { /* ignore */ }
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__lt.push(e.duration);
      }).observe({ type: 'longtask', buffered: true });
    } catch { /* unsupported */ }
  }, [user.token]);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  const bytes = { js: 0, css: 0, api: 0, img: 0 };
  page.on('response', async (res) => {
    const u = res.url();
    const len = Number((await res.headerValue('content-length').catch(() => null)) ?? 0) || (await res.body().catch(() => Buffer.alloc(0))).length;
    if (/\.js(\?|$)/.test(u)) bytes.js += len;
    else if (/\.css(\?|$)/.test(u)) bytes.css += len;
    else if (u.includes('/api/v1/images/')) bytes.img += len;
    else if (u.includes('/api/')) bytes.api += len;
  });
  return { ctx, page, bytes };
}

const longTasks = async (page) => page.evaluate(() => {
  const a = window.__lt ?? [];
  window.__lt = [];
  return { count: a.length, totalMs: Math.round(a.reduce((x, y) => x + y, 0)), maxMs: Math.round(Math.max(0, ...a)) };
});

/** Scroll with the mouse wheel for `steps` steps, counting animation frames. Returns fps and long tasks. */
async function scrollFps(page, { steps, dy, pauseMs = 16, beforeStep }) {
  await longTasks(page);
  await page.evaluate(() => {
    window.__frames = 0;
    window.__run = true;
    const tick = () => {
      window.__frames++;
      if (window.__run) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const t0 = Date.now();
  for (let i = 0; i < steps; i++) {
    if (beforeStep) await beforeStep(i);
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(pauseMs);
  }
  const ms = Date.now() - t0;
  const frames = await page.evaluate(() => {
    window.__run = false;
    return window.__frames;
  });
  return { fps: Math.round((frames / ms) * 10000) / 10, ms, longTasks: await longTasks(page) };
}

const out = { label, date: new Date().toISOString(), cpuThrottle: cpu, runs, home: [], library: [], guide: [], nav: [] };
try {
  for (let r = 0; r < runs; r++) {
    /* ------------------------------ Home ------------------------------ */
    if (sections.includes('home')) {
      const { ctx, page, bytes } = await newPage();
      const api = [];
      page.on('requestfinished', (req) => {
        const u = new URL(req.url());
        if (u.pathname.startsWith('/api/v1/') && !u.pathname.startsWith('/api/v1/images')) {
          const t = req.timing();
          api.push(`${u.pathname} ${Math.round(t.startTime - nav0)}+${Math.round(t.responseEnd)}`);
        }
      });
      const nav0 = Date.now();
      await page.goto(`${server.base}/`, { waitUntil: 'commit' });
      // Real title cards (the loading skeleton uses .card too). The time comes from a MutationObserver in the page, so
      // it doesn't depend on how often Playwright polls a busy, throttled main thread.
      await page.waitForSelector('.programme .story-title, .home-rows a.card[href^="/item/"]', { timeout: 60000, state: 'attached' });
      const rowsAt = await page.evaluate(() => window.__seen['.programme .story-title, .home-rows a.card[href^="/item/"]'] ?? performance.now());
      const fcp = await page.evaluate(() => performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null);
      await page.waitForLoadState('networkidle').catch(() => {});
      const lt = await longTasks(page);
      if (process.env.MM_PERF_DEBUG) console.log(api.join('\n'), await page.evaluate(() => JSON.stringify(window.__seen)));
      out.home.push({ fcpMs: r0(fcp), rowsVisibleMs: r0(rowsAt), jsKB: r0(bytes.js / 1024), cssKB: r0(bytes.css / 1024), apiKB: r0(bytes.api / 1024), longTasks: lt });
      console.log(`home      FCP ${r0(fcp)}ms  rows ${r0(rowsAt)}ms  JS ${r0(bytes.js / 1024)}KB CSS ${r0(bytes.css / 1024)}KB API ${r0(bytes.api / 1024)}KB  long tasks ${lt.count} / ${lt.totalMs}ms`);

      /* ------------------------ Home → item → play ----------------------- */
      const t0 = await page.evaluate(() => performance.now());
      // A poster row (cards in Continue Watching / Next Up start playback instead of opening the title).
      await page.locator('.programme .story-title, .home-rows .row:not(.row-wide):not(.row-channels) .card[href^="/item/"]').first().click();
      try {
        await page.waitForSelector('.detail-actions button', { timeout: 60000, state: 'attached' });
      } catch (e) {
        await page.screenshot({ path: path.join(os.tmpdir(), 'mm-web-perf-fail.png') });
        throw e;
      }
      const itemMs = r0((await page.evaluate(() => window.__seen['.detail-actions button'])) - t0);
      await page.waitForTimeout(1500); // idle time a viewer spends reading the page (prefetch may happen here)
      const t1 = await page.evaluate(() => performance.now());
      await page.locator('.detail-actions [data-nav]').first().click();
      await page.waitForSelector('.player .player-video-host', { timeout: 60000, state: 'attached' });
      const playerMs = r0((await page.evaluate(() => window.__seen['.player .player-video-host'])) - t1);
      out.nav.push({ homeToItemMs: itemMs, itemToPlayerUiMs: playerMs });
      console.log(`nav       home → item ${itemMs}ms   item → player UI ${playerMs}ms`);
      await ctx.close();
    }

    /* ----------------------------- Library ---------------------------- */
    if (sections.includes('library')) {
      const { ctx, page } = await newPage();
      await page.goto(`${server.base}/library/${manifest.libraries.movies}`);
      await page.waitForSelector('.grid .card', { timeout: 60000 });
      await page.mouse.move(800, 600);
      // Load ~20 pages (1,200 cards) by scrolling to the end, then measure a scroll back up through all of them.
      const load = await scrollFps(page, { steps: 160, dy: 900, pauseMs: 40 });
      const cards = await page.locator('.grid .card').count();
      const sweep = await scrollFps(page, { steps: 120, dy: -1200, pauseMs: 16 });
      out.library.push({ cards, loadingScroll: load, sweep });
      console.log(`library   ${cards} cards  loading-scroll ${load.fps}fps lt ${load.longTasks.count}/${load.longTasks.totalMs}ms   sweep ${sweep.fps}fps lt ${sweep.longTasks.count}/${sweep.longTasks.totalMs}ms`);
      await ctx.close();
    }

    /* ------------------------------ Guide ----------------------------- */
    if (sections.includes('guide')) {
      const { ctx, page } = await newPage();
      await page.goto(`${server.base}/livetv/guide`);
      await page.waitForSelector('.guide-row .guide-prog', { timeout: 60000, state: 'attached' });
      const firstMs = await page.evaluate(() => window.__seen['.guide-row .guide-prog'] ?? performance.now());
      const box = await page.locator('.guide-grid').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const load = await scrollFps(page, { steps: 120, dy: 600, pauseMs: 40 });
      const rows = await page.locator('.guide-row').count();
      const sweep = await scrollFps(page, { steps: 80, dy: -900, pauseMs: 16 });
      const horiz = await scrollFps(page, { steps: 40, dy: 0, pauseMs: 16, beforeStep: () => page.mouse.wheel(300, 0) });
      out.guide.push({ firstRowsMs: firstMs, rows, loadingScroll: load, sweep, horizontal: horiz });
      console.log(`guide     first ${firstMs}ms  ${rows} rows  loading-scroll ${load.fps}fps lt ${load.longTasks.count}/${load.longTasks.totalMs}ms   sweep ${sweep.fps}fps lt ${sweep.longTasks.totalMs}ms   horizontal ${horiz.fps}fps`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  await server.stop();
  fs.rmSync(work, { recursive: true, force: true });
}

const q = (o, f) => (o.length ? f() : null);
out.summary = {
  homeFcpMs: med(out.home.map((h) => h.fcpMs)),
  homeRowsMs: med(out.home.map((h) => h.rowsVisibleMs)),
  homeJsKB: med(out.home.map((h) => h.jsKB)),
  homeCssKB: med(out.home.map((h) => h.cssKB)),
  homeLongTaskMs: med(out.home.map((h) => h.longTasks.totalMs)),
  homeToItemMs: med(out.nav.map((n) => n.homeToItemMs)),
  itemToPlayerUiMs: med(out.nav.map((n) => n.itemToPlayerUiMs)),
  libraryCards: med(out.library.map((l) => l.cards)),
  libraryLoadFps: med(out.library.map((l) => l.loadingScroll.fps)),
  libraryLoadLongTaskMs: med(out.library.map((l) => l.loadingScroll.longTasks.totalMs)),
  librarySweepFps: med(out.library.map((l) => l.sweep.fps)),
  librarySweepLongTaskMs: med(out.library.map((l) => l.sweep.longTasks.totalMs)),
  guideFirstRowsMs: med(out.guide.map((g) => g.firstRowsMs)),
  guideRows: med(out.guide.map((g) => g.rows)),
  guideLoadFps: med(out.guide.map((g) => g.loadingScroll.fps)),
  guideLoadLongTaskMs: med(out.guide.map((g) => g.loadingScroll.longTasks.totalMs)),
  guideSweepFps: med(out.guide.map((g) => g.sweep.fps)),
  guideHorizontalFps: med(out.guide.map((g) => g.horizontal.fps)),
};
console.log(out.summary);
const dir = path.join(repo, 'scripts/perf/results');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `web-${label}.json`), JSON.stringify(out, null, 1));
