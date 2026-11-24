import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HwAccel, HwDevice, HwMethodResult, ToneMapPath, TranscodeVideoCodec } from '@mediamax/shared';

const hwa = await import('../src/services/hwaccel.ts');
const { buildVideoPipeline, encoderArgs, chooseVideoCodec, codecBitrate, toneMapCandidates, hwInputArgs, ENCODERS, softwareToneMap } = hwa;
const transcoderMod = await import('../src/services/transcoder.ts');
const { buildArgs, shouldToneMap, hasEncoder } = transcoderMod;
const det = await import('../src/services/hwdetect.ts');
const { transcodeCodecFor } = await import('../src/services/playback.ts');
const { updateSettings } = await import('../src/services/settings.ts');

const DEV = '/dev/dri/renderD128';
const T = (hw: HwAccel, platform = 'linux', gpuIndex = 0) => ({ hw, platform, vaapiDevice: DEV, gpuIndex });
const SW_TM = softwareToneMap('software');
/** CPU tone-mapping that downscales in its first zscale (no separate scale filter). */
const SW_TM_H = (h: number) => [`zscale=w=-2:h=${h}:f=bilinear:t=linear:npl=100`, ...SW_TM.slice(1)];
const PLACEBO = 'libplacebo=tonemapping=bt.2390:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:format=yuv420p';
const OPENCL = (back: string, fmt: string) => [
  'hwmap=derive_device=opencl:mode=read', 'tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=hable:desat=0',
  `hwmap=derive_device=${back}:mode=write:reverse=1`, `format=${fmt}`,
];
const ALL_HW: HwAccel[] = ['none', 'vaapi', 'nvenc', 'qsv', 'videotoolbox', 'v4l2m2m', 'amf', 'rkmpp'];
const CODECS: TranscodeVideoCodec[] = ['h264', 'hevc', 'av1'];
const TONEMAPS: (ToneMapPath | null)[] = [null, 'software', 'libplacebo', 'vaapi', 'opencl', 'qsv', 'cuda'];

/* ------------------------- input (device) args ------------------------- */

test('hardware input args per accelerator and platform', () => {
  assert.deepEqual(hwInputArgs(T('vaapi'), 'full', true), ['-init_hw_device', `vaapi=va:${DEV}`, '-filter_hw_device', 'va', '-hwaccel', 'vaapi', '-hwaccel_device', 'va', '-hwaccel_output_format', 'vaapi']);
  assert.deepEqual(hwInputArgs(T('vaapi'), 'hybrid', true), ['-init_hw_device', `vaapi=va:${DEV}`, '-filter_hw_device', 'va', '-hwaccel', 'vaapi', '-hwaccel_device', 'va']);
  assert.deepEqual(hwInputArgs(T('vaapi'), 'hybrid', false), ['-init_hw_device', `vaapi=va:${DEV}`, '-filter_hw_device', 'va']);
  assert.deepEqual(hwInputArgs(T('qsv'), 'full', true), ['-init_hw_device', `vaapi=va:${DEV}`, '-init_hw_device', 'qsv=qs@va', '-filter_hw_device', 'va', '-hwaccel', 'vaapi', '-hwaccel_device', 'va', '-hwaccel_output_format', 'vaapi']);
  assert.deepEqual(hwInputArgs(T('qsv'), 'hybrid', false), ['-init_hw_device', `vaapi=va:${DEV}`, '-init_hw_device', 'qsv=qs@va', '-filter_hw_device', 'qs']);
  assert.deepEqual(hwInputArgs(T('qsv', 'win32', 1), 'full', true), ['-init_hw_device', 'd3d11va=dx11:1', '-init_hw_device', 'qsv=qs@dx11', '-filter_hw_device', 'dx11', '-hwaccel', 'd3d11va', '-hwaccel_device', 'dx11', '-hwaccel_output_format', 'd3d11']);
  assert.deepEqual(hwInputArgs(T('qsv', 'win32', 1), 'hybrid', true), ['-init_hw_device', 'd3d11va=dx11:1', '-init_hw_device', 'qsv=qs@dx11', '-filter_hw_device', 'qs', '-hwaccel', 'd3d11va', '-hwaccel_device', 'dx11']);
  assert.deepEqual(hwInputArgs(T('nvenc', 'linux', 1), 'full', true), ['-init_hw_device', 'cuda=cu:1', '-filter_hw_device', 'cu', '-hwaccel', 'cuda', '-hwaccel_device', 'cu', '-hwaccel_output_format', 'cuda']);
  // NVIDIA on Windows uses the same CUDA path.
  assert.deepEqual(hwInputArgs(T('nvenc', 'win32'), 'full', true), hwInputArgs(T('nvenc', 'linux'), 'full', true));
  assert.deepEqual(hwInputArgs(T('rkmpp'), 'full', true), ['-hwaccel', 'rkmpp', '-hwaccel_output_format', 'drm_prime']);
  assert.deepEqual(hwInputArgs(T('rkmpp'), 'hybrid', true), ['-hwaccel', 'rkmpp']);
  assert.deepEqual(hwInputArgs(T('amf', 'win32', 2), 'hybrid', true), ['-hwaccel', 'd3d11va', '-hwaccel_device', '2']);
  assert.deepEqual(hwInputArgs(T('videotoolbox', 'darwin'), 'hybrid', true), ['-hwaccel', 'videotoolbox']);
  assert.deepEqual(hwInputArgs(T('v4l2m2m'), 'hybrid', true), []);
  assert.deepEqual(hwInputArgs(T('none'), 'hybrid', true), []);
});

/* ----------------------------- full matrix ----------------------------- */

/**
 * Expected [mode, filters, effective tone map] for accelerator × tone-map, decoding a 2160p source to 1080p
 * with no CPU-only filters. `undefined` = combination identical to the hybrid fallback (computed below).
 */
const H = 1080;
type Exp = { mode: 'full' | 'hybrid' | 'software'; filters: string[]; toneMap: ToneMapPath | null };
function expected(hw: HwAccel, platform: string, tm: ToneMapPath | null): Exp {
  const hybrid = (): Exp => {
    const etm: ToneMapPath | null = tm ? (tm === 'libplacebo' ? 'libplacebo' : 'software') : null;
    const pre = etm === 'libplacebo' ? [PLACEBO, `scale=-2:${H}`] : etm ? SW_TM_H(H) : [`scale=-2:${H}`];
    const yuv = etm === 'software' ? [] : ['format=yuv420p']; // the CPU tone-map chain already ends in yuv420p
    const tail: Record<string, string[]> = {
      vaapi: ['format=nv12', 'hwupload'], nvenc: ['format=nv12', 'hwupload'], qsv: ['format=nv12', 'hwupload=extra_hw_frames=64'],
      videotoolbox: yuv, v4l2m2m: yuv, amf: ['format=nv12'], rkmpp: ['format=nv12'],
    };
    return { mode: 'hybrid', filters: [...pre, ...tail[hw]], toneMap: etm };
  };
  if (hw === 'none') {
    const etm: ToneMapPath | null = tm ? (tm === 'libplacebo' ? 'libplacebo' : 'software') : null;
    return { mode: 'software', filters: etm === 'software' ? SW_TM_H(H) : [...(etm === 'libplacebo' ? [PLACEBO] : []), `scale=-2:${H}`, 'format=yuv420p'], toneMap: etm };
  }
  const win = platform === 'win32';
  switch (hw) {
    case 'vaapi': {
      const t = { vaapi: ['tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709'], opencl: OPENCL('vaapi', 'vaapi') } as Record<string, string[]>;
      if (tm && !t[tm]) return hybrid();
      return { mode: 'full', filters: ['format=nv12|p010le|vaapi', 'hwupload', ...(tm ? t[tm] : []), `scale_vaapi=w=-2:h=${H}:format=nv12`], toneMap: tm };
    }
    case 'qsv': {
      const ok = win ? ['qsv'] : ['qsv', 'vaapi', 'opencl'];
      if (tm && !ok.includes(tm)) return hybrid();
      const pre = tm === 'vaapi' ? ['tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709'] : tm === 'opencl' ? OPENCL('vaapi', 'vaapi') : [];
      return {
        mode: 'full', toneMap: tm,
        filters: [`format=nv12|p010le|${win ? 'd3d11' : 'vaapi'}`, 'hwupload', ...pre, 'hwmap=derive_device=qsv', 'format=qsv', ...(tm === 'qsv' ? ['vpp_qsv=tonemap=1:format=nv12'] : []), `scale_qsv=w=round(iw*${H}/ih/2)*2:h=${H}:format=nv12`],
      };
    }
    case 'nvenc':
      if (tm && tm !== 'cuda') return hybrid();
      return { mode: 'full', filters: ['format=nv12|p010le|cuda', 'hwupload', ...(tm ? ['tonemap_cuda=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=bt2390'] : []), `scale_cuda=w=-2:h=${H}:format=nv12`], toneMap: tm };
    case 'rkmpp':
      if (tm && tm !== 'opencl') return hybrid();
      return { mode: 'full', filters: [...(tm ? OPENCL('rkmpp', 'drm_prime') : []), `scale_rkrga=w=-2:h=${H}:format=nv12`], toneMap: tm };
    default:
      return hybrid(); // videotoolbox, amf, v4l2m2m
  }
}

