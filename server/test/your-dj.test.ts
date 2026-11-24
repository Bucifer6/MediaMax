// AI DJ phase: DJ rules (filters, presets, admin-enforced intersection, endless continuation), Your DJ sessions
// (segments, reasons, switch, requests without a model, cooldown, play attribution that keeps DJ picks out of
// "on repeat"), and the radio host's break planner (frequency, time budget, anti-repeat, no outbound requests unless
// weather / online facts are opted in). Outbound requests go to a stubbed fetch that counts them.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let fetches: string[] = [];
let fetchHeaders: Record<string, string>[] = [];
let onFetch: ((url: string) => Response) | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  fetches.push(url);
  fetchHeaders.push(Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])));
  if (onFetch) return onFetch(url);
  throw new Error('outbound request blocked by test');
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const { createUser, issueToken, getUser } = await import('../src/services/auth.ts');
const { getSettings, updateSettings } = await import('../src/services/settings.ts');
const { db } = await import('../src/db.ts');
const { buildApp } = await import('../src/app.ts');
const { ANALYSIS_VERSION } = await import('../src/services/dj/analysis.ts');
const { bus } = await import('../src/services/events.ts');
const { makeBreak, planBreak, introBudgetMs, wordCount } = await import('../src/services/dj/host/breaks.ts');
const { resetHostMemory } = await import('../src/services/dj/host/memory.ts');
const { trackInfo } = await import('../src/services/facts.ts');
const { resetWeatherCache } = await import('../src/services/weather.ts');
const { JOKES } = await import('../src/services/dj/host/jokes.ts');
const { intersectRules, normaliseRules } = await import('../src/services/dj/rules.ts');

const app = await buildApp();
after(() => app.close());

const admin = await createUser({ username: 'yd-admin', password: 'pass1234', isAdmin: true });
const viewer = await createUser({ username: 'yd-viewer', password: 'pass1234' });
const kid = await createUser({ username: 'yd-kid', password: 'pass1234' });
const tok = (id: string, d: string) => issueToken(id, { deviceId: d, deviceName: 'test', platform: 'web' }).token;
const A = { authorization: `Bearer ${tok(admin.id, 'yd-a')}` };
const V = { authorization: `Bearer ${tok(viewer.id, 'yd-v')}` };
const K = { authorization: `Bearer ${tok(kid.id, 'yd-k')}` };
const now = new Date().toISOString();
const ago = (d: number) => new Date(Date.now() - d * 86400000).toISOString();

