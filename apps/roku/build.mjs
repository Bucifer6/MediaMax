#!/usr/bin/env node
// Builds the Vibe Roku channel into apps/roku/dist/Kinora.zip and optionally sideloads it.
//
//   node apps/roku/build.mjs                                  # zip only
//   node apps/roku/build.mjs --images                         # re-render icons / splash from tv/shared/brand first
//   node apps/roku/build.mjs --deploy 192.168.1.50 --password <dev-password> [--user rokudev]
//
// The zip uses the server's dependency-free ZIP writer (server/src/util/zip.ts, loaded with Node's built-in type
// stripping, Node >= 22.18) and falls back to the `zip` CLI on older Node versions.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const brand = path.join(repo, 'tv/shared/brand');
const imagesDir = path.join(here, 'images');
const distDir = path.join(here, 'dist');
const zipPath = path.join(distDir, 'Kinora.zip');

function parseArgs(argv) {
  const out = { images: false, imagesOnly: false, deploy: null, password: process.env.ROKU_DEV_PASSWORD ?? null, user: 'rokudev' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--images') out.images = true;
    else if (a === '--images-only') out.images = out.imagesOnly = true;
    else if (a === '--deploy') out.deploy = argv[++i];
    else if (a === '--password') out.password = argv[++i];
    else if (a === '--user') out.user = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node apps/roku/build.mjs [--images] [--deploy <roku-ip> --password <dev-password> [--user rokudev]]');
      process.exit(0);
    } else {
      console.error(`Unknown option: ${a}`);
      process.exit(2);
    }
  }
  if (out.deploy && !out.password) {
    console.error('--deploy needs --password (the developer password you set when enabling developer mode) or ROKU_DEV_PASSWORD');
    process.exit(2);
  }
  return out;
}

/* ------------------------------------------------------------ images */

const BG = '0x0C0C10';
const ffmpeg = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });

/** Logo + wordmark cut out of the stock splash, letterboxed onto the brand background. */
function focusIcon(out, w, h, artH) {
  ffmpeg(['-i', path.join(brand, 'splash-1920x1080.png'), '-vf',
    `crop=800:510:560:260,scale=${w - 16}:${artH}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${BG}`, '-frames:v', '1', out]);
}

export function renderImages() {
  fs.mkdirSync(imagesDir, { recursive: true });
  // Roku channel store / home screen sizes.
  focusIcon(path.join(imagesDir, 'icon_focus_fhd.png'), 336, 210, 190);
  focusIcon(path.join(imagesDir, 'icon_focus_hd.png'), 290, 218, 196);
  ffmpeg(['-i', path.join(brand, 'splash-1920x1080.png'), '-vf', 'scale=1920:1080:flags=lanczos', '-frames:v', '1', path.join(imagesDir, 'splash_fhd.png')]);
  ffmpeg(['-i', path.join(brand, 'splash-1920x1080.png'), '-vf', 'scale=1280:720:flags=lanczos', '-frames:v', '1', path.join(imagesDir, 'splash_hd.png')]);
  // In-app mark (headers, sign-in).
  ffmpeg(['-i', path.join(brand, 'icon-512.png'), '-vf', 'scale=256:256:flags=lanczos', '-frames:v', '1', path.join(imagesDir, 'logo.png')]);
  // BusySpinner ring: a 3/4 arc in the accent colour on transparency.
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=black@0:s=96x96,format=rgba', '-vf',
    "geq=r=34:g=211:b=238:a='255*between(hypot(X-48,Y-48),34,44)*gt(atan2(Y-48,X-48),-1.9)'", '-frames:v', '1', path.join(imagesDir, 'spinner.png')]);
  console.log(`Rendered images into ${path.relative(repo, imagesDir)}/`);
}

/* ------------------------------------------------------------ zip */

const CHANNEL_ENTRIES = ['manifest', 'source', 'components', 'images'];

function listFiles() {
  const files = [];
  const walk = (rel) => {
    const abs = path.join(here, rel);
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) if (!name.startsWith('.')) walk(path.posix.join(rel, name));
    } else files.push(rel);
  };
  for (const e of CHANNEL_ENTRIES) walk(e);
  return files;
}

