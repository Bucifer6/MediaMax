import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AudioStream, DeviceProfile } from '@mediamax/shared';
const audio = await import('../src/services/audio.ts');
const { decide } = await import('../src/services/playback.ts');
const { buildArgs } = await import('../src/services/transcoder.ts');
const abr = await import('../src/services/abr.ts');

const { parseAudioStream, planAudio, audioArgs, downmixFilter, normalizeComforts, comfortsFor, masterAudioFor, decisionInfo } = audio;

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (f: string) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures/audio', f), 'utf8'));
const real = fx('real-5.1.json');
const bd = fx('blu-ray.json');
const s = (j: any): AudioStream => parseAudioStream(j);

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/* ------------------------------- profiles ------------------------------- */

/** Chrome on a laptop: decodes AAC/Opus/FLAC, 2 speakers. */
const BROWSER: DeviceProfile = { audioCodecs: ['aac', 'mp3', 'opus', 'flac'], maxAudioChannels: 2, multichannelAudioCodecs: ['aac', 'opus', 'flac'] };
/** Samsung TV + soundbar over ARC: TV decodes AC-3/E-AC-3 via MSE and passes them on. */
const TV_ARC: DeviceProfile = { audioCodecs: ['aac', 'mp3', 'ac3', 'eac3'], maxAudioChannels: 6, multichannelAudioCodecs: ['aac', 'ac3', 'eac3'] };
/** Apple TV 4K: decodes AC-3/E-AC-3 incl. Atmos (JOC), no TrueHD/DTS, 7.1 PCM out. */
const APPLE_TV: DeviceProfile = { audioCodecs: ['aac', 'mp3', 'alac', 'flac', 'ac3', 'eac3', 'eac3-joc'], maxAudioChannels: 8, audioPassthrough: [] };
/** Shield with an AV receiver over HDMI (full passthrough). */
const SHIELD_AVR: DeviceProfile = { audioCodecs: ['aac', 'ac3', 'eac3', 'opus', 'flac'], audioPassthrough: ['ac3', 'eac3', 'eac3-joc', 'truehd', 'dts', 'dts-hd'], maxAudioChannels: 8 };
/** Android TV with a DTS-only (no DTS-HD) soundbar. */
const DTS_ONLY: DeviceProfile = { audioCodecs: ['aac', 'ac3', 'eac3'], audioPassthrough: ['ac3', 'dts'], maxAudioChannels: 6 };
/** Old client: no maxAudioChannels. */
const LEGACY: DeviceProfile = { audioCodecs: ['aac', 'mp3', 'opus', 'flac', 'eac3'] };

/* ------------------------------ detection ------------------------------ */

test('detects codecs, layouts and DTS core from real ffmpeg-made 5.1 files', () => {
  const ac3 = s(real.ac3);
  assert.equal(ac3.formatLabel, 'AC-3');
  assert.equal(ac3.channelLayout, '5.1(side)');
  assert.equal(ac3.bitrate, 448);
  assert.equal(audio.audioStreamLabel(ac3), 'AC-3 5.1');
  const eac3 = s(real.eac3);
  assert.equal(eac3.formatLabel, 'E-AC-3');
  assert.equal(eac3.atmos, false);
  const dts = s(real.dts);
  assert.equal(dts.formatLabel, 'DTS');
  assert.equal(dts.dtsHdMa, false);
  assert.equal(audio.isDtsHd(dts), false);
  const thd = s(real.truehd);
  assert.equal(thd.formatLabel, 'TrueHD');
  assert.equal(thd.lossless, true);
  assert.equal(thd.atmos, false);
});

