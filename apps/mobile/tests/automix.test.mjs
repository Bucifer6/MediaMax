// Automix (lite DJ) on the phone: the planner (port of web/src/player/automix.ts) and the two-player blend
// scheduling / cut logic used by src/state/music.tsx (run: npm test in apps/mobile).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  automixAction, automixApplies, automixLabel, BlendRunner, camelotMatch, fixedFade, foldTempo, fxGains, glideRate, isGaplessJoin, matchRates,
  nextBarMs, nextQueueIndex, pausedFromOutside, phaseNudge, pickFx, planAutomix, prepareBlend, sanitizePlan, transitionPoints,
  AUTOMIX_ARM_MS, AUTOMIX_LATE_FADE_MS, AUTOMIX_PRELOAD_LEAD_MS,
} from '../src/player/automix.ts';

const item = (id, extra = {}) => ({ id, type: 'track', title: id, durationMs: 240000, parentId: null, index: null, ...extra });
const ana = (id, bpm, extra = {}) => ({
  itemId: id, bpm, bpmConfidence: 0.9, beatOffsetMs: 120, downbeatMs: 120, timbre: null, key: null, camelot: '8A', energy: 0.6, loudnessDb: -9,
  cueInMs: 120, cueOutMs: 238000, introEndMs: null, outroStartMs: null, durationMs: 240000, analyzedAt: '', phrases: null, ...extra,
});
const onGrid = (ms, bpm, anchor) => {
  const bar = 240000 / bpm;
  const r = (((ms - anchor) % bar) + bar) % bar;
  return Math.min(r, bar - r) < 1;
};
const fade = (extra = {}) => ({ mixOutMs: 200000, mixInMs: 500, crossfadeMs: 6000, tempoRatio: 1, style: 'fade', keyMatch: 'unknown', bpmDelta: null, ...extra });

/* ------------------------------- planner (same expectations as the web tests) ------------------------------- */

test('beat-matched plan: mix-out on a bar of A (outro phrase), mix-in on the first downbeat of B, swap on a bar', () => {
  const aa = ana('a', 124, { phrases: [{ startMs: 200000, endMs: 238000, type: 'outro', bars: 16, energy: 0.4 }] });
  const ab = ana('b', 126, { downbeatMs: 480, beatOffsetMs: 480, cueInMs: 300, phrases: [{ startMs: 480, endMs: 31000, type: 'intro', bars: 16, energy: 0.3 }] });
  const tr = planAutomix(item('a'), aa, item('b'), ab, 'auto');
  assert.equal(tr.style, 'blend');
  assert.equal(tr.fx, 'bassSwap');
  assert.ok(onGrid(tr.mixOutMs, 124, 120));
  assert.ok(tr.mixOutMs >= 200000);
  assert.equal(tr.phraseAligned, true);
  assert.equal(tr.mixInMs, 480);
  assert.ok(Math.abs(tr.crossfadeMs - 16 * (240000 / 124)) < 1);
  assert.ok(Math.abs(tr.tempoRatio - 124 / 126) < 1e-5);
  assert.ok(Math.abs(transitionPoints(tr).kSwap - 0.5) < 1e-9);
});

test('no outro phrase: last bar line that fits; styles change the length', () => {
  const a = item('a');
  const b = item('b');
  const aa = ana('a', 128);
  const ab = ana('b', 128);
  const tr = planAutomix(a, aa, b, ab, 'auto');
  const bar = 240000 / 128;
  assert.ok(onGrid(tr.mixOutMs, 128, 120));
  assert.ok(tr.mixOutMs + tr.crossfadeMs <= aa.cueOutMs && tr.mixOutMs + tr.crossfadeMs > aa.cueOutMs - bar);
  assert.ok(Math.abs(planAutomix(a, aa, b, ab, 'minimal').crossfadeMs - 4 * bar) < 1);
  assert.equal(planAutomix(a, aa, b, ab, 'minimal').fx, 'none');
  assert.ok(Math.abs(planAutomix(a, aa, b, ab, 'smooth').crossfadeMs - 16 * bar) < 1);
});

