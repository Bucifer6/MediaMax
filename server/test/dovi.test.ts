/**
 * Real Dolby Vision over HLS (dovi.ts): codec strings, decisions per device, master playlist, FFmpeg arguments, and
 * an end-to-end remux of a synthetic Dolby Vision file (FFmpeg can't encode DV, so a libx265 HEVC file gets a
 * hand-written dvcC/dvvC box; FFmpeg's demuxer then reports DOVI configuration side data exactly as for a real file).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dovi = await import('../src/services/dovi.ts');
const { parseVideoRange, rangeDecision } = await import('../src/services/hdr.ts');
const { decide, dolbyVisionPlayback } = await import('../src/services/playback.ts');
const { buildArgs } = await import('../src/services/transcoder.ts');
const { updateSettings } = await import('../src/services/settings.ts');

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/hdr/dovi.json'), 'utf8'));
const range = (k: string) => parseVideoRange(fixtures[k])!;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-dovi-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const DV = (profile: number, level: number | null, blCompatId: number | null) => ({ profile, level, blCompatId, rpu: true, el: profile === 7, bl: true });

/* ------------------------------ codec strings ------------------------------ */

test('codec strings for profiles 5, 7, 8.1, 8.2, 8.4, 10 with zero-padded levels', () => {
  const p5 = dovi.doviSignal(DV(5, 6, 0), { videoCodec: 'hevc', height: 2160 })!;
  assert.deepEqual([p5.profile, p5.sampleEntry, p5.dvCodec, p5.baseCodec, p5.videoRange], ['5', 'dvh1', 'dvh1.05.06', null, 'PQ']);
  const p7 = dovi.doviSignal(DV(7, 6, 6), { videoCodec: 'hevc' })!;
  assert.deepEqual([p7.profile, p7.sampleEntry, p7.dvCodec], ['7', 'dvh1', 'dvh1.07.06']);
  const p81 = dovi.doviSignal(DV(8, 6, 1), { videoCodec: 'hevc', height: 2160 })!;
  assert.deepEqual([p81.profile, p81.sampleEntry, p81.dvCodec, p81.baseCodec, p81.brand, p81.videoRange], ['8.1', 'hvc1', 'dvh1.08.06', 'hvc1.2.4.L153.B0', 'db1p', 'PQ']);
  const p84 = dovi.doviSignal(DV(8, 9, 4), { videoCodec: 'hevc', height: 2160 })!;
  assert.deepEqual([p84.profile, p84.dvCodec, p84.brand, p84.videoRange], ['8.4', 'dvh1.08.09', 'db4h', 'HLG']);
  const p82 = dovi.doviSignal(DV(8, 4, 2), { videoCodec: 'hevc', height: 1080 })!;
  assert.deepEqual([p82.profile, p82.dvCodec, p82.baseCodec, p82.brand, p82.videoRange], ['8.2', 'dvh1.08.04', 'hvc1.2.4.L123.B0', 'db2g', 'SDR']);
  const lvl13 = dovi.doviSignal(DV(8, 13, 1), { videoCodec: 'hevc' })!;
  assert.equal(lvl13.dvCodec, 'dvh1.08.13');
  const p101 = dovi.doviSignal(DV(10, 6, 1), { videoCodec: 'av1', height: 2160 })!;
  assert.deepEqual([p101.profile, p101.sampleEntry, p101.dvCodec, p101.baseCodec, p101.brand], ['10.1', 'av01', 'dav1.10.06', 'av01.0.13M.10', 'db1p']);
  const p100 = dovi.doviSignal(DV(10, 5, 0), { videoCodec: 'av1' })!;
  assert.deepEqual([p100.profile, p100.dvCodec, p100.baseCodec], ['10', 'dav1.10.05', null]);
  // No level in the record: from the resolution and frame rate.
  assert.equal(dovi.doviSignal(DV(8, null, 1), { height: 2160, frameRate: 23.976 })!.dvCodec, 'dvh1.08.06');
  assert.equal(dovi.doviSignal(DV(8, 0, 1), { height: 1080, frameRate: 60 })!.dvCodec, 'dvh1.08.05');
  // Not carried natively: profile 9 (AVC), unknown profile, profile 8 on a non-HEVC stream.
  assert.equal(dovi.doviSignal(DV(9, 5, 2), { videoCodec: 'h264' }), null);
  assert.equal(dovi.doviSignal(DV(0, null, null)), null);
  assert.equal(dovi.doviSignal(DV(8, 6, 1), { videoCodec: 'av1' }), null);
});

