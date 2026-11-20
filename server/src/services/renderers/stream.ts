import crypto from 'node:crypto';
import type { RendererKind } from '@mediamax/shared';
import { getKv, setKv } from '../settings.js';
import { dlnaFeatures, parseSinkList, protocolInfo, type SinkEntry } from './xml.js';

/* ------------------------------ signed URLs --------------------------- */

/**
 * Stream URLs handed to devices can't carry a login, so they carry a signed claim instead:
 * one media file of one renderer session, a format, and an expiry. The route additionally checks
 * the session is still alive (stopping playback revokes every URL) and the caller is on the LAN.
 */
export interface StreamClaims {
  /** Renderer session key (random, per play). */
  s: string;
  /** Media id. */
  m: string;
  /** Format: direct | ts | mp4 | mp3 | flac | srt */
  f: StreamFormatId | 'srt';
  /** Transcode start offset (seconds). */
  t: number;
  /** Audio stream index (transcodes) or subtitle stream index (srt). */
  a: number | null;
  /** Expiry, unix seconds. */
  x: number;
}

export type StreamFormatId = 'direct' | 'ts' | 'mp4' | 'mp3' | 'flac';

let secret: Buffer | null = null;
function key(): Buffer {
  if (secret) return secret;
  let hex = getKv<string | null>('renderers.secret', null);
  if (!hex || !/^[0-9a-f]{64}$/.test(hex)) {
    hex = crypto.randomBytes(32).toString('hex');
    setKv('renderers.secret', hex);
  }
  return (secret = Buffer.from(hex, 'hex'));
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const mac = (data: string) => crypto.createHmac('sha256', key()).update(data).digest().subarray(0, 24);

export function signStream(c: StreamClaims): string {
  const body = b64(JSON.stringify(c));
  return `${body}.${b64(mac(body))}`;
}

/** Verify a token; null if forged, malformed or expired. */
export function verifyStream(token: string, now = Date.now()): StreamClaims | null {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined || body.length > 2048) return null;
  const want = mac(body);
  let got: Buffer;
  try {
    got = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StreamClaims;
    if (typeof c.s !== 'string' || typeof c.m !== 'string' || typeof c.x !== 'number' || c.x * 1000 < now) return null;
    return c;
  } catch {
    return null;
  }
}

/** Long enough to play the item (plus pauses), never more than a day. */
export const streamExpiry = (durationMs: number | null, now = Date.now()) => Math.floor(now / 1000 + Math.min(86400, Math.max(4 * 3600, ((durationMs ?? 0) / 1000) * 3)));

/* ------------------------------ format choice ------------------------- */

export interface MediaFacts {
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  isAudio: boolean;
  /** A non-default audio track was chosen (needs a remux/transcode on most renderers). */
  nonDefaultAudio: boolean;
  /** Not a local file (IPTV/podcast URL). */
  remote: boolean;
}

export interface StreamFormat {
  method: 'direct' | 'transcode';
  f: StreamFormatId;
  mime: string;
  ext: string;
  pn: string | null;
  /** For transcodes: keep the video as is and only convert audio/container. */
  copyVideo: boolean;
  protocolInfo: string;
  reasons: string[];
}

const MIMES: Record<string, string[]> = {
  mp4: ['video/mp4'], m4v: ['video/mp4', 'video/x-m4v'], mov: ['video/quicktime', 'video/mp4'], mkv: ['video/x-matroska', 'video/x-mkv', 'video/mkv'],
  avi: ['video/x-msvideo', 'video/avi', 'video/divx'], ts: ['video/mp2t', 'video/vnd.dlna.mpeg-tts', 'video/mpeg'], m2ts: ['video/vnd.dlna.mpeg-tts', 'video/mp2t'],
  mpg: ['video/mpeg'], mpeg: ['video/mpeg'], webm: ['video/webm'], wmv: ['video/x-ms-wmv'],
  mp3: ['audio/mpeg', 'audio/mp3'], flac: ['audio/flac', 'audio/x-flac'], m4a: ['audio/mp4', 'audio/x-m4a', 'audio/m4a'], aac: ['audio/aac', 'audio/x-aac', 'audio/vnd.dlna.adts'],
  ogg: ['audio/ogg', 'application/ogg', 'audio/x-ogg'], opus: ['audio/ogg'], wav: ['audio/wav', 'audio/x-wav', 'audio/wave'],
};

