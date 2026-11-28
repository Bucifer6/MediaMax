// Two-way tracking and rating integrations (0.8, phase 2) against one local mock standing in for Trakt, SIMKL,
// MDBList and OMDb (response shapes as their clients use them): pull imports only add and never echo back, pushes of
// My List / ratings / plays, community comments, MDBList ratings and list rows, rating posters, episode ratings.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const { db } = await import('../src/db.ts');
const { createUser, getUser } = await import('../src/services/auth.ts');
const { updateSettings, publicSettings, SECRET_MASK } = await import('../src/services/settings.ts');
const { setProviderHttpOptions } = await import('../src/services/metadata/http.ts');
const { updateMetadataSettings } = await import('../src/services/metadata/config.ts');
const items = await import('../src/services/items.ts');
const trakt = await import('../src/services/trakt.ts');
const simkl = await import('../src/services/simkl.ts');
const mdb = await import('../src/services/mdblist.ts');
const { episodeRatings } = await import('../src/services/episodeRatings.ts');

const posts: { path: string; body: any }[] = [];
const mock = http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      posts.push({ path: u.pathname, body: body ? JSON.parse(body) : null });
      json(201, {});
    });
    return;
  }
  const p = u.pathname;
  // Trakt
  if (p === '/trakt/sync/watched/movies') return json(200, [{ last_watched_at: '2026-01-02T00:00:00.000Z', movie: { ids: { imdb: 'tt0133093', tmdb: 603 } } }, { movie: { ids: { imdb: 'tt9999999' } } }]);
  if (p === '/trakt/sync/watched/shows') return json(200, [{ show: { ids: { tvdb: 81189 } }, seasons: [{ number: 1, episodes: [{ number: 1, last_watched_at: '2026-01-03T00:00:00.000Z' }] }] }]);
  if (p === '/trakt/sync/playback') return json(200, [{ progress: 50, paused_at: '2026-01-04T00:00:00.000Z', type: 'episode', episode: { season: 1, number: 2 }, show: { ids: { tvdb: 81189 } } }]);
  if (p === '/trakt/sync/watchlist') return json(200, [{ type: 'show', listed_at: '2026-01-05T00:00:00.000Z', show: { ids: { tvdb: 81189 } } }]);
  if (p === '/trakt/sync/ratings') return json(200, [{ type: 'movie', rating: 9, movie: { ids: { tmdb: 603 } } }]);
  if (p === '/trakt/movies/tt0133093/comments/likes') {
    return json(200, [{ id: 7, comment: 'Still holds up.', spoiler: false, review: false, likes: 12, created_at: '2026-01-01T00:00:00.000Z', user: { username: 'neo' }, user_stats: { rating: 10 } }]);
  }
  // SIMKL
  if (p === '/simkl/sync/all-items/movies') return json(200, { movies: [{ status: 'plantowatch', added_to_watchlist_at: '2026-02-01T00:00:00Z', movie: { ids: { imdb: 'tt0133093' } } }] });
  if (p === '/simkl/sync/all-items/shows') return json(200, { shows: [{ status: 'watching', show: { ids: { tvdb: '81189' } }, seasons: [{ number: 1, episodes: [{ number: 3, watched_at: '2026-02-02T00:00:00Z' }] }] }] });
  if (p === '/simkl/sync/all-items/anime') return json(200, null);
  // MDBList
  if (p === '/mdb/imdb/movie/tt0133093') {
    return json(200, { ratings: [{ source: 'imdb', value: 8.7 }, { source: 'tmdb', value: 82 }, { source: 'tomatoes', value: 83 }, { source: 'popcorn', value: 85 }, { source: 'metacritic', value: 73 }, { source: 'letterboxd', value: 4.2, score: 84 }, { source: 'trakt', value: 87 }] });
  }
  if (p === '/mdb/lists/someone/best-of/items') return json(200, [{ imdb_id: 'tt9999999', mediatype: 'movie' }, { imdb_id: 'tt0133093', mediatype: 'movie' }]);
  // OMDb
  if (p === '/omdb/' && u.searchParams.get('Season') === '1') return json(200, { Response: 'True', totalSeasons: '1', Episodes: [{ Episode: '1', Title: 'Pilot', imdbRating: '8.9' }, { Episode: '2', Title: 'Two', imdbRating: 'N/A' }] });
  json(404, {});
});

