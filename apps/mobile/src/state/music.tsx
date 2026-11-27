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
 *
 * Your DJ and the Radio Host (thin clients of the server's AI DJ endpoints; src/player/yourDj.ts, radioHost.ts):
 * Your DJ plays a server session (POST /dj/session, /more, /switch, /request) as a Mix. The host asks POST /dj/break
 * about 30 s before a transition and plays what comes back on a third expo-audio player (the server's clip) or with
 * expo-speech (the server's text), ducking the music through a volume envelope (`Ducker`) multiplied into both music
 * players. Only for music streamed from the server: never for downloads, offline, or while casting. Any failure is
 * silent and never touches playback.
 */
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus, type AudioPlayer } from 'expo-audio';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { audioDeviceProfile, castDeviceProfile } from '@/api/profiles';
import { getJSON, setJSON } from '@/api/storage';
import { lockScreenOptions, transportMode, type LockScreenOptions } from '@/car/policy';
import { syncCarRemoteCommands } from '@/car/remote';
import { castMediaInfo, isOurMedia, useCast } from '@/cast';
import type { Chapter, DjBreak, DjOrderRequest, DjOrderSource, DjSession, DjStatus, DjTransition, DjTransitionPreference, Item, PlaybackInfo, TrackAnalysis, UserPreferences } from '@/api/types';
import { activePresetIdOf } from '@/player/djRules';
import {
  askState, DEFAULT_RADIO_HOST, deviceVoiceId, Ducker, GAP_FADE_MS, hostMayAsk, RadioHost, radioHostPrefs, talkWindowMs, wantsDeviceVoice,
  type HostSnapshot, type HostVoice,
} from '@/player/radioHost';
import {
  aiDjOn, isEarlySkip, isForbidden, moreOrRestart, requestOrMiss, sessionHistory, startSession, switchAck, switchQueue, yourDjAvailability,
  yourDjCommentary, yourDjReducer, type YourDjAction, type YourDjState,
} from '@/player/yourDj';
import { useOnline } from '@/utils/connectivity';
import { deviceSpeech } from '@/utils/speech';
import {
  AUTOMIX_DEFAULT, AUTOMIX_MAX_STRETCH, automixAction, automixApplies, BlendRunner, glideMs, glideRate, isGaplessJoin, nextQueueIndex, pausedFromOutside,
  planAutomix, prepareBlend, sanitizePlan, type MixDeck,
} from '@/player/automix';
import { isAudioItem, isSpokenAudio } from '@/utils/library';
import { useDownloads } from './downloads';
import { useSession } from './session';

/** Waits before asking /dj/status again after a failure (the last one repeats). */
const DJ_STATUS_RETRY_MS = [3000, 10000, 30000, 60000];

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
/** Radio Host: "mute on this device" (AsyncStorage). */
const HOST_MUTE_KEY = 'vibe.host.muted';
/** Radio Host scheduler (foreground; player status updates cover the background). */
const HOST_TICK_MS = 500;
/** Duck envelope step. */
const DUCK_TICK_MS = 50;
/** A server voice clip that hasn't loaded by then is dropped (device voice instead). */
const CLIP_LOAD_TIMEOUT_MS = 10000;
/** Your DJ "switch it up": fade the current song out this fast before the new direction. */
const TURN_FADE_MS = 500;
const hostKey = (a: Item, b: Item, i: number) => `${a.id}>${b.id}@${i}`;

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
  /** Your DJ session, when the queue is one (segments, reasons, busy state, gentle messages). */
  yourDj: YourDjState | null;
  /** Can Your DJ start (server reachable, AI DJ on)? `hidden` = don't show the card; `note` = why it's disabled. */
  yourDjAvailability: { available: boolean; hidden: boolean; note: string | null };
  /** The server hasn't said yet whether Your DJ is on; pressing Play asks it again. */
  yourDjChecking: boolean;
  yourDjStarting: boolean;
  /** One tap: a personal set from the library (server), played as an endless Automix mix. `message` when it couldn't start. */
  startYourDj: () => Promise<{ ok: boolean; message?: string }>;
  /** "Switch it up": a different segment, starting with the next track. */
  djSwitch: () => Promise<void>;
  /** A typed request; no match = a gentle message, the set carries on. */
  djRequest: (text: string) => Promise<void>;
  djDismiss: () => void;
  /** Like a track (POST /dj/feedback love; the server also favourites it). */
  djLove: (item: Item) => void;
  /** What the server says about the AI DJ (null = unknown / unreachable). */
  djAi: { on: boolean; radioHost: boolean; weather: boolean | null; serverVoice: boolean; hostName: string | null };
  /** Radio Host / Your DJ voice: captions while it talks, skip talk, mute (this device). */
  host: HostSnapshot & { muted: boolean; active: boolean; skip: () => void; setMuted: (m: boolean) => void };
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
  const { api, user, updatePreferences, status: sessionStatus } = useSession();
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

  /* ---------------- Your DJ / Radio Host (server-driven; src/player/yourDj.ts, radioHost.ts) ---------------- */
  const online = useOnline();
  const signedIn = sessionStatus === 'signed-in' && !!api;
  const [djStatus, setDjStatus] = useState<DjStatus | null>(null);
  /** The server answered 403 to /dj/session or /dj/break: the admin switched the AI DJ off. */
  const [aiForbidden, setAiForbidden] = useState(false);
  useEffect(() => setAiForbidden(false), [api]);
  /** Bumped to ask /dj/status again (a failed check, the app coming back to the foreground, a press on Play). */
  const [djStatusTick, setDjStatusTick] = useState(0);
  const djStatusFails = useRef(0);
  const recheckDjStatus = useCallback(() => setDjStatusTick((n) => n + 1), []);
  useEffect(() => {
    // Only the Vibe server is asked, and only while it can be reached (no requests offline / downloads-only).
    if (!api || !signedIn || !online) {
      setDjStatus(null);
      djStatusFails.current = 0;
      return;
    }
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | null = null;
    api
      .djStatus()
      .then((st) => {
        if (!alive) return;
        djStatusFails.current = 0;
        setDjStatus(st);
      })
      .catch(() => {
        if (!alive) return;
        // One failed check (a slow or restarting server at launch) used to leave Your DJ disabled for good: try again.
        const delay = DJ_STATUS_RETRY_MS[Math.min(djStatusFails.current, DJ_STATUS_RETRY_MS.length - 1)]!;
        djStatusFails.current++;
        retry = setTimeout(() => alive && setDjStatusTick((n) => n + 1), delay);
      });
    return () => {
      alive = false;
      if (retry) clearTimeout(retry);
    };
  }, [api, signedIn, online, djStatusTick]);
  const djStatusKnown = !!djStatus;
  useEffect(() => {
    if (djStatusKnown) return;
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') setDjStatusTick((n) => n + 1);
    });
    return () => sub.remove();
  }, [djStatusKnown]);
  const aiOn = aiDjOn({ signedIn, online, status: djStatus, forbidden: aiForbidden });
  const yourDjAvail = useMemo(
    () => yourDjAvailability({ signedIn, online, status: djStatus, forbidden: aiForbidden, hasMusic: true }),
    [signedIn, online, djStatus, aiForbidden],
  );
  const [yourDj, setYourDjState] = useState<YourDjState | null>(null);
  const yourDjRef = useRef<YourDjState | null>(null);
  const dispatchDj = useCallback((a: YourDjAction) => {
    yourDjRef.current = yourDjReducer(yourDjRef.current, a);
    setYourDjState(yourDjRef.current);
  }, []);
  const [yourDjStarting, setYourDjStarting] = useState(false);
  const commentary = yourDjCommentary(user?.preferences);
  const hostPrefs = user ? radioHostPrefs(user.preferences) : DEFAULT_RADIO_HOST;
  const activePresetId = activePresetIdOf(user?.preferences);
  /** Who talks between tracks: Your DJ (commentary Intros / Full), the Radio Host (any other music), or nobody. */
  const hostMode: 'radio' | 'yourdj' | null = !aiOn
    ? null
    : yourDj
      ? commentary !== 'off' && djStatus?.ai?.yourDj !== false ? 'yourdj' : null
      : hostPrefs.enabled && djStatus?.ai?.radioHost !== false ? 'radio' : null;
  const djRef = useRef({ aiOn, hostMode, hostVoice: hostPrefs.voice ?? null, commentary, activePresetId, available: yourDjAvail.available, signedIn, online });
  djRef.current = { aiOn, hostMode, hostVoice: hostPrefs.voice ?? null, commentary, activePresetId, available: yourDjAvail.available, signedIn, online };
  /** /dj/status hasn't answered yet: Play stays pressable (and focusable on TV) and asks again. */
  const yourDjChecking = signedIn && online && !djStatus && !aiForbidden;
  const [hostState, setHostState] = useState<HostSnapshot>({ caption: null, speaking: false, kind: null });
  const [hostMuted, setHostMutedState] = useState(false);
  /** Third player: the server-rendered host clips (never the lock-screen player). */
  const voicePlayer = useAudioPlayer(null, { updateInterval: 250 });
  const voicePlayerRef = useRef(voicePlayer);
  voicePlayerRef.current = voicePlayer;
  /** The music level while the host talks (multiplied into both music players' volumes). */
  const duckerRef = useRef(new Ducker());
  const [ducking, setDucking] = useState(false);
  /** The envelope moved since it was last applied (one more apply after it ends). */
  const duckDirtyRef = useRef(false);
  const duckNow = () => duckerRef.current.factor(Date.now());
  /** A gap break is running for this transition key (the outgoing player is paused on purpose). */
  const gapRef = useRef<string | null>(null);
  /** Ends a gap break early; `cont` = carry on to the next track (assigned further down). */
  const abortGapRef = useRef<(cont: boolean) => boolean>(() => false);
  /** A Your DJ intro / "switch it up" acknowledgement to play once its track has started. */
  const pendingIntroRef = useRef<{ brk: DjBreak; itemId: string } | null>(null);
  /** Transitions already asked about (once per pair and queue position). */
  const hostAskedRef = useRef(new Set<string>());
  /** The transition the host last asked about, until it happened (`done`). */
  const lastAskRef = useRef<{ key: string; nextId: string; introMs: number | null; done: boolean } | null>(null);
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  /** Host scheduler + duck step (assigned further down; also called on every music player status update). */
  const hostStepRef = useRef<() => void>(() => undefined);

  /** A server-rendered clip on the voice player; null when it doesn't load in time (then the device voice speaks). */
  const clipVoice = (url: string, knownMs: number | null, signal: AbortSignal): Promise<HostVoice | null> =>
    new Promise((resolve) => {
      const a = apiRef.current;
      const p = voicePlayerRef.current;
      if (!a) return resolve(null);
      let settled = false;
      let poll: ReturnType<typeof setInterval> | null = null;
      const t0 = Date.now();
      let finish: (() => void) | null = null;
      let sub: { remove(): void } | null = null;
      const drop = () => {
        sub?.remove();
        sub = null;
      };
      const voice: HostVoice = {
        get durationMs() {
          try {
            return p.duration > 0 ? Math.round(p.duration * 1000) : knownMs;
          } catch {
            return knownMs;
          }
        },
        play(volume) {
          return new Promise<void>((res, rej) => {
            finish = res;
            drop();
            sub = p.addListener('playbackStatusUpdate', (st) => {
              if (st.didJustFinish) {
                drop();
                res();
              } else if (st.error) {
                drop();
                rej(new Error(st.error));
              }
            });
            try {
              p.volume = clamp01(volume);
              if (p.currentTime > 0.05) void p.seekTo(0).catch(() => undefined);
              p.play();
            } catch (e) {
              drop();
              rej(e);
            }
          });
        },
        stop() {
          drop();
          try {
            p.pause();
          } catch {
            /* ignore */
          }
          finish?.();
        },
        setVolume(v) {
          try {
            p.volume = clamp01(v);
          } catch {
            /* ignore */
          }
        },
      };
      const done = (v: HostVoice | null) => {
        if (settled) return;
        settled = true;
        if (poll) clearInterval(poll);
        resolve(v);
      };
      signal.addEventListener('abort', () => done(null));
      try {
        p.pause();
        p.volume = 0;
        // Streamed from the Vibe server with the app's auth, like every other stream.
        p.replace({ uri: a.withAuthQuery(url), headers: a.headers(false) });
      } catch {
        return done(null);
      }
      poll = setInterval(() => {
        let loaded = false;
        let err: string | null = null;
        try {
          loaded = p.isLoaded;
          err = p.currentStatus?.error ?? null;
        } catch {
          /* ignore */
        }
        if (err) done(null);
        else if (loaded && Date.now() - t0 >= 250) done(voice);
        else if (Date.now() - t0 > CLIP_LOAD_TIMEOUT_MS) done(null);
      }, 100);
    });

  /** The server's text in the device voice (expo-speech); null where there is none (tvOS): the break is skipped. */
  const speechVoice = (text: string, pref: string | null): HostVoice | null => {
    const sp = deviceSpeech;
    if (!sp) return null;
    let finish: (() => void) | null = null;
    return {
      durationMs: null,
      play(volume) {
        return new Promise<void>((res, rej) => {
          finish = res;
          try {
            const voice = deviceVoiceId(pref);
            sp.speak(text, { volume: clamp01(volume), ...(voice ? { voice } : {}), onDone: () => res(), onStopped: () => res(), onError: (e) => rej(e) });
          } catch (e) {
            rej(e);
          }
        });
      },
      stop() {
        sp.stop().catch(() => undefined);
        finish?.();
      },
      setVolume() {
        /* can't change mid-utterance */
      },
    };
  };

  const hostRef = useRef<RadioHost | null>(null);
  if (!hostRef.current) {
    hostRef.current = new RadioHost({
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      fetchBreak: async (req, signal) => {
        const a = apiRef.current;
        if (!a || !djRef.current.aiOn) return null;
        try {
          return (await a.djBreak(req, signal)).break ?? null;
        } catch (e) {
          if (isForbidden(e)) setAiForbidden(true);
          throw e;
        }
      },
      prepareVoice: async (brk, signal) => {
        const pref = djRef.current.hostVoice;
        if (brk.audioUrl && !wantsDeviceVoice(pref)) {
          const v = await clipVoice(brk.audioUrl, brk.durationMs, signal);
          if (v || signal.aborted) return v;
        }
        return signal.aborted ? null : speechVoice(brk.text, pref);
      },
      duck: (duckInMs, releaseInMs, g, rampMs) => {
        duckerRef.current.duck(Date.now(), duckInMs, releaseInMs, g, rampMs);
        duckDirtyRef.current = true;
        setDucking(true);
        return true;
      },
      unduck: (rampMs) => {
        duckerRef.current.unduck(Date.now(), rampMs);
        duckDirtyRef.current = true;
        setDucking(true);
      },
      volume: () => volumeRef.current,
      onState: setHostState,
      // Silent fallback: never a toast, never an interruption.
      log: (...a) => console.debug(...a),
    });
  }
  useEffect(() => {
    void getJSON<boolean>(HOST_MUTE_KEY, false).then((m) => {
      setHostMutedState(!!m);
      hostRef.current?.setMuted(!!m);
    });
  }, []);

  useEffect(() => {
    if (castModeRef.current || sleepRef.current || blendRef.current) return; // the sleep fade / a blend owns the volume while it runs
    try {
      livePlayer().volume = clamp01(volumeRef.current * gain * duckNow());
    } catch {
      /* player not ready */
    }
  }, [gain, livePlayer]); // eslint-disable-line react-hooks/exhaustive-deps

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
      p.volume = clamp01(volumeRef.current * replayGainFor(into, st.queue, st.shuffle, st.rgMode) * sleepFactorRef.current * duckNow());
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
      if (blendRef.current || gapRef.current || !into || sb.state !== 'ready' || sb.itemId !== into.id) return false;
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
        // The host's duck applies to both players (an over-intro break starts with the blend).
        levels: () => {
          const d = duckNow();
          return { out: volumeRef.current * gainRef.current * sleepFactorRef.current * d, inc: volumeRef.current * intoGain * sleepFactorRef.current * d };
        },
      });
      blendRef.current = { runner, into, phaseChecked: false, stoppedSince: null, lastPublish: Date.now() };
      runner.start();
      // Radio Host: the transition it asked about starts now.
      const la = lastAskRef.current;
      if (la && !la.done && la.nextId === into.id) {
        la.done = true;
        hostRef.current?.onTransition(la.key);
      }
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

    // 4. Schedule the next blend (not while a gap break holds the transition).
    if (gapRef.current) return;
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
    const subs = [playerA, playerB].map((p) =>
      p.addListener('playbackStatusUpdate', () => {
        driveRef.current();
        hostStepRef.current();
      }),
    );
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
        player.volume = clamp01(volumeRef.current * gainRef.current * sleepFactorRef.current * duckNow());
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
      // A gap break holds the transition (it moves on when the host is done); in the background it is dropped.
      if (gapRef.current) {
        if (AppState.currentState === 'active') return;
        abortGapRef.current(false);
      }
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
        if (!castModeRef.current && !blendRef.current) livePlayer().volume = clamp01(volumeRef.current * gainRef.current * duckNow());
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
          livePlayer().volume = clamp01(volumeRef.current * gainRef.current * duckNow());
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
            player.volume = clamp01(volumeRef.current * gainRef.current * sleepFactorRef.current * duckNow());
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
      abortGapRef.current(false);
      hostRef.current?.cancel();
      // Normal Play follows the Automix preference (a Mix, and Your DJ, end here).
      dispatchDj({ type: 'end' });
      pendingIntroRef.current = null;
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
    [abortBlend, dispatchDj],
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
          // Play rules: the active preset (the server intersects the admin's enforced restrictions).
          const presetId = djRef.current.activePresetId;
          const base: DjOrderRequest = src.source ? { source: src.source, harmonic: true, presetId } : { itemIds: (src.items ?? []).map((i) => i.id).slice(0, 5000), harmonic: true, presetId };
          const r = await a.djOrder({ ...base, limit: src.source ? MIX_PAGE : 500 });
          seedAnalyses(r.analyses);
          tracks = r.items.filter((i) => i.type === 'track');
          paged = r.remaining > 0 ? { base, remaining: r.remaining } : null;
          start = 0;
        } else tracks = (src.items ?? []).filter((i) => i.type === 'track');
        if (!tracks.length) return false;
        abortBlend();
        abortGapRef.current(false);
        hostRef.current?.cancel();
        dispatchDj({ type: 'end' });
        pendingIntroRef.current = null;
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
    [seedAnalyses, abortBlend, dispatchDj],
  );

  // Keep a Mix going: the next page of a big source, then (Endless) similar tracks from the library.
  useEffect(() => {
    if (!mixSession || mixFetching.current || !api || !queue.length) return;
    if (queue.length - index - 1 >= MIX_LOW_WATER) return;
    const src = mixSourceRef.current;
    const ids = queue.map((q) => q.id);
    let more: Promise<Item[]>;
    const dj = yourDjRef.current;
    if (dj) {
      // Your DJ: more of the current segment, or the next one (the server decides). An expired session restarts quietly.
      if (!djRef.current.aiOn) return;
      more = moreOrRestart(api, dj.sessionId, sessionHistory(queue, queue.length - 1), djRef.current.activePresetId)
        .then((r) => {
          if (yourDjRef.current?.sessionId !== dj.sessionId) return [];
          const tracks = r.items.filter((t) => t.type === 'track');
          seedAnalyses(r.analyses);
          dispatchDj({ type: 'more', session: { ...r, items: tracks } });
          // A new segment's spoken intro (when the server made one for it).
          const first = tracks.find((t) => !stRef.current.queue.some((q) => q.id === t.id));
          if (r.intro && first && djRef.current.commentary !== 'off') pendingIntroRef.current = { brk: r.intro, itemId: first.id };
          return tracks;
        })
        .catch((e) => {
          if (isForbidden(e)) setAiForbidden(true);
          throw e;
        });
    } else if (src && src.remaining > 0) {
      more = api.djOrder({ ...src.base, history: ids.slice(-5000), limit: MIX_PAGE }).then((r) => {
        seedAnalyses(r.analyses);
        src.remaining = r.remaining;
        return r.items;
      });
    } else if (endless) {
      // Seeded from the last played tracks; the server's local scoring only (no prompt, so no AI).
      more = api.djMix({ history: ids.slice(-200), count: 10, harmonic: true, curve: 'steady', transitions: mixStyle, maxStretchPct: AUTOMIX_MAX_STRETCH * 100, presetId: djRef.current.activePresetId }).then((m) => {
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
  }, [mixSession, endless, queue, index, mixStyle, api, seedAnalyses, dispatchDj]);

  /* ---------------- Radio Host / Your DJ voice: scheduling ---------------- */
  const advanceRef = useRef(advance);
  advanceRef.current = advance;

  /** Put the live player at its level (volume × ReplayGain × sleep fade × host duck). A running blend does both itself. */
  const applyDuck = () => {
    if (castModeRef.current || blendRef.current) return;
    try {
      livePlayer().volume = clamp01(volumeRef.current * gainRef.current * sleepFactorRef.current * duckNow());
    } catch {
      /* not ready */
    }
  };
  const applyDuckRef = useRef(applyDuck);
  applyDuckRef.current = applyDuck;
  useEffect(() => {
    if (!ducking) return;
    const timer = setInterval(() => {
      const active = duckerRef.current.active(Date.now());
      applyDuckRef.current();
      if (!active) {
        duckDirtyRef.current = false;
        setDucking(false);
      }
    }, DUCK_TICK_MS);
    return () => clearInterval(timer);
  }, [ducking]);

  /** Move on from a held transition (gap break over or dropped): the prepared next track, else the normal advance. */
  const continueAfterGap = () => {
    if (swapAtEnd()) return;
    report('stopped');
    session.current = null;
    advanceRef.current(1, true);
  };

  /** End a gap break early (seek, skip, play, the app going to the background). `cont` = go on to the next track. */
  const abortGap = (cont: boolean) => {
    if (!gapRef.current) return false;
    gapRef.current = null;
    hostRef.current?.cancel();
    duckerRef.current.reset();
    applyDuck();
    if (cont) {
      let playingNow = true;
      try {
        playingNow = livePlayer().playing;
      } catch {
        /* ignore */
      }
      if (!playingNow) continueAfterGap();
    }
    return true;
  };
  abortGapRef.current = abortGap;

  /** Gap break: the outgoing track fades, a brief pause while the host talks, then the next track. */
  const startGap = (key: string) => {
    gapRef.current = key;
    clearArm();
    duckerRef.current.fadeOut(Date.now(), GAP_FADE_MS);
    duckDirtyRef.current = true;
    setDucking(true);
    setTimeout(() => {
      if (gapRef.current !== key) return;
      try {
        livePlayer().pause();
      } catch {
        /* ignore */
      }
      duckerRef.current.reset();
      void (hostRef.current?.playGap(key) ?? Promise.resolve()).then(() => {
        if (gapRef.current !== key) return;
        gapRef.current = null;
        applyDuck();
        continueAfterGap();
      });
    }, GAP_FADE_MS);
  };

  /** One host step: ask for a break ~30 s before the next transition, keep its timing, start a gap, fire onTransition. */
  const hostTick = () => {
    const h = hostRef.current;
    const d = djRef.current;
    const st = stRef.current;
    if (!h || gapRef.current || blendRef.current) return;
    const cur = st.queue[st.index];
    if (!cur || loadedId.current !== cur.id) return;
    const p = livePlayer();
    let playingNow = false;
    let posMs = 0;
    let durMs = 0;
    try {
      playingNow = p.playing;
      posMs = p.currentTime * 1000;
      durMs = p.duration * 1000 || 0;
    } catch {
      return;
    }
    if (!playingNow) return;
    // The track the host asked about started (plain track change or gapless join; a blend reports it itself).
    const la = lastAskRef.current;
    if (la && !la.done && la.nextId === cur.id && posMs < 20000) {
      la.done = true;
      h.onTransition(la.key, la.introMs == null ? null : Math.max(0, la.introMs - posMs));
    }
    // A Your DJ segment intro / "switch it up" acknowledgement over the start of its track.
    const pi = pendingIntroRef.current;
    if (pi && pi.itemId === cur.id && d.hostMode === 'yourdj' && !castModeRef.current) {
      pendingIntroRef.current = null;
      void analysisFor(cur.id).then((a) => {
        if (currentRef.current?.id !== cur.id) return;
        let pos = posMs;
        try {
          pos = livePlayer().currentTime * 1000;
        } catch {
          /* ignore */
        }
        h.playNow(pi.brk, talkWindowMs(a?.cues?.introEndMs ?? a?.introEndMs ?? null, pos));
      });
    }
    const n = nextQueueIndex(st.queue.length, st.index, st.repeat);
    const nx = n >= 0 ? st.queue[n] : undefined;
    const dl = downloadsRef.current;
    const gate = {
      mode: d.hostMode, aiOn: d.aiOn, casting: castModeRef.current, muted: h.isMuted,
      localFile: dl.get(cur.id)?.state === 'done' || (!!nx && dl.get(nx.id)?.state === 'done'),
      tracks: cur.type === 'track' && nx?.type === 'track' && n !== st.index, repeatOne: st.repeat === 'one',
    };
    if (!nx || !hostMayAsk(gate) || !durMs) return;
    const key = hostKey(cur, nx, st.index);
    let tr: DjTransition | null = null;
    if (st.automixLocal && automixApplies(cur, nx)) {
      const t = planNow();
      if (t === undefined) return; // the plan is still being made
      tr = t;
    }
    const rate = liveRateRef.current || 1;
    const remaining = ((tr ? tr.mixOutMs : durMs) - posMs) / rate;
    const at = Date.now() + remaining;
    if (h.wantsGap(key) && remaining <= GAP_FADE_MS + 150) {
      // Only in the foreground: a paused track must never wait on a throttled timer.
      if (AppState.currentState === 'active') startGap(key);
      return;
    }
    if (h.current?.key === key) {
      h.retime(key, at);
      return;
    }
    if (hostAskedRef.current.has(key)) return;
    const ask = askState(remaining);
    if (ask === 'wait') return;
    hostAskedRef.current.add(key);
    if (hostAskedRef.current.size > 200) hostAskedRef.current.delete(hostAskedRef.current.values().next().value!);
    if (ask === 'late') return; // too close to prepare a break: stay quiet
    if (pendingIntroRef.current?.itemId === nx.id) return; // Your DJ already has an intro for it
    const mode = d.hostMode!;
    const sessionId = yourDjRef.current?.sessionId;
    void analysisFor(nx.id).then((ab) => {
      if (stRef.current.queue[stRef.current.index]?.id !== cur.id) return;
      const introEnd = ab?.cues?.introEndMs ?? ab?.introEndMs ?? null;
      const introMs = talkWindowMs(introEnd, tr?.mixInMs ?? 0, tr?.style === 'blend' ? tr.tempoRatio || 1 : 1);
      const now = new Date();
      lastAskRef.current = { key, nextId: nx.id, introMs, done: false };
      h.ask(key, {
        mode, previousItemId: cur.id, nextItemId: nx.id, sessionId: mode === 'yourdj' ? sessionId : undefined, ...h.stats(),
        introMs: introMs ?? undefined, hour: now.getHours(), minute: now.getMinutes(),
      }, at, introMs);
    });
  };
  const lastHostStep = useRef(0);
  hostStepRef.current = () => {
    const now = Date.now();
    const active = duckerRef.current.active(now);
    if (active || duckDirtyRef.current) {
      applyDuck();
      duckDirtyRef.current = active;
    }
    if (now - lastHostStep.current < HOST_TICK_MS - 100) return;
    lastHostStep.current = now;
    if (djRef.current.hostMode) hostTick();
  };

  const hostActive = !!hostMode && !castOn;
  useEffect(() => {
    if (!hostActive || !playing) return;
    const timer = setInterval(() => hostStepRef.current(), HOST_TICK_MS);
    return () => clearInterval(timer);
  }, [hostActive, playing]);
  // The host turned off (or casting started, or the server went away): it stops talking; the music carries on.
  useEffect(() => {
    if (hostActive) return;
    abortGapRef.current(true);
    hostRef.current?.cancel();
    pendingIntroRef.current = null;
  }, [hostActive]);
  // The app went to the background during a gap break: don't leave the music waiting on a throttled timer.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active') abortGapRef.current(true);
    });
    return () => sub.remove();
  }, []);
  // A new track: count it for the host's spacing.
  useEffect(() => {
    if (current) hostRef.current?.noteTrackStarted();
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------- Your DJ ---------------- */
  const djPresetRef = useRef<string | null>(null);

  /** Introduce a new direction once its first track plays: the DJ's voice, or a caption when commentary is off. */
  const introduce = (sess: DjSession, ack: boolean) => {
    const first = sess.items[0];
    if (!first) return;
    if (djRef.current.commentary === 'off') {
      if (ack) hostRef.current?.caption(switchAck(sess.segment));
      return;
    }
    const brk: DjBreak | null =
      sess.intro ?? (ack ? { id: `ack-${sess.segment.id}`, kind: 'segment-intro', text: switchAck(sess.segment), placement: 'over-intro', maxMs: 8000, audioUrl: null, durationMs: null } : null);
    if (brk) pendingIntroRef.current = { brk, itemId: first.id };
  };

  const startYourDj = useCallback(async (): Promise<{ ok: boolean; message?: string }> => {
    const a = apiRef.current;
    const d = djRef.current;
    if (!a) return { ok: false };
    if (!d.available) {
      if (!d.signedIn || !d.online) return { ok: false };
      // Status still unknown: ask now, and start straight away if the server says Your DJ is on.
      setYourDjStarting(true);
      try {
        const st = await a.djStatus();
        setDjStatus(st);
        if (!yourDjAvailability({ signedIn: true, online: true, status: st, forbidden: false, hasMusic: true }).available) {
          return { ok: false, message: "Your DJ is switched off on this server." };
        }
      } catch {
        recheckDjStatus();
        return { ok: false, message: "Couldn't reach your Vibe server. Try again in a moment." };
      } finally {
        setYourDjStarting(false);
      }
    }
    setYourDjStarting(true);
    try {
      const presetId = d.activePresetId;
      djPresetRef.current = presetId ?? null;
      const sess = await startSession(a, d.available, presetId);
      if (!sess) return { ok: false };
      const tracks = sess.items.filter((i) => i.type === 'track');
      if (!tracks.length) return { ok: false, message: sess.note || 'Your DJ needs a few more songs in your library to build a set.' };
      seedAnalyses(sess.analyses);
      abortBlend();
      abortGapRef.current(false);
      hostRef.current?.cancel();
      mixSourceRef.current = null;
      setShuffleState(false);
      setRepeat('off');
      setMixSession({ label: 'Your DJ' });
      setEndless(true);
      const started = { ...sess, items: tracks };
      dispatchDj({ type: 'start', session: started });
      pendingIntroRef.current = null;
      introduce(started, false);
      startOverride.current = null;
      loadedId.current = null;
      setQueue(tracks);
      setIndex(0);
      setReloadTick((n) => n + 1);
      return { ok: true };
    } catch (e) {
      if (isForbidden(e)) setAiForbidden(true);
      console.debug('[your dj] start failed', e);
      return { ok: false, message: "Your DJ isn't available right now. Try again in a moment." };
    } finally {
      setYourDjStarting(false);
    }
  }, [seedAnalyses, abortBlend, dispatchDj]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Apply a new direction (switch / request): it replaces what was coming up and starts with the next track. */
  const turnTo = (sess: DjSession) => {
    const tracks = sess.items.filter((i) => i.type === 'track');
    const i = stRef.current.index;
    if (!tracks.length) return;
    seedAnalyses(sess.analyses);
    abortGapRef.current(false);
    hostRef.current?.cancel();
    introduce({ ...sess, items: tracks }, true);
    setQueue((q) => switchQueue(q, i, tracks));
    abortBlend();
    // A short fade out of the current song, then the new segment.
    duckerRef.current.fadeOut(Date.now(), TURN_FADE_MS);
    duckDirtyRef.current = true;
    setDucking(true);
    setTimeout(() => {
      duckerRef.current.reset();
      if (stRef.current.index === i) {
        loadedId.current = null;
        setIndex(i + 1);
      }
      applyDuckRef.current();
    }, TURN_FADE_MS);
  };

  const djSwitch = useCallback(async () => {
    const dj = yourDjRef.current;
    const a = apiRef.current;
    if (!dj || dj.busy || !a || !djRef.current.aiOn) return;
    dispatchDj({ type: 'busy', busy: 'switch' });
    try {
      const st = stRef.current;
      const sess = await a.djSessionSwitch(dj.sessionId, { history: sessionHistory(st.queue, st.queue.length - 1), hour: new Date().getHours() });
      if (yourDjRef.current?.sessionId !== dj.sessionId) return;
      dispatchDj({ type: 'switch', session: sess });
      turnTo(sess);
    } catch (e) {
      // Silent: the set just carries on.
      if (isForbidden(e)) setAiForbidden(true);
      console.debug('[your dj] switch failed', e);
      dispatchDj({ type: 'busy', busy: null });
    }
  }, [dispatchDj]); // eslint-disable-line react-hooks/exhaustive-deps

  const djRequest = useCallback(async (text: string) => {
    const dj = yourDjRef.current;
    const a = apiRef.current;
    const q = text.trim();
    if (!dj || !q || dj.busy || !a || !djRef.current.aiOn) return;
    dispatchDj({ type: 'busy', busy: 'request' });
    const st = stRef.current;
    const result = await requestOrMiss(a, dj.sessionId, q, sessionHistory(st.queue, st.queue.length - 1));
    if (yourDjRef.current?.sessionId !== dj.sessionId) return;
    dispatchDj({ type: 'request', result });
    if ('id' in result && result.items?.length) turnTo(result);
  }, [dispatchDj]); // eslint-disable-line react-hooks/exhaustive-deps

  const djLove = useCallback((item: Item) => {
    const d = djRef.current;
    if (!d.signedIn || !d.online) return;
    apiRef.current?.djFeedback({ itemId: item.id, kind: 'love' }).catch(() => undefined);
  }, []);

  /** The listener moved on from a track early: DJ feedback ("not for me") for Your DJ and mixes. */
  const noteSkip = () => {
    const cur = currentRef.current;
    const a = apiRef.current;
    const d = djRef.current;
    if (!a || !cur || cur.type !== 'track' || !d.signedIn || !d.online || (!yourDjRef.current && !mixSession)) return;
    try {
      const p = livePlayer();
      if (isEarlySkip(p.currentTime * 1000, p.duration * 1000 || cur.durationMs || 0)) a.djFeedback({ itemId: cur.id, kind: 'skip' }).catch(() => undefined);
    } catch {
      /* ignore */
    }
  };

  // Play rules changed during Your DJ: what's coming up is re-picked within the new rules (the current song plays on).
  useEffect(() => {
    const dj = yourDjRef.current;
    const a = apiRef.current;
    const pid = activePresetId ?? null;
    if (!dj || !a || djPresetRef.current === pid) return;
    djPresetRef.current = pid;
    if (!djRef.current.aiOn) return;
    a.djSession(pid ? { presetId: pid, hour: new Date().getHours() } : { hour: new Date().getHours() })
      .then((sess) => {
        if (yourDjRef.current?.sessionId !== dj.sessionId) return;
        const tracks = sess.items.filter((t) => t.type === 'track');
        if (!tracks.length) {
          dispatchDj({ type: 'request', result: { ok: false, message: sess.note || 'Nothing in your library fits those rules yet, so I kept the current songs.' } });
          return;
        }
        seedAnalyses(sess.analyses);
        dispatchDj({ type: 'more', session: { ...sess, items: tracks } });
        const i = stRef.current.index;
        setQueue((q) => switchQueue(q, i, tracks));
      })
      .catch((e) => console.debug('[your dj] rules change', e));
  }, [activePresetId, dispatchDj, seedAnalyses]);

  const setHostMuted = useCallback((mu: boolean) => {
    hostRef.current?.setMuted(mu);
    setHostMutedState(mu);
    void setJSON(HOST_MUTE_KEY, mu).catch(() => undefined);
  }, []);

  /** A listener action that changes what plays (skip, seek, pause…): the host stops, a gap break ends. */
  const hostInterrupt = () => {
    abortGapRef.current(false);
    hostRef.current?.cancel();
  };

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
        hostInterrupt();
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
        // Play during a gap break: the talk is skipped and the next track starts.
        if (abortGapRef.current(true)) return;
        const p = livePlayer();
        if (p.playing) {
          hostInterrupt();
          abortBlend();
          p.pause();
          report('paused');
        } else p.play();
      },
      pause: () => {
        hostInterrupt();
        pauseAny();
      },
      next: () => {
        noteSkip();
        const inGap = !!gapRef.current;
        hostInterrupt();
        // Skipping during a blend completes it: the incoming track simply takes over.
        if (completeBlend()) return;
        if (inGap && swapAtEnd()) return;
        advance(1);
      },
      previous: () => {
        hostInterrupt();
        abortBlend();
        if ((castModeRef.current ? castPosRef.current / 1000 : livePlayer().currentTime) > 4) seekAny(0);
        else advance(-1);
      },
      seek: (ms) => {
        hostInterrupt();
        seekAny(ms);
      },
      jumpTo: (i, startMs) => {
        hostInterrupt();
        abortBlend();
        const target = queue[i];
        if (target && startMs != null) startOverride.current = { id: target.id, ms: startMs };
        loadedId.current = null;
        setIndex(i);
        // Same entry: the load effect would not re-run, so reload it.
        if (i === index) setReloadTick((n) => n + 1);
      },
      stop: () => {
        hostInterrupt();
        abortBlend();
        releaseStandby();
        dispatchDj({ type: 'end' });
        pendingIntroRef.current = null;
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
          else if (!blendRef.current) livePlayer().volume = clamp01(vol * gainRef.current * sleepFactorRef.current * duckNow());
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
          dispatchDj({ type: 'end' });
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
      yourDj,
      yourDjAvailability: yourDjAvail,
      yourDjChecking,
      yourDjStarting,
      startYourDj,
      djSwitch,
      djRequest,
      djDismiss: () => dispatchDj({ type: 'dismiss' }),
      djLove,
      djAi: {
        on: aiOn,
        radioHost: aiOn && djStatus?.ai?.radioHost !== false,
        weather: djStatus?.ai?.weather ?? null,
        serverVoice: !!djStatus?.ai?.serverVoice,
        hostName: djStatus?.ai?.hostName || null,
      },
      host: {
        ...hostState,
        muted: hostMuted,
        active: !!hostMode,
        skip: () => hostRef.current?.skip(),
        setMuted: setHostMuted,
      },
    }),
    [queue, index, current, status, durationMs, mode.longTrack, shuffle, repeat, error, spoken, rate, chapters, playQueue, livePlayer, report, advance, playing, castOn, castState, ours, cast.positionMs, cast.mediaStatus, cast.deviceName, seekAny, pauseAny, volume, sleep, sleepRemainingMs, setSleep, altSource,
      automixOn, automixPref, mixStyle, mixSession, playAsMix, endless, blend, abortBlend, completeBlend, releaseStandby, updatePreferences, user?.preferences.automix,
      yourDj, yourDjAvail, yourDjChecking, yourDjStarting, startYourDj, djSwitch, djRequest, djLove, dispatchDj, aiOn, djStatus, hostState, hostMuted, hostMode, setHostMuted, swapAtEnd],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMusic(): MusicValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMusic outside MusicProvider');
  return v;
}
