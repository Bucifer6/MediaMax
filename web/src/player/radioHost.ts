/**
 * Radio Host: a radio-style presenter for any music listening (album, playlist, mix, folder, endless, Your DJ).
 *
 * About 30 s before a transition the player asks the server for a break (POST /dj/break). Most transitions come back
 * empty (the host stays quiet). When a break comes back, its voice is prepared while the current track plays (the
 * server's rendered speech, else the device's own speech synthesis) and it is played at its placement:
 *   - over-intro: the next track starts ducked (−12 dB, ~400 ms ramps), the host talks, and the music is back at full
 *     ~2 s before the vocals start (the "post", from the track analysis);
 *   - over-outro: the end of the outgoing track is ducked and the talk finishes as the next track comes in;
 *   - gap: the outgoing track fades, the host talks, then the next track starts.
 * Fallback is silent: a break that isn't ready in time, or a voice that fails, is skipped (console.debug only). The
 * music is never stopped or interrupted by the host, and no error is ever shown.
 *
 * The timing maths and the controller are pure (no DOM at import, every side effect injected), so they are
 * unit-tested in Node. `createHostVoice` (bottom) is the browser voice.
 */
import type { DjBreak, DjBreakKind, DjBreakPlacement, DjBreakRequest } from './djTypes';
import { DEVICE_VOICE } from './djTypes';

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

  constructor(private deps: HostDeps) {
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

/* ------------------------------------------------------------------ browser voice */

const hasSpeech = () => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';

/** The device voice to use for a "device:<name>" preference (or the first English voice). */
function pickDeviceVoice(pref: string | null | undefined): SpeechSynthesisVoice | null {
  try {
    const all = window.speechSynthesis.getVoices();
    const name = pref?.startsWith(`${DEVICE_VOICE}:`) ? pref.slice(DEVICE_VOICE.length + 1) : null;
    const chosen = name ? all.find((v) => v.name === name) : null;
    if (chosen) return chosen;
    // Automatic: on-device voices only (some browsers offer online voices that send the text to a speech service).
    const voices = all.filter((v) => v.localService !== false);
    const lang = navigator.language?.slice(0, 2) || 'en';
    return voices.find((v) => v.lang?.startsWith(lang) && v.default) || voices.find((v) => v.lang?.startsWith(lang)) || voices.find((v) => v.lang?.startsWith('en')) || voices[0] || null;
  } catch {
    return null;
  }
}

function deviceVoice(text: string, pref: string | null | undefined): HostVoice | null {
  if (!hasSpeech()) return null;
  let utter: SpeechSynthesisUtterance | null = null;
  let finish: (() => void) | null = null;
  return {
    durationMs: null,
    play(volume) {
      return new Promise<void>((resolve, reject) => {
        const u = new SpeechSynthesisUtterance(text);
        const v = pickDeviceVoice(pref);
        if (v) u.voice = v;
        else if (window.speechSynthesis.getVoices().some((x) => x.localService === false) && !window.speechSynthesis.getVoices().some((x) => x.localService !== false)) {
          // Only online voices here: stay quiet rather than send the text off the device.
          reject(new Error('no on-device voice'));
          return;
        }
        u.volume = Math.max(0, Math.min(1, volume));
        u.rate = 1.02;
        u.onend = () => resolve();
        u.onerror = (e) => ((e as SpeechSynthesisErrorEvent).error === 'interrupted' || (e as SpeechSynthesisErrorEvent).error === 'canceled' ? resolve() : reject(new Error((e as SpeechSynthesisErrorEvent).error || 'speech error')));
        utter = u;
        finish = resolve;
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
      });
    },
    stop() {
      if (utter) window.speechSynthesis.cancel();
      finish?.();
    },
    setVolume() {
      /* speech volume can't change mid-utterance */
    },
  };
}

/** Load a rendered voice line; resolves once it can play through, null on failure / timeout. */
function audioVoice(url: string, durationMs: number | null, signal: AbortSignal, timeoutMs: number): Promise<HostVoice | null> {
  return new Promise((resolve) => {
    const el = new Audio();
    el.preload = 'auto';
    let settled = false;
    let finish: (() => void) | null = null;
    const voice: HostVoice = {
      get durationMs() {
        return Number.isFinite(el.duration) && el.duration > 0 ? Math.round(el.duration * 1000) : durationMs;
      },
      play(volume) {
        return new Promise<void>((res, rej) => {
          finish = res;
          el.volume = Math.max(0, Math.min(1, volume));
          el.onended = () => res();
          el.onerror = () => rej(new Error('voice audio error'));
          el.play().catch(rej);
        });
      },
      stop() {
        el.pause();
        el.removeAttribute('src');
        finish?.();
      },
      setVolume(v) {
        el.volume = Math.max(0, Math.min(1, v));
      },
    };
    const done = (v: HostVoice | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      el.oncanplaythrough = null;
      if (!v) {
        el.removeAttribute('src');
        el.load();
      }
      resolve(v);
    };
    const timer = window.setTimeout(() => done(null), timeoutMs);
    signal.addEventListener('abort', () => done(null));
    el.oncanplaythrough = () => done(voice);
    el.onerror = () => done(null);
    el.src = url;
    el.load();
  });
}

/**
 * The browser voice for a break: the server's rendered speech when there is one (and the listener didn't choose the
 * device voice), else the device's speech synthesis. A rendered line that fails to load falls back to the device
 * voice; null = no voice at all (the break is skipped).
 */
export async function createHostVoice(brk: DjBreak, pref: string | null | undefined, signal: AbortSignal, resolveUrl: (u: string) => string = (u) => u, timeoutMs = 12000): Promise<HostVoice | null> {
  const device = pref === DEVICE_VOICE || !!pref?.startsWith(`${DEVICE_VOICE}:`);
  if (brk.audioUrl && !device) {
    const v = await audioVoice(resolveUrl(brk.audioUrl), brk.durationMs, signal, timeoutMs);
    if (v || signal.aborted) return v;
  }
  return signal.aborted ? null : deviceVoice(brk.text, pref);
}

/** Device voices for the voice picker ("device:<name>"). */
export function deviceVoices(): { id: string; name: string }[] {
  if (!hasSpeech()) return [];
  try {
    return window.speechSynthesis.getVoices().map((v) => ({ id: `${DEVICE_VOICE}:${v.name}`, name: `${v.name}${v.lang ? ` (${v.lang})` : ''}${v.localService === false ? ' · online' : ''}` }));
  } catch {
    return [];
  }
}