/* ------------------------------ library ------------------------------ */
// 5 artists × 2 albums × 6 tracks = 60 tracks: Rock (A0, A1), Pop (A2, A3), Jazz (A4). Every 5th track is explicit.
const LIB = 'yd-lib';
db.run('INSERT INTO libraries (id, name, type, paths, created_at) VALUES (?, ?, ?, ?, ?)', LIB, 'Music', 'music', '[]', now);
const GENRE = ['Rock', 'Rock', 'Pop', 'Pop', 'Jazz'];
const tracks: { id: string; artist: number; genre: string; year: number; explicit: boolean; energy: number; bpm: number; dur: number }[] = [];
for (let a = 0; a < 5; a++) {
  db.run('INSERT INTO items (id, library_id, type, title, sort_title, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', `yd-ar${a}`, LIB, 'artist', `Artist ${a}`, `Artist ${a}`, ago(400), now);
  for (let b = 0; b < 2; b++) {
    const al = `yd-al${a}${b}`;
    const year = 1980 + a * 8 + b * 4;
    db.run('INSERT INTO items (id, library_id, type, title, sort_title, year, genres, parent_id, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', al, LIB, 'album', `Album ${a}${b}`, `Album ${a}${b}`, year, JSON.stringify([GENRE[a]]), `yd-ar${a}`, ago(400), now);
    for (let t = 0; t < 6; t++) {
      const n = tracks.length;
      const id = `yd-t${String(n).padStart(2, '0')}`;
      const explicit = n % 5 === 0;
      const dur = (150 + (n % 7) * 30) * 1000;
      tracks.push({ id, artist: a, genre: GENRE[a], year, explicit, energy: 0.2 + (n % 8) * 0.1, bpm: 80 + (n % 9) * 8, dur });
      db.run('INSERT INTO items (id, library_id, type, title, sort_title, year, genres, content_rating, parent_id, grandparent_id, idx, duration_ms, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, LIB, 'track', `Song ${n}`, `Song ${n}`, year, JSON.stringify([GENRE[a]]), explicit ? 'Explicit' : null, al, `yd-ar${a}`, t + 1, dur, n >= 54 ? ago(3) : ago(300), now);
      db.run('INSERT INTO media (id, item_id, path, duration_ms, mtime) VALUES (?, ?, ?, ?, ?)', `yd-m${n}`, id, `/music/yd/${n}.flac`, dur, 1);
      db.run(`INSERT INTO track_analysis (item_id, media_mtime, version, bpm, bpm_confidence, key_name, camelot, energy, cue_in_ms, cue_out_ms, intro_end_ms, duration_ms, analyzed_at)
        VALUES (?, 1, ?, ?, 0.9, 'C major', '8B', ?, 0, ?, 12000, ?, ?)`, id, ANALYSIS_VERSION, 80 + (n % 9) * 8, 0.2 + (n % 8) * 0.1, dur - 3000, dur, now);
    }
  }
}
const byId = new Map(tracks.map((t) => [t.id, t]));
// Listening history for the viewer: on repeat (last 30 days), throwbacks (heavy plays 200+ days ago), favourites.
const play = (user: string, item: string, at: string, source: string | null = null) =>
  db.run('INSERT INTO play_history (user_id, item_id, started_at, method, platform, source) VALUES (?, ?, ?, ?, ?, ?)', user, item, at, 'direct', 'web', source);
for (const n of [1, 2, 3, 4, 6, 7, 13, 14]) for (let k = 0; k < 4; k++) play(viewer.id, tracks[n].id, ago(2 + k));
for (const n of [20, 21, 22, 23, 24, 25]) for (let k = 0; k < 5; k++) play(viewer.id, tracks[n].id, ago(200 + k));
for (const n of [30, 31, 32, 33, 34]) db.run('INSERT INTO user_data (user_id, item_id, favorite, rating, play_count, last_played_at) VALUES (?, ?, 1, 9, 3, ?)', viewer.id, tracks[n].id, ago(150));

beforeEach(() => {
  fetches = [];
  fetchHeaders = [];
  onFetch = null;
});

const post = (url: string, headers: Record<string, string>, payload: unknown) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers, payload: payload as object });

/* ------------------------------ DJ rules ------------------------------ */

test('rules: normalise and intersect (enforced can only narrow)', () => {
  assert.deepEqual(normaliseRules({ includeGenres: ['Pop', '', 'Pop'], yearMin: '1990', bogus: 1, cleanOnly: 'yes', energyMax: 3 }), { includeGenres: ['Pop'], yearMin: 1990, energyMax: 1 });
  const r = intersectRules({ includeGenres: ['Rock', 'Pop'], yearMin: 1980, maxDurationSec: 600, excludeArtists: ['x'] }, { includeGenres: ['pop'], yearMin: 1990, cleanOnly: true, excludeArtists: ['y'] });
  assert.deepEqual(r.includeGenres, ['Pop']);
  assert.equal(r.yearMin, 1990);
  assert.equal(r.maxDurationSec, 600);
  assert.equal(r.cleanOnly, true);
  assert.deepEqual(r.excludeArtists, ['x', 'y']);
  assert.deepEqual(intersectRules({ includeGenres: ['Rock'] }, { includeGenres: ['Pop'] }).includeGenres, [], 'disjoint includes: nothing matches');
});

