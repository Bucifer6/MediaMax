import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { HwAccel } from '@mediamax/shared';
import { config } from '../config.js';
import { getSettings } from './settings.js';
import { logger } from '../util/log.js';
import { sleep, REMOTE_PROTOCOLS } from '../util/misc.js';

const log = logger('transcoder');

/* ------------------------- capability probing ----------------------- */

let filterCache: Set<string> | null = null;
let encoderCache: Set<string> | null = null;

function listCaps(kind: '-filters' | '-encoders'): Set<string> {
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
  /** Target video bitrate kbps. */
  bitrate: number;
  maxHeight: number | null;
  sourceHeight: number | null;
  sourceCodec: string | null;
  hdr: boolean;
  /** Burn-in subtitle: absolute stream index (embedded) or external file path. */
  burnSubtitle?: { kind: 'embedded-text' | 'embedded-image' | 'external'; streamIndex?: number; relIndex?: number; file?: string } | null;
  audioChannels?: number;
  hasVideo: boolean;
}

export interface TranscodeInfo {
  videoCodec: string;
  audioCodec: string;
  bitrate: number | null;
  hwAccel: string;
}

const escapeFilterPath = (p: string) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/,/g, '\\,').replace(/\[/g, '\\[').replace(/\]/g, '\\]');

export function targetHeight(bitrate: number, sourceHeight: number | null, maxHeight: number | null): number | null {
  const ladder: [number, number][] = [[20000, 2160], [10000, 1440], [6000, 1080], [3000, 720], [1500, 540], [800, 480], [0, 360]];
  const byBitrate = ladder.find(([b]) => bitrate >= b)![1];
  const h = Math.min(byBitrate, maxHeight ?? Infinity, sourceHeight ?? Infinity);
  return Number.isFinite(h) ? h : null;
}

