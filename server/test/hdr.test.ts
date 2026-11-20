import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const { parseVideoRange, rangeDecision, STRIP_DOVI_BSF } = await import('../src/services/hdr.ts');
const { decide } = await import('../src/services/playback.ts');

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (f: string) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures/hdr', f), 'utf8'));
const dovi = fx('dovi.json');

/* ------------------------------ detection ------------------------------ */

test('HDR10 from a real libx265 file (stream + first-frame side data)', () => {
  const r = parseVideoRange(fx('hdr10.stream.json').streams[0], fx('hdr10.frame.json').frames[0].side_data_list)!;
  assert.equal(r.hdrFormat, 'hdr10');
  assert.equal(r.label, 'HDR10');
  assert.equal(r.bitDepth, 10);
  assert.equal(r.frameRate, 24);
  assert.deepEqual(r.contentLight, { maxCll: 1000, maxFall: 400 });
  assert.equal(r.masteringDisplay?.maxLuminance, 1000);
  assert.equal(r.masteringDisplay?.minLuminance, 0.0001);
  assert.equal(r.dolbyVision, null);
});

test('HLG from a real libx265 file', () => {
  const r = parseVideoRange(fx('hlg.stream.json').streams[0])!;
  assert.equal(r.hdrFormat, 'hlg');
  assert.equal(r.fallback, null);
});

test('HDR10+ comes from the first frame', () => {
  assert.equal(parseVideoRange(dovi.hdr10plus_stream)!.hdrFormat, 'hdr10');
  const r = parseVideoRange(dovi.hdr10plus_stream, dovi.hdr10plus_first_frame)!;
  assert.equal(r.hdrFormat, 'hdr10plus');
  assert.equal(r.fallback, 'hdr10');
  assert.equal(r.label, 'HDR10+');
  assert.equal(r.contentLight?.maxCll, 4000);
});

test('Dolby Vision profiles, levels and base-layer fallback', () => {
  const p81 = parseVideoRange(dovi.dv_p81_mkv)!;
  assert.equal(p81.hdrFormat, 'dolbyvision');
  assert.deepEqual(p81.dolbyVision, { profile: 8, level: 6, blCompatId: 1, rpu: true, el: false, bl: true });
  assert.equal(p81.fallback, 'hdr10');
  assert.equal(p81.label, 'Dolby Vision 8.1');
  assert.equal(p81.frameRate, 23.976);

  const p84 = parseVideoRange(dovi.dv_p84_mp4)!;
  assert.equal(p84.label, 'Dolby Vision 8.4');
  assert.equal(p84.fallback, 'hlg');

  const p5 = parseVideoRange(dovi.dv_p5_mp4)!;
  assert.equal(p5.label, 'Dolby Vision 5');
  assert.equal(p5.fallback, 'none');

  const p7 = parseVideoRange(dovi.dv_p7_mkv)!;
  assert.equal(p7.dolbyVision?.el, true);
  assert.equal(p7.fallback, 'hdr10');
  assert.deepEqual(p7.contentLight, { maxCll: 1104, maxFall: 336 });
});

test('SDR stays SDR', () => {
  const r = parseVideoRange(dovi.sdr_h264)!;
  assert.equal(r.hdrFormat, 'sdr');
  assert.equal(r.bitDepth, 8);
  assert.equal(parseVideoRange({ codec_type: 'audio' }), null);
});

/* ------------------------------ decisions ------------------------------ */

const range = (k: string, frame?: any[]) => parseVideoRange(dovi[k], frame)!;
const SAMSUNG = { hdr10: true, hdr10Plus: true, hlg: true, dolbyVision: false };
const LG = { hdr10: true, hlg: true, dolbyVision: true, dolbyVisionProfiles: ['5', '8.1', '8.4'] };
const SDR = { hdr10: false, hlg: false, dolbyVision: false };

test('legacy clients (no videoRange) keep the old behaviour', () => {
  const d = rangeDecision(range('dv_p5_mp4'), true, undefined);
  assert.ok(d.ok && d.legacy);
});

test('DV 8.1 → base layer on Samsung, passthrough on LG, tone-map on SDR', () => {
  assert.equal(rangeDecision(range('dv_p81_mkv'), true, SAMSUNG).delivery, 'base-layer');
  assert.equal(rangeDecision(range('dv_p81_mkv'), true, LG).delivery, 'passthrough');
  const sdr = rangeDecision(range('dv_p81_mkv'), true, SDR);
  assert.equal(sdr.ok, false);
  assert.equal(sdr.toneMap, true);
});

test('DV 5 needs DV; otherwise tone-map', () => {
  assert.equal(rangeDecision(range('dv_p5_mp4'), true, LG).delivery, 'passthrough');
  const s = rangeDecision(range('dv_p5_mp4'), true, SAMSUNG);
  assert.equal(s.ok, false);
  assert.match(s.reasons[0], /no HDR10 fallback/);
});

test('DV 7 → strip RPU/EL for HDR10 clients, passthrough only when profile 7 is listed', () => {
  const s = rangeDecision(range('dv_p7_mkv'), true, SAMSUNG);
  assert.equal(s.delivery, 'strip-dovi');
  assert.equal(s.videoBsf, STRIP_DOVI_BSF);
  assert.ok(s.needsRemux);
  assert.equal(rangeDecision(range('dv_p7_mkv'), true, LG).delivery, 'strip-dovi');
  assert.equal(rangeDecision(range('dv_p7_mkv'), true, { ...LG, dolbyVisionProfiles: ['7', '8.1'] }).delivery, 'passthrough');
});

