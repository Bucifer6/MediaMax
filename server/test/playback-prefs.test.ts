// Subtitle intelligence & skip segments (0.8): the shared track/skip/subtitle helpers, preference validation,
// IntroDB + AniSkip crowd segments against a local mock (shapes from api.introdb.app and api.aniskip.com/v2),
// admin-only marker submission, the parental guide, and AutoSync on synthetic subtitle timings.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const { db } = await import('../src/db.ts');
const { createUser, getUser, updateMe, normalizeSubtitleStyle } = await import('../src/services/auth.ts');
const { updateSettings, getSettings, publicSettings, SECRET_MASK } = await import('../src/services/settings.ts');
const { setProviderHttpOptions } = await import('../src/services/metadata/http.ts');
const { markersWithCrowd, mergeMarkers, submitMarker, parentalGuide, dominantSeverity } = await import('../src/services/skipSegments.ts');
const { alignSpans, vttSpans } = await import('../src/services/autosync.ts');
const pp = await import('../src/services/playerPrefs.ts');
const { originalLanguageOf } = await import('../src/services/items.ts');
const { issueToken } = await import('../src/services/auth.ts');
const { buildApp } = await import('../src/app.ts');

/* --------------------------------- helpers ---------------------------------- */

test('audio choice: primary, secondary and "original" languages', () => {
  const streams = [
    { index: 1, language: 'eng', default: true },
    { index: 2, language: 'jpn' },
    { index: 3, language: 'fre' },
  ];
  assert.equal(pp.pickAudio(streams, { audioLanguage: 'ja' })?.index, 2);
  assert.equal(pp.pickAudio(streams, { audioLanguage: 'de', secondaryAudioLanguage: 'fr' })?.index, 3);
  assert.equal(pp.pickAudio(streams, { audioLanguage: 'original' }, 'ja')?.index, 2);
  // Original unknown → no pick (the caller falls back to the file's default track); then the secondary applies.
  assert.equal(pp.pickAudio(streams, { audioLanguage: 'original' }, null), null);
  assert.equal(pp.pickAudio(streams, { audioLanguage: 'original', secondaryAudioLanguage: 'fra' }, null)?.index, 3);
  assert.equal(pp.pickAudio(streams, { audioLanguage: null }), null);
  // Unknown 3-letter codes stay whole: Malayalam must not match Marathi.
  assert.equal(pp.sameLanguage('mal', 'mar'), false);
  assert.equal(pp.sameLanguage('mal', 'mal'), true);
  assert.equal(pp.sameLanguage('pt-BR', 'por'), true);
  assert.equal(pp.lang2('und'), '');
});

test('subtitle choice by mode, with secondary language and foreign-audio auto', () => {
  const tracks = [
    { index: 10, language: 'eng', default: false, forced: true },
    { index: 11, language: 'eng', default: false, forced: false },
    { index: 12, language: 'rum', default: true, forced: false },
    { index: 13, language: 'spa', default: false, forced: false },
  ];
  assert.equal(pp.pickSubtitle(tracks, { subtitleMode: 'off', subtitleLanguage: 'en' }), null);
  assert.equal(pp.pickSubtitle(tracks, { subtitleMode: 'always', subtitleLanguage: 'en' })?.index, 11);
  assert.equal(pp.pickSubtitle(tracks, { subtitleMode: 'always', subtitleLanguage: 'de', secondarySubtitleLanguage: 'es' })?.index, 13);
  assert.equal(pp.pickSubtitle(tracks, { subtitleMode: 'always', subtitleLanguage: 'de' })?.index, 12, 'falls back to the default track');
  assert.equal(pp.pickSubtitle(tracks, { subtitleMode: 'forced', subtitleLanguage: 'en' })?.index, 10);
  assert.equal(pp.pickSubtitle(tracks, { subtitleMode: 'auto', subtitleLanguage: 'en' })?.index, 10, 'forced in the language comes first');
  const noForced = tracks.filter((t) => !t.forced);
  assert.equal(pp.pickSubtitle(noForced, { subtitleMode: 'auto', subtitleLanguage: 'en' }, 'jpn')?.index, 11, 'foreign audio → full subtitles');
  assert.equal(pp.pickSubtitle(noForced, { subtitleMode: 'auto', subtitleLanguage: 'en' }, 'eng')?.index, 12, 'own-language audio → the default track');
  assert.deepEqual(pp.visibleSubtitles(tracks, { showOnlyPreferredSubtitles: true, subtitleLanguage: 'en', secondarySubtitleLanguage: 'es' }).map((t) => t.index), [10, 11, 13]);
  assert.equal(pp.visibleSubtitles(tracks, { showOnlyPreferredSubtitles: true, subtitleLanguage: 'ko' }).length, 4, 'never filters down to nothing');
});

