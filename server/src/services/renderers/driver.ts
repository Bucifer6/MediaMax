import type { RendererPlayState } from '@mediamax/shared';
import type { DidlItem } from './xml.js';

/** What a driver needs to start a stream on the device. */
export interface LoadMedia {
  url: string;
  mime: string;
  /** Full protocolInfo for the DIDL res (DLNA); drivers that don't need it ignore it. */
  protocolInfo: string;
  didl: DidlItem;
  title: string;
  subtitle: string | null;
  artUrl: string | null;
  durationMs: number | null;
  /** Seek here once playing (direct files only; transcodes start at the offset already). */
  startMs: number;
  isAudio: boolean;
  /** Byte-seekable original file (false for live transcodes). */
  seekable: boolean;
  subtitleUrl: string | null;
}

export interface DriverStatus {
  state: RendererPlayState;
  positionMs: number | null;
  durationMs: number | null;
  /** URI the device is playing (to tell our stream from something else). */
  uri: string | null;
  /** Sonos queue: 1-based track number. */
  track: number | null;
}

export interface RendererDriver {
  load(m: LoadMedia): Promise<void>;
  /** Native queue (Sonos): replace the device queue with these and start at `startIndex`. */
  loadQueue?(items: LoadMedia[], startIndex: number): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  seek(ms: number): Promise<void>;
  next?(): Promise<void>;
  previous?(): Promise<void>;
  status(): Promise<DriverStatus>;
  getVolume(): Promise<{ volume: number | null; muted: boolean }>;
  setVolume(v: number): Promise<void>;
  setMuted(m: boolean): Promise<void>;
  /** What the device says it can play (DLNA ConnectionManager Sink list). */
  sinkProtocols?(): Promise<string>;
  /** Short on-screen message (Kodi). */
  notify?(title: string, message: string, imageUrl?: string | null): Promise<void>;
}
