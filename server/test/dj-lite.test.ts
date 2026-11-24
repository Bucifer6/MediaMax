// Lite DJ (automix in the normal player): cue points in the analysis, POST /dj/transitions, POST /dj/order, and
// the guarantee that analysis and every lite endpoint stay local (no outbound requests, even with AI configured).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ffmpeg = process.env.MEDIAMAX_FFMPEG ?? 'ffmpeg';
const hasFfmpeg = spawnSync(ffmpeg, ['-version']).status === 0;

// Every outbound request fails the test: count them, and throw like an unreachable network would.
const realFetch = globalThis.fetch;
let fetches: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  fetches.push(String(input instanceof Request ? input.url : input));
  throw new Error('outbound request blocked by test');
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const { createUser, issueToken } = await import('../src/services/auth.ts');
const { getSettings, updateSettings } = await import('../src/services/settings.ts');
const { db } = await import('../src/db.ts');
const { buildApp } = await import('../src/app.ts');
const { trackCues } = await import('../src/services/dj/phrases.ts');

const app = await buildApp();
after(() => app.close());

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-djlite-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const admin = await createUser({ username: 'djl-admin', password: 'pass1234', isAdmin: true });
const viewer = await createUser({ username: 'djl-viewer', password: 'pass1234' });
const tok = (id: string, d: string) => issueToken(id, { deviceId: d, deviceName: 'test', platform: 'web' }).token;
const A = { authorization: `Bearer ${tok(admin.id, 'djl-a')}` };
const V = { authorization: `Bearer ${tok(viewer.id, 'djl-v')}` };
const now = new Date().toISOString();

