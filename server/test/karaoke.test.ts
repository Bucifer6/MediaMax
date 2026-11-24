// Lyrics v2 (LRC parser, sources incl. embedded tags and ID3 SYLT, editor, offsets) and karaoke stems
// (upload / serve / server-side mix, model download with SHA-256 verification). LRC cases adapted from OpenDJ (MIT).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const lrc = await import('../src/services/lrc.ts');
const id3 = await import('../src/services/id3.ts');
const lyrics = await import('../src/services/lyrics.ts');
const stems = await import('../src/services/stems.ts');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-karaoke-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const skip = hasFfmpeg ? false : 'ffmpeg not available';
const ff = (...args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

/* ------------------------------------------------------------------ LRC parser */

test('LRC copies in server / web / mobile match shared/src/lrc.ts', () => {
  const canon = fs.readFileSync(path.join(root, 'shared/src/lrc.ts'), 'utf8');
  for (const p of ['server/src/services/lrc.ts', 'web/src/lyrics/lrc.ts', 'apps/mobile/src/player/lrc.ts']) {
    assert.equal(fs.readFileSync(path.join(root, p), 'utf8'), canon, `${p} is out of date: run node scripts/sync-types.mjs`);
  }
});

test('stem DSP / model copies in web and server match shared/src/stems', () => {
  for (const f of ['dsp.ts', 'model.ts']) {
    const canon = fs.readFileSync(path.join(root, 'shared/src/stems', f), 'utf8');
    for (const dir of ['web/src/stems', 'server/src/services/separation']) {
      assert.equal(fs.readFileSync(path.join(root, dir, f), 'utf8'), canon, `${dir}/${f} is out of date: run node scripts/sync-types.mjs`);
    }
  }
});

test('LRC: metadata tags, multiple timestamps per line, sorting, empty lines', () => {
  const r = lrc.parseLrc('﻿[ti:Song Title]\n[ar:The Artist]\n[al:Album]\n[by:someone]\n[length: 03:20]\n[00:12.00][01:30.50]Chorus\n[00:05.10]Verse one\n[00:20.00]\n[00:21.5]short frac\n[00:22:50]colon frac\n[01:02.123]millis\n');
  assert.deepEqual(r.meta, { ti: 'Song Title', ar: 'The Artist', al: 'Album', by: 'someone', length: '03:20' });
  assert.deepEqual(r.synced.map((l) => [l.startMs, l.text]), [[5100, 'Verse one'], [12000, 'Chorus'], [20000, ''], [21500, 'short frac'], [22500, 'colon frac'], [62123, 'millis'], [90500, 'Chorus']]);
  assert.match(r.plain, /^Verse one\nChorus\n\nshort frac/);
});

test('LRC: [offset:] shifts every stamp (+ = earlier), words too', () => {
  const plus = lrc.parseLrc('[offset:+500]\n[00:10.00]<00:10.00>a <00:10.50>b\n[00:00.20]start');
  assert.deepEqual(plus.synced.map((l) => l.startMs), [0, 9500]);
  assert.deepEqual(plus.synced[1].words!.map((w) => w.startMs), [9500, 10000]);
  assert.equal(plus.offsetMs, 500);
  assert.equal(lrc.parseLrc('[offset:-250]\n[00:10.00]x').synced[0].startMs, 10250);
});

test('LRC: enhanced word timing (A2), trailing end stamp, repeated line stamps shift the words; writer round trip', () => {
  const r = lrc.parseLrc('[00:05.00]<00:05.00>Hel<00:05.40>lo <00:05.90>world<00:06.60>\n[00:08.00]First <00:08.50>word untimed\n[00:10.00][00:20.00]<00:10.00>re<00:10.30>peat');
  const [a, b, c, d] = r.synced;
  assert.equal(a.text, 'Hello world');
  assert.deepEqual(a.words, [{ startMs: 5000, text: 'Hel' }, { startMs: 5400, text: 'lo ' }, { startMs: 5900, text: 'world' }]);
  assert.equal(a.endMs, 6600);
  assert.deepEqual(b.words, [{ startMs: 8000, text: 'First ' }, { startMs: 8500, text: 'word untimed' }]);
  assert.deepEqual(c.words!.map((w) => w.startMs), [10000, 10300]);
  assert.deepEqual(d.words!.map((w) => w.startMs), [20000, 20300]);
  const text = lrc.buildLrc(r.synced);
  assert.deepEqual(lrc.parseLrc(text).synced, r.synced);
  assert.match(text, /\[00:05\.00\]<00:05\.00>Hel<00:05\.40>lo <00:05\.90>world<00:06\.60>/);
});

test('LRC: plain text, LRC detection, time formatting, normalise / shift helpers', () => {
  const r = lrc.parseLrc('Just some\nplain lyrics\n');
  assert.equal(r.synced.length, 0);
  assert.equal(r.plain, 'Just some\nplain lyrics');
  assert.equal(lrc.looksLikeLrc('[00:01.00]a\n[00:02.00]b'), true);
  assert.equal(lrc.looksLikeLrc('[ar:x]\n[00:01.00]a'), true);
  assert.equal(lrc.looksLikeLrc('Verse [1]\nchorus'), false);
  assert.equal(lrc.formatLrcTime(59999), '01:00.00');
  assert.equal(lrc.formatLrcTime(61234), '01:01.23');
  const n = lrc.normalizeLines([{ startMs: '3000', text: 'b' }, { startMs: 1000, text: 'a' }, { startMs: -1, text: 'bad' }, { startMs: 'x' }]);
  assert.deepEqual(n.map((l) => l.text), ['a', 'b']);
  assert.deepEqual(lrc.shiftLines(n, 500).map((l) => l.startMs), [1500, 3500]);
  assert.deepEqual(lrc.plainToLines('a\n\n\nb').map((l) => l.text), ['a', '', 'b']);
  assert.equal(lyrics.decodeText(Buffer.from([0xff, 0xfe, 0x61, 0, 0x62, 0])), 'ab');
  assert.equal(lyrics.decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9])), 'café');
});

