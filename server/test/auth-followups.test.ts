/**
 * Review follow-ups: TOTP replay, one PIN lockout for sign-in screen + profile switching, admin user edits validated
 * like creation, IPTV detail fetches only for users who may see the item, preferences size cap, remote-streaming check
 * on DJ transition previews, Subsonic not revealing 2FA on a wrong password, and API keys kept out of media URLs.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const { db } = await import('../src/db.ts');
const auth = await import('../src/services/auth.ts');
const profiles = await import('../src/services/profiles.ts');
const settings = await import('../src/services/settings.ts');
const { totp } = await import('../src/util/totp.ts');
const { buildApp } = await import('../src/app.ts');

const app = await buildApp();
after(() => app.close());

const admin = await auth.createUser({ username: 'admin', password: 'pass1234', isAdmin: true });
const adminTok = auth.issueToken(admin.id, { deviceId: 'adm' }).token;
const DEV = { deviceId: 'd1', deviceName: 'Test', platform: 'web' } as const;
const call = (token: string, method: string, url: string, payload?: unknown, extra: Record<string, unknown> = {}) =>
  app.inject({ method: method as any, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload: payload as any } : {}), ...extra });

async function enable2fa(userId: string) {
  const { secret } = auth.totpSetup(userId);
  await auth.totpEnable(userId, totp(secret)); // consumes the current step
  return secret;
}

test('TOTP: a code is accepted once; it and earlier steps are rejected afterwards (login, profile login, disable)', async () => {
  await auth.createUser({ username: 'tina', password: 'pass1234' });
  const id = db.get('SELECT id FROM users WHERE username = ?', 'tina')!.id;
  const secret = await enable2fa(id);
  const now = totp(secret);
  const next = totp(secret, Date.now() + 30000);
  // The enabling code can't be replayed to sign in.
  await assert.rejects(auth.login('tina', 'pass1234', DEV, undefined, now), (e: any) => e.code === 'totp_invalid');
  auth._resetSignInLockouts();
  assert.ok((await auth.login('tina', 'pass1234', DEV, undefined, next)).token);
  await assert.rejects(auth.login('tina', 'pass1234', DEV, undefined, next), (e: any) => e.code === 'totp_invalid');
  auth._resetSignInLockouts();
  // Disabling with an already-used code fails too.
  assert.throws(() => auth.totpDisable(id, next), /not valid/);
  assert.equal(auth.getUser(id).totpEnabled, true);
});

test('TOTP: disabling consumes the code', async () => {
  await auth.createUser({ username: 'tom', password: 'pass1234' });
  const id = db.get('SELECT id FROM users WHERE username = ?', 'tom')!.id;
  const secret = await enable2fa(id);
  const next = totp(secret, Date.now() + 30000);
  auth.totpDisable(id, next);
  assert.equal(auth.getUser(id).totpEnabled, false);
});

test('PIN lockout: sign-in screen and profile switching share one budget; a PIN change clears it', async () => {
  auth._resetSignInLockouts();
  settings.updateSettings({ signInScreen: { showUsers: true, homeNetworkOnly: false } } as any);
  const owner = await auth.createUser({ username: 'pam', password: 'pass1234', pin: '1111', showOnSignIn: true });
  const kid = await profiles.createProfile(owner, owner.id, { displayName: 'Kid' });
  const kidCtx = () => auth.authenticate(auth.issueToken(kid.id, { deviceId: 'kid-dev' }).token)!;
  for (let i = 0; i < 3; i++) await assert.rejects(auth.profileLogin(owner.id, '9999', DEV, '127.0.0.1'), /Incorrect PIN/);
  for (let i = 0; i < 2; i++) await assert.rejects(profiles.switchProfile(kidCtx(), owner.id, '9999', '127.0.0.1'), (e: any) => e.code === 'pin_invalid');
  // 5 wrong PINs in total: both paths are locked now, even with the right PIN.
  await assert.rejects(profiles.switchProfile(kidCtx(), owner.id, '1111', '127.0.0.1'), (e: any) => e.statusCode === 429 && e.code === 'pin_locked');
  await assert.rejects(auth.profileLogin(owner.id, '1111', DEV, '127.0.0.1'), (e: any) => e.statusCode === 429);
  // The owner sets a new PIN: the lockout ends.
  await auth.updateMe(owner.id, { pin: '2222' });
  assert.ok((await auth.profileLogin(owner.id, '2222', DEV, '127.0.0.1')).token);
  // Admin PIN reset clears it too.
  for (let i = 0; i < 5; i++) await assert.rejects(auth.profileLogin(owner.id, '9999', DEV, '127.0.0.1'));
  await assert.rejects(auth.profileLogin(owner.id, '2222', DEV, '127.0.0.1'), (e: any) => e.statusCode === 429);
  await auth.updateUser(owner.id, { pin: '3333' }, admin.id);
  assert.ok((await auth.profileLogin(owner.id, '3333', DEV, '127.0.0.1')).token);
});

test('admin updateUser: same username/password rules as createUser; admins keep a password', async () => {
  const u = await auth.createUser({ username: 'ursula', password: 'pass1234' });
  let r = await call(adminTok, 'PATCH', `/users/${u.id}`, { password: 'short' });
  assert.equal(r.statusCode, 400, r.body);
  r = await call(adminTok, 'PATCH', `/users/${u.id}`, { username: 'bad/name' });
  assert.equal(r.statusCode, 400, r.body);
  r = await call(adminTok, 'PATCH', `/users/${u.id}`, { username: 'x'.repeat(65) });
  assert.equal(r.statusCode, 400, r.body);
  r = await call(adminTok, 'PATCH', `/users/${admin.id}`, { password: '' });
  assert.equal(r.statusCode, 400, r.body);
  assert.equal(auth.getUser(admin.id).hasPassword, true);
  // Promoting while clearing the password is refused as well.
  r = await call(adminTok, 'PATCH', `/users/${u.id}`, { password: '', isAdmin: true });
  assert.equal(r.statusCode, 400, r.body);
  // Non-admins may still be made passwordless (PIN-only / passwordless sign-in), and valid edits work.
  r = await call(adminTok, 'PATCH', `/users/${u.id}`, { password: '', username: 'ursula.b' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().hasPassword, false);
  assert.equal(r.json().username, 'ursula.b');
});

test('GET /items/:id(/children): no IPTV provider fetch for a user who cannot see the library', async () => {
  let hits = 0;
  const srv = http.createServer((_req, res) => {
    hits++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ info: { plot: 'Fetched' } }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  after(() => srv.close());
  const now = new Date().toISOString();
  db.insert('live_sources', { id: 'src1', name: 'P', type: 'xtream', url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, username: 'a', password: 'b', created_at: now });
  db.insert('libraries', { id: 'lib-iptv', name: 'IPTV Movies', type: 'iptv-movies', paths: '[]', source_id: 'src1', created_at: now });
  db.insert('libraries', { id: 'lib-other', name: 'Other', type: 'movies', paths: '[]', created_at: now });
  db.insert('items', { id: 'iptv-m1', library_id: 'lib-iptv', type: 'movie', title: 'Film', sort_title: 'film', remote_ref: '42', added_at: now, updated_at: now });
  const outsider = await auth.createUser({ username: 'otto', password: 'pass1234', libraryIds: ['lib-other'] });
  const tok = auth.issueToken(outsider.id, { deviceId: 'o' }).token;
  assert.equal((await call(tok, 'GET', '/items/iptv-m1')).statusCode, 404);
  assert.equal((await call(tok, 'GET', '/items/iptv-m1/children')).statusCode, 404);
  assert.equal(hits, 0, 'no provider request for an item the user cannot see');
  // An administrator still triggers the lazy fetch.
  const r = await call(adminTok, 'GET', '/items/iptv-m1');
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(hits, 1);
});

test('PATCH /auth/me: preferences over 64 KB are refused', async () => {
  const u = await auth.createUser({ username: 'pete', password: 'pass1234' });
  const tok = auth.issueToken(u.id, { deviceId: 'p' }).token;
  let r = await call(tok, 'PATCH', '/auth/me', { preferences: { junk: 'x'.repeat(70 * 1024) } });
  assert.equal(r.statusCode, 400, r.body);
  assert.ok(String(db.get('SELECT preferences FROM users WHERE id = ?', u.id)!.preferences).length < 1024);
  r = await call(tok, 'PATCH', '/auth/me', { preferences: { autoplayNext: false } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().preferences.autoplayNext, false);
  // Bodies far over the cap are cut off before parsing.
  r = await call(tok, 'PATCH', '/auth/me', { preferences: { junk: 'x'.repeat(2 * 1024 * 1024) } });
  assert.equal(r.statusCode, 413);
});

test('DJ transition preview: home-network-only accounts get no rendered audio remotely', async () => {
  const u = await auth.createUser({ username: 'remy', password: 'pass1234', allowRemote: false });
  const tok = auth.issueToken(u.id, { deviceId: 'r' }).token;
  const r = await call(tok, 'GET', '/dj/transition-preview?from=a&to=b', undefined, { remoteAddress: '8.8.8.8' });
  assert.equal(r.statusCode, 403, r.body);
  assert.equal(r.json().error, 'remote_not_allowed');
  // On the home network the request gets past the check (and fails on the unknown tracks instead).
  const local = await call(tok, 'GET', '/dj/transition-preview?from=a&to=b', undefined, { remoteAddress: '192.168.1.5' });
  assert.equal(local.statusCode, 404, local.body);
});

test('Subsonic: a wrong password never reveals that the account uses two-factor', async () => {
  const u = await auth.createUser({ username: 'sid', password: 'pass1234' });
  await enable2fa(u.id);
  const q = (p: string) => app.inject({ method: 'GET', url: `/rest/ping.view?u=sid&p=${p}&v=1.16.1&c=test&f=json` });
  const wrong = (await q('nope1234')).json()['subsonic-response'];
  assert.equal(wrong.status, 'failed');
  assert.equal(wrong.error.message, 'Wrong username or password');
  const right = (await q('pass1234')).json()['subsonic-response'];
  assert.equal(right.status, 'failed');
  assert.match(right.error.message, /two-factor/);
});

test('API keys: media URLs carry a signed, expiring token, never the key itself', async () => {
  const u = await auth.createUser({ username: 'kay', password: 'pass1234' });
  const created = auth.createApiKey(u.id, 'script');
  const ctx = auth.authenticateApiKey(created.key)!;
  assert.ok(ctx.token.startsWith('mmu_'));
  assert.ok(!ctx.token.includes(created.key) && !ctx.token.includes(created.key.slice(4)));
  // The URL token authenticates as the key (e.g. ?token= on HLS / trickplay URLs)...
  let r = await app.inject({ method: 'GET', url: `/api/v1/auth/me?token=${encodeURIComponent(ctx.token)}` });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().id, u.id);
  // ...with the key's limits: no credential actions.
  r = await app.inject({ method: 'GET', url: `/api/v1/auth/api-keys?token=${encodeURIComponent(ctx.token)}` });
  assert.equal(r.statusCode, 403);
  // Tampered or expired tokens fail; deleting the key ends its URL tokens at once.
  assert.equal(auth.authenticate(ctx.token.slice(0, -2) + (ctx.token.endsWith('AA') ? 'BB' : 'AA')), null);
  assert.equal(auth.authenticate(auth.apiUrlToken(created.id, Date.now() - auth.API_URL_TOKEN_TTL_MS - 5000)), null);
  auth.deleteApiKey(u.id, created.id, false);
  r = await app.inject({ method: 'GET', url: `/api/v1/auth/me?token=${encodeURIComponent(ctx.token)}` });
  assert.equal(r.statusCode, 401);
});
