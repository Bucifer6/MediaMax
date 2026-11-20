/** What a tuner driver hands back to the live-TV source refresh (mirrors livetv.ts ChannelIn). */
export interface TunerChannel {
  remoteId: string;
  name: string;
  number: number | null;
  logo: string | null;
  category: string | null;
  /** Stream URL without credentials (they are added at play time). */
  streamUrl: string;
  epgId: string | null;
}

export interface TunerCategory {
  remoteId: string;
  name: string;
}

export interface TunerDevice {
  name: string | null;
  model: string | null;
  version: string | null;
  /** One line per tuner/input, e.g. "DVB-S2 #0". */
  tuners: string[];
  /** Concurrent streams the device can serve (null = unknown). */
  tunerCount: number | null;
}

export interface TunerSync {
  device: TunerDevice;
  categories: TunerCategory[];
  channels: TunerChannel[];
  warnings: string[];
}

export interface GuideChannelOut {
  id: string;
  name: string;
  altNames: string[];
  callsign: string | null;
  number: string | null;
  icon: string | null;
}

export interface GuideProgrammeOut {
  channel: string;
  start: string;
  end: string;
  title: string;
  subtitle?: string | null;
  description?: string | null;
  category?: string | null;
  icon?: string | null;
  episodeNum?: string | null;
  isNew?: boolean;
}

export interface GuideSink {
  channel(c: GuideChannelOut): void;
  /** Call once every channel is known, before the programmes. */
  decide(): void;
  programme(p: GuideProgrammeOut): void;
}

/** Saved per-source options (live_sources.options). */
export interface TunerOptions {
  profile?: string | null;
  authType?: 'auto' | 'basic' | 'digest' | null;
  satipMode?: 'fritzbox' | 'm3u' | null;
  fritzLists?: string[] | null;
  playlistUrl?: string | null;
  rtspTransport?: 'tcp' | 'udp' | null;
  descriptionUrl?: string | null;
  bouquets?: string[] | null;
  streamPort?: number | null;
  useTranscoding?: boolean | null;
  transcodePort?: number | null;
  streamAuth?: boolean | null;
  maxStreams?: number | null;
  guideDays?: number | null;
}

export const isoFromUnix = (s: number) => new Date(s * 1000).toISOString();
