/**
 * DJ mode: plays a server-built mix (POST /dj/mix) on two expo-audio players
 * ("deck A" / "deck B") with beat- and key-aware transitions.
 *
 * How a transition is scheduled (all JS-driven, from one 50 ms timer):
 *  1. About 15 s before the outgoing track reaches the incoming track's
 *     `transition.mixOutMs`, the idle deck asks the server for a playback
 *     session starting at `transition.mixInMs`, loads it paused at volume 0 and
 *     seeks to the mix-in point (minus the stream's `streamStartMs`).
 *  2. When the outgoing track reaches `mixOutMs` (a one-shot setTimeout covers
 *     the last few hundred ms for better precision), the incoming deck starts at
 *     `tempoRatio` (pitch-corrected) and both volumes follow an equal-power
 *     curve (cos / sin) over `crossfadeMs`, updated every 50 ms.
 *  3. At the end of the fade the outgoing deck is paused and its session is
 *     stopped (so plays / scrobbles are recorded), the decks swap roles and the
 *     new live deck eases its playback rate back to 1.0 over ~8 s.
 *
 * Continuous mode tops the queue up (history + count) whenever fewer than 3
 * tracks are left. While DJ mode plays, the normal music player is paused;
 * starting normal music stops DJ mode.
 *
 * AI DJ:
 *  - A mix can start from a plain-language prompt. The server answers with the
 *    resolved request (`mix.request`), which is what continuous top-ups send
 *    back, so the prompt is parsed only once.
 *  - Host ("DJ voice"): when the next track is cued (step 1 above) the line
 *    into it is fetched from POST /dj/host at the same time (always for the
 *    first track, then every 1st / 2nd / 4th track by chattiness). When the
 *    transition starts and the line has arrived, both decks duck to 30 % over
 *    0.4 s, the line plays (server MP3 on a third player, else expo-speech on
 *    the device, else just the subtitle) and the decks come back over 1 s. A
 *    line that isn't ready is dropped: the host never holds a transition up.
 *    The one exception is the opening line, which may hold the very first
 *    track for up to 3 s (nothing is playing yet).
 *  - Every deck's volume is crossfade × ReplayGain × duck: `DeckRt.level` is
 *    crossfade × ReplayGain, `setVol` multiplies in the current duck.
 *
 * Phone and TV only: CarPlay / Android Auto keep driving src/state/music.tsx.
 */
import { useAudioPlayer, type AudioPlayer } from 'expo-audio';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type MediaMaxClient } from '@/api/client';
import { audioDeviceProfile } from '@/api/profiles';
import { getJSON, setJSON } from '@/api/storage';
import type { DjHostLine, DjMixRequest, DjMixTrack, DjStatus, DjTransition, Item, PlaybackInfo } from '@/api/types';
import { invalidate } from '@/api/useQuery';
import { syncCarRemoteCommands } from '@/car/remote';
import { deviceSpeech } from '@/utils/speech';
import { useDownloads } from './downloads';
import { useMusic } from './music';
import { useSession } from './session';

export type DeckId = 'A' | 'B';
export type DjPhase = 'idle' | 'loading' | 'playing' | 'paused' | 'ended';

/** Start fetching the next track this long before its mix point. */
const PRELOAD_LEAD_MS = 15000;
const TICK_MS = 50;
/** How often the UI snapshot is refreshed. */
const PUBLISH_MS = 250;
const REPORT_MS = 10000;
/** Ease the incoming track's tempo back to 1.0 over this long after the blend. */
const TEMPO_EASE_MS = 8000;
/** "Mix now" fade length. */
const MIX_NOW_MS = 8000;
/** Continuous mode: top up when fewer upcoming tracks than this remain. */
const TOP_UP_BELOW = 3;
const TOP_UP_COUNT = 5;
const FALLBACK_FADE_MS = 8000;

/** AI DJ host: deck volume while the host talks, and how fast to get there / back. */
const DUCK_LEVEL = 0.3;
const DUCK_IN_MS = 400;
const DUCK_OUT_MS = 1000;
/** The opening line may hold the first track this long (nothing is playing yet). */
const OPENING_WAIT_MS = 3000;
/** Safety cap on one host line; server audio that hasn't started after this long is given up. */
const HOST_MAX_MS = 30000;
const HOST_START_TIMEOUT_MS = 5000;
/** Talk into every n-th track (the opening line is always spoken). */
const HOST_EVERY: Record<DjStatus['ai']['chattiness'], number> = { rare: 4, normal: 2, chatty: 1 };
const VOICE_KEY = 'dj:voice';

export type DjAi = DjStatus['ai'];

export interface DeckView {
  id: DeckId;
  track: DjMixTrack | null;
  /** Position in the track (ms, media timeline). */
  positionMs: number;
  durationMs: number;
  /** Where this track mixes out into the next one (if known). */
  mixOutMs: number | null;
  playing: boolean;
  loading: boolean;
  /** live = audible track, next = cued up, idle = empty. */
  role: 'live' | 'next' | 'idle';
  rate: number;
  volume: number;
}

export interface DjValue {
  /** DJ mode owns playback (loading, playing or paused). */
  active: boolean;
  phase: DjPhase;
  error: string | null;
  continuous: boolean;
  /** Full mix: already played, current and upcoming tracks. */
  tracks: DjMixTrack[];
  /** Index (into `tracks`) of the audible track; -1 before the first starts. */
  currentIndex: number;
  liveDeck: DeckId;
  decks: Record<DeckId, DeckView>;
  /** 0 = all deck A, 1 = all deck B. */
  crossfader: number;
  /** A crossfade is running. */
  mixing: boolean;
  /** Share of candidate tracks the server had analysed when it built the mix (0–1). */
  analyzedShare: number | null;
  /** Fetching more tracks (continuous mode). */
  toppingUp: boolean;
  /** AI DJ: the prompt this mix was asked for (null for mixes built from the explicit options). */
  prompt: string | null;
  /** AI DJ: what the prompt was understood as, e.g. "House · 1990s · chill". */
  summary: string | null;
  understoodBy: 'llm' | 'rules' | null;
  /** The host talks in this mix (DJ voice on and the AI DJ enabled on the server). */
  hostActive: boolean;
  /** Host name from the server's AI DJ settings. */
  hostName: string | null;
  /** The host line being spoken right now (for the subtitle bubble). */
  hostLine: { text: string; by: DjHostLine['by'] } | null;
  /** Item id of the track you hear right now (the incoming one from halfway through a blend). */
  audibleItemId: string | null;
  /** "DJ voice" preference (persisted; on by default). */
  voice: boolean;
  setVoice: (on: boolean) => void;
  /**
   * Start a mix. `req.prompt` asks the AI DJ (the server resolves it). `ai` is `DjStatus.ai`: when it's enabled
   * and DJ voice is on, the host talks between tracks.
   */
  start: (req: DjMixRequest, opts?: { continuous?: boolean; ai?: DjAi | null }) => Promise<void>;
  pause: () => void;
  resume: () => void;
  toggle: () => void;
  /** Start the transition into the next track now, with an 8 s fade. */
  mixNow: () => void;
  /** Drop the upcoming track (and tell the AI DJ it was skipped). */
  skipNext: () => void;
  /** Love the audible track (AI DJ feedback; also favourites it). Resolves to its item id. */
  love: () => Promise<string | null>;
  stop: () => void;
  /** Save the mix (played + upcoming tracks) as a normal playlist. */
  saveAsPlaylist: (title: string) => Promise<Item>;
}

