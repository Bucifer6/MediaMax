import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { HwAccel, HwDetectReport, HwMethodResult, ToneMapPath, TranscodeVideoCodec } from '@mediamax/shared';
import {
  TONEMAP_FILTERS, buildVideoPipeline, codecBitrate, encoderArgs, encoderFor, isHwToneMap, needsFmp4, rateArgs, toneMapCandidates, type VideoPipeline,
} from './hwaccel.js';
import { config } from '../config.js';
import { getSettings } from './settings.js';
import { logger } from '../util/log.js';
import { sleep, REMOTE_PROTOCOLS } from '../util/misc.js';

const log = logger('transcoder');

/* ------------------------- capability probing ----------------------- */

let filterCache: Set<string> | null = null;
let encoderCache: Set<string> | null = null;

export function listCaps(kind: '-filters' | '-encoders'): Set<string> {
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
}

export interface TranscodeInfo {
  videoCodec: string;
  audioCodec: string;
  bitrate: number | null;
  hwAccel: string;
  /** Set when the hardware transcode failed and the job fell back. */
  hwFallback?: string | null;
  toneMap?: string | null;
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
}

const escapeFilterPath = (p: string) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/,/g, '\\,').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
const normCodec = (c: string | null) => (c ?? '').toLowerCase().replace('h265', 'hevc').replace('avc', 'h264');

export function targetHeight(bitrate: number, sourceHeight: number | null, maxHeight: number | null): number | null {
  const ladder: [number, number][] = [[20000, 2160], [10000, 1440], [6000, 1080], [3000, 720], [1500, 540], [800, 480], [0, 360]];
  const byBitrate = ladder.find(([b]) => bitrate >= b)![1];
  const h = Math.min(byBitrate, maxHeight ?? Infinity, sourceHeight ?? Infinity);
  return Number.isFinite(h) ? h : null;
}

/* ----------------------- detection results cache ---------------------- */

let detectReport: HwDetectReport | null = null;
export const getDetectReport = () => detectReport;
export const setDetectReport = (r: HwDetectReport | null) => { detectReport = r; };

