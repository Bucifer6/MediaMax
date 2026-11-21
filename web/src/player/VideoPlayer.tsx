import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type TouchEvent as ReactTouchEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { AudioComforts, Item, Marker, PlaybackInfo, PlaybackRequest, Renderer, SubtitleFormat, SubtitleStyle, TrickplayInfo } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useMusic } from './music';
import { attachStream, type Attached } from './engine';
import { profileWithBitrate, QUALITY_OPTIONS } from './deviceProfile';
import { capabilitiesReady } from './capabilities';
import { audioCaps, audioCapsReady } from './audioCaps';
import { AudioFx, clientFx, comfortRequest, deviceComforts, fxActive } from './audioFx';
import { AudioBadges, audioDecisionText, audioSummary } from '../components/AudioBadge';
import { getDeviceId } from '../api/device';
import { RangeBadge, rangeDeliveryText } from '../components/HdrBadge';
import { OptionList, Popover, SeekBar, VolumeControl } from './controls';
import { useSyncPlay } from './syncplay';
import { absoluteUrl, castContentType, castDeviceProfile, claimCast, useCast } from './cast';
import { CastMenu } from './CastMenu';
import { useAirPlay, useRendererRemote } from './renderers';
import { Icon } from '../components/Icon';
import { Img, Spinner } from '../components/ui';
import { canSearchSubtitles, SubtitleSearchModal } from '../components/SubtitleSearch';
import { ChapterList } from './MiniPlayer';
import { DEFAULT_PREFERENCES } from '../theme/defaults';
import { isTypingTarget } from '../hooks';
import { formatClock, languageName } from '../utils/format';
import { useRemoteTarget } from '../remote/useRemoteTarget';
import { openPairDialog } from '../remote/api';
import { isResumable } from '../utils/items';
import { SUBTITLE_FIELD_LABELS, SUBTITLE_OPTIONS, subtitleStyleOf } from './subtitleStyle';
import { SubtitleOverlay, type SubtitleStatus } from './subtitles/SubtitleOverlay';
import { useAdaptive } from './useAdaptive';
import { initialBandwidth } from './bandwidth';
import { formatBps } from './abr';
import { VideoPair, whenPlayable } from './videoPair';
import { helpForReason, helpPath } from '../utils/helpLinks';
import { useMarathon } from './Marathon';

/** Subtitle formats our own renderer draws (SubtitleOverlay). VobSub/DVB still need server burn-in. */
const SUBTITLE_FORMATS: SubtitleFormat[] = ['srt', 'vtt', 'ass', 'pgs'];
/** Seamless switches start the new stream this far ahead of the playhead, so it is ready when the old one gets there. */
const SWITCH_LEAD_MS = 4000;
const isTvMode = () => typeof document !== 'undefined' && document.documentElement.classList.contains('tv');

type Menu = null | 'audio' | 'subs' | 'subStyle' | 'sync' | 'quality' | 'speed' | 'together' | 'chapters';
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
/** Subtitle delay range / step (ms), as in VLC's G/H. */
const SUB_DELAY_MAX = 10000;
const SUB_DELAY_STEP = 100;
/** Audio delay (ms): Web Audio can only hold the sound back, so it is 0..+AUDIO_DELAY_MAX. */
const AUDIO_DELAY_MAX = 3000;
const AUDIO_DELAY_STEP = 50;
/** Two taps within this window count as a double tap (touch: skip 10s on the left/right third). */
const DOUBLE_TAP_MS = 300;

const syncKey = (id: string) => `mm.sync.${id}`;
/** Sync offsets are remembered per item for the browser session. */
function loadSync(id: string): { sub: number; audio: number } {
  try {
    const v = JSON.parse(sessionStorage.getItem(syncKey(id)) ?? '{}') as { sub?: number; audio?: number };
    return { sub: Number(v.sub) || 0, audio: Number(v.audio) || 0 };
  } catch {
    return { sub: 0, audio: 0 };
  }
}
function saveSync(id: string, sub: number, audio: number) {
  try {
    if (!sub && !audio) sessionStorage.removeItem(syncKey(id));
    else sessionStorage.setItem(syncKey(id), JSON.stringify({ sub, audio }));
  } catch {
    /* ignore */
  }
}
export function formatDelay(ms: number) {
  const r = Math.round(ms / 10) * 10;
  const abs = Math.abs(r / 1000).toFixed(r % 100 ? 2 : 1);
  return `${r > 0 ? '+' : r < 0 ? '\u2212' : ''}${abs}s`;
}

interface Stats {
  engine: string;
  method: string;
  resolution: string;
  videoCodec: string;
  audioCodec: string;
  bitrate: string;
  bandwidth: string;
  buffer: string;
  dropped: string;
  extra: string;
  /** HDR format and how it reaches this device (e.g. "Dolby Vision 8.1 → HDR10 base layer"). */
  range?: string;
  /** Why the server remuxes / transcodes (each reason links to its Help Centre explanation). */
  why?: string[];
  /** Adaptive quality: mode, level, estimated bandwidth. */
  abr?: string;
  /** Subtitle renderer in use. */
  subs?: string;
  /** Listening comforts and where they run (server / this browser). */
  audioFx?: string;
}

/** "night mode (server), dialogue boost (browser)" for the stats overlay. */
function audioFxText(pi: PlaybackInfo | null, c: AudioComforts, webFx: boolean): string | undefined {
  const applied = new Set(pi?.audio?.applied ?? []);
  const names: [keyof AudioComforts, string][] = [['nightMode', 'night mode'], ['dialogueBoost', 'dialogue boost'], ['normalize', 'normalise'], ['delayMs', `lip-sync ${formatDelay(c.delayMs ?? 0)}`]];
  const parts = names.filter(([k]) => c[k]).map(([k, n]) => `${n} (${applied.has(k) ? 'server' : webFx && k !== 'normalize' && !(k === 'delayMs' && (c.delayMs ?? 0) < 0) ? 'browser' : 'off'})`);
  return parts.length ? parts.join(', ') : undefined;
}

interface StartOpts {
  startMs: number;
  audioIndex?: number;
  subtitleIndex: number | null;
  burn: boolean;
  maxBitrate: number | null;
  /** Automatic quality: adaptive stream + measured bandwidth (abr.ts / useAdaptive.ts). */
  auto?: boolean;
  /** Bandwidth (kbps) to report for this start (an ABR restart); otherwise the current estimate / probe is used. */
  measuredKbps?: number | null;
}

