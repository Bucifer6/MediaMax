/**
 * Full-screen video player for library items, offline downloads, live TV and
 * catch-up. Custom overlay controls (scrubber, audio / subtitle / quality
 * menus, skip intro/credits, up-next countdown), D-pad support on TV, PiP and
 * background audio on phones, and progress reporting every 10 s.
 *
 * Chromecast (phones): while a cast session is connected the stream is requested
 * with a Chromecast profile and loaded on the receiver; the local player pauses,
 * the controls drive the receiver and progress is reported from its status.
 */
import { useEventListener } from 'expo';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { VideoAirPlayButton, VideoView, isPictureInPictureSupported, useVideoPlayer, type SubtitleTrack as NativeSubtitleTrack } from 'expo-video';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { QUALITY_OPTIONS, castDeviceProfile, videoDeviceProfile } from '@/api/profiles';
import type { Channel, Item, Marker, PlaybackInfo, ProgressReport, RemoteSubtitle, SubtitleTrack } from '@/api/types';
import { CastButton, castMediaInfo, isOurMedia, useCast } from '@/cast';
import { Button } from '@/components/Button';
import { Focusable } from '@/components/Focusable';
import { Icon } from '@/components/Icon';
import { Img } from '@/components/Img';
import { OptionSheet, type SheetOption } from '@/components/OptionSheet';
import { ProgressBar } from '@/components/ProgressBar';
import { T } from '@/components/Text';
import { useDownloads } from '@/state/downloads';
import { useMusic } from '@/state/music';
import { useApi, useCapabilities, useSession } from '@/state/session';
import { useSyncPlay } from '@/state/syncplay';
import { useTheme } from '@/theme';
import { useBackHandler, useTVRemote } from '@/tv';
import { on } from '@/utils/events';
import { formatClock, formatTime, languageName, programProgress } from '@/utils/format';
import { OnlineSubtitlesSheet } from './OnlineSubtitlesSheet';
import { Scrubber } from './Scrubber';
import { useTrickplay } from './Trickplay';
import { WatchTogetherSheet } from './WatchTogether';
import { activeCues, parseVtt, type Cue } from './vtt';

export type PlayerTarget =
  | { kind: 'vod'; itemId: string; startMs?: number }
  | { kind: 'live'; channelId: string; catchupStart?: string; durationMin?: number; categoryId?: string };

type SubChoice = { kind: 'off' } | { kind: 'server'; track: SubtitleTrack } | { kind: 'embedded'; track: NativeSubtitleTrack };
type SheetKind = 'audio' | 'subs' | 'online' | 'quality' | 'channels' | 'together' | null;

const langMatch = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.slice(0, 2).toLowerCase() === b.slice(0, 2).toLowerCase();

