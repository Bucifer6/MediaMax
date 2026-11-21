import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HwAccel, HwDevice, HwMethodResult, ToneMapPath, TranscodeVideoCodec } from '@mediamax/shared';

const hwa = await import('../src/services/hwaccel.ts');
const { buildVideoPipeline, encoderArgs, chooseVideoCodec, codecBitrate, toneMapCandidates, hwInputArgs, ENCODERS, softwareToneMap } = hwa;
const { buildArgs, shouldToneMap, hasEncoder } = await import('../src/services/transcoder.ts');
const det = await import('../src/services/hwdetect.ts');
const { transcodeCodecFor } = await import('../src/services/playback.ts');
const { updateSettings } = await import('../src/services/settings.ts');

const DEV = '/dev/dri/renderD128';
const T = (hw: HwAccel, platform = 'linux', gpuIndex = 0) => ({ hw, platform, vaapiDevice: DEV, gpuIndex });
const SW_TM = softwareToneMap('software');
const PLACEBO = 'libplacebo=tonemapping=bt.2390:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:format=yuv420p';
const OPENCL = (back: string, fmt: string) => [
  'hwmap=derive_device=opencl:mode=read', 'tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=bt2390:desat=0',
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
    const pre = etm === 'libplacebo' ? [PLACEBO] : etm ? SW_TM : [];
    const tail: Record<string, string[]> = {
      vaapi: ['format=nv12', 'hwupload'], nvenc: ['format=nv12', 'hwupload'], qsv: ['format=nv12', 'hwupload=extra_hw_frames=64'],
      videotoolbox: ['format=yuv420p'], v4l2m2m: ['format=yuv420p'], amf: ['format=nv12'], rkmpp: ['format=nv12'],
    };
    return { mode: 'hybrid', filters: [...pre, `scale=-2:${H}`, ...tail[hw]], toneMap: etm };
  };
  if (hw === 'none') {
    const etm: ToneMapPath | null = tm ? (tm === 'libplacebo' ? 'libplacebo' : 'software') : null;
    return { mode: 'software', filters: [...(etm === 'libplacebo' ? [PLACEBO] : etm ? SW_TM : []), `scale=-2:${H}`, 'format=yuv420p'], toneMap: etm };
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
        filters: [`format=nv12|p010le|${win ? 'd3d11' : 'vaapi'}`, 'hwupload', ...pre, 'hwmap=derive_device=qsv', 'format=qsv', ...(tm === 'qsv' ? ['vpp_qsv=tonemap=1:format=nv12'] : []), `scale_qsv=w=-1:h=${H}:format=nv12`],
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
  assert.deepEqual(p.filters, [...SW_TM, 'scale=-2:720', sub, 'format=nv12', 'hwupload']);
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
    libx264: ['-preset', 'veryfast', '-profile:v', 'high', '-level', '4.1', '-tune', 'zerolatency'],
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

test('HEVC/AV1 bitrate is ~60-70% of H.264', () => {
  assert.equal(codecBitrate(8000, 'h264'), 8000);
  assert.equal(codecBitrate(8000, 'hevc'), 5200);
  assert.equal(codecBitrate(8000, 'av1'), 4800);
});

test('tone-mapping candidates per accelerator', () => {
  assert.deepEqual(toneMapCandidates('vaapi', 'linux'), ['vaapi', 'opencl', 'software', 'libplacebo']);
  assert.deepEqual(toneMapCandidates('qsv', 'linux'), ['qsv', 'vaapi', 'opencl', 'software', 'libplacebo']);
  assert.deepEqual(toneMapCandidates('qsv', 'win32'), ['qsv', 'software', 'libplacebo']);
  assert.deepEqual(toneMapCandidates('nvenc', 'linux'), ['cuda', 'software', 'libplacebo']);
  assert.deepEqual(toneMapCandidates('rkmpp', 'linux'), ['opencl', 'software', 'libplacebo']);
  for (const hw of ['none', 'amf', 'videotoolbox', 'v4l2m2m'] as HwAccel[]) assert.deepEqual(toneMapCandidates(hw, 'linux'), ['software', 'libplacebo']);
  assert.deepEqual(toneMapCandidates('vaapi', 'linux', false), ['software', 'libplacebo']);
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
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-level', '4.1', '-tune', 'zerolatency',
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
  assert.ok(!ov.args.includes('-hwaccel'));
  const q = buildArgs(opts() as any, '/t', 0, { hw: 'qsv', codec: 'h264', toneMap: null, platform: 'win32' });
  assert.equal(q.args[q.args.indexOf('-vf') + 1], 'format=nv12|p010le|d3d11,hwupload,hwmap=derive_device=qsv,format=qsv,scale_qsv=w=-1:h=1080:format=nv12');
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
const src = pathMod.join(tmp, 'src.mkv');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine', '-t', '10',
  '-c:v', has('libx265') ? 'libx265' : 'libx264', '-preset', 'ultrafast', ...(has('libx265') ? ['-x265-params', 'log-level=error'] : []), '-c:a', 'aac', src]);
const jobOpts = (o: any = {}) => ({ ...opts({ input: src, sourceHeight: 360, sourceCodec: has('libx265') ? 'hevc' : 'h264', durationSec: 10, bitrate: 2000 }), ...o });

test('job: VA-API without a device falls back to software and reports why', async () => {
  updateSettings({ transcoding: { hwAccel: 'vaapi', vaapiDevice: '/dev/dri/renderD999', segmentSeconds: 4, allowHevcEncoding: true, preferredCodecs: ['hevc', 'h264'] } as any });
  const job = new TranscodeJob('hwfb-' + process.pid, jobOpts({ videoCodec: 'hevc' }) as any);
  let changed = 0;
  job.onInfoChange = () => changed++;
  job.start(0);
  try {
    await job.waitForSegment(0, 30000);
    assert.equal(job.info!.hwAccel, 'none');
    assert.equal(job.info!.videoCodec, 'libx264');
    assert.match(job.info!.hwFallback ?? '', /vaapi failed, used software/);
    assert.ok(changed >= 1);
    if (hasEncoder('hevc_vaapi')) {
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