test('lyric state at time t: line, word, wipe progress, gaps; offsets', () => {
  const { synced } = lrc.parseLrc('[00:10.00]one two\n[00:12.00]<00:12.00>two <00:13.00>words<00:14.00>\n[00:16.00]three');
  assert.equal(lrc.lineIndexAt(synced, 9990), -1);
  assert.equal(lrc.lyricStateAt(synced, 10000).line!.text, 'one two');
  const s = lrc.lyricStateAt(synced, 13500);
  assert.equal(s.line!.text, 'two words');
  assert.equal(s.wordIndex, 1);
  assert.ok(Math.abs(s.wordProgress - 0.5) < 1e-9);
  assert.equal(s.next!.text, 'three');
  assert.deepEqual(lrc.wordFills(s.line!, s).map((w) => w.fill), [1, 0.5]);
  assert.equal(lrc.lyricStateAt(synced, 15000).gap, true, 'after the end stamp = instrumental gap');
  // Line-only timing: the wipe moves across the words in proportion to their length.
  const st = lrc.lyricStateAt(synced, 11000);
  assert.ok(Math.abs(st.progress - 0.5) < 1e-9);
  const fills = lrc.wordFills(st.line!, st);
  assert.deepEqual(fills.map((f) => f.text), ['one', ' ', 'two']);
  assert.equal(fills[0].fill, 1);
  assert.equal(fills[2].fill, 0);
  // Offsets: + shows lyrics earlier; latency only while playing.
  assert.equal(lrc.lyricsTime(10000, 250, 40), 10210);
  assert.equal(lrc.lyricsTime(10000, -300, 40, false), 9700);
  assert.equal(lrc.lyricsTime(100, -300), 0);
});

/* ------------------------------------------------------------------ ID3 SYLT / USLT */

const syncsafe = (n: number) => Buffer.from([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);
const frame = (fid: string, body: Buffer, v = 4) => Buffer.concat([Buffer.from(fid), v === 4 ? syncsafe(body.length) : (() => { const b = Buffer.alloc(4); b.writeUInt32BE(body.length); return b; })(), Buffer.from([0, 0]), body]);
function id3Tag({ sylt, uslt, enc = 3, v = 4, format = 2 }: { sylt?: [string, number][]; uslt?: string; enc?: number; v?: number; format?: number }) {
  const str = (s: string) => (enc === 1 ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le'), Buffer.from([0, 0])]) : Buffer.concat([Buffer.from(s, enc === 0 ? 'latin1' : 'utf8'), Buffer.from([0])]));
  const frames: Buffer[] = [];
  if (sylt) {
    frames.push(frame('SYLT', Buffer.concat([Buffer.from([enc]), Buffer.from('eng'), Buffer.from([format, 1]), str(''),
      ...sylt.flatMap(([text, ms]) => { const b = Buffer.alloc(4); b.writeUInt32BE(ms); return [str(text), b]; })]), v));
  }
  if (uslt) frames.push(frame('USLT', Buffer.concat([Buffer.from([enc]), Buffer.from('eng'), str(''), enc === 1 ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(uslt, 'utf16le')]) : Buffer.from(uslt, 'utf8')]), v));
  frames.push(Buffer.alloc(32)); // padding
  const body = Buffer.concat(frames);
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([v, 0, 0]), syncsafe(body.length), body]);
}

