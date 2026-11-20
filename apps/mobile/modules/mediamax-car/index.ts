/**
 * JS face of the `MediaMaxCar` native module (CarPlay on iOS, Android Auto on Android).
 *
 * The native side owns the car surfaces (CarPlay templates / the Media3 MediaLibraryService) and asks
 * JS for everything else: the browse tree (`onGetChildren`), search results (`onSearch`), what to play
 * (`onPlay`, `onPlayFromSearch`) and transport commands (`onCommand`). JS answers browse requests with
 * `resolveChildren` and mirrors the phone player into the car with `updateNowPlaying`.
 *
 * The module only exists in development / EAS builds of the phone apps. It is `null` in Expo Go, on
 * web and in TV builds (the pod is iOS-only and TV builds exclude it from autolinking), so every caller
 * must handle `MediaMaxCar === null`.
 */
import { Platform } from 'react-native';
import { requireOptionalNativeModule, type NativeModule } from 'expo';

/** A row in the car's browse tree. Ids are opaque to native code. */
export interface CarNode {
  id: string;
  title: string;
  subtitle?: string | null;
  /** Absolute http(s) URL. */
  artworkUrl?: string | null;
  /** SF Symbol name for CarPlay tab icons (ignored on Android). */
  icon?: string | null;
  /** Section header; consecutive nodes with the same group share a section. */
  group?: string | null;
  browsable: boolean;
  playable: boolean;
  /** 0…1 playback progress (spoken audio). */
  progress?: number | null;
  /** Shows the "now playing" indicator (CarPlay). */
  playing?: boolean;
  /** Hint for Android Auto's MediaMetadata.mediaType. */
  mediaType?: CarMediaType | null;
}

export type CarMediaType = 'folder' | 'track' | 'album' | 'artist' | 'playlist' | 'audiobook' | 'chapter' | 'podcast' | 'episode';

/** Mirror of the phone player for the car. */
export interface CarNowPlaying {
  id: string | null;
  title: string;
  subtitle: string | null;
  album: string | null;
  artworkUrl: string | null;
  durationMs: number;
  positionMs: number;
  playing: boolean;
  buffering: boolean;
  /** Audiobook part / podcast episode: ±15/30 s buttons and a speed button instead of track skip. */
  spoken: boolean;
  /**
   * Music longer than `LONG_TRACK_MS` (src/car/policy.ts): ±15/30 s buttons *in addition to*
   * next/previous (CarPlay: extra Now Playing buttons; Android Auto: extra custom actions).
   * Optional for older JS bundles; treated as false when missing.
   */
  longTrack?: boolean;
  rate: number;
  hasNext: boolean;
  hasPrevious: boolean;
  queueLength: number;
  error: string | null;
}

/**
 * Transport commands from the car / system. `seekTo` and `seekBy` carry milliseconds. `rate` without
 * a value means "next speed" (speed button); with a value it is the speed the system asked for
 * (Android: Assistant "play at 1.5x speed" / `setPlaybackParameters`).
 */
export type CarCommand = 'play' | 'pause' | 'toggle' | 'next' | 'previous' | 'seekTo' | 'seekBy' | 'rate' | 'stop';

/** Structured hints a voice assistant may send with "play …" (Siri INMediaSearch, Assistant extras). */
export type CarSearchType = 'track' | 'album' | 'artist' | 'playlist' | 'audiobook' | 'podcast' | 'episode' | 'music';

export interface CarPlayFromSearch {
  /** Free text ("" = "play something" / resume). */
  query: string;
  type?: CarSearchType | null;
  artist?: string | null;
  album?: string | null;
  /** Where it came from: 'siri', 'assistant' (Android) or undefined (older native builds). */
  source?: string | null;
}

export type CarEvents = {
  onGetChildren: (e: { requestId: string; parentId: string }) => void;
  onSearch: (e: { requestId: string; query: string }) => void;
  onPlay: (e: { mediaId: string }) => void;
  onPlayFromSearch: (e: CarPlayFromSearch) => void;
  onCommand: (e: { command: CarCommand; value?: number | null }) => void;
  onConnectionChange: (e: { connected: boolean; platform: 'carplay' | 'androidauto' }) => void;
};

export declare class MediaMaxCarNativeModule extends NativeModule<CarEvents> {
  /** A CarPlay scene / Android Auto browser is connected right now. */
  isConnected(): boolean;
  /** JS can answer browse requests (the bridge component is mounted). */
  setReady(ready: boolean): void;
  resolveChildren(requestId: string, nodes: CarNode[] | null, error: string | null): void;
  updateNowPlaying(state: CarNowPlaying | null): void;
  /** Reload a list in the car; `null` reloads the whole tree (e.g. after sign-in or a server switch). */
  invalidate(parentId: string | null): void;
  /**
   * iOS: (re)installs next/previous-track remote commands after expo-audio re-registered its own.
   * `trackSkip` = music (track skip) rather than spoken audio (±15/30 s). No-op on Android.
   * Long music keeps track skip here; its ±15/30 s buttons come from `CarNowPlaying.longTrack`.
   */
  syncRemoteCommands(trackSkip: boolean): void;
}

function load(): MediaMaxCarNativeModule | null {
  if (Platform.isTV || (Platform.OS !== 'ios' && Platform.OS !== 'android')) return null;
  try {
    return requireOptionalNativeModule<MediaMaxCarNativeModule>('MediaMaxCar');
  } catch {
    return null;
  }
}

/** The native module, or null where it does not exist (Expo Go, web, TV, builds without the plugin). */
export const MediaMaxCar: MediaMaxCarNativeModule | null = load();