/** A short dance loop: kick on the beat, off-beat hats and a triad pad; intro of 4 bars without drums. */
function track(file: string, bpm: number, chord: number[], seconds = 36) {
  const B = (60 / bpm).toFixed(6);
  const d0 = 0.25;
  const tt = `(t-${d0})`;
  const x = `mod(${tt},${B})`;
  const intro = `gte(${tt},${(16 * Number(B)).toFixed(4)})`;
  const kick = `0.7*sin(2*PI*(48*${x}+5*(1-exp(-25*${x}))))*exp(-9*${x})*gte(${tt},0)*${intro}`;
  const hat = `0.08*(random(0)*2-1)*exp(-80*mod(${tt}+${B}/2,${B}))*gte(${tt},0)`;
  const pad = chord.map((f) => `sin(2*PI*${f}*t)`).join('+');
  const expr = `0.6*(${kick}+${hat}+0.06*(${pad}))*min(1,t)*min(1,(${seconds}-t)/3)`;
  const r = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=22050:d=${seconds}`, '-ac', '1', '-c:a', 'pcm_s16le', file]);
  if (r.status !== 0) throw new Error(String(r.stderr));
}

const LIB = 'djl-lib';
const HIDDEN = 'djl-hidden';
db.run('INSERT INTO libraries (id, name, type, paths, created_at) VALUES (?, ?, ?, ?, ?)', LIB, 'Music', 'music', JSON.stringify([tmp]), now);
db.run('INSERT INTO libraries (id, name, type, paths, created_at) VALUES (?, ?, ?, ?, ?)', HIDDEN, 'Private', 'music', JSON.stringify([path.join(tmp, 'private')]), now);
db.run('UPDATE users SET library_ids = ? WHERE id = ?', JSON.stringify([LIB]), viewer.id);
db.insert('items', { id: 'djl-artist', library_id: LIB, type: 'artist', title: 'Synth Unit', sort_title: 'synth unit', added_at: now, updated_at: now });
db.insert('items', { id: 'djl-album', library_id: LIB, type: 'album', title: 'Loops', sort_title: 'loops', parent_id: 'djl-artist', added_at: now, updated_at: now });
const n = (s: number) => 220 * Math.pow(2, s / 12);
const TRACKS: [string, number, number[], string][] = [
  ['djl-t1', 124, [n(0), n(3), n(7)], 'a'], // A minor
  ['djl-t2', 126, [n(3), n(7), n(10)], 'a'], // C major
  ['djl-t3', 122, [n(-2), n(2), n(5)], 'b'], // G major
  ['djl-t4', 128, [n(0), n(3), n(7)], 'b'],
];
function addTrack(id: string, lib: string, file: string, ms = 36000, extra: Record<string, unknown> = {}) {
  db.insert('items', { id, library_id: lib, type: 'track', title: id, sort_title: id, parent_id: 'djl-album', grandparent_id: 'djl-artist', genres: '["House"]', duration_ms: ms, added_at: now, updated_at: now, ...extra });
  db.insert('media', { id: `${id}-m`, item_id: id, path: file, container: 'wav', duration_ms: ms, size: 1, mtime: 1 });
}
if (hasFfmpeg) {
  for (const [id, bpm, chord, dir] of TRACKS) {
    fs.mkdirSync(path.join(tmp, dir), { recursive: true });
    const f = path.join(tmp, dir, `${id}.wav`);
    track(f, bpm, chord);
    addTrack(id, LIB, f);
  }
  fs.mkdirSync(path.join(tmp, 'private'), { recursive: true });
  const p = path.join(tmp, 'private', 'secret.wav');
  track(p, 120, [n(0), n(4), n(7)]);
  addTrack('djl-secret', HIDDEN, p);
  // Undecodable file and a file too short to analyse.
  const bad = path.join(tmp, 'a', 'broken.mp3');
  fs.writeFileSync(bad, 'not audio at all');
  addTrack('djl-broken', LIB, bad);
  db.insert('items', { id: 'djl-playlist', library_id: null, type: 'playlist', title: 'Mine', sort_title: 'mine', owner_id: viewer.id, added_at: now, updated_at: now });
  for (const [i, id] of ['djl-t3', 'djl-t1', 'djl-t2'].entries()) db.insert('collection_items', { collection_id: 'djl-playlist', item_id: id, sort: i });
}

// Configure every third-party service the Advanced DJ could use: the lite paths must still never reach them.
updateSettings({
  ai: { ...getSettings().ai!, llm: { ...getSettings().ai!.llm, provider: 'openai', url: 'http://llm.invalid/v1', model: 'm', apiKey: 'sk-test', maxRequestsPerDay: 100 } },
  aiDj: { ...getSettings().aiDj, tts: { ...getSettings().aiDj.tts, provider: 'openai', url: 'http://tts.invalid/v1' } },
});

const skip = !hasFfmpeg && 'ffmpeg not installed';

test('analysis gives automix cue points, analyses on demand, and returns null for undecodable files', { skip }, async () => {
  fetches = [];
  const r = await app.inject({ url: '/api/v1/items/djl-t1/analysis', headers: V });
  assert.equal(r.statusCode, 200);
  const a = r.json();
  assert.ok(a.bpm && Math.abs(a.bpm - 124) < 0.5, `bpm ${a.bpm}`);
  assert.equal(a.camelot, '8A');
  // The beat grid sits on the kick (d0 = 250 ms), not the off-beat hi-hat half a beat later.
  const beat = 60000 / 124;
  const off = (((a.beatOffsetMs - 250) % beat) + beat) % beat;
  assert.ok(Math.min(off, beat - off) < 45, `beat grid ${a.beatOffsetMs} ms is ${off.toFixed(0)} ms off the kick`);
  const c = a.cues;
  assert.ok(c, 'cues present');
  assert.ok(['outro', 'phrase', 'loudness', 'fallback'].includes(c.source));
  assert.ok(c.mixInMs >= a.cueInMs && c.mixInMs < c.mixOutMs && c.mixOutMs < c.endMs && c.endMs === a.cueOutMs, JSON.stringify(c));
  assert.ok(c.mixOutMs >= a.cueInMs + Math.min(30000, (a.cueOutMs - a.cueInMs) / 3) - 1, 'mix-out not in the first third');
  if (c.introEndMs != null) assert.ok(c.introEndMs > c.mixInMs && c.introEndMs <= c.mixOutMs);
  // Undecodable: 200 with a null body, and the failure is remembered (no second decode until the file changes).
  const bad = await app.inject({ url: '/api/v1/items/djl-broken/analysis', headers: V });
  assert.equal(bad.statusCode, 200);
  assert.equal(bad.body, 'null');
  const first = db.get<{ analyzed_at: string }>('SELECT analyzed_at FROM track_analysis WHERE item_id = ?', 'djl-broken')!.analyzed_at;
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await app.inject({ url: '/api/v1/items/djl-broken/analysis', headers: V })).body, 'null');
  assert.equal(db.get<{ analyzed_at: string }>('SELECT analyzed_at FROM track_analysis WHERE item_id = ?', 'djl-broken')!.analyzed_at, first, 'not re-analysed');
  // Hidden library: not found.
  assert.equal((await app.inject({ url: '/api/v1/items/djl-secret/analysis', headers: V })).statusCode, 404);
  assert.deepEqual(fetches, []);
});

test('cue points fall back sensibly without phrases or a beat', () => {
  const base = { itemId: 'x', bpmConfidence: 0, timbre: null, key: null, camelot: null, energy: 0.5, loudnessDb: -12, analyzedAt: '' };
  const noBeat = trackCues({ ...base, bpm: null, beatOffsetMs: null, cueInMs: 1200, cueOutMs: 200000, introEndMs: null, outroStartMs: null, durationMs: 203000 });
  assert.deepEqual(noBeat, { mixInMs: 1200, introEndMs: null, mixOutMs: 190000, endMs: 200000, source: 'fallback' });
  const loud = trackCues({ ...base, bpm: 120, beatOffsetMs: 100, cueInMs: 0, cueOutMs: 180000, introEndMs: 15000, outroStartMs: 165300, durationMs: 180000 });
  assert.equal(loud.source, 'loudness');
  assert.equal((loud.mixOutMs - 100) % 2000, 0, 'snapped to a bar');
  assert.equal(loud.introEndMs, 15000);
  // A very short track: mix-out still after mix-in and before the end.
  const short = trackCues({ ...base, bpm: 128, beatOffsetMs: 50, cueInMs: 0, cueOutMs: 9000, introEndMs: null, outroStartMs: null, durationMs: 9000 });
  assert.ok(short.mixInMs <= short.mixOutMs && short.mixOutMs <= short.endMs, JSON.stringify(short));
});

test('POST /dj/transitions: stored analyses only, access-checked, validated', { skip }, async () => {
  fetches = [];
  // Analyse t2 (t1 already is); t3 stays unanalysed.
  await app.inject({ url: '/api/v1/items/djl-t2/analysis', headers: V });
  const before = db.get<{ n: number }>('SELECT COUNT(*) n FROM track_analysis')!.n;
  const r = await app.inject({
    method: 'POST', url: '/api/v1/dj/transitions', headers: V,
    payload: { pairs: [{ from: 'djl-t1', to: 'djl-t2' }, { from: 'djl-t2', to: 'djl-t3' }, { from: 'djl-t1', to: 'djl-secret' }, { from: 'djl-t1', to: 'nope' }, { from: 'djl-album', to: 'djl-t1' }], transitions: 'smooth', maxStretchPct: 99 },
  });
  assert.equal(r.statusCode, 200);
  const t = r.json().transitions;
  assert.equal(t.length, 5);
  assert.equal(t[0].style, 'blend', JSON.stringify(t[0]));
  assert.ok(Math.abs(t[0].tempoRatio - 124 / 126) < 0.003, `tempo ratio ${t[0].tempoRatio}`);
  assert.equal(t[1].style, 'fade');
  assert.match(t[1].reason, /Not analysed/);
  assert.deepEqual(t.slice(2), [null, null, null], 'hidden, unknown and non-track ids are null');
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) n FROM track_analysis')!.n, before, 'no on-demand analysis');
  const tooMany = Array.from({ length: 51 }, () => ({ from: 'djl-t1', to: 'djl-t2' }));
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/dj/transitions', headers: V, payload: { pairs: tooMany } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/dj/transitions', headers: V, payload: { pairs: [{ from: 1, to: 'djl-t1' }] } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/dj/transitions', headers: V, payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/dj/transitions', payload: { pairs: [] } })).statusCode, 401);
  assert.deepEqual(fetches, []);
});

test('POST /dj/order: sources and id lists in a mix order, no repeats, paged, access-checked', { skip }, async () => {
  fetches = [];
  const order = (payload: object, h = V) => app.inject({ method: 'POST', url: '/api/v1/dj/order', headers: h, payload });
  const all = await order({ source: { type: 'library', id: LIB }, limit: 2 });
  assert.equal(all.statusCode, 200);
  const j = all.json();
  assert.equal(j.items.length, 2);
  assert.equal(j.total, 5, 'four tracks and the broken file');
  assert.equal(j.remaining, 3);
  assert.ok(j.items.every((i: { id: string }) => i.id in j.analyses));
  assert.ok(Object.values(j.analyses).every((a: any) => a == null || (a.timbre === null && a.cues)));
  const more = (await order({ source: { type: 'library', id: LIB }, limit: 10, history: j.items.map((i: { id: string }) => i.id) })).json();
  const ids = [...j.items, ...more.items].map((i: { id: string }) => i.id);
  assert.equal(new Set(ids).size, ids.length, 'no repeats across pages');
  assert.equal(ids.length, 5);
  assert.equal(more.remaining, 0);
  for (const [src, want] of [
    [{ type: 'album', id: 'djl-album' }, 5],
    [{ type: 'artist', id: 'djl-artist' }, 5],
    [{ type: 'playlist', id: 'djl-playlist' }, 3],
    [{ type: 'genre', id: 'house' }, 5],
    [{ type: 'folder', id: LIB, path: 'b' }, 2],
    [{ type: 'folder', id: LIB, path: path.join(tmp, 'a') }, 3],
  ] as const) {
    const r = await order({ source: src });
    assert.equal(r.statusCode, 200, JSON.stringify(src) + r.body);
    assert.equal(r.json().items.length, want, JSON.stringify(src));
  }
  // A queue: ids in, same ids out (reordered), unknown and hidden ones dropped; startItemId is honoured.
  const q = (await order({ itemIds: ['djl-t4', 'djl-t2', 'djl-secret', 'nope', 'djl-t1'], startItemId: 'djl-t2' })).json();
  assert.deepEqual(q.items.map((i: { id: string }) => i.id).sort(), ['djl-t1', 'djl-t2', 'djl-t4']);
  assert.equal(q.items[0].id, 'djl-t2');
  // Access: hidden library, a folder outside the library, bad input.
  assert.equal((await order({ source: { type: 'library', id: HIDDEN } })).statusCode, 404);
  assert.equal((await order({ source: { type: 'folder', id: LIB, path: '../private' } })).statusCode, 400);
  assert.equal((await order({ source: { type: 'folder', id: LIB, path: '/etc' } })).statusCode, 400);
  assert.equal((await order({})).statusCode, 400);
  assert.equal((await order({ itemIds: 'djl-t1' })).statusCode, 400);
  assert.equal((await order({ source: { type: 'nope', id: 'x' } })).statusCode, 400);
  const secret = (await order({ source: { type: 'genre', id: 'house' } }, A)).json();
  assert.ok(secret.items.some((i: { id: string }) => i.id === 'djl-secret'), 'admins see every library');
  assert.deepEqual(fetches, []);
});

test('POST /dj/mix without a prompt never reaches the language model or the speech API', { skip }, async () => {
  fetches = [];
  const r = await app.inject({ method: 'POST', url: '/api/v1/dj/mix', headers: V, payload: { libraryId: LIB, count: 3, history: ['djl-t1'] } });
  assert.equal(r.statusCode, 200, r.body);
  const mix = r.json();
  assert.ok(mix.tracks.length >= 1);
  assert.ok(!mix.tracks.some((t: { item: { id: string } }) => t.item.id === 'djl-t1'), 'history is not repeated');
  assert.ok(mix.tracks[0].transition, 'continues from the history');
  const seeded = await app.inject({ method: 'POST', url: '/api/v1/dj/mix', headers: V, payload: { seedItemId: 'djl-artist', durationMin: 2 } });
  assert.equal(seeded.statusCode, 200, seeded.body);
  assert.equal(seeded.json().understoodBy, undefined);
  assert.deepEqual(fetches, [], 'no outbound requests');
  // Control: a prompt (Advanced DJ) does try the configured model — so the stub above really would have caught it.
  const ai = await app.inject({ method: 'POST', url: '/api/v1/dj/mix', headers: V, payload: { prompt: 'house for an hour' } });
  assert.equal(ai.statusCode, 200, ai.body);
  assert.ok(fetches.some((u) => u.includes('llm.invalid')), `prompt path used the model: ${fetches.join()}`);
  assert.equal(ai.json().understoodBy, 'rules', 'the model failed, so the built-in parser took over');
});

test('a mix of N minutes plays for N minutes (mix-in to mix-out), not N minutes of whole tracks', async () => {
  const L = 'djl-dur';
  db.run('INSERT INTO libraries (id, name, type, paths, created_at) VALUES (?, ?, ?, ?, ?)', L, 'Dur', 'music', '[]', now);
  const { ensureAnalysisColumns } = await import('../src/services/dj/analysis.ts');
  ensureAnalysisColumns();
  for (let i = 0; i < 40; i++) {
    const id = `djl-d${i}`;
    db.insert('items', { id, library_id: L, type: 'track', title: id, sort_title: id, genres: '["House"]', duration_ms: 240000, added_at: now, updated_at: now });
    db.insert('media', { id: `${id}-m`, item_id: id, path: `/nowhere/${id}.mp3`, container: 'mp3', duration_ms: 240000, size: 1, mtime: 1 });
    // 124 BPM, 8 × 16-bar phrases from 0.1 s, the last one an outro.
    const bar = 240000 / 124;
    const phrases = Array.from({ length: 8 }, (_, k) => ({ startMs: Math.round(100 + k * 16 * bar), endMs: Math.round(100 + (k + 1) * 16 * bar), type: k === 0 ? 'intro' : k === 7 ? 'outro' : 'verse', energy: 0.8, bars: 16 }));
    db.run(`INSERT INTO track_analysis (item_id, media_mtime, version, bpm, bpm_confidence, beat_offset_ms, key_name, camelot, energy, loudness_db, cue_in_ms, cue_out_ms, intro_end_ms, outro_start_ms, duration_ms, analyzed_at, phrases, downbeat_ms)
      VALUES (?, 1, 3, 124, 0.9, 100, 'A minor', '8A', ?, -9, 0, 239000, NULL, NULL, 240000, ?, ?, 100)`, id, 0.5 + (i % 5) / 20, now, JSON.stringify(phrases));
  }
  const r = await app.inject({ method: 'POST', url: '/api/v1/dj/mix', headers: A, payload: { libraryId: L, durationMin: 20, artistGap: 0 } });
  assert.equal(r.statusCode, 200, r.body);
  const mix = r.json();
  // Played length: each track from its mix-in to the next track's start (its mix-out); the last to its end.
  let played = 0;
  mix.tracks.forEach((t: any, i: number) => {
    const inMs = t.transition?.mixInMs ?? 0;
    const next = mix.tracks[i + 1];
    played += (next ? next.transition.mixOutMs : t.item.durationMs ?? 240000) - inMs;
  });
  assert.ok(Math.abs(played - mix.durationMs) < 2000, `durationMs ${mix.durationMs} vs played ${played}`);
  assert.ok(mix.durationMs >= 20 * 60000 && mix.durationMs < 20 * 60000 + 240000, `20 min requested, got ${(mix.durationMs / 60000).toFixed(1)}`);
  assert.equal(new Set(mix.tracks.map((t: any) => t.item.id)).size, mix.tracks.length, 'no repeats');
});
