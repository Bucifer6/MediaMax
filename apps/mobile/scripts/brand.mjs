#!/usr/bin/env node
/**
 * Produce a white-label brand folder from a running MediaMax server.
 *
 *   npm run brand -- https://media.example.com acme [--bundle-id com.acme.media] [--lock]
 *
 * Fetches /api/v1/branding and writes:
 *   branding/<brand>/brand.json   app name, bundle ids, splash colour, server url
 *   branding/<brand>/icon.png     from Branding.appIconUrl (or logoUrl)
 *   branding/<brand>/splash.png   from Branding.splash.logoUrl (or logoUrl)
 *
 * Then build with:  MEDIAMAX_BRAND=acme eas build --profile ios   (or android/tvos/androidtv)
 *
 * Native icons need a square 1024x1024 PNG with no transparency for iOS; Expo
 * prebuild resizes it for every density. TV banner / Apple TV layered images
 * have exact size requirements, so drop them in by hand (see README).
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
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

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mediamax';
const brand = brandArg ?? slugify(branding.serverName);
const dir = path.join(root, 'branding', brand);
mkdirSync(dir, { recursive: true });

const theme = branding.themes.find((t) => t.id === branding.defaultThemeId) ?? branding.themes[0];
const idPart = brand.replace(/[^a-z0-9]/g, '');
const bundleId = flag('--bundle-id') ?? `tv.mediamax.${idPart}`;

const existing = existsSync(path.join(dir, 'brand.json')) ? JSON.parse(readFileSync(path.join(dir, 'brand.json'), 'utf8')) : {};
const brandJson = {
  ...existing,
  appName: branding.serverName,
  slug: `mediamax-${idPart}`,
  scheme: `mediamax-${idPart}`,
  bundleId,
  androidPackage: flag('--android-package') ?? bundleId,
  serverUrl: server,
  lockServer: args.includes('--lock'),
  splashBackgroundColor: branding.splash?.backgroundColor ?? theme?.colors.background ?? '#0B0B12',
  primaryColor: theme?.colors.primary ?? '#7C5CFF',
  brandingRevision: branding.revision,
};
writeFileSync(path.join(dir, 'brand.json'), JSON.stringify(brandJson, null, 2) + '\n');

async function download(url, file) {
  if (!url) return false;
  const abs = /^https?:/.test(url) ? url : `${server}${url}`;
  const r = await fetch(abs);
  if (!r.ok) {
    console.warn(`  ! could not download ${abs}: ${r.status}`);
    return false;
  }
  writeFileSync(path.join(dir, file), Buffer.from(await r.arrayBuffer()));
  console.log(`  + ${file}`);
  return true;
}

console.log(`Brand "${brand}" -> ${path.relative(process.cwd(), dir)}`);
await download(branding.appIconUrl ?? branding.logoUrl, 'icon.png');
await download(branding.splash?.logoUrl ?? branding.logoUrl, 'splash.png');
console.log(`\nNext: MEDIAMAX_BRAND=${brand} npx expo prebuild --clean   (or eas build --profile ios|android|tvos|androidtv)`);
console.log('Icons must be PNG. If the server serves another format, convert it to a 1024x1024 PNG first.');
