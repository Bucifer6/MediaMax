/** Device profiles sent with POST /playback so the server picks direct play vs remux vs transcode. */
import { Dimensions, PixelRatio, Platform } from 'react-native';
import type { DeviceProfile } from './types';
import { nativeCapabilities } from '../../modules/mediamax-media';

/**
 * Video profile with HDR / 10-bit / passthrough capabilities from the MediaMaxMedia native module (display HDR
 * modes, MediaCodecList / VideoToolbox decoders, HDMI audio). Without the module (Expo Go) the static profile is
 * sent without `videoRange`, so the server keeps its legacy behaviour.
 */
export function videoDeviceProfile(maxBitrate?: number | null): DeviceProfile {
  const base = staticVideoProfile(maxBitrate);
  const n = nativeCapabilities();
  if (!n) return base;
  const merge = (a: string[] = [], b: string[] = []) => [...new Set([...a, ...b])];
  // Only codecs the hardware decodes (h264 always), so 4K HEVC/AV1 isn't direct-played onto a software decoder.
  const videoCodecs = merge(['h264'], n.videoCodecs.filter((c) => (base.videoCodecs ?? []).includes(c) || c === 'av1' || c === 'hevc'));
  const maxHeight = n.maxDecodeHeight || null;
  return {
    ...base,
    videoCodecs: Platform.OS === 'ios' ? videoCodecs.filter((c) => c !== 'vp9') : videoCodecs,
    audioCodecs: merge(base.audioCodecs, n.audioCodecs.filter((c) => c !== 'pcm')),
    audioPassthrough: merge(n.audioPassthrough, n.directAudioFormats),
    // Smart audio decisions (E-AC-3 / DTS core / AAC 7.1): only when the native build reports the output channels.
    ...(n.maxAudioChannels ? { maxAudioChannels: n.maxAudioChannels, multichannelAudioCodecs: n.multichannelAudioCodecs ?? [] } : {}),
    tenBitCodecs: n.tenBitCodecs,
    maxHeight,
    maxWidth: maxHeight ? Math.max(base.maxWidth ?? 0, Math.round((maxHeight * 16) / 9)) : base.maxWidth,
    player: Platform.OS === 'ios' ? 'avplayer' : 'exoplayer',
    videoRange: {
      hdr10: n.hdr10,
      hdr10Plus: n.hdr10Plus,
      hlg: n.hlg,
      dolbyVision: n.dolbyVision,
      dolbyVisionProfiles: n.dolbyVisionProfiles,
      hdrDisplay: n.hdrDisplay,
    },
  };
}

function staticVideoProfile(maxBitrate?: number | null): DeviceProfile {
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
