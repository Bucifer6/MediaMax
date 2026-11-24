import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Chapter, DjMixRequest, DjOrderRequest, DjOrderSource, DjTransition, DjTransitionPreference, Item, PlaybackInfo, TrackAnalysis, UserPreferences } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { errorMessage, withToken } from '../api/client';
import { attachStream } from './engine';
import { profileWithBitrate } from './deviceProfile';
import { absoluteUrl, CAST_OWNER_EVENT, castContentType, castDeviceProfile, castOwner, claimCast, useCast, type CastHandle, type CastOwner } from './cast';
import { isAlbumInOrder, MusicOutput, replayGainFactor, SUSPENDS_WEB_AUDIO_IN_BACKGROUND, type Deck } from './musicOutput';
import { useApp } from '../state/app';
import {
  AUTOMIX_DEFAULT, AUTOMIX_MAX_STRETCH, automixApplies, automixLabel, FIXED_FADE_MS, isGaplessJoin, phaseNudge, planAutomix, sanitizePlan,
} from './automix';
import { glideMs, matchRates, nativeKeyLock, transitionPoints } from './djMixer';
import { echoDelaySec } from './djStrip';
import { useToast } from '../state/toast';
import { findNextEpisode, shuffled, tracksFor } from '../utils/playback';
import { hasAudioResume, isAudio, isResumable, isVideo, playLink } from '../utils/items';
import { askState, createHostVoice, GAP_FADE_MS, RadioHost, talkWindowMs, type HostSnapshot } from './radioHost';
import { appendTracks, sessionHistory, switchAck, switchQueue, yourDjReducer, type YourDjAction, type YourDjState } from './yourDj';
import { djRulesPrefs, radioHostPrefs, yourDjCommentary, type DjBreak, type DjSession } from './djTypes';
import { PlayRulesHost } from '../components/PlayRules';

type Repeat = 'off' | 'all' | 'one';

/** Sleep timer: pause after a number of minutes, at the end of the current chapter, or at the end of the current part. */
export type SleepTimer =
  | { mode: 'time'; minutes: number; endsAt: number }
  | { mode: 'chapter'; itemId: string; endMs: number }
  | { mode: 'part' };
export type SleepOption = { minutes: number } | 'chapter' | 'part';
/** How long the volume fades out before the sleep timer pauses. */
const SLEEP_FADE_MS = 12000;
/** Start preparing the next track this long before the current one ends (plus the crossfade). */
const PRELOAD_LEAD_MS = 30000;
/** Gapless: below this much remaining time, schedule the exact handover with a timer. */
const HANDOVER_WINDOW_MS = 600;
/** Start the next element this much early to cover its output start-up latency. */
const HANDOVER_LEAD_MS = 8;
/** Radio: fetch more tracks when fewer than this many are left after the current one. */
const RADIO_LOW_WATER = 5;
/** Play as mix: page size for big sources (a whole library streams in batches). */
const MIX_PAGE = 50;

/** What "Play as mix" plays. */
export interface MixSource {
  /** "Mix: <label>" in the player. */
  label: string;
  /** Tracks in the source's own order (album, playlist, folder, My List, the queue). */
  items?: Item[];
  start?: number;
  /** Smart order (tempo, key, energy flow) from the server: a library, genre or artist, paged in batches. */
  source?: DjOrderSource;
  /** Put `items` in smart order instead of their own (Shuffle + Mix). */
  smart?: boolean;
}

/** A running Automix blend, for Now Playing ("Mixing into …"). */
export interface BlendState {
  into: Item;
  /** "Bass swap", "Filter fade", "Echo out", "Crossfade"… */
  label: string;
  /** 0–1. */
  progress: number;
}

/** Song / album / artist radio: an endless DJ-style mix seeded from one item, played through the normal queue. */
export interface RadioState {
  seedId: string;
  /** "Radio based on <title>". */
  label: string;
}

interface MusicApi {
  queue: Item[];
  index: number;
  current: Item | null;
  info: PlaybackInfo | null;
  playing: boolean;
  loading: boolean;
  positionMs: number;
  durationMs: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: Repeat;
  /** Chapters of the current item (audiobooks, podcasts with chapter marks). */
  chapters: Chapter[];
  /** `startMs` starts the first item at that position instead of its saved resume point. */
  playQueue: (items: Item[], start?: number, startMs?: number) => void;
  enqueue: (items: Item[], next?: boolean) => void;
  toggle: () => void;
  pause: () => void;
  next: () => void;
  prev: () => void;
  seek: (ms: number) => void;
  jump: (i: number, startMs?: number) => void;
  removeAt: (i: number) => void;
  clear: () => void;
  setVolume: (v: number) => void;
  setMuted: (m: boolean) => void;
  setShuffle: (s: boolean) => void;
  setRepeat: (r: Repeat) => void;
  /** Google Cast state (button shown when `cast.available`). */
  cast: CastHandle;
  /** The current track is playing on a Cast device. */
  casting: boolean;
  sleep: SleepTimer | null;
  setSleep: (opt: SleepOption | null) => void;
  /** Active radio, if the queue is a radio mix. */
  radio: RadioState | null;
  /** Start a radio mix seeded from a track, album or artist; `title` names it ("Radio based on <title>"). */
  startRadio: (seedId: string, title: string) => Promise<void>;
  /** Playback speed for audiobooks and podcasts (music always plays at 1×). Remembered per device. */
  rate: number;
  setRate: (r: number) => void;
  /** Local audio output hooks for lyrics, karaoke and visualisers (stable object). */
  output: MusicOutputApi;
  /** The live deck plays an alternative source (karaoke stem mix) instead of the track's own stream. */
  altSource: string | null;
  /** Automix (lite DJ) is on: tracks blend like one continuous mix. The preference, or forced on by "Play as mix". */
  automix: boolean;
  /** Turn Automix on/off (saved as the listener's preference; off also ends a "Play as mix" session). */
  setAutomix: (on: boolean) => void;
  /** Automix transition feel (saved preference). */
  mixStyle: DjTransitionPreference;
  setMixStyle: (s: DjTransitionPreference) => void;
  /** "Play as mix" session, if one is running. */
  mix: { label: string } | null;
  /** Play a music source as a continuous mix (Automix on for the session, Endless on). */
  playAsMix: (source: MixSource) => Promise<void>;
  /** Endless: when the mix runs out, keep going with similar tracks from the library (server only, no AI). */
  endless: boolean;
  setEndless: (on: boolean) => void;
  /** The running blend ("Mixing into …"), null between transitions. */
  blend: BlendState | null;
  /** Your DJ session, when the queue is one (segments, reasons, busy state, gentle messages). */
  yourDj: YourDjState | null;
  /** A Your DJ session is being started (the card shows progress). */
  yourDjStarting: boolean;
  /** One tap: a personal set from the library, played as an endless Automix mix. */
  startYourDj: () => Promise<void>;
  /** "Switch it up": a different segment, starting with the next track. */
  djSwitch: () => Promise<void>;
  /** A typed request ("something upbeat from the 90s"); no match = a gentle message, the set carries on. */
  djRequest: (text: string) => Promise<void>;
  djDismiss: () => void;
  /** Like a track: favourite + DJ feedback (steers Your DJ and mixes). */
  djLove: (item: Item) => void;
  /** Radio Host / Your DJ voice: captions while it talks, skip talk, mute. */
  host: HostSnapshot & { muted: boolean; skip: () => void; setMuted: (m: boolean) => void; active: boolean };
}

export interface MusicOutputApi {
  /** Precise media position of the live deck (ms), for per-frame lyrics / visualisers. */
  timeMs: () => number;
  /** Audio output latency (ms). */
  latencyMs: () => number;
  /** Analyser tapped (fan-out) after the output chain; null when Web Audio isn't in use. */
  analyser: () => AnalyserNode | null;
  /** Create / resume the Web Audio graph (call from a user gesture). Returns whether Web Audio is active. */
  ensureGraph: () => boolean;
  /** Quick karaoke vocal level 0..1 (1 = off). */
  setVocalLevel: (level: number) => void;
  /** Play `url` (a seekable audio file, e.g. the server's karaoke mix) on the live deck from the current position; null = back to the normal stream. */
  setAltSource: (url: string | null) => Promise<void>;
}

const Ctx = createContext<MusicApi | null>(null);
/**
 * Stable actions for components that start playback but don't show player state (every poster card via
 * usePlayItem). The full context changes on every timeupdate while something plays, which re-rendered each card on
 * screen four times a second; this one never changes.
 */
type MusicActions = Pick<MusicApi, 'playQueue' | 'playAsMix' | 'startYourDj'>;
const ActionsCtx = createContext<MusicActions | null>(null);
export function useMusic(): MusicApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMusic outside provider');
  return v;
}

const VOL_KEY = 'mm.volume';
const HOST_MUTE_KEY = 'vibe.host.muted';
/** A skip this early in a track counts as "not for me" (DJ feedback). */
const SKIP_FEEDBACK_MS = 30000;
function loadHostMuted() {
  try {
    return localStorage.getItem(HOST_MUTE_KEY) === '1';
  } catch {
    return false;
  }
}
const RATE_KEY = 'vibe.spokenRate';
function loadRate() {
  try {
    const v = Number(localStorage.getItem(RATE_KEY));
    return v >= 0.5 && v <= 3 ? v : 1;
  } catch {
    return 1;
  }
}
function loadVolume() {
  try {
    const v = Number(localStorage.getItem(VOL_KEY));
    return isFinite(v) && v > 0 && v <= 1 ? v : 0.9;
  } catch {
    return 0.9;
  }
}

