// Wrapped story data: totals, top titles across movies and shows, people weighted by time, binge record, biggest
// day, day-by-day heatmap, top music, the film personality — and that another user's history never leaks in.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { db } = await import('../src/db.ts');
const { createUser, issueToken } = await import('../src/services/auth.ts');
const { buildWrapped, filmPersonality } = await import('../src/services/wrapped.ts');
const { buildApp } = await import('../src/app.ts');

const me = createUser({ username: 'wr-me', password: 'pw-123456', displayName: 'Robin' } as any);
const other = createUser({ username: 'wr-other', password: 'pw-123456' });
const now = '2025-01-01T00:00:00.000Z';
db.run("INSERT INTO libraries (id, name, type, paths, fetch_metadata, created_at) VALUES ('w-lib', 'All', 'movies', '[]', 0, ?)", now);
const item = (id: string, type: string, title: string, extra: Record<string, unknown> = {}) =>
  db.insert('items', { id, library_id: 'w-lib', type, title, sort_title: title.toLowerCase(), added_at: now, updated_at: now, ...extra });
const actor = (name: string, imageUrl: string | null = null) => ({ name, role: null, kind: 'actor', imageUrl });
item('w-m1', 'movie', 'Space Saga', { genres: JSON.stringify(['Science Fiction']), duration_ms: 7_200_000, poster: 'p-m1', people: JSON.stringify([actor('Ava Star', '/api/v1/images/ava'), actor('Ben Bit'), { name: 'Dee Rector', role: null, kind: 'director', imageUrl: null }]) });
item('w-m2', 'movie', 'Space Saga II', { genres: JSON.stringify(['Science Fiction']), duration_ms: 7_200_000, people: JSON.stringify([actor('Ava Star'), { name: 'Dee Rector', role: null, kind: 'director', imageUrl: null }]) });
item('w-show', 'show', 'Box Set', { genres: JSON.stringify(['Drama']), poster: 'p-show', people: JSON.stringify([actor('Cy Series')]) });
item('w-s1', 'season', 'Season 1', { parent_id: 'w-show' });
for (let e = 1; e <= 6; e++) item(`w-e${e}`, 'episode', `Episode ${e}`, { parent_id: 'w-s1', grandparent_id: 'w-show', duration_ms: 2_700_000 });
item('w-art', 'artist', 'Synth Band', { poster: 'p-art' });
item('w-alb', 'album', 'Neon', { parent_id: 'w-art', poster: 'p-alb' });
item('w-t1', 'track', 'Glow', { parent_id: 'w-alb', grandparent_id: 'w-art', duration_ms: 240_000 });
item('w-t2', 'track', 'Pulse', { parent_id: 'w-alb', grandparent_id: 'w-art', duration_ms: 200_000 });

const play = (userId: string, itemId: string, startedAt: string, minutes: number) =>
  db.run('INSERT INTO play_history (user_id, item_id, started_at, ended_at, duration_ms) VALUES (?, ?, ?, ?, ?)', userId, itemId, startedAt, startedAt, minutes * 60000);
// Mine (2025): two movies, a 5-episode binge on 14 March, another episode later, music.
play(me.id, 'w-m1', '2025-02-10T20:00:00.000Z', 120);
play(me.id, 'w-m2', '2025-02-11T20:00:00.000Z', 100);
for (let e = 1; e <= 5; e++) play(me.id, `w-e${e}`, `2025-03-14T${String(10 + e).padStart(2, '0')}:00:00.000Z`, 45);
play(me.id, 'w-e6', '2025-04-02T21:00:00.000Z', 45);
play(me.id, 'w-t1', '2025-05-01T08:00:00.000Z', 4);
play(me.id, 'w-t1', '2025-05-02T08:00:00.000Z', 4);
play(me.id, 'w-t2', '2025-05-02T08:10:00.000Z', 3);
play(me.id, 'w-m1', '2024-12-31T20:00:00.000Z', 120); // previous year
play(me.id, 'w-m1', '2025-06-01T20:00:00.000Z', 0.2); // too short to count
// Someone else's history must never show up.
for (let i = 0; i < 10; i++) play(other.id, 'w-m2', `2025-07-0${(i % 9) + 1}T20:00:00.000Z`, 120);