test('/dj/order and /dj/mix apply the rules (genres, artists, year, bpm, energy, clean, rating, length)', async () => {
  const order = async (rules: object, h = V) => (await post('/dj/order', h, { source: { type: 'library', id: LIB }, limit: 100, rules })).json() as { items: { id: string }[]; total: number };
  const all = await order({});
  assert.equal(all.total, 60);
  const noRock = await order({ excludeGenres: ['ROCK'] });
  assert.equal(noRock.total, 36);
  assert.ok(noRock.items.every((i) => byId.get(i.id)!.genre !== 'Rock'));
  const jazz = await order({ includeGenres: ['jazz'] });
  assert.ok(jazz.items.length === 12 && jazz.items.every((i) => byId.get(i.id)!.genre === 'Jazz'));
  const artists = await order({ includeArtists: ['artist 2', 'yd-ar3'], excludeArtists: ['Artist 3'] });
  assert.ok(artists.items.length === 12 && artists.items.every((i) => byId.get(i.id)!.artist === 2), 'names (any case) or ids');
  const years = await order({ yearMin: 1990, yearMax: 1999 });
  assert.ok(years.items.length > 0 && years.items.every((i) => byId.get(i.id)!.year >= 1990 && byId.get(i.id)!.year <= 1999));
  const clean = await order({ cleanOnly: true });
  assert.equal(clean.total, 48);
  assert.ok(clean.items.every((i) => !byId.get(i.id)!.explicit));
  const calm = await order({ energyMax: 0.45 });
  assert.ok(calm.items.length > 0 && calm.items.every((i) => byId.get(i.id)!.energy <= 0.45 + 1e-9));
  const tempo = await order({ bpmMin: 120, bpmMax: 130 });
  assert.ok(tempo.items.every((i) => { const b = byId.get(i.id)!.bpm; return [b, b * 2, b / 2].some((x) => x >= 120 && x <= 130); }));
  const rated = await order({ minRating: 8 });
  assert.deepEqual(rated.items.map((i) => i.id).sort(), [30, 31, 32, 33, 34].map((n) => tracks[n].id));
  const short = await order({ maxDurationSec: 200 });
  assert.ok(short.items.length > 0 && short.items.every((i) => byId.get(i.id)!.dur <= 200000));
  // Mix with rules (and its continuous top-ups) stays in bounds too.
  const mix = (await post('/dj/mix', V, { count: 10, rules: { includeGenres: ['Pop'] } })).json();
  assert.ok(mix.tracks.length > 0 && mix.tracks.every((t: { item: { id: string } }) => byId.get(t.item.id)!.genre === 'Pop'));
  assert.deepEqual(mix.request.rules, { includeGenres: ['Pop'] }, 'rules travel with the resolved request for top-ups');
});

test('presets in preferences; GET /dj/rules; admin-enforced restrictions intersect everywhere (endless too)', async () => {
  // A preset saved in preferences is the default for every request.
  const me = await app.inject({ method: 'PATCH', url: '/api/v1/auth/me', headers: V, payload: { preferences: { djRules: { activePresetId: 'chill', presets: [{ id: 'chill', name: 'Chill', rules: { energyMax: 0.45, junk: 1 } }, { id: 'jazz', name: 'Jazz', rules: { includeGenres: ['Jazz'] } }] } } } });
  assert.equal(me.statusCode, 200);
  assert.deepEqual(me.json().preferences.djRules.presets[0].rules, { energyMax: 0.45 });
  const r = (await app.inject({ url: '/api/v1/dj/rules', headers: V })).json();
  assert.deepEqual(r.effective, { energyMax: 0.45 });
  assert.equal(r.activePresetId, 'chill');
  const viaPreset = (await post('/dj/order', V, { source: { type: 'library', id: LIB }, limit: 100 })).json();
  assert.ok(viaPreset.items.every((i: { id: string }) => byId.get(i.id)!.energy <= 0.45 + 1e-9));
  const other = (await post('/dj/order', V, { source: { type: 'library', id: LIB }, limit: 100, presetId: 'jazz' })).json();
  assert.ok(other.items.length === 12 && other.items.every((i: { id: string }) => byId.get(i.id)!.genre === 'Jazz'));
  await app.inject({ method: 'PATCH', url: '/api/v1/auth/me', headers: V, payload: { preferences: { djRules: { activePresetId: null, presets: [] } } } });

  // Admin-only endpoints.
  assert.equal((await app.inject({ method: 'PUT', url: `/api/v1/users/${kid.id}/dj-restrictions`, headers: V, payload: {} })).statusCode, 403);
  assert.equal((await app.inject({ url: `/api/v1/users/nobody/dj-restrictions`, headers: A })).statusCode, 404);
  const put = await app.inject({ method: 'PUT', url: `/api/v1/users/${kid.id}/dj-restrictions`, headers: A, payload: { includeGenres: ['Pop'], cleanOnly: true } });
  assert.deepEqual(put.json(), { includeGenres: ['Pop'], cleanOnly: true });
  const kr = (await app.inject({ url: '/api/v1/dj/rules', headers: K })).json();
  assert.deepEqual(kr.enforced, { includeGenres: ['Pop'], cleanOnly: true });
  const okKid = (ids: string[]) => ids.length > 0 && ids.every((id) => byId.get(id)!.genre === 'Pop' && !byId.get(id)!.explicit);
  // The kid's own rules can't loosen it: asking for Rock gives nothing; narrowing works.
  const loosen = (await post('/dj/order', K, { source: { type: 'library', id: LIB }, limit: 100, rules: { includeGenres: ['Rock', 'Pop'] } })).json();
  assert.ok(okKid(loosen.items.map((i: { id: string }) => i.id)));
  const rock = (await post('/dj/order', K, { source: { type: 'library', id: LIB }, rules: { includeGenres: ['Rock'] } })).json();
  assert.equal(rock.items.length, 0);
  // A queue with forbidden tracks in it: they are left out.
  const q = (await post('/dj/order', K, { itemIds: tracks.map((t) => t.id) })).json();
  assert.ok(okKid(q.items.map((i: { id: string }) => i.id)));
  // Endless continuation (/dj/mix with history + count) respects it on every top-up.
  let history: string[] = [];
  for (let k = 0; k < 3; k++) {
    const m = (await post('/dj/mix', K, { history, count: 5 })).json();
    const ids = m.tracks.map((t: { item: { id: string } }) => t.item.id);
    assert.ok(okKid(ids), `top-up ${k}`);
    history = [...history, ...ids];
  }
  // Clearing: {} = none.
  await app.inject({ method: 'PUT', url: `/api/v1/users/${kid.id}/dj-restrictions`, headers: A, payload: {} });
  assert.deepEqual((await app.inject({ url: `/api/v1/users/${kid.id}/dj-restrictions`, headers: A })).json(), {});
  await app.inject({ method: 'PUT', url: `/api/v1/users/${kid.id}/dj-restrictions`, headers: A, payload: { includeGenres: ['Pop'], cleanOnly: true } });
});

