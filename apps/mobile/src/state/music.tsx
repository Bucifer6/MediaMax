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
 *
 * Automix (the "lite DJ", src/player/automix.ts): music plays on two expo-audio
 * players. The "live" one is the current track (status, lock screen, progress
 * reports); the "standby" one prepares the next track at its mix-in point about
 * 15 s before the planned mix-out (POST /dj/transitions, else the local
 * planner). At the mix-out point the standby player starts and both volumes
 * follow the transition's shape; when it ends the players swap roles and the
 * lock screen moves to the new live player. Gapless album joins never blend:
 * the next track waits on the standby player and takes over when the current
 * one ends. A pause, seek or track change during a blend cuts it (the current
 * track stays at full level); skipping completes it. The blend is stepped by a
 * 50 ms timer and by every player status update, because Android pauses JS
 * timers while the app is in the background (native status events still
 * arrive, as they do for the normal end-of-track advance). "Mix" (playAsMix)
 * plays a source as a continuous mix, smart-ordered via POST /dj/order for big
 * sources and kept going by POST /dj/mix without a prompt (Endless). Only the
 * Vibe server is contacted.
 */
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus, type AudioPlayer } from 'expo-audio';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { audioDeviceProfile, castDeviceProfile } from '@/api/profiles';
import { getJSON, setJSON } from '@/api/storage';
import { lockScreenOptions, transportMode, type LockScreenOptions } from '@/car/policy';
import { syncCarRemoteCommands } from '@/car/remote';
import { castMediaInfo, isOurMedia, useCast } from '@/cast';
import type { Chapter, DjOrderRequest, DjOrderSource, DjTransition, DjTransitionPreference, Item, PlaybackInfo, TrackAnalysis, UserPreferences } from '@/api/types';
import {
  AUTOMIX_DEFAULT, AUTOMIX_MAX_STRETCH, automixAction, automixApplies, BlendRunner, glideMs, glideRate, isGaplessJoin, nextQueueIndex, pausedFromOutside,
  planAutomix, prepareBlend, sanitizePlan, type MixDeck,
} from '@/player/automix';
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
/** Automix scheduler / blend step (foreground; player status updates drive it in the background). */
const AUTOMIX_TICK_MS = 50;
/** "Mixing into …" progress refresh. */
const BLEND_PUBLISH_MS = 250;
/** Mix: page size for big sources (a whole library streams in batches). */
const MIX_PAGE = 50;
/** Mix: fetch more when fewer than this many tracks are left after the current one. */
const MIX_LOW_WATER = 5;

/** What "Mix" plays. */
export interface MixSource {
  /** Shown as "Mix · <label>". */
  label: string;
  /** Tracks in their own order (album, playlist). */
  items?: Item[];
  start?: number;
  /** Smart order (tempo, key, energy flow) from the server: a library, genre or artist, paged in batches. */
  source?: DjOrderSource;
  /** Put `items` in smart order instead of their own. */
  smart?: boolean;
}

/** A running Automix blend, for Now Playing and the mini player ("Mixing into …"). */
export interface BlendView {
  into: Item;
  /** "Crossfade", "Beat-matched blend"… */
  label: string;
  /** 0–1. */
  progress: number;
}

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
  /** Karaoke: server path the current track plays from instead of its own stream (the stems mix), or null. */
  altSource: string | null;
  /** Switch the current track to / from an alternative source at the same position. */
  setAltSource: (path: string | null) => void;
  /** Automix (lite DJ) is on: music tracks blend like one continuous mix. The preference, or forced on by a Mix. */
  automix: boolean;
  /** Turn Automix on/off (saved as the `automix` preference, like the web app; off also ends a Mix). */
  setAutomix: (on: boolean) => void;
  /** Automix transition feel (saved as `automixStyle`). */
  mixStyle: DjTransitionPreference;
  setMixStyle: (s: DjTransitionPreference) => void;
  /** The Mix that is playing, if any. */
  mix: { label: string } | null;
  /** Play a music source as a continuous mix (Automix on, Endless on). False when there was nothing to play. */
  playAsMix: (source: MixSource) => Promise<boolean>;
  /** Endless: when a Mix runs out, keep going with similar tracks from the library (server only, no AI). */
  endless: boolean;
  setEndless: (on: boolean) => void;
  /** The running blend, null between transitions. */
  blend: BlendView | null;
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

/** ReplayGain factor for `item`: lower loud tracks to a common loudness (local playback only; never amplifies past 1×). */
function replayGainFor(item: Item | null | undefined, queue: Item[], shuffle: boolean, rgMode: NonNullable<UserPreferences['replayGain']>): number {
  const rg = item?.type === 'track' ? item.replayGain : null;
  if (!rg || rgMode === 'off') return 1;
  const albumInOrder = queue.length > 1 && !shuffle && queue.every((q) => q.parentId === item?.parentId);
  const db = rgMode === 'album' || (rgMode === 'auto' && albumInOrder) ? rg.albumGainDb ?? rg.trackGainDb : rg.trackGainDb ?? rg.albumGainDb;
  if (db == null) return 1;
  const peak = (rgMode === 'album' || albumInOrder ? rg.albumPeak : rg.trackPeak) ?? null;
  let f = Math.pow(10, db / 20);
  if (peak && peak > 0) f = Math.min(f, 1 / peak); // avoid clipping
  return Math.max(0.05, Math.min(1, f));
}

