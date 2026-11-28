// "Open in external player" helpers (src/player/external.ts; run: npm test in apps/mobile).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXTERNAL_DEFAULT, EXTERNAL_PLAYERS, externalPlayerLabel, externalPlayerProfile, externalProgress, externalSeekMs, normalizeExternalSetting,
} from '../src/player/external.ts';

test('stored setting is validated', () => {
  assert.deepEqual(normalizeExternalSetting(null), EXTERNAL_DEFAULT);
  assert.deepEqual(normalizeExternalSetting('yes'), EXTERNAL_DEFAULT);
  assert.deepEqual(normalizeExternalSetting({ enabled: true, packageName: 'org.videolan.vlc' }), { enabled: true, packageName: 'org.videolan.vlc' });
  assert.deepEqual(normalizeExternalSetting({ enabled: 1, packageName: 'com.evil.app' }), { enabled: false, packageName: null }, 'unknown package → chooser, truthy non-boolean → off');
  assert.equal(externalPlayerLabel(null), 'Ask every time');
  assert.equal(externalPlayerLabel('org.xbmc.kodi'), 'Kodi');
  assert.ok(EXTERNAL_PLAYERS.every((p) => p.packageName !== null || !p.returnsPosition));
});

test('external profile asks for direct play of everything, without HDR decisions', () => {
  const p = externalPlayerProfile(8000);
  assert.equal(p.maxBitrate, 8000);
  assert.equal(p.videoRange, undefined);
  for (const c of ['dts', 'dts-hd', 'truehd', 'eac3', 'flac']) assert.ok(p.audioCodecs.includes(c), c);
  for (const c of ['hevc', 'av1', 'mpeg2video', 'vc1']) assert.ok(p.videoCodecs.includes(c), c);
  for (const c of ['mkv', 'mp4', 'ts', 'm2ts', 'avi']) assert.ok(p.containers.includes(c), c);
  assert.equal(externalPlayerProfile().maxBitrate, null);
});

test('seek position is in stream time', () => {
  assert.equal(externalSeekMs({ startMs: 120_000 }), 120_000);
  assert.equal(externalSeekMs({ startMs: 120_000, streamStartMs: 0 }), 120_000);
  assert.equal(externalSeekMs({ startMs: 120_000, streamStartMs: 120_000 }), 0, 'stream starting at the resume point');
  assert.equal(externalSeekMs({ startMs: 0, streamStartMs: 5000 }), 0, 'never negative');
});

test('returned position becomes progress', () => {
  const info = { durationMs: 3_600_000, streamStartMs: 0 };
  assert.deepEqual(externalProgress({ launched: true, positionMs: 1_234_567 }, info), { positionMs: 1_234_567, durationMs: 3_600_000 });
  assert.equal(externalProgress({ launched: true, positionMs: null }, info), null, 'Kodi: nothing returned, resume point unchanged');
  assert.equal(externalProgress({ launched: false, positionMs: 5000 }, info), null);
  assert.deepEqual(externalProgress({ launched: true, positionMs: 10, completed: true }, info), { positionMs: 3_600_000, durationMs: 3_600_000 }, 'finished → watched');
  assert.deepEqual(externalProgress({ launched: true, positionMs: 9_999_999 }, info), { positionMs: 3_600_000, durationMs: 3_600_000 }, 'clamped');
  assert.deepEqual(externalProgress({ launched: true, positionMs: 1000 }, { durationMs: 60_000, streamStartMs: 30_000 }), { positionMs: 31_000, durationMs: 60_000 }, 'stream offset added');
  assert.deepEqual(externalProgress({ launched: true, positionMs: 1000, durationMs: 50_000 }, { durationMs: null }), { positionMs: 1000, durationMs: 50_000 }, 'player duration when the server has none');
});

test('externalSubtitles: preferred track first (switched on), image tracks left out, none when subtitles are off', async () => {
  const { externalSubtitles } = await import('../src/player/playerPrefs.ts');
  const tracks = [
    { index: 1, language: 'spa', default: false, forced: false, title: null, url: '/s/1.vtt' },
    { index: 2, language: 'eng', default: true, forced: false, title: null, url: '/s/2.vtt' },
    { index: 3, language: 'eng', default: false, forced: false, title: 'PGS', url: '/s/3.sup', isImage: true },
  ];
  assert.deepEqual(externalSubtitles(tracks, { subtitleMode: 'always', subtitleLanguage: 'es' }).map((t) => t.index), [1, 2]);
  assert.deepEqual(externalSubtitles(tracks, { subtitleMode: 'auto', subtitleLanguage: 'es' }, 'jpn').map((t) => t.index), [1, 2], 'foreign audio');
  assert.deepEqual(externalSubtitles(tracks.map((t) => ({ ...t, default: false })), { subtitleMode: 'auto', subtitleLanguage: 'es' }, 'spa').map((t) => t.index), [], 'own-language audio: none, as in our player');
  assert.deepEqual(externalSubtitles(tracks, { subtitleMode: 'off', subtitleLanguage: 'es' }).map((t) => t.index), []);
  assert.deepEqual(externalSubtitles(tracks, { subtitleMode: 'always', subtitleLanguage: 'en', showOnlyPreferredSubtitles: true }).map((t) => t.index), [2]);
});
