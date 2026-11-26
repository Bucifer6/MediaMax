/**
 * Server updates (Admin → Updates): version order, install detection, the GitHub release check against a mock
 * API, the checksum-verified download, and the admin routes.
 */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

/* A mock GitHub: /repos/<repo>/releases[/latest] and the release files. */
let releases: object[] = [];
let failWith = 0;
const setupBytes = crypto.randomBytes(300_000);
let sums = '';
const server = http.createServer((req, res) => {
  const url = req.url ?? '/';
  if (failWith && url.startsWith('/repos/')) {
    res.writeHead(failWith);
    return res.end('{}');
  }
  if (url === '/repos/test/vibe/releases/latest') {
    const stable = releases.filter((r) => !(r as { prerelease: boolean }).prerelease);
    res.writeHead(stable.length ? 200 : 404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(stable[0] ?? { message: 'Not Found' }));
  }
  if (url.startsWith('/repos/test/vibe/releases?')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(releases));
  }
  if (url.endsWith('/SHA256SUMS.txt')) {
    res.writeHead(200);
    return res.end(sums);
  }
  if (url.endsWith('-setup.exe')) {
    res.writeHead(200, { 'Content-Length': String(setupBytes.length) });
    return res.end(setupBytes);
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.MEDIAMAX_UPDATE_API = base;
process.env.MEDIAMAX_UPDATE_REPO = 'test/vibe';

const updates = await import('../src/services/updates.ts');
const { config } = await import('../src/config.ts');
const { updateSettings } = await import('../src/services/settings.ts');
const { listActivity } = await import('../src/services/activity.ts');
const { buildApp } = await import('../src/app.ts');
const { createUser, issueToken } = await import('../src/services/auth.ts');

const app = await buildApp();
after(async () => {
  await app.close();
  server.close();
});

const release = (version: string, opts: { prerelease?: boolean; assetBase?: string } = {}) => ({
  tag_name: `v${version}`,
  name: `Vibe ${version}`,
  body: `## What's new\n\n- Things in ${version}`,
  html_url: `https://github.com/test/vibe/releases/tag/v${version}`,
  published_at: '2026-11-26T12:00:00Z',
  prerelease: !!opts.prerelease,
  draft: false,
  assets: [
    { name: `vibe-${version}-windows-x64-setup.exe`, browser_download_url: `${opts.assetBase ?? base}/dl/v${version}/vibe-${version}-windows-x64-setup.exe`, size: setupBytes.length },
    { name: 'SHA256SUMS.txt', browser_download_url: `${opts.assetBase ?? base}/dl/v${version}/SHA256SUMS.txt`, size: 100 },
  ],
});
// Always one major version ahead of whatever this build is, so the tests don't need bumping.
const major = Number(config.version.split('.')[0]);
const NEXT = `${major + 1}.0.0`;

beforeEach(() => {
  updates.resetUpdateState();
  failWith = 0;
  releases = [];
  updateSettings({ updates: { autoCheck: true, includePrereleases: false } });
});

test('compareSemver orders releases and pre-releases', () => {
  const c = updates.compareSemver;
  assert.ok(c('1.10.0', '1.9.3') > 0);
  assert.ok(c('v0.5.2', '0.5.1') > 0);
  assert.equal(c('0.5.2', 'v0.5.2'), 0);
  assert.ok(c('1.2.0-beta.1', '1.2.0') < 0, 'a pre-release comes before its release');
  assert.ok(c('1.2.0-beta.2', '1.2.0-beta.1') > 0);
  assert.ok(c('1.2.0-beta.10', '1.2.0-beta.9') > 0, 'numeric pre-release parts compare as numbers');
  assert.ok(c('1.2.0-rc.1', '1.2.0-beta.5') > 0);
  assert.ok(c('1.2.0-beta.1', '1.1.9') > 0);
});

test('detectInstall tells Windows setup, portable, Linux, Docker and source installs apart', () => {
  const none = () => false;
  const d = updates.detectInstall;
  assert.equal(d({ platform: 'win32', sea: true, exeDir: 'C:\\Program Files\\Vibe', exists: (p) => p.endsWith('unins000.exe') }), 'windows-setup');
  assert.equal(d({ platform: 'win32', sea: true, exeDir: 'C:\\vibe', exists: none }), 'windows-portable');
  assert.equal(d({ platform: 'linux', sea: true, exists: none }), 'linux');
  assert.equal(d({ platform: 'linux', sea: true, exists: (p) => p === '/.dockerenv' }), 'docker');
  assert.equal(d({ platform: 'linux', sea: false, exists: none }), 'source');
});

test('checksumFor reads sha256sum lines', () => {
  const h = 'a'.repeat(64);
  const text = `${'b'.repeat(64)}  vibe-1.0.0-linux-x64.tar.gz\r\n${h} *vibe-1.0.0-windows-x64-setup.exe\n`;
  assert.equal(updates.checksumFor(text, 'vibe-1.0.0-windows-x64-setup.exe'), h);
  assert.equal(updates.checksumFor(text, 'missing.exe'), null);
});

test('pickWindowsAssets only accepts GitHub (or the configured API host) download URLs', () => {
  assert.ok(updates.pickWindowsAssets(release(NEXT).assets, NEXT));
  assert.ok(updates.pickWindowsAssets(release(NEXT, { assetBase: 'https://github.com/test/vibe/releases/download' }).assets, NEXT));
  assert.equal(updates.pickWindowsAssets(release(NEXT, { assetBase: 'https://evil.example' }).assets, NEXT), null);
  assert.equal(updates.pickWindowsAssets(release(NEXT).assets, '9.9.9'), null, 'the setup must be for the offered version');
});

test('a newer release is found, logged once, and remembered', async () => {
  releases = [release(NEXT)];
  const s = await updates.checkForUpdates();
  assert.equal(s.updateAvailable, true);
  assert.equal(s.latest?.version, NEXT);
  assert.equal(s.lastError, null);
  assert.ok(s.checkedAt);
  assert.match(s.latest!.notes, /Things in/);
  await updates.checkForUpdates();
  const logged = listActivity(50, 0).items.filter((a) => a.message.includes(`Vibe ${NEXT} is available`));
  assert.equal(logged.length, 1, 'the same version is announced once');
});

test('the current version is up to date, and pre-releases are offered only when asked', async () => {
  releases = [release(`${NEXT}-beta.1`, { prerelease: true }), release(config.version)];
  let s = await updates.checkForUpdates();
  assert.equal(s.updateAvailable, false);
  assert.equal(s.latest?.version, config.version);

  updateSettings({ updates: { autoCheck: true, includePrereleases: true } });
  s = await updates.checkForUpdates();
  assert.equal(s.updateAvailable, true);
  assert.equal(s.latest?.version, `${NEXT}-beta.1`);
  assert.equal(s.latest?.prerelease, true);
});

test('a failed check keeps the error for the admin page', async () => {
  failWith = 503;
  const s = await updates.checkForUpdates();
  assert.match(s.lastError ?? '', /HTTP 503/);
  assert.equal(s.state, 'idle');
});

test('downloadVerified checks the setup program against SHA256SUMS.txt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-upd-'));
  const picked = updates.pickWindowsAssets(release(NEXT).assets, NEXT)!;
  sums = `${crypto.createHash('sha256').update(setupBytes).digest('hex')}  vibe-${NEXT}-windows-x64-setup.exe\n`;
  const file = await updates.downloadVerified(picked, dir);
  assert.deepEqual(fs.readFileSync(file), setupBytes);

  fs.rmSync(file);
  sums = `${'0'.repeat(64)}  vibe-${NEXT}-windows-x64-setup.exe\n`;
  await assert.rejects(updates.downloadVerified(picked, dir), /Checksum mismatch/);
  assert.equal(fs.existsSync(file), false, 'a file that fails the check is deleted');

  sums = 'nothing useful\n';
  await assert.rejects(updates.downloadVerified(picked, dir), /no checksum/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('admin routes: status, check now, and update now refused where the server cannot update itself', async () => {
  const admin = await createUser({ username: 'upd-admin', password: 'pass1234', isAdmin: true });
  const viewer = await createUser({ username: 'upd-viewer', password: 'pass1234' });
  const dev = { deviceId: 'u', deviceName: 'test', platform: 'web' as const };
  const auth = (id: string) => ({ authorization: `Bearer ${issueToken(id, dev).token}` });
  releases = [release(NEXT)];

  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/updates', headers: auth(viewer.id) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/admin/updates/install', headers: auth(viewer.id) })).statusCode, 403);

  const checked = await app.inject({ method: 'POST', url: '/api/v1/admin/updates/check', headers: auth(admin.id) });
  assert.equal(checked.statusCode, 200);
  assert.equal(checked.json().updateAvailable, true);

  const status = (await app.inject({ method: 'GET', url: '/api/v1/admin/updates', headers: auth(admin.id) })).json();
  assert.equal(status.latest.version, NEXT);
  assert.equal(status.canSelfUpdate, false, 'tests run from source');
  assert.match(status.manualSteps, /npm/);

  const install = await app.inject({ method: 'POST', url: '/api/v1/admin/updates/install', headers: auth(admin.id) });
  assert.equal(install.statusCode, 409);
  assert.match(install.json().message, /can't update itself/);
});
