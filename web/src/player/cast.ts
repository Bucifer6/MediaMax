/**
 * Google Cast (Chromecast) sender support.
 *
 * The Cast Web Sender SDK is loaded lazily, only in Chrome/Edge, only on a secure origin and only
 * when a player asks for it. Everything here is optional: if the SDK can't load, `useCast` simply
 * reports `available: false` and the UI hides its cast button.
 */
import { useCallback, useEffect, useState } from 'react';
import type { DeviceProfile } from '@mediamax/shared';

/* eslint-disable @typescript-eslint/no-explicit-any */
type CastNs = any;
declare global {
  interface Window {
    __onGCastApiAvailable?: (available: boolean) => void;
    cast?: CastNs;
    chrome?: CastNs;
  }
}

const SDK_URL = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';

/**
 * Chrome / Edge (desktop or Android) by user agent. TV browsers are left out even when their user agent says Chrome
 * (LG webOS does): casting from a TV makes no sense, and it keeps the TV apps from loading Google's SDK.
 */
export function castUserAgent(ua: string): boolean {
  if (/HeadlessChrome|OPR\/|Opera|SamsungBrowser|YaBrowser|Electron/i.test(ua)) return false;
  if (/Web0S|webOS|NetCast|Tizen|SMART-TV|SmartTV|VIDAA|Hisense|CrKey|AFT[A-Z]|BRAVIA|Android TV|GoogleTV/i.test(ua)) return false;
  return /\b(Chrome|Chromium|Edg)\/\d+/.test(ua);
}

/** Chrome / Edge (desktop or Android) on a secure origin, not an automated test browser or a TV. */
export function castSupported(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (!window.isSecureContext) return false;
  if ((navigator as Navigator & { webdriver?: boolean }).webdriver) return false;
  if (document.documentElement.classList.contains('tv')) return false;
  return castUserAgent(navigator.userAgent);
}

let sdkPromise: Promise<boolean> | null = null;

/** Load the SDK once; resolves false (never rejects) when Cast isn't usable. */
export function loadCastSdk(): Promise<boolean> {
  if (sdkPromise) return sdkPromise;
  if (!castSupported()) return (sdkPromise = Promise.resolve(false));
  sdkPromise = new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      if (ok) {
        try {
          const { cast, chrome } = window;
          cast.framework.CastContext.getInstance().setOptions({
            receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
            autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
          });
        } catch {
          ok = false;
        }
      }
      resolve(ok);
    };
    if (window.cast?.framework && window.chrome?.cast) {
      finish(true);
      return;
    }
    const prev = window.__onGCastApiAvailable;
    window.__onGCastApiAvailable = (available: boolean) => {
      prev?.(available);
      finish(available && !!window.cast?.framework);
    };
    const s = document.createElement('script');
    s.src = SDK_URL;
    s.async = true;
    s.onerror = () => finish(false);
    document.head.appendChild(s);
    window.setTimeout(() => finish(false), 15000);
  });
  return sdkPromise;
}

/** Device profile for the Default Media Receiver: H.264 + AAC/MP3 in MP4 or HLS, up to 1080p. */
export function castDeviceProfile(maxBitrate?: number | null, audioOnly = false): DeviceProfile {
  return {
    videoCodecs: audioOnly ? [] : ['h264'],
    audioCodecs: ['aac', 'mp3'],
    containers: audioOnly ? ['mp3', 'm4a', 'aac', 'mp4'] : ['mp4', 'm4v'],
    supportsHls: true,
    maxWidth: 1920,
    maxBitrate: maxBitrate ?? 20000,
  };
}

/** Absolute URL a Chromecast can reach (server-relative URLs get the public URL or this origin). */
export function absoluteUrl(url: string | null | undefined, base?: string | null): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  const root = (base || window.location.origin).replace(/\/+$/, '');
  return root + (url.startsWith('/') ? url : `/${url}`);
}

export interface CastMedia {
  url: string;
  contentType: string;
  live?: boolean;
  kind: 'movie' | 'episode' | 'music' | 'generic';
  title: string;
  subtitle?: string | null;
  /** For music: album name. */
  album?: string | null;
  imageUrl?: string | null;
  startSeconds?: number;
  subtitles?: { url: string; language: string | null; label: string }[];
  /** Index into `subtitles` to show, or null. */
  activeSubtitle?: number | null;
}

export interface RemoteState {
  currentTime: number;
  duration: number;
  isPaused: boolean;
  volume: number;
  muted: boolean;
  playerState: string | null;
  idleReason: string | null;
  mediaLoaded: boolean;
}