test('far tempos and unanalysed tracks fall back to a ~6 s crossfade between the audible ends', () => {
  assert.equal(foldTempo(140, 70), 1);
  const a = item('a');
  const b = item('b');
  assert.equal(planAutomix(a, ana('a', 140), b, ana('b', 71)).style, 'blend', 'half time');
  const far = planAutomix(a, ana('a', 128), b, ana('b', 100));
  assert.equal(far.style, 'fade');
  assert.equal(far.crossfadeMs, 6000);
  assert.equal(far.mixOutMs, 238000 - 6000);
  assert.equal(far.mixInMs, 120);
  const none = planAutomix(a, null, b, null);
  assert.equal(none.mixOutMs, 240000 - 6000);
  assert.equal(none.mixInMs, 0);
  assert.equal(none.fx, 'none');
  assert.equal(fixedFade(item('s', { durationMs: 9000 }), null, b, null).crossfadeMs, 3000, 'a third of a short track');
  assert.equal(planAutomix(a, ana('a', 107), b, ana('b', 100)).style, 'fade', '7 % apart');
  assert.equal(planAutomix(a, ana('a', 105), b, ana('b', 100)).style, 'blend');
  assert.equal(planAutomix(a, ana('a', 120), b, ana('b', 120, { bpmConfidence: 0.2 })).style, 'fade');
});

test('gapless albums never crossfade; only music tracks automix', () => {
  const a = item('a', { parentId: 'alb', index: 3 });
  const b = item('b', { parentId: 'alb', index: 4 });
  const cont = ana('a', 120, { cueOutMs: 239900 });
  assert.equal(isGaplessJoin(a, b, cont, ana('b', 120, { cueInMs: 0 }), false), true);
  assert.equal(isGaplessJoin(a, b, null, null, false), true, 'unknown: keep gapless');
  assert.equal(isGaplessJoin(a, b, ana('a', 120, { cueOutMs: 236000 }), ana('b', 120, { cueInMs: 1500 }), false), false);
  assert.equal(isGaplessJoin(a, b, cont, null, true), false, 'shuffled');
  assert.equal(isGaplessJoin(a, item('c', { parentId: 'alb', index: 7 }), cont, null, false), false);
  assert.equal(automixApplies(a, b), true);
  assert.equal(automixApplies(a, item('p', { type: 'podcastepisode' })), false);
  assert.equal(automixApplies(item('x', { type: 'bookpart' }), b), false);
});

test('keys, effects, server cue points and plan sanitising', () => {
  assert.equal(camelotMatch('12A', '1A'), 'compatible');
  assert.equal(camelotMatch('8A', '3B'), 'clash');
  assert.equal(pickFx('auto', -0.3, 'compatible', true), 'filter');
  assert.equal(pickFx('auto', 0, 'clash', true), 'echo');
  assert.equal(pickFx('minimal', 0, 'clash', true), 'none');
  const bar = 240000 / 128;
  const aa = ana('a', 128, { cues: { mixInMs: 120, introEndMs: null, mixOutMs: 120 + 100 * bar, endMs: 236000, source: 'phrase' } });
  const ab = ana('b', 128, { cues: { mixInMs: 120 + bar, introEndMs: null, mixOutMs: 200000, endMs: 238000, source: 'outro' } });
  const tr = planAutomix(item('a'), aa, item('b'), ab);
  assert.equal(tr.mixInMs, 120 + bar);
  assert.ok(Math.abs(tr.mixOutMs - (120 + 100 * bar)) < 1);
  assert.equal(fixedFade(item('a'), aa, item('b'), ab).mixOutMs, 236000 - 6000);
  const a = item('a');
  const b = item('b');
  assert.equal(sanitizePlan(fade({ style: 'blend', tempoRatio: 1.07, crossfadeMs: 20000 }), a, null, b, null, 'auto').style, 'fade', 'past ±6 %');
  const long = sanitizePlan(fade({ mixOutMs: 230000, crossfadeMs: 20000, swapAtMs: 10000 }), a, null, b, null, 'auto');
  assert.equal(long.crossfadeMs, 10000);
  assert.equal(long.swapAtMs, 5000);
  assert.equal(nextBarMs(2001, 120, 500), 2500);
  assert.deepEqual(matchRates(1.02, 1, 0.06), { inRate: 1.02, outRate: 1 });
  const n = phaseNudge(40, 1.02);
  assert.ok(Math.abs((1.02 - n.rate) * n.holdMs - 40) < 0.6);
  assert.equal(phaseNudge(5, 1), null);
});