test('detects Dolby Atmos, DTS:X and DTS-HD MA from ffprobe profiles (and old-ffmpeg titles)', () => {
  const thd = s(bd.truehd_atmos);
  assert.equal(thd.atmos, true);
  assert.equal(thd.formatLabel, 'TrueHD Atmos');
  assert.equal(audio.audioStreamLabel(thd), 'TrueHD Atmos 7.1');
  assert.equal(thd.bitDepth, 24);
  assert.equal(thd.bitrate, 4651);
  assert.equal(thd.language, 'eng');
  const joc = s(bd.eac3_joc);
  assert.equal(joc.atmos, true);
  assert.equal(joc.formatLabel, 'E-AC-3 Atmos');
  assert.equal(joc.lossless, false);
  const ma = s(bd.dtshd_ma);
  assert.deepEqual([ma.dtsHdMa, ma.dtsX, ma.lossless, ma.formatLabel], [true, false, true, 'DTS-HD MA']);
  const x = s(bd.dtsx);
  assert.deepEqual([x.dtsHdMa, x.dtsX, x.formatLabel], [true, true, 'DTS:X']);
  assert.equal(s(bd.dtsx_old_ffmpeg).dtsX, true, 'title hint on ffmpeg < 6.1');
  assert.equal(s(bd.aac_stereo).formatLabel, 'AAC');
  assert.equal(audio.channelLabel(8, '7.1'), '7.1');
  assert.equal(audio.channelLabel(6, null), '5.1');
  assert.equal(audio.channelLabel(2, 'stereo'), 'Stereo');
});

/* ------------------------------ decisions ------------------------------ */

test('TrueHD Atmos → E-AC-3 5.1 for a TV passing E-AC-3 to a soundbar', () => {
  const p = planAudio(s(bd.truehd_atmos), TV_ARC);
  assert.equal(p.delivery, 'transcode');
  assert.equal(p.codec, 'eac3');
  assert.equal(p.channels, 6);
  assert.equal(p.bitrateKbps, 640);
  assert.equal(p.objects, 'lost');
  assert.equal(p.reason, "TrueHD Atmos → E-AC-3 5.1: device can't play TrueHD");
  assert.equal(p.codecString, 'ec-3');
  assert.deepEqual(audioArgs(p), ['-c:a', 'eac3', '-ac', '6', '-b:a', '640k', '-ar', '48000']);
});

test('copy when the client passes it through: TrueHD Atmos / DTS:X to an AV receiver keep their objects', () => {
  const thd = planAudio(s(bd.truehd_atmos), SHIELD_AVR);
  assert.equal(thd.delivery, 'copy');
  assert.equal(thd.objects, 'kept');
  assert.deepEqual(audioArgs(thd), ['-c:a', 'copy', '-strict', '-2']);
  const x = planAudio(s(bd.dtsx), SHIELD_AVR);
  assert.equal(x.delivery, 'copy');
  assert.equal(x.objects, 'kept');
  assert.equal(x.copyOk, true);
});

test('DTS-HD MA / DTS:X → DTS core copy (dca_core) for a DTS-only device', () => {
  const p = planAudio(s(bd.dtshd_ma), DTS_ONLY);
  assert.equal(p.delivery, 'dts-core');
  assert.equal(p.codec, 'copy');
  assert.equal(p.bsf, 'dca_core');
  assert.equal(p.channels, 6);
  assert.equal(p.reason, 'DTS-HD MA → DTS core: device plays DTS but not DTS-HD');
  assert.deepEqual(audioArgs(p), ['-c:a', 'copy', '-bsf:a', 'dca_core']);
  assert.equal(planAudio(s(bd.dtsx), DTS_ONLY).objects, 'lost');
  // Plain DTS (core) is copied as is.
  assert.equal(planAudio(s(real.dts), DTS_ONLY).delivery, 'copy');
});

test('7.1 → AAC 7.1 / 5.1 / stereo by maxAudioChannels', () => {
  const flac71 = s(bd.flac_71);
  const aacOnly = (ch: number): DeviceProfile => ({ audioCodecs: ['aac'], maxAudioChannels: ch });
  const p8 = planAudio(flac71, aacOnly(8));
  assert.deepEqual([p8.codec, p8.channels, p8.bitrateKbps, p8.output], ['aac', 8, 512, 'AAC 7.1']);
  assert.deepEqual(p8.filters, []);
  const p6 = planAudio(flac71, aacOnly(6));
  assert.deepEqual([p6.codec, p6.channels, p6.bitrateKbps], ['aac', 6, 384]);
  const p2 = planAudio(flac71, aacOnly(2));
  assert.deepEqual([p2.codec, p2.channels, p2.bitrateKbps], ['aac', 2, 192]);
  assert.match(p2.filters[0], /^aformat=channel_layouts=7\.1,pan=stereo\|FL=1\*FL\+0\.707\*FC/);
  assert.equal(p2.filters.at(-1), audio.LIMITER);
  // Decodes AAC, but only in stereo.
  const p = planAudio(flac71, { audioCodecs: ['aac'], maxAudioChannels: 8, multichannelAudioCodecs: [] });
  assert.equal(p.channels, 2);
});

