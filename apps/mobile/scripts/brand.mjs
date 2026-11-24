#!/usr/bin/env node
/**
 * Produce a white-label brand folder from a running Vibe server.
 *
 *   npm run brand -- https://media.example.com acme [--bundle-id com.acme.media] [--lock]
 *
 * Fetches /api/v1/branding and writes:
 *   branding/<brand>/brand.json   app name, bundle ids, splash colour, server url
 *   branding/<brand>/icon.png     from Branding.appIconUrl (or logoUrl)
 *   branding/<brand>/splash.png   from Branding.splash.logoUrl (or logoUrl)
 *
 * Then build with:  KINORA_BRAND=acme eas build --profile ios   (or android/tvos/androidtv)
 *
 *   branding/<brand>/tv-banner.png  from Branding.tvBannerUrl (Android TV launcher banner, 320x180)
 *   branding/<brand>/appletv-topshelf*.png  from Branding.topShelfUrl (Apple TV top shelf, 1920x720),
 *       plus the 2x / wide sizes and the Apple TV app icons (derived from icon.png)
 *       that @react-native-tvos/config-tv needs before it applies any Apple TV art.
 *
 * Native icons need a square 1024x1024 PNG with no transparency for iOS; Expo
 * prebuild resizes it for every density. TV art is resized with @expo/image-utils
 * (installed with Expo); if that fails (e.g. the server serves WebP/SVG) the
 * original download is kept and the other sizes must be added by hand (see README).
 * Images you put in the brand folder yourself are never overwritten, except the
 * ones this script downloaded or generated on an earlier run.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const VALUE_FLAGS = new Set(['--bundle-id', '--android-package']);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.has(args[i - 1])));
const [serverArg, brandArg] = positional;
if (!serverArg) {
  console.error('usage: npm run brand -- <serverUrl> [brandName] [--bundle-id id] [--android-package id] [--lock]');
  process.exit(1);
}
const server = serverArg.replace(/\/+$/, '');
const res = await fetch(`${server}/api/v1/branding`);
if (!res.ok) throw new Error(`GET /api/v1/branding failed: ${res.status}`);
const branding = await res.json();

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'kinora';
const brand = brandArg ?? slugify(branding.serverName);
const dir = path.join(root, 'branding', brand);
mkdirSync(dir, { recursive: true });

const theme = branding.themes.find((t) => t.id === branding.defaultThemeId) ?? branding.themes[0];
const idPart = brand.replace(/[^a-z0-9]/g, '');
// White-label ids default to the stock id prefix from branding/defaults.json (pass --bundle-id for your own domain).
const DEFAULTS = JSON.parse(readFileSync(path.join(root, 'branding', 'defaults.json'), 'utf8'));
const bundleId = flag('--bundle-id') ?? `${DEFAULTS.idPrefix}.${idPart}`;

const existing = existsSync(path.join(dir, 'brand.json')) ? JSON.parse(readFileSync(path.join(dir, 'brand.json'), 'utf8')) : {};
const brandJson = {
  ...existing,
  appName: branding.serverName,
  slug: `kinora-${idPart}`,
  scheme: `kinora-${idPart}`,
  bundleId,
  androidPackage: flag('--android-package') ?? bundleId,
  serverUrl: server,
  lockServer: args.includes('--lock'),
  splashBackgroundColor: branding.splash?.backgroundColor ?? theme?.colors.background ?? '#0B0B12',
  primaryColor: theme?.colors.primary ?? '#7C5CFF',
  brandingRevision: branding.revision,
};
// Files this script wrote last time (safe to replace); anything else in the folder was added by hand.
const previouslyGenerated = new Set(existing.generatedAssets ?? []);
const generated = new Set();

async function download(url, file) {
  if (!url) return false;
  const abs = /^https?:/.test(url) ? url : `${server}${url}`;
  const r = await fetch(abs);
  if (!r.ok) {
    console.warn(`  ! could not download ${abs}: ${r.status}`);
    return false;
  }
  writeFileSync(path.join(dir, file), Buffer.from(await r.arrayBuffer()));
  generated.add(file);
  console.log(`  + ${file}`);
  return true;
}

/** True when `file` may be (re)written: missing, or written by this script before. */
const writable = (file) => !existsSync(path.join(dir, file)) || previouslyGenerated.has(file);