/* ------------------------------ Your DJ ------------------------------ */

test('Your DJ: a session opens with On repeat, 4–6 tracks with reasons; switch picks another kind; more moves on', async () => {
  const s = (await post('/dj/session', V, { hour: 9 })).json();
  assert.equal(s.segment.kind, 'on-repeat');
  assert.ok(s.items.length >= 4 && s.items.length <= 6, `batch of ${s.items.length}`);
  for (const it of s.items) {
    assert.ok([1, 2, 3, 4, 6, 7, 13, 14].map((n) => tracks[n].id).includes(it.id), 'from the on-repeat plays');
    assert.match(s.reasons[it.id], /played this 4 times this month/);
    assert.ok(it.id in s.analyses);
  }
  assert.ok(!s.intro || typeof s.intro.text === 'string');
  if (s.intro) assert.equal(s.intro.audioUrl, null, 'no server voice configured: device speech');
  const history = s.items.map((i: { id: string }) => i.id);
  const sw = (await post(`/dj/session/${s.id}/switch`, V, { history })).json();
  assert.notEqual(sw.segment.kind, 'on-repeat');
  assert.ok(sw.items.length >= 4);
  assert.ok(sw.items.every((i: { id: string }) => !history.includes(i.id)), 'never repeats within the session');
  const sw2 = (await post(`/dj/session/${s.id}/switch`, V, { history: [...history, ...sw.items.map((i: { id: string }) => i.id)] })).json();
  assert.notEqual(sw2.segment.kind, sw.segment.kind);
  const more = (await post(`/dj/session/${s.id}/more`, V, { history })).json();
  assert.ok(more.items.length >= 1);
  assert.equal((await post('/dj/session/nope/more', V, {})).statusCode, 404);
  // Sessions are per user.
  assert.equal((await post(`/dj/session/${s.id}/more`, K, {})).statusCode, 404);
  const chips = (await app.inject({ url: '/api/v1/dj/session/suggestions?hour=8', headers: V })).json().chips;
  assert.equal(chips.length, 3);
  assert.ok(chips.includes('Easy morning'));
});

