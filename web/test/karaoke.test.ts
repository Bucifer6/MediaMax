// Karaoke state at time t, lyrics editor model, visualiser helpers, quick vocal-reduction gains and the stems DSP
// (cases partly adapted from OpenDJ, MIT).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lyricStateAt, lyricsTime, parseLrc, wordFills } from '../src/lyrics/lrc.ts';
import { fillUntimed, firstUntimed, linesFromText, linesToLrc, shiftAll, tapLine } from '../src/lyrics/editorModel.ts';
import { barLevels, beatPhase, bassEnergy, capDpr, mirrored, OnsetDetector, paletteFromPixels, pulseFromPhase, rmsLevel, withAlpha } from '../src/visualizer/core.ts';
import { vocalPathGains } from '../src/player/karaokeFx.ts';
import { BINS, demucsISpec, demucsSpec, fftPlan, planChunks, separateChunked, specFrames } from '../src/stems/dsp.ts';
import { createRunner, createStubSession, StubTensor, type TensorCtor } from '../src/stems/model.ts';

const LRC = '[ar:Test]\n[00:01.00]<00:01.00>Hel<00:01.40>lo <00:02.00>world<00:03.00>\n[00:04.00]plain line here\n[00:08.00]\n[00:09.00]last';

test('karaoke state at time t: word highlight with A2 timing', () => {
  const { synced } = parseLrc(LRC);
  const at = (ms: number) => lyricStateAt(synced, ms);
  assert.equal(at(500).index, -1);
  const s = at(1200);
  assert.equal(s.index, 0);
  assert.equal(s.wordIndex, 0);
  assert.ok(Math.abs(s.wordProgress - 0.5) < 1e-9);
  assert.deepEqual(wordFills(s.line!, s).map((w) => [w.text, w.fill]), [['Hel', 0.5], ['lo ', 0], ['world', 0]]);
  const s2 = at(2500);
  assert.deepEqual(wordFills(s2.line!, s2).map((w) => w.fill), [1, 1, 0.5]);
  assert.equal(at(3500).gap, true, 'after the end stamp: instrumental gap');
  assert.equal(at(3500).next!.text, 'plain line here');
});

test('karaoke state at time t: wipe across a line with only line timing; empty line is a gap', () => {
  const { synced } = parseLrc(LRC);
  const s = lyricStateAt(synced, 6000); // half way 4 s → 8 s
  assert.ok(Math.abs(s.progress - 0.5) < 1e-9);
  const fills = wordFills(s.line!, s);
  assert.deepEqual(fills.map((f) => f.text), ['plain', ' ', 'line', ' ', 'here']);
  assert.equal(fills[0].fill, 1);
  assert.ok(fills[2].fill > 0 && fills[2].fill < 1);
  assert.equal(fills[4].fill, 0);
  assert.equal(lyricStateAt(synced, 8500).gap, true);
});

test('offset math: per-track + global offset, output latency only while playing', () => {
  const { synced } = parseLrc(LRC);
  // +300 ms offset: line 2 shows 300 ms earlier.
  assert.equal(lyricStateAt(synced, lyricsTime(3750, 300, 0)).index, 1);
  assert.equal(lyricStateAt(synced, lyricsTime(3750, 0, 0)).index, 0);
  // 100 ms latency delays what is shown while playing.
  assert.equal(lyricsTime(4050, 0, 100, true), 3950);
  assert.equal(lyricsTime(4050, 0, 100, false), 4050);
});

test('lyrics editor model: tap-to-sync, undo-friendly immutability, shift, interpolation, LRC out', () => {
  let lines = linesFromText('first\nsecond\nthird\nfourth');
  assert.equal(firstUntimed(lines), 0);
  const before = lines;
  lines = tapLine(lines, 0, 1000.4);
  assert.equal(before[0].startMs, null, 'input not mutated');
  assert.equal(lines[0].startMs, 1000);
  lines = tapLine(lines, 3, 7000);
  const filled = fillUntimed(lines);
  assert.deepEqual(filled.map((l) => l.startMs), [1000, 3000, 5000, 7000]);
  assert.deepEqual(shiftAll(lines, -1500).map((l) => l.startMs), [0, null, null, 5500]);
  const lrc = linesToLrc(lines, { ti: 'T' });
  assert.match(lrc, /^\[ti:T\]/);
  assert.match(lrc, /\[00:03\.00\]second/);
  // Word timing moves with a re-tapped line.
  const w = tapLine(linesFromText('[00:01.00]<00:01.00>a <00:01.50>b'), 0, 2000);
  assert.deepEqual(w[0].words!.map((x) => x.startMs), [2000, 2500]);
  assert.equal(linesToLrc(linesFromText('only\nplain')), 'only\nplain\n');
});

