import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { HwAccel, HwDetectReport, HwMethodResult, ToneMapPath, TranscodeVideoCodec, VideoRangeInfo } from '@mediamax/shared';
import {
  TONEMAP_FILTERS, buildVideoPipeline, codecBitrate, encoderArgs, encoderFor, isHwToneMap, isInterlacedFieldOrder, keyframeArgs, needsFmp4, outputHeight, rateArgs, toneMapCandidates,
  type DeinterlaceMode, type FfmpegFeatures, type VideoPipeline,
} from './hwaccel.js';
import { doviMuxArgs, type DoviRemux } from './dovi.js';
import { config } from '../config.js';
import { getSettings } from './settings.js';
import { logger } from '../util/log.js';
import { httpReconnectArgs, sleep, REMOTE_PROTOCOLS } from '../util/misc.js';
import { audioArgs, audioNeedsFmp4, planDetail, type AudioPlan } from './audio.js';

const log = logger('transcoder');

/* ------------------------- capability probing ----------------------- */

let filterCache: Set<string> | null = null;
let encoderCache: Set<string> | null = null;

export function listCaps(kind: '-filters' | '-encoders' | '-pix_fmts'): Set<string> {
  try {
    const r = spawnSync(config.ffmpeg, ['-hide_banner', kind], { encoding: 'utf8', timeout: 10000 });
    const set = new Set<string>();
    for (const line of (r.stdout ?? '').split('\n')) {
      const m = line.trim().match(/^[A-Z.|]{2,8}\s+(\S+)/);
      if (m) set.add(m[1]);
    }
    return set;
  } catch {
    return new Set();
  }
}
export const hasFilter = (f: string) => (filterCache ??= listCaps('-filters')).has(f);
export const hasEncoder = (e: string) => (encoderCache ??= listCaps('-encoders')).has(e);

/** Whether `ffmpeg -h filter=tonemap_opencl` lists tonemap=bt2390 (jellyfin-ffmpeg; stock FFmpeg 5.1 … 7.x does not). */
export const parseOpenclBt2390 = (help: string | null | undefined) => !!help && /^\s*bt2390\b/m.test(help);

let featureCache: { openclBt2390: boolean } | null = null;
/** Build-dependent filter options (observed from this ffmpeg build, never assumed from its name). Cached per process. */
export function ffmpegFeatures(): Required<FfmpegFeatures> {
  if (!featureCache) {
    let help = '';
    if (hasFilter('tonemap_opencl')) {
      try {
        const r = spawnSync(config.ffmpeg, ['-hide_banner', '-h', 'filter=tonemap_opencl'], { encoding: 'utf8', timeout: 10000 });
        help = `${r.stdout ?? ''}`;
      } catch { /* ignore */ }
    }
    featureCache = { openclBt2390: parseOpenclBt2390(help) };
  }
  return { ...featureCache, hasFilter };
}

let versionCache: string | null | undefined;
/** First line of `ffmpeg -version` (null when ffmpeg is missing); part of the detect cache key. */
export function ffmpegVersionString(): string | null {
  if (versionCache === undefined) {
    try {
      const r = spawnSync(config.ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 5000 });
      versionCache = r.status === 0 ? (r.stdout ?? '').split('\n')[0].trim() || null : null;
    } catch {
      versionCache = null;
    }
  }
  return versionCache;
}

