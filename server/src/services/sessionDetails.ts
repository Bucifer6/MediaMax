/**
 * Emby-style "Now playing" breakdown for the admin dashboard: which app and device, how the stream leaves the
 * server (direct play / HLS remux / transcode) and what happens to its video, audio and subtitles, with the
 * reasons in plain words.
 */
import type { AudioStream, MediaSource, Platform, SessionDetails, StreamAction, SubtitleStream } from '@mediamax/shared';
import type { AudioPlan } from './audio.js';
import type { TranscodeInfo } from './transcoder.js';

export interface ClientHints {
  userAgent?: string | null;
  /** e.g. "1.1", "2.0" (Node's `req.raw.httpVersion`). */
  httpVersion?: string | null;
  secure?: boolean;
}

const APP_NAMES: Record<Platform, string> = {
  web: 'Kinora Web', ios: 'Kinora for iOS', android: 'Kinora for Android', tvos: 'Kinora for Apple TV',
  androidtv: 'Kinora for Android TV', roku: 'Kinora for Roku', other: 'Kinora',
};

/** "Chrome 131 on Windows", "Samsung TV (Tizen 6.5)", "Hisense TV (VIDAA)", "Safari 18 on iPhone" … (null when unknown). */
export function describeUserAgent(ua: string | null | undefined): string | null {
  if (!ua) return null;
  // Hisense VIDAA OS (also on Toshiba/Sharp sets running VIDAA). Its Chromium/Opera-based engine says "VIDAA", sometimes
  // with a version ("VIDAA/6.0"); older firmware only says "Hisense". Checked first: these UAs also carry Chrome/HbbTV.
  const vidaa = ua.match(/VIDAA(?:[/ _]?(\d+(?:\.\d+)*))?/i);
  if (vidaa) return `Hisense TV (VIDAA${vidaa[1] ? ` ${vidaa[1]}` : ''})`;
  if (/Hisense/i.test(ua) && !/Mobile|Android/i.test(ua)) return 'Hisense TV';
  const tizen = ua.match(/Tizen\s*([\d.]+)?/i);
  if (tizen) return `Samsung TV${tizen[1] ? ` (Tizen ${tizen[1]})` : ''}`;
  const webos = /Web0S|webOS/i.test(ua);
  if (webos) return 'LG TV (webOS)';
  if (/^Kinora|okhttp|Expo|CFNetwork|Dalvik/i.test(ua)) return null;
  const os = /Windows NT/.test(ua) ? 'Windows' : /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Android/.test(ua) ? (/AFT\w+/.test(ua) ? 'Fire TV' : 'Android') : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : null;
  const browsers: [string, RegExp][] = [
    ['Edge', /Edg(?:e|A|iOS)?\/(\d+)/], ['Opera', /OPR\/(\d+)/], ['Vivaldi', /Vivaldi\/(\d+)/], ['Samsung Internet', /SamsungBrowser\/(\d+)/],
    ['Firefox', /(?:Firefox|FxiOS)\/(\d+)/], ['Chrome', /(?:Chrome|CriOS)\/(\d+)/], ['Safari', /Version\/(\d+)[\d.]* .*Safari/],
  ];
  for (const [name, re] of browsers) {
    const m = ua.match(re);
    if (m) return `${name} ${m[1]}${os ? ` on ${os}` : ''}`;
  }
  return os;
}

let displayNames: Intl.DisplayNames | null = null;
const ISO2: Record<string, string> = {
  eng: 'en', rum: 'ro', ron: 'ro', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', ita: 'it', hun: 'hu', por: 'pt', rus: 'ru', pol: 'pl',
  dut: 'nl', nld: 'nl', gre: 'el', ell: 'el', tur: 'tr', bul: 'bg', srp: 'sr', hrv: 'hr', scc: 'sr', scr: 'hr', cze: 'cs', ces: 'cs', slo: 'sk', slk: 'sk',
  ukr: 'uk', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh', ara: 'ar', heb: 'he', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi', hin: 'hi', tha: 'th', vie: 'vi',
};
export function languageName(code: string | null | undefined): string | null {
  if (!code || code === 'und') return null;
  const c = code.toLowerCase();
  try {
    displayNames ??= new Intl.DisplayNames(['en'], { type: 'language' });
    const name = displayNames.of(ISO2[c] ?? c);
    return name && name.toLowerCase() !== c ? name : code;
  } catch {
    return code;
  }
}