export default function VideoPlayer() {
  const { itemId = '' } = useParams();
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const { user, system, setUser } = useApp();
  const toast = useToast();
  const music = useMusic();
  const cast = useCast(true);
  const castRef = useRef(cast);
  castRef.current = cast;
  /** True while playback happens on a Cast device (the local <video> is idle). */
  const castingRef = useRef(false);
  const castSidRef = useRef<string | null>(null);
  const castOffsetRef = useRef(0);
  const [casting, setCasting] = useState(false);
  const prefs = { ...DEFAULT_PREFERENCES, ...(user?.preferences ?? {}) };
  const subStyle = subtitleStyleOf(prefs.subtitleStyle);
  const subStyleRef = useRef(subStyle);
  subStyleRef.current = subStyle;

  /** The <video> currently playing: one of two elements, swapped for seamless quality switches (videoPair.ts). */
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const pairRef = useRef<VideoPair | null>(null);
  const [activeVideo, setActiveVideo] = useState<HTMLVideoElement | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const attached = useRef<Attached | null>(null);
  const sessionRef = useRef<string | null>(null);
  const offsetRef = useRef(0);
  const pendingSeek = useRef<number | null>(null);
  const [autoQuality, setAutoQuality] = useState(prefs.maxBitrate == null && prefs.autoQuality !== false);
  const optsRef = useRef<StartOpts>({ startMs: 0, subtitleIndex: null, burn: false, maxBitrate: prefs.maxBitrate, auto: autoQuality });
  const skippedMarkers = useRef(new Set<string>());

  const [item, setItem] = useState<Item | null>(null);
  const [info, setInfo] = useState<PlaybackInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [buffering, setBuffering] = useState(true);
  const [paused, setPaused] = useState(true);
  const [positionMs, setPositionMs] = useState(0);
  const [bufferedMs, setBufferedMs] = useState(0);
  const [volume, setVolume] = useState(() => {
    try {
      const v = Number(localStorage.getItem('mm.videoVolume'));
      return isFinite(v) && v > 0 && v <= 1 ? v : 1;
    } catch {
      return 1;
    }
  });
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [controls, setControls] = useState(true);
  const [menu, setMenu] = useState<Menu>(null);
  const [subtitleIndex, setSubtitleIndex] = useState<number | null>(null);
  // The admin dashboard shows which subtitle is on (text subtitles are rendered here, so only the player knows).
  const subtitleIndexRef = useRef<number | null>(null);
  subtitleIndexRef.current = subtitleIndex;
  const [burned, setBurned] = useState(false);
  const [audioIndex, setAudioIndex] = useState<number | undefined>(undefined);
  const [maxBitrate, setMaxBitrate] = useState<number | null>(prefs.maxBitrate);
  const [nextItem, setNextItem] = useState<Item | null>(null);
  const [upNextDismissed, setUpNextDismissed] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [ended, setEnded] = useState(false);
  const [osd, setOsd] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [trickplay, setTrickplay] = useState<TrickplayInfo | null>(null);
  /** Arrow-key / TV-remote seeks: where the preview should show for a moment. */
  const [keySeekMs, setKeySeekMs] = useState<number | null>(null);
  const keySeekTimer = useRef<number | null>(null);
  const previewKeySeek = (ms: number) => {
    setKeySeekMs(Math.max(0, durationMs ? Math.min(durationMs, ms) : ms));
    if (keySeekTimer.current) window.clearTimeout(keySeekTimer.current);
    keySeekTimer.current = window.setTimeout(() => setKeySeekMs(null), 1500);
  };
  const [subSearch, setSubSearch] = useState(false);
  /** Subtitle index to select once the next PlaybackInfo arrives (after an online download). */
  const pendingSubPick = useRef<number | null>(null);
  /** Subtitle / audio sync offsets (ms); positive = later. */
  const [subDelayMs, setSubDelayMs] = useState(() => loadSync(itemId).sub);
  const [audioDelayMs, setAudioDelayMs] = useState(() => Math.max(0, loadSync(itemId).audio));
  const subDelayRef = useRef(subDelayMs);
  subDelayRef.current = subDelayMs;
  const [syncToast, setSyncToast] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [showStats, setShowStats] = useState(false);
  /** Listening comforts (night mode, dialogue boost, normalise, lip-sync) for this device: see audioFx.ts. */
  const [comforts, setComforts] = useState<AudioComforts>(() => deviceComforts(user?.preferences, getDeviceId()));
  const comfortsRef = useRef(comforts);
  comfortsRef.current = comforts;
  const [tapSkip, setTapSkip] = useState<{ side: 'left' | 'right'; n: number } | null>(null);

  const durationMs = info?.durationMs ?? item?.durationMs ?? 0;
  const markers: Marker[] = info?.markers?.length ? info.markers : item?.markers ?? [];

  /* ---------------- adaptive quality (Auto) ---------------- */
  const restartRef = useRef<(kbps: number) => void>(() => {});
  const adaptive = useAdaptive({
    enabled: autoQuality && !casting,
    info,
    attached,
    video: () => videoRef.current,
    onRestart: (kbps) => restartRef.current(kbps),
    notify: (text, kind) => (kind === 'down' ? toast.show(text) : flash(text)),
  });
  const adaptiveRef = useRef(adaptive);
  adaptiveRef.current = adaptive;
  /** Stream that is being replaced by a seamless switch: its errors (its session has ended) are expected. */
  const retiringRef = useRef<Attached | null>(null);
  /** Bumped by every (re)start, so an in-flight seamless switch knows it was overtaken. */
  const genRef = useRef(0);

  /** Playback request: the subtitle formats we render, and in Auto mode the adaptive flag + measured bandwidth. */
  const playbackRequest = async (opts: StartOpts): Promise<PlaybackRequest> => {
    let kbps: number | null = null;
    if (opts.auto) {
      const est = adaptiveRef.current.estimator.current.estimate;
      if (opts.measuredKbps != null) kbps = opts.measuredKbps;
      else if (est) kbps = Math.round(est / 1000);
      else {
        const bw = await initialBandwidth();
        adaptiveRef.current.seed(bw.bps);
        kbps = bw.bps ? Math.round(bw.bps / 1000) : null;
      }
    }
    return {
      startMs: Math.round(opts.startMs),
      audioStreamIndex: opts.audioIndex,
      subtitleStreamIndex: opts.burn ? opts.subtitleIndex : undefined,
      burnSubtitles: opts.burn || undefined,
      deviceProfile: profileWithBitrate(opts.auto ? null : opts.maxBitrate),
      subtitleFormats: SUBTITLE_FORMATS,
      ...comfortRequest(comfortsRef.current, audioCaps()?.webAudioFx ?? false),
      ...(opts.auto ? { adaptive: true, measuredBandwidth: kbps } : {}),
    };
  };
  const abrAttachOptions = (opts: StartOpts) => ({
    manualLevels: !!opts.auto,
    onFragment: adaptiveRef.current.onFragment,
    onLevelSwitched: adaptiveRef.current.onLevelSwitched,
  });

  // The two <video> elements (videoPair.ts) live in a host div the player owns.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const pair = new VideoPair(host, 'player-video');
    pairRef.current = pair;
    videoRef.current = pair.active;
    setActiveVideo(pair.active);
    return () => {
      pair.destroy();
      pairRef.current = null;
      videoRef.current = null;
    };
  }, []);

  /* ---------------- helpers ---------------- */
  const flash = useCallback((text: string) => {
    setOsd(text);
    window.clearTimeout((flash as unknown as { t?: number }).t);
    (flash as unknown as { t?: number }).t = window.setTimeout(() => setOsd(null), 900);
  }, []);

  const showSyncToast = useCallback((text: string) => {
    setSyncToast(text);
    window.clearTimeout((showSyncToast as unknown as { t?: number }).t);
    (showSyncToast as unknown as { t?: number }).t = window.setTimeout(() => setSyncToast(null), 1400);
  }, []);

  const currentMs = useCallback(() => {
    if (castingRef.current) return castOffsetRef.current + castRef.current.remote.currentTime * 1000;
    const v = videoRef.current;
    return v ? offsetRef.current + v.currentTime * 1000 : 0;
  }, []);

  const report = useCallback((state: 'playing' | 'paused' | 'stopped', keepalive = false) => {
    const sid = sessionRef.current;
    if (!sid) return;
    api.playback.progress(sid, { positionMs: Math.round(currentMs()), durationMs: durationMs || undefined, state, sessionId: sid, subtitleIndex: subtitleIndexRef.current }, keepalive).catch(() => {});
  }, [currentMs, durationMs]);

  const endSession = useCallback((keepalive = false) => {
    const sid = sessionRef.current;
    if (!sid) return;
    report('stopped', keepalive);
    api.playback.stop(sid, keepalive).catch(() => {});
    sessionRef.current = null;
  }, [report]);

  const reportCast = useCallback((state: 'playing' | 'paused' | 'stopped', keepalive = false) => {
    const sid = castSidRef.current;
    if (!sid) return;
    const pos = castOffsetRef.current + castRef.current.remote.currentTime * 1000;
    api.playback.progress(sid, { positionMs: Math.round(pos), durationMs: durationMs || undefined, state, sessionId: sid }, keepalive).catch(() => {});
  }, [durationMs]);

  const endCastSession = useCallback((keepalive = false) => {
    const sid = castSidRef.current;
    if (!sid) return;
    reportCast('stopped', keepalive);
    api.playback.stop(sid, keepalive).catch(() => {});
    castSidRef.current = null;
  }, [reportCast]);

  const itemRef = useRef(item);
  itemRef.current = item;
  const subtitleRef = useRef<number | null>(null);

  /** Start (or restart) playback on the Cast device with a Chromecast-friendly stream. */
  const startCastRef = useRef<(opts: StartOpts) => Promise<void>>(async () => {});
  startCastRef.current = async (opts: StartOpts) => {
    optsRef.current = opts;
    setError(null);
    endCastSession();
    try {
      const pi = await api.playback.start(itemId, {
        startMs: Math.round(opts.startMs),
        audioStreamIndex: opts.audioIndex,
        subtitleStreamIndex: opts.burn ? opts.subtitleIndex : undefined,
        burnSubtitles: opts.burn || undefined,
        deviceProfile: castDeviceProfile(opts.maxBitrate),
      });
      if (!castingRef.current) {
        api.playback.stop(pi.sessionId).catch(() => {});
        return;
      }
      castSidRef.current = pi.sessionId;
      castOffsetRef.current = pi.streamStartMs ?? 0;
      setInfo(pi);
      setBurned(opts.burn);
      setBuffering(false);
      setPositionMs(opts.startMs);
      const base = system?.publicUrl;
      const it = itemRef.current;
      const subs = opts.burn ? [] : pi.subtitles;
      const active = subs.findIndex((x) => x.index === subtitleRef.current);
      claimCast('video');
      await castRef.current.load({
        url: absoluteUrl(pi.url, base)!,
        contentType: castContentType(pi.mimeType, pi.isHls),
        kind: it?.type === 'episode' ? 'episode' : it?.type === 'movie' ? 'movie' : 'generic',
        title: pi.title || it?.title || '',
        subtitle: pi.subtitle ?? (it?.type === 'episode' ? it.grandparentTitle : it?.year ? String(it.year) : null),
        imageUrl: absoluteUrl(pi.posterUrl ?? it?.posterUrl ?? pi.backdropUrl, base),
        startSeconds: Math.max(0, (opts.startMs - castOffsetRef.current) / 1000),
        subtitles: subs.map((x) => ({ url: absoluteUrl(x.url, base)!, language: x.language, label: x.title || languageName(x.language) })),
        activeSubtitle: active >= 0 ? active : null,
      });
      reportCast('playing');
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  /* ---------------- start / restart playback ---------------- */
  const start = useCallback(async (opts: StartOpts) => {
    const v = videoRef.current;
    if (!v) return;
    if (castingRef.current) {
      await startCastRef.current(opts);
      return;
    }
    optsRef.current = { ...opts, measuredKbps: undefined };
    genRef.current++;
    retiringRef.current = null;
    setError(null);
    setBuffering(true);
    endSession();
    attached.current?.destroy();
    attached.current = null;
    try {
      await capabilitiesReady(); // HDR / 10-bit detection (bounded wait), so the profile carries videoRange
      await audioCapsReady(); // speaker channels / multichannel / Atmos (bounded wait)
      const pi = await api.playback.start(itemId, await playbackRequest(opts));
      if (castingRef.current) {
        // Casting started while this request was in flight.
        api.playback.stop(pi.sessionId).catch(() => {});
        return;
      }
      sessionRef.current = pi.sessionId;
      offsetRef.current = 0;
      pendingSeek.current = opts.startMs > 0 ? opts.startMs : pi.startMs > 0 ? pi.startMs : null;
      setInfo(pi);
      setBurned(opts.burn);
      let me: Attached | null = null;
      me = attached.current = await attachStream(v, pi, {
        ...abrAttachOptions(opts),
        onFatal: (kind, msg) => {
          // A stream that was already replaced (seamless switch) may fail as its session ends: not an error.
          if (me && (attached.current !== me || retiringRef.current === me)) return;
          if (kind === 'native' && pi.method === 'direct' && !opts.burn) {
            // Browser couldn't decode the original — ask the server to transcode.
            toast.show('Switching to a compatible stream…');
            void start({ ...opts, startMs: currentMs() || opts.startMs, burn: false, maxBitrate: opts.maxBitrate ?? 20000, auto: false });
            return;
          }
          setError(msg);
        },
      });
      v.playbackRate = rate;
      await v.play().catch(() => setPaused(true));
    } catch (e) {
      setError(errorMessage(e));
      setBuffering(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId, endSession, rate]);

  /**
   * Switch to another stream without a visible restart (Auto quality: direct play ↔ transcode, another bitrate).
   * The new stream starts a few seconds ahead in the standby <video> while the current one keeps playing from its
   * buffer; when the playhead reaches the switch point the elements swap. Falls back to a plain restart when that
   * isn't possible (paused, Picture-in-Picture, Web Audio delay routing, casting).
   */
  const seamlessRestart = async (kbps: number) => {
    const old = videoRef.current;
    const pair = pairRef.current;
    const opts: StartOpts = { ...optsRef.current, auto: true };
    if (!old || !pair || castingRef.current || old.paused || audioGraph.current || document.pictureInPictureElement === old) {
      void start({ ...opts, startMs: currentMs() || opts.startMs, measuredKbps: kbps });
      return;
    }
    const gen = ++genRef.current;
    const nv = pair.standby;
    const startAt = currentMs() + SWITCH_LEAD_MS;
    let pi: PlaybackInfo;
    try {
      pi = await api.playback.start(itemId, await playbackRequest({ ...opts, startMs: startAt, measuredKbps: kbps }));
    } catch {
      return; // keep playing what we have
    }
    if (gen !== genRef.current || castingRef.current) {
      api.playback.stop(pi.sessionId).catch(() => {});
      return;
    }
    // The server replaced the previous session: the old element plays on from its buffer (direct play keeps streaming).
    retiringRef.current = attached.current;
    sessionRef.current = pi.sessionId;
    optsRef.current = { ...opts, measuredKbps: undefined };
    nv.muted = true;
    nv.volume = volume;
    nv.playbackRate = rate;
    let me: Attached | null = null;
    me = await attachStream(nv, pi, {
      ...abrAttachOptions(opts),
      onFatal: (_kind, msg) => {
        if (attached.current === me) setError(msg);
      },
    });
    const base = pi.streamStartMs ?? 0;
    await new Promise<void>((res) => {
      if (nv.readyState >= 1) return res();
      nv.addEventListener('loadedmetadata', () => res(), { once: true });
      window.setTimeout(res, 15000);
    });
    const seekLocal = Math.max(0, (startAt - base) / 1000);
    if (seekLocal > 0.5) nv.currentTime = seekLocal;
    const ok = await whenPlayable(nv, 20000);
    if (!ok || gen !== genRef.current) {
      me.destroy();
      if (gen === genRef.current) void start({ ...opts, startMs: currentMs(), measuredKbps: kbps });
      return;
    }
    // Let the old element play up to the switch point (it may run dry first).
    const deadline = performance.now() + SWITCH_LEAD_MS + 3000;
    while (currentMs() < startAt - 60 && performance.now() < deadline && !old.paused && !old.ended && gen === genRef.current) await new Promise((r) => window.setTimeout(r, 40));
    if (gen !== genRef.current) {
      me.destroy();
      return;
    }
    const userPaused = old.paused && !old.ended;
    const target = Math.max(0, (currentMs() - base) / 1000);
    if (Math.abs(nv.currentTime - target) > 0.3) nv.currentTime = target;
    nv.muted = muted;
    const prev = attached.current;
    attached.current = me;
    retiringRef.current = null;
    pair.swap();
    videoRef.current = nv;
    offsetRef.current = base;
    pendingSeek.current = null;
    setActiveVideo(nv);
    setInfo(pi);
    setBuffering(false);
    if (!userPaused) void nv.play().catch(() => setPaused(true));
    old.pause();
    prev?.destroy();
  };
  restartRef.current = (kbps) => void seamlessRestart(kbps);

  // Initial load whenever the item changes.
  useEffect(() => {
    let cancelled = false;
    music.pause();
    setItem(null);
    setInfo(null);
    setNextItem(null);
    setUpNextDismissed(false);
    setCountdown(null);
    setEnded(false);
    setTrickplay(null);
    setSubSearch(false);
    skippedMarkers.current.clear();
    const sy = loadSync(itemId);
    setSubDelayMs(sy.sub);
    setAudioDelayMs(Math.max(0, sy.audio));
    // Scrub previews (404 until the server has generated them — just go without).
    const tpCtrl = new AbortController();
    api.items.trickplay(itemId, undefined, tpCtrl.signal).then((tp) => {
      if (!cancelled && tp.count > 0 && tp.sheets.length) setTrickplay(tp);
    }).catch(() => {});
    (async () => {
      const it = await api.items.get(itemId).catch(() => null);
      if (cancelled) return;
      setItem(it);
      itemRef.current = it;
      const fromParam = sp.get('start');
      const startMs = fromParam != null ? Number(fromParam) || 0 : it && isResumable(it) ? it.userData.positionMs : 0;
      // Cinema mode: play trailers / a pre-roll first when a movie starts from the beginning.
      if (it?.type === 'movie' && startMs === 0 && !sp.get('nointro') && !sp.get('then') && prefs.cinemaMode !== false) {
        const intros = await api.items.intros(itemId).catch(() => []);
        if (cancelled) return;
        if (intros.length) {
          const [first, ...rest] = intros.map((x) => x.id);
          navigate(`/play/${first}?start=0&then=${encodeURIComponent(itemId)}${rest.length ? `&intros=${rest.join(',')}` : ''}`, { replace: true });
          return;
        }
      }
      // Preferred audio language.
      let ai: number | undefined;
      const media = it?.media?.[0];
      if (media && prefs.audioLanguage) {
        const match = media.audioStreams.find((a) => a.language?.toLowerCase().startsWith(prefs.audioLanguage!.toLowerCase()));
        if (match && !match.default) ai = match.index;
      }
      setAudioIndex(ai);
      await start({ startMs, audioIndex: ai, subtitleIndex: null, burn: false, maxBitrate: prefs.maxBitrate, auto: autoQuality });
    })();
    return () => {
      cancelled = true;
      tpCtrl.abort();
      endSession();
      attached.current?.destroy();
      attached.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  /* ---------------- Google Cast ---------------- */
  // Hand playback over to / back from the Cast device.
  useEffect(() => {
    if (cast.connected && !castingRef.current) {
      const pos = currentMs() || optsRef.current.startMs;
      castingRef.current = true;
      setCasting(true);
      videoRef.current?.pause();
      endSession();
      attached.current?.destroy();
      attached.current = null;
      void startCastRef.current({ ...optsRef.current, startMs: pos });
    } else if (!cast.connected && castingRef.current) {
      const pos = currentMs();
      castingRef.current = false;
      setCasting(false);
      endCastSession();
      if (videoRef.current) void start({ ...optsRef.current, startMs: pos });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cast.connected]);

  // Mirror the remote player's position and state.
  const remote = cast.remote;
  useEffect(() => {
    if (!casting) return;
    setPositionMs(castOffsetRef.current + remote.currentTime * 1000);
    setPaused(remote.isPaused);
    setBuffering(false);
  }, [casting, remote.currentTime, remote.isPaused]);
  useEffect(() => {
    if (!casting || !castSidRef.current) return;
    if (remote.playerState === 'IDLE' && remote.idleReason === 'FINISHED') {
      setEnded(true);
      reportCast('stopped');
    } else if (remote.playerState === 'PLAYING' || remote.playerState === 'PAUSED') {
      setEnded(false);
      reportCast(remote.isPaused ? 'paused' : 'playing');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [casting, remote.playerState, remote.isPaused, remote.idleReason]);
  // Progress every 10s from the remote player, and clean up when leaving the player.
  useEffect(() => {
    if (!casting) return;
    const iv = window.setInterval(() => {
      if (!castRef.current.remote.isPaused) reportCast('playing');
    }, 10000);
    const unload = () => endCastSession(true);
    window.addEventListener('pagehide', unload);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener('pagehide', unload);
    };
  }, [casting, reportCast, endCastSession]);
  useEffect(() => () => {
    if (castingRef.current) {
      castRef.current.stop();
      castingRef.current = false;
    }
    const sid = castSidRef.current;
    if (sid) {
      api.playback.stop(sid).catch(() => {});
      castSidRef.current = null;
    }
  }, []);

  // Default subtitle choice once the playback info arrives.
  useEffect(() => {
    if (!info || burned) return;
    const subs = info.subtitles;
    let pick: number | null = null;
    const lang = prefs.subtitleLanguage?.toLowerCase();
    const byLang = (list: typeof subs) => (lang ? list.find((s) => s.language?.toLowerCase().startsWith(lang)) : undefined);
    if (prefs.subtitleMode === 'always') pick = (byLang(subs) ?? subs.find((s) => s.default) ?? subs[0])?.index ?? null;
    else if (prefs.subtitleMode === 'forced') pick = (byLang(subs.filter((s) => s.forced)) ?? subs.find((s) => s.forced))?.index ?? null;
    else if (prefs.subtitleMode === 'auto') pick = (subs.find((s) => s.forced) ?? subs.find((s) => s.default))?.index ?? null;
    const wanted = pendingSubPick.current;
    pendingSubPick.current = null;
    if (wanted != null && subs.some((s) => s.index === wanted)) {
      setSubtitleIndex(wanted);
      return;
    }
    setSubtitleIndex((cur) => (cur != null && subs.some((s) => s.index === cur) ? cur : pick));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.sessionId]);

  const setSync = useCallback((sub: number, audio: number) => {
    setSubDelayMs(sub);
    setAudioDelayMs(audio);
    saveSync(itemId, sub, audio);
  }, [itemId]);
  const nudgeSubtitles = useCallback((delta: number | null) => {
    const next = delta == null ? 0 : Math.max(-SUB_DELAY_MAX, Math.min(SUB_DELAY_MAX, Math.round((subDelayRef.current + delta) / SUB_DELAY_STEP) * SUB_DELAY_STEP));
    setSync(next, audioDelayMs);
    showSyncToast(`Subtitles ${formatDelay(next)}`);
  }, [audioDelayMs, setSync, showSyncToast]);
  const nudgeAudio = useCallback((delta: number | null) => {
    const next = delta == null ? 0 : Math.max(0, Math.min(AUDIO_DELAY_MAX, Math.round((audioDelayMs + delta) / AUDIO_DELAY_STEP) * AUDIO_DELAY_STEP));
    setSync(subDelayRef.current, next);
    showSyncToast(`Audio ${formatDelay(next)}`);
  }, [audioDelayMs, setSync, showSyncToast]);

  /* ---------------- audio delay + comforts (Web Audio, audioFx.ts) ---------------- */
  // The element's sound is routed through Web Audio the first time a delay or a local comfort is needed
  // (night mode, dialogue boost during direct play). Web Audio can only hold audio back (positive delay); the
  // routing stays in place for the life of the player. Comforts the server applied are not applied again.
  const audioGraph = useRef<AudioFx | null>(null);
  const webFx = audioCaps()?.webAudioFx ?? false;
  const localFx = clientFx(comforts, info, webFx && !casting);
  const fxDelay = Math.min(AUDIO_DELAY_MAX, localFx.delayMs + audioDelayMs);
  useEffect(() => {
    const v = videoRef.current;
    const fx = { ...localFx, delayMs: fxDelay };
    if (!v || (!fxActive(fx) && !audioGraph.current)) return;
    if (!audioGraph.current) {
      try {
        audioGraph.current = new AudioFx(v);
      } catch {
        toast.show('Audio effects are not supported in this browser');
        setAudioDelayMs(0);
        return;
      }
    }
    audioGraph.current.set(fx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fxDelay, localFx.nightMode, localFx.dialogueBoost, toast]);
  useEffect(() => () => {
    audioGraph.current?.close();
    audioGraph.current = null;
  }, []);

  /** Change a comfort (saved to the user's preferences). Restarts the stream when the server has to (re)do it. */
  const setComfort = useCallback(async (key: 'nightMode' | 'dialogueBoost' | 'normalize', on: boolean) => {
    const next = { ...comfortsRef.current, [key]: on };
    setComforts(next);
    comfortsRef.current = next;
    const serverSide = !webFx || key === 'normalize' || info?.audio?.delivery === 'transcode' || info?.audio?.delivery === 'dts-core' || !!info?.audio?.applied.includes(key);
    if (serverSide && info && !castingRef.current) void start({ ...optsRef.current, startMs: currentMs() });
    if (!user) return;
    const audio = { ...(user.preferences.audio ?? {}), [key]: on };
    try {
      setUser(await api.auth.updateMe({ preferences: { audio } }));
    } catch (e) {
      toast.error(e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webFx, info, user, setUser, toast]);

  const saveSubStyle = useCallback(async (patch: Partial<SubtitleStyle>) => {
    if (!user) return;
    const next = { ...subStyleRef.current, ...patch };
    setUser({ ...user, preferences: { ...user.preferences, subtitleStyle: next } });
    try {
      setUser(await api.auth.updateMe({ preferences: { subtitleStyle: next } }));
    } catch (e) {
      toast.error(e);
    }
  }, [user, setUser, toast]);

  // Apply subtitle track modes.
  subtitleRef.current = subtitleIndex;
  useEffect(() => {
    if (castingRef.current && info) {
      const i = info.subtitles.findIndex((x) => x.index === subtitleIndex);
      castRef.current.setSubtitle(burned || i < 0 ? null : i);
    }
  }, [subtitleIndex, info, burned]);

  /* ---------------- media element events ---------------- */
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onMeta = () => {
      const target = pendingSeek.current;
      pendingSeek.current = null;
      if (!info) return;
      // Stream time 0 corresponds to media position `streamStartMs` (0 for full-timeline streams).
      offsetRef.current = info.streamStartMs ?? 0;
      if (target != null) {
        const local = (target - offsetRef.current) / 1000;
        if (local > 0.5) v.currentTime = local;
      }
    };
    const onTime = () => {
      setPositionMs(offsetRef.current + v.currentTime * 1000);
      if (v.buffered.length) setBufferedMs(offsetRef.current + v.buffered.end(v.buffered.length - 1) * 1000);
    };
    const onPlay = () => {
      setPaused(false);
      setEnded(false);
      report('playing');
    };
    const onPause = () => {
      setPaused(true);
      if (!v.ended) report('paused');
    };
    const onWaiting = () => setBuffering(true);
    const onPlaying = () => setBuffering(false);
    const onEnded = () => {
      setEnded(true);
      report('stopped');
    };
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('progress', onTime);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('canplay', onPlaying);
    v.addEventListener('ended', onEnded);
    return () => {
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('progress', onTime);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('canplay', onPlaying);
      v.removeEventListener('ended', onEnded);
    };
  }, [info, durationMs, report]);

  // Progress every 10s + on unload.
  useEffect(() => {
    const iv = window.setInterval(() => {
      if (videoRef.current && !videoRef.current.paused) report('playing');
    }, 10000);
    const unload = () => endSession(true);
    window.addEventListener('pagehide', unload);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener('pagehide', unload);
    };
  }, [report, endSession]);

  useEffect(() => {
    const v = videoRef.current;
    if (castingRef.current) {
      castRef.current.setVolume(volume);
      castRef.current.setMuted(muted);
    } else if (v) {
      v.volume = volume;
      v.muted = muted;
    }
    try {
      localStorage.setItem('mm.videoVolume', String(volume));
    } catch {
      /* ignore */
    }
  }, [volume, muted]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate]);

  /* ---------------- stats overlay (I) ---------------- */
  useEffect(() => {
    if (!showStats) {
      setStats(null);
      return;
    }
    const kbps = (bps: number | null | undefined) => (bps ? (bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : `${Math.round(bps / 1000)} kbps`) : '—');
    const tick = () => {
      const v = videoRef.current;
      const pi = info;
      if (!v) return;
      const media = itemRef.current?.media?.[0];
      const es = attached.current?.stats?.() ?? {};
      const direct = pi?.method === 'direct' || pi?.method === 'remux';
      const aIdx = optsRef.current.audioIndex;
      const audio = media?.audioStreams.find((a) => a.index === aIdx) ?? media?.audioStreams.find((a) => a.default) ?? media?.audioStreams[0];
      let ahead = 0;
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= v.currentTime + 0.1 && v.buffered.end(i) >= v.currentTime) ahead = v.buffered.end(i) - v.currentTime;
      }
      const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
      const dropped = q ? `${q.droppedVideoFrames} / ${q.totalVideoFrames}${q.totalVideoFrames ? ` (${((q.droppedVideoFrames / q.totalVideoFrames) * 100).toFixed(1)}%)` : ''}` : '—';
      setStats({
        engine: attached.current?.engine ?? (castingRef.current ? 'cast' : '—'),
        method: pi ? (pi.method === 'direct' ? 'Direct play' : pi.method === 'remux' ? 'Direct stream (remux)' : pi.method === 'transcode' ? 'Transcode' : pi.method) : '—',
        resolution: v.videoWidth ? `${v.videoWidth}×${v.videoHeight}${media?.width && media.width !== v.videoWidth ? ` (source ${media.width}×${media.height})` : ''}` : '—',
        videoCodec: es.videoCodec || (direct ? media?.videoCodec : null) || (pi?.method === 'transcode' ? 'h264 (transcoded)' : '—'),
        audioCodec: pi?.audio ? audioDecisionText(pi.audio) : es.audioCodec || (audio ? `${audio.codec}${audio.channels ? ` · ${audio.channels}ch` : ''}` : '—'),
        audioFx: audioFxText(pi, comfortsRef.current, webFx),
        // MediaSource.bitrate is in kbps.
        bitrate: kbps(es.bitrate ?? (direct && media?.bitrate ? media.bitrate * 1000 : null)),
        bandwidth: es.bandwidth ? kbps(es.bandwidth) : adaptiveRef.current.state.estimate ? `${kbps(adaptiveRef.current.state.estimate)} (estimated)` : attached.current?.engine === 'native' ? 'n/a (progressive download)' : '—',
        abr: optsRef.current.auto ? adaptiveRef.current.describe() : `Fixed · ${QUALITY_OPTIONS.find((q) => q.kbps === optsRef.current.maxBitrate)?.label ?? 'Original'}`,
        subs: subStatusRef.current?.renderer ? `${subStatusRef.current.renderer}${subStatusRef.current.loading ? ` (loading${subStatusRef.current.progress != null ? ` ${Math.round(subStatusRef.current.progress * 100)}%` : ''})` : ''}` : undefined,
        buffer: `${ahead.toFixed(1)} s`,
        dropped,
        extra: `${rate}× · subs ${formatDelay(subDelayRef.current)} · audio ${formatDelay(audioDelayMs)}`,
        range: pi?.videoRange ? rangeDeliveryText(pi.videoRange, pi.dolbyVision) : media?.videoRange?.label ?? (media?.hdr ? 'HDR' : 'SDR'),
        why: pi?.reasons?.length ? pi.reasons : undefined,
      });
    };
    tick();
    const iv = window.setInterval(tick, 1000);
    return () => window.clearInterval(iv);
  }, [showStats, info, rate, audioDelayMs, webFx]);

  /* ---------------- controls ---------------- */
  const seekTo = useCallback((ms: number, fromRemote = false) => {
    const v = videoRef.current;
    if (!v || !info) return;
    const target = Math.max(0, Math.min(durationMs || Infinity, ms));
    if (castingRef.current) {
      castRef.current.seek((target - castOffsetRef.current) / 1000);
      setPositionMs(target);
      setEnded(false);
      if (!fromRemote) sync.broadcast('seek', target);
      return;
    }
    const local = (target - offsetRef.current) / 1000;
    let ok = info.method === 'direct' || !info.isHls;
    if (!ok && local >= 0 && v.seekable.length) {
      const endS = v.seekable.end(v.seekable.length - 1);
      ok = local <= endS + 1;
    }
    if (ok && local >= 0) v.currentTime = local;
    else void start({ ...optsRef.current, startMs: target });
    setPositionMs(target);
    if (!fromRemote) sync.broadcast('seek', target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, durationMs, start]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (castingRef.current) {
      const wasPaused = castRef.current.remote.isPaused;
      castRef.current.playOrPause();
      sync.broadcast(wasPaused ? 'play' : 'pause', currentMs());
      return;
    }
    if (v.paused) {
      void v.play();
      sync.broadcast('play', currentMs());
    } else {
      v.pause();
      sync.broadcast('pause', currentMs());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMs]);

  // Pause / resume from the admin dashboard or a paired phone: handled by useRemoteTarget below.
  useEffect(() => {
    if (sessionRef.current) report(videoRef.current?.paused ? 'paused' : 'playing');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtitleIndex]);

  const sync = useSyncPlay({
    itemId,
    userId: user?.id ?? '',
    userName: user?.displayName || user?.username,
    getPositionMs: currentMs,
    isPaused: () => videoRef.current?.paused ?? true,
    apply: (action, pos) => {
      const v = videoRef.current;
      if (!v) return;
      if (action === 'seek' || Math.abs(currentMs() - pos) > 1500) seekTo(pos, true);
      if (castingRef.current) {
        const rp = castRef.current.remote.isPaused;
        if ((action === 'play' && rp) || (action === 'pause' && !rp)) castRef.current.playOrPause();
        return;
      }
      if (action === 'play') void v.play();
      if (action === 'pause') v.pause();
    },
    load: (id) => navigate(`/play/${id}?start=0`, { replace: true }),
  });

  // Cinema-mode intro chain: ?then=<movie>&intros=<remaining ids>
  const introThen = sp.get('then');
  const nextIntro = useCallback(() => {
    if (!introThen) return;
    const [n, ...rest] = (sp.get('intros') ?? '').split(',').filter(Boolean);
    navigate(n ? `/play/${n}?start=0&then=${encodeURIComponent(introThen)}${rest.length ? `&intros=${rest.join(',')}` : ''}` : `/play/${introThen}?start=0&nointro=1`, { replace: true });
  }, [introThen, sp, navigate]);
  const skipIntros = useCallback(() => {
    if (introThen) navigate(`/play/${introThen}?start=0&nointro=1`, { replace: true });
  }, [introThen, navigate]);
  useEffect(() => {
    if (ended && introThen) nextIntro();
  }, [ended, introThen, nextIntro]);

  const goNext = useCallback(() => {
    if (!info?.nextItemId) return;
    sync.broadcast('load', 0, info.nextItemId);
    navigate(`/play/${info.nextItemId}?start=0`, { replace: true });
  }, [info?.nextItemId, navigate, sync]);

  const exit = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    if (window.history.length > 1) navigate(-1);
    else navigate(item ? `/item/${item.id}` : '/');
  }, [navigate, item]);

  /* Random marathon (?marathon=…) and the sleep timer. */
  const marathonId = sp.get('marathon');
  const marathon = useMarathon({ videoRef, item, marathonId, ended, positionMs, durationMs, exit });

  /* "Play to" a network renderer (DLNA TV, Kodi): the server takes over, this page becomes a remote. */
  const rendererRemote = useRendererRemote();
  const getVideoEl = useCallback(() => videoRef.current, []);
  const airplay = useAirPlay(getVideoEl);
  const playToRenderer = useCallback(async (r: Renderer) => {
    if (!item) return;
    await rendererRemote.start(r, { itemId: item.id, startMs: Math.round(currentMs()), audioStreamIndex: audioIndex, subtitleStreamIndex: burned ? null : subtitleIndex });
    videoRef.current?.pause();
    toast.show(`Playing on ${r.name}`);
    exit();
  }, [item, rendererRemote, currentMs, audioIndex, burned, subtitleIndex, toast, exit]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void shellRef.current?.requestFullscreen?.().catch(() => {});
  }, []);
  useEffect(() => {
    const h = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);

  const togglePip = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch (e) {
      toast.error(e);
    }
  }, [toast]);

  const selectAudio = (idx: number) => {
    setMenu(null);
    setAudioIndex(idx);
    void start({ ...optsRef.current, startMs: currentMs(), audioIndex: idx });
  };

  const textSubs = info?.subtitles ?? [];
  // Bitmap formats our renderer can't draw (VobSub, DVB): the server burns them in — an explicit, last-resort choice.
  const burnOnly = info?.burnInSubtitles
    ?? (item?.media?.[0]?.subtitleStreams ?? []).filter((s) => !textSubs.some((t) => t.index === s.index)).map((s) => ({ ...s, url: '' }));
  const selectSubtitle = (idx: number | null, burn = false) => {
    setMenu(null);
    setSubtitleIndex(idx);
    if (burn) toast.show('These subtitles are drawn into the video by the server (a bitmap format this player can\u2019t render).');
    if (burn || burned) void start({ ...optsRef.current, startMs: currentMs(), subtitleIndex: idx, burn });
  };
  /** The track our overlay renders (null when off or burned in). */
  const activeSubTrack = !burned && subtitleIndex != null ? textSubs.find((s) => s.index === subtitleIndex) ?? null : null;
  const activeSubRef = useRef(activeSubTrack);
  activeSubRef.current = activeSubTrack;
  const burnRef = useRef<(idx: number) => void>(() => {});
  burnRef.current = (idx) => selectSubtitle(idx, true);
  const subStatusRef = useRef<SubtitleStatus | null>(null);
  const onSubStatus = useCallback((st: SubtitleStatus) => {
    const prev = subStatusRef.current;
    subStatusRef.current = st;
    if (!st.error || st.error === prev?.error) return;
    const tr = activeSubRef.current;
    // Last resort for bitmap subtitles we couldn't decode: let the server burn them in.
    if (tr?.isImage) burnRef.current(tr.index);
    else toast.show(`Subtitles: ${st.error}`);
  }, [toast]);
  const cycleSubtitles = () => {
    const list = [null, ...textSubs.map((s) => s.index)];
    const i = list.indexOf(subtitleIndex);
    const next = list[(i + 1) % list.length] ?? null;
    selectSubtitle(next);
    flash(next == null ? 'Subtitles off' : `Subtitles: ${textSubs.find((s) => s.index === next)?.title ?? languageName(textSubs.find((s) => s.index === next)?.language)}`);
  };

  const openSubSearch = () => {
    setMenu(null);
    setSubSearch(true);
  };
  /** A subtitle was downloaded or removed: re-request playback at the current spot so the track list updates. */
  const onSubtitlesChanged = (updated: Item) => {
    const before = new Set((item?.media?.[0]?.subtitleStreams ?? []).map((s) => s.index));
    const added = (updated.media?.[0]?.subtitleStreams ?? []).find((s) => !before.has(s.index));
    setItem(updated);
    pendingSubPick.current = added && !burned ? added.index : null;
    if (!added && subtitleIndex != null && !(updated.media?.[0]?.subtitleStreams ?? []).some((s) => s.index === subtitleIndex)) setSubtitleIndex(null);
    const wasPaused = videoRef.current?.paused ?? false;
    void start({ ...optsRef.current, startMs: currentMs() }).then(() => {
      if (wasPaused) videoRef.current?.pause();
    });
  };

  const selectQuality = (q: number | null | 'auto') => {
    setMenu(null);
    if (q === 'auto') {
      setAutoQuality(true);
      setMaxBitrate(null);
      void start({ ...optsRef.current, startMs: currentMs(), maxBitrate: null, auto: true });
      return;
    }
    setAutoQuality(false);
    setMaxBitrate(q);
    void start({ ...optsRef.current, startMs: currentMs(), maxBitrate: q, auto: false });
  };

  /* ---------------- auto-hide controls ---------------- */
  const hideTimer = useRef<number | null>(null);
  const poke = useCallback(() => {
    setControls(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) {
        setControls(false);
        setMenu(null);
      }
    }, 3200);
  }, []);
  useEffect(() => {
    if (paused) setControls(true);
    else poke();
  }, [paused, poke]);

  /* ---------------- touch: tap = controls, double tap on a side = skip 10s ---------------- */
  const lastTap = useRef<{ t: number; side: 'left' | 'right' | 'center' } | null>(null);
  const tapTimer = useRef<number | null>(null);
  /** Whether the controls were up when the finger came down (the shell's touchstart shows them). */
  const controlsAtTouch = useRef(true);
  const onVideoTouchEnd = (e: ReactTouchEvent<HTMLDivElement>) => {
    const touch = e.changedTouches[0];
    if (!touch || e.touches.length) return;
    // Handle taps ourselves: no synthesized click (which would toggle play) or dblclick (fullscreen).
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const x = (touch.clientX - r.left) / r.width;
    const side = x < 1 / 3 ? 'left' : x > 2 / 3 ? 'right' : 'center';
    const now = performance.now();
    const prev = lastTap.current;
    if (prev && now - prev.t < DOUBLE_TAP_MS && prev.side === side && side !== 'center') {
      if (tapTimer.current) window.clearTimeout(tapTimer.current);
      tapTimer.current = null;
      lastTap.current = { t: now, side }; // keep tapping to skip further
      seekTo(currentMs() + (side === 'left' ? -10000 : 10000));
      setTapSkip((cur) => ({ side, n: cur?.side === side ? cur.n + 1 : 1 }));
      window.clearTimeout((setTapSkip as unknown as { t?: number }).t);
      (setTapSkip as unknown as { t?: number }).t = window.setTimeout(() => setTapSkip(null), 700);
      return;
    }
    lastTap.current = { t: now, side };
    if (tapTimer.current) window.clearTimeout(tapTimer.current);
    tapTimer.current = window.setTimeout(() => {
      tapTimer.current = null;
      // Single tap: show the controls, or hide them when they're already up.
      if (controlsAtTouch.current && !videoRef.current?.paused) {
        setControls(false);
        setMenu(null);
      } else poke();
    }, DOUBLE_TAP_MS);
  };

  /* ---------------- keyboard ---------------- */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (subSearch || isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const v = videoRef.current;
      if (!v) return;
      let handled = true;
      switch (e.key) {
        case ' ':
        case 'k':
        case 'MediaPlayPause':
          togglePlay();
          flash(v.paused ? 'Play' : 'Pause');
          break;
        case 'ArrowLeft':
        case 'j': {
          // Step from the target still being previewed, so holding the D-pad keeps moving.
          const to = (keySeekMs ?? currentMs()) - (e.shiftKey ? 30000 : 10000);
          seekTo(to);
          previewKeySeek(to);
          if (!trickplay) flash('« 10s');
          break;
        }
        case 'ArrowRight':
        case 'l': {
          const to = (keySeekMs ?? currentMs()) + (e.shiftKey ? 30000 : 10000);
          seekTo(to);
          previewKeySeek(to);
          if (!trickplay) flash('10s »');
          break;
        }
        case 'ArrowUp':
          setVolume((x) => Math.min(1, +(x + 0.05).toFixed(2)));
          setMuted(false);
          flash(`Volume ${Math.round(Math.min(1, volume + 0.05) * 100)}%`);
          break;
        case 'ArrowDown':
          setVolume((x) => Math.max(0, +(x - 0.05).toFixed(2)));
          flash(`Volume ${Math.round(Math.max(0, volume - 0.05) * 100)}%`);
          break;
        case 'f':
          toggleFullscreen();
          break;
        case 'm':
          setMuted((m) => !m);
          flash(muted ? 'Unmuted' : 'Muted');
          break;
        case 'c':
          cycleSubtitles();
          break;
        case 'a':
        case 'A': {
          // Next audio track (TV remotes: green key).
          if (audioStreams.length < 2) break;
          const i = audioStreams.findIndex((x) => x.index === currentAudio);
          const nx = audioStreams[(i + 1) % audioStreams.length];
          selectAudio(nx.index);
          flash(`Audio: ${nx.title ?? languageName(nx.language)}`);
          break;
        }
        case 'p':
          void togglePip();
          break;
        case 'g':
        case 'G':
          nudgeSubtitles(-SUB_DELAY_STEP);
          break;
        case 'h':
        case 'H':
          nudgeSubtitles(SUB_DELAY_STEP);
          break;
        case 'i':
        case 'I':
          setShowStats((x) => !x);
          break;
        case 'n':
        case 'MediaTrackNext':
          goNext();
          break;
        case '>':
          setRate((r) => SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(r) + 1)] ?? r);
          break;
        case '<':
          setRate((r) => SPEEDS[Math.max(0, SPEEDS.indexOf(r) - 1)] ?? r);
          break;
        case 'Escape':
        case 'Backspace':
          if (menu) setMenu(null);
          else if (!document.fullscreenElement) exit();
          break;
        default:
          if (/^[0-9]$/.test(e.key) && durationMs) seekTo((Number(e.key) / 10) * durationMs);
          else handled = false;
      }
      if (handled) {
        e.preventDefault();
        poke();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  /* ---------------- markers, up next ---------------- */
  const activeSkip = markers.find((m) => m.type !== 'credits' && positionMs >= m.startMs && positionMs < m.endMs - 1000);
  const inCredits = markers.find((m) => m.type === 'credits' && positionMs >= m.startMs && positionMs < m.endMs);

  useEffect(() => {
    if (!activeSkip || !prefs.skipIntros) return;
    const key = `${activeSkip.type}-${activeSkip.startMs}`;
    if (skippedMarkers.current.has(key)) return;
    skippedMarkers.current.add(key);
    seekTo(activeSkip.endMs);
    flash(`Skipped ${activeSkip.type}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSkip?.startMs]);

  const remaining = durationMs ? durationMs - positionMs : Infinity;
  const nearEnd = !!info?.nextItemId && (!!inCredits || remaining < 30000) && positionMs > 0;
  useEffect(() => {
    if (!info?.nextItemId || nextItem?.id === info.nextItemId) return;
    if (remaining < 90000 || inCredits) api.items.get(info.nextItemId).then(setNextItem).catch(() => {});
  }, [info?.nextItemId, remaining < 90000, !!inCredits]); // eslint-disable-line react-hooks/exhaustive-deps

  const showUpNext = (nearEnd || ended) && !!nextItem && !upNextDismissed && !marathon.blockAutoplay;
  useEffect(() => {
    if (!showUpNext || !prefs.autoplayNext || paused && !ended) {
      setCountdown(null);
      return;
    }
    setCountdown((c) => c ?? 10);
  }, [showUpNext, prefs.autoplayNext, paused, ended]);
  useEffect(() => {
    if (countdown == null) return;
    if (countdown <= 0) {
      goNext();
      return;
    }
    const t = window.setTimeout(() => setCountdown((c) => (c == null ? c : c - 1)), 1000);
    return () => window.clearTimeout(t);
  }, [countdown, goNext]);

  /* ---------------- render ---------------- */
  const title = info?.title ?? item?.title ?? '';
  const subtitle = info?.subtitle ?? (item?.type === 'episode' ? `${item.grandparentTitle ?? ''} · S${item.parentIndex ?? '?'} E${item.index ?? '?'}` : item?.year ? String(item.year) : '');
  const qualityLabel = autoQuality ? `Auto${adaptive.state.level ? ` · ${adaptive.state.level}` : ''}` : QUALITY_OPTIONS.find((q) => q.kbps === maxBitrate)?.label ?? 'Original';
  const audioStreams = info?.audioStreams ?? item?.media?.[0]?.audioStreams ?? [];
  const currentAudio = audioIndex ?? audioStreams.find((a) => a.default)?.index ?? audioStreams[0]?.index;

  const backdrop = useMemo(() => info?.backdropUrl ?? item?.backdropUrl ?? null, [info?.backdropUrl, item?.backdropUrl]);

  /* Remote control target (your other devices, a paired phone remote / second screen). */
  const remoteSkip = introThen ? { type: 'intro', label: 'Skip to movie' }
    : activeSkip && !prefs.skipIntros ? { type: activeSkip.type, label: `Skip ${activeSkip.type === 'commercial' ? 'ad break' : activeSkip.type}` }
      : inCredits ? { type: 'credits', label: info?.nextItemId ? 'Next episode' : 'Skip credits' } : null;
  useRemoteTarget(item ? {
    itemId: item.id, title, subtitle: subtitle || null, posterUrl: item.posterUrl ?? null, positionMs, durationMs: durationMs || null, paused, volume: muted ? 0 : volume,
    audioTracks: audioStreams.map((a) => ({ index: a.index, label: a.title ?? languageName(a.language) })), audioIndex: currentAudio ?? null,
    subtitleTracks: textSubs.map((t) => ({ index: t.index, label: t.title || languageName(t.language) })), subtitleIndex: subtitleIndex ?? null,
    skip: remoteSkip, nextItemId: info?.nextItemId ?? null,
  } : null, {
    togglePlay, seekTo, setVolume: (v) => { setVolume(v); setMuted(false); }, next: goNext, stop: exit,
    setAudio: (i) => selectAudio(i), setSubtitle: (i) => selectSubtitle(i),
    skip: () => (introThen ? skipIntros() : activeSkip ? seekTo(activeSkip.endMs) : inCredits ? (info?.nextItemId ? goNext() : seekTo(inCredits.endMs)) : undefined),
  });

  return (
    <div
      ref={shellRef}
      className={`player ${controls ? 'show-controls' : 'hide-controls'} ${fullscreen ? 'is-fs' : ''}`}
      onMouseMove={poke}
      onTouchStart={poke}
    >
      {backdrop && buffering && positionMs < 1000 && <div className="player-backdrop"><Img src={backdrop} width={1920} /></div>}
      <div
        ref={hostRef}
        className="player-video-host"
        onClick={() => { togglePlay(); poke(); }}
        onDoubleClick={toggleFullscreen}
        onTouchStart={() => { controlsAtTouch.current = controls; }}
        onTouchEnd={onVideoTouchEnd}
      />
      {!casting && (
        <SubtitleOverlay
          track={activeSubTrack}
          video={activeVideo}
          streamStartMs={info?.streamStartMs ?? 0}
          delayMs={subDelayMs}
          style={subStyle}
          tv={isTvMode()}
          controlsVisible={controls}
          onStatus={onSubStatus}
        />
      )}

      {(buffering && !error && !casting) && <div className="player-center"><Spinner size={56} /></div>}
      {casting && (
        <div className="cast-overlay">
          {backdrop && <div className="cast-overlay-bg"><Img src={backdrop} width={1280} /></div>}
          <div className="cast-overlay-body" role="status">
            <Icon name="cast" size={40} />
            <small>Casting to</small>
            <strong>{cast.deviceName ?? 'your Cast device'}</strong>
            <span className="muted">{remote.playerState === 'BUFFERING' ? 'Buffering…' : remote.isPaused ? 'Paused' : title}</span>
            <button className="btn btn-glass btn-sm" onClick={cast.disconnect}><Icon name="x" size={14} /> Stop casting</button>
          </div>
        </div>
      )}
      {osd && <div className="player-osd">{osd}</div>}
      {syncToast && <div className="player-sync-toast" role="status">{syncToast}</div>}
      {tapSkip && (
        <div className={`tap-skip tap-skip-${tapSkip.side}`} aria-hidden="true">
          <Icon name={tapSkip.side === 'left' ? 'rewind10' : 'forward10'} size={34} />
          <span>{tapSkip.n * 10} seconds</span>
        </div>
      )}
      {showStats && stats && (
        <div className="player-stats" role="dialog" aria-label="Playback statistics">
          <div className="player-stats-head">
            <strong>Stats for nerds</strong>
            <button className="btn-icon" onClick={() => setShowStats(false)} aria-label="Close stats"><Icon name="x" size={14} /></button>
          </div>
          <dl>
            <dt>Playback</dt><dd>{stats.method} · {stats.engine}</dd>
            <dt>Resolution</dt><dd>{stats.resolution}</dd>
            <dt>Video codec</dt><dd>{stats.videoCodec}</dd>
            {stats.range && <><dt>Dynamic range</dt><dd>{info?.videoRange && <RangeBadge format={info.videoRange.source} label={info.videoRange.label} />} {stats.range}</dd></>}
            {stats.why && (
              <><dt>Why</dt><dd className="stats-why">{stats.why.map((r, i) => (
                <span key={i}>{i > 0 && '; '}<a href={helpPath(helpForReason(r))} target="_blank" rel="noopener" title="What does this mean?">{r}</a></span>
              ))}</dd></>
            )}
            <dt>Audio</dt><dd>{(() => { const a = info?.audioStreams.find((x) => x.index === (optsRef.current.audioIndex ?? currentAudio)); return a ? <AudioBadges stream={a} channels={false} /> : null; })()} {stats.audioCodec}</dd>
            {stats.audioFx && <><dt>Audio effects</dt><dd>{stats.audioFx}</dd></>}
            <dt>Bitrate</dt><dd>{stats.bitrate}</dd>
            <dt>Network</dt><dd>{stats.bandwidth}</dd>
            {stats.abr && <><dt>Quality</dt><dd>{stats.abr}</dd></>}
            {stats.subs && <><dt>Subtitles</dt><dd>{stats.subs}</dd></>}
            <dt>Buffer</dt><dd>{stats.buffer}</dd>
            <dt>Dropped frames</dt><dd>{stats.dropped}</dd>
            <dt>Speed / sync</dt><dd>{stats.extra}</dd>
          </dl>
          <button className="btn btn-glass btn-sm player-stats-pair" onClick={() => { setShowStats(false); openPairDialog(); }}><Icon name="device" size={14} /> Use your phone as remote</button>
        </div>
      )}

      {error && (
        <div className="player-error">
          <Icon name="alert" size={40} />
          <h2>Playback error</h2>
          <p>{error}</p>
          <div className="row-gap">
            <button className="btn btn-primary" onClick={() => start({ ...optsRef.current, startMs: currentMs() || optsRef.current.startMs })}>
              <Icon name="refresh" size={16} /> Retry
            </button>
            <button className="btn" onClick={() => start({ ...optsRef.current, startMs: currentMs() || optsRef.current.startMs, maxBitrate: 8000, auto: false })}>Try lower quality</button>
            <button className="btn btn-ghost" onClick={exit}>Exit</button>
          </div>
        </div>
      )}

      {/* Top bar */}
      <div className="player-top">
        <button className="btn-icon btn-icon-lg" onClick={exit} aria-label="Back"><Icon name="arrowLeft" size={26} /></button>
        <div className="player-titles">
          <div className="player-title">{title}</div>
          {subtitle && <div className="player-subtitle">{subtitle}</div>}
        </div>
        {info && <span className={`badge player-method method-${info.method}`} title="Playback method">{info.method === 'direct' ? 'Direct play' : info.method === 'remux' ? 'Direct stream' : info.method === 'transcode' ? 'Transcoding' : 'Live'}</span>}
        {sync.room && <span className="badge badge-accent"><Icon name="together" size={12} /> {sync.room.members.length} watching</span>}
        {marathonId && <span className="badge badge-accent"><Icon name="shuffle" size={12} /> Marathon</span>}
        {marathon.sleepButton}
      </div>
      {marathon.overlay}

      {introThen && (
        <button className="skip-btn" onClick={skipIntros}>
          {item?.extraType === 'trailer' ? `Trailer · ${item.parentTitle ?? ''} — ` : ''}Skip to movie <Icon name="skipFwd" size={16} />
        </button>
      )}

      {/* Skip intro / credits */}
      {activeSkip && !prefs.skipIntros && (
        <button className="skip-btn" onClick={() => seekTo(activeSkip.endMs)}>
          Skip {activeSkip.type === 'commercial' ? 'ad break' : activeSkip.type} <Icon name="skipFwd" size={16} />
        </button>
      )}
      {inCredits && !showUpNext && (
        <button className="skip-btn" onClick={() => (info?.nextItemId ? goNext() : seekTo(inCredits.endMs))}>
          {info?.nextItemId ? 'Next episode' : 'Skip credits'} <Icon name="skipFwd" size={16} />
        </button>
      )}

      {/* Up next */}
      {showUpNext && nextItem && (
        <div className="upnext">
          <div className="upnext-art">
            <Img src={nextItem.thumbUrl ?? nextItem.backdropUrl ?? nextItem.posterUrl} width={400} />
            {countdown != null && (
              <svg className="upnext-ring" viewBox="0 0 40 40">
                <circle cx="20" cy="20" r="17" />
                <circle cx="20" cy="20" r="17" className="ring-fill" style={{ strokeDashoffset: `${(countdown / 10) * 107}` }} />
              </svg>
            )}
          </div>
          <div className="upnext-body">
            <small>Up next{countdown != null ? ` in ${countdown}s` : ''}</small>
            <strong>{nextItem.title}</strong>
            {nextItem.type === 'episode' && <span className="muted">S{nextItem.parentIndex} · E{nextItem.index}</span>}
            <div className="row-gap">
              <button className="btn btn-primary btn-sm" onClick={goNext}><Icon name="play" size={14} /> Play now</button>
              <button className="btn btn-ghost btn-sm" onClick={() => { setUpNextDismissed(true); setCountdown(null); }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {ended && !showUpNext && !marathonId && (
        <div className="player-center ended">
          <button className="btn btn-primary btn-lg" onClick={() => seekTo(0)}><Icon name="refresh" size={18} /> Watch again</button>
          <button className="btn btn-glass btn-lg" onClick={exit}>Back</button>
        </div>
      )}

      {/* Bottom controls */}
      <div className="player-bottom" onClick={(e) => e.stopPropagation()}>
        <div className="player-seek-row">
          <span className="player-time">{formatClock(positionMs)}</span>
          <SeekBar positionMs={positionMs} durationMs={durationMs} bufferedMs={bufferedMs} onSeek={(ms) => seekTo(ms)} markers={markers} trickplay={trickplay} previewMs={keySeekMs} chapters={item?.chapters} />
          <span className="player-time">-{formatClock(Math.max(0, durationMs - positionMs))}</span>
        </div>
        <div className="player-controls">
          <div className="pc-left">
            <button className="btn-icon btn-icon-lg" onClick={togglePlay} aria-label={paused ? 'Play' : 'Pause'}><Icon name={paused ? 'play' : 'pause'} size={30} /></button>
            <button className="btn-icon" onClick={() => seekTo(currentMs() - 10000)} aria-label="Back 10 seconds"><Icon name="rewind10" size={26} /></button>
            <button className="btn-icon" onClick={() => seekTo(currentMs() + 10000)} aria-label="Forward 10 seconds"><Icon name="forward10" size={26} /></button>
            {info?.nextItemId && <button className="btn-icon" onClick={goNext} aria-label="Next"><Icon name="next" size={24} /></button>}
            <VolumeControl volume={volume} muted={muted} onVolume={setVolume} onMute={setMuted} />
          </div>
          <div className="pc-right">
            <div className="pc-menu">
              <button className={`btn-icon ${subtitleIndex != null ? 'active' : ''}`} onClick={() => setMenu(menu === 'subs' ? null : 'subs')} aria-label="Subtitles"><Icon name="subtitles" size={24} /></button>
              <Popover open={menu === 'subs'} onClose={() => setMenu(null)}>
                <OptionList<string>
                  title="Subtitles"
                  value={subtitleIndex == null ? 'off' : `${burned ? 'b' : 't'}${subtitleIndex}`}
                  onSelect={(v) => (v === 'off' ? selectSubtitle(null) : selectSubtitle(Number(v.slice(1)), v[0] === 'b'))}
                  options={[
                    { label: 'Off', value: 'off' },
                    ...textSubs.map((s) => ({ label: s.title || languageName(s.language), value: `t${s.index}`, sub: [s.forced && 'Forced', s.default && 'Default', s.format && s.format !== 'srt' && s.format !== 'vtt' && s.format.toUpperCase()].filter(Boolean).join(' · ') || undefined })),
                    ...burnOnly.map((s) => ({ label: s.title || languageName(s.language), value: `b${s.index}`, sub: `${(s.codec ?? 'bitmap').toUpperCase()} · burn-in (transcodes)` })),
                  ]}
                />
                <button className="option option-action" onClick={() => setMenu('subStyle')}>
                  <span className="option-check"><Icon name="type" size={16} /></span>
                  <span className="option-label">Subtitle style…</span>
                </button>
                <button className="option option-action option-action-plain" onClick={() => setMenu('sync')}>
                  <span className="option-check"><Icon name="clock" size={16} /></span>
                  <span className="option-label">
                    Sync &amp; delay…
                    {(subDelayMs !== 0 || audioDelayMs !== 0) && <small>Subtitles {formatDelay(subDelayMs)} · Audio {formatDelay(audioDelayMs)}</small>}
                  </span>
                </button>
                {canSearchSubtitles(item) && (
                  <button className="option option-action option-action-plain" onClick={openSubSearch}>
                    <span className="option-check"><Icon name="search" size={16} /></span>
                    <span className="option-label">Search online…</span>
                  </button>
                )}
              </Popover>
              <Popover open={menu === 'subStyle'} onClose={() => setMenu(null)} className="substyle-popover">
                <div className="option-title option-title-back">
                  <button className="btn-icon" onClick={() => setMenu('subs')} aria-label="Back to subtitles"><Icon name="chevronLeft" size={16} /></button>
                  Subtitle style
                </div>
                {(Object.keys(SUBTITLE_OPTIONS) as (keyof SubtitleStyle)[]).map((field) => (
                  <div className="substyle-row" key={field} role="radiogroup" aria-label={SUBTITLE_FIELD_LABELS[field]}>
                    <span className="substyle-label">{SUBTITLE_FIELD_LABELS[field]}</span>
                    <div className="substyle-chips">
                      {SUBTITLE_OPTIONS[field].map((o) => (
                        <button
                          key={o.value}
                          role="radio"
                          aria-checked={subStyle[field] === o.value}
                          className={`chip ${subStyle[field] === o.value ? 'active' : ''}`}
                          onClick={() => void saveSubStyle({ [field]: o.value } as Partial<SubtitleStyle>)}
                        >
                          {o.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </Popover>
              <Popover open={menu === 'sync'} onClose={() => setMenu(null)} className="sync-popover">
                <div className="option-title option-title-back">
                  <button className="btn-icon" onClick={() => setMenu('subs')} aria-label="Back to subtitles"><Icon name="chevronLeft" size={16} /></button>
                  Sync &amp; delay
                </div>
                <div className="sync-row">
                  <span className="sync-label">Subtitles<small>G / H</small></span>
                  <button className="btn-icon" onClick={() => nudgeSubtitles(-SUB_DELAY_STEP)} aria-label="Subtitles earlier"><Icon name="minus" size={16} /></button>
                  <output className="sync-value" aria-live="polite">{formatDelay(subDelayMs)}</output>
                  <button className="btn-icon" onClick={() => nudgeSubtitles(SUB_DELAY_STEP)} aria-label="Subtitles later"><Icon name="plus" size={16} /></button>
                  <button className="btn btn-ghost btn-sm" onClick={() => nudgeSubtitles(null)} disabled={!subDelayMs}>Reset</button>
                </div>
                <input
                  className="sync-slider"
                  type="range"
                  min={-SUB_DELAY_MAX}
                  max={SUB_DELAY_MAX}
                  step={SUB_DELAY_STEP}
                  value={subDelayMs}
                  onChange={(e) => nudgeSubtitles(Number(e.target.value) - subDelayMs)}
                  aria-label="Subtitle delay"
                />
                {!casting && (
                  <>
                    <div className="sync-row">
                      <span className="sync-label">Audio<small>delay only</small></span>
                      <button className="btn-icon" onClick={() => nudgeAudio(-AUDIO_DELAY_STEP)} aria-label="Audio earlier" disabled={!audioDelayMs}><Icon name="minus" size={16} /></button>
                      <output className="sync-value" aria-live="polite">{formatDelay(audioDelayMs)}</output>
                      <button className="btn-icon" onClick={() => nudgeAudio(AUDIO_DELAY_STEP)} aria-label="Audio later"><Icon name="plus" size={16} /></button>
                      <button className="btn btn-ghost btn-sm" onClick={() => nudgeAudio(null)} disabled={!audioDelayMs}>Reset</button>
                    </div>
                    <p className="sync-hint">Positive values make subtitles or sound come later. Audio can only be delayed (for sound that runs ahead of the picture).</p>
                  </>
                )}
              </Popover>
            </div>
            {(item?.chapters?.length ?? 0) > 0 && (
              <div className="pc-menu">
                <button className={`btn-icon ${menu === 'chapters' ? 'active' : ''}`} onClick={() => setMenu(menu === 'chapters' ? null : 'chapters')} aria-label="Chapters"><Icon name="chapters" size={22} /></button>
                <Popover open={menu === 'chapters'} onClose={() => setMenu(null)} className="chapters-popover">
                  <div className="option-title">Chapters</div>
                  <ChapterList chapters={item!.chapters!} positionMs={positionMs} onSeek={(ms) => { setMenu(null); seekTo(ms); }} />
                </Popover>
              </div>
            )}
            {audioStreams.length > 0 && (
              <div className="pc-menu">
                <button className="btn-icon" onClick={() => setMenu(menu === 'audio' ? null : 'audio')} aria-label="Audio"><Icon name="audio" size={22} /></button>
                <Popover open={menu === 'audio'} onClose={() => setMenu(null)} className="audio-popover">
                  <OptionList<number | undefined>
                    title="Audio"
                    value={currentAudio}
                    onSelect={(v) => v !== undefined && v !== currentAudio && selectAudio(v)}
                    options={audioStreams.map((a) => ({
                      label: a.title || languageName(a.language),
                      value: a.index,
                      sub: <span className="audio-track-sub">{audioSummary(a)} <AudioBadges stream={a} channels={false} /></span>,
                    }))}
                  />
                  {info?.audio && info.audio.delivery !== 'direct' && <p className="audio-delivery">{audioDecisionText(info.audio)}</p>}
                  {!casting && (
                    <div className="audio-panel" role="group" aria-label="Listening">
                      {([
                        ['nightMode', 'Night mode', 'Softer explosions, clearer quiet scenes'],
                        ['dialogueBoost', 'Dialogue boost', 'Lifts voices above music and effects'],
                        ['normalize', 'Normalise volume', 'Even loudness (re-encodes the audio on the server)'],
                      ] as const).map(([key, label, hint]) => (
                        <button key={key} type="button" role="switch" aria-checked={!!comforts[key]} className="audio-toggle" onClick={() => void setComfort(key, !comforts[key])}>
                          <span>{label}<small>{hint}</small></span>
                          <i className="audio-switch" aria-hidden="true" />
                        </button>
                      ))}
                      {!webFx && <p className="audio-note">This device plays sound through its own hardware pipeline, so these are applied by the server (the audio is re-encoded; the picture is not).</p>}
                      {(comforts.delayMs ?? 0) !== 0 && <p className="audio-note">Lip-sync for this device: {formatDelay(comforts.delayMs ?? 0)} (Settings → Audio).</p>}
                    </div>
                  )}
                </Popover>
              </div>
            )}
            <div className="pc-menu">
              <button className="btn-icon" onClick={() => setMenu(menu === 'quality' ? null : 'quality')} aria-label="Quality"><Icon name="gauge" size={22} /></button>
              <Popover open={menu === 'quality'} onClose={() => setMenu(null)}>
                <OptionList<number | null | 'auto'>
                  title={`Quality · ${qualityLabel}`}
                  value={autoQuality ? 'auto' : maxBitrate}
                  onSelect={selectQuality}
                  options={[
                    { label: 'Auto', value: 'auto' as const, sub: adaptive.state.estimate ? `Adapts to your connection · ${formatBps(adaptive.state.estimate)}` : 'Adapts to your connection' },
                    ...QUALITY_OPTIONS.map((q) => ({ label: q.label, value: q.kbps })),
                  ]}
                />
              </Popover>
            </div>
            <div className="pc-menu">
              <button className="btn-icon pc-speed" onClick={() => setMenu(menu === 'speed' ? null : 'speed')} aria-label="Playback speed">{rate === 1 ? <Icon name="speed" size={22} /> : <span>{rate}×</span>}</button>
              <Popover open={menu === 'speed'} onClose={() => setMenu(null)}>
                <OptionList<number> title="Speed" value={rate} onSelect={(r) => { setRate(r); setMenu(null); }} options={SPEEDS.map((s) => ({ label: s === 1 ? 'Normal' : `${s}×`, value: s }))} />
              </Popover>
            </div>
            <div className="pc-menu">
              <button className={`btn-icon ${sync.room ? 'active' : ''}`} onClick={() => setMenu(menu === 'together' ? null : 'together')} aria-label="Watch together"><Icon name="together" size={22} /></button>
              <Popover open={menu === 'together'} onClose={() => setMenu(null)} className="together-panel">
                <div className="option-title">Watch together</div>
                {sync.room ? (
                  <div className="together-room">
                    <p className="muted">Share this code with friends on any MediaMax device:</p>
                    <div className="room-code">
                      {sync.room.code}
                      <button className="btn-icon" onClick={() => { void navigator.clipboard?.writeText(sync.room!.code); toast.success('Code copied'); }} aria-label="Copy code"><Icon name="copy" size={16} /></button>
                    </div>
                    <ul className="room-members">
                      {sync.room.members.map((m) => (
                        <li key={m.userId}><Icon name="user" size={14} /> {m.displayName} {m.userId === sync.room!.ownerId && <span className="badge badge-muted">Host</span>}</li>
                      ))}
                    </ul>
                    <button className="btn btn-ghost btn-sm" onClick={sync.leave}>Leave room</button>
                  </div>
                ) : (
                  <div className="together-start">
                    <p className="muted">Play, pause and seek stay in sync for everyone in the room.</p>
                    <button className="btn btn-primary btn-block" onClick={sync.create} disabled={!!sync.pending}>
                      {sync.pending === 'create' ? <Spinner size={16} /> : <Icon name="plus" size={16} />} Start a room
                    </button>
                    <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (joinCode.trim()) sync.join(joinCode); }}>
                      <input className="input" value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())} placeholder="Room code" aria-label="Room code" />
                      <button className="btn" disabled={!joinCode.trim() || !!sync.pending}>{sync.pending === 'join' ? <Spinner size={16} /> : 'Join'}</button>
                    </form>
                    {sync.error && <p className="form-error">{sync.error}</p>}
                  </div>
                )}
              </Popover>
            </div>
            <CastMenu cast={cast} airplay={airplay} media="video" onPlayTo={playToRenderer} />
            {!casting && 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled && (
              <button className="btn-icon" onClick={togglePip} aria-label="Picture in picture"><Icon name="pip" size={22} /></button>
            )}
            <button className="btn-icon" onClick={toggleFullscreen} aria-label="Fullscreen"><Icon name={fullscreen ? 'fullscreenExit' : 'fullscreen'} size={22} /></button>
          </div>
        </div>
      </div>
      {canSearchSubtitles(item) && (
        <SubtitleSearchModal open={subSearch} onClose={() => setSubSearch(false)} item={item} onUpdated={onSubtitlesChanged} container={shellRef.current} />
      )}
    </div>
  );
}
