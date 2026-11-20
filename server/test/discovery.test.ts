import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Person } from '@mediamax/shared';

const { db } = await import('../src/db.ts');
const { createUser, getUser } = await import('../src/services/auth.ts');
const items = await import('../src/services/items.ts');
const rec = await import('../src/services/recommend.ts');
const cal = await import('../src/services/calendar.ts');
const { saveSchedule } = await import('../src/services/schedule.ts');
const notes = await import('../src/services/notifications.ts');

/* ------------------------------ fixtures ----------------------------- */

const now = new Date().toISOString();
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const H = 3_600_000;
const D = 24 * H;

function lib(id: string, type = 'movies') {
  db.insert('libraries', { id, name: id, type, paths: '[]', created_at: now });
}
const actor = (name: string): Person => ({ name, role: null, kind: 'actor', imageUrl: null });
const director = (name: string): Person => ({ name, role: null, kind: 'director', imageUrl: null });
function item(id: string, o: { lib?: string; type?: string; title?: string; genres?: string[]; people?: Person[]; studios?: string[]; year?: number; rating?: number; cr?: string | null; parent?: string; grand?: string; idx?: number; pidx?: number; added?: string }) {
  db.insert('items', {
    id, library_id: o.lib ?? 'movies', type: o.type ?? 'movie', title: o.title ?? id, sort_title: (o.title ?? id).toLowerCase(),
    genres: JSON.stringify(o.genres ?? []), people: JSON.stringify(o.people ?? []), studios: JSON.stringify(o.studios ?? []),
    year: o.year ?? 2010, community_rating: o.rating ?? 7, content_rating: o.cr ?? null, parent_id: o.parent ?? null, grandparent_id: o.grand ?? null,
    idx: o.idx ?? null, parent_idx: o.pidx ?? null, added_at: o.added ?? now, updated_at: now,
  });
}
function ud(userId: string, itemId: string, o: { played?: boolean; pos?: number; fav?: boolean; rating?: number; at?: string }) {
  db.run('INSERT OR REPLACE INTO user_data (user_id, item_id, played, play_count, position_ms, favorite, last_played_at, rating) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    userId, itemId, o.played ? 1 : 0, o.played ? 1 : 0, o.pos ?? 0, o.fav ? 1 : 0, o.at ?? now, o.rating ?? null);
}
function play(userId: string, itemId: string, msAgo: number, durationMs = 30 * 60_000) {
  db.run('INSERT INTO play_history (user_id, item_id, started_at, duration_ms) VALUES (?, ?, ?, ?)', userId, itemId, iso(msAgo), durationMs);
}

lib('movies');
lib('shows', 'shows');
lib('secret');
// Sci-fi by one director, comedies, a horror title, and restricted content.
item('scifi1', { title: 'Star Voyage', genres: ['Science Fiction', 'Adventure'], people: [director('Ada Nolan'), actor('Kim Park')], year: 2014, studios: ['Orbit'] });
item('scifi2', { title: 'Star Voyage II', genres: ['Science Fiction', 'Adventure'], people: [director('Ada Nolan'), actor('Kim Park')], year: 2017, studios: ['Orbit'] });
item('scifi3', { title: 'Nebula', genres: ['Science Fiction'], people: [director('Ada Nolan')], year: 2019 });
item('scifi4', { title: 'Deep Space', genres: ['Science Fiction', 'Thriller'], people: [actor('Kim Park')], year: 2015, rating: 6 });
item('comedy1', { title: 'Laugh Riot', genres: ['Comedy'], people: [director('Bo Jest'), actor('Al Funn')], year: 1995, rating: 9 });
item('comedy2', { title: 'More Laughs', genres: ['Comedy', 'Romance'], people: [actor('Al Funn')], year: 1997, rating: 8 });
item('horror1', { title: 'The Shriek', genres: ['Horror'], year: 2015, rating: 9.5 });
item('rated-r', { title: 'Grim Future', genres: ['Science Fiction'], people: [director('Ada Nolan')], year: 2018, cr: 'R' });
item('hidden', { lib: 'secret', title: 'Secret Sci-fi', genres: ['Science Fiction'], people: [director('Ada Nolan')], year: 2016 });
// A show with two seasons' worth of episodes.
item('show1', { lib: 'shows', type: 'show', title: 'Space Patrol', genres: ['Science Fiction'], year: 2020 });
item('s1', { lib: 'shows', type: 'season', title: 'Season 1', parent: 'show1', idx: 1 });
for (let e = 1; e <= 4; e++) item(`ep${e}`, { lib: 'shows', type: 'episode', title: `Ep ${e}`, parent: 's1', grand: 'show1', idx: e, pidx: 1 });
item('show2', { lib: 'shows', type: 'show', title: 'Sitcom House', genres: ['Comedy'], year: 2001 });
item('s2', { lib: 'shows', type: 'season', title: 'Season 1', parent: 'show2', idx: 1 });
item('sc1', { lib: 'shows', type: 'episode', title: 'Pilot', parent: 's2', grand: 'show2', idx: 1, pidx: 1 });
// A trailer extra must never show up in recommendations or charts.
item('trailer', { type: 'video', title: 'Star Voyage trailer', parent: 'scifi1', genres: ['Science Fiction'] });

const alice = createUser({ username: 'alice', password: 'pass1234' });
const bob = createUser({ username: 'bob', password: 'pass1234' });
const kid = createUser({ username: 'kid', password: 'pass1234', maxContentRating: 'PG-13', libraryIds: ['movies', 'shows'] });
const carol = createUser({ username: 'carol', password: 'pass1234' });

/* --------------------------- pure scoring ---------------------------- */

test('similarity: shared director and genres beat an unrelated title', () => {
  const rows = new Map(db.all('SELECT * FROM items').map((r) => [r.id, r]));
  const f = (id: string) => rec.featuresOf(rows.get(id));
  const sequel = rec.similarity(f('scifi1'), f('scifi2'));
  const sameGenre = rec.similarity(f('scifi1'), f('scifi3'));
  const unrelated = rec.similarity(f('scifi1'), f('comedy1'));
  assert.ok(sequel > sameGenre, `sequel ${sequel} > same genre ${sameGenre}`);
  assert.ok(sameGenre > unrelated, `${sameGenre} > ${unrelated}`);
  assert.equal(unrelated, 0);
  assert.ok(Math.abs(rec.similarity(f('scifi1'), f('scifi1')) - 1) < 1e-9);
  assert.deepEqual(f('scifi1').genres, ['science fiction', 'adventure']);
  assert.equal(f('comedy1').decade, 1990);
});

test('taste profile: liked traits score up, disliked traits score down', () => {
  const rows = new Map(db.all('SELECT * FROM items').map((r) => [r.id, r]));
  const f = (id: string) => rec.featuresOf(rows.get(id));
  const p = rec.buildProfile([{ f: f('scifi1'), w: rec.signalWeight({ played: true, favorite: true }) }, { f: f('comedy1'), w: rec.signalWeight({ played: true, rating: 2 }) }]);
  assert.ok(rec.profileScore(p, f('scifi3')) > 0);
  assert.ok(rec.profileScore(p, f('comedy2')) < 0, 'thumbs-down comedy makes other comedies score negative');
  assert.ok(rec.profileScore(p, f('scifi2')) > rec.profileScore(p, f('scifi4')), 'same director + cast beats genre only');
});

test('signal weights: favourites and thumbs up add, thumbs down and not-interested subtract, old plays fade', () => {
  assert.ok(rec.signalWeight({ played: true, favorite: true }) > rec.signalWeight({ played: true }));
  assert.ok(rec.signalWeight({ played: true, rating: 10 }) > rec.signalWeight({ played: true }));
  assert.ok(rec.signalWeight({ played: true, rating: 2 }) < 0);
  assert.ok(rec.signalWeight({ notInterested: true }) < 0);
  assert.ok(rec.signalWeight({ played: true, ageDays: 400 }) < rec.signalWeight({ played: true, ageDays: 1 }));
  assert.ok(rec.signalWeight({ episodes: 10 }) > rec.signalWeight({ episodes: 1 }));
  assert.ok(rec.signalWeight({ watchlist: true }) > 0);
});

test('collaborative: viewers like you, and people who watched X also watched Y', () => {
  const m: Map<string, Set<string>> = new Map([
    ['me', new Set(['a', 'b'])],
    ['twin', new Set(['a', 'b', 'c'])],
    ['other', new Set(['x', 'd'])],
    ['half', new Set(['a', 'e', 'f', 'g'])],
  ]);
  const c = rec.collabForUser(m, 'me');
  assert.ok(!c.has('a') && !c.has('x') && !c.has('d'), 'own titles and strangers\' titles are not suggested');
  assert.ok((c.get('c') ?? 0) > (c.get('e') ?? 0), 'the closer viewer counts more');
  const co = rec.coWatched(m, 'a');
  assert.ok(co.has('b') && co.has('c') && !co.has('a') && !co.has('d'));
  assert.ok((co.get('b') ?? 0) > (co.get('g') ?? 0));
});

test('charts: top 10 ranks by distinct viewers, trending by recency', () => {
  const rows = [
    { tid: 'busy', uid: 'u1', started_at: iso(6 * D) }, { tid: 'busy', uid: 'u1', started_at: iso(5 * D) }, { tid: 'busy', uid: 'u1', started_at: iso(4 * D) },
    { tid: 'wide', uid: 'u1', started_at: iso(6 * D) }, { tid: 'wide', uid: 'u2', started_at: iso(6 * D) },
    { tid: 'fresh', uid: 'u3', started_at: iso(1 * H) },
  ];
  assert.deepEqual(rec.rankCharts('top10', rows).map((r) => r.id), ['wide', 'busy', 'fresh']);
  assert.equal(rec.rankCharts('trending', rows)[0].id, 'fresh');
});

/* ------------------------- recommendations (DB) ----------------------- */

test('recommended: content + co-watching, excludes watched/in-progress/not-interested and respects access', () => {
  rec.clearRecommendationCache();
  ud(alice.id, 'scifi1', { played: true, fav: true });
  ud(alice.id, 'scifi2', { pos: 60_000 }); // in progress
  ud(alice.id, 'comedy1', { played: true, rating: 2 }); // thumbs down
  items.setNotInterested(alice, 'scifi4', true);
  // Bob shares Alice's taste and also loved the horror film.
  ud(bob.id, 'scifi1', { played: true });
  ud(bob.id, 'horror1', { played: true });
  const ids = rec.recommendedIds(alice);
  for (const x of ['scifi1', 'scifi2', 'comedy1', 'scifi4', 'trailer']) assert.ok(!ids.includes(x), `${x} must be excluded`);
  assert.ok(ids.includes('scifi3') && ids.includes('horror1'));
  assert.ok(ids.indexOf('scifi3') < ids.indexOf('comedy2'), 'liked director ranks above the disliked genre');
  assert.ok(ids.indexOf('horror1') < ids.indexOf('comedy2'), 'co-watched by a similar viewer ranks above the disliked genre');

  // The restricted viewer never gets the other library or R-rated titles.
  ud(kid.id, 'scifi1', { played: true });
  const kidIds = rec.recommendedIds(kid);
  assert.ok(!kidIds.includes('hidden') && !kidIds.includes('rated-r'));
  assert.ok(kidIds.includes('scifi3'));

  // Rows come back as Items with the viewer's data.
  const row = rec.discoveryRow(alice, { id: 'r', type: 'recommended', enabled: true, title: 'Recommended for you', limit: 5 });
  assert.ok(row && row.items.length > 0 && row.items.length <= 5);
});

test('cache is dropped when the viewer rates something', () => {
  const before = rec.recommendedIds(alice);
  assert.ok(before.includes('scifi3'));
  items.setNotInterested(alice, 'scifi3', true);
  assert.ok(!rec.recommendedIds(alice).includes('scifi3'));
  items.setNotInterested(alice, 'scifi3', false);
  assert.ok(rec.recommendedIds(alice).includes('scifi3'));
});

test('similar items: same kind, ranked by similarity, hidden titles removed', () => {
  const sim = rec.similarTo(alice, 'scifi1', 5)!.map((i) => i.id);
  assert.equal(sim[0], 'scifi2');
  assert.ok(!sim.includes('scifi1') && !sim.includes('show1') && !sim.includes('scifi4'), 'no self, no shows, no not-interested');
  assert.equal(rec.similarTo(alice, 'ep1', 5), null, 'episodes fall back to the genre-based endpoint');
  assert.ok(!rec.similarTo(kid, 'scifi1', 10)!.some((i) => i.id === 'rated-r' || i.id === 'hidden'));
});

test('because you watched: picks a finished title and suggests unseen similar ones', () => {
  rec.clearRecommendationCache();
  const seed = rec.becauseSeed(alice);
  assert.equal(seed?.id, 'scifi1');
  const row = rec.discoveryRow(alice, { id: 'b', type: 'because', enabled: true, title: 'Because you watched {title}', limit: 10 });
  assert.equal(row?.title, 'Because you watched Star Voyage');
  assert.equal(row?.seedItemId, 'scifi1');
  assert.ok(!row!.items.some((i) => i.id === 'scifi2'), 'in-progress titles are left out');
  // A show counts once three episodes are finished.
  for (const e of ['ep1', 'ep2', 'ep3']) ud(carol.id, e, { played: true, at: iso(H) });
  assert.equal(rec.becauseSeed(carol)?.id, 'show1');
});

test('top 10 rolls episodes up to the show; trending hides not-interested; short plays never count', () => {
  rec.clearRecommendationCache();
  play(alice.id, 'ep1', 2 * D);
  play(bob.id, 'ep2', 3 * D);
  play(carol.id, 'ep3', 1 * D);
  play(alice.id, 'comedy2', 1 * H);
  play(bob.id, 'comedy2', 2 * H);
  play(alice.id, 'horror1', 3 * D);
  play(alice.id, 'scifi3', 9 * D); // too old for the weekly chart
  play(bob.id, 'scifi2', H, 10_000); // 10 s: not a real play
  const top = rec.popularIds(alice, 'top10');
  assert.deepEqual(top.slice(0, 3), ['show1', 'comedy2', 'horror1']);
  assert.ok(!top.includes('scifi3') && !top.includes('scifi2') && !top.includes('ep1'));
  const row = rec.discoveryRow(alice, { id: 't', type: 'top10', enabled: true, title: 'Top 10 on {server} this week', limit: 10 });
  assert.ok(row && row.title.startsWith('Top 10 on ') && !row.title.includes('{server}'));
  assert.equal(rec.popularIds(alice, 'trending')[0], 'comedy2');
  items.setNotInterested(alice, 'comedy2', true);
  rec.clearRecommendationCache();
  assert.ok(!rec.popularIds(alice, 'trending').includes('comedy2'));
  assert.ok(rec.popularIds(bob, 'trending').includes('comedy2'), 'only for that viewer');
});

test('trailer previews run beside normal playback and stay out of history and the dashboard', async () => {
  const pb = await import('../src/services/playback.ts');
  const ctx = { user: alice, deviceRowId: 'dev1', device: { deviceId: 'd1', deviceName: 'Browser', platform: 'web' as const, appVersion: null }, token: 't' };
  const base = { ctx, channelId: null, mediaId: null, job: null, title: 'x', subtitle: null, posterUrl: null, durationMs: null, remoteAddr: null };
  const before = db.get<{ n: number }>('SELECT COUNT(*) n FROM play_history')!.n;
  const main = pb.registerSession({ ...base, itemId: 'scifi3', method: 'direct' });
  const prev = pb.registerSession({ ...base, itemId: 'trailer', method: 'direct', preview: true });
  assert.ok(pb.getSession(main.id), 'the preview did not replace the real playback');
  assert.ok(!pb.listSessions().some((s) => s.id === prev.id));
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) n FROM play_history')!.n, before + 1);
  const prev2 = pb.registerSession({ ...base, itemId: 'trailer', method: 'direct', preview: true });
  assert.ok(!pb.getSession(prev.id) && pb.getSession(prev2.id), 'a new preview replaces the old one');
  pb.stopSession(prev2.id);
  pb.stopSession(main.id);
});