test('auto-skip: per segment, legacy skipIntros when unset, credits off by default', () => {
  assert.equal(pp.shouldAutoSkip({ skipIntros: true }, 'intro'), true);
  assert.equal(pp.shouldAutoSkip({ skipIntros: true }, 'commercial'), true);
  assert.equal(pp.shouldAutoSkip({ skipIntros: true }, 'credits'), false);
  assert.equal(pp.shouldAutoSkip({ skipIntros: true, autoSkip: { recap: false } }, 'recap'), false);
  assert.equal(pp.shouldAutoSkip({ skipIntros: false, autoSkip: { credits: true } }, 'credits'), true);
  assert.equal(pp.shouldAutoSkip(null, 'intro'), false);
});

test('SDH stripping and RTL punctuation', () => {
  assert.equal(pp.stripSdh('[MUSIC PLAYING]'), '');
  assert.equal(pp.stripSdh('(sighs) I know.'), 'I know.');
  assert.equal(pp.stripSdh('JOHN: Where are you?\n- MARY: Here.'), 'Where are you?\n- Here.');
  assert.equal(pp.stripSdh('- [door slams]\n- Who is it?'), '- Who is it?');
  assert.equal(pp.stripSdh('♪ la la la ♪'), '♪ la la la ♪', 'lyrics stay');
  assert.equal(pp.stripSdh('I said OK: fine.'), 'I said OK: fine.', 'mid-line capitals are not speaker tags');
  assert.equal(pp.fixRtl('שלום!'), '‏שלום!‏');
  assert.equal(pp.fixRtl('Hello!'), 'Hello!');
  assert.equal(pp.cleanCueText('(laughs) مرحبا', { stripSdh: true }), '‏مرحبا‏');
  assert.equal(pp.cleanCueText('[x]', { stripSdh: false, rtlFix: false }), '[x]');
});

test('HDR comfort colours and controls', () => {
  assert.equal(pp.dimColor('#ffffff', 100), '#ffffff');
  assert.equal(pp.dimColor('#ffffff', 0), '#4d4d4d');
  assert.equal(pp.hdrSubtitleColor({ hdrStyleEnabled: true, hdrBrightness: 100 }, true), '#ffffff');
  assert.equal(pp.hdrSubtitleColor({ hdrStyleEnabled: true }, false), null, 'SDR playback keeps the normal colour');
  assert.equal(pp.hdrSubtitleColor({ hdrStyleEnabled: false }, true), null);
  assert.equal(pp.hdrActive({ delivery: 'passthrough' }), true);
  assert.equal(pp.hdrActive({ delivery: 'tonemap' }), false);
  assert.equal(pp.hdrActive(null), false);
  assert.equal(pp.hdrControlsOpacity({ hdrStyleEnabled: true, hdrDimPlayerControls: true, hdrBrightness: 0 }, true), 0.3);
  assert.equal(pp.hdrControlsOpacity({ hdrStyleEnabled: true, hdrDimPlayerControls: false }, true), 1);
});

/* ------------------------------- preferences -------------------------------- */

