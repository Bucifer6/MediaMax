import type { DeviceProfile } from '@mediamax/shared';
import { platformTag, videoCaps } from './capabilities';

let cached: DeviceProfile | null = null;

function mse(type: string): boolean {
  try {
    const MS = (window as unknown as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource ?? window.MediaSource;
    return !!MS && MS.isTypeSupported(type);
  } catch {
    return false;
  }
}

function canPlay(el: HTMLMediaElement, type: string): boolean {
  try {
    return el.canPlayType(type) !== '';
  } catch {
    return false;
  }
}

export function supportsNativeHls(): boolean {
  const v = document.createElement('video');
  return canPlay(v, 'application/vnd.apple.mpegurl');
}

export function supportsMse(): boolean {
  return !!((window as unknown as { ManagedMediaSource?: unknown }).ManagedMediaSource ?? window.MediaSource);
}

/** Build a device profile from what this browser can decode. */
export function detectDeviceProfile(): DeviceProfile {
  if (cached) return cached;
  const v = document.createElement('video');
  const a = document.createElement('audio');
  const test = (type: string, el: HTMLMediaElement = v) => canPlay(el, type) || mse(type);

  const videoCodecs: string[] = [];
  if (test('video/mp4; codecs="avc1.640028"') || test('video/mp4; codecs="avc1.42E01E"')) videoCodecs.push('h264');
  if (test('video/mp4; codecs="hvc1.1.6.L120.90"') || test('video/mp4; codecs="hev1.1.6.L120.90"')) videoCodecs.push('hevc');
  if (test('video/webm; codecs="vp9"') || test('video/mp4; codecs="vp09.00.10.08"')) videoCodecs.push('vp9');
  if (test('video/webm; codecs="vp8"')) videoCodecs.push('vp8');
  if (test('video/mp4; codecs="av01.0.05M.08"')) videoCodecs.push('av1');

  const audioCodecs: string[] = [];
  if (test('audio/mp4; codecs="mp4a.40.2"', a)) audioCodecs.push('aac');
  if (test('audio/mpeg', a)) audioCodecs.push('mp3');
  if (test('audio/webm; codecs="opus"', a) || test('audio/ogg; codecs="opus"', a)) audioCodecs.push('opus');
  if (test('audio/ogg; codecs="vorbis"', a) || test('audio/webm; codecs="vorbis"', a)) audioCodecs.push('vorbis');
  if (test('audio/flac', a) || test('audio/mp4; codecs="flac"', a)) audioCodecs.push('flac');
  if (test('audio/mp4; codecs="ac-3"', a)) audioCodecs.push('ac3');
  if (test('audio/mp4; codecs="ec-3"', a)) audioCodecs.push('eac3');
  if (test('audio/wav', a)) audioCodecs.push('pcm');
  if (test('audio/mp4; codecs="alac"', a)) audioCodecs.push('alac');

  const containers: string[] = [];
  if (test('video/mp4')) containers.push('mp4', 'm4v', 'mov');
  if (test('video/webm')) containers.push('webm');
  if (test('audio/mpeg', a)) containers.push('mp3');
  if (test('audio/mp4', a)) containers.push('m4a', 'aac');
  if (test('audio/flac', a)) containers.push('flac');
  if (test('audio/ogg', a)) containers.push('ogg', 'oga');
  if (test('audio/wav', a)) containers.push('wav');

  const hlsJs = supportsMse() && (mse('video/mp4; codecs="avc1.42E01E,mp4a.40.2"') || mse('video/mp4; codecs="avc1.42E01E"'));
  const maxWidth = Math.round(Math.max(window.screen?.width ?? 1920, window.screen?.height ?? 1080) * Math.min(window.devicePixelRatio || 1, 2));

  // Samsung/LG TVs: never hand a video file to the TV's built-in progressive pipeline. Leaving video containers out
  // makes the server remux to fMP4/HLS (cheap: video and audio are copied), which our hls.js engine feeds to the
  // hardware decoder through MSE. Audio-only files still play directly.
  const tv = platformTag() === 'tizen' || platformTag() === 'webos';
  const base: DeviceProfile = {
    videoCodecs,
    audioCodecs,
    containers: tv && hlsJs ? containers.filter((c) => !['mp4', 'm4v', 'mov', 'webm'].includes(c)) : containers,
    supportsHls: hlsJs || supportsNativeHls(),
    maxWidth: maxWidth >= 3000 ? 3840 : maxWidth >= 1800 ? 1920 : maxWidth >= 1200 ? 1280 : 854,
    player: tv ? `${platformTag()}-mse` : 'html5',
  };
  // HDR / 10-bit capabilities arrive asynchronously (capabilities.ts); only cache the profile once they're known.
  const vc = videoCaps();
  if (!vc) return base;
  cached = {
    ...base,
    videoRange: vc.videoRange,
    tenBitCodecs: vc.tenBitCodecs,
    ...(vc.maxHeight ? { maxHeight: vc.maxHeight, maxWidth: Math.max(base.maxWidth ?? 0, Math.round((vc.maxHeight * 16) / 9)) } : {}),
  };
  return cached;
}

export function profileWithBitrate(maxBitrate: number | null | undefined): DeviceProfile {
  return { ...detectDeviceProfile(), maxBitrate: maxBitrate ?? null };
}

export const QUALITY_OPTIONS: { label: string; kbps: number | null }[] = [
  { label: 'Original', kbps: null },
  { label: '4K · 40 Mbps', kbps: 40000 },
  { label: '1080p · 20 Mbps', kbps: 20000 },
  { label: '1080p · 10 Mbps', kbps: 10000 },
  { label: '1080p · 8 Mbps', kbps: 8000 },
  { label: '720p · 4 Mbps', kbps: 4000 },
  { label: '720p · 3 Mbps', kbps: 3000 },
  { label: '480p · 1.5 Mbps', kbps: 1500 },
  { label: '360p · 720 kbps', kbps: 720 },
];
