import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTempo, onsetEnvelope, chroma, estimateKey, keyCompatibility, loudness, mixPoints } from '../src/services/dj/dsp.ts';
import { planTransition, tempoDistance, curveTarget } from '../src/services/dj/mix.ts';
import type { TrackAnalysis } from '@mediamax/shared';

const RATE = 11025;
/** Kick drum at `bpm` over a sustained triad (Hz), `seconds` long. */
function synth(bpm: number, chord: number[], seconds = 40, fadeIn = 0) {
  const pcm = new Float32Array(RATE * seconds);
  const period = 60 / bpm;
  for (let i = 0; i < pcm.length; i++) {
    const t = i / RATE;
    const kick = 0.6 * Math.sin(2 * Math.PI * 55 * t) * Math.exp(-25 * (t % period));
    let pad = 0;
    for (const f of chord) pad += 0.12 * Math.sin(2 * Math.PI * f * t);
    pad += 0.15 * Math.sin(2 * Math.PI * (chord[0] / 2) * t);
    const env = fadeIn ? Math.min(1, t / fadeIn) : 1;
    pcm[i] = (kick + pad) * env;
  }
  return pcm;
}

test('tempo: exact BPM and beat grid on synthetic kicks', () => {
  for (const bpm of [95, 128, 140]) {
    const { env, fps } = onsetEnvelope(synth(bpm, [220, 261.63, 329.63]), RATE);
    const t = estimateTempo(env, fps);
    assert.ok(t.bpm && Math.abs(t.bpm - bpm) < 0.3, `expected ${bpm}, got ${t.bpm}`);
    assert.ok(t.confidence >= 0.35);
  }
});

test('tempo: no beat → null', () => {
  // A slowly swelling ambient pad (no percussion).
  const pad = new Float32Array(RATE * 40);
  for (let i = 0; i < pad.length; i++) {
    const t = i / RATE;
    pad[i] = 0.2 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.18 * t)) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 0.07 * t));
  }
  const { env, fps } = onsetEnvelope(pad, RATE);
  assert.equal(estimateTempo(env, fps).bpm, null);
});

test('key detection and Camelot codes', () => {
  assert.deepEqual(pick(estimateKey(chroma(synth(120, [220, 261.63, 329.63]), RATE))), { key: 'A minor', camelot: '8A' });
  assert.deepEqual(pick(estimateKey(chroma(synth(120, [261.63, 329.63, 392]), RATE))), { key: 'C major', camelot: '8B' });
});
const pick = (k: { key: string | null; camelot: string | null }) => ({ key: k.key, camelot: k.camelot });

test('Camelot compatibility', () => {
  assert.equal(keyCompatibility('8A', '8A'), 'perfect');
  assert.equal(keyCompatibility('8A', '9A'), 'compatible');
  assert.equal(keyCompatibility('12A', '1A'), 'compatible');
  assert.equal(keyCompatibility('8A', '8B'), 'compatible');
  assert.equal(keyCompatibility('8A', '10A'), 'energy');
  assert.equal(keyCompatibility('8A', '3B'), 'clash');
  assert.equal(keyCompatibility(null, '3B'), 'unknown');
});

test('mix points find the fade-in intro and trailing silence', () => {
  const pcm = synth(128, [220, 261.63, 329.63], 60, 10);
  const padded = new Float32Array(pcm.length + RATE * 3);
  padded.set(pcm);
  const p = mixPoints(loudness(padded, RATE), Math.round((padded.length / RATE) * 1000));
  assert.ok(p.cueOutMs <= 60500 && p.cueOutMs > 58000, `cueOut ${p.cueOutMs}`);
  assert.ok(p.introEndMs != null && p.introEndMs > 3000 && p.introEndMs < 12000, `introEnd ${p.introEndMs}`);
});

test('tempo distance handles half/double time', () => {
  assert.ok(tempoDistance(140, 70)!.d < 0.001);
  assert.ok(Math.abs(tempoDistance(128, 126)!.ratio - 128 / 126) < 1e-9);
  assert.equal(tempoDistance(null, 120), null);
});

const A = (o: Partial<TrackAnalysis>): TrackAnalysis => ({
  itemId: 'x', bpm: 128, bpmConfidence: 0.9, beatOffsetMs: 100, key: 'A minor', camelot: '8A', energy: 0.8, loudnessDb: -10,
  cueInMs: 0, cueOutMs: 200000, introEndMs: 16000, outroStartMs: 180000, durationMs: 200000, analyzedAt: '', ...o,
});

test('transitions: beat-matched blend on the bar, fade on key clash, cut when nothing matches', () => {
  const blend = planTransition(A({}), 200000, A({ camelot: '9A', bpm: 126, beatOffsetMs: 40 }));
  assert.equal(blend.style, 'blend');
  assert.ok(Math.abs(blend.tempoRatio - 128 / 126) < 0.002);
  const bar = (60000 / 128) * 4;
  assert.ok(Math.abs(((blend.mixOutMs - 100) / bar) - Math.round((blend.mixOutMs - 100) / bar)) < 0.01, 'mix-out on a bar line');
  assert.ok(blend.mixOutMs + blend.crossfadeMs <= 200000);
  assert.equal(planTransition(A({}), 200000, A({ camelot: '3B' })).style, 'fade');
  assert.equal(planTransition(A({}), 200000, A({ camelot: '3B', bpm: 90 })).style, 'cut');
  const unknown = planTransition(null, 180000, null);
  assert.equal(unknown.style, 'fade');
  assert.equal(unknown.mixOutMs, 174000);
});

test('energy curves', () => {
  assert.ok(curveTarget('build', 1, 0.5) > curveTarget('build', 0, 0.5));
  assert.ok(curveTarget('peak', 0.7, 0.5) > curveTarget('peak', 1, 0.5));
  assert.equal(curveTarget('steady', 0.3, 0.42), 0.42);
});
