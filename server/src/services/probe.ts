import { spawn } from 'node:child_process';
import type { AudioStream, Chapter, SubtitleStream, VideoRangeInfo } from '@mediamax/shared';
import { config } from '../config.js';
import { parseVideoRange, wantsFrameProbe } from './hdr.js';

export interface ProbeResult {
  container: string | null;
  durationMs: number;
  size: number;
  bitrate: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  hdr: boolean;
  /** HDR format / Dolby Vision details (null without video). */
  videoRange: VideoRangeInfo | null;
  audio: AudioStream[];
  subs: SubtitleStream[];
  tags: Record<string, string>;
  hasVideo: boolean;
  /** index of attached-picture (cover art) stream, if any. */
  coverArtIndex: number | null;
  chapters: Chapter[];
}

export function ffprobeJson(input: string, extraArgs: string[] = [], timeoutMs = 60000): Promise<any> {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', ...extraArgs, input];
    const p = spawn(config.ffprobe, args);
    let out = '';
    let err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    // 'close', not 'exit': 'exit' can fire before stdout is fully read (truncated JSON under load).
    p.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0) return reject(new Error(err.trim() || `ffprobe exited ${code}`));
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** Side data of a video stream's first frame (cheap: one frame is decoded). */
export async function firstFrameSideData(input: string, streamIndex: number): Promise<any[]> {
  return new Promise((resolve) => {
    const p = spawn(config.ffprobe, ['-v', 'error', '-print_format', 'json', '-select_streams', String(streamIndex), '-show_frames', '-read_intervals', '%+#1', '-show_entries', 'frame=side_data_list', input]);
    let out = '';
    const t = setTimeout(() => p.kill('SIGKILL'), 15000);
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => { clearTimeout(t); resolve([]); });
    p.on('close', () => {
      clearTimeout(t);
      try {
        resolve(JSON.parse(out).frames?.[0]?.side_data_list ?? []);
      } catch {
        resolve([]);
      }
    });
  });
}

const CONTAINER_MAP: Record<string, string> = {
  'matroska,webm': 'mkv', 'mov,mp4,m4a,3gp,3g2,mj2': 'mp4', mpegts: 'ts', avi: 'avi', flv: 'flv', mp3: 'mp3', flac: 'flac', ogg: 'ogg', wav: 'wav', asf: 'wmv', aac: 'aac', 'hls': 'hls',
};

function lowerTags(t: Record<string, string> | undefined): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(t ?? {})) o[k.toLowerCase()] = String(v);
  return o;
}

export async function probe(input: string, filePath?: string): Promise<ProbeResult> {
  const j = await ffprobeJson(input);
  const streams: any[] = j.streams ?? [];
  const fmt = j.format ?? {};
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const cover = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic);
  let container = CONTAINER_MAP[fmt.format_name] ?? (fmt.format_name ? String(fmt.format_name).split(',')[0] : null);
  if (filePath && container === 'mp4') {
    const ext = filePath.split('.').pop()?.toLowerCase();
    if (ext === 'm4a' || ext === 'mov' || ext === 'm4v') container = ext === 'm4v' ? 'mp4' : ext;
  }
  if (filePath && container === 'mkv' && filePath.toLowerCase().endsWith('.webm')) container = 'webm';
  // .m4b audiobooks are plain MP4 audio; report m4a so players treat them as such.
  if (filePath && filePath.toLowerCase().endsWith('.m4b')) container = 'm4a';
  const chapters: Chapter[] = (j.chapters ?? []).map((c: any, i: number) => ({
    title: c.tags?.title || `Chapter ${i + 1}`,
    startMs: Math.round(parseFloat(c.start_time ?? '0') * 1000),
    endMs: Math.round(parseFloat(c.end_time ?? '0') * 1000),
  })).filter((c: Chapter) => c.endMs > c.startMs);
  // PQ streams: read the first frame's side data too (HDR10+ dynamic metadata, mastering display, MaxCLL).
  const frameSd = video && wantsFrameProbe(video) ? await firstFrameSideData(input, video.index).catch(() => []) : [];
  const videoRange = video ? parseVideoRange(video, frameSd) : null;
  const hdr = !!videoRange && videoRange.hdrFormat !== 'sdr';
  const audio: AudioStream[] = streams.filter((s) => s.codec_type === 'audio').map((s) => ({
    index: s.index,
    codec: s.codec_name ?? 'unknown',
    language: normLang(s.tags?.language),
    title: s.tags?.title ?? null,
    channels: s.channels ?? 2,
    default: !!s.disposition?.default,
  }));
  if (audio.length && !audio.some((a) => a.default)) audio[0].default = true;
  const subs: SubtitleStream[] = streams.filter((s) => s.codec_type === 'subtitle').map((s) => ({
    index: s.index,
    codec: s.codec_name ?? 'unknown',
    language: normLang(s.tags?.language),
    title: s.tags?.title ?? null,
    default: !!s.disposition?.default,
    forced: !!s.disposition?.forced,
    external: false,
  }));
  const durationSec = parseFloat(fmt.duration ?? video?.duration ?? '0') || 0;
  return {
    container,
    durationMs: Math.round(durationSec * 1000),
    size: parseInt(fmt.size ?? '0', 10) || 0,
    bitrate: fmt.bit_rate ? Math.round(parseInt(fmt.bit_rate, 10) / 1000) : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    videoCodec: video?.codec_name ?? null,
    hdr,
    videoRange,
    audio,
    subs,
    // Ogg/Opus/FLAC-in-Ogg keep their tags on the audio stream; container tags win when both exist.
    tags: { ...lowerTags(streams.find((s) => s.codec_type === 'audio')?.tags), ...lowerTags(fmt.tags) },
    hasVideo: !!video,
    coverArtIndex: cover?.index ?? null,
    chapters,
  };
}

const LANG3: Record<string, string> = { en: 'eng', fr: 'fre', de: 'ger', es: 'spa', it: 'ita', pt: 'por', ja: 'jpn', zh: 'chi', ko: 'kor', ru: 'rus', nl: 'dut', sv: 'swe', no: 'nor', da: 'dan', fi: 'fin', pl: 'pol', ro: 'rum', tr: 'tur', ar: 'ara', hi: 'hin', he: 'heb', el: 'gre', cs: 'cze', hu: 'hun' };
export function normLang(l: string | undefined | null): string | null {
  if (!l || l === 'und') return null;
  const s = l.toLowerCase();
  return LANG3[s] ?? s;
}

/** Text subtitle codecs we can convert to WebVTT. */
export const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'vtt', 'mov_text', 'text', 'microdvd', 'subviewer', 'sami', 'ttml']);
