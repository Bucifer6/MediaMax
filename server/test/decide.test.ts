import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.MEDIAMAX_DATA ??= (await import('node:os')).tmpdir() + '/mediamax-test-' + process.pid;
const { decide } = await import('../src/services/playback.ts');
const { targetHeight } = await import('../src/services/transcoder.ts');

const media = (o: any = {}) => ({ id: 'm', container: 'mp4', durationMs: 1000, size: 1, bitrate: 5000, width: 1920, height: 1080, videoCodec: 'h264', resolutionLabel: '1080p', hdr: false, audioStreams: [], subtitleStreams: [], remote: false, ...o });
const aac = { index: 1, codec: 'aac', language: 'eng', title: null, channels: 2, default: true };
const base = { audio: aac, burnSubs: false, forceTranscode: false, allowTranscode: true, userMaxBitrate: null, isAudioOnly: false };

test('direct play when everything is supported', () => {
  assert.equal(decide(media(), undefined, base).method, 'direct');
});
test('remux when only the container is unsupported', () => {
  const d = decide(media({ container: 'mkv' }), { containers: ['mp4'] }, base);
  assert.equal(d.method, 'remux');
  assert.ok(d.videoCopy);
});
test('transcode when video codec unsupported', () => {
  assert.equal(decide(media({ videoCodec: 'hevc' }), { videoCodecs: ['h264'] }, base).method, 'transcode');
});
test('transcode when over bitrate limit', () => {
  assert.equal(decide(media({ bitrate: 40000 }), { maxBitrate: 8000 }, base).method, 'transcode');
  assert.equal(decide(media({ bitrate: 40000 }), {}, { ...base, userMaxBitrate: 4000 }).method, 'transcode');
});
test('burn-in forces transcode, and no-transcode users get direct', () => {
  assert.equal(decide(media(), undefined, { ...base, burnSubs: true }).method, 'transcode');
  assert.equal(decide(media({ videoCodec: 'hevc' }), { videoCodecs: ['h264'] }, { ...base, allowTranscode: false }).method, 'direct');
});
test('audio track copy decision', () => {
  const d = decide(media({ container: 'mkv' }), { containers: ['mp4'], audioCodecs: ['aac'] }, { ...base, audio: { ...aac, codec: 'dts' } });
  assert.equal(d.method, 'remux');
  assert.equal(d.audioCopy, false);
});
test('bitrate ladder', () => {
  assert.equal(targetHeight(3000, 2160, null), 720);
  assert.equal(targetHeight(20000, 1080, null), 1080);
  assert.equal(targetHeight(8000, 2160, 720), 720);
});