test('visualiser helpers: log bar mapping, beat phase, pulse, energy, onset detector, palette', () => {
  const freq = new Uint8Array(1024);
  // 1 kHz bin at 48 kHz / 2048 FFT = bin 42.7
  freq[43] = 255;
  const bars = barLevels(freq, 32, 48000, 40, 16000);
  const peak = bars.indexOf(Math.max(...bars));
  const expected = Math.floor((Math.log(1000 / 40) / Math.log(16000 / 40)) * 32);
  assert.ok(Math.abs(peak - expected) <= 1, `${peak} vs ${expected}`);
  assert.equal(bars.filter((b) => b > 0).length <= 2, true);
  assert.deepEqual(beatPhase(1250, 120, 250), { beat: 2, phase: 0 });
  const bp = beatPhase(1500, 120, 250)!;
  assert.ok(Math.abs(bp.phase - 0.5) < 1e-9);
  assert.equal(beatPhase(1000, null, 0), null);
  assert.equal(pulseFromPhase(0), 1);
  assert.ok(pulseFromPhase(0.5) < 0.1);
  const lows = new Uint8Array(1024);
  lows.fill(255, 0, 7);
  assert.ok(bassEnergy(lows, 48000, 160) > 0.95);
  assert.equal(rmsLevel(new Uint8Array(64).fill(128)), 0);
  assert.deepEqual(mirrored([1, 2, 3]), [3, 2, 1, 1, 2, 3]);
  // Onsets on a periodic kick (every 500 ms at 60 fps) but not on a steady tone.
  const od = new OnsetDetector();
  let onsets = 0;
  for (let f = 0; f < 300; f++) {
    const now = f * (1000 / 60);
    const fr = new Uint8Array(64).fill(20);
    if (f % 30 === 0) fr.fill(240, 0, 24);
    if (od.update(fr, now, 1000 / 60)) onsets++;
  }
  assert.ok(onsets >= 8 && onsets <= 10, `onsets ${onsets}`);
  const steady = new OnsetDetector();
  let s2 = 0;
  for (let f = 0; f < 300; f++) if (steady.update(new Uint8Array(64).fill(200), f * 16, 16)) s2++;
  assert.equal(s2, 0);
  const px: number[] = [];
  for (let i = 0; i < 100; i++) px.push(220, 30, 40, 255); // red
  for (let i = 0; i < 60; i++) px.push(30, 60, 220, 255); // blue
  for (let i = 0; i < 40; i++) px.push(5, 5, 5, 255); // near black (de-weighted)
  const pal = paletteFromPixels(px, 3);
  assert.ok(pal[0].r > 200 && pal[0].b < 60);
  assert.ok(pal.some((c) => c.b > 200));
  assert.equal(withAlpha('#ff0000', 0.5), 'rgba(255,0,0,0.5)');
  assert.equal(capDpr(3, true, 1920), 1);
  assert.equal(capDpr(3, false, 1200), 2);
});

test('quick vocal reduction gains: transparent at 100 %, centre removed at 0 %', () => {
  assert.deepEqual(vocalPathGains(1), { mid: 1, low: 0, side: 1 });
  assert.deepEqual(vocalPathGains(0), { mid: 0, low: 1, side: 1.5 });
  assert.deepEqual(vocalPathGains(0.5), { mid: 0.5, low: 0.5, side: 1.25 });
  assert.deepEqual(vocalPathGains(7), { mid: 1, low: 0, side: 1 });
  assert.deepEqual(vocalPathGains(NaN), { mid: 1, low: 0, side: 1 });
});

const maxAbs = (a: ArrayLike<number>, b: ArrayLike<number>, from = 0, to = a.length) => {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
function noise(n: number, seed = 1) {
  let s = seed;
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    o[i] = (s / 0x7fffffff - 0.5) * 0.8;
  }
  return o;
}

test('stems DSP: FFT vs naive DFT, sine in the right bin, ispec(spec(x)) ≈ x', () => {
  const n = 64, p = fftPlan(n), x = noise(n, 3), y = noise(n, 4);
  const re = Float64Array.from(x), im = Float64Array.from(y);
  p.fft(re, im);
  for (const k of [0, 1, 5, 31, 63]) {
    let sr = 0, si = 0;
    for (let t = 0; t < n; t++) {
      const a = (-2 * Math.PI * k * t) / n;
      sr += x[t] * Math.cos(a) - y[t] * Math.sin(a);
      si += x[t] * Math.sin(a) + y[t] * Math.cos(a);
    }
    assert.ok(Math.abs(re[k] - sr) < 1e-9 && Math.abs(im[k] - si) < 1e-9);
  }
  const len = 30000, mix = new Float32Array(2 * len);
  for (let i = 0; i < len; i++) {
    mix[i] = 0.3 * Math.sin((2 * Math.PI * 1000 * i) / 44100);
    mix[len + i] = 0.2 * Math.sin((2 * Math.PI * 3000 * i) / 44100);
  }
  const le = specFrames(len), z = demucsSpec(mix, 2, len);
  let best = 0, bi = 0;
  for (let f = 0; f < BINS; f++) {
    const m = Math.hypot(z[(0 * BINS + f) * le + 10], z[(1 * BINS + f) * le + 10]);
    if (m > best) { best = m; bi = f; }
  }
  assert.equal(bi, Math.round((1000 * 4096) / 44100));
  const back = demucsISpec(z, 1, 2, len);
  assert.ok(maxAbs(back, mix, 2048, len - 2048) < 1e-4);
});

test('stems: chunked separation with the stub model sums back to the input; overlap-add order', async () => {
  const seg = 16384;
  const runner = createRunner(createStubSession(seg), StubTensor as unknown as TensorCtor);
  assert.equal(runner.kind, 'hybrid');
  assert.equal(runner.segment, seg);
  const len = 40000;
  const L = noise(len, 7), R = noise(len, 8);
  const sum = [new Float32Array(len), new Float32Array(len)];
  let expect = 0;
  await separateChunked({
    channels: [L, R], length: len, segment: runner.segment, sources: 4, runChunk: runner.runChunk,
    onBlock: ({ frame, frames, data }) => {
      assert.equal(frame, expect);
      expect += frames;
      for (let s = 0; s < 4; s++) for (let c = 0; c < 2; c++) for (let i = 0; i < frames; i++) sum[c][frame + i] += data[(s * 2 + c) * frames + i];
    },
  });
  assert.equal(expect, len);
  assert.equal(planChunks(len, seg).chunks.length, Math.ceil(len / Math.floor(0.75 * seg)));
  assert.ok(maxAbs(sum[0], L) < 1e-3 && maxAbs(sum[1], R) < 1e-3, 'stems sum to the mix');
});