test('Your DJ: requests are understood without a model and stay within the rules; misses are gentle', async () => {
  const s = (await post('/dj/session', V, {})).json();
  const r = (await post(`/dj/session/${s.id}/request`, V, { text: 'some jazz please', history: [] })).json();
  assert.equal(r.segment.kind, 'request');
  assert.ok(r.items.length >= 1 && r.items.every((i: { id: string }) => byId.get(i.id)!.genre === 'Jazz'));
  assert.ok(Object.values(r.reasons).every((x) => /asked/i.test(String(x))));
  assert.equal(fetches.length, 0, 'no model configured: no outbound request');
  // The kid asks for rock: nothing within the enforced rules → ok:false with a gentle message.
  const ks = (await post('/dj/session', K, {})).json();
  assert.ok(ks.items.every((i: { id: string }) => byId.get(i.id)!.genre === 'Pop' && !byId.get(i.id)!.explicit), 'kid session within restrictions');
  const miss = await post(`/dj/session/${ks.id}/request`, K, { text: 'hard rock', history: [] });
  assert.equal(miss.statusCode, 200);
  assert.equal(miss.json().ok, false);
  assert.match(miss.json().message, /DJ rules/);
  // Switching for the kid stays in bounds as well.
  const ksw = (await post(`/dj/session/${ks.id}/switch`, K, { history: ks.items.map((i: { id: string }) => i.id) })).json();
  assert.ok(ksw.items.every((i: { id: string }) => byId.get(i.id)!.genre === 'Pop' && !byId.get(i.id)!.explicit));
  assert.equal((await post(`/dj/session/${s.id}/request`, V, { text: '' })).statusCode, 400);
});

test('Your DJ: tracks it played cool down; its plays are flagged and excluded from on-repeat and stats', async () => {
  db.run('DELETE FROM dj_served WHERE user_id = ?', viewer.id); // earlier tests' sessions
  const s1 = (await post('/dj/session', V, {})).json();
  const first = s1.items.map((i: { id: string }) => i.id);
  // A playback of a served track becomes a Your DJ play (play_history.source = 'yourdj').
  const h = db.run('INSERT INTO play_history (user_id, item_id, started_at, method, platform) VALUES (?, ?, ?, ?, ?)', viewer.id, first[0], now, 'direct', 'web');
  bus.emit('playback.start', { ctx: { user: { id: viewer.id } }, itemId: first[0], historyId: Number(h.lastInsertRowid) });
  assert.equal(db.get<{ source: string }>('SELECT source FROM play_history WHERE id = ?', Number(h.lastInsertRowid))!.source, 'yourdj');
  // The same track played again later (not handed out again) is the listener's own choice.
  const h2 = db.run('INSERT INTO play_history (user_id, item_id, started_at, method, platform) VALUES (?, ?, ?, ?, ?)', viewer.id, first[0], now, 'direct', 'web');
  bus.emit('playback.start', { ctx: { user: { id: viewer.id } }, itemId: first[0], historyId: Number(h2.lastInsertRowid) });
  assert.equal(db.get<{ source: string | null }>('SELECT source FROM play_history WHERE id = ?', Number(h2.lastInsertRowid))!.source, null);
  // Many DJ plays of a never-chosen track don't make it "on repeat" nor count as listens.
  for (let k = 0; k < 6; k++) play(viewer.id, tracks[50].id, ago(1), 'yourdj');
  const vUser = getUser(viewer.id);
  assert.equal(trackInfo(vUser, tracks[50].id)!.plays, 0);
  // A new session: on repeat again, but nothing served in the last 7 days comes back while others are left.
  const s2 = (await post('/dj/session', V, {})).json();
  assert.ok(!s2.items.some((i: { id: string }) => i.id === tracks[50].id));
  if (s2.segment.kind === 'on-repeat') assert.ok(s2.items.every((i: { id: string }) => !first.includes(i.id)), 'cooldown');
});

/* ------------------------------ breaks ------------------------------ */

const vUser = () => getUser(viewer.id);
const seq = (...xs: number[]) => {
  let i = 0;
  return () => xs[Math.min(i++, xs.length - 1)];
};