let imageUtils = null;
try {
  imageUtils = createRequire(path.join(root, 'package.json'))('@expo/image-utils');
} catch {
  imageUtils = null;
}

/** Resize `src` (a file in the brand folder) to an exact PNG size. Returns false if it could not. */
async function resize(src, file, width, height, resizeMode, backgroundColor) {
  if (!imageUtils) return false;
  try {
    const { source } = await imageUtils.generateImageAsync(
      { projectRoot: root, cacheType: `brand-${brand}` },
      { src: path.join(dir, src), width, height, resizeMode, backgroundColor, removeTransparency: !!backgroundColor },
    );
    writeFileSync(path.join(dir, file), source);
    generated.add(file);
    console.log(`  + ${file} (${width}x${height})`);
    return true;
  } catch (e) {
    console.warn(`  ! could not resize ${src} -> ${file}: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

console.log(`Brand "${brand}" -> ${path.relative(process.cwd(), dir)}`);
await download(branding.appIconUrl ?? branding.logoUrl, 'icon.png');
await download(branding.splash?.logoUrl ?? branding.logoUrl, 'splash.png');

const bg = brandJson.splashBackgroundColor;
const manual = [];

// Android TV launcher banner (picked up by app.config.ts as androidTVBanner).
if (branding.tvBannerUrl && writable('tv-banner.png')) {
  if (await download(branding.tvBannerUrl, 'tv-banner.png')) {
    if (!(await resize('tv-banner.png', 'tv-banner.png', 320, 180, 'cover'))) manual.push('tv-banner.png must be a 320x180 PNG');
  }
}

// Apple TV top shelf. config-tv only applies Apple TV art when all seven images exist,
// so the 2x / wide variants and the app icons are derived here.
if (branding.topShelfUrl && writable('appletv-topshelf-1920x720.png')) {
  const shelf = 'appletv-topshelf-1920x720.png';
  if (await download(branding.topShelfUrl, shelf)) {
    const ok = await resize(shelf, shelf, 1920, 720, 'cover', bg);
    const variants = [
      ['appletv-topshelf-3840x1440.png', 3840, 1440, 'cover'],
      ['appletv-topshelfwide-2320x720.png', 2320, 720, 'contain'],
      ['appletv-topshelfwide-4640x1440.png', 4640, 1440, 'contain'],
    ];
    for (const [file, w, h, mode] of variants) {
      if (!writable(file)) continue;
      if (!ok || !(await resize(shelf, file, w, h, mode, bg))) manual.push(`${file} (${w}x${h})`);
    }
    const icons = [
      ['appletv-icon-1280x768.png', 1280, 768],
      ['appletv-icon-400x240.png', 400, 240],
      ['appletv-icon-800x480.png', 800, 480],
    ];
    if (existsSync(path.join(dir, 'icon.png'))) {
      for (const [file, w, h] of icons) {
        if (!writable(file)) continue;
        // Centre the square app icon on the splash colour; a 5:3 Apple TV icon.
        if (!(await resize('icon.png', file, w, h, 'contain', bg))) manual.push(`${file} (${w}x${h})`);
      }
    } else {
      for (const [file, w, h] of icons) if (writable(file)) manual.push(`${file} (${w}x${h})`);
    }
  }
}

brandJson.generatedAssets = [...new Set([...[...previouslyGenerated].filter((f) => existsSync(path.join(dir, f))), ...generated])].sort();
writeFileSync(path.join(dir, 'brand.json'), JSON.stringify(brandJson, null, 2) + '\n');

if (manual.length) {
  console.log('\nAdd these TV images by hand (exact sizes, PNG) to use the server art:');
  for (const m of manual) console.log(`  - ${m}`);
}
console.log(`\nNext: KINORA_BRAND=${brand} npx expo prebuild --clean   (or eas build --profile ios|android|tvos|androidtv)`);
console.log('Icons must be PNG. If the server serves another format, convert it to a 1024x1024 PNG first.');
