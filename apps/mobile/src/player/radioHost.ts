/**
 * Radio Host on the phone: a radio-style presenter for music streamed from the Vibe server (album, playlist, mix,
 * Endless, Your DJ). Mobile port of web/src/player/radioHost.ts — keep the timing maths and the controller in step.
 *
 * Thin client: the server decides whether to talk and what to say (POST /dj/break, about 30 s before a transition;
 * most calls return null). The phone only plays the break: the server-rendered clip (DjBreak.audioUrl, on a third
 * expo-audio player) or, when there is none, the server's text spoken by the device voice (expo-speech). Placement:
 *   - over-intro: the next track's player is ducked to ≈0.25 (−12 dB, ~400 ms ramps) while the host talks and is
 *     back at full ~2 s before its vocals (the "post": TrackAnalysis cues.introEndMs);
 *   - over-outro: the outgoing track's tail is ducked and the talk finishes as the transition starts;
 *   - gap: the outgoing track fades, a brief pause while the host talks, then the next track.
 * No downloads / offline playback, no on-device content. Anything late or failing is skipped silently
 * (console.debug); the music is never stopped or interrupted by the host and no error is shown.
 *
 * Pure (no React Native imports; every side effect injected), unit-tested in Node (tests/radio-host.test.mjs). The
 * player wiring is in src/state/music.tsx.
 */
import type { DjBreak, DjBreakKind, DjBreakRequest, HostChattiness, RadioHostPrefs, UserPreferences } from '../api/types';

export type DjBreakPlacement = DjBreak['placement'];
export type RadioHostCategories = RadioHostPrefs['categories'];

/** Radio Host voice preference meaning "always use this device's own speech". */
export const DEVICE_VOICE = 'device';
export const DEFAULT_HOST_CATEGORIES: RadioHostCategories = { announce: true, facts: true, jokes: false, weather: true, time: true, stats: true };
export const DEFAULT_RADIO_HOST: RadioHostPrefs = { enabled: false, chattiness: 'off', categories: DEFAULT_HOST_CATEGORIES, voice: null };

/** The listener's Radio Host preferences with defaults filled in (off by default; missing categories default on, as on the server). */
export function radioHostPrefs(prefs: Partial<UserPreferences> | null | undefined): RadioHostPrefs {
  const p = prefs?.radioHost;
  if (!p) return DEFAULT_RADIO_HOST;
  const chattiness: HostChattiness = p.enabled === false ? 'off' : (p.chattiness ?? 'off');
  return { enabled: chattiness !== 'off', chattiness, categories: { ...DEFAULT_HOST_CATEGORIES, ...(p.categories ?? {}) }, voice: p.voice ?? null };
}

/** The whole object to save (the server merges preferences per top-level key). */
export function withHostPatch(cur: RadioHostPrefs, patch: Partial<RadioHostPrefs>): RadioHostPrefs {
  const next = { ...cur, ...patch, categories: { ...cur.categories, ...(patch.categories ?? {}) } };
  return { ...next, enabled: next.chattiness !== 'off' };
}

/** The voice preference says "always the device voice" ('device' or 'device:<voice id>'). */
export const wantsDeviceVoice = (pref: string | null | undefined) => pref === DEVICE_VOICE || !!pref?.startsWith(`${DEVICE_VOICE}:`);
/** expo-speech voice identifier from a 'device:<id>' preference. */
export const deviceVoiceId = (pref: string | null | undefined) => (pref?.startsWith(`${DEVICE_VOICE}:`) ? pref.slice(DEVICE_VOICE.length + 1) || undefined : undefined);

/* ------------------------------------------------------------------ when to ask */