/* ------------------------------ watchlist ---------------------------- */

test('watchlist: add, flag in user data, list newest first, home row, not-interested removes', () => {
  assert.equal(items.getItem(bob, 'horror1', false).userData.inWatchlist, false);
  const ud1 = items.setWatchlist(bob, 'horror1', true);
  assert.equal(ud1.inWatchlist, true);
  db.run("UPDATE watchlist SET added_at = '2020-01-01T00:00:00.000Z' WHERE user_id = ? AND item_id = 'horror1'", bob.id);
  items.setWatchlist(bob, 'show2', true);
  items.setWatchlist(bob, 'show2', true); // idempotent
  const list = items.listWatchlist(bob);
  assert.deepEqual(list.items.map((i) => i.id), ['show2', 'horror1']);
  assert.equal(list.total, 2);
  assert.equal(items.listWatchlist(alice).total, 0, 'per user');
  // Queries elsewhere carry the flag too.
  assert.equal(items.queryItems(bob, { type: 'movie', limit: 50 }).items.find((i) => i.id === 'horror1')?.userData.inWatchlist, true);
  const ud2 = items.setNotInterested(bob, 'horror1', true);
  assert.equal(ud2.inWatchlist, false);
  assert.equal(ud2.notInterested, true);
  assert.deepEqual(items.listWatchlist(bob).items.map((i) => i.id), ['show2']);
  // Adding back to the list clears "not interested".
  assert.equal(items.setWatchlist(bob, 'horror1', true).notInterested, false);
  items.setWatchlist(bob, 'horror1', false);
  // Restricted viewers can't add what they can't see.
  assert.throws(() => items.setWatchlist(getUser(kid.id), 'hidden', true));
});