test('pipeline: every accelerator × codec × tone-mapping combination (exact filters, encoder and input args)', () => {
  let n = 0;
  for (const platform of ['linux', 'win32', 'darwin']) {
    for (const hw of ALL_HW) {
      for (const codec of CODECS) {
        for (const tm of TONEMAPS) {
          const enc = ENCODERS[hw][codec];
          const input = { target: T(hw, platform), codec, height: H, sourceHeight: 2160, toneMap: tm, decode: true };
          if (!enc) {
            assert.throws(() => buildVideoPipeline(input), /cannot encode/, `${hw} ${codec}`);
            continue;
          }
          const p = buildVideoPipeline(input);
          const e = expected(hw, platform, tm);
          const label = `${platform} ${hw} ${codec} ${tm}`;
          assert.equal(p.encoder, enc, label);
          assert.equal(p.mode, e.mode, label);
          assert.deepEqual(p.filters, e.filters, label);
          assert.equal(p.toneMap, e.toneMap, label);
          assert.deepEqual(p.inputArgs, hw === 'none' ? [] : hwInputArgs(T(hw, platform), e.mode === 'full' ? 'full' : 'hybrid', true), label);
          n++;
        }
      }
    }
  }
  assert.ok(n > 300, `combinations tested: ${n}`);
});

test('pipeline: burn-in subtitles force the hybrid path and keep the hardware encoder', () => {
  const sub = "subtitles='/m/a.srt'";
  const p = buildVideoPipeline({ target: T('vaapi'), codec: 'hevc', height: 720, sourceHeight: 1080, toneMap: 'vaapi', swFilters: [sub], decode: true });
  assert.equal(p.mode, 'hybrid');
  assert.deepEqual(p.filters, [...SW_TM_H(720), sub, 'format=nv12', 'hwupload']);
  assert.equal(p.encoder, 'hevc_vaapi');
  assert.equal(p.toneMap, 'software');
  const sw = buildVideoPipeline({ target: T('none'), codec: 'h264', height: 720, sourceHeight: 1080, toneMap: null, swFilters: [sub], decode: true });
  assert.deepEqual(sw.filters, ['scale=-2:720', sub, 'format=yuv420p']);
});

test('pipeline: no upscaling, and GPU scalers without a height', () => {
  assert.deepEqual(buildVideoPipeline({ target: T('vaapi'), codec: 'h264', height: 1080, sourceHeight: 720, toneMap: null, decode: true }).filters, ['format=nv12|p010le|vaapi', 'hwupload', 'scale_vaapi=format=nv12']);
  assert.deepEqual(buildVideoPipeline({ target: T('nvenc'), codec: 'h264', height: null, sourceHeight: 720, toneMap: null, decode: true }).filters.at(-1), 'scale_cuda=format=nv12');
  assert.deepEqual(buildVideoPipeline({ target: T('qsv'), codec: 'h264', height: null, sourceHeight: null, toneMap: null, decode: true }).filters.at(-1), 'scale_qsv=format=nv12');
  assert.deepEqual(buildVideoPipeline({ target: T('rkmpp'), codec: 'h264', height: null, sourceHeight: null, toneMap: null, decode: true }).filters, ['scale_rkrga=format=nv12']);
  assert.deepEqual(buildVideoPipeline({ target: T('none'), codec: 'h264', height: 1080, sourceHeight: 1080, toneMap: null, decode: true }).filters, ['format=yuv420p']);
  // Without hardware decode (lavfi test source / image subtitle overlay) the full pipeline is not used.
  assert.equal(buildVideoPipeline({ target: T('vaapi'), codec: 'h264', height: 720, sourceHeight: 1080, toneMap: null, decode: false }).mode, 'hybrid');
});

/* ------------------------------ encoders ------------------------------ */

test('encoder args for every encoder', () => {
  const o = { bitrate: 5000, preset: 'veryfast', threads: 0 };
  const exp: Record<string, string[]> = {
    libx264: ['-preset', 'veryfast', '-profile:v', 'high', '-level', '4.1'],
    libx265: ['-preset', 'veryfast', '-x265-params', 'log-level=error', '-tag:v', 'hvc1'],
    libsvtav1: ['-preset', '10'],
    h264_nvenc: ['-preset', 'p4', '-forced-idr', '1'], hevc_nvenc: ['-preset', 'p4', '-forced-idr', '1', '-tag:v', 'hvc1'], av1_nvenc: ['-preset', 'p4', '-forced-idr', '1'],
    h264_qsv: ['-preset', 'veryfast', '-forced_idr', '1'], hevc_qsv: ['-preset', 'veryfast', '-forced_idr', '1', '-tag:v', 'hvc1'], av1_qsv: ['-preset', 'veryfast', '-forced_idr', '1'],
    h264_amf: ['-usage', 'transcoding', '-quality', 'speed', '-rc', 'vbr_peak'], hevc_amf: ['-usage', 'transcoding', '-quality', 'speed', '-rc', 'vbr_peak', '-tag:v', 'hvc1'], av1_amf: ['-usage', 'transcoding', '-quality', 'speed', '-rc', 'vbr_peak'],
    h264_rkmpp: ['-rc_mode', 'VBR'], hevc_rkmpp: ['-rc_mode', 'VBR', '-tag:v', 'hvc1'],
    h264_vaapi: [], hevc_vaapi: ['-tag:v', 'hvc1'], av1_vaapi: [],
    h264_videotoolbox: [], hevc_videotoolbox: ['-tag:v', 'hvc1'],
    h264_v4l2m2m: [], hevc_v4l2m2m: ['-tag:v', 'hvc1'],
  };
  const all = new Set(Object.values(ENCODERS).flatMap((m) => Object.values(m)));
  assert.deepEqual([...all].sort(), Object.keys(exp).sort());
  for (const [enc, rest] of Object.entries(exp)) assert.deepEqual(encoderArgs(enc, o), ['-c:v', enc, ...rest], enc);
  assert.deepEqual(encoderArgs('libx264', { ...o, threads: 4 }).slice(-2), ['-threads', '4']);
});