export interface HostGate {
  /** Who talks: 'radio' (Radio Host on), 'yourdj' (Your DJ commentary), null = nobody. */
  mode: 'radio' | 'yourdj' | null;
  /** The AI DJ endpoints are usable (signed in, online, the server reports the AI DJ on, no 403). */
  aiOn: boolean;
  casting: boolean;
  muted: boolean;
  /** The outgoing or incoming track plays from a download (offline playback): the host stays out of it. */
  localFile: boolean;
  /** Both sides of the transition are music tracks. */
  tracks: boolean;
  repeatOne: boolean;
}

/** May the player ask the server for a break at all? (false = no request is made) */
export function hostMayAsk(g: HostGate): boolean {
  return !!g.mode && g.aiOn && !g.casting && !g.muted && !g.localFile && g.tracks && !g.repeatOne;
}

/* ------------------------------------------------------------------ ducking */

/**
 * The music level while the host talks, as a piecewise-linear envelope over wall time (ms): expo-audio has no gain
 * automation, so the player samples `factor(now)` (≈ every 50 ms, and on every player status update) and multiplies it
 * into the players' volumes. Because the release is part of the envelope, the music comes back on time even when JS
 * timers are throttled in the background.
 */
export class Ducker {
  private pts: { t: number; v: number }[] = [];

  /** 0–1 music level at `now`. */
  factor(now: number): number {
    const p = this.pts;
    if (!p.length) return 1;
    if (now <= p[0]!.t) return p[0]!.v;
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1]!;
      const b = p[i]!;
      if (now <= b.t) return b.t === a.t ? b.v : a.v + ((b.v - a.v) * (now - a.t)) / (b.t - a.t);
    }
    return p[p.length - 1]!.v;
  }

  /** The envelope still moves, or holds the music below full. */
  active(now: number): boolean {
    const p = this.pts;
    if (!p.length) return false;
    const last = p[p.length - 1]!;
    if (now >= last.t && last.v >= 1) {
      this.pts = [];
      return false;
    }
    return true;
  }

  /** Attack at `duckInMs` from now (ramp to `gain`), hold, release at `releaseInMs` (ramp back to 1). */
  duck(now: number, duckInMs: number, releaseInMs: number, gain = DUCK_GAIN, rampMs = DUCK_RAMP_MS) {
    const f = this.factor(now);
    const d = now + Math.max(0, duckInMs);
    const r = Math.max(d + rampMs, now + releaseInMs);
    this.pts = [{ t: now, v: f }, { t: d, v: f }, { t: d + rampMs, v: gain }, { t: r, v: gain }, { t: r + rampMs, v: 1 }];
  }

  /** Back to full over `rampMs` from wherever it is now. */
  unduck(now: number, rampMs = DUCK_RAMP_MS) {
    const f = this.factor(now);
    if (f >= 1 && !this.pts.length) return;
    this.pts = [{ t: now, v: f }, { t: now + Math.max(1, rampMs), v: 1 }];
  }

  /** Fade the music out over `ms` and hold it silent (a gap break, "switch it up"). */
  fadeOut(now: number, ms: number) {
    const f = this.factor(now);
    this.pts = [{ t: now, v: f }, { t: now + Math.max(1, ms), v: 0 }];
  }

  /** Full level now. */
  reset() {
    this.pts = [];
  }
}

export const DUCK_DB = -12;
export const dbToGain = (db: number) => Math.pow(10, db / 20);
/** Music level while the host talks (−12 dB ≈ 0.25). */
export const DUCK_GAIN = dbToGain(DUCK_DB);
/** Attack / release of the duck. */
export const DUCK_RAMP_MS = 400;
/** Music is back at full this long before the incoming track's vocals ("post"). */
export const POST_LEAD_MS = 2000;
/** Ask for a break this long before the transition. */
export const REQUEST_LEAD_MS = 30000;
/** Too close to the transition to prepare a break: stay quiet. */
export const MIN_LEAD_MS = 8000;
/** The voice must be ready at least this long before it should start, or the break is skipped. */
export const PREP_MARGIN_MS = 300;
/** Gap: the outgoing track fades over this long before the talk. */
export const GAP_FADE_MS = 700;
/** Gap: pause after the talk before the next track. */
export const GAP_PAD_MS = 250;
/** Over-outro: the talk ends this long before the transition. */
export const OUTRO_PAD_MS = 300;
/** Over-outro talk is never longer than this (the outgoing track may still be singing). */
export const MAX_OUTRO_TALK_MS = 15000;
export const WORDS_PER_SEC = 3;

