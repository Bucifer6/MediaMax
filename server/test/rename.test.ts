/**
 * The MediaMax -> Kinora -> Vibe renames keep old names working: VIBE_* and KINORA_* environment variables override
 * their MEDIAMAX_* twins (all work, the newest wins), a database still named mediamax.db is renamed to vibe.db, X-Kinora-* and X-MediaMax-* request headers are both accepted, the former stock server
 * names show as "Vibe", standalone installs keep an existing MediaMax data folder, and both app URL schemes are valid
 * sign-in redirects.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { applyEnvAliases, envVar } = await import('../src/env.ts');
const { pickDataDir, migrateDbFile } = await import('../src/config.ts');
const { DatabaseSync } = await import('node:sqlite');
const { clientHeader, deviceFromRequest } = await import('../src/http.ts');
const { productName, PRODUCT_NAME } = await import('../src/util/product.ts');
const { validateRedirect } = await import('../src/services/oidc.ts');
const { createUser, authenticate } = await import('../src/services/auth.ts');
const branding = await import('../src/services/branding.ts');
const { getKv, setKv } = await import('../src/services/settings.ts');
const { buildApp } = await import('../src/app.ts');

const app = await buildApp();
after(() => app.close());

test('KINORA_* overrides MEDIAMAX_*; either alone works', () => {
  const env: NodeJS.ProcessEnv = { MEDIAMAX_PORT: '9000', KINORA_PORT: '9100', MEDIAMAX_DATA: '/old', KINORA_HWACCEL: 'vaapi', KINORA_: 'ignored', OTHER: 'x' };
  applyEnvAliases(env);
  assert.equal(env.MEDIAMAX_PORT, '9100', 'new name wins when both are set');
  assert.equal(env.MEDIAMAX_DATA, '/old', 'old name alone still works');
  assert.equal(env.MEDIAMAX_HWACCEL, 'vaapi', 'new name alone reaches code that reads the old name');
  assert.equal(env.MEDIAMAX_, undefined, 'a bare prefix is not an alias');
  assert.equal(env.OTHER, 'x');
  const all: NodeJS.ProcessEnv = { MEDIAMAX_PORT: '9000', KINORA_PORT: '9100', VIBE_PORT: '9200', VIBE_HWACCEL: 'qsv' };
  applyEnvAliases(all);
  assert.equal(all.MEDIAMAX_PORT, '9200', 'VIBE_ wins over KINORA_ and MEDIAMAX_');
  assert.equal(all.MEDIAMAX_HWACCEL, 'qsv');
  assert.equal(envVar('PORT', { MEDIAMAX_PORT: '1', KINORA_PORT: '2' }), '2');
  assert.equal(envVar('PORT', { MEDIAMAX_PORT: '1', KINORA_PORT: '2', VIBE_PORT: '3' }), '3');
  assert.equal(envVar('PORT', { VIBE_PORT: '3' }), '3');
  assert.equal(envVar('PORT', { MEDIAMAX_PORT: '1' }), '1');
  assert.equal(envVar('PORT', {}), undefined);
});

test('config picks up KINORA_* at start-up, ahead of MEDIAMAX_*', () => {
  // config.ts imports env.ts first, so code reading the MEDIAMAX_ names sees the KINORA_ values.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinora-env-'));
  const run = (env: Record<string, string>) =>
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', '-e', "const { config } = await import('./src/config.ts'); console.log(JSON.stringify([config.port, config.logLevel, config.dataDir]))"], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
      env: { PATH: process.env.PATH ?? '', HOME: os.tmpdir(), ...env },
      encoding: 'utf8',
    });
  try {
    assert.deepEqual(JSON.parse(run({ KINORA_PORT: '9100', MEDIAMAX_PORT: '9000', KINORA_LOG_LEVEL: 'debug', MEDIAMAX_DATA: dir })), [9100, 'debug', dir]);
    assert.deepEqual(JSON.parse(run({ MEDIAMAX_PORT: '9000', KINORA_DATA: dir })), [9000, 'info', dir]);
    assert.deepEqual(JSON.parse(run({ VIBE_PORT: '9300', KINORA_PORT: '9100', VIBE_DATA: dir })), [9300, 'info', dir]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('standalone data folder: Vibe by default, a folder not yet moved from Kinora or MediaMax is used', () => {
  const has = (...dirs: string[]) => (p: string) => dirs.includes(p);
  const v = path.join('/data', 'vibe');
  const k = path.join('/data', 'kinora');
  const m = path.join('/data', 'mediamax');
  const order = [v, k, m];
  assert.equal(pickDataDir(order, has()), v, 'fresh install');
  assert.equal(pickDataDir(order, has(k)), k, 'Kinora install not moved yet');
  assert.equal(pickDataDir(order, has(m)), m, 'MediaMax install not moved yet');
  assert.equal(pickDataDir(order, has(k, m)), k, 'the newer former name wins');
  assert.equal(pickDataDir(order, has(v, k, m)), v, 'the Vibe folder wins once it exists');
});

test('a database still named mediamax.db is renamed to vibe.db with every committed change', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-db-'));
  try {
    const legacy = path.join(dir, 'mediamax.db');
    // Leave changes in the write-ahead log, as a server that was killed would.
    const d = new DatabaseSync(legacy);
    d.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (v TEXT);');
    d.exec("INSERT INTO t VALUES ('kept')");
    const other = new DatabaseSync(legacy);
    assert.ok(fs.statSync(legacy + '-wal').size > 0, 'the test needs changes still in the WAL');
    // While another connection has it open the WAL cannot be folded in: nothing is renamed.
    assert.equal(migrateDbFile(dir), legacy);
    assert.ok(fs.existsSync(legacy) && !fs.existsSync(path.join(dir, 'vibe.db')));
    other.close();
    d.close();

    const target = migrateDbFile(dir);
    assert.equal(target, path.join(dir, 'vibe.db'));
    assert.ok(!fs.existsSync(legacy) && !fs.existsSync(legacy + '-wal') && !fs.existsSync(legacy + '-shm'));
    const r = new DatabaseSync(target);
    assert.deepEqual(r.prepare('SELECT v FROM t').all().map((x) => x.v), ['kept']);
    r.close();
    // Already renamed: left alone. A fresh folder gets vibe.db.
    assert.equal(migrateDbFile(dir), target);
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-db-'));
    assert.equal(migrateDbFile(fresh), path.join(fresh, 'vibe.db'));
    fs.rmSync(fresh, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('X-Kinora-* and X-MediaMax-* headers are both accepted; the new one wins', () => {
  const req = (headers: Record<string, string | string[]>) => ({ headers }) as never;
  assert.equal(clientHeader(req({ 'x-kinora-device-id': 'new' }), 'device-id'), 'new');
  assert.equal(clientHeader(req({ 'x-mediamax-device-id': 'old' }), 'device-id'), 'old');
  assert.equal(clientHeader(req({ 'x-kinora-device-id': 'new', 'x-mediamax-device-id': 'old' }), 'device-id'), 'new');
  assert.equal(clientHeader(req({ 'x-kinora-device-id': '', 'x-mediamax-device-id': 'old' }), 'device-id'), 'old');
  assert.equal(clientHeader(req({}), 'device-id'), undefined);
  const d = deviceFromRequest(req({ 'x-mediamax-platform': 'ios', 'x-kinora-device-name': 'Phone', 'x-mediamax-version': '2.0', 'user-agent': '' }));
  assert.deepEqual(d, { deviceId: undefined, deviceName: 'Phone', platform: 'ios', appVersion: '2.0' });
});

test('sign-in records the device from either header family', async () => {
  await createUser({ username: 'renamer', password: 'pass1234' });
  for (const [prefix, id] of [['x-kinora-', 'dev-new'], ['x-mediamax-', 'dev-old']] as const) {
    const r = await app.inject({
      method: 'POST', url: '/api/v1/auth/login', payload: { username: 'renamer', password: 'pass1234' },
      headers: { [`${prefix}device-id`]: id, [`${prefix}device-name`]: `${prefix} TV`, [`${prefix}platform`]: 'androidtv', [`${prefix}version`]: '3.1' },
    });
    assert.equal(r.statusCode, 200, r.body);
    const ctx = authenticate(r.json().token);
    assert.equal(ctx?.device.deviceId, id);
    assert.equal(ctx?.device.platform, 'androidtv');
    assert.equal(ctx?.device.appVersion, '3.1');
    // X-Kinora-Token and X-MediaMax-Token both authenticate.
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { [`${prefix}token`]: r.json().token } });
    assert.equal(me.statusCode, 200, `${prefix}token: ${me.body}`);
  }
});

test('the stock name is Vibe; a server still named Kinora or MediaMax shows Vibe, a renamed one keeps its name', () => {
  assert.equal(PRODUCT_NAME, 'Vibe');
  assert.equal(productName('MediaMax'), 'Vibe');
  assert.equal(productName('Kinora'), 'Vibe');
  assert.equal(productName(''), 'Vibe');
  assert.equal(productName('Acme Cinema'), 'Acme Cinema');
  assert.equal(branding.getBranding().serverName, 'Vibe');
  const before = getKv<Record<string, unknown>>('branding', {});
  setKv('branding', { ...before, serverName: 'MediaMax' });
  assert.equal(branding.getBranding().serverName, 'Vibe');
  setKv('branding', { ...before, serverName: 'Kinora' });
  assert.equal(branding.getBranding().serverName, 'Vibe');
  assert.equal(branding.updateBranding({ serverName: 'Acme Cinema' }).serverName, 'Acme Cinema');
  assert.equal(branding.getBranding().serverName, 'Acme Cinema');
});

test('kinora:// and the legacy mediamax:// are both valid app sign-in redirects', () => {
  assert.equal(validateRedirect('kinora://oidc', 'https://media.example.com'), 'kinora://oidc');
  assert.equal(validateRedirect('mediamax://oidc', 'https://media.example.com'), 'mediamax://oidc');
  assert.throws(() => validateRedirect('evil://oidc', 'https://media.example.com'));
});
