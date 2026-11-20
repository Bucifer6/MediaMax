import type { Item, PlaybackInfo, UserPreferences } from '@mediamax/shared';
import type { Attached } from './engine';

/** One of the music player's two audio elements ("decks"): the live one, and the one preloading the next track. */
export interface Deck {
  id: 0 | 1;
  el: HTMLAudioElement;
  attached: Attached | null;
  sessionId: string | null;
  info: PlaybackInfo | null;
  /** Media position at stream time 0. */
  offsetMs: number;
  /** Item / queue position this deck was loaded for (null = empty). */
  itemId: string | null;
  queueIndex: number;
  /** Media position to seek to once metadata is in. */
  pendingSeek: number | null;
  /** Bumped on every (re)load so stale async loads can be dropped. */
  token: number;
  /** The stream is attached and can start immediately. */
  ready: boolean;
}

/** ReplayGain factor for `item` (same rules as the mobile app, but a boost above 1x is allowed when the peak leaves headroom). */
export function replayGainFactor(item: Item | null | undefined, mode: UserPreferences['replayGain'], albumInOrder: boolean): number {
  const rg = item?.type === 'track' ? item.replayGain : null;
  const m = mode ?? 'auto';
  if (!rg || m === 'off') return 1;
  const useAlbum = m === 'album' || (m === 'auto' && albumInOrder);
  const db = useAlbum ? rg.albumGainDb ?? rg.trackGainDb : rg.trackGainDb ?? rg.albumGainDb;
  if (db == null || !Number.isFinite(db)) return 1;
  const peak = (useAlbum ? rg.albumPeak ?? rg.trackPeak : rg.trackPeak ?? rg.albumPeak) ?? null;
  let f = Math.pow(10, db / 20);
  // Never push the peak past full scale; without a known peak, never boost at all.
  f = peak && peak > 0 ? Math.min(f, 1 / peak) : Math.min(f, 1);
  return Math.max(0.05, Math.min(4, f));
}

