/**
 * Account profiles: CRUD + limits, switching (PIN + lockout), profile sessions locked out of admin / account security,
 * per-profile isolation, kids rating filter, shared stream limit, request permission inheritance and quotas,
 * owner deletion cascade, and existing users after the migration.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthResponse, User } from '@mediamax/shared';

const { db } = await import('../src/db.ts');
const settings = await import('../src/services/settings.ts');
const auth = await import('../src/services/auth.ts');
const profiles = await import('../src/services/profiles.ts');
const items = await import('../src/services/items.ts');
const perms = await import('../src/services/requestPerms.ts');
const playback = await import('../src/services/playback.ts');
const { buildApp } = await import('../src/app.ts');

const now = new Date().toISOString();
// An account that existed before profiles: inserted the way old servers stored users (no profile columns set).
db.insert('users', { id: 'legacy', username: 'legacy', display_name: 'Legacy', password_hash: auth.hashSecret('pass1234'), is_admin: 0, preferences: '{}', created_at: now });
const admin = auth.createUser({ username: 'admin', password: 'pass1234', isAdmin: true });
const owner = auth.createUser({ username: 'mum', displayName: 'Mum', password: 'pass1234', pin: '1111', maxStreams: 2 });

db.insert('libraries', { id: 'lib-m', name: 'Movies', type: 'movies', paths: '[]', created_at: now });
db.insert('libraries', { id: 'lib-tv', name: 'TV', type: 'shows', paths: '[]', created_at: now });
const item = (id: string, type: string, title: string, rating: string | null, extra: Record<string, unknown> = {}) =>
  db.insert('items', { id, library_id: type === 'movie' ? 'lib-m' : 'lib-tv', type, title, sort_title: title.toLowerCase(), content_rating: rating, added_at: now, updated_at: now, ...extra });
item('m-pg', 'movie', 'Happy Pony', 'PG');
item('m-r', 'movie', 'Pony Massacre', 'R');
item('m-nr', 'movie', 'Pony Unrated', null);
item('s-kids', 'show', 'Pony Club', 'TV-Y7');
item('s-kids-1', 'season', 'Season 1', null, { parent_id: 's-kids', idx: 1 });
item('e-k1', 'episode', 'Pony Ep 1', null, { parent_id: 's-kids-1', grandparent_id: 's-kids', idx: 1, parent_idx: 1 });
item('e-k2', 'episode', 'Pony Ep 2', null, { parent_id: 's-kids-1', grandparent_id: 's-kids', idx: 2, parent_idx: 1 });
item('s-adult', 'show', 'Pony Crimes', 'TV-MA');
item('s-adult-1', 'season', 'Season 1', null, { parent_id: 's-adult', idx: 1 });
item('e-a1', 'episode', 'Crimes Ep 1', null, { parent_id: 's-adult-1', grandparent_id: 's-adult', idx: 1, parent_idx: 1 });
item('e-a2', 'episode', 'Crimes Ep 2', null, { parent_id: 's-adult-1', grandparent_id: 's-adult', idx: 2, parent_idx: 1 });

const app = await buildApp();
after(() => app.close());

const DEV = { deviceId: 'tv-1', deviceName: 'Living room TV', platform: 'androidtv' } as const;
const call = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as any, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload: payload as any } : {}) });
const loginOwner = async (): Promise<AuthResponse> => {
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'mum', password: 'pass1234', ...DEV } });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};

let ownerToken = '';
let dad: string;
let kid: string;

test('migration: existing users are account owners with no profiles and sign in as before', async () => {
  const u = auth.getUser('legacy');
  assert.equal(u.parentUserId, null);
  assert.equal(u.profileCount, 0);
  assert.equal(u.isKids, false);
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'legacy', password: 'pass1234', deviceId: 'x' } });
  assert.equal(r.statusCode, 200);
  const list = (await call(r.json().token, 'GET', '/auth/account/profiles')).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].isOwner, true);
  assert.equal(list[0].current, true);
});

test('profile CRUD, built-in avatars and the per-account limit', async () => {
  ownerToken = (await loginOwner()).token;
  const avatars = (await app.inject({ method: 'GET', url: '/api/v1/avatars' })).json();
  assert.ok(avatars.length >= 8);
  const svg = await app.inject({ method: 'GET', url: avatars[0].url.replace(/^\/api\/v1/, '/api/v1') });
  assert.equal(svg.statusCode, 200);
  assert.match(svg.headers['content-type'] as string, /svg/);

  let r = await call(ownerToken, 'POST', '/profiles', { displayName: 'Dad', avatarId: 'robot', pin: '2222' });
  assert.equal(r.statusCode, 200, r.body);
  dad = r.json().id;
  assert.equal(r.json().avatarId, 'robot');
  assert.equal(r.json().hasPin, true);
  assert.equal(r.json().requestPermissions, null, 'adults inherit the owner\'s request permissions');
  r = await call(ownerToken, 'POST', '/profiles', { displayName: 'Kiddo', isKids: true, avatarId: 'panda' });
  kid = r.json().id;
  assert.equal(r.json().isKids, true);
  assert.equal(r.json().maxContentRating, 'PG');
  assert.equal(r.json().hideUnrated, true);
  assert.equal(r.json().themeId, 'kids');
  assert.equal(r.json().requestPermissions.movie, 'none');

  r = await call(ownerToken, 'PATCH', `/profiles/${dad}`, { displayName: 'Daddy', color: '#123456', language: 'de' });
  assert.equal(r.json().displayName, 'Daddy');
  assert.equal(r.json().language, 'de');
  assert.equal(auth.getUser(dad).preferences.audioLanguage, 'de');
  assert.equal((await call(ownerToken, 'PATCH', `/profiles/${dad}`, { avatarId: 'nope' })).statusCode, 400);
  assert.equal((await call(ownerToken, 'GET', '/profiles')).json().length, 2);
  assert.equal(auth.getUser(owner.id).profileCount, 2);

  // Limit: 3 including the owner.
  settings.updateSettings({ profiles: { ...auth.profileSettings(), maxPerAccount: 3 } });
  r = await call(ownerToken, 'POST', '/profiles', { displayName: 'Third' });
  assert.equal(r.statusCode, 409);
  settings.updateSettings({ profiles: { ...auth.profileSettings(), maxPerAccount: 6 } });
  const extra = (await call(ownerToken, 'POST', '/profiles', { displayName: 'Temp' })).json().id;
  assert.equal((await call(ownerToken, 'DELETE', `/profiles/${extra}`)).statusCode, 200);
  assert.equal(db.get('SELECT 1 FROM users WHERE id = ?', extra), undefined);

  // Other users cannot touch them; admins can.
  const other = auth.createUser({ username: 'other', password: 'pass1234' });
  const otherTok = auth.issueToken(other.id, { deviceId: 'o' }).token;
  assert.equal((await call(otherTok, 'PATCH', `/profiles/${dad}`, { displayName: 'x' })).statusCode, 403);
  const adminTok = auth.issueToken(admin.id, { deviceId: 'a' }).token;
  assert.equal((await call(adminTok, 'GET', `/users/${owner.id}/profiles`)).json().length, 2);
  r = await call(adminTok, 'PATCH', `/profiles/${dad}`, { requestQuotas: { movie: { limit: 1, days: 7 }, show: { limit: 1, days: 7 }, music: { limit: 1, days: 7 }, book: { limit: 1, days: 7 } } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().requestQuotas.movie.limit, 1);
  // Owners cannot set quotas.
  assert.equal((await call(ownerToken, 'PATCH', `/profiles/${dad}`, { requestQuotas: null })).statusCode, 403);
  await call(adminTok, 'PATCH', `/profiles/${dad}`, { requestQuotas: null });
  // Profiles never appear on the server-wide login picker and cannot sign in by username.
  assert.ok(auth.publicProfiles().every((p) => p.id !== dad && p.id !== kid));
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: auth.getUserRow(kid).username, password: '' } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/profile-login', payload: { userId: kid } })).statusCode, 401);
});

let dadToken = '';
let kidToken = '';
test('switching: PIN required when set, wrong PINs lock out, previous session on the device ends', async () => {
  const list = (await call(ownerToken, 'GET', '/auth/account/profiles')).json();
  assert.deepEqual(list.map((p: any) => p.displayName), ['Mum', 'Daddy', 'Kiddo']);
  assert.equal(list[0].isOwner, true);

  let r = await call(ownerToken, 'POST', `/auth/profiles/${dad}/switch`, {});
  assert.equal(r.statusCode, 401);
  assert.equal(r.json().error, 'pin_required');
  for (let i = 0; i < 5; i++) assert.equal((await call(ownerToken, 'POST', `/auth/profiles/${dad}/switch`, { pin: '9999' })).statusCode, 401);
  r = await call(ownerToken, 'POST', `/auth/profiles/${dad}/switch`, { pin: '2222' });
  assert.equal(r.statusCode, 429, 'locked out even with the right PIN');
  profiles._resetProfileLockouts();
  r = await call(ownerToken, 'POST', `/auth/profiles/${dad}/switch`, { pin: '2222' });
  assert.equal(r.statusCode, 200, r.body);
  dadToken = r.json().token;
  assert.equal(r.json().user.id, dad);
  assert.equal(r.json().user.ownerName, 'Mum');
  // The owner's session on this device was replaced by the profile's.
  assert.equal((await call(ownerToken, 'GET', '/auth/me')).statusCode, 401);
  assert.equal((await call(dadToken, 'GET', '/auth/me')).json().id, dad);

  // Profile → kids profile (no PIN) works from a profile session.
  r = await call(dadToken, 'POST', `/auth/profiles/${kid}/switch`, {});
  assert.equal(r.statusCode, 200);
  kidToken = r.json().token;
  // Leaving the kids profile for the owner needs the owner's PIN.
  assert.equal((await call(kidToken, 'POST', `/auth/profiles/${owner.id}/switch`, {})).statusCode, 401);
  r = await call(kidToken, 'POST', `/auth/profiles/${owner.id}/switch`, { pin: '1111' });
  assert.equal(r.statusCode, 200);
  ownerToken = r.json().token;
  assert.equal(r.json().user.id, owner.id);
  // Another account's profile can't be reached.
  const legacyTok = auth.issueToken('legacy', { deviceId: 'l' }).token;
  assert.equal((await call(legacyTok, 'POST', `/auth/profiles/${kid}/switch`, {})).statusCode, 404);
  // Activity shows "Owner › Profile".
  assert.ok(db.get("SELECT 1 FROM activity WHERE user_name = 'Mum › Kiddo'"));
});

test('profile sessions cannot reach admin, account security or profile management (even for an admin owner)', async () => {
  const adminDev = { deviceId: 'admin-pc' };
  const aTok = auth.issueToken(admin.id, adminDev).token;
  const p = (await call(aTok, 'POST', '/profiles', { displayName: 'Admin junior' })).json();
  const pTok = (await call(aTok, 'POST', `/auth/profiles/${p.id}/switch`, {})).json().token;
  const me = (await call(pTok, 'GET', '/auth/me')).json();
  assert.equal(me.isAdmin, false);
  for (const [method, url, body] of [
    ['GET', '/users'], ['GET', '/settings'], ['GET', '/system/logs'], ['POST', '/users', { username: 'x', password: 'pass1234' }],
    ['GET', '/auth/api-keys'], ['POST', '/auth/api-keys', { name: 'k' }], ['POST', '/auth/me/2fa/setup'],
    ['PATCH', '/auth/me', { password: 'newpass12', currentPassword: '' }], ['PATCH', '/auth/me', { pin: '1234' }],
    ['GET', '/profiles'], ['POST', '/profiles', { displayName: 'Sneaky' }], ['PATCH', `/profiles/${p.id}`, { pin: '' }],
    ['DELETE', `/profiles/${p.id}`], ['POST', '/auth/link/approve', { code: 'ABCD' }],
  ] as [string, string, unknown?][]) {
    const r = await call(pTok, method, url, body ?? (method === 'GET' || method === 'DELETE' ? undefined : {}));
    assert.ok(r.statusCode === 403, `${method} ${url} → ${r.statusCode}`);
  }
  // Preferences (subtitle/audio/theme) are still the profile's own to change.
  const r = await call(pTok, 'PATCH', '/auth/me', { preferences: { subtitleMode: 'always' }, avatarId: 'owl' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().preferences.subtitleMode, 'always');
  assert.equal(auth.getUser(admin.id).preferences.subtitleMode, 'auto');
  // Signing out of the profile signs the device out of the account.
  await call(pTok, 'POST', '/auth/logout', {});
  assert.equal(db.get('SELECT COUNT(*) n FROM devices WHERE device_id = ?', 'admin-pc')!.n, 0);
});

test('watch progress, My List and history are per profile', () => {
  const mum = auth.getUser(owner.id);
  const daddy = auth.getUser(dad);
  items.reportProgress(daddy, 'm-r', 600000, 6000000, 'paused');
  items.setWatchlist(daddy, 'm-pg', true);
  items.setRating(daddy, 'm-pg', 9);
  assert.deepEqual(items.continueWatching(daddy).map((i) => i.id), ['m-r']);
  assert.deepEqual(items.continueWatching(mum), []);
  assert.deepEqual(items.listWatchlist(daddy).items.map((i) => i.id), ['m-pg']);
  assert.equal(items.listWatchlist(mum).total, 0);
  assert.equal(items.getItem(mum, 'm-pg').userData?.rating ?? null, null);
  items.setPlayed(daddy, 'e-a1', true);
  assert.deepEqual(items.nextUp(daddy).map((i) => i.id), ['e-a2']);
  assert.deepEqual(items.nextUp(mum), []);
});

test('kids profile: rating limit applies to browse, search, next up and item access; unrated hidden', () => {
  const k = auth.getUser(kid);
  assert.equal(k.maxContentRating, 'PG');
  assert.equal(k.allowLiveTv, false, 'kids profiles have no Live TV unless the admin allows it');
  const movies = items.queryItems(k, { libraryId: 'lib-m', type: 'movie' } as any).items.map((i) => i.id).sort();
  assert.deepEqual(movies, ['m-pg']);
  const found = items.searchItems(k, 'Pony').map((i) => i.id);
  assert.ok(found.includes('m-pg') && found.includes('s-kids'));
  assert.ok(!found.includes('m-r') && !found.includes('m-nr') && !found.includes('s-adult') && !found.includes('e-a1'));
  assert.throws(() => items.getItem(k, 'm-r'), /not found/i);
  // Next up: an adult show the kid somehow played is not offered; the kids show is.
  items.setPlayed(k, 'e-k1', true);
  db.run("INSERT OR REPLACE INTO user_data (user_id, item_id, played, play_count, position_ms, favorite, last_played_at) VALUES (?, 'e-a1', 1, 1, 0, 0, ?)", kid, now);
  assert.deepEqual(items.nextUp(k).map((i) => i.id), ['e-k2']);
  // The owner's own limit still caps a profile: owner PG-13 + profile R → PG-13.
  auth.updateUser(owner.id, { maxContentRating: 'PG-13' }, admin.id);
  assert.equal(auth.getUser(dad).maxContentRating, 'PG-13');
  auth.updateUser(owner.id, { maxContentRating: null }, admin.id);
  assert.equal(auth.getUser(dad).maxContentRating, null);
  settings.updateSettings({ profiles: { ...auth.profileSettings(), kidsLiveTv: true } });
  assert.equal(auth.getUser(kid).allowLiveTv, true);
  settings.updateSettings({ profiles: { ...auth.profileSettings(), kidsLiveTv: false } });
  // Library subset: only the owner's libraries, intersected.
  auth.updateUser(owner.id, { libraryIds: ['lib-m'] }, admin.id);
  profiles.updateProfile(auth.getUser(owner.id), dad, { libraryIds: ['lib-m', 'lib-tv'] });
  assert.deepEqual(profiles.getProfile(auth.getUser(owner.id), dad).libraryIds, ['lib-m']);
  auth.updateUser(owner.id, { libraryIds: null }, admin.id);
});

test('the concurrent stream limit is shared by the owner and its profiles', () => {
  const ctxOf = (u: User, deviceRowId: string) => ({ user: auth.getUser(u.id), deviceRowId, token: 't', device: { deviceId: deviceRowId, deviceName: deviceRowId, platform: 'web' as const } });
  const base = { itemId: null, channelId: null, mediaId: null, method: 'directplay' as const, job: null, title: 'x', subtitle: null, posterUrl: null, durationMs: null, remoteAddr: null };
  const a = playback.registerSession({ ...base, ctx: ctxOf(owner, 'd1') });
  const b = playback.registerSession({ ...base, ctx: ctxOf(auth.getUser(dad), 'd2') });
  assert.equal(auth.getUser(kid).maxStreams, 2);
  assert.throws(() => playback.registerSession({ ...base, ctx: ctxOf(auth.getUser(kid), 'd3') }), /limit 2/);
  assert.ok(playback.listSessions().some((s) => s.userName === 'Mum › Daddy'));
  playback.stopSession(b.id, 'test', false);
  const c = playback.registerSession({ ...base, ctx: ctxOf(auth.getUser(kid), 'd3') });
  playback.stopSession(a.id, 'test', false);
  playback.stopSession(c.id, 'test', false);
});

test('request permissions: adults inherit the owner, kids get none, owners can only lower; quota is shared', async () => {
  auth.updateUser(owner.id, { requestPermissions: { movie: 'auto', show: 'request', movie4k: 'none' } }, admin.id);
  const daddy = auth.getUser(dad);
  assert.equal(perms.effectivePermissions(daddy).movie, 'auto');
  assert.equal(perms.effectivePermissions(daddy).manageRequests, false);
  assert.equal(perms.effectivePermissions(auth.getUser(kid)).movie, 'none');
  assert.equal(perms.requestLevel(auth.getUser(kid), 'movie'), 'none');
  // Owner can't give more than they have.
  const mum = auth.getUser(owner.id);
  const p = profiles.updateProfile(mum, dad, { requestPermissions: { movie4k: 'auto', show: 'auto', movie: 'request' } });
  assert.equal(p.requestPermissions!.movie4k, 'none');
  assert.equal(p.requestPermissions!.show, 'request');
  assert.equal(p.requestPermissions!.movie, 'request');
  profiles.updateProfile(mum, dad, { requestPermissions: null });
  assert.equal(perms.effectivePermissions(auth.getUser(dad)).movie, 'auto');
  // Admin owner's profiles inherit admin request rights but never manage requests.
  const adminProfile = db.get('SELECT id FROM users WHERE parent_user_id = ?', admin.id)!.id;
  assert.equal(perms.effectivePermissions(auth.getUser(adminProfile)).movie4k, 'auto');
  assert.equal(perms.effectivePermissions(auth.getUser(adminProfile)).manageRequests, false);

  // Shared quota: owner limit 2 movies/week; one by the owner, one by the profile → both see 0 left.
  auth.updateUser(owner.id, { requestQuotas: { movie: { limit: 2, days: 7 }, show: { limit: 5, days: 7 }, music: { limit: 5, days: 7 }, book: { limit: 5, days: 7 } } }, admin.id);
  const ins = (by: string, id: string) => db.insert('media_requests', { id, media_type: 'movie', tmdb_id: id, title: id, status: 'pending', requested_by: by, requested_at: new Date().toISOString() });
  ins(owner.id, 'rq1');
  ins(dad, 'rq2');
  assert.equal(perms.quotaStatus(auth.getUser(dad), 'movie').remaining, 0);
  assert.equal(perms.quotaStatus(auth.getUser(owner.id), 'movie').remaining, 0);
  // With its own (admin-set) quota the profile counts separately.
  profiles.updateProfile(auth.getUser(admin.id), dad, { requestQuotas: { movie: { limit: 3, days: 7 }, show: { limit: 1, days: 7 }, music: { limit: 1, days: 7 }, book: { limit: 1, days: 7 } } });
  assert.equal(perms.quotaStatus(auth.getUser(dad), 'movie').remaining, 2);
  assert.equal(perms.quotaStatus(auth.getUser(owner.id), 'movie').remaining, 1);
});

test('disabling or deleting the owner takes its profiles with it', async () => {
  const dadDev = auth.issueToken(dad, { deviceId: 'phone' }).token;
  assert.equal((await call(dadDev, 'GET', '/auth/me')).statusCode, 200);
  auth.updateUser(owner.id, { disabled: true }, admin.id);
  assert.equal((await call(dadDev, 'GET', '/auth/me')).statusCode, 401);
  auth.updateUser(owner.id, { disabled: false }, admin.id);
  // Profiles can't be made admins or given passwords.
  assert.throws(() => auth.updateUser(dad, { isAdmin: true }, admin.id), /Profiles cannot/);
  items.setWatchlist(auth.getUser(kid), 'm-pg', true);
  auth.deleteUser(owner.id, admin.id);
  assert.equal(db.get('SELECT COUNT(*) n FROM users WHERE parent_user_id = ?', owner.id)!.n, 0);
  assert.equal(db.get('SELECT COUNT(*) n FROM watchlist WHERE user_id = ?', kid)!.n, 0);
  assert.equal(db.get('SELECT COUNT(*) n FROM users WHERE id IN (?, ?)', dad, kid)!.n, 0);
});