test('effects as volume shapes: equal-power crossfade, bounded overlap, every shape from (1,0) to (0,1)', () => {
  for (const fx of ['none', 'bassSwap', 'filter', 'echo']) {
    const s = fxGains(fx, 0, 0.5, 0.75);
    const e = fxGains(fx, 1, 0.5, 0.75);
    assert.equal(s.out, 1, `${fx} starts on the outgoing track`);
    assert.ok(e.out < 1e-9 && Math.abs(e.inc - 1) < 1e-9, `${fx} ends on the incoming track`);
    for (let i = 0; i <= 100; i++) {
      const g = fxGains(fx, i / 100, 0.5, 0.75);
      assert.ok(g.out >= 0 && g.out <= 1 && g.inc >= 0 && g.inc <= 1);
      assert.ok(g.out + g.inc <= 2 + 1e-9);
      if (fx === 'none') assert.ok(Math.abs(g.out ** 2 + g.inc ** 2 - 1) < 1e-9, 'equal power');
    }
  }
  assert.equal(automixLabel({ fx: 'none', style: 'fade' }), 'Crossfade');
  assert.equal(automixLabel({ fx: 'bassSwap', style: 'blend' }), 'Beat-matched swap');
});

/* ----------------------------------------------- scheduling ----------------------------------------------- */

test('queue advance: next index, end of queue, repeat all', () => {
  assert.equal(nextQueueIndex(3, 0, 'off'), 1);
  assert.equal(nextQueueIndex(3, 2, 'off'), -1);
  assert.equal(nextQueueIndex(3, 2, 'all'), 0);
  assert.equal(nextQueueIndex(0, 0, 'all'), -1);
});

test('scheduler: preload at the mix-in point ahead of the mix-out, arm a timer close to it, start on it', () => {
  const tr = fade();
  const at = (posMs, standby, extra = {}) => automixAction({ posMs, durMs: 240000, rate: 1, playing: true, tr, standby, ...extra });
  assert.deepEqual(automixAction({ posMs: 0, durMs: 240000, rate: 1, playing: true, tr: undefined, standby: 'none' }), { kind: 'none' }, 'not planned yet');
  assert.deepEqual(at(200000 - AUTOMIX_PRELOAD_LEAD_MS - 1, 'none'), { kind: 'none' }, 'too early to preload');
  assert.deepEqual(at(200000 - AUTOMIX_PRELOAD_LEAD_MS, 'none'), { kind: 'preload', startMs: 500 });
  assert.deepEqual(at(199000, 'loading'), { kind: 'none' }, 'still loading');
  assert.deepEqual(at(199000, 'ready'), { kind: 'none' });
  assert.deepEqual(at(200000 - AUTOMIX_ARM_MS + 100, 'ready'), { kind: 'arm', waitMs: AUTOMIX_ARM_MS - 100 });
  assert.deepEqual(at(200000, 'ready'), { kind: 'start' });
  assert.deepEqual(at(201000, 'ready'), { kind: 'start' }, 'late start (the timer was paused in the background)');
  assert.deepEqual(at(201000, 'ready', { playing: false }), { kind: 'none' }, 'paused: never starts a blend');
  assert.deepEqual(at(239800, 'ready'), { kind: 'none' }, 'nothing left but a cut: let it end');
  assert.deepEqual(at(199000, 'ready', { standbyStale: true }), { kind: 'preload', startMs: 500 }, 're-cue a stale standby');
  // A faster outgoing track gets there sooner (wall clock).
  assert.deepEqual(automixAction({ posMs: 200000 - 1000, durMs: 240000, rate: 2, playing: true, tr, standby: 'ready' }), { kind: 'arm', waitMs: 500 });
});