export function VideoPlayerScreen({ target }: { target: PlayerTarget }) {
  const t = useTheme();
  const api = useApi();
  const insets = useSafeAreaInsets();
  const { user, status } = useSession();
  const caps = useCapabilities();
  const music = useMusic();
  const downloads = useDownloads();
  const prefs = user?.preferences;
  const isLive = target.kind === 'live';
  const sync = useSyncPlay();

  // ----- what we're playing -----
  const [channelId, setChannelId] = useState(target.kind === 'live' ? target.channelId : '');
  const [catchup, setCatchup] = useState(target.kind === 'live' && target.catchupStart ? { start: target.catchupStart, durationMin: target.durationMin } : null);
  const offlineRec = target.kind === 'vod' ? downloads.get(target.itemId) : undefined;
  const offlineUri = offlineRec?.state === 'done' && offlineRec.fileUri ? offlineRec.fileUri : null;

  const [info, setInfo] = useState<PlaybackInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [maxBitrate, setMaxBitrate] = useState<number | null>(prefs?.maxBitrate ?? null);
  const [audioIndex, setAudioIndex] = useState<number | undefined>(undefined);
  const [sub, setSub] = useState<SubChoice>({ kind: 'off' });
  const [embeddedSubs, setEmbeddedSubs] = useState<NativeSubtitleTrack[]>([]);
  const [cues, setCues] = useState<Cue[]>([]);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [controls, setControls] = useState(true);
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubFocused, setScrubFocused] = useState(false);
  const [pendingSeek, setPendingSeek] = useState<number | null>(null);
  const [osd, setOsd] = useState<string | null>(null);
  const [upNext, setUpNext] = useState<{ item: Item | null; secondsLeft: number } | null>(null);
  const [upNextDismissed, setUpNextDismissed] = useState(false);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [channelList, setChannelList] = useState<Channel[]>([]);
  const [offlineItem] = useState<Item | null>(offlineRec?.item ?? null);
  const vodItemId = target.kind === 'vod' ? target.itemId : null;
  const trickplay = useTrickplay(vodItemId && !offlineUri ? vodItemId : null);
  /** Online playback of a library item: can search subtitles online / watch together. */
  const onlineVod = !!vodItemId && !offlineUri && status === 'signed-in';
  const syncOn = sync.enabled && onlineVod;
  const inRoom = syncOn && !!sync.room;

  // ----- Chromecast -----
  const cast = useCast();
  const canCast = cast.supported && !offlineUri && status === 'signed-in';
  const casting = canCast && cast.connected && !!cast.client;
  const castingRef = useRef(casting);
  castingRef.current = casting;
  const castClientRef = useRef(cast.client);
  castClientRef.current = cast.client;
  /** URL loaded on the receiver (to ignore status updates for someone else's media). */
  const castUrlRef = useRef<string | null>(null);
  /** Media position that receiver stream time 0 corresponds to. */
  const castOffsetRef = useRef(0);
  /** Bumped after each successful load on the receiver (re-applies the subtitle track). */
  const [castTick, setCastTick] = useState(0);
  const castStatus = casting && castUrlRef.current && isOurMedia(cast.mediaStatus, castUrlRef.current) ? cast.mediaStatus : null;

  const infoRef = useRef<PlaybackInfo | null>(null);
  const offsetRef = useRef(0);
  const pendingStartRef = useRef<number | null>(null);
  const posRef = useRef(0);
  const durRef = useRef(0);
  const firstLoad = useRef(true);
  const skipped = useRef(new Set<number>());
  const viewRef = useRef<VideoView>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const osdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seekDialTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** After an online subtitle download: pick the new track once playback is re-requested. */
  const autoPickSub = useRef<{ prev: Set<number>; language: string } | null>(null);
  posRef.current = pos;
  durRef.current = dur;
  const playingRef = useRef(false);
  playingRef.current = playing;

  const player = useVideoPlayer(null, (p) => {
    p.timeUpdateEventInterval = 0.5;
    p.keepScreenOnWhilePlaying = true;
    p.showNowPlayingNotification = !Platform.isTV;
    p.staysActiveInBackground = !Platform.isTV;
  });

  const flash = useCallback((text: string) => {
    setOsd(text);
    if (osdTimer.current) clearTimeout(osdTimer.current);
    osdTimer.current = setTimeout(() => setOsd(null), 1600);
  }, []);

  // ----- progress reporting -----
  const report = useCallback(
    (state: ProgressReport['state']) => {
      const positionMs = Math.round(posRef.current);
      if (target.kind === 'vod' && offlineUri) {
        downloads.updateLocalPosition(target.itemId, positionMs);
        return;
      }
      const pi = infoRef.current;
      if (!pi) return;
      api.sessionProgress(pi.sessionId, { positionMs, durationMs: durRef.current || undefined, state, sessionId: pi.sessionId }).catch(() => undefined);
    },
    [api, target, offlineUri, downloads],
  );

  /** Pick subtitles for fresh PlaybackInfo: a just-downloaded track, or the user's defaults on first load. */
  const applySubtitleDefaults = useCallback(
    (pi: PlaybackInfo) => {
      const pickNew = autoPickSub.current;
      if (pickNew) {
        autoPickSub.current = null;
        const fresh = pi.subtitles.filter((s) => !pickNew.prev.has(s.index));
        const pick = fresh.find((s) => langMatch(s.language, pickNew.language)) ?? fresh[0];
        if (pick) setSub({ kind: 'server', track: pick });
      }
      if (firstLoad.current) {
        firstLoad.current = false;
        const mode = prefs?.subtitleMode ?? 'auto';
        const lang = prefs?.subtitleLanguage;
        const tracks = pi.subtitles;
        let pick: SubtitleTrack | undefined;
        if (mode === 'forced') pick = tracks.find((s) => s.forced);
        else if (mode === 'always') pick = tracks.find((s) => !s.forced && langMatch(s.language, lang)) ?? tracks.find((s) => s.default) ?? tracks[0];
        else if (mode === 'auto') pick = tracks.find((s) => s.forced && (!lang || langMatch(s.language, lang))) ?? tracks.find((s) => s.default);
        setSub(pick ? { kind: 'server', track: pick } : { kind: 'off' });
      }
    },
    [prefs],
  );

  // ----- casting -----
  /** Request a Chromecast-friendly stream and load it on the receiver. */
  const castLoadRef = useRef<(startMs: number, opts: { audio?: number; bitrate?: number | null }) => Promise<void>>(async () => undefined);
  castLoadRef.current = async (startMs, opts) => {
    const client = castClientRef.current;
    if (!client) return;
    setLoading(true);
    setError(null);
    try {
      try {
        player.pause();
      } catch {
        /* nothing loaded */
      }
      const prev = infoRef.current;
      if (prev) {
        infoRef.current = null;
        api.stopSession(prev.sessionId).catch(() => undefined);
      }
      const liveNow = target.kind === 'live' && !catchup;
      const pi =
        target.kind === 'live'
          ? await api.playChannel(channelId, { ...(catchup ? { catchupStart: catchup.start, catchupDurationMin: catchup.durationMin } : {}), forceHls: true })
          : await api.playback(target.itemId, {
              startMs: Math.round(startMs),
              audioStreamIndex: opts.audio,
              subtitleStreamIndex: null, // sidecar WebVTT tracks are sent to the receiver instead
              deviceProfile: castDeviceProfile('video', opts.bitrate === undefined ? maxBitrate : opts.bitrate),
            });
      if (!castingRef.current) {
        api.stopSession(pi.sessionId).catch(() => undefined);
        return;
      }
      infoRef.current = pi;
      setInfo(pi);
      applySubtitleDefaults(pi);
      castOffsetRef.current = pi.streamStartMs ?? 0;
      if (pi.durationMs) setDur(pi.durationMs);
      const mediaInfo = castMediaInfo(api, pi, {
        live: liveNow,
        title: target.kind === 'live' && channel ? channel.name : pi.title,
        subtitle: target.kind === 'live' ? channel?.nowPlaying?.title ?? pi.subtitle : pi.subtitle,
        posterPath: pi.posterUrl ?? pi.backdropUrl ?? channel?.logoUrl,
      });
      castUrlRef.current = mediaInfo.contentUrl;
      const from = pi.startMs || startMs;
      await client.loadMedia({ mediaInfo, autoplay: true, startTime: liveNow ? undefined : Math.max(0, (from - castOffsetRef.current) / 1000) });
      if (!liveNow) setPos(from);
      setCastTick((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start casting');
    } finally {
      setLoading(false);
    }
  };

  // ----- loading -----
  const load = useCallback(
    async (startMs: number, opts: { audio?: number; bitrate?: number | null; paused?: boolean } = {}) => {
      if (castingRef.current) return castLoadRef.current(startMs, opts);
      setLoading(true);
      setError(null);
      try {
        const prev = infoRef.current;
        if (prev) {
          infoRef.current = null;
          api.stopSession(prev.sessionId).catch(() => undefined);
        }
        let pi: PlaybackInfo | null = null;
        let uri: string;
        if (target.kind === 'vod' && offlineUri) {
          uri = offlineUri;
        } else if (target.kind === 'live') {
          pi = await api.playChannel(channelId, catchup ? { catchupStart: catchup.start, catchupDurationMin: catchup.durationMin } : {});
          uri = api.absolute(pi.url);
        } else {
          pi = await api.playback(target.itemId, {
            startMs: Math.round(startMs),
            audioStreamIndex: opts.audio,
            subtitleStreamIndex: null, // we render sidecar subtitles ourselves
            deviceProfile: videoDeviceProfile(opts.bitrate === undefined ? maxBitrate : opts.bitrate),
          });
          uri = api.absolute(pi.url);
        }
        infoRef.current = pi;
        setInfo(pi);
        if (pi) applySubtitleDefaults(pi);
        pendingStartRef.current = pi ? pi.startMs ?? startMs : startMs;
        offsetRef.current = 0;
        if (pi?.durationMs) setDur(pi.durationMs);
        else if (offlineItem?.durationMs) setDur(offlineItem.durationMs);
        const artwork = pi?.posterUrl ? api.image(pi.posterUrl, 600) ?? undefined : undefined;
        player.replace({
          uri,
          contentType: pi?.isHls ? 'hls' : 'auto',
          headers: offlineUri ? undefined : api.headers(false),
          metadata: { title: pi?.title ?? offlineItem?.title, artist: pi?.subtitle ?? undefined, artwork },
        });
        if (!opts.paused) player.play();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Playback failed');
        setLoading(false);
      }
    },
    [api, target, offlineUri, channelId, catchup, maxBitrate, player, offlineItem, applySubtitleDefaults],
  );

  // Initial load + live channel changes.
  useEffect(() => {
    music.pause();
    void load(target.kind === 'vod' ? target.startMs ?? 0 : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, catchup]);

  // Stop the server session when leaving.
  useEffect(
    () => () => {
      report('stopped');
      const pi = infoRef.current;
      if (pi) api.stopSession(pi.sessionId).catch(() => undefined);
      // The server session is gone, so stop the receiver too (the cast session itself stays connected).
      if (castingRef.current && castUrlRef.current) void castClientRef.current?.stop().catch(() => undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ----- player events -----
  useEventListener(player, 'timeUpdate', ({ currentTime, bufferedPosition }) => {
    if (castingRef.current) return;
    const ms = currentTime * 1000 + offsetRef.current;
    setPos(ms);
    setBuffered(bufferedPosition > 0 ? bufferedPosition * 1000 + offsetRef.current : 0);
  });
  useEventListener(player, 'playingChange', ({ isPlaying }) => {
    if (castingRef.current) return;
    setPlaying(isPlaying);
    if (!isPlaying && infoRef.current) report('paused');
  });
  useEventListener(player, 'statusChange', ({ status: s, error: err }) => {
    if (castingRef.current) return;
    setLoading(s === 'loading');
    if (s === 'error') setError(err?.message ?? 'The video could not be played');
  });
  useEventListener(player, 'availableSubtitleTracksChange', ({ availableSubtitleTracks }) => setEmbeddedSubs(availableSubtitleTracks));
  useEventListener(player, 'sourceLoad', ({ duration, availableSubtitleTracks }) => {
    if (castingRef.current) return;
    setEmbeddedSubs(availableSubtitleTracks);
    const start = pendingStartRef.current;
    pendingStartRef.current = null;
    const pi = infoRef.current;
    const streamMs = duration * 1000;
    if (isLive && !catchup) return;
    if (catchup || !pi) {
      if (isFinite(streamMs) && streamMs > 0) setDur(streamMs);
      if (start && start > 500) player.currentTime = start / 1000;
      if (!catchup) syncAfterLoad(start ?? 0);
      return;
    }
    // Work out whether the stream starts at 0 or at startMs (a transcode started mid-file).
    const full = pi.durationMs ?? 0;
    let offset = 0;
    if (pi.streamStartMs !== undefined) offset = pi.streamStartMs;
    else if (start && start > 0) {
      if (isFinite(streamMs) && streamMs > 0 && full > 0) offset = Math.abs(streamMs - (full - start)) < Math.abs(streamMs - full) ? start : 0;
      else offset = pi.method === 'transcode' ? start : 0;
    }
    offsetRef.current = offset;
    setDur(full || (isFinite(streamMs) ? streamMs + offset : 0));
    if (start && start - offset > 500) player.currentTime = (start - offset) / 1000;
    syncAfterLoad(start ?? 0);
  });
  const onEnded = () => {
    if (isLive && !catchup) return;
    const next = infoRef.current?.nextItemId;
    if (next && prefs?.autoplayNext !== false) goNext(next);
    else exit();
  };
  useEventListener(player, 'playToEnd', () => {
    if (castingRef.current) return;
    onEnded();
  });

  // ----- Chromecast session / status -----
  // Connect: move playback to the receiver at the current position. Disconnect: back to this device, paused.
  const wasCasting = useRef(casting);
  useEffect(() => {
    if (casting === wasCasting.current) return;
    wasCasting.current = casting;
    if (casting) {
      void castLoadRef.current(posRef.current, { audio: audioIndex });
    } else {
      castUrlRef.current = null;
      setControls(true);
      void load(posRef.current, { audio: audioIndex, paused: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [casting]);

  // Mirror the receiver's state into the UI and the progress reports.
  const castEndedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!castStatus) return;
    const st = castStatus.playerState;
    const nowPlaying = st === 'playing' || st === 'buffering';
    if (playingRef.current && st === 'paused') report('paused');
    setPlaying(nowPlaying);
    setLoading(st === 'loading' || st === 'buffering');
    const sid = infoRef.current?.sessionId ?? null;
    if (st === 'idle' && sid && castEndedFor.current !== sid) {
      if (castStatus.idleReason === 'finished') {
        castEndedFor.current = sid;
        report('stopped');
        onEnded();
      } else if (castStatus.idleReason === 'error') {
        castEndedFor.current = sid;
        setError('The Chromecast could not play this stream');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [castStatus]);
  useEffect(() => {
    if (!castStatus || (isLive && !catchup)) return;
    setPos(cast.positionMs + castOffsetRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cast.positionMs, !!castStatus]);
  // Subtitles on the receiver: WebVTT text tracks 1..n in `info.subtitles` order.
  useEffect(() => {
    if (!casting || !castUrlRef.current) return;
    const subs = infoRef.current?.subtitles ?? [];
    const id = sub.kind === 'server' ? subs.findIndex((x) => x.index === sub.track.index) + 1 : 0;
    void castClientRef.current?.setActiveTrackIds(id > 0 ? [id] : []).catch(() => undefined);
  }, [casting, sub, castTick]);

  /** Play / pause whichever player is active. */
  const playAny = useCallback(() => {
    if (castingRef.current) void castClientRef.current?.play().catch(() => undefined);
    else player.play();
  }, [player]);
  const pauseAny = useCallback(() => {
    if (castingRef.current) void castClientRef.current?.pause().catch(() => undefined);
    else player.pause();
  }, [player]);

  // Session killed by an admin.
  useEffect(
    () =>
      on('sessionTerminated', (e) => {
        if (e.sessionId === infoRef.current?.sessionId) {
          pauseAny();
          setError(`Playback was stopped by the server${e.reason ? `: ${e.reason}` : ''}`);
        }
      }),
    [pauseAny],
  );

  // Progress every 10 s while playing.
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => report('playing'), 10000);
    return () => clearInterval(timer);
  }, [playing, report]);

  // Server subtitles: fetch + parse VTT.
  useEffect(() => {
    if (sub.kind === 'embedded') {
      player.subtitleTrack = sub.track;
      setCues([]);
      return;
    }
    try {
      player.subtitleTrack = null;
    } catch {
      /* ignore */
    }
    if (sub.kind !== 'server') {
      setCues([]);
      return;
    }
    let alive = true;
    fetch(api.withAuthQuery(sub.track.url), { headers: api.headers(false) })
      .then((r) => r.text())
      .then((txt) => alive && setCues(parseVtt(txt)))
      .catch(() => alive && setCues([]));
    return () => {
      alive = false;
    };
  }, [sub, api, player]);

  // Live: channel details + zapping list.
  useEffect(() => {
    if (!isLive) return;
    let alive = true;
    const fetchChannel = () => api.channel(channelId).then((c) => alive && setChannel(c)).catch(() => undefined);
    void fetchChannel();
    const timer = setInterval(fetchChannel, 60000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [isLive, channelId, api]);
  useEffect(() => {
    if (target.kind !== 'live') return;
    api
      .channels({ categoryId: target.categoryId, limit: 2000, withEpg: false })
      .then((r) => setChannelList(r.items))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----- controls visibility -----
  const poke = useCallback(() => {
    setControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControls(false), t.isTV ? 5000 : 4000);
  }, [t.isTV]);
  useEffect(() => {
    if (!playing || sheet || scrubbing || pendingSeek != null) {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      return;
    }
    if (controls) poke();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, sheet, scrubbing, pendingSeek]);

  // ----- actions -----
  const exit = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, []);

  const goNext = useCallback((nextId: string) => {
    report('stopped');
    if (inRoom) sync.broadcast('load', 0, nextId);
    router.replace(`/player/${nextId}` as never);
  }, [report, inRoom, sync]);

  const canSeek = !isLive || !!catchup;
  const seekTo = useCallback(
    (ms: number) => {
      if (!canSeek) return;
      const d = durRef.current;
      const target = Math.max(0, d > 0 ? Math.min(ms, d - 1000) : ms);
      const pi = infoRef.current;
      if (castingRef.current) {
        void castClientRef.current?.seek({ position: Math.max(0, (target - castOffsetRef.current) / 1000) }).catch(() => undefined);
        setPos(target);
        setUpNextDismissed(false);
        return;
      }
      const streamS = (target - offsetRef.current) / 1000;
      const streamDur = player.duration;
      if (pi && pi.method === 'transcode' && (streamS < 0 || (isFinite(streamDur) && streamDur > 0 && streamS > streamDur - 1))) {
        void load(target, { audio: audioIndex });
      } else {
        player.currentTime = Math.max(0, streamS);
      }
      setPos(target);
      setUpNextDismissed(false);
    },
    [canSeek, player, load, audioIndex],
  );
  /** A seek the user asked for: also sent to the watch-together room. */
  const userSeek = useCallback(
    (ms: number) => {
      if (!canSeek) return;
      seekTo(ms);
      if (inRoom) sync.broadcast('seek', Math.max(0, ms));
    },
    [canSeek, seekTo, inRoom, sync],
  );
  const seekBy = useCallback((deltaMs: number) => {
    userSeek(posRef.current + deltaMs);
    flash(`${deltaMs > 0 ? '+' : '−'}${Math.abs(deltaMs / 1000)}s`);
  }, [userSeek, flash]);

  const togglePlay = useCallback(() => {
    const isPlaying = castingRef.current ? playingRef.current : player.playing;
    if (isPlaying) {
      pauseAny();
      if (inRoom) sync.broadcast('pause', posRef.current);
    } else {
      playAny();
      if (inRoom) sync.broadcast('play', posRef.current);
    }
  }, [player, inRoom, sync, playAny, pauseAny]);

  // ----- watch together -----
  /** Apply a command from another room member. Never broadcasts (no echo). */
  const applyRemote = useCallback(
    (action: 'play' | 'pause' | 'seek', positionMs: number, by: string | null) => {
      const drift = Math.abs(positionMs - posRef.current);
      if (action === 'seek' || drift > 1500) {
        // Source still loading: just move where it will start.
        if (pendingStartRef.current != null) pendingStartRef.current = positionMs;
        else seekTo(positionMs);
      }
      if (action === 'play') playAny();
      if (action === 'pause') pauseAny();
      if (by) flash(action === 'play' ? `${by} pressed play` : action === 'pause' ? `${by} paused` : `${by} jumped to ${formatClock(positionMs)}`);
    },
    [seekTo, playAny, pauseAny, flash],
  );
  const applyRef = useRef(applyRemote);
  applyRef.current = applyRemote;
  useEffect(() => {
    if (!syncOn || !vodItemId) return;
    return sync.register({
      itemId: vodItemId,
      getPositionMs: () => posRef.current,
      isPaused: () => (castingRef.current ? !playingRef.current : !player.playing),
      apply: (a, p, by) => applyRef.current(a, p, by),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncOn, vodItemId, sync.register, player]);

  /** Once a source has loaded inside a room: start everyone (if we sent the load) or catch up with the room. */
  const syncAfterLoadRef = useRef<(startMs: number) => void>(() => undefined);
  syncAfterLoadRef.current = (startMs: number) => {
    const room = sync.room;
    if (!inRoom || !room || !vodItemId) return;
    if (sync.consumeOwnLoad(vodItemId)) {
      sync.broadcast('play', startMs);
      return;
    }
    if (room.itemId && room.itemId !== vodItemId) return;
    const roomPos = sync.roomPosition();
    if (roomPos != null && Math.abs(roomPos - startMs) > 2000) seekTo(roomPos);
    if (room.state === 'playing') playAny();
    else pauseAny();
  };
  function syncAfterLoad(startMs: number) {
    syncAfterLoadRef.current(startMs);
  }

  const zap = useCallback(
    (dir: 1 | -1) => {
      if (!isLive || channelList.length < 2) return;
      const i = channelList.findIndex((c) => c.id === channelId);
      const next = channelList[(i + dir + channelList.length) % channelList.length];
      setCatchup(null);
      setChannelId(next.id);
      flash(`${next.number != null ? `${next.number}  ` : ''}${next.name}`);
    },
    [isLive, channelList, channelId, flash],
  );

  // ----- markers & up next -----
  const markers: Marker[] = info?.markers ?? offlineItem?.markers ?? [];
  const activeMarker = !isLive ? markers.find((m) => pos >= m.startMs && pos < m.endMs - 800) : undefined;
  const credits = markers.find((m) => m.type === 'credits');
  const nextId = info?.nextItemId ?? null;

  useEffect(() => {
    if (!activeMarker || activeMarker.type === 'credits') return;
    const key = activeMarker.startMs;
    if (prefs?.skipIntros && activeMarker.type === 'intro' && !skipped.current.has(key)) {
      skipped.current.add(key);
      seekTo(activeMarker.endMs);
      flash('Intro skipped');
    }
  }, [activeMarker, prefs?.skipIntros, seekTo, flash]);

  useEffect(() => {
    if (isLive || !nextId || upNext || upNextDismissed || prefs?.autoplayNext === false || dur <= 0) return;
    const inCredits = credits ? pos >= credits.startMs : dur > 120000 && dur - pos < 25000;
    if (!inCredits) return;
    setUpNext({ item: null, secondsLeft: 10 });
    api.item(nextId).then((it) => setUpNext((u) => (u ? { ...u, item: it } : u))).catch(() => undefined);
  }, [pos, dur, credits, nextId, upNext, upNextDismissed, isLive, prefs?.autoplayNext, api]);

  useEffect(() => {
    if (!upNext || !playing) return;
    if (upNext.secondsLeft <= 0) {
      if (nextId) goNext(nextId);
      return;
    }
    const timer = setTimeout(() => setUpNext((u) => (u ? { ...u, secondsLeft: u.secondsLeft - 1 } : u)), 1000);
    return () => clearTimeout(timer);
  }, [upNext, playing, nextId, goNext]);

  // ----- remote control (TV) -----
  useTVRemote((evt) => {
    const type = evt.eventType;
    if (type === 'channelUp' || type === 'pageUp') return zap(1);
    if (type === 'channelDown' || type === 'pageDown') return zap(-1);
    if (type === 'playPause') {
      togglePlay();
      return poke();
    }
    if (sheet) return;
    if (!controls) {
      if (type === 'select') {
        // A visible Skip / Up Next button has focus and handles select itself.
        if ((activeMarker && (activeMarker.type !== 'credits' || !nextId)) || upNext) return;
        togglePlay();
        return poke();
      }
      if (type === 'left' || type === 'right') {
        if (canSeek) seekBy(type === 'right' ? 10000 : -10000);
        return;
      }
      if (type === 'longLeft' || type === 'longRight' || type === 'rewind' || type === 'fastForward') {
        if (canSeek) seekBy(type === 'longRight' || type === 'fastForward' ? 30000 : -30000);
        return;
      }
      if (isLive && (type === 'up' || type === 'down')) return zap(type === 'up' ? 1 : -1);
      if (type === 'up' || type === 'down' || type === 'swipeUp' || type === 'swipeDown') return poke();
      return;
    }
    // Controls visible: scrub with left/right while the seek bar is focused.
    if (scrubFocused && canSeek && (type === 'left' || type === 'right' || type === 'longLeft' || type === 'longRight')) {
      const step = type.startsWith('long') ? 60000 : 10000;
      setPendingSeek((p) => {
        const base = p ?? posRef.current;
        const next = Math.max(0, Math.min(durRef.current || base, base + (type.endsWith('ight') ? step : -step)));
        return next;
      });
      if (seekDialTimer.current) clearTimeout(seekDialTimer.current);
      seekDialTimer.current = setTimeout(() => {
        setPendingSeek((p) => {
          if (p != null) userSeek(p);
          return null;
        });
      }, 900);
    }
    poke();
  });

  useBackHandler(() => {
    if (sheet) {
      setSheet(null);
      return true;
    }
    if (upNext) {
      setUpNext(null);
      setUpNextDismissed(true);
      return true;
    }
    if (t.isTV && controls && playing) {
      setControls(false);
      return true;
    }
    return false;
  });

  // ----- menus -----
  const audioStreams = info?.audioStreams ?? offlineItem?.media?.[0]?.audioStreams ?? [];
  const currentAudio = audioIndex ?? audioStreams.find((a) => a.default)?.index ?? audioStreams[0]?.index;
  const audioOptions: SheetOption<number>[] = audioStreams.map((a) => ({
    key: a.index,
    label: a.title ?? languageName(a.language),
    description: [a.language ? languageName(a.language) : null, a.codec.toUpperCase(), a.channels >= 6 ? (a.channels >= 8 ? '7.1' : '5.1') : a.channels === 2 ? 'Stereo' : a.channels === 1 ? 'Mono' : null].filter(Boolean).join(' · '),
    selected: a.index === currentAudio,
  }));
  const selectAudio = (index: number) => {
    setSheet(null);
    if (index === currentAudio) return;
    setAudioIndex(index);
    const pi = infoRef.current;
    const native = player.availableAudioTracks;
    const pos0 = audioStreams.findIndex((a) => a.index === index);
    if (!castingRef.current && (!pi || pi.method === 'direct' || pi.method === 'remux') && native.length === audioStreams.length && native[pos0]) {
      player.audioTrack = native[pos0];
    } else {
      void load(posRef.current, { audio: index });
    }
  };

  const subSections = useMemo(() => {
    const serverTracks = info?.subtitles ?? [];
    const sections: { title?: string; options: SheetOption<string>[] }[] = [
      { options: [{ key: 'off', label: 'Off', selected: sub.kind === 'off', icon: 'close-circle-outline' }] },
    ];
    if (serverTracks.length)
      sections.push({
        title: 'Subtitles',
        options: serverTracks.map((s) => ({
          key: `s:${s.index}`,
          label: s.title ?? languageName(s.language),
          description: [s.language ? languageName(s.language) : null, s.forced ? 'Forced' : null, s.default ? 'Default' : null].filter(Boolean).join(' · ') || undefined,
          selected: sub.kind === 'server' && sub.track.index === s.index,
        })),
      });
    if (embeddedSubs.length && !casting)
      sections.push({
        title: 'In stream',
        options: embeddedSubs.map((s, i) => ({ key: `e:${i}`, label: s.label || languageName(s.language), selected: sub.kind === 'embedded' && sub.track.id === s.id && sub.track.language === s.language })),
      });
    if (onlineVod) sections.push({ title: 'More', options: [{ key: 'online', label: 'Search online…', description: 'Find and download subtitles from OpenSubtitles', icon: 'cloud-download-outline' }] });
    return sections;
  }, [info, embeddedSubs, sub, onlineVod, casting]);
  const selectSub = (key: string) => {
    if (key === 'online') return setSheet('online');
    setSheet(null);
    if (key === 'off') return setSub({ kind: 'off' });
    const [kind, idx] = key.split(':');
    if (kind === 's') {
      const tr = info?.subtitles.find((s) => String(s.index) === idx);
      if (tr) setSub({ kind: 'server', track: tr });
    } else {
      const tr = embeddedSubs[Number(idx)];
      if (tr) setSub({ kind: 'embedded', track: tr });
    }
  };

  const qualityOptions: SheetOption<string>[] = QUALITY_OPTIONS.map((q) => ({ key: String(q.kbps ?? 'orig'), label: q.label, selected: q.kbps === maxBitrate, description: q.kbps == null && info ? `Currently: ${info.method}` : undefined }));
  const selectQuality = (key: string) => {
    setSheet(null);
    const kbps = key === 'orig' ? null : Number(key);
    if (kbps === maxBitrate) return;
    setMaxBitrate(kbps);
    void load(posRef.current, { audio: audioIndex, bitrate: kbps });
  };

  const onSubtitleDownloaded = (_item: Item, remote: RemoteSubtitle) => {
    setSheet(null);
    autoPickSub.current = { prev: new Set((infoRef.current?.subtitles ?? []).map((s) => s.index)), language: remote.language };
    flash('Subtitles downloaded');
    // Re-request playback at the current position so the new track is listed.
    void load(posRef.current, { audio: audioIndex });
  };

  const recordNow = async () => {
    if (!channel?.nowPlaying) return;
    try {
      await api.createRecording({ channelId: channel.id, programId: channel.nowPlaying.id });
      flash('Recording scheduled');
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Could not record');
    }
  };

  // ----- render -----
  const subtitleText = sub.kind === 'server' && !casting ? activeCues(cues, pos).map((c) => c.text).join('\n') : '';
  const title = info?.title ?? offlineItem?.title ?? channel?.name ?? '';
  const subtitle = isLive ? (catchup ? `Catch-up · ${formatTime(catchup.start)}` : channel?.nowPlaying?.title ?? null) : info?.subtitle ?? null;
  const pipSupported = !t.isTV && !casting && isPictureInPictureSupported();
  // The receiver is the screen while casting: keep the remote-control UI up.
  const showControls = (controls || casting) && !error;
  const iconSize = t.isTV ? t.s(30) : 26;

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <StatusBar hidden />
      <VideoView
        ref={viewRef}
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit="contain"
        nativeControls={false}
        allowsPictureInPicture={pipSupported}
        startsPictureInPictureAutomatically={pipSupported}
        focusable={false}
      />

      {casting ? <CastingPanel deviceName={cast.deviceName} title={title} art={info?.backdropUrl ?? info?.posterUrl ?? channel?.logoUrl ?? null} /> : null}

      {/* Tap layer (phones) */}
      {!t.isTV ? <Pressable style={StyleSheet.absoluteFill} onPress={() => (controls ? setControls(false) : poke())} /> : null}

      {/* Subtitles */}
      {subtitleText ? (
        <View pointerEvents="none" style={{ position: 'absolute', left: '8%', right: '8%', bottom: controls ? (t.isTV ? t.s(190) : 130) : t.isTV ? t.s(60) : 36, alignItems: 'center' }}>
          <T
            center
            weight="700"
            color="#fff"
            style={{ fontSize: t.isTV ? t.s(30) : t.wide ? 24 : 18, lineHeight: t.isTV ? t.s(40) : t.wide ? 32 : 25, textShadowColor: 'rgba(0,0,0,0.95)', textShadowRadius: 6, textShadowOffset: { width: 0, height: 1 }, backgroundColor: 'rgba(0,0,0,0.35)', paddingHorizontal: 8, borderRadius: 4 }}
          >
            {subtitleText}
          </T>
        </View>
      ) : null}

      {loading && !error ? (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
          <ActivityIndicator size="large" color={t.colors.primary} />
        </View>
      ) : null}

      {/* OSD toast (seek amount, channel banner) */}
      {osd ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: t.isTV ? t.s(60) : insets.top + 50, alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.7)', paddingHorizontal: t.space.lg, paddingVertical: t.space.sm, borderRadius: 999 }}>
          <T variant="heading" color="#fff">
            {osd}
          </T>
        </View>
      ) : null}

      {/* Controls */}
      {showControls ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <LinearGradient colors={['rgba(0,0,0,0.75)', 'transparent']} pointerEvents="box-none" style={{ paddingTop: t.isTV ? t.s(40) : insets.top + 8, paddingHorizontal: t.isTV ? t.space.gutter : Math.max(insets.left, 12), paddingBottom: 40, flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
            {!t.isTV ? (
              <Focusable onPress={exit} style={{ padding: 6 }} accessibilityLabel="Close player">
                <Icon name="chevron-down" color="#fff" size={28} />
              </Focusable>
            ) : null}
            {isLive && channel?.logoUrl ? <Img path={channel.logoUrl} width={60} contentFit="contain" style={{ width: t.s(60), height: t.s(40) }} /> : null}
            <View style={{ flex: 1 }}>
              <T variant={t.isTV ? 'title' : 'heading'} color="#fff" numberOfLines={1}>
                {isLive && channel ? `${channel.number != null ? `${channel.number} · ` : ''}${channel.name}` : title}
              </T>
              {subtitle ? (
                <T variant="small" color="rgba(255,255,255,0.8)" numberOfLines={1}>
                  {subtitle}
                </T>
              ) : null}
            </View>
            {isLive && !catchup ? (
              <View style={{ backgroundColor: t.colors.danger, paddingHorizontal: 10, paddingVertical: 3, borderRadius: 4 }}>
                <T variant="caption" color="#fff">
                  LIVE
                </T>
              </View>
            ) : null}
            {inRoom ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: t.alpha(t.colors.primary, 0.85), paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999 }}>
                <Icon name="people" size={t.isTV ? t.s(16) : 14} color={t.colors.primaryText} />
                <T variant="caption" color={t.colors.primaryText}>
                  {sync.room!.code} · {sync.room!.members.length}
                </T>
              </View>
            ) : null}
            {canCast ? <CastButton tint={casting ? t.colors.primary : '#fff'} /> : null}
            {Platform.OS === 'ios' && !t.isTV && !casting ? <VideoAirPlayButton tint="#fff" activeTint={t.colors.primary} style={{ width: 34, height: 34 }} /> : null}
            {pipSupported ? (
              <Focusable onPress={() => viewRef.current?.startPictureInPicture().catch(() => undefined)} style={{ padding: 6 }} accessibilityLabel="Picture in picture">
                <Icon name="albums-outline" color="#fff" />
              </Focusable>
            ) : null}
          </LinearGradient>

          {/* Centre transport (phones) */}
          {!t.isTV ? (
            <View pointerEvents="box-none" style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 48 }}>
              {canSeek ? (
                <Focusable onPress={() => seekBy(-10000)} style={{ padding: 10 }} accessibilityLabel="Back 10 seconds">
                  <Icon name="play-back" color="#fff" size={34} />
                </Focusable>
              ) : isLive ? (
                <Focusable onPress={() => zap(-1)} style={{ padding: 10 }} accessibilityLabel="Previous channel">
                  <Icon name="chevron-up" color="#fff" size={34} />
                </Focusable>
              ) : null}
              <Focusable onPress={togglePlay} style={{ width: 76, height: 76, borderRadius: 38, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' }} accessibilityLabel={playing ? 'Pause' : 'Play'}>
                <Icon name={playing ? 'pause' : 'play'} color="#fff" size={42} />
              </Focusable>
              {canSeek ? (
                <Focusable onPress={() => seekBy(10000)} style={{ padding: 10 }} accessibilityLabel="Forward 10 seconds">
                  <Icon name="play-forward" color="#fff" size={34} />
                </Focusable>
              ) : isLive ? (
                <Focusable onPress={() => zap(1)} style={{ padding: 10 }} accessibilityLabel="Next channel">
                  <Icon name="chevron-down" color="#fff" size={34} />
                </Focusable>
              ) : null}
            </View>
          ) : (
            <View style={{ flex: 1 }} pointerEvents="none" />
          )}

          <LinearGradient colors={['transparent', 'rgba(0,0,0,0.85)']} pointerEvents="box-none" style={{ paddingHorizontal: t.isTV ? t.space.gutter : Math.max(insets.left, insets.right, 16), paddingBottom: t.isTV ? t.s(40) : Math.max(insets.bottom, 12), paddingTop: 50, gap: t.space.sm }}>
            {isLive && !catchup ? (
              channel?.nowPlaying ? (
                <View style={{ gap: 6 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <T variant="small" color="#fff" weight="700">
                      Now · {channel.nowPlaying.title}
                    </T>
                    <T variant="small" color="rgba(255,255,255,0.75)">
                      {formatTime(channel.nowPlaying.start)} – {formatTime(channel.nowPlaying.end)}
                    </T>
                  </View>
                  <ProgressBar value={programProgress(channel.nowPlaying)} />
                  {channel.next ? (
                    <T variant="small" color="rgba(255,255,255,0.7)">
                      Next · {formatTime(channel.next.start)} {channel.next.title}
                    </T>
                  ) : null}
                </View>
              ) : null
            ) : dur > 0 ? (
              <Scrubber positionMs={pos} durationMs={dur} bufferedMs={buffered} markers={markers} onSeek={userSeek} onScrubbing={setScrubbing} onFocusChange={setScrubFocused} pendingMs={pendingSeek} trickplay={trickplay} />
            ) : null}

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, flexWrap: 'wrap' }}>
              {t.isTV ? (
                <>
                  <Button icon={playing ? 'pause' : 'play'} variant="secondary" onPress={togglePlay} hasTVPreferredFocus accessibilityLabel={playing ? 'Pause' : 'Play'} />
                  {canSeek ? <Button icon="play-back" variant="secondary" onPress={() => seekBy(-10000)} accessibilityLabel="Back 10 seconds" /> : null}
                  {canSeek ? <Button icon="play-forward" variant="secondary" onPress={() => seekBy(10000)} accessibilityLabel="Forward 10 seconds" /> : null}
                </>
              ) : null}
              <View style={{ flex: 1 }} />
              {audioStreams.length > 1 ? <CtrlButton icon="musical-note-outline" label={t.isTV || t.wide ? 'Audio' : undefined} onPress={() => setSheet('audio')} size={iconSize} /> : null}
              {(info?.subtitles.length ?? 0) + embeddedSubs.length > 0 || onlineVod ? <CtrlButton icon={sub.kind === 'off' ? 'chatbox-outline' : 'chatbox'} label={t.isTV || t.wide ? 'Subtitles' : undefined} onPress={() => setSheet('subs')} size={iconSize} /> : null}
              {!offlineUri && !isLive ? <CtrlButton icon="speedometer-outline" label={t.isTV || t.wide ? (maxBitrate ? `${Math.round(maxBitrate / 1000)} Mbps` : 'Quality') : undefined} onPress={() => setSheet('quality')} size={iconSize} /> : null}
              {isLive && channelList.length > 1 ? <CtrlButton icon="list" label={t.isTV || t.wide ? 'Channels' : undefined} onPress={() => setSheet('channels')} size={iconSize} /> : null}
              {isLive ? <CtrlButton icon="grid-outline" label={t.isTV || t.wide ? 'Guide' : undefined} onPress={() => router.push('/live/guide' as never)} size={iconSize} /> : null}
              {isLive && caps.dvr && channel?.nowPlaying && !catchup ? <CtrlButton icon="radio-button-on" label={t.isTV || t.wide ? 'Record' : undefined} onPress={recordNow} size={iconSize} color={t.colors.danger} /> : null}
              {syncOn ? <CtrlButton icon={inRoom ? 'people' : 'people-outline'} label={t.isTV || t.wide ? (inRoom ? `Together · ${sync.room!.members.length}` : 'Watch together') : undefined} onPress={() => setSheet('together')} size={iconSize} color={inRoom ? t.colors.primary : undefined} /> : null}
              {nextId && !isLive ? <CtrlButton icon="play-skip-forward" label={t.isTV || t.wide ? 'Next' : undefined} onPress={() => goNext(nextId)} size={iconSize} /> : null}
            </View>
          </LinearGradient>
        </View>
      ) : null}

      {/* Skip intro / credits */}
      {activeMarker && !upNext && !error && (activeMarker.type !== 'credits' || !nextId) ? (
        <View style={{ position: 'absolute', right: t.isTV ? t.space.gutter : Math.max(insets.right, 20), bottom: controls ? (t.isTV ? t.s(200) : 140) : t.isTV ? t.s(60) : 40 }}>
          <Button
            label={activeMarker.type === 'intro' ? 'Skip Intro' : activeMarker.type === 'recap' ? 'Skip Recap' : 'Skip Credits'}
            icon="play-skip-forward"
            variant="secondary"
            size="lg"
            hasTVPreferredFocus={!controls}
            onPress={() => userSeek(activeMarker.endMs)}
          />
        </View>
      ) : null}

      {/* Up next */}
      {upNext && !error ? (
        <UpNextCard
          item={upNext.item}
          seconds={upNext.secondsLeft}
          onPlay={() => nextId && goNext(nextId)}
          onCancel={() => {
            setUpNext(null);
            setUpNextDismissed(true);
          }}
        />
      ) : null}

      {/* Error */}
      {error ? (
        <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.85)', gap: t.space.md, padding: t.space.xl }]}>
          <Icon name="alert-circle-outline" size={t.s(48)} color={t.colors.danger} />
          <T variant="heading" color="#fff" center>
            Playback problem
          </T>
          <T color="rgba(255,255,255,0.8)" center style={{ maxWidth: 520 }}>
            {error}
          </T>
          <View style={{ flexDirection: 'row', gap: t.space.sm }}>
            <Button label="Retry" icon="refresh" onPress={() => load(posRef.current, { audio: audioIndex })} hasTVPreferredFocus />
            {!offlineUri && !isLive && status === 'signed-in' ? <Button label="Lower quality" variant="secondary" onPress={() => selectQuality('3000')} /> : null}
            <Button label="Close" variant="secondary" onPress={exit} />
          </View>
        </View>
      ) : null}

      <OptionSheet visible={sheet === 'audio'} title="Audio" options={audioOptions} onSelect={selectAudio} onClose={() => setSheet(null)} />
      <OptionSheet visible={sheet === 'subs'} title="Subtitles" sections={subSections} onSelect={selectSub} onClose={() => setSheet(null)} />
      {onlineVod && vodItemId ? <OnlineSubtitlesSheet visible={sheet === 'online'} itemId={vodItemId} onClose={() => setSheet(null)} onDownloaded={onSubtitleDownloaded} /> : null}
      {syncOn && vodItemId ? <WatchTogetherSheet visible={sheet === 'together'} itemId={vodItemId} onClose={() => setSheet(null)} /> : null}
      <OptionSheet visible={sheet === 'quality'} title="Quality" options={qualityOptions} onSelect={selectQuality} onClose={() => setSheet(null)} />
      <OptionSheet
        visible={sheet === 'channels'}
        title="Channels"
        options={channelList.map((c) => ({ key: c.id, label: `${c.number != null ? `${c.number}  ` : ''}${c.name}`, selected: c.id === channelId }))}
        onSelect={(id) => {
          setSheet(null);
          setCatchup(null);
          setChannelId(id);
        }}
        onClose={() => setSheet(null)}
      />
    </View>
  );
}

function CtrlButton({ icon, label, onPress, size, color }: { icon: React.ComponentProps<typeof Icon>['name']; label?: string; onPress: () => void; size: number; color?: string }) {
  const t = useTheme();
  return (
    <Focusable onPress={onPress} ringRadius={999} focusScale={t.isTV ? 1.08 : 1} accessibilityLabel={label ?? icon} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: t.isTV ? t.s(10) : 8, paddingHorizontal: t.isTV ? t.s(16) : 10, borderRadius: 999, backgroundColor: t.isTV ? 'rgba(255,255,255,0.12)' : 'transparent' }}>
      {({ focused }) => (
        <>
          <Icon name={icon} size={size} color={color ?? (focused ? t.colors.primary : '#fff')} />
          {label ? (
            <T variant="small" weight="700" color="#fff">
              {label}
            </T>
          ) : null}
        </>
      )}
    </Focusable>
  );
}

function UpNextCard({ item, seconds, onPlay, onCancel }: { item: Item | null; seconds: number; onPlay: () => void; onCancel: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const w = t.isTV ? t.s(300) : 200;
  return (
    <View style={{ position: 'absolute', right: t.isTV ? t.space.gutter : Math.max(insets.right, 16), bottom: t.isTV ? t.s(60) : Math.max(insets.bottom, 16) + 8, width: w + t.space.md * 2, backgroundColor: 'rgba(20,20,28,0.94)', borderRadius: t.radius * 1.2, padding: t.space.md, gap: t.space.sm, borderWidth: 1, borderColor: t.alpha(t.colors.primary, 0.4) }}>
      <T variant="caption" tone="primary" style={{ textTransform: 'uppercase' }}>
        Up next in {seconds}s
      </T>
      <View style={{ width: w, height: (w * 9) / 16, borderRadius: t.radius, overflow: 'hidden', backgroundColor: '#111' }}>
        {item ? <Img path={item.thumbUrl ?? item.backdropUrl ?? item.posterUrl} width={w} style={{ width: '100%', height: '100%' }} /> : null}
        <View style={{ position: 'absolute', left: 0, bottom: 0, height: 4, width: `${((10 - seconds) / 10) * 100}%`, backgroundColor: t.colors.primary }} />
      </View>
      {item ? (
        <T weight="700" color="#fff" numberOfLines={2}>
          {item.type === 'episode' ? `S${item.parentIndex}E${item.index} · ${item.title}` : item.title}
        </T>
      ) : null}
      <View style={{ flexDirection: 'row', gap: t.space.sm }}>
        <Button label="Play now" icon="play" size="sm" onPress={onPlay} hasTVPreferredFocus />
        <Button label="Cancel" variant="secondary" size="sm" onPress={onCancel} />
      </View>
    </View>
  );
}

/** Shown in place of the picture while the video plays on a Chromecast. */
function CastingPanel({ deviceName, title, art }: { deviceName: string | null; title: string; art: string | null }) {
  const t = useTheme();
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' }]}>
      {art ? <Img path={art} width={600} blurRadius={30} style={[StyleSheet.absoluteFill, { opacity: 0.45 }]} /> : null}
      <View style={{ alignItems: 'center', gap: t.space.sm, paddingHorizontal: t.space.xl }}>
        <Icon name="tv-outline" size={56} color={t.colors.primary} />
        <T variant="heading" color="#fff" center>
          Casting to {deviceName ?? 'Chromecast'}
        </T>
        {title ? (
          <T color="rgba(255,255,255,0.75)" center numberOfLines={2}>
            {title}
          </T>
        ) : null}
      </View>
    </View>
  );
}