/** Speaking time of `text` at ~3 words/s (plus a little breath). */
export function estimateSpeechMs(text: string, wordsPerSec = WORDS_PER_SEC): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return words ? Math.round((words / wordsPerSec) * 1000 + 400) : 0;
}

/**
 * The incoming track's talk-over window as the listener hears it: from where it starts playing (its mix-in point)
 * to its vocal start (`introEndMs`), in wall time at `rate`. null when unknown.
 */
export function talkWindowMs(introEndMs: number | null | undefined, startMs: number, rate = 1): number | null {
  if (introEndMs == null || !Number.isFinite(introEndMs) || introEndMs <= startMs) return introEndMs == null ? null : 0;
  return Math.round((introEndMs - startMs) / (rate || 1));
}

/** Should the player ask for a break now? `remainingMs` = wall time until the transition. */
export function askState(remainingMs: number): 'wait' | 'ask' | 'late' {
  if (!Number.isFinite(remainingMs)) return 'wait';
  if (remainingMs > REQUEST_LEAD_MS) return 'wait';
  return remainingMs < MIN_LEAD_MS ? 'late' : 'ask';
}

export interface TimelineInput {
  placement: DjBreakPlacement;
  /** Wall ms from now until the transition (blend start / track change). */
  transitionInMs: number;
  /** Talk-over window of the incoming track (ms after it starts), null = unknown. */
  introMs: number | null;
  speechMs: number;
}

/** When everything happens, in ms from the moment the plan was made. */
export interface BreakTimeline {
  placement: DjBreakPlacement;
  speakAtMs: number;
  speechEndMs: number;
  /** Duck attack starts (null = no duck: gap). */
  duckAtMs: number | null;
  /** Release (ramp back up) starts. */
  releaseAtMs: number | null;
  /** Music level while ducked. */
  gain: number;
  /** Gap: the outgoing music fades out here, and the next track starts at `resumeAtMs`. */
  gapAtMs?: number;
  resumeAtMs?: number;
}

function overIntro(T: number, introMs: number | null, speech: number): BreakTimeline | null {
  if (introMs == null) return null;
  const speakAt = T + DUCK_RAMP_MS;
  const fullBy = T + introMs - POST_LEAD_MS;
  // The talk (and the release ramp) must be over before the music has to be back at full.
  if (speakAt + speech + DUCK_RAMP_MS > fullBy + 1) return null;
  const end = speakAt + speech;
  return { placement: 'over-intro', speakAtMs: speakAt, speechEndMs: end, duckAtMs: T, releaseAtMs: end, gain: DUCK_GAIN };
}
function overOutro(T: number, speech: number): BreakTimeline | null {
  if (speech > MAX_OUTRO_TALK_MS) return null;
  const speakAt = T - OUTRO_PAD_MS - speech;
  const duckAt = speakAt - DUCK_RAMP_MS;
  if (duckAt < 0) return null;
  return { placement: 'over-outro', speakAtMs: speakAt, speechEndMs: speakAt + speech, duckAtMs: duckAt, releaseAtMs: speakAt + speech, gain: DUCK_GAIN };
}
function gap(T: number, speech: number): BreakTimeline {
  const speakAt = T + GAP_FADE_MS;
  return { placement: 'gap', speakAtMs: speakAt, speechEndMs: speakAt + speech, duckAtMs: null, releaseAtMs: null, gain: 1, gapAtMs: T, resumeAtMs: speakAt + speech + GAP_PAD_MS };
}