test('scheduler: gapless joins preload from the very start and never start a blend', () => {
  const at = (posMs, standby) => automixAction({ posMs, durMs: 240000, rate: 1, playing: true, tr: null, standby });
  assert.deepEqual(at(200000, 'none'), { kind: 'none' });
  assert.deepEqual(at(240000 - AUTOMIX_PRELOAD_LEAD_MS, 'none'), { kind: 'preload', startMs: 0 });
  assert.deepEqual(at(239900, 'ready'), { kind: 'none' });
});

test('prepareBlend: on time, late (beats still meet), far too late (short fade), never past the end', () => {
  const blend = fade({ style: 'blend', tempoRatio: 1.02, crossfadeMs: 16000, fx: 'bassSwap', swapAtMs: 8000, beatMs: 500 });
  const onTime = prepareBlend(blend, { posMs: 200000, durMs: 240000, rate: 1 });
  assert.equal(onTime.beat, true);
  assert.equal(onTime.inRate, 1.02);
  assert.equal(onTime.startInMs, 500);
  assert.equal(onTime.durMs, 16000);
  assert.equal(onTime.kSwap, 0.5);
  const late = prepareBlend(blend, { posMs: 200250, durMs: 240000, rate: 1 });
  assert.ok(Math.abs(late.startInMs - (500 + 250 * 1.02)) < 1e-9, 'the incoming track starts as far in as we are late');
  const tooLate = prepareBlend(blend, { posMs: 210000, durMs: 240000, rate: 1 });
  assert.equal(tooLate.beat, false);
  assert.equal(tooLate.inRate, 1);
  assert.equal(tooLate.tr.fx, 'none');
  assert.equal(tooLate.durMs, AUTOMIX_LATE_FADE_MS);
  assert.equal(tooLate.startInMs, 500, 'a plain fade starts at the mix-in point');
  const end = prepareBlend(fade({ mixOutMs: 235500, crossfadeMs: 8000 }), { posMs: 236000, durMs: 240000, rate: 1 });
  assert.equal(end.durMs, 4000, 'fits before the end of the outgoing track');
  // A plan the phone can't tempo-match (past ±6 %) plays as a fade at 1×.
  const wide = prepareBlend(fade({ style: 'blend', tempoRatio: 1.1 }), { posMs: 200000, durMs: 240000, rate: 1 });
  assert.equal(wide.beat, false);
  assert.equal(wide.inRate, 1);
});

/* ------------------------------------------- running and cutting ------------------------------------------- */

function rig(tr = fade(), at = { posMs: 200000, durMs: 240000, rate: 1 }) {
  const clock = { t: 1000 };
  const mk = (name) => {
    const d = { name, volume: 1, rate: 1, playing: name === 'out', log: [] };
    return Object.assign(d, {
      setVolume(v) { d.volume = v; },
      setRate(r) { d.rate = r; d.log.push(`rate ${r}`); },
      play() { d.playing = true; d.log.push('play'); },
      pause() { d.playing = false; d.log.push('pause'); },
    });
  };
  const out = mk('out');
  const inc = mk('inc');
  const levels = { out: 0.8, inc: 0.5 };
  const runner = new BlendRunner(prepareBlend(tr, at), out, inc, { now: () => clock.t, levels: () => levels });
  return { clock, out, inc, runner, levels };
}

test('blend: the incoming track starts silent, both follow the equal-power curve, the outgoing one stops at the end', () => {
  const { clock, out, inc, runner } = rig();
  runner.start();
  assert.equal(runner.state, 'running');
  assert.equal(inc.playing, true);
  assert.equal(inc.volume, 0);
  assert.equal(out.volume, 0.8, 'outgoing at its full level (volume × ReplayGain)');
  clock.t += 3000;
  runner.step();
  assert.ok(Math.abs(runner.progress() - 0.5) < 1e-9);
  assert.ok(Math.abs(out.volume - 0.8 * Math.SQRT1_2) < 1e-9);
  assert.ok(Math.abs(inc.volume - 0.5 * Math.SQRT1_2) < 1e-9);
  clock.t += 3000;
  assert.equal(runner.step(), 'done');
  assert.equal(out.playing, false);
  assert.equal(out.volume, 0);
  assert.equal(inc.volume, 0.5);
  assert.equal(runner.cut(), false, 'a finished blend cannot be cut');
  assert.equal(runner.complete(), false);
});