const EMPTY_REMOTE: RemoteState = { currentTime: 0, duration: 0, isPaused: true, volume: 1, muted: false, playerState: null, idleReason: null, mediaLoaded: false };

let remote: { player: CastNs; controller: CastNs } | null = null;
function remotePlayer() {
  if (!remote) {
    const { cast } = window;
    const player = new cast.framework.RemotePlayer();
    remote = { player, controller: new cast.framework.RemotePlayerController(player) };
  }
  return remote;
}

export interface CastHandle {
  /** SDK loaded and at least one receiver found. */
  available: boolean;
  connected: boolean;
  connecting: boolean;
  deviceName: string | null;
  remote: RemoteState;
  /** Open the device picker, or disconnect when already connected. */
  toggle: () => void;
  disconnect: () => void;
  load: (m: CastMedia) => Promise<void>;
  playOrPause: () => void;
  seek: (seconds: number) => void;
  setVolume: (v: number) => void;
  setMuted: (m: boolean) => void;
  stop: () => void;
  setSubtitle: (trackIndex: number | null) => void;
}

/** Cast state for a player. Loads the SDK the first time `enabled` is true. */
export function useCast(enabled: boolean): CastHandle {
  const [ready, setReady] = useState(false);
  const [castState, setCastState] = useState<string>('NO_DEVICES_AVAILABLE');
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [state, setState] = useState<RemoteState>(EMPTY_REMOTE);
  useEffect(() => {
    if (!enabled || ready) return;
    let cancelled = false;
    loadCastSdk().then((ok) => {
      if (!cancelled && ok) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, ready]);

  useEffect(() => {
    if (!ready) return;
    const { cast } = window;
    let ctx: CastNs;
    try {
      ctx = cast.framework.CastContext.getInstance();
    } catch {
      return;
    }
    const readDevice = () => {
      try {
        setDeviceName(ctx.getCurrentSession()?.getCastDevice()?.friendlyName ?? null);
      } catch {
        setDeviceName(null);
      }
    };
    const onCastState = (e: { castState: string }) => {
      setCastState(e.castState);
      readDevice();
    };
    const onSession = () => readDevice();
    const { player, controller } = remotePlayer();
    const readRemote = () => {
      let idleReason: string | null = null;
      try {
        idleReason = ctx.getCurrentSession()?.getMediaSession()?.idleReason ?? null;
      } catch {
        /* no media session */
      }
      setState({
        currentTime: Number(player.currentTime) || 0,
        duration: Number(player.duration) || 0,
        isPaused: !!player.isPaused,
        volume: typeof player.volumeLevel === 'number' ? player.volumeLevel : 1,
        muted: !!player.isMuted,
        playerState: player.playerState ?? null,
        idleReason,
        mediaLoaded: !!player.isMediaLoaded,
      });
    };
    setCastState(ctx.getCastState());
    readDevice();
    readRemote();
    ctx.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, onCastState);
    ctx.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, onSession);
    controller.addEventListener(cast.framework.RemotePlayerEventType.ANY_CHANGE, readRemote);
    return () => {
      ctx.removeEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, onCastState);
      ctx.removeEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, onSession);
      controller.removeEventListener(cast.framework.RemotePlayerEventType.ANY_CHANGE, readRemote);
    };
  }, [ready]);

  const connected = ready && castState === 'CONNECTED';
  const ctx = () => window.cast.framework.CastContext.getInstance();

  const toggle = useCallback(() => {
    if (!ready) return;
    try {
      if (ctx().getCastState() === 'CONNECTED') ctx().endCurrentSession(true);
      else void ctx().requestSession().catch(() => undefined); // cancelled picker rejects
    } catch {
      /* ignore */
    }
  }, [ready]);

  const disconnect = useCallback(() => {
    if (!ready) return;
    try {
      ctx().endCurrentSession(true);
    } catch {
      /* ignore */
    }
  }, [ready]);

  const load = useCallback(async (m: CastMedia) => {
    const { chrome } = window;
    const session = ctx().getCurrentSession();
    if (!session) throw new Error('Not connected to a Cast device');
    const info = new chrome.cast.media.MediaInfo(m.url, m.contentType);
    info.streamType = m.live ? chrome.cast.media.StreamType.LIVE : chrome.cast.media.StreamType.BUFFERED;
    if (/mpegurl/i.test(m.contentType)) {
      // Kinora HLS uses MPEG-TS segments.
      try {
        info.hlsSegmentFormat = chrome.cast.media.HlsSegmentFormat.TS;
        if (m.kind !== 'music' && chrome.cast.media.HlsVideoSegmentFormat) info.hlsVideoSegmentFormat = chrome.cast.media.HlsVideoSegmentFormat.MPEG2_TS;
      } catch {
        /* older SDK */
      }
    }
    let md: CastNs;
    if (m.kind === 'music') {
      md = new chrome.cast.media.MusicTrackMediaMetadata();
      md.artist = m.subtitle ?? undefined;
      md.albumName = m.album ?? undefined;
    } else if (m.kind === 'movie') {
      md = new chrome.cast.media.MovieMediaMetadata();
      md.subtitle = m.subtitle ?? undefined;
    } else if (m.kind === 'episode') {
      md = new chrome.cast.media.TvShowMediaMetadata();
      md.seriesTitle = m.subtitle ?? undefined;
    } else {
      md = new chrome.cast.media.GenericMediaMetadata();
      md.subtitle = m.subtitle ?? undefined;
    }
    md.title = m.title;
    if (m.imageUrl) md.images = [new chrome.cast.Image(m.imageUrl)];
    info.metadata = md;
    const subs = m.subtitles ?? [];
    if (subs.length) {
      info.tracks = subs.map((s, i) => {
        const t = new chrome.cast.media.Track(i + 1, chrome.cast.media.TrackType.TEXT);
        t.trackContentId = s.url;
        t.trackContentType = 'text/vtt';
        t.subtype = chrome.cast.media.TextTrackType.SUBTITLES;
        t.name = s.label;
        t.language = s.language ?? undefined;
        return t;
      });
      info.textTrackStyle = new chrome.cast.media.TextTrackStyle();
    }
    const req = new chrome.cast.media.LoadRequest(info);
    req.autoplay = true;
    req.currentTime = m.live ? undefined : Math.max(0, m.startSeconds ?? 0);
    req.activeTrackIds = m.activeSubtitle != null && subs[m.activeSubtitle] ? [m.activeSubtitle + 1] : [];
    const err = await session.loadMedia(req);
    if (err) throw new Error(`Cast device refused the stream (${String(err)})`);
  }, []);

  const playOrPause = useCallback(() => {
    if (connected) remotePlayer().controller.playOrPause();
  }, [connected]);
  const seek = useCallback((seconds: number) => {
    if (!connected) return;
    const { player, controller } = remotePlayer();
    player.currentTime = Math.max(0, seconds);
    controller.seek();
  }, [connected]);
  const setVolume = useCallback((v: number) => {
    if (!connected) return;
    const { player, controller } = remotePlayer();
    player.volumeLevel = Math.max(0, Math.min(1, v));
    controller.setVolumeLevel();
  }, [connected]);
  const setMuted = useCallback((m: boolean) => {
    if (!connected) return;
    const { player, controller } = remotePlayer();
    if (!!player.isMuted !== m) controller.muteOrUnmute();
  }, [connected]);
  const stop = useCallback(() => {
    if (!connected) return;
    try {
      remotePlayer().controller.stop();
    } catch {
      /* ignore */
    }
  }, [connected]);
  const setSubtitle = useCallback((trackIndex: number | null) => {
    if (!connected) return;
    try {
      const { chrome } = window;
      const media = ctx().getCurrentSession()?.getMediaSession();
      if (!media) return;
      const req = new chrome.cast.media.EditTracksInfoRequest(trackIndex == null ? [] : [trackIndex + 1]);
      media.editTracksInfo(req, () => undefined, () => undefined);
    } catch {
      /* ignore */
    }
  }, [connected]);

  return {
    available: ready && castState !== 'NO_DEVICES_AVAILABLE',
    connected,
    connecting: ready && castState === 'CONNECTING',
    deviceName,
    remote: state,
    toggle,
    disconnect,
    load,
    playOrPause,
    seek,
    setVolume,
    setMuted,
    stop,
    setSubtitle,
  };
}

/** HLS content type the Default Media Receiver expects. */
export function castContentType(mimeType: string, isHls: boolean): string {
  if (isHls || /mpegurl/i.test(mimeType)) return 'application/x-mpegURL';
  return mimeType || 'video/mp4';
}

/* The video player, live player and music player share one Cast session; the last one to load media owns it. */
export type CastOwner = 'video' | 'live' | 'music';
export const CAST_OWNER_EVENT = 'mm:cast-owner';
let owner: CastOwner | null = null;
export function claimCast(o: CastOwner) {
  owner = o;
  window.dispatchEvent(new CustomEvent<CastOwner>(CAST_OWNER_EVENT, { detail: o }));
}
export const castOwner = () => owner;
