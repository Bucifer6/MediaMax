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
}

export type MediaEvents = {
  /** W3C KeyboardEvent.key names: "0"–"9", "ChannelUp", "ColorF0Red", "Info", "Guide", "MediaTrackNext", … */
  onRemoteKey: (e: { key: string }) => void;
};

export declare class MediaMaxMediaNativeModule extends NativeModule<MediaEvents> {
  getCapabilities(): NativeMediaCapabilities | null;
  /** Apple TV (tvOS 17+, "Match Content" on): switch the display to the content's frame rate and range. */
  matchDisplay(frameRate: number, range: 'sdr' | 'hdr10' | 'hlg' | 'dolbyvision'): Promise<boolean>;
  resetDisplay(): Promise<void>;
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