/** What Sonos plays natively (it advertises a Sink list too, but this is the documented set). */
const SONOS_AUDIO = new Set(['mp3', 'm4a', 'aac', 'flac', 'ogg', 'wav']);
const VIDEO_OK = new Set(['h264', 'mpeg2video', 'mpeg4', 'msmpeg4v3']);
const AUDIO_OK_IN_VIDEO = new Set(['aac', 'mp3', 'ac3', 'eac3', 'mp2', 'pcm_s16le']);
const LOSSLESS = new Set(['flac', 'alac', 'wav', 'pcm_s16le', 'pcm_s24le']);

const PN: Record<string, string[]> = {
  mp3: ['MP3'],
  m4a: ['AAC_ISO_320', 'AAC_ISO'],
  ts: ['AVC_TS_HP_HD_AAC_MULT5_ISO', 'AVC_TS_MP_HD_AAC_MULT5_ISO', 'AVC_TS_HP_HD_AAC_MULT5', 'AVC_TS_MP_HD_AAC_MULT5', 'AVC_TS_MP_SD_AAC_MULT5_ISO'],
  mp4: ['AVC_MP4_HP_HD_AAC', 'AVC_MP4_MP_HD_AAC', 'AVC_MP4_MP_SD_AAC_MULT5'],
};

const norm = (c: string | null) => (c ?? '').toLowerCase().replace('h265', 'hevc').replace(/^avc1?$/, 'h264');

/** First of `candidates` the device lists (a DLNA.ORG_PN the device doesn't know makes some TVs refuse the stream). */
function pickPn(sinks: SinkEntry[], mime: string, candidates: string[] | undefined): string | null {
  if (!candidates) return null;
  const listed = new Set(sinks.filter((s) => s.mime === mime && s.pn).map((s) => s.pn));
  return candidates.find((c) => listed.has(c)) ?? null;
}

/**
 * Decide how a renderer gets a file: the original when the device lists its container (and we
 * trust its codecs), otherwise an MPEG-TS / MP4 (H.264 + AAC) transcode for video or FLAC / MP3
 * for audio. An empty Sink list means "unknown": assume the DLNA baseline (MP4/H.264/AAC, MP3).
 */
export function chooseFormat(kind: RendererKind, sinkRaw: string, m: MediaFacts): StreamFormat {
  const sinks = parseSinkList(sinkRaw);
  const anyMime = sinks.some((s) => s.mime === '*' || s.mime === '*/*');
  const listed = (mime: string) => anyMime || sinks.some((s) => s.mime === mime);
  const container = (m.container ?? '').toLowerCase();
  const vc = norm(m.videoCodec);
  const ac = norm(m.audioCodec);
  const reasons: string[] = [];
  const make = (method: StreamFormat['method'], f: StreamFormatId, mime: string, ext: string, copyVideo = false): StreamFormat => {
    const pn = method === 'direct' ? pickPn(sinks, mime, PN[ext]) : pickPn(sinks, mime, PN[f]);
    return { method, f, mime, ext, pn, copyVideo, protocolInfo: protocolInfo(mime, dlnaFeatures({ pn, transcoded: method === 'transcode' })), reasons };
  };

  // Kodi plays anything ffmpeg does: always the original file.
  if (kind === 'kodi' && !m.remote) return make('direct', 'direct', MIMES[container]?.[0] ?? (m.isAudio ? 'audio/mpeg' : 'video/mp4'), container || 'bin');

  const baseline = sinks.length === 0;
  const containerMime = (MIMES[container] ?? []).find((x) => (baseline ? ['video/mp4', 'audio/mpeg', 'audio/mp4'].includes(x) : listed(x)));

  if (m.isAudio) {
    const sonosOk = kind !== 'sonos' || SONOS_AUDIO.has(container);
    if (!m.remote && containerMime && sonosOk) return make('direct', 'direct', containerMime, container);
    reasons.push(m.remote ? 'remote source' : `${container || 'this'} audio isn't supported by the device`);
    const flacOk = kind === 'sonos' || listed('audio/flac') || listed('audio/x-flac');
    if (LOSSLESS.has(ac) && flacOk) return make('transcode', 'flac', kind === 'sonos' || listed('audio/flac') ? 'audio/flac' : 'audio/x-flac', 'flac');
    return make('transcode', 'mp3', 'audio/mpeg', 'mp3');
  }

  const hevcListed = sinks.some((s) => /hevc|h265/i.test(`${s.mime} ${s.pn ?? ''}`));
  const videoOk = VIDEO_OK.has(vc) || (vc === 'hevc' && hevcListed);
  const audioOk = !ac || AUDIO_OK_IN_VIDEO.has(ac);
  if (!videoOk) reasons.push(`video codec ${vc || 'unknown'}`);
  if (!audioOk) reasons.push(`audio codec ${ac}`);
  if (!containerMime) reasons.push(`container ${container || 'unknown'}`);
  if (m.nonDefaultAudio) reasons.push('non-default audio track');
  if (m.remote) reasons.push('remote source');
  if (!m.remote && containerMime && videoOk && audioOk && !m.nonDefaultAudio) return make('direct', 'direct', containerMime, container);
  const tsMime = ['video/mp2t', 'video/mpeg', 'video/vnd.dlna.mpeg-tts'].find(listed);
  const copyVideo = vc === 'h264';
  if (tsMime || baseline || !listed('video/mp4')) return make('transcode', 'ts', tsMime ?? 'video/mpeg', 'ts', copyVideo);
  return make('transcode', 'mp4', 'video/mp4', 'mp4', copyVideo);
}