test('year story: totals, top titles, people, binge, heatmap, music', () => {
  const w = buildWrapped(me.id, 2025);
  assert.equal(w.year, 2025);
  assert.equal(w.totalMinutes, 120 + 100 + 6 * 45 + 11);
  assert.equal(w.moviesWatched, 2);
  assert.equal(w.episodesWatched, 6);
  assert.equal(w.tracksPlayed, 3);
  assert.equal(w.activeDays, 6);
  assert.deepEqual(w.topTitles.map((t) => [t.title, t.minutes, t.subtitle]), [['Box Set', 270, 'Series'], ['Space Saga', 120, 'Movie'], ['Space Saga II', 100, 'Movie']]);
  assert.equal(w.topTitles[0].posterUrl, '/api/v1/images/p-show');
  // People: in two titles beats one; ties by time.
  assert.deepEqual(w.topPeople.slice(0, 2).map((p) => [p.name, p.titles, p.minutes]), [['Ava Star', 2, 220], ['Dee Rector', 2, 220]]);
  assert.equal(w.topPeople[0].imageUrl, '/api/v1/images/ava');
  assert.ok(w.topPeople.some((p) => p.name === 'Cy Series' && p.minutes === 270));
  assert.deepEqual(w.binge && { t: w.binge.title, n: w.binge.episodes, m: w.binge.minutes, d: w.binge.date }, { t: 'Box Set', n: 5, m: 225, d: '2025-03-14' });
  assert.deepEqual(w.biggestDay, { date: '2025-03-14', minutes: 225 });
  assert.equal(w.heatmap.length, 12);
  assert.deepEqual(w.heatmap.map((m) => m.length), [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
  assert.equal(w.heatmap[2][13], 225);
  assert.equal(w.heatmap[1][9], 120);
  assert.equal(w.heatmap[6].reduce((a, b) => a + b, 0), 0, 'the other user’s July plays are not mine');
  assert.equal(w.musicMinutes, 11);
  assert.deepEqual(w.topTracks.map((t) => [t.title, t.plays, t.subtitle]), [['Glow', 2, 'Synth Band'], ['Pulse', 1, 'Synth Band']]);
  assert.equal(w.topArtists[0].title, 'Synth Band');
  assert.equal(w.topGenres[0].genre, 'Drama');
  assert.equal(w.personality.id, 'drama-devotee');
  assert.ok(w.personality.traits.includes('Binge-watcher'));
  assert.equal(w.displayName, 'Robin');
});

test('all time includes earlier years; an empty year is a newcomer', () => {
  const all = buildWrapped(me.id, null);
  assert.equal(all.topTitles.find((t) => t.title === 'Space Saga')!.minutes, 240);
  assert.deepEqual(all.heatmap, []);
  const empty = buildWrapped(me.id, 2019);
  assert.equal(empty.totalMinutes, 0);
  assert.equal(empty.binge, null);
  assert.equal(empty.personality.id, 'newcomer');
});

test('film personality rules', () => {
  const base = { topGenre: 'Horror', peakHour: 23, bingeEpisodes: 0, movies: 10, episodes: 2, musicShare: 0, streak: 1, totalMinutes: 1000 };
  const h = filmPersonality(base);
  assert.equal(h.id, 'thrill-seeker');
  assert.deepEqual(h.traits, ['Night owl', 'Film buff']);
  assert.equal(filmPersonality({ ...base, bingeEpisodes: 8, movies: 1, episodes: 40 }).id, 'binge-master');
  assert.equal(filmPersonality({ ...base, musicShare: 0.7 }).id, 'soundtrack');
  assert.equal(filmPersonality({ ...base, topGenre: 'Telenovela' }).id, 'eclectic');
  assert.ok(filmPersonality({ ...base, peakHour: 8 }).traits.includes('Early bird'));
});

test('HTTP: your own story only', async () => {
  const app = await buildApp();
  after(() => app.close());
  const tok = issueToken(me.id, { deviceId: 'wr' }).token;
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/stats/me/wrapped?year=2025' })).statusCode, 401);
  const r = await app.inject({ method: 'GET', url: '/api/v1/stats/me/wrapped?year=2025', headers: { authorization: `Bearer ${tok}` } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().binge.episodes, 5);
});
