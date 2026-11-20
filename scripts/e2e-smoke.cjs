#!/usr/bin/env node
/**
 * End-to-end smoke test: boots a fresh MediaMax server (built server + web), generates sample media
 * with ffmpeg, runs first-time setup, scans libraries, then opens every page of the web app in Chromium.
 * Fails on page errors, console errors, 5xx API responses, blank pages, or a player that never starts.
 *
 *   npm run build && node scripts/e2e-smoke.cjs
 *
 * Requires: ffmpeg, and the `playwright` package with Chromium available.
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const port = 18000 + Math.floor(Math.random() * 1000);
const B = `http://127.0.0.1:${port}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediamax-e2e-'));
const media = path.join(tmp, 'media');
const ff = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);

function makeMedia() {
  const movieDir = path.join(media, 'Movies', 'Smoke Test Movie (2024)');
  const showDir = path.join(media, 'TV', 'Smoke Show (2023)', 'Season 01');
  const musicDir = path.join(media, 'Music', 'Smoke Artist', 'Smoke Album');
  const bookDir = path.join(media, 'Audiobooks', 'Smoke Author', 'Smoke Book');
  for (const d of [movieDir, showDir, musicDir, bookDir]) fs.mkdirSync(d, { recursive: true });
  ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', path.join(movieDir, 'Smoke Test Movie (2024).mp4'));
  fs.writeFileSync(path.join(movieDir, 'Smoke Test Movie (2024).en.srt'), '1\n00:00:01,000 --> 00:00:03,000\nHello\n');
  for (const e of [1, 2]) ff('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', path.join(showDir, `Smoke.Show.S01E0${e}.mkv`));
  ff('-f', 'lavfi', '-i', 'sine=frequency=500:d=5', '-metadata', 'artist=Smoke Artist', '-metadata', 'album=Smoke Album', '-metadata', 'title=Smoke Track', '-metadata', 'track=1', '-c:a', 'libmp3lame', path.join(musicDir, '01 - Smoke Track.mp3'));
  ff('-f', 'lavfi', '-i', 'sine=frequency=200:d=5', '-metadata', 'album=Smoke Book', '-metadata', 'artist=Smoke Author', '-c:a', 'libmp3lame', path.join(bookDir, '01.mp3'));
}

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

(async () => {
  makeMedia();
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/dist/index.js'], {
    cwd: root,
    env: { ...process.env, MEDIAMAX_DATA: path.join(tmp, 'data'), MEDIAMAX_PORT: String(port), MEDIAMAX_HOST: '127.0.0.1', MEDIAMAX_NO_SCHEDULER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));
  const failures = [];
  let browser;
  try {
    await waitFor(async () => (await fetch(`${B}/api/v1/system/info`)).ok, 30000, 'server start');
    const setup = await (await fetch(`${B}/api/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serverName: 'Smoke Test', username: 'admin', password: 'smoke-pass' }) })).json();
    const token = setup.token;
    if (!token) throw new Error('Setup failed: ' + JSON.stringify(setup));
    const H = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const api = async (p, init) => (await fetch(`${B}/api/v1${p}`, { headers: H, ...init })).json();
    for (const [name, type, dir] of [['Movies', 'movies', 'Movies'], ['TV', 'shows', 'TV'], ['Music', 'music', 'Music'], ['Audiobooks', 'audiobooks', 'Audiobooks']]) {
      await api('/libraries', { method: 'POST', body: JSON.stringify({ name, type, paths: [path.join(media, dir)], fetchMetadata: false }) });
    }
    await waitFor(async () => {
      const libs = await api('/libraries');
      return libs.length === 4 && libs.every((l) => !l.scanning && l.itemCount > 0);
    }, 60000, 'library scans');
    const pick = async (q) => (await api('/items?' + q)).items?.[0]?.id;
    const movie = await pick('type=movie');
    const ids = [movie, await pick('type=show'), await pick('type=album'), await pick('type=artist'), await pick('type=audiobook'), await pick('type=episode')].filter(Boolean);
    const libs = await api('/libraries');
    const users = await api('/users');
    const pages = ['/', '/search?q=smoke', '/livetv', '/livetv/guide', '/dvr', '/playlists', '/collections', '/link', '/wrapped', '/podcasts', '/settings', '/discover', '/requests',
      ...libs.map((l) => `/library/${l.id}`), ...ids.map((i) => `/item/${i}`),
      '/admin', '/admin/libraries', '/admin/stats', '/admin/users', `/admin/users/${users[0].id}/wrapped`, '/admin/livetv', '/admin/channels',
      '/admin/branding', '/admin/settings', '/admin/plugins', '/admin/plugins?tab=catalog', '/admin/plugins?tab=repositories', '/admin/tasks', '/admin/activity', '/admin/devices'];

    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    const page = await (await browser.newContext({ viewport: { width: 1366, height: 860 } })).newPage();
    let current = '';
    page.on('pageerror', (e) => failures.push(`${current}: page error: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/status of 404/.test(m.text())) failures.push(`${current}: console error: ${m.text().slice(0, 200)}`);
    });
    page.on('response', (r) => {
      if (r.url().includes('/api/') && r.status() >= 500) failures.push(`${current}: HTTP ${r.status()} ${r.url().replace(B, '').replace(/token=[^&]+/, 'token=…')}`);
    });
    await page.goto(B + '/');
    await page.evaluate((t) => localStorage.setItem('mm.token', t), token);
    for (const p of pages) {
      current = p;
      await page.goto(B + p, { waitUntil: 'networkidle', timeout: 20000 }).catch((e) => failures.push(`${p}: navigation: ${e.message.split('\n')[0]}`));
      await page.waitForTimeout(400);
      const text = (await page.evaluate(() => document.body.innerText || '')).trim();
      if (text.length < 20) failures.push(`${p}: page looks blank`);
      if (/something went wrong/i.test(text)) failures.push(`${p}: error boundary shown`);
    }
    // Player: the video element must start (direct play or HLS).
    current = `/play/${movie}`;
    await page.goto(`${B}/play/${movie}`, { waitUntil: 'networkidle' });
    const started = await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return !!v && (v.readyState >= 2 || v.currentTime > 0);
    }, null, { timeout: 20000 }).then(() => true).catch(() => false);
    if (!started) failures.push('player: video never became ready');
    console.log(`Visited ${pages.length + 1} pages.`);
  } catch (e) {
    failures.push(`setup: ${e.message}`);
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
  }
  if (/\[ERROR\]/.test(serverLog)) failures.push('server logged errors:\n' + serverLog.split('\n').filter((l) => l.includes('[ERROR]')).slice(0, 10).join('\n'));
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failures.length) {
    console.error(`E2E smoke test FAILED (${failures.length}):\n - ` + [...new Set(failures)].join('\n - '));
    process.exit(1);
  }
  console.log('E2E smoke test passed.');
})();