/* ------------------------------ calendar ----------------------------- */

test('calendar range: defaults, validation and clamping', () => {
  const ref = new Date('2026-05-10T12:00:00Z');
  assert.deepEqual(cal.calendarRange(null, null, ref), { from: '2026-05-03', to: '2026-06-09' });
  assert.deepEqual(cal.calendarRange('2026-05-01', '2026-04-01', ref), { from: '2026-05-01', to: '2026-05-01' });
  assert.equal(cal.calendarRange('2026-01-01', '2027-01-01', ref).to, '2026-05-01');
  assert.equal(cal.calendarRange('nonsense', null, ref).from, '2026-05-03');
});

test('calendar: upcoming episodes from the stored schedule plus recently added episodes, access-filtered', () => {
  const soon = cal.ymd(new Date(Date.now() + 3 * D));
  saveSchedule('show1', { status: 'Returning Series', inProduction: true, lastAirDate: '2026-01-01', next: { airDate: soon, season: 2, episode: 1, title: 'Return', overview: null } });
  saveSchedule('show2', { status: 'Ended', inProduction: false, lastAirDate: '2010-01-01', next: null });
  item('ep5', { lib: 'shows', type: 'episode', title: 'Ep 5', parent: 's1', grand: 'show1', idx: 5, pidx: 1, added: iso(H) });
  const res = cal.calendarFor(carol);
  const up = res.entries.filter((e) => e.kind === 'upcoming');
  assert.equal(up.length, 1);
  assert.equal(up[0].show.id, 'show1');
  assert.equal(up[0].date, soon);
  assert.equal(up[0].seasonNumber, 2);
  assert.equal(up[0].following, true, 'carol watched episodes of show1');
  const added = res.entries.filter((e) => e.kind === 'added');
  assert.ok(added.some((e) => e.episode?.id === 'ep5'));
  assert.equal(typeof res.tmdbConfigured, 'boolean');
  // Sorted by date (agenda order).
  assert.deepEqual(res.entries.map((e) => e.date), [...res.entries.map((e) => e.date)].sort());
  // A viewer without access to the shows library sees nothing.
  const outsider = createUser({ username: 'outsider', password: 'pass1234', libraryIds: ['movies'] });
  assert.equal(cal.calendarFor(outsider).entries.length, 0);
  // Home row.
  const row = cal.upcomingRow(carol, { id: 'u', type: 'upcoming', enabled: true, title: 'Coming soon', limit: 10 });
  assert.equal(row?.items[0].id, 'show1');
  assert.equal(row?.calendar?.[0].episodeNumber, 1);
  assert.equal(cal.upcomingRow(outsider, { id: 'u', type: 'upcoming', enabled: true, limit: 10 }), null);
});