test('blend: steps are clock-driven, so sparse background updates land on the same curve', () => {
  const { clock, out, runner } = rig();
  runner.start();
  clock.t += 1500; // one status update every 250–500 ms, or none for a while: the level is where it should be
  runner.step();
  assert.ok(Math.abs(out.volume - 0.8 * Math.cos((0.25 * Math.PI) / 2)) < 1e-9);
});

test('cut (pause / seek / track change): the outgoing track is back at full level, the incoming one is dropped', () => {
  const { clock, out, inc, runner } = rig(fade({ style: 'blend', tempoRatio: 1.03, crossfadeMs: 16000 }), { posMs: 200000, durMs: 240000, rate: 1.02 });
  runner.start();
  assert.ok(Math.abs(inc.rate - 1.02 * 1.03) < 1e-12, 'tempo matched to the (still stretched) outgoing track');
  clock.t += 4000;
  runner.step();
  assert.ok(out.volume < 0.8);
  assert.equal(runner.cut(), true);
  assert.equal(runner.state, 'cut');
  assert.equal(inc.playing, false);
  assert.equal(inc.volume, 0);
  assert.equal(inc.rate, 1);
  assert.equal(out.playing, true, 'the outgoing track keeps playing (the caller pauses it for a pause)');
  assert.equal(out.volume, 0.8);
  clock.t += 20000;
  assert.equal(runner.step(), 'cut', 'a cut blend never completes later');
  assert.equal(out.volume, 0.8);
});

test('cut restores a rate the blend changed; skip completes the blend early', () => {
  // The incoming track would need > +6 %: the outgoing one is slowed to match, and gets its rate back on a cut.
  const t1 = rig(fade({ style: 'blend', tempoRatio: 1.05, crossfadeMs: 16000 }), { posMs: 200000, durMs: 240000, rate: 1.04 });
  t1.runner.start();
  assert.ok(t1.out.rate < 1.04);
  t1.runner.cut();
  assert.equal(t1.out.rate, 1.04);
  const t2 = rig();
  t2.runner.start();
  t2.clock.t += 1000;
  t2.runner.step();
  assert.equal(t2.runner.complete(), true);
  assert.equal(t2.out.playing, false);
  assert.equal(t2.inc.volume, 0.5);
});

test('beat-phase check nudges the incoming rate briefly, then goes back to the matched rate', () => {
  const { clock, inc, runner } = rig(fade({ style: 'blend', tempoRatio: 1, crossfadeMs: 16000 }));
  runner.start();
  assert.equal(runner.phaseError(201000, 1500), 0, 'on the beat');
  const err = runner.phaseError(201000, 1540);
  assert.equal(err, 40);
  assert.equal(runner.nudge(err), true);
  assert.ok(inc.rate < 1);
  assert.equal(runner.nudge(err), false, 'one nudge at a time');
  clock.t += 5000;
  runner.step();
  assert.equal(inc.rate, 1);
  assert.equal(rig().runner.phaseError(0, 0), null, 'plain fades have no phase');
});

test('tempo glide and outside-pause detection', () => {
  assert.equal(glideRate(1.04, 0, 8000), 1.04);
  assert.ok(Math.abs(glideRate(1.04, 4000, 8000) - 1.02) < 1e-12);
  assert.equal(glideRate(1.04, 9000, 8000), 1);
  const base = { playing: false, buffering: false, posMs: 100000, durMs: 240000, stoppedSinceMs: 1000, now: 1400 };
  assert.equal(pausedFromOutside(base), true, 'lock screen pause');
  assert.equal(pausedFromOutside({ ...base, now: 1100 }), false, 'not for long enough yet');
  assert.equal(pausedFromOutside({ ...base, buffering: true }), false, 'buffering is not a pause');
  assert.equal(pausedFromOutside({ ...base, posMs: 239800 }), false, 'it reached its end: complete, not cut');
  assert.equal(pausedFromOutside({ ...base, playing: true }), false);
});
