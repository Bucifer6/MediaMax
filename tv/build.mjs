#!/usr/bin/env node
/**
 * Assemble the Samsung Tizen and LG webOS wrapper apps into tv/dist/{tizen,webos}.
 * Both are small "enter your server address" pages that then load the MediaMax web app in TV mode (?tv=1).
 *
 *   node tv/build.mjs [--icon path/to/square.png] [--name "Brand"]
 *
 * Then package and sign with the vendor tools (see tv/README.md):
 *   tizen package -t wgt -s <profile> -- tv/dist/tizen
 *   ares-package tv/dist/webos
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const icon = path.resolve(opt('--icon', path.join(here, '../apps/mobile/assets/icon.png')));
const name = opt('--name', 'MediaMax');
const dist = path.join(here, 'dist');

function png(out, w, h, pad = 0) {
  // ffmpeg is already a MediaMax dependency; letterbox the square icon onto the brand background.
  const inner = Math.round(Math.min(w, h) * (1 - pad));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', icon, '-vf', `scale=${inner}:${inner}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x0b0d12`, '-frames:v', '1', out]);
}

const page = fs.readFileSync(path.join(here, 'shared/index.html'), 'utf8').replaceAll('MediaMax', name);
for (const target of ['tizen', 'webos']) {
  const dir = path.join(dist, target);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), page);
  if (target === 'tizen') {
    fs.writeFileSync(path.join(dir, 'config.xml'), fs.readFileSync(path.join(here, 'tizen/config.xml'), 'utf8').replace(/<name>[^<]*<\/name>/, `<name>${name}</name>`));
    png(path.join(dir, 'icon.png'), 512, 512, 0.15);
  } else {
    const info = JSON.parse(fs.readFileSync(path.join(here, 'webos/appinfo.json'), 'utf8'));
    info.title = name;
    fs.writeFileSync(path.join(dir, 'appinfo.json'), JSON.stringify(info, null, 2));
    png(path.join(dir, 'icon.png'), 80, 80, 0.1);
    png(path.join(dir, 'largeIcon.png'), 130, 130, 0.1);
    png(path.join(dir, 'splash.png'), 1920, 1080, 0.7);
  }
  console.log(`Built ${path.relative(process.cwd(), dir)}`);
}