/** A player as the blend runner drives it. */
function deckOf(p: AudioPlayer): MixDeck {
  return {
    setVolume: (v) => {
      try {
        p.volume = Math.max(0, Math.min(1, v));
      } catch {
        /* not ready */
      }
    },
    setRate: (r) => {
      try {
        // 'high' = spectral pitch correction on iOS; Android keeps the pitch while shouldCorrectPitch is set.
        p.setPlaybackRate(r, 'high');
      } catch {
        /* ignore */
      }
    },
    play: () => {
      try {
        p.play();
      } catch {
        /* ignore */
      }
    },
    pause: () => {
      try {
        p.pause();
      } catch {
        /* ignore */
      }
    },
  };
}

/** The standby player: the next track, being prepared or ready (cued at `startMs`). */
interface Standby {
  itemId: string | null;
  startMs: number;
  state: 'none' | 'loading' | 'ready' | 'failed';
  token: number;
  session: PlaybackInfo | null;
  /** Source replaced, waiting for it to load (then seek to startMs). */
  awaiting: boolean;
  replacedAt: number;
}

interface RunningBlend {
  runner: BlendRunner;
  into: Item;
  phaseChecked: boolean;
  /** When the outgoing player was first seen stopped (outside-pause detection). */
  stoppedSince: number | null;
  lastPublish: number;
}