/* ---------------------------- notifications --------------------------- */

test('new-episode notifications go to followers only, once per show, and can be marked read', () => {
  db.run('DELETE FROM notifications');
  item('ep6', { lib: 'shows', type: 'episode', title: 'Ep 6', parent: 's1', grand: 'show1', idx: 6, pidx: 1 });
  item('ep7', { lib: 'shows', type: 'episode', title: 'Ep 7', parent: 's1', grand: 'show1', idx: 7, pidx: 1 });
  item('sc2', { lib: 'shows', type: 'episode', title: 'Second', parent: 's2', grand: 'show2', idx: 2, pidx: 1 });
  items.setWatchlist(bob, 'show2', true);
  const sent = notes.notifyNewEpisodes(['ep6', 'ep7', 'sc2', 'horror1']);
  // carol + alice + bob watched show1 episodes (from play/ud fixtures: carol ep1-3; alice/bob only play_history, not user_data) → carol;
  // bob has show2 on his list.
  const carolN = notes.listNotifications(carol);
  assert.equal(carolN.unread, 1);
  assert.equal(carolN.items[0].title, '2 new episodes of Space Patrol');
  assert.equal(carolN.items[0].itemId, 'ep6');
  const bobN = notes.listNotifications(bob);
  assert.equal(bobN.items.length, 1);
  assert.equal(bobN.items[0].title, 'New episode of Sitcom House');
  assert.equal(bobN.items[0].body, 'S01E02 · Second');
  assert.equal(notes.listNotifications(alice).items.length, 0);
  assert.equal(sent, 2);
  // Not for viewers who can't see the show.
  const outsider = getUser(db.get<{ id: string }>("SELECT id FROM users WHERE username = 'outsider'")!.id);
  items.setWatchlist(getUser(alice.id), 'show2', true);
  db.run("INSERT INTO watchlist (user_id, item_id, added_at) VALUES (?, 'show2', ?)", outsider.id, now);
  notes.notifyNewEpisodes(['sc2']);
  assert.equal(notes.listNotifications(outsider).items.length, 0);
  assert.equal(notes.listNotifications(alice).unread, 1);
  // Mark read.
  assert.equal(notes.markRead(carol, [carolN.items[0].id]).unread, 0);
  assert.equal(notes.markRead(bob).unread, 0);
  assert.ok(notes.listNotifications(bob).items.every((n) => n.readAt));
});