const iso = new Date().toISOString();
let user: ReturnType<typeof getUser>;
before(async () => {
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  process.env.MEDIAMAX_TRAKT_API_BASE = `${base}/trakt`;
  process.env.MEDIAMAX_SIMKL_API_BASE = `${base}/simkl`;
  setProviderHttpOptions('mdblist', { base: `${base}/mdb`, minIntervalMs: 0 });
  setProviderHttpOptions('trakt', { minIntervalMs: 0 });
  setProviderHttpOptions('omdb', { base: `${base}/omdb`, minIntervalMs: 0 });
  updateSettings({ trakt: { clientId: 'cid', clientSecret: 'secret' }, simkl: { clientId: 'scid' } });
  db.insert('libraries', { id: 'tr-lib', name: 'All', type: 'movies', paths: '[]', created_at: iso });
  db.insert('items', { id: 'tr-matrix', library_id: 'tr-lib', type: 'movie', title: 'The Matrix', sort_title: 'matrix', external_ids: JSON.stringify({ imdb: 'tt0133093', tmdb: '603' }), added_at: iso, updated_at: iso });
  db.insert('items', { id: 'tr-show', library_id: 'tr-lib', type: 'show', title: 'The Office', sort_title: 'office', external_ids: JSON.stringify({ tvdb: '81189', imdb: 'tt0386676' }), added_at: iso, updated_at: iso });
  db.insert('items', { id: 'tr-s1', library_id: 'tr-lib', type: 'season', title: 'Season 1', sort_title: 's1', parent_id: 'tr-show', idx: 1, added_at: iso, updated_at: iso });
  for (const n of [1, 2, 3]) {
    db.insert('items', { id: `tr-e${n}`, library_id: 'tr-lib', type: 'episode', title: `E${n}`, sort_title: `e${n}`, parent_id: 'tr-s1', grandparent_id: 'tr-show', parent_idx: 1, idx: n, added_at: iso, updated_at: iso });
    db.insert('media', { id: `tr-m${n}`, item_id: `tr-e${n}`, path: `/x/e${n}.mkv`, duration_ms: 1_200_000 });
  }
  trakt.initTrakt();
  simkl.initSimkl();
  user = getUser((await createUser({ username: 'tr-user', password: 'pass1234' })).id);
  db.insert('trakt_accounts', { user_id: user.id, access_token: 'tok', refresh_token: 'r', expires_at: new Date(Date.now() + 30 * 86400000).toISOString(), username: 'tr', scrobble: 1, push: 1 });
  db.insert('simkl_accounts', { user_id: user.id, access_token: 'stok' });
});
after(() => mock.close());

const ud = (itemId: string) => db.get<{ played: number; position_ms: number; rating: number | null }>('SELECT played, position_ms, rating FROM user_data WHERE user_id = ? AND item_id = ?', user.id, itemId);
const onList = (itemId: string) => !!db.get('SELECT 1 FROM watchlist WHERE user_id = ? AND item_id = ?', user.id, itemId);

test('Trakt pull: watched, resume point, watchlist and rating land in the library without echoing back', async () => {
  posts.length = 0;
  const r = await trakt.pullFromTrakt(user.id);
  assert.deepEqual(r, { watched: 2, resumed: 1, watchlist: 1, rated: 1, notInLibrary: 1 });
  assert.equal(ud('tr-matrix')?.played, 1);
  assert.equal(ud('tr-matrix')?.rating, 9);
  assert.equal(ud('tr-e1')?.played, 1);
  assert.equal(ud('tr-e2')?.position_ms, 600_000, '50 % of a 20-minute episode');
  assert.ok(onList('tr-show'));
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(posts.length, 0, 'an import is never pushed back to Trakt or SIMKL');
  const again = await trakt.pullFromTrakt(user.id);
  assert.deepEqual(again, { watched: 0, resumed: 0, watchlist: 0, rated: 0, notInLibrary: 1 }, 'a second pull changes nothing');
  assert.equal(trakt.traktStatus(user.id).lastPull?.notInLibrary, 1);
});

