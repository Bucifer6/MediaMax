// Unit tests for src/car/policy.ts (long-track skips, lock-screen options, speeds, voice search).
// Run with `npm test` in apps/mobile (Node's built-in test runner with TypeScript type stripping).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LONG_TRACK_MS,
  SKIP_BACK_MS,
  SKIP_FORWARD_MS,
  isLongTrack,
  lockScreenOptions,
  nextSpeed,
  normalizeSpeed,
  pickBestMatch,
  transportMode,
  voiceQuery,
} from '../src/car/policy.ts';

const SPEEDS = [0.8, 1, 1.1, 1.25, 1.5, 1.75, 2];
const ORDER = ['track', 'album', 'artist', 'playlist', 'audiobook', 'bookpart', 'podcast', 'podcastepisode'];

test('long track threshold is about ten minutes and only applies to music', () => {
  assert.equal(LONG_TRACK_MS, 600_000);
  assert.equal(isLongTrack(false, LONG_TRACK_MS + 1), true);
  assert.equal(isLongTrack(false, LONG_TRACK_MS), false);
  assert.equal(isLongTrack(false, 4 * 60_000), false);
  assert.equal(isLongTrack(true, 3 * 3600_000), false, 'spoken audio is never a "long track"');
  assert.equal(isLongTrack(false, null), false);
  assert.equal(isLongTrack(false, undefined), false);
  assert.equal(isLongTrack(false, Number.NaN), false);
});

test('transport mode keeps track skip for long music and adds interval skip', () => {
  assert.deepEqual(transportMode(false, 75 * 60_000), { spoken: false, longTrack: true, trackSkip: true, intervalSkip: true });
  assert.deepEqual(transportMode(false, 3 * 60_000), { spoken: false, longTrack: false, trackSkip: true, intervalSkip: false });
  assert.deepEqual(transportMode(true, 3600_000), { spoken: true, longTrack: false, trackSkip: false, intervalSkip: true });
});

test('lock screen: spoken audio unchanged (±15/30, track skip only with a queue)', () => {
  const single = lockScreenOptions(transportMode(true, 3600_000), 'ios', 1);
  assert.deepEqual(single, {
    showNextTrack: false,
    showPreviousTrack: false,
    showSeekForward: true,
    showSeekBackward: true,
    seekForwardIntervalSeconds: 30,
    seekBackwardIntervalSeconds: 15,
  });
  const queued = lockScreenOptions(transportMode(true, 3600_000), 'android', 3);
  assert.equal(queued.showNextTrack, true);
  assert.equal(queued.showSeekForward, true);
});

test('lock screen: long music adds seek buttons on Android, keeps next/previous only on iOS', () => {
  const long = transportMode(false, 90 * 60_000);
  const android = lockScreenOptions(long, 'android', 5);
  assert.equal(android.showNextTrack, true);
  assert.equal(android.showPreviousTrack, true);
  assert.equal(android.showSeekForward, true);
  assert.equal(android.showSeekBackward, true);
  const ios = lockScreenOptions(long, 'ios', 5);
  assert.equal(ios.showNextTrack, true);
  assert.equal(ios.showSeekForward, false, 'iOS would replace next/previous with skip buttons');
  assert.equal(ios.showSeekBackward, false);
  assert.equal(ios.seekForwardIntervalSeconds, SKIP_FORWARD_MS / 1000);
  assert.equal(ios.seekBackwardIntervalSeconds, SKIP_BACK_MS / 1000);
});

test('lock screen: normal music has no seek buttons anywhere', () => {
  for (const platform of ['ios', 'android']) {
    const o = lockScreenOptions(transportMode(false, 200_000), platform, 10);
    assert.equal(o.showSeekForward, false);
    assert.equal(o.showNextTrack, true);
  }
});

test('speed button cycles through the app speeds and wraps', () => {
  assert.equal(nextSpeed(1, SPEEDS), 1.1);
  assert.equal(nextSpeed(1.25, SPEEDS), 1.5);
  assert.equal(nextSpeed(2, SPEEDS), 0.8);
  assert.equal(nextSpeed(1.3, SPEEDS), 1.5);
});

test('speeds from the system are clamped and snapped', () => {
  assert.equal(normalizeSpeed(1.5, SPEEDS), 1.5);
  assert.equal(normalizeSpeed(1.2, SPEEDS), 1.2);
  assert.equal(normalizeSpeed(1.26, SPEEDS), 1.25);
  assert.equal(normalizeSpeed(10, SPEEDS), 3);
  assert.equal(normalizeSpeed(0.1, SPEEDS), 0.5);
  assert.equal(normalizeSpeed(0, SPEEDS), null);
  assert.equal(normalizeSpeed(Number.NaN, SPEEDS), null);
});

const item = (type, title, extra = {}) => ({ type, title, parentTitle: null, grandparentTitle: null, ...extra });

test('voice query falls back to album, then artist', () => {
  assert.equal(voiceQuery('  Blue Train ', { artist: 'Coltrane' }), 'Blue Train');
  assert.equal(voiceQuery('', { album: 'Kind of Blue', artist: 'Miles Davis' }), 'Kind of Blue');
  assert.equal(voiceQuery('', { artist: 'Miles Davis' }), 'Miles Davis');
  assert.equal(voiceQuery('', null), '');
});

test('best match: server order without hints, skipping non-audio results', () => {
  const items = [item('movie', 'Daft Punk Unchained'), item('album', 'Discovery'), item('track', 'One More Time')];
  assert.equal(pickBestMatch(items, ORDER, null)?.title, 'Discovery');
  assert.equal(pickBestMatch([item('movie', 'x')], ORDER, null), null);
});

test('best match: requested media type wins', () => {
  const items = [item('track', 'Abbey Road Medley'), item('album', 'Abbey Road'), item('artist', 'The Beatles')];
  assert.equal(pickBestMatch(items, ORDER, { type: 'album' })?.type, 'album');
  assert.equal(pickBestMatch(items, ORDER, { type: 'artist' })?.type, 'artist');
  const books = [item('podcastepisode', 'Dune review'), item('bookpart', 'Dune — Part 1'), item('audiobook', 'Dune')];
  assert.equal(pickBestMatch(books, ORDER, { type: 'audiobook' })?.type, 'audiobook');
});

test('best match: artist hint picks the right version', () => {
  const items = [
    item('track', 'Hallelujah', { grandparentTitle: 'Leonard Cohen', parentTitle: 'Various Positions' }),
    item('track', 'Hallelujah', { grandparentTitle: 'Jeff Buckley', parentTitle: 'Grace' }),
  ];
  assert.equal(pickBestMatch(items, ORDER, { artist: 'jeff buckley' })?.parentTitle, 'Grace');
  assert.equal(pickBestMatch(items, ORDER, { album: 'Various Positions' })?.grandparentTitle, 'Leonard Cohen');
  assert.equal(pickBestMatch(items, ORDER, { artist: 'Nobody' })?.grandparentTitle, 'Leonard Cohen');
});