/**
 * Plan a break. Over-intro that doesn't fit before the vocals (or with an unknown intro) moves over the outro; an
 * over-outro that can't start in time moves over the intro; null = skip it (nothing fits).
 */
export function planBreakTimeline(inp: TimelineInput): BreakTimeline | null {
  const T = inp.transitionInMs;
  const s = Math.max(0, inp.speechMs);
  if (!Number.isFinite(T) || T < 0 || s <= 0) return null;
  if (inp.placement === 'gap') return gap(T, s);
  if (inp.placement === 'over-intro') return overIntro(T, inp.introMs, s) ?? overOutro(T, s);
  return overOutro(T, s) ?? overIntro(T, inp.introMs, s);
}

/** The duck as gain automation points on the audio clock (s): attack, hold, release. */
export function duckPoints(tl: Pick<BreakTimeline, 'duckAtMs' | 'releaseAtMs' | 'gain'>, nowSec: number, rampMs = DUCK_RAMP_MS): { t: number; v: number }[] {
  if (tl.duckAtMs == null || tl.releaseAtMs == null) return [];
  const d = nowSec + tl.duckAtMs / 1000;
  const ramp = rampMs / 1000;
  const r = Math.max(d + ramp, nowSec + tl.releaseAtMs / 1000);
  return [{ t: d, v: 1 }, { t: d + ramp, v: tl.gain }, { t: r, v: tl.gain }, { t: r + ramp, v: 1 }];
}

/** The voice was ready early enough to start on time. */
export function readyInTime(readyAtMs: number, speakAtMs: number, margin = PREP_MARGIN_MS): boolean {
  return readyAtMs <= speakAtMs - margin;
}

/* ------------------------------------------------------------------ controller */

/** A prepared voice line. `play` resolves when it finished (or was stopped) and rejects when it fails. */
export interface HostVoice {
  durationMs: number | null;
  play(volume: number): Promise<void>;
  stop(): void;
  setVolume(v: number): void;
}

export interface HostSnapshot {
  caption: string | null;
  speaking: boolean;
  kind: DjBreakKind | null;
}

export interface HostDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  fetchBreak(req: DjBreakRequest, signal: AbortSignal): Promise<DjBreak | null>;
  prepareVoice(brk: DjBreak, signal: AbortSignal): Promise<HostVoice | null>;
  /** Duck the music: attack at `duckInMs` from now, release at `releaseInMs`. false = can't duck (no Web Audio): talk anyway. */
  duck(duckInMs: number, releaseInMs: number, gain: number, rampMs: number): boolean;
  /** Ramp the music back to full now. */
  unduck(rampMs: number): void;
  /** Voice level (the music volume, 0 when muted). */
  volume(): number;
  onState(s: HostSnapshot): void;
  log(...args: unknown[]): void;
}

type SlotState = 'fetching' | 'ready' | 'scheduled' | 'speaking' | 'done';
interface Slot {
  key: string;
  state: SlotState;
  abort: AbortController;
  timers: unknown[];
  transitionAt: number;
  introMs: number | null;
  brk?: DjBreak;
  voice?: HostVoice;
  tl?: BreakTimeline;
  /** The transition already happened while the break was still being prepared. */
  passed?: boolean;
  ducked?: boolean;
  finish?: () => void;
}

/**
 * Drives one break at a time. The player calls `ask` ~30 s before a transition, `retime` as playback moves,
 * `onTransition` when the blend / track change actually starts, and (gap) `wantsGap` + `playGap` at the end of the
 * outgoing track. `cancel` on seek / skip / pause / queue changes.
 */
export class RadioHost {
  private slot: Slot | null = null;
  private muted = false;
  private snapshot: HostSnapshot = { caption: null, speaking: false, kind: null };
  private lastBreakAt: number;
  private tracksSince = 0;
  private captionTimer: unknown = null;

  private deps: HostDeps;

  constructor(deps: HostDeps) {
    this.deps = deps;
    this.lastBreakAt = deps.now();
  }

