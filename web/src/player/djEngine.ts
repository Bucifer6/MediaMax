/**
 * DJ engine: two decks, automatic beat-matched crossfades and continuous mixes.
 *
 * The server plans every transition (mix-out point on a bar of the outgoing track, mix-in on a beat of the
 * incoming one, crossfade length, tempo ratio). This engine executes the plan precisely:
 *   - preloads the next track on the idle deck ~15 s ahead, already seeked to its mix-in point,
 *   - starts it the moment the live deck reaches the mix-out point (a short timer closes the gap between ticks),
 *   - runs the transition on a small Web Audio mixer per deck (into a safety limiter) — 2-band split (bass swap), high/low-pass filters
 *     (filter fade), beat-synced echo send (echo-out) and an equal-power crossfade — with every control
 *     automated on the audio clock (element volume ramps as a fallback),
 *   - plays the incoming track at the matched tempo with key lock during the blend (the browser's own
 *     pitch-preserving playback, or the WSOLA AudioWorklet in djKeylock.worklet.ts where that is missing; no
 *     tempo change at all when neither is available), then glides it back to its own tempo over N bars (or stays),
 *   - tops up the queue from the server in continuous mode.
 * Mixer styles and the WSOLA key lock are adapted from OpenDJ (MIT, github.com/Bucifer6/OpenDJ).
 */
import type { DjHostLine, DjMix, DjMixRequest, DjMixTrack, DjStatus, PlaybackInfo } from '@mediamax/shared';
import { getToken } from '../api/client';
import { api } from '../api/endpoints';
import { attachStream, type Attached } from './engine';
import { profileWithBitrate } from './deviceProfile';
import { djLive } from './djLive';
import {
  glideMs, levelsAt, matchRates, nextBarMs, resolveKeyLock, transitionLabel, transitionPoints, transitionProgress,
  type KeyLockMode,
} from './djMixer';
import { buildEcho, buildStrip, echoDelaySec, restStrip, scheduleTransition, type EchoBus, type FxStrip } from './djStrip';
import keylockWorkletUrl from './djKeylock.worklet.ts?worker&url';
import type { DjTransitionPreference } from '@mediamax/shared';

/** DJ mixer settings (kept per browser by the DJ page). */
export interface DjOptions {
  transitions: DjTransitionPreference;
  keyLock: KeyLockMode;
  /** Largest tempo change for beat-matching, percent. */
  maxStretchPct: number;
  /** After a tempo-matched transition: glide back to the track's own tempo, or stay at the matched tempo. */
  afterTransition: 'glide' | 'stay';
  glideBars: number;
}
export const DEFAULT_DJ_OPTIONS: DjOptions = { transitions: 'auto', keyLock: 'auto', maxStretchPct: 8, afterTransition: 'glide', glideBars: 16 };

export interface DeckState {
  track: DjMixTrack | null;
  positionMs: number;
  durationMs: number;
  /** 0–1 gain currently applied by the crossfader. */
  gain: number;
  rate: number;
  loading: boolean;
}

export interface DjState {
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';
  error: string | null;
  decks: [DeckState, DeckState];
  /** Which deck is audible (during a fade: the one fading out). */
  live: 0 | 1;
  /** -1 = fully deck A … +1 = fully deck B. */
  crossfader: number;
  transitioning: boolean;
  queue: DjMixTrack[];
  /** Index in `queue` of the track on the live deck. */
  index: number;
  continuous: boolean;
  fetching: boolean;
  /** AI DJ host: the line being spoken right now (for subtitles). */
  hostSpeaking: string | null;
  voice: boolean;
  /** What the AI DJ understood the request as. */
  summary: string | null;
  understoodBy: 'llm' | 'rules' | null;
  /** Running transition: label ("Bass swap"), progress 0–1. */
  transition: { label: string; progress: number } | null;
  options: DjOptions;
  /** Key-lock engine in use: browser time-stretch, WSOLA worklet, or off (no tempo matching). */
  keyLock: 'native' | 'worklet' | 'off';
}

/** One deck's mixer strip (Web Audio): the shared effect strip (djStrip.ts) behind the optional key-lock worklet. */
interface Strip extends FxStrip {
  src: MediaElementAudioSourceNode;
  keylock: AudioWorkletNode | null;
}

interface Deck {
  audio: HTMLAudioElement;
  gain: GainNode | null;
  strip: Strip | null;
  attached: Attached | null;
  sessionId: string | null;
  offsetMs: number;
  queueIndex: number;
  ready: boolean;
  lastReport: number;
  /** Bumped on every load/unload so a superseded async load can tell (and release what it started). */
  gen: number;
}

const PRELOAD_MS = 15000;
const TOPUP_BELOW = 3;

