/**
 * DJ engine: two decks, automatic beat-matched crossfades and continuous mixes.
 *
 * The server plans every transition (mix-out point on a bar of the outgoing track, mix-in on a beat of the
 * incoming one, crossfade length, tempo ratio). This engine executes the plan precisely:
 *   - preloads the next track on the idle deck ~15 s ahead, already seeked to its mix-in point,
 *   - starts it the moment the live deck reaches the mix-out point (a short timer closes the gap between ticks),
 *   - runs an equal-power crossfade on Web Audio gain nodes (volume ramps as a fallback),
 *   - plays the incoming track at `tempoRatio` (pitch preserved) during the blend, then eases it back to 1.0,
 *   - tops up the queue from the server in continuous mode.
 */
import type { DjHostLine, DjMix, DjMixRequest, DjMixTrack, DjStatus, PlaybackInfo } from '@mediamax/shared';
import { getToken } from '../api/client';
import { api } from '../api/endpoints';
import { attachStream, type Attached } from './engine';
import { profileWithBitrate } from './deviceProfile';

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
}

interface Deck {
  audio: HTMLAudioElement;
  gain: GainNode | null;
  attached: Attached | null;
  sessionId: string | null;
  offsetMs: number;
  queueIndex: number;
  ready: boolean;
  lastReport: number;
}

const PRELOAD_MS = 15000;
const TOPUP_BELOW = 3;
const RATE_EASE_MS = 8000;

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

  constructor() {
    const mk = (): Deck => {
      const audio = new Audio();
      audio.preload = 'auto';
      (audio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
      return { audio, gain: null, attached: null, sessionId: null, offsetMs: 0, queueIndex: -1, ready: false, lastReport: 0 };
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
    this.queue = mix.tracks;
    this.request = request;
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
    this.status = 'paused';
    this.report('paused');
    this.emit();
  }

  async resume() {
    if (this.status !== 'paused') return;
    await this.ctx?.resume();
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
    let at = pos + 200;
    const a = cur.analysis;
    if (a?.bpm && a.beatOffsetMs != null) {
      const bar = (60000 / a.bpm) * 4;
      at = a.beatOffsetMs + Math.ceil((pos + 300 - a.beatOffsetMs) / bar) * bar;
    }
    next.transition = {
      ...(next.transition ?? { mixInMs: next.analysis?.cueInMs ?? 0, tempoRatio: 1, keyMatch: 'unknown', bpmDelta: null }),
      mixOutMs: Math.round(at), crossfadeMs: Math.min(8000, Math.max(2000, (next.transition?.crossfadeMs ?? 8000))), style: next.transition?.style === 'cut' ? 'cut' : 'fade',
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
    };
  }

  /* ------------------------------ internals ---------------------------- */

  private emit() {
    const s = this.snapshot();
    for (const l of this.listeners) l(s);
  }

  private fail(msg: string) {
    this.status = 'error';
    this.error = msg;
    this.stopTicking();
    this.emit();
  }

  private ensureAudioGraph() {
    if (this.ctx || typeof AudioContext === 'undefined') return;
    try {
      this.ctx = new AudioContext({ latencyHint: 'playback' });
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      for (const d of this.decks) {
        const src = this.ctx.createMediaElementSource(d.audio);
        d.gain = this.ctx.createGain();
        src.connect(d.gain).connect(this.master);
      }
    } catch {
      this.ctx = null; // fall back to element volume
    }
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
    const t = this.queue[queueIndex];
    d.queueIndex = queueIndex;
    d.ready = false;
    const pi: PlaybackInfo = await api.playback.start(t.item.id, { startMs: Math.round(startMs) || undefined, deviceProfile: profileWithBitrate(null) });
    d.sessionId = pi.sessionId;
    d.offsetMs = pi.streamStartMs ?? 0;
    d.audio.playbackRate = 1;
    d.attached = await attachStream(d.audio, pi, {
      onFatal: (_k, msg) => {
        if (d.queueIndex === this.index) this.fail(`Can't play "${t.item.title}": ${msg}`);
      },
    });
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
    d.ready = true;
    this.emit();
  }

  private unload(d: Deck) {
    if (d.sessionId) {
      api.playback.progress(d.sessionId, { positionMs: Math.round(this.position(d)), state: 'stopped', sessionId: d.sessionId }, true).catch(() => {});
      api.playback.stop(d.sessionId, true).catch(() => {});
    }
    d.attached?.destroy();
    d.attached = null;
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
    } catch {
      // Unplayable: drop it and let the next tick try the following track.
      this.queue.splice(i, 1);
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
    incoming.audio.playbackRate = tr?.tempoRatio && tr.style === 'blend' ? tr.tempoRatio : 1;
    void incoming.audio.play();
    this.transitioning = true;
    this.fadeStart = performance.now();
    this.fadeLen = Math.max(300, tr?.crossfadeMs ?? 5000);
    // Equal-power curves scheduled on the audio clock (smooth regardless of timer jitter).
    if (this.ctx && incoming.gain && this.decks[this.live].gain) {
      const n = 128;
      const up = new Float32Array(n);
      const down = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        const x = k / (n - 1);
        up[k] = Math.sin((x * Math.PI) / 2);
        down[k] = Math.cos((x * Math.PI) / 2);
      }
      const t0 = this.ctx.currentTime + 0.01;
      incoming.gain.gain.cancelScheduledValues(0);
      this.decks[this.live].gain!.gain.cancelScheduledValues(0);
      incoming.gain.gain.setValueCurveAtTime(up, t0, this.fadeLen / 1000);
      this.decks[this.live].gain!.gain.setValueCurveAtTime(down, t0, this.fadeLen / 1000);
    }
    this.updateMediaSession(next);
    void this.speakIfReady(this.index + 1);
    this.emit();
  }

  /** Track fade progress (and drive element volume when Web Audio isn't available). */
  private fadeStep() {
    const x = Math.min(1, (performance.now() - this.fadeStart) / this.fadeLen);
    const inIdx = (1 - this.live) as 0 | 1;
    this.gains[inIdx] = Math.sin((x * Math.PI) / 2);
    this.gains[this.live] = Math.cos((x * Math.PI) / 2);
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
    this.setGain(this.live, 1);
    this.easeRate(this.decks[this.live]);
    this.emit();
  }

  /** Ease a tempo-matched deck back to its natural speed. */
  private easeRate(d: Deck) {
    if (Math.abs(d.audio.playbackRate - 1) < 0.001) return;
    if (this.easeTimer) window.clearInterval(this.easeTimer);
    const from = d.audio.playbackRate;
    const t0 = performance.now();
    this.easeTimer = window.setInterval(() => {
      const x = Math.min(1, (performance.now() - t0) / RATE_EASE_MS);
      d.audio.playbackRate = from + (1 - from) * x;
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
        next.transition = { ...(next.transition ?? { mixInMs: 0, keyMatch: 'unknown', bpmDelta: null }), crossfadeMs: 300, style: 'cut', tempoRatio: 1, mixOutMs: 0 } as NonNullable<DjMixTrack['transition']>;
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