test('breaks: radio host off by default; most transitions quiet; budget fits the intro', async () => {
  resetHostMemory();
  // Off by default (per user): the endpoint answers null.
  const off = (await post('/dj/break', V, { mode: 'radio', nextItemId: tracks[1].id, tracksSinceBreak: 9, msSinceBreak: 3600000 })).json();
  assert.deepEqual(off, { break: null });
  await app.inject({ method: 'PATCH', url: '/api/v1/auth/me', headers: V, payload: { preferences: { radioHost: { enabled: true, chattiness: 'light', categories: { jokes: true } } } } });
  const u = vUser();
  assert.equal(u.preferences.radioHost!.enabled, true);
  assert.equal(u.preferences.radioHost!.categories.time, true, 'categories default on');
  // Right after a break: quiet, whatever the dice say.
  assert.equal(await planBreak({ user: u, req: { mode: 'radio', previousItemId: tracks[0].id, nextItemId: tracks[1].id, tracksSinceBreak: 0, msSinceBreak: 0, minute: 15 }, rng: () => 0 }), null);
  // Due but the dice say "let one more go by".
  assert.equal(await planBreak({ user: u, req: { mode: 'radio', previousItemId: tracks[0].id, nextItemId: tracks[1].id, tracksSinceBreak: 3, msSinceBreak: 10 * 60000, minute: 15 }, rng: () => 0.99 }), null);
  // Frequency over many transitions at light: well under half talk.
  let talks = 0;
  for (let k = 0; k < 40; k++) {
    const p = await planBreak({ user: u, req: { mode: 'radio', previousItemId: tracks[k % 60].id, nextItemId: tracks[(k + 1) % 60].id, tracksSinceBreak: k % 4, msSinceBreak: (k % 4) * 200000, minute: 15 } });
    if (p) talks++;
  }
  assert.ok(talks <= 12, `light host talked ${talks}/40 times`);
  // Over a 5 s intro: at most 4 s (intro − 1 s) ≈ 12 words, placed over the intro.
  assert.equal(introBudgetMs(5000), 4000);
  assert.equal(introBudgetMs(2500), null);
  assert.equal(introBudgetMs(30000), 10000);
  const b = await makeBreak({ user: u, req: { mode: 'radio', previousItemId: tracks[0].id, nextItemId: tracks[1].id, tracksSinceBreak: 5, msSinceBreak: 20 * 60000, introMs: 5000, minute: 15 }, rng: seq(0, 0.9, 0.9, 0.9, 0.5) });
  assert.ok(b);
  assert.equal(b!.placement, 'over-intro');
  assert.equal(b!.maxMs, 4000);
  assert.ok(wordCount(b!.text) <= 12, b!.text);
  assert.match(b!.text, /Song 1/);
  assert.equal(b!.audioUrl, null, 'device speech');
  assert.equal(b!.by, 'template');
  // No intro window: in the gap / over the outro.
  const g = await makeBreak({ user: u, req: { mode: 'radio', previousItemId: tracks[2].id, nextItemId: tracks[3].id, tracksSinceBreak: 5, msSinceBreak: 20 * 60000, minute: 15 }, rng: seq(0, 0.9, 0.9, 0.9, 0.5) });
  assert.ok(g && (g.placement === 'over-outro' || g.placement === 'gap'));
  assert.ok(g!.durationMs === null && g!.maxMs <= 10000);
  assert.equal(fetches.length, 0, 'nothing configured: no outbound requests');
});

test('breaks: never repeat within a session; jokes rotate and full breaks are capped per hour', async () => {
  resetHostMemory();
  await app.inject({ method: 'PATCH', url: '/api/v1/auth/me', headers: V, payload: { preferences: { radioHost: { enabled: true, chattiness: 'chatty', categories: { jokes: true, facts: true, time: false, weather: false } } } } });
  const u = vUser();
  const texts: string[] = [];
  let full = 0;
  const jokes: string[] = [];
  for (let k = 0; k < 12; k++) {
    const b = await makeBreak({ user: u, req: { mode: 'radio', previousItemId: tracks[k].id, nextItemId: tracks[k + 1].id, tracksSinceBreak: 4, msSinceBreak: 600000, minute: 15 }, rng: () => 0.01 });
    if (!b) continue;
    texts.push(b.text);
    if (b.kind === 'full') {
      full++;
      assert.equal(b.placement, 'gap');
      assert.ok(b.maxMs <= 45000);
      const j = JOKES.find((x) => b.text.includes(x));
      if (j) jokes.push(j);
    }
  }
  assert.ok(texts.length >= 8);
  assert.equal(new Set(texts).size, texts.length, 'no break repeated');
  assert.equal(full, 3, 'chatty: at most 3 full breaks an hour');
  assert.equal(new Set(jokes).size, jokes.length, 'no joke twice');
  // Persisted per listener: a new listening session doesn't retell those jokes.
  const logged = db.all<{ key: string }>("SELECT key FROM dj_host_log WHERE user_id = ? AND kind = 'joke'", viewer.id).length;
  assert.equal(logged, jokes.length);
  assert.equal(fetches.length, 0);
});