/** The detect result for the configured accelerator/device, if detection has run this session. */
export function detectedMethod(hw: HwAccel): HwMethodResult | null {
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

/** Best tone-mapping path for an accelerator: detect results first, then whatever filters the build has. */
export function pickToneMap(hw: HwAccel, platform: string, gpuPathsPossible: boolean): ToneMapPath | null {
  const s = getSettings().transcoding;
  const m = hw === 'none' ? detectReport?.methods.find((x) => x.hwAccel === 'none') ?? null : detectedMethod(hw);
  let cands = toneMapCandidates(hw, platform, s.hardwareToneMapping && gpuPathsPossible);
  if (m) {
    const failed = new Set(m.toneMapping.tried.filter((t) => !t.works && !t.skipped).map((t) => t.path));
    cands = cands.filter((c) => !failed.has(c));
    if (m.toneMapping.path && cands.includes(m.toneMapping.path)) cands = [m.toneMapping.path, ...cands.filter((c) => c !== m.toneMapping.path)];
  }
  // libplacebo needs a working Vulkan device: only use it once the detect step has seen it work.
  const confirmed = (c: ToneMapPath) => c !== 'libplacebo' || !!m?.toneMapping.tried.some((t) => t.path === 'libplacebo' && t.works);
  return cands.find((c) => TONEMAP_FILTERS[c].every(hasFilter) && confirmed(c)) ?? null;
}

/* ------------------------------- args -------------------------------- */

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
  const segmentType: SegmentType = ctx.segmentType ?? (o.mode !== 'live' && needsFmp4(o.videoCopy ? normCodec(o.sourceCodec) : encodeVideo ? codec : null) ? 'fmp4' : 'mpegts');

  // Video pipeline
  const h = targetHeight(o.bitrate, o.sourceHeight, o.maxHeight);
  const overlay = o.burnSubtitle?.kind === 'embedded-image' && o.burnSubtitle.streamIndex != null;
  const swFilters: string[] = [];
  if (o.burnSubtitle?.kind === 'external' && o.burnSubtitle.file) swFilters.push(`subtitles='${escapeFilterPath(o.burnSubtitle.file)}'`);
  if (o.burnSubtitle?.kind === 'embedded-text' && o.burnSubtitle.relIndex != null) swFilters.push(`subtitles='${escapeFilterPath(o.input)}':si=${o.burnSubtitle.relIndex}`);
  let pipeline: VideoPipeline | null = null;
  if (encodeVideo) {
    const wantToneMap = shouldToneMap(o, s.toneMapHdr);
    const gpuPossible = !overlay && swFilters.length === 0;
    const toneMap = !wantToneMap ? null : ctx.toneMap === undefined || ctx.toneMap === 'auto' ? pickToneMap(hw, platform, gpuPossible) : ctx.toneMap;
    const target = { hw, platform, vaapiDevice: s.vaapiDevice, gpuIndex: s.gpuIndex ?? 0 };
    // Image subtitles are overlaid on the CPU, so that pipeline never decodes to GPU surfaces; its filters follow the overlay.
    pipeline = buildVideoPipeline({ target, codec, height: h, sourceHeight: o.sourceHeight, toneMap, swFilters, decode: !overlay });
  }

  if (o.mode === 'live') args.push('-fflags', '+genpts+discardcorrupt', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  if (pipeline) args.push(...pipeline.inputArgs);
  args.push(...(o.inputArgs ?? []));
  if (!path.isAbsolute(o.input)) args.push(...REMOTE_PROTOCOLS);
  if (o.startSec > 0 && o.mode !== 'live') args.push('-ss', o.startSec.toFixed(3));
  args.push('-i', o.input);

  // Stream mapping
  const audioMap = o.audioIndex != null ? `0:${o.audioIndex}` : '0:a:0?';
  if (pipeline && overlay) args.push('-filter_complex', `[0:v:0][0:${o.burnSubtitle!.streamIndex}]overlay=eof_action=pass,${pipeline.filters.join(',')}[v]`, '-map', '[v]');
  else if (o.hasVideo) args.push('-map', '0:v:0');
  args.push('-map', audioMap, '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1');

  let videoBitrate: number | null = null;
  if (o.hasVideo) {
    if (o.videoCopy || !pipeline) {
      args.push('-c:v', 'copy');
      if (normCodec(o.sourceCodec) === 'hevc') args.push('-tag:v', 'hvc1');
    } else {
      if (!overlay && pipeline.filters.length) args.push('-vf', pipeline.filters.join(','));
      videoBitrate = codecBitrate(o.bitrate, codec);
      args.push(...encoderArgs(pipeline.encoder, { bitrate: videoBitrate, preset: s.preset, threads: s.threads }), ...rateArgs(videoBitrate));
      if (o.mode !== 'live') args.push('-force_key_frames', `expr:gte(t,n_forced*${seg})`, '-sc_threshold', '0');
      else args.push('-g', String(seg * 25));
    }
  }
  let audioCodec = 'copy';
  if (o.audioCopy) args.push('-c:a', 'copy');
  else {
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
    info: { videoCodec: pipeline?.encoder ?? 'copy', audioCodec, bitrate: videoBitrate, hwAccel: hw, toneMap: pipeline?.toneMap ?? null, hwFallback: null },
  };
}

/* ------------------------------- jobs ------------------------------- */

export class TranscodeJob {
  readonly dir: string;
  private proc: ChildProcess | null = null;
  private startNumber = 0;
  private paused = false;
  private lastRequested = 0;
  private stderr = '';
  private hw: HwAccel;
  private codec: TranscodeVideoCodec;
  private toneMapOverride: ToneMapPath | null | 'auto' = 'auto';
  private runStartedAt = 0;
  private initServed = false;
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
    this.segmentType = opts.mode !== 'live' && needsFmp4(opts.videoCopy ? normCodec(opts.sourceCodec) : encodes ? this.codec : null) ? 'fmp4' : 'mpegts';
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
    this.exited = false;
    this.failed = null;
    this.stderr = '';
    this.runStartedAt = Date.now();
    const seg = this.segmentSeconds;
    const opts = { ...this.opts, startSec: this.opts.mode === 'transcode' ? this.opts.startSec + fromSegment * seg : this.opts.startSec };
    const { args, info } = buildArgs(opts, this.dir, this.opts.mode === 'transcode' ? fromSegment : 0, {
      hw: this.hw, codec: this.codec, toneMap: this.toneMapOverride, segmentType: this.segmentType,
    });
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
   * Hardware transcodes that fail to start (or die in the first seconds) are retried: first with CPU
   * tone-mapping if the GPU tone-mapper was in use, then fully in software. Returns true when restarted.
   */
  private tryFallback(fromSegment: number, msg: string): boolean {
    if (this.hw === 'none' || !this.info || this.info.hwAccel === 'none') return false;
    const produced = this.latestSegment() >= fromSegment;
    const early = Date.now() - this.runStartedAt < 10000;
    if (produced && !early) return false;
    const resumeAt = produced ? this.latestSegment() + 1 : fromSegment;
    const gpuToneMap = isHwToneMap((this.info.toneMap ?? null) as ToneMapPath | null, this.hw, process.platform);
    if (gpuToneMap && this.toneMapOverride === 'auto') {
      this.toneMapOverride = 'software';
      this.fallbackReason = `${this.hw} ${this.info.toneMap} tone-mapping failed, used CPU tone-mapping: ${msg}`.slice(0, 300);
      log.warn(`Transcode ${this.id}: ${this.fallbackReason}`);
      this.start(resumeAt);
      return true;
    }
    // Switching codec mid-stream would not match segments/init the player already has.
    if (this.codec !== 'h264' && (produced || this.initServed)) return false;
    log.warn(`Hardware transcode (${this.hw}) failed, retrying in software: ${msg}`);
    this.fallbackReason = `${this.hw} failed, used software: ${msg}`.slice(0, 300);
    this.hw = 'none';
    this.codec = 'h264';
    this.toneMapOverride = 'auto';
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
    let n = this.startNumber - 1;
    while (fs.existsSync(this.segmentPath(n + 1))) n++;
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
      await sleep(150);
    }
    throw new Error('Timed out waiting for stream to start');
  }

  /** Wait for segment n, (re)starting the encoder when the request is outside the encoded window. */
  async waitForSegment(n: number, timeoutMs = 45000): Promise<string> {
    this.lastRequested = n;
    this.throttle();
    const latest = this.latestSegment();
    const outside = n < this.startNumber || n > latest + 4;
    if (this.opts.mode === 'transcode' && outside && !this.segmentExists(n)) {
      log.debug(`Seek: restarting transcode ${this.id} at segment ${n} (window ${this.startNumber}-${latest})`);
      this.start(n);
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.segmentExists(n) && (this.segmentExists(n + 1) || this.exited)) return this.segmentPath(n);
      if (this.failed) throw new Error(this.failed);
      if (this.exited && !this.segmentExists(n)) {
        if (this.opts.mode === 'transcode' && !this.failed && !this.killed) {
          this.start(n);
        } else throw new Error('Transcoder stopped');
      }
      await sleep(150);
    }
    throw new Error('Timed out waiting for segment');
  }

  /** Pause ffmpeg when it is far ahead of the player, resume when the player catches up. */
  private throttle() {
    if (!this.proc || this.exited || process.platform === 'win32' || this.opts.mode === 'live') return;
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

  async waitForPlaylist(timeoutMs = 30000): Promise<string> {
    const p = path.join(this.dir, 'ff.m3u8');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes('#EXTINF')) return p;
      if (this.failed) throw new Error(this.failed);
      if (this.exited && !fs.existsSync(p)) throw new Error('Transcoder stopped before producing output');
      await sleep(200);
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