test('CODECS / SUPPLEMENTAL-CODECS: Apple style, and DV-in-CODECS for ExoPlayer', () => {
  const p81 = dovi.doviSignal(DV(8, 6, 1), { videoCodec: 'hevc', height: 2160 })!;
  assert.deepEqual(dovi.doviCodecsAttrs(p81, 'supplemental', null, 'ec-3'), { codecs: 'hvc1.2.4.L153.B0,ec-3', supplemental: 'dvh1.08.06/db1p' });
  assert.deepEqual(dovi.doviCodecsAttrs(p81, 'supplemental', 'hvc1.2.4.L150.90', 'mp4a.40.2'), { codecs: 'hvc1.2.4.L150.90,mp4a.40.2', supplemental: 'dvh1.08.06/db1p' });
  assert.deepEqual(dovi.doviCodecsAttrs(p81, 'codecs', 'hvc1.2.4.L150.90', 'ec-3'), { codecs: 'dvh1.08.06,ec-3', supplemental: null });
  const p84 = dovi.doviSignal(DV(8, 6, 4), { videoCodec: 'hevc' })!;
  assert.equal(dovi.doviCodecsAttrs(p84, 'supplemental', null, null).supplemental, 'dvh1.08.06/db4h');
  const p5 = dovi.doviSignal(DV(5, 6, 0), { videoCodec: 'hevc' })!;
  // Profile 5: no compatible base layer, the DV codec is the CODECS entry (Apple HLS authoring spec).
  assert.deepEqual(dovi.doviCodecsAttrs(p5, 'supplemental', 'hvc1.2.4.L153.B0', 'ec-3'), { codecs: 'dvh1.05.06,ec-3', supplemental: null });
  const p101 = dovi.doviSignal(DV(10, 6, 1), { videoCodec: 'av1' })!;
  assert.deepEqual(dovi.doviCodecsAttrs(p101, 'supplemental', 'av01.0.12M.10', 'Opus'), { codecs: 'av01.0.12M.10,Opus', supplemental: 'dav1.10.06/db1p' });
  assert.equal(dovi.doviCodecStyle('exoplayer'), 'codecs');
  assert.equal(dovi.doviCodecStyle('webos-mse'), 'supplemental');
  assert.equal(dovi.doviCodecStyle('avplayer'), 'supplemental');
});

test('master playlist carries CODECS, SUPPLEMENTAL-CODECS, VIDEO-RANGE', () => {
  const m = dovi.doviMasterPlaylist({ uri: 'stream.m3u8?token=t', bandwidth: 22_000_000, codecs: 'hvc1.2.4.L153.B0,ec-3', supplemental: 'dvh1.08.06/db1p', videoRange: 'PQ', width: 3840, height: 2160, frameRate: 23.976 });
  assert.equal(m, [
    '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-STREAM-INF:BANDWIDTH=22000000,AVERAGE-BANDWIDTH=18700000,CODECS="hvc1.2.4.L153.B0,ec-3",SUPPLEMENTAL-CODECS="dvh1.08.06/db1p",RESOLUTION=3840x2160,FRAME-RATE=23.976,VIDEO-RANGE=PQ',
    'stream.m3u8?token=t', '',
  ].join('\n'));
  const p5 = dovi.doviMasterPlaylist({ uri: 's.m3u8', bandwidth: 1e6, codecs: 'dvh1.05.06,ec-3', supplemental: null, videoRange: 'PQ' });
  assert.match(p5, /CODECS="dvh1\.05\.06,ec-3",VIDEO-RANGE=PQ\n/);
  assert.doesNotMatch(p5, /SUPPLEMENTAL/);
});

