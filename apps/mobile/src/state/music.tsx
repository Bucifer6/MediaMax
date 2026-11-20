/**
 * Audio queue + background audio via expo-audio, with lock-screen / control
 * centre metadata and server progress reporting. Plays music tracks plus
 * spoken-word audio (audiobook parts, podcast episodes), which additionally
 * resume where you left off, offer playback speed and expose chapters.
 *
 * While a Chromecast session is connected the queue plays on the receiver
 * instead: the local player is paused, transport controls are mirrored to the
 * cast session and progress is reported from the receiver's media status.
 *
 * Spoken audio also gets a sleep timer (minutes / end of chapter, with a short
 * fade-out) and remembers its playback speed per book or show (AsyncStorage).
 */
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { audioDeviceProfile, castDeviceProfile } from '@/api/profiles';
import { getJSON, setJSON } from '@/api/storage';
import { lockScreenOptions, transportMode, type LockScreenOptions } from '@/car/policy';
import { syncCarRemoteCommands } from '@/car/remote';
import { castMediaInfo, isOurMedia, useCast } from '@/cast';
import type { Chapter, Item, PlaybackInfo } from '@/api/types';
import { isAudioItem, isSpokenAudio } from '@/utils/library';
import { useDownloads } from './downloads';
import { useSession } from './session';

export type RepeatMode = 'off' | 'all' | 'one';
export const SPEEDS = [0.8, 1, 1.1, 1.25, 1.5, 1.75, 2];

/** Sleep timer: pause after some minutes, at the end of the current chapter, or at the end of the current part/track. */
export type SleepTimer =
  | { mode: 'time'; minutes: number; endsAt: number }
  | { mode: 'chapter'; itemId: string; endMs: number }
  | { mode: 'part'; itemId: string };
/** `'chapter'` falls back to the end of the current part when the item has no (further) chapters. */
export type SleepOption = { minutes: number } | 'chapter';
/** How long the volume fades out before the sleep timer pauses (local playback only). */
const SLEEP_FADE_MS = 10000;
/** Playback speed is remembered per book (parent of a part) or per podcast show. */
const speedKey = (item: Item) => `mediamax.speed.${item.parentId ?? item.id}`;

interface MusicValue {
  queue: Item[];
  index: number;
  current: Item | null;
  playing: boolean;
  buffering: boolean;
  positionMs: number;
  durationMs: number;
  shuffle: boolean;
  repeat: RepeatMode;
  error: string | null;
  /** Current item is an audiobook part / podcast episode. */
  spoken: boolean;
  /**
   * Current item is a music track longer than LONG_TRACK_MS (src/car/policy.ts): DJ mix, live set,
   * concert… It gets ±15/30 s skips in addition to next/previous.
   */
  longTrack: boolean;
  /** Spoken-word playback speed (music always plays at 1x). */
  rate: number;
  setRate: (rate: number) => void;
  /** Chapters of the current item (from GET /items/:id), if any. */
  chapters: Chapter[];
  /** Relative seek, e.g. -15 s / +30 s for spoken audio. */
  skip: (deltaMs: number) => void;
  /** `startMs` overrides the resume position of the first item. */
  playQueue: (items: Item[], startIndex?: number, opts?: { shuffle?: boolean; startMs?: number }) => void;
  enqueue: (items: Item[]) => void;
  playNextInQueue: (item: Item) => void;
  toggle: () => void;
  pause: () => void;
  next: () => void;
  previous: () => void;
  seek: (ms: number) => void;
  /** `startMs` starts that queue entry at a position (e.g. a bookmark) instead of its resume point. */
  jumpTo: (index: number, startMs?: number) => void;
  stop: () => void;
  setShuffle: (v: boolean) => void;
  cycleRepeat: () => void;
  /** Name of the Chromecast the queue is playing on, or null when playing locally. */
  castingTo: string | null;
  /** 0–1 (local player, or the receiver's stream volume while casting). */
  volume: number;
  setVolume: (v: number) => void;
  sleep: SleepTimer | null;
  /** Wall-clock time left on the sleep timer (null when off or unknown). */
  sleepRemainingMs: number | null;
  setSleep: (opt: SleepOption | null) => void;
}

const Ctx = createContext<MusicValue | null>(null);