test('ID3 SYLT parser: crafted v2.4 UTF-8 and v2.3 UTF-16 tags, syllables → words, MPEG-frame stamps', () => {
  const tag = id3Tag({ sylt: [['Hel', 1000], ['lo ', 1400], ['wörld', 1800], ['\nSecond', 2500], [' line', 2900]], uslt: 'Hello wörld\nSecond line' });
  const r = id3.parseId3Lyrics(tag);
  assert.equal(r.sylt.length, 1);
  assert.equal(r.sylt[0].language, 'eng');
  const lines = id3.syltToLines(r.sylt[0].entries, { format: r.sylt[0].format });
  assert.deepEqual(lines.map((x) => [x.startMs, x.text]), [[1000, 'Hello wörld'], [2500, 'Second line']]);
  assert.deepEqual(lines[0].words, [{ startMs: 1000, text: 'Hel' }, { startMs: 1400, text: 'lo ' }, { startMs: 1800, text: 'wörld' }]);
  assert.equal(r.uslt[0].text, 'Hello wörld\nSecond line');
  const u16 = id3.parseId3Lyrics(id3Tag({ sylt: [['Ünï', 500], ['code', 900]], uslt: 'Ünïcode', enc: 1, v: 3 }));
  assert.deepEqual(u16.sylt[0].entries.map((e) => [e.text, e.timestamp]), [['Ünï', 500], ['code', 900]]);
  assert.equal(u16.uslt[0].text, 'Ünïcode');
  const mpeg = id3.syltToLines([{ text: 'a', timestamp: 38 }, { text: 'b', timestamp: 76 }], { format: 1, sampleRate: 44100 });
  assert.equal(mpeg[0].startMs, Math.round((38 * 1152 * 1000) / 44100));
  assert.deepEqual(id3.parseId3Lyrics(Buffer.from('not a tag at all')), { sylt: [], uslt: [] });
  // Truncated / garbage frame sizes never throw.
  const bad = Buffer.from(tag);
  bad.writeUInt32BE(0x7f7f7f7f, 14);
  assert.doesNotThrow(() => id3.parseId3Lyrics(bad));
});

/* ------------------------------------------------------------------ embedded tags + source priority */

test('embedded lyrics: FLAC / MP3 / M4A `lyrics` tags (LRC detected as synced), SYLT and USLT in MP3', { skip }, async () => {
  const lrcText = '[00:00.50]first\n[00:01.20]second';
  for (const ext of ['flac', 'mp3', 'm4a']) {
    const f = path.join(tmp, `tag.${ext}`);
    ff('-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-metadata', `lyrics=${lrcText}`, f);
    const l = await lyrics.readEmbedded(f);
    assert.ok(l, ext);
    assert.equal(l!.synced, true, ext);
    assert.deepEqual(l!.lines.map((x) => [x.startMs, x.text]), [[500, 'first'], [1200, 'second']], ext);
  }
  const plainF = path.join(tmp, 'plain.flac');
  ff('-f', 'lavfi', '-i', 'sine=duration=1', '-metadata', 'UNSYNCEDLYRICS=Just words\nmore words', plainF);
  const p = await lyrics.readEmbedded(plainF);
  assert.equal(p!.synced, false);
  assert.deepEqual(p!.lines.map((x) => x.text), ['Just words', 'more words']);
  // ID3 SYLT (FFmpeg drops it) and USLT prepended to a raw MP3.
  const raw = path.join(tmp, 'raw.mp3');
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '0', '-write_xing', '0', raw);
  const sy = path.join(tmp, 'sylt.mp3');
  fs.writeFileSync(sy, Buffer.concat([id3Tag({ sylt: [['Hel', 1000], ['lo', 1400], ['\nBye', 2500]], uslt: 'Hello\nBye' }), fs.readFileSync(raw)]));
  const s = await lyrics.readEmbedded(sy);
  assert.equal(s!.synced, true);
  assert.deepEqual(s!.lines.map((x) => [x.startMs, x.text]), [[1000, 'Hello'], [2500, 'Bye']]);
  const us = path.join(tmp, 'uslt.mp3');
  fs.writeFileSync(us, Buffer.concat([id3Tag({ uslt: 'Unsynced words' }), fs.readFileSync(raw)]));
  const u = await lyrics.readEmbedded(us);
  assert.equal(u!.synced, false);
  assert.equal(u!.lines[0].text, 'Unsynced words');
});