export function buildArgs(o: TranscodeOptions, outDir: string, startNumber: number, hw: HwAccel): { args: string[]; info: TranscodeInfo } {
  const s = getSettings().transcoding;
  const seg = s.segmentSeconds;
  const args: string[] = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  const softwareOnly = !!o.burnSubtitle || (o.hdr && s.toneMapHdr);
  const useHw = !o.videoCopy && o.hasVideo && hw !== 'none' && !softwareOnly;
  if (useHw) {
    if (hw === 'vaapi') args.push('-hwaccel', 'vaapi', '-hwaccel_device', s.vaapiDevice, '-hwaccel_output_format', 'vaapi');
    else if (hw === 'nvenc') args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda');
    else if (hw === 'qsv') args.push('-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv');
    else if (hw === 'videotoolbox') args.push('-hwaccel', 'videotoolbox');
  }
  if (o.mode === 'live') args.push('-fflags', '+genpts+discardcorrupt', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  args.push(...(o.inputArgs ?? []));
  if (!path.isAbsolute(o.input)) args.push(...REMOTE_PROTOCOLS);
  if (o.startSec > 0 && o.mode !== 'live') args.push('-ss', o.startSec.toFixed(3));
  args.push('-i', o.input);

  // Stream mapping
  const audioMap = o.audioIndex != null ? `0:${o.audioIndex}` : '0:a:0?';
  let filterComplex: string | null = null;
  const vfs: string[] = [];
  const h = targetHeight(o.bitrate, o.sourceHeight, o.maxHeight);
  let videoCodec = 'copy';
  if (o.hasVideo && !o.videoCopy) {
    if (o.burnSubtitle?.kind === 'embedded-image' && o.burnSubtitle.streamIndex != null) {
      filterComplex = `[0:v:0][0:${o.burnSubtitle.streamIndex}]overlay=eof_action=pass${h ? `,scale=-2:${h}` : ''},format=yuv420p[v]`;
    } else {
      if (o.hdr && s.toneMapHdr && hasFilter('zscale') && hasFilter('tonemap')) {
        vfs.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
      }
      if (useHw && hw === 'vaapi') vfs.push(`scale_vaapi=w=-2:h=${h ?? -1}:format=nv12`);
      else if (useHw && hw === 'nvenc') vfs.push(h ? `scale_cuda=-2:${h}` : 'scale_cuda=format=yuv420p');
      else if (useHw && hw === 'qsv') vfs.push(h ? `scale_qsv=w=-1:h=${h}` : 'vpp_qsv=format=nv12');
      else {
        if (h && (!o.sourceHeight || h < o.sourceHeight)) vfs.push(`scale=-2:${h}`);
        if (o.burnSubtitle?.kind === 'external' && o.burnSubtitle.file) vfs.push(`subtitles='${escapeFilterPath(o.burnSubtitle.file)}'`);
        if (o.burnSubtitle?.kind === 'embedded-text' && o.burnSubtitle.relIndex != null) vfs.push(`subtitles='${escapeFilterPath(o.input)}':si=${o.burnSubtitle.relIndex}`);
        vfs.push('format=yuv420p');
      }
    }
    const enc = useHw
      ? ({ vaapi: 'h264_vaapi', nvenc: 'h264_nvenc', qsv: 'h264_qsv', videotoolbox: 'h264_videotoolbox', v4l2m2m: 'h264_v4l2m2m', none: 'libx264' } as const)[hw]
      : hw === 'v4l2m2m' && !softwareOnly ? 'h264_v4l2m2m' : 'libx264';
    videoCodec = enc;
  }

  if (filterComplex) args.push('-filter_complex', filterComplex, '-map', '[v]');
  else if (o.hasVideo) args.push('-map', '0:v:0');
  args.push('-map', audioMap, '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1');

  if (o.hasVideo) {
    if (o.videoCopy) {
      args.push('-c:v', 'copy');
      if (o.sourceCodec === 'hevc') args.push('-tag:v', 'hvc1');
    } else {
      if (vfs.length && !filterComplex) args.push('-vf', vfs.join(','));
      args.push('-c:v', videoCodec);
      if (videoCodec === 'libx264') {
        args.push('-preset', s.preset, '-profile:v', 'high', '-level', '4.1', '-tune', 'zerolatency');
        if (s.threads > 0) args.push('-threads', String(s.threads));
      } else if (videoCodec === 'h264_nvenc') args.push('-preset', 'p4');
      args.push('-b:v', `${o.bitrate}k`, '-maxrate', `${o.bitrate}k`, '-bufsize', `${o.bitrate * 2}k`);
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

  args.push('-f', 'hls', '-hls_time', String(seg), '-hls_segment_type', 'mpegts', '-start_number', String(startNumber),
    '-hls_segment_filename', path.join(outDir, 'seg%d.ts'));
  if (o.mode === 'live') args.push('-hls_list_size', '8', '-hls_flags', 'delete_segments+independent_segments+omit_endlist');
  else args.push('-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments+temp_file');
  args.push(path.join(outDir, 'ff.m3u8'));
  return { args, info: { videoCodec, audioCodec, bitrate: o.videoCopy ? null : o.bitrate, hwAccel: useHw ? hw : 'none' } };
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
  info: TranscodeInfo | null = null;
  failed: string | null = null;
  exited = false;
  killed = false;

  constructor(readonly id: string, readonly opts: TranscodeOptions) {
    this.dir = path.join(config.transcodeDir, id);
    fs.mkdirSync(this.dir, { recursive: true });
    this.hw = getSettings().transcoding.hwAccel;
  }

  get segmentSeconds() {
    return getSettings().transcoding.segmentSeconds;
  }

  start(fromSegment = 0) {
    this.stopProcess();
    this.startNumber = fromSegment;
    this.exited = false;
    this.failed = null;
    this.stderr = '';
    const seg = this.segmentSeconds;
    const opts = { ...this.opts, startSec: this.opts.mode === 'transcode' ? this.opts.startSec + fromSegment * seg : this.opts.startSec };
    const { args, info } = buildArgs(opts, this.dir, this.opts.mode === 'transcode' ? fromSegment : 0, this.hw);
    this.info = info;
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
        // Hardware encoders can fail on some inputs — fall back to software once.
        if (this.hw !== 'none' && !this.segmentExists(fromSegment)) {
          log.warn(`Hardware transcode (${this.hw}) failed, retrying in software: ${msg}`);
          this.hw = 'none';
          this.start(fromSegment);
          return;
        }
        this.failed = msg;
        log.warn(`Transcode ${this.id} failed: ${msg}`);
      }
    });
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
    return path.join(this.dir, `seg${n}.ts`);
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
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${seg}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS'];
    for (let i = 0; i < count; i++) {
      const d = i === count - 1 ? dur - i * seg || seg : seg;
      lines.push(`#EXTINF:${d.toFixed(3)},`, `seg${i}.ts${query}`);
    }
    lines.push('#EXT-X-ENDLIST');
    return lines.join('\n') + '\n';
  }

  /** ffmpeg's own (event/live) playlist with tokenised segment URLs. */
  rewrittenPlaylist(query: string): string {
    const p = path.join(this.dir, 'ff.m3u8');
    const txt = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '#EXTM3U\n';
    return txt.split('\n').map((l) => (l.endsWith('.ts') && !l.startsWith('#') ? path.basename(l) + query : l)).join('\n');
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
