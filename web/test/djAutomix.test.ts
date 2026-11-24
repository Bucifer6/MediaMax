import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Item, TrackAnalysis } from '@mediamax/shared';
import {
  automixApplies, camelotMatch, fixedFade, foldTempo, isGaplessJoin, phaseNudge, pickFx, planAutomix, sanitizePlan, blendWallMs,
} from '../src/player/automix';
import { beatDriftMs, incomingRate, levelsAt, matchRates, nextBarMs, transitionPoints, transitionProgress } from '../src/player/djMixer';

const item = (id: string, extra: Partial<Item> = {}): Item => ({ id, type: 'track', title: id, durationMs: 240000, parentId: null, index: null, ...extra } as unknown as Item);
const ana = (id: string, bpm: number | null, extra: Partial<TrackAnalysis> = {}): TrackAnalysis => ({
  itemId: id, bpm, bpmConfidence: 0.9, beatOffsetMs: 120, downbeatMs: 120, timbre: null, key: null, camelot: '8A', energy: 0.6, loudnessDb: -9,
  cueInMs: 120, cueOutMs: 238000, introEndMs: null, outroStartMs: null, durationMs: 240000, analyzedAt: '', phrases: null, ...extra,
});
const onGrid = (ms: number, bpm: number, anchor: number) => {
  const bar = 240000 / bpm;
  const r = (((ms - anchor) % bar) + bar) % bar;
  return Math.min(r, bar - r) < 1;
};

test('beat-matched plan: mix-out on a bar of A (outro phrase), mix-in on the first downbeat of B, swap on a bar', () => {
  const a = item('a');
  const b = item('b');
  const aa = ana('a', 124, { phrases: [{ startMs: 200000, endMs: 238000, type: 'outro', bars: 16, energy: 0.4 }] });
  const ab = ana('b', 126, { downbeatMs: 480, beatOffsetMs: 480, cueInMs: 300, phrases: [{ startMs: 480, endMs: 31000, type: 'intro', bars: 16, energy: 0.3 }] });
  const tr = planAutomix(a, aa, b, ab, 'auto');
  assert.equal(tr.style, 'blend');
  assert.equal(tr.fx, 'bassSwap');
  assert.ok(onGrid(tr.mixOutMs, 124, 120), `mixOut ${tr.mixOutMs} on A's bar grid`);
  assert.ok(tr.mixOutMs >= 200000, 'starts in the outro');
  assert.equal(tr.phraseAligned, true);
  assert.equal(tr.mixInMs, 480);
  assert.ok(Math.abs(tr.crossfadeMs - 16 * (240000 / 124)) < 1, '16 bars of A');
  assert.ok(Math.abs(tr.tempoRatio - 124 / 126) < 1e-5);
  assert.ok(tr.swapAtMs != null && onGrid(tr.swapAtMs, 124, 0), 'bass swap on a bar line');
  assert.ok(tr.mixOutMs + tr.crossfadeMs <= aa.cueOutMs + 240000 / 124, 'ends by the end of the audio');
  // The transition fits: kSwap is the middle bar.
  assert.ok(Math.abs(transitionPoints(tr).kSwap - 0.5) < 1e-9);
});

test('no outro phrase: last bar line that leaves room for the blend; styles change the length', () => {
  const a = item('a');
  const b = item('b');
  const aa = ana('a', 128);
  const ab = ana('b', 128);
  const tr = planAutomix(a, aa, b, ab, 'auto');
  const bar = 240000 / 128;
  assert.ok(onGrid(tr.mixOutMs, 128, 120));
  assert.ok(tr.mixOutMs + tr.crossfadeMs <= aa.cueOutMs && tr.mixOutMs + tr.crossfadeMs > aa.cueOutMs - bar, 'latest bar that fits');
  assert.ok(Math.abs(planAutomix(a, aa, b, ab, 'minimal').crossfadeMs - 4 * bar) < 1);
  assert.equal(planAutomix(a, aa, b, ab, 'minimal').fx, 'none');
  assert.ok(Math.abs(planAutomix(a, aa, b, ab, 'smooth').crossfadeMs - 16 * bar) < 1, 'smooth: 32 bars would pass 34 s → halved');
});

