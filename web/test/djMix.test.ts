import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyLockShifter, resample, stretch } from '../src/player/djWsola';
import { automationCurves, glideMs, incomingRate, levelsAt, OPEN_HP, OPEN_LP, resolveKeyLock, transitionLabel, transitionPoints } from '../src/player/djMixer';

const SR = 44100;
const tone = (hz: number, secs: number) => {
  const x = new Float32Array(Math.round(SR * secs));
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / SR) + 0.2 * Math.sin((2 * Math.PI * 2 * hz * i) / SR);
  return x;
};

/** Strongest frequency between lo and hi (Goertzel scan, 0.25 Hz steps) over the middle of the signal. */
function dominant(x: Float32Array, lo: number, hi: number) {
  const seg = x.subarray(Math.floor(x.length * 0.2), Math.floor(x.length * 0.8));
  let best = 0;
  let bestF = 0;
  for (let f = lo; f <= hi; f += 0.25) {
    const w = (2 * Math.PI * f) / SR;
    const c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < seg.length; i++) {
      const s0 = seg[i] + c * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const p = s1 * s1 + s2 * s2 - c * s1 * s2;
    if (p > best) {
      best = p;
      bestF = f;
    }
  }
  return bestF;
}

test('WSOLA stretch: 5% faster → 5% shorter, same pitch (±1%)', () => {
  const x = tone(440, 3);
  for (const tempo of [1.05, 0.95]) {
    const y = stretch(x, tempo);
    const want = x.length / tempo;
    assert.ok(Math.abs(y.length - want) / want < 0.01, `length ${y.length} vs ${want}`);
    const f = dominant(y, 400, 480);
    assert.ok(Math.abs(f - 440) / 440 < 0.01, `tempo ${tempo}: dominant ${f} Hz`);
    // No dropouts: the overlap-added windows keep the level steady.
    let rms = 0;
    for (let i = y.length * 0.2; i < y.length * 0.8; i++) rms += y[Math.floor(i)] ** 2;
    rms = Math.sqrt(rms / (y.length * 0.6));
    assert.ok(rms > 0.3 && rms < 0.45, `rms ${rms}`);
  }
});

test('KeyLockShifter: undoes the pitch change of a resampled (sped-up) stream, keeps its length and timing', () => {
  const rate = 1.05;
  const sped = resample(tone(440, 3), rate); // what <audio> with preservesPitch = false produces
  assert.ok(Math.abs(dominant(sped, 420, 480) - 440 * rate) < 2, 'resampled tone is higher');
  const sh = new KeyLockShifter(1);
  sh.pitch = 1 / rate;
  const out = new Float32Array(sped.length);
  for (let off = 0; off < sped.length; off += 128) {
    const n = Math.min(128, sped.length - off);
    const o = [new Float32Array(n)];
    sh.process([sped.subarray(off, off + n)], o);
    out.set(o[0], off);
  }
  assert.equal(out.length, sped.length);
  const f = dominant(out, 400, 480);
  assert.ok(Math.abs(f - 440) / 440 < 0.01, `dominant after key lock ${f} Hz`);
  // Fixed latency, bypassed when pitch = 1: output is the input delayed by LATENCY frames.
  const by = new KeyLockShifter(1);
  const inp = tone(440, 0.2);
  const o = [new Float32Array(inp.length)];
  by.process([inp], o);
  const L = KeyLockShifter.LATENCY;
  assert.equal(o[0][L + 100], inp[100]);
  assert.equal(o[0][10], 0);
});

test('mixer levels per style', () => {
  // Plain crossfade: equal power.
  const m = levelsAt('none', 0.5);
  assert.ok(Math.abs(m.inGain ** 2 + m.outGain ** 2 - 1) < 1e-9);
  // Bass swap: lows change over exactly at the swap point, never both basslines at once.
  for (const k of [0, 0.2, 0.49, 0.51, 0.8, 1]) {
    const l = levelsAt('bassSwap', k, 0.5);
    assert.equal(l.inLow + l.outLow, 1, `k=${k}`);
  }
  assert.equal(levelsAt('bassSwap', 0.49, 0.5).outLow, 1);
  assert.equal(levelsAt('bassSwap', 0.51, 0.5).inLow, 1);
  assert.equal(levelsAt('bassSwap', 1, 0.5).outGain < 1e-9, true);
  // Filter fade: HPF rises on the outgoing track, LPF opens on the incoming one, both open at rest.
  assert.equal(levelsAt('filter', 0).outHp, OPEN_HP);
  assert.ok(levelsAt('filter', 0.5).outHp > 200);
  assert.ok(levelsAt('filter', 0.3).inLp < 5000);
  assert.equal(levelsAt('filter', 1).inLp, OPEN_LP);
  // Echo-out: send on from the middle, dry cut at the cut point, new track fully in after it.
  const e1 = levelsAt('echo', 0.6, 0.5, 0.75);
  assert.equal(e1.echoSend, 1);
  assert.equal(e1.outGain, 1);
  const e2 = levelsAt('echo', 0.8, 0.5, 0.75);
  assert.equal(e2.outGain, 0);
  assert.equal(e2.echoSend, 0);
  assert.equal(e2.inGain, 1);
  const c = automationCurves('bassSwap', 30, 0.5, 0.75);
  assert.ok(c.inLow.length >= 1500, '~20 ms resolution');
  assert.equal(c.outLow[0], 1);
  assert.equal(c.inLow[c.inLow.length - 1], 1);
});

test('transition points, labels, key lock choice, tempo helpers', () => {
  assert.deepEqual(transitionPoints({ fx: 'bassSwap', swapAtMs: 7500, crossfadeMs: 30000, beatMs: 468.75 }).kSwap, 0.25);
  // Echo cut lands on a beat: 4 beats of 500 ms → 0.75×2000 = 1500 = 3 beats.
  assert.equal(transitionPoints({ fx: 'echo', crossfadeMs: 2000, beatMs: 500 }).kCut, 0.75);
  assert.equal(transitionPoints({ fx: 'echo', crossfadeMs: 3000, beatMs: 500 }).kCut, 2500 / 3000);
  assert.equal(transitionLabel({ style: 'blend', fx: 'bassSwap' }), 'Bass swap');
  assert.equal(transitionLabel({ style: 'blend' }), 'Beat-matched blend');
  assert.equal(transitionLabel({ style: 'cut', fx: 'echo' }), 'Echo out');
  assert.equal(resolveKeyLock('auto', { native: true, worklet: true }), 'native');
  assert.equal(resolveKeyLock('auto', { native: false, worklet: true }), 'worklet', 'old TV browsers: WSOLA worklet');
  assert.equal(resolveKeyLock('auto', { native: false, worklet: false }), 'off', 'no AudioWorklet: no time-stretch');
  assert.equal(resolveKeyLock('worklet', { native: true, worklet: false }), 'native');
  assert.equal(resolveKeyLock('off', { native: true, worklet: true }), 'off');
  assert.ok(Math.abs(incomingRate(1.02, 1.03, 0.08) - 1.0506) < 1e-9, 'compounds with the outgoing deck still at a matched tempo');
  assert.equal(incomingRate(1.1, 1.05, 0.08), 1.08, 'clamped to the stretch limit');
  assert.equal(glideMs(16, 120, 1), 32000);
});
