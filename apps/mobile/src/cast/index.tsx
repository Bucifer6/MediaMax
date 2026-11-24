/**
 * Google Cast (Chromecast) for the phone apps.
 *
 * `react-native-google-cast` is a native module that only exists in dev / EAS
 * builds made with its config plugin, and never on TV builds (see
 * app.config.ts and react-native.config.js). It is therefore required lazily
 * and only when its native module is registered, so Expo Go, TV builds and web
 * keep working: `useCast().supported` is simply false there and every cast UI
 * renders nothing.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { NativeModules, Platform, type StyleProp, type ViewStyle } from 'react-native';
import type { MediaInfo, MediaStatus, MediaTrack, RemoteMediaClient } from 'react-native-google-cast';
import type { MediaMaxClient } from '@/api/client';
import type { PlaybackInfo, SubtitleTrack } from '@/api/types';
import { languageName } from '@/utils/format';

type CastLib = typeof import('react-native-google-cast');

let cached: CastLib | null | undefined;

/** The cast library, or null where it cannot work (TV, web, Expo Go, builds without the plugin). */
export function castLib(): CastLib | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (Platform.isTV || (Platform.OS !== 'ios' && Platform.OS !== 'android')) return cached;
  // The JS package touches NativeModules at import time; only load it when the native side exists.
  if (!NativeModules.RNGCCastContext || !NativeModules.RNGCSessionManager) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require('react-native-google-cast') as CastLib;
  } catch {
    cached = null;
  }
  return cached;
}

export interface CastValue {
  /** Cast can be used in this build on this device. */
  supported: boolean;
  /** A cast session is connected. */
  connected: boolean;
  /** Friendly name of the connected receiver ("Living Room TV"). */
  deviceName: string | null;
  client: RemoteMediaClient | null;
  mediaStatus: MediaStatus | null;
  /** Receiver stream position in ms (updated about once a second). */
  positionMs: number;
  /** Disconnect from the receiver (stops what it is playing). */
  disconnect: () => void;
}

const NONE: CastValue = { supported: false, connected: false, deviceName: null, client: null, mediaStatus: null, positionMs: 0, disconnect: () => undefined };
const Ctx = createContext<CastValue>(NONE);

type Session = NonNullable<Awaited<ReturnType<ReturnType<CastLib['CastContext']['getSessionManager']>['getCurrentCastSession']>>>;