test('tempo folding, far tempos and unanalysed tracks fall back to a ~6 s crossfade between the audible ends', () => {
  assert.equal(foldTempo(140, 70), 1);
  assert.ok(Math.abs(foldTempo(87, 174) - 1) < 1e-9);
  const a = item('a');
  const b = item('b');
  const half = planAutomix(a, ana('a', 140), b, ana('b', 71));
  assert.equal(half.style, 'blend', 'half time mixes');
  const far = planAutomix(a, ana('a', 128), b, ana('b', 100));
  assert.equal(far.style, 'fade');
  assert.equal(far.crossfadeMs, 6000);
  assert.equal(far.mixOutMs, 238000 - 6000, 'trailing silence skipped');
  assert.equal(far.mixInMs, 120, 'leading silence skipped');
  const none = planAutomix(a, null, b, null);
  assert.equal(none.style, 'fade');
  assert.equal(none.mixOutMs, 240000 - 6000);
  assert.equal(none.mixInMs, 0);
  assert.equal(none.fx, 'none');
  // Short tracks: never more than a third of either.
  assert.equal(fixedFade(item('s', { durationMs: 9000 }), null, b, null).crossfadeMs, 3000);
  // 6 % is the automix limit: 7 % apart is a crossfade.
  assert.equal(planAutomix(a, ana('a', 107), b, ana('b', 100)).style, 'fade');
  assert.equal(planAutomix(a, ana('a', 105), b, ana('b', 100)).style, 'blend');
  // Low beat confidence: no beat match.
  assert.equal(planAutomix(a, ana('a', 120), b, ana('b', 120, { bpmConfidence: 0.2 })).style, 'fade');
});

test('gapless albums are never crossfaded; non-tracks never automix', () => {
  const a = item('a', { parentId: 'alb', index: 3 });
  const b = item('b', { parentId: 'alb', index: 4 });
  const cont = ana('a', 120, { cueOutMs: 239900 });
  assert.equal(isGaplessJoin(a, b, cont, ana('b', 120, { cueInMs: 0 }), false), true, 'continuous audio');
  assert.equal(isGaplessJoin(a, b, null, null, false), true, 'unknown: keep gapless');
  assert.equal(isGaplessJoin(a, b, ana('a', 120, { cueOutMs: 236000 }), ana('b', 120, { cueInMs: 1500 }), false), false, 'silence between: may blend');
  assert.equal(isGaplessJoin(a, b, cont, ana('b', 120, { cueInMs: 0 }), true), false, 'shuffled');
  assert.equal(isGaplessJoin(a, item('c', { parentId: 'alb', index: 7 }), cont, null, false), false, 'not the next track');
  assert.equal(isGaplessJoin(a, item('d', { parentId: 'other' }), null, null, false), false);
  assert.equal(automixApplies(a, b), true);
  assert.equal(automixApplies(a, item('p', { type: 'podcastepisode' })), false);
  assert.equal(automixApplies(item('x', { type: 'bookpart' }), b), false);
});

test('keys and effects: picked by key relation, energy and style', () => {
  assert.equal(camelotMatch('8A', '8A'), 'perfect');
  assert.equal(camelotMatch('8A', '9A'), 'compatible');
  assert.equal(camelotMatch('12A', '1A'), 'compatible');
  assert.equal(camelotMatch('8A', '8B'), 'compatible');
  assert.equal(camelotMatch('8A', '10A'), 'energy');
  assert.equal(camelotMatch('8A', '3B'), 'clash');
  assert.equal(camelotMatch(null, '3B'), 'unknown');
  assert.equal(pickFx('auto', 0, 'compatible', true), 'bassSwap');
  assert.equal(pickFx('auto', -0.3, 'compatible', true), 'filter', 'into a calmer track');
  assert.equal(pickFx('auto', 0, 'clash', true), 'echo', 'echo-out hides a key clash');
  assert.equal(pickFx('minimal', 0, 'clash', true), 'none');
  assert.equal(pickFx('energetic', 0, 'unknown', false), 'echo');
  assert.equal(pickFx('auto', 0, 'unknown', false), 'none');
  const tr = planAutomix(item('a'), ana('a', 124, { camelot: '8A' }), item('b'), ana('b', 124, { camelot: '3B' }));
  assert.equal(tr.fx, 'echo');
  assert.equal(tr.keyMatch, 'clash');
});

