/**
 * Roulette and Random marathon: filters (library, genre, runtime, decade, rating, unwatched, My List, moods),
 * access / ratings, series episode choice (next up vs S1E1 vs random), exclusions, seeded weighting, the marathon
 * queue (no repeats, disliked never) and the "Are you still watching?" rule, plus endpoint auth.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { db } = await import('../src/db.ts');
const auth = await import('../src/services/auth.ts');
const roulette = await import('../src/services/decide/roulette.ts');
const marathon = await import('../src/services/decide/marathon.ts');
const { pickWeight, seededRng, weightedIndex } = await import('../src/services/decide/common.ts');
const { buildApp } = await import('../src/app.ts');

const now = new Date().toISOString();
const old = new Date(Date.now() - 400 * 86400000).toISOString();
db.insert('libraries', { id: 'lib-m', name: 'Movies', type: 'movies', paths: '[]', created_at: now });
db.insert('libraries', { id: 'lib-m2', name: 'Classics', type: 'movies', paths: '[]', created_at: now });
db.insert('libraries', { id: 'lib-tv', name: 'TV', type: 'shows', paths: '[]', created_at: now });
const item = (id: string, o: Record<string, unknown>) =>
  db.insert('items', { id, library_id: 'lib-m', type: 'movie', title: id, sort_title: id, added_at: old, updated_at: now, genres: '[]', ...o });
item('comedy-90s', { genres: '["Comedy"]', year: 1994, duration_ms: 90 * 60000, community_rating: 7.5, content_rating: 'PG' });
item('comedy-long', { genres: '["Comedy"]', year: 2015, duration_ms: 150 * 60000, community_rating: 6, content_rating: 'PG-13' });
item('thriller', { genres: '["Thriller"]', year: 2010, duration_ms: 110 * 60000, community_rating: 8.2, content_rating: 'R' });
item('family', { genres: '["Family","Animation"]', year: 2005, duration_ms: 85 * 60000, community_rating: 7, content_rating: 'G' });
item('scifi', { genres: '["Science Fiction"]', year: 1999, duration_ms: 130 * 60000, community_rating: 8.7, content_rating: 'R', overview: 'A hacker learns reality is a simulation.' });
item('classic', { library_id: 'lib-m2', genres: '["Drama"]', year: 1957, duration_ms: 96 * 60000, community_rating: 8.9 });
item('disliked', { genres: '["Comedy"]', year: 2001, duration_ms: 95 * 60000, community_rating: 9 });
item('meh', { genres: '["Comedy"]', year: 2002, duration_ms: 95 * 60000, community_rating: 9 });
// Shows: "sitcom" (S1 3 eps + special), "drama" (2 eps).
item('sitcom', { library_id: 'lib-tv', type: 'show', genres: '["Comedy"]', content_rating: 'TV-PG', community_rating: 8 });
item('sitcom-s0', { library_id: 'lib-tv', type: 'season', parent_id: 'sitcom', idx: 0 });
item('sitcom-s1', { library_id: 'lib-tv', type: 'season', parent_id: 'sitcom', idx: 1 });
item('sitcom-sp', { library_id: 'lib-tv', type: 'episode', parent_id: 'sitcom-s0', grandparent_id: 'sitcom', idx: 1, parent_idx: 0, duration_ms: 22 * 60000 });
for (let e = 1; e <= 3; e++) item(`sitcom-e${e}`, { library_id: 'lib-tv', type: 'episode', parent_id: 'sitcom-s1', grandparent_id: 'sitcom', idx: e, parent_idx: 1, duration_ms: 22 * 60000 });
item('drama', { library_id: 'lib-tv', type: 'show', genres: '["Drama"]', content_rating: 'TV-MA', community_rating: 9 });
item('drama-s1', { library_id: 'lib-tv', type: 'season', parent_id: 'drama', idx: 1 });
item('drama-e1', { library_id: 'lib-tv', type: 'episode', parent_id: 'drama-s1', grandparent_id: 'drama', idx: 1, parent_idx: 1, duration_ms: 55 * 60000 });
item('drama-e2', { library_id: 'lib-tv', type: 'episode', parent_id: 'drama-s1', grandparent_id: 'drama', idx: 2, parent_idx: 1, duration_ms: 55 * 60000 });

const viewer = await auth.createUser({ username: 'viewer', password: 'pass1234' });
const teen = await auth.createUser({ username: 'teen', password: 'pass1234', maxContentRating: 'PG-13', libraryIds: ['lib-m', 'lib-tv'] });
db.insert('user_data', { user_id: viewer.id, item_id: 'disliked', not_interested: 1 });
db.insert('user_data', { user_id: viewer.id, item_id: 'meh', rating: 3 });
db.insert('user_data', { user_id: viewer.id, item_id: 'comedy-90s', played: 1 });
db.insert('watchlist', { user_id: viewer.id, item_id: 'family', added_at: now });
const V = () => auth.getUser(viewer.id);
const T = () => auth.getUser(teen.id);

const ids = (user = V(), f: Record<string, unknown> = {}) =>
  roulette.candidates(user, roulette.parseFilters({ kind: 'movie', ...f } as any), [], true).map((c) => c.id).sort();

const app = await buildApp();
after(() => app.close());

test('filters: library, genres, runtime, decade, rating, unwatched, My List', () => {
  assert.deepEqual(ids(V(), { libraryIds: ['lib-m2'] }), ['classic']);
  assert.deepEqual(ids(V(), { genres: ['Comedy'] }), ['comedy-90s', 'comedy-long']);
  assert.deepEqual(ids(V(), { genres: ['Comedy'], maxRuntimeMin: 100 }), ['comedy-90s']);
  assert.deepEqual(ids(V(), { decade: 1990 }), ['comedy-90s', 'scifi']);
  assert.deepEqual(ids(V(), { minRating: 8.5 }), ['classic', 'scifi']);
  assert.ok(!ids(V(), { unwatchedOnly: true }).includes('comedy-90s'));
  assert.deepEqual(ids(V(), { fromMyList: true }), ['family']);
});

test('disliked and not-interested titles are never picked', () => {
  const all = ids();
  assert.ok(!all.includes('disliked'));
  assert.ok(!all.includes('meh'));
  assert.ok(ids(T()).includes('meh'), 'only the viewer who disliked it loses it');
});

test('access: library restrictions and rating caps', () => {
  const t = ids(T());
  assert.ok(!t.includes('classic'), 'no access to that library');
  assert.ok(!t.includes('thriller') && !t.includes('scifi'), 'R is above PG-13');
  assert.ok(t.includes('comedy-long'));
  const shows = roulette.candidates(T(), roulette.parseFilters({ kind: 'series' }), [], true).map((c) => c.id);
  assert.deepEqual(shows, ['sitcom']);
});

test('moods map to genres / keywords and caps', () => {
  assert.deepEqual(ids(V(), { mood: 'family' }), ['family']);
  assert.ok(ids(V(), { mood: 'mind-bending' }).includes('scifi'));
  assert.deepEqual(ids(V(), { mood: 'edge' }), ['thriller']);
  assert.ok(ids(V(), { mood: 'short' }).every((id) => ['comedy-90s', 'family', 'classic'].includes(id)));
  assert.deepEqual(roulette.candidates(V(), roulette.parseFilters({ kind: 'series', mood: 'short' }), [], true).map((c) => c.id), ['sitcom']);
});

test('spin: pick + decoys in one response, exclusions, seeded determinism', () => {
  const r = roulette.spin(V(), { kind: 'movie', seed: 42 });
  assert.ok(r.pick);
  assert.ok(r.poolSize >= 5);
  assert.ok(!r.decoys.some((d) => d.id === r.pick!.id), 'the pick is not a decoy');
  assert.deepEqual(roulette.spin(V(), { kind: 'movie', seed: 42 }).pick!.id, r.pick!.id, 'same seed → same pick');
  const without = roulette.spin(V(), { kind: 'movie', seed: 42, excludeIds: [r.pick!.id] });
  assert.notEqual(without.pick!.id, r.pick!.id, '"Not this one" is excluded');
  assert.deepEqual(roulette.spin(V(), { kind: 'movie', genres: ['Nope'] }), { pick: null, episode: null, decoys: [], poolSize: 0 });
});

test('weighting favours higher-rated and recently added, deterministically with a seed', () => {
  assert.ok(pickWeight({ community_rating: 9, added_at: old }) > pickWeight({ community_rating: 5, added_at: old }));
  assert.ok(pickWeight({ community_rating: 7, added_at: now }) > pickWeight({ community_rating: 7, added_at: old }));
  const w = [pickWeight({ community_rating: 9.5, added_at: now }), pickWeight({ community_rating: 3, added_at: old })];
  const rng = seededRng(5);
  let hi = 0;
  for (let i = 0; i < 2000; i++) if (weightedIndex(w, rng) === 0) hi++;
  assert.ok(hi > 1700, `high-rated picked ${hi}/2000`);
  const a = Array.from({ length: 20 }, (_, i) => roulette.spin(V(), { kind: 'movie', seed: i }).pick!.id);
  const b = Array.from({ length: 20 }, (_, i) => roulette.spin(V(), { kind: 'movie', seed: i }).pick!.id);
  assert.deepEqual(a, b);
});

test('series: S1E1 when not started, next up when started, random episode option', () => {
  assert.equal(roulette.chooseEpisode(V(), 'sitcom', 'next')!.id, 'sitcom-e1', 'not started → S1E1 (not the special)');
  db.insert('user_data', { user_id: viewer.id, item_id: 'sitcom-e1', played: 1, last_played_at: now });
  assert.equal(roulette.chooseEpisode(V(), 'sitcom', 'next')!.id, 'sitcom-e2', 'started → next up');
  const seen = new Set<string>();
  const rng = seededRng(9);
  for (let i = 0; i < 60; i++) seen.add(roulette.chooseEpisode(V(), 'sitcom', 'random', rng)!.id);
  assert.deepEqual([...seen].sort(), ['sitcom-e1', 'sitcom-e2', 'sitcom-e3'], 'random covers regular episodes, not specials');
  const unwatched = new Set<string>();
  for (let i = 0; i < 40; i++) unwatched.add(roulette.chooseEpisode(V(), 'sitcom', 'random', rng, true)!.id);
  assert.ok(!unwatched.has('sitcom-e1'));
  const s = roulette.spin(V(), { kind: 'series', genres: ['Comedy'], seed: 1 });
  assert.equal(s.pick!.id, 'sitcom');
  assert.equal(s.episode!.id, 'sitcom-e2');
  const sr = roulette.spin(V(), { kind: 'series', genres: ['Comedy'], randomEpisode: true, seed: 1 });
  assert.ok(sr.episode!.id.startsWith('sitcom-e'));
});

test('marathon: no repeats, filters respected, exhausts, skipped excluded', () => {
  marathon._resetMarathons();
  const m = marathon.createMarathon(V(), { kind: 'movie', genres: ['Comedy', 'Family', 'Thriller', 'Science Fiction'], seed: 3 });
  const seen: string[] = [];
  let cur = m.item;
  let id = m.marathon.id;
  while (cur) {
    assert.ok(!seen.includes(cur.id), `repeat: ${cur.id}`);
    assert.ok(!['disliked', 'meh', 'classic'].includes(cur.id));
    seen.push(cur.id);
    cur = marathon.nextInMarathon(V(), id, { finishedItemId: cur.id }).item;
  }
  assert.deepEqual(seen.sort(), ['comedy-90s', 'comedy-long', 'family', 'scifi', 'thriller']);
  const m2 = marathon.createMarathon(T(), { kind: 'movie' });
  const n = marathon.nextInMarathon(T(), m2.marathon.id, { skippedItemId: m2.item!.id });
  assert.notEqual(n.item?.id, m2.item!.id);
  assert.deepEqual(n.marathon.played, [], 'skips are not counted as played');
  assert.throws(() => marathon.nextInMarathon(V(), m2.marathon.id, {}), /not found/, 'marathons are private to the viewer');
});

test('marathon: random episodes of one show forever (until all used), access checked', () => {
  marathon._resetMarathons();
  const m = marathon.createMarathon(V(), { kind: 'series', showId: 'sitcom', seed: 1 });
  const got = [m.item!.id];
  for (let i = 0; i < 5; i++) {
    const n = marathon.nextInMarathon(V(), m.marathon.id, { finishedItemId: got[got.length - 1] });
    if (!n.item) break;
    got.push(n.item.id);
  }
  assert.deepEqual(got.slice(0, 3).sort(), ['sitcom-e1', 'sitcom-e2', 'sitcom-e3'], 'regular episodes first, no repeats');
  assert.deepEqual(got.slice(3), ['sitcom-sp'], 'specials only once the regular episodes are used up');
  assert.throws(() => marathon.createMarathon(T(), { kind: 'series', showId: 'drama' }), /not found/i, 'TV-MA show hidden from a PG-13 profile');
  const any = marathon.createMarathon(T(), { kind: 'series' });
  assert.ok(any.item!.id.startsWith('sitcom-e'));
});

test('still watching: after N titles or N minutes without input, configurable and off-able', () => {
  const s = marathon.normalizeStillWatching({});
  assert.deepEqual(s, { enabled: true, afterItems: 2, afterMinutes: 240 });
  assert.equal(marathon.stillWatchingDue(s, 1, 60_000), false);
  assert.equal(marathon.stillWatchingDue(s, 2, 0), true);
  assert.equal(marathon.stillWatchingDue(s, 0, 240 * 60_000), true);
  assert.equal(marathon.stillWatchingDue({ ...s, enabled: false }, 10, 1e9), false);
  assert.equal(marathon.normalizeStillWatching({ afterItems: 0, afterMinutes: 1 }).afterItems, 1);
  marathon._resetMarathons();
  const m = marathon.createMarathon(V(), { kind: 'movie', stillWatching: { afterItems: 1 } });
  assert.equal(marathon.nextInMarathon(V(), m.marathon.id, { finishedItemId: m.item!.id, itemsSinceInput: 1 }).stillWatchingCheck, true);
  const off = marathon.createMarathon(V(), { kind: 'movie', stillWatching: { enabled: false } });
  assert.equal(marathon.nextInMarathon(V(), off.marathon.id, { finishedItemId: off.item!.id, itemsSinceInput: 9 }).stillWatchingCheck, false);
});

test('endpoints: spin, moods and marathon over HTTP', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/roulette/moods' })).statusCode, 401);
  const token = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'teen', password: 'pass1234', deviceId: 'd1' } })).json().token;
  const h = { authorization: `Bearer ${token}` };
  const moods = (await app.inject({ method: 'GET', url: '/api/v1/roulette/moods', headers: h })).json();
  assert.equal(moods.length, 6);
  const r = (await app.inject({ method: 'POST', url: '/api/v1/roulette/spin', headers: h, payload: { kind: 'movie' } })).json();
  assert.ok(r.pick && !['thriller', 'scifi', 'classic'].includes(r.pick.id));
  const m = (await app.inject({ method: 'POST', url: '/api/v1/marathon', headers: h, payload: { kind: 'movie' } })).json();
  assert.ok(m.marathon.id && m.item);
  const n = await app.inject({ method: 'POST', url: `/api/v1/marathon/${m.marathon.id}/next`, headers: h, payload: { finishedItemId: m.item.id } });
  assert.equal(n.statusCode, 200);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/marathon/${m.marathon.id}`, headers: h })).statusCode, 200);
});
