#!/usr/bin/env node
/**
 * Render every Vibe brand PNG (and favicon.ico) from the master SVGs in branding/vibe/,
 * and copy them to where the web app, the Expo apps, the Samsung/LG/VIDAA TV wrappers and the Roku channel pick them up.
 *
 *   node scripts/brand-export.mjs            rebuild masters (scripts/brand/build-masters.mjs), then export
 *   node scripts/brand-export.mjs --no-masters   export from the SVGs as they are (e.g. after hand-editing one)
 *
 * Needs the `playwright` package with Chromium (same as `npm run screenshots`). No network access.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const B = path.join(repo, 'branding/vibe');

if (!process.argv.includes('--no-masters')) execFileSync(process.execPath, [path.join(here, 'brand/build-masters.mjs')], { stdio: 'inherit' });

// [master svg, output path (repo-relative), width, height (default: keep the SVG's aspect ratio)]
const MOBILE = 'apps/mobile/assets';
const JOBS = [
  // brand folder exports
  ['mark.svg', 'branding/vibe/png/mark-512.png', 512],
  ['mark.svg', 'branding/vibe/png/mark-1024.png', 1024],
  ['mark-simple.svg', 'branding/vibe/png/mark-simple-16.png', 16],
  ['mark-simple.svg', 'branding/vibe/png/mark-simple-32.png', 32],
  ['mark-simple.svg', 'branding/vibe/png/mark-simple-48.png', 48],
  ['mark-mono-black.svg', 'branding/vibe/png/mark-mono-black-512.png', 512],
  ['mark-mono-white.svg', 'branding/vibe/png/mark-mono-white-512.png', 512],
  ['wordmark-dark.svg', 'branding/vibe/png/wordmark-dark-1200.png', 1200],
  ['wordmark-light.svg', 'branding/vibe/png/wordmark-light-1200.png', 1200],
  ['wordmark-tagline-dark.svg', 'branding/vibe/png/wordmark-tagline-dark-1200.png', 1200],
  ['wordmark-tagline-light.svg', 'branding/vibe/png/wordmark-tagline-light-1200.png', 1200],
  ['wordmark-mono-black.svg', 'branding/vibe/png/wordmark-mono-black-1200.png', 1200],
  ['wordmark-mono-white.svg', 'branding/vibe/png/wordmark-mono-white-1200.png', 1200],
  ['lockup-stacked-dark.svg', 'branding/vibe/png/lockup-stacked-dark-1000.png', 1000],
  ['lockup-stacked-light.svg', 'branding/vibe/png/lockup-stacked-light-1000.png', 1000],
  ['lockup-stacked-mono-black.svg', 'branding/vibe/png/lockup-stacked-mono-black-1000.png', 1000],
  ['lockup-stacked-mono-white.svg', 'branding/vibe/png/lockup-stacked-mono-white-1000.png', 1000],
  ['app-icon-dark.svg', 'branding/vibe/png/app-icon-dark-1024.png', 1024],
  ['app-icon-light.svg', 'branding/vibe/png/app-icon-light-1024.png', 1024],
  ['splash-dark.svg', 'branding/vibe/png/splash-dark-1920x1080.png', 1920, 1080],
  ['splash-light.svg', 'branding/vibe/png/splash-light-1920x1080.png', 1920, 1080],
  ['og-image.svg', 'branding/vibe/png/og-image-1200x630.png', 1200, 630],
  // store listing art
  ['app-icon-dark.svg', 'branding/vibe/png/store/app-store-icon-1024.png', 1024],
  ['app-icon-dark.svg', 'branding/vibe/png/store/play-icon-512.png', 512],
  ['play-feature-graphic.svg', 'branding/vibe/png/store/play-feature-graphic-1024x500.png', 1024, 500],
  ['tv-banner.svg', 'branding/vibe/png/store/android-tv-banner-1280x720.png', 1280, 720],
  ['splash-dark.svg', 'branding/vibe/png/store/fire-tv-background-1920x1080.png', 1920, 1080],
  ['app-icon-dark.svg', 'branding/vibe/png/store/samsung-lg-icon-512.png', 512],
  ['roku-poster.svg', 'branding/vibe/png/store/roku-channel-poster-540x405.png', 540, 405],

  // web app (web/public)
  ['favicon.svg', 'web/public/favicon-16.png', 16],
  ['favicon.svg', 'web/public/favicon-32.png', 32],
  ['favicon.svg', 'web/public/favicon-48.png', 48],
  ['app-icon-dark.svg', 'web/public/apple-touch-icon.png', 180],
  ['app-icon-dark.svg', 'web/public/icon-192.png', 192],
  ['app-icon-dark.svg', 'web/public/icon-512.png', 512],
  ['icon-maskable.svg', 'web/public/icon-maskable-512.png', 512],
  ['og-image.svg', 'web/public/og-image.png', 1200, 630],

  // Expo phone / tablet / TV apps (stock assets; a white-label brand folder overrides them)
  ['app-icon-dark.svg', `${MOBILE}/icon.png`, 1024],
  ['android-foreground.svg', `${MOBILE}/android-icon-foreground.png`, 1024],
  ['android-background.svg', `${MOBILE}/android-icon-background.png`, 1024],
  ['android-monochrome.svg', `${MOBILE}/android-icon-monochrome.png`, 1024],
  // Square, mark inside the centre circle: Android 12+ masks the splash icon to a circle of 2/3 its size.
  ['android-foreground.svg', `${MOBILE}/splash-icon.png`, 1024],
  ['favicon.svg', `${MOBILE}/favicon.png`, 48],
  ['notification-icon.svg', `${MOBILE}/notification-icon.png`, 96],
  ['wordmark-dark.svg', `${MOBILE}/brand/wordmark-dark.png`, 960],
  ['wordmark-light.svg', `${MOBILE}/brand/wordmark-light.png`, 960],
  ['mark.svg', `${MOBILE}/brand/mark.png`, 512],
  ['tv-banner.svg', `${MOBILE}/tv/tv-banner.png`, 320, 180],
  ['app-icon-dark.svg', `${MOBILE}/tv/tv-icon.png`, 512],
  ['appletv-icon-front.svg', `${MOBILE}/tv/appletv-icon-front-1280x768.png`, 1280, 768],
  ['appletv-icon-back.svg', `${MOBILE}/tv/appletv-icon-back-1280x768.png`, 1280, 768],
  ['appletv-icon-front.svg', `${MOBILE}/tv/appletv-icon-front-400x240.png`, 400, 240],
  ['appletv-icon-back.svg', `${MOBILE}/tv/appletv-icon-back-400x240.png`, 400, 240],
  ['appletv-icon-front.svg', `${MOBILE}/tv/appletv-icon-front-800x480.png`, 800, 480],
  ['appletv-icon-back.svg', `${MOBILE}/tv/appletv-icon-back-800x480.png`, 800, 480],
  ['appletv-icon.svg', `${MOBILE}/tv/appletv-icon-1280x768.png`, 1280, 768],
  ['appletv-icon.svg', `${MOBILE}/tv/appletv-icon-400x240.png`, 400, 240],
  ['appletv-icon.svg', `${MOBILE}/tv/appletv-icon-800x480.png`, 800, 480],
  ['appletv-topshelf.svg', `${MOBILE}/tv/appletv-topshelf-1920x720.png`, 1920, 720],
  ['appletv-topshelf.svg', `${MOBILE}/tv/appletv-topshelf-3840x1440.png`, 3840, 1440],
  ['appletv-topshelfwide.svg', `${MOBILE}/tv/appletv-topshelfwide-2320x720.png`, 2320, 720],
  ['appletv-topshelfwide.svg', `${MOBILE}/tv/appletv-topshelfwide-4640x1440.png`, 4640, 1440],

  // Samsung Tizen / LG webOS wrappers (tv/build.mjs copies these into tv/dist)
  ['app-icon-dark.svg', 'tv/shared/brand/icon-512.png', 512],
  ['app-icon-dark.svg', 'tv/shared/brand/icon-130.png', 130],
  ['app-icon-dark.svg', 'tv/shared/brand/icon-80.png', 80],
  ['splash-dark.svg', 'tv/shared/brand/splash-1920x1080.png', 1920, 1080],

  // Roku channel (apps/roku/manifest, the sign-in/home logo and the loading spinner)
  ['roku-icon-fhd.svg', 'apps/roku/images/icon_focus_fhd.png', 336, 210],
  ['roku-icon-hd.svg', 'apps/roku/images/icon_focus_hd.png', 290, 218],
  ['splash-dark.svg', 'apps/roku/images/splash_fhd.png', 1920, 1080],
  ['splash-dark.svg', 'apps/roku/images/splash_hd.png', 1280, 720],
  ['app-icon-dark.svg', 'apps/roku/images/logo.png', 256],
  ['spinner.svg', 'apps/roku/images/spinner.png', 96],
];

// Opaque outputs (app-store icons must not have an alpha channel).
const OPAQUE = /app-icon|android-background|appletv-icon-back|appletv-icon\.svg|appletv-top|splash|og-image|tv-banner|icon-maskable|roku-|feature-graphic/;

const browser = await chromium.launch();
const page = await browser.newPage();
let count = 0;
for (const [src, out, w, hArg] of JOBS) {
  const svg = fs.readFileSync(path.join(B, src), 'utf8');
  // Height defaults to the SVG's own aspect ratio.
  const [, sw, sh] = svg.match(/width="([\d.]+)" height="([\d.]+)"/);
  const h = hArg ?? Math.round((w * +sh) / +sw);
  await page.setViewportSize({ width: w, height: h });
  // Chromium rasterises the SVG at the target size, so small sizes are hinted by the renderer rather than downscaled.
  await page.setContent(`<html><body style="margin:0;background:transparent"><img style="display:block;width:${w}px;height:${h}px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`);
  await page.waitForFunction(() => document.images[0].complete);
  const dest = path.join(repo, out);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const opaque = OPAQUE.test(src);
  await page.screenshot({ path: dest, omitBackground: !opaque, clip: { x: 0, y: 0, width: w, height: h } });
  if (opaque) {
    // Strip the alpha channel so App Store Connect / Play accept the icon.
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', dest, '-pix_fmt', 'rgb24', dest + '.tmp.png']);
    fs.renameSync(dest + '.tmp.png', dest);
  }
  count++;
}
await browser.close();

// favicon.ico with 16, 32 and 48 px PNG entries (PNG-in-ICO is supported by every current browser).
{
  const sizes = [16, 32, 48];
  const pngs = sizes.map((s) => fs.readFileSync(path.join(repo, `web/public/favicon-${s}.png`)));
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((s, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(s, e);
    header.writeUInt8(s, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(pngs[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  fs.writeFileSync(path.join(repo, 'web/public/favicon.ico'), Buffer.concat([header, ...pngs]));
  fs.rmSync(path.join(repo, 'web/public/favicon-48.png'));
}

// SVGs served as-is
fs.copyFileSync(path.join(B, 'favicon.svg'), path.join(repo, 'web/public/favicon.svg'));
for (const f of ['wordmark-dark.svg', 'wordmark-light.svg', 'mark.svg']) {
  fs.mkdirSync(path.join(repo, 'web/public/brand'), { recursive: true });
  fs.copyFileSync(path.join(B, f), path.join(repo, 'web/public/brand', f));
}

console.log(`Rendered ${count} PNGs + favicon.ico`);
