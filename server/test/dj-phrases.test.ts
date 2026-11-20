// DJ phrase detection, phrase-aligned mix points, the transition chooser and the ffmpeg transition renderer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DjPhrase, DjTransition, TrackAnalysis } from '@mediamax/shared';
import { analyseAll, analysePcm, analysisStatus, decodePcm, getAnalysis, ANALYSIS_VERSION } from '../src/services/dj/analysis.ts';
import { db } from '../src/db.ts';
import { detectPhrases, phraseMixPoints } from '../src/services/dj/phrases.ts';
import { bassSwapPoint, chooseFx, planTransition } from '../src/services/dj/mix.ts';
import { buildTransitionGraph, ffmpegHasFilter, renderTransition } from '../src/services/dj/render.ts';

const ffmpeg = process.env.MEDIAMAX_FFMPEG ?? 'ffmpeg';
const hasFfmpeg = spawnSync(ffmpeg, ['-version']).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-djphr-'));

const BPM = 124;
const BEAT = 60 / BPM;
const BAR = 4 * BEAT;
const D0 = 0.5; // first downbeat (s)

/**
 * A synthetic dance track rendered by ffmpeg (aevalsrc), sections in whole bars from D0:
 * intro 16 (hats + pad) → drop 32 (kick, off-beat bass, hats) → breakdown 16 (pad + hats) → drop 16 → outro 16 (kick + hats, fading).
 */
