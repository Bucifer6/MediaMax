/**
 * Movie Match: deck access (libraries, rating caps, kids profiles, "unwatched by everyone"), the match rules
 * (all / majority / super like), join / leave / reconnect, events, "Play on" the host, and endpoint auth.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerEvent } from '@mediamax/shared';

const { db } = await import('../src/db.ts');
const auth = await import('../src/services/auth.ts');
const profiles = await import('../src/services/profiles.ts');
const match = await import('../src/services/decide/match.ts');
const { seededRng } = await import('../src/services/decide/common.ts');
const { events } = await import('../src/services/events.ts');
const { buildApp } = await import('../src/app.ts');

const now = new Date().toISOString();
db.insert('libraries', { id: 'lib-m', name: 'Movies', type: 'movies', paths: '[]', created_at: now });
db.insert('libraries', { id: 'lib-x', name: 'Private', type: 'movies', paths: '[]', created_at: now });
db.insert('libraries', { id: 'lib-tv', name: 'TV', type: 'shows', paths: '[]', created_at: now });
const item = (id: string, lib: string, type: string, rating: string | null, extra: Record<string, unknown> = {}) =>
  db.insert('items', { id, library_id: lib, type, title: id, sort_title: id, content_rating: rating, added_at: now, updated_at: now, genres: '["Comedy"]', ...extra });
for (let i = 0; i < 40; i++) item(`pg-${String(i).padStart(2, '0')}`, 'lib-m', 'movie', 'PG', { community_rating: 5 + (i % 5), duration_ms: (80 + i) * 60000 });
for (let i = 0; i < 10; i++) item(`r-${i}`, 'lib-m', 'movie', 'R', { community_rating: 9 });
item('private-1', 'lib-x', 'movie', 'PG');
item('show-1', 'lib-tv', 'show', 'TV-PG');
item('show-1-s1', 'lib-tv', 'season', null, { parent_id: 'show-1', idx: 1 });
item('show-1-e1', 'lib-tv', 'episode', null, { parent_id: 'show-1-s1', grandparent_id: 'show-1', idx: 1, parent_idx: 1 });

const host = auth.createUser({ username: 'host', password: 'pass1234' });
const friend = auth.createUser({ username: 'friend', password: 'pass1234' });
const third = auth.createUser({ username: 'third', password: 'pass1234' });
const fourth = auth.createUser({ username: 'fourth', password: 'pass1234' });
const limited = auth.createUser({ username: 'limited', password: 'pass1234', libraryIds: ['lib-m'] });
const kidProfile = profiles.createProfile(auth.getUser(host.id), host.id, { displayName: 'Kiddo', isKids: true });
const kid = auth.getUser(kidProfile.id);

const app = await buildApp();
after(() => app.close());

// Fake WebSocket clients capture events.
const inbox = new Map<string, ServerEvent[]>();
const fakeClient = (userId: string, deviceRowId: string, deviceName = 'Device') => {
  inbox.set(deviceRowId, []);
  const c = { id: deviceRowId, userId, isAdmin: false, deviceRowId, deviceName, platform: 'web' as const, remoteState: null, send: (e: ServerEvent) => inbox.get(deviceRowId)!.push(e) };
  events.add(c);
  return c;
};

const S = (o: Partial<import('@mediamax/shared').MatchSettings> = {}) => match.normalizeSettings(o);

test('deck: only items every member may see — libraries, rating caps and kids profiles', () => {
  const all = match.buildDeck([auth.getUser(host.id)], S({ kind: 'movies' }), [], 100, seededRng(1), true);
  assert.ok(all.includes('r-0'));
  assert.ok(all.includes('private-1'));
  const withKid = match.buildDeck([auth.getUser(host.id), kid], S({ kind: 'movies' }), [], 100, seededRng(1), true);
  assert.ok(withKid.length > 0);
  assert.ok(!withKid.some((id) => id.startsWith('r-')), 'R-rated titles never reach a group with a kids profile');
  const withLimited = match.buildDeck([auth.getUser(host.id), limited], S({ kind: 'movies' }), [], 100, seededRng(1), true);
  assert.ok(!withLimited.includes('private-1'), 'a library one member cannot open is left out');
  const shows = match.buildDeck([limited], S({ kind: 'shows' }), [], 100, seededRng(1), true);
  assert.deepEqual(shows, []);
  const both = match.buildDeck([auth.getUser(host.id)], S({ kind: 'both' }), [], 100, seededRng(1), true);
  assert.ok(both.includes('show-1'));
});

test('deck: "unwatched by everyone", disliked titles, filters, size and determinism', () => {
  db.insert('user_data', { user_id: friend.id, item_id: 'pg-00', played: 1 });
  db.insert('user_data', { user_id: third.id, item_id: 'pg-01', not_interested: 1 });
  db.insert('user_data', { user_id: friend.id, item_id: 'show-1-e1', played: 1 });
  const group = [auth.getUser(host.id), auth.getUser(friend.id), auth.getUser(third.id)];
  const deck = match.buildDeck(group, S({ kind: 'both', unwatchedByAll: true }), [], 100, seededRng(2), true);
  assert.ok(!deck.includes('pg-00'), 'watched by one member');
  assert.ok(!deck.includes('show-1'), 'a show one member has started');
  assert.ok(!deck.includes('pg-01'), 'not interested');
  const keep = match.buildDeck(group, S({ kind: 'movies', unwatchedByAll: false }), [], 100, seededRng(2), true);
  assert.ok(keep.includes('pg-00'));
  const short = match.buildDeck(group, S({ kind: 'movies', maxRuntimeMin: 90 }), [], 100, seededRng(2), true);
  assert.ok(short.length > 0 && short.every((id) => (db.get<{ d: number }>('SELECT duration_ms d FROM items WHERE id = ?', id)!.d) <= 90 * 60000));
  const sixty = match.buildDeck(group, S({ unwatchedByAll: false }), [], 20, seededRng(3), true);
  assert.equal(sixty.length, 20);
  assert.equal(new Set(sixty).size, 20, 'no duplicates');
  assert.deepEqual(match.buildDeck(group, S({ unwatchedByAll: false }), [], 20, seededRng(3), true), sixty, 'same seed → same deck');
  const more = match.buildDeck(group, S({ unwatchedByAll: false }), sixty, 20, seededRng(4), true);
  assert.ok(!more.some((id) => sixty.includes(id)), 'extensions never repeat a card');
});

test('match rules: all, majority, super likes', () => {
  assert.equal(match.isMatch('all', 1, ['yes']), false, 'a group of one never matches');
  assert.equal(match.isMatch('all', 2, ['yes']), false);
  assert.equal(match.isMatch('all', 2, ['yes', 'super']), true);
  assert.equal(match.isMatch('all', 3, ['yes', 'yes', 'no']), false);
  assert.equal(match.isMatch('majority', 3, ['yes', 'yes']), true);
  assert.equal(match.isMatch('majority', 4, ['yes', 'yes']), false, 'exactly half is not a majority');
  assert.equal(match.isMatch('majority', 4, ['super', 'yes', 'no', 'no']), true, 'a super like counts twice');
  assert.equal(match.isMatch('majority', 2, ['super']), false, 'needs two different people');
  assert.equal(match.enthusiasm(2, 1, 1), 3);
});

test('session: create, join by code, same deck order, vote → "It\'s a match!" event to everyone, results ranked', async () => {
  match._resetMatches();
  const hostDev = fakeClient(host.id, 'dev-host-tv', 'Living room TV');
  fakeClient(friend.id, 'dev-friend');
  const st = match.createMatch(auth.getUser(host.id), { rowId: 'dev-host-tv', name: 'Living room TV' }, { kind: 'movies', unwatchedByAll: false, seed: 7 } as any);
  assert.match(st.code, /^[A-Z2-9]{6}$/);
  assert.equal(st.hostDeviceOnline, true);
  assert.ok(st.deckSize >= 40);
  const joined = match.joinMatch(auth.getUser(friend.id), st.code.toLowerCase());
  assert.equal(joined.members.length, 2);
  const d1 = match.matchDeck(auth.getUser(host.id), st.id, 0, 10).cards.map((c) => c.id);
  const d2 = match.matchDeck(auth.getUser(friend.id), st.id, 0, 10).cards.map((c) => c.id);
  assert.deepEqual(d1, d2, 'everyone swipes the same deck in the same order');
  const [a, b] = d1;
  assert.equal(match.voteMatch(auth.getUser(host.id), st.id, a, 'yes').match, null);
  assert.ok(inbox.get('dev-friend')!.some((e) => e.type === 'match.state'), 'state is broadcast to members');
  const r = match.voteMatch(auth.getUser(friend.id), st.id, a, 'super');
  assert.equal(r.match?.itemId, a);
  for (const dev of ['dev-host-tv', 'dev-friend']) assert.ok(inbox.get(dev)!.some((e) => e.type === 'match.found' && e.match.itemId === a), `${dev} got the match`);
  match.voteMatch(auth.getUser(host.id), st.id, b, 'yes');
  match.voteMatch(auth.getUser(friend.id), st.id, b, 'yes');
  const res = match.matchResults(auth.getUser(host.id), st.id);
  assert.deepEqual(res.map((x) => x.itemId), [a, b], 'ranked by enthusiasm (super like first)');
  assert.equal(res[0].enthusiasm, 3);
  // Play on the host's TV.
  inbox.get('dev-host-tv')!.length = 0;
  const p = match.playOnHost(auth.getUser(friend.id), st.id, a, 'Phone');
  assert.equal(p.deviceName, 'Living room TV');
  assert.ok(inbox.get('dev-host-tv')!.some((e) => e.type === 'remote.command' && e.action === 'playItem' && e.itemId === a));
  assert.throws(() => match.playOnHost(auth.getUser(friend.id), st.id, d1[5], 'Phone'), /Only a match/);
  events.remove(hostDev);
  assert.throws(() => match.playOnHost(auth.getUser(friend.id), st.id, a, 'Phone'), /not online/);
  // Cursor / reconnect: state comes back with your place.
  assert.equal(match.getMatch(auth.getUser(friend.id), st.id).myCursor, 2);
  assert.throws(() => match.getMatch(auth.getUser(third.id), st.id), /Join the session/);
  assert.throws(() => match.voteMatch(auth.getUser(friend.id), st.id, 'private-nope', 'yes'), /not in this deck/);
});

test('session: a kids profile joining removes cards it may not see, for everyone', () => {
  match._resetMatches();
  const st = match.createMatch(auth.getUser(host.id), null, { kind: 'movies', unwatchedByAll: false } as any);
  const before = match.matchDeck(auth.getUser(host.id), st.id, 0, 60);
  assert.ok(before.cards.some((c) => c.contentRating === 'R') || before.total >= 50);
  const s2 = match.joinMatch(kid, st.code);
  const after = match.matchDeck(auth.getUser(host.id), st.id, 0, 60).cards;
  assert.ok(after.length > 0);
  assert.ok(!after.some((c) => c.contentRating === 'R'));
  assert.equal(s2.members.length, 2);
});

test('session: leave re-evaluates (the rest may now all agree), majority mode, host ends', () => {
  match._resetMatches();
  const st = match.createMatch(auth.getUser(host.id), null, { kind: 'movies', unwatchedByAll: false, rule: 'all' } as any);
  match.joinMatch(auth.getUser(friend.id), st.code);
  match.joinMatch(auth.getUser(third.id), st.code);
  const card = match.matchDeck(auth.getUser(host.id), st.id, 0, 1).cards[0].id;
  match.voteMatch(auth.getUser(host.id), st.id, card, 'yes');
  match.voteMatch(auth.getUser(friend.id), st.id, card, 'yes');
  assert.equal(match.getMatch(auth.getUser(host.id), st.id).matches.length, 0);
  match.leaveMatch(auth.getUser(third.id), st.id);
  assert.deepEqual(match.getMatch(auth.getUser(host.id), st.id).matches.map((m) => m.itemId), [card]);
  // Rejoining (reconnect from another device) keeps you in, no duplicates.
  match.joinMatch(auth.getUser(friend.id), st.code);
  assert.equal(match.getMatch(auth.getUser(host.id), st.id).members.length, 2);
  assert.throws(() => match.endMatch(auth.getUser(friend.id), st.id), /Only the host/);
  match.endMatch(auth.getUser(host.id), st.id);
  assert.throws(() => match.getMatch(auth.getUser(host.id), st.id), /ended/);

  const mj = match.createMatch(auth.getUser(host.id), null, { kind: 'movies', unwatchedByAll: false, rule: 'majority' } as any);
  for (const u of [friend, third, fourth]) match.joinMatch(auth.getUser(u.id), mj.code);
  const c2 = match.matchDeck(auth.getUser(host.id), mj.id, 0, 1).cards[0].id;
  match.voteMatch(auth.getUser(host.id), mj.id, c2, 'super');
  assert.equal(match.voteMatch(auth.getUser(friend.id), mj.id, c2, 'yes').match?.itemId, c2, 'super + yes is a majority of 4');
});

test('session: deck extends as people near the end', () => {
  match._resetMatches();
  const st = match.createMatch(auth.getUser(host.id), null, { kind: 'movies', unwatchedByAll: false } as any);
  const small = match.extendMatch(auth.getUser(host.id), st.id);
  assert.ok(small.deckSize >= st.deckSize);
});

test('endpoints: auth required, join by code, vote, results', async () => {
  match._resetMatches();
  for (const url of ['/api/v1/match', '/api/v1/match/join', '/api/v1/roulette/spin', '/api/v1/marathon']) {
    const r = await app.inject({ method: 'POST', url, payload: {} });
    assert.equal(r.statusCode, 401, url);
  }
  const login = async (username: string) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: 'pass1234', deviceId: `d-${username}`, deviceName: `${username} phone` } })).json().token as string;
  const th = await login('host');
  const tf = await login('friend');
  const tt = await login('third');
  const call = (t: string, method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url: `/api/v1${url}`, headers: { authorization: `Bearer ${t}` }, ...(payload !== undefined ? { payload: payload as any } : {}) });
  const created = (await call(th, 'POST', '/match', { kind: 'movies', unwatchedByAll: false })).json();
  assert.ok(created.code);
  assert.equal((await call(tf, 'POST', '/match/join', { code: 'NOPE00' })).statusCode, 404);
  assert.equal((await call(tf, 'POST', '/match/join', { code: created.code })).statusCode, 200);
  assert.equal((await call(tt, 'GET', `/match/${created.id}/deck`)).statusCode, 403, 'non-members cannot read the deck');
  const deck = (await call(tf, 'GET', `/match/${created.id}/deck?limit=5`)).json();
  assert.equal(deck.cards.length, 5);
  assert.equal((await call(th, 'POST', `/match/${created.id}/vote`, { itemId: deck.cards[0].id, vote: 'yes' })).statusCode, 200);
  const v = (await call(tf, 'POST', `/match/${created.id}/vote`, { itemId: deck.cards[0].id, vote: 'yes' })).json();
  assert.equal(v.match.itemId, deck.cards[0].id);
  assert.equal((await call(tf, 'POST', `/match/${created.id}/vote`, { itemId: deck.cards[1].id, vote: 'maybe' })).statusCode, 400);
  assert.equal((await call(tf, 'GET', `/match/${created.id}/results`)).json().length, 1);
  assert.equal((await call(tf, 'POST', `/match/${created.id}/end`)).statusCode, 403);
  assert.equal((await call(th, 'POST', `/match/${created.id}/end`)).statusCode, 200);
});