  get state(): HostSnapshot {
    return this.snapshot;
  }
  get isMuted() {
    return this.muted;
  }
  /** Key of the break being prepared / played, and its state (for tests and the player). */
  get current(): { key: string; state: SlotState; placement?: DjBreakPlacement } | null {
    return this.slot ? { key: this.slot.key, state: this.slot.state, placement: this.slot.tl?.placement } : null;
  }

  /** For DjBreakRequest.tracksSinceBreak / msSinceBreak. */
  stats() {
    return { tracksSinceBreak: this.tracksSince, msSinceBreak: Math.max(0, Math.round(this.deps.now() - this.lastBreakAt)) };
  }
  noteTrackStarted() {
    this.tracksSince++;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (m) this.cancel();
  }

  private emit(s: Partial<HostSnapshot>) {
    this.snapshot = { ...this.snapshot, ...s };
    this.deps.onState(this.snapshot);
  }

  private clear(slot: Slot) {
    slot.timers.forEach((t) => this.deps.clearTimer(t));
    slot.timers = [];
  }

  /** Drop the break for `key` (any break when omitted): stop talking, music back to full. Never touches playback. */
  cancel(key?: string) {
    const s = this.slot;
    if (!s || (key != null && s.key !== key)) return;
    this.slot = null;
    s.abort.abort();
    this.clear(s);
    if (s.state === 'speaking' || s.ducked) {
      try {
        s.voice?.stop();
      } catch {
        /* ignore */
      }
      this.deps.unduck(DUCK_RAMP_MS);
    }
    s.state = 'done';
    s.finish?.();
    if (this.snapshot.speaking || this.snapshot.caption) this.emit({ caption: null, speaking: false, kind: null });
  }

  /** "Skip talk": the host stops; the music carries on (a gap moves straight on to the next track). */
  skip() {
    this.cancel();
  }

  private skipSilently(s: Slot, why: string) {
    this.deps.log('[radio host] skipped:', why, s.key);
    if (this.slot === s) this.cancel();
  }

  /** Ask for a break before the transition `key` (once per key). `transitionAt` is on the deps.now() clock. */
  ask(key: string, req: DjBreakRequest, transitionAt: number, introMs: number | null) {
    if (this.muted || this.slot?.key === key) return;
    // Never cut the host off mid-sentence for the next break (e.g. a Your DJ intro on a short song).
    if (this.slot?.state === 'speaking') return;
    this.cancel();
    const s: Slot = { key, state: 'fetching', abort: new AbortController(), timers: [], transitionAt, introMs };
    this.slot = s;
    void (async () => {
      try {
        const brk = await this.deps.fetchBreak(req, s.abort.signal);
        if (this.slot !== s) return;
        if (!brk || !brk.text?.trim()) {
          // Most transitions: the host stays quiet.
          s.state = 'done';
          return;
        }
        s.brk = brk;
        const voice = await this.deps.prepareVoice(brk, s.abort.signal);
        if (this.slot !== s) {
          voice?.stop();
          return;
        }
        if (!voice) return this.skipSilently(s, 'no voice');
        s.voice = voice;
        this.arm(s);
      } catch (e) {
        if (this.slot === s) this.skipSilently(s, (e as Error)?.message ?? String(e));
      }
    })();
  }

  private speechMs(s: Slot): number {
    const est = estimateSpeechMs(s.brk!.text);
    const known = s.voice?.durationMs ?? s.brk!.durationMs;
    return Math.max(300, Math.min(known && known > 0 ? known : est, (s.brk!.maxMs || 45000) + 2000));
  }