/* ------------------------------------------------------------------ HTTP: lyrics + stems */

async function setupApp() {
  const { createUser, issueToken } = await import('../src/services/auth.ts');
  const { buildApp } = await import('../src/app.ts');
  const { db } = await import('../src/db.ts');
  const { updateMetadataSettings, getMetadataSettings } = await import('../src/services/metadata/config.ts');
  updateMetadataSettings({ providers: { ...getMetadataSettings().providers, lrclib: { enabled: false, apiKey: null } } });
  const now = new Date().toISOString();
  db.run('INSERT OR IGNORE INTO libraries (id, name, type, paths, created_at) VALUES (?, ?, ?, ?, ?)', 'lib-k', 'Music', 'music', JSON.stringify([tmp]), now);
  const addTrack = (id: string, file: string) => {
    db.run('INSERT INTO items (id, library_id, type, title, sort_title, added_at, updated_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, 'lib-k', 'track', `Track ${id}`, id, now, now, 3000);
    db.run('INSERT INTO media (id, item_id, path, container, duration_ms, size, mtime) VALUES (?,?,?,?,?,?,?)', `m-${id}`, id, file, path.extname(file).slice(1), 3000, 1, 0);
  };
  const admin = await createUser({ username: 'kadmin', password: 'pw-123456', isAdmin: true });
  const user = await createUser({ username: 'kuser', password: 'pw-123456', isAdmin: false });
  const at = issueToken(admin.id, { deviceId: 'k-a', deviceName: 'test', platform: 'web' }).token;
  const ut = issueToken(user.id, { deviceId: 'k-u', deviceName: 'test', platform: 'web' }).token;
  const app = await buildApp();
  return { app, addTrack, A: { authorization: `Bearer ${at}` }, U: { authorization: `Bearer ${ut}` }, db };
}
const ctx = hasFfmpeg ? await setupApp() : null;
after(async () => ctx?.app.close());

test('lyrics source priority: user edit > sidecar .lrc > .txt > embedded; editor + per-user offsets', { skip }, async () => {
  const { app, addTrack, A, U } = ctx!;
  const dir = path.join(tmp, 'prio');
  fs.mkdirSync(dir);
  const f = path.join(dir, 'Song.flac');
  ff('-f', 'lavfi', '-i', 'sine=duration=2', '-metadata', 'lyrics=[00:00.30]from tags\n[00:01.00]tag line 2', f);
  addTrack('t-prio', f);
  const get = async (h = U) => (await app.inject({ url: '/api/v1/items/t-prio/lyrics', headers: h })).json();
  let l = await get();
  assert.equal(l.source, 'embedded');
  assert.equal(l.lines[0].text, 'from tags');
  assert.equal(l.canEdit, false);
  fs.writeFileSync(path.join(dir, 'Song.txt'), 'plain txt words');
  l = await get();
  assert.equal(l.source, 'embedded', 'a synced embedded hit beats a plain .txt');
  fs.writeFileSync(path.join(dir, 'Song.flac.lrc'), '[00:00.40]from sidecar');
  l = await get();
  assert.equal(l.source, 'lrc');
  assert.equal(l.lines[0].text, 'from sidecar');
  fs.writeFileSync(path.join(dir, 'Song.LRC'), '[ar:X]\n[00:00.10]<00:00.10>upper <00:00.60>case');
  l = await get();
  assert.equal(l.lines[0].text, 'upper case', 'Song.LRC is tried before Song.flac.lrc');
  assert.deepEqual(l.lines[0].words.map((w: any) => w.startMs), [100, 600]);
  assert.match(l.lrc, /<00:00\.60>case/);

  // Editor: only admins save; user edits win; DELETE reverts.
  const denied = await app.inject({ method: 'PUT', url: '/api/v1/items/t-prio/lyrics', headers: U, payload: { lrc: '[00:01.00]nope' } });
  assert.equal(denied.statusCode, 403);
  const saved = await app.inject({ method: 'PUT', url: '/api/v1/items/t-prio/lyrics', headers: A, payload: { lines: [{ startMs: 500, text: 'mine' }, { startMs: 1500, text: 'too', words: [{ startMs: 1500, text: 'too' }] }], writeSidecar: true } });
  assert.equal(saved.statusCode, 200, saved.body);
  const sj = saved.json();
  assert.equal(sj.source, 'user');
  assert.equal(sj.wroteSidecar, null);
  assert.match(sj.sidecarError, /turned off/);
  assert.match(sj.lrc, /\[ti:Track t-prio\]/);
  assert.match(sj.lrc, /\[00:01\.50\]<00:01\.50>too/);
  assert.deepEqual((await get()).lines.map((x: any) => x.text), ['mine', 'too']);
  // Admin setting on: the .lrc is written next to the file.
  const { updateSettings } = await import('../src/services/settings.ts');
  updateSettings({ karaoke: { stemsEnabled: false, stemsModelUrl: null, stemsModelSha256: null, writeLrcSidecars: true } });
  const w = (await app.inject({ method: 'PUT', url: '/api/v1/items/t-prio/lyrics', headers: A, payload: { lrc: '[00:02.00]written', writeSidecar: true } })).json();
  assert.equal(w.wroteSidecar, path.join(dir, 'Song.lrc'));
  assert.match(fs.readFileSync(path.join(dir, 'Song.lrc'), 'utf8'), /\[00:02\.00\]written/);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/items/t-prio/lyrics', headers: A, payload: { lrc: '   ' } })).statusCode, 400);
  await app.inject({ method: 'DELETE', url: '/api/v1/items/t-prio/lyrics', headers: A });
  assert.equal((await get()).lines[0].text, 'written', 'after DELETE the (new) sidecar is used again');

  // Per-user offset.
  const o = await app.inject({ method: 'PUT', url: '/api/v1/items/t-prio/lyrics/offset', headers: U, payload: { offsetMs: -350 } });
  assert.deepEqual(o.json(), { offsetMs: -350 });
  assert.equal((await get()).userOffsetMs, -350);
  assert.equal((await get(A)).userOffsetMs, 0, 'offsets are per user');
  // Preferences: validated and clamped.
  const pr = await app.inject({ method: 'PATCH', url: '/api/v1/auth/me', headers: U, payload: { preferences: { lyricsOffsetMs: 99999, karaokeVocalLevel: 33.4, visualizerStyle: 'nope', nowPlayingView: 'karaoke' } } });
  assert.equal(pr.statusCode, 200, pr.body);
  const p = pr.json().preferences;
  assert.equal(p.lyricsOffsetMs, 5000);
  assert.equal(p.karaokeVocalLevel, 33);
  assert.equal(p.visualizerStyle, undefined);
  assert.equal(p.nowPlayingView, 'karaoke');
});

/** Power of `freq` in interleaved s16le stereo (left channel), Goertzel. */
function tonePower(pcm: Buffer, freq: number, rate = 44100) {
  const n = Math.floor(pcm.length / 4);
  const k = (2 * Math.PI * freq) / rate;
  const c = 2 * Math.cos(k);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 4) / 32768 + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / (n * n);
}
const sinePcm = (freq: number, frames: number, amp = 0.4) => {
  const b = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / 44100) * amp * 32767);
    b.writeInt16LE(v, i * 4);
    b.writeInt16LE(v, i * 4 + 2);
  }
  return b;
};

