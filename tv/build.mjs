#!/usr/bin/env node
/**
 * Assemble the Samsung Tizen, LG webOS and Hisense VIDAA wrapper apps into tv/dist/{tizen,webos,vidaa}.
 * All are small "enter your server address" pages that then load the MediaMax web app in TV mode (?tv=1).
 *
 *   node tv/build.mjs [--icon path/to/square.png] [--name "Brand"] [--url https://tv.example.com/mediamax/]
 *
 * --url is where you will host tv/dist/vidaa (VIDAA apps are hosted web apps); it makes the URLs in
 * tv/dist/vidaa/vidaa-app.json absolute, ready for the VIDAA submission form or a developer-mode install.
 *
 * Without options the stock MediaMax artwork rendered by scripts/brand-export.mjs is used (tv/shared/brand/:
 * app icon, splash, and the outlined wordmark on the start screen). --icon letterboxes your own square icon
 * instead (white label), and --name replaces the name everywhere and shows it as text on the start screen.
 *
 * Then package and sign with the vendor tools (see tv/README.md):
 *   tizen package -t wgt -s <profile> -- tv/dist/tizen
 *   ares-package tv/dist/webos
 *   (VIDAA: upload tv/dist/vidaa to an HTTPS host, then register that URL)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const customIcon = opt('--icon', null);
const icon = customIcon ? path.resolve(customIcon) : null;
const name = opt('--name', 'MediaMax');
const hostedUrl = opt('--url', null);
const stockArt = path.join(here, 'shared/brand');
const stockLogo = path.join(here, '../branding/mediamax/wordmark-dark.svg');
const dist = path.join(here, 'dist');

function png(out, w, h, pad = 0, stock = null) {
  if (!icon && stock) return fs.copyFileSync(path.join(stockArt, stock), out);
  // ffmpeg is already a MediaMax dependency; letterbox the square icon onto the brand background.
  const inner = Math.round(Math.min(w, h) * (1 - pad));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', icon ?? path.join(stockArt, 'icon-512.png'), '-vf', `scale=${inner}:${inner}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x0A0F22`, '-frames:v', '1', out]);
}

const useLogo = name === 'MediaMax' && fs.existsSync(stockLogo);
let page = fs.readFileSync(path.join(here, 'shared/index.html'), 'utf8');
if (useLogo) page = page.replace('<h1 id="brand">MediaMax</h1>', '<h1 id="brand"><img class="logo" src="logo.svg" alt="MediaMax" /></h1>');
page = page.replaceAll('MediaMax', name);
for (const target of ['tizen', 'webos', 'vidaa']) {
  const dir = path.join(dist, target);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), page);
  if (useLogo) fs.copyFileSync(stockLogo, path.join(dir, 'logo.svg'));
  if (target === 'tizen') {
    fs.writeFileSync(path.join(dir, 'config.xml'), fs.readFileSync(path.join(here, 'tizen/config.xml'), 'utf8').replace(/<name>[^<]*<\/name>/, `<name>${name}</name>`));
    png(path.join(dir, 'icon.png'), 512, 512, 0.15, 'icon-512.png');
  } else if (target === 'vidaa') {
    // No vendor package: the folder itself is the app (host it over HTTPS). vidaa-app.json carries the launcher /
    // store metadata; its relative URLs become absolute with --url.
    const info = JSON.parse(fs.readFileSync(path.join(here, 'vidaa/app.json'), 'utf8'));
    delete info._comment;
    info.AppName = info.Title = name;
    info.Description = info.Description.replace('MediaMax', name);
    if (hostedUrl) {
      const base = new URL(hostedUrl.endsWith('/') ? hostedUrl : `${hostedUrl}/`);
      for (const k of ['URL', 'StartCommand', 'IconURL', 'Icon_96', 'Image', 'Thumb', 'Splash']) info[k] = new URL(info[k], base).href;
    }
    fs.writeFileSync(path.join(dir, 'vidaa-app.json'), JSON.stringify(info, null, 2));
    png(path.join(dir, 'icon.png'), 512, 512, 0.15, 'icon-512.png');
    png(path.join(dir, 'icon-130.png'), 130, 130, 0.1, 'icon-130.png');
    png(path.join(dir, 'splash.png'), 1920, 1080, 0.7, 'splash-1920x1080.png');
  } else {
    const info = JSON.parse(fs.readFileSync(path.join(here, 'webos/appinfo.json'), 'utf8'));
    info.title = name;
    fs.writeFileSync(path.join(dir, 'appinfo.json'), JSON.stringify(info, null, 2));
    png(path.join(dir, 'icon.png'), 80, 80, 0.1, 'icon-80.png');
    png(path.join(dir, 'largeIcon.png'), 130, 130, 0.1, 'icon-130.png');
    png(path.join(dir, 'splash.png'), 1920, 1080, 0.7, 'splash-1920x1080.png');
  }
  console.log(`Built ${path.relative(process.cwd(), dir)}`);
}