test('subtitle style: free-form fields are clamped, colours checked, null clears', () => {
  const s = normalizeSubtitleStyle({ fontScale: 500, textColor: '#ABCDEF', outlineWidth: 0, bold: false, hdrBrightness: 40, backgroundColor: 'red', stripSdh: 'yes' });
  assert.equal(s.fontScale, 200);
  assert.equal(s.textColor, '#abcdef');
  assert.equal(s.outlineWidth, 1);
  assert.equal(s.bold, false);
  assert.equal(s.hdrBrightness, 40);
  assert.equal(s.backgroundColor, undefined);
  assert.equal(s.stripSdh, undefined);
  const cleared = normalizeSubtitleStyle({ fontScale: null, textColor: null }, s);
  assert.equal(cleared.fontScale, undefined);
  assert.equal(cleared.textColor, undefined);
  assert.equal(cleared.hdrBrightness, 40, 'other fields kept');
});

test('preferences: languages, auto-skip and spoiler switches are validated and merged', async () => {
  const u = await createUser({ username: 'pp-user', password: 'pass1234' });
  let me = await updateMe(u.id, { preferences: { audioLanguage: 'original', secondaryAudioLanguage: 'EN', subtitleLanguage: 'original', secondarySubtitleLanguage: 'x y z', autoSkip: { intro: true, credits: 'yes' as never }, blurUnwatchedEpisodes: true } as never });
  assert.equal(me.preferences.audioLanguage, 'original');
  assert.equal(me.preferences.secondaryAudioLanguage, 'en');
  assert.equal(me.preferences.subtitleLanguage, null, "'original' is for audio only");
  assert.equal(me.preferences.secondarySubtitleLanguage, null);
  assert.deepEqual(me.preferences.autoSkip, { intro: true });
  assert.equal(me.preferences.blurUnwatchedEpisodes, true);
  me = await updateMe(u.id, { preferences: { autoSkip: { recap: false } } as never });
  assert.deepEqual(me.preferences.autoSkip, { intro: true, recap: false }, 'merged key by key');
  assert.equal(me.preferences.audioLanguage, 'original', 'untouched keys stay');
});

/* ----------------------------- crowd segments ------------------------------- */

const hits: string[] = [];
let lastSubmit: { headers: http.IncomingHttpHeaders; body: any } | null = null;
const mock = http.createServer((req, res) => {
  hits.push(req.url ?? '');
  const u = new URL(req.url ?? '/', 'http://x');
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (u.pathname === '/segments') {
    if (u.searchParams.get('imdb_id') === 'tt0903747' && u.searchParams.get('season') === '1' && u.searchParams.get('episode') === '2') {
      return json(200, {
        imdb_id: 'tt0903747', media_type: 'tv', is_movie: false, season: 1, episode: 2,
        intro: { start_sec: 2.5, end_sec: 58, start_ms: 2500, end_ms: 58000, confidence: 0.92, submission_count: 14 },
        recap: null, outro: { start_sec: 3431, end_sec: 3500, start_ms: 3431000, end_ms: 3500000 }, post_credits: null, no_intro: false, no_recap: true, no_outro: false,
      });
    }
    return json(200, { imdb_id: u.searchParams.get('imdb_id'), intro: null, recap: null, outro: null, post_credits: null });
  }
  if (u.pathname.startsWith('/v2/skip-times/21/3')) {
    return json(200, {
      found: true, statusCode: 200, message: 'ok',
      results: [
        { interval: { startTime: 57.4, endTime: 145.7 }, skipType: 'op', skipId: 'a', episodeLength: 1491 },
        { interval: { startTime: 1357.9, endTime: 1480 }, skipType: 'ed', skipId: 'b', episodeLength: 1491 },
      ],
    });
  }
  if (u.pathname === '/submit' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      lastSubmit = { headers: req.headers, body: JSON.parse(body) };
      json(req.headers['x-api-key'] === 'idb_good' ? 201 : 401, { ok: true });
    });
    return;
  }
  if (u.pathname === '/titles/tt0903747/parentsGuide') {
    return json(200, {
      parentsGuide: [
        { category: 'VIOLENCE', severityBreakdowns: [{ severityLevel: 'none', voteCount: 2 }, { severityLevel: 'severe', voteCount: 40 }, { severityLevel: 'moderate', voteCount: 10 }] },
        { category: 'PROFANITY', severityBreakdowns: [{ severityLevel: 'none', voteCount: 30 }, { severityLevel: 'mild', voteCount: 5 }] },
        { category: 'UNKNOWN', severityBreakdowns: [{ severityLevel: 'mild', voteCount: 5 }] },
      ],
    });
  }
  json(404, { error: 'not found' });
});

