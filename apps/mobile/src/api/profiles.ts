/** Device profiles sent with POST /playback so the server picks direct play vs remux vs transcode. */
import { Dimensions, PixelRatio, Platform } from 'react-native';
import type { DeviceProfile } from './types';

export function videoDeviceProfile(maxBitrate?: number | null): DeviceProfile {
  const { width, height } = Dimensions.get('screen');
  const px = Math.round(Math.max(width, height) * PixelRatio.get());
  const maxWidth = Platform.isTV ? Math.max(1920, px) : Math.min(3840, Math.max(1280, px));
  if (Platform.OS === 'ios') {
    return {
      maxBitrate: maxBitrate ?? null,
      maxWidth,
      videoCodecs: ['h264', 'hevc'],
      audioCodecs: ['aac', 'ac3', 'eac3', 'mp3', 'alac', 'flac'],
      // AVPlayer: no MKV/WebM; MPEG-TS only inside HLS.
      containers: ['mp4', 'm4v', 'mov'],
      supportsHls: true,
    };
  }
  return {
    maxBitrate: maxBitrate ?? null,
    maxWidth,
    videoCodecs: ['h264', 'hevc', 'vp9'],
    audioCodecs: ['aac', 'ac3', 'eac3', 'mp3', 'opus', 'flac', 'vorbis'],
    // ExoPlayer (Media3) handles these natively.
    containers: ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'ts'],
    supportsHls: true,
  };
}

export function audioDeviceProfile(): DeviceProfile {
  return Platform.OS === 'ios'
    ? { audioCodecs: ['aac', 'mp3', 'alac', 'flac'], containers: ['mp3', 'm4a', 'mp4', 'flac', 'wav'], supportsHls: true, videoCodecs: [] }
    : { audioCodecs: ['aac', 'mp3', 'flac', 'opus', 'vorbis'], containers: ['mp3', 'm4a', 'mp4', 'flac', 'ogg', 'oga', 'wav', 'webm'], supportsHls: true, videoCodecs: [] };
}

/** Quality menu (kbps). null = original. */
export const QUALITY_OPTIONS: { label: string; kbps: number | null }[] = [
  { label: 'Original', kbps: null },
  { label: '4K · 40 Mbps', kbps: 40000 },
  { label: '1080p · 20 Mbps', kbps: 20000 },
  { label: '1080p · 10 Mbps', kbps: 10000 },
  { label: '720p · 6 Mbps', kbps: 6000 },
  { label: '720p · 3 Mbps', kbps: 3000 },
  { label: '480p · 1.5 Mbps', kbps: 1500 },
  { label: '360p · 720 kbps', kbps: 720 },
];

/**
 * What a Chromecast (default media receiver) plays natively. Sent instead of the
 * phone's own profile while casting, so the server remuxes/transcodes for the TV.
 */
export function castDeviceProfile(kind: 'video' | 'audio', maxBitrate?: number | null): DeviceProfile {
  if (kind === 'audio') return { audioCodecs: ['aac', 'mp3'], containers: ['mp4', 'm4a', 'mp3'], supportsHls: true, videoCodecs: [] };
  return {
    maxBitrate: maxBitrate ?? null,
    maxWidth: 1920,
    videoCodecs: ['h264'],
    audioCodecs: ['aac', 'mp3'],
    containers: ['mp4'],
    supportsHls: true,
  };
}