/* ------------------------------ decisions ------------------------------ */

const media = (o: any = {}) => ({ id: 'm', container: 'mkv', durationMs: 1000, size: 1, bitrate: 20000, width: 3840, height: 2160, videoCodec: 'hevc', resolutionLabel: '4K', hdr: true, audioStreams: [], subtitleStreams: [], remote: false, edition: null, ...o });
const eac3 = { index: 1, codec: 'eac3', language: 'eng', title: null, channels: 6, default: true };
const opts = { audio: eac3, burnSubs: false, forceTranscode: false, allowTranscode: true, userMaxBitrate: null, isAudioOnly: false, doviMux: true };
// TV apps leave video containers out of their profile, so the server always remuxes to fMP4 HLS for hls.js/MSE.
const tvBase = { videoCodecs: ['h264', 'hevc'], audioCodecs: ['aac', 'ac3', 'eac3'], containers: ['mp3', 'm4a'], tenBitCodecs: ['hevc'] };
const LG = { ...tvBase, player: 'webos-mse', videoRange: { hdr10: true, hlg: true, dolbyVision: true, dolbyVisionProfiles: ['5', '8.1', '8.4'] } };
const SAMSUNG = { ...tvBase, player: 'tizen-mse', videoRange: { hdr10: true, hdr10Plus: true, hlg: true, dolbyVision: false } };
const SAFARI = { videoCodecs: ['h264', 'hevc'], audioCodecs: ['aac', 'ac3', 'eac3'], containers: ['mp4', 'm4v', 'mov'], player: 'html5', videoRange: { hdr10: true, hlg: true, dolbyVision: true, dolbyVisionProfiles: ['5', '8.1', '8.4'] } };
const ANDROID = { videoCodecs: ['h264', 'hevc', 'av1'], audioCodecs: ['aac', 'ac3', 'eac3'], containers: ['mp4', 'mkv'], player: 'exoplayer', tenBitCodecs: ['hevc', 'av1'], videoRange: { hdr10: true, hlg: true, dolbyVision: true, dolbyVisionProfiles: ['5', '8.1', '8.2', '8.4', '10'] } };
const CHROME = { videoCodecs: ['h264', 'hevc'], audioCodecs: ['aac', 'ac3', 'eac3'], containers: ['mp4'], player: 'html5', videoRange: { hdr10: true, hlg: true, dolbyVision: false } };

test('LG webOS with Dolby Vision: DV 8.1 and 5 are remuxed as real Dolby Vision', () => {
  const d = decide(media({ videoRange: range('dv_p81_mkv') }), LG, opts);
  assert.equal(d.method, 'remux');
  assert.equal(d.range?.delivery, 'passthrough');
  assert.equal(d.dolbyVision?.dvCodec, 'dvh1.08.06');
  assert.equal(d.dolbyVision?.sampleEntry, 'hvc1');
  assert.equal(d.videoBsf, null);
  assert.deepEqual(dolbyVisionPlayback(media({ videoRange: range('dv_p81_mkv') }) as any, d), { profile: '8.1', level: 6, mode: 'native', baseLayer: 'hdr10', codec: 'dvh1.08.06' });
  const d5 = decide(media({ videoRange: range('dv_p5_mp4'), container: 'mp4' }), LG, opts);
  assert.equal(d5.method, 'remux');
  assert.equal(d5.dolbyVision?.sampleEntry, 'dvh1');
  assert.equal(d5.dolbyVision?.dvCodec.slice(0, 8), 'dvh1.05.');
  // Profile 7 isn't listed: still stripped to its HDR10 base layer, as before.
  const d7 = decide(media({ videoRange: range('dv_p7_mkv') }), LG, opts);
  assert.equal(d7.range?.delivery, 'strip-dovi');
  assert.equal(d7.dolbyVision, undefined);
  // …and kept as real profile 7 when the device lists it.
  const d7ok = decide(media({ videoRange: range('dv_p7_mkv') }), { ...LG, videoRange: { ...LG.videoRange, dolbyVisionProfiles: ['7', '8.1'] } }, opts);
  assert.equal(d7ok.dolbyVision?.dvCodec.slice(0, 7), 'dvh1.07');
  assert.equal(d7ok.videoBsf, null);
});