const iso = new Date().toISOString();
before(async () => {
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  setProviderHttpOptions('introdb', { base, minIntervalMs: 0 });
  setProviderHttpOptions('introdb-submit', { minIntervalMs: 0 });
  setProviderHttpOptions('aniskip', { base: `${base}/v2`, minIntervalMs: 0 });
  db.insert('libraries', { id: 'pp-lib', name: 'Shows', type: 'shows', paths: '[]', created_at: iso });
  db.insert('items', { id: 'pp-show', library_id: 'pp-lib', type: 'show', title: 'Breaking', sort_title: 'breaking', external_ids: JSON.stringify({ imdb: 'tt0903747', mal: '21' }), extra: JSON.stringify({ originalLanguage: 'en' }), added_at: iso, updated_at: iso });
  db.insert('items', { id: 'pp-s1', library_id: 'pp-lib', type: 'season', title: 'Season 1', sort_title: 's1', parent_id: 'pp-show', idx: 1, added_at: iso, updated_at: iso });
  const ep = (id: string, idx: number, markers: unknown[] = []) =>
    db.insert('items', { id, library_id: 'pp-lib', type: 'episode', title: id, sort_title: id, parent_id: 'pp-s1', grandparent_id: 'pp-show', parent_idx: 1, idx, markers: JSON.stringify(markers), added_at: iso, updated_at: iso });
  ep('pp-e2', 2, [{ type: 'credits', startMs: 3400000, endMs: 3500000 }]);
  ep('pp-e3', 3);
  db.insert('media', { id: 'pp-m2', item_id: 'pp-e2', path: '/x/e2.mkv', duration_ms: 3500000 });
});
after(() => {
  mock.close();
  setProviderHttpOptions('introdb', null);
  setProviderHttpOptions('aniskip', null);
});

test('crowd segments are off until the admin enables them', async () => {
  hits.length = 0;
  const local = [{ type: 'credits' as const, startMs: 3400000, endMs: 3500000 }];
  assert.deepEqual(await markersWithCrowd('pp-e2', local), local);
  assert.equal(hits.length, 0, 'no outbound request');
});

test('IntroDB fills missing types; local markers win', async () => {
  updateSettings({ skipSegments: { introDb: true, aniSkip: false, introDbApiKey: null, parentalGuideUrl: null } });
  const local = [{ type: 'credits' as const, startMs: 3400000, endMs: 3500000 }];
  const m = await markersWithCrowd('pp-e2', local);
  assert.deepEqual(m, [
    { type: 'intro', startMs: 2500, endMs: 58000, source: 'introdb' },
    { type: 'credits', startMs: 3400000, endMs: 3500000 },
  ]);
  assert.ok(hits.some((h) => h === '/segments?imdb_id=tt0903747&season=1&episode=2'), 'series IMDb id + season/episode');
});

test('AniSkip maps op/ed for a season-1 episode with a MAL id', async () => {
  updateSettings({ skipSegments: { introDb: false, aniSkip: true } as never });
  const m = await markersWithCrowd('pp-e3', []);
  assert.deepEqual(m, [
    { type: 'intro', startMs: 57400, endMs: 145700, source: 'aniskip' },
    { type: 'credits', startMs: 1357900, endMs: 1480000, source: 'aniskip' },
  ]);
  assert.deepEqual(mergeMarkers([{ type: 'intro', startMs: 0, endMs: 1 }], m).map((x) => x.source ?? 'local'), ['local', 'aniskip']);
});