/* -------------------------------- ffmpeg ------------------------------ */

export interface TranscodeArgsInput {
  input: string;
  inputArgs?: string[];
  f: Exclude<StreamFormatId, 'direct'>;
  startSec: number;
  audioIndex: number | null;
  copyVideo: boolean;
  /** kbps */
  bitrate: number;
  sourceHeight: number | null;
  hdr: boolean;
  toneMap?: string | null;
}

/** ffmpeg arguments for a progressive (pipe) stream a renderer can play from the first byte. */
export function transcodeArgs(o: TranscodeArgsInput): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...(o.inputArgs ?? [])];
  if (o.startSec > 0) args.push('-ss', String(o.startSec));
  args.push('-i', o.input);
  if (o.f === 'mp3' || o.f === 'flac') {
    args.push('-map', o.audioIndex != null ? `0:${o.audioIndex}` : '0:a:0', '-vn', '-sn', '-map_metadata', '-1');
    if (o.f === 'mp3') args.push('-c:a', 'libmp3lame', '-b:a', '320k', '-ar', '44100', '-f', 'mp3');
    else args.push('-c:a', 'flac', '-compression_level', '2', '-f', 'flac');
    args.push('pipe:1');
    return args;
  }
  args.push('-map', '0:v:0', '-map', o.audioIndex != null ? `0:${o.audioIndex}` : '0:a:0?', '-sn', '-dn', '-map_metadata', '-1');
  if (o.copyVideo) args.push('-c:v', 'copy');
  else {
    const h = Math.min(1080, o.sourceHeight || 1080);
    const filters = [...(o.hdr && o.toneMap ? [o.toneMap] : []), `scale=-2:${h}`, 'format=yuv420p'];
    args.push('-vf', filters.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-level', '4.1',
      '-b:v', `${o.bitrate}k`, '-maxrate', `${o.bitrate}k`, '-bufsize', `${o.bitrate * 2}k`, '-g', '48', '-sc_threshold', '0');
  }
  args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k');
  if (o.f === 'ts') args.push('-f', 'mpegts', '-muxdelay', '0', '-mpegts_copyts', '0');
  else args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4');
  args.push('pipe:1');
  return args;
}

/** HDR → SDR for renderers (zscale + tonemap), when ffmpeg has zscale. */
export const SOFTWARE_TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';

/** WebVTT → SRT, shifting cues back by `offsetMs` (transcodes that start mid-file) and dropping cues before 0. */
export function vttToSrt(vtt: string, offsetMs = 0): string {
  const toMs = (t: string) => {
    const m = t.match(/(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/);
    return m ? ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]) : 0;
  };
  const fmt = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
  };
  let n = 0;
  const out: string[] = [];
  for (const block of vtt.replace(/\r/g, '').replace(/^WEBVTT[^\n]*\n+/, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->').map((x) => x.trim());
    const start = toMs(a) - offsetMs;
    const end = toMs(b) - offsetMs;
    if (end <= 0) continue;
    const text = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (!text) continue;
    out.push(`${++n}\n${fmt(Math.max(0, start))} --> ${fmt(end)}\n${text}`);
  }
  return out.join('\n\n') + '\n';
}