const OPTIONS_KEY = 'mm.dj.mixer';
function loadOptions(): DjOptions {
  try {
    const o = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? 'null');
    return o && typeof o === 'object' ? { ...DEFAULT_DJ_OPTIONS, ...o } : { ...DEFAULT_DJ_OPTIONS };
  } catch {
    return { ...DEFAULT_DJ_OPTIONS };
  }
}

/** Can this browser time-stretch an <audio> element without changing pitch? */
export function nativeKeyLock(): boolean {
  if (typeof HTMLMediaElement === 'undefined') return false;
  const p = HTMLMediaElement.prototype as unknown as Record<string, unknown>;
  return 'preservesPitch' in p || 'webkitPreservesPitch' in p || 'mozPreservesPitch' in p;
}

export class DjEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** @internal exposed for tests */
  decks: [Deck, Deck];
  private live: 0 | 1 = 0;
  private queue: DjMixTrack[] = [];
  private index = 0;
  private request: DjMixRequest = {};
  private continuous = false;
  private fetching = false;
  private status: DjState['status'] = 'idle';
  private error: string | null = null;
  private transitioning = false;
  private fadeStart = 0;
  private fadeLen = 0;
  private timer: number | null = null;
  private fireTimer: number | null = null;
  private listeners = new Set<(s: DjState) => void>();
  private gains: [number, number] = [1, 0];
  private easeTimer: number | null = null;
  private options: DjOptions = loadOptions();
  private keyLockMode: 'native' | 'worklet' | 'off' = 'off';
  private workletReady: Promise<boolean> | null = null;
  private echo: EchoBus | null = null;
  /** Running transition's effect and swap/cut points. */
  private fx: { fx: NonNullable<NonNullable<DjMixTrack['transition']>['fx']>; kSwap: number; kCut: number; label: string } | null = null;
  private pausedAt = 0;
  /** Fade clock: the audio clock (it freezes with the context on pause and drives the scheduled curves), else wall time. */
  private now(): number {
    return this.ctx ? this.ctx.currentTime * 1000 : performance.now();
  }

  constructor() {
    const mk = (): Deck => {
      const audio = new Audio();
      audio.preload = 'auto';
      (audio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
      return { audio, gain: null, strip: null, attached: null, sessionId: null, offsetMs: 0, queueIndex: -1, ready: false, lastReport: 0, gen: 0 };
    };
    this.decks = [mk(), mk()];
    for (const d of this.decks) d.audio.addEventListener('ended', () => this.onEnded(d));
    // Any other player starting (music, video, live TV) pauses the mix. Media 'play' events don't bubble; capture them.
    document.addEventListener('play', (e) => {
      if (this.status === 'playing' && !this.decks.some((d) => d.audio === e.target)) this.pause();
    }, true);
    window.addEventListener('mediamax:media-play', () => {
      if (this.status === 'playing') this.pause();
    });
  }

  /* ----------------------------- public API ---------------------------- */

  subscribe(fn: (s: DjState) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Mixer settings (transition feel, key lock, stretch limit, tempo after a transition). */
  getOptions(): DjOptions {
    return { ...this.options };
  }

  setOptions(o: Partial<DjOptions>) {
    this.options = { ...this.options, ...o };
    this.options.maxStretchPct = Math.max(1, Math.min(16, Number(this.options.maxStretchPct) || 8));
    this.options.glideBars = Math.max(1, Math.min(64, Math.round(Number(this.options.glideBars) || 16)));
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(this.options));
    } catch {
      /* private mode */
    }
    this.request = { ...this.request, transitions: this.options.transitions, maxStretchPct: this.options.maxStretchPct };
    if (this.ctx) void this.prepareKeyLock();
    this.emit();
  }

  /** What the browser supports for key lock (for the settings UI). */
  keyLockSupport() {
    const ctxOk = typeof AudioContext !== 'undefined';
    return { native: nativeKeyLock(), worklet: ctxOk && typeof AudioWorkletNode !== 'undefined' };
  }

  /* ------------------------------ AI DJ host ---------------------------- */

  private voiceOn = false;
  private summary: string | null = null;
  private understoodBy: 'llm' | 'rules' | null = null;
  private ai: DjStatus['ai'] | null = null;
  private lines = new Map<number, Promise<DjHostLine | null>>();
  private hostSpeaking: string | null = null;
  private voiceEl: HTMLAudioElement | null = null;

  /** Turn the spoken host on/off (it needs the server's AI DJ to be enabled). */
  setVoice(on: boolean, ai: DjStatus['ai'] | null) {
    this.ai = ai;
    this.voiceOn = on && !!ai?.enabled;
    if (!this.voiceOn) this.silence();
    this.emit();
  }

  /** Should the host talk before queue position `i`? Always for the opener, then by chattiness. */
  private wantsLine(i: number) {
    if (!this.voiceOn || !this.ai) return false;
    if (i === 0) return true;
    const every = this.ai.chattiness === 'chatty' ? 1 : this.ai.chattiness === 'rare' ? 4 : 2;
    return i % every === 0;
  }

  private fetchLine(i: number) {
    if (!this.wantsLine(i) || this.lines.has(i) || !this.queue[i]) return;
    const p = api.dj.host({
      previousItemId: i > 0 ? this.queue[i - 1]?.item.id : undefined, nextItemId: this.queue[i].item.id,
      position: i, prompt: this.request.prompt, hour: new Date().getHours(),
    }).catch(() => null);
    this.lines.set(i, p);
  }

  /** Speak a ready line over the music (ducked). Never waits: a line that isn't ready yet is skipped. */
  private async speakIfReady(i: number, maxWaitMs = 0) {
    const p = this.lines.get(i);
    if (!p) return;
    const line = await Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), maxWaitMs))]);
    if (!line?.text || !this.voiceOn || this.status !== 'playing') return;
    this.duck(true);
    this.hostSpeaking = line.text;
    this.emit();
    const done = () => {
      if (this.hostSpeaking !== line.text) return;
      this.hostSpeaking = null;
      this.duck(false);
      this.emit();
    };
    try {
      if (line.audioUrl) {
        const token = getToken();
        const el = (this.voiceEl ??= new Audio());
        el.src = `${line.audioUrl}${line.audioUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token ?? '')}`;
        el.onended = done;
        el.onerror = done;
        await el.play();
      } else if ('speechSynthesis' in window) {
        const u = new SpeechSynthesisUtterance(line.text);
        const voices = speechSynthesis.getVoices();
        // Prefer natural-sounding English voices where the browser has them.
        u.voice = voices.find((v) => /natural|neural|google uk english|samantha|daniel/i.test(v.name) && v.lang.startsWith('en'))
          ?? voices.find((v) => v.lang === navigator.language) ?? voices.find((v) => v.lang.startsWith('en')) ?? null;
        u.rate = 1.03;
        u.onend = done;
        u.onerror = done;
        speechSynthesis.cancel();
        speechSynthesis.speak(u);
        // Some browsers never fire onend for long utterances; don't leave the music ducked.
        setTimeout(done, Math.min(20000, 1500 + line.text.length * 75));
      } else done();
    } catch {
      done();
    }
  }

  private silence() {
    this.voiceEl?.pause();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (this.hostSpeaking) {
      this.hostSpeaking = null;
      this.duck(false);
    }
  }

  /** Lower the music under the host's voice (Web Audio master gain; element volume as a fallback). */
  private ducked = false;
  private duck(on: boolean) {
    if (this.ducked === on) return;
    this.ducked = on;
    if (this.master && this.ctx) {
      const g = this.master.gain;
      const t = this.ctx.currentTime;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(on ? 0.3 : 1, t + (on ? 0.35 : 1.2));
    } else {
      for (const d of this.decks) d.audio.volume = Math.max(0, Math.min(1, d.audio.volume * (on ? 0.3 : 1 / 0.3)));
    }
  }

  /** ♥ the track that's playing now: favourites it and steers future mixes. */
  love() {
    const t = this.queue[this.index];
    if (t) void api.dj.feedback({ itemId: t.item.id, kind: 'love' }).catch(() => {});
    return t?.item ?? null;
  }

  /** Start a mix. `request` is kept for continuous top-ups. */
  async start(mix: DjMix, request: DjMixRequest, continuous: boolean) {
    this.stop(false);
    this.ensureAudioGraph();
    await this.prepareKeyLock();
    this.queue = mix.tracks;
    this.request = { ...request, transitions: request.transitions ?? this.options.transitions, maxStretchPct: request.maxStretchPct ?? this.options.maxStretchPct };
    this.summary = mix.summary ?? null;
    this.understoodBy = mix.understoodBy ?? null;
    this.lines.clear();
    this.fetchLine(0);
    this.continuous = continuous;
    this.index = 0;
    this.live = 0;
    this.status = 'loading';
    this.error = null;
    this.emit();
    if (!this.queue.length) return this.fail('The mix is empty');
    try {
      await this.load(this.decks[0], 0, this.queue[0].analysis?.cueInMs ?? 0);
      this.setGain(0, 1);
      this.setGain(1, 0);
      await this.ctx?.resume();
      await this.decks[0].audio.play();
      this.status = 'playing';
      this.startTicking();
      this.updateMediaSession();
      // Opening line over the intro (waits up to 4 s for it, the music is already playing).
      void this.speakIfReady(0, 4000);
    } catch (e) {
      this.fail((e as Error).message);
    }
    this.emit();
  }

  pause() {
    if (this.status !== 'playing') return;
    for (const d of this.decks) if (!d.audio.paused) d.audio.pause();
    this.silence();
    // Freeze scheduled mixer automation with the music.
    void this.ctx?.suspend().catch(() => {});
    this.pausedAt = performance.now();
    this.status = 'paused';
    this.report('paused');
    this.emit();
  }

  async resume() {
    if (this.status !== 'paused') return;
    await this.ctx?.resume();
    // Without Web Audio the fade runs on wall time: skip the paused stretch. (The audio clock froze with the context.)
    if (this.pausedAt && !this.ctx) this.fadeStart += performance.now() - this.pausedAt;
    this.pausedAt = 0;
    const liveDeck = this.decks[this.live];
    await liveDeck.audio.play().catch(() => {});
    if (this.transitioning) await this.decks[1 - this.live].audio.play().catch(() => {});
    this.status = 'playing';
    this.report('playing');
    this.emit();
  }

  stop(emit = true) {
    this.stopTicking();
    this.silence();
    this.lines.clear();
    for (const d of this.decks) this.unload(d);
    this.transitioning = false;
    this.queue = [];
    this.index = 0;
    this.status = 'idle';
    if (emit) this.emit();
  }

  /** Start the transition to the next track right now (snapped to the next bar when the tempo is known). */
  mixNow() {
    if (this.status !== 'playing' || this.transitioning) return;
    const next = this.queue[this.index + 1];
    if (!next) return;
    const cur = this.queue[this.index];
    const pos = this.position(this.decks[this.live]);
    const a = cur.analysis;
    // On the next bar line (counted from the first downbeat when known, not just any beat).
    const at = nextBarMs(pos + 300, a?.bpm, a?.downbeatMs ?? a?.beatOffsetMs) ?? pos + 200;
    next.transition = {
      ...(next.transition ?? { mixInMs: next.analysis?.cueInMs ?? 0, tempoRatio: 1, keyMatch: 'unknown', bpmDelta: null }),
      mixOutMs: Math.round(at), crossfadeMs: Math.min(8000, Math.max(2000, (next.transition?.crossfadeMs ?? 8000))), style: next.transition?.style === 'cut' ? 'cut' : 'fade',
      // A manual mix happens off-phrase: a filter fade (or the planned echo-out) hides that best.
      fx: next.transition?.fx === 'echo' ? 'echo' : a?.bpm ? 'filter' : 'none', swapAtMs: undefined, phraseAligned: false,
    } as NonNullable<DjMixTrack['transition']>;
    if (next.transition.style !== 'blend') next.transition.tempoRatio = 1;
    const idle = this.decks[1 - this.live];
    if (idle.queueIndex !== this.index + 1) void this.preload();
    this.emit();
  }

  /** Drop the upcoming track (and fetch more if needed). */
  skipNext() {
    if (this.transitioning || this.index + 1 >= this.queue.length) return;
    const idle = this.decks[1 - this.live];
    if (idle.queueIndex === this.index + 1) this.unload(idle);
    const removed = this.queue.splice(this.index + 1, 1)[0];
    if (removed) void api.dj.feedback({ itemId: removed.item.id, kind: 'skip' }).catch(() => {});
    // Queue positions shifted: drop host lines prepared for anything after the live track.
    for (const k of [...this.lines.keys()]) if (k > this.index) this.lines.delete(k);
    // The new upcoming track keeps its own mix-in; reuse the removed track's mix-out timing from the live track.
    const next = this.queue[this.index + 1];
    if (next && removed?.transition) next.transition = { ...(next.transition ?? removed.transition), mixOutMs: removed.transition.mixOutMs };
    void this.topUp();
    this.emit();
  }

  /** Remove a queued track by position (not the live or preloaded one). */
  removeAt(i: number) {
    if (i <= this.index + (this.decks[1 - this.live].queueIndex === this.index + 1 ? 1 : 0)) return;
    this.queue.splice(i, 1);
    for (const k of [...this.lines.keys()]) if (k >= i) this.lines.delete(k);
    void this.topUp();
    this.emit();
  }

  get tracksPlayed() {
    return this.queue.slice(0, this.index + 1).map((t) => t.item.id);
  }

  allTrackIds() {
    return this.queue.map((t) => t.item.id);
  }

  snapshot(): DjState {
    const deck = (i: 0 | 1): DeckState => {
      const d = this.decks[i];
      const t = d.queueIndex >= 0 ? this.queue[d.queueIndex] ?? null : null;
      return {
        track: t, positionMs: this.position(d), durationMs: t?.item.durationMs ?? (isFinite(d.audio.duration) ? d.audio.duration * 1000 : 0),
        gain: this.gains[i], rate: d.audio.playbackRate, loading: !!t && !d.ready,
      };
    };
    const xf = this.gains[1] - this.gains[0];
    return {
      status: this.status, error: this.error, decks: [deck(0), deck(1)], live: this.live, crossfader: Math.max(-1, Math.min(1, xf)),
      transitioning: this.transitioning, queue: this.queue, index: this.index, continuous: this.continuous, fetching: this.fetching,
      hostSpeaking: this.hostSpeaking, voice: this.voiceOn, summary: this.summary, understoodBy: this.understoodBy,
      transition: this.transitioning && this.fx ? { label: this.fx.label, progress: transitionProgress(this.now(), this.fadeStart, this.fadeLen) } : null,
      options: { ...this.options }, keyLock: this.keyLockMode,
    };
  }

  /* ------------------------------ internals ---------------------------- */

  private emit() {
    const s = this.snapshot();
    djLive.set(s.status === 'playing');
    for (const l of this.listeners) l(s);
  }

  private fail(msg: string) {
    this.status = 'error';
    this.error = msg;
    this.stopTicking();
    this.emit();
  }

  /**
   * Per deck: source → [key-lock worklet] → input ─┬─ LR4 low-pass ─ low ─┐
   *                                                └─ LR4 high-pass ─ high ┴→ HPF → LPF → gain → master
   *                                                                             LPF → echoSend → echo bus → master
   */
  private ensureAudioGraph() {
    if (this.ctx || typeof AudioContext === 'undefined') return;
    try {
      const ctx = (this.ctx = new AudioContext({ latencyHint: 'playback' }));
      this.master = ctx.createGain();
      // Safety limiter: two tracks at full level around a bass swap can peak above 0 dBFS.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -2;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.25;
      this.master.connect(limiter).connect(ctx.destination);
      this.echo = buildEcho(ctx, this.master);
      for (const d of this.decks) {
        const src = ctx.createMediaElementSource(d.audio);
        const fx = buildStrip(ctx, this.echo);
        d.gain = ctx.createGain();
        src.connect(fx.input);
        fx.out.connect(d.gain).connect(this.master);
        d.strip = { ...fx, src, keylock: null };
      }
    } catch {
      this.ctx = null; // fall back to element volume
      this.echo = null;
      for (const d of this.decks) d.strip = null;
    }
  }

  /** Decide the key-lock engine and, for the worklet, load it and insert it in front of each deck's strip. */
  private async prepareKeyLock() {
    const support = this.keyLockSupport();
    let mode = resolveKeyLock(this.options.keyLock, support);
    if (mode === 'worklet') {
      const ok = await this.loadWorklet();
      if (!ok) mode = support.native && this.options.keyLock !== 'off' ? 'native' : 'off';
    }
    this.keyLockMode = mode;
    for (const d of this.decks) {
      const el = d.audio as HTMLAudioElement & { preservesPitch?: boolean; webkitPreservesPitch?: boolean; mozPreservesPitch?: boolean };
      const keep = mode !== 'worklet';
      el.preservesPitch = keep;
      el.webkitPreservesPitch = keep;
      el.mozPreservesPitch = keep;
      const st = d.strip;
      if (!st || !this.ctx) continue;
      if (mode === 'worklet' && !st.keylock) {
        try {
          const node = new AudioWorkletNode(this.ctx, 'mediamax-keylock', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
          st.src.disconnect();
          st.src.connect(node).connect(st.input);
          st.keylock = node;
        } catch {
          this.keyLockMode = support.native ? 'native' : 'off';
        }
      } else if (mode !== 'worklet' && st.keylock) {
        st.src.disconnect();
        st.keylock.disconnect();
        st.src.connect(st.input);
        st.keylock = null;
      }
      this.setRate(d, d.audio.playbackRate);
    }
  }

  private loadWorklet(): Promise<boolean> {
    if (!this.ctx?.audioWorklet) return Promise.resolve(false);
    return (this.workletReady ??= this.ctx.audioWorklet.addModule(keylockWorkletUrl).then(() => true, () => false));
  }

  /** Set a deck's tempo; the key stays put (browser time-stretch or the worklet undoing the resampling). */
  private setRate(d: Deck, rate: number) {
    const r = this.keyLockMode === 'off' ? 1 : rate;
    d.audio.playbackRate = r;
    const kl = d.strip?.keylock;
    if (kl && this.ctx) {
      const p = kl.parameters.get('pitch');
      p?.setValueAtTime(1 / r, this.ctx.currentTime);
    }
  }

  /** Put a deck's EQ/filters/echo send back to neutral. */
  private restStrip(d: Deck) {
    if (this.ctx) restStrip(this.ctx, d.strip);
  }

  private setGain(i: 0 | 1, v: number) {
    this.gains[i] = v;
    const d = this.decks[i];
    if (d.gain && this.ctx) {
      // A crossfade curve may still be scheduled; setting a value inside it throws in some browsers.
      d.gain.gain.cancelScheduledValues(0);
      d.gain.gain.setValueAtTime(v, this.ctx.currentTime);
    }
    else d.audio.volume = Math.max(0, Math.min(1, v));
  }

  private position(d: Deck) {
    if (d.queueIndex < 0) return 0;
    return d.audio.currentTime * 1000 + d.offsetMs;
  }

  private async load(d: Deck, queueIndex: number, startMs: number) {
    this.unload(d);
    const gen = d.gen;
    const t = this.queue[queueIndex];
    d.queueIndex = queueIndex;
    d.ready = false;
    const superseded = () => d.gen !== gen;
    const pi: PlaybackInfo = await api.playback.start(t.item.id, { startMs: Math.round(startMs) || undefined, deviceProfile: profileWithBitrate(null) });
    // The mix was stopped / restarted (or the deck reloaded) while the server was starting the stream: release it.
    if (superseded()) {
      api.playback.stop(pi.sessionId, true).catch(() => {});
      throw new DeckSuperseded();
    }
    d.sessionId = pi.sessionId;
    d.offsetMs = pi.streamStartMs ?? 0;
    this.setRate(d, 1);
    const attached = await attachStream(d.audio, pi, { onFatal: (_k, msg) => (d.gen === gen ? this.onDeckFailed(d, t, msg) : undefined) });
    if (superseded()) {
      attached.destroy();
      throw new DeckSuperseded();
    }
    d.attached = attached;
    await new Promise<void>((resolve) => {
      if (d.audio.readyState >= 1) return resolve();
      const done = () => {
        d.audio.removeEventListener('loadedmetadata', done);
        resolve();
      };
      d.audio.addEventListener('loadedmetadata', done);
      setTimeout(done, 15000);
    });
    // Direct streams start at 0: seek to the mix-in point ourselves.
    const want = (startMs - d.offsetMs) / 1000;
    if (want > 0.05 && Math.abs(d.audio.currentTime - want) > 0.05) d.audio.currentTime = want;
    await new Promise<void>((resolve) => {
      if (d.audio.readyState >= 3) return resolve();
      const done = () => {
        d.audio.removeEventListener('canplay', done);
        resolve();
      };
      d.audio.addEventListener('canplay', done);
      setTimeout(done, 15000);
    });
    if (superseded()) throw new DeckSuperseded();
    d.ready = true;
    this.emit();
  }

  /**
   * A deck's stream died. The live deck: carry on with the next track (hard cut) or end with an error; the
   * preloaded / incoming deck: drop that track (abandoning a running transition) so the next tick prepares the one after.
   */
  private onDeckFailed(d: Deck, t: DjMixTrack, msg: string) {
    const isLive = d === this.decks[this.live];
    if (isLive && !this.transitioning) {
      const next = this.queue[this.index + 1];
      if (!next) return this.fail(`Can't play "${t.item.title}": ${msg}`);
      d.audio.pause();
      this.onEnded(d);
      return;
    }
    if (isLive) {
      // The outgoing deck failed mid-transition: the incoming one simply takes over now.
      this.finishTransition();
      return;
    }
    const i = d.queueIndex;
    if (this.transitioning) this.abortTransition();
    this.unload(d);
    if (i === this.index + 1 && this.queue[i]?.item.id === t.item.id) this.dropUpcoming(i);
    this.emit();
  }

  /** Remove the upcoming entry `i`; the one after it keeps the mix-out timing that was planned from the live track. */
  private dropUpcoming(i: number) {
    const removed = this.queue.splice(i, 1)[0];
    for (const k of [...this.lines.keys()]) if (k >= i) this.lines.delete(k);
    const next = this.queue[i];
    if (next && removed?.transition && i === this.index + 1) next.transition = { ...(next.transition ?? removed.transition), mixOutMs: removed.transition.mixOutMs };
    return removed;
  }

  /** Stop a running transition and put the outgoing (live) deck back to full level. */
  private abortTransition() {
    const outIdx = this.live;
    this.transitioning = false;
    this.fx = null;
    this.setGain(outIdx, 1);
    this.setGain((1 - outIdx) as 0 | 1, 0);
    this.restStrip(this.decks[outIdx]);
  }

  private unload(d: Deck) {
    d.gen++;
    if (d.sessionId) {
      api.playback.progress(d.sessionId, { positionMs: Math.round(this.position(d)), state: 'stopped', sessionId: d.sessionId }, true).catch(() => {});
      api.playback.stop(d.sessionId, true).catch(() => {});
    }
    d.attached?.destroy();
    d.attached = null;
    this.restStrip(d);
    d.audio.pause();
    d.audio.removeAttribute('src');
    d.audio.load();
    d.sessionId = null;
    d.queueIndex = -1;
    d.ready = false;
    d.offsetMs = 0;
  }

  private startTicking() {
    this.stopTicking();
    this.timer = window.setInterval(() => this.tick(), 100);
  }

  private stopTicking() {
    if (this.timer) window.clearInterval(this.timer);
    if (this.fireTimer) window.clearTimeout(this.fireTimer);
    if (this.easeTimer) window.clearInterval(this.easeTimer);
    this.timer = this.fireTimer = this.easeTimer = null;
  }

  private tick() {
    if (this.status !== 'playing') return;
    const liveDeck = this.decks[this.live];
    const pos = this.position(liveDeck);
    const next = this.queue[this.index + 1];
    const idle = this.decks[1 - this.live];
    if (this.continuous && this.queue.length - this.index - 1 < TOPUP_BELOW) void this.topUp();
    if (next && !this.transitioning) {
      const tr = next.transition;
      const mixOut = tr?.mixOutMs ?? (liveDeck.audio.duration * 1000 - 6000);
      if (idle.queueIndex !== this.index + 1 && pos >= mixOut - PRELOAD_MS) void this.preload();
      // Close the last gap with a timer so the incoming beat lands on the bar.
      const remaining = (mixOut - pos) / (liveDeck.audio.playbackRate || 1);
      if (idle.queueIndex === this.index + 1 && idle.ready && remaining <= 150 && !this.fireTimer) {
        this.fireTimer = window.setTimeout(() => {
          this.fireTimer = null;
          this.beginTransition();
        }, Math.max(0, remaining));
      }
    }
    // Keep sessions alive and progress recorded.
    for (const d of this.decks) {
      if (d.sessionId && !d.audio.paused && Date.now() - d.lastReport > 10000) {
        d.lastReport = Date.now();
        api.playback.progress(d.sessionId, { positionMs: Math.round(this.position(d)), state: 'playing', sessionId: d.sessionId }).catch(() => {});
      }
    }
    if (this.transitioning) this.fadeStep();
    this.emit();
  }

  private preloading = false;
  private async preload() {
    if (this.preloading) return;
    const i = this.index + 1;
    const next = this.queue[i];
    if (!next) return;
    this.preloading = true;
    try {
      const idle = this.decks[1 - this.live];
      this.setGain((1 - this.live) as 0 | 1, 0);
      this.fetchLine(i);
      await this.load(idle, i, next.transition?.mixInMs ?? next.analysis?.cueInMs ?? 0);
    } catch (e) {
      if (!(e instanceof DeckSuperseded) && this.queue[i] === next) {
        // Unplayable: free the deck (it still claimed this queue slot, which stalled the mix until the live track
        // ended) and drop the track; the next tick prepares the following one.
        const idle = this.decks[1 - this.live];
        if (idle.queueIndex === i) this.unload(idle);
        this.dropUpcoming(i);
        this.emit();
      }
    } finally {
      this.preloading = false;
    }
  }

  private beginTransition() {
    if (this.transitioning || this.status !== 'playing') return;
    const inIdx = (1 - this.live) as 0 | 1;
    const incoming = this.decks[inIdx];
    const next = this.queue[this.index + 1];
    if (!next || incoming.queueIndex !== this.index + 1) return;
    const tr = next.transition;
    const outgoing = this.decks[this.live];
    // Tempo match with key lock (half/double time is already folded into the ratio). When the outgoing deck is
    // still stretched from the previous transition and the product would pass the limit, the outgoing deck moves
    // toward its own tempo instead, so the beats stay matched (a clamp alone drifts ~20 ms per second per percent).
    const wantMatch = !!tr?.tempoRatio && tr.style === 'blend' && this.keyLockMode !== 'off';
    const rates = wantMatch ? matchRates(tr!.tempoRatio, outgoing.audio.playbackRate || 1, this.options.maxStretchPct / 100) : { inRate: 1, outRate: outgoing.audio.playbackRate || 1 };
    if (Math.abs(rates.outRate - (outgoing.audio.playbackRate || 1)) > 1e-4) this.setRate(outgoing, rates.outRate);
    const outRate = rates.outRate;
    this.setRate(incoming, rates.inRate);
    // Started late (throttled timers, a slow preload): skip the incoming track ahead by the same amount so its
    // beats still land on the outgoing track's.
    const lateMs = tr?.mixOutMs ? (this.position(outgoing) - tr.mixOutMs) / outRate : 0;
    if (lateMs > 40 && lateMs < 4000 && tr?.style === 'blend') incoming.audio.currentTime += (lateMs * rates.inRate) / 1000;
    void incoming.audio.play();
    this.transitioning = true;
    this.fadeStart = this.now() + (this.ctx ? 10 : 0);
    // The plan is in the outgoing track's own time; at a matched tempo its bars pass faster/slower.
    this.fadeLen = Math.max(300, (tr?.crossfadeMs ?? 5000) / outRate);
    const fx = tr?.fx ?? 'none';
    const { kSwap, kCut } = tr ? transitionPoints(tr, outRate) : { kSwap: 0.5, kCut: 0.75 };
    this.fx = { fx, kSwap, kCut, label: tr ? transitionLabel(tr) : 'Crossfade' };
    // Every control the style uses, scheduled on the audio clock (smooth regardless of timer jitter).
    if (this.ctx && incoming.gain && outgoing.gain) {
      scheduleTransition(this.ctx, { outGain: outgoing.gain.gain, inGain: incoming.gain.gain, out: outgoing.strip, in: incoming.strip, echo: this.echo },
        fx, this.fadeStart / 1000, this.fadeLen / 1000, kSwap, kCut, { echoDelaySec: echoDelaySec(tr?.beatMs, outRate) });
    }
    this.updateMediaSession(next);
    void this.speakIfReady(this.index + 1);
    this.emit();
  }

  /** Track fade progress (and drive element volume when Web Audio isn't available). */
  private fadeStep() {
    const x = transitionProgress(this.now(), this.fadeStart, this.fadeLen);
    const inIdx = (1 - this.live) as 0 | 1;
    const l = levelsAt(this.fx?.fx ?? 'none', x, this.fx?.kSwap, this.fx?.kCut);
    this.gains[inIdx] = l.inGain;
    this.gains[this.live] = l.outGain;
    if (!this.ctx) {
      this.decks[inIdx].audio.volume = this.gains[inIdx];
      this.decks[this.live].audio.volume = this.gains[this.live];
    }
    if (x >= 1) this.finishTransition();
  }

  private finishTransition() {
    const out = this.decks[this.live];
    this.unload(out);
    this.live = (1 - this.live) as 0 | 1;
    this.index += 1;
    this.transitioning = false;
    this.gains = this.live === 0 ? [1, 0] : [0, 1];
    this.fx = null;
    this.setGain(this.live, 1);
    this.restStrip(this.decks[this.live]);
    if (this.options.afterTransition === 'glide') {
      const t = this.queue[this.index];
      this.easeRate(this.decks[this.live], glideMs(this.options.glideBars, t?.analysis?.bpm, this.decks[this.live].audio.playbackRate));
    }
    this.emit();
  }

  /** Glide a tempo-matched deck back to its natural speed (key stays locked throughout). */
  private easeRate(d: Deck, ms: number) {
    if (Math.abs(d.audio.playbackRate - 1) < 0.001) return;
    if (this.easeTimer) window.clearInterval(this.easeTimer);
    const from = d.audio.playbackRate;
    const t0 = performance.now();
    this.easeTimer = window.setInterval(() => {
      if (this.status === 'paused') return;
      const x = Math.min(1, (performance.now() - t0) / Math.max(500, ms));
      this.setRate(d, from + (1 - from) * x);
      if (x >= 1 && this.easeTimer) {
        window.clearInterval(this.easeTimer);
        this.easeTimer = null;
      }
    }, 100);
  }

  private onEnded(d: Deck) {
    if (d !== this.decks[this.live] || this.transitioning) return;
    const next = this.queue[this.index + 1];
    if (next) {
      // Ran out before the planned mix point (e.g. after a seek): hard swap.
      const idle = this.decks[1 - this.live];
      if (idle.queueIndex === this.index + 1 && idle.ready) {
        next.transition = { ...(next.transition ?? { mixInMs: 0, keyMatch: 'unknown', bpmDelta: null }), crossfadeMs: 300, style: 'cut', tempoRatio: 1, mixOutMs: 0, fx: 'none' } as NonNullable<DjMixTrack['transition']>;
        this.beginTransition();
        return;
      }
      void this.preload().then(() => this.beginTransition());
      return;
    }
    this.unload(d);
    this.status = 'ended';
    this.stopTicking();
    this.emit();
  }

  private async topUp() {
    if (this.fetching || !this.continuous) return;
    this.fetching = true;
    this.emit();
    try {
      const more = await api.dj.mix({ ...this.request, seedItemId: undefined, history: this.queue.map((t) => t.item.id), count: 5 });
      this.queue.push(...more.tracks);
    } catch {
      /* try again on a later tick */
    } finally {
      this.fetching = false;
      this.emit();
    }
  }

  private report(state: 'playing' | 'paused') {
    for (const d of this.decks) {
      if (d.sessionId) api.playback.progress(d.sessionId, { positionMs: Math.round(this.position(d)), state, sessionId: d.sessionId }).catch(() => {});
    }
  }

  private updateMediaSession(track = this.queue[this.index]) {
    if (!('mediaSession' in navigator) || !track) return;
    const it = track.item;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: it.title, artist: it.grandparentTitle ?? '', album: `DJ mix · ${it.parentTitle ?? ''}`,
      artwork: it.posterUrl ? [{ src: it.posterUrl, sizes: '512x512' }] : [],
    });
    navigator.mediaSession.setActionHandler('play', () => void this.resume());
    navigator.mediaSession.setActionHandler('pause', () => this.pause());
    navigator.mediaSession.setActionHandler('nexttrack', () => this.mixNow());
  }
}

/** A deck load that was overtaken by a stop / restart / reload (not an error). */
class DeckSuperseded extends Error {}

let shared: DjEngine | null = null;
/** One engine per tab. */
export function djEngine() {
  if (!shared) {
    shared = new DjEngine();
    // Handy for debugging and automated tests: window.mediamaxDj.snapshot()
    (window as unknown as { mediamaxDj?: DjEngine }).mediamaxDj = shared;
  }
  return shared;
}