test('LG with an FFmpeg that cannot write DV boxes: base layer, or tone-map for profile 5', () => {
  const d = decide(media({ videoRange: range('dv_p81_mkv') }), LG, { ...opts, doviMux: false });
  assert.equal(d.method, 'remux');
  assert.equal(d.range?.delivery, 'base-layer');
  assert.equal(d.dolbyVision, undefined);
  assert.ok(d.reasons.some((r) => /can't be remuxed/.test(r)));
  assert.equal(dolbyVisionPlayback(media({ videoRange: range('dv_p81_mkv') }) as any, d)?.mode, 'base-layer');
  const d5 = decide(media({ videoRange: range('dv_p5_mp4'), container: 'mp4' }), LG, { ...opts, doviMux: false });
  assert.equal(d5.method, 'transcode');
  assert.equal(d5.toneMap, true);
  assert.equal(d5.range?.delivery, 'tonemap');
});

test('Samsung (no Dolby Vision): HDR10 base layer, unchanged', () => {
  const d = decide(media({ videoRange: range('dv_p81_mkv') }), SAMSUNG, opts);
  assert.equal(d.method, 'remux');
  assert.equal(d.range?.delivery, 'base-layer');
  assert.equal(d.dolbyVision, undefined);
  const info = dolbyVisionPlayback(media({ videoRange: range('dv_p81_mkv') }) as any, d)!;
  assert.deepEqual([info.mode, info.baseLayer], ['base-layer', 'hdr10']);
  assert.equal(decide(media({ videoRange: range('dv_p5_mp4') }), SAMSUNG, opts).method, 'transcode');
});

test('Safari: direct play of DV MP4; MKV is remuxed with DV signalling', () => {
  assert.equal(decide(media({ videoRange: range('dv_p84_mp4'), container: 'mp4' }), SAFARI, opts).method, 'direct');
  const d = decide(media({ videoRange: range('dv_p84_mp4') }), SAFARI, opts);
  assert.equal(d.method, 'remux');
  assert.equal(d.dolbyVision?.videoRange, 'HLG');
  assert.equal(d.dolbyVision?.brand, 'db4h');
});

test('Android with a DV decoder: direct play of MKV; AV1 profile 10 too', () => {
  assert.equal(decide(media({ videoRange: range('dv_p81_mkv') }), ANDROID, opts).method, 'direct');
  const p10 = { ...range('dv_p81_mkv'), label: 'Dolby Vision 10.1', dolbyVision: DV(10, 6, 1) };
  assert.equal(rangeDecision(p10, true, ANDROID.videoRange).delivery, 'passthrough');
  // Remux (here: an AVI container) keeps profile 10 on the av01 sample entry with a dvvC box.
  const d = decide(media({ videoCodec: 'av1', container: 'avi', videoRange: p10 }), ANDROID, opts);
  assert.equal(d.method, 'remux');
  assert.deepEqual([d.dolbyVision?.sampleEntry, d.dolbyVision?.dvCodec], ['av01', 'dav1.10.06']);
  // A device without profile 10 gets the AV1 HDR10 base layer.
  assert.equal(rangeDecision(p10, true, { ...ANDROID.videoRange, dolbyVisionProfiles: ['8.1'] }).delivery, 'base-layer');
});

test('Chrome without Dolby Vision: base layer; legacy clients unchanged', () => {
  const d = decide(media({ videoRange: range('dv_p81_mkv') }), CHROME, opts);
  assert.equal(d.method, 'remux');
  assert.equal(d.range?.delivery, 'base-layer');
  assert.equal(d.dolbyVision, undefined);
  // No videoRange at all (old app): no DV signalling, exactly as before.
  const legacy = decide(media({ videoRange: range('dv_p81_mkv') }), { videoCodecs: ['hevc'], containers: ['mp4'], audioCodecs: ['eac3'] }, opts);
  assert.equal(legacy.method, 'remux');
  assert.equal(legacy.dolbyVision, undefined);
});

/* ------------------------------ FFmpeg arguments ------------------------------ */

const topts = (o: any = {}) => ({
  input: '/media/dv.mkv', startSec: 0, durationSec: 100, mode: 'remux', audioIndex: 1, audioCopy: true, videoCopy: true,
  bitrate: 20000, maxHeight: null, sourceHeight: 2160, sourceCodec: 'hevc', hdr: true, audioChannels: 6, hasVideo: true, ...o,
});
const remux = (sig: any) => ({ ...sig, style: 'supplemental', bandwidthKbps: 20000, width: 3840, height: 2160, frameRate: 23.976 });
const after_ = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

test('FFmpeg args: DV remux keeps the DV box (-strict unofficial) and picks the sample entry', () => {
  updateSettings({ transcoding: { hwAccel: 'none', segmentSeconds: 4 } as any });
  const plain = buildArgs(topts() as any, '/t', 0, 'none').args;
  assert.equal(after_(plain, '-tag:v'), 'hvc1');
  assert.ok(!plain.includes('-strict'), 'non-DV remux unchanged (no DV box written)');
  const p5 = buildArgs(topts({ dolbyVision: remux(dovi.doviSignal(DV(5, 6, 0), { videoCodec: 'hevc' })) }) as any, '/t', 0, 'none');
  assert.equal(p5.segmentType, 'fmp4');
  assert.equal(after_(p5.args, '-strict'), 'unofficial');
  assert.equal(after_(p5.args, '-tag:v'), 'dvh1');
  assert.equal(p5.args.filter((a) => a === '-tag:v').length, 1);
  const p81 = buildArgs(topts({ dolbyVision: remux(dovi.doviSignal(DV(8, 6, 1), { videoCodec: 'hevc' })) }) as any, '/t', 0, 'none').args;
  assert.equal(after_(p81, '-strict'), 'unofficial');
  assert.equal(after_(p81, '-tag:v'), 'hvc1');
  const p10 = buildArgs(topts({ sourceCodec: 'av1', dolbyVision: remux(dovi.doviSignal(DV(10, 6, 1), { videoCodec: 'av1' })) }) as any, '/t', 0, 'none').args;
  assert.equal(after_(p10, '-strict'), 'unofficial');
  assert.ok(!p10.includes('-tag:v'));
  // Profile 7 → HDR10 strip keeps the plain hvc1 path.
  const strip = buildArgs(topts({ videoBsf: 'filter_units=remove_types=62|63' }) as any, '/t', 0, 'none').args;
  assert.equal(after_(strip, '-bsf:v'), 'filter_units=remove_types=62|63');
  assert.equal(after_(strip, '-tag:v'), 'hvc1');
});

/* ------------------------------ MP4 boxes ------------------------------ */

test('box walker reads hvcC / dvvC / audio entries from a hand-built init segment', () => {
  const box = (type: string, ...body: Buffer[]) => {
    const b = Buffer.concat(body);
    const h = Buffer.alloc(8);
    h.writeUInt32BE(b.length + 8);
    h.write(type, 4, 'latin1');
    return Buffer.concat([h, b]);
  };
  const full = (type: string, ...body: Buffer[]) => box(type, Buffer.alloc(4), ...body);
  const visual = (type: string, w: number, h: number, ...kids: Buffer[]) => {
    const f = Buffer.alloc(78);
    f.writeUInt16BE(1, 6);
    f.writeUInt16BE(w, 24);
    f.writeUInt16BE(h, 26);
    return box(type, f, ...kids);
  };
  // hvcC: Main 10 (profile_idc 2), compat flags 0x20000000, constraint 0x90, level 153.
  const hvcC = Buffer.alloc(23);
  hvcC[0] = 1; hvcC[1] = 0x02; hvcC.writeUInt32BE(0x20000000, 2); hvcC[6] = 0x90; hvcC[12] = 153;
  const dvvC = Buffer.alloc(24);
  dvvC[0] = 1; dvvC.writeUInt16BE((8 << 9) | (6 << 3) | 0b101, 2); dvvC[4] = 1 << 4;
  const stsd = (entry: Buffer) => full('stsd', Buffer.from([0, 0, 0, 1]), entry);
  const trak = (handler: string, entry: Buffer) => box('trak', box('mdia', full('hdlr', Buffer.alloc(4), Buffer.from(handler)), box('minf', box('stbl', stsd(entry)))));
  const audio = box('ac-3', Buffer.alloc(28), box('dac3', Buffer.alloc(3)));
  const init = Buffer.concat([box('ftyp', Buffer.from('iso5')), box('moov', trak('vide', visual('dvh1', 3840, 2160, box('hvcC', hvcC), box('dvvC', dvvC))), trak('soun', audio))]);
  const info = dovi.parseInit(init);
  assert.deepEqual(info.video, { entry: 'dvh1', codec: 'hvc1.2.4.L153.90', dovi: { box: 'dvvC', profile: 8, level: 6, rpu: true, el: false, bl: true, blCompatId: 1 }, width: 3840, height: 2160 });
  assert.deepEqual(info.audio, { entry: 'ac-3', codec: 'ac-3' });
});

/* ------------------------------ real FFmpeg ------------------------------ */

const hasX265 = !!spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout?.toString().includes('libx265');
const skip = !hasX265 && 'ffmpeg with libx265 not available';

/** A 2 s 10-bit HEVC (+ AC-3 or AAC) MP4, moov after mdat, with a Dolby Vision configuration box injected. */
function dvFile(name: string, cfg: { profile: number; level: number; blCompatId: number }, audio: 'ac3' | 'aac' = 'ac3'): string {
  const base = path.join(tmp, `${name}.base.mp4`);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=2', '-f', 'lavfi', '-i', 'sine=d=2',
    '-pix_fmt', 'yuv420p10le', '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error:keyint=24',
    '-color_primaries', 'bt2020', '-color_trc', cfg.blCompatId === 4 ? 'arib-std-b67' : 'smpte2084', '-colorspace', 'bt2020nc', '-tag:v', 'hvc1',
    '-c:a', audio, '-b:a', '128k', base]);
  assert.equal(r.status, 0, r.stderr?.toString());
  const out = path.join(tmp, `${name}.mp4`);
  fs.writeFileSync(out, dovi.injectDoviConfig(fs.readFileSync(base), cfg));
  return out;
}