export function ffmpegAvailable(): boolean {
  try {
    return spawnSync(config.ffmpeg, ['-version'], { timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

/* ------------------------------ options ----------------------------- */

export interface TranscodeOptions {
  input: string;
  /** Extra input options (e.g. user agent for remote URLs). */
  inputArgs?: string[];
  startSec: number;
  durationSec: number | null;
  mode: 'transcode' | 'remux' | 'live';
  /** Absolute ffprobe stream index for audio; null = first audio. */
  audioIndex: number | null;
  audioCopy: boolean;
  videoCopy: boolean;
  /** Target video bitrate kbps (H.264-equivalent; HEVC/AV1 are encoded at a fraction of it). */
  bitrate: number;
  maxHeight: number | null;
  sourceHeight: number | null;
  sourceCodec: string | null;
  hdr: boolean;
  /** Burn-in subtitle: absolute stream index (embedded) or external file path. */
  burnSubtitle?: { kind: 'embedded-text' | 'embedded-image' | 'external'; streamIndex?: number; relIndex?: number; file?: string } | null;
  audioChannels?: number;
  hasVideo: boolean;
  /** Preferred output codec (chosen from the client's device profile); H.264 when omitted. */
  videoCodec?: TranscodeVideoCodec;
  /**
   * HDR → SDR tone-mapping decision from the HDR/client-capability logic (source is PQ/HLG/DV and the client
   * can't display it). When omitted, falls back to `hdr && settings.toneMapHdr`. See shouldToneMap().
   */
  toneMap?: boolean;
  /** Bitstream filter for copied video, e.g. stripping Dolby Vision RPU/EL NAL units (see hdr.ts STRIP_DOVI_BSF). */
  videoBsf?: string | null;
  /** Copied video keeps real Dolby Vision: DV configuration box + sample entry, master playlist with DV codecs (dovi.ts). */
  dolbyVision?: DoviRemux | null;
  /** Audio delivery from the audio decision (audio.ts): codec, channels, downmix and comfort filters, DTS core copy. */
  audioPlan?: AudioPlan | null;
  /**
   * The source's probed video range (media.videoRange): frame rate (GOP length, H.264 level), Dolby Vision profile
   * (profile 5 prefers libplacebo) and, for files scanned since field order was recorded, `fieldOrder` (deinterlacing).
   */
  videoRange?: (VideoRangeInfo & { fieldOrder?: string | null }) | null;
  /** ffprobe field_order of the source (overrides videoRange.fieldOrder): tt/bb/tb/bt = interlaced. */
  fieldOrder?: string | null;
  /** Source frame rate (overrides videoRange.frameRate). */
  frameRate?: number | null;
}

export interface TranscodeInfo {
  videoCodec: string;
  audioCodec: string;
  bitrate: number | null;
  hwAccel: string;
  /** Set when the hardware transcode failed and the job fell back. */
  hwFallback?: string | null;
  toneMap?: string | null;
  /** RFC 6381 audio codec of the output (HLS CODECS), when known. */
  audioCodecString?: string | null;
  /** Audio output and why, for the dashboard (see audio.ts planDetail). */
  audioDetail?: string | null;
  /** Output frame height when encoding video. */
  height?: number | null;
}

export type SegmentType = 'mpegts' | 'fmp4';

/** Per-run choices the job makes (and changes when it falls back). */
export interface BuildContext {
  hw: HwAccel;
  platform?: string;
  codec?: TranscodeVideoCodec;
  /** 'auto' picks the best working path; a value forces it; null disables tone-mapping. */
  toneMap?: ToneMapPath | null | 'auto';
  segmentType?: SegmentType;
  /** false: decode on the CPU even with a hardware encoder (fallback after a hardware decode failure). */
  decode?: boolean;
}

/**
 * A file name as a filter option value inside a filtergraph (e.g. `subtitles=<this>`). ffmpeg unescapes twice: first
 * the filtergraph (\ ' [ ] , ;), then the option value (\ ' :), so both levels are escaped, in that order reversed.
 * Quoting with '…' is not enough: a ' in a (downloaded) file name would end the quote. Windows paths use / instead of \.
 */
export function escapeFilterPath(p: string, win = process.platform === 'win32'): string {
  const value = (win ? p.replace(/\\/g, '/') : p).replace(/[\\':]/g, '\\$&');
  return value.replace(/[\\'[\],;]/g, '\\$&');
}
const normCodec = (c: string | null) => (c ?? '').toLowerCase().replace('h265', 'hevc').replace('avc', 'h264');

export function targetHeight(bitrate: number, sourceHeight: number | null, maxHeight: number | null): number | null {
  const ladder: [number, number][] = [[20000, 2160], [10000, 1440], [6000, 1080], [3000, 720], [1500, 540], [800, 480], [0, 360]];
  const byBitrate = ladder.find(([b]) => bitrate >= b)![1];
  const h = Math.min(byBitrate, maxHeight ?? Infinity, sourceHeight ?? Infinity);
  return Number.isFinite(h) ? h : null;
}

/* ----------------------- detection results cache ---------------------- */

/**
 * The last hardware detect report, persisted as JSON in <cacheDir>/hwdetect/report.json so a restart does not assume
 * every encoder works. It is valid for the hwAccel/device settings and the exact ffmpeg build (`ffmpeg -version`) it
 * ran with; when those change, or no report exists, detection re-runs in the background (never in tests or without ffmpeg).
 */
const reportFile = () => path.join(config.cacheDir, 'hwdetect', 'report.json');
let detectReport: HwDetectReport | null = null;
let detectKey: string | null = null;
let reportLoaded = false;
let autoDetectFor: string | null = null;

export function detectCacheKey(): string {
  const s = getSettings().transcoding;
  // Not keyed on hwAccel: detection tests every method whichever one is selected, so switching between them must not
  // throw the report away and re-run a minute of test transcodes.
  return JSON.stringify({ vaapiDevice: s.vaapiDevice, gpuIndex: s.gpuIndex ?? 0, ffmpeg: ffmpegVersionString() });
}

/** Background detection is skipped under `node --test`, with KINORA_NO_HWDETECT=1 (MEDIAMAX_ alias), and without ffmpeg. */
export const autoDetectEnabled = () => !process.env.NODE_TEST_CONTEXT && process.env.MEDIAMAX_NO_HWDETECT !== '1' && ffmpegVersionString() != null;

function scheduleDetection(key: string, why: string) {
  if (autoDetectFor === key || !autoDetectEnabled()) return;
  autoDetectFor = key;
  log.info(`Hardware detection will run in the background (${why})`);
  setTimeout(() => {
    import('./hwdetect.js').then((m) => m.detectHardware()).catch((e) => log.warn(`Background hardware detection failed: ${(e as Error).message}`));
  }, 5000).unref();
}

/** (Re)read the persisted report from disk (startup; exported for tests). */
export function loadDetectReport() {
  reportLoaded = true;
  detectReport = null;
  detectKey = null;
  try {
    const j = JSON.parse(fs.readFileSync(reportFile(), 'utf8')) as { key?: string; report?: HwDetectReport };
    if (j?.report?.methods && typeof j.key === 'string') {
      detectReport = j.report;
      detectKey = j.key;
    }
  } catch { /* no cache yet */ }
}

/** The detect report for the current settings and ffmpeg build (loads the persisted one on first use), else null. */
export function getDetectReport(): HwDetectReport | null {
  if (!reportLoaded) loadDetectReport();
  const key = detectCacheKey();
  if (detectReport && detectKey !== key) {
    log.info('Cached hardware detect report is stale (transcoding device settings or ffmpeg build changed)');
    detectReport = null;
    detectKey = null;
  }
  if (!detectReport) scheduleDetection(key, 'no valid cached report');
  return detectReport;
}

export function setDetectReport(r: HwDetectReport | null) {
  reportLoaded = true;
  detectReport = r;
  detectKey = r ? detectCacheKey() : null;
  try {
    if (r) {
      fs.mkdirSync(path.dirname(reportFile()), { recursive: true });
      fs.writeFileSync(reportFile() + '.tmp', JSON.stringify({ key: detectKey, report: r }));
      fs.renameSync(reportFile() + '.tmp', reportFile());
    } else fs.rmSync(reportFile(), { force: true });
  } catch (e) {
    log.warn(`Could not save the hardware detect report: ${(e as Error).message}`);
  }
}

/** Load the persisted report and, when none is valid, start detection in the background. Call once at startup. */
export function initDetectReport() {
  getDetectReport();
}

/** The detect result for the configured accelerator/device, if detection has run (or a valid report was cached). */
export function detectedMethod(hw: HwAccel): HwMethodResult | null {
  const detectReport = getDetectReport();
  if (!detectReport || hw === 'none') return null;
  const s = getSettings().transcoding;
  const win = process.platform === 'win32';
  return detectReport.methods.find((m) => m.hwAccel === hw && m.available && (
    m.device ? m.device === s.vaapiDevice : m.gpuIndex == null || m.gpuIndex === s.gpuIndex || (!win && hw !== 'nvenc')
  )) ?? null;
}

/** Whether an encoder can be used: in this ffmpeg build, and not failed in the detect step. */
export function encoderWorks(hw: HwAccel, codec: TranscodeVideoCodec): boolean {
  const enc = encoderFor(hw, codec);
  if (!enc || !hasEncoder(enc)) return false;
  const m = detectedMethod(hw);
  return m ? m.encode[codec].works : true;
}

/** The detect step found this VA-API / QSV encoder only works with -low_power 1 (VDEnc-only GPUs). */
export function encoderLowPower(hw: HwAccel, codec: TranscodeVideoCodec): boolean {
  if (hw !== 'vaapi' && hw !== 'qsv') return false;
  return !!(detectedMethod(hw)?.encode[codec] as { lowPower?: boolean } | undefined)?.lowPower;
}

/**
 * Best tone-mapping path for an accelerator: detect results first, then whatever filters the build has.
 * `preferPlacebo` (Dolby Vision profile 5: only libplacebo applies the RPU reshaping) puts libplacebo first when the
 * detect step saw it work; otherwise the order is unchanged.
 */
export function pickToneMap(hw: HwAccel, platform: string, gpuPathsPossible: boolean, preferPlacebo = false): ToneMapPath | null {
  const s = getSettings().transcoding;
  const m = hw === 'none' ? getDetectReport()?.methods.find((x) => x.hwAccel === 'none') ?? null : detectedMethod(hw);
  let cands = toneMapCandidates(hw, platform, s.hardwareToneMapping && gpuPathsPossible);
  if (m) {
    const failed = new Set(m.toneMapping.tried.filter((t) => !t.works && !t.skipped).map((t) => t.path));
    cands = cands.filter((c) => !failed.has(c));
    if (m.toneMapping.path && cands.includes(m.toneMapping.path)) cands = [m.toneMapping.path, ...cands.filter((c) => c !== m.toneMapping.path)];
  }
  if (preferPlacebo && cands.includes('libplacebo')) cands = ['libplacebo', ...cands.filter((c) => c !== 'libplacebo')];
  // libplacebo needs a working Vulkan device: only use it once the detect step has seen it work.
  const confirmed = (c: ToneMapPath) => c !== 'libplacebo' || !!m?.toneMapping.tried.some((t) => t.path === 'libplacebo' && t.works);
  return cands.find((c) => TONEMAP_FILTERS[c].every(hasFilter) && confirmed(c)) ?? null;
}

/* ------------------------------- args -------------------------------- */

/** Audio formats other than AAC/MP3 (E-AC-3, AC-3, DTS, TrueHD, FLAC …) go in fMP4 segments, which every HLS player demuxes. */
function planWantsFmp4(o: Pick<TranscodeOptions, 'audioPlan' | 'audioCopy' | 'hasVideo'>): boolean {
  if (!o.audioPlan || !o.hasVideo) return false;
  return audioNeedsFmp4(o.audioCopy && o.audioPlan.codec !== 'copy' ? { ...o.audioPlan, codec: 'copy' } : o.audioPlan, o.audioCopy);
}

/**
 * Whether this transcode tone-maps HDR to SDR. The explicit `opts.toneMap` decision (HDR source + client without
 * HDR support) wins; otherwise any HDR source is tone-mapped when the admin setting is on. Copying video never tone-maps.
 */
export function shouldToneMap(o: Pick<TranscodeOptions, 'hdr' | 'toneMap' | 'videoCopy' | 'hasVideo'>, toneMapHdrSetting = getSettings().transcoding.toneMapHdr): boolean {
  if (!o.hasVideo || o.videoCopy) return false;
  if (o.toneMap !== undefined) return o.toneMap && toneMapHdrSetting;
  return o.hdr && toneMapHdrSetting;
}

export function buildArgs(o: TranscodeOptions, outDir: string, startNumber: number, hwOrCtx: HwAccel | BuildContext): { args: string[]; info: TranscodeInfo; segmentType: SegmentType } {
  const ctx: BuildContext = typeof hwOrCtx === 'string' ? { hw: hwOrCtx } : hwOrCtx;
  const platform = ctx.platform ?? process.platform;
  const s = getSettings().transcoding;
  const seg = s.segmentSeconds;
  const args: string[] = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  const encodeVideo = o.hasVideo && !o.videoCopy;
  let hw: HwAccel = encodeVideo ? ctx.hw : 'none';
  let codec: TranscodeVideoCodec = hw === 'none' ? 'h264' : ctx.codec ?? o.videoCodec ?? 'h264';
  if (!encoderFor(hw, codec)) codec = 'h264';
  const segmentType: SegmentType = ctx.segmentType ?? (o.mode !== 'live' && (needsFmp4(o.videoCopy ? normCodec(o.sourceCodec) : encodeVideo ? codec : null) || planWantsFmp4(o)) ? 'fmp4' : 'mpegts');

  // Video pipeline
  const h = targetHeight(o.bitrate, o.sourceHeight, o.maxHeight);
  const overlay = o.burnSubtitle?.kind === 'embedded-image' && o.burnSubtitle.streamIndex != null;
  const swFilters: string[] = [];
  let subFilter: string | null = null;
  if (o.burnSubtitle?.kind === 'external' && o.burnSubtitle.file) subFilter = `subtitles=${escapeFilterPath(o.burnSubtitle.file)}`;
  if (o.burnSubtitle?.kind === 'embedded-text' && o.burnSubtitle.relIndex != null) subFilter = `subtitles=${escapeFilterPath(o.input)}:si=${o.burnSubtitle.relIndex}`;
  // Input seeking (-ss before -i) starts frame timestamps at 0, but the subtitles filter times cues in source time:
  // shift the frames to source time around it. These are CPU filters, so they run before any hwupload.
  const seekSec = o.startSec > 0 && o.mode !== 'live' ? o.startSec.toFixed(3) : null;
  if (subFilter) swFilters.push(...(seekSec ? [`setpts=PTS+${seekSec}/TB`, subFilter, `setpts=PTS-${seekSec}/TB`] : [subFilter]));
  let pipeline: VideoPipeline | null = null;
  const fieldOrder = o.fieldOrder ?? o.videoRange?.fieldOrder ?? null;
  // Probed interlaced → deinterlace; live inputs with unknown field order → CPU bwdif that only touches interlaced frames.
  const deinterlace: DeinterlaceMode = isInterlacedFieldOrder(fieldOrder) ? 'interlaced' : o.mode === 'live' && !fieldOrder ? 'auto' : null;
  const srcFps = o.frameRate ?? o.videoRange?.frameRate ?? null;
  if (encodeVideo) {
    const wantToneMap = shouldToneMap(o, s.toneMapHdr);
    const gpuPossible = !overlay && swFilters.length === 0;
    const dv5 = o.videoRange?.dolbyVision?.profile === 5;
    const toneMap = !wantToneMap ? null : ctx.toneMap === undefined || ctx.toneMap === 'auto' ? pickToneMap(hw, platform, gpuPossible, dv5) : ctx.toneMap;
    const target = { hw, platform, vaapiDevice: s.vaapiDevice, gpuIndex: s.gpuIndex ?? 0 };
    // Image subtitles are overlaid on the CPU (hybrid pipeline): the hardware decoder still decodes, into system memory.
    const vr = o.videoRange;
    const sourceColor = vr ? { transfer: vr.colorTransfer, primaries: vr.colorPrimaries, matrix: vr.colorSpace } : null;
    pipeline = buildVideoPipeline({ target, codec, height: h, sourceHeight: o.sourceHeight, sourceColor, toneMap, swFilters, cpuFrames: overlay, decode: ctx.decode ?? true, deinterlace, features: ffmpegFeatures() });
  }

  if (o.mode === 'live') args.push('-fflags', '+genpts+discardcorrupt', ...httpReconnectArgs(o.input, 5));
  if (pipeline) args.push(...pipeline.inputArgs);
  args.push(...(o.inputArgs ?? []));
  if (!path.isAbsolute(o.input)) args.push(...REMOTE_PROTOCOLS);
  if (seekSec) args.push('-ss', seekSec);
  args.push('-i', o.input);

  // Stream mapping
  const audioMap = o.audioIndex != null ? `0:${o.audioIndex}` : '0:a:0?';
  if (pipeline && overlay) {
    // Deinterlace the video before the (progressive) subtitle bitmap is drawn on it.
    const [first, ...rest] = pipeline.filters;
    const pre = first?.startsWith('bwdif=') ? `[0:v:0]${first}[dv];[dv]` : '[0:v:0]';
    const post = pre === '[0:v:0]' ? pipeline.filters : rest;
    args.push('-filter_complex', `${pre}[0:${o.burnSubtitle!.streamIndex}]overlay=eof_action=pass${post.length ? `,${post.join(',')}` : ''}[v]`, '-map', '[v]');
  }
  else if (o.hasVideo) args.push('-map', '0:v:0');
  args.push('-map', audioMap, '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1');

  let videoBitrate: number | null = null;
  if (o.hasVideo) {
    if (o.videoCopy || !pipeline) {
      args.push('-c:v', 'copy');
      if (o.videoBsf) args.push('-bsf:v', o.videoBsf);
      if (o.dolbyVision && o.videoCopy) args.push(...doviMuxArgs(o.dolbyVision.sampleEntry));
      else if (normCodec(o.sourceCodec) === 'hevc') args.push('-tag:v', 'hvc1');
    } else {
      if (!overlay && pipeline.filters.length) args.push('-vf', pipeline.filters.join(','));
      videoBitrate = codecBitrate(o.bitrate, codec);
      const fps = srcFps ? srcFps * (pipeline.fieldRate ? 2 : 1) : null;
      args.push(...encoderArgs(pipeline.encoder, {
        bitrate: videoBitrate, preset: s.preset, threads: s.threads, live: o.mode === 'live', height: outputHeight(h, o.sourceHeight), fps, lowPower: encoderLowPower(hw, codec),
      }), ...rateArgs(videoBitrate));
      // Time-based keyframes at segment boundaries for VOD and live alike (live used to assume 25 fps with -g seg*25).
      args.push(...keyframeArgs(seg, fps));
    }
  }
  let audioCodec = 'copy';
  if (o.audioCopy) {
    args.push('-c:a', 'copy');
    if (o.audioPlan?.codec === 'copy' && !o.audioPlan.bsf && o.audioPlan.sourceCodec === 'truehd') args.push('-strict', '-2');
  } else if (o.audioPlan && o.hasVideo) {
    args.push(...audioArgs(o.audioPlan));
    audioCodec = o.audioPlan.codec;
  } else {
    audioCodec = 'aac';
    const ch = Math.min(o.audioChannels ?? 2, 6);
    args.push('-c:a', 'aac', '-ac', String(ch > 2 ? 6 : 2), '-b:a', ch > 2 ? '384k' : '192k');
  }
  if (o.mode === 'transcode' && o.startSec > 0) args.push('-output_ts_offset', o.startSec.toFixed(3));
  if (o.mode !== 'live') args.push('-max_muxing_queue_size', '2048');

  args.push('-f', 'hls', '-hls_time', String(seg));
  if (segmentType === 'fmp4') args.push('-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4');
  else args.push('-hls_segment_type', 'mpegts');
  args.push('-start_number', String(startNumber), '-hls_segment_filename', path.join(outDir, segmentType === 'fmp4' ? 'seg%d.m4s' : 'seg%d.ts'));
  if (o.mode === 'live') args.push('-hls_list_size', '8', '-hls_flags', 'delete_segments+independent_segments+omit_endlist');
  else args.push('-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments+temp_file');
  args.push(path.join(outDir, 'ff.m3u8'));
  if (!pipeline) hw = 'none';
  return {
    args,
    segmentType,
    info: {
      videoCodec: pipeline?.encoder ?? 'copy', audioCodec, bitrate: videoBitrate, hwAccel: hw, toneMap: pipeline?.toneMap ?? null, hwFallback: null,
      height: pipeline ? h : null,
      // Audio decision details (only with an audio plan, so other callers see the same info as before).
      ...(o.audioPlan && o.hasVideo ? {
        audioCodecString: o.audioCopy && o.audioPlan.codec !== 'copy' ? null : o.audioPlan.codecString,
        audioDetail: o.audioCopy ? null : planDetail(o.audioPlan),
      } : {}),
    },
  };
}

/* ------------------------------- jobs ------------------------------- */

/** Polling interval while waiting for output: tight for the first seconds (playback start), relaxed after. */
export const pollDelay = (waitedMs: number) => (waitedMs < 3000 ? 40 : waitedMs < 10000 ? 100 : 200);

export class TranscodeJob {
  readonly dir: string;
  private proc: ChildProcess | null = null;
  private startNumber = 0;
  /** Highest complete segment seen in the current run (segments only appear, so later scans resume here). */
  private latestKnown = -1;
  private paused = false;
  private lastRequested = 0;
  private stderr = '';
  private hw: HwAccel;
  private codec: TranscodeVideoCodec;
  private toneMapOverride: ToneMapPath | null | 'auto' = 'auto';
  /** false after a failure with hardware decoding: keep the hardware encoder, decode on the CPU. */
  private decodeOverride: boolean | undefined;
  /** The last run's command used hardware decoding (-hwaccel). */
  private usedHwDecode = false;
  private runStartedAt = 0;
  private initServed = false;
  /** Instant-play warm job: pause ffmpeg once segments up to this number exist, until released (see hold()). */
  private holdUntil: number | null = null;
  /** Why this job is no longer on the configured hardware path (shown on the admin dashboard). */
  private fallbackReason: string | null = null;
  readonly segmentType: SegmentType;
  info: TranscodeInfo | null = null;
  failed: string | null = null;
  exited = false;
  killed = false;
  /** Called when `info` changes after start (e.g. a hardware → software fallback). */
  onInfoChange: (() => void) | null = null;

  constructor(readonly id: string, readonly opts: TranscodeOptions) {
    this.dir = path.join(config.transcodeDir, id);
    fs.mkdirSync(this.dir, { recursive: true });
    const configured = getSettings().transcoding.hwAccel;
    this.hw = configured;
    this.codec = opts.videoCodec ?? 'h264';
    const encodes = opts.hasVideo && !opts.videoCopy;
    if (encodes && configured !== 'none' && !encoderWorks(configured, 'h264')) {
      const enc = encoderFor(configured, 'h264');
      this.fallbackReason = `${configured}: ${enc} ${enc && hasEncoder(enc) ? 'failed the hardware test' : 'is not in this ffmpeg build'}, used software`;
      log.warn(`Hardware transcoding (${configured}) unavailable: ${this.fallbackReason}`);
      this.hw = 'none';
    }
    if (this.hw === 'none' || !encoderWorks(this.hw, this.codec)) this.codec = 'h264';
    this.segmentType = opts.mode !== 'live' && (needsFmp4(opts.videoCopy ? normCodec(opts.sourceCodec) : encodes ? this.codec : null) || planWantsFmp4(opts)) ? 'fmp4' : 'mpegts';
  }

  get segmentSeconds() {
    return getSettings().transcoding.segmentSeconds;
  }

  get segmentExt() {
    return this.segmentType === 'fmp4' ? 'm4s' : 'ts';
  }

  start(fromSegment = 0) {
    this.stopProcess();
    this.startNumber = fromSegment;
    // The player asks for this segment next: don't let the throttle see a far-ahead encoder before it does.
    this.lastRequested = fromSegment;
    this.latestKnown = fromSegment - 1;
    this.exited = false;
    this.failed = null;
    this.stderr = '';
    this.runStartedAt = Date.now();
    const seg = this.segmentSeconds;
    const opts = { ...this.opts, startSec: this.opts.mode === 'transcode' ? this.opts.startSec + fromSegment * seg : this.opts.startSec };
    const { args, info } = buildArgs(opts, this.dir, this.opts.mode === 'transcode' ? fromSegment : 0, {
      hw: this.hw, codec: this.codec, toneMap: this.toneMapOverride, segmentType: this.segmentType, decode: this.decodeOverride,
    });
    this.usedHwDecode = args.includes('-hwaccel');
    const changed = !!this.info && (this.info.videoCodec !== info.videoCodec || this.info.toneMap !== info.toneMap);
    this.info = { ...info, hwFallback: this.fallbackReason };
    if (changed) this.onInfoChange?.();
    log.debug(`ffmpeg ${args.join(' ')}`);
    const p = spawn(config.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc = p;
    p.stderr?.on('data', (d) => {
      this.stderr = (this.stderr + d.toString()).slice(-4000);
    });
    p.on('error', (e) => {
      this.failed = e.message;
      this.exited = true;
    });
    p.on('exit', (code, signal) => {
      if (this.proc !== p) return;
      this.exited = true;
      if (code !== 0 && !this.killed && signal !== 'SIGKILL' && signal !== 'SIGTERM') {
        const msg = this.stderr.trim().split('\n').slice(-3).join(' | ') || `ffmpeg exited with ${code}`;
        if (this.tryFallback(fromSegment, msg)) return;
        this.failed = msg;
        log.warn(`Transcode ${this.id} failed: ${msg}`);
      }
    });
  }

  /**
   * Hardware transcodes that fail to start (or die in the first seconds) are retried, one step at a time, staying on
   * the hardware as long as possible:
   *  1. GPU tone-mapping → CPU tone-mapping;
   *  2. HEVC/AV1 → H.264 on the same hardware (only while nothing of the stream has been served);
   *  3. hardware decoding → CPU decoding with the same hardware encoder (same codec, so also after segments were served);
   *  4. fully in software (H.264 on the CPU).
   * Returns true when restarted.
   */
  private tryFallback(fromSegment: number, msg: string): boolean {
    if (this.hw === 'none' || !this.info || this.info.hwAccel === 'none') return false;
    const produced = this.latestSegment() >= fromSegment;
    const early = Date.now() - this.runStartedAt < 10000;
    if (produced && !early) return false;
    const resumeAt = produced ? this.latestSegment() + 1 : fromSegment;
    const retry = (reason: string) => {
      this.fallbackReason = `${reason}: ${msg}`.slice(0, 300);
      log.warn(`Transcode ${this.id}: ${this.fallbackReason}`);
      this.start(resumeAt);
      return true;
    };
    const gpuToneMap = isHwToneMap((this.info.toneMap ?? null) as ToneMapPath | null, this.hw, process.platform);
    if (gpuToneMap && this.toneMapOverride === 'auto') {
      this.toneMapOverride = 'software';
      return retry(`${this.hw} ${this.info.toneMap} tone-mapping failed, used CPU tone-mapping`);
    }
    // Switching codec mid-stream would not match segments/init the player already has.
    const codecSwitchOk = !produced && !this.initServed;
    if (this.codec !== 'h264' && codecSwitchOk && encoderWorks(this.hw, 'h264')) {
      const failedCodec = this.codec;
      this.codec = 'h264';
      fs.rmSync(path.join(this.dir, 'init.mp4'), { force: true });
      return retry(`${this.hw} ${failedCodec.toUpperCase()} encoding failed, used ${this.hw} H.264`);
    }
    if (this.usedHwDecode && this.decodeOverride !== false) {
      this.decodeOverride = false;
      return retry(`${this.hw} hardware decoding failed, decoded on the CPU and encoded with ${this.hw}`);
    }
    if (this.codec !== 'h264' && !codecSwitchOk) return false;
    log.warn(`Hardware transcode (${this.hw}) failed, retrying in software: ${msg}`);
    this.fallbackReason = `${this.hw} failed, used software: ${msg}`.slice(0, 300);
    this.hw = 'none';
    this.codec = 'h264';
    this.toneMapOverride = 'auto';
    this.decodeOverride = undefined;
    if (!this.initServed) fs.rmSync(path.join(this.dir, 'init.mp4'), { force: true });
    this.start(resumeAt);
    return true;
  }

  private stopProcess() {
    if (this.proc && !this.exited) {
      const p = this.proc;
      this.proc = null;
      try {
        if (this.paused) p.kill('SIGCONT');
        p.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    this.paused = false;
  }

  segmentPath(n: number) {
    return path.join(this.dir, `seg${n}.${this.segmentExt}`);
  }

  segmentExists(n: number) {
    return fs.existsSync(this.segmentPath(n));
  }

  /** Highest segment number fully written (ffmpeg writes seg N+1 only after N is complete, temp_file renames on completion). */
  latestSegment(): number {
    // Resume from the last segment found in this run instead of re-checking every file from the start of it
    // (late in a film that was thousands of synchronous stat calls per segment request).
    let n = Math.max(this.startNumber - 1, this.latestKnown);
    while (fs.existsSync(this.segmentPath(n + 1))) n++;
    this.latestKnown = n;
    return n;
  }

  /**
   * fMP4 init segment. ffmpeg rewrites init.mp4 on every (re)start, so once the first media segment of a run
   * exists (the init is complete by then) it is copied to a stable file that later requests get.
   */
  async initSegment(timeoutMs = 45000): Promise<string> {
    const stable = path.join(this.dir, 'init.served.mp4');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(stable)) {
        this.initServed = true;
        return stable;
      }
      const raw = path.join(this.dir, 'init.mp4');
      if (fs.existsSync(raw) && (this.latestSegment() >= this.startNumber || this.exited)) {
        fs.copyFileSync(raw, stable + '.tmp');
        fs.renameSync(stable + '.tmp', stable);
        continue;
      }
      if (this.failed) throw new Error(this.failed);
      if (this.exited && !this.killed && this.opts.mode === 'transcode' && !fs.existsSync(raw)) this.start(this.startNumber);
      await sleep(pollDelay(timeoutMs - (deadline - Date.now())));
    }
    throw new Error('Timed out waiting for stream to start');
  }

  /** Wait for segment n, (re)starting the encoder when the request is outside the encoded window. */
  async waitForSegment(n: number, timeoutMs = 45000): Promise<string> {
    if (this.holdUntil != null) this.release();
    this.lastRequested = n;
    this.throttle();
    const latest = this.latestSegment();
    const outside = n < this.startNumber || n > latest + 4;
    if (this.opts.mode === 'transcode' && outside && !this.segmentExists(n)) {
      log.debug(`Seek: restarting transcode ${this.id} at segment ${n} (window ${this.startNumber}-${latest})`);
      this.start(n);
    }
    const deadline = Date.now() + timeoutMs;
    const t0 = Date.now();
    // VOD runs write segments with hls_flags temp_file (renamed into place once complete), so an existing segment is
    // a finished one; waiting for the next segment as well only added a whole segment of encoding to every start/seek.
    const ready = (k: number) => this.segmentExists(k) && (this.opts.mode !== 'live' || this.segmentExists(k + 1) || this.exited);
    while (Date.now() < deadline) {
      if (ready(n)) return this.segmentPath(n);
      if (this.failed) throw new Error(this.failed);
      if (this.exited && !this.segmentExists(n)) {
        if (this.opts.mode === 'transcode' && !this.failed && !this.killed) {
          this.start(n);
        } else throw new Error('Transcoder stopped');
      }
      await sleep(pollDelay(Date.now() - t0));
    }
    throw new Error('Timed out waiting for segment');
  }

  /** Pause ffmpeg when it is far ahead of the player, resume when the player catches up. */
  private throttle() {
    if (!this.proc || this.exited || process.platform === 'win32' || this.opts.mode === 'live') return;
    if (this.holdUntil != null) {
      try {
        if (!this.paused && this.latestSegment() >= this.holdUntil) {
          this.proc.kill('SIGSTOP');
          this.paused = true;
        }
      } catch {
        /* ignore */
      }
      return;
    }
    const ahead = this.latestSegment() - this.lastRequested;
    try {
      if (!this.paused && ahead > 45) {
        this.proc.kill('SIGSTOP');
        this.paused = true;
      } else if (this.paused && ahead < 20) {
        this.proc.kill('SIGCONT');
        this.paused = false;
      }
    } catch {
      /* ignore */
    }
  }

  tick() {
    this.throttle();
  }

  /** The player fetched segment `n` (remux / live: served straight from disk), for the throttle. */
  requested(n: number) {
    this.lastRequested = n;
    this.throttle();
  }

  /**
   * Instant play (playback.ts warm jobs): encode up to segment `segment`, then pause until `release()` — the first
   * segments are ready when the user presses Play, without encoding a film nobody may watch. Polled through tick().
   */
  hold(segment: number) {
    this.holdUntil = segment;
    this.throttle();
  }

  /** End a hold(): the job belongs to a playback session now and runs (and is throttled) normally. */
  release() {
    this.holdUntil = null;
    if (this.paused && this.proc && !this.exited) {
      try {
        this.proc.kill('SIGCONT');
      } catch {
        /* ignore */
      }
      this.paused = false;
    }
  }

  async waitForPlaylist(timeoutMs = 30000): Promise<string> {
    const p = path.join(this.dir, 'ff.m3u8');
    const deadline = Date.now() + timeoutMs;
    const t0 = Date.now();
    while (Date.now() < deadline) {
      if (fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes('#EXTINF')) return p;
      if (this.failed) throw new Error(this.failed);
      if (this.exited && !fs.existsSync(p)) throw new Error('Transcoder stopped before producing output');
      await sleep(pollDelay(Date.now() - t0));
    }
    throw new Error('Timed out waiting for stream to start');
  }

  /** Full VOD playlist for transcode mode so players can seek anywhere immediately. */
  vodPlaylist(query: string): string {
    const seg = this.segmentSeconds;
    const dur = Math.max(0, (this.opts.durationSec ?? 0) - this.opts.startSec);
    const count = Math.max(1, Math.ceil(dur / seg));
    const fmp4 = this.segmentType === 'fmp4';
    const lines = ['#EXTM3U', `#EXT-X-VERSION:${fmp4 ? 7 : 3}`, `#EXT-X-TARGETDURATION:${seg}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS'];
    if (fmp4) lines.push(`#EXT-X-MAP:URI="init.mp4${query}"`);
    for (let i = 0; i < count; i++) {
      const d = i === count - 1 ? dur - i * seg || seg : seg;
      lines.push(`#EXTINF:${d.toFixed(3)},`, `seg${i}.${this.segmentExt}${query}`);
    }
    lines.push('#EXT-X-ENDLIST');
    return lines.join('\n') + '\n';
  }

  /** ffmpeg's own (event/live) playlist with tokenised segment URLs. */
  rewrittenPlaylist(query: string): string {
    const p = path.join(this.dir, 'ff.m3u8');
    const txt = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '#EXTM3U\n';
    return txt.split('\n').map((l) => {
      if (l.startsWith('#EXT-X-MAP:')) return l.replace(/URI="([^"]+)"/, (_m, u: string) => `URI="${path.basename(u)}${query}"`);
      return (l.endsWith('.ts') || l.endsWith('.m4s')) && !l.startsWith('#') ? path.basename(l) + query : l;
    }).join('\n');
  }

  stop() {
    this.killed = true;
    this.stopProcess();
    setTimeout(() => fs.rmSync(this.dir, { recursive: true, force: true }), 2000);
  }
}

export function cleanupTranscodeDir() {
  try {
    for (const d of fs.readdirSync(config.transcodeDir)) fs.rmSync(path.join(config.transcodeDir, d), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