export function MusicProvider({ children }: { children: React.ReactNode }) {
  const { api, user, updatePreferences } = useSession();
  const apiRef = useRef(api);
  apiRef.current = api;
  const downloads = useDownloads();
  // Read through a ref: the downloads value changes every progress tick, which would otherwise
  // re-run (and cancel) the track load and reset the progress timer.
  const downloadsRef = useRef(downloads);
  downloadsRef.current = downloads;
  // Two players for Automix: `live` is the current track's; the other one is the standby (next track).
  const playerA = useAudioPlayer(null, { updateInterval: 250 });
  const playerB = useAudioPlayer(null, { updateInterval: 250 });
  const statusA = useAudioPlayerStatus(playerA);
  const statusB = useAudioPlayerStatus(playerB);
  const [live, setLive] = useState<0 | 1>(0);
  const liveRef = useRef<0 | 1>(0);
  const playersRef = useRef<[AudioPlayer, AudioPlayer]>([playerA, playerB]);
  playersRef.current = [playerA, playerB];
  const status = live === 0 ? statusA : statusB;
  /** The current track's player (always read through this: it changes when a blend completes). */
  const livePlayer = useCallback(() => playersRef.current[liveRef.current], []);
  const standbyPlayer = useCallback(() => playersRef.current[liveRef.current === 0 ? 1 : 0], []);
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
  /** Sleep-timer fade factor (0–1) on top of the volume; a running blend applies it to both players. */
  const sleepFactorRef = useRef(1);
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

  // ----- Automix preferences and Mix sessions -----
  const automixPref = user?.preferences.automix ?? AUTOMIX_DEFAULT;
  const mixStyle: DjTransitionPreference = user?.preferences.automixStyle ?? 'auto';
  const [mixSession, setMixSession] = useState<{ label: string } | null>(null);
  const automixOn = !!mixSession || automixPref;
  const [endless, setEndless] = useState(true);
  const [blend, setBlend] = useState<BlendView | null>(null);

  const rgMode = user?.preferences.replayGain ?? 'auto';
  const gain = useMemo(() => replayGainFor(current, queue, shuffle, rgMode), [current, queue, shuffle, rgMode]);
  const gainRef = useRef(gain);
  gainRef.current = gain;

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
  /** Karaoke mix for the current track (kept only while that track plays). */
  const altRef = useRef<{ itemId: string; path: string } | null>(null);
  const [altSource, setAltSourceState] = useState<string | null>(null);

  /** Automix runs on the phone's own players (not while casting). */
  const automixLocal = automixOn && !castOn;
  const stRef = useRef({ queue, index, repeat, shuffle, mixStyle, rgMode, automixLocal });
  stRef.current = { queue, index, repeat, shuffle, mixStyle, rgMode, automixLocal };

  const blendRef = useRef<RunningBlend | null>(null);
  const sbRef = useRef<Standby>({ itemId: null, startMs: 0, state: 'none', token: 0, session: null, awaiting: false, replacedAt: 0 });
  /** One-shot timer that starts a blend exactly on its mix-out point. */
  const armRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The live player's playback rate (music): 1, or a tempo match gliding back to 1 after a blend. */
  const liveRateRef = useRef(1);
  const glideRef = useRef<{ from: number; t0: number; ms: number } | null>(null);

  useEffect(() => {
    if (castModeRef.current || sleepRef.current || blendRef.current) return; // the sleep fade / a blend owns the volume while it runs
    try {
      livePlayer().volume = volumeRef.current * gain;
    } catch {
      /* player not ready */
    }
  }, [gain, livePlayer]);

  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix' }).catch(() => undefined);
  }, []);

  const report = useCallback(
    (state: 'playing' | 'paused' | 'stopped') => {
      const s = session.current;
      const remote = castModeRef.current;
      const p = livePlayer();
      const positionMs = remote ? castPosRef.current : Math.round(p.currentTime * 1000);
      const durationMs = remote ? currentRef.current?.durationMs ?? undefined : Math.round(p.duration * 1000) || undefined;
      // Offline spoken audio: keep the resume position locally, like offline video.
      const cur = currentRef.current;
      if (!s && cur && spokenRef.current && positionMs > 0) downloadsRef.current.updateLocalPosition(cur.id, positionMs);
      if (!api || !s) return;
      const body = { positionMs, durationMs, state, sessionId: s.sessionId };
      api.sessionProgress(s.sessionId, body).catch(() => undefined);
      if (state === 'stopped') api.stopSession(s.sessionId).catch(() => undefined);
    },
    [api, livePlayer],
  );

  /** Set up the lock screen / control centre (and CarPlay's next/previous) for `item` on player `p`. */
  const applyLockScreen = useCallback((p: AudioPlayer, item: Item, queueLength: number) => {
    const a = apiRef.current;
    if (!a) return;
    const isSpoken = isSpokenAudio(item.type);
    const artwork = a.image(item.posterUrl ?? item.thumbUrl, 600) ?? undefined;
    const meta = { title: item.title, artist: item.grandparentTitle ?? item.parentTitle ?? undefined, albumTitle: item.parentTitle ?? undefined, artworkUrl: artwork };
    // Same ±15/30 s as the now-playing screen (also used by CarPlay / Android Auto). Long music
    // tracks add them on Android; see lockScreenOptions for why iOS keeps next/previous only.
    const options = lockScreenOptions(transportMode(isSpoken, item.durationMs || null), Platform.OS, queueLength);
    lockScreen.current = { itemId: item.id, meta, options };
    try {
      // Moving it to another player hands the lock screen over (expo-audio keeps one active player; the
      // previous one is released by the native side, so it is not cleared here: that would clear the new one on iOS).
      p.setActiveForLockScreen(true, meta, options);
      // iOS: route next/previous track (lock screen, CarPlay) to this queue; see src/car/remote.ts.
      syncCarRemoteCommands(!isSpoken);
    } catch {
      /* not supported on this platform */
    }
  }, []);

  /* ---------------- Automix: standby player, blends ---------------- */

  const clearArm = () => {
    if (armRef.current) clearTimeout(armRef.current);
    armRef.current = null;
  };

  /** Drop whatever the standby player holds (stops its server session). Never during a blend (it is the incoming track). */
  const releaseStandby = useCallback(() => {
    clearArm();
    const sb = sbRef.current;
    sb.token++;
    if (sb.session) apiRef.current?.stopSession(sb.session.sessionId).catch(() => undefined);
    const had = sb.itemId != null;
    sb.session = null;
    sb.itemId = null;
    sb.state = 'none';
    sb.awaiting = false;
    if (had) {
      const p = standbyPlayer();
      try {
        p.pause();
        p.volume = 0;
      } catch {
        /* ignore */
      }
    }
  }, [standbyPlayer]);

  /** Prepare `item` on the standby player, paused and silent, cued at `startMs` (its mix-in point). */
  const preloadStandby = useCallback(
    (item: Item, startMs: number) => {
      const a = apiRef.current;
      if (!a) return;
      releaseStandby();
      const sb = sbRef.current;
      const token = ++sb.token;
      sb.itemId = item.id;
      sb.startMs = startMs;
      sb.state = 'loading';
      const p = standbyPlayer();
      void (async () => {
        let uri: string;
        let headers: Record<string, string> | undefined;
        const local = downloadsRef.current.get(item.id);
        if (local?.state === 'done' && local.fileUri) uri = local.fileUri;
        else {
          try {
            // Full timeline (no startMs): positions stay the track's own, the player seeks to the mix-in point.
            const info = await a.playback(item.id, { deviceProfile: audioDeviceProfile() });
            if (token !== sb.token) {
              a.stopSession(info.sessionId).catch(() => undefined);
              return;
            }
            sb.session = info;
            uri = a.absolute(info.url);
            headers = a.headers(false);
          } catch {
            // Plays normally once the current track ends (the regular load retries it).
            if (token === sb.token) sb.state = 'failed';
            return;
          }
        }
        if (token !== sb.token) return;
        try {
          p.pause();
          p.volume = 0;
          p.replace(headers ? { uri, headers } : { uri });
          p.shouldCorrectPitch = true;
          p.setPlaybackRate(1);
        } catch {
          /* ignore */
        }
        sb.awaiting = true;
        sb.replacedAt = Date.now();
      })();
    },
    [releaseStandby, standbyPlayer],
  );

  const stopGlide = () => {
    glideRef.current = null;
  };

  /**
   * The standby player becomes the live one, playing `into` (after a blend or a gapless join): server sessions,
   * queue position, lock screen and progress move over; a tempo-matched track glides back to its own tempo.
   */
  const swapToStandby = useCallback(
    (into: Item, rateNow: number, tr: DjTransition | null) => {
      const st = stRef.current;
      let n = st.queue.findIndex((q, i) => i > st.index && q.id === into.id);
      if (n < 0) n = st.queue.findIndex((q) => q.id === into.id);
      if (n < 0) {
        // Removed from the queue while it was mixing in: keep it, right after the current track.
        n = st.index + 1;
        setQueue((q) => [...q.slice(0, st.index + 1), into, ...q.slice(st.index + 1)]);
      }
      report('stopped');
      clearArm();
      const sb = sbRef.current;
      session.current = sb.session;
      sb.session = null;
      sb.itemId = null;
      sb.state = 'none';
      sb.awaiting = false;
      sb.token++;
      const next: 0 | 1 = liveRef.current === 0 ? 1 : 0;
      liveRef.current = next;
      setLive(next);
      liveRateRef.current = rateNow;
      if (altRef.current) {
        altRef.current = null;
        setAltSourceState(null);
      }
      pendingSeek.current = null;
      loadedId.current = into.id;
      setError(null);
      setChapters([]);
      setIndex(n);
      applyLockScreen(livePlayer(), into, st.queue.length);
      stopGlide();
      if (Math.abs(rateNow - 1) > 0.002) {
        // Back to its own tempo over 16 bars (its bpm = the outgoing beat's bpm / the ratio).
        const bpmIn = tr?.beatMs ? 60000 / tr.beatMs / (tr.tempoRatio || 1) : null;
        glideRef.current = { from: rateNow, t0: Date.now(), ms: glideMs(16, bpmIn, rateNow) };
      }
      report('playing');
    },
    [report, applyLockScreen, livePlayer],
  );

  /** Cut a running blend (pause, seek, track change): the current track stays at full level, the incoming one is dropped. */
  const abortBlend = useCallback(() => {
    clearArm();
    const b = blendRef.current;
    if (!b) return false;
    blendRef.current = null;
    setBlend(null);
    b.runner.cut();
    releaseStandby();
    return true;
  }, [releaseStandby]);

  /** Finish a running blend now (it ran its course, the outgoing track ended, or the listener skipped). */
  const completeBlend = useCallback(() => {
    const b = blendRef.current;
    if (!b) return false;
    blendRef.current = null;
    setBlend(null);
    b.runner.complete();
    swapToStandby(b.into, b.runner.plan.inRate, b.runner.plan.tr);
    return true;
  }, [swapToStandby]);

  /** The current track ended and the next one is ready on the standby player (gapless join, or a blend that never started). */
  const swapAtEnd = useCallback(() => {
    const st = stRef.current;
    if (!st.automixLocal || st.repeat === 'one') return false;
    const n = nextQueueIndex(st.queue.length, st.index, st.repeat);
    const into = n >= 0 ? st.queue[n] : null;
    const sb = sbRef.current;
    if (!into || sb.state !== 'ready' || sb.itemId !== into.id) return false;
    const p = standbyPlayer();
    try {
      p.volume = volumeRef.current * replayGainFor(into, st.queue, st.shuffle, st.rgMode) * sleepFactorRef.current;
      p.setPlaybackRate(1);
      p.play();
    } catch {
      return false;
    }
    swapToStandby(into, 1, null);
    return true;
  }, [standbyPlayer, swapToStandby]);

  /* ---------------- Automix: plans ---------------- */
  /** Track analysis per item (the server's own API; analysed on demand there). */
  const analysesRef = useRef(new Map<string, Promise<TrackAnalysis | null>>());
  const analysisFor = useCallback((id: string) => {
    const m = analysesRef.current;
    let p = m.get(id);
    if (!p) {
      const a = apiRef.current;
      p = a ? a.trackAnalysis(id).catch(() => null) : Promise.resolve(null);
      m.set(id, p);
      if (m.size > 500) m.delete(m.keys().next().value!);
    }
    return p;
  }, []);
  const seedAnalyses = useCallback((list: Record<string, TrackAnalysis | null> | { item: Item; analysis: TrackAnalysis | null }[]) => {
    const m = analysesRef.current;
    const entries = Array.isArray(list) ? list.map((t) => [t.item.id, t.analysis] as const) : Object.entries(list);
    for (const [id, a] of entries) if (a) m.set(id, Promise.resolve(a));
  }, []);
  /** The plan for the move from the current track to the next: tr = null means a gapless join. */
  const planRef = useRef<{ key: string; ready: boolean; tr: DjTransition | null } | null>(null);
  const serverPlansRef = useRef(true);
  const planKey = (a: Item, b: Item) => `${a.id}>${b.id}>${stRef.current.mixStyle}>${stRef.current.shuffle ? 1 : 0}`;
  const nextIdx = nextQueueIndex(queue.length, index, repeat);
  const nextItem = nextIdx >= 0 ? queue[nextIdx] ?? null : null;
  useEffect(() => {
    const a = current;
    const b = nextItem;
    if (!automixLocal || !api || !a || !b || a.id === b.id || !automixApplies(a, b) || repeat === 'one') {
      planRef.current = null;
      return;
    }
    const key = planKey(a, b);
    if (planRef.current?.key === key) return;
    planRef.current = { key, ready: false, tr: null };
    const style = mixStyle;
    void (async () => {
      const [aa, ab] = await Promise.all([analysisFor(a.id), analysisFor(b.id)]);
      let tr: DjTransition | null = null;
      if (!isGaplessJoin(a, b, aa, ab, shuffle)) {
        // The server's planner (same per-pair logic as advanced DJ mixes); the local one if that isn't available.
        if (serverPlansRef.current) {
          tr = await api
            .djTransitions({ pairs: [{ from: a.id, to: b.id }], transitions: style, maxStretchPct: AUTOMIX_MAX_STRETCH * 100 })
            .then((r) => r.transitions[0] ?? null)
            .catch((e: { status?: number }) => {
              if (e?.status === 404) serverPlansRef.current = false;
              return null;
            });
        }
        tr = sanitizePlan(tr ?? planAutomix(a, aa, b, ab, style), a, aa, b, ab, style);
      }
      if (planRef.current?.key === key) planRef.current = { key, ready: true, tr };
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, nextItem?.id, automixLocal, mixStyle, shuffle, repeat, api]);

  /** Start the planned blend into the prepared standby player. */
  const startBlend = useCallback(
    (tr: DjTransition) => {
      clearArm();
      const st = stRef.current;
      const n = nextQueueIndex(st.queue.length, st.index, st.repeat);
      const into = n >= 0 ? st.queue[n] : null;
      const sb = sbRef.current;
      if (blendRef.current || !into || sb.state !== 'ready' || sb.itemId !== into.id) return false;
      const out = livePlayer();
      const inc = standbyPlayer();
      let posMs = 0;
      let durMs = 0;
      try {
        if (!out.playing) return false;
        posMs = out.currentTime * 1000;
        durMs = out.duration * 1000 || (currentRef.current?.durationMs ?? 0);
      } catch {
        return false;
      }
      stopGlide();
      const plan = prepareBlend(tr, { posMs, durMs, rate: liveRateRef.current });
      try {
        // Exactly on the planned mix-in (plus however late the start is, so the beats still meet).
        if (Math.abs(inc.currentTime * 1000 - plan.startInMs) > 60) void inc.seekTo(plan.startInMs / 1000).catch(() => undefined);
      } catch {
        /* ignore */
      }
      const intoGain = replayGainFor(into, st.queue, st.shuffle, st.rgMode);
      const runner = new BlendRunner(plan, deckOf(out), deckOf(inc), {
        now: Date.now,
        levels: () => ({ out: volumeRef.current * gainRef.current * sleepFactorRef.current, inc: volumeRef.current * intoGain * sleepFactorRef.current }),
      });
      blendRef.current = { runner, into, phaseChecked: false, stoppedSince: null, lastPublish: Date.now() };
      runner.start();
      setBlend({ into, label: plan.label, progress: 0 });
      return true;
    },
    [livePlayer, standbyPlayer],
  );

  /** The current plan, when it is for the current → next pair (undefined while it is being made). */
  const planNow = (): DjTransition | null | undefined => {
    const st = stRef.current;
    const a = st.queue[st.index];
    const n = nextQueueIndex(st.queue.length, st.index, st.repeat);
    const b = n >= 0 ? st.queue[n] : undefined;
    const p = planRef.current;
    if (!a || !b || p?.key !== planKey(a, b) || !p.ready) return undefined;
    return p.tr;
  };

  /**
   * One scheduler / blend step: finish loading the standby, run the blend (and notice an outside pause), glide
   * a tempo-matched track home, then preload / arm / start the next blend. Idempotent; reads only refs.
   */
  const drive = () => {
    const now = Date.now();
    const sb = sbRef.current;
    const st = stRef.current;
    if (castModeRef.current) return;

    // 1. The standby source loaded: cue it at its mix-in point.
    if (sb.awaiting && now - sb.replacedAt >= 250) {
      const p = standbyPlayer();
      let loaded = false;
      try {
        loaded = p.isLoaded;
      } catch {
        /* ignore */
      }
      if (loaded) {
        sb.awaiting = false;
        const tok = sb.token;
        const done = () => {
          if (tok === sb.token && sb.state === 'loading') sb.state = 'ready';
        };
        if (sb.startMs > 20) void p.seekTo(sb.startMs / 1000).catch(() => undefined).finally(done);
        else done();
      }
    }

    const out = livePlayer();
    let playing = false;
    let buffering = false;
    let posMs = 0;
    let durMs = 0;
    try {
      playing = out.playing;
      buffering = out.isBuffering;
      posMs = out.currentTime * 1000;
      durMs = out.duration * 1000 || 0;
    } catch {
      return;
    }

    // 2. A running blend.
    const b = blendRef.current;
    if (b) {
      if (!playing && !buffering) b.stoppedSince ??= now;
      else b.stoppedSince = null;
      if (!playing && durMs > 0 && posMs >= durMs - 500) {
        completeBlend(); // the outgoing track ran out
        return;
      }
      if (pausedFromOutside({ playing, buffering, posMs, durMs, stoppedSinceMs: b.stoppedSince, now })) {
        // Lock screen / headset / a call paused the current track: cut the blend so the incoming one doesn't play on alone.
        abortBlend();
        report('paused');
        return;
      }
      if (!b.phaseChecked && now - b.runner.startedAt >= 1000) {
        // Beat-phase check once playback has settled: nudge the incoming rate briefly if it's off the beat.
        b.phaseChecked = true;
        try {
          const err = b.runner.phaseError(posMs, standbyPlayer().currentTime * 1000);
          if (err != null) b.runner.nudge(err);
        } catch {
          /* ignore */
        }
      }
      if (b.runner.step() === 'done') {
        completeBlend();
        return;
      }
      if (now - b.lastPublish >= BLEND_PUBLISH_MS) {
        b.lastPublish = now;
        setBlend({ into: b.into, label: b.runner.plan.label, progress: b.runner.progress() });
      }
      return;
    }

    // 3. Tempo glide back to 1× after a beat-matched blend.
    const g = glideRef.current;
    if (g && playing) {
      const r = glideRate(g.from, now - g.t0, g.ms);
      if (r === 1 || Math.abs(r - liveRateRef.current) >= 0.002) {
        liveRateRef.current = r;
        try {
          out.setPlaybackRate(r, 'high');
        } catch {
          /* ignore */
        }
      }
      if (r === 1) glideRef.current = null;
    }

    // 4. Schedule the next blend.
    const cur = st.queue[st.index];
    const n = st.automixLocal && st.repeat !== 'one' ? nextQueueIndex(st.queue.length, st.index, st.repeat) : -1;
    const nx = n >= 0 ? st.queue[n] : undefined;
    // The queue / repeat changed, or Automix went off: a stale preload.
    if (sb.itemId && sb.itemId !== nx?.id) releaseStandby();
    if (!cur || !nx || loadedId.current !== cur.id || nx.id === cur.id || !automixApplies(cur, nx)) return;
    const tr = planNow();
    const mine = sb.itemId === nx.id;
    const stale = mine && sb.state !== 'failed' && tr !== undefined && (tr ? Math.abs(sb.startMs - tr.mixInMs) > 50 : sb.startMs > 0);
    const action = automixAction({
      posMs, durMs, rate: liveRateRef.current, playing, tr,
      standby: !mine ? 'none' : sb.state === 'failed' ? 'loading' : sb.state, standbyStale: stale,
    });
    if (action.kind === 'preload') preloadStandby(nx, action.startMs);
    else if (action.kind === 'start' && tr) startBlend(tr);
    else if (action.kind === 'arm' && tr && !armRef.current) {
      armRef.current = setTimeout(() => {
        armRef.current = null;
        const t = planNow();
        if (t && !blendRef.current) startBlend(t);
      }, Math.max(0, action.waitMs - 8));
    }
  };
  const driveRef = useRef(drive);
  driveRef.current = drive;

  // Player status updates drive Automix too: they keep coming in the background, where Android pauses JS timers.
  useEffect(() => {
    const subs = [playerA, playerB].map((p) => p.addListener('playbackStatusUpdate', () => driveRef.current()));
    return () => subs.forEach((s) => s.remove());
  }, [playerA, playerB]);

  // Cast connected / disconnected: hand the current item over at the same position.
  useEffect(() => {
    if (castOn) {
      abortBlend();
      releaseStandby();
    }
    if (castOn === castModeRef.current) return;
    const cur = currentRef.current;
    if (cur && loadedId.current === cur.id) {
      const pos = castModeRef.current ? castPosRef.current : Math.round(livePlayer().currentTime * 1000);
      startOverride.current = { id: cur.id, ms: pos };
      loadPaused.current = !castOn;
      loadedId.current = null;
    } else if (!cur) {
      castModeRef.current = castOn;
    }
    if (!castOn) castUrl.current = null;
  }, [castOn, livePlayer, abortBlend, releaseStandby]);

  // Load the current track.
  useEffect(() => {
    if (!current || !api) return;
    if (loadedId.current === current.id) return;
    loadedId.current = current.id;
    // A real track change (not a blend handing over): any blend in progress is cut.
    abortBlend();
    stopGlide();
    const player = livePlayer();
    let alive = true;
    (async () => {
      setError(null);
      if (session.current) report('stopped');
      session.current = null;
      castModeRef.current = castOn;
      const local = downloadsRef.current.get(current.id);
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
          if (!alive) {
            api.stopSession(info.sessionId).catch(() => undefined);
            return;
          }
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
      let mine: string | null = null;
      if (altRef.current && altRef.current.itemId !== current.id) {
        altRef.current = null;
        setAltSourceState(null);
      }
      if (altRef.current) {
        uri = api.absolute(altRef.current.path);
      } else if (local?.state === 'done' && local.fileUri) {
        uri = local.fileUri;
      } else {
        try {
          const info = await api.playback(current.id, { deviceProfile: audioDeviceProfile(), startMs: startMs > 0 ? Math.round(startMs) : undefined });
          if (!alive) {
            api.stopSession(info.sessionId).catch(() => undefined);
            return;
          }
          session.current = info;
          mine = info.sessionId;
          if (isSpoken && info.startMs) startMs = info.startMs;
          uri = api.absolute(info.url);
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Playback failed');
          return;
        }
      }
      await applySavedSpeed();
      if (!alive) {
        if (mine) api.stopSession(mine).catch(() => undefined);
        if (session.current?.sessionId === mine) session.current = null;
        return;
      }
      player.replace({ uri, headers: api.headers(false) });
      try {
        player.volume = volumeRef.current * gainRef.current * sleepFactorRef.current;
      } catch {
        /* ignore */
      }
      pendingSeek.current = startMs > 1000 ? startMs : null;
      liveRateRef.current = 1;
      try {
        player.setPlaybackRate(isSpoken ? rateRef.current : 1);
      } catch {
        /* ignore */
      }
      if (loadPaused.current) loadPaused.current = false;
      else player.play();
      applyLockScreen(player, current, queue.length);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, api, report, castOn, reloadTick]);

  // Apply the resume position once the new source is ready.
  useEffect(() => {
    if (!status.isLoaded || pendingSeek.current == null) return;
    const ms = pendingSeek.current;
    pendingSeek.current = null;
    void livePlayer().seekTo(ms / 1000);
  }, [status.isLoaded, livePlayer]);

  // Progress every 10s (from the receiver's position while casting).
  const playing = castOn ? castPlaying : status.playing;
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => report('playing'), 10000);
    return () => clearInterval(timer);
  }, [playing, report]);

  // Automix scheduler in the foreground (player status updates cover the background).
  const blendActive = blend != null;
  useEffect(() => {
    if (!automixLocal || (!playing && !blendActive)) return;
    const timer = setInterval(() => driveRef.current(), AUTOMIX_TICK_MS);
    return () => clearInterval(timer);
  }, [automixLocal, playing, blendActive]);

  // Automix turned off (or casting started): no more blends; a preload is dropped.
  useEffect(() => {
    if (automixLocal) return;
    if (!blendRef.current) releaseStandby();
  }, [automixLocal, releaseStandby]);

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
      livePlayer().setActiveForLockScreen(true, applied.meta, options);
      syncCarRemoteCommands(!spokenRef.current);
    } catch {
      /* not supported on this platform */
    }
  }, [mode.longTrack, livePlayer]); // eslint-disable-line react-hooks/exhaustive-deps

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
        const p = livePlayer();
        void p.seekTo(0);
        p.play();
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
    [queue.length, index, repeat, livePlayer, report],
  );

  // Track finished.
  const finishedRef = useRef(false);
  useEffect(() => {
    if (status.didJustFinish && !finishedRef.current) {
      finishedRef.current = true;
      // Automix: the outgoing track ran out during a blend, or the next one waits on the standby player.
      if (completeBlend() || swapAtEnd()) return;
      report('stopped');
      session.current = null;
      if (sleepRef.current?.mode === 'part') {
        // Sleep timer "end of part": move on, but load the next part paused.
        loadPaused.current = true;
        setSleepState(null);
      }
      advance(1, true);
    } else if (!status.didJustFinish) finishedRef.current = false;
  }, [status.didJustFinish, advance, report, completeBlend, swapAtEnd]);

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

  /** Seek on whichever player is active (ms). A seek cuts a running blend. */
  const seekAny = useCallback(
    (ms: number) => {
      const client = castClientRef.current;
      if (castModeRef.current && client) void client.seek({ position: Math.max(0, ms / 1000) }).catch(() => undefined);
      else {
        abortBlend();
        void livePlayer().seekTo(Math.max(0, ms / 1000));
      }
    },
    [livePlayer, abortBlend],
  );

  /** Pause whichever player is active (cuts a running blend). */
  const pauseAny = useCallback(() => {
    const client = castClientRef.current;
    if (castModeRef.current && client) {
      if (castPlayingRef.current) {
        void client.pause().catch(() => undefined);
        report('paused');
      }
      return;
    }
    abortBlend();
    const p = livePlayer();
    if (p.playing) {
      p.pause();
      report('paused');
    }
  }, [livePlayer, report, abortBlend]);

  // ----- Sleep timer -----
  const setSleep = useCallback(
    (opt: SleepOption | null) => {
      sleepFactorRef.current = 1;
      try {
        if (!castModeRef.current && !blendRef.current) livePlayer().volume = volumeRef.current * gainRef.current;
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
        const pos = castModeRef.current ? castPosRef.current : livePlayer().currentTime * 1000;
        const nextStart = chaptersRef.current.find((c) => c.startMs > pos + 500)?.startMs;
        setSleepState(nextStart != null ? { mode: 'chapter', itemId: cur.id, endMs: nextStart } : { mode: 'part', itemId: cur.id });
        return;
      }
      setSleepState({ mode: 'time', minutes: opt.minutes, endsAt: Date.now() + opt.minutes * 60000 });
    },
    [livePlayer],
  );

  useEffect(() => {
    if (!sleep) return;
    const fire = () => {
      setSleepState(null);
      setSleepRemaining(null);
      pauseAny();
      setTimeout(() => {
        sleepFactorRef.current = 1;
        try {
          livePlayer().volume = volumeRef.current * gainRef.current;
        } catch {
          /* ignore */
        }
      }, 300);
    };
    const tick = () => {
      const remote = castModeRef.current;
      const player = livePlayer();
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
        sleepFactorRef.current = Math.max(0, Math.min(1, remaining / SLEEP_FADE_MS));
        // During a blend the runner applies the factor to both players.
        if (!blendRef.current) {
          try {
            player.volume = volumeRef.current * gainRef.current * sleepFactorRef.current;
          } catch {
            /* ignore */
          }
        }
      }
    };
    tick();
    const timer = setInterval(tick, 500);
    return () => {
      clearInterval(timer);
      sleepFactorRef.current = 1;
    };
  }, [sleep, livePlayer, pauseAny]);

  const playQueue = useCallback(
    (items: Item[], startIndex = 0, opts: { shuffle?: boolean; startMs?: number } = {}) => {
      const wanted = items[startIndex];
      const tracks = items.filter((i) => isAudioItem(i.type));
      if (!tracks.length) return;
      abortBlend();
      // Normal Play follows the Automix preference (a Mix ends here).
      setMixSession(null);
      mixSourceRef.current = null;
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
      // Replaying the same track at the same index (e.g. after the queue ended) leaves `current` unchanged, so the load
      // effect would not run: force it.
      setReloadTick((n) => n + 1);
    },
    [abortBlend],
  );

  /* ---------------- Mix ---------------- */
  /** Smart-ordered source still being paged in (a whole library streams in batches). */
  const mixSourceRef = useRef<{ base: DjOrderRequest; remaining: number } | null>(null);
  const mixFetching = useRef(false);
  const playAsMix = useCallback(
    async (src: MixSource) => {
      const a = apiRef.current;
      if (!a) return false;
      try {
        let tracks: Item[];
        let start = src.start ?? 0;
        let paged: { base: DjOrderRequest; remaining: number } | null = null;
        if (src.source || src.smart) {
          const base: DjOrderRequest = src.source ? { source: src.source, harmonic: true } : { itemIds: (src.items ?? []).map((i) => i.id).slice(0, 5000), harmonic: true };
          const r = await a.djOrder({ ...base, limit: src.source ? MIX_PAGE : 500 });
          seedAnalyses(r.analyses);
          tracks = r.items.filter((i) => i.type === 'track');
          paged = r.remaining > 0 ? { base, remaining: r.remaining } : null;
          start = 0;
        } else tracks = (src.items ?? []).filter((i) => i.type === 'track');
        if (!tracks.length) return false;
        abortBlend();
        mixSourceRef.current = paged;
        setShuffleState(false);
        setRepeat('off');
        setMixSession({ label: src.label });
        setEndless(true);
        startOverride.current = null;
        loadedId.current = null;
        setQueue(tracks);
        setIndex(Math.max(0, Math.min(start, tracks.length - 1)));
        setReloadTick((n) => n + 1);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not start the mix');
        return false;
      }
    },
    [seedAnalyses, abortBlend],
  );

  // Keep a Mix going: the next page of a big source, then (Endless) similar tracks from the library.
  useEffect(() => {
    if (!mixSession || mixFetching.current || !api || !queue.length) return;
    if (queue.length - index - 1 >= MIX_LOW_WATER) return;
    const src = mixSourceRef.current;
    const ids = queue.map((q) => q.id);
    let more: Promise<Item[]>;
    if (src && src.remaining > 0) {
      more = api.djOrder({ ...src.base, history: ids.slice(-5000), limit: MIX_PAGE }).then((r) => {
        seedAnalyses(r.analyses);
        src.remaining = r.remaining;
        return r.items;
      });
    } else if (endless) {
      // Seeded from the last played tracks; the server's local scoring only (no prompt, so no AI).
      more = api.djMix({ history: ids.slice(-200), count: 10, harmonic: true, curve: 'steady', transitions: mixStyle, maxStretchPct: AUTOMIX_MAX_STRETCH * 100 }).then((m) => {
        seedAnalyses(m.tracks);
        return m.tracks.map((t) => t.item);
      });
    } else return;
    mixFetching.current = true;
    const label = mixSession.label;
    more
      .then((list) => {
        if (!stRef.current.queue.length) return;
        const seen = new Set(stRef.current.queue.map((q) => q.id));
        const add = list.filter((t) => t.type === 'track' && !seen.has(t.id));
        if (add.length && label) setQueue((q) => [...q, ...add]);
      })
      .catch(() => undefined)
      .finally(() => {
        mixFetching.current = false;
      });
  }, [mixSession, endless, queue, index, mixStyle, api, seedAnalyses]);

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
          else if (spokenRef.current) livePlayer().setPlaybackRate(r);
        } catch {
          /* ignore */
        }
      },
      chapters,
      skip: (deltaMs) => {
        if (castModeRef.current) return seekAny(castPosRef.current + deltaMs);
        const p = livePlayer();
        const d = p.duration > 0 ? p.duration : Infinity;
        seekAny(Math.max(0, Math.min(d - 1, p.currentTime + deltaMs / 1000)) * 1000);
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
        const p = livePlayer();
        if (p.playing) {
          abortBlend();
          p.pause();
          report('paused');
        } else p.play();
      },
      pause: pauseAny,
      next: () => {
        // Skipping during a blend completes it: the incoming track simply takes over.
        if (completeBlend()) return;
        advance(1);
      },
      previous: () => {
        abortBlend();
        if ((castModeRef.current ? castPosRef.current / 1000 : livePlayer().currentTime) > 4) seekAny(0);
        else advance(-1);
      },
      seek: seekAny,
      jumpTo: (i, startMs) => {
        abortBlend();
        const target = queue[i];
        if (target && startMs != null) startOverride.current = { id: target.id, ms: startMs };
        loadedId.current = null;
        setIndex(i);
        // Same entry: the load effect would not re-run, so reload it.
        if (i === index) setReloadTick((n) => n + 1);
      },
      stop: () => {
        abortBlend();
        releaseStandby();
        if (castModeRef.current) void castClientRef.current?.stop().catch(() => undefined);
        const p = livePlayer();
        p.pause();
        report('stopped');
        session.current = null;
        try {
          p.clearLockScreenControls();
        } catch {
          /* ignore */
        }
        syncCarRemoteCommands(false);
        lockScreen.current = null;
        setSleepState(null);
        setSleepRemaining(null);
        setMixSession(null);
        mixSourceRef.current = null;
        loadedId.current = null;
        setQueue([]);
        setIndex(0);
      },
      setShuffle: (v) => {
        abortBlend();
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
          // During a blend the runner picks the new volume up on its next step.
          else if (!blendRef.current) livePlayer().volume = vol * gainRef.current * sleepFactorRef.current;
        } catch {
          /* ignore */
        }
      },
      sleep,
      sleepRemainingMs,
      setSleep,
      altSource,
      setAltSource: (path: string | null) => {
        const cur = currentRef.current;
        if (!cur || (altRef.current?.path ?? null) === path) return;
        abortBlend();
        altRef.current = path ? { itemId: cur.id, path } : null;
        setAltSourceState(path);
        startOverride.current = { id: cur.id, ms: Math.round(livePlayer().currentTime * 1000) };
        loadedId.current = null;
        setReloadTick((n) => n + 1);
      },
      automix: automixOn,
      setAutomix: (on) => {
        if (!on) {
          setMixSession(null);
          mixSourceRef.current = null;
          completeBlend();
        }
        if (on !== automixPref || user?.preferences.automix === undefined) void updatePreferences({ automix: on }).catch(() => undefined);
      },
      mixStyle,
      setMixStyle: (s) => void updatePreferences({ automixStyle: s }).catch(() => undefined),
      mix: mixSession,
      playAsMix,
      endless,
      setEndless,
      blend,
    }),
    [queue, index, current, status, durationMs, mode.longTrack, shuffle, repeat, error, spoken, rate, chapters, playQueue, livePlayer, report, advance, playing, castOn, castState, ours, cast.positionMs, cast.mediaStatus, cast.deviceName, seekAny, pauseAny, volume, sleep, sleepRemainingMs, setSleep, altSource,
      automixOn, automixPref, mixStyle, mixSession, playAsMix, endless, blend, abortBlend, completeBlend, releaseStandby, updatePreferences, user?.preferences.automix],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMusic(): MusicValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMusic outside MusicProvider');
  return v;
}
