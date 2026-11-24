// Your DJ on the phone (src/player/yourDj.ts) and play rules (src/player/djRules.ts): the reducer (start / more /
// switch / request with no match), queue helpers, availability (offline / no server / AI DJ off = unavailable, no
// requests), the thin request helpers, and how rules presets are cleaned and serialised. Run: npm test in apps/mobile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aiDjOn, appendTracks, isEarlySkip, isMiss, moreOrRestart, NO_MATCH_FALLBACK, reasonLabel, requestOrMiss, segmentOf, sessionHistory, startSession,
  switchAck, switchQueue, yourDjAvailability, yourDjCommentary, yourDjReducer,
} from '../src/player/yourDj.ts';
import {
  activePresetIdOf, cleanRules, cycleGenre, djRulesPrefs, genreState, numField, parseRulesPrefs, removePreset, ruleChips, rulesSummary, serializeRulesPrefs,
  setActivePreset, splitList, upsertPreset,
} from '../src/player/djRules.ts';

const item = (id) => ({ id, type: 'track', title: id, durationMs: 200000 });
const session = (id, segId, kind, ids, extra = {}) => ({
  id, segment: { id: segId, kind, title: `${kind} title`, reason: `Because ${kind}` }, items: ids.map(item), analyses: {}, reasons: Object.fromEntries(ids.map((x) => [x, `reason ${x}`])), intro: null, ...extra,
});

/* ---------------- reducer ---------------- */

test('start → more → switch: segments, reasons and the turn counter', () => {
  let s = yourDjReducer(null, { type: 'start', session: session('s1', 'g1', 'on-repeat', ['a', 'b']) });
  assert.equal(s.sessionId, 's1');
  assert.equal(s.segmentId, 'g1');
  assert.equal(s.turn, 0);
  assert.equal(segmentOf(s, 'a').title, 'on-repeat title');
  assert.equal(reasonLabel(s, 'a'), 'On repeat · reason a');
  s = yourDjReducer(s, { type: 'more', session: session('s1', 'g2', 'throwbacks', ['c']) });
  assert.equal(s.turn, 0, 'more just queues up behind');
  assert.equal(segmentOf(s, 'c').kind, 'throwbacks');
  assert.equal(segmentOf(s, 'a').kind, 'on-repeat', 'earlier tracks keep their segment');
  s = yourDjReducer(s, { type: 'busy', busy: 'switch' });
  assert.equal(s.busy, 'switch');
  s = yourDjReducer(s, { type: 'switch', session: session('s1', 'g3', 'rare', ['d', 'e']) });
  assert.equal(s.busy, null);
  assert.equal(s.turn, 1);
  assert.equal(s.segmentId, 'g3');
  assert.equal(reasonLabel(s, 'zzz'), null, 'not a DJ pick');
  assert.equal(yourDjReducer(s, { type: 'end' }), null);
});

test('request with no match: the gentle message, the set (and its segment) carries on — never an error', () => {
  let s = yourDjReducer(null, { type: 'start', session: session('s1', 'g1', 'mood', ['a']) });
  s = yourDjReducer(s, { type: 'busy', busy: 'request' });
  const miss = { ok: false, message: "Nothing like that in your library within your rules, so I'll keep this going." };
  assert.equal(isMiss(miss), true);
  s = yourDjReducer(s, { type: 'request', result: miss });
  assert.equal(s.busy, null);
  assert.equal(s.message, miss.message);
  assert.equal(s.segmentId, 'g1');
  assert.equal(s.turn, 0);
  s = yourDjReducer(s, { type: 'dismiss' });
  assert.equal(s.message, null);
  // An empty message falls back to ours.
  s = yourDjReducer(s, { type: 'request', result: { ok: false, message: '  ' } });
  assert.equal(s.message, NO_MATCH_FALLBACK);
  // A match is a new direction.
  s = yourDjReducer(s, { type: 'request', result: session('s1', 'g9', 'request', ['r1']) });
  assert.equal(s.turn, 1);
  assert.equal(segmentOf(s, 'r1').kind, 'request');
  assert.equal(s.message, null);
  // The server's note (rules leave little) is shown.
  s = yourDjReducer(s, { type: 'more', session: session('s1', 'g10', 'genre', [], { note: 'Only a few songs fit your rules.' }) });
  assert.equal(s.message, 'Only a few songs fit your rules.');
});