export function MusicProvider({ children }: { children: ReactNode }) {
  const outRef = useRef<MusicOutput | null>(null);
  if (!outRef.current && typeof Audio !== 'undefined') {
    outRef.current = new MusicOutput((el) => {
      // Lets DJ mode step aside when normal music starts (detached elements' events don't reach the document).
      el.addEventListener('play', () => window.dispatchEvent(new Event('mediamax:media-play')));
    });
  }
  const out = outRef.current;
  const toast = useToast();
  const [queue, setQueue] = useState<Item[]>([]);
  const [index, setIndex] = useState(-1);
  const [info, setInfo] = useState<PlaybackInfo | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [positionMs, setPosition] = useState(0);
  const [durationMs, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(loadVolume);
  const [muted, setMuted] = useState(false);
  const [shuffle, setShuffleState] = useState(false);
  const [repeat, setRepeat] = useState<Repeat>('off');
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [sleep, setSleepState] = useState<SleepTimer | null>(null);
  const [radio, setRadio] = useState<RadioState | null>(null);
  const [rate, setRateState] = useState(loadRate);
  /** Requested start position for the next track load (bookmarks). */
  const startAtRef = useRef<{ id: string; ms: number } | null>(null);
  /** Load the next track paused (sleep timer "end of part"). */
  const holdRef = useRef(false);
  /** The live deck already plays this queue entry (gapless / crossfade handover): the load effect adopts it. */
  const adoptRef = useRef<{ itemId: string; index: number } | null>(null);
  /** A handover is scheduled or running (don't start another). */
  const handoverRef = useRef<{ timer: number | null; fromDeck: 0 | 1 } | null>(null);
  /** Sleep-timer fade factor (0–1) applied on top of the volume. */
  const sleepFactorRef = useRef(1);
  const { system, user, setUser } = useApp();
  const crossfadeSec = Math.max(0, Math.min(12, user?.preferences.musicCrossfadeSec ?? 0));
  const rgMode = user?.preferences.replayGain ?? 'auto';
  /* Automix (lite DJ) */
  const automixPref = user?.preferences.automix ?? AUTOMIX_DEFAULT;
  const mixStyle: DjTransitionPreference = user?.preferences.automixStyle ?? 'auto';
  const [mixSession, setMixSession] = useState<{ label: string } | null>(null);
  const automixOn = !!mixSession || automixPref;
  const [endless, setEndless] = useState(true);
  const [blend, setBlend] = useState<BlendState | null>(null);
  /* Your DJ */
  const [yourDj, setYourDjState] = useState<YourDjState | null>(null);
  const yourDjRef = useRef<YourDjState | null>(null);
  const dispatchDj = useCallback((a: YourDjAction) => {
    yourDjRef.current = yourDjReducer(yourDjRef.current, a);
    setYourDjState(yourDjRef.current);
  }, []);
  const [yourDjStarting, setYourDjStarting] = useState(false);
  const commentary = yourDjCommentary(user?.preferences);
  const hostPrefs = radioHostPrefs(user?.preferences);
  const activePresetId = djRulesPrefs(user?.preferences).activePresetId ?? null;
  /** Who talks between tracks: Your DJ (commentary Full), the Radio Host (any other music), or nobody. */
  const hostMode: 'radio' | 'yourdj' | null = yourDj ? (commentary === 'full' ? 'yourdj' : null) : hostPrefs.enabled ? 'radio' : null;
  const current = index >= 0 ? queue[index] ?? null : null;
  const stateRef = useRef({ queue, index, repeat, durationMs, positionMs, chapters, volume, muted, sleep, shuffle, crossfadeSec, rgMode, radio, automixOn, mixStyle, endless, hostMode, hostVoice: hostPrefs.voice ?? null, commentary, activePresetId, mixSession });
  stateRef.current = { queue, index, repeat, durationMs, positionMs, chapters, volume, muted, sleep, shuffle, crossfadeSec, rgMode, radio, automixOn, mixStyle, endless, hostMode, hostVoice: hostPrefs.voice ?? null, commentary, activePresetId, mixSession };
  const playingRef = useRef(playing);
  playingRef.current = playing;
  /** Karaoke: the live deck plays this URL instead of the track's stream. */
  const altRef = useRef<{ itemId: string; url: string } | null>(null);
  const [altSource, setAltSourceState] = useState<string | null>(null);

  /** Music decks whose playback rate an Automix blend or tempo glide controls right now. */
  const rateHoldRef = useRef(new Set<0 | 1>());
  /** Route audio through Web Audio (gain ramps, ReplayGain boost) — except on iOS unless crossfade is on. */
  const wantGraph = () => !SUSPENDS_WEB_AUDIO_IN_BACKGROUND || stateRef.current.crossfadeSec > 0;
  /** The live deck's element (null during SSR). */
  const liveEl = () => out?.active.el ?? null;

  /* ---------------- Radio Host / Your DJ voice ---------------- */
  const [hostState, setHostState] = useState<HostSnapshot>({ caption: null, speaking: false, kind: null });
  const [hostMuted, setHostMutedState] = useState(loadHostMuted);
  const hostRef = useRef<RadioHost | null>(null);
  if (!hostRef.current && typeof window !== 'undefined') {
    hostRef.current = new RadioHost({
      now: () => performance.now(),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (t) => window.clearTimeout(t as number),
      fetchBreak: (req, signal) => api.dj.hostBreak(req, signal).then((r) => r?.break ?? null),
      prepareVoice: (brk, signal) => createHostVoice(brk, stateRef.current.hostVoice, signal, withToken),
      duck: (a, b, g, r) => out?.duck(a, b, g, r) ?? false,
      unduck: (r) => out?.unduck(r),
      volume: () => (stateRef.current.muted ? 0 : stateRef.current.volume),
      onState: setHostState,
      // Silent fallback: never a toast, never an interruption.
      log: (...a) => console.debug(...a),
    });
    hostRef.current.setMuted(loadHostMuted());
  }
  const host = hostRef.current;
  /** Transitions already asked about (once per pair and queue position). */
  const hostAskedRef = useRef(new Set<string>());
  const hostKey = (a: Item, b: Item, i: number) => `${a.id}>${b.id}@${i}`;
  /** A gap break is running: the outgoing deck is paused on purpose (key), or the listener paused during it. */
  const gapRef = useRef<string | null>(null);
  const gapPausedRef = useRef(false);
  /** A Your DJ intro / acknowledgement to play once the next track has started. */
  const pendingIntroRef = useRef<{ brk: DjBreak; itemId: string } | null>(null);

  // Spoken-word speed: both decks (defaultPlaybackRate survives a source change); music stays at 1×.
  const spoken = current?.type === 'bookpart' || current?.type === 'podcastepisode';
  useEffect(() => {
    const r = spoken ? rate : 1;
    for (const d of out?.decks ?? []) {
      d.el.defaultPlaybackRate = r;
      // An Automix blend / tempo glide owns a music deck's rate until it ends.
      if (!spoken && rateHoldRef.current.has(d.id)) continue;
      d.el.playbackRate = r;
    }
  }, [out, rate, spoken, current?.id]);

  /* ---------------- output levels ---------------- */
  const applyMaster = useCallback(() => {
    const st = stateRef.current;
    out?.setMaster(st.muted ? 0 : st.volume * sleepFactorRef.current);
  }, [out]);

  /** ReplayGain for the item loaded on a deck, in the current queue context. */
  const deckGain = useCallback((d: Deck) => {
    const st = stateRef.current;
    const item = st.queue[d.queueIndex]?.id === d.itemId ? st.queue[d.queueIndex] : st.queue.find((q) => q.id === d.itemId);
    return replayGainFactor(item, st.rgMode, isAlbumInOrder(st.queue, item ?? null, st.shuffle));
  }, []);

  /* ---------------- Google Cast ---------------- */
  // The SDK is only loaded once something is playing.
  const cast = useCast(!!current);
  const castRef = useRef(cast);
  castRef.current = cast;
  const castingRef = useRef(false);
  const castSidRef = useRef<string | null>(null);
  const castOffsetRef = useRef(0);
  const [casting, setCasting] = useState(false);
  const castEndHandled = useRef<string | null>(null);

  const reportCast = useCallback((state: 'playing' | 'paused' | 'stopped', keepalive = false) => {
    const sid = castSidRef.current;
    if (!sid) return;
    const pos = castOffsetRef.current + castRef.current.remote.currentTime * 1000;
    api.playback.progress(sid, { positionMs: Math.round(pos), durationMs: stateRef.current.durationMs || undefined, state, sessionId: sid }, keepalive).catch(() => {});
  }, []);
  const endCastSession = useCallback((keepalive = false) => {
    const sid = castSidRef.current;
    if (!sid) return;
    reportCast('stopped', keepalive);
    api.playback.stop(sid, keepalive).catch(() => {});
    castSidRef.current = null;
  }, [reportCast]);

  /** Play `item` on the Cast device from `startMs`. */
  const castTrackRef = useRef<(item: Item, startMs: number) => Promise<void>>(async () => {});
  castTrackRef.current = async (item: Item, startMs: number) => {
    endCastSession();
    const pi = await api.playback.start(item.id, { startMs: startMs || undefined, deviceProfile: castDeviceProfile(null, true) });
    if (!castingRef.current) {
      api.playback.stop(pi.sessionId).catch(() => {});
      return;
    }
    castSidRef.current = pi.sessionId;
    castOffsetRef.current = pi.streamStartMs ?? 0;
    castEndHandled.current = null;
    setInfo(pi);
    setPosition(startMs);
    const base = system?.publicUrl;
    claimCast('music');
    await castRef.current.load({
      url: absoluteUrl(pi.url, base)!,
      contentType: castContentType(pi.mimeType, pi.isHls),
      kind: item.type === 'track' ? 'music' : 'generic',
      title: pi.title || item.title,
      subtitle: pi.subtitle ?? item.grandparentTitle ?? item.parentTitle ?? null,
      album: item.type === 'track' ? item.parentTitle : null,
      imageUrl: absoluteUrl(pi.posterUrl ?? item.posterUrl ?? item.thumbUrl, base),
      startSeconds: Math.max(0, (startMs - castOffsetRef.current) / 1000),
    });
    reportCast('playing');
  };

  /* ---------------- deck sessions ---------------- */
  const reportDeck = useCallback((d: Deck, state: 'playing' | 'paused' | 'stopped', keepalive = false) => {
    const sid = d.sessionId;
    if (!sid) return;
    api.playback
      .progress(sid, { positionMs: Math.round(d.offsetMs + d.el.currentTime * 1000), durationMs: (d.info?.durationMs ?? stateRef.current.durationMs) || undefined, state, sessionId: sid }, keepalive)
      .catch(() => {});
  }, []);
  const report = useCallback((state: 'playing' | 'paused' | 'stopped', keepalive = false) => {
    if (out) reportDeck(out.active, state, keepalive);
  }, [out, reportDeck]);

  /** Stop a deck: end its server session and detach its stream. `report` = it was heard (send a final progress). */
  const releaseDeck = useCallback((d: Deck, keepalive = false) => {
    d.token++;
    if (rateHoldRef.current.delete(d.id)) d.el.playbackRate = d.el.defaultPlaybackRate || 1;
    const sid = d.sessionId;
    if (sid) {
      // Only a deck that actually played reports progress; a preloaded one never started.
      if (d.el.currentTime > 0) reportDeck(d, 'stopped', keepalive);
      api.playback.stop(sid, keepalive).catch(() => {});
    }
    d.sessionId = null;
    d.attached?.destroy();
    d.attached = null;
    d.info = null;
    d.itemId = null;
    d.queueIndex = -1;
    d.pendingSeek = null;
    d.ready = false;
  }, [reportDeck]);

  const stopSession = useCallback((keepalive = false) => {
    if (out) releaseDeck(out.active, keepalive);
  }, [out, releaseDeck]);

  /* ---------------- Automix blends ---------------- */
  const blendRef = useRef<{
    from: Deck; to: Deck; n: number; into: Item; label: string; tr: DjTransition; inRate: number; outRate: number;
    token: number; durMs: number; startedAt: number; timers: number[];
  } | null>(null);
  const glideRef = useRef<number | null>(null);
  const clearBlendTimers = (b: { timers: number[] }) => b.timers.forEach((t) => window.clearTimeout(t));

  /** Glide a tempo-matched deck back to its own tempo over `ms` (the key stays: preservesPitch). */
  const glideHome = useCallback((d: Deck, ms: number) => {
    const stop = () => {
      if (glideRef.current != null) window.clearInterval(glideRef.current);
      glideRef.current = null;
    };
    stop();
    const from = d.el.playbackRate;
    const tok = d.token;
    const t0 = performance.now();
    glideRef.current = window.setInterval(() => {
      if (d.token !== tok) return stop();
      const x = Math.min(1, (performance.now() - t0) / Math.max(500, ms));
      d.el.playbackRate = from + (1 - from) * x;
      if (x >= 1) {
        rateHoldRef.current.delete(d.id);
        stop();
      }
    }, 250);
  }, []);

  /** Cut a blend (seek, pause, track change): the outgoing deck stays at full level, the incoming one is dropped. */
  const abortBlend = useCallback(() => {
    const b = blendRef.current;
    if (!b || !out) return;
    blendRef.current = null;
    clearBlendTimers(b);
    setBlend(null);
    if (handoverRef.current?.fromDeck === b.from.id) handoverRef.current = null;
    out.endBlend();
    out.setFade(b.from.id, 1);
    if (rateHoldRef.current.delete(b.from.id)) b.from.el.playbackRate = 1;
    if (b.to.token === b.token && out.active !== b.to) {
      b.to.el.pause();
      releaseDeck(b.to);
      out.setFade(b.to.id, 0);
    }
  }, [out, releaseDeck]);

  /** Finish a blend now (it ran its course, or the listener skipped): the incoming track takes over. */
  const completeBlend = useCallback(() => {
    const b = blendRef.current;
    if (!b || !out) return;
    blendRef.current = null;
    clearBlendTimers(b);
    setBlend(null);
    handoverRef.current = null;
    out.endBlend();
    if (b.to.token !== b.token) return; // the incoming deck was reloaded meanwhile
    b.from.el.pause();
    releaseDeck(b.from);
    out.setFade(b.from.id, 1);
    if (out.active === b.from) out.swap();
    b.to.queueIndex = b.n;
    adoptRef.current = { itemId: b.into.id, index: b.n };
    setIndex(b.n);
    setInfo(b.to.info);
    setPosition(b.to.offsetMs + b.to.el.currentTime * 1000);
    setDuration(b.to.info?.durationMs ?? b.into.durationMs ?? 0);
    // Back to its own tempo over 16 bars (its bpm = the outgoing beat's bpm / the ratio).
    if (Math.abs(b.to.el.playbackRate - 1) > 0.001) {
      const bpmIn = b.tr.beatMs ? 60000 / b.tr.beatMs / (b.tr.tempoRatio || 1) : null;
      glideHome(b.to, glideMs(16, bpmIn, b.to.el.playbackRate));
    } else rateHoldRef.current.delete(b.to.id);
  }, [out, releaseDeck, glideHome]);

  /** Cancel a scheduled handover and silence the deck that is fading out, if any. */
  const cancelHandover = useCallback(() => {
    if (blendRef.current) abortBlend();
    const h = handoverRef.current;
    if (!h || !out) return;
    if (h.timer != null) window.clearTimeout(h.timer);
    handoverRef.current = null;
    const from = out.decks[h.fromDeck];
    if (from !== out.active) {
      from.el.pause();
      releaseDeck(from);
      out.setFade(from.id, 1);
    }
  }, [out, releaseDeck, abortBlend]);

  /** Attach `item` to deck `d`. Returns false when superseded or failed. */
  const loadDeck = useCallback(async (d: Deck, item: Item, queueIndex: number, startMs: number, onFatal: (msg: string) => void): Promise<boolean> => {
    releaseDeck(d);
    const token = ++d.token;
    d.itemId = item.id;
    d.queueIndex = queueIndex;
    const pi = await api.playback.start(item.id, { startMs: startMs || undefined, deviceProfile: profileWithBitrate(null) });
    if (token !== d.token || castingRef.current) {
      api.playback.stop(pi.sessionId).catch(() => {});
      return false;
    }
    d.sessionId = pi.sessionId;
    d.offsetMs = pi.streamStartMs ?? 0;
    d.pendingSeek = startMs > 0 ? startMs : null;
    d.info = pi;
    d.attached = await attachStream(d.el, pi, { onFatal: (_k, msg) => (token === d.token ? onFatal(msg) : undefined) });
    if (token !== d.token) return false;
    d.ready = true;
    return true;
  }, [releaseDeck]);

  const setMediaSession = (item: Item, pi: PlaybackInfo | null) => {
    if (!('mediaSession' in navigator)) return;
    const art = pi?.posterUrl || item.posterUrl;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: pi?.title || item.title,
      artist: pi?.subtitle ?? item.grandparentTitle ?? item.parentTitle ?? '',
      album: item.parentTitle ?? '',
      artwork: art ? [{ src: art, sizes: '512x512' }] : [],
    });
  };

  // Load the current track.
  useEffect(() => {
    if (!out) return;
    const d = out.active;
    if (altRef.current && altRef.current.itemId !== current?.id) {
      altRef.current = null;
      setAltSourceState(null);
    }
    if (!current) {
      adoptRef.current = null;
      cancelHandover();
      releaseDeck(out.standby);
      stopSession();
      if (castingRef.current && castSidRef.current) castRef.current.stop();
      endCastSession();
      setInfo(null);
      setPlaying(false);
      return;
    }
    setChapters(current.chapters ?? []);
    // Gapless / crossfade handover: the live deck already plays this entry.
    const adopt = adoptRef.current;
    if (adopt && adopt.itemId === current.id && adopt.index === index && d.itemId === current.id) {
      adoptRef.current = null;
      setInfo(d.info);
      setDuration(d.info?.durationMs ?? current.durationMs ?? 0);
      setPosition(d.offsetMs + d.el.currentTime * 1000);
      setLoading(false);
      setMediaSession(current, d.info);
      return;
    }
    adoptRef.current = null;
    cancelHandover();
    if (!host?.current?.key.startsWith('now:')) host?.cancel();
    let cancelled = false;
    setLoading(true);
    setPosition(0);
    setDuration(current.durationMs ?? 0);
    const startAt = startAtRef.current?.id === current.id ? startAtRef.current.ms : null;
    startAtRef.current = null;
    const resumeMs = startAt ?? (hasAudioResume(current) && isResumable(current) ? current.userData.positionMs : 0);
    (async () => {
      try {
        // Next/previous onto the track the standby deck has already prepared: swap decks, no reload.
        const sb = out.standby;
        if (!castingRef.current && startAt == null && !hasAudioResume(current) && sb.ready && sb.itemId === current.id) {
          d.el.pause();
          stopSession();
          out.swap();
          sb.queueIndex = index;
          out.setFade(sb.id, 1);
          out.setReplayGain(sb.id, deckGain(sb));
          setInfo(sb.info);
          if (sb.el.currentTime > 0) sb.el.currentTime = 0;
          if (holdRef.current) {
            holdRef.current = false;
            setPlaying(false);
          } else await sb.el.play().catch(() => setPlaying(false));
          setMediaSession(current, sb.info);
          return;
        }
        d.el.pause();
        stopSession();
        // Pick up the latest saved position (the queued copy may be stale) and the chapters,
        // which are only included on GET /items/:id.
        let startMs = resumeMs;
        if (hasAudioResume(current)) {
          const fresh = await api.items.get(current.id).catch(() => null);
          if (fresh) {
            if (startAt == null) startMs = isResumable(fresh) ? fresh.userData.positionMs : 0;
            if (!cancelled && fresh.chapters) setChapters(fresh.chapters);
          }
        }
        if (cancelled) return;
        if (castingRef.current) {
          endCastSession();
          await castTrackRef.current(current, startMs);
          return;
        }
        const ok = await loadDeck(d, current, index, startMs, (msg) => {
          toast.error(`Can't play "${current.title}": ${msg}`);
          setPlaying(false);
        });
        if (!ok || cancelled) return;
        setInfo(d.info);
        out.setFade(d.id, 1);
        out.setReplayGain(d.id, deckGain(d));
        if (holdRef.current) {
          holdRef.current = false;
          setPlaying(false);
        } else await d.el.play().catch(() => setPlaying(false));
        setMediaSession(current, d.info);
      } catch (e) {
        if (!cancelled) {
          toast.error(`Playback failed: ${errorMessage(e)}`);
          setPlaying(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, index]);

  /** Seek in media time; restarts the stream when the target is before a mid-file transcode start. */
  const seekRef = useRef<(ms: number) => void>(() => {});
  seekRef.current = (ms: number) => {
    const cur = stateRef.current.queue[stateRef.current.index];
    if (!out || !cur) return;
    if (castingRef.current) {
      castRef.current.seek(Math.max(0, (ms - castOffsetRef.current) / 1000));
      setPosition(ms);
      return;
    }
    abortGap(true);
    host?.cancel();
    cancelHandover();
    const d = out.active;
    const a = d.el;
    const local = (ms - d.offsetMs) / 1000;
    if (local >= 0 && (!d.info?.isHls || (a.seekable.length && local <= a.seekable.end(a.seekable.length - 1) + 1))) {
      a.currentTime = local;
      return;
    }
    // Outside what the stream covers: ask the server for a new stream at that point.
    void (async () => {
      try {
        const ok = await loadDeck(d, cur, stateRef.current.index, Math.round(ms), (msg) => toast.error(msg));
        if (!ok) return;
        setInfo(d.info);
        await a.play().catch(() => setPlaying(false));
      } catch (e) {
        toast.error(e);
      }
    })();
  };

  /** Switch the live deck to / from an alternative source (karaoke mix), keeping the position. */
  const altSourceRef = useRef<(url: string | null) => Promise<void>>(async () => {});
  altSourceRef.current = async (url: string | null) => {
    const cur = stateRef.current.queue[stateRef.current.index];
    if (!out || !cur || castingRef.current) return;
    const same = url ? altRef.current?.url === url && altRef.current.itemId === cur.id : !altRef.current;
    if (same) return;
    const d = out.active;
    const pos = d.offsetMs + d.el.currentTime * 1000;
    const wasPlaying = !d.el.paused;
    if (url) {
      altRef.current = { itemId: cur.id, url };
      d.attached?.destroy();
      d.attached = null;
      d.offsetMs = 0;
      d.pendingSeek = pos;
      if (d.info) d.info = { ...d.info, isHls: false };
      d.el.src = withToken(url);
      setAltSourceState(url);
      if (wasPlaying) await d.el.play().catch(() => setPlaying(false));
      return;
    }
    altRef.current = null;
    setAltSourceState(null);
    try {
      const ok = await loadDeck(d, cur, stateRef.current.index, Math.round(pos), (msg) => toast.error(msg));
      if (ok) {
        setInfo(d.info);
        if (wasPlaying) await d.el.play().catch(() => setPlaying(false));
      }
    } catch (e) {
      toast.error(e);
    }
  };
  const outputApi = useMemo<MusicOutputApi>(() => ({
    timeMs: () => {
      const d = out?.active;
      return d ? d.offsetMs + d.el.currentTime * 1000 : 0;
    },
    latencyMs: () => out?.latencyMs ?? 0,
    analyser: () => out?.analyser ?? null,
    ensureGraph: () => {
      out?.prime(true);
      return !!out?.webAudio;
    },
    setVocalLevel: (v: number) => out?.setVocalLevel(v),
    setAltSource: (url: string | null) => altSourceRef.current(url),
  }), [out]);

  /** End a running gap break early (seek, skip): the outgoing deck back to full; `resume` = play it on. */
  const abortGap = useCallback((resume: boolean) => {
    if (!gapRef.current || !out) return;
    gapRef.current = null;
    gapPausedRef.current = false;
    handoverRef.current = null;
    host?.cancel();
    out.setFade(out.active.id, 1);
    if (resume) void out.active.el.play().catch(() => setPlaying(false));
  }, [out, host]);

  /** The listener moved on from a track early: DJ feedback ("not for me"), for Your DJ and mixes. */
  const noteSkip = () => {
    const st = stateRef.current;
    const cur = st.queue[st.index];
    if (!cur || cur.type !== 'track' || (!yourDjRef.current && !st.mixSession && !st.radio)) return;
    if (st.positionMs < SKIP_FEEDBACK_MS && (!st.durationMs || st.positionMs < st.durationMs - 3000)) api.dj.feedback({ itemId: cur.id, kind: 'skip' }).catch(() => {});
  };

  const goto = useCallback((i: number) => {
    const { queue: q } = stateRef.current;
    if (i < 0 || i >= q.length) return;
    setIndex(i);
  }, []);

  /** Queue position that follows the current one (-1 = none). */
  const nextIndexOf = useCallback(() => {
    const { queue: q, index: i, repeat: r } = stateRef.current;
    if (i + 1 < q.length) return i + 1;
    if (r === 'all' && q.length) return 0;
    return -1;
  }, []);

  const next = useCallback(() => {
    out?.prime(wantGraph());
    if (gapRef.current) {
      // Skipping during a gap break: the host stops, the next track starts now.
      gapRef.current = null;
      gapPausedRef.current = false;
      handoverRef.current = null;
    }
    host?.cancel();
    noteSkip();
    // Skipping during an Automix blend completes it: the incoming track simply takes over.
    if (blendRef.current) {
      completeBlend();
      return;
    }
    const n = nextIndexOf();
    const { queue: q, index: i } = stateRef.current;
    if (n >= 0 && n === i && q[n]) {
      // One-track queue on repeat "all": the index doesn't change, so the load effect wouldn't run. Restart it here.
      if (castingRef.current) void castTrackRef.current(q[n]!, 0).catch(() => undefined);
      else {
        seekRef.current(0);
        void liveEl()?.play().catch(() => setPlaying(false));
      }
    } else if (n >= 0) setIndex(n);
    else {
      cancelHandover();
      liveEl()?.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextIndexOf, cancelHandover, completeBlend, out]);

  const prev = useCallback(() => {
    out?.prime(wantGraph());
    abortGap(false);
    host?.cancel();
    const a = liveEl();
    if (castingRef.current) {
      const pos = castOffsetRef.current + castRef.current.remote.currentTime * 1000;
      if (pos > 4000 || stateRef.current.index <= 0) seekRef.current(0);
      else setIndex(stateRef.current.index - 1);
      return;
    }
    const off = out?.active.offsetMs ?? 0;
    if (a && off + a.currentTime * 1000 > 4000) {
      if (off) seekRef.current(0);
      else a.currentTime = 0;
      return;
    }
    const { index: i } = stateRef.current;
    if (i > 0) setIndex(i - 1);
    else if (a) a.currentTime = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [out]);

  /* ---------------- gapless & crossfade ---------------- */
  /** Should the move from `a` to `b` crossfade (vs. a plain gapless join)? Albums played in order stay gapless. */
  const fadeSecFor = useCallback((a: Item | undefined, b: Item | undefined) => {
    const st = stateRef.current;
    // Automix plans its own blends (or a gapless join); the fixed crossfade setting applies when it's off.
    if (automixActive() && automixApplies(a, b)) return 0;
    if (!st.crossfadeSec || !a || !b || a.type !== 'track' || b.type !== 'track') return 0;
    if (!st.shuffle && a.parentId && a.parentId === b.parentId) return 0;
    const shortest = Math.min(a.durationMs || Infinity, b.durationMs || Infinity) / 1000;
    return Math.max(0, Math.min(st.crossfadeSec, shortest / 3));
  }, []);

  /* ---------------- Automix plans ---------------- */
  /** Automix runs on Web Audio (it needs gain automation); on iOS only where the graph is in use (see wantGraph). */
  const automixActive = () => stateRef.current.automixOn && (!SUSPENDS_WEB_AUDIO_IN_BACKGROUND || !!out?.webAudio);
  /** Analyses already loaded (synchronous reads for the host's gap timing). */
  const resolvedAnalysesRef = useRef(new Map<string, TrackAnalysis>());
  /** Track analysis per item (server's own API; on-demand analysis there), shared by planning and gapless checks. */
  const analysesRef = useRef(new Map<string, Promise<TrackAnalysis | null>>());
  const analysisFor = useCallback((id: string) => {
    const m = analysesRef.current;
    let p = m.get(id);
    if (!p) {
      p = api.dj.analysis(id).catch(() => null);
      p.then((a) => {
        if (a) resolvedAnalysesRef.current.set(id, a);
      });
      m.set(id, p);
      if (m.size > 500) m.delete(m.keys().next().value!);
    }
    return p;
  }, []);
  const seedAnalyses = useCallback((list: Record<string, TrackAnalysis | null> | { item: Item; analysis: TrackAnalysis | null }[]) => {
    const m = analysesRef.current;
    const entries = Array.isArray(list) ? list.map((t) => [t.item.id, t.analysis] as const) : Object.entries(list);
    for (const [id, a] of entries) {
      if (!a) continue;
      m.set(id, Promise.resolve(a));
      resolvedAnalysesRef.current.set(id, a);
    }
  }, []);
  /** The plan for the move from the current track to the next: tr = null means a gapless join. */
  const planRef = useRef<{ key: string; ready: boolean; tr: DjTransition | null } | null>(null);
  const serverPlansRef = useRef(true);
  const planKey = (a: Item, b: Item) => `${a.id}>${b.id}>${stateRef.current.mixStyle}>${stateRef.current.shuffle ? 1 : 0}`;
  const planFor = (a: Item | undefined, b: Item | undefined) => {
    const p = planRef.current;
    return a && b && p?.key === planKey(a, b) ? p : null;
  };
  const nextId = queue[nextIndexOf()]?.id;
  useEffect(() => {
    const a = queue[index];
    const b = queue[nextIndexOf()];
    if (!automixOn || !a || !b || !automixApplies(a, b) || repeat === 'one') {
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
          tr = await api.dj.transitions({ pairs: [{ from: a.id, to: b.id }], transitions: style, maxStretchPct: AUTOMIX_MAX_STRETCH * 100 })
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
  }, [current?.id, nextId, automixOn, mixStyle, shuffle, repeat]);

  const preloadingRef = useRef(false);
  /** Prepare the next queue entry on the standby deck (music only, local playback). */
  const maybePreload = useCallback(() => {
    if (!out || castingRef.current || preloadingRef.current || handoverRef.current) return;
    const st = stateRef.current;
    if (st.repeat === 'one' || st.sleep?.mode === 'part') return;
    const n = nextIndexOf();
    const item = st.queue[n];
    const cur = st.queue[st.index];
    if (!item || !cur || hasAudioResume(item) || hasAudioResume(cur)) return;
    const sb = out.standby;
    if (sb.itemId === item.id && (sb.ready || sb.sessionId)) return;
    const d = out.active;
    const remaining = (d.el.duration - d.el.currentTime) * 1000;
    if (!Number.isFinite(remaining)) return;
    let startMs = 0;
    if (automixActive() && automixApplies(cur, item)) {
      // Automix: prepared ahead of the planned mix-out point, already at the incoming track's mix-in point.
      const plan = planFor(cur, item);
      const tr = plan?.ready ? plan.tr : null;
      if (tr) {
        if (tr.mixOutMs - (d.offsetMs + d.el.currentTime * 1000) > PRELOAD_LEAD_MS) return;
        startMs = tr.mixInMs;
      } else if (remaining > PRELOAD_LEAD_MS) return;
    } else if (remaining > PRELOAD_LEAD_MS + fadeSecFor(cur, item) * 1000) return;
    preloadingRef.current = true;
    out.setFade(sb.id, 0);
    loadDeck(sb, item, n, startMs, () => releaseDeck(sb))
      .then((ok) => {
        if (ok) out.setReplayGain(sb.id, deckGain(sb));
      })
      .catch(() => releaseDeck(sb)) // e.g. stream limit reached: fall back to a normal track change
      .finally(() => {
        preloadingRef.current = false;
      });
  }, [out, nextIndexOf, fadeSecFor, loadDeck, releaseDeck, deckGain]);

  /** Start the standby deck now: gapless join (fadeSec 0) or crossfade. */
  const handover = useCallback((fadeSec: number) => {
    if (!out) return false;
    const from = out.active;
    const to = out.standby;
    const n = nextIndexOf();
    const st = stateRef.current;
    if (n < 0 || !to.ready || to.itemId !== st.queue[n]?.id) return false;
    const fromItem = st.queue[st.index];
    if (fromItem) host?.onTransition(hostKey(fromItem, st.queue[n]!, st.index));
    out.resume();
    to.queueIndex = n;
    out.swap();
    out.setReplayGain(to.id, deckGain(to));
    if (fadeSec > 0) {
      handoverRef.current = { timer: null, fromDeck: from.id };
      out.setFade(to.id, 0);
      void out.fadeTo(to.id, 1, fadeSec);
      void out.fadeTo(from.id, 0, fadeSec).then(() => {
        if (handoverRef.current?.fromDeck !== from.id) return;
        handoverRef.current = null;
        from.el.pause();
        releaseDeck(from);
        out.setFade(from.id, 1);
      });
    } else {
      out.setFade(to.id, 1);
      // The outgoing deck is freed when it ends; make sure it is even if 'ended' never comes.
      const tok = from.token;
      window.setTimeout(() => {
        if (from.token === tok && out.active !== from) {
          from.el.pause();
          releaseDeck(from);
        }
      }, 3000);
    }
    void to.el.play().catch(() => setPlaying(false));
    adoptRef.current = { itemId: to.itemId!, index: n };
    setIndex(n);
    setInfo(to.info);
    setPosition(0);
    setDuration(to.info?.durationMs ?? st.queue[n]?.durationMs ?? 0);
    return true;
  }, [out, nextIndexOf, deckGain, releaseDeck]);

  /**
   * Start an Automix blend into the prepared standby deck. The outgoing deck stays the "current" track until the
   * blend ends (Now Playing shows "Mixing into …"). Every level and effect is scheduled on the audio clock.
   */
  const startBlend = useCallback((planned: DjTransition) => {
    if (!out) return false;
    const from = out.active;
    const to = out.standby;
    const n = nextIndexOf();
    const st = stateRef.current;
    const into = st.queue[n];
    if (n < 0 || !into || !to.ready || to.itemId !== into.id) return false;
    let tr = planned;
    const rate0 = from.el.playbackRate || 1;
    const pos = from.offsetMs + from.el.currentTime * 1000;
    const endMs = Number.isFinite(from.el.duration) ? from.offsetMs + from.el.duration * 1000 : pos + tr.crossfadeMs;
    const leftWall = Math.max(0, (endMs - pos) / rate0);
    const late = (pos - tr.mixOutMs) / rate0;
    const keepPitch = nativeKeyLock();
    if (late > 4000 || (tr.style === 'blend' && !keepPitch && Math.abs((tr.tempoRatio || 1) - 1) > 0.002)) {
      // Far past the planned point (after a seek), or no pitch-preserving playback for the tempo match: a short plain blend.
      tr = { ...tr, style: 'fade', tempoRatio: 1, fx: 'none', crossfadeMs: Math.min(late > 4000 ? 3000 : FIXED_FADE_MS[st.mixStyle], leftWall * rate0) };
    }
    const beat = tr.style === 'blend';
    const rates = beat ? matchRates(tr.tempoRatio, rate0, AUTOMIX_MAX_STRETCH) : { inRate: 1, outRate: rate0 };
    for (const d of [from, to]) {
      const el = d.el as HTMLAudioElement & { webkitPreservesPitch?: boolean };
      el.preservesPitch = true;
      el.webkitPreservesPitch = true;
      rateHoldRef.current.add(d.id);
    }
    if (Math.abs(rates.outRate - rate0) > 1e-4) from.el.playbackRate = rates.outRate;
    to.el.playbackRate = rates.inRate;
    // Exactly on the planned mix-in (plus however late the start is, so the beats still meet).
    const wantIn = tr.mixInMs + (beat && late > 0 ? late * rates.inRate : 0);
    if (Math.abs(to.offsetMs + to.el.currentTime * 1000 - wantIn) > 25 && wantIn >= to.offsetMs) {
      to.pendingSeek = null;
      to.el.currentTime = (wantIn - to.offsetMs) / 1000;
    }
    const durMs = Math.max(200, Math.min(tr.crossfadeMs / rates.outRate, leftWall));
    const { kSwap, kCut } = transitionPoints(tr, rates.outRate);
    out.resume();
    out.setReplayGain(to.id, deckGain(to));
    out.blend(from.id, to.id, tr.fx ?? 'none', durMs / 1000, kSwap, kCut, echoDelaySec(tr.beatMs, rates.outRate));
    handoverRef.current = { timer: null, fromDeck: from.id };
    const label = automixLabel(tr);
    const b = { from, to, n, into, label, tr, inRate: rates.inRate, outRate: rates.outRate, token: to.token, durMs, startedAt: performance.now(), timers: [] as number[] };
    blendRef.current = b;
    const fromItem = st.queue[st.index];
    if (fromItem) host?.onTransition(hostKey(fromItem, into, st.index));
    void to.el.play().catch(() => {
      if (blendRef.current === b) abortBlend();
    });
    b.timers.push(window.setTimeout(() => {
      if (blendRef.current === b) completeBlend();
    }, durMs + 60));
    const dbg = window as unknown as { vibeAutomix?: Record<string, unknown> };
    dbg.vibeAutomix = { tr, rates, durMs, late, from: st.queue[st.index]?.id, to: into.id };
    if (beat && keepPitch) {
      // Beat-phase check once playback has settled: nudge the incoming deck's rate briefly if it's off the beat.
      b.timers.push(window.setTimeout(() => {
        if (blendRef.current !== b) return;
        const pa = b.from.offsetMs + b.from.el.currentTime * 1000;
        const pb = b.to.offsetMs + b.to.el.currentTime * 1000;
        const err = pb - (tr.mixInMs + (pa - tr.mixOutMs) * (b.inRate / b.outRate));
        (dbg.vibeAutomix ??= {}).phaseErrMs = Math.round(err);
        const nudge = phaseNudge(err, b.inRate);
        if (!nudge) return;
        b.to.el.playbackRate = nudge.rate;
        b.timers.push(window.setTimeout(() => {
          if (blendRef.current === b) b.to.el.playbackRate = b.inRate;
        }, nudge.holdMs));
      }, 700));
    }
    setBlend({ into, label, progress: 0 });
    b.timers.push(window.setInterval(() => {
      if (blendRef.current !== b) return;
      setBlend({ into, label, progress: out.blendProgress() ?? Math.min(1, (performance.now() - b.startedAt) / b.durMs) });
    }, 250));
    return true;
  }, [out, nextIndexOf, deckGain, abortBlend, completeBlend]);

  /**
   * Radio Host / Your DJ commentary: about 30 s before the transition into the next track, ask the server for a
   * break (once per transition), with the incoming track's talk-over window from its analysis.
   */
  const hostTick = () => {
    const st = stateRef.current;
    if (!out || !host || !st.hostMode || castingRef.current || host.isMuted || st.repeat === 'one') return;
    const d = out.active;
    if (d.el.paused) return;
    const n = nextIndexOf();
    const cur = st.queue[st.index];
    const nx = st.queue[n];
    if (!cur || !nx || cur.type !== 'track' || nx.type !== 'track' || n === st.index) return;
    const key = hostKey(cur, nx, st.index);
    const rate = d.el.playbackRate || 1;
    const pos = d.offsetMs + d.el.currentTime * 1000;
    const endMs = Number.isFinite(d.el.duration) ? d.offsetMs + d.el.duration * 1000 : st.durationMs;
    if (!endMs) return;
    const plan = automixActive() && automixApplies(cur, nx) ? planFor(cur, nx) : null;
    const tr = plan?.ready ? plan.tr : null;
    const transitionMs = tr ? tr.mixOutMs : endMs - fadeSecFor(cur, nx) * 1000;
    const remaining = (transitionMs - pos) / rate;
    const at = performance.now() + remaining;
    if (host.current?.key === key) {
      host.retime(key, at);
      return;
    }
    if (hostAskedRef.current.has(key)) return;
    const ask = askState(remaining);
    if (ask === 'wait') return;
    hostAskedRef.current.add(key);
    if (hostAskedRef.current.size > 200) hostAskedRef.current.delete(hostAskedRef.current.values().next().value!);
    if (ask === 'late') return;
    const mode = st.hostMode;
    const sessionId = yourDjRef.current?.sessionId;
    void analysisFor(nx.id).then((ab) => {
      if (stateRef.current.queue[stateRef.current.index]?.id !== cur.id) return;
      const introEnd = ab?.cues?.introEndMs ?? ab?.introEndMs ?? null;
      const introMs = talkWindowMs(introEnd, tr?.mixInMs ?? 0, tr?.style === 'blend' ? tr.tempoRatio || 1 : 1);
      const now = new Date();
      host.ask(key, {
        mode, previousItemId: cur.id, nextItemId: nx.id, sessionId: mode === 'yourdj' ? sessionId : undefined, ...host.stats(),
        introMs: introMs ?? undefined, hour: now.getHours(), minute: now.getMinutes(),
      }, at, introMs);
    });
  };

  /** Called on every timeupdate of the live deck: preload, then start the next track on time. */
  const checkTransition = useCallback(() => {
    if (!out || castingRef.current || handoverRef.current) return;
    maybePreload();
    hostTick();
    const st = stateRef.current;
    const d = out.active;
    const to = out.standby;
    if (!to.ready || d.el.paused) return;
    const remainingMs = ((d.el.duration - d.el.currentTime) * 1000) / (d.el.playbackRate || 1);
    if (!Number.isFinite(remainingMs)) return;
    const cur = st.queue[st.index];
    const nx = st.queue[nextIndexOf()];
    const gapKey = cur && nx ? hostKey(cur, nx, st.index) : '';
    if (gapKey && host?.wantsGap(gapKey)) {
      // A gap break: no blend; at the end of the song's audio the music fades, the host talks, then the next track.
      const ca = resolvedAnalysesRef.current.get(cur!.id);
      const durMs = d.offsetMs + d.el.duration * 1000;
      const endMs = Math.min(durMs, ca?.cues?.endMs ?? ca?.cueOutMs ?? durMs);
      const pos = d.offsetMs + d.el.currentTime * 1000;
      if (pos < endMs - GAP_FADE_MS - 150) return;
      handoverRef.current = { timer: null, fromDeck: d.id };
      gapRef.current = gapKey;
      void out.fadeTo(d.id, 0, GAP_FADE_MS / 1000).then(async () => {
        if (gapRef.current !== gapKey) return;
        d.el.pause();
        await host.playGap(gapKey);
        if (gapRef.current !== gapKey) return;
        gapRef.current = null;
        handoverRef.current = null;
        if (gapPausedRef.current) {
          // Paused during the talk: the next track waits, paused.
          gapPausedRef.current = false;
          holdRef.current = true;
          setIndex(nextIndexOf());
        } else if (!handover(0)) next();
      });
      return;
    }
    const plan = automixActive() && automixApplies(cur, nx) ? planFor(cur, nx) : null;
    if (plan?.tr && to.itemId === nx?.id) {
      // Automix: start the blend exactly on the planned mix-out point (a timer closes the gap between timeupdates).
      const tr = plan.tr;
      const wait = (tr.mixOutMs - (d.offsetMs + d.el.currentTime * 1000)) / (d.el.playbackRate || 1);
      if (wait <= HANDOVER_WINDOW_MS) {
        const timer = window.setTimeout(() => {
          if (handoverRef.current?.timer !== timer) return;
          handoverRef.current = null;
          if (!startBlend(tr)) handover(0);
        }, Math.max(0, wait - HANDOVER_LEAD_MS));
        handoverRef.current = { timer, fromDeck: d.id };
      }
      return;
    }
    const fade = fadeSecFor(cur, nx);
    if (fade > 0) {
      if (remainingMs <= fade * 1000) handover(Math.min(fade, remainingMs / 1000));
      return;
    }
    if (remainingMs <= HANDOVER_WINDOW_MS) {
      // timeupdate only fires every ~250 ms: time the gapless start precisely with a timer.
      const wait = Math.max(0, remainingMs - HANDOVER_LEAD_MS);
      const timer = window.setTimeout(() => {
        if (handoverRef.current?.timer !== timer) return;
        handoverRef.current = null;
        handover(0);
      }, wait);
      handoverRef.current = { timer, fromDeck: d.id };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [out, maybePreload, fadeSecFor, nextIndexOf, handover, startBlend, next]);

  // A stale preload (queue edited, repeat/shuffle changed): drop it so the right track is prepared.
  useEffect(() => {
    if (!out || handoverRef.current) return;
    const sb = out.standby;
    // Not loaded, or the outgoing track of a gapless join playing out its last milliseconds.
    if (!sb.itemId || (!sb.el.paused && sb.el.currentTime > 0)) return;
    const n = nextIndexOf();
    if (queue[n]?.id !== sb.itemId || repeat === 'one') releaseDeck(sb);
  }, [queue, index, repeat, shuffle, out, nextIndexOf, releaseDeck]);

  // Element events (both decks; only the live one drives the UI).
  useEffect(() => {
    if (!out) return;
    const cleanups = out.decks.map((d) => {
      const a = d.el;
      const live = () => out.active === d;
      const onTime = () => {
        if (!live()) return;
        setPosition(d.offsetMs + a.currentTime * 1000);
        checkTransition();
      };
      const onDur = () => {
        if (!live() || !isFinite(a.duration)) return;
        // Keep the item's full duration when the stream starts part-way through.
        setDuration((dur) => Math.max(d.offsetMs + a.duration * 1000, d.offsetMs ? dur : 0));
      };
      const onMeta = () => {
        const target = d.pendingSeek;
        d.pendingSeek = null;
        if (target == null) return;
        const local = (target - d.offsetMs) / 1000;
        // Exact: Automix preloads the next track at its mix-in point, which can be a fraction of a second in.
        if (local > 0.02) a.currentTime = local;
      };
      const onPlay = () => {
        out.resume();
        if (!live()) return;
        setPlaying(true);
        report('playing');
      };
      const onPause = () => {
        if (!live()) return;
        // A gap break paused the outgoing track on purpose: the set is still "playing".
        if (gapRef.current) return;
        // Paused from outside (headset, OS media controls) mid-blend: cut it so the incoming track doesn't play on alone.
        if (blendRef.current && !a.ended) abortBlend();
        setPlaying(false);
        if (!a.ended) report('paused');
      };
      const onEnded = () => {
        if (!live()) {
          // The outgoing deck of a gapless join finished: free it.
          if (d.el.currentTime > 0) releaseDeck(d);
          return;
        }
        const { repeat: r, sleep: sl } = stateRef.current;
        if (sl?.mode === 'part') {
          // Sleep timer "end of part": move on, but load the next part paused.
          setSleepState(null);
          sleepFactorRef.current = 1;
          applyMaster();
          holdRef.current = stateRef.current.index + 1 < stateRef.current.queue.length || r === 'all';
          next();
          return;
        }
        if (r === 'one') {
          a.currentTime = 0;
          void a.play();
          return;
        }
        // The outgoing track ran out during an Automix blend: the incoming one takes over.
        if (blendRef.current) {
          completeBlend();
          return;
        }
        // Gapless fallback when the timer didn't get there first.
        const h = handoverRef.current;
        if (h?.timer != null) window.clearTimeout(h.timer);
        handoverRef.current = null;
        if (!handover(0)) next();
      };
      a.addEventListener('timeupdate', onTime);
      a.addEventListener('loadedmetadata', onMeta);
      a.addEventListener('durationchange', onDur);
      a.addEventListener('play', onPlay);
      a.addEventListener('pause', onPause);
      a.addEventListener('ended', onEnded);
      return () => {
        a.removeEventListener('timeupdate', onTime);
        a.removeEventListener('loadedmetadata', onMeta);
        a.removeEventListener('durationchange', onDur);
        a.removeEventListener('play', onPlay);
        a.removeEventListener('pause', onPause);
        a.removeEventListener('ended', onEnded);
      };
    });
    const iv = window.setInterval(() => {
      if (!out.active.el.paused) report('playing');
    }, 10000);
    const unload = () => {
      releaseDeck(out.standby, true);
      stopSession(true);
    };
    window.addEventListener('pagehide', unload);
    return () => {
      cleanups.forEach((c) => c());
      window.clearInterval(iv);
      window.removeEventListener('pagehide', unload);
    };
  }, [out, next, report, stopSession, releaseDeck, checkTransition, handover, applyMaster, completeBlend, abortBlend]);

  useEffect(() => {
    if (castingRef.current) castRef.current.setVolume(volume);
    else applyMaster();
    try {
      localStorage.setItem(VOL_KEY, String(volume));
    } catch {
      /* ignore */
    }
  }, [volume, applyMaster]);
  useEffect(() => {
    if (castingRef.current) castRef.current.setMuted(muted);
    else applyMaster();
  }, [muted, applyMaster]);

  // ReplayGain follows the queue context (album in order or not) and the preference.
  useEffect(() => {
    if (!out) return;
    for (const d of out.decks) if (d.itemId) out.setReplayGain(d.id, deckGain(d));
  }, [out, queue, index, shuffle, rgMode, deckGain]);

  /** Start local playback of the current track at `ms` (after casting ends). */
  const resumeLocal = useCallback(async (ms: number, autoplay: boolean) => {
    const cur = stateRef.current.queue[stateRef.current.index];
    if (!out || !cur) return;
    try {
      const d = out.active;
      const ok = await loadDeck(d, cur, stateRef.current.index, Math.round(ms), (msg) => toast.error(msg));
      if (!ok) return;
      setInfo(d.info);
      out.setFade(d.id, 1);
      out.setReplayGain(d.id, deckGain(d));
      applyMaster();
      if (autoplay) await d.el.play().catch(() => setPlaying(false));
    } catch (e) {
      toast.error(e);
    }
  }, [out, loadDeck, deckGain, applyMaster, toast]);

  /** Move the current track to the Cast device. */
  const takeOverCast = useCallback(() => {
    const cur = stateRef.current.queue[stateRef.current.index];
    castingRef.current = true;
    setCasting(true);
    if (!out || !cur) return;
    cancelHandover();
    const d = out.active;
    const pos = d.offsetMs + d.el.currentTime * 1000;
    d.el.pause();
    stopSession();
    releaseDeck(out.standby);
    setLoading(true);
    castTrackRef.current(cur, pos)
      .catch((e) => toast.error(`Cast failed: ${errorMessage(e)}`))
      .finally(() => setLoading(false));
  }, [out, cancelHandover, stopSession, releaseDeck, toast]);

  // Hand over to / back from the Cast device. Music only claims a new Cast session when it's the
  // active player (not while a video or live channel is open, which cast themselves).
  useEffect(() => {
    if (cast.connected && !castingRef.current) {
      const onPlayerPage = /^\/(play|watch)\//.test(window.location.pathname);
      if (!onPlayerPage && stateRef.current.index >= 0) takeOverCast();
    } else if (!cast.connected && castingRef.current) {
      const pos = castOffsetRef.current + castRef.current.remote.currentTime * 1000;
      castingRef.current = false;
      setCasting(false);
      endCastSession();
      // Resume locally, paused: don't suddenly start playing out of this device's speakers.
      void resumeLocal(pos, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cast.connected]);

  // Another player took the Cast device: stop mirroring it.
  useEffect(() => {
    const h = (e: Event) => {
      if ((e as CustomEvent<CastOwner>).detail === 'music' || !castingRef.current) return;
      castingRef.current = false;
      setCasting(false);
      endCastSession();
      setPlaying(false);
    };
    window.addEventListener(CAST_OWNER_EVENT, h);
    return () => window.removeEventListener(CAST_OWNER_EVENT, h);
  }, [endCastSession]);

  // Mirror the remote player.
  const remote = cast.remote;
  useEffect(() => {
    if (!casting || castOwner() !== 'music') return;
    setPosition(castOffsetRef.current + remote.currentTime * 1000);
    if (remote.duration > 0) setDuration((d) => Math.max(d, castOffsetRef.current + remote.duration * 1000));
  }, [casting, remote.currentTime, remote.duration]);
  useEffect(() => {
    if (!casting || castOwner() !== 'music' || !castSidRef.current) return;
    const sid = castSidRef.current;
    if (remote.playerState === 'IDLE' && remote.idleReason === 'FINISHED') {
      if (castEndHandled.current === sid) return;
      castEndHandled.current = sid;
      setPlaying(false);
      reportCast('stopped');
      const { repeat: r, queue: q, index: i } = stateRef.current;
      if (r === 'one' && q[i]) void castTrackRef.current(q[i]!, 0).catch(() => undefined);
      else next();
      return;
    }
    const isPlaying = remote.playerState === 'PLAYING' || remote.playerState === 'BUFFERING';
    setPlaying(isPlaying && !remote.isPaused);
    if (remote.playerState === 'PLAYING' || remote.playerState === 'PAUSED') reportCast(remote.isPaused ? 'paused' : 'playing');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [casting, remote.playerState, remote.isPaused, remote.idleReason]);
  useEffect(() => {
    if (!casting) return;
    const iv = window.setInterval(() => {
      if (castOwner() === 'music' && !castRef.current.remote.isPaused) reportCast('playing');
    }, 10000);
    const unload = () => endCastSession(true);
    window.addEventListener('pagehide', unload);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener('pagehide', unload);
    };
  }, [casting, reportCast, endCastSession]);

  const togglePlayback = useCallback(() => {
    if (!out || stateRef.current.index < 0) return;
    if (castingRef.current) {
      castRef.current.playOrPause();
      return;
    }
    if (castRef.current.connected) {
      // Connected but another player had the device: bring the music back to it.
      takeOverCast();
      return;
    }
    out.prime(wantGraph());
    const a = out.active.el;
    if (gapRef.current) {
      // During a gap break the deck is paused on purpose: play/pause toggles whether the next track waits.
      gapPausedRef.current = !gapPausedRef.current;
      if (gapPausedRef.current) host?.skip();
      setPlaying(!gapPausedRef.current);
      return;
    }
    if (a.paused) void a.play();
    else {
      host?.cancel();
      cancelHandover();
      a.pause();
    }
  }, [out, takeOverCast, cancelHandover, host]);
  const pausePlayback = useCallback(() => {
    if (castingRef.current) {
      if (!castRef.current.remote.isPaused) castRef.current.playOrPause();
      return;
    }
    if (gapRef.current) {
      gapPausedRef.current = true;
      host?.skip();
      setPlaying(false);
      return;
    }
    host?.cancel();
    cancelHandover();
    liveEl()?.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancelHandover]);

  // Media session controls.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    try {
      ms.setActionHandler('play', () => (castingRef.current ? togglePlayback() : void liveEl()?.play()));
      ms.setActionHandler('pause', pausePlayback);
      ms.setActionHandler('nexttrack', next);
      ms.setActionHandler('previoustrack', prev);
    } catch {
      /* unsupported action */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [next, prev, togglePlayback, pausePlayback]);

  /* ---------------- Sleep timer ---------------- */
  const setSleep = useCallback((opt: SleepOption | null) => {
    sleepFactorRef.current = 1;
    if (!castingRef.current) applyMaster();
    if (!opt) {
      setSleepState(null);
      return;
    }
    if (opt === 'part') {
      setSleepState({ mode: 'part' });
      return;
    }
    if (opt === 'chapter') {
      const { chapters: ch, positionMs: pos, durationMs: dur, queue: q, index: i } = stateRef.current;
      const cur = q[i];
      if (!cur || !ch.length) return;
      const nextStart = ch.find((c) => c.startMs > pos + 500)?.startMs;
      setSleepState({ mode: 'chapter', itemId: cur.id, endMs: nextStart ?? dur });
      return;
    }
    setSleepState({ mode: 'time', minutes: opt.minutes, endsAt: Date.now() + opt.minutes * 60_000 });
  }, [applyMaster]);

  useEffect(() => {
    if (!sleep) return;
    const fire = () => {
      setSleepState(null);
      pausePlayback();
      window.setTimeout(() => {
        sleepFactorRef.current = 1;
        applyMaster();
      }, 300);
      toast.show('Sleep timer: playback paused');
    };
    const iv = window.setInterval(() => {
      const st = stateRef.current;
      const cur = st.queue[st.index];
      let remaining: number;
      if (sleep.mode === 'time') remaining = sleep.endsAt - Date.now();
      else if (sleep.mode === 'chapter') {
        if (!cur || cur.id !== sleep.itemId) {
          setSleepState(null);
          return;
        }
        remaining = sleep.endMs - st.positionMs;
      } else remaining = st.durationMs > 0 ? st.durationMs - st.positionMs : Infinity;
      if (sleep.mode !== 'time' && !playingRef.current) return;
      if (remaining <= 0 && sleep.mode !== 'part') {
        fire();
        return;
      }
      // Fade out over the last few seconds (local playback only).
      if (!castingRef.current && playingRef.current) {
        const f = Math.max(0, Math.min(1, remaining / SLEEP_FADE_MS));
        sleepFactorRef.current = sleep.mode === 'part' ? Math.max(f, 0.05) : f;
        applyMaster();
      }
    }, 250);
    return () => window.clearInterval(iv);
  }, [sleep, pausePlayback, applyMaster, toast]);

  /* ---------------- Radio ---------------- */
  const radioFetching = useRef(false);
  const radioReq = useRef<DjMixRequest>({});
  const startRadio = useCallback(async (seedId: string, title: string) => {
    out?.prime(wantGraph());
    const label = `Radio based on ${title}`;
    try {
      radioReq.current = { harmonic: true, curve: 'steady' };
      const presetId = stateRef.current.activePresetId ?? undefined;
      if (presetId) radioReq.current.presetId = presetId;
      const mix = await api.dj.mix({ seedItemId: seedId, count: 25, harmonic: true, curve: 'steady', presetId });
      if (mix.request) radioReq.current = { ...mix.request, harmonic: true, curve: 'steady', presetId };
      const tracks = mix.tracks.map((t) => t.item).filter(isAudio);
      if (!tracks.length) {
        toast.show('Not enough music to build a radio from this yet');
        return;
      }
      const st = stateRef.current;
      const cur = st.queue[st.index];
      setShuffleState(false);
      setRepeat('off');
      dispatchDj({ type: 'end' });
      setRadio({ seedId, label });
      if (cur && cur.id === seedId && (playingRef.current || castingRef.current)) {
        // Keep the seed playing; the mix becomes what comes next.
        setQueue([cur, ...tracks.filter((t) => t.id !== cur.id)]);
        if (st.index !== 0) adoptRef.current = { itemId: cur.id, index: 0 };
        if (out) out.active.queueIndex = 0;
        setIndex(0);
      } else {
        startAtRef.current = null;
        setQueue(tracks);
        setIndex(-1);
        window.setTimeout(() => setIndex(0), 0);
      }
      toast.show(label);
    } catch (e) {
      toast.error(e);
    }
  }, [out, toast]);

  // Keep the radio going: top up when only a few tracks are left.
  useEffect(() => {
    if (!radio || radioFetching.current || index < 0) return;
    if (queue.length - index - 1 >= RADIO_LOW_WATER) return;
    radioFetching.current = true;
    const history = queue.map((q) => q.id).slice(-200);
    api.dj
      .mix({ ...radioReq.current, seedItemId: undefined, history, count: 10 })
      .then((mix) => {
        if (stateRef.current.radio?.seedId !== radio.seedId) return;
        const seen = new Set(stateRef.current.queue.map((q) => q.id));
        const more = mix.tracks.map((t) => t.item).filter((t) => isAudio(t) && !seen.has(t.id));
        if (more.length) setQueue((q) => [...q, ...more]);
      })
      .catch(() => {})
      .finally(() => {
        radioFetching.current = false;
      });
  }, [radio, queue, index]);

  /* ---------------- Play as mix ---------------- */
  /** Smart-ordered source still being paged in (a whole library streams in batches). */
  const mixSourceRef = useRef<{ base: DjOrderRequest; remaining: number } | null>(null);
  const mixFetching = useRef(false);
  const playAsMix = useCallback(async (src: MixSource) => {
    out?.prime(true);
    try {
      let tracks: Item[];
      let start = src.start ?? 0;
      mixSourceRef.current = null;
      if (src.source || src.smart) {
        const presetId = stateRef.current.activePresetId ?? undefined;
        const base: DjOrderRequest = src.source ? { source: src.source, harmonic: true, presetId } : { itemIds: (src.items ?? []).map((i) => i.id).slice(0, 5000), harmonic: true, presetId };
        const r = await api.dj.order({ ...base, limit: src.source ? MIX_PAGE : 500 });
        seedAnalyses(r.analyses);
        tracks = r.items.filter(isAudio);
        mixSourceRef.current = r.remaining > 0 ? { base, remaining: r.remaining } : null;
        start = 0;
      } else tracks = (src.items ?? []).filter(isAudio);
      if (!tracks.length) {
        toast.show('Nothing to mix here yet');
        return;
      }
      setRadio(null);
      setShuffleState(false);
      setRepeat('off');
      dispatchDj({ type: 'end' });
      setMixSession({ label: src.label });
      setEndless(true);
      startAtRef.current = null;
      setQueue(tracks);
      setIndex(-1);
      window.setTimeout(() => setIndex(Math.max(0, Math.min(start, tracks.length - 1))), 0);
    } catch (e) {
      toast.error(e);
    }
  }, [out, toast, seedAnalyses, dispatchDj]);

  // Keep a mix going: the next page of a big source, then (Endless) similar tracks from the library.
  useEffect(() => {
    if (!mixSession || mixFetching.current || index < 0) return;
    if (queue.length - index - 1 >= RADIO_LOW_WATER) return;
    const src = mixSourceRef.current;
    const ids = queue.map((q) => q.id);
    let more: Promise<Item[]>;
    const dj = yourDjRef.current;
    if (dj) {
      // Your DJ: more of the current segment, or the next one (the server decides).
      const history = sessionHistory(queue, queue.length - 1);
      // Sessions live a few hours on the server: an expired one just starts afresh (same rules), silently.
      more = api.dj.sessionMore(dj.sessionId, history).catch((e: { status?: number }) => {
        if (e?.status !== 404) throw e;
        const presetId = stateRef.current.activePresetId ?? undefined;
        return api.dj.session(presetId ? { presetId } : {});
      }).then((r) => {
        if (yourDjRef.current?.sessionId !== dj.sessionId) return [];
        seedAnalyses(r.analyses);
        dispatchDj({ type: 'more', session: r });
        return r.items;
      });
    } else if (src && src.remaining > 0) {
      more = api.dj.order({ ...src.base, history: ids.slice(-5000), limit: MIX_PAGE }).then((r) => {
        seedAnalyses(r.analyses);
        src.remaining = r.remaining;
        return r.items;
      });
    } else if (endless) {
      // Seeded from the last played tracks; local scoring only (no prompt, so no AI).
      more = api.dj.mix({ history: ids.slice(-200), count: 10, harmonic: true, curve: 'steady', transitions: mixStyle, maxStretchPct: AUTOMIX_MAX_STRETCH * 100, presetId: stateRef.current.activePresetId ?? undefined }).then((m) => {
        seedAnalyses(m.tracks);
        return m.tracks.map((t) => t.item);
      });
    } else return;
    mixFetching.current = true;
    const session = mixSession;
    more
      .then((list) => {
        if (stateRef.current.queue.length === 0) return;
        const seen = new Set(stateRef.current.queue.map((q) => q.id));
        const add = list.filter((t) => isAudio(t) && !seen.has(t.id));
        if (add.length && session) setQueue((q) => [...q, ...add]);
      })
      .catch(() => {})
      .finally(() => {
        mixFetching.current = false;
      });
  }, [mixSession, endless, queue, index, mixStyle, seedAnalyses, dispatchDj]);

  /* ---------------- Your DJ ---------------- */
  /** Introduce a new direction once its first track plays: the DJ's voice, or a caption when commentary is off. */
  const introduce = useCallback((session: DjSession, ack: boolean) => {
    const first = session.items[0];
    if (!first) return;
    const c = stateRef.current.commentary;
    if (c === 'off') {
      if (ack) host?.caption(switchAck(session.segment));
      return;
    }
    const brk: DjBreak | null = session.intro ?? (ack ? { id: `ack-${session.segment.id}`, kind: 'segment-intro', text: switchAck(session.segment), placement: 'over-intro', maxMs: 8000, audioUrl: null, durationMs: null } : null);
    if (brk) pendingIntroRef.current = { brk, itemId: first.id };
  }, [host]);

  const startYourDj = useCallback(async () => {
    out?.prime(true);
    setYourDjStarting(true);
    try {
      const presetId = stateRef.current.activePresetId ?? undefined;
      const session = await api.dj.session(presetId ? { presetId } : {});
      const tracks = session.items.filter(isAudio);
      if (!tracks.length) {
        toast.show(session.note || 'Your DJ needs a few more songs in your library to build a set.');
        return;
      }
      seedAnalyses(session.analyses);
      host?.cancel();
      setRadio(null);
      setShuffleState(false);
      setRepeat('off');
      mixSourceRef.current = null;
      setMixSession({ label: 'Your DJ' });
      setEndless(true);
      dispatchDj({ type: 'start', session: { ...session, items: tracks } });
      introduce({ ...session, items: tracks }, false);
      startAtRef.current = null;
      setQueue(tracks);
      setIndex(-1);
      window.setTimeout(() => setIndex(0), 0);
    } catch (e) {
      console.debug('[your dj] start failed', e);
      toast.show("Your DJ isn't available right now. Try again in a moment.");
    } finally {
      setYourDjStarting(false);
    }
  }, [out, toast, seedAnalyses, dispatchDj, introduce, host]);

  /** Apply a new direction (switch / request): it replaces what was coming up and starts with the next track. */
  const turnTo = useCallback((session: DjSession) => {
    const tracks = session.items.filter(isAudio);
    const i = stateRef.current.index;
    if (!tracks.length || i < 0) return;
    seedAnalyses(session.analyses);
    introduce({ ...session, items: tracks }, true);
    setQueue((q) => switchQueue(q, i, tracks));
    // A short fade out of the current track, then the new segment.
    window.setTimeout(() => {
      if (blendRef.current) abortBlend();
      cancelHandover();
      const d = out?.active;
      const go = () => setIndex(stateRef.current.index === i ? i + 1 : stateRef.current.index);
      if (d && out?.webAudio && !d.el.paused) void out.fadeTo(d.id, 0, 0.6).then(go);
      else go();
    }, 0);
  }, [out, seedAnalyses, introduce, abortBlend, cancelHandover]);

  const djSwitch = useCallback(async () => {
    const dj = yourDjRef.current;
    if (!dj || dj.busy) return;
    out?.prime(true);
    dispatchDj({ type: 'busy', busy: 'switch' });
    try {
      const st = stateRef.current;
      const session = await api.dj.sessionSwitch(dj.sessionId, sessionHistory(st.queue, st.queue.length - 1));
      if (yourDjRef.current?.sessionId !== dj.sessionId) return;
      dispatchDj({ type: 'switch', session });
      turnTo(session);
    } catch (e) {
      // Silent: the set just carries on.
      console.debug('[your dj] switch failed', e);
      dispatchDj({ type: 'busy', busy: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [out, dispatchDj, turnTo]);

  const djRequest = useCallback(async (text: string) => {
    const dj = yourDjRef.current;
    const q = text.trim();
    if (!dj || !q || dj.busy) return;
    out?.prime(true);
    dispatchDj({ type: 'busy', busy: 'request' });
    try {
      const st = stateRef.current;
      const result = await api.dj.sessionRequest(dj.sessionId, q, sessionHistory(st.queue, st.queue.length - 1));
      if (yourDjRef.current?.sessionId !== dj.sessionId) return;
      dispatchDj({ type: 'request', result });
      if ('id' in result && result.items?.length) turnTo(result);
    } catch (e) {
      console.debug('[your dj] request failed', e);
      // Never an error: a gentle line, and the set carries on.
      dispatchDj({ type: 'request', result: { ok: false, message: "I couldn't line that up just now, so I'll keep this going." } });
    }
  }, [out, dispatchDj, turnTo]);

  const djLove = useCallback((item: Item) => {
    api.dj.feedback({ itemId: item.id, kind: 'love' }).catch(() => {});
    api.items.setFavorite(item.id, true).catch(() => {});
  }, []);

  // A new track started: count it for the host's spacing, and play a pending Your DJ intro over its start.
  useEffect(() => {
    if (!current || !playing) return;
    const p = pendingIntroRef.current;
    if (p && p.itemId === current.id) {
      pendingIntroRef.current = null;
      void analysisFor(current.id).then((a) => {
        if (stateRef.current.queue[stateRef.current.index]?.id !== current.id) return;
        const d = out?.active;
        const pos = d ? d.offsetMs + d.el.currentTime * 1000 : 0;
        host?.playNow(p.brk, talkWindowMs(a?.cues?.introEndMs ?? a?.introEndMs ?? null, pos));
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, playing]);
  useEffect(() => {
    if (current) host?.noteTrackStarted();
  }, [current?.id, host]); // eslint-disable-line react-hooks/exhaustive-deps

  // Play rules changed during Your DJ: what's coming up is re-picked within the new rules (the current song plays on).
  const djPresetRef = useRef(activePresetId);
  useEffect(() => {
    const prevPreset = djPresetRef.current;
    djPresetRef.current = activePresetId;
    const dj = yourDjRef.current;
    if (!dj || prevPreset === activePresetId) return;
    api.dj.session(activePresetId ? { presetId: activePresetId } : {})
      .then((session) => {
        if (yourDjRef.current?.sessionId !== dj.sessionId) return;
        const tracks = session.items.filter(isAudio);
        if (!tracks.length) {
          dispatchDj({ type: 'request', result: { ok: false, message: session.note || 'Nothing in your library fits those rules yet, so I kept the current songs.' } });
          return;
        }
        seedAnalyses(session.analyses);
        dispatchDj({ type: 'more', session: { ...session, items: tracks } });
        const i = stateRef.current.index;
        setQueue((q) => switchQueue(q, i, tracks));
      })
      .catch((e) => console.debug('[your dj] rules change', e));
  }, [activePresetId, dispatchDj, seedAnalyses]);

  // The host stops talking when it is turned off, and follows mute.
  useEffect(() => {
    if (!hostMode && !yourDj) host?.cancel();
  }, [hostMode, yourDj, host]);

  /** Save a music preference for this listener (optimistic). */
  const savePref = useCallback((patch: Partial<UserPreferences>) => {
    if (!user) return;
    const prev = user;
    setUser({ ...user, preferences: { ...user.preferences, ...patch } });
    api.auth.updateMe({ preferences: patch }).then(setUser).catch((e) => {
      setUser(prev);
      toast.error(e);
    });
  }, [user, setUser, toast]);

  // Handy for debugging and automated tests (like window.mediamaxDj): window.vibeAutomixDebug.plan()
  useEffect(() => {
    (window as unknown as { vibeAutomixDebug?: unknown }).vibeAutomixDebug = {
      plan: () => planRef.current,
      positionMs: () => (out ? out.active.offsetMs + out.active.el.currentTime * 1000 : 0),
      seek: (ms: number) => seekRef.current(ms),
      blending: () => !!blendRef.current,
    };
  }, [out]);

  // Release the audio graph on unmount.
  useEffect(() => () => out?.close(), [out]);

  const value = useMemo<MusicApi>(
    () => ({
      queue, index, current, info, playing, loading, positionMs, durationMs, volume, muted, shuffle, repeat, chapters,
      playQueue: (items, start = 0, startMs) => {
        if (!items.length) return;
        out?.prime(wantGraph());
        abortGap(false);
        host?.cancel();
        setRadio(null);
        dispatchDj({ type: 'end' });
        // Normal Play follows the Automix preference ("Play as mix" sessions end here).
        setMixSession(null);
        mixSourceRef.current = null;
        startAtRef.current = startMs != null && items[start] ? { id: items[start]!.id, ms: startMs } : null;
        const list = shuffle && !hasAudioResume(items[start]!) ? [items[start]!, ...shuffled(items.filter((_, i) => i !== start))] : items;
        setQueue(list);
        setIndex(-1);
        window.setTimeout(() => setIndex(shuffle ? 0 : start), 0);
      },
      enqueue: (items, playNext) => {
        setQueue((q) => {
          if (!q.length) {
            out?.prime(wantGraph());
            window.setTimeout(() => setIndex(0), 0);
            return items;
          }
          if (playNext) {
            const i = stateRef.current.index;
            return [...q.slice(0, i + 1), ...items, ...q.slice(i + 1)];
          }
          return [...q, ...items];
        });
      },
      toggle: togglePlayback,
      pause: pausePlayback,
      next,
      prev,
      seek: (ms) => seekRef.current(ms),
      jump: (i, startMs) => {
        const item = stateRef.current.queue[i];
        if (!item) return;
        out?.prime(wantGraph());
        if (i !== stateRef.current.index) {
          abortGap(false);
          host?.cancel();
        }
        if (i === stateRef.current.index) {
          if (startMs != null) seekRef.current(startMs);
          return;
        }
        startAtRef.current = startMs != null ? { id: item.id, ms: startMs } : null;
        goto(i);
      },
      removeAt: (i) => {
        const cur = queue[index];
        // Removing an entry above the current one only shifts its position: the same track keeps playing.
        if (cur && i < index) adoptRef.current = { itemId: cur.id, index: index - 1 };
        setQueue((q) => q.filter((_, j) => j !== i));
        setIndex((cur) => (i < cur ? cur - 1 : i === cur ? Math.min(cur, queue.length - 2) : cur));
        if (out && out.active.queueIndex > i) out.active.queueIndex--;
      },
      clear: () => {
        abortGap(false);
        host?.cancel();
        dispatchDj({ type: 'end' });
        cancelHandover();
        liveEl()?.pause();
        if (castingRef.current) castRef.current.stop();
        setRadio(null);
        setMixSession(null);
        mixSourceRef.current = null;
        setQueue([]);
        setIndex(-1);
      },
      setVolume: (v) => setVolumeState(Math.max(0, Math.min(1, v))),
      setMuted,
      setShuffle: (s) => {
        setShuffleState(s);
        if (s && queue.length > 1) {
          const cur = queue[index];
          const rest = shuffled(queue.filter((_, i) => i !== index));
          setQueue(cur ? [cur, ...rest] : rest);
          if (cur && index !== 0) {
            // Same track keeps playing; only its queue position changes.
            adoptRef.current = { itemId: cur.id, index: 0 };
            if (out) out.active.queueIndex = 0;
          }
          setIndex(cur ? 0 : -1);
        }
      },
      setRepeat,
      cast,
      casting,
      sleep,
      setSleep,
      radio,
      startRadio,
      rate,
      setRate: (r) => {
        const v = Math.max(0.5, Math.min(3, r));
        setRateState(v);
        try {
          localStorage.setItem(RATE_KEY, String(v));
        } catch {
          /* private mode */
        }
      },
      output: outputApi,
      altSource,
      automix: automixOn,
      setAutomix: (on) => {
        if (!on) {
          setMixSession(null);
          dispatchDj({ type: 'end' });
          if (blendRef.current) completeBlend();
        }
        if (on !== automixPref || user?.preferences.automix === undefined) savePref({ automix: on });
      },
      mixStyle,
      setMixStyle: (st) => savePref({ automixStyle: st }),
      mix: mixSession,
      playAsMix,
      endless,
      setEndless,
      blend,
      yourDj,
      yourDjStarting,
      startYourDj,
      djSwitch,
      djRequest,
      djDismiss: () => dispatchDj({ type: 'dismiss' }),
      djLove,
      host: {
        ...hostState,
        muted: hostMuted,
        active: !!hostMode || !!yourDj,
        skip: () => {
          host?.skip();
        },
        setMuted: (mu: boolean) => {
          host?.setMuted(mu);
          setHostMutedState(mu);
          try {
            localStorage.setItem(HOST_MUTE_KEY, mu ? '1' : '0');
          } catch {
            /* private mode */
          }
        },
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queue, index, current, info, playing, loading, positionMs, durationMs, volume, muted, shuffle, repeat, chapters, next, prev, goto, togglePlayback, pausePlayback, cast, casting, sleep, setSleep, radio, startRadio, cancelHandover, outputApi, altSource, rate,
      automixOn, automixPref, mixStyle, mixSession, playAsMix, endless, blend, savePref, completeBlend, user?.preferences.automix,
      yourDj, yourDjStarting, startYourDj, djSwitch, djRequest, djLove, hostState, hostMuted, hostMode, host, abortGap, dispatchDj],
  );

  const latest = useRef(value);
  latest.current = value;
  const actions = useMemo<MusicActions>(() => ({
    playQueue: (...a) => latest.current.playQueue(...a),
    playAsMix: (...a) => latest.current.playAsMix(...a),
    startYourDj: () => latest.current.startYourDj(),
  }), []);

  return (
    <Ctx.Provider value={value}>
      <ActionsCtx.Provider value={actions}>
        {children}
        <PlayRulesHost />
      </ActionsCtx.Provider>
    </Ctx.Provider>
  );
}


/** One function that "plays" any item the right way. */
export function usePlayItem() {
  const navigate = useNavigate();
  const music = useContext(ActionsCtx);
  if (!music) throw new Error('usePlayItem outside MusicProvider');
  const toast = useToast();
  return useCallback(
    async (item: Item, opts: { shuffle?: boolean; fromStart?: boolean } = {}) => {
      try {
        if (isVideo(item)) {
          navigate(playLink(item, opts));
          return;
        }
        if (item.type === 'show' || item.type === 'season') {
          const ep = await findNextEpisode(item);
          if (ep) navigate(playLink(ep));
          else toast.show('No episodes to play');
          return;
        }
        if (item.type === 'podcastepisode') {
          music.playQueue([item]);
          return;
        }
        if (item.type === 'podcast') {
          const ep = await api.items.next(item.id).catch(() => null);
          if (ep) music.playQueue([ep]);
          else toast.show('No episodes to play');
          return;
        }
        if (item.type === 'audiobook') {
          const parts = (await api.items.children(item.id, { sort: 'index', limit: 1000 })).items.filter(isAudio);
          if (!parts.length) {
            toast.show('Nothing to play');
            return;
          }
          const resumeAt = opts.fromStart ? null : await api.items.next(item.id).catch(() => null);
          const i = resumeAt ? parts.findIndex((p) => p.id === resumeAt.id) : 0;
          music.playQueue(i >= 0 && resumeAt ? parts.map((p) => (p.id === resumeAt.id ? resumeAt : p)) : parts, Math.max(0, i));
          return;
        }
        if (isAudio(item) && item.parentId) {
          const album = (await api.items.children(item.parentId, { sort: 'index', limit: 1000 }).catch(() => null))?.items.filter(isAudio) ?? [];
          const i = album.findIndex((t) => t.id === item.id);
          if (i >= 0) music.playQueue(album, i);
          else music.playQueue([item]);
          return;
        }
        if (item.type === 'album' || item.type === 'artist' || item.type === 'playlist' || item.type === 'track') {
          let tracks = await tracksFor(item);
          if (!tracks.length && item.type === 'playlist') {
            const kids = (await api.items.children(item.id, { limit: 500 })).items;
            const firstVideo = kids.find(isVideo);
            if (firstVideo) {
              navigate(playLink(firstVideo));
              return;
            }
          }
          if (!tracks.length) {
            toast.show('Nothing to play');
            return;
          }
          if (opts.shuffle) tracks = shuffled(tracks);
          music.playQueue(tracks, 0);
          return;
        }
        if (item.type === 'collection') {
          const kids = (await api.items.children(item.id, { limit: 200 })).items;
          const first = kids.find(isVideo);
          if (first) navigate(playLink(first));
          else navigate(`/item/${item.id}`);
          return;
        }
        navigate(`/item/${item.id}`);
      } catch (e) {
        toast.error(e);
      }
    },
    [navigate, music, toast],
  );
}

/**
 * "Mix" next to Play and Shuffle: play a music item as a continuous Automix mix. Albums and playlists keep their
 * own order (Shuffle + Mix = smart order); artists use the server's smart order, paged in batches.
 */
/** Stable playback actions (never re-render the caller while music plays). */
export function useMusicActions(): MusicActions {
  const v = useContext(ActionsCtx);
  if (!v) throw new Error('useMusicActions outside MusicProvider');
  return v;
}

export function usePlayAsMix() {
  const music = useContext(ActionsCtx);
  const toast = useToast();
  return useCallback(async (item: Item, opts: { shuffle?: boolean } = {}) => {
    if (!music) return;
    try {
      const label = item.title;
      if (item.type === 'artist') return music.playAsMix({ label, source: { type: 'artist', id: item.id } });
      if (opts.shuffle && (item.type === 'album' || item.type === 'playlist')) return music.playAsMix({ label, source: { type: item.type, id: item.id } });
      const tracks = await tracksFor(item);
      if (!tracks.length) {
        toast.show('Nothing to mix here yet');
        return;
      }
      return music.playAsMix({ label, items: tracks });
    } catch (e) {
      toast.error(e);
    }
  }, [music, toast]);
}