test('libx264: zerolatency only for live, H.264 level from output size and frame rate; VA-API low-power', () => {
  const o = { bitrate: 5000, preset: 'veryfast', threads: 0 };
  assert.deepEqual(encoderArgs('libx264', { ...o, live: true }), ['-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-level', '4.1', '-tune', 'zerolatency']);
  const level = (height: number | null, fps: number | null) => { const a = encoderArgs('libx264', { ...o, height, fps }); return a[a.indexOf('-level') + 1]; };
  assert.equal(level(2160, 24), '5.1');
  assert.equal(level(1440, null), '5.1');
  assert.equal(level(1080, 24), '4.1');
  assert.equal(level(1080, 50), '4.2');
  assert.equal(level(720, 60), '4.1');
  assert.equal(level(null, null), '4.1');
  assert.deepEqual(encoderArgs('h264_vaapi', { ...o, lowPower: true }), ['-c:v', 'h264_vaapi', '-low_power', '1']);
  assert.deepEqual(encoderArgs('hevc_vaapi', { ...o, lowPower: true }), ['-c:v', 'hevc_vaapi', '-low_power', '1', '-tag:v', 'hvc1']);
  assert.deepEqual(encoderArgs('h264_qsv', { ...o, lowPower: true }), ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-forced_idr', '1']);
});

test('keyframes: time-based at segment boundaries, GOP of one segment when the frame rate is known', () => {
  assert.deepEqual(hwa.keyframeArgs(4, null), ['-force_key_frames', 'expr:gte(t,n_forced*4)', '-sc_threshold', '0']);
  assert.deepEqual(hwa.keyframeArgs(4, 23.976), ['-force_key_frames', 'expr:gte(t,n_forced*4)', '-sc_threshold', '0', '-g', '96', '-keyint_min', '96']);
  assert.deepEqual(hwa.keyframeArgs(6, 50), ['-force_key_frames', 'expr:gte(t,n_forced*6)', '-sc_threshold', '0', '-g', '300', '-keyint_min', '300']);
});

test('OpenCL tone-mapping uses bt2390 only when the build has it (jellyfin-ffmpeg), else hable', () => {
  const tm = (features: any) => buildVideoPipeline({ target: T('vaapi'), codec: 'h264', height: 1080, sourceHeight: 2160, toneMap: 'opencl', decode: true, features }).filters[3];
  assert.equal(tm(undefined), 'tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=hable:desat=0');
  assert.equal(tm({ openclBt2390: true }), 'tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=bt2390:desat=0');
  assert.equal(det.decodeTestArgs(T('v4l2m2m'), '/s.mp4'), null);
  const { parseOpenclBt2390 } = transcoderMod;
  assert.equal(parseOpenclBt2390('   tonemap  <int> ..FV...\n     none 0\n     hable 5\n     mobius 6\n'), false);
  assert.equal(parseOpenclBt2390('   tonemap  <int> ..FV...\n     hable 5\n     mobius 6\n     bt2390 7  ..FV...\n'), true);
});

/* ----------------------------- deinterlacing ---------------------------- */

test('deinterlacing: GPU deinterlacers in full pipelines, bwdif on the CPU, auto mode only on CPU paths', () => {
  const p = (hw: HwAccel, o: any = {}) => buildVideoPipeline({ target: T(hw, o.platform ?? 'linux'), codec: 'h264', height: 720, sourceHeight: 1080, toneMap: null, decode: true, deinterlace: 'interlaced', ...o });
  const BW = 'bwdif=mode=send_field:parity=auto:deint=interlaced';
  const BW_AUTO = 'bwdif=mode=send_frame:parity=auto:deint=interlaced';
  assert.deepEqual(p('vaapi').filters, ['format=nv12|p010le|vaapi', 'hwupload', 'deinterlace_vaapi=rate=field', 'scale_vaapi=w=-2:h=720:format=nv12']);
  assert.equal(p('vaapi').fieldRate, true);
  assert.deepEqual(p('nvenc').filters, ['format=nv12|p010le|cuda', 'hwupload', 'yadif_cuda=mode=send_field:parity=auto:deint=interlaced', 'scale_cuda=w=-2:h=720:format=nv12']);
  assert.deepEqual(p('qsv').filters, ['format=nv12|p010le|vaapi', 'hwupload', 'hwmap=derive_device=qsv', 'format=qsv', 'vpp_qsv=deinterlace=2', 'scale_qsv=w=round(iw*720/ih/2)*2:h=720:format=nv12']);
  assert.equal(p('qsv').fieldRate, false);
  // Merged into the tone-mapping vpp_qsv.
  assert.deepEqual(p('qsv', { toneMap: 'qsv' }).filters.slice(4), ['vpp_qsv=deinterlace=2:tonemap=1:format=nv12', 'scale_qsv=w=round(iw*720/ih/2)*2:h=720:format=nv12']);
  assert.deepEqual(p('vaapi', { toneMap: 'vaapi' }).filters.slice(2, 4), ['deinterlace_vaapi=rate=field', 'tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709']);
  // No GPU deinterlacer (RKMPP) or not in this build → hybrid with bwdif first.
  const rk = p('rkmpp');
  assert.equal(rk.mode, 'hybrid');
  assert.deepEqual(rk.filters, [BW, 'scale=-2:720', 'format=nv12']);
  const noYadif = p('nvenc', { features: { hasFilter: (f: string) => f !== 'yadif_cuda' } });
  assert.equal(noYadif.mode, 'hybrid');
  assert.deepEqual(noYadif.filters, [BW, 'scale=-2:720', 'format=nv12', 'hwupload']);
  // CPU: deinterlace before tone-mapping/scaling.
  assert.deepEqual(p('none', { toneMap: 'software' }).filters, [BW, ...SW_TM_H(720)]);
  assert.deepEqual(p('none').filters, [BW, 'scale=-2:720', 'format=yuv420p']);
  // Unknown field order (live): no-op-for-progressive bwdif on CPU/hybrid, nothing in the full GPU pipeline.
  assert.deepEqual(p('none', { deinterlace: 'auto' }).filters, [BW_AUTO, 'scale=-2:720', 'format=yuv420p']);
  assert.equal(p('none', { deinterlace: 'auto' }).fieldRate, false);
  assert.deepEqual(p('vaapi', { deinterlace: 'auto' }).filters, ['format=nv12|p010le|vaapi', 'hwupload', 'scale_vaapi=w=-2:h=720:format=nv12']);
  assert.deepEqual(p('vaapi', { deinterlace: 'auto', swFilters: ['subtitles=x'] }).filters, [BW_AUTO, 'scale=-2:720', 'subtitles=x', 'format=nv12', 'hwupload']);
  // Progressive: nothing.
  assert.deepEqual(p('none', { deinterlace: null }).filters, ['scale=-2:720', 'format=yuv420p']);
  assert.equal(hwa.isInterlacedFieldOrder('tt'), true);
  assert.equal(hwa.isInterlacedFieldOrder('bt'), true);
  assert.equal(hwa.isInterlacedFieldOrder('progressive'), false);
  assert.equal(hwa.isInterlacedFieldOrder(null), false);
});

test('HEVC/AV1 bitrate is ~60-70% of H.264', () => {
  assert.equal(codecBitrate(8000, 'h264'), 8000);
  assert.equal(codecBitrate(8000, 'hevc'), 5200);
  assert.equal(codecBitrate(8000, 'av1'), 4800);
});

test('tone-mapping candidates per accelerator (libplacebo before the CPU zscale path)', () => {
  assert.deepEqual(toneMapCandidates('vaapi', 'linux'), ['vaapi', 'opencl', 'libplacebo', 'software']);
  assert.deepEqual(toneMapCandidates('qsv', 'linux'), ['qsv', 'vaapi', 'opencl', 'libplacebo', 'software']);
  assert.deepEqual(toneMapCandidates('qsv', 'win32'), ['qsv', 'libplacebo', 'software']);
  assert.deepEqual(toneMapCandidates('nvenc', 'linux'), ['cuda', 'libplacebo', 'software']);
  assert.deepEqual(toneMapCandidates('rkmpp', 'linux'), ['opencl', 'libplacebo', 'software']);
  for (const hw of ['none', 'amf', 'videotoolbox', 'v4l2m2m'] as HwAccel[]) assert.deepEqual(toneMapCandidates(hw, 'linux'), ['libplacebo', 'software']);
  assert.deepEqual(toneMapCandidates('vaapi', 'linux', false), ['libplacebo', 'software']);
});

/* ---------------------------- codec choice ----------------------------- */

const choose = (o: Partial<Parameters<typeof chooseVideoCodec>[0]>) => chooseVideoCodec({
  clientCodecs: ['h264', 'hevc', 'av1'], preferred: ['av1', 'hevc', 'h264'], allowHevc: true, allowAv1: true, hw: 'nvenc', codecWorks: () => true, ...o,
});

test('codec choice from device profiles', () => {
  assert.equal(choose({}), 'av1');
  assert.equal(choose({ allowAv1: false }), 'hevc');
  assert.equal(choose({ preferred: ['hevc', 'av1'] }), 'hevc');
  assert.equal(choose({ clientCodecs: ['h264', 'hevc'] }), 'hevc'); // browser without AV1
  assert.equal(choose({ clientCodecs: ['avc', 'h265'] }), 'hevc'); // aliases
  assert.equal(choose({ clientCodecs: ['h264'] }), 'h264'); // Chromecast profile
  assert.equal(choose({ clientCodecs: undefined }), 'h264'); // no profile → server default
  assert.equal(choose({ allowHevc: false, allowAv1: false }), 'h264');
  assert.equal(choose({ hw: 'none' }), 'h264'); // never HEVC/AV1 on the CPU
  assert.equal(choose({ hw: 'videotoolbox' }), 'hevc'); // VideoToolbox has no AV1 encoder
  assert.equal(choose({ hw: 'v4l2m2m', preferred: ['hevc'] }), 'hevc');
  assert.equal(choose({ codecWorks: (c) => c !== 'av1' }), 'hevc'); // failed in detect
  assert.equal(choose({ preferred: [] }), 'h264');
});

test('transcodeCodecFor uses settings and the real web/mobile profiles', () => {
  updateSettings({ transcoding: { hwAccel: 'none', preferredCodecs: ['hevc', 'h264'], allowHevcEncoding: true, allowAv1Encoding: false } as any });
  assert.equal(transcodeCodecFor({ videoCodecs: ['h264', 'hevc'] }), 'h264'); // CPU only
  updateSettings({ transcoding: { hwAccel: 'vaapi' } as any });
  // HEVC when this ffmpeg build has hevc_vaapi (no detect report yet, so the encoder is assumed to work).
  assert.equal(transcodeCodecFor({ videoCodecs: ['h264', 'hevc', 'vp9'] }), hasEncoder('hevc_vaapi') ? 'hevc' : 'h264');
  assert.equal(transcodeCodecFor({ videoCodecs: ['h264'] }), 'h264');
  assert.equal(transcodeCodecFor(undefined), 'h264');
  updateSettings({ transcoding: { hwAccel: 'none' } as any });
});

/* ------------------------------ buildArgs ------------------------------ */

const opts = (o: any = {}) => ({
  input: '/media/movie.mkv', startSec: 0, durationSec: 100, mode: 'transcode', audioIndex: 1, audioCopy: false, videoCopy: false,
  bitrate: 8000, maxHeight: null, sourceHeight: 2160, sourceCodec: 'hevc', hdr: false, audioChannels: 2, hasVideo: true, ...o,
});

test('buildArgs: software H.264 on MPEG-TS (unchanged default path)', () => {
  updateSettings({ transcoding: { hwAccel: 'none', segmentSeconds: 4, preset: 'veryfast', threads: 0, toneMapHdr: true } as any });
  const { args, info, segmentType } = buildArgs(opts() as any, '/t', 0, 'none');
  assert.equal(segmentType, 'mpegts');
  assert.deepEqual(args, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', '/media/movie.mkv',
    '-map', '0:v:0', '-map', '0:1', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-vf', 'scale=-2:1080,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-level', '4.1',
    '-b:v', '8000k', '-maxrate', '8000k', '-bufsize', '16000k', '-force_key_frames', 'expr:gte(t,n_forced*4)', '-sc_threshold', '0',
    '-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-max_muxing_queue_size', '2048',
    '-f', 'hls', '-hls_time', '4', '-hls_segment_type', 'mpegts', '-start_number', '0', '-hls_segment_filename', '/t/seg%d.ts',
    '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments+temp_file', '/t/ff.m3u8',
  ]);
  assert.deepEqual(info, { videoCodec: 'libx264', audioCodec: 'aac', bitrate: 8000, hwAccel: 'none', toneMap: null, hwFallback: null, height: 1080 });
});