test('Trakt pull never overwrites the viewer’s own rating or un-watches', async () => {
  db.run('UPDATE user_data SET rating = 4 WHERE user_id = ? AND item_id = ?', user.id, 'tr-matrix');
  await trakt.pullFromTrakt(user.id);
  assert.equal(ud('tr-matrix')?.rating, 4);
});

test('pushes: My List and ratings to Trakt; plays and My List to SIMKL', async () => {
  posts.length = 0;
  items.setWatchlist(user, 'tr-matrix', true);
  items.setRating(user, 'tr-matrix', 7.6);
  items.setPlayed(user, 'tr-e3', true);
  await new Promise((res) => setTimeout(res, 150));
  const by = (p: string) => posts.filter((x) => x.path === p).map((x) => x.body);
  assert.deepEqual(by('/trakt/sync/watchlist')[0]?.movies?.[0]?.ids, { tmdb: 603, imdb: 'tt0133093' });
  assert.equal(by('/trakt/sync/ratings')[0]?.movies?.[0]?.rating, 8);
  assert.deepEqual(by('/simkl/sync/add-to-list')[0], { movies: [{ ids: { imdb: 'tt0133093', tmdb: 603 }, to: 'plantowatch' }], shows: [] });
  const hist = by('/simkl/sync/history')[0];
  assert.deepEqual(hist?.shows?.[0]?.ids, { imdb: 'tt0386676', tvdb: 81189 });
  assert.equal(hist?.shows?.[0]?.seasons?.[0]?.episodes?.[0]?.number, 3);
});

test('SIMKL pull: plan-to-watch → My List, watched episodes', async () => {
  db.run('DELETE FROM watchlist WHERE user_id = ?', user.id);
  db.run("UPDATE user_data SET played = 0 WHERE user_id = ? AND item_id = 'tr-e3'", user.id);
  const r = await simkl.pullFromSimkl(user.id);
  assert.equal(r.watchlist, 1);
  assert.equal(r.watched, 1);
  assert.ok(onList('tr-matrix'));
  assert.equal(ud('tr-e3')?.played, 1);
  assert.equal(simkl.simklStatus(user.id).connected, true);
});

test('Trakt comments for a movie (public: client id only)', async () => {
  const c = await trakt.itemComments('tr-matrix');
  assert.deepEqual(c, [{ id: 7, comment: 'Still holds up.', spoiler: false, review: false, likes: 12, createdAt: '2026-01-01T00:00:00.000Z', user: 'neo', rating: 10 }]);
  assert.deepEqual(await trakt.itemComments('tr-e1'), [], 'unknown on the mock → empty');
});

test('MDBList: ratings mapped to Vibe scales; key write-only; list rows show library titles in list order', async () => {
  updateSettings({ mdblist: { apiKey: 'mk', ratings: true } });
  assert.equal(publicSettings().mdblist?.apiKey, SECRET_MASK);
  const n = await mdb.refreshAllMdbRatings();
  assert.equal(n, 1);
  const ratings = JSON.parse(db.get<{ ratings: string }>("SELECT ratings FROM items WHERE id = 'tr-matrix'")!.ratings);
  assert.deepEqual(ratings, { imdb: 8.7, tmdb: 8.2, rottenTomatoes: 83, audience: 85, metacritic: 73, letterboxd: 4.2, trakt: 87 });
  assert.equal(await mdb.refreshAllMdbRatings(), 0, 'not fetched again for a month');
  assert.equal(mdb.listPath('https://mdblist.com/lists/someone/best-of'), 'lists/someone/best-of/items');
  assert.equal(mdb.listPath('12345'), 'lists/12345/items');
  assert.equal(mdb.listPath('javascript:alert(1)'), null);
  assert.deepEqual(mdb.mdblistRowIds('someone/best-of'), [], 'first call loads in the background');
  await new Promise((res) => setTimeout(res, 100));
  assert.deepEqual(mdb.mdblistRowIds('someone/best-of'), ['tr-matrix']);
});

