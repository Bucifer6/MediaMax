// Unit tests for the client ABR controller and bandwidth estimator (run: npm test -w web).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbrController, BandwidthEstimator, Ewma, RESTART_ABR, SEGMENT_ABR, restartLevels, type AbrLevel } from '../src/player/abr.ts';

const MBPS = 1e6;
const ladder: AbrLevel[] = [
  { bitrate: 9.2 * MBPS, label: '1080p' },
  { bitrate: 4.5 * MBPS, label: '720p' },
  { bitrate: 1.8 * MBPS, label: '480p' },
  { bitrate: 1.0 * MBPS, label: '360p' },
];

/** Run the controller once a second for `secs` with a fixed input; returns the decisions. */
function run(c: AbrController, from: number, secs: number, input: { bw: number; buf: number; dropped?: number }) {
  const out: { t: number; level: number; reason: string }[] = [];
  for (let t = from; t < from + secs * 1000; t += 1000) {
    const d = c.update({ now: t, bandwidth: input.bw, bufferS: input.buf, droppedRatio: input.dropped ?? 0, playing: true });
    if (d) out.push({ t, level: d.level, reason: d.reason });
  }
  return out;
}

test('EWMA: bias-corrected and weighted by duration', () => {
  const e = new Ewma(3);
  e.sample(1, 10);
  assert.equal(Math.round(e.estimate), 10, 'first sample is not pulled towards zero');
  e.sample(3, 20);
  assert.ok(e.estimate > 15 && e.estimate < 20);
});

test('estimator: takes the lower of fast and slow averages, ignores tiny transfers', () => {
  const b = new BandwidthEstimator();
  assert.equal(b.estimate, null);
  b.add(1000, 1); // too small: latency-dominated
  assert.equal(b.estimate, null);
  for (let i = 0; i < 10; i++) b.add(2_500_000, 1000); // 20 Mbps
  assert.ok(Math.abs(b.estimate! - 20 * MBPS) < 0.5 * MBPS);
  b.add(250_000, 1000); // one 2 Mbps segment
  const afterDrop = b.estimate!;
  assert.ok(afterDrop < 18 * MBPS, 'a drop shows quickly (fast EWMA)');
  b.add(2_500_000, 1000);
  assert.ok(b.estimate! < 20 * MBPS && b.estimate! >= afterDrop * 0.9, 'a single spike back up is not trusted fully (slow EWMA)');
});

test('controller sorts levels and fits the estimate with the safety share', () => {
  const c = new AbrController(ladder, 3);
  assert.deepEqual(c.levels.map((l) => l.label), ['360p', '480p', '720p', '1080p']);
  assert.equal(c.fit(6 * MBPS), 2, '6 Mbps × 0.8 = 4.8 ≥ 4.5 → 720p');
  assert.equal(c.fit(0.5 * MBPS), 0);
});

test('steps down on sustained low throughput (after the hold time), not on a blip', () => {
  const c = new AbrController(ladder, 3, SEGMENT_ABR, 0);
  // 2 s of low bandwidth with a healthy buffer: nothing yet.
  assert.deepEqual(run(c, 1000, 2, { bw: 5 * MBPS, buf: 20 }), []);
  // Recovers: the hold resets.
  assert.deepEqual(run(c, 3000, 2, { bw: 30 * MBPS, buf: 20 }), []);
  // Sustained: switches after downHoldMs to the level that fits.
  const d = run(c, 5000, 5, { bw: 6 * MBPS, buf: 20 });
  assert.equal(d.length, 1);
  assert.equal(c.levels[d[0].level].label, '720p');
  assert.equal(d[0].t - 5000, SEGMENT_ABR.downHoldMs);
});

test('emergency: nearly empty buffer drops immediately, possibly several levels', () => {
  const c = new AbrController(ladder, 3, SEGMENT_ABR, 0);
  const d = c.update({ now: 1000, bandwidth: 1.5 * MBPS, bufferS: 1, playing: true });
  assert.equal(c.levels[d!.level].label, '360p');
  assert.equal(d!.reason, 'buffer');
});

test('steps up one level at a time, only after the dwell time, hold time and with buffer', () => {
  const c = new AbrController(ladder, 0, SEGMENT_ABR, 0);
  // Great bandwidth but a thin buffer: stays.
  assert.deepEqual(run(c, 0, 30, { bw: 50 * MBPS, buf: 5 }), []);
  const d = run(c, 30000, 60, { bw: 50 * MBPS, buf: 20 });
  assert.deepEqual(d.map((x) => c.levels[x.level].label), ['480p', '720p', '1080p']);
  for (let i = 1; i < d.length; i++) assert.ok(d[i].t - d[i - 1].t >= SEGMENT_ABR.minDwellMs, 'dwell between ups');
});