test('tempo matching stays on the beat: no drift with matchRates, the old clamp drifted', () => {
  // B (122 BPM) into A (128): A still plays at +4 % from the previous transition.
  const ratio = 128 / 122;
  const outRate = 1.04;
  const max = 0.08;
  const lenMs = 16 * (240000 / 128) / outRate;
  const r = matchRates(ratio, outRate, max);
  assert.ok(r.inRate <= 1 + max + 1e-12 && r.outRate <= 1 + max + 1e-12);
  assert.ok(beatDriftMs(128, r.outRate, 122, r.inRate, lenMs) < 0.01, 'matched');
  const clamped = incomingRate(ratio, outRate, max);
  assert.ok(beatDriftMs(128, outRate, 122, clamped, lenMs) > 250, 'a clamp alone drifts by hundreds of ms over a 16-bar blend');
  // Within limits: untouched.
  assert.deepEqual(matchRates(1.02, 1, 0.08), { inRate: 1.02, outRate: 1 });
  // The server rounds the ratio to 5 decimals: ≤ 1 ms over a 30 s blend.
  assert.ok(beatDriftMs(124, 1, 126, Math.round((124 / 126) * 1e5) / 1e5, 30000) < 1);
});

test('phase nudge removes a start-up offset; tight starts are left alone', () => {
  assert.equal(phaseNudge(5, 1), null);
  assert.equal(phaseNudge(1000, 1), null, 'way off: not a nudge job');
  const n = phaseNudge(40, 1.02)!;
  assert.ok(n.rate < 1.02);
  // Media time removed while nudged = (base − nudged rate) × hold.
  assert.ok(Math.abs((1.02 - n.rate) * n.holdMs - 40) < 0.6);
  const m = phaseNudge(-30, 1)!;
  assert.ok(m.rate > 1 && Math.abs((m.rate - 1) * m.holdMs - 30) < 0.6);
  assert.ok(m.rate <= 1.02 + 1e-12, 'at most 2 %');
});

test('plans are made safe for the player; bars, progress and wall time', () => {
  const a = item('a');
  const b = item('b');
  const far = sanitizePlan({ mixOutMs: 200000, mixInMs: 0, crossfadeMs: 20000, tempoRatio: 1.07, style: 'blend', keyMatch: 'unknown', bpmDelta: 7 }, a, null, b, null, 'auto');
  assert.equal(far.style, 'fade', 'past the automix stretch limit');
  const long = sanitizePlan({ mixOutMs: 230000, mixInMs: 0, crossfadeMs: 20000, tempoRatio: 1, style: 'fade', keyMatch: 'unknown', bpmDelta: null, swapAtMs: 10000 }, a, null, b, null, 'auto');
  assert.equal(long.crossfadeMs, 10000);
  assert.equal(long.swapAtMs, 5000);
  assert.equal(nextBarMs(1000, 120, 0), 2000);
  assert.equal(nextBarMs(2000, 120, 0), 2000);
  assert.equal(nextBarMs(2001, 120, 500), 2500);
  assert.equal(nextBarMs(100, null, 0), null);
  assert.equal(transitionProgress(5, 0, 10), 0.5);
  assert.equal(transitionProgress(50, 0, 10), 1);
  assert.equal(blendWallMs({ crossfadeMs: 10400 }, 1.04), 10000);
});

test('gain staging: equal-power fades, one bassline at a time, bounded overlap (limiter covers the rest)', () => {
  for (const fx of ['none', 'bassSwap', 'filter', 'echo'] as const) {
    let peak = 0;
    for (let i = 0; i <= 200; i++) {
      const l = levelsAt(fx, i / 200, 0.5, 0.75);
      assert.ok(l.inGain >= 0 && l.inGain <= 1 && l.outGain >= 0 && l.outGain <= 1, `${fx} gains in 0–1`);
      if (fx === 'none') assert.ok(Math.abs(l.inGain ** 2 + l.outGain ** 2 - 1) < 1e-9, 'equal power');
      if (fx === 'bassSwap') assert.equal(l.inLow + l.outLow, 1, 'never two basslines');
      // Worst case (fully correlated material): summed amplitude.
      peak = Math.max(peak, l.inGain * (fx === 'bassSwap' ? 1 : 1) + l.outGain);
    }
    assert.ok(peak <= 2 + 1e-9, `${fx} overlap ≤ +6 dB`);
    if (fx === 'none') assert.ok(peak <= Math.SQRT2 + 1e-9, 'plain crossfade ≤ +3 dB');
  }
});
