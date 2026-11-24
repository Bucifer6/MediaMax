// Adaptive streaming (ladder, master/rendition playlists, rendition manager, segment alignment, bandwidth probe)
// and client-rendered subtitles (raw formats, partial extraction, fonts).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import type { HlsRendition } from '@mediamax/shared';

const abr = await import('../src/services/abr.ts');
const { buildArgs } = await import('../src/services/transcoder.ts');
const subs = await import('../src/services/subtitles.ts');
const { BANDWIDTH_MIN_BYTES, BANDWIDTH_RATE, resetBandwidthUsage } = await import('../src/routes/streaming.ts');
const { createUser, issueToken } = await import('../src/services/auth.ts');
const { buildApp } = await import('../src/app.ts');
const { db } = await import('../src/db.ts');
const { probe } = await import('../src/services/probe.ts');
const { encodeSup, sampleBitmap } = await import('../../web/test/pgsEncode.ts');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/* ------------------- fixtures (created before any test is registered) ------------------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-stream-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const admin = createUser({ username: 'streamadmin', password: 'pw-123456', isAdmin: true });
const viewer = createUser({ username: 'streamviewer', password: 'pw-123456' });
const atok = issueToken(admin.id, { deviceId: 'stream-a', deviceName: 'test', platform: 'web' }).token;
const vtok = issueToken(viewer.id, { deviceId: 'stream-v', deviceName: 'test', platform: 'web' }).token;
const app = await buildApp();
after(() => app.close());
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** A short MKV with SRT, ASS, PGS subtitle tracks and an attached font, registered as a movie. */
async function fixtureMovie(): Promise<{ itemId: string; mediaId: string; file: string; subs: { index: number; codec: string }[] }> {
  const sup = path.join(tmp, 's.sup');
  fs.writeFileSync(sup, encodeSup([{ startMs: 500, endMs: 2500, bitmap: { x: 40, y: 150, width: 240, height: 40, pixels: sampleBitmap(240, 40) }, palette: [{ index: 1, r: 0, g: 0, b: 255, a: 255 }, { index: 2, r: 255, g: 255, b: 255, a: 255 }, { index: 3, r: 255, g: 0, b: 0, a: 255 }] }], { width: 320, height: 240 }));
  fs.writeFileSync(path.join(tmp, 's.srt'), '1\n00:00:00,500 --> 00:00:02,000\nHello <i>SRT</i>\n\n2\n00:00:02,000 --> 00:00:03,000\nSecond\n');
  fs.writeFileSync(path.join(tmp, 's.ass'), '[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: 720\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,DejaVu Sans,40,&H0000FFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.50,0:00:02.50,Default,,0,0,0,,{\\pos(640,360)}Styled ASS\n');
  const font = ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'].find((f) => fs.existsSync(f));
  const file = path.join(tmp, 'movie.mkv');
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:d=3:r=25', '-f', 'lavfi', '-i', 'sine=d=3',
    '-i', path.join(tmp, 's.srt'), '-i', path.join(tmp, 's.ass'), '-i', sup,
    '-map', '0:v', '-map', '1:a', '-map', '2', '-map', '3', '-map', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-c:s:0', 'srt', '-c:s:1', 'ass', '-c:s:2', 'copy'];
  if (font) args.push('-attach', font, '-metadata:s:t', 'mimetype=application/x-truetype-font');
  args.push(file);
  const r = spawnSync('ffmpeg', args);
  assert.equal(r.status, 0, r.stderr?.toString());
  const p = await probe(file, file);
  const now = new Date().toISOString();
  const lib = 'lib-stream';
  db.run('INSERT OR IGNORE INTO libraries (id, name, type, paths, created_at) VALUES (?, ?, ?, ?, ?)', lib, 'Streaming test', 'movies', JSON.stringify([tmp]), now);
  db.run('INSERT INTO items (id, library_id, type, title, sort_title, added_at, updated_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'item-stream', lib, 'movie', 'Stream test', 'stream test', now, now, p.durationMs);
  db.run('INSERT INTO media (id, item_id, path, container, duration_ms, size, bitrate, width, height, video_codec, audio, subs, mtime) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    'media-stream', 'item-stream', file, p.container, p.durationMs, p.size, p.bitrate, p.width, p.height, p.videoCodec, JSON.stringify(p.audio), JSON.stringify(p.subs), fs.statSync(file).mtimeMs | 0);
  return { itemId: 'item-stream', mediaId: 'media-stream', file, subs: p.subs };
}

const fx = hasFfmpeg ? await fixtureMovie() : null;

/* --------------------------------- ladder --------------------------------- */

const L = (i: Partial<Parameters<typeof abr.buildLadder>[0]>) => abr.buildLadder({ sourceWidth: 1920, sourceHeight: 1080, sourceKbps: 10000, capKbps: Infinity, maxHeight: null, audioKbps: 192, ...i });
const shape = (l: HlsRendition[]) => l.map((r) => `${r.height}@${r.videoKbps}`);

test('ladder: rungs up to the source, highest first, max 4', () => {
  assert.deepEqual(shape(L({})), ['1080@8000', '720@4000', '480@1500', '360@720']);
  const uhd = L({ sourceWidth: 3840, sourceHeight: 2160, sourceKbps: 60000 });
  assert.deepEqual(shape(uhd), ['2160@20000', '1440@10000', '1080@8000', '720@4000']);
  assert.deepEqual(uhd.map((r) => r.width), [3840, 2560, 1920, 1280]);
  assert.deepEqual(uhd.map((r) => r.id), [0, 1, 2, 3]);
  // BANDWIDTH: video + audio + 8 % overhead, in bits/s.
  assert.equal(L({})[1].bandwidth, Math.round((4000 + 192) * 1000 * 1.08));
});

test('ladder: capped by source bitrate, hard cap and device height; close rungs dropped', () => {
  // Low-bitrate source: no rung above what the source carries; the transcoder outputs 540p at that bitrate.
  assert.deepEqual(shape(L({ sourceKbps: 3000 })), ['540@2808', '480@1500', '360@720']);
  // Remote cap 5 Mbps (incl. audio) → top rung 4.8 Mbps video at 720p; the 720p@4000 rung is too close to keep.
  assert.deepEqual(shape(L({ capKbps: 5000 })), ['720@4808', '480@1500', '360@720']);
  assert.deepEqual(shape(L({ maxHeight: 720 })), ['720@4000', '480@1500', '360@720']);
  // A source between rungs starts at the next rung down; a source below the lowest rung keeps its own size.
  assert.deepEqual(shape(L({ sourceWidth: 1920, sourceHeight: 800, sourceKbps: 9000 })), ['720@4000', '480@1500', '360@720']);
  assert.deepEqual(shape(L({ sourceWidth: 320, sourceHeight: 240, sourceKbps: 600 })), ['240@408']);
  // Tiny cap: still one playable rendition.
  assert.deepEqual(shape(L({ capKbps: 200 })), ['360@300']);
});

test('start rendition follows measured bandwidth (80 % safety share)', () => {
  const l = L({});
  assert.equal(abr.pickStartRendition(l, null), 0, 'no measurement: top');
  assert.equal(l[abr.pickStartRendition(l, 3000)].height, 480);
  assert.equal(l[abr.pickStartRendition(l, 6000)].height, 720);
  assert.equal(l[abr.pickStartRendition(l, 100)].height, 360, 'nothing fits: lowest');
});

test('bitrate caps: LAN unlimited, remote cap, measured bandwidth only limits the direct-play decision', () => {
  assert.deepEqual(abr.bitrateCaps({ isLocal: true, remoteMax: 4000 }), { capKbps: Infinity, decisionKbps: Infinity, bandwidthLimited: false });
  assert.equal(abr.bitrateCaps({ isLocal: false, remoteMax: 4000 }).capKbps, 4000);
  const m = abr.bitrateCaps({ isLocal: true, measuredKbps: 5000, userMax: 20000 });
  assert.deepEqual(m, { capKbps: 20000, decisionKbps: 4000, bandwidthLimited: true });
  assert.equal(abr.bitrateCaps({ isLocal: false, profileMax: 3000, measuredKbps: 50000 }).bandwidthLimited, false);
});

test('master playlist: best fit first, BANDWIDTH/RESOLUTION/CODECS, tokenised variant URIs', () => {
  const l = L({});
  const m = abr.masterPlaylist(l, 2, '?token=t', (r) => abr.codecsAttr('h264', r.height, 'aac'));
  const lines = m.trim().split('\n');
  assert.equal(lines[0], '#EXTM3U');
  assert.match(lines[3], /^#EXT-X-STREAM-INF:BANDWIDTH=\d+,AVERAGE-BANDWIDTH=\d+,RESOLUTION=854x480,CODECS="avc1\.640028,mp4a\.40\.2",NAME="480p"$/);
  assert.equal(lines[4], 'r2.m3u8?token=t');
  assert.equal(lines.filter((x) => x.startsWith('#EXT-X-STREAM-INF')).length, 4);
  assert.equal(abr.codecsAttr('hevc', 2160, null), 'hvc1.1.6.L153.90');
  assert.equal(abr.codecsAttr('h264', 1080, 'copy'), null, 'unknown audio codec: omit CODECS');
  assert.equal(abr.codecOfEncoder('hevc_vaapi'), 'hevc');
  assert.equal(abr.codecOfEncoder('libx264'), 'h264');
});

test('rendition playlist: identical segment grid for every rendition', () => {
  const p = abr.renditionPlaylist('r1_', 10.5, 4, 'ts', false, '?token=t');
  assert.match(p, /#EXT-X-PLAYLIST-TYPE:VOD/);
  assert.deepEqual(p.match(/#EXTINF:[\d.]+/g), ['#EXTINF:4.000', '#EXTINF:4.000', '#EXTINF:2.500']);
  assert.deepEqual(p.match(/r1_seg\d+\.ts\?token=t/g), ['r1_seg0.ts?token=t', 'r1_seg1.ts?token=t', 'r1_seg2.ts?token=t']);
  assert.match(abr.renditionPlaylist('r0_', 8, 4, 'm4s', true, '?q'), /#EXT-X-MAP:URI="r0_init\.mp4\?q"/);
});

test('segment alignment: a rendition started at segment N seeks to N×seg with keyframes forced on the segment grid', () => {
  const opts = {
    input: '/media/x.mkv', startSec: 0, durationSec: 600, mode: 'transcode' as const, audioIndex: null, audioCopy: false, videoCopy: false,
    bitrate: 4000, maxHeight: 720, sourceHeight: 1080, sourceCodec: 'h264', hdr: false, hasVideo: true,
  };
  const seg = 4;
  const n = 37;
  const a = buildArgs({ ...opts, startSec: n * seg }, '/tmp/r1', n, 'none').args;
  const b = buildArgs({ ...opts, bitrate: 1500, maxHeight: 480, startSec: n * seg }, '/tmp/r2', n, 'none').args;
  const val = (args: string[], k: string) => args[args.indexOf(k) + 1];
  for (const args of [a, b]) {
    assert.equal(val(args, '-ss'), (n * seg).toFixed(3));
    assert.equal(val(args, '-force_key_frames'), `expr:gte(t,n_forced*${seg})`);
    assert.equal(val(args, '-sc_threshold'), '0');
    assert.equal(val(args, '-hls_time'), String(seg));
    assert.equal(val(args, '-start_number'), String(n));
    assert.equal(val(args, '-output_ts_offset'), (n * seg).toFixed(3));
  }
  assert.notEqual(val(a, '-b:v'), val(b, '-b:v'), 'renditions differ in bitrate only');
});

test('live TV: HTTP-only reconnect options only for http(s) inputs (ffmpeg rejects them for rtsp/udp/rtp/files)', () => {
  const opts = {
    startSec: 0, durationSec: null, mode: 'live' as const, audioIndex: null, audioCopy: false, videoCopy: true,
    bitrate: 4000, maxHeight: null, sourceHeight: 1080, sourceCodec: 'h264', hdr: false, hasVideo: true,
  };
  for (const [input, want] of [['http://iptv/1.ts', true], ['HTTPS://iptv/1.m3u8', true], ['rtsp://192.0.2.1/?freq=11494', false], ['udp://239.0.0.1:1234', false], ['rtp://239.0.0.1:5000', false]] as const) {
    const args = buildArgs({ ...opts, input } as any, '/tmp/live', 0, 'none').args;
    assert.equal(args.includes('-reconnect'), want, input);
    assert.ok(args.indexOf('-fflags') < args.indexOf('-i'));
  }
});

test('burned-in text subtitles stay in sync after a seek; the burn runs on CPU frames before any hwupload', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  // A black clip and one cue at 11–13 s: playing from 10 s, the cue must be on the frame at 11.5 s, not at 21–23 s.
  const clip = path.join(tmp, 'burn.mp4');
  const srt = path.join(tmp, 'burn.srt');
  const mk = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=black:s=320x240:r=10:d=20', '-c:v', 'libx264', '-g', '10', '-pix_fmt', 'yuv420p', clip]);
  assert.equal(mk.status, 0, String(mk.stderr));
  fs.writeFileSync(srt, '1\n00:00:11,000 --> 00:00:13,000\nSUBTITLE CUE\n\n');
  const opts = {
    input: clip, startSec: 10, durationSec: 20, mode: 'transcode' as const, audioIndex: null, audioCopy: false, videoCopy: false,
    bitrate: 4000, maxHeight: null, sourceHeight: 240, sourceCodec: 'h264', hdr: false, hasVideo: true, burnSubtitle: { kind: 'external' as const, file: srt },
  };
  const val = (args: string[], k: string) => args[args.indexOf(k) + 1];
  const vf = val(buildArgs(opts, path.join(tmp, 'burn-out'), 0, 'none').args, '-vf');
  assert.match(vf, /^setpts=PTS\+10\.000\/TB,subtitles=.*,setpts=PTS-10\.000\/TB,format=yuv420p$/);
  assert.ok(!val(buildArgs({ ...opts, startSec: 0 }, path.join(tmp, 'burn-out'), 0, 'none').args, '-vf').includes('setpts'), 'no shift without a seek');
  // Hardware encoders: the shifted burn comes before the upload to the GPU.
  const hwVf = val(buildArgs(opts, path.join(tmp, 'burn-out'), 0, { hw: 'vaapi', codec: 'h264', toneMap: null }).args, '-vf').split(',');
  const at = (f: string) => hwVf.findIndex((x) => x.startsWith(f));
  assert.ok(at('setpts=PTS+') >= 0 && at('setpts=PTS+') < at('subtitles=') && at('subtitles=') < at('setpts=PTS-') && at('setpts=PTS-') < at('hwupload'), hwVf.join(','));
  // Render it the way the transcode does (input seek, same filters) and look at output frames 1.5 s and 3.5 s in.
  const lit = (outSec: number) => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', '10.000', '-i', clip, '-vf', vf, '-ss', String(outSec), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { maxBuffer: 1 << 24 });
    assert.equal(r.status, 0, String(r.stderr));
    return (r.stdout as Buffer).filter((b) => b > 128).length;
  };
  assert.ok(lit(1.5) > 50, 'the cue at 11–13 s is drawn on the frame at 11.5 s');
  assert.equal(lit(3.5), 0, 'and gone at 13.5 s');
});

/* --------------------------- rendition manager --------------------------- */

class FakeJob implements import('../src/services/abr.ts').RenditionJob {
  static log: string[] = [];
  readonly segmentType = 'mpegts' as const;
  readonly segmentExt = 'ts';
  exited = false;
  info = { videoCodec: 'libx264', audioCodec: 'aac', bitrate: 1, hwAccel: 'none' };
  started: number | null = null;
  stopped = false;
  constructor(readonly id: string, readonly r: HlsRendition) {}
  start(n = 0) {
    this.started = n;
    FakeJob.log.push(`start r${this.r.id}@${n}`);
  }
  stop() {
    this.stopped = true;
    this.exited = true;
    FakeJob.log.push(`stop r${this.r.id}`);
  }
  tick() {}
  async waitForSegment(n: number) {
    return `/fake/${this.id}/seg${n}.ts`;
  }
  async initSegment() {
    return `/fake/${this.id}/init.mp4`;
  }
}

function manager(o: Partial<import('../src/services/abr.ts').RenditionManagerOptions> = {}) {
  let now = 0;
  FakeJob.log = [];
  const m = new abr.RenditionManager({
    sessionId: 's', ladder: L({}), startRendition: 1, startSegment: 10, durationSec: 600, segmentSeconds: 4, maxActive: 2, idleMs: 20000,
    createJob: (id, r) => new FakeJob(id, r), now: () => now, ...o,
  });
  return { m, advance: (ms: number) => (now += ms) };
}

test('rendition manager: start rendition warmed up, others encoded only when requested, from the requested segment', async () => {
  const { m, advance } = manager();
  assert.deepEqual(FakeJob.log, ['start r1@10']);
  assert.equal(m.runningCount(), 1);
  await m.segment(1, 10);
  advance(4000);
  // Player switches to 480p at segment 14: only now does that encoder start, at segment 14.
  await m.segment(2, 14);
  assert.deepEqual(FakeJob.log, ['start r1@10', 'start r2@14']);
  assert.equal(m.activeId, 2);
  assert.equal(m.switches, 1);
  assert.match(m.media(2, '?t'), /r2_seg14\.ts\?t/);
  // A third rendition with a budget of 2 encoders stops the least recently used one.
  advance(1000);
  await m.segment(3, 15);
  assert.ok(FakeJob.log.includes('stop r1'));
  assert.deepEqual(m.heldRenditions(), [2, 3]);
  m.stop();
  assert.equal(m.runningCount(), 0);
});

test('rendition manager: idle renditions are stopped, the active one is kept', async () => {
  const { m, advance } = manager();
  await m.segment(1, 10);
  await m.segment(0, 11); // switch up
  advance(19000);
  m.reapIdle();
  assert.deepEqual(m.heldRenditions(), [0, 1], 'not idle long enough yet');
  advance(2000);
  m.reapIdle();
  assert.deepEqual(m.heldRenditions(), [0]);
  assert.ok(FakeJob.log.includes('stop r1'));
  m.stop();
});

test('rendition manager: one encoder session (or no hardware room) → restart-style switching', async () => {
  const one = manager({ maxActive: 1 }).m;
  await one.segment(2, 20);
  assert.deepEqual(FakeJob.log, ['start r1@10', 'stop r1', 'start r2@20']);
  one.stop();
  const full = manager({ maxActive: 2, canStartExtra: () => false }).m;
  await full.segment(3, 12);
  assert.deepEqual(FakeJob.log, ['start r1@10', 'stop r1', 'start r3@12']);
  full.stop();
  assert.equal(abr.sessionEncoderLimit('v4l2m2m'), 1);
  assert.equal(abr.sessionEncoderLimit('vaapi'), 2);
  assert.equal(abr.hardwareHasRoom(7, 'nvenc'), true);
  assert.equal(abr.hardwareHasRoom(8, 'nvenc'), false);
});

test('rendition requests: file names map to playlists, segments and init', async () => {
  const { m } = manager();
  const pl = await abr.renditionRequest(m, 'r0.m3u8', '?t');
  assert.equal(pl?.kind, 'playlist');
  assert.equal(await abr.renditionRequest(m, 'master.m3u8', '?t'), null);
  await assert.rejects(abr.renditionRequest(m, 'r9_seg1.ts', '?t'), /Unknown rendition/);
  m.stop();
});

/* ------------------------- real adaptive transcode ------------------------- */


test('subtitle track list: text tracks get rawUrl/format; PGS only for clients that render it', { skip: !fx && 'ffmpeg not installed' }, () => {
  const stored = fx!.subs as never[];
  const legacy = subs.subtitleTrackList('?token=x', fx!.mediaId, stored);
  assert.deepEqual(legacy.tracks.map((t) => t.format), ['srt', 'ass']);
  assert.match(legacy.tracks[0].url, /\/\d+\.vtt\?token=x$/, 'WebVTT url kept for older clients');
  assert.match(legacy.tracks[1].rawUrl!, /\/\d+\.ass\?token=x$/);
  assert.match(legacy.tracks[1].fontsUrl!, /\/fonts\?token=x$/);
  assert.deepEqual(legacy.burnIn.map((t) => t.format), ['pgs']);
  const modern = subs.subtitleTrackList('?token=x', fx!.mediaId, stored, ['srt', 'vtt', 'ass', 'pgs']);
  assert.deepEqual(modern.tracks.map((t) => t.format), ['srt', 'ass', 'pgs']);
  assert.match(modern.tracks[2].rawUrl!, /\.sup\?token=x$/);
  assert.equal(modern.burnIn.length, 0);
  // Only the selected stream is extracted; audio/video packets are discarded by the demuxer.
  const ea = subs.extractArgs('/m.mkv', 4, 'sup', 'hdmv_pgs_subtitle', '/o.sup');
  assert.deepEqual(ea.slice(ea.indexOf('-i')), ['-i', '/m.mkv', '-map', '0:4', '-c:s', 'copy', '-f', 'sup', '/o.sup']);
  assert.ok(ea.includes('-discard:v') && ea.includes('-discard:a'));
});

test('subtitle endpoints: original formats, legacy VTT, partial flag, auth, fonts', { skip: !fx && 'ffmpeg not installed' }, async () => {
  const [srt, ass, pgs] = fx!.subs;
  const get = (u: string, t = vtok) => app.inject({ method: 'GET', url: `/api/v1/stream/subtitles/${fx!.mediaId}/${u}`, headers: auth(t) });
  let r = await get(`${srt.index}.srt`);
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'] as string, /subrip/);
  // (ffmpeg normalises the file's start time — here +23 ms of AAC priming — exactly as the transcoder does.)
  assert.match(r.body, /00:00:00,5\d\d --> 00:00:02,0\d\d\r?\nHello <i>SRT<\/i>/);
  assert.equal(r.headers['x-subtitle-complete'], '1');
  r = await get(String(srt.index)); // legacy: no extension = WebVTT
  assert.match(r.body, /^WEBVTT/);
  r = await get(`${ass.index}.ass?partial=1`);
  assert.match(r.body, /\{\\pos\(640,360\)\}Styled ASS/);
  assert.equal(r.headers['x-subtitle-complete'], '1');
  r = await get(`${ass.index}.ssa`);
  assert.equal(r.statusCode, 200);
  r = await get(`${pgs.index}.sup`);
  assert.equal(r.statusCode, 200);
  assert.equal(r.rawPayload.subarray(0, 2).toString(), 'PG');
  assert.equal(r.rawPayload[10], 0x16, 'first segment is a PCS');
  r = await get(`${pgs.index}.vtt`);
  assert.equal(r.statusCode, 400, 'bitmap subtitles are never converted to text');
  r = await app.inject({ method: 'GET', url: `/api/v1/stream/subtitles/${fx!.mediaId}/${srt.index}.srt` });
  assert.equal(r.statusCode, 401);
  // Embedded fonts (MKV attachments) for libass.
  r = await app.inject({ method: 'GET', url: `/api/v1/stream/subtitles/${fx!.mediaId}/fonts`, headers: auth(vtok) });
  const fonts = r.json() as { name: string; url: string }[];
  if (fonts.length) {
    assert.match(fonts[0].name, /\.ttf$/);
    const f = await app.inject({ method: 'GET', url: fonts[0].url.replace(/\?token=.*/, ''), headers: auth(vtok) });
    assert.equal(f.statusCode, 200);
    assert.equal(f.headers['content-type'], 'font/ttf');
    assert.ok(f.rawPayload.length > 10000);
  }
  r = await app.inject({ method: 'GET', url: `/api/v1/stream/subtitles/${fx!.mediaId}/fonts/..%2Fetc%2Fpasswd`, headers: auth(vtok) });
  assert.equal(r.statusCode, 404);
});

test('partial subtitle content is cut at the last complete cue', () => {
  const p = path.join(tmp, 'partial.srt.part');
  fs.writeFileSync(p, '1\n00:00:01,000 --> 00:00:02,000\nOne\n\n2\n00:00:03,000 --> 00:00:04,000\nTw');
  const out = subs.partialContent({ file: p.replace('.part', ''), part: p, ext: 'srt', complete: false, failed: null, progress: 0.5, done: Promise.resolve('') }).toString();
  assert.equal(out.trim(), '1\n00:00:01,000 --> 00:00:02,000\nOne');
});

test('adaptive transcode end to end: master playlist, lazily encoded renditions, aligned segments', { skip: !fx && 'ffmpeg not installed' }, async () => {
  // A transcode is forced by a client that can't decode H.264; LAN client, measured 1.2 Mbps → starts on a low rendition.
  const start = await app.inject({
    method: 'POST', url: `/api/v1/playback/${fx!.itemId}`, headers: auth(atok),
    payload: { adaptive: true, measuredBandwidth: 1200, subtitleFormats: ['srt', 'vtt', 'ass', 'pgs'], deviceProfile: { videoCodecs: ['vp9'], containers: ['mp4'], audioCodecs: ['aac'] } },
  });
  assert.equal(start.statusCode, 200, start.body);
  const info = start.json();
  assert.equal(info.method, 'transcode');
  assert.equal(info.adaptiveMode, 'renditions');
  assert.ok(info.renditions.length >= 2, JSON.stringify(info.renditions));
  assert.equal(info.isLocal, true);
  assert.deepEqual(info.subtitles.map((s: { format: string }) => s.format), ['srt', 'ass', 'pgs']);
  const sid = info.sessionId;
  const hls = (f: string) => app.inject({ method: 'GET', url: `/api/v1/stream/hls/${sid}/${f}`, headers: auth(atok) });
  const master = (await hls('master.m3u8')).body;
  const firstVariant = master.split('\n').find((l) => l.startsWith('r'))!;
  assert.equal(firstVariant.split('.')[0], `r${info.startRendition}`, 'best-fit rendition listed first');
  const lo = info.renditions.at(-1).id;
  const hi = info.renditions[0].id;
  const pl = (await hls(`r${lo}.m3u8`)).body;
  assert.match(pl, new RegExp(`r${lo}_seg0\\.ts`));
  const seg0 = await hls(`r${lo}_seg0.ts`);
  assert.equal(seg0.statusCode, 200);
  assert.equal(seg0.rawPayload[0], 0x47, 'MPEG-TS sync byte');
  // Switch up at segment 0: the other rendition's encoder starts on demand.
  const segHi = await hls(`r${hi}_seg0.ts`);
  assert.equal(segHi.statusCode, 200);
  // Both renditions' first segments start at the same PTS (aligned for seamless switching).
  const pts = (buf: Buffer) => {
    const f = path.join(tmp, `p${Math.random()}.ts`);
    fs.writeFileSync(f, buf);
    const o = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-read_intervals', '%+#1', '-of', 'csv=p=0', f]).stdout.toString().trim();
    return parseFloat(o.split('\n')[0]);
  };
  assert.ok(Math.abs(pts(seg0.rawPayload) - pts(segHi.rawPayload)) < 0.05, `${pts(seg0.rawPayload)} vs ${pts(segHi.rawPayload)}`);
  const sizes = [seg0.rawPayload.length, segHi.rawPayload.length];
  assert.ok(sizes[1] > sizes[0], `higher rendition is bigger: ${sizes}`);
  await app.inject({ method: 'DELETE', url: `/api/v1/playback/sessions/${sid}`, headers: auth(atok) });
});

/* ----------------------------- bandwidth probe ----------------------------- */

test('bandwidth test: auth, size clamp, no-cache headers, incompressible body, rate limit', async () => {
  resetBandwidthUsage();
  let r = await app.inject({ method: 'GET', url: '/api/v1/playback/bandwidth-test?bytes=65536' });
  assert.equal(r.statusCode, 401);
  r = await app.inject({ method: 'GET', url: '/api/v1/playback/bandwidth-test?bytes=65536', headers: auth(vtok) });
  assert.equal(r.statusCode, 200);
  assert.equal(r.rawPayload.length, 65536);
  assert.match(r.headers['cache-control'] as string, /no-store/);
  assert.match(r.headers['cache-control'] as string, /no-transform/);
  assert.equal(r.headers['content-type'], 'application/octet-stream');
  assert.ok(zlib.gzipSync(r.rawPayload).length > 65536 * 0.98, 'random bytes do not compress');
  r = await app.inject({ method: 'GET', url: '/api/v1/playback/bandwidth-test?bytes=1', headers: auth(vtok) });
  assert.equal(r.rawPayload.length, BANDWIDTH_MIN_BYTES);
  r = await app.inject({ method: 'GET', url: '/api/v1/playback/bandwidth-test?bytes=99999999999', headers: auth(vtok) });
  assert.equal(r.rawPayload.length, abr.DEFAULT_STREAMING.bandwidthTestMaxBytes);
  r = await app.inject({ method: 'GET', url: '/api/v1/playback/bandwidth-test?bytes=-5', headers: auth(vtok) });
  assert.equal(r.statusCode, 400);
  resetBandwidthUsage();
  let limited = 0;
  for (let i = 0; i < BANDWIDTH_RATE.maxRequests + 2; i++) {
    const x = await app.inject({ method: 'GET', url: '/api/v1/playback/bandwidth-test?bytes=8192', headers: auth(vtok) });
    if (x.statusCode === 429) limited++;
  }
  assert.equal(limited, 2);
  // Another user has their own budget.
  r = await app.inject({ method: 'GET', url: '/api/v1/playback/bandwidth-test?bytes=8192', headers: auth(atok) });
  assert.equal(r.statusCode, 200);
});