interface DeckRt {
  id: DeckId;
  player: AudioPlayer;
  track: DjMixTrack | null;
  /** Index into tracks of what's loaded; -1 when empty. */
  qIndex: number;
  session: PlaybackInfo | null;
  /** Media position (ms) of stream time 0. */
  offsetMs: number;
  /** Stream position (ms) to seek to once loaded. */
  seekMs: number;
  awaitingLoad: boolean;
  ready: boolean;
  loading: boolean;
  /** Bumped on every (un)load so stale async work is dropped. */
  token: number;
  gain: number;
  /** Crossfade × ReplayGain, before the host duck. */
  level: number;
  rate: number;
  /** Actual player volume (level × duck). */
  volume: number;
  lastReport: number;
  /** Seen actually playing since the last play() (guards the lock-screen pause detection). */
  seenPlaying: boolean;
}

/**
 * Volume shape of a transition effect (the server picks bass swap / filter fade / echo-out per pair). expo-audio
 * has no EQ, filters or delay, so on phone/TV each effect is approximated with the two deck volumes, timed like
 * the web mixer (web/src/player/djMixer.ts): bass swap = the new track comes up to the phrase line, then the old
 * one leaves; filter fade = old track holds, then fades over the second half while the new one eases in;
 * echo-out = the new track sneaks in, the old one drops out on the beat at ~3/4 (no echo tail).
 */
export function fxGains(fx: DjTransition['fx'], p: number, kSwap = 0.5, kCut = 0.75): { out: number; inc: number } {
  const c = (x: number) => Math.max(0, Math.min(1, x));
  const ease = (x: number) => x * x * (3 - 2 * x);
  p = c(p);
  switch (fx) {
    case 'bassSwap': {
      const k = Math.max(0.05, Math.min(0.95, kSwap));
      return { inc: Math.sin((c(p / k) * Math.PI) / 2), out: p < k ? 1 : Math.cos((c((p - k) / (1 - k)) * Math.PI) / 2) };
    }
    case 'filter':
      return { inc: ease(c(p / 0.66)), out: p < 0.5 ? 1 : Math.cos((c((p - 0.5) / 0.5) * Math.PI) / 2) };
    case 'echo':
      return { inc: p < kCut ? 0.35 * ease(c(p / kCut)) : 1, out: p < kCut ? 1 : Math.max(0, 1 - (p - kCut) / 0.08) };
    default:
      return { inc: Math.sin((p * Math.PI) / 2), out: Math.cos((p * Math.PI) / 2) };
  }
}

interface Fade {
  from: DeckId;
  to: DeckId;
  startedAt: number;
  fx?: DjTransition['fx'];
  kSwap?: number;
  kCut?: number;
  durMs: number;
  /** Elapsed time frozen while paused. */
  pausedElapsed: number | null;
  lockSwitched: boolean;
}

interface Ease {
  deck: DeckId;
  from: number;
  startedAt: number;
  pausedElapsed: number | null;
  lastSet: number;
}

interface HostPending {
  /** The track this line leads into. */
  itemId: string;
  line: DjHostLine | null;
  failed: boolean;
  ctrl: AbortController;
}

interface HostSpeaking {
  line: DjHostLine;
  kind: 'server' | 'device' | 'text';
  startedAt: number;
  maxMs: number;
  seenPlaying: boolean;
}

interface Duck {
  value: number;
  from: number;
  target: number;
  startedAt: number;
  durMs: number;
}

type Snap = Omit<DjValue, 'start' | 'pause' | 'resume' | 'toggle' | 'mixNow' | 'skipNext' | 'stop' | 'saveAsPlaylist' | 'love' | 'voice' | 'setVoice'>;

const Ctx = createContext<DjValue | null>(null);

const other = (d: DeckId): DeckId => (d === 'A' ? 'B' : 'A');
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function trackDuration(tr: DjMixTrack | null): number {
  if (!tr) return 0;
  return tr.analysis?.durationMs || tr.item.durationMs || 0;
}

/** ReplayGain (track gain, never amplifying), like the music engine. */
function trackGain(item: Item, mode: string): number {
  const rg = item.replayGain;
  if (!rg || mode === 'off') return 1;
  const db = mode === 'album' ? rg.albumGainDb ?? rg.trackGainDb : rg.trackGainDb ?? rg.albumGainDb;
  if (db == null) return 1;
  const peak = (mode === 'album' ? rg.albumPeak : rg.trackPeak) ?? null;
  let f = Math.pow(10, db / 20);
  if (peak && peak > 0) f = Math.min(f, 1 / peak);
  return clamp(f, 0.05, 1);
}

/** Transition used when the server's one no longer applies (after skipping a track). */
function fallbackTransition(out: DjMixTrack, inc: DjMixTrack): DjTransition {
  const outDur = trackDuration(out);
  const mixOutMs = Math.max(0, out.analysis?.outroStartMs ?? (out.analysis?.cueOutMs ?? outDur) - FALLBACK_FADE_MS - 2000);
  const a = out.analysis?.bpm;
  const b = inc.analysis?.bpm;
  const ratio = a && b ? a / b : 1;
  return {
    mixOutMs,
    mixInMs: inc.analysis?.cueInMs ?? 0,
    crossfadeMs: FALLBACK_FADE_MS,
    tempoRatio: Math.abs(ratio - 1) <= 0.08 ? ratio : 1,
    style: 'fade',
    keyMatch: 'unknown',
    bpmDelta: a && b ? Math.round((b - a) * 10) / 10 : null,
  };
}

/** Where `out` should start mixing into `inc`, clamped to the track. */
function mixOutFor(out: DjMixTrack, inc: DjMixTrack | undefined): number | null {
  if (!inc) return null;
  const dur = trackDuration(out);
  const tr = inc.transition ?? fallbackTransition(out, inc);
  let ms = tr.mixOutMs;
  if (dur > 0) ms = Math.min(ms, Math.max(0, dur - Math.max(tr.crossfadeMs, 1000) - 500));
  return Math.max(0, ms);
}