test('buildArgs: VA-API HEVC with GPU tone-mapping on fMP4 HLS', () => {
  const { args, info, segmentType } = buildArgs(opts({ hdr: true, startSec: 8 }) as any, '/t', 2, { hw: 'vaapi', codec: 'hevc', toneMap: 'vaapi', platform: 'linux' });
  assert.equal(segmentType, 'fmp4');
  assert.deepEqual(args, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-init_hw_device', `vaapi=va:${DEV}`, '-filter_hw_device', 'va', '-hwaccel', 'vaapi', '-hwaccel_device', 'va', '-hwaccel_output_format', 'vaapi',
    '-ss', '8.000', '-i', '/media/movie.mkv',
    '-map', '0:v:0', '-map', '0:1', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-vf', 'format=nv12|p010le|vaapi,hwupload,tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709,scale_vaapi=w=-2:h=1080:format=nv12',
    '-c:v', 'hevc_vaapi', '-tag:v', 'hvc1', '-b:v', '5200k', '-maxrate', '5200k', '-bufsize', '10400k',
    '-force_key_frames', 'expr:gte(t,n_forced*4)', '-sc_threshold', '0',
    '-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-output_ts_offset', '8.000', '-max_muxing_queue_size', '2048',
    '-f', 'hls', '-hls_time', '4', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-start_number', '2', '-hls_segment_filename', '/t/seg%d.m4s',
    '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments+temp_file', '/t/ff.m3u8',
  ]);
  assert.deepEqual(info, { videoCodec: 'hevc_vaapi', audioCodec: 'aac', bitrate: 5200, hwAccel: 'vaapi', toneMap: 'vaapi', hwFallback: null, height: 1080 });
});