export function CastProvider({ children }: { children: React.ReactNode }) {
  const lib = castLib();
  const [session, setSession] = useState<Session | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [mediaStatus, setMediaStatus] = useState<MediaStatus | null>(null);
  const [positionMs, setPositionMs] = useState(0);

  // Session lifecycle.
  useEffect(() => {
    if (!lib) return;
    let alive = true;
    let subs: { remove: () => void }[] = [];
    try {
      const sm = lib.CastContext.getSessionManager();
      sm.getCurrentCastSession()
        .then((s) => alive && setSession(s))
        .catch(() => undefined);
      subs = [
        sm.onSessionStarted((s) => setSession(s)),
        sm.onSessionResumed((s) => setSession(s)),
        sm.onSessionSuspended(() => setSession(null)),
        sm.onSessionEnded(() => setSession(null)),
      ];
    } catch {
      /* native side not initialised */
    }
    return () => {
      alive = false;
      subs.forEach((s) => s.remove());
    };
  }, [lib]);

  // Receiver name, media status and position for the current session.
  useEffect(() => {
    if (!session) {
      setDeviceName(null);
      setMediaStatus(null);
      setPositionMs(0);
      return;
    }
    let alive = true;
    session
      .getCastDevice()
      .then((d) => alive && setDeviceName(d?.friendlyName ?? null))
      .catch(() => undefined);
    const client = session.client;
    client
      .getMediaStatus()
      .then((s) => alive && setMediaStatus(s))
      .catch(() => undefined);
    const a = client.onMediaStatusUpdated((s) => {
      setMediaStatus(s);
      if (s) setPositionMs(Math.round(s.streamPosition * 1000));
    });
    const b = client.onMediaProgressUpdated((progress) => setPositionMs(Math.round(progress * 1000)), 1);
    return () => {
      alive = false;
      a.remove();
      b.remove();
    };
  }, [session]);

  const disconnect = useCallback(() => {
    if (!lib) return;
    try {
      void lib.CastContext.getSessionManager().endCurrentSession(true).catch(() => undefined);
    } catch {
      /* ignore */
    }
  }, [lib]);

  const value = useMemo<CastValue>(
    () => (lib ? { supported: true, connected: !!session, deviceName, client: session?.client ?? null, mediaStatus, positionMs, disconnect } : NONE),
    [lib, session, deviceName, mediaStatus, positionMs, disconnect],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCast(): CastValue {
  return useContext(Ctx);
}

/** The native Cast button (opens the device picker / disconnect dialog). Renders nothing where Cast is unavailable. */
export function CastButton({ tint = '#fff', size = 34, style }: { tint?: string; size?: number; style?: StyleProp<ViewStyle> }) {
  const lib = castLib();
  if (!lib) return null;
  const Native = lib.CastButton;
  return <Native accessibilityLabel="Cast" tintColor={tint} style={[{ width: size, height: size }, style, { tintColor: tint } as ViewStyle]} />;
}

/** Is the receiver playing the media we loaded (and not something another screen or sender put there)? */
export function isOurMedia(status: MediaStatus | null, url: string | null): boolean {
  if (!status || !url) return false;
  const mi = status.mediaInfo;
  if (!mi) return true; // some receivers omit mediaInfo in progress updates
  return mi.contentUrl === url || mi.contentId === url;
}

/** Text tracks for the receiver, ids 1..n in `info.subtitles` order. */
export function castSubtitleTracks(api: MediaMaxClient, subs: SubtitleTrack[]): MediaTrack[] {
  return subs.map((s, i) => ({
    id: i + 1,
    type: 'text',
    subtype: 'subtitles',
    contentId: api.withAuthQuery(s.url),
    contentType: 'text/vtt',
    language: s.language ?? undefined,
    name: s.title ?? languageName(s.language),
  }));
}

/**
 * Build the receiver's MediaInfo for a PlaybackInfo the server returned for a
 * cast profile. `info.url` is server-relative and already carries `?token=`.
 */
export function castMediaInfo(
  api: MediaMaxClient,
  info: PlaybackInfo,
  opts: { live?: boolean; audio?: boolean; title?: string; subtitle?: string | null; posterPath?: string | null } = {},
): MediaInfo {
  const url = api.absolute(info.url);
  const poster = api.image(opts.posterPath ?? info.posterUrl ?? info.backdropUrl, 800);
  const images = poster ? [{ url: poster }] : [];
  const title = opts.title ?? info.title;
  const subtitle = opts.subtitle ?? info.subtitle ?? undefined;
  const lib = castLib();
  return {
    contentId: url,
    contentUrl: url,
    contentType: info.mimeType || (info.isHls ? 'application/x-mpegURL' : 'video/mp4'),
    streamType: (opts.live ? lib?.MediaStreamType.LIVE ?? 'live' : lib?.MediaStreamType.BUFFERED ?? 'buffered') as MediaInfo['streamType'],
    ...(info.isHls && lib
      ? { hlsSegmentFormat: opts.audio ? lib.MediaHlsSegmentFormat.TS_AAC : lib.MediaHlsSegmentFormat.TS, ...(opts.audio ? {} : { hlsVideoSegmentFormat: lib.MediaHlsVideoSegmentFormat.MPEG2_TS }) }
      : {}),
    streamDuration: !opts.live && info.durationMs ? info.durationMs / 1000 : undefined,
    metadata: opts.audio ? { type: 'musicTrack', title, artist: subtitle, images } : { type: 'generic', title, subtitle, images },
    mediaTracks: opts.audio ? [] : castSubtitleTracks(api, info.subtitles),
  };
}
