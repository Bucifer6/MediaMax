// Emby-style "Now playing" cards: the session breakdown (client, stream, video, audio, subtitles) and the
// admin pause / resume / message controls.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const sd = await import('../src/services/sessionDetails.ts');
const auth = await import('../src/services/auth.ts');
const playback = await import('../src/services/playback.ts');
const { events } = await import('../src/services/events.ts');
const { buildApp } = await import('../src/app.ts');

const app = await buildApp();
after(() => app.close());

const media = (o: any = {}) => ({ id: 'm', container: 'mkv', durationMs: 1000, size: 1, bitrate: 10000, width: 1920, height: 1080, videoCodec: 'h264', resolutionLabel: '1080p', hdr: false, audioStreams: [], subtitleStreams: [], remote: false, ...o });
const eac3 = { index: 1, codec: 'eac3', language: 'eng', title: null, channels: 6, default: true, channelLayout: '5.1(side)' };

test('user agents are named like Emby does', () => {
  assert.equal(sd.describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'), 'Chrome 131 on Windows');
  assert.equal(sd.describeUserAgent('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'), 'Edge 131 on Windows');
  assert.equal(sd.describeUserAgent('Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) Version/6.5 TV Safari/537.36'), 'Samsung TV (Tizen 6.5)');
  assert.equal(sd.describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), 'Safari 18 on iPhone');
  assert.equal(sd.describeUserAgent('okhttp/4.12.0'), null);
  assert.equal(sd.describeUserAgent(null), null);
});

test('direct play: container, bitrate and each stream read "Direct Play"', () => {
  const d = sd.mediaDetails({
    platform: 'web', appVersion: '1.2.0', hints: { userAgent: null, httpVersion: '1.1', secure: true }, local: false, media: media({ audioStreams: [eac3] }) as any,
    isAudioOnly: false, method: 'direct', videoCopy: true, audioCopy: true, audio: eac3 as any, audioPlan: null, reasons: [], adaptive: false, burnSub: null,
  });
  assert.deepEqual(d.client, { app: 'MediaMax Web', version: '1.2.0', browser: null, protocol: 'HTTP/1.1', secure: true, local: false });
  assert.equal(d.stream.container, 'MKV');
  assert.equal(d.stream.bitrate, 10000);
  assert.equal(d.stream.delivery, 'Direct Play');
  assert.equal(d.video?.label, '1080p H264');
  assert.equal(d.video?.action, 'direct');
  assert.equal(d.audio?.label, 'English EAC3 5.1 (Default)');
  assert.equal(d.audio?.action, 'direct');
  assert.equal(d.subtitle, null);
});

test('transcode: encoder output, hardware, tone-mapping and friendly reasons are merged in', () => {
  const d = sd.mediaDetails({
    platform: 'androidtv', local: true, media: media({ container: 'mpegts', videoCodec: 'hevc', width: 3840, height: 2160, hdr: true, videoRange: { label: 'HDR10', frameRate: 23.976 } }) as any,
    isAudioOnly: false, method: 'transcode', videoCopy: false, audioCopy: true, audio: eac3 as any, audioPlan: null,
    reasons: ['bitrate 10000k exceeds 7000k', 'video codec hevc not supported'], adaptive: false, burnSub: null,
  });
  assert.equal(d.client.app, 'MediaMax for Android TV');
  assert.deepEqual(d.stream.reasons, ['Reducing bitrate: source 10 Mbps is above the 7.0 Mbps limit', 'Video codec hevc not supported']);
  const live = sd.withJob(d, { videoCodec: 'h264_qsv', audioCodec: 'copy', bitrate: 7000, hwAccel: 'qsv', toneMap: 'vpp_qsv', height: 1080 }, 640);
  assert.equal(live.stream.outputBitrate, 7640);
  assert.equal(live.video?.label, '4K HEVC');
  assert.equal(live.video?.range, 'HDR10');
  assert.equal(live.video?.action, 'transcode');
  assert.deepEqual(live.video?.notes, ['H264 1080p · 7.0 Mbps', 'Hardware: QSV', 'HDR → SDR tone-mapping (vpp_qsv)']);
  assert.equal(live.audio?.action, 'copy');
  // Remux (copy): no encoder notes.
  const remux = sd.withJob({ ...d, video: { ...d.video!, action: 'copy' } }, { videoCodec: 'copy', audioCodec: 'aac', bitrate: null, hwAccel: 'none', audioDetail: 'AAC 5.1' }, 384);
  assert.deepEqual(remux.video?.notes, []);
  assert.equal(remux.stream.outputBitrate, null);
});

