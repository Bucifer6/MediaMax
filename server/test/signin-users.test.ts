// Security: the public sign-in screen never lists users unless an admin opted them in, and only to the home network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { createUser, issueToken } = await import('../src/services/auth.ts');
const { updateSettings } = await import('../src/services/settings.ts');
const { updateBranding, getBranding } = await import('../src/services/branding.ts');
const { buildApp } = await import('../src/app.ts');

const app = await buildApp();
after(() => app.close());

const admin = createUser({ username: 'si-admin', password: 'pass1234', isAdmin: true });
const hidden = createUser({ username: 'si-hidden', password: 'pass1234' });
const kid = createUser({ username: 'si-kid', pin: '1234' });
const atok = issueToken(admin.id, { deviceId: 'si-a', deviceName: 'test', platform: 'web' }).token;
const LAN = '192.168.1.20';
const WAN = '203.0.113.7';

const profiles = async (remoteAddress = LAN) => {
  const r = await app.inject({ method: 'GET', url: '/api/v1/auth/profiles', remoteAddress });
  assert.equal(r.statusCode, 200, r.body);
  return (r.json() as { id: string; username: string }[]).map((p) => p.username);
};
const pinLogin = (userId: string, pin: string, remoteAddress = LAN) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/profile-login', remoteAddress, payload: { userId, pin, deviceId: 'si-d', deviceName: 't', platform: 'web' } });

test('by default nobody is listed: no user names leak to unauthenticated clients', async () => {
  assert.equal(getBranding().features.profilePicker, true, 'picker feature on (the default)');
  assert.deepEqual(await profiles(), []);
  assert.deepEqual(await profiles('127.0.0.1'), []);
  // Nor can a hidden user be entered through the PIN-only picker sign-in.
  assert.equal((await pinLogin(kid.id, '1234')).statusCode, 401);
});

test('only users opted in with "Show on sign-in screen" appear, and only on the home network', async () => {
  let r = await app.inject({ method: 'PATCH', url: `/api/v1/users/${kid.id}`, headers: { authorization: `Bearer ${atok}` }, payload: { showOnSignIn: true } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().showOnSignIn, true);
  assert.deepEqual(await profiles(), ['si-kid']);
  assert.ok(!(await profiles()).includes(hidden.username) && !(await profiles()).includes(admin.username));
  assert.deepEqual(await profiles(WAN), [], 'outside the home network: nothing');
  assert.equal((await pinLogin(kid.id, '1234', WAN)).statusCode, 401, 'picker sign-in refused from outside too');
  r = await pinLogin(kid.id, '1234');
  assert.equal(r.statusCode, 200, r.body);
  // Normal username + password sign-in is unaffected for hidden users, from anywhere.
  r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: WAN, payload: { username: 'si-hidden', password: 'pass1234', deviceId: 'si-h', deviceName: 't', platform: 'web' } });
  assert.equal(r.statusCode, 200, r.body);
});

test('server settings: home-network-only can be lifted; the master switch and the picker feature hide everyone', async () => {
  updateSettings({ signInScreen: { showUsers: true, homeNetworkOnly: false } });
  assert.deepEqual(await profiles(WAN), ['si-kid']);
  updateSettings({ signInScreen: { showUsers: false, homeNetworkOnly: false } });
  assert.deepEqual(await profiles(), []);
  assert.equal((await pinLogin(kid.id, '1234')).statusCode, 401);
  updateSettings({ signInScreen: { showUsers: true, homeNetworkOnly: true } });
  updateBranding({ features: { ...getBranding().features, profilePicker: false } });
  assert.deepEqual(await profiles(), []);
  updateBranding({ features: { ...getBranding().features, profilePicker: true } });
  assert.deepEqual(await profiles(), ['si-kid']);
});

test('a non-admin cannot opt themselves in', async () => {
  const tok = issueToken(hidden.id, { deviceId: 'si-x', deviceName: 'test', platform: 'web' }).token;
  const r = await app.inject({ method: 'PATCH', url: `/api/v1/users/${hidden.id}`, headers: { authorization: `Bearer ${tok}` }, payload: { showOnSignIn: true } });
  assert.equal(r.statusCode, 403);
  await app.inject({ method: 'PATCH', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${tok}` }, payload: { showOnSignIn: true } });
  assert.ok(!(await profiles()).includes('si-hidden'));
});