test('buildArgs: image subtitle overlay with NVENC, Windows QSV, AMF', () => {
  const ov = buildArgs(opts({ burnSubtitle: { kind: 'embedded-image', streamIndex: 3 } }) as any, '/t', 0, { hw: 'nvenc', codec: 'h264', toneMap: null });
  assert.deepEqual(ov.args.slice(5, 9), ['-init_hw_device', 'cuda=cu:0', '-filter_hw_device', 'cu']);
  const i = ov.args.indexOf('-filter_complex');
  assert.equal(ov.args[i + 1], '[0:v:0][0:3]overlay=eof_action=pass,scale=-2:1080,format=nv12,hwupload[v]');
  // The hybrid path keeps hardware decoding; without -hwaccel_output_format the frames arrive in system memory.
  assert.deepEqual(ov.args.slice(9, 13), ['-hwaccel', 'cuda', '-hwaccel_device', 'cu']);
  assert.ok(!ov.args.includes('-hwaccel_output_format'));
  // Deinterlacing runs before the overlay; the decode:false fallback drops -hwaccel.
  const ovi = buildArgs(opts({ burnSubtitle: { kind: 'embedded-image', streamIndex: 3 }, fieldOrder: 'tt' }) as any, '/t', 0, { hw: 'nvenc', codec: 'h264', toneMap: null });
  assert.equal(ovi.args[ovi.args.indexOf('-filter_complex') + 1], '[0:v:0]bwdif=mode=send_field:parity=auto:deint=interlaced[dv];[dv][0:3]overlay=eof_action=pass,scale=-2:1080,format=nv12,hwupload[v]');
  const ovsw = buildArgs(opts({ burnSubtitle: { kind: 'embedded-image', streamIndex: 3 } }) as any, '/t', 0, { hw: 'nvenc', codec: 'h264', toneMap: null, decode: false });
  assert.ok(!ovsw.args.includes('-hwaccel'));
  const q = buildArgs(opts() as any, '/t', 0, { hw: 'qsv', codec: 'h264', toneMap: null, platform: 'win32' });
  assert.equal(q.args[q.args.indexOf('-vf') + 1], 'format=nv12|p010le|d3d11,hwupload,hwmap=derive_device=qsv,format=qsv,scale_qsv=w=round(iw*1080/ih/2)*2:h=1080:format=nv12');
  const a = buildArgs(opts() as any, '/t', 0, { hw: 'amf', codec: 'av1', toneMap: null, platform: 'win32' });
  assert.deepEqual(a.args.slice(5, 9), ['-hwaccel', 'd3d11va', '-hwaccel_device', '0']);
  assert.equal(a.args[a.args.indexOf('-c:v') + 1], 'av1_amf');
  assert.equal(a.segmentType, 'fmp4');
});

test('buildArgs: software never encodes HEVC; remux of HEVC uses fMP4; live stays MPEG-TS', () => {
  const sw = buildArgs(opts() as any, '/t', 0, { hw: 'none', codec: 'hevc' });
  assert.equal(sw.info.videoCodec, 'libx264');
  assert.equal(sw.segmentType, 'mpegts');
  const rm = buildArgs(opts({ mode: 'remux', videoCopy: true, audioCopy: true }) as any, '/t', 0, 'vaapi');
  assert.equal(rm.segmentType, 'fmp4');
  assert.deepEqual(rm.args.slice(rm.args.indexOf('-c:v'), rm.args.indexOf('-c:v') + 4), ['-c:v', 'copy', '-tag:v', 'hvc1']);
  assert.equal(rm.info.hwAccel, 'none');
  const live = buildArgs(opts({ mode: 'live', videoCopy: true, sourceCodec: null, input: 'http://x/y.ts' }) as any, '/t', 0, 'vaapi');
  assert.equal(live.segmentType, 'mpegts');
  // The accelerator has no encoder for the codec (VideoToolbox AV1) → H.264.
  assert.equal(buildArgs(opts() as any, '/t', 0, { hw: 'videotoolbox', codec: 'av1', platform: 'darwin' }).info.videoCodec, 'h264_videotoolbox');
});

test('shouldToneMap: explicit decision wins, setting gates it, copy never tone-maps', () => {
  assert.equal(shouldToneMap({ hdr: true, hasVideo: true, videoCopy: false }, true), true);
  assert.equal(shouldToneMap({ hdr: true, hasVideo: true, videoCopy: false }, false), false);
  assert.equal(shouldToneMap({ hdr: true, toneMap: false, hasVideo: true, videoCopy: false }, true), false); // HDR-capable client
  assert.equal(shouldToneMap({ hdr: false, toneMap: true, hasVideo: true, videoCopy: false }, true), true);
  assert.equal(shouldToneMap({ hdr: true, hasVideo: true, videoCopy: true }, true), false);
});

/* ------------------------------ detection ------------------------------ */

test('parsers: hwaccels, nvidia-smi, vainfo, vendor names', () => {
  assert.deepEqual(det.parseHwaccels('Hardware acceleration methods:\nvdpau\ncuda\nvaapi\n\n'), ['vdpau', 'cuda', 'vaapi']);
  assert.deepEqual(det.parseNvidiaSmi('GPU 0: NVIDIA GeForce RTX 3060 (UUID: GPU-abc)\nGPU 1: Tesla T4 (UUID: GPU-def)\n').map((d) => [d.index, d.name]), [[0, 'NVIDIA GeForce RTX 3060'], [1, 'Tesla T4']]);
  assert.equal(det.parseVainfo('vainfo: VA-API version: 1.20 (libva 2.12.0)\nvainfo: Driver version: Intel iHD driver for Intel(R) Gen Graphics - 24.1.0 ()\n'), 'Intel iHD driver for Intel(R) Gen Graphics - 24.1.0 ()');
  assert.equal(det.vendorFromName('AMD Radeon RX 7600'), 'amd');
  assert.equal(det.vendorFromName('Intel(R) UHD Graphics 770'), 'intel');
  assert.equal(det.vendorFromName('NVIDIA GeForce GTX 1660'), 'nvidia');
  assert.match(det.errorSnippet('a\nb\nb\nc\nd\ne\n'), /^b \| c \| d \| e$/);
});

const allEnc = new Set(Object.values(ENCODERS).flatMap((m) => Object.values(m)) as string[]);
const dri = (path: string, vendor: HwDevice['vendor'], name = 'GPU'): HwDevice => ({ kind: 'dri', path, name, driver: null, vendor, index: null });

test('planCandidates: no devices → every hardware method unavailable with a clear reason', () => {
  const c = det.planCandidates('linux', [], allEnc);
  assert.deepEqual(c.map((x) => x.hwAccel), ['vaapi', 'qsv', 'nvenc', 'v4l2m2m', 'rkmpp', 'none']);
  for (const x of c.filter((x) => x.hwAccel !== 'none')) assert.ok(x.unavailable && x.unavailable.length > 10, x.hwAccel);
  assert.equal(c.find((x) => x.hwAccel === 'none')!.unavailable, null);
});

test('planCandidates: Intel + AMD + NVIDIA on Linux, Rockchip without rkmpp, Windows, macOS', () => {
  const c = det.planCandidates('linux', [
    dri('/dev/dri/renderD128', 'intel'), dri('/dev/dri/renderD129', 'amd'),
    { kind: 'nvidia', path: null, name: 'RTX', driver: 'nvidia', vendor: 'nvidia', index: 0 },
    { kind: 'rockchip', path: null, name: 'Rockchip RK3588', driver: 'rkmpp', vendor: 'rockchip', index: null },
  ], allEnc);
  const by = (hw: string) => c.filter((x) => x.hwAccel === hw);
  assert.deepEqual(by('vaapi').map((x) => [x.device, x.label]), [['/dev/dri/renderD128', 'VA-API (Intel)'], ['/dev/dri/renderD129', 'VA-API (AMD Radeon)']]);
  assert.deepEqual(by('qsv').map((x) => x.device), ['/dev/dri/renderD128']);
  assert.deepEqual(by('nvenc').map((x) => [x.gpuIndex, x.unavailable]), [[0, null]]);
  assert.equal(by('rkmpp')[0].unavailable, null);
  const noRk = det.planCandidates('linux', [{ kind: 'rockchip', path: null, name: 'Rockchip RK3588', driver: 'rkmpp', vendor: 'rockchip', index: null }], new Set(['libx264']));
  assert.match(noRk.find((x) => x.hwAccel === 'rkmpp')!.unavailable!, /RK3588 detected, but this ffmpeg build has no rkmpp/);
  const w = det.planCandidates('win32', [
    { kind: 'windows-gpu', path: null, name: 'Intel UHD 770', driver: null, vendor: 'intel', index: 0 },
    { kind: 'windows-gpu', path: null, name: 'AMD Radeon RX 7600', driver: null, vendor: 'amd', index: 1 },
  ], allEnc);
  assert.deepEqual(w.map((x) => [x.hwAccel, x.gpuIndex, !!x.unavailable]), [['nvenc', null, true], ['qsv', 0, false], ['amf', 1, false], ['none', null, false]]);
  assert.deepEqual(det.planCandidates('darwin', [], allEnc).map((x) => x.hwAccel), ['videotoolbox', 'none']);
});