  /** The voice is ready: plan the timeline against the transition and schedule what can be scheduled. */
  private arm(s: Slot) {
    const now = this.deps.now();
    if (s.passed) {
      // The transition started while preparing: only the intro window may still be usable.
      if (s.brk!.placement !== 'over-intro') return this.skipSilently(s, 'late');
    }
    const tl = planBreakTimeline({ placement: s.brk!.placement, transitionInMs: Math.max(0, s.transitionAt - now), introMs: s.introMs, speechMs: this.speechMs(s) });
    if (!tl) return this.skipSilently(s, 'does not fit');
    if (!readyInTime(0, tl.speakAtMs)) return this.skipSilently(s, 'not ready in time');
    s.tl = tl;
    s.state = 'ready';
    if (tl.placement === 'over-outro') this.scheduleOutro(s);
    else if (tl.placement === 'over-intro' && s.passed) this.startIntro(s, now - s.transitionAt);
  }

  private scheduleOutro(s: Slot) {
    this.clear(s);
    const tl = s.tl!;
    s.state = 'scheduled';
    s.timers.push(this.deps.setTimer(() => {
      if (this.slot !== s) return;
      s.ducked = this.deps.duck(0, tl.releaseAtMs! - tl.duckAtMs!, tl.gain, DUCK_RAMP_MS);
    }, Math.max(0, tl.duckAtMs!)));
    s.timers.push(this.deps.setTimer(() => this.speak(s), Math.max(0, tl.speakAtMs)));
  }

  /** Playback moved (rate change, small seek): re-plan an over-outro that hasn't started talking yet. */
  retime(key: string, transitionAt: number) {
    const s = this.slot;
    if (!s || s.key !== key) return;
    const moved = Math.abs(transitionAt - s.transitionAt) > 250;
    s.transitionAt = transitionAt;
    if (!moved || s.state === 'speaking' || s.ducked || s.tl?.placement !== 'over-outro') return;
    const tl = planBreakTimeline({ placement: 'over-outro', transitionInMs: transitionAt - this.deps.now(), introMs: s.introMs, speechMs: this.speechMs(s) });
    if (!tl || tl.placement !== 'over-outro') return this.skipSilently(s, 'retimed out');
    s.tl = tl;
    this.scheduleOutro(s);
  }

  /** The transition `key` started now (blend began / next track started). `introMs` = the incoming talk window. */
  onTransition(key: string, introMs?: number | null) {
    const s = this.slot;
    if (!s || s.key !== key) return;
    if (introMs !== undefined) s.introMs = introMs;
    if (s.state === 'fetching') {
      s.passed = true;
      s.transitionAt = this.deps.now();
      return;
    }
    if (s.state === 'ready' && s.tl?.placement === 'over-intro') this.startIntro(s, 0);
    else if (s.state === 'ready' && s.tl?.placement === 'gap') this.skipSilently(s, 'gap missed');
  }

  /** Over-intro from the start of the incoming track (`sinceMs` after it started). */
  private startIntro(s: Slot, sinceMs: number) {
    const tl = planBreakTimeline({ placement: 'over-intro', transitionInMs: 0, introMs: s.introMs != null ? s.introMs - sinceMs : null, speechMs: this.speechMs(s) });
    if (!tl || tl.placement !== 'over-intro') return this.skipSilently(s, 'intro too short');
    s.tl = tl;
    s.state = 'scheduled';
    s.ducked = this.deps.duck(0, tl.releaseAtMs!, tl.gain, DUCK_RAMP_MS);
    s.timers.push(this.deps.setTimer(() => this.speak(s), tl.speakAtMs));
  }

  /** At the end of the outgoing track: is a gap break ready for `key`? */
  wantsGap(key: string): boolean {
    const s = this.slot;
    return !!s && s.key === key && s.state === 'ready' && s.tl?.placement === 'gap' && !this.muted;
  }

  /** Talk in the gap (the player has faded the music out). Always resolves: when done, skipped or failed. */
  playGap(key: string): Promise<void> {
    const s = this.slot;
    if (!s || s.key !== key || !this.wantsGap(key)) return Promise.resolve();
    return new Promise((resolve) => {
      s.finish = resolve;
      this.speak(s);
    });
  }

