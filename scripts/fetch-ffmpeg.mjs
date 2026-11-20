#!/usr/bin/env node
/**
 * Downloads a static FFmpeg build for a release archive and checks its SHA-256.
 *
 *   node scripts/fetch-ffmpeg.mjs --target linux-x64 --out build/ffmpeg-linux-x64
 *
 * Source: BtbN/FFmpeg-Builds (https://github.com/BtbN/FFmpeg-Builds), the builds FFmpeg's own download page
 * links for Windows and Linux, available for win64, linux64 and linuxarm64. We use the "gpl" variant of a
 * release branch (not master), whose Linux builds link everything statically except glibc (2.28+).
 *
 * Pinning (scripts/ffmpeg.json):
 *   branch   FFmpeg release branch, e.g. "7.1". Selects ffmpeg-n<branch>…-<platform>-gpl-<branch> assets.
 *   tag      BtbN release tag. "latest" follows that branch's newest point release; set an
 *            "autobuild-YYYY-MM-DD-HH-MM" tag to freeze it (BtbN prunes old autobuilds, so a frozen tag
 *            must be bumped before it disappears).
 *   sha256   optional { "<target>": "<hex>" }: when set, the download must match exactly.
 * Every download is also checked against the checksums.sha256 file BtbN publishes with each release.
 * Environment overrides: FFMPEG_BRANCH, FFMPEG_TAG. GITHUB_TOKEN (if set) avoids API rate limits.
 *
 * Output: <out>/ffmpeg(.exe), <out>/ffprobe(.exe), FFMPEG-LICENSE.txt and FFMPEG-SOURCE.txt (exact asset,
 * checksum and where to get the corresponding source, as the GPL asks).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLATFORMS = { 'windows-x64': 'win64', 'linux-x64': 'linux64', 'linux-arm64': 'linuxarm64' };

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function log(msg) {
  process.stdout.write(`[ffmpeg] ${msg}\n`);
}

async function get(url, accept) {
  const headers = { 'User-Agent': 'mediamax-release-build', ...(accept ? { Accept: accept } : {}) };
  if (process.env.GITHUB_TOKEN && url.startsWith('https://api.github.com/')) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(10 * 60000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (attempt >= 3) throw e;
      log(`${e.message}; retrying`);
      await new Promise((r) => setTimeout(r, attempt * 5000));
    }
  }
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (e.name === name) return p;
  }
  return null;
}

async function main() {
  const target = arg('target');
  const out = path.resolve(arg('out') ?? `build/ffmpeg-${target}`);
  const platform = PLATFORMS[target];
  if (!platform) throw new Error(`--target must be one of ${Object.keys(PLATFORMS).join(', ')}`);
  const pin = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'ffmpeg.json'), 'utf8'));
  const branch = process.env.FFMPEG_BRANCH || pin.branch;
  const tag = process.env.FFMPEG_TAG || pin.tag;
  const repo = pin.repo ?? 'BtbN/FFmpeg-Builds';
  if (!/^[0-9]+\.[0-9]+$/.test(branch) || !/^[\w.-]+$/.test(tag)) throw new Error(`Bad branch/tag ${branch} ${tag}`);

  const release = JSON.parse((await get(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, 'application/vnd.github+json')).toString());
  const esc = branch.replace('.', '\\.');
  const pattern = new RegExp(`^ffmpeg-n${esc}[^/]*-${platform}-gpl-${esc}\\.(zip|tar\\.xz)$`);
  const asset = release.assets.find((a) => pattern.test(a.name));
  if (!asset) {
    throw new Error(`No ${platform} gpl ${branch} build in ${repo}@${tag}. Assets: ${release.assets.map((a) => a.name).filter((n) => n.includes(platform)).join(', ') || 'none'}`);
  }
  const sums = release.assets.find((a) => a.name === 'checksums.sha256');
  if (!sums) throw new Error(`${repo}@${tag} publishes no checksums.sha256`);

  log(`downloading ${asset.browser_download_url}`);
  const data = await get(asset.browser_download_url);
  const actual = createHash('sha256').update(data).digest('hex');
  const published = (await get(sums.browser_download_url)).toString().split('\n')
    .map((l) => l.trim().split(/\s+\*?/)).map(([h, n]) => [h, n?.replace(/^\.\//, '')]).find(([, name]) => name === asset.name)?.[0];
  if (!published) throw new Error(`${asset.name} is not listed in checksums.sha256`);
  if (published.toLowerCase() !== actual) throw new Error(`Checksum mismatch for ${asset.name}: published ${published}, got ${actual}`);
  const pinned = pin.sha256?.[target];
  if (pinned && pinned.toLowerCase() !== actual) throw new Error(`Checksum mismatch for ${asset.name}: pinned ${pinned}, got ${actual}`);
  log(`sha256 ${actual} verified against checksums.sha256${pinned ? ' and the pinned value' : ''}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediamax-ffmpeg-'));
  try {
    const file = path.join(tmp, asset.name);
    fs.writeFileSync(file, data);
    const ex = path.join(tmp, 'x');
    fs.mkdirSync(ex);
    // bsdtar (Windows' tar.exe) reads zip and tar.xz; GNU tar on Linux needs unzip for a zip.
    const r = asset.name.endsWith('.zip') && process.platform !== 'win32'
      ? spawnSync('unzip', ['-q', file, '-d', ex], { stdio: 'inherit' })
      : spawnSync('tar', ['-xf', file, '-C', ex], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`Could not extract ${asset.name}`);

    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const ext = platform === 'win64' ? '.exe' : '';
    for (const tool of ['ffmpeg', 'ffprobe']) {
      const src = findFile(ex, tool + ext);
      if (!src) throw new Error(`${tool}${ext} not found in ${asset.name}`);
      fs.copyFileSync(src, path.join(out, tool + ext));
      fs.chmodSync(path.join(out, tool + ext), 0o755);
    }
    const license = findFile(ex, 'LICENSE.txt');
    if (license) fs.copyFileSync(license, path.join(out, 'FFMPEG-LICENSE.txt'));
    const nl = platform === 'win64' ? '\r\n' : '\n';
    fs.writeFileSync(path.join(out, 'FFMPEG-SOURCE.txt'), [
      'The ffmpeg and ffprobe programs in this folder are unmodified builds of FFmpeg (https://ffmpeg.org),',
      'licensed under the GNU GPL version 3 (see FFMPEG-LICENSE.txt). MediaMax runs them as separate programs.',
      '',
      `Build:     ${asset.name}`,
      `From:      ${asset.browser_download_url}`,
      `Release:   https://github.com/${repo}/releases/tag/${tag}`,
      `SHA-256:   ${actual}`,
      '',
      'Corresponding source: FFmpeg https://git.ffmpeg.org/ffmpeg.git (branch release/' + branch + '; the exact',
      'commit is in the build name after "-g"), and the scripts that build it and its libraries:',
      `https://github.com/${repo}`,
      '',
    ].join(nl));
    log(`wrote ${out}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  process.stderr.write(`[ffmpeg] ${e.message}\n`);
  process.exit(1);
});