test('queue helpers: history, append, switch keeps the current song and replaces what was coming', () => {
  const q = ['a', 'b', 'c', 'd'].map(item);
  assert.deepEqual(sessionHistory(q, 1), ['a', 'b']);
  assert.deepEqual(appendTracks(q, ['d', 'e', 'e'].map(item)).map((x) => x.id), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(switchQueue(q, 1, ['x', 'a', 'y'].map(item)).map((x) => x.id), ['a', 'b', 'x', 'y']);
  assert.deepEqual(switchQueue(q, 1, ['a'].map(item)).map((x) => x.id), ['a', 'b', 'c', 'd'], 'nothing new: unchanged');
  assert.equal(switchAck({ id: 'g', kind: 'decade', title: 'Back to 2009', reason: 'Big for you then.' }), 'Switching it up. Back to 2009: Big for you then.');
});

test('skip feedback only for early skips; commentary default follows the server (intros)', () => {
  assert.equal(isEarlySkip(12000, 200000), true);
  assert.equal(isEarlySkip(31000, 200000), false);
  assert.equal(isEarlySkip(19000, 20000), false, 'the very end of a short track is not a skip');
  assert.equal(yourDjCommentary({}), 'intros');
  assert.equal(yourDjCommentary({ yourDj: { commentary: 'intros' } }), 'intros');
});

/* ---------------- availability: offline / no server → unavailable, no requests ---------------- */

const status = (ai = {}) => ({ analyzed: 1, total: 1, running: false, ai: { enabled: true, llm: false, serverVoice: false, hostName: 'Vibe', chattiness: 'normal', yourDj: true, radioHost: true, ...ai } });

test('availability: server reachable and AI DJ on; offline / downloads-only = disabled with a note; AI DJ off = hidden', () => {
  const base = { signedIn: true, online: true, status: status(), forbidden: false, hasMusic: true };
  assert.deepEqual(yourDjAvailability(base), { available: true, hidden: false, note: null });
  const off = yourDjAvailability({ ...base, online: false });
  assert.equal(off.available, false);
  assert.equal(off.hidden, false);
  assert.match(off.note, /connection/);
  assert.equal(yourDjAvailability({ ...base, signedIn: false }).available, false, 'offline mode (downloads only)');
  assert.equal(yourDjAvailability({ ...base, status: status({ enabled: false }) }).hidden, true);
  assert.equal(yourDjAvailability({ ...base, forbidden: true }).hidden, true, '403 from /dj/session or /dj/break');
  assert.equal(yourDjAvailability({ ...base, status: null }).available, false, 'not known yet');
  assert.equal(yourDjAvailability({ ...base, hasMusic: false }).hidden, true);
  assert.equal(aiDjOn(base), true);
  assert.equal(aiDjOn({ ...base, online: false }), false);
  assert.equal(aiDjOn({ ...base, status: null }), false);
});

function fakeApi(over = {}) {
  const calls = [];
  const api = {
    calls,
    djSession: async (b) => (calls.push(['session', b]), session('s2', 'g1', 'mood', ['a'])),
    djSessionMore: async (id, b) => (calls.push(['more', id, b]), session(id, 'g2', 'rare', ['b'])),
    djSessionSwitch: async (id, b) => (calls.push(['switch', id, b]), session(id, 'g3', 'decade', ['c'])),
    djSessionRequest: async (id, b) => (calls.push(['request', id, b]), { ok: false, message: 'no match' }),
    ...over,
  };
  return api;
}

test('no server / unavailable: starting Your DJ makes no request at all', async () => {
  const api = fakeApi();
  assert.equal(await startSession(api, false, undefined), null);
  assert.equal(await startSession(null, true, undefined), null);
  assert.equal(api.calls.length, 0);
  const s = await startSession(api, true, 'p1', 9);
  assert.equal(s.id, 's2');
  assert.deepEqual(api.calls, [['session', { presetId: 'p1', hour: 9 }]]);
});

test('endless: an expired session (404) quietly starts a new one with the same rules; other errors propagate', async () => {
  const gone = Object.assign(new Error('gone'), { status: 404 });
  const api = fakeApi({ djSessionMore: async () => { throw gone; } });
  const r = await moreOrRestart(api, 'old', ['a'], 'p1', 20);
  assert.equal(r.id, 's2');
  assert.deepEqual(api.calls, [['session', { presetId: 'p1', hour: 20 }]]);
  const forbidden = Object.assign(new Error('off'), { status: 403 });
  await assert.rejects(moreOrRestart(fakeApi({ djSessionMore: async () => { throw forbidden; } }), 'x', [], undefined), (e) => e.status === 403);
  const ok = fakeApi();
  assert.equal((await moreOrRestart(ok, 's1', ['a', 'b'], undefined, 8)).segment.kind, 'rare');
  assert.deepEqual(ok.calls[0], ['more', 's1', { history: ['a', 'b'], hour: 8 }]);
});

test('requests never throw: a failure is a gentle miss', async () => {
  const api = fakeApi({ djSessionRequest: async () => { throw Object.assign(new Error('500'), { status: 500 }); } });
  const r = await requestOrMiss(api, 's1', '90s hip hop', ['a']);
  assert.equal(isMiss(r), true);
  assert.match(r.message, /keep this going/);
  const miss = await requestOrMiss(fakeApi(), 's1', 'polka', []);
  assert.deepEqual(miss, { ok: false, message: 'no match' });
});

/* ---------------- play rules ---------------- */

test('rules are cleaned: trimmed, de-duplicated, ranges ordered, excluded wins, empties dropped', () => {
  const r = cleanRules({
    includeGenres: [' Jazz ', 'jazz', 'Rock', ''], excludeGenres: ['rock'], includeArtists: [], yearMin: 1999, yearMax: 1990,
    bpmMin: 300, energyMin: 0, energyMax: 1, cleanOnly: false, minRating: 0, maxDurationSec: 10,
  });
  assert.deepEqual(r, { includeGenres: ['Jazz'], excludeGenres: ['rock'], yearMin: 1990, yearMax: 1999, bpmMin: 220, maxDurationSec: 30 });
  assert.deepEqual(cleanRules({ cleanOnly: true }), { cleanOnly: true });
});

test('presets: create, activate, edit, delete; serialised as the whole djRules object', () => {
  let prefs = djRulesPrefs({});
  assert.deepEqual(prefs, { activePresetId: null, presets: [] });
  prefs = upsertPreset(prefs, { id: 'p1', name: 'Kids', rules: { cleanOnly: true, excludeGenres: ['Metal'] } }, true);
  prefs = upsertPreset(prefs, { id: 'p2', name: 'kids', rules: { yearMin: 1980, yearMax: 1989 } });
  assert.equal(prefs.presets[1].name, 'kids 2', 'unique names');
  assert.equal(prefs.activePresetId, 'p1');
  assert.equal(activePresetIdOf({ djRules: prefs }), 'p1');
  prefs = setActivePreset(prefs, 'nope');
  assert.equal(prefs.activePresetId, null, 'unknown id = everything');
  prefs = setActivePreset(prefs, 'p2');
  const saved = serializeRulesPrefs(prefs);
  assert.deepEqual(saved, {
    activePresetId: 'p2',
    presets: [{ id: 'p1', name: 'Kids', rules: { excludeGenres: ['Metal'], cleanOnly: true } }, { id: 'p2', name: 'kids 2', rules: { yearMin: 1980, yearMax: 1989 } }],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), saved, 'plain JSON for PATCH /auth/me');
  assert.deepEqual(parseRulesPrefs(saved), saved, 'round trip');
  prefs = removePreset(prefs, 'p2');
  assert.equal(prefs.activePresetId, null, 'deleting the preset in use turns rules off');
  assert.equal(activePresetIdOf({ djRules: { activePresetId: 'gone', presets: [] } }), undefined, 'never send a stale presetId');
  assert.deepEqual(parseRulesPrefs({ presets: [{ id: 'x', rules: { yearMin: 'abc' } }, { nope: 1 }] }), { activePresetId: null, presets: [{ id: 'x', name: 'My rules', rules: {} }] });
});

test('chips (locked admin restrictions use the same labels) and the phone editor helpers', () => {
  const labels = ruleChips({ includeGenres: ['Jazz'], excludeArtists: ['ABBA'], yearMin: 1990, yearMax: 1999, cleanOnly: true, minRating: 8, maxDurationSec: 300 }).map((c) => c.label);
  assert.deepEqual(labels, ['Only Jazz', 'No ABBA', '1990–1999', 'Clean only', 'Rated 4★ or more', 'Up to 5 min']);
  assert.equal(rulesSummary({}), 'No limits');
  assert.equal(rulesSummary({ includeGenres: ['Jazz', 'Soul'], cleanOnly: true }), 'Only Jazz · Only Soul · +1');
  assert.deepEqual(splitList('Metallica, ABBA ,abba;;'), ['Metallica', 'ABBA']);
  let r = {};
  r = cycleGenre(r, 'House');
  assert.equal(genreState(r, 'house'), 'only');
  r = cycleGenre(r, 'House');
  assert.equal(genreState(r, 'House'), 'never');
  assert.deepEqual(r, { excludeGenres: ['House'] });
  r = cycleGenre(r, 'House');
  assert.deepEqual(r, {});
  assert.equal(numField(' 1994 '), 1994);
  assert.equal(numField(''), undefined);
  assert.equal(numField('x'), undefined);
});