function shuffled<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function MusicProvider({ children }: { children: React.ReactNode }) {
  const { api, user } = useSession();
  const downloads = useDownloads();
  const player = useAudioPlayer(null, { updateInterval: 500 });
  const status = useAudioPlayerStatus(player);
  const [queue, setQueue] = useState<Item[]>([]);
  const [index, setIndex] = useState(0);
  const [shuffle, setShuffleState] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>('off');
  const [error, setError] = useState<string | null>(null);
  const [rate, setRateState] = useState(1);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const chaptersRef = useRef<Chapter[]>(chapters);
  chaptersRef.current = chapters;
  const [volume, setVolumeState] = useState(1);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const [sleep, setSleepState] = useState<SleepTimer | null>(null);
  const sleepRef = useRef<SleepTimer | null>(sleep);
  sleepRef.current = sleep;
  const [sleepRemainingMs, setSleepRemaining] = useState<number | null>(null);
  const session = useRef<PlaybackInfo | null>(null);
  const loadedId = useRef<string | null>(null);
  /** Resume position to apply once the source has loaded (spoken audio). */
  const pendingSeek = useRef<number | null>(null);
  /** One-shot start override from playQueue(…, { startMs }). */
  const startOverride = useRef<{ id: string; ms: number } | null>(null);
  const current = queue[index] ?? null;
  const spoken = !!current && isSpokenAudio(current.type);
  const spokenRef = useRef(spoken);
  spokenRef.current = spoken;
  const rateRef = useRef(rate);
  rateRef.current = rate;
  const currentRef = useRef<Item | null>(current);
  currentRef.current = current;
  /** What the lock screen was last set up with (re-applied when a long track's duration shows up late). */
  const lockScreen = useRef<{ itemId: string; meta: Record<string, string | undefined>; options: LockScreenOptions } | null>(null);

  // ReplayGain: lower loud tracks to a common loudness (local playback only; we never amplify past 1×).
  const rgMode = user?.preferences.replayGain ?? 'auto';
  const gain = useMemo(() => {
    const rg = current?.type === 'track' ? current.replayGain : null;
    if (!rg || rgMode === 'off') return 1;
    const albumInOrder = queue.length > 1 && !shuffle && queue.every((q) => q.parentId === current?.parentId);
    const db = rgMode === 'album' || (rgMode === 'auto' && albumInOrder) ? rg.albumGainDb ?? rg.trackGainDb : rg.trackGainDb ?? rg.albumGainDb;
    if (db == null) return 1;
    const peak = (rgMode === 'album' || albumInOrder ? rg.albumPeak : rg.trackPeak) ?? null;
    let f = Math.pow(10, db / 20);
    if (peak && peak > 0) f = Math.min(f, 1 / peak); // avoid clipping
    return Math.max(0.05, Math.min(1, f));
  }, [current, queue, shuffle, rgMode]);
  const gainRef = useRef(gain);
  gainRef.current = gain;
  useEffect(() => {
    if (castModeRef.current || sleepRef.current) return; // the sleep fade owns the volume while it runs
    try {
      player.volume = volumeRef.current * gain;
    } catch {
      /* player not ready */
    }
  }, [gain]); // eslint-disable-line react-hooks/exhaustive-deps

  // ----- Chromecast -----
  const cast = useCast();
  const castOn = cast.connected && !!cast.client && !!api;
  /** Whether the current item is loaded on the receiver (vs. the local player). */
  const castModeRef = useRef(false);
  /** URL we loaded on the receiver, to tell our media apart from another sender's. */
  const castUrl = useRef<string | null>(null);
  const castPosRef = useRef(0);
  castPosRef.current = cast.positionMs;
  const castClientRef = useRef(cast.client);
  castClientRef.current = cast.client;
  const ours = castOn && isOurMedia(cast.mediaStatus, castUrl.current);
  const castState = ours ? cast.mediaStatus?.playerState ?? null : null;
  const castPlaying = castState === 'playing' || castState === 'buffering';
  const castPlayingRef = useRef(castPlaying);
  castPlayingRef.current = castPlaying;
  const oursRef = useRef(ours);
  oursRef.current = ours;
  /** Load the next source paused (handing playback back from the TV). */
  const loadPaused = useRef(false);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix' }).catch(() => undefined);
  }, []);

  const report = useCallback(
    (state: 'playing' | 'paused' | 'stopped') => {
      const s = session.current;
      const remote = castModeRef.current;
      const positionMs = remote ? castPosRef.current : Math.round(player.currentTime * 1000);
      const durationMs = remote ? currentRef.current?.durationMs ?? undefined : Math.round(player.duration * 1000) || undefined;
      // Offline spoken audio: keep the resume position locally, like offline video.
      const cur = currentRef.current;
      if (!s && cur && spokenRef.current && positionMs > 0) downloads.updateLocalPosition(cur.id, positionMs);
      if (!api || !s) return;
      const body = { positionMs, durationMs, state, sessionId: s.sessionId };
      api.sessionProgress(s.sessionId, body).catch(() => undefined);
      if (state === 'stopped') api.stopSession(s.sessionId).catch(() => undefined);
    },
    [api, player, downloads],
  );

  // Cast connected / disconnected: hand the current item over at the same position.
  useEffect(() => {
    if (castOn === castModeRef.current) return;
    const cur = currentRef.current;
    if (cur && loadedId.current === cur.id) {
      const pos = castModeRef.current ? castPosRef.current : Math.round(player.currentTime * 1000);
      startOverride.current = { id: cur.id, ms: pos };
      loadPaused.current = !castOn;
      loadedId.current = null;
    } else if (!cur) {
      castModeRef.current = castOn;
    }
    if (!castOn) castUrl.current = null;
  }, [castOn, player]);

  // Load the current track.
  useEffect(() => {
    if (!current || !api) return;
    if (loadedId.current === current.id) return;
    loadedId.current = current.id;
    let alive = true;
    (async () => {
      setError(null);
      if (session.current) report('stopped');
      session.current = null;
      castModeRef.current = castOn;
      const local = downloads.get(current.id);
      const isSpoken = isSpokenAudio(current.type);
      // Spoken audio resumes; music always starts at the top.
      const override = startOverride.current?.id === current.id ? startOverride.current.ms : null;
      startOverride.current = null;
      const dur = current.durationMs ?? 0;
      const saved = local?.state === 'done' && local.positionMs ? local.positionMs : current.userData.positionMs;
      let startMs = override ?? (isSpoken ? (dur && saved > dur * 0.95 ? 0 : saved) : 0);
      setChapters([]);
      // Remembered speed for this book / show (read in parallel with the playback request).
      const savedSpeed = isSpoken ? getJSON<number | null>(speedKey(current), null) : Promise.resolve(null);
      const applySavedSpeed = async () => {
        const r = await savedSpeed;
        if (alive && typeof r === 'number' && r >= 0.5 && r <= 3) {
          rateRef.current = r;
          setRateState(r);
        }
      };
      if (isSpoken) {
        api
          .item(current.id)
          .then((full) => alive && setChapters(full.chapters ?? []))
          .catch(() => undefined);
      }
      const client = castClientRef.current;
      if (castOn && client) {
        // Play on the Chromecast: ask the server for something the receiver can decode.
        loadPaused.current = false;
        try {
          player.pause();
        } catch {
          /* nothing loaded yet */
        }
        try {
          const info = await api.playback(current.id, { deviceProfile: castDeviceProfile('audio'), startMs: startMs > 0 ? Math.round(startMs) : undefined });
          await applySavedSpeed();
          if (!alive) return;
          session.current = info;
          const from = info.startMs || startMs;
          const mediaInfo = castMediaInfo(api, info, { audio: true, title: current.title, subtitle: current.grandparentTitle ?? current.parentTitle, posterPath: current.posterUrl ?? current.thumbUrl });
          castUrl.current = mediaInfo.contentUrl;
          await client.loadMedia({ mediaInfo, autoplay: true, startTime: from > 1000 ? from / 1000 : 0, playbackRate: isSpoken ? rateRef.current : 1 });
        } catch (e) {
          if (alive) setError(e instanceof Error ? e.message : 'Could not cast this item');
        }
        return;
      }
      let uri: string;
      if (local?.state === 'done' && local.fileUri) {
        uri = local.fileUri;
      } else {
        try {
          const info = await api.playback(current.id, { deviceProfile: audioDeviceProfile(), startMs: startMs > 0 ? Math.round(startMs) : undefined });
          if (!alive) return;
          session.current = info;
          if (isSpoken && info.startMs) startMs = info.startMs;
          uri = api.absolute(info.url);
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Playback failed');
          return;
        }
      }
      await applySavedSpeed();
      if (!alive) return;
      player.replace({ uri, headers: api.headers(false) });
      try {
        player.volume = volumeRef.current * gainRef.current;
      } catch {
        /* ignore */
      }
      pendingSeek.current = startMs > 1000 ? startMs : null;
      try {
        player.setPlaybackRate(isSpoken ? rateRef.current : 1);
      } catch {
        /* ignore */
      }
      if (loadPaused.current) loadPaused.current = false;
      else player.play();
      const artwork = api.image(current.posterUrl ?? current.thumbUrl, 600) ?? undefined;
      const meta = { title: current.title, artist: current.grandparentTitle ?? current.parentTitle ?? undefined, albumTitle: current.parentTitle ?? undefined, artworkUrl: artwork };
      // Same ±15/30 s as the now-playing screen (also used by CarPlay / Android Auto). Long music
      // tracks add them on Android; see lockScreenOptions for why iOS keeps next/previous only.
      const options = lockScreenOptions(transportMode(isSpoken, dur || null), Platform.OS, queue.length);
      lockScreen.current = { itemId: current.id, meta, options };
      try {
        player.setActiveForLockScreen(true, meta, options);
        // iOS: route next/previous track (lock screen, CarPlay) to this queue; see src/car/remote.ts.
        syncCarRemoteCommands(!isSpoken);
      } catch {
        /* not supported on this platform */
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, api, player, downloads, report, castOn, reloadTick]);

  // Apply the resume position once the new source is ready.
  useEffect(() => {
    if (!status.isLoaded || pendingSeek.current == null) return;
    const ms = pendingSeek.current;
    pendingSeek.current = null;
    void player.seekTo(ms / 1000);
  }, [status.isLoaded, player]);

  // Progress every 10s (from the receiver's position while casting).
  const playing = castOn ? castPlaying : status.playing;
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => report('playing'), 10000);
    return () => clearInterval(timer);
  }, [playing, report]);

  // Long-track buttons depend on the duration. When the item had none in its metadata, the player
  // reports it once loaded: set the lock screen up again if that changes its buttons.
  const durationMs = castOn
    ? Math.round((ours && cast.mediaStatus?.mediaInfo?.streamDuration ? cast.mediaStatus.mediaInfo.streamDuration * 1000 : 0) || (current?.durationMs ?? 0))
    : Math.round((status.duration || (current?.durationMs ?? 0) / 1000) * 1000);
  const mode = transportMode(spoken, durationMs);
  useEffect(() => {
    const applied = lockScreen.current;
    const cur = currentRef.current;
    if (!applied || !cur || applied.itemId !== cur.id || loadedId.current !== cur.id || castModeRef.current) return;
    const options = lockScreenOptions(transportMode(spokenRef.current, durationMs), Platform.OS, queue.length);
    if (JSON.stringify(options) === JSON.stringify(applied.options)) return;
    lockScreen.current = { ...applied, options };
    try {
      player.setActiveForLockScreen(true, applied.meta, options);
      syncCarRemoteCommands(!spokenRef.current);
    } catch {
      /* not supported on this platform */
    }
  }, [mode.longTrack, player]); // eslint-disable-line react-hooks/exhaustive-deps

  const advance = useCallback(
    (dir: 1 | -1, auto = false) => {
      if (!queue.length) return;
      if (auto && repeat === 'one') {
        if (castModeRef.current) {
          // The receiver is idle after finishing: load the item again.
          loadedId.current = null;
          setReloadTick((n) => n + 1);
          return;
        }
        void player.seekTo(0);
        player.play();
        return;
      }
      let ni = index + dir;
      if (ni >= queue.length) {
        if (repeat === 'all' || !auto) ni = 0;
        else {
          report('stopped');
          session.current = null;
          return;
        }
      }
      if (ni < 0) ni = queue.length - 1;
      loadedId.current = null;
      setIndex(ni);
    },
    [queue.length, index, repeat, player, report],
  );

  // Track finished.
  const finishedRef = useRef(false);
  useEffect(() => {
    if (status.didJustFinish && !finishedRef.current) {
      finishedRef.current = true;
      report('stopped');
      session.current = null;
      if (sleepRef.current?.mode === 'part') {
        // Sleep timer "end of part": move on, but load the next part paused.
        loadPaused.current = true;
        setSleepState(null);
      }
      advance(1, true);
    } else if (!status.didJustFinish) finishedRef.current = false;
  }, [status.didJustFinish, advance, report]);

  // Track finished on the Chromecast.
  const castEndedFor = useRef<string | null>(null);
  useEffect(() => {
    const st = cast.mediaStatus;
    const s = session.current;
    if (!castOn || !ours || !s || st?.playerState !== 'idle' || st.idleReason !== 'finished') return;
    if (castEndedFor.current === s.sessionId) return;
    castEndedFor.current = s.sessionId;
    report('stopped');
    session.current = null;
    advance(1, true);
  }, [cast.mediaStatus, castOn, ours, report, advance]);

  /** Seek on whichever player is active (ms). */
  const seekAny = useCallback(
    (ms: number) => {
      const client = castClientRef.current;
      if (castModeRef.current && client) void client.seek({ position: Math.max(0, ms / 1000) }).catch(() => undefined);
      else void player.seekTo(Math.max(0, ms / 1000));
    },
    [player],
  );

  /** Pause whichever player is active. */
  const pauseAny = useCallback(() => {
    const client = castClientRef.current;
    if (castModeRef.current && client) {
      if (castPlayingRef.current) {
        void client.pause().catch(() => undefined);
        report('paused');
      }
      return;
    }
    if (player.playing) {
      player.pause();
      report('paused');
    }
  }, [player, report]);

  // ----- Sleep timer -----
  const setSleep = useCallback(
    (opt: SleepOption | null) => {
      try {
        if (!castModeRef.current) player.volume = volumeRef.current * gainRef.current;
      } catch {
        /* ignore */
      }
      if (!opt) {
        setSleepState(null);
        setSleepRemaining(null);
        return;
      }
      if (opt === 'chapter') {
        const cur = currentRef.current;
        if (!cur) return;
        const pos = castModeRef.current ? castPosRef.current : player.currentTime * 1000;
        const nextStart = chaptersRef.current.find((c) => c.startMs > pos + 500)?.startMs;
        setSleepState(nextStart != null ? { mode: 'chapter', itemId: cur.id, endMs: nextStart } : { mode: 'part', itemId: cur.id });
        return;
      }
      setSleepState({ mode: 'time', minutes: opt.minutes, endsAt: Date.now() + opt.minutes * 60000 });
    },
    [player],
  );

  useEffect(() => {
    if (!sleep) return;
    const fire = () => {
      setSleepState(null);
      setSleepRemaining(null);
      pauseAny();
      setTimeout(() => {
        try {
          player.volume = volumeRef.current * gainRef.current;
        } catch {
          /* ignore */
        }
      }, 300);
    };
    const tick = () => {
      const remote = castModeRef.current;
      const pos = remote ? castPosRef.current : player.currentTime * 1000;
      const isPlaying = remote ? castPlayingRef.current : player.playing;
      const cur = currentRef.current;
      let remaining: number;
      if (sleep.mode === 'time') remaining = sleep.endsAt - Date.now();
      else {
        if (!cur) {
          setSleepState(null);
          setSleepRemaining(null);
          return;
        }
        // The chapter/part we were waiting for has ended and the queue moved on.
        if (cur.id !== sleep.itemId) return fire();
        const endMs = sleep.mode === 'chapter' ? sleep.endMs : (remote ? cur.durationMs ?? 0 : player.duration * 1000) || (cur.durationMs ?? 0);
        remaining = endMs > 0 ? (endMs - pos) / (spokenRef.current ? rateRef.current : 1) : NaN;
      }
      setSleepRemaining(Number.isFinite(remaining) ? Math.max(0, Math.ceil(remaining / 1000) * 1000) : null);
      if (sleep.mode !== 'time' && !isPlaying) return;
      if (remaining <= 0 && sleep.mode !== 'part') return fire();
      // Fade out over the last few seconds (local playback; "end of part" is handled when the track finishes).
      if (!remote && isPlaying && sleep.mode !== 'part' && Number.isFinite(remaining)) {
        try {
          player.volume = volumeRef.current * gainRef.current * Math.max(0, Math.min(1, remaining / SLEEP_FADE_MS));
        } catch {
          /* ignore */
        }
      }
    };
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [sleep, player, pauseAny]);

  const playQueue = useCallback((items: Item[], startIndex = 0, opts: { shuffle?: boolean; startMs?: number } = {}) => {
    const wanted = items[startIndex];
    const tracks = items.filter((i) => isAudioItem(i.type));
    if (!tracks.length) return;
    let list = tracks;
    let start = Math.max(0, wanted ? tracks.indexOf(wanted) : Math.min(startIndex, tracks.length - 1));
    if (opts.startMs != null && tracks[start]) startOverride.current = { id: tracks[start].id, ms: opts.startMs };
    if (opts.shuffle) {
      const first = tracks[start];
      list = [first, ...shuffled(tracks.filter((t) => t.id !== first.id))];
      start = 0;
      setShuffleState(true);
    }
    loadedId.current = null;
    setQueue(list);
    setIndex(start);
  }, []);

  const value = useMemo<MusicValue>(
    () => ({
      queue,
      index,
      current,
      playing,
      buffering: castOn ? castState === 'buffering' || castState === 'loading' : status.isBuffering,
      positionMs: castOn ? (ours ? cast.positionMs : 0) : Math.round((status.currentTime ?? 0) * 1000),
      durationMs,
      shuffle,
      repeat,
      error,
      spoken,
      longTrack: mode.longTrack,
      rate,
      setRate: (r) => {
        setRateState(r);
        const cur = currentRef.current;
        if (cur && spokenRef.current) void setJSON(speedKey(cur), r).catch(() => undefined);
        try {
          if (spokenRef.current && castModeRef.current) void castClientRef.current?.setPlaybackRate(r).catch(() => undefined);
          else if (spokenRef.current) player.setPlaybackRate(r);
        } catch {
          /* ignore */
        }
      },
      chapters,
      skip: (deltaMs) => {
        if (castModeRef.current) return seekAny(castPosRef.current + deltaMs);
        const d = player.duration > 0 ? player.duration : Infinity;
        void player.seekTo(Math.max(0, Math.min(d - 1, player.currentTime + deltaMs / 1000)));
      },
      playQueue,
      enqueue: (items) => setQueue((q) => [...q, ...items.filter((i) => isAudioItem(i.type))]),
      playNextInQueue: (item) => setQueue((q) => [...q.slice(0, index + 1), item, ...q.slice(index + 1)]),
      toggle: () => {
        const client = castClientRef.current;
        if (castModeRef.current && client) {
          if (!oursRef.current) {
            // Something else took over the receiver (e.g. a video was cast): load our item again.
            loadedId.current = null;
            setReloadTick((n) => n + 1);
          } else if (castPlayingRef.current) {
            void client.pause().catch(() => undefined);
            report('paused');
          } else void client.play().catch(() => undefined);
          return;
        }
        if (player.playing) {
          player.pause();
          report('paused');
        } else player.play();
      },
      pause: pauseAny,
      next: () => advance(1),
      previous: () => {
        if ((castModeRef.current ? castPosRef.current / 1000 : player.currentTime) > 4) seekAny(0);
        else advance(-1);
      },
      seek: seekAny,
      jumpTo: (i, startMs) => {
        const target = queue[i];
        if (target && startMs != null) startOverride.current = { id: target.id, ms: startMs };
        loadedId.current = null;
        setIndex(i);
        // Same entry: the load effect would not re-run, so reload it.
        if (i === index) setReloadTick((n) => n + 1);
      },
      stop: () => {
        if (castModeRef.current) void castClientRef.current?.stop().catch(() => undefined);
        player.pause();
        report('stopped');
        session.current = null;
        try {
          player.clearLockScreenControls();
        } catch {
          /* ignore */
        }
        syncCarRemoteCommands(false);
        lockScreen.current = null;
        setSleepState(null);
        setSleepRemaining(null);
        loadedId.current = null;
        setQueue([]);
        setIndex(0);
      },
      setShuffle: (v) => {
        setShuffleState(v);
        if (v && queue.length > 1) {
          const cur = queue[index];
          setQueue([cur, ...shuffled(queue.filter((_, i) => i !== index))]);
          setIndex(0);
          loadedId.current = cur.id;
        }
      },
      cycleRepeat: () => setRepeat((r) => (r === 'off' ? 'all' : r === 'all' ? 'one' : 'off')),
      castingTo: castOn ? cast.deviceName ?? 'Chromecast' : null,
      volume,
      setVolume: (v) => {
        const vol = Math.max(0, Math.min(1, v));
        setVolumeState(vol);
        volumeRef.current = vol;
        try {
          if (castModeRef.current) void castClientRef.current?.setStreamVolume(vol).catch(() => undefined);
          else player.volume = vol * gainRef.current;
        } catch {
          /* ignore */
        }
      },
      sleep,
      sleepRemainingMs,
      setSleep,
    }),
    [queue, index, current, status, durationMs, mode.longTrack, shuffle, repeat, error, spoken, rate, chapters, playQueue, player, report, advance, playing, castOn, castState, ours, cast.positionMs, cast.mediaStatus, cast.deviceName, seekAny, pauseAny, volume, sleep, sleepRemainingMs, setSleep],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMusic(): MusicValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMusic outside MusicProvider');
  return v;
}