test('marker submission: admin only, validated, optionally sent to IntroDB with the key', async () => {
  const viewer = getUser((await createUser({ username: 'pp-viewer', password: 'pass1234' })).id);
  await assert.rejects(() => submitMarker(viewer, 'pp-e2', { type: 'intro', startMs: 1000, endMs: 50000 }), /Only an admin/);
  const admin = { isAdmin: true };
  await assert.rejects(() => submitMarker(admin, 'pp-e2', { type: 'intro', startMs: 1000, endMs: 2000 }), /between 5 and 300/);
  await assert.rejects(() => submitMarker(admin, 'pp-e2', { type: 'intro', startMs: 3_490_000, endMs: 3_520_000 }), /after the end/);
  const noKey = await submitMarker(admin, 'pp-e2', { type: 'intro', startMs: 1000, endMs: 50000, upstream: true });
  assert.equal(noKey.upstream?.sent, false);
  assert.match(noKey.upstream?.message ?? '', /No IntroDB API key/);
  assert.deepEqual(noKey.markers.find((m) => m.type === 'intro'), { type: 'intro', startMs: 1000, endMs: 50000, source: 'user' });
  updateSettings({ skipSegments: { introDbApiKey: 'idb_good' } as never });
  assert.equal(publicSettings().skipSegments?.introDbApiKey, SECRET_MASK, 'the key is write-only');
  updateSettings({ skipSegments: { introDbApiKey: SECRET_MASK } as never });
  assert.equal(getSettings().skipSegments?.introDbApiKey, 'idb_good', 'the mask keeps the stored key');
  const sent = await submitMarker(admin, 'pp-e2', { type: 'credits', startMs: 3_430_000, endMs: 3_499_000, upstream: true });
  assert.deepEqual(sent.upstream, { sent: true, message: null });
  assert.equal(lastSubmit?.headers['x-api-key'], 'idb_good');
  assert.deepEqual(lastSubmit?.body, { imdb_id: 'tt0903747', segment_type: 'outro', start_sec: 3430, end_sec: 3499, season: 1, episode: 2 });
});

test('parental guide: rating always, severities from the configured source', async () => {
  db.run("UPDATE items SET content_rating = 'TV-MA' WHERE id = 'pp-show'");
  assert.deepEqual(await parentalGuide('pp-e2'), { contentRating: 'TV-MA', categories: [] });
  assert.throws(() => updateSettings({ skipSegments: { parentalGuideUrl: 'ftp://nope' } as never }), /must start with http/);
  const base = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  updateSettings({ skipSegments: { parentalGuideUrl: `${base}/titles/{imdb}/parentsGuide` } as never });
  assert.deepEqual(await parentalGuide('pp-e2'), {
    contentRating: 'TV-MA',
    categories: [{ category: 'violence', severity: 'severe' }, { category: 'profanity', severity: 'none' }],
  });
  assert.equal(dominantSeverity([]), null);
});

test('original language: own, or the show’s for an episode', () => {
  assert.equal(originalLanguageOf({ type: 'episode', originalLanguage: null, parentId: 'pp-s1', grandparentId: 'pp-show' }), 'en');
  assert.equal(originalLanguageOf({ type: 'movie', originalLanguage: 'ja', parentId: null, grandparentId: null }), 'ja');
});

/* --------------------------------- AutoSync --------------------------------- */

/** Pseudo-random but repeatable dialogue: cue lengths 0.8–4 s, gaps 0.2–6 s, a long break every ~80 cues. */
function dialogue(n: number, seed = 7): [number, number][] {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const out: [number, number][] = [];
  let t = 5000;
  for (let i = 0; i < n; i++) {
    const len = 800 + rnd() * 3200;
    out.push([Math.round(t), Math.round(t + len)]);
    t += len + 200 + rnd() * 5800 + (i % 80 === 79 ? 20000 : 0);
  }
  return out;
}

