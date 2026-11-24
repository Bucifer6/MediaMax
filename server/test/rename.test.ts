/**
 * The MediaMax -> Kinora -> Vibe renames keep old names working: KINORA_* environment variables override their
 * MEDIAMAX_* twins (both work), X-Kinora-* and X-MediaMax-* request headers are both accepted, the former stock server
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
const { pickDataDir } = await import('../src/config.ts');
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
  assert.equal(envVar('PORT', { MEDIAMAX_PORT: '1', KINORA_PORT: '2' }), '2');
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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('standalone data folder: Kinora by default, an existing MediaMax folder is kept', () => {
  const has = (...dirs: string[]) => (p: string) => dirs.includes(p);
  const k = path.join('/data', 'kinora');
  const m = path.join('/data', 'mediamax');
  assert.equal(pickDataDir(k, m, has()), k, 'fresh install');
  assert.equal(pickDataDir(k, m, has(m)), m, 'upgrade from MediaMax');
  assert.equal(pickDataDir(k, m, has(k, m)), k, 'Kinora folder wins once it exists');
  assert.equal(pickDataDir(k, m, has(k)), k);
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