function runRemux(input: string, sig: any, dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const { args } = buildArgs(topts({ input, audioIndex: null, dolbyVision: sig ? remux(sig) : null }) as any, dir, 0, 'none');
  const r = spawnSync('ffmpeg', args);
  assert.equal(r.status, 0, r.stderr?.toString());
  return path.join(dir, 'init.mp4');
}

test('runtime check: this FFmpeg keeps DV configuration boxes when remuxing', { skip }, async () => {
  dovi.setDoviMuxCapability(null);
  assert.equal(await dovi.doviMuxSupported('ffmpeg'), true);
  assert.equal(dovi.doviMuxCapability(), true);
  dovi.setDoviMuxCapability(null);
  assert.equal(await dovi.doviMuxSupported('/nonexistent/ffmpeg'), false);
  dovi.setDoviMuxCapability(null);
});

test('real FFmpeg: DV 8.1 remux writes hvc1 + dvvC; profile 5 writes dvh1 + dvcC; plain remux writes neither', { skip }, async () => {
  updateSettings({ transcoding: { hwAccel: 'none', segmentSeconds: 1 } as any });
  const { probe } = await import('../src/services/probe.ts');
  const f81 = dvFile('p81', { profile: 8, level: 6, blCompatId: 1 });
  const p = await probe(f81, f81);
  assert.equal(p.videoRange?.label, 'Dolby Vision 8.1');
  assert.deepEqual(p.videoRange?.dolbyVision, DV(8, 6, 1) as any);

  const sig81 = dovi.doviSignal(p.videoRange!.dolbyVision!, { videoCodec: 'hevc', height: 180 })!;
  const init81 = dovi.parseInit(fs.readFileSync(runRemux(f81, sig81, path.join(tmp, 'o81'))));
  assert.equal(init81.video?.entry, 'hvc1');
  assert.deepEqual(init81.video?.dovi, { box: 'dvvC', profile: 8, level: 6, rpu: true, el: false, bl: true, blCompatId: 1 });
  assert.match(init81.video!.codec, /^hvc1\.2\.4\.L\d+/);
  assert.equal(init81.audio?.codec, 'ac-3');
  // FFmpeg's own reading of the output agrees.
  const pr = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-select_streams', 'v', path.join(tmp, 'o81', 'init.mp4')]).stdout.toString());
  assert.ok(pr.streams[0].side_data_list.some((s: any) => /DOVI/.test(s.side_data_type) && s.dv_profile === 8));

  const f5 = dvFile('p5', { profile: 5, level: 6, blCompatId: 0 }, 'aac');
  const init5 = dovi.parseInit(fs.readFileSync(runRemux(f5, dovi.doviSignal(DV(5, 6, 0), { videoCodec: 'hevc' }), path.join(tmp, 'o5'))));
  assert.equal(init5.video?.entry, 'dvh1');
  assert.equal(init5.video?.dovi?.box, 'dvcC');
  assert.equal(init5.video?.dovi?.profile, 5);
  assert.equal(init5.audio?.codec, 'mp4a.40.2');

  const m5 = await dovi.doviMasterForJob(remux(dovi.doviSignal(DV(5, 6, 0), { videoCodec: 'hevc' })), async () => path.join(tmp, 'o5', 'init.mp4'), 's.m3u8');
  assert.match(m5, /CODECS="dvh1\.05\.06,mp4a\.40\.2",RESOLUTION/);

  const initPlain = dovi.parseInit(fs.readFileSync(runRemux(f81, null, path.join(tmp, 'oplain'))));
  assert.equal(initPlain.video?.entry, 'hvc1');
  assert.equal(initPlain.video?.dovi, null, 'base-layer remux for non-DV clients carries no DV box');

  // Master playlist from the init segment FFmpeg wrote.
  const m81 = await dovi.doviMasterForJob(remux(sig81), async () => path.join(tmp, 'o81', 'init.mp4'), 'stream.m3u8?token=t');
  assert.match(m81, new RegExp(`CODECS="${init81.video!.codec.replace(/\./g, '\\.')},ac-3",SUPPLEMENTAL-CODECS="dvh1\\.08\\.06/db1p"`));
  assert.match(m81, /VIDEO-RANGE=PQ/);
  const exo = await dovi.doviMasterForJob({ ...remux(sig81), style: 'codecs' }, async () => path.join(tmp, 'o81', 'init.mp4'), 's.m3u8');
  assert.match(exo, /CODECS="dvh1\.08\.06,ac-3",/);
  // An init segment without the DV box: the DV codec is not announced.
  const noDv = await dovi.doviMasterForJob(remux(sig81), async () => path.join(tmp, 'oplain', 'init.mp4'), 's.m3u8');
  assert.doesNotMatch(noDv, /dvh1|SUPPLEMENTAL/);
});