test('browser profile: TrueHD / DTS → AAC stereo with a proper downmix; AAC stereo copies', () => {
  const p = planAudio(s(bd.truehd_atmos), BROWSER);
  assert.deepEqual([p.codec, p.channels], ['aac', 2]);
  assert.match(p.reason!, /device can't play TrueHD/);
  assert.equal(planAudio(s(bd.aac_stereo), BROWSER).delivery, 'copy');
  assert.equal(planAudio(s(real.eac3), BROWSER).codec, 'aac');
});

test('Apple TV: E-AC-3 Atmos copied with objects kept; TrueHD and DTS → E-AC-3 5.1', () => {
  const joc = planAudio(s(bd.eac3_joc), APPLE_TV);
  assert.deepEqual([joc.delivery, joc.objects, joc.codecString], ['copy', 'kept', 'ec-3']);
  assert.equal(planAudio(s(bd.truehd_atmos), APPLE_TV).codec, 'eac3');
  assert.equal(planAudio(s(bd.dtshd_ma), APPLE_TV).codec, 'eac3');
  assert.equal(planAudio(s(real.dts), APPLE_TV).codec, 'eac3');
  // E-AC-3 Atmos to a client without JOC still copies (the 5.1 bed plays) but the objects are lost.
  assert.equal(planAudio(s(bd.eac3_joc), TV_ARC).objects, 'lost');
});

test('AC-3-only passthrough gets AC-3 5.1; the encoder check falls back to AAC', () => {
  const p = planAudio(s(bd.truehd_atmos), { audioCodecs: ['aac'], audioPassthrough: ['ac3'], maxAudioChannels: 2 });
  assert.deepEqual([p.codec, p.channels, p.bitrateKbps], ['ac3', 6, 640]);
  const noEac3 = planAudio(s(bd.truehd_atmos), TV_ARC, { hasEncoder: (e) => e !== 'eac3' });
  assert.notEqual(noEac3.codec, 'eac3');
});

test('legacy profiles keep the old behaviour (codec name match, AAC 5.1 / stereo)', () => {
  const legacy = planAudio(s(bd.truehd_atmos), LEGACY);
  assert.deepEqual([legacy.codec, legacy.channels, legacy.bitrateKbps, legacy.filters], ['aac', 6, 384, []]);
  assert.deepEqual(audioArgs(legacy), ['-c:a', 'aac', '-ac', '6', '-b:a', '384k']);
  // Old Android passthrough list with "dts": DTS-HD MA (codec "dts") is copied whole, as before (no dca_core).
  const oldAndroid = planAudio(s(bd.dtshd_ma), { audioCodecs: ['aac'], audioPassthrough: ['dts'] });
  assert.equal(oldAndroid.delivery, 'copy');
  // Legacy E-AC-3 decoder still gets AAC for TrueHD (no E-AC-3 target without maxAudioChannels).
  assert.equal(planAudio(s(real.truehd), LEGACY).codec, 'aac');
  assert.equal(planAudio(s(bd.aac_stereo), LEGACY).delivery, 'copy');
});

test('decide(): DTS-HD MA remuxes with the DTS core, legacy reasons unchanged, smart reasons explain', () => {
  const media = { id: 'm', container: 'mkv', durationMs: 1000, size: 1, bitrate: 20000, width: 1920, height: 1080, videoCodec: 'h264', resolutionLabel: '1080p', hdr: false, audioStreams: [], subtitleStreams: [], remote: false } as any;
  const base = { burnSubs: false, forceTranscode: false, allowTranscode: true, userMaxBitrate: null, isAudioOnly: false };
  const ma = s(bd.dtshd_ma);
  const d = decide(media, { ...DTS_ONLY, containers: ['mkv'] }, { ...base, audio: ma });
  assert.equal(d.method, 'remux');
  assert.equal(d.audioCopy, false);
  assert.equal(d.audio?.delivery, 'dts-core');
  assert.deepEqual(d.reasons, ['DTS-HD MA → DTS core: device plays DTS but not DTS-HD']);
  // Same file to an AV receiver with DTS-HD: direct play.
  assert.equal(decide(media, { ...SHIELD_AVR, containers: ['mkv'] }, { ...base, audio: ma }).method, 'direct');
  // Legacy: old message.
  const legacy = decide(media, { containers: ['mkv'], audioCodecs: ['aac'] }, { ...base, audio: s(bd.truehd_atmos) });
  assert.deepEqual(legacy.reasons, ['audio codec truehd not supported']);
  assert.equal(legacy.audio?.codec, 'aac');
  // Forced transcode re-encodes copyable audio with the same target choice.
  const forced = decide(media, { ...TV_ARC, containers: ['mkv'] }, { ...base, audio: s(real.eac3), forceTranscode: true });
  assert.equal(forced.method, 'transcode');
  assert.equal(forced.audioCopy, false);
  assert.equal(forced.audio?.codec, 'eac3');
  // Audio-only items (music) don't use the audio plan.
  assert.equal(decide({ ...media, videoCodec: null }, undefined, { ...base, audio: s(real.ac3), isAudioOnly: true }).audio, null);
});

test('decide(): forceAudioProcessing remuxes so comforts apply; without force they ride along only when encoding', () => {
  const media = { id: 'm', container: 'mp4', durationMs: 1000, size: 1, bitrate: 5000, width: 1920, height: 1080, videoCodec: 'h264', resolutionLabel: '1080p', hdr: false, audioStreams: [], subtitleStreams: [], remote: false } as any;
  const base = { burnSubs: false, forceTranscode: false, allowTranscode: true, userMaxBitrate: null, isAudioOnly: false };
  const a = { ...s(bd.aac_stereo), default: true };
  assert.equal(decide(media, BROWSER, { ...base, audio: a, audioProcessing: { nightMode: true } }).method, 'direct');
  const d = decide(media, BROWSER, { ...base, audio: a, audioProcessing: { nightMode: true, delayMs: -200 }, forceAudioProcessing: true });
  assert.equal(d.method, 'remux');
  assert.equal(d.videoCopy, true);
  assert.equal(d.audioCopy, false);
  assert.deepEqual(d.audio?.applied, ['nightMode', 'delayMs']);
  assert.match(d.reasons[0], /audio processing requested/);
  assert.equal(decisionInfo(d.audio!, 'remux')?.delivery, 'transcode');
});

/* ------------------------------ comforts ------------------------------ */

test('night mode / dialogue boost / normalise / delay filters only when enabled', () => {
  const st = s(bd.aac_stereo);
  const plain = planAudio(st, BROWSER, { noCopy: true });
  assert.deepEqual(plain.filters, []);
  assert.ok(!audioArgs(plain).includes('-af'));
  const all = planAudio(st, BROWSER, { noCopy: true, comforts: { nightMode: true, dialogueBoost: true, normalize: true, delayMs: 120 } });
  const af = all.filters.join(',');
  assert.match(af, /equalizer=f=2000/, 'speech EQ on stereo');
  assert.match(af, /acompressor=threshold=-24dB:ratio=4/);
  assert.match(af, /loudnorm=I=-16/);
  assert.match(af, /alimiter/);
  assert.match(af, /adelay=delays=120:all=1$/);
  assert.deepEqual(all.applied, ['dialogueBoost', 'nightMode', 'normalize', 'delayMs']);
  // Negative delay: trim the start of the audio.
  assert.equal(audio.delayFilter(-250), 'atrim=start=0.250,asetpts=PTS-STARTPTS');
  // Dialogue boost on a 5.1 output lifts the centre channel; on a downmix it changes the matrix.
  const thd = s(real.truehd);
  assert.match(planAudio(thd, { audioCodecs: ['aac'], maxAudioChannels: 6 }, { noCopy: true, comforts: { dialogueBoost: true } }).filters[0], /FC=1\.413\*FC/);
  assert.equal(downmixFilter(6, true), 'aformat=channel_layouts=5.1,pan=stereo|FL=0.707*FL+1*FC+0.4*BL|FR=0.707*FR+1*FC+0.4*BR');
  assert.equal(downmixFilter(6), 'aformat=channel_layouts=5.1,pan=stereo|FL=1*FL+0.707*FC+0.5*BL|FR=1*FR+0.707*FC+0.5*BR');
  // Copies never carry filters; DTS core is skipped when comforts need decoded audio.
  assert.equal(planAudio(s(bd.dtshd_ma), DTS_ONLY, { comforts: { nightMode: true } }).delivery, 'transcode');
});

test('comfort normalisation and per-device overrides', () => {
  assert.deepEqual(normalizeComforts({ nightMode: true, delayMs: 123456, junk: 1, dialogueBoost: 'yes' }), { nightMode: true, delayMs: 5000 });
  assert.deepEqual(normalizeComforts({ delayMs: -87 }), { delayMs: -90 });
  assert.deepEqual(comfortsFor({ audio: { nightMode: true, delayMs: 0 }, audioDevices: { tv: { delayMs: 150 } } }, 'tv'), { nightMode: true, delayMs: 150 });
  assert.deepEqual(comfortsFor({ audio: { nightMode: true } }, 'phone'), { nightMode: true });
});

/* ------------------------------ ffmpeg args ------------------------------ */

const topts = (o: any = {}) => ({
  input: '/x.mkv', startSec: 0, durationSec: 60, mode: 'remux', audioIndex: 1, audioCopy: false, videoCopy: true, bitrate: 8000,
  maxHeight: null, sourceHeight: 1080, sourceCodec: 'h264', hdr: false, hasVideo: true, ...o,
});

test('buildArgs: audio-only re-encode on the remux path, E-AC-3 in fMP4, CODECS string', () => {
  const plan = planAudio(s(bd.truehd_atmos), TV_ARC);
  const { args, info, segmentType } = buildArgs(topts({ audioPlan: plan }) as any, '/tmp/out', 0, 'none');
  const i = args.indexOf('-c:a');
  assert.deepEqual(args.slice(i, i + 8), ['-c:a', 'eac3', '-ac', '6', '-b:a', '640k', '-ar', '48000']);
  assert.ok(args.includes('-c:v') && args[args.indexOf('-c:v') + 1] === 'copy', 'video copied');
  assert.equal(segmentType, 'fmp4');
  assert.equal(info.audioCodec, 'eac3');
  assert.equal(info.audioCodecString, 'ec-3');
  assert.match(info.audioDetail!, /^E-AC-3 5\.1 \(TrueHD Atmos → E-AC-3 5\.1/);
  // DTS core copy.
  const core = buildArgs(topts({ audioPlan: planAudio(s(bd.dtshd_ma), DTS_ONLY) }) as any, '/tmp/out', 0, 'none').args;
  assert.ok(core.join(' ').includes('-c:a copy -bsf:a dca_core'));
  // AAC stereo copy stays MPEG-TS (unchanged for H.264 + AAC).
  const aacPlan = planAudio(s(bd.aac_stereo), BROWSER);
  assert.equal(buildArgs(topts({ audioCopy: true, audioPlan: aacPlan }) as any, '/tmp/out', 0, 'none').segmentType, 'mpegts');
  // No plan (live TV, old callers): previous AAC args.
  const old = buildArgs(topts({ audioChannels: 6 }) as any, '/tmp/out', 0, 'none').args;
  assert.ok(old.join(' ').includes('-c:a aac -ac 6 -b:a 384k'));
});

test('master playlist CODECS for E-AC-3 and the Atmos EXT-X-MEDIA tag', () => {
  assert.equal(abr.codecsAttr('h264', 1080, 'ec-3'), 'avc1.640028,ec-3');
  assert.equal(abr.codecsAttr('hevc', 2160, 'eac3'), 'hvc1.1.6.L153.90,ec-3');
  assert.equal(abr.codecsAttr('h264', 1080, 'ac-3'), 'avc1.640028,ac-3');
  assert.equal(abr.codecsAttr('h264', 1080, 'aac'), 'avc1.640028,mp4a.40.2');
  assert.equal(abr.codecsAttr('h264', 1080, 'unknown'), null);
  const ladder = abr.buildLadder({ sourceWidth: 1920, sourceHeight: 1080, sourceKbps: 20000, capKbps: Infinity, maxHeight: null, audioKbps: 768 });
  const joc = s(bd.eac3_joc);
  const plan = planAudio(joc, APPLE_TV);
  const ma = masterAudioFor(plan, joc)!;
  assert.equal(ma.channels, '16/JOC');
  const m = abr.masterPlaylist(ladder, 0, '?t', (r) => abr.codecsAttr('h264', r.height, plan.codecString), ma);
  assert.match(m, /#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="E-AC-3 Atmos 5\.1",LANGUAGE="eng",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="16\/JOC"/);
  assert.match(m, /CODECS="avc1\.640028,ec-3",AUDIO="aud"/);
  // Encoded E-AC-3 5.1: channel count, no JOC. AAC: no EXT-X-MEDIA.
  assert.equal(masterAudioFor(planAudio(s(bd.truehd_atmos), TV_ARC), s(bd.truehd_atmos))?.channels, '6');
  assert.equal(masterAudioFor(planAudio(s(bd.truehd_atmos), BROWSER), s(bd.truehd_atmos)), null);
});

/* --------------------------- real ffmpeg checks --------------------------- */

/** Per-channel RMS level (dBFS) of a file, from astats. */
function channelRms(file: string): number[] {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'astats=measure_overall=none:measure_perchannel=RMS_level', '-f', 'null', '-'], { encoding: 'utf8' });
  return [...r.stderr.matchAll(/RMS level dB: (-?[\d.]+|-inf)/g)].map((m) => (m[1] === '-inf' ? -Infinity : Number(m[1])));
}

test('stereo downmix of a real 5.1 file: centre dialogue lands in both channels at −3 dB, LFE dropped', { skip: !hasFfmpeg }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-audio-'));
  try {
    // 5.1(side): a −20 dBFS 1 kHz tone on one channel, silence elsewhere.
    const make = (name: string, chan: number) => {
      const out = path.join(dir, `${name}.wav`);
      // 0.1414 peak sine = 0.1 RMS = −20 dBFS.
      const exprs = Array.from({ length: 6 }, (_, i) => (i === chan ? '0.1414*sin(2*PI*1000*t)' : '0')).join('|');
      const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc=${exprs}:c=5.1(side):s=48000:d=2`, '-c:a', 'pcm_s16le', out]);
      assert.equal(r.status, 0, r.stderr?.toString());
      return out;
    };
    const centre = make('centre', 2);
    const src = channelRms(centre);
    assert.ok(Math.abs(src[2] - -20) < 0.3, `source centre ${src[2]}`);
    const downmix = (input: string, boost = false) => {
      const out = path.join(dir, `dm-${path.basename(input, '.wav')}${boost ? '-b' : ''}.wav`);
      const plan = planAudio(parseAudioStream({ index: 0, codec_name: 'pcm_s16le', channels: 6, channel_layout: '5.1(side)' }), BROWSER, { noCopy: true, comforts: boost ? { dialogueBoost: true } : {} });
      assert.equal(plan.channels, 2);
      const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-af', plan.filters.join(','), '-ac', '2', '-c:a', 'pcm_s16le', out]);
      assert.equal(r.status, 0, r.stderr?.toString());
      return channelRms(out);
    };
    const [l, r] = downmix(centre);
    assert.ok(Math.abs(l - -23) < 0.5 && Math.abs(r - -23) < 0.5, `centre → L ${l} / R ${r} dB (want −23)`);
    const [bl, br] = downmix(centre, true);
    assert.ok(Math.abs(bl - -20) < 0.5 && Math.abs(br - -20) < 0.5, `dialogue boost: centre at unity (L ${bl} / R ${br})`);
    const [fl, fr] = downmix(make('left', 0));
    assert.ok(Math.abs(fl - -20) < 0.5 && fr < -80, `front left → L only (L ${fl} / R ${fr})`);
    const [sl, sr] = downmix(make('sl', 4));
    assert.ok(Math.abs(sl - -26) < 0.5 && sr < -80, `surround left → L at −6 dB (L ${sl} / R ${sr})`);
    const [ll, lr] = downmix(make('lfe', 3));
    assert.ok(ll < -80 && lr < -80, `LFE dropped (L ${ll} / R ${lr})`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('real ffmpeg runs the planned args: E-AC-3 5.1, AAC 7.1, DTS core copy, comforts', { skip: !hasFfmpeg }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-audio-'));
  try {
    const src71 = path.join(dir, 'src71.mkv');
    let r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000:duration=1', '-ac', '8', '-c:a', 'flac', src71]);
    assert.equal(r.status, 0, r.stderr?.toString());
    const srcDts = path.join(dir, 'src.dts.mkv');
    r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000:duration=1', '-ac', '6', '-c:a', 'dca', '-strict', '-2', srcDts]);
    assert.equal(r.status, 0, r.stderr?.toString());
    const probe = (f: string) => JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', f], { encoding: 'utf8' }).stdout).streams[0];
    const flac = parseAudioStream(probe(src71));
    assert.equal(flac.channels, 8);
    const run = (input: string, plan: ReturnType<typeof planAudio>, ext = 'mp4') => {
      const out = path.join(dir, `out-${Math.random().toString(36).slice(2)}.${ext}`);
      const res = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map', '0:a:0', ...audioArgs(plan), out]);
      assert.equal(res.status, 0, `${audioArgs(plan).join(' ')}: ${res.stderr?.toString()}`);
      return probe(out);
    };
    const e = run(src71, planAudio(flac, TV_ARC));
    assert.deepEqual([e.codec_name, e.channels], ['eac3', 6]);
    const a8 = run(src71, planAudio(flac, { audioCodecs: ['aac'], maxAudioChannels: 8 }));
    assert.deepEqual([a8.codec_name, a8.channels, a8.channel_layout], ['aac', 8, '7.1']);
    const st = run(src71, planAudio(flac, BROWSER, { forceProcessing: true, comforts: { nightMode: true, dialogueBoost: true, normalize: true, delayMs: -100 } }));
    assert.deepEqual([st.codec_name, st.channels], ['aac', 2]);
    const dts = parseAudioStream(probe(srcDts));
    const core = run(srcDts, { ...planAudio({ ...dts, dtsHdMa: true }, DTS_ONLY) });
    assert.equal(core.codec_name, 'dts');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildArgs: copied audio next to encoded video starts at the seek point; fMP4 fragments carry their real time (A/V sync, seeking)', () => {
  const plan = planAudio(s(real), TV_ARC);
  const enc = buildArgs(topts({ mode: 'transcode', videoCopy: false, audioCopy: true, audioPlan: plan, startSec: 900 }) as any, '/tmp/out', 0, 'none');
  assert.equal(enc.segmentType, 'fmp4');
  const a = enc.args;
  assert.equal(a[a.indexOf('-copypriorss:a') + 1], '0', 'audio before the seek point is dropped');
  assert.equal(a[a.indexOf('-hls_segment_options') + 1], 'movflags=+frag_discont', 'fragments carry their real time (seeking)');
  assert.ok(a.indexOf('-copypriorss:a') > a.indexOf('-i'), 'output option');
  const fromStart = buildArgs(topts({ mode: 'transcode', videoCopy: false, audioCopy: true, audioPlan: plan, startSec: 0 }) as any, '/tmp/out', 0, 'none').args;
  assert.ok(!fromStart.includes('-copypriorss:a'), 'nothing to drop without a seek');
  const remux = buildArgs(topts({ audioCopy: true, audioPlan: plan, startSec: 900 }) as any, '/tmp/out', 0, 'none').args;
  assert.ok(!remux.includes('-copypriorss:a'), 'video copy: audio and video both start at the keyframe');
  const aacEnc = buildArgs(topts({ mode: 'transcode', videoCopy: false, audioPlan: planAudio(s(real), { audioCodecs: ['aac'], maxAudioChannels: 2 } as any), startSec: 900, videoCodec: 'hevc' }) as any, '/tmp/out', 0, 'none');
  if (aacEnc.segmentType === 'fmp4') assert.ok(aacEnc.args.includes('movflags=+frag_discont'), 'every seekable fMP4 stream');
});