test('HDR10+ → base layer for HDR10-only clients; HLG needs HLG', () => {
  const r = range('hdr10plus_stream', dovi.hdr10plus_first_frame);
  assert.equal(rangeDecision(r, true, SAMSUNG).delivery, 'passthrough');
  assert.equal(rangeDecision(r, true, LG).delivery, 'base-layer');
  assert.equal(rangeDecision(range('dv_p84_mp4'), true, { hdr10: true, hlg: false }).ok, false);
  assert.equal(rangeDecision(range('dv_p84_mp4'), true, { hdr10: true, hlg: true }).delivery, 'base-layer');
});

test('media scanned before HDR detection (hdr flag only) is treated as HDR10', () => {
  assert.equal(rangeDecision(null, true, SDR).toneMap, true);
  assert.equal(rangeDecision(null, true, SAMSUNG).delivery, 'passthrough');
});

/* ------------------------------ decide() integration ------------------------------ */

const media = (o: any = {}) => ({ id: 'm', container: 'mkv', durationMs: 1000, size: 1, bitrate: 20000, width: 3840, height: 2160, videoCodec: 'hevc', resolutionLabel: '4K', hdr: true, audioStreams: [], subtitleStreams: [], remote: false, edition: null, ...o });
const eac3 = { index: 1, codec: 'eac3', language: 'eng', title: null, channels: 6, default: true };
const base = { audio: eac3, burnSubs: false, forceTranscode: false, allowTranscode: true, userMaxBitrate: null, isAudioOnly: false };
const tizen = { videoCodecs: ['h264', 'hevc', 'av1'], audioCodecs: ['aac', 'ac3', 'eac3'], containers: ['mkv', 'mp4', 'ts'], tenBitCodecs: ['hevc', 'av1'], videoRange: SAMSUNG, canSelectAudioTrack: true };

test('Samsung AVPlay direct-plays MKV/HEVC/DV 8.1/E-AC3 and switches audio itself', () => {
  const d = decide(media({ videoRange: range('dv_p81_mkv') }), tizen, base);
  assert.equal(d.method, 'direct');
  assert.equal(d.range?.delivery, 'base-layer');
  assert.equal(decide(media({ videoRange: range('dv_p81_mkv') }), tizen, { ...base, audio: { ...eac3, default: false } }).method, 'direct');
});

test('DV 7 to Samsung remuxes with the strip filter; DV 5 transcodes with tone-mapping', () => {
  const d7 = decide(media({ videoRange: range('dv_p7_mkv') }), tizen, base);
  assert.equal(d7.method, 'remux');
  assert.equal(d7.videoBsf, STRIP_DOVI_BSF);
  const d5 = decide(media({ videoRange: range('dv_p5_mp4'), container: 'mp4' }), tizen, base);
  assert.equal(d5.method, 'transcode');
  assert.equal(d5.toneMap, true);
  assert.equal(d5.range?.delivery, 'tonemap');
});

test('SDR browser gets HDR10 tone-mapped; audio passthrough and 10-bit checks', () => {
  const sdrWeb = { videoCodecs: ['h264', 'hevc'], containers: ['mkv'], audioCodecs: ['aac'], videoRange: SDR };
  const d = decide(media({ videoRange: parseVideoRange(fx('hdr10.stream.json').streams[0]) }), sdrWeb, base);
  assert.equal(d.method, 'transcode');
  assert.equal(d.toneMap, true);
  assert.ok(d.reasons.some((r) => /tone-mapping/.test(r)));
  // E-AC3 bitstreamed to a receiver counts as supported audio.
  assert.equal(decide(media({ hdr: false }), { ...sdrWeb, audioPassthrough: ['eac3'] }, base).method, 'direct');
  // 10-bit HEVC on a client that only decodes 8-bit HEVC.
  const tb = decide(media({ hdr: false, videoRange: { ...range('sdr_h264'), bitDepth: 10 } }), { ...sdrWeb, audioPassthrough: ['eac3'], tenBitCodecs: [] }, base);
  assert.equal(tb.method, 'transcode');
  // Legacy profile: unchanged decisions, no tone-map override.
  const legacy = decide(media({ videoRange: range('dv_p5_mp4') }), { videoCodecs: ['hevc'], containers: ['mkv'], audioCodecs: ['eac3'] }, base);
  assert.equal(legacy.method, 'direct');
  assert.equal(legacy.toneMap, undefined);
});

/* ------------------------------ real files (needs ffmpeg + libx265) ------------------------------ */

const hasX265 = spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout?.toString().includes('libx265');
test('probe() detects HDR10 with mastering metadata in a freshly encoded file', { skip: !hasX265 && 'ffmpeg with libx265 not available' }, async () => {
  const { probe } = await import('../src/services/probe.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-hdr-'));
  const out = path.join(dir, 'hdr10.mkv');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=192x108:r=24:d=0.5', '-pix_fmt', 'yuv420p10le', '-c:v', 'libx265',
    '-x265-params', 'log-level=error:hdr10=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400',
    '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', out]);
  assert.equal(r.status, 0, r.stderr?.toString());
  const p = await probe(out, out);
  assert.equal(p.hdr, true);
  assert.equal(p.videoRange?.hdrFormat, 'hdr10');
  assert.equal(p.videoRange?.contentLight?.maxCll, 1000);
  fs.rmSync(dir, { recursive: true, force: true });
});