test('stems: upload in parts → FLAC cache, stem download, server-side karaoke mix with vocal gain', { skip }, async () => {
  const { app, addTrack, A, U } = ctx!;
  const { updateSettings } = await import('../src/services/settings.ts');
  const f = path.join(tmp, 'stems-src.flac');
  ff('-f', 'lavfi', '-i', 'sine=duration=2', f);
  addTrack('t-stems', f);
  // Off by default: preparing is refused.
  updateSettings({ karaoke: { stemsEnabled: false, stemsModelUrl: null, stemsModelSha256: null, writeLrcSidecars: false } });
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/items/t-stems/stems/begin', headers: A, payload: { frames: 100, sampleRate: 44100 } })).statusCode, 400);
  updateSettings({ karaoke: { stemsEnabled: true, stemsModelUrl: null, stemsModelSha256: null, writeLrcSidecars: false } });
  const st = (await app.inject({ url: '/api/v1/stems/status', headers: U })).json();
  assert.equal(st.enabled, true);
  assert.equal(st.canPrepare, false, 'only admins prepare');
  assert.equal(st.model.ready, false);
  assert.equal(st.model.sha256, stems.DEFAULT_MODEL.sha256);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/items/t-stems/stems/begin', headers: U, payload: { frames: 100, sampleRate: 44100 } })).statusCode, 403);

  const frames = 44100 * 2;
  const begin = await app.inject({ method: 'POST', url: '/api/v1/items/t-stems/stems/begin', headers: A, payload: { frames, sampleRate: 44100, model: 'test', backend: 'stub' } });
  assert.equal(begin.statusCode, 200, begin.body);
  const { token } = begin.json();
  assert.equal((await app.inject({ url: '/api/v1/items/t-stems/stems', headers: U })).json().preparing, true);
  const pcm: Record<string, Buffer> = { vocals: sinePcm(880, frames), drums: Buffer.alloc(frames * 4), bass: sinePcm(110, frames, 0.2), other: sinePcm(220, frames, 0.3) };
  const half = frames / 2;
  for (const [stem, buf] of Object.entries(pcm)) {
    for (const [frame, part] of [[0, buf.subarray(0, half * 4)], [half, buf.subarray(half * 4)]] as const) {
      const r = await app.inject({ method: 'PUT', url: `/api/v1/items/t-stems/stems/part?token=${token}&stem=${stem}&frame=${frame}`, headers: { ...A, 'content-type': 'application/octet-stream' }, payload: part });
      assert.equal(r.statusCode, 200, r.body);
    }
  }
  const outside = await app.inject({ method: 'PUT', url: `/api/v1/items/t-stems/stems/part?token=${token}&stem=vocals&frame=${frames}`, headers: { ...A, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(8) });
  assert.equal(outside.statusCode, 400);
  const fin = await app.inject({ method: 'POST', url: `/api/v1/items/t-stems/stems/finish?token=${token}`, headers: A });
  assert.equal(fin.statusCode, 200, fin.body);
  assert.equal(fin.json().ready, true);
  assert.equal(fin.json().format, 'flac');
  const stemRes = await app.inject({ url: '/api/v1/items/t-stems/stems/vocals', headers: { ...U, range: 'bytes=0-3' } });
  assert.equal(stemRes.statusCode, 206);
  assert.equal(stemRes.rawPayload.toString('latin1'), 'fLaC');

  const decode = async (q: string) => {
    const r = await app.inject({ url: `/api/v1/items/t-stems/karaoke.mp3?${q}`, headers: U });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.headers['content-type'], 'audio/mpeg');
    const mp3 = path.join(tmp, `mix-${q.replace(/\W/g, '_')}.mp3`);
    fs.writeFileSync(mp3, r.rawPayload);
    return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', mp3, '-f', 's16le', '-ac', '2', '-ar', '44100', '-']);
  };
  const full = await decode('vocals=100');
  const karaoke = await decode('vocals=0');
  const acapella = await decode('vocals=100&inst=0');
  const db = (a: number, b: number) => 10 * Math.log10(a / b);
  assert.ok(db(tonePower(full, 880), tonePower(karaoke, 880)) > 30, 'vocal tone removed in the karaoke mix');
  assert.ok(Math.abs(db(tonePower(full, 220), tonePower(karaoke, 220))) < 1, 'instrumental untouched');
  assert.ok(db(tonePower(full, 220), tonePower(acapella, 220)) > 30, 'instrumental removed in vocals-only');
  // Cached and seekable.
  const again = await app.inject({ url: '/api/v1/items/t-stems/karaoke.mp3?vocals=2', headers: { ...U, range: 'bytes=10-19' } }); // 2 → 0 (5 % steps)
  assert.equal(again.statusCode, 206);
  assert.equal(fs.readdirSync(path.join(stems.createStemStore().root, 't-stems')).filter((n) => n.startsWith('mix-')).length, 3);
  // Delete: admin only.
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/items/t-stems/stems', headers: U })).statusCode, 403);
  await app.inject({ method: 'DELETE', url: '/api/v1/items/t-stems/stems', headers: A });
  assert.equal((await app.inject({ url: '/api/v1/items/t-stems/karaoke.mp3', headers: U })).statusCode, 404);
});

