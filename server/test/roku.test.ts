// The native Roku channel (apps/roku): its device headers, the link-code sign-in it uses, and how decide() treats the
// device profiles it builds at runtime (components/common/DeviceProfile.brs).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { createUser, issueToken, authenticate, _resetLinks } = await import('../src/services/auth.ts');
const { buildApp } = await import('../src/app.ts');
const { decide } = await import('../src/services/playback.ts');

const app = await buildApp();
after(() => app.close());

const ROKU_HEADERS = {
  'x-mediamax-device-id': 'roku-client-id-1',
  'x-mediamax-device-name': 'Living Room Roku',
  'x-mediamax-platform': 'roku',
  'x-mediamax-version': '1.0.1',
};

test('Roku link-code sign-in keeps platform "roku" on the issued session', async () => {
  _resetLinks();
  const owner = createUser({ username: 'roku-owner', password: 'pass1234' });
  const ownerTok = issueToken(owner.id, { deviceId: 'phone', deviceName: 'Phone', platform: 'ios' }).token;
  // The channel sends the device fields in the body as well as the headers.
  const req = await app.inject({
    method: 'POST', url: '/api/v1/auth/link/request', headers: ROKU_HEADERS,
    payload: { deviceId: 'roku-client-id-1', deviceName: 'Living Room Roku', platform: 'roku', appVersion: '1.0.1' },
  });
  assert.equal(req.statusCode, 200);
  const { code, pollToken } = req.json();
  assert.equal((await app.inject({ method: 'GET', url: `/api/v1/auth/link/poll?pollToken=${pollToken}` })).json().status, 'pending');
  const approve = await app.inject({ method: 'POST', url: '/api/v1/auth/link/approve', headers: { authorization: `Bearer ${ownerTok}` }, payload: { code } });
  assert.equal(approve.statusCode, 200);
  assert.equal(approve.json().deviceName, 'Living Room Roku');
  const poll = (await app.inject({ method: 'GET', url: `/api/v1/auth/link/poll?pollToken=${pollToken}` })).json();
  assert.equal(poll.status, 'linked');
  const ctx = authenticate(poll.token);
  assert.equal(ctx?.device.platform, 'roku');
  assert.equal(ctx?.device.deviceName, 'Living Room Roku');
  assert.equal(ctx?.device.appVersion, '1.0.1');
  _resetLinks();
});

test('password sign-in from Roku headers records the platform too', async () => {
  createUser({ username: 'roku-viewer', password: 'pass1234' });
  const res = await app.inject({
    method: 'POST', url: '/api/v1/auth/login', headers: ROKU_HEADERS,
    payload: { username: 'roku-viewer', password: 'pass1234', deviceId: 'roku-client-id-2', deviceName: 'Bedroom Roku', platform: 'roku' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(authenticate(res.json().token)?.device.platform, 'roku');
});

/* -------------------------------------------- decide() with the profiles the channel sends -------------------------------------------- */

const media = (o: any = {}) => ({ id: 'm', container: 'mkv', durationMs: 1000, size: 1, bitrate: 6000, width: 1920, height: 1080, videoCodec: 'h264', resolutionLabel: '1080p', hdr: false, audioStreams: [], subtitleStreams: [], remote: false, ...o });
const track = (codec: string, channels = 6) => ({ index: 1, codec, language: 'eng', title: null, channels, default: true });
const opts = (audio: any) => ({ audio, burnSubs: false, forceTranscode: false, allowTranscode: true, userMaxBitrate: null, isAudioOnly: false });

/** Roku Express (HD, H.264 only) on a TV without a receiver. */
const hdRoku = {
  maxWidth: 1920, maxHeight: 1080, videoCodecs: ['h264'], tenBitCodecs: [], audioCodecs: ['aac', 'mp3', 'ac3'], audioPassthrough: ['ac3'],
  maxAudioChannels: 2, multichannelAudioCodecs: ['ac3'], containers: ['mp4', 'm4v', 'mov', 'mkv', 'mp3', 'm4a', 'aac', 'flac'],
  supportsHls: true, canSelectAudioTrack: false, videoRange: { hdr10: false, hdr10Plus: false, hlg: false, dolbyVision: false, hdrDisplay: false }, player: 'roku',
};
/** Roku Ultra (4K, HEVC / VP9 / AV1) on an HDR10 TV with an E-AC-3 soundbar. */
const ultra = {
  ...hdRoku, maxWidth: 3840, maxHeight: 2160, videoCodecs: ['h264', 'hevc', 'vp9', 'av1'], tenBitCodecs: ['hevc', 'vp9', 'av1'],
  audioCodecs: ['aac', 'mp3', 'ac3', 'eac3', 'flac'], audioPassthrough: ['ac3', 'eac3'], maxAudioChannels: 6, multichannelAudioCodecs: ['ac3', 'eac3', 'aac'],
  videoRange: { hdr10: true, hdr10Plus: false, hlg: true, dolbyVision: false, hdrDisplay: true },
};

test('Roku: H.264 MKV with AC-3 direct-plays', () => {
  assert.equal(decide(media(), hdRoku, opts(track('ac3'))).method, 'direct');
});

test('Roku: HEVC on an H.264-only model is transcoded, on a 4K model it direct-plays', () => {
  const hevc = media({ videoCodec: 'hevc', width: 3840, height: 2160, resolutionLabel: '4K', bitrate: 20000 });
  assert.equal(decide(hevc, hdRoku, opts(track('eac3'))).method, 'transcode');
  assert.equal(decide(hevc, ultra, opts(track('eac3'))).method, 'direct');
});

test('Roku: unsupported audio (DTS without passthrough) keeps the video and re-encodes only the audio', () => {
  const d = decide(media(), hdRoku, opts(track('dts')));
  assert.equal(d.method, 'remux');
  assert.equal(d.videoCopy, true);
  assert.equal(d.audioCopy, false);
});

test('Roku: AVI is remuxed to HLS', () => {
  assert.equal(decide(media({ container: 'avi' }), hdRoku, opts(track('aac', 2))).method, 'remux');
});
