#!/usr/bin/env node
/**
 * README screenshot pipeline.
 *
 *   npm run build && npm run screenshots
 *
 * 1. Generates a fictional demo library with ffmpeg (movies, shows, music with real beats, audiobooks, photos)
 *    plus Kodi NFOs and artwork rendered from HTML/SVG templates with Playwright.
 * 2. Boots a fresh Vibe server on a free port with a temporary MEDIAMAX_DATA, runs setup ("Vibe Demo"),
 *    scans, creates users, viewing history, My List, favourites, DJ analysis, and Live TV from a mock Xtream provider.
 *    Then the feature extras (lib/showcase.mjs + seedFeatures): profiles, requests and issues against mock TMDB /
 *    Radarr / Sonarr (scripts/e2e/mocks.mjs), Home Assistant over a mock MQTT broker, Play to devices (mock Kodi and
 *    UPnP renderers), disk spin-down, trickplay, a Dolby Vision film and word-timed lyrics.
 * 3. Captures the screenshots into docs/screenshots/ and cleans up.
 *
 * Options:
 *   --only=home,player     capture only these shots (names from lib/shots.mjs)
 *   --work=<dir>           use this work folder instead of a temp one, and keep it (media is reused on the next run)
 *   --hold                 after seeding, keep the server running and write <work>/state.json (for --attach)
 *   --attach=<dir>         take screenshots against a server started with --hold
 *   --out=<dir>            output folder (default docs/screenshots)
 *
 * Needs ffmpeg (with libx265) and the `playwright` package with Chromium. No external network is required (Google
 * Fonts are used when reachable).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareFonts } from './lib/fonts.mjs';
import { Renderer, avatarHtml } from './lib/artwork.mjs';
import { generateMedia } from './lib/media.mjs';
import { startMock } from './lib/mock.mjs';
import { bootServer, client } from './lib/server.mjs';
import { seedFeatures, seedLogs, seedServer } from './lib/seed.mjs';
import { generateShowcase } from './lib/showcase.mjs';
import { startDeviceMocks, startMqttBroker } from './lib/devices.mjs';
import { startServiceMocks, ARR_KEY } from '../e2e/mocks.mjs';
import { Shooter, SHOTS } from './lib/shots.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const arg = (k) => {
  const a = process.argv.find((x) => x === `--${k}` || x.startsWith(`--${k}=`));
  return a == null ? null : a.includes('=') ? a.slice(a.indexOf('=') + 1) : true;
};
// node:sqlite (used to backdate demo history) prints an ExperimentalWarning; keep the output clean.
process.removeAllListeners('warning');
process.on('warning', (w) => w.name !== 'ExperimentalWarning' && console.warn(w));
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${m}`);

const only = arg('only') ? String(arg('only')).split(',') : null;
const out = path.resolve(repo, arg('out') || 'docs/screenshots');
const attach = arg('attach');

async function main() {
  if (!fs.existsSync(path.join(repo, 'server/dist/index.js')) || !fs.existsSync(path.join(repo, 'web/dist/index.html'))) {
    log('No build found, running npm run build…');
    execFileSync('npm', ['run', 'build'], { cwd: repo, stdio: 'inherit' });
  }
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  const cleanup = [() => browser.close()];
  const work = attach ? path.resolve(String(attach)) : arg('work') ? path.resolve(String(arg('work'))) : fs.mkdtempSync(path.join(os.tmpdir(), 'mediamax-shots-'));
  const keepWork = !!(attach || arg('work'));
  try {
    let state;
    if (attach) {
      state = JSON.parse(fs.readFileSync(path.join(work, 'state.json'), 'utf8'));
    } else {
      fs.mkdirSync(work, { recursive: true });
      const portFile = path.join(work, 'mock-port');
      const reuse = fs.existsSync(path.join(work, 'media.done')) && fs.existsSync(portFile);
      // Cast headshot URLs are baked into the NFOs, so the mock must come back on the port the media was made with
      // (read from an NFO: another tool sharing the work folder may have rewritten mock-port).
      const nfoPort = () => {
        try {
          const dir = path.join(work, 'media', 'Movies');
          const nfo = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0], 'movie.nfo'), 'utf8');
          return Number(nfo.match(/<thumb>http:\/\/127\.0\.0\.1:(\d+)\//)?.[1]) || null;
        } catch {
          return null;
        }
      };
      const port = reuse ? nfoPort() ?? Number(fs.readFileSync(portFile, 'utf8')) : 0;
      const mock = await startMock(path.join(work, 'assets'), port).catch(() => {
        log(`Port ${port} is taken; cast headshots will be missing.`);
        return startMock(path.join(work, 'assets'), 0);
      });
      cleanup.unshift(() => mock.close());
      fs.writeFileSync(portFile, String(mock.server.address().port));
      log(`Mock Xtream provider on ${mock.base}`);

      const renderer = new Renderer(browser, work, prepareFonts(path.join(work, 'fonts'), log));
      await renderer.open();
      const media = path.join(work, 'media');
      if (!reuse) {
        log('Generating demo media and artwork…');
        await generateMedia({ root: work, renderer, assetBase: mock.base, log });
        fs.writeFileSync(path.join(work, 'media.done'), new Date().toISOString());
      } else log('Reusing generated media.');
      await generateShowcase({ root: work, renderer, log });
      const avatars = {};
      for (const [k, hue] of [['sam', 205], ['alex', 330], ['kids', 45]]) {
        avatars[k] = path.join(work, 'art', `avatar-${k}.jpg`);
        await renderer.render(avatarHtml(k[0].toUpperCase() + k.slice(1), hue), 256, 256, avatars[k]);
      }
      await renderer.page.close();

      // Libraries and the data folder are shown on some admin pages: point the server at a short, stable path.
      const demo = path.join(os.tmpdir(), 'mediamax-demo');
      fs.rmSync(demo, { force: true });
      fs.symlinkSync(work, demo);
      cleanup.push(() => fs.promises.rm(demo, { force: true }));
      const data = path.join(demo, 'data');
      fs.rmSync(data, { recursive: true, force: true });
      const services = await startServiceMocks(0, { images: path.join(work, 'assets', 'tmdb'), downloads: true });
      const devices = await startDeviceMocks();
      const mqtt = await startMqttBroker();
      cleanup.unshift(() => services.close(), () => devices.close(), () => mqtt.close());
      const accessLog = seedLogs(data);
      log('Booting Vibe…');
      const server = await bootServer({ repo, data, env: { MEDIAMAX_ALLOW_PRIVATE_URLS: '1', MEDIAMAX_PROXY_KIND: 'nginx', MEDIAMAX_PROXY_LOG: accessLog, MEDIAMAX_TMDB_API_BASE: `${services.base}/3`, MEDIAMAX_TMDB_IMAGE_BASE: `${services.base}/t/p/`, MEDIAMAX_NO_WATCH: '1' } });
      cleanup.unshift(() => server.stop());
      log(`Server on ${server.base}`);
      const seeded = await seedServer({ base: server.base, media: path.join(demo, 'media'), data, mockBase: mock.base, avatars, log });
      await seedFeatures({ ...seeded, base: server.base, mocks: services, devices, mqtt, arrKey: ARR_KEY, log });
      const branding = await seeded.admin.get('/branding');
      state = {
        base: server.base, token: seeded.token, alexToken: seeded.alex.token, kidsToken: seeded.kids.token,
        M: seeded.M, S: seeded.S, albums: seeded.albums.map((a) => ({ id: a.id, title: a.title })), channels: seeded.channels.map((c) => ({ id: c.id, name: c.name })),
        heroId: seeded.M['neon-meridian'], themeNames: Object.fromEntries((branding.themes ?? []).map((t) => [t.id, t.name])),
      };
      fs.writeFileSync(path.join(work, 'state.json'), JSON.stringify(state, null, 2));
      if (arg('hold')) {
        log(`Holding. Attach with: node scripts/screenshots/run.mjs --attach=${work}  (Ctrl+C to stop)`);
        await new Promise((r) => process.once('SIGINT', r));
        return;
      }
    }

    state.admin = client(state.base, state.token);
    state.alex = client(state.base, state.alexToken);
    state.kids = client(state.base, state.kidsToken);
    state.adminId = (await state.admin.get('/auth/me')).id;
    state.logoUrls = (await state.admin.get('/items?type=movie,show&limit=200')).items.map((i) => i.logoUrl).filter(Boolean);
    fs.mkdirSync(out, { recursive: true });
    const shooter = new Shooter({ browser, base: state.base, out, state, log });
    await shooter.init();
    log(`Capturing into ${path.relative(repo, out)}/`);
    for (const [name, fn] of Object.entries(SHOTS)) {
      if (only && !only.includes(name)) continue;
      try {
        await fn(shooter);
      } catch (e) {
        shooter.problems.push(`${name}: ${e.message.split('\n')[0]}`);
        log(`  ✗ ${name}: ${e.message.split('\n')[0]}`);
      }
    }
    if (shooter.problems.length) console.warn(`\nThings to look at:\n - ${[...new Set(shooter.problems)].join('\n - ')}`);
  } finally {
    for (const fn of cleanup) await fn().catch?.(() => undefined);
    if (!keepWork) fs.rmSync(work, { recursive: true, force: true });
  }
  const size = fs.readdirSync(out, { recursive: true }).reduce((s, f) => s + (fs.statSync(path.join(out, f)).isFile() ? fs.statSync(path.join(out, f)).size : 0), 0);
  log(`Done. ${path.relative(repo, out)} is ${(size / 1048576).toFixed(1)} MB.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
