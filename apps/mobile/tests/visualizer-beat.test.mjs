// Visualiser beat timing (run: npm test in apps/mobile).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CALM_BPM, barLevels, beatGrid, nextBeat } from '../src/player/beat.ts';

test('a steady analysed track gets its own grid', () => {
  const g = beatGrid({ bpm: 120, bpmConfidence: 0.9, beatOffsetMs: 250, energy: 0.8 });
  assert.deepEqual(g, { beatMs: 500, offsetMs: 250, steady: true, energy: 0.8 });
});

test('no analysis, no beat or an unsure tempo: calm breathing, not a wrong pulse', () => {
  for (const a of [null, { bpm: null, beatOffsetMs: null, energy: 0.9 }, { bpm: 128, bpmConfidence: 0.1, beatOffsetMs: 0, energy: 0.9 }, { bpm: 400, beatOffsetMs: 0 }]) {
    const g = beatGrid(a);
    assert.equal(g.steady, false);
    assert.equal(g.beatMs, 60000 / CALM_BPM);
    assert.ok(g.energy <= 0.5);
  }
});

test('nextBeat: time to the next beat on the grid, and its number', () => {
  const g = { beatMs: 500, offsetMs: 250 };
  assert.deepEqual(nextBeat(250, g), { inMs: 500, index: 1 }, 'exactly on a beat: wait for the next one');
  assert.deepEqual(nextBeat(300, g), { inMs: 450, index: 1 });
  assert.deepEqual(nextBeat(10_740, g), { inMs: 10, index: 21 });
  assert.deepEqual(nextBeat(0, g), { inMs: 250, index: 0 }, 'before the first grid beat');
});

test('bars: bass leads on the beat, treble on the half-beat, energy scales them, all within 0–1', () => {
  const on = barLevels(32, 1, 7, false);
  const off = barLevels(32, 1, 7, true);
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  assert.equal(on.length, 32);
  assert.ok(avg(on.slice(0, 8)) > avg(on.slice(24)), 'beat: low bars higher');
  assert.ok(avg(off.slice(24)) > avg(off.slice(0, 8)), 'half-beat: high bars higher');
  assert.ok(avg(barLevels(32, 0.2, 7, false)) < avg(on), 'quieter tracks kick less');
  assert.ok([...on, ...off].every((v) => v >= 0.06 && v <= 1));
  assert.notDeepEqual(barLevels(32, 1, 8, false), on, 'varies from beat to beat');
});
