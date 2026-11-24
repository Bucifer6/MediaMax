// DJ analysis accuracy on synthetic music with known tempo, beat grid and key (regressions found in the DJ audit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chroma, estimateKey, estimateTempo, onsetEnvelope } from '../src/services/dj/dsp.ts';

const R = 11025;
type Pattern = 'four' | 'hiphop';
/** Drums at `bpm` from d0 s: 'four' = kick on every beat; 'hiphop' = kick on 1 and 3-and, snare on 2 and 4. Off-beat white-noise hats. */
function drums(bpm: number, pattern: Pattern, d0: number, seconds = 30, chord: number[] = []) {
  const B = 60 / bpm;
  const pcm = new Float32Array(R * seconds);
  const kick = (p: number) => (p >= 0 ? 0.7 * Math.sin(2 * Math.PI * (48 * p + 5 * (1 - Math.exp(-25 * p)))) * Math.exp(-9 * p) : 0);
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  for (let i = 0; i < pcm.length; i++) {
    const t = i / R - d0;
    let v = 0;
    if (t >= 0) {
      const bar = t % (4 * B);
      const at = (beat: number) => (bar - beat * B + 4 * B) % (4 * B);
      if (pattern === 'four') v += kick(t % B);
      else v += kick(at(0)) + kick(at(2.5)) + 0.25 * rnd() * (Math.exp(-25 * at(1)) + Math.exp(-25 * at(3)));
      v += 0.08 * rnd() * Math.exp(-80 * ((t + B / 2) % B));
    }
    for (const f of chord) v += 0.05 * Math.sin(2 * Math.PI * f * (i / R));
    pcm[i] = v;
  }
  return pcm;
}
const tempoOf = (pcm: Float32Array) => {
  const { env, fps, low } = onsetEnvelope(pcm, R);
  const t = estimateTempo(env, fps, low);
  return { ...t, beatOffsetMs: t.beatOffsetMs != null ? t.beatOffsetMs + 90 : null }; // + frame latency, as analysis.ts does
};

test('beat grid sits on the kick, not on the off-beat hi-hats', () => {
  for (const [bpm, d0] of [[120, 0.71], [128, 1.13], [100, 0.5]] as const) {
    const t = tempoOf(drums(bpm, 'four', d0));
    const beat = 60000 / bpm;
    assert.ok(t.bpm && Math.abs(t.bpm - bpm) < 0.3, `${bpm}: bpm ${t.bpm}`);
    const off = (((t.beatOffsetMs! - d0 * 1000) % beat) + beat) % beat;
    assert.ok(Math.min(off, beat - off) < 45, `${bpm} BPM: grid ${off.toFixed(0)} ms off the kick (half a beat = ${(beat / 2).toFixed(0)})`);
  }
});

test('slow grooves are not read at double time (85 BPM hip hop)', () => {
  for (const bpm of [85, 90]) {
    const t = tempoOf(drums(bpm, 'hiphop', 0.3));
    assert.ok(t.bpm && Math.abs(t.bpm - bpm) < 0.5, `expected ${bpm}, got ${t.bpm}`);
  }
});

test('key: major/minor and fifths survive a tuned kick drum (all 24 keys, Camelot codes)', () => {
  const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const MAJ = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
  const MIN = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
  const misses: string[] = [];
  for (let t = 0; t < 12; t++) {
    for (const minor of [false, true]) {
      const f0 = 130.81 * Math.pow(2, t / 12);
      const third = minor ? 3 : 4;
      // i – iv – V – i over a 128 BPM kick (whose pitch sweep ends near 50–60 Hz).
      const prog = [[0, third, 7], [5, 5 + third, 12], [7, 11, 14], [0, third, 7]];
      const B = 60 / 128;
      const pcm = new Float32Array(R * 20);
      for (let i = 0; i < pcm.length; i++) {
        const tt = i / R;
        const p = tt % B;
        let v = 0.7 * Math.sin(2 * Math.PI * (48 * p + 5 * (1 - Math.exp(-25 * p)))) * Math.exp(-9 * p);
        const ch = prog[Math.floor(tt / (4 * B)) % 4];
        for (const s of ch) v += 0.08 * Math.sin(2 * Math.PI * f0 * Math.pow(2, s / 12) * tt) + 0.03 * Math.sin(4 * Math.PI * f0 * Math.pow(2, s / 12) * tt);
        v += 0.15 * Math.sin(Math.PI * f0 * Math.pow(2, ch[0] / 12) * tt);
        pcm[i] = v;
      }
      const k = estimateKey(chroma(pcm, R));
      const want = `${NOTES[t]} ${minor ? 'minor' : 'major'}`;
      const cam = `${(minor ? MIN : MAJ)[t]}${minor ? 'A' : 'B'}`;
      if (k.key !== want || k.camelot !== cam) misses.push(`${want} (${cam}) → ${k.key} (${k.camelot})`);
    }
  }
  assert.deepEqual(misses, []);
});