/* ------------------------------ HTTP end to end ------------------------------ */

test('HTTP: LG gets a DV master playlist and a dvvC init segment; Samsung gets the plain stream', { skip }, async () => {
  const { createUser, issueToken } = await import('../src/services/auth.ts');
  const { buildApp } = await import('../src/app.ts');
  const { db } = await import('../src/db.ts');
  const { probe } = await import('../src/services/probe.ts');
  const { stopSession } = await import('../src/services/playback.ts');
  dovi.setDoviMuxCapability(null);
  updateSettings({ transcoding: { hwAccel: 'none', segmentSeconds: 1, enabled: true } as any });
  const file = dvFile('http81', { profile: 8, level: 6, blCompatId: 1 });
  const p = await probe(file, file);
  const now = new Date().toISOString();
  db.run('INSERT OR IGNORE INTO libraries (id, name, type, paths, created_at) VALUES (?, ?, ?, ?, ?)', 'lib-dv', 'DV', 'movies', JSON.stringify([tmp]), now);
  db.run('INSERT INTO items (id, library_id, type, title, sort_title, added_at, updated_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'item-dv', 'lib-dv', 'movie', 'DV test', 'dv test', now, now, p.durationMs);
  db.run('INSERT INTO media (id, item_id, path, container, duration_ms, size, bitrate, width, height, video_codec, audio, subs, mtime, hdr, video_range) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    'media-dv', 'item-dv', file, p.container, p.durationMs, p.size, p.bitrate, p.width, p.height, p.videoCodec, JSON.stringify(p.audio), JSON.stringify(p.subs), fs.statSync(file).mtimeMs | 0, 1, JSON.stringify(p.videoRange));
  const admin = createUser({ username: 'dvadmin', password: 'pw-123456', isAdmin: true });
  const tok = issueToken(admin.id, { deviceId: 'dv-a', deviceName: 'test', platform: 'web' }).token;
  const app = await buildApp();
  const auth = { authorization: `Bearer ${tok}` };
  const play = async (profile: any) => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/playback/item-dv', headers: auth, payload: { deviceProfile: profile } });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  const hls = (sid: string, f: string) => app.inject({ method: 'GET', url: `/api/v1/stream/hls/${sid}/${f}`, headers: auth });

  const lg = await play(LG);
  assert.equal(lg.method, 'remux');
  assert.equal(lg.videoRange.delivery, 'passthrough');
  assert.equal(lg.videoRange.output, 'dolbyvision');
  assert.deepEqual(lg.dolbyVision, { profile: '8.1', level: 6, mode: 'native', baseLayer: 'hdr10', codec: 'dvh1.08.06' });
  const master = (await hls(lg.sessionId, 'master.m3u8')).body;
  assert.match(master, /#EXT-X-STREAM-INF:.*CODECS="hvc1\.2\.4\.L\d+[^"]*,ac-3",SUPPLEMENTAL-CODECS="dvh1\.08\.06\/db1p",RESOLUTION=320x180,FRAME-RATE=24\.000,VIDEO-RANGE=PQ/);
  const variant = master.trim().split('\n').at(-1)!;
  assert.match(variant, /^stream\.m3u8\?token=/);
  const media = (await hls(lg.sessionId, variant.split('?')[0])).body;
  assert.match(media, /#EXT-X-MAP:URI="init\.mp4\?token=/);
  const init = await hls(lg.sessionId, 'init.mp4');
  assert.equal(init.statusCode, 200);
  assert.equal(dovi.parseInit(init.rawPayload).video?.dovi?.profile, 8);
  stopSession(lg.sessionId);

  const sam = await play(SAMSUNG);
  assert.equal(sam.method, 'remux');
  assert.equal(sam.dolbyVision.mode, 'base-layer');
  const samMaster = (await hls(sam.sessionId, 'master.m3u8')).body;
  assert.doesNotMatch(samMaster, /STREAM-INF|dvh1/, 'non-DV clients keep the plain media playlist');
  const samInit = await hls(sam.sessionId, 'init.mp4');
  assert.equal(dovi.parseInit(samInit.rawPayload).video?.dovi, null);
  stopSession(sam.sessionId);

  const android = await play({ ...ANDROID, containers: ['mkv'] });
  assert.equal(android.method, 'remux');
  assert.match((await hls(android.sessionId, 'master.m3u8')).body, /CODECS="dvh1\.08\.06,ac-3",RESOLUTION/);
  stopSession(android.sessionId);
  await app.close();
});