test('AutoSync: constant delay', () => {
  const ref = dialogue(400);
  const late = ref.map(([a, b]) => [a + 2350, b + 2350] as [number, number]);
  const r = alignSpans(ref, late);
  assert.equal(r.map.ratio, 1);
  assert.ok(Math.abs(r.map.offsetMs + 2350) <= 20, `offset ${r.map.offsetMs}`);
  assert.ok(r.score > 0.95 && r.scoreBefore < 0.6, `score ${r.score} (before ${r.scoreBefore})`);
});

test('AutoSync: frame-rate drift (25 fps subtitle on a 23.976 fps video)', () => {
  const ref = dialogue(500);
  const f = 25 / 23.976;
  const drifted = ref.map(([a, b]) => [Math.round(a / f) + 1000, Math.round(b / f) + 1000] as [number, number]);
  const r = alignSpans(ref, drifted);
  assert.ok(Math.abs(r.map.ratio - f) < 0.001, `ratio ${r.map.ratio}`);
  assert.ok(r.score > 0.9, `score ${r.score}`);
});

test('AutoSync: one group out of step after an ad break', () => {
  const ref = dialogue(240);
  // Cues after the second long break (index 160+) are 1.5 s late.
  const subj = ref.map(([a, b], i) => (i >= 160 ? [a + 1500, b + 1500] : [a, b]) as [number, number]);
  const r = alignSpans(ref, subj);
  assert.equal(r.map.offsetMs, 0);
  assert.equal(r.map.groups.length, 1);
  assert.ok(Math.abs(r.map.groups[0].offsetMs + 1500) <= 20, JSON.stringify(r.map.groups));
  assert.ok(r.score > 0.97, `score ${r.score}`);
  assert.equal(pp.applySyncMap(ref[10][0], r.map), ref[10][0], 'the early group is untouched');
});

test('AutoSync: already in sync stays put; VTT timings parse', () => {
  const ref = dialogue(200, 3);
  const r = alignSpans(ref, ref);
  assert.deepEqual(r.map, { ratio: 1, offsetMs: 0, groups: [] });
  assert.deepEqual(vttSpans('WEBVTT\n\n00:00:01.500 --> 00:00:03.000\nHi\n\n01:02.25 --> 01:04.000 line:90%\nThere\n'), [[1500, 3000], [62250, 64000]]);
});

test("routes: items the viewer can't see are refused; marker saving is admin-only", async () => {
  db.insert('libraries', { id: 'pp-secret', name: 'Secret', type: 'movies', paths: '[]', created_at: iso });
  db.insert('items', { id: 'pp-hidden', library_id: 'pp-secret', type: 'movie', title: 'Hidden', sort_title: 'hidden', added_at: iso, updated_at: iso });
  const viewer = await createUser({ username: 'pp-routes', password: 'pass1234', libraryIds: ['pp-lib'] });
  const token = issueToken(viewer.id, { deviceId: 'pp-r', deviceName: 'test', platform: 'web' }).token;
  const app = await buildApp();
  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  for (const [method, url, body] of [
    ['GET', '/items/pp-hidden/parental-guide'],
    ['POST', '/items/pp-hidden/markers', { type: 'intro', startMs: 0, endMs: 30000 }],
    ['POST', '/items/pp-hidden/subtitles/autosync', { mediaId: 'x', subtitleIndex: 0, referenceIndex: 1 }],
  ] as const) {
    const r = await call(method, url, body);
    assert.ok(r.statusCode === 403 || r.statusCode === 404, `${url} → ${r.statusCode}`);
  }
  assert.equal((await call('POST', '/items/pp-e2/markers', { type: 'intro', startMs: 0, endMs: 30000 })).statusCode, 403, 'viewers cannot save markers');
  assert.equal((await call('GET', '/items/pp-e2/parental-guide')).statusCode, 200);
  await app.close();
});