test('rating posters: proxied image URL only when configured; template validated', () => {
  assert.equal(items.getItem(user, 'tr-matrix', false).ratingPosterUrl, undefined);
  assert.throws(() => updateSettings({ ratingPosters: { urlTemplate: 'https://posters.example/{nothing}.jpg' } as never }), /contain \{imdb\} or \{tmdb\}/);
  updateSettings({ ratingPosters: { urlTemplate: 'https://posters.example/KEY/imdb/{imdb}.jpg', home: true, search: false, detail: true } });
  const url = items.getItem(user, 'tr-matrix', false).ratingPosterUrl;
  assert.match(url ?? '', /^\/api\/v1\/images\/[\w-]+$/, 'the key never reaches the client');
  assert.equal(publicSettings().ratingPosters?.urlTemplate, SECRET_MASK);
});

test('episode ratings: IMDb through OMDb when enabled, linked to library episodes', async () => {
  updateMetadataSettings({ providers: { omdb: { enabled: true, apiKey: 'ok' } } } as never);
  const r = await episodeRatings('tr-show');
  assert.equal(r.source, 'imdb');
  assert.deepEqual(r.seasons, [{ season: 1, episodes: [{ episode: 1, title: 'Pilot', rating: 8.9, itemId: 'tr-e1' }, { episode: 2, title: 'Two', rating: null, itemId: 'tr-e2' }] }]);
  await assert.rejects(() => episodeRatings('tr-matrix'), /for shows/);
});

test('Trakt two-way is opt-in: new columns default off; pushes need "push"; imports stay inside visible libraries', async () => {
  const other = getUser((await createUser({ username: 'tr-limited', password: 'pass1234', libraryIds: [] })).id);
  db.insert('trakt_accounts', { user_id: other.id, access_token: 'tok2', refresh_token: 'r', expires_at: new Date(Date.now() + 30 * 86400000).toISOString(), scrobble: 1 });
  const st = trakt.traktStatus(other.id);
  assert.equal(st.pull, false);
  assert.equal(st.push, false);
  posts.length = 0;
  items.setWatchlist(user, 'tr-show', false);
  db.run('UPDATE trakt_accounts SET push = 0 WHERE user_id = ?', user.id);
  items.setWatchlist(user, 'tr-show', true);
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(posts.filter((p) => p.path.startsWith('/trakt/sync/watchlist')).length, 1, 'only the change made while push was on');
  db.insert('libraries', { id: 'tr-none', name: 'None', type: 'movies', paths: '[]', created_at: iso });
  db.run("UPDATE items SET library_id = 'tr-none' WHERE id = 'tr-matrix'");
  const limited = getUser((await createUser({ username: 'tr-lib-only', password: 'pass1234', libraryIds: ['tr-lib'] })).id);
  db.insert('trakt_accounts', { user_id: limited.id, access_token: 'tok3', refresh_token: 'r', expires_at: new Date(Date.now() + 30 * 86400000).toISOString(), scrobble: 1 });
  const r = await trakt.pullFromTrakt(limited.id);
  assert.equal(db.get('SELECT 1 FROM user_data WHERE user_id = ? AND item_id = ?', limited.id, 'tr-matrix'), undefined, 'a movie in a library they cannot see is not imported');
  assert.equal(r.notInLibrary, 2);
  db.run("UPDATE items SET library_id = 'tr-lib' WHERE id = 'tr-matrix'");
});

test('MDBList keeps ratings an admin locked', async () => {
  db.run("UPDATE items SET locked_fields = '[\"ratings\"]', ratings = '{\"imdb\":1}', extra = '{}' WHERE id = 'tr-matrix'");
  await mdb.refreshAllMdbRatings();
  assert.deepEqual(JSON.parse(db.get<{ ratings: string }>("SELECT ratings FROM items WHERE id = 'tr-matrix'")!.ratings), { imdb: 1 });
});
