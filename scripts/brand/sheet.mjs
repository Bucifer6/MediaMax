#!/usr/bin/env node
/**
 * Render a one-page brand sheet (every asset at real sizes, icons under the platform masks) for review.
 *
 *   node scripts/brand/sheet.mjs out.png
 *
 * Also writes branding/kinora/png/icon-sizes.png: the app icon and the mark at launcher, toolbar and favicon sizes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const B = path.join(repo, 'branding/kinora');
const out = path.resolve(process.argv[2] ?? 'brand-sheet.png');

const uri = (file) => {
  const p = path.isAbsolute(file) ? file : path.join(B, file);
  const type = p.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
  return `data:${type};base64,${fs.readFileSync(p).toString('base64')}`;
};
const png = (rel) => uri(path.join(repo, rel));

const css = `
body{margin:0;background:#191f22;color:#f2f6f4;font:13px/1.4 system-ui,sans-serif;padding:28px;width:1700px}
h2{font-size:14px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#a7b6b1;margin:26px 0 10px}
.row{display:flex;gap:22px;align-items:flex-end;flex-wrap:wrap}
.cell{display:flex;flex-direction:column;align-items:center;gap:6px}
.cell small{color:#a7b6b1}
.dark{background:#101416;padding:16px;border-radius:10px}
.light{background:#ffffff;padding:16px;border-radius:10px}
.pix{image-rendering:pixelated}
.ios{border-radius:22.37%;overflow:hidden}
.circle{border-radius:50%;overflow:hidden}
.squircle{clip-path:path('M96 0C168 0 192 24 192 96S168 192 96 192 0 168 0 96 24 0 96 0Z')}
.adaptive{position:relative;width:192px;height:192px}
.adaptive img{position:absolute;inset:-24px;width:240px;height:240px}
.safe{position:absolute;left:50%;top:50%;width:146.7px;height:146.7px;margin:-73.3px;border:1px dashed #ff4d6d;border-radius:50%}
`;
const cell = (inner, label) => `<div class="cell">${inner}<small>${label}</small></div>`;
const img = (src, w, h, cls = '') => `<img class="${cls}" src="${src}" width="${w}"${h ? ` height="${h}"` : ''}>`;

const html = `<!doctype html><style>${css}</style>
<h2>Mark — full colour (512 master) and simplified at real pixel sizes</h2>
<div class="row">
  ${cell(`<div class="dark">${img(uri('mark.svg'), 340)}</div>`, 'mark.svg on dark')}
  ${cell(`<div class="light">${img(uri('mark.svg'), 340)}</div>`, 'mark.svg on white')}
  ${cell(`<div class="dark row" style="align-items:flex-end">${[16, 32, 48].map((s) => img(png(`branding/kinora/png/mark-simple-${s}.png`), s, s)).join('')}${img(uri('mark.svg'), 96)}</div>`, 'simplified 16 / 32 / 48 · full 96')}
  ${cell(`<div class="light row" style="align-items:flex-end">${[16, 32, 48].map((s) => img(png(`branding/kinora/png/mark-simple-${s}.png`), s, s)).join('')}${img(uri('mark.svg'), 96)}</div>`, 'on white')}
  ${cell(`<div class="dark row" style="align-items:flex-end">${img(png('web/public/favicon-16.png'), 16, 16)}${img(png('web/public/favicon-32.png'), 32, 32)}${img(png('web/public/favicon-32.png'), 128, 128, 'pix')}</div>`, 'favicon 16 / 32 / 32 zoomed')}
</div>
<h2>Single colour</h2>
<div class="row">
  ${cell(`<div class="light">${img(uri('mark-mono-black.svg'), 150)}</div>`, 'mark mono black')}
  ${cell(`<div class="dark">${img(uri('mark-mono-white.svg'), 150)}</div>`, 'mark mono white')}
  ${cell(`<div class="light">${img(uri('wordmark-mono-black.svg'), 360)}</div>`, 'wordmark mono black')}
  ${cell(`<div class="dark">${img(uri('wordmark-mono-white.svg'), 360)}</div>`, 'wordmark mono white')}
  ${cell(`<div style="background:#3b82f6;padding:16px;border-radius:10px">${img(png('apps/mobile/assets/notification-icon.png'), 24, 24)} ${img(png('apps/mobile/assets/notification-icon.png'), 48, 48)}</div>`, 'notification 24 / 48 dp')}
</div>
<h2>App icons under platform masks</h2>
<div class="row">
  ${cell(img(uri('app-icon-dark.svg'), 192, 192, 'ios'), 'iOS (dark)')}
  ${cell(img(uri('app-icon-light.svg'), 192, 192, 'ios'), 'iOS (light)')}
  ${cell(`<div class="adaptive circle"><img src="${png('apps/mobile/assets/android-icon-background.png')}"><img src="${png('apps/mobile/assets/android-icon-foreground.png')}"></div>`, 'Android adaptive · circle')}
  ${cell(`<div class="adaptive squircle"><img src="${png('apps/mobile/assets/android-icon-background.png')}"><img src="${png('apps/mobile/assets/android-icon-foreground.png')}"></div>`, 'Android adaptive · squircle')}
  ${cell(`<div class="adaptive" style="border-radius:24px;overflow:hidden"><img src="${png('apps/mobile/assets/android-icon-background.png')}"><img src="${png('apps/mobile/assets/android-icon-foreground.png')}"><div class="safe"></div></div>`, 'foreground + 66 dp safe circle')}
  ${cell(`<div class="adaptive circle" style="background:#d8e2ff"><img src="${png('apps/mobile/assets/android-icon-monochrome.png')}" style="filter:brightness(0) saturate(100%) invert(18%) sepia(40%) saturate(2000%) hue-rotate(210deg)"></div>`, 'Android 13 themed (monochrome)')}
  ${cell(img(png('web/public/icon-maskable-512.png'), 192, 192, 'circle'), 'PWA maskable · circle')}
  ${cell(img(png('web/public/apple-touch-icon.png'), 90, 90, 'ios'), 'apple-touch 180')}
</div>
<h2>Wordmarks</h2>
<div class="row">
  ${cell(`<div class="dark">${img(uri('wordmark-dark.svg'), 480)}</div>`, 'wordmark-dark')}
  ${cell(`<div class="light">${img(uri('wordmark-light.svg'), 480)}</div>`, 'wordmark-light')}
  ${cell(`<div class="dark">${img(uri('wordmark-tagline-dark.svg'), 480)}</div>`, 'with tagline')}
  ${cell(`<div class="light">${img(uri('wordmark-tagline-light.svg'), 480)}</div>`, 'with tagline (light)')}
  ${cell(`<div class="dark">${img(uri('wordmark-dark.svg'), 160)}</div>`, 'header size')}
  ${cell(`<div class="light">${img(uri('wordmark-light.svg'), 160)}</div>`, 'header size')}
</div>
<h2>Splash · TV · social</h2>
<div class="row">
  ${cell(img(uri('splash-dark.svg'), 420), 'splash-dark 1920×1080')}
  ${cell(img(uri('splash-light.svg'), 420), 'splash-light')}
  ${cell(img(uri('og-image.svg'), 380), 'og-image 1200×630')}
  ${cell(img(png('apps/mobile/assets/tv/tv-banner.png'), 320, 180), 'Android TV banner 320×180')}
  ${cell(`<div class="light">${img(uri('lockup-stacked-light.svg'), 230)}</div>`, 'stacked lockup')}
</div>
<div class="row" style="margin-top:16px">
  ${cell(`<div style="border-radius:14px;overflow:hidden;box-shadow:0 10px 30px #0008">${img(png('apps/mobile/assets/tv/appletv-icon-400x240.png'), 400, 240)}</div>`, 'Apple TV icon 400×240 (front + back layers)')}
  ${cell(img(png('apps/mobile/assets/tv/appletv-topshelfwide-2320x720.png'), 700), 'Apple TV top shelf wide')}
  ${cell(img(png('tv/shared/brand/icon-130.png'), 130, 130), 'webOS largeIcon 130')}
  ${cell(img(png('tv/shared/brand/icon-80.png'), 80, 80), 'webOS icon 80')}
  ${cell(img(png('apps/roku/images/icon_focus_fhd.png'), 336, 210), 'Roku focus icon FHD 336×210')}
  ${cell(img(png('apps/roku/images/spinner.png'), 48, 48), 'Roku spinner')}
  ${cell(img(png('branding/kinora/png/store/play-feature-graphic-1024x500.png'), 410, 200), 'Play feature graphic 1024×500')}
</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1760, height: 800 } });
await page.setContent(html);
await page.waitForTimeout(300);
await page.screenshot({ path: out, fullPage: true });

{
  const sizes = [256, 128, 64, 48, 32, 24, 16];
  const row = (bg, src, cls = '') => `<div style="background:${bg};padding:20px;display:flex;gap:20px;align-items:flex-end">${sizes.map((s) => `<div style="display:flex;flex-direction:column;align-items:center;gap:6px"><img class="${cls}" src="${src}" width="${s}" height="${s}"><small style="color:#a7b6b1;font:11px system-ui">${s}</small></div>`).join('')}</div>`;
  await page.setViewportSize({ width: 900, height: 400 });
  await page.setContent(`<!doctype html><style>${css} body{width:auto;padding:0;display:inline-block} .ios{border-radius:22.37%}</style>${row('#101416', uri('app-icon-dark.svg'), 'ios')}${row('#ffffff', uri('app-icon-light.svg'), 'ios')}${row('#101416', uri('favicon.svg'))}${row('#ffffff', uri('mark-simple.svg'))}`);
  await page.waitForTimeout(300);
  await page.locator('body').screenshot({ path: path.join(B, 'png/icon-sizes.png') });
}
await browser.close();
console.log(`Wrote ${out}`);
