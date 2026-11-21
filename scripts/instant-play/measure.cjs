#!/usr/bin/env node
/**
 * Playback start-latency benchmark (instant play warm-up).
 *
 * Boots a fresh server from the built output (server/dist + web/dist), generates three test films with ffmpeg —
 * one that direct-plays in Chromium (MP4 H.264/AAC), one that is remuxed (MKV H.264/AAC) and one that is
 * transcoded (MKV MPEG-4 Part 2) — and measures:
 *
 *   api      POST /playback/:id → first media bytes (direct: first 64 KB; HLS: master → variant → init → first segment).
 *            "cold" = no warm-up; "warm" = POST /playback/:id/prepare, then the same start ~1.5 s later (a hover / page dwell).
 *            "resume" variants start 90 s in.
 *   browser  Chromium: open the item page, hover Play for 600 ms, click, time until the <video> is playing (currentTime > 0).
 *
 * Works against builds with and without the prepare endpoint (a 404 there just skips the "warm" rows), so the same
 * script measures before/after:
 *
 *   npm run build && node scripts/instant-play/measure.cjs [--runs 5] [--label after] [--json out.json]
 *
 * Requires ffmpeg and the `playwright` package with Chromium (set PLAYWRIGHT_MODULE to its path if it isn't resolvable).
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const RUNS = Number(arg('runs', 5));
const LABEL = arg('label', 'run');
const JSON_OUT = arg('json', null);
const SKIP_BROWSER = process.argv.includes('--no-browser');

let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'));
} catch {
  ({ chromium } = require('/opt/node-tools/node_modules/playwright'));
}

const root = path.resolve(__dirname, '../..');
const port = 19000 + Math.floor(Math.random() * 1000);
const B = `http://127.0.0.1:${port}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instant-play-'));
const media = path.join(tmp, 'media', 'Movies');
const ff = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 3-minute 720p films: enough timeline for a 90 s resume. */
function makeMedia() {
  const src = ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '180'];
  const films = [
    ['Direct Film (2024)', 'mp4', ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-c:a', 'aac', '-movflags', '+faststart']],
    ['Remux Film (2024)', 'mkv', ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-c:a', 'aac']],
    ['Transcode Film (2024)', 'mkv', ['-c:v', 'mpeg4', '-q:v', '5', '-g', '48', '-c:a', 'aac']],
  ];
  for (const [name, ext, codec] of films) {
    const dir = path.join(media, name);
    fs.mkdirSync(dir, { recursive: true });
    ff(...src, ...codec, path.join(dir, `${name}.${ext}`));
  }
}

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {
      /* retry */
    }
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** What Chromium's web player sends (deviceProfile.ts, Auto quality). */
const PROFILE = {
  videoCodecs: ['h264', 'vp9', 'vp8', 'av1'], audioCodecs: ['aac', 'mp3', 'opus', 'vorbis', 'flac'],
  containers: ['mp4', 'm4v', 'mov', 'webm', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'wav'], supportsHls: true, maxWidth: 1920, player: 'html5',
};
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

(async () => {
  makeMedia();
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/dist/index.js'], {
    cwd: root,
    env: { ...process.env, MEDIAMAX_DATA: path.join(tmp, 'data'), MEDIAMAX_PORT: String(port), MEDIAMAX_HOST: '127.0.0.1', MEDIAMAX_NO_SCHEDULER: '1', MEDIAMAX_LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));
  const results = { label: LABEL, runs: RUNS, api: {}, browser: {} };
  let browser;
  try {
    await waitFor(async () => (await fetch(`${B}/api/v1/system/info`)).ok, 30000, 'server start');
    const setup = await (await fetch(`${B}/api/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serverName: 'Bench', username: 'admin', password: 'bench-pass' }) })).json();
    const token = setup.token;
    if (!token) throw new Error('Setup failed: ' + JSON.stringify(setup));
    const H = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const api = async (p, init) => {
      const r = await fetch(`${B}/api/v1${p}`, { headers: H, ...init });
      if (!r.ok) throw Object.assign(new Error(`${p}: ${r.status} ${await r.text()}`), { status: r.status });
      return r.json();
    };
    await api('/libraries', { method: 'POST', body: JSON.stringify({ name: 'Movies', type: 'movies', paths: [media], fetchMetadata: false }) });
    await waitFor(async () => (await api('/libraries')).every((l) => !l.scanning && l.itemCount >= 3), 60000, 'library scan');
    // No trailers / pre-rolls in front of the film.
    await api('/auth/me', { method: 'PATCH', body: JSON.stringify({ preferences: { cinemaMode: false } }) }).catch(() => {});
    const items = (await api('/items?type=movie&limit=10')).items;
    const id = (t) => items.find((i) => i.title.startsWith(t)).id;
    const films = [['direct', id('Direct')], ['remux', id('Remux')], ['transcode', id('Transcode')]];

    const get = async (url, headers = {}) => {
      const r = await fetch(new URL(url, B), { headers: { Authorization: `Bearer ${token}`, ...headers } });
      if (!r.ok && r.status !== 206) throw new Error(`${url.replace(/token=[^&]+/, 'token=…')}: ${r.status}`);
      return r;
    };
    const lines = (txt) => txt.split('\n').map((l) => l.trim()).filter(Boolean);
    /** First media bytes of a PlaybackInfo, at `startMs`. */
    async function firstBytes(pi, startMs) {
      if (!pi.isHls) {
        await (await get(pi.url, { Range: 'bytes=0-65535' })).arrayBuffer();
        return;
      }
      const base = new URL(pi.url, B);
      let txt = await (await get(base.href)).text();
      let playlistUrl = base;
      if (txt.includes('#EXT-X-STREAM-INF')) {
        const ls = lines(txt);
        const variant = ls[ls.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF')) + 1];
        playlistUrl = new URL(variant, base);
        txt = await (await get(playlistUrl.href)).text();
      }
      const ls = lines(txt);
      const map = ls.find((l) => l.startsWith('#EXT-X-MAP'));
      const fetches = [];
      if (map) fetches.push(get(new URL(map.match(/URI="([^"]+)"/)[1], playlistUrl).href).then((r) => r.arrayBuffer()));
      let t = 0;
      let seg = null;
      for (let i = 0; i < ls.length; i++) {
        if (!ls[i].startsWith('#EXTINF')) continue;
        const d = parseFloat(ls[i].slice(8));
        seg = ls[i + 1];
        if (t + d > startMs / 1000) break;
        t += d;
      }
      // Remux (event playlist) may not list the resume point yet: the player asks for the segment it needs.
      if (seg) fetches.push(get(new URL(seg, playlistUrl).href).then((r) => r.arrayBuffer()));
      await Promise.all(fetches);
    }

    const body = (startMs) => ({ startMs, deviceProfile: PROFILE, adaptive: true, measuredBandwidth: 100000, subtitleFormats: ['vtt'] });
    let prepareSupported = true;
    for (const [kind, itemId] of films) {
      for (const startMs of [0, 90000]) {
        for (const mode of ['cold', 'warm']) {
          const key = `${kind}${startMs ? ' resume' : ''} ${mode}`;
          const times = [];
          for (let i = 0; i < RUNS; i++) {
            if (mode === 'warm') {
              if (!prepareSupported) break;
              try {
                await api(`/playback/${itemId}/prepare`, { method: 'POST', body: JSON.stringify(body(startMs)) });
              } catch (e) {
                if (e.status === 404) {
                  prepareSupported = false;
                  break;
                }
                throw e;
              }
              await sleep(1500);
            }
            const t0 = performance.now();
            const pi = await api(`/playback/${itemId}`, { method: 'POST', body: JSON.stringify(body(startMs)) });
            await firstBytes(pi, startMs);
            times.push(performance.now() - t0);
            await api(`/playback/sessions/${pi.sessionId}`, { method: 'DELETE' });
            await sleep(400);
          }
          if (times.length) results.api[key] = { median: median(times), min: Math.round(Math.min(...times)), max: Math.round(Math.max(...times)), method: kind };
        }
      }
    }

    if (!SKIP_BROWSER) {
      browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
      const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
      const page = await ctx.newPage();
      await page.goto(B + '/');
      await page.evaluate((t) => localStorage.setItem('mm.token', t), token);
      for (const [kind, itemId] of films) {
        const times = [];
        for (let i = 0; i < RUNS; i++) {
          // Fresh start each time: no resume position.
          await api(`/items/${itemId}/progress`, { method: 'POST', body: JSON.stringify({ positionMs: 0, state: 'stopped' }) }).catch(() => {});
          await page.goto(`${B}/item/${itemId}`, { waitUntil: 'networkidle' });
          const btn = page.locator('.detail-info .btn-primary').first();
          await btn.waitFor();
          await btn.hover();
          await page.waitForTimeout(600);
          const ms = await page.evaluate(() => new Promise((resolve, reject) => {
            const t0 = performance.now();
            document.querySelector('.detail-info .btn-primary').click();
            const tick = () => {
              const v = document.querySelector('video');
              if (v && v.currentTime > 0 && !v.paused) resolve(performance.now() - t0);
              else if (performance.now() - t0 > 30000) reject(new Error('video never started'));
              else setTimeout(tick, 10);
            };
            tick();
          }));
          times.push(ms);
          await page.goto(`${B}/`, { waitUntil: 'networkidle' });
          await sleep(500);
        }
        results.browser[kind] = { median: median(times), min: Math.round(Math.min(...times)), max: Math.round(Math.max(...times)) };
      }
    }
  } catch (e) {
    console.error('Benchmark failed:', e);
    console.error(serverLog.split('\n').slice(-30).join('\n'));
    process.exitCode = 1;
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nPlayback start latency (${LABEL}, median of ${RUNS} runs, ms)`);
  console.log('API: start request → first media bytes');
  for (const [k, v] of Object.entries(results.api)) console.log(`  ${k.padEnd(26)} ${String(v.median).padStart(6)}   (min ${v.min}, max ${v.max})`);
  if (Object.keys(results.browser).length) {
    console.log('Browser: click Play (after 600 ms hover) → video playing');
    for (const [k, v] of Object.entries(results.browser)) console.log(`  ${k.padEnd(26)} ${String(v.median).padStart(6)}   (min ${v.min}, max ${v.max})`);
  }
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
})();