test('mix helpers: 5 % steps, filter gains', () => {
  assert.equal(stems.mixLevel(undefined, 15), 15);
  assert.equal(stems.mixLevel('33', 15), 35);
  assert.equal(stems.mixLevel(-4, 15), 0);
  assert.equal(stems.mixLevel(400, 15), 100);
  assert.equal(stems.mixLevel('x', 15), 15);
  assert.match(stems.mixFilter(15, 100), /^\[0:a\]volume=0\.15\[v\];\[1:a\]volume=1\.00\[d\].*amix=inputs=4:normalize=0/);
  assert.throws(() => stems.modelSpec({ stemsModelUrl: 'ftp://x/y.onnx' }), /http/);
  const c = stems.modelSpec({ stemsModelUrl: 'https://example.com/m.tgz#package/m.onnx', stemsModelSha256: 'A'.repeat(64) });
  assert.equal(c.entry, 'package/m.onnx');
  assert.equal(c.sha256, 'a'.repeat(64));
  assert.equal(stems.modelSpec({}).id, 'htdemucs-v4');
  assert.throws(() => stems.modelSpec({ stemsModelUrl: 'https://example.com/m.onnx' }), /SHA-256/);
  // TXXX:SYNCEDLYRICS (Mp3tag / foobar2000) reaches FFmpeg as a plain SYNCEDLYRICS tag
  assert.equal(lyrics.fromTags({ SYNCEDLYRICS: '[00:01.00]Hi' })?.synced, true);
});