const CODEC_NAMES: Record<string, string> = {
  h264: 'H264', avc: 'H264', hevc: 'HEVC', h265: 'HEVC', av1: 'AV1', vp9: 'VP9', vp8: 'VP8', mpeg2video: 'MPEG2', mpeg4: 'MPEG4', vc1: 'VC1',
  aac: 'AAC', ac3: 'AC3', eac3: 'EAC3', dts: 'DTS', truehd: 'TrueHD', flac: 'FLAC', mp3: 'MP3', mp2: 'MP2', opus: 'Opus', vorbis: 'Vorbis', alac: 'ALAC',
  pcm_s16le: 'PCM', pcm_s24le: 'PCM', subrip: 'SRT', srt: 'SRT', ass: 'ASS', ssa: 'SSA', webvtt: 'VTT', mov_text: 'MP4 text',
  hdmv_pgs_subtitle: 'PGS', pgssub: 'PGS', dvd_subtitle: 'VobSub', dvdsub: 'VobSub', dvb_subtitle: 'DVB',
};
export const codecName = (c: string | null | undefined) => (c ? CODEC_NAMES[c.toLowerCase()] ?? c.toUpperCase() : null);

const CONTAINERS: Record<string, string> = { mpegts: 'MPEG-TS', ts: 'MPEG-TS', m2ts: 'M2TS', matroska: 'MKV', mkv: 'MKV', mov: 'MOV', mp4: 'MP4', m4v: 'MP4', webm: 'WEBM', avi: 'AVI', hls: 'HLS' };
export const containerName = (c: string | null | undefined) => (c ? CONTAINERS[c.toLowerCase()] ?? c.toUpperCase() : null);

/** Encoder names (libx264, h264_qsv, hevc_nvenc …) → codec label. */
const encoderCodec = (enc: string) => codecName(enc.replace(/^lib/, '').replace(/^x26([45])$/, (_, d) => (d === '4' ? 'h264' : 'hevc')).replace(/_(qsv|nvenc|vaapi|videotoolbox|amf|v4l2m2m|rkmpp|mf)$/, ''));

export function resolutionLabel(width: number | null, height: number | null): string | null {
  if (!width && !height) return null;
  const w = width ?? 0;
  const h = height ?? 0;
  if (w >= 3200 || h >= 2000) return '4K';
  if (w >= 2200 || h >= 1300) return '1440p';
  if (w >= 1700 || h >= 1000) return '1080p';
  if (w >= 1100 || h >= 700) return '720p';
  if (h >= 560) return '576p';
  if (h >= 470) return '480p';
  return h ? `${h}p` : 'SD';
}

const channelLabel = (n: number, layout?: string | null) => {
  if (layout && /^(\d\.\d|stereo|mono)/.test(layout)) return layout.replace(/\(.*\)$/, '');
  return n >= 8 ? '7.1' : n >= 6 ? '5.1' : n === 2 ? 'stereo' : n === 1 ? 'mono' : `${n} ch`;
};

export function audioLabel(a: AudioStream): string {
  const parts = [languageName(a.language), a.formatLabel || codecName(a.codec), channelLabel(a.channels, a.channelLayout)].filter(Boolean);
  return `${parts.join(' ')}${a.default ? ' (Default)' : ''}`;
}

export function subtitleLabel(s: SubtitleStream): string {
  const flags = [s.forced && 'Forced', s.external ? 'External' : 'Embedded'].filter(Boolean).join(', ');
  return `${[languageName(s.language) ?? s.title ?? 'Unknown', codecName(s.codec)].filter(Boolean).join(' ')} (${flags})`;
}

/** Decision reasons ("bitrate 12000k exceeds 8000k") in plain words, like Emby's "Reducing bitrate due to quality setting". */
export function friendlyReason(r: string): string {
  const m = r.match(/^bitrate (\d+)k exceeds (\d+)k$/);
  if (m) return `Reducing bitrate: source ${fmtKbps(+m[1])} is above the ${fmtKbps(+m[2])} limit`;
  return r.charAt(0).toUpperCase() + r.slice(1);
}

const fmtKbps = (k: number) => (k >= 1000 ? `${(k / 1000).toFixed(k >= 10000 ? 0 : 1)} Mbps` : `${k} kbps`);

function clientOf(platform: Platform, appVersion: string | undefined, hints: ClientHints | undefined, local: boolean): SessionDetails['client'] {
  const v = hints?.httpVersion;
  return {
    app: APP_NAMES[platform] ?? 'Kinora',
    version: appVersion ?? null,
    browser: describeUserAgent(hints?.userAgent),
    protocol: v ? (v.startsWith('2') ? 'HTTP/2' : v.startsWith('3') ? 'HTTP/3' : `HTTP/${v}`) : null,
    secure: !!hints?.secure,
    local,
  };
}

