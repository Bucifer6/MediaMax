import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReplayGain } from '../src/util/replaygain.js';

test('ReplayGain tags', () => {
  assert.deepEqual(parseReplayGain({ replaygain_track_gain: '-7.43 dB', replaygain_track_peak: '0.988525', replaygain_album_gain: '-8.10 dB' }),
    { trackGainDb: -7.43, trackPeak: 0.988525, albumGainDb: -8.1, albumPeak: null });
  assert.equal(parseReplayGain({ title: 'x' }), null);
  assert.equal(parseReplayGain({ replaygain_track_gain: 'garbage' }), null);
});

test('Opus R128 gains convert to the ReplayGain reference', () => {
  // -1280 / 256 = -5 dB relative to -23 LUFS → 0 dB relative to -18 LUFS
  assert.deepEqual(parseReplayGain({ r128_track_gain: '-1280' }), { trackGainDb: 0, trackPeak: null, albumGainDb: null, albumPeak: null });
});