async function writeZip(files) {
  fs.mkdirSync(distDir, { recursive: true });
  fs.rmSync(zipPath, { force: true });
  try {
    const { createZip } = await import(pathToFileURL(path.join(repo, 'server/src/util/zip.ts')).href);
    const buf = createZip(files.map((f) => ({ name: f, data: fs.readFileSync(path.join(here, f)) })));
    fs.writeFileSync(zipPath, buf);
    return 'server/src/util/zip.ts';
  } catch (e) {
    // Node without type stripping (< 22.18): use the zip CLI.
    execFileSync('zip', ['-q', '-9', '-r', zipPath, ...files], { cwd: here, stdio: 'inherit' });
    return `zip CLI (${e.code ?? e.message})`;
  }
}

/* ------------------------------------------------------------ deploy (Roku dev installer, HTTP digest) */

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function parseDigest(header) {
  const out = {};
  for (const m of header.replace(/^Digest\s+/i, '').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) out[m[1].toLowerCase()] = m[2] ?? m[3];
  return out;
}

function digestHeader(challenge, { user, password, method, uri }) {
  const c = parseDigest(challenge);
  const nc = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');
  const ha1 = md5(`${user}:${c.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const qop = c.qop ? c.qop.split(',').map((s) => s.trim()).find((q) => q === 'auth') : undefined;
  const response = qop ? md5(`${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${c.nonce}:${ha2}`);
  const parts = [`username="${user}"`, `realm="${c.realm}"`, `nonce="${c.nonce}"`, `uri="${uri}"`, `response="${response}"`];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (c.opaque) parts.push(`opaque="${c.opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

function installForm() {
  const form = new FormData();
  form.append('mysubmit', 'Install');
  form.append('archive', new Blob([fs.readFileSync(zipPath)], { type: 'application/zip' }), 'Kinora.zip');
  return form;
}

async function deploy(ip, user, password) {
  const uri = '/plugin_install';
  const url = `http://${ip}${uri}`;
  // First request only collects the digest challenge.
  const first = await fetch(url, { method: 'POST', body: installForm() });
  let res = first;
  if (first.status === 401) {
    const challenge = first.headers.get('www-authenticate');
    if (!challenge || !/^Digest/i.test(challenge)) throw new Error(`Unexpected auth challenge from ${ip}: ${challenge}`);
    res = await fetch(url, { method: 'POST', body: installForm(), headers: { Authorization: digestHeader(challenge, { user, password, method: 'POST', uri }) } });
  }
  const text = await res.text();
  if (res.status === 401) throw new Error('The Roku rejected the developer password.');
  if (!res.ok) throw new Error(`Install failed: HTTP ${res.status}`);
  // The installer answers with an HTML page; its message is in a Roku.Message JSON blob or a <font> tag.
  const messages = [...text.matchAll(/"text":"([^"]+)"/g)].map((m) => m[1]);
  const font = text.match(/<font color="red">([^<]+)<\/font>/i)?.[1];
  const summary = messages.join(' · ') || font || 'Installed';
  if (/fail|error/i.test(summary) && !/success/i.test(summary)) throw new Error(summary);
  return summary;
}

/* ------------------------------------------------------------ main */

const args = parseArgs(process.argv.slice(2));
const required = ['icon_focus_fhd.png', 'icon_focus_hd.png', 'splash_fhd.png', 'splash_hd.png', 'logo.png', 'spinner.png'];
if (args.images || required.some((f) => !fs.existsSync(path.join(imagesDir, f)))) renderImages();
if (!args.imagesOnly) {
  const files = listFiles();
  const via = await writeZip(files);
  console.log(`Built ${path.relative(repo, zipPath)} (${files.length} files, ${(fs.statSync(zipPath).size / 1024).toFixed(0)} KiB) via ${via}`);
  if (args.deploy) {
    try {
      console.log(`Installing on ${args.deploy}…`);
      console.log(await deploy(args.deploy, args.user, args.password));
    } catch (e) {
      console.error(`Sideload failed: ${e.message}`);
      process.exit(1);
    }
  }
}