test('no flapping: hysteresis band between up and down thresholds', () => {
  const c = new AbrController(ladder, 2, SEGMENT_ABR, 0); // 720p
  // 7 Mbps: fits 720p (×0.8 = 5.6 ≥ 4.5) but not enough to go up (×0.65 = 4.55 < 9.2) nor to go down.
  assert.deepEqual(run(c, 0, 300, { bw: 7 * MBPS, buf: 25 }), []);
  // Oscillating bandwidth around the 1080p threshold for 10 minutes: few switches.
  let switches = 0;
  for (let t = 0; t < 600; t++) {
    const bw = (t % 20 < 10 ? 16 : 10) * MBPS;
    if (c.update({ now: 300000 + t * 1000, bandwidth: bw, bufferS: 25, playing: true })) switches++;
  }
  assert.ok(switches <= 6, `${switches} switches`);
});

test('flaps lengthen the dwell time', () => {
  const c = new AbrController(ladder, 1, SEGMENT_ABR, 0);
  run(c, 0, 40, { bw: 50 * MBPS, buf: 20 }); // up
  const before = c.dwellMs;
  run(c, 40000, 10, { bw: 2 * MBPS, buf: 20 }); // quick down after up = flap
  assert.ok(c.flaps >= 1);
  assert.ok(c.dwellMs > before);
});

test('dropped frames cap the level below the current one for a while', () => {
  const c = new AbrController(ladder, 3, SEGMENT_ABR, 0);
  const d = c.update({ now: 1000, bandwidth: 100 * MBPS, bufferS: 30, droppedRatio: 0.3, playing: true });
  assert.equal(d!.reason, 'dropped-frames');
  assert.equal(c.levels[c.current].label, '720p');
  assert.deepEqual(run(c, 2000, 50, { bw: 100 * MBPS, buf: 30 }), [], 'stays capped during the penalty');
  const later = run(c, 2000 + SEGMENT_ABR.droppedPenaltyMs, 60, { bw: 100 * MBPS, buf: 30 });
  assert.equal(c.levels[later.at(-1)!.level].label, '1080p');
});

test('buffer safety net: a near-empty buffer steps down even when the estimate lags', () => {
  const c = new AbrController(ladder, 3, SEGMENT_ABR, 0);
  // Estimate still says 50 Mbps (the slow segment hasn't finished), but the buffer is empty.
  assert.equal(c.update({ now: 11000, bandwidth: 50 * MBPS, bufferS: 0.5, playing: true }), null, 'not on the first tick');
  const d = c.update({ now: 13500, bandwidth: 50 * MBPS, bufferS: 0.4, playing: true });
  assert.equal(c.levels[d!.level].label, '720p');
  assert.equal(d!.immediate, true);
  // Not again right away: the new level gets time to deliver.
  assert.equal(c.update({ now: 20000, bandwidth: 50 * MBPS, bufferS: 0.2, playing: true }), null);
  assert.equal(c.levels[c.update({ now: 24000, bandwidth: 50 * MBPS, bufferS: 0.2, playing: true })!.level].label, '480p');
  // With a low estimate the drop goes straight to the fitting level, immediately.
  const e = new AbrController(ladder, 3, SEGMENT_ABR, 0).update({ now: 1000, bandwidth: 2 * MBPS, bufferS: 1, playing: true });
  assert.equal(e!.immediate, true);
});

test('paused / unknown bandwidth never switches', () => {
  const c = new AbrController(ladder, 3, SEGMENT_ABR, 0);
  assert.equal(c.update({ now: 10000, bandwidth: null, bufferS: 0, playing: true }), null);
  assert.equal(c.update({ now: 20000, bandwidth: 0.1 * MBPS, bufferS: 0, playing: false }), null);
});

test('restart mode: source on top, steps below it, calmer timings', () => {
  const lv = restartLevels(12000, null);
  assert.deepEqual(lv.map((l) => l.label), ['360p', '480p', '720p', '1080p', 'Original']);
  assert.equal(lv.at(-1)!.kbps, null);
  assert.deepEqual(restartLevels(3000, null).map((l) => l.label), ['360p', '480p', 'Original']);
  assert.deepEqual(restartLevels(12000, 4000).map((l) => l.label), ['360p', '480p', '720p'], 'cap removes the original');
  assert.ok(RESTART_ABR.minDwellMs > SEGMENT_ABR.minDwellMs);
  // Direct play of a 12 Mbps file on a 6 Mbps link → 720p transcode after the hold.
  const c = new AbrController(lv, lv.length - 1, RESTART_ABR, 0);
  const d = run(c, 0, 10, { bw: 6 * MBPS, buf: 10 });
  assert.equal(lv[d[0].level].label, '720p');
});