export interface MediaDetailInput {
  platform: Platform;
  appVersion?: string;
  hints?: ClientHints;
  local: boolean;
  media: MediaSource;
  isAudioOnly: boolean;
  method: 'direct' | 'remux' | 'transcode';
  videoCopy: boolean;
  audioCopy: boolean;
  audio: AudioStream | null;
  audioPlan: AudioPlan | null;
  reasons: string[];
  adaptive: boolean;
  /** Burned-in subtitle, if any. */
  burnSub: SubtitleStream | null;
  rangeDelivery?: string | null;
}

/** The static part of the breakdown, decided at start (the live encoder state is merged in by `withJob`). */
export function mediaDetails(i: MediaDetailInput): SessionDetails {
  const m = i.media;
  const vr = m.videoRange;
  const video: SessionDetails['video'] = i.isAudioOnly || !m.videoCodec ? null : {
    label: [resolutionLabel(m.width, m.height) ?? m.resolutionLabel, codecName(m.videoCodec)].filter(Boolean).join(' '),
    codec: m.videoCodec, width: m.width, height: m.height,
    range: vr?.label ?? (m.hdr ? 'HDR' : null), frameRate: vr?.frameRate ?? null,
    action: i.method === 'direct' ? 'direct' : i.videoCopy ? 'copy' : 'transcode',
    notes: i.videoCopy && i.rangeDelivery === 'strip-dovi' ? ['Dolby Vision layers removed (HDR10 base layer)'] : [],
  };
  const audio: SessionDetails['audio'] = i.audio ? {
    label: audioLabel(i.audio),
    action: i.method === 'direct' ? 'direct' : i.audioCopy ? 'copy' : 'transcode',
    output: i.method === 'direct' || i.audioCopy ? null : i.audioPlan ? (i.audioPlan.reason ? `${i.audioPlan.output} (${i.audioPlan.reason})` : i.audioPlan.output) : null,
  } : null;
  return {
    client: clientOf(i.platform, i.appVersion, i.hints, i.local),
    stream: {
      container: containerName(m.container), bitrate: m.bitrate,
      delivery: i.method === 'direct' ? 'Direct Play' : i.method === 'remux' ? 'HLS (remux)' : i.adaptive ? 'HLS (adaptive)' : 'HLS',
      outputBitrate: null, reasons: i.reasons.map(friendlyReason),
    },
    video, audio,
    subtitle: i.burnSub ? { label: subtitleLabel(i.burnSub), action: 'burn-in' } : null,
  };
}

/** Merge the running encoder's state (output codec, bitrate, hardware, tone-mapping; it changes with ABR / fallbacks). */
export function withJob(d: SessionDetails, info: TranscodeInfo | null | undefined, audioOutKbps: number | null): SessionDetails {
  if (!info) return d;
  const encoding = info.videoCodec !== 'copy';
  const video = d.video && encoding ? {
    ...d.video,
    action: 'transcode' as StreamAction,
    notes: [
      ...d.video.notes,
      `${encoderCodec(info.videoCodec)}${info.height ? ` ${resolutionLabel(null, info.height) ?? `${info.height}p`}` : ''}${info.bitrate ? ` · ${fmtKbps(info.bitrate)}` : ''}`,
      info.hwAccel && info.hwAccel !== 'none' ? `Hardware: ${info.hwAccel.toUpperCase()}` : 'Software (CPU)',
      ...(info.toneMap ? [`HDR → SDR tone-mapping (${info.toneMap})`] : []),
      ...(info.hwFallback ? [info.hwFallback] : []),
    ],
  } : d.video;
  const audio = d.audio && d.audio.action === 'transcode' && !d.audio.output && info.audioDetail ? { ...d.audio, output: info.audioDetail } : d.audio;
  const outputBitrate = encoding && info.bitrate ? info.bitrate + (audioOutKbps ?? 0) : null;
  return { ...d, video, audio, stream: { ...d.stream, outputBitrate } };
}

/** Subtitle the player reports showing (text subtitles are delivered separately, so only the client knows). */
export function withSubtitle(d: SessionDetails, subs: SubtitleStream[], index: number | null | undefined): SessionDetails {
  if (d.subtitle?.action === 'burn-in' || index === undefined) return d;
  const s = index == null ? null : subs.find((x) => x.index === index);
  return { ...d, subtitle: s ? { label: subtitleLabel(s), action: s.external ? 'external' : 'embedded' } : null };
}

/** Live TV: the provider's stream isn't probed, so describe the delivery path only. */
export function liveDetails(platform: Platform, appVersion: string | undefined, hints: ClientHints | undefined, local: boolean, path: { container: string; delivery: string; note?: string }): SessionDetails {
  return {
    client: clientOf(platform, appVersion, hints, local),
    stream: { container: path.container, bitrate: null, delivery: path.delivery, outputBitrate: null, reasons: path.note ? [path.note] : [] },
    video: null, audio: null, subtitle: null,
  };
}