test('subtitles: burn-in is fixed at start; text subtitles follow what the player reports', () => {
  const subs = [
    { index: 3, codec: 'subrip', language: 'rum', title: null, default: false, forced: false, external: true },
    { index: 4, codec: 'hdmv_pgs_subtitle', language: 'eng', title: null, default: false, forced: true, external: false },
  ];
  const d = sd.mediaDetails({ platform: 'web', local: true, media: media() as any, isAudioOnly: false, method: 'direct', videoCopy: true, audioCopy: true, audio: null, audioPlan: null, reasons: [], adaptive: false, burnSub: null });
  const on = sd.withSubtitle(d, subs, 3);
  assert.deepEqual(on.subtitle, { label: 'Romanian SRT (External)', action: 'external' });
  assert.equal(sd.withSubtitle(on, subs, null).subtitle, null);
  assert.deepEqual(sd.withSubtitle(on, subs, undefined).subtitle, on.subtitle, 'not reported: unchanged');
  const burnt = sd.mediaDetails({ platform: 'web', local: true, media: media() as any, isAudioOnly: false, method: 'transcode', videoCopy: false, audioCopy: true, audio: null, audioPlan: null, reasons: [], adaptive: false, burnSub: subs[1] });
  assert.deepEqual(burnt.subtitle, { label: 'English PGS (Forced, Embedded)', action: 'burn-in' });
  assert.deepEqual(sd.withSubtitle(burnt, subs, 3).subtitle, burnt.subtitle);
});

test('admin can pause, resume and message a session on the playing device only', async () => {
  const admin = auth.createUser({ username: 'np-admin', password: 'pass1234', isAdmin: true });
  const viewer = auth.createUser({ username: 'np-viewer', password: 'pass1234' });
  const adminTok = auth.issueToken(admin.id, { deviceId: 'np-a', deviceName: 'Admin PC', platform: 'web' }).token;
  const viewerTok = auth.issueToken(viewer.id, { deviceId: 'np-tv', deviceName: 'Living room TV', platform: 'androidtv' }).token;
  const ctx = auth.authenticate(viewerTok)!;
  const details = sd.liveDetails('androidtv', '2.5.0', { httpVersion: '1.1' }, false, { container: 'MPEG-TS', delivery: 'HLS (remux)' });
  const s = playback.registerSession({ ctx, itemId: null, channelId: 'c1', mediaId: null, method: 'live', job: null, title: 'Antena 1', subtitle: null, posterUrl: null, durationMs: null, remoteAddr: '203.0.113.9', details });
  const listed = playback.listSessions().find((x) => x.id === s.id)!;
  assert.equal(listed.details?.client.app, 'MediaMax for Android TV');
  assert.equal(listed.details?.stream.delivery, 'HLS (remux)');

  const headers = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });
  const cmd = (body: object, t = adminTok) => app.inject({ method: 'POST', url: `/api/v1/sessions/${s.id}/command`, headers: headers(t), payload: JSON.stringify(body) });

  // No socket open for that device yet.
  assert.equal((await cmd({ action: 'pause' })).statusCode, 409);
  const got: any[] = [];
  const other: any[] = [];
  const tv = { id: 'w1', userId: viewer.id, isAdmin: false, deviceRowId: ctx.deviceRowId, deviceName: 'Living room TV', platform: 'androidtv', remoteState: null, send: (e: any) => got.push(e) };
  const phone = { id: 'w2', userId: viewer.id, isAdmin: false, deviceRowId: 'some-other-device', deviceName: 'Phone', platform: 'android', remoteState: null, send: (e: any) => other.push(e) };
  events.add(tv as any);
  events.add(phone as any);
  try {
    assert.equal((await cmd({ action: 'pause' }, viewerTok)).statusCode, 403, 'admins only');
    assert.equal((await cmd({ action: 'reboot' })).statusCode, 400);
    assert.equal((await cmd({ action: 'pause' })).statusCode, 200);
    assert.equal((await cmd({ action: 'message', text: 'Server restarts in 5 minutes', header: 'Maintenance' })).statusCode, 200);
    assert.equal((await cmd({ action: 'message', text: '   ' })).statusCode, 400);
    const pause = got.find((e) => e.type === 'remote.command');
    assert.equal(pause.action, 'pause');
    const msg = got.find((e) => e.type === 'session.message');
    assert.deepEqual([msg.header, msg.text], ['Maintenance', 'Server restarts in 5 minutes']);
    assert.ok(msg.timeoutMs >= 3000);
    assert.equal(other.filter((e) => e.type === 'remote.command' || e.type === 'session.message').length, 0, 'other devices are not touched');
  } finally {
    events.remove(tv as any);
    events.remove(phone as any);
    playback.stopSession(s.id, 'test', false);
  }
});
