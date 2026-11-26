/**
 * Pure ffmpeg argument builders for hardware (and software) video pipelines.
 *
 * Nothing in here touches the filesystem or spawns processes, so every accelerator × codec × tone-mapping
 * combination can be unit tested (test/hwaccel.test.ts) without the hardware. The transcoder and the
 * hardware detection both build their commands from these functions, so what the detect step tests is
 * what playback runs.
 *
 * Two pipeline shapes:
 *  - full:   decode to GPU surfaces → GPU filters (scale, tone-map) → GPU encode. Used for VA-API, QSV, NVENC
 *            and RKMPP when no CPU-only filter (subtitle burn-in, CPU tone-mapping) is needed.
 *  - hybrid: (optional) hardware decode that downloads frames → CPU filters → upload when the encoder needs
 *            surfaces → hardware encode. Used for burn-in, CPU tone-mapping, and for accelerators that take
 *            system-memory frames anyway (VideoToolbox, AMF, V4L2 M2M).
 */
import type { HwAccel, ToneMapPath, TranscodeVideoCodec } from '@mediamax/shared';

export interface HwTarget {
  hw: HwAccel;
  platform: NodeJS.Platform | string;
  /** Linux render node for VA-API / QSV. */
  vaapiDevice: string;
  /** GPU / adapter index for NVENC, and QSV / AMF on Windows. */
  gpuIndex: number;
}

export const HW_LABELS: Record<HwAccel, string> = {
  none: 'Software (CPU)',
  vaapi: 'VA-API (Intel/AMD, Linux)',
  nvenc: 'NVIDIA NVENC',
  qsv: 'Intel Quick Sync',
  videotoolbox: 'Apple VideoToolbox',
  v4l2m2m: 'V4L2 M2M (Raspberry Pi / ARM)',
  amf: 'AMD AMF (Windows)',
  rkmpp: 'Rockchip MPP (RK3588 …)',
};

/** Encoder per accelerator and output codec. Missing entries = the hardware has no such encoder. */
export const ENCODERS: Record<HwAccel, Partial<Record<TranscodeVideoCodec, string>>> = {
  none: { h264: 'libx264', hevc: 'libx265', av1: 'libsvtav1' },
  vaapi: { h264: 'h264_vaapi', hevc: 'hevc_vaapi', av1: 'av1_vaapi' },
  nvenc: { h264: 'h264_nvenc', hevc: 'hevc_nvenc', av1: 'av1_nvenc' },
  qsv: { h264: 'h264_qsv', hevc: 'hevc_qsv', av1: 'av1_qsv' },
  videotoolbox: { h264: 'h264_videotoolbox', hevc: 'hevc_videotoolbox' },
  v4l2m2m: { h264: 'h264_v4l2m2m', hevc: 'hevc_v4l2m2m' },
  amf: { h264: 'h264_amf', hevc: 'hevc_amf', av1: 'av1_amf' },
  rkmpp: { h264: 'h264_rkmpp', hevc: 'hevc_rkmpp' },
};

export const encoderFor = (hw: HwAccel, codec: TranscodeVideoCodec): string | null => ENCODERS[hw][codec] ?? null;

/** HEVC/AV1 reach the same quality as H.264 at roughly 60–70% of the bitrate. */
export const CODEC_BITRATE_FACTOR: Record<TranscodeVideoCodec, number> = { h264: 1, hevc: 0.65, av1: 0.6 };
export const codecBitrate = (h264Kbps: number, codec: TranscodeVideoCodec) => Math.max(200, Math.round(h264Kbps * CODEC_BITRATE_FACTOR[codec]));

/** Accelerators whose decoder can hand GPU surfaces straight to GPU filters (the "full" pipeline). */
const SURFACES: Partial<Record<HwAccel, true>> = { vaapi: true, qsv: true, nvenc: true, rkmpp: true };

/* --------------------------- tone mapping ---------------------------- */