export function DjProvider({ children }: { children: React.ReactNode }) {
  const { api, user } = useSession();
  const downloads = useDownloads();
  const music = useMusic();
  const playerA = useAudioPlayer(null, { updateInterval: 250 });
  const playerB = useAudioPlayer(null, { updateInterval: 250 });
  /** AI DJ host: server-rendered speech. */
  const hostPlayer = useAudioPlayer(null, { updateInterval: 250 });
  const hostPlayerRef = useRef(hostPlayer);
  hostPlayerRef.current = hostPlayer;

  const apiRef = useRef<MediaMaxClient | null>(api);
  apiRef.current = api;
  const downloadsRef = useRef(downloads);
  downloadsRef.current = downloads;
  const rgMode = user?.preferences.replayGain ?? 'auto';
  const rgModeRef = useRef(rgMode);
  rgModeRef.current = rgMode;

  const mkDeck = (id: DeckId, player: AudioPlayer): DeckRt => ({ id, player, track: null, qIndex: -1, session: null, offsetMs: 0, seekMs: 0, awaitingLoad: false, ready: false, loading: false, token: 0, gain: 1, level: 0, rate: 1, volume: 0, lastReport: 0, seenPlaying: false });
  const decksRef = useRef<Record<DeckId, DeckRt> | null>(null);
  if (!decksRef.current) decksRef.current = { A: mkDeck('A', playerA), B: mkDeck('B', playerB) };
  decksRef.current.A.player = playerA;
  decksRef.current.B.player = playerB;

  const tracksRef = useRef<DjMixTrack[]>([]);
  const curRef = useRef(-1);
  const liveRef = useRef<DeckId>('B');
  const phaseRef = useRef<DjPhase>('idle');
  const fadeRef = useRef<Fade | null>(null);
  const easeRef = useRef<Ease | null>(null);
  /** Start the next transition as soon as the next deck is ready, with this fade length. */
  const forceRef = useRef<{ crossfadeMs: number; keepTempo: boolean } | null>(null);
  const startTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqRef = useRef<DjMixRequest>({});
  const continuousRef = useRef(false);
  const fetchingRef = useRef(false);
  const exhaustedRef = useRef(false);
  const skippedRef = useRef<string[]>([]);
  /** Tracks whose deck was playing when paused (to resume the same set). */
  const resumeSet = useRef<DeckId[]>([]);
  const lockDeck = useRef<DeckId | null>(null);
  const extPauseSince = useRef<number | null>(null);
  const seenStopped = useRef(false);
  const lastPublish = useRef(0);
  const analyzedShareRef = useRef<number | null>(null);
  // AI DJ
  const promptRef = useRef<string | null>(null);
  const summaryRef = useRef<string | null>(null);
  const understoodByRef = useRef<'llm' | 'rules' | null>(null);
  /** reqRef holds the server-resolved request (top-ups must not re-send the prompt). */
  const resolvedRef = useRef(false);
  const aiRef = useRef<DjAi | null>(null);
  const hostPendingRef = useRef<HostPending | null>(null);
  const speakingRef = useRef<HostSpeaking | null>(null);
  const speechToken = useRef(0);
  const hostLoadedUrl = useRef<string | null>(null);
  const duckRef = useRef<Duck>({ value: 1, from: 1, target: 1, startedAt: 0, durMs: 0 });
  const openingWaitSince = useRef<number | null>(null);

  const [running, setRunning] = useState(false);
  const [snap, setSnap] = useState<Snap>(() => emptySnap());
  const [error, setError] = useState<string | null>(null);
  const [voice, setVoiceState] = useState(true);
  const voiceRef = useRef(true);
  voiceRef.current = voice;

  useEffect(() => {
    let alive = true;
    void getJSON<boolean>(VOICE_KEY, true).then((v) => {
      if (alive) setVoiceState(v !== false);
    });
    return () => {
      alive = false;
    };
  }, []);

  // ----- helpers -----
  const deck = (id: DeckId) => decksRef.current![id];

  const mediaPos = (d: DeckRt): number => {
    try {
      return Math.round(d.player.currentTime * 1000) + d.offsetMs;
    } catch {
      return 0;
    }
  };

  /** Set a deck's crossfade × ReplayGain level; the player gets that × the host duck. */
  const setVol = (d: DeckRt, v: number) => {
    d.level = v;
    d.volume = v * duckRef.current.value;
    try {
      d.player.volume = clamp(d.volume, 0, 1);
    } catch {
      /* not ready */
    }
  };

  // ----- AI DJ host -----
  const hostOn = () => voiceRef.current && !!aiRef.current?.enabled;

  const applyDuck = () => {
    for (const id of ['A', 'B'] as DeckId[]) {
      const d = deck(id);
      if (d.track) setVol(d, d.level);
    }
  };

  const duckTo = (target: number, durMs: number) => {
    const k = duckRef.current;
    k.from = k.value;
    k.target = target;
    k.startedAt = Date.now();
    k.durMs = durMs;
    if (durMs <= 0) k.value = target;
    applyDuck();
  };

  const stepDuck = (now: number) => {
    const k = duckRef.current;
    if (k.value === k.target) return;
    const p = k.durMs > 0 ? clamp((now - k.startedAt) / k.durMs, 0, 1) : 1;
    k.value = p >= 1 ? k.target : k.from + (k.target - k.from) * p;
    applyDuck();
  };

  const loadHostAudio = (url: string) => {
    const a = apiRef.current;
    if (!a) return;
    const uri = a.withAuthQuery(url);
    if (hostLoadedUrl.current === uri) return;
    try {
      hostPlayerRef.current.pause();
      hostPlayerRef.current.replace({ uri, headers: a.headers(false) });
      hostLoadedUrl.current = uri;
    } catch {
      hostLoadedUrl.current = null;
    }
  };

  /** Fetch the host line into track `idx` (called when that track is cued, so it's ready by the transition). */
  const prepareHost = (idx: number) => {
    const tr = tracksRef.current[idx];
    const a = apiRef.current;
    const ai = aiRef.current;
    if (!tr || !a || !ai || !hostOn()) return;
    if (idx > 0 && idx % (HOST_EVERY[ai.chattiness] ?? 2) !== 0) return;
    const cur = hostPendingRef.current;
    if (cur && cur.itemId === tr.item.id) return;
    cur?.ctrl.abort();
    const pending: HostPending = { itemId: tr.item.id, line: null, failed: false, ctrl: new AbortController() };
    hostPendingRef.current = pending;
    const prev = idx > 0 ? tracksRef.current[idx - 1] : undefined;
    a.djHost(
      { previousItemId: prev?.item.id, nextItemId: tr.item.id, position: idx, prompt: promptRef.current ?? undefined, hour: new Date().getHours() },
      pending.ctrl.signal,
    )
      .then((line) => {
        if (hostPendingRef.current !== pending) return;
        if (!line?.text?.trim()) {
          pending.failed = true;
          return;
        }
        pending.line = line;
        // Pre-load server speech unless a line is playing on the host player right now.
        if (line.audioUrl && !speakingRef.current) loadHostAudio(line.audioUrl);
      })
      .catch(() => {
        if (hostPendingRef.current === pending) pending.failed = true;
      });
  };

  const dropHostPending = () => {
    hostPendingRef.current?.ctrl.abort();
    hostPendingRef.current = null;
  };

  /** Stop whatever the host is saying. `resetDuck` snaps the decks back to full level (pause / stop). */
  const stopHost = (resetDuck: boolean) => {
    speechToken.current++;
    const s = speakingRef.current;
    speakingRef.current = null;
    if (s?.kind === 'server') {
      try {
        hostPlayerRef.current.pause();
      } catch {
        /* ignore */
      }
    } else if (s?.kind === 'device') {
      deviceSpeech?.stop().catch(() => undefined);
    }
    if (resetDuck) duckTo(1, 0);
  };

  const endSpeech = () => {
    if (!speakingRef.current) return;
    stopHost(false);
    duckTo(1, DUCK_OUT_MS);
    publish();
  };

  const speak = (line: DjHostLine, instant: boolean) => {
    stopHost(false);
    const a = apiRef.current;
    let kind: HostSpeaking['kind'] = 'text';
    // Reading time for the subtitle-only / device voice case.
    let maxMs = Math.min(HOST_MAX_MS, 2500 + line.text.length * 75);
    if (line.audioUrl && a) {
      try {
        loadHostAudio(line.audioUrl);
        const p = hostPlayerRef.current;
        p.volume = 1;
        if (p.currentTime > 0) void p.seekTo(0).catch(() => undefined);
        p.play();
        kind = 'server';
        maxMs = line.durationMs ? Math.min(HOST_MAX_MS, line.durationMs + 4000) : HOST_MAX_MS;
      } catch {
        kind = 'text';
      }
    }
    if (kind === 'text' && deviceSpeech) {
      const token = speechToken.current;
      const done = () => {
        if (token === speechToken.current) endSpeech();
      };
      try {
        deviceSpeech.speak(line.text, { onDone: done, onStopped: done, onError: done });
        kind = 'device';
        maxMs = Math.min(HOST_MAX_MS, 4000 + line.text.length * 110); // safety net in case onDone never fires
      } catch {
        kind = 'text';
      }
    }
    // A subtitle on its own doesn't need the music out of the way.
    if (kind !== 'text') duckTo(DUCK_LEVEL, instant ? 0 : DUCK_IN_MS);
    speakingRef.current = { line, kind, startedAt: Date.now(), maxMs, seenPlaying: false };
    publish();
  };

  /** The transition into `tr` is starting: speak its line if (and only if) it has arrived. */
  const maybeSpeak = (tr: DjMixTrack | null, instant: boolean) => {
    const p = hostPendingRef.current;
    if (!tr || !p || p.itemId !== tr.item.id) return;
    hostPendingRef.current = null;
    if (!p.line || !hostOn()) {
      p.ctrl.abort();
      return;
    }
    speak(p.line, instant);
  };

  /** Hold the very first track briefly while its opening line is still on the way. */
  const holdForOpening = (tr: DjMixTrack, now: number) => {
    const p = hostPendingRef.current;
    if (!hostOn() || !p || p.itemId !== tr.item.id || p.line || p.failed) return false;
    openingWaitSince.current = openingWaitSince.current ?? now;
    return now - openingWaitSince.current < OPENING_WAIT_MS;
  };

  const stepHost = (now: number) => {
    const s = speakingRef.current;
    if (!s) return;
    const elapsed = now - s.startedAt;
    if (s.kind === 'server') {
      const p = hostPlayerRef.current;
      let playing = false;
      let finished = false;
      let buffering = false;
      try {
        playing = p.playing;
        finished = p.currentStatus?.didJustFinish ?? false;
        buffering = p.isBuffering;
      } catch {
        /* ignore */
      }
      if (playing) s.seenPlaying = true;
      if (finished || (s.seenPlaying && !playing && !buffering) || (!s.seenPlaying && elapsed > HOST_START_TIMEOUT_MS) || elapsed > s.maxMs) endSpeech();
    } else if (elapsed > s.maxMs) endSpeech();
  };

  /** The deck you hear: the incoming one from halfway through a blend. */
  const audibleDeck = (): DeckRt | null => {
    const f = fadeRef.current;
    if (f) {
      const p = clamp((f.pausedElapsed ?? Date.now() - f.startedAt) / f.durMs, 0, 1);
      const d = deck(p >= 0.5 ? f.to : f.from);
      return d.track ? d : deck(f.to);
    }
    const d = deck(liveRef.current);
    return d.track ? d : null;
  };

  const setRate = (d: DeckRt, r: number) => {
    d.rate = r;
    try {
      // 'high' = spectral pitch correction on iOS; Android ignores the quality and keeps pitch while shouldCorrectPitch is set.
      d.player.setPlaybackRate(r, 'high');
    } catch {
      /* ignore */
    }
  };

  const report = (d: DeckRt, state: 'playing' | 'paused' | 'stopped') => {
    const s = d.session;
    const a = apiRef.current;
    if (!s || !a) return;
    d.lastReport = Date.now();
    const body = { positionMs: mediaPos(d), durationMs: trackDuration(d.track) || undefined, state, sessionId: s.sessionId };
    a.sessionProgress(s.sessionId, body).catch(() => undefined);
    if (state === 'stopped') {
      a.stopSession(s.sessionId).catch(() => undefined);
      d.session = null;
    }
  };

  /** Empty a deck. `played` reports the session as a real play (progress + stop); otherwise it is just closed. */
  const unload = (d: DeckRt, played: boolean) => {
    d.token++;
    try {
      d.player.pause();
    } catch {
      /* ignore */
    }
    if (played) report(d, 'stopped');
    else if (d.session) {
      apiRef.current?.stopSession(d.session.sessionId).catch(() => undefined);
      d.session = null;
    }
    d.track = null;
    d.qIndex = -1;
    d.ready = false;
    d.loading = false;
    d.awaitingLoad = false;
    d.offsetMs = 0;
    d.seekMs = 0;
    d.rate = 1;
  };

  const setLockScreen = (d: DeckRt) => {
    const a = apiRef.current;
    const it = d.track?.item;
    if (!a || !it) return;
    const prev = lockDeck.current;
    if (prev && prev !== d.id) {
      try {
        deck(prev).player.clearLockScreenControls();
      } catch {
        /* ignore */
      }
    }
    lockDeck.current = d.id;
    const artwork = a.image(it.posterUrl ?? it.thumbUrl, 600) ?? undefined;
    try {
      d.player.setActiveForLockScreen(
        true,
        { title: it.title, artist: it.grandparentTitle ?? it.parentTitle ?? undefined, albumTitle: it.parentTitle ? `DJ mix · ${it.parentTitle}` : 'DJ mix', artworkUrl: artwork },
        { showNextTrack: false, showPreviousTrack: false, showSeekForward: false, showSeekBackward: false },
      );
      // iOS: no next/previous handlers driving the music queue while DJ mode owns the lock screen.
      syncCarRemoteCommands(false);
    } catch {
      /* not supported on this platform */
    }
  };

  const clearLockScreen = () => {
    for (const id of ['A', 'B'] as DeckId[]) {
      try {
        deck(id).player.clearLockScreenControls();
      } catch {
        /* ignore */
      }
    }
    lockDeck.current = null;
  };

  /** Load track `idx` onto deck `d`, paused at volume 0, cued to its mix-in point. */
  const preload = (d: DeckRt, idx: number) => {
    const tr = tracksRef.current[idx];
    const a = apiRef.current;
    if (!tr || !a) return;
    if (d.track) unload(d, false);
    const token = ++d.token;
    d.track = tr;
    d.qIndex = idx;
    d.loading = true;
    d.ready = false;
    d.gain = trackGain(tr.item, rgModeRef.current);
    prepareHost(idx);
    const prevTrack = tracksRef.current[idx - 1];
    const tr2 = tr.transition ?? (prevTrack && idx > 0 ? fallbackTransition(prevTrack, tr) : null);
    const cue = tr.analysis?.cueInMs ?? 0;
    const mixIn = Math.max(0, tr2 ? tr2.mixInMs : cue > 500 ? cue : 0);
    void (async () => {
      let uri: string;
      let headers: Record<string, string> | undefined;
      const local = downloadsRef.current.get(tr.item.id);
      if (local?.state === 'done' && local.fileUri) {
        uri = local.fileUri;
        d.offsetMs = 0;
        d.seekMs = mixIn;
      } else {
        try {
          const info = await a.playback(tr.item.id, { deviceProfile: audioDeviceProfile(), startMs: mixIn > 0 ? Math.round(mixIn) : undefined });
          if (token !== d.token) {
            a.stopSession(info.sessionId).catch(() => undefined);
            return;
          }
          d.session = info;
          // Full-timeline streams: seek to the mix-in point; streams cut at startMs begin there (streamStartMs).
          d.offsetMs = info.streamStartMs ?? 0;
          d.seekMs = Math.max(0, (info.startMs || mixIn) - d.offsetMs);
          uri = a.absolute(info.url);
          headers = a.headers(false);
        } catch (e) {
          if (token !== d.token) return;
          // Could not play this one: drop it and carry on with the rest of the mix.
          setError(e instanceof Error ? `Skipped “${tr.item.title}”: ${e.message}` : 'Skipped a track that could not play');
          dropTrack(idx);
          return;
        }
      }
      try {
        d.player.pause();
        d.player.replace(headers ? { uri, headers } : { uri });
      } catch {
        /* ignore */
      }
      try {
        // Time-stretch without changing pitch when the tempo is matched (iOS: spectral algorithm below; Android keeps pitch).
        d.player.shouldCorrectPitch = true;
      } catch {
        /* ignore */
      }
      setVol(d, 0);
      setRate(d, 1);
      d.loading = false;
      d.awaitingLoad = true;
    })();
  };

  /** Remove upcoming track `idx` from the mix (skip / failed to load). */
  const dropTrack = (idx: number) => {
    const list = tracksRef.current;
    const tr = list[idx];
    if (!tr || idx <= curRef.current) return;
    skippedRef.current.push(tr.item.id);
    for (const id of ['A', 'B'] as DeckId[]) {
      const d = deck(id);
      if (d.qIndex === idx || d.qIndex === idx + 1) unload(d, false); // the one after is re-cued with its new transition
      else if (d.qIndex > idx) d.qIndex--;
    }
    const next = [...list.slice(0, idx), ...list.slice(idx + 1)];
    // The following track's transition was planned from the removed one: rebuild it from the analysis.
    const after = next[idx];
    const before = next[idx - 1];
    if (after && before) next[idx] = { ...after, transition: fallbackTransition(before, after) };
    else if (after && !before) next[idx] = { ...after, transition: null };
    tracksRef.current = next;
    if (startTimer.current) {
      clearTimeout(startTimer.current);
      startTimer.current = null;
    }
    publish();
  };

  const topUp = () => {
    const a = apiRef.current;
    if (!a || fetchingRef.current || exhaustedRef.current) return;
    fetchingRef.current = true;
    const history = [...skippedRef.current, ...tracksRef.current.map((x) => x.item.id)];
    const { seedItemId: _seed, durationMin: _dur, prompt, ...rest } = reqRef.current;
    // The server's resolved request replaces the prompt (no re-parsing on every top-up); an older server
    // that didn't send one back still gets the prompt.
    const body: DjMixRequest = resolvedRef.current || !prompt ? rest : { ...rest, prompt };
    void a
      .djMix({ ...body, history, count: TOP_UP_COUNT })
      .then((mix) => {
        if (phaseRef.current === 'idle' || phaseRef.current === 'ended') return;
        const known = new Set(history);
        const add = mix.tracks.filter((x) => !known.has(x.item.id));
        if (!add.length) exhaustedRef.current = true;
        tracksRef.current = [...tracksRef.current, ...add];
        analyzedShareRef.current = mix.analyzedShare;
      })
      .catch(() => undefined)
      .finally(() => {
        fetchingRef.current = false;
        publish();
      });
  };

  /** Start the crossfade from the live deck into the deck holding the next track. */
  const beginFade = (crossfadeMs: number, tempoRatio: number, tr?: DjTransition | null) => {
    if (startTimer.current) {
      clearTimeout(startTimer.current);
      startTimer.current = null;
    }
    if (fadeRef.current) return;
    const from = liveRef.current;
    const to = other(from);
    const inc = deck(to);
    if (!inc.ready) return;
    forceRef.current = null;
    // Host link (only if it's already here). The opening line ducks at once so the first track starts under it.
    maybeSpeak(inc.track, !deck(from).track);
    setVol(inc, crossfadeMs <= TICK_MS ? inc.gain : 0);
    setRate(inc, clamp(tempoRatio || 1, 0.9, 1.1));
    try {
      inc.player.play();
    } catch {
      /* ignore */
    }
    inc.lastReport = Date.now();
    inc.seenPlaying = false;
    report(inc, 'playing');
    const L = Math.max(crossfadeMs, TICK_MS);
    const kSwap = tr?.swapAtMs != null ? tr.swapAtMs / Math.max(1, tr.crossfadeMs) : 0.5;
    const beat = tr?.beatMs ?? 0;
    const kCut = tr?.fx === 'echo' && beat > 0 ? clamp((Math.round((L * 0.75) / beat) * beat) / L, 0.3, 0.95) : 0.75;
    fadeRef.current = { from, to, startedAt: Date.now(), durMs: L, pausedElapsed: null, lockSwitched: false, fx: tr?.fx ?? 'none', kSwap, kCut };
    if (!deck(from).track) setLockScreen(inc);
    if (fadeRef.current && !deck(from).track) fadeRef.current.lockSwitched = true;
    if (phaseRef.current === 'loading') phaseRef.current = 'playing';
    stepFade();
  };

  const stepFade = () => {
    const f = fadeRef.current;
    if (!f || f.pausedElapsed != null) return;
    const p = clamp((Date.now() - f.startedAt) / f.durMs, 0, 1);
    const out = deck(f.from);
    const inc = deck(f.to);
    // Equal-power curve (perceived loudness stays constant), shaped by the transition effect.
    const g = fxGains(f.fx, p, f.kSwap, f.kCut);
    if (out.track) setVol(out, g.out * out.gain);
    setVol(inc, g.inc * inc.gain);
    if (p >= 0.5 && !f.lockSwitched) {
      f.lockSwitched = true;
      setLockScreen(inc);
    }
    if (p >= 1) finishFade();
  };

  const finishFade = () => {
    const f = fadeRef.current;
    if (!f) return;
    fadeRef.current = null;
    const out = deck(f.from);
    const inc = deck(f.to);
    if (out.track) unload(out, true);
    if (!f.lockSwitched) setLockScreen(inc);
    setVol(inc, inc.gain);
    liveRef.current = f.to;
    curRef.current = inc.qIndex;
    if (Math.abs(inc.rate - 1) > 0.001) {
      easeRef.current = { deck: f.to, from: inc.rate, startedAt: Date.now(), pausedElapsed: null, lastSet: 0 };
    }
    publish();
  };

  const stepEase = () => {
    const e = easeRef.current;
    if (!e || e.pausedElapsed != null) return;
    const d = deck(e.deck);
    if (e.deck !== liveRef.current || !d.track) {
      easeRef.current = null;
      return;
    }
    const now = Date.now();
    const p = clamp((now - e.startedAt) / TEMPO_EASE_MS, 0, 1);
    // Rate changes are cheap but not free: update a few times a second.
    if (p < 1 && now - e.lastSet < 200) return;
    e.lastSet = now;
    setRate(d, e.from + (1 - e.from) * p);
    if (p >= 1) easeRef.current = null;
  };

  const teardown = (phase: 'idle' | 'ended') => {
    if (startTimer.current) clearTimeout(startTimer.current);
    startTimer.current = null;
    for (const id of ['A', 'B'] as DeckId[]) unload(deck(id), true);
    clearLockScreen();
    fadeRef.current = null;
    easeRef.current = null;
    forceRef.current = null;
    resumeSet.current = [];
    stopHost(true);
    dropHostPending();
    openingWaitSince.current = null;
    phaseRef.current = phase;
    if (phase === 'idle') {
      tracksRef.current = [];
      curRef.current = -1;
      skippedRef.current = [];
    }
    setRunning(false);
    publish();
  };

  // ----- the scheduler -----
  const tick = () => {
    const phase = phaseRef.current;
    if (phase === 'idle' || phase === 'ended') return;
    const now = Date.now();
    const decks = decksRef.current!;

    // Finish loading: seek to the mix-in point once the source is ready.
    for (const id of ['A', 'B'] as DeckId[]) {
      const d = decks[id];
      if (!d.awaitingLoad) continue;
      let loaded = false;
      try {
        loaded = d.player.isLoaded;
      } catch {
        /* ignore */
      }
      if (!loaded) continue;
      d.awaitingLoad = false;
      const token = d.token;
      if (d.seekMs > 300) {
        d.player
          .seekTo(d.seekMs / 1000)
          .catch(() => undefined)
          .finally(() => {
            if (token === d.token) d.ready = true;
          });
      } else d.ready = true;
    }

    stepDuck(now);
    stepHost(now);

    if (phase === 'paused') {
      // Lock screen / headset "play" resumed the audible deck: resume the whole mix
      // (only after it has been seen stopped, so a pause still in flight isn't mistaken for it).
      const lock = lockDeck.current ? decks[lockDeck.current] : null;
      if (lock?.track) {
        if (!safePlaying(lock)) seenStopped.current = true;
        else if (seenStopped.current) resumeAll(true);
      }
      return publishMaybe(now);
    }

    const tracks = tracksRef.current;
    const cur = curRef.current;
    const live = decks[liveRef.current];
    const next = decks[other(liveRef.current)];
    const nextIdx = cur + 1;
    const nextTrack = tracks[nextIdx];

    if (continuousRef.current && tracks.length - nextIdx < TOP_UP_BELOW) topUp();

    if (fadeRef.current) {
      stepFade();
    } else {
      const livePos = live.track ? mediaPos(live) : 0;
      const mixOut = live.track ? mixOutFor(live.track, nextTrack) : 0;
      const liveDur = trackDuration(live.track);
      const liveEnded = !!live.track && didFinish(live, livePos, liveDur);
      const wantSoon = !live.track || forceRef.current != null || liveEnded || (mixOut != null && livePos >= mixOut - PRELOAD_LEAD_MS);

      // 1. Cue the next track on the idle deck.
      if (nextTrack && next.qIndex !== nextIdx && wantSoon) preload(next, nextIdx);

      // 2. Start the transition.
      if (nextTrack && next.qIndex === nextIdx && next.ready) {
        const tr = nextTrack.transition ?? (live.track ? fallbackTransition(live.track, nextTrack) : null);
        const force = forceRef.current;
        if (!live.track) {
          if (!holdForOpening(nextTrack, now)) beginFade(0, 1);
        } else if (force) beginFade(force.crossfadeMs, force.keepTempo ? tr?.tempoRatio ?? 1 : 1);
        else if (liveEnded) beginFade(0, 1);
        else if (mixOut != null) {
          const wantFade = tr?.crossfadeMs ?? FALLBACK_FADE_MS;
          // Never fade longer than what's left of the outgoing track.
          const left = liveDur > 0 ? Math.max(TICK_MS, liveDur - livePos) : wantFade;
          const fadeMs = Math.min(wantFade, left);
          const ratio = tr?.tempoRatio ?? 1;
          const remaining = mixOut - livePos;
          if (remaining <= 0) beginFade(fadeMs, ratio, tr);
          else if (remaining < 400 && !startTimer.current) {
            // Precise start: a one-shot timer instead of waiting for the next 50 ms tick.
            const rate = live.rate || 1;
            startTimer.current = setTimeout(() => {
              startTimer.current = null;
              if (phaseRef.current === 'playing') beginFade(fadeMs, ratio, tr);
            }, remaining / rate);
          }
        }
      } else if (liveEnded && !nextTrack && !fetchingRef.current && (!continuousRef.current || exhaustedRef.current)) {
        // End of the mix.
        teardown('ended');
        return;
      } else if (liveEnded && live.session) {
        // Waiting for the next track to load: close this play now.
        report(live, 'stopped');
      }
    }

    // Lock screen / headset pause hits only the deck that owns the lock screen: pause the whole mix
    // (debounced; ignores buffering and the end of a track).
    const lock = lockDeck.current ? decks[lockDeck.current] : null;
    if (lock?.track && lock.ready) {
      let buffering = false;
      let loaded = true;
      try {
        buffering = lock.player.isBuffering;
        loaded = lock.player.isLoaded;
      } catch {
        /* ignore */
      }
      const ended = didFinish(lock, mediaPos(lock), trackDuration(lock.track));
      const isPlaying = safePlaying(lock);
      if (isPlaying) lock.seenPlaying = true;
      if (lock.seenPlaying && !isPlaying && !buffering && loaded && !ended) {
        extPauseSince.current = extPauseSince.current ?? now;
        if (now - extPauseSince.current > 1500) {
          extPauseSince.current = null;
          pauseAll();
          return;
        }
      } else extPauseSince.current = null;
    } else extPauseSince.current = null;

    stepEase();

    // Progress reports (plays / scrobbles), per deck.
    for (const id of ['A', 'B'] as DeckId[]) {
      const d = decks[id];
      if (d.session && safePlaying(d) && now - d.lastReport >= REPORT_MS) report(d, 'playing');
    }
    publishMaybe(now);
  };

  const safePlaying = (d: DeckRt) => {
    try {
      return d.player.playing;
    } catch {
      return false;
    }
  };

  const didFinish = (d: DeckRt, pos: number, dur: number) => {
    let finished = false;
    try {
      finished = d.player.currentStatus?.didJustFinish ?? false;
    } catch {
      /* ignore */
    }
    if (finished) return true;
    let streamDur = 0;
    try {
      streamDur = d.player.duration * 1000 + d.offsetMs;
    } catch {
      /* ignore */
    }
    const end = streamDur > 1000 ? streamDur : dur;
    // Tolerant end check: the analysed duration can be a little longer than the decoded stream.
    return end > 0 && pos >= end - 1500 && !safePlaying(d);
  };

  const pauseAll = () => {
    if (phaseRef.current !== 'playing' && phaseRef.current !== 'loading') return;
    if (startTimer.current) {
      clearTimeout(startTimer.current);
      startTimer.current = null;
    }
    const now = Date.now();
    const playingDecks: DeckId[] = [];
    for (const id of ['A', 'B'] as DeckId[]) {
      const d = deck(id);
      if (!d.track) continue;
      if (safePlaying(d) || (fadeRef.current && (fadeRef.current.from === id || fadeRef.current.to === id)) || id === liveRef.current) {
        if (d.ready || id === liveRef.current) playingDecks.push(id);
      }
      try {
        d.player.pause();
      } catch {
        /* ignore */
      }
      if (d.session && (id === liveRef.current || fadeRef.current)) report(d, 'paused');
    }
    // Only resume decks that were actually audible (a cued-up deck stays paused).
    resumeSet.current = playingDecks.filter((id) => id === liveRef.current || (fadeRef.current && fadeRef.current.to === id));
    if (fadeRef.current) fadeRef.current.pausedElapsed = now - fadeRef.current.startedAt;
    if (easeRef.current) easeRef.current.pausedElapsed = now - easeRef.current.startedAt;
    // The host line is dropped (not resumed): the decks come back at full level.
    stopHost(true);
    phaseRef.current = 'paused';
    seenStopped.current = false;
    publish();
  };

  const resumeAll = (fromLockScreen = false) => {
    if (phaseRef.current !== 'paused') return;
    const now = Date.now();
    if (fadeRef.current?.pausedElapsed != null) {
      fadeRef.current.startedAt = now - fadeRef.current.pausedElapsed;
      fadeRef.current.pausedElapsed = null;
    }
    if (easeRef.current?.pausedElapsed != null) {
      easeRef.current.startedAt = now - easeRef.current.pausedElapsed;
      easeRef.current.pausedElapsed = null;
    }
    phaseRef.current = deck(liveRef.current).track ? 'playing' : 'loading';
    extPauseSince.current = null;
    if (!fromLockScreen) music.pause();
    for (const id of resumeSet.current) {
      try {
        deck(id).player.play();
      } catch {
        /* ignore */
      }
      deck(id).lastReport = 0; // report "playing" on the next tick
      deck(id).seenPlaying = false;
    }
    resumeSet.current = [];
    publish();
  };

  // ----- UI snapshot -----
  const publishMaybe = (now: number) => {
    if (now - lastPublish.current >= PUBLISH_MS) publish();
  };

  const publish = () => {
    lastPublish.current = Date.now();
    const decks = decksRef.current!;
    const tracks = tracksRef.current;
    const live = liveRef.current;
    const f = fadeRef.current;
    const view = (id: DeckId): DeckView => {
      const d = decks[id];
      const pos = d.track ? mediaPos(d) : 0;
      const nextT = d.qIndex >= 0 ? tracks[d.qIndex + 1] : undefined;
      return {
        id,
        track: d.track,
        positionMs: pos,
        durationMs: trackDuration(d.track),
        mixOutMs: d.track ? mixOutFor(d.track, nextT) : null,
        playing: d.track ? safePlaying(d) : false,
        loading: d.loading || d.awaitingLoad || (!!d.track && !d.ready),
        role: !d.track ? 'idle' : id === live ? 'live' : f && f.to === id ? 'live' : 'next',
        rate: d.rate,
        volume: d.volume,
      };
    };
    let crossfader = live === 'A' ? 0 : 1;
    if (f) {
      const p = clamp((f.pausedElapsed ?? Date.now() - f.startedAt) / f.durMs, 0, 1);
      crossfader = f.to === 'B' ? p : 1 - p;
    }
    setSnap({
      active: phaseRef.current !== 'idle' && phaseRef.current !== 'ended',
      phase: phaseRef.current,
      error: null,
      continuous: continuousRef.current,
      tracks,
      currentIndex: curRef.current,
      liveDeck: live,
      decks: { A: view('A'), B: view('B') },
      crossfader,
      mixing: !!f,
      analyzedShare: analyzedShareRef.current,
      toppingUp: fetchingRef.current,
      prompt: promptRef.current,
      summary: summaryRef.current,
      understoodBy: understoodByRef.current,
      hostActive: hostOn(),
      hostName: aiRef.current?.hostName || null,
      hostLine: speakingRef.current ? { text: speakingRef.current.line.text, by: speakingRef.current.line.by } : null,
      audibleItemId: audibleDeck()?.track?.item.id ?? null,
    });
  };

  // Keep the newest closures for the timer.
  const tickRef = useRef(tick);
  tickRef.current = tick;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => tickRef.current(), TICK_MS);
    return () => clearInterval(timer);
  }, [running]);

  // ----- normal music interplay -----
  const activeRef = useRef(false);
  activeRef.current = running;
  const musicPlayingPrev = useRef(music.playing);
  const stopRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    const was = musicPlayingPrev.current;
    musicPlayingPrev.current = music.playing;
    // Normal music started (play / new queue): DJ mode hands over.
    if (music.playing && !was && activeRef.current) stopRef.current();
  }, [music.playing]);

  // Signing out / switching server: stop.
  useEffect(() => {
    if (!api && activeRef.current) stopRef.current();
  }, [api]);

  // Unmount.
  useEffect(
    () => () => {
      if (startTimer.current) clearTimeout(startTimer.current);
      hostPendingRef.current?.ctrl.abort();
      if (speakingRef.current?.kind === 'device') deviceSpeech?.stop().catch(() => undefined);
    },
    [],
  );

  // ----- public API -----
  const start = useCallback(
    async (req: DjMixRequest, opts: { continuous?: boolean; ai?: DjAi | null } = {}) => {
      const a = apiRef.current;
      if (!a) return;
      if (phaseRef.current !== 'idle') teardown('idle');
      setError(null);
      const continuous = !!opts.continuous;
      continuousRef.current = continuous;
      exhaustedRef.current = false;
      skippedRef.current = [];
      reqRef.current = req;
      resolvedRef.current = false;
      promptRef.current = req.prompt?.trim() || null;
      summaryRef.current = null;
      understoodByRef.current = null;
      aiRef.current = opts.ai ?? null;
      openingWaitSince.current = null;
      phaseRef.current = 'loading';
      liveRef.current = 'B'; // empty "live" deck: the first track fades in on deck A
      curRef.current = -1;
      tracksRef.current = [];
      analyzedShareRef.current = null;
      music.pause();
      setRunning(true);
      publish();
      try {
        const body: DjMixRequest = continuous ? { ...req, durationMin: undefined, count: req.count ?? TOP_UP_COUNT + 1 } : req;
        const mix = await a.djMix(body);
        if (phaseRef.current !== 'loading' || tracksRef.current.length) return; // stopped meanwhile
        if (!mix.tracks.length) {
          setError('No tracks matched. Try fewer genres, another BPM range or a different seed.');
          teardown('idle');
          return;
        }
        tracksRef.current = mix.tracks.map((x, i) => (i === 0 ? { ...x, transition: null } : x));
        analyzedShareRef.current = mix.analyzedShare;
        if (mix.request) {
          reqRef.current = mix.request;
          resolvedRef.current = true;
        }
        if (mix.continuous) continuousRef.current = true;
        summaryRef.current = mix.summary ?? null;
        understoodByRef.current = mix.understoodBy ?? null;
        publish();
      } catch (e) {
        if (e instanceof ApiError && e.status === 403 && req.prompt) {
          setError('The AI DJ is turned off on this server. Build a mix with the options below instead.');
          invalidate('dj:status');
        } else setError(e instanceof Error ? e.message : 'Could not build a mix');
        teardown('idle');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [music.pause],
  );

  const stop = () => teardown('idle');
  stopRef.current = stop;

  const value = useMemo<DjValue>(
    () => ({
      ...snap,
      error,
      start,
      pause: () => pauseAll(),
      resume: () => resumeAll(),
      toggle: () => (phaseRef.current === 'paused' ? resumeAll() : pauseAll()),
      mixNow: () => {
        if (fadeRef.current || !tracksRef.current[curRef.current + 1] || !deck(liveRef.current).track) return;
        if (phaseRef.current === 'paused') resumeAll();
        forceRef.current = { crossfadeMs: MIX_NOW_MS, keepTempo: true };
        tickRef.current();
      },
      skipNext: () => {
        const idx = curRef.current + 1;
        const f = fadeRef.current;
        // Mid-blend the incoming track is already audible: skip the one after it instead.
        const target = f ? idx + 1 : idx;
        const skipped = tracksRef.current[target]?.item.id;
        dropTrack(target);
        if (skipped) apiRef.current?.djFeedback({ itemId: skipped, kind: 'skip' }).catch(() => undefined);
      },
      love: async () => {
        const a = apiRef.current;
        const id = audibleDeck()?.track?.item.id;
        if (!a || !id) return null;
        await a.djFeedback({ itemId: id, kind: 'love' });
        invalidate(`item:${id}`);
        return id;
      },
      voice,
      setVoice: (on: boolean) => {
        setVoiceState(on);
        voiceRef.current = on;
        setJSON(VOICE_KEY, on).catch(() => undefined);
        if (!on) {
          stopHost(false);
          duckTo(1, DUCK_OUT_MS);
          dropHostPending();
        }
        publish();
      },
      stop: () => stopRef.current(),
      saveAsPlaylist: async (title: string) => {
        const a = apiRef.current;
        if (!a) throw new Error('Not signed in');
        const pl = await a.createPlaylist(title, tracksRef.current.map((x) => x.item.id));
        invalidate('playlists');
        return pl;
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snap, error, start, voice],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function emptyDeck(id: DeckId): DeckView {
  return { id, track: null, positionMs: 0, durationMs: 0, mixOutMs: null, playing: false, loading: false, role: 'idle', rate: 1, volume: 0 };
}

function emptySnap(): Snap {
  return {
    active: false,
    phase: 'idle' as DjPhase,
    error: null,
    continuous: false,
    tracks: [] as DjMixTrack[],
    currentIndex: -1,
    liveDeck: 'A' as DeckId,
    decks: { A: emptyDeck('A'), B: emptyDeck('B') },
    crossfader: 0,
    mixing: false,
    analyzedShare: null,
    toppingUp: false,
    prompt: null,
    summary: null,
    understoodBy: null,
    hostActive: false,
    hostName: null,
    hostLine: null,
    audibleItemId: null,
  };
}

export function useDj(): DjValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDj outside DjProvider');
  return v;
}

/**
 * Advanced DJ (the DJ screen with decks, the AI DJ prompt and its voice host) is opt-in: Settings → Playback,
 * the same `advancedDj` preference as the web app. Entry points are hidden while it is off; a mix that is already
 * playing stays reachable from the mini player.
 */
export function useAdvancedDj(): boolean {
  const { user } = useSession();
  return user?.preferences.advancedDj ?? false;
}