test('model download: tgz member extracted, SHA-256 verified (archive + model), mismatches rejected', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'model-'));
  fs.mkdirSync(path.join(dir, 'package'));
  const model = crypto.randomBytes(300_000);
  fs.writeFileSync(path.join(dir, 'package', 'net.onnx'), model);
  fs.writeFileSync(path.join(dir, 'package', 'README.md'), 'readme');
  const tgz = path.join(tmp, 'model.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', dir, 'package']);
  const archive = fs.readFileSync(tgz);
  const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
  const srv = http.createServer((req, res) => {
    if (req.url === '/model.tgz') {
      res.writeHead(200, { 'content-length': archive.length });
      res.end(archive);
    } else if (req.url === '/raw.onnx') res.end(model);
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  try {
    const spec = { ...stems.DEFAULT_MODEL, url: `${base}/model.tgz`, entry: 'package/net.onnx', archiveSha256: sha(archive), sha256: sha(model), bytes: model.length, downloadBytes: archive.length };
    const store = stems.createStemStore({ dataDir: path.join(tmp, 'store1'), defaultModel: spec });
    assert.equal(store.startDownload({}).ready, false);
    await store.downloadDone();
    const s = store.modelStatus({});
    assert.equal(s!.ready, true, s!.error ?? '');
    assert.equal(s!.verified, true);
    assert.deepEqual(fs.readFileSync(store.modelFile({})!), model);
    assert.equal(store.startDownload({}).ready, true, 'already there');
    store.close();

    const wrong = stems.createStemStore({ dataDir: path.join(tmp, 'store2'), defaultModel: { ...spec, sha256: 'f'.repeat(64) } });
    wrong.startDownload({});
    await wrong.downloadDone();
    assert.equal(wrong.modelStatus({})!.ready, false);
    assert.match(wrong.modelStatus({})!.error!, /SHA-256 mismatch/);
    assert.equal(fs.readdirSync(path.join(tmp, 'store2', 'stems', 'models')).length, 0, 'no partial file left behind');
    wrong.close();

    const badArchive = stems.createStemStore({ dataDir: path.join(tmp, 'store3'), defaultModel: { ...spec, archiveSha256: '0'.repeat(64) } });
    badArchive.startDownload({});
    await badArchive.downloadDone();
    assert.match(badArchive.modelStatus({})!.error!, /archive SHA-256/);
    badArchive.close();

    // Custom, pinned, plain .onnx URL from the admin settings.
    const custom = stems.createStemStore({ dataDir: path.join(tmp, 'store4') });
    const k = { stemsModelUrl: `${base}/raw.onnx`, stemsModelSha256: sha(model) };
    custom.startDownload(k);
    await custom.downloadDone();
    assert.equal(custom.modelStatus(k)!.verified, true);
    custom.close();
  } finally {
    srv.close();
  }
});