/** ffmpeg filters each tone-mapping path needs. */
export const TONEMAP_FILTERS: Record<ToneMapPath, string[]> = {
  software: ['zscale', 'tonemap'],
  libplacebo: ['libplacebo'],
  vaapi: ['tonemap_vaapi'],
  opencl: ['tonemap_opencl', 'hwmap'],
  qsv: ['vpp_qsv'],
  cuda: ['tonemap_cuda'],
};

/** GPU tone-mapping paths that run inside the full pipeline of an accelerator. */
export function hwToneMapPaths(hw: HwAccel, platform: string): ToneMapPath[] {
  switch (hw) {
    case 'vaapi': return ['vaapi', 'opencl'];
    case 'qsv': return platform === 'win32' ? ['qsv'] : ['qsv', 'vaapi', 'opencl'];
    case 'nvenc': return ['cuda'];
    case 'rkmpp': return ['opencl'];
    default: return [];
  }
}

/**
 * Tone-mapping paths to try for an accelerator, best first. libplacebo (Vulkan) and the CPU path work with any of them;
 * libplacebo comes before the zscale/tonemap CPU path (better quality, applies Dolby Vision reshaping, runs on the GPU),
 * but callers only use it once the detect step has seen it work (pickToneMap), so without Vulkan the CPU path is used.
 */
export function toneMapCandidates(hw: HwAccel, platform: string, allowHardware = true): ToneMapPath[] {
  const hwPaths = allowHardware ? hwToneMapPaths(hw, platform) : [];
  return [...hwPaths, 'libplacebo', 'software'];
}

export const isHwToneMap = (path: ToneMapPath | null, hw: HwAccel, platform: string) => !!path && hwToneMapPaths(hw, platform).includes(path);

/**
 * CPU-side tone-mapping filters (software frames in, 8-bit BT.709 yuv420p out). With `height`, the zscale/tonemap path
 * downscales in its first zscale, so the float (gbrpf32le) tone-mapping runs at the output size, not the source size
 * (4K → 1080p HDR: ~35 fps instead of ~6 fps); the caller then adds no separate scale filter.
 */
/** The source's probed colour properties (media.videoRange): ffprobe names (smpte2084, bt2020, bt2020nc …). */
export interface SourceColor { transfer?: string | null; primaries?: string | null; matrix?: string | null }

const ZSCALE_TRANSFER = new Set(['smpte2084', 'arib-std-b67']);
const ZSCALE_PRIMARIES = new Set(['bt2020', 'bt709']);
const ZSCALE_MATRIX: Record<string, string> = { bt2020nc: '2020_ncl', bt2020c: '2020_cl', bt709: '709' };
/**
 * Explicit zscale colour properties for HDR sources, so the conversion doesn't depend on frame colour tags. zscale
 * takes any property it isn't given from the incoming frame, for the output too (vf_zscale.c format_init): with
 * untagged frames the input became "unspecified" (or, with only the input set, the output primaries did), and zimg
 * has no path between a specified and an unspecified colorspace. So the input transfer / primaries / matrix / range
 * are set, and the output primaries stay the source's (the next zscale converts them to BT.709).
 * Empty when the probe didn't record a known HDR transfer (then the frame tags are used, as before).
 */
function zscaleInput(src: SourceColor | null): string {
  if (!src?.transfer || !ZSCALE_TRANSFER.has(src.transfer)) return '';
  const out = [`tin=${src.transfer}`, 'rin=tv'];
  if (src.primaries && ZSCALE_PRIMARIES.has(src.primaries)) out.push(`pin=${src.primaries}`, `p=${src.primaries}`);
  const m = src.matrix ? ZSCALE_MATRIX[src.matrix] : undefined;
  if (m) out.push(`min=${m}`);
  return `${out.join(':')}:`;
}

