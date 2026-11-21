// Instant play client helpers (src/player/warmupCore.ts): dwell timer, request builder parity, metered detection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DwellTimer, buildPlaybackRequest, canWarmItem, isMeteredConnection, preferredAudioIndex, warmStartMs } from '../src/player/warmupCore.ts';

function clock() {
  let now = 0;
  const timers: { fn: () => void; at: number; id: number }[] = [];
  let id = 0;
  return {
    opts: {
      now: () => now,
      setTimer: (fn: () => void, ms: number) => {
        timers.push({ fn, at: now + ms, id: ++id });
        return id;
      },
      clearTimer: (t: unknown) => {
        const i = timers.findIndex((x) => x.id === t);
        if (i >= 0) timers.splice(i, 1);
      },
    },
    advance(ms: number) {
      now += ms;
      for (const t of [...timers].filter((x) => x.at <= now)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    },
  };
}

test('dwell: fires after 400 ms of hover, not when the pointer leaves earlier', () => {
  const c = clock();
  const fired: string[] = [];
  const d = new DwellTimer((k) => fired.push(k), { ...c.opts, delayMs: 400, repeatMs: 25000 });
  d.enter('a');
  c.advance(300);
  d.leave('a');
  c.advance(500);
  assert.deepEqual(fired, []);
  d.enter('a');
  d.enter('a'); // focus + hover together: one timer
  c.advance(400);
  assert.deepEqual(fired, ['a']);
});

test('dwell: an item is not prepared again within the repeat window', () => {
  const c = clock();
  const fired: string[] = [];
  const d = new DwellTimer((k) => fired.push(k), { ...c.opts, delayMs: 400, repeatMs: 25000 });
  d.trigger('a');
  d.enter('a');
  c.advance(1000);
  assert.deepEqual(fired, ['a']);
  c.advance(25000);
  d.enter('a');
  c.advance(400);
  assert.deepEqual(fired, ['a', 'a']);
  d.markFired('b');
  d.enter('b');
  c.advance(400);
  assert.deepEqual(fired, ['a', 'a'], 'markFired counts as fired');
});

test('the warm-up request equals the player request for the same inputs', () => {
  const profile = (b: number | null) => ({ videoCodecs: ['h264'], maxBitrate: b });
  const base = { startMs: 1234.4, subtitleIndex: null, burn: false, maxBitrate: 8000, kbps: 30000, profile, comforts: {} };
  const auto = buildPlaybackRequest({ ...base, auto: true });
  assert.deepEqual(auto, { startMs: 1234, audioStreamIndex: undefined, subtitleStreamIndex: undefined, burnSubtitles: undefined, deviceProfile: { videoCodecs: ['h264'], maxBitrate: null }, subtitleFormats: ['srt', 'vtt', 'ass', 'pgs'], adaptive: true, measuredBandwidth: 30000 });
  const fixed = buildPlaybackRequest({ ...base, auto: false, audioIndex: 2, burn: true, subtitleIndex: 4 });
  assert.equal(fixed.deviceProfile?.maxBitrate, 8000);
  assert.equal(fixed.adaptive, undefined);
  assert.equal(fixed.subtitleStreamIndex, 4);
  assert.equal(fixed.audioStreamIndex, 2);
});

test('start position, audio preference and warmable items', () => {
  const ud = (positionMs: number, played = false) => ({ positionMs, played, playCount: 0, favorite: false, lastPlayedAt: null, rating: null }) as any;
  assert.equal(warmStartMs({ durationMs: 100000, userData: ud(50000) }), 50000);
  assert.equal(warmStartMs({ durationMs: 100000, userData: ud(99000) }), 0, 'finished: from the start');
  assert.equal(warmStartMs({ durationMs: 100000, userData: ud(50000, true) }), 0);
  const media = [{ audioStreams: [{ index: 1, language: 'eng', default: true }, { index: 2, language: 'fra', default: false }] }] as any;
  assert.equal(preferredAudioIndex({ media }, 'fr'), 2);
  assert.equal(preferredAudioIndex({ media }, 'en'), undefined, 'default track: no explicit index (as the player)');
  assert.equal(preferredAudioIndex({ media }, null), undefined);
  assert.equal(canWarmItem({ type: 'movie', media: [{ remote: false }] } as any), true);
  assert.equal(canWarmItem({ type: 'movie', media: [{ remote: true }] } as any), false, 'IPTV / remote files are not warmed');
  assert.equal(canWarmItem({ type: 'album' } as any), false);
  assert.equal(canWarmItem({ type: 'episode' } as any), true, 'media unknown: the server decides');
});

test('metered connections', () => {
  assert.equal(isMeteredConnection(undefined), false);
  assert.equal(isMeteredConnection({ saveData: true }), true);
  assert.equal(isMeteredConnection({ type: 'cellular' }), true);
  assert.equal(isMeteredConnection({ type: 'wifi', effectiveType: '4g' }), false);
  assert.equal(isMeteredConnection({ effectiveType: '2g' }), true);
});