const method = (o: Partial<HwMethodResult>): HwMethodResult => {
  const enc = (works: boolean) => ({ works, error: null, fps: 100, encoder: 'x' });
  return {
    id: 'x', hwAccel: 'none', label: 'L', device: null, gpuIndex: null, deviceName: null, available: true, works: true, error: null,
    encode: { h264: enc(true), hevc: enc(false), av1: enc(false) }, decode: { works: true, error: null, fps: 1 }, tenBit: null,
    toneMapping: { path: null, tried: [] }, fps: 100, recommended: false, notes: [], ...o,
  };
};

test('recommend: highest-priority working method, else software', () => {
  assert.equal(det.recommend([method({ id: 'none:default' })]).hwAccel, 'none');
  const r = det.recommend([
    method({ id: 'none:default' }),
    method({ id: 'vaapi:/dev/dri/renderD128', hwAccel: 'vaapi', device: '/dev/dri/renderD128' }),
    method({ id: 'qsv:/dev/dri/renderD128', hwAccel: 'qsv', device: '/dev/dri/renderD128', toneMapping: { path: 'qsv', tried: [] } }),
    method({ id: 'nvenc:0', hwAccel: 'nvenc', works: false }),
  ]);
  assert.equal(r.id, 'qsv:/dev/dri/renderD128');
  assert.equal(r.device, '/dev/dri/renderD128');
  assert.match(r.reason, /tone-mapping: qsv/);
});

test('detect test commands are built from the playback pipeline', () => {
  const a = det.testArgs(T('vaapi'), { codec: 'hevc', input: 'testsrc', toneMap: null, decode: false });
  assert.deepEqual(a, ['-y', '-init_hw_device', `vaapi=va:${DEV}`, '-filter_hw_device', 'va', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-t', '2', '-an',
    '-vf', 'scale=-2:720,format=nv12,hwupload', '-c:v', 'hevc_vaapi', '-tag:v', 'hvc1', '-b:v', '4000k', '-maxrate', '4000k', '-bufsize', '8000k', '-f', 'null', '-']);
  const d = det.testArgs(T('nvenc'), { codec: 'h264', input: '/s.mp4', toneMap: 'cuda', decode: true });
  assert.equal(d[d.indexOf('-vf') + 1], 'format=nv12|p010le|cuda,hwupload,tonemap_cuda=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=bt2390,scale_cuda=w=-2:h=720:format=nv12');
});

test('runFfmpeg: software encode works here; hardware on a missing device fails cleanly with the error', async () => {
  const ok = await det.runFfmpeg(det.testArgs(T('none'), { codec: 'h264', input: 'testsrc', toneMap: null, decode: false }), 30000);
  assert.equal(ok.ok, true, ok.error ?? '');
  assert.ok(ok.fps && ok.fps > 0);
  const bad = await det.runFfmpeg(det.testArgs({ ...T('vaapi'), vaapiDevice: '/dev/dri/renderD999' }, { codec: 'h264', input: 'testsrc', toneMap: null, decode: false }), 15000);
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /renderD999|vaapi|Device creation failed/i);
  const missing = await det.runFfmpeg(['-version'], 5000, '/nonexistent/ffmpeg');
  assert.equal(missing.ok, false);
  assert.match(missing.error!, /ENOENT/);
});

/* ---------------------- real jobs (ffmpeg, no GPU) ---------------------- */

const { TranscodeJob, hasEncoder: has } = await import('../src/services/transcoder.ts');
const { execFileSync } = await import('node:child_process');
const fs = await import('node:fs');
const os = await import('node:os');
const pathMod = await import('node:path');
const tmp = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'mm-hw-'));
const { config: { cacheDir: transcoderCacheDir } } = await import('../src/config.ts');
const src = pathMod.join(tmp, 'src.mkv');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine', '-t', '10',
  '-c:v', has('libx265') ? 'libx265' : 'libx264', '-preset', 'ultrafast', ...(has('libx265') ? ['-x265-params', 'log-level=error'] : []), '-c:a', 'aac', src]);
const jobOpts = (o: any = {}) => ({ ...opts({ input: src, sourceHeight: 360, sourceCodec: has('libx265') ? 'hevc' : 'h264', durationSec: 10, bitrate: 2000 }), ...o });