test('breaks: time checks near the hour; weather and online facts only when opted in (cached, polite)', async () => {
  resetHostMemory();
  resetWeatherCache();
  await app.inject({ method: 'PATCH', url: '/api/v1/auth/me', headers: V, payload: { preferences: { radioHost: { enabled: true, chattiness: 'light', categories: { weather: true, time: true, facts: true, jokes: false } } } } });
  const u = vUser();
  const req = (minute: number) => ({ mode: 'radio' as const, previousItemId: tracks[5].id, nextItemId: tracks[8].id, tracksSinceBreak: 1, msSinceBreak: 60000, minute, hour: 9 });
  // Not due by count/time, but a time check near the top of the hour is: the host says the time.
  const t = await makeBreak({ user: u, req: req(58), rng: () => 0.9 });
  assert.ok(t && /ten o'clock/i.test(t.text), t?.text);
  assert.equal(fetches.length, 0, 'weather not configured: no request');
  // Admin opts in: weather location + online facts.
  updateSettings({ ai: { ...getSettings().ai!, weatherLocation: { name: 'Testville', lat: 44.43, lon: 26.1 }, onlineFacts: true } });
  onFetch = (url) => {
    if (url.startsWith('https://api.open-meteo.com/')) return new Response(JSON.stringify({ current: { temperature_2m: 13.6, weather_code: 61 } }), { headers: { 'content-type': 'application/json' } });
    if (url.startsWith('https://musicbrainz.org/ws/2/artist?')) return new Response(JSON.stringify({ artists: [{ id: 'mb-1', name: 'Artist 0', score: 100 }] }), { headers: { 'content-type': 'application/json' } });
    if (url.startsWith('https://musicbrainz.org/ws/2/artist/mb-1')) return new Response(JSON.stringify({ id: 'mb-1', type: 'Group', 'begin-area': { name: 'Leeds' }, 'life-span': { begin: '1994' }, relations: [] }), { headers: { 'content-type': 'application/json' } });
    return new Response('not found', { status: 404 });
  };
  resetHostMemory();
  const w = await makeBreak({ user: u, req: { ...req(0), tracksSinceBreak: 5, msSinceBreak: 20 * 60000 }, rng: seq(0, 0.9, 0.9, 0.9, 0.9, 0.9) });
  assert.ok(w && /Testville/.test(w.text) && /14 degrees/.test(w.text), w?.text);
  assert.equal(fetches.filter((f) => f.startsWith('https://api.open-meteo.com/')).length, 1);
  assert.match(fetches.find((f) => f.includes('open-meteo'))!, /latitude=44.43&longitude=26.1/);
  // MusicBrainz was asked politely (identifying UA, no contact details) for the next track's artist.
  const mbi = fetches.findIndex((f) => f.startsWith('https://musicbrainz.org/'));
  assert.ok(mbi >= 0);
  assert.match(fetchHeaders[mbi]['user-agent'], /^Vibe\/[\w.+-]+ \(self-hosted media server\)$/);
  // Cached: weather is not fetched again within 30 minutes, artist facts not again at all.
  fetches = [];
  resetHostMemory();
  const w2 = await makeBreak({ user: u, req: { ...req(1), tracksSinceBreak: 5, msSinceBreak: 20 * 60000 }, rng: seq(0, 0.9, 0.9, 0.9, 0.9, 0.9) });
  assert.ok(w2);
  assert.equal(fetches.length, 0, `cached, got ${fetches.join(', ')}`);
  const f = db.get<{ data: string }>("SELECT data FROM dj_cache WHERE key = 'mb:artist:artist 0'");
  assert.match(f!.data, /Leeds/);
  // Opt out again: no more requests.
  updateSettings({ ai: { ...getSettings().ai!, weatherLocation: null, onlineFacts: false } });
  resetWeatherCache();
  fetches = [];
  await makeBreak({ user: u, req: { ...req(0), tracksSinceBreak: 5, msSinceBreak: 20 * 60000 }, rng: () => 0 });
  assert.equal(fetches.length, 0);
});

test('breaks: Your DJ commentary (off / intros / full) and segment intros', async () => {
  resetHostMemory();
  const s = (await post('/dj/session', V, {})).json();
  const first = s.items[0].id;
  await app.inject({ method: 'PATCH', url: '/api/v1/auth/me', headers: V, payload: { preferences: { yourDj: { commentary: 'off' } } } });
  assert.equal(await makeBreak({ user: vUser(), req: { mode: 'yourdj', sessionId: s.id, nextItemId: s.items[1].id, tracksSinceBreak: 9, msSinceBreak: 3600000 }, rng: () => 0 }), null);
  await app.inject({ method: 'PATCH', url: '/api/v1/auth/me', headers: V, payload: { preferences: { yourDj: { commentary: 'intros' } } } });
  const seg = { id: 'x', kind: 'genre' as const, title: 'Jazz', reason: 'Because you like Jazz' };
  const intro = await makeBreak({ user: vUser(), req: { mode: 'yourdj', sessionId: s.id, nextItemId: first, tracksSinceBreak: 0, msSinceBreak: 0, introMs: 20000 }, segmentStart: seg, rng: () => 0 });
  assert.ok(intro && intro.kind === 'segment-intro' && /jazz/i.test(intro.text));
  assert.equal(await makeBreak({ user: vUser(), req: { mode: 'yourdj', sessionId: s.id, nextItemId: s.items[1].id, tracksSinceBreak: 9, msSinceBreak: 3600000 }, rng: () => 0 }), null, 'intros only');
  const http = await post('/dj/break', V, { mode: 'yourdj', sessionId: s.id, nextItemId: s.items[1].id, tracksSinceBreak: 1, msSinceBreak: 1000 });
  assert.equal(http.statusCode, 200);
  assert.equal((await post('/dj/break', V, { mode: 'nope', nextItemId: first })).statusCode, 400);
  await app.inject({ method: 'PATCH', url: '/api/v1/auth/me', headers: V, payload: { preferences: { yourDj: { commentary: 'full' } } } });
});

test('breaks: the language model rewrites only grounded text (invented numbers are rejected → templates)', async () => {
  resetHostMemory();
  await app.inject({ method: 'PATCH', url: '/api/v1/auth/me', headers: V, payload: { preferences: { radioHost: { enabled: true, chattiness: 'chatty', categories: { time: false, weather: false, jokes: false } } } } });
  updateSettings({ ai: { ...getSettings().ai!, llmProviders: [{ id: 'loc', name: 'Local', kind: 'openai', url: 'http://llm.test/v1', model: 'm', enabled: true }] as never } });
  let reply = 'Here is Song 9, it hit number 1 in 1977!';
  onFetch = () => new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), { headers: { 'content-type': 'application/json' } });
  const req = { mode: 'radio' as const, previousItemId: tracks[8].id, nextItemId: tracks[9].id, tracksSinceBreak: 5, msSinceBreak: 20 * 60000, minute: 15 };
  const bad = await makeBreak({ user: vUser(), req, rng: seq(0, 0.9, 0.9, 0.9, 0.9) });
  assert.equal(bad!.by, 'template', 'invented chart facts are rejected');
  assert.ok(!/1977/.test(bad!.text));
  const { resetChainState } = await import('../src/services/ai/chain.ts');
  resetChainState();
  resetHostMemory();
  reply = 'Lovely stuff there. Coming up next, Song 9 by Artist 0.';
  const good = await makeBreak({ user: vUser(), req, rng: seq(0, 0.9, 0.9, 0.9, 0.9) });
  assert.equal(good!.by, 'llm');
  assert.equal(good!.text, reply);
  // The model only ever saw the talking points and facts, not the library.
  const sent = fetches.filter((f) => f.startsWith('http://llm.test/'));
  assert.ok(sent.length >= 1);
  updateSettings({ ai: { ...getSettings().ai!, llmProviders: [] } });
});