function synthTrack(file: string, bpm = BPM, sections = [16, 32, 16, 16, 16]) {
  const beat = 60 / bpm;
  const bar = 4 * beat;
  const [i, d1, br, d2, o] = sections;
  const at = (bars: number) => (D0 + bars * bar).toFixed(4);
  const gate = (a: number, b: number) => `between(t,${at(a)},${at(b)})`;
  const u = `mod(t-${D0},${beat.toFixed(5)})`;
  const u2 = `mod(t-${(D0 + beat / 2).toFixed(5)},${beat.toFixed(5)})`;
  const kick = `0.8*sin(2*PI*55*${u})*exp(-18*${u})`;
  const bass = `0.35*sin(2*PI*55*${u2})*lt(${u2},${(beat * 0.45).toFixed(4)})*gte(t,${(D0 + beat / 2).toFixed(4)})`;
  const hats = `0.1*(2*random(0)-1)*exp(-90*mod(t-${D0},${(beat / 2).toFixed(5)}))`;
  const pad = `(sin(2*PI*220*t)+sin(2*PI*261.63*t)+sin(2*PI*329.63*t))`;
  const s1 = i, s2 = s1 + d1, s3 = s2 + br, s4 = s3 + d2, s5 = s4 + o;
  const fade = `(1-0.7*(t-${at(s4)})/${(o * bar).toFixed(4)})`;
  const expr = [
    `${hats}*lt(t,${at(s5)})`,
    `0.05*${pad}*(${gate(0, s1)}+${gate(s1, s2)}+${gate(s3, s4)})`,
    `0.12*${pad}*${gate(s2, s3)}`,
    `(${kick}+${bass})*(${gate(s1, s2)}+${gate(s3, s4)})`,
    `${kick}*${fade}*${gate(s4, s5)}`,
  ].join('+');
  const dur = (D0 + s5 * bar + 1).toFixed(2);
  const r = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc=exprs='${expr}':s=22050:d=${dur}`, '-ac', '1', '-c:a', 'pcm_s16le', file]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  return { boundaries: [s1, s2, s3, s4].map((b) => (D0 + b * bar) * 1000), durMs: Number(dur) * 1000 };
}

test('phrase detection on an ffmpeg-generated track: boundaries within ±1 bar, sections labelled', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const file = path.join(tmp, 'track.wav');
  const { boundaries } = synthTrack(file);
  const pcm = await decodePcm(file);
  const a = analysePcm(pcm);
  assert.ok(a.bpm && Math.abs(a.bpm - BPM) < 0.5, `bpm ${a.bpm}`);
  assert.ok(a.phrases && a.phrases.length >= 4, `phrases: ${JSON.stringify(a.phrases)}`);
  assert.ok(a.downbeatMs != null && Math.abs(a.downbeatMs - D0 * 1000) <= BAR * 1000, `downbeat ${a.downbeatMs}`);
  const starts = a.phrases!.map((p) => p.startMs);
  for (const b of boundaries) {
    const near = starts.reduce((best, s) => (Math.abs(s - b) < Math.abs(best - b) ? s : best), Infinity);
    assert.ok(Math.abs(near - b) <= BAR * 1000 + 1, `boundary at ${(b / 1000).toFixed(1)} s: nearest phrase start ${(near / 1000).toFixed(1)} s (${starts.map((x) => (x / 1000).toFixed(1)).join(', ')})`);
  }
  const typeAt = (ms: number) => a.phrases!.find((p) => ms >= p.startMs && ms < p.endMs)?.type;
  assert.equal(a.phrases![0].type, 'intro');
  assert.equal(typeAt(boundaries[0] + 8 * BAR * 1000), 'drop');
  assert.equal(typeAt(boundaries[1] + 8 * BAR * 1000), 'breakdown');
  assert.equal(typeAt(boundaries[2] + 8 * BAR * 1000), 'drop');
  assert.equal(a.phrases![a.phrases!.length - 1].type, 'outro');
  // Phrases are whole bars long and long sections are split into 16-bar phrases.
  for (const p of a.phrases!.slice(1, -1)) assert.ok(p.bars >= 4 && p.bars <= 32, `phrase of ${p.bars} bars`);
  // Mix-out lands on the outro start (within a bar), mix-in on the first downbeat.
  const mp = phraseMixPoints(a.phrases!, a.downbeatMs!, a.bpm, a.cueOutMs);
  assert.ok(mp.fromOutro);
  assert.ok(Math.abs(mp.mixOutMs - boundaries[3]) <= BAR * 1000 + 1, `mixOut ${mp.mixOutMs} vs ${boundaries[3]}`);
});

test('phrase detection: no tempo → no phrases', () => {
  const r = detectPhrases(new Float32Array(11025 * 10), 11025, null, null);
  assert.deepEqual(r.phrases, []);
});

const bar128 = (60000 / 128) * 4;
const phrasesFor = (downbeat: number, spec: [DjPhrase['type'], number][], bar = bar128): DjPhrase[] => {
  let t = downbeat;
  return spec.map(([type, bars]) => {
    const p = { startMs: Math.round(t), endMs: Math.round(t + bars * bar), type, bars, energy: type === 'drop' ? 1 : 0.5 };
    t += bars * bar;
    return p;
  });
};
const A = (o: Partial<TrackAnalysis>): TrackAnalysis => ({
  itemId: 'x', bpm: 128, bpmConfidence: 0.9, beatOffsetMs: 100, key: 'A minor', camelot: '8A', energy: 0.8, loudnessDb: -10,
  cueInMs: 0, cueOutMs: 240000, introEndMs: 16000, outroStartMs: 200000, durationMs: 240000, analyzedAt: '', timbre: null, ...o,
});

test('mix points snap to phrases: outro of A → intro of B', () => {
  // A: 100 ms downbeat, intro 16 / drop 32 / breakdown 16 / drop 32 / outro 16 bars.
  const pa = phrasesFor(100, [['intro', 16], ['drop', 32], ['breakdown', 16], ['drop', 32], ['outro', 16]]);
  const end = pa[pa.length - 1].endMs;
  const a = A({ downbeatMs: 100, phrases: pa, cueOutMs: end, durationMs: end + 2000 });
  const pb = phrasesFor(220, [['intro', 16], ['drop', 32]]);
  const b = A({ camelot: '9A', bpm: 126, beatOffsetMs: 40, downbeatMs: 220, phrases: pb, cueInMs: 150 });
  const t = planTransition(a, a.durationMs, b);
  assert.equal(t.style, 'blend');
  assert.equal(t.phraseAligned, true);
  assert.equal(t.mixOutMs, pa[4].startMs, 'starts on the outro phrase');
  assert.equal(t.outPhrase, 'outro');
  assert.equal(t.inPhrase, 'intro');
  assert.equal(t.mixInMs, 220, 'B starts on its first downbeat');
  assert.ok(t.mixOutMs + t.crossfadeMs <= a.cueOutMs);
  assert.ok(Math.abs(t.crossfadeMs / bar128 - Math.round(t.crossfadeMs / bar128)) < 0.01, 'whole bars');
  assert.ok(t.fx === 'bassSwap' && t.swapAtMs != null && t.swapAtMs > 0 && t.swapAtMs < t.crossfadeMs);
});

test('an outro just shorter than the planned blend shortens the blend instead of leaving the phrase line', () => {
  const pa = phrasesFor(100, [['intro', 16], ['drop', 32], ['breakdown', 16], ['drop', 32], ['outro', 16]]);
  const end = pa[pa.length - 1].endMs - 300; // audio fades out a little before the last bar line
  const a = A({ downbeatMs: 100, phrases: pa, cueOutMs: end, durationMs: end + 1000 });
  const b = A({ camelot: '9A', bpm: 126, beatOffsetMs: 40, downbeatMs: 220, phrases: phrasesFor(220, [['intro', 32], ['drop', 32]]), cueInMs: 150 });
  const t = planTransition(a, a.durationMs, b, { preference: 'smooth' });
  assert.equal(t.mixOutMs, pa[4].startMs);
  assert.equal(t.phraseAligned, true);
  assert.ok(t.mixOutMs + t.crossfadeMs <= a.cueOutMs);
  assert.ok(t.crossfadeMs >= 15 * bar128, `still about 16 bars: ${t.crossfadeMs}`);
});

test('mix points fall back to bars without phrases', () => {
  const t = planTransition(A({}), 240000, A({ camelot: '9A', bpm: 126, beatOffsetMs: 40 }));
  assert.equal(t.phraseAligned, false);
  assert.ok(Math.abs(((t.mixOutMs - 100) / bar128) - Math.round((t.mixOutMs - 100) / bar128)) < 0.01, 'on a bar line');
  assert.ok(t.mixOutMs <= 200000);
});

test('bass swap point: a phrase start of the incoming track near the middle, else an 8/4-bar line', () => {
  const pb = phrasesFor(0, [['intro', 8], ['verse', 16]]);
  const b = A({ phrases: pb, downbeatMs: 0 });
  // 16-bar transition at ratio 1: the 8-bar phrase line is exactly in the middle.
  assert.equal(Math.round(bassSwapPoint(b, 0, 16 * bar128, 1, bar128)), Math.round(8 * bar128));
  const nb = A({ phrases: null });
  assert.equal(Math.round(bassSwapPoint(nb, 0, 16 * bar128, 1, bar128)), Math.round(8 * bar128));
  // At ratio 1.05 the incoming track runs faster: its 8-bar line comes earlier on the wall clock.
  assert.equal(Math.round(bassSwapPoint(b, 0, 16 * bar128, 1.05, bar128)), Math.round((8 * bar128) / 1.05));
});

test('transition chooser', () => {
  const base = { style: 'blend' as const, preference: 'auto' as const, energyDelta: 0, tempoGap: 0.01, keyMatch: 'compatible' as const, outPhrase: 'outro' as const, inPhrase: 'intro' as const, hasBeat: true, genres: ['house'] };
  assert.equal(chooseFx(base).fx, 'bassSwap');
  assert.equal(chooseFx({ ...base, energyDelta: -0.3 }).fx, 'filter', 'energy falls → filter fade');
  assert.equal(chooseFx({ ...base, preference: 'minimal' }).fx, 'none');
  assert.equal(chooseFx({ ...base, style: 'cut', tempoGap: 0.3, keyMatch: 'clash' }).fx, 'echo', 'nothing matches → echo out');
  assert.equal(chooseFx({ ...base, style: 'fade', tempoGap: 0.2 }).fx, 'echo', 'tempo gap too big → echo out');
  assert.equal(chooseFx({ ...base, style: 'fade', tempoGap: 0.2, preference: 'smooth' }).fx, 'filter');
  assert.equal(chooseFx({ ...base, style: 'fade', tempoGap: 0.02, keyMatch: 'clash' }).fx, 'filter', 'key clash at a close tempo → HPF out');
  assert.equal(chooseFx({ ...base, genres: ['folk'] }).fx, 'none', 'acoustic → plain blend');
  assert.equal(chooseFx({ ...base, style: 'fade', hasBeat: false, genres: [] }).fx, 'none');
  assert.equal(chooseFx({ ...base, preference: 'energetic', outPhrase: 'drop', energyDelta: -0.2 }).fx, 'echo');
  // Wired through planTransition: an unbeatable pair gets the echo-out, 2 bars long.
  const t = planTransition(A({}), 240000, A({ camelot: '3B', bpm: 90 }));
  assert.equal(t.style, 'cut');
  assert.equal(t.fx, 'echo');
  assert.ok(Math.abs(t.crossfadeMs - 2 * bar128) < 2);
  // The stretch limit is configurable: 10 % apart blends only when allowed.
  const far = A({ camelot: '9A', bpm: 116.4 });
  assert.notEqual(planTransition(A({}), 240000, far).style, 'blend');
  const ok = planTransition(A({}), 240000, far, { maxStretch: 0.12 });
  assert.equal(ok.style, 'blend');
  assert.ok(Math.abs(ok.tempoRatio - 128 / 116.4) < 0.002);
  // Half-time partner: 64 BPM blends with 128 at ratio 1.
  assert.equal(planTransition(A({}), 240000, A({ camelot: '8A', bpm: 64 })).tempoRatio, 1);
});

const T = (o: Partial<DjTransition>): DjTransition => ({ mixOutMs: 60000, mixInMs: 500, crossfadeMs: 15000, tempoRatio: 1.03, style: 'blend', keyMatch: 'compatible', bpmDelta: 3, fx: 'bassSwap', swapAtMs: 7500, beatMs: 468.75, ...o });

test('ffmpeg transition graphs', () => {
  const swap = buildTransitionGraph(T({}), { leadMs: 8000, tailMs: 6000, rubberband: true, glideMs: 8000 });
  assert.match(swap.graph, /rubberband@tb=tempo=1\.03:pitch=1/);
  assert.match(swap.graph, /lowpass=f=200,lowpass=f=200/);
  assert.match(swap.graph, /highpass=f=200,highpass=f=200/);
  assert.match(swap.graph, /if\(lt\(t,15\.5\),1/, 'A lows until the swap (8 s lead + 7.5 s)');
  assert.match(swap.graph, /asendcmd=c='[^']*rubberband@tb tempo 1'/, 'glides back to 1.0');
  assert.equal(swap.stretch, 'rubberband');
  assert.equal(swap.aStartMs, 52000);
  assert.equal(swap.totalMs, 8000 + 15000 + 6000);
  const at = buildTransitionGraph(T({}), { rubberband: false });
  assert.match(at.graph, /atempo@tb=1\.03/);
  assert.equal(at.stretch, 'atempo');
  const filt = buildTransitionGraph(T({ fx: 'filter' }));
  assert.match(filt.graph, /highpass@hpA=f=20/);
  assert.match(filt.graph, /asendcmd=c='8 highpass@hpA f 20;/);
  const echo = buildTransitionGraph(T({ fx: 'echo', crossfadeMs: 3750, style: 'cut', tempoRatio: 1 }));
  assert.match(echo.graph, /aecho=0:1:352\|703\|1055/, "3/4-beat feedback taps");
  assert.equal(echo.stretch, 'none');
  assert.ok(!/atempo|rubberband/.test(echo.graph));
  const plain = buildTransitionGraph(T({ fx: 'none', style: 'fade', tempoRatio: 1 }));
  assert.match(plain.graph, /cos\(\(t-8\)\/15\*PI\/2\)/);
});

test('ffmpeg renders every transition style from two generated tracks', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const a = path.join(tmp, 'a.wav');
  const b = path.join(tmp, 'b.wav');
  synthTrack(a, 128, [8, 16, 8, 8, 8]);
  synthTrack(b, 124, [8, 16, 8, 8, 8]);
  const rb = ffmpegHasFilter('rubberband', ffmpeg);
  for (const fx of ['bassSwap', 'filter', 'echo', 'none'] as const) {
    for (const rubberband of rb ? [true, false] : [false]) {
      const plan = buildTransitionGraph(T({ fx, mixOutMs: 40000, crossfadeMs: fx === 'echo' ? 3750 : 15000, tempoRatio: 128 / 124 }), { leadMs: 4000, tailMs: 4000, rubberband, glideMs: 3000 });
      const out = path.join(tmp, `mix-${fx}-${rubberband}.wav`);
      await renderTransition(a, b, plan, out, 'wav', ffmpeg);
      const pcm = await decodePcm(out);
      const secs = pcm.length / 11025;
      assert.ok(Math.abs(secs - plan.totalMs / 1000) < 0.3, `${fx}/${rubberband}: ${secs.toFixed(2)} s vs ${plan.totalMs / 1000}`);
      let peak = 0;
      for (const v of pcm) peak = Math.max(peak, Math.abs(v));
      // Limited at 0.97; decoding back at 11025 Hz can add small inter-sample overs.
      assert.ok(peak > 0.05 && peak <= 1.1, `${fx}: peak ${peak}`);
    }
  }
});

test('version bump: old analyses stay usable and are upgraded a batch at a time; new files are never capped', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const file = path.join(tmp, 'lib-track.wav');
  synthTrack(file, 126, [8, 8, 8, 8, 8]);
  const now = new Date().toISOString();
  const mtime = fs.statSync(file).mtimeMs | 0;
  db.run('INSERT OR IGNORE INTO libraries (id, name, type, paths, created_at) VALUES (?, ?, ?, ?, ?)', 'lib-dj', 'Music', 'music', JSON.stringify([tmp]), now);
  const copy = (n: number) => {
    const f = path.join(tmp, `lib-track-${n}.wav`);
    fs.copyFileSync(file, f);
    return f;
  };
  for (const n of [1, 2, 3]) {
    db.run('INSERT INTO items (id, library_id, type, title, sort_title, added_at, updated_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', `trk-${n}`, 'lib-dj', 'track', `T${n}`, `t${n}`, now, now, 90000);
    db.run('INSERT INTO media (id, item_id, path, container, duration_ms, size, mtime) VALUES (?,?,?,?,?,?,?)', `m-${n}`, `trk-${n}`, copy(n), 'wav', 90000, 1, mtime);
  }
  assert.equal(await analyseAll(), 3);
  assert.equal(getAnalysis('trk-1')?.phrases?.length ? true : false, true, 'phrases stored');
  // Pretend the analyses came from the previous algorithm version.
  db.run('UPDATE track_analysis SET version = ? WHERE item_id LIKE ?', ANALYSIS_VERSION - 1, 'trk-%');
  assert.equal(analysisStatus().analyzed >= 3, true, 'outdated analyses still count as analysed');
  assert.ok(getAnalysis('trk-2')?.bpm, 'and are still served');
  // A new track arrives: it is analysed even with an upgrade cap of 1, plus exactly one upgrade.
  db.run('INSERT INTO items (id, library_id, type, title, sort_title, added_at, updated_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'trk-4', 'lib-dj', 'track', 'T4', 't4', now, now, 90000);
  db.run('INSERT INTO media (id, item_id, path, container, duration_ms, size, mtime) VALUES (?,?,?,?,?,?,?)', 'm-4', 'trk-4', copy(4), 'wav', 90000, 1, mtime);
  assert.equal(await analyseAll(undefined, Infinity, undefined, 1), 2);
  const versions = db.all<{ version: number }>('SELECT version FROM track_analysis WHERE item_id LIKE ? ORDER BY item_id', 'trk-%').map((r) => r.version);
  assert.equal(versions.filter((v) => v === ANALYSIS_VERSION).length, 2);
  assert.equal(await analyseAll(undefined, Infinity, undefined, 0), 0, 'cap 0: nothing upgraded');
});
