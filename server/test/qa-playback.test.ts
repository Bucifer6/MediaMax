// QA regressions for the playback decision: Dolby Vision with an SDR base layer, reasons text on transcodes,
// transcode output height.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { decide, outputMaxHeight } = await import('../src/services/playback.ts');

const media = (o: any = {}) => ({ id: 'm', container: 'mp4', durationMs: 1000, size: 1, bitrate: 5000, width: 1920, height: 1080, videoCodec: 'h264', resolutionLabel: '1080p', hdr: false, audioStreams: [], subtitleStreams: [], remote: false, ...o });
const aac = { index: 1, codec: 'aac', language: 'eng', title: null, channels: 2, default: true };
const base = { audio: aac, burnSubs: false, forceTranscode: false, allowTranscode: true, userMaxBitrate: null, isAudioOnly: false };
const dvRange = (profile: number, blCompatId: number, fallback: string, el = false) => ({
  hdrFormat: 'dolbyvision', fallback, label: `Dolby Vision ${profile}.${blCompatId}`, bitDepth: 10, pixFmt: 'yuv420p10le', codecProfile: 'Main 10',
  colorTransfer: fallback === 'sdr' ? 'bt709' : 'smpte2084', colorPrimaries: null, colorSpace: null, frameRate: 24,
  dolbyVision: { profile, level: 6, blCompatId, rpu: true, el, bl: true }, masteringDisplay: null, contentLight: null,
});

test('transcoding Dolby Vision 8.2 (SDR base layer) never tone-maps', () => {
  const m = media({ container: 'mkv', videoCodec: 'hevc', width: 3840, height: 2160, hdr: true, videoRange: dvRange(8, 2, 'sdr') });
  const iphone = { videoCodecs: ['h264', 'hevc'], containers: ['mp4'], maxHeight: 1080, videoRange: { hdr10: true, dolbyVision: true } };
  const d = decide(m as any, iphone, base);
  assert.equal(d.method, 'transcode');
  assert.equal(d.toneMap, false);
  assert.equal(d.range?.delivery, 'base-layer');
  const sdrClient = { videoCodecs: ['h264'], containers: ['mp4'], videoRange: { hdr10: false } };
  assert.equal(decide(m as any, sdrClient, base).toneMap, false);
  // HDR10 still tone-maps on a transcode.
  const hdr10 = media({ container: 'mkv', videoCodec: 'hevc', hdr: true, videoRange: { ...dvRange(8, 1, 'hdr10'), hdrFormat: 'hdr10', dolbyVision: null } });
  assert.equal(decide(hdr10 as any, sdrClient, base).toneMap, true);
});

test('a transcode does not claim the DV profile 7 HDR10 base-layer remux in its reasons', () => {
  const m = media({ container: 'mkv', videoCodec: 'hevc', width: 3840, height: 2160, hdr: true, videoRange: dvRange(7, 6, 'hdr10', true) });
  const d = decide(m as any, { videoCodecs: ['hevc'], containers: ['mp4'], maxHeight: 1080, videoRange: { hdr10: true } }, base);
  assert.equal(d.method, 'transcode');
  assert.ok(!d.reasons.some((r) => /remuxed/.test(r)), d.reasons.join('; '));
  // …while the remux still says so.
  const r = decide(m as any, { videoCodecs: ['hevc'], containers: ['mp4'], videoRange: { hdr10: true } }, base);
  assert.equal(r.method, 'remux');
  assert.ok(r.reasons.some((x) => /remuxed/.test(x)));
});

test('transcode output height honours maxHeight and the source aspect ratio', () => {
  assert.equal(outputMaxHeight({ maxHeight: 1080 }, 3840, 2160), 1080);
  assert.equal(outputMaxHeight({ maxWidth: 1920 }, 3840, 2160), 1080);
  assert.equal(outputMaxHeight({ maxWidth: 1920 }, 3840, 1606), 802, 'even height for 4:2:0 encoders');
  assert.equal(outputMaxHeight({ maxWidth: 1920 }, 1440, 1080), 1080);
  assert.equal(outputMaxHeight({ maxWidth: 3840, maxHeight: 1080 }, 3840, 2160), 1080);
  assert.equal(outputMaxHeight({}, 3840, 2160), null);
});