test('job: VA-API without a device falls back to software and reports why', async () => {
  updateSettings({ transcoding: { hwAccel: 'vaapi', vaapiDevice: '/dev/dri/renderD999', segmentSeconds: 4, allowHevcEncoding: true, preferredCodecs: ['hevc', 'h264'] } as any });
  const job = new TranscodeJob('hwfb-' + process.pid, jobOpts({ videoCodec: 'hevc' }) as any);
  let changed = 0;
  // Fallback ladder: each restart's reason, in order.
  const reasons: string[] = [];
  const start = job.start.bind(job);
  job.start = (n?: number) => { start(n); reasons.push(job.info?.hwFallback ?? ''); };
  job.onInfoChange = () => changed++;
  job.start(0);
  try {
    await job.waitForSegment(0, 30000);
    assert.equal(job.info!.hwAccel, 'none');
    assert.equal(job.info!.videoCodec, 'libx264');
    assert.match(job.info!.hwFallback ?? '', /vaapi failed, used software/);
    assert.ok(changed >= 1);
    if (hasEncoder('hevc_vaapi')) {
      // HEVC → H.264 on VA-API → VA-API encode with CPU decode → software.
      assert.match(reasons[1], /vaapi HEVC encoding failed, used vaapi H\.264/);
      assert.match(reasons[2], /vaapi hardware decoding failed, decoded on the CPU and encoded with vaapi/);
      assert.match(reasons[3], /vaapi failed, used software/);
      // HEVC was requested, so segments are fMP4 — the software H.264 fallback keeps that container.
      assert.equal(job.segmentType, 'fmp4');
      const init = await job.initSegment(10000);
      assert.ok(fs.statSync(init).size > 100);
      assert.match(job.vodPlaylist('?t=1'), /#EXT-X-MAP:URI="init\.mp4\?t=1"[\s\S]*seg0\.m4s\?t=1/);
    }
  } finally {
    job.stop();
    updateSettings({ transcoding: { hwAccel: 'none', vaapiDevice: DEV } as any });
  }
});

test('job: HEVC remux produces fMP4 HLS with an init segment', { skip: !has('libx265') && 'no libx265' }, async () => {
  const job = new TranscodeJob('remux-' + process.pid, jobOpts({ mode: 'remux', videoCopy: true, audioCopy: true }) as any);
  job.start(0);
  try {
    await job.waitForPlaylist(30000);
    assert.equal(job.segmentType, 'fmp4');
    const init = await job.initSegment(10000);
    const pl = job.rewrittenPlaylist('?k=1');
    assert.match(pl, /#EXT-X-MAP:URI="init\.mp4\?k=1"/);
    assert.match(pl, /seg0\.m4s\?k=1/);
    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_tag_string', '-of', 'csv=p=0', init]).toString();
    assert.match(probe, /hevc,hvc1/);
  } finally {
    job.stop();
  }
});

test('per-rendition video args (adaptive streaming) and encoder session limits', () => {
  const r = hwa.buildRenditionVideoArgs({ target: T('nvenc'), codec: 'hevc', height: 720, sourceHeight: 1080, bitrateKbps: 4000, toneMap: null, preset: 'veryfast', threads: 0, segmentSeconds: 4 });
  assert.deepEqual(r.inputArgs, hwInputArgs(T('nvenc'), 'full', true));
  assert.deepEqual(r.filters, ['format=nv12|p010le|cuda', 'hwupload', 'scale_cuda=w=-2:h=720:format=nv12']);
  assert.deepEqual(r.videoArgs, ['-c:v', 'hevc_nvenc', '-preset', 'p4', '-forced-idr', '1', '-tag:v', 'hvc1', '-b:v', '2600k', '-maxrate', '2600k', '-bufsize', '5200k', '-force_key_frames', 'expr:gte(t,n_forced*4)', '-sc_threshold', '0']);
  assert.equal(r.bitrateKbps, 2600);
  assert.equal(hwa.maxEncoderSessions('nvenc', 'NVIDIA GeForce RTX 3060'), 8);
  assert.equal(hwa.maxEncoderSessions('nvenc', 'Quadro P2000'), null);
  assert.equal(hwa.maxEncoderSessions('vaapi'), null);
});

/* ------------------ live / VOD keyframes, levels, DV 5 ------------------ */

test('buildArgs: live encodes use time-based keyframes (no 25 fps assumption), zerolatency and CPU auto-deinterlace', () => {
  updateSettings({ transcoding: { hwAccel: 'none', segmentSeconds: 4, preset: 'veryfast', threads: 0, toneMapHdr: true } as any });
  const live = buildArgs(opts({ mode: 'live', input: 'http://x/y.ts', sourceHeight: 1080 }) as any, '/t', 0, 'none');
  assert.ok(!live.args.includes('-g'));
  const k = live.args.indexOf('-force_key_frames');
  assert.deepEqual(live.args.slice(k, k + 4), ['-force_key_frames', 'expr:gte(t,n_forced*4)', '-sc_threshold', '0']);
  assert.ok(live.args.includes('zerolatency'));
  assert.equal(live.args[live.args.indexOf('-vf') + 1], 'bwdif=mode=send_frame:parity=auto:deint=interlaced,format=yuv420p');
  // A live input known to be progressive: no deinterlacer.
  const prog = buildArgs(opts({ mode: 'live', input: 'http://x/y.ts', sourceHeight: 1080, fieldOrder: 'progressive' }) as any, '/t', 0, 'none');
  assert.equal(prog.args[prog.args.indexOf('-vf') + 1], 'format=yuv420p');
});

test('buildArgs: VOD GOP from the probed frame rate (doubled by field-rate deinterlacing), level 5.1 above 1080p', () => {
  const vr = (o: any = {}) => ({ hdrFormat: 'sdr', fallback: null, label: 'SDR', bitDepth: 8, pixFmt: 'yuv420p', codecProfile: null, colorTransfer: null, colorPrimaries: null, colorSpace: null, frameRate: 25, dolbyVision: null, masteringDisplay: null, contentLight: null, ...o });
  const a = buildArgs(opts({ videoRange: vr(), sourceHeight: 1080 }) as any, '/t', 0, 'none').args;
  assert.deepEqual(a.slice(a.indexOf('-g'), a.indexOf('-g') + 4), ['-g', '100', '-keyint_min', '100']);
  assert.ok(!a.includes('zerolatency'));
  const i = buildArgs(opts({ videoRange: vr({ fieldOrder: 'tt' }), sourceHeight: 1080 }) as any, '/t', 0, 'none').args;
  assert.equal(i[i.indexOf('-g') + 1], '200');
  assert.equal(i[i.indexOf('-level') + 1], '4.2'); // 1080p50 after deinterlacing
  assert.match(i[i.indexOf('-vf') + 1], /^bwdif=mode=send_field:parity=auto:deint=interlaced,/);
  const uhd = buildArgs(opts({ bitrate: 40000, sourceHeight: 2160 }) as any, '/t', 0, 'none').args;
  assert.equal(uhd[uhd.indexOf('-level') + 1], '5.1');
  // VA-API with a probed interlaced source: GPU deinterlacing before the scaler.
  const va = buildArgs(opts({ videoRange: vr({ fieldOrder: 'bb' }) }) as any, '/t', 0, { hw: 'vaapi', codec: 'h264', toneMap: null, platform: 'linux' }).args;
  assert.equal(va[va.indexOf('-vf') + 1], 'format=nv12|p010le|vaapi,hwupload,deinterlace_vaapi=rate=field,scale_vaapi=w=-2:h=1080:format=nv12');
});

const fakeReport = (m: Partial<HwMethodResult>[]) => ({
  ranAt: new Date().toISOString(), durationMs: 1, platform: 'linux', arch: 'x64',
  ffmpeg: { path: 'ffmpeg', version: 'x', hwaccels: [], encoders: [], filters: [] }, devices: [],
  methods: m.map((x) => method(x)), recommendation: { id: 'none:default', hwAccel: 'none' as HwAccel, device: null, gpuIndex: null, reason: '' },
});

test('detect report: Dolby Vision 5 prefers libplacebo once detection saw it work; VA-API low-power flag reaches the encoder', () => {
  const { setDetectReport, pickToneMap, hasFilter: hf } = transcoderMod;
  updateSettings({ transcoding: { hwAccel: 'vaapi', vaapiDevice: DEV, hardwareToneMapping: true, toneMapHdr: true } as any });
  const enc = (works: boolean, extra: any = {}) => ({ works, error: null, fps: 100, encoder: 'x', ...extra });
  setDetectReport(fakeReport([{
    id: 'vaapi:' + DEV, hwAccel: 'vaapi', device: DEV,
    encode: { h264: enc(true, { lowPower: true }), hevc: enc(true), av1: enc(false) } as any,
    toneMapping: { path: 'vaapi', tried: [{ path: 'vaapi', works: true, error: null, fps: 1 }, { path: 'libplacebo', works: true, error: null, fps: 1 }] },
  }]) as any);
  try {
    if (hf('tonemap_vaapi')) assert.equal(pickToneMap('vaapi', 'linux', true), 'vaapi');
    if (hf('libplacebo')) assert.equal(pickToneMap('vaapi', 'linux', true, true), 'libplacebo');
    const a = buildArgs(opts() as any, '/t', 0, { hw: 'vaapi', codec: 'h264', toneMap: null, platform: 'linux' }).args;
    assert.deepEqual(a.slice(a.indexOf('-c:v'), a.indexOf('-c:v') + 4), ['-c:v', 'h264_vaapi', '-low_power', '1']);
    const h = buildArgs(opts() as any, '/t', 0, { hw: 'vaapi', codec: 'hevc', toneMap: null, platform: 'linux' }).args;
    assert.ok(!h.includes('-low_power'));
    if (hf('libplacebo')) {
      const dv = { hdrFormat: 'dolbyvision', fallback: 'none', label: 'Dolby Vision 5', bitDepth: 10, pixFmt: 'yuv420p10le', codecProfile: null, colorTransfer: null, colorPrimaries: null, colorSpace: null, frameRate: 24, masteringDisplay: null, contentLight: null, dolbyVision: { profile: 5, level: 6, blCompatId: 0, rpu: true, el: false, bl: true } };
      const d = buildArgs(opts({ hdr: true, toneMap: true, videoRange: dv }) as any, '/t', 0, { hw: 'vaapi', codec: 'h264', platform: 'linux' });
      assert.equal(d.info.toneMap, 'libplacebo');
      assert.match(d.args[d.args.indexOf('-vf') + 1], /^libplacebo=/);
    }
  } finally {
    setDetectReport(null);
    updateSettings({ transcoding: { hwAccel: 'none' } as any });
  }
});

test('detect report is persisted, keyed on device settings + ffmpeg build, and never auto-runs under node --test', () => {
  const { setDetectReport, getDetectReport, loadDetectReport, autoDetectEnabled, detectCacheKey } = transcoderMod;
  assert.equal(autoDetectEnabled(), false);
  updateSettings({ transcoding: { hwAccel: 'vaapi', vaapiDevice: DEV } as any });
  const file = pathMod.join(transcoderCacheDir, 'hwdetect', 'report.json');
  try {
    const r = fakeReport([{ id: 'vaapi:' + DEV, hwAccel: 'vaapi', device: DEV }]);
    setDetectReport(r as any);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.key, detectCacheKey());
    assert.match(saved.key, /"ffmpeg":"ffmpeg version /);
    loadDetectReport(); // as after a restart
    assert.equal(getDetectReport()?.ranAt, r.ranAt);
    updateSettings({ transcoding: { vaapiDevice: '/dev/dri/renderD129' } as any });
    assert.equal(getDetectReport(), null); // device changed → stale
    updateSettings({ transcoding: { vaapiDevice: DEV } as any });
    loadDetectReport();
    assert.equal(getDetectReport()?.ranAt, r.ranAt);
    fs.writeFileSync(file, JSON.stringify({ key: saved.key.replace(/ffmpeg version [^"]*/, 'ffmpeg version 0.0'), report: r }));
    loadDetectReport();
    assert.equal(getDetectReport(), null); // other ffmpeg build → stale
  } finally {
    setDetectReport(null);
    updateSettings({ transcoding: { hwAccel: 'none' } as any });
  }
});

test('hdr: interlaced field order is kept with the video range', async () => {
  const { parseVideoRange } = await import('../src/services/hdr.ts');
  assert.equal(parseVideoRange({ codec_type: 'video', field_order: 'tt' })!.fieldOrder, 'tt');
  assert.equal('fieldOrder' in parseVideoRange({ codec_type: 'video', field_order: 'progressive' })!, false);
});

/* --------------- detection commands and local ffmpeg syntax --------------- */

test('detect: decode-only tests need real hardware frames; low-power retry args', async () => {
  assert.deepEqual(det.decodeTestArgs(T('vaapi'), '/s.mp4'), ['-y', ...hwInputArgs(T('vaapi'), 'full', true), '-i', '/s.mp4', '-t', '2', '-an', '-vf', 'hwdownload,format=nv12|p010le', '-f', 'null', '-']);
  assert.deepEqual(det.decodeTestArgs(T('rkmpp'), '/s.mp4', ['nv15'])!.slice(-5), ['-vf', 'hwdownload,format=nv12|p010le|nv15', '-f', 'null', '-']);
  assert.deepEqual(det.decodeTestArgs(T('videotoolbox', 'darwin'), '/s.mp4')!.slice(1, 5), ['-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox_vld']);
  assert.deepEqual(det.decodeTestArgs(T('amf', 'win32', 1), '/s.mp4')!.slice(1, 7), ['-hwaccel', 'd3d11va', '-hwaccel_device', '1', '-hwaccel_output_format', 'd3d11']);
  const lp = det.testArgs(T('vaapi'), { codec: 'h264', input: 'testsrc', toneMap: null, decode: false, lowPower: true });
  assert.deepEqual(lp.slice(lp.indexOf('-c:v'), lp.indexOf('-c:v') + 4), ['-c:v', 'h264_vaapi', '-low_power', '1']);
  // The premise: hwdownload rejects software frames, so a silent fallback to CPU decoding fails the test.
  const swFrames = await det.runFfmpeg(['-y', '-i', src, '-t', '1', '-an', '-vf', 'hwdownload,format=nv12|p010le', '-f', 'null', '-'], 15000);
  assert.equal(swFrames.ok, false);
  const missingDev = await det.runFfmpeg(det.decodeTestArgs({ ...T('vaapi'), vaapiDevice: '/dev/dri/renderD999' }, src)!, 15000);
  assert.equal(missingDev.ok, false);
  assert.match(missingDev.error!, /renderD999|vaapi|Device creation failed/i);
});

test('local ffmpeg accepts the new CPU chains (tone-map with scaling in zscale, bwdif) with identical output size', { skip: !transcoderMod.hasFilter('zscale') && 'no zscale' }, async () => {
  const { hasFilter: hf } = transcoderMod;
  const hdr = pathMod.join(tmp, 'hdr.mkv');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1998x1080:rate=25', '-t', '0.4', '-pix_fmt', 'yuv420p10le',
    '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-c:v', 'ffv1', hdr]);
  const p = buildVideoPipeline({ target: T('none'), codec: 'h264', height: 720, sourceHeight: 1080, toneMap: 'software', decode: true, deinterlace: 'interlaced' });
  const out = pathMod.join(tmp, 'tm.nut');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', hdr, '-vf', p.filters.join(','), '-c:v', 'rawvideo', out]);
  const dims = (f: string) => execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,pix_fmt', '-of', 'csv=p=0', f]).toString().trim();
  const ref = pathMod.join(tmp, 'ref.nut');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', hdr, '-vf', 'scale=-2:720', '-c:v', 'rawvideo', ref]);
  assert.equal(dims(ref).split(',').slice(0, 2).join(','), '1332,720');
  assert.equal(dims(out), '1332,720,yuv420p'); // same size as the old tone-map → scale=-2:720 chain
  // The QSV width expression gives the same width as -2 (checked with the software scaler, same expression evaluator).
  const q = pathMod.join(tmp, 'q.nut');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', hdr, '-vf', 'scale=w=round(iw*720/ih/2)*2:h=720', '-c:v', 'rawvideo', q]);
  assert.equal(dims(q).split(',').slice(0, 2).join(','), '1332,720');
  if (hf('bwdif')) {
    // Live "auto" deinterlacing passes progressive frames through: same frame count and rate.
    const n = (vf: string) => execFileSync('ffprobe', ['-v', 'error', '-f', 'lavfi', '-i', `movie=${src.replace(/[\\':]/g, '\\$&')},${vf}`, '-count_frames', '-show_entries', 'stream=nb_read_frames,r_frame_rate', '-of', 'csv=p=0']).toString().trim();
    assert.equal(n(hwa.cpuDeinterlace('auto')), n('null'));
  }
});

test('local ffmpeg parses every GPU filter the pipelines build (only missing-device/format errors, no option errors)', async () => {
  const { hasFilter: hf, ffmpegFeatures } = transcoderMod;
  const chains = new Set<string>();
  for (const hw of ['vaapi', 'qsv', 'nvenc'] as HwAccel[]) {
    for (const tm of [null, ...hwa.hwToneMapPaths(hw, 'linux')]) {
      for (const deinterlace of [null, 'interlaced'] as const) {
        const p = buildVideoPipeline({ target: T(hw), codec: 'h264', height: 720, sourceHeight: 1080, toneMap: tm, decode: true, deinterlace, features: ffmpegFeatures() });
        for (const f of p.filters) if (!/^(format|hwupload|hwmap)=?/.test(f) && f !== 'hwupload') chains.add(f);
      }
    }
  }
  let checked = 0;
  for (const f of chains) {
    if (!hf(f.split('=')[0])) continue;
    const r = await det.runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=25', '-t', '0.1', '-vf', f, '-f', 'null', '-'], 15000);
    assert.doesNotMatch(r.error ?? '', /Option not found|Unable to parse option|Invalid argument.*option|Undefined constant/i, f);
    checked++;
  }
  assert.ok(checked > 0 || !hf('scale_vaapi'));
});