/** The queue is one album played in order (ReplayGain 'auto' uses album gain; crossfade is skipped). */
export function isAlbumInOrder(queue: Item[], current: Item | null, shuffle: boolean) {
  return !!current && queue.length > 1 && !shuffle && !!current.parentId && queue.every((q) => q.parentId === current.parentId);
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * iOS suspends Web Audio when the page is in the background or the phone is locked, which would silence music routed
 * through it. There the graph is only used once the listener turns crossfade on.
 */
export const SUSPENDS_WEB_AUDIO_IN_BACKGROUND =
  typeof navigator !== 'undefined' && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

/**
 * Two audio elements routed through Web Audio: per-deck gain (ReplayGain × fade) into a master gain (volume × mute ×
 * sleep fade). Falls back to element volume (no boost, stepped fades) where Web Audio isn't available.
 */
export class MusicOutput {
  readonly decks: [Deck, Deck];
  private live: 0 | 1 = 0;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private gains: [GainNode | null, GainNode | null] = [null, null];
  private failed = false;
  /** ReplayGain factor per deck and fade level per deck (0–1). */
  private rg: [number, number] = [1, 1];
  private fade: [number, number] = [1, 1];
  private masterLevel = 1;
  private fadeTimers: [number | null, number | null] = [null, null];

  constructor(setup: (el: HTMLAudioElement) => void) {
    const mk = (id: 0 | 1): Deck => {
      const el = new Audio();
      el.preload = 'auto';
      setup(el);
      return { id, el, attached: null, sessionId: null, info: null, offsetMs: 0, itemId: null, queueIndex: -1, pendingSeek: null, token: 0, ready: false };
    };
    this.decks = [mk(0), mk(1)];
  }

  get active(): Deck {
    return this.decks[this.live];
  }
  get standby(): Deck {
    return this.decks[this.live === 0 ? 1 : 0];
  }
  /** Make the standby deck the live one. */
  swap() {
    this.live = this.live === 0 ? 1 : 0;
  }
  get webAudio() {
    return !!this.ctx;
  }

  /**
   * Create / resume the audio graph. Call from a user gesture where possible (autoplay rules).
   * `create` = false only resumes an existing graph.
   */
  prime(create = true) {
    if (create && !this.ctx && !this.failed) {
      try {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) throw new Error('no Web Audio');
        const ctx = new Ctx({ latencyHint: 'playback' });
        const master = ctx.createGain();
        master.connect(ctx.destination);
        const gains = this.decks.map((d) => {
          const src = ctx.createMediaElementSource(d.el);
          const g = ctx.createGain();
          src.connect(g).connect(master);
          d.el.volume = 1;
          d.el.muted = false;
          return g;
        }) as [GainNode, GainNode];
        this.ctx = ctx;
        this.master = master;
        this.gains = gains;
        this.applyMaster();
        this.decks.forEach((d) => this.applyDeck(d.id, 0));
      } catch {
        this.failed = true;
      }
    }
    if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
  }

  /** Resume a suspended graph (never creates one: that needs a user gesture). */
  resume() {
    if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
  }

  /** volume × mute × sleep factor. */
  setMaster(level: number) {
    this.masterLevel = Math.max(0, level);
    this.applyMaster();
  }
  private applyMaster() {
    if (this.ctx && this.master) {
      this.master.gain.cancelScheduledValues(0);
      this.master.gain.setTargetAtTime(this.masterLevel, this.ctx.currentTime, 0.015);
    } else this.decks.forEach((d) => this.applyDeck(d.id, 0));
  }

  setReplayGain(id: 0 | 1, factor: number) {
    if (this.rg[id] === factor) return;
    this.rg[id] = factor;
    if (this.fadeTimers[id] == null) this.applyDeck(id, 0.08);
  }

  /** Set the fade level at once (cancels a running fade). */
  setFade(id: 0 | 1, level: number) {
    this.stopFade(id);
    this.fade[id] = level;
    this.applyDeck(id, 0);
  }

  private applyDeck(id: 0 | 1, rampSec: number) {
    const target = this.rg[id] * this.fade[id];
    const g = this.gains[id];
    if (this.ctx && g) {
      g.gain.cancelScheduledValues(0);
      if (rampSec > 0) g.gain.setTargetAtTime(target, this.ctx.currentTime, rampSec / 3);
      else g.gain.setValueAtTime(target, this.ctx.currentTime);
    } else {
      this.decks[id].el.volume = clamp01(this.masterLevel * Math.min(1, target));
    }
  }

  private stopFade(id: 0 | 1) {
    const t = this.fadeTimers[id];
    if (t != null) window.clearTimeout(t);
    this.fadeTimers[id] = null;
  }

  /** Equal-power fade of one deck from its current level to `to` over `sec`. Resolves when done. */
  fadeTo(id: 0 | 1, to: number, sec: number): Promise<void> {
    this.stopFade(id);
    const from = this.fade[id];
    this.fade[id] = to;
    return new Promise((resolve) => {
      const g = this.gains[id];
      if (this.ctx && g && sec > 0) {
        const n = 64;
        const curve = new Float32Array(n);
        const rg = this.rg[id];
        for (let i = 0; i < n; i++) {
          const t = i / (n - 1);
          // Equal power: sin/cos quarter waves keep the summed loudness steady through the blend.
          const w = to > from ? Math.sin((t * Math.PI) / 2) : Math.cos((t * Math.PI) / 2);
          curve[i] = rg * (to > from ? from + (to - from) * w : to + (from - to) * w);
        }
        g.gain.cancelScheduledValues(0);
        g.gain.setValueCurveAtTime(curve, this.ctx.currentTime + 0.005, sec);
        this.fadeTimers[id] = window.setTimeout(() => {
          this.fadeTimers[id] = null;
          resolve();
        }, sec * 1000 + 30);
        return;
      }
      // Element-volume fallback: step the volume.
      const start = performance.now();
      const step = () => {
        const t = Math.min(1, (performance.now() - start) / (sec * 1000 || 1));
        const lvl = from + (to - from) * t;
        this.decks[id].el.volume = clamp01(this.masterLevel * Math.min(1, this.rg[id] * lvl));
        if (t >= 1) {
          this.fadeTimers[id] = null;
          resolve();
        } else this.fadeTimers[id] = window.setTimeout(step, 50);
      };
      step();
    });
  }

  close() {
    void this.ctx?.close().catch(() => {});
  }
}