  /**
   * Play a break right now over the current track's start (a Your DJ segment intro or a "switch it up"
   * acknowledgement). `introMs` = what is left of the current track's talk-over window. Skipped if the voice isn't
   * ready within `deadlineMs`.
   */
  playNow(brk: DjBreak, introMs: number | null, deadlineMs = 4000) {
    if (this.muted) return;
    this.cancel();
    const key = `now:${brk.id}`;
    const t0 = this.deps.now();
    const s: Slot = { key, state: 'fetching', abort: new AbortController(), timers: [], transitionAt: t0, introMs, brk };
    this.slot = s;
    void (async () => {
      try {
        const voice = await this.deps.prepareVoice(brk, s.abort.signal);
        if (this.slot !== s) {
          voice?.stop();
          return;
        }
        if (!voice) return this.skipSilently(s, 'no voice');
        s.voice = voice;
        const waited = this.deps.now() - t0;
        if (waited > deadlineMs) return this.skipSilently(s, 'not ready in time');
        const speech = this.speechMs(s);
        // Over what's left of the intro when it fits; otherwise a short duck over the music (it's the listener's own tap).
        const tl = planBreakTimeline({ placement: 'over-intro', transitionInMs: 0, introMs: introMs != null ? introMs - waited : null, speechMs: speech })
          ?? { placement: 'over-intro' as const, speakAtMs: DUCK_RAMP_MS, speechEndMs: DUCK_RAMP_MS + speech, duckAtMs: 0, releaseAtMs: DUCK_RAMP_MS + speech, gain: DUCK_GAIN };
        s.tl = tl;
        s.state = 'scheduled';
        s.ducked = this.deps.duck(0, tl.releaseAtMs!, tl.gain, DUCK_RAMP_MS);
        s.timers.push(this.deps.setTimer(() => this.speak(s), tl.speakAtMs));
      } catch (e) {
        if (this.slot === s) this.skipSilently(s, (e as Error)?.message ?? String(e));
      }
    })();
  }

  /** A caption without a voice (commentary off): shown for `ms`. */
  caption(text: string, ms = 4000) {
    if (this.snapshot.speaking) return;
    if (this.captionTimer) this.deps.clearTimer(this.captionTimer);
    this.emit({ caption: text, speaking: false, kind: null });
    this.captionTimer = this.deps.setTimer(() => {
      this.captionTimer = null;
      if (!this.snapshot.speaking) this.emit({ caption: null });
    }, ms);
  }

  private speak(s: Slot) {
    if (this.slot !== s || !s.voice || !s.brk || this.muted) return;
    s.state = 'speaking';
    this.lastBreakAt = this.deps.now();
    this.tracksSince = 0;
    if (this.captionTimer) {
      this.deps.clearTimer(this.captionTimer);
      this.captionTimer = null;
    }
    this.emit({ caption: s.brk.text, speaking: true, kind: s.brk.kind });
    const speech = this.speechMs(s);
    const done = (failed?: unknown) => {
      if (this.slot !== s) return;
      if (failed) this.deps.log('[radio host] voice failed:', (failed as Error)?.message ?? failed);
      this.clear(s);
      this.slot = null;
      s.state = 'done';
      // Talk ended early (or failed): bring the music back now rather than at the planned release.
      if (s.ducked) this.deps.unduck(DUCK_RAMP_MS);
      this.emit({ caption: null, speaking: false, kind: null });
      s.finish?.();
    };
    // A voice that never reports its end can't hold the music down (or a gap) forever.
    s.timers.push(this.deps.setTimer(() => {
      try {
        s.voice?.stop();
      } catch {
        /* ignore */
      }
      done();
    }, speech * 1.5 + 3000));
    try {
      s.voice.play(this.deps.volume()).then(() => done(), (e) => done(e ?? 'error'));
    } catch (e) {
      done(e);
    }
  }
}