export function softwareToneMap(path: 'software' | 'libplacebo', height: number | null = null, src: SourceColor | null = null): string[] {
  if (path === 'libplacebo') return ['libplacebo=tonemapping=bt.2390:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:format=yuv420p'];
  const input = zscaleInput(src);
  return [height ? `zscale=w=-2:h=${height}:f=bilinear:${input}t=linear:npl=100` : `zscale=${input}t=linear:npl=100`, 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv', 'format=yuv420p'];
}

/**
 * OpenCL tone-mapping. `tonemap=bt2390` only exists in jellyfin-ffmpeg's tonemap_opencl; stock FFmpeg (5.1 … 7.x) only
 * has none|linear|gamma|clip|reinhard|hable|mobius and rejects the whole filter graph otherwise, so bt2390 is used only
 * when the build lists it (ffmpegFeatures().openclBt2390, from `ffmpeg -h filter=tonemap_opencl`).
 */
const openclToneMap = (back: 'vaapi' | 'rkmpp', bt2390: boolean) => [
  'hwmap=derive_device=opencl:mode=read',
  `tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=${bt2390 ? 'bt2390' : 'hable'}:desat=0`,
  `hwmap=derive_device=${back}:mode=write:reverse=1`,
  `format=${back === 'vaapi' ? 'vaapi' : 'drm_prime'}`,
];

/* ---------------------------- deinterlacing --------------------------- */

/**
 * - 'interlaced': the source was probed as interlaced (ffprobe field_order tt/bb/tb/bt): deinterlace to field rate
 *   (50i → 50p) on the GPU in the full pipeline, with bwdif on the CPU otherwise.
 * - 'auto': field order unknown (live TV): CPU/hybrid paths add bwdif in send_frame mode with deint=interlaced, which
 *   passes progressive frames through untouched (same frames, same frame rate — send_field would double the declared
 *   rate and make ffmpeg duplicate every progressive frame). Full GPU pipelines add nothing.
 */
export type DeinterlaceMode = 'interlaced' | 'auto' | null;

export const isInterlacedFieldOrder = (fieldOrder: string | null | undefined) => !!fieldOrder && /^(tt|bb|tb|bt)$/.test(fieldOrder);

/** GPU deinterlacer filter per full-pipeline accelerator (none for RKMPP: interlaced sources use the hybrid path). */
export const HW_DEINTERLACE_FILTER: Partial<Record<HwAccel, string>> = { vaapi: 'deinterlace_vaapi', qsv: 'vpp_qsv', nvenc: 'yadif_cuda' };

export function cpuDeinterlace(mode: Exclude<DeinterlaceMode, null>): string {
  return `bwdif=mode=${mode === 'interlaced' ? 'send_field' : 'send_frame'}:parity=auto:deint=interlaced`;
}

/* ----------------------------- pipeline ------------------------------ */

export interface PipelineInput {
  target: HwTarget;
  /** Probed colour properties of the source (explicit input for CPU tone-mapping). */
  sourceColor?: SourceColor | null;
  codec: TranscodeVideoCodec;
  /** Output height; null keeps the source height. */
  height: number | null;
  sourceHeight: number | null;
  /** Tone-map HDR → SDR with this path (null = no tone-mapping). */
  toneMap: ToneMapPath | null;
  /** Filters that must run on CPU frames (subtitle burn-in), placed after scaling. */
  swFilters?: string[];
  /** Use the hardware decoder (false for lavfi test sources, and after a hardware decode failure). */
  decode: boolean;
  /** CPU filters run ahead of this chain (image-subtitle overlay in a filter_complex): forces the hybrid pipeline. */
  cpuFrames?: boolean;
  /** Deinterlace (see DeinterlaceMode). */
  deinterlace?: DeinterlaceMode;
  /** What this ffmpeg build supports (see FfmpegFeatures); defaults assume a stock build. */
  features?: FfmpegFeatures;
}

/** Build-dependent filter capabilities the pipeline needs to know about. */
export interface FfmpegFeatures {
  /** tonemap_opencl accepts tonemap=bt2390 (jellyfin-ffmpeg); stock FFmpeg uses hable. */
  openclBt2390?: boolean;
  /** Whether a filter is in this build (used for the GPU deinterlacers); default: assume present. */
  hasFilter?: (name: string) => boolean;
}

export interface VideoPipeline {
  mode: 'full' | 'hybrid' | 'software';
  /** Arguments that go before `-i`. */
  inputArgs: string[];
  /** Video filter chain (join with "," for -vf, or append to a filter_complex chain). */
  filters: string[];
  encoder: string;
  /** The tone-mapping path actually used (hardware paths fall back to CPU in the hybrid pipeline). */
  toneMap: ToneMapPath | null;
  /** The deinterlacer outputs one frame per field (frame rate doubled): keyframe intervals in frames double too. */
  fieldRate: boolean;
}

/** Arguments before -i: device creation and (optionally) hardware decoding. */
export function hwInputArgs(t: HwTarget, mode: 'full' | 'hybrid', decode: boolean): string[] {
  const win = t.platform === 'win32';
  const idx = String(t.gpuIndex ?? 0);
  const full = mode === 'full';
  switch (t.hw) {
    case 'vaapi': {
      const a = ['-init_hw_device', `vaapi=va:${t.vaapiDevice}`, '-filter_hw_device', 'va'];
      if (decode) a.push('-hwaccel', 'vaapi', '-hwaccel_device', 'va', ...(full ? ['-hwaccel_output_format', 'vaapi'] : []));
      return a;
    }
    case 'qsv': {
      if (win) {
        const a = ['-init_hw_device', `d3d11va=dx11:${idx}`, '-init_hw_device', 'qsv=qs@dx11', '-filter_hw_device', full ? 'dx11' : 'qs'];
        if (decode) a.push('-hwaccel', 'd3d11va', '-hwaccel_device', 'dx11', ...(full ? ['-hwaccel_output_format', 'd3d11'] : []));
        return a;
      }
      const a = ['-init_hw_device', `vaapi=va:${t.vaapiDevice}`, '-init_hw_device', 'qsv=qs@va', '-filter_hw_device', full ? 'va' : 'qs'];
      if (decode) a.push('-hwaccel', 'vaapi', '-hwaccel_device', 'va', ...(full ? ['-hwaccel_output_format', 'vaapi'] : []));
      return a;
    }
    case 'nvenc': {
      const a = ['-init_hw_device', `cuda=cu:${idx}`, '-filter_hw_device', 'cu'];
      if (decode) a.push('-hwaccel', 'cuda', '-hwaccel_device', 'cu', ...(full ? ['-hwaccel_output_format', 'cuda'] : []));
      return a;
    }
    case 'rkmpp':
      return decode ? ['-hwaccel', 'rkmpp', ...(full ? ['-hwaccel_output_format', 'drm_prime'] : [])] : [];
    case 'amf':
      return decode ? ['-hwaccel', 'd3d11va', '-hwaccel_device', idx] : [];
    case 'videotoolbox':
      return decode ? ['-hwaccel', 'videotoolbox'] : [];
    default:
      return []; // v4l2m2m: software decode, the M2M encoder takes system-memory frames
  }
}

/** GPU scaling filter for the full pipeline (always outputs 8-bit 4:2:0). */
function hwScale(hw: HwAccel, h: number | null): string {
  switch (hw) {
    case 'vaapi': return h ? `scale_vaapi=w=-2:h=${h}:format=nv12` : 'scale_vaapi=format=nv12';
    // scale_qsv/vpp_qsv reject -2 ("Size values less than -1 are not acceptable", FFmpeg 5.1 … 7.1) and -1 can give an
    // odd width: compute the aspect-preserving width rounded to even (same result as -2 in the other scalers).
    case 'qsv': return h ? `scale_qsv=w=round(iw*${h}/ih/2)*2:h=${h}:format=nv12` : 'scale_qsv=format=nv12';
    case 'nvenc': return h ? `scale_cuda=w=-2:h=${h}:format=nv12` : 'scale_cuda=format=nv12';
    case 'rkmpp': return h ? `scale_rkrga=w=-2:h=${h}:format=nv12` : 'scale_rkrga=format=nv12';
    default: throw new Error(`no GPU scaler for ${hw}`);
  }
}

/** GPU tone-mapping filters for the full pipeline. */
function hwToneMap(hw: HwAccel, path: ToneMapPath, f: FfmpegFeatures, qsvDeinterlace = false): string[] {
  switch (path) {
    case 'vaapi': return ['tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709'];
    case 'qsv': return [`vpp_qsv=${qsvDeinterlace ? 'deinterlace=2:' : ''}tonemap=1:format=nv12`];
    // tonemap_cuda only exists in jellyfin-ffmpeg (the 'cuda' path needs it in the filter list), which has bt2390.
    case 'cuda': return ['tonemap_cuda=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=bt2390'];
    case 'opencl': return openclToneMap(hw === 'rkmpp' ? 'rkmpp' : 'vaapi', !!f.openclBt2390);
    default: throw new Error(`${path} is not a GPU tone-mapping path`);
  }
}

/**
 * Build the video side of a transcode. With `hw: 'none'` this is the CPU pipeline (libx264 by default).
 * Throws when the accelerator has no encoder for the codec.
 */
export function buildVideoPipeline(p: PipelineInput): VideoPipeline {
  const { target: t, codec } = p;
  const hw = t.hw;
  const encoder = encoderFor(hw, codec);
  if (!encoder) throw new Error(`${HW_LABELS[hw]} cannot encode ${codec}`);
  const swFilters = p.swFilters ?? [];
  const h = p.height;
  const needScale = !!h && (!p.sourceHeight || h < p.sourceHeight);
  const f = p.features ?? {};
  const deint = p.deinterlace ?? null;

  /** CPU chain: deinterlace → tone-map (scaling inside zscale) or scale → CPU-only filters. */
  const cpuChain = (tm: 'software' | 'libplacebo' | null): string[] => [
    ...(deint ? [cpuDeinterlace(deint)] : []),
    ...(tm ? softwareToneMap(tm, tm === 'software' && needScale ? h : null, p.sourceColor ?? null) : []),
    ...(needScale && tm !== 'software' ? [`scale=-2:${h}`] : []),
    ...swFilters,
  ];

  if (hw === 'none') {
    const tm = p.toneMap === 'software' || p.toneMap === 'libplacebo' ? p.toneMap : p.toneMap ? 'software' : null;
    const filters = cpuChain(tm);
    if (filters.at(-1) !== 'format=yuv420p') filters.push('format=yuv420p');
    return { mode: 'software', inputArgs: [], filters, encoder, toneMap: tm, fieldRate: deint === 'interlaced' };
  }

  // A probed-interlaced source needs the accelerator's GPU deinterlacer in the full pipeline (else: hybrid with bwdif).
  const gpuDeint = deint === 'interlaced';
  const deintOk = !gpuDeint || (!!HW_DEINTERLACE_FILTER[hw] && (f.hasFilter?.(HW_DEINTERLACE_FILTER[hw]!) ?? true));
  const full = p.decode && !!SURFACES[hw] && swFilters.length === 0 && !p.cpuFrames && deintOk && (p.toneMap === null || isHwToneMap(p.toneMap, hw, t.platform));
  if (full) {
    const filters: string[] = [];
    const win = t.platform === 'win32';
    // Pass decoded surfaces through; frames the GPU could not decode are uploaded instead of failing.
    if (hw === 'vaapi') filters.push('format=nv12|p010le|vaapi', 'hwupload');
    else if (hw === 'nvenc') filters.push('format=nv12|p010le|cuda', 'hwupload');
    else if (hw === 'qsv') filters.push(`format=nv12|p010le|${win ? 'd3d11' : 'vaapi'}`, 'hwupload');
    if (gpuDeint && hw === 'vaapi') filters.push('deinterlace_vaapi=rate=field');
    if (gpuDeint && hw === 'nvenc') filters.push('yadif_cuda=mode=send_field:parity=auto:deint=interlaced');
    // QSV on Linux can tone-map on the VA-API side before mapping to QSV.
    if (hw === 'qsv' && p.toneMap && p.toneMap !== 'qsv') filters.push(...hwToneMap('vaapi', p.toneMap, f));
    if (hw === 'qsv') filters.push('hwmap=derive_device=qsv', 'format=qsv');
    // QSV deinterlaces in vpp_qsv: merged into the tone-mapping vpp_qsv when there is one.
    if (gpuDeint && hw === 'qsv' && p.toneMap !== 'qsv') filters.push('vpp_qsv=deinterlace=2');
    if (p.toneMap && !(hw === 'qsv' && p.toneMap !== 'qsv')) filters.push(...hwToneMap(hw, p.toneMap, f, gpuDeint && hw === 'qsv'));
    filters.push(hwScale(hw, needScale ? h : null));
    // vpp_qsv=deinterlace=2 keeps the frame rate (FFmpeg 5.1's vpp_qsv has no rate=field); VA-API and CUDA output field rate.
    return { mode: 'full', inputArgs: hwInputArgs(t, 'full', true), filters, encoder, toneMap: p.toneMap, fieldRate: gpuDeint && hw !== 'qsv' };
  }

  // Hybrid: CPU filters, then hand frames to the hardware encoder. Hardware decoding (when used) has no
  // -hwaccel_output_format here, so decoded frames arrive in system memory for the CPU filters.
  const tm: 'software' | 'libplacebo' | null = p.toneMap ? (p.toneMap === 'libplacebo' ? 'libplacebo' : 'software') : null;
  const filters = cpuChain(tm);
  if (hw === 'vaapi' || hw === 'nvenc') filters.push('format=nv12', 'hwupload');
  else if (hw === 'qsv') filters.push('format=nv12', 'hwupload=extra_hw_frames=64');
  else if (hw === 'videotoolbox' || hw === 'v4l2m2m') { if (filters.at(-1) !== 'format=yuv420p') filters.push('format=yuv420p'); }
  else filters.push('format=nv12'); // amf, rkmpp
  return { mode: 'hybrid', inputArgs: hwInputArgs(t, 'hybrid', p.decode), filters, encoder, toneMap: tm, fieldRate: deint === 'interlaced' };
}

/* ------------------------------ encoder ------------------------------ */

export interface EncoderOptions {
  /** Target bitrate for this codec (already scaled with codecBitrate). */
  bitrate: number;
  preset: string;
  threads: number;
  /** Live TV: libx264 keeps -tune zerolatency (no lookahead / B-frame delay before the first segment). */
  live?: boolean;
  /** Output height, for the H.264 level (null = unknown / source height). */
  height?: number | null;
  /** Output frame rate when known, for the H.264 level. */
  fps?: number | null;
  /** VA-API / QSV low-power (VDEnc) entrypoint: the only one on Jasper Lake / Alder Lake-N (N100) / Arc (from the detect step). */
  lowPower?: boolean;
}

/** H.264 level for libx264: 4.1 up to 1080p30, 4.2 for 1080p50/60, 5.1 above 1080p. */
export function h264Level(height: number | null | undefined, fps: number | null | undefined): string {
  if (height && height > 1080) return '5.1';
  if (height && height > 720 && fps && fps > 30) return '4.2';
  return '4.1';
}

/** Encoder-specific arguments, starting with -c:v. Rate control and keyframes are added by the caller. */
export function encoderArgs(encoder: string, o: EncoderOptions): string[] {
  const a = ['-c:v', encoder];
  switch (encoder) {
    case 'libx264':
      // -tune zerolatency (no B-frames, no lookahead) costs quality at the same bitrate; VOD gains nothing from it, since
      // a segment is only served once complete. Live keeps it: the first segment is ready a little sooner.
      a.push('-preset', o.preset, '-profile:v', 'high', '-level', h264Level(o.height, o.fps), ...(o.live ? ['-tune', 'zerolatency'] : []));
      if (o.threads > 0) a.push('-threads', String(o.threads));
      break;
    case 'libx265':
      a.push('-preset', o.preset, '-x265-params', 'log-level=error');
      if (o.threads > 0) a.push('-threads', String(o.threads));
      break;
    case 'libsvtav1':
      a.push('-preset', '10');
      break;
    case 'h264_nvenc': case 'hevc_nvenc': case 'av1_nvenc':
      a.push('-preset', 'p4', '-forced-idr', '1');
      break;
    case 'h264_qsv': case 'hevc_qsv': case 'av1_qsv':
      a.push('-preset', 'veryfast', '-forced_idr', '1');
      if (o.lowPower) a.push('-low_power', '1');
      break;
    case 'h264_amf': case 'hevc_amf': case 'av1_amf':
      a.push('-usage', 'transcoding', '-quality', 'speed', '-rc', 'vbr_peak');
      break;
    case 'h264_rkmpp': case 'hevc_rkmpp':
      a.push('-rc_mode', 'VBR');
      break;
    case 'h264_vaapi': case 'hevc_vaapi': case 'av1_vaapi':
      if (o.lowPower) a.push('-low_power', '1');
      break;
    default:
      break; // videotoolbox, v4l2m2m: defaults are fine
  }
  if (encoder.startsWith('hevc_') || encoder === 'libx265') a.push('-tag:v', 'hvc1');
  return a;
}

/** Rate control shared by every encoder. */
export const rateArgs = (kbps: number) => ['-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`];

/** Output frame height: the target height, never above the source (the pipelines never upscale). */
export const outputHeight = (height: number | null, sourceHeight: number | null) => (height && sourceHeight ? Math.min(height, sourceHeight) : height ?? sourceHeight);

/**
 * Keyframes at every segment boundary (time-based, so it works without knowing the frame rate, live included), no
 * scene-cut keyframes, and — when the frame rate is known — a GOP of exactly one segment: V4L2 M2M and VideoToolbox
 * otherwise default to a 12-frame GOP, and other encoders would add keyframes inside segments.
 */
export function keyframeArgs(segmentSeconds: number, fps: number | null | undefined): string[] {
  const a = ['-force_key_frames', `expr:gte(t,n_forced*${segmentSeconds})`, '-sc_threshold', '0'];
  const gop = fps && fps > 0 ? Math.round(fps * segmentSeconds) : 0;
  if (gop > 0) a.push('-g', String(gop), '-keyint_min', String(gop));
  return a;
}

/* ---------------------------- codec choice --------------------------- */

const normCodec = (c: string) => c.toLowerCase().replace('h265', 'hevc').replace('avc', 'h264').replace('hvc1', 'hevc').replace('hev1', 'hevc').replace('av01', 'av1');

export interface CodecChoiceInput {
  /** The client's DeviceProfile.videoCodecs (undefined = server default, H.264 only). */
  clientCodecs: string[] | undefined;
  preferred: TranscodeVideoCodec[];
  allowHevc: boolean;
  allowAv1: boolean;
  hw: HwAccel;
  /** Whether this ffmpeg build / the detect step says the hardware encoder for this codec works. */
  codecWorks: (codec: TranscodeVideoCodec) => boolean;
}

/**
 * Pick the output codec for a transcode: the first preferred codec the client plays that the configured
 * hardware encoder can produce. HEVC/AV1 are never encoded on the CPU (too slow for real time); H.264 is the fallback.
 */
export function chooseVideoCodec(i: CodecChoiceInput): TranscodeVideoCodec {
  if (i.hw === 'none') return 'h264';
  const client = new Set((i.clientCodecs ?? ['h264']).map(normCodec));
  const order = [...i.preferred.filter((c) => c !== 'h264'), 'h264' as const];
  for (const c of order) {
    if (c === 'h264') return 'h264';
    if (c === 'hevc' && !i.allowHevc) continue;
    if (c === 'av1' && !i.allowAv1) continue;
    if (!client.has(c)) continue;
    if (encoderFor(i.hw, c) && i.codecWorks(c)) return c;
  }
  return 'h264';
}

/** HEVC/AV1 need fragmented-MP4 HLS segments (Safari, Chrome/Edge via hls.js, AVPlayer); H.264 stays on MPEG-TS. */
export const needsFmp4 = (codec: string | null) => codec === 'hevc' || codec === 'av1';

/* ------------------------- per-rendition helper ------------------------ */

export interface RenditionInput {
  target: HwTarget;
  codec: TranscodeVideoCodec;
  /** Output height (null keeps the source height; never upscales). */
  height: number | null;
  sourceHeight: number | null;
  /** H.264-equivalent target bitrate; scaled for HEVC/AV1 with codecBitrate(). */
  bitrateKbps: number;
  toneMap: ToneMapPath | null;
  preset: string;
  threads: number;
  /** Keyframe interval in seconds, aligned across renditions (forced keyframes at n × segmentSeconds). */
  segmentSeconds: number;
  swFilters?: string[];
  decode?: boolean;
  /** Source frame rate when known (GOP length and H.264 level). */
  frameRate?: number | null;
  deinterlace?: DeinterlaceMode;
  features?: FfmpegFeatures;
  lowPower?: boolean;
}

/**
 * Everything ffmpeg needs for one video rendition at a given resolution/bitrate: input (device) args, the filter
 * chain, and encoder + rate-control + aligned-keyframe args. Call once per rendition (adaptive streaming ladders).
 */
export function buildRenditionVideoArgs(r: RenditionInput): { inputArgs: string[]; filters: string[]; videoArgs: string[]; encoder: string; bitrateKbps: number; toneMap: ToneMapPath | null } {
  const pipe = buildVideoPipeline({
    target: r.target, codec: r.codec, height: r.height, sourceHeight: r.sourceHeight, toneMap: r.toneMap, swFilters: r.swFilters, decode: r.decode ?? true,
    deinterlace: r.deinterlace, features: r.features,
  });
  const kbps = codecBitrate(r.bitrateKbps, r.codec);
  const fps = r.frameRate ? r.frameRate * (pipe.fieldRate ? 2 : 1) : null;
  const videoArgs = [
    ...encoderArgs(pipe.encoder, { bitrate: kbps, preset: r.preset, threads: r.threads, height: outputHeight(r.height, r.sourceHeight), fps, lowPower: r.lowPower }), ...rateArgs(kbps),
    ...keyframeArgs(r.segmentSeconds, fps),
  ];
  return { inputArgs: pipe.inputArgs, filters: pipe.filters, videoArgs, encoder: pipe.encoder, bitrateKbps: kbps, toneMap: pipe.toneMap };
}

/**
 * Concurrent hardware encode sessions the device allows, or null when the driver sets no fixed limit
 * (VA-API, QSV, AMF, VideoToolbox: bounded by throughput instead). NVIDIA GeForce/consumer cards are capped by
 * the driver (8 sessions since driver 551.x, 5 before, 3 on very old drivers); Quadro/RTX A/Tesla/data-centre cards are not.
 * This is the documented driver policy, not a measured value.
 */
export function maxEncoderSessions(hw: HwAccel, deviceName: string | null = null): number | null {
  if (hw === 'nvenc') return deviceName && /quadro|tesla|rtx a\d|rtx \d000 ada|\b[ahlt]\d{1,3}\b|grid/i.test(deviceName) ? null : 8;
  if (hw === 'v4l2m2m') return 1; // Raspberry Pi 4 bcm2835 encoder: effectively one 1080p30 stream
  if (hw === 'rkmpp') return null;
  return null;
}
