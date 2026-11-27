/**
 * JS face of the `MediaMaxMedia` native module: what this device's player (expo-video → AVPlayer on iOS/tvOS,
 * Media3/ExoPlayer on Android/Android TV) can play — HDR10 / HDR10+ / HLG / Dolby Vision (with profiles), 10-bit
 * hardware decoders, audio passthrough — plus TV remote keys react-native-tvos doesn't forward (Android) and Apple TV
 * display matching (AVDisplayCriteria, tvOS 17+).
 *
 * The module is missing in Expo Go and on web; `nativeCapabilities()` then returns null and callers fall back to
 * conservative static profiles (src/api/profiles.ts).
 */
import { Platform } from 'react-native';
import { requireOptionalNativeModule, type NativeModule } from 'expo';

export interface NativeMediaCapabilities {
  platform: 'android' | 'ios' | 'tvos';
  hdr10: boolean;
  hdr10Plus: boolean;
  hlg: boolean;
  dolbyVision: boolean;
  /** e.g. ["5", "8.1", "8.4"]; "7" only on players with dual-layer support. */
  dolbyVisionProfiles: string[];
  hdrDisplay: boolean;
  videoCodecs: string[];
  tenBitCodecs: string[];
  audioCodecs: string[];
  /** Encoded formats the HDMI / eARC sink takes as a bitstream (Android). */
  audioPassthrough: string[];
  maxDecodeHeight: number;
  displayHeight: number;
  /** Channels of the current audio output (HDMI / eARC sink, AirPlay, speakers); absent on older native builds. */
  maxAudioChannels?: number;
  /** Decoders that output more than two channels. */
  multichannelAudioCodecs?: string[];
  /** Android 13+: encoded formats the route takes directly (AudioManager.getDirectProfilesForAttributes). */
  directAudioFormats?: string[];
  /** Spatial audio active (Android Spatializer / iOS spatial headphones): Atmos JOC renders spatially. */
  spatialAudio?: boolean;
  /**
   * Android: codecs only Media3's FFmpeg extension decodes (software, multichannel PCM out), e.g. ["dts","dts-hd","truehd","mp2"].
   * Absent on older native builds / builds without the extension.
   */
  softwareAudioCodecs?: string[];
  ffmpegVersion?: string | null;
}

export interface ExternalPlayerOptions {
  url: string;
  title?: string;
  /** Where to start (stream time, ms). */
  positionMs?: number;
  /** null / omitted = Android's chooser. */
  packageName?: string | null;
  mimeType?: string;
}

export interface ExternalPlayerResult {
  launched: boolean;
  /** no-player: nothing on the device opens the stream. */
  reason?: 'no-player';
  /** The chosen player isn't installed (the chooser was shown instead, or nothing could open it). */
  requestedMissing?: boolean;
  resultCode?: number;
  /** Stream position when the player closed (VLC, MX Player, Just Player, mpv); null when it doesn't say. */
  positionMs?: number | null;
  durationMs?: number | null;
  completed?: boolean;
  packageName?: string | null;
}

export type MediaEvents = {
  /** W3C KeyboardEvent.key names: "0"–"9", "ChannelUp", "ColorF0Red", "Info", "Guide", "MediaTrackNext", … */
  onRemoteKey: (e: { key: string }) => void;
};

export declare class MediaMaxMediaNativeModule extends NativeModule<MediaEvents> {
  getCapabilities(): NativeMediaCapabilities | null;
  /**
   * Switch the display to the content's frame rate: Apple TV (tvOS 17+, "Match Content" on, also the range) and
   * Android TV / Fire TV (refresh rate only, preferredDisplayModeId). Resolves false when nothing fits.
   */
  matchDisplay(frameRate: number, range: 'sdr' | 'hdr10' | 'hlg' | 'dolbyvision'): Promise<boolean>;
  resetDisplay(): Promise<void>;
  /** Android: open the stream in another player app; resolves when that player returns. Missing on older builds. */
  openExternalPlayer?(options: ExternalPlayerOptions): Promise<ExternalPlayerResult>;
  /** Android: which of these packages are installed. */
  installedPlayers?(packages: string[]): string[];
}

function load(): MediaMaxMediaNativeModule | null {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    return requireOptionalNativeModule<MediaMaxMediaNativeModule>('MediaMaxMedia');
  } catch {
    return null;
  }
}

export const MediaMaxMedia: MediaMaxMediaNativeModule | null = load();

let cached: NativeMediaCapabilities | null | undefined;
/** Native capabilities (cached), or null without the native module. */
export function nativeCapabilities(): NativeMediaCapabilities | null {
  if (cached !== undefined) return cached;
  try {
    cached = MediaMaxMedia?.getCapabilities() ?? null;
  } catch {
    cached = null;
  }
  return cached;
}
