/**
 * Client-side adaptive bitrate (ABR) logic — pure, no DOM, unit-tested in web/test/abr.test.ts.
 *
 *  - BandwidthEstimator: two exponentially weighted moving averages of throughput samples (fast and slow half-life,
 *    weighted by transfer time); the estimate is the lower of the two, so drops are seen quickly and spikes ignored.
 *  - AbrController: picks a quality level from the estimate, buffer health and dropped frames with hysteresis:
 *    steps down quickly (at once when the buffer is nearly empty, after a short hold otherwise), steps up one level at
 *    a time only after the better conditions held for a while, a minimum dwell time since the last switch, and with a
 *    healthy buffer. Repeated down-after-up switches ("flapping") lengthen the dwell time.
 *
 * The same controller drives both adaptive modes: switching variants of a multi-rendition HLS stream (hls.js) and
 * restarting a stream at another bitrate (direct play ↔ transcode, single-variant transcodes) with longer dwell times.
 */

/* --------------------------------- EWMA --------------------------------- */

export class Ewma {
  private readonly alpha: number;
  private value = 0;
  private weight = 0;

  /** `halfLife` in seconds of sample weight. */
  constructor(halfLife: number) {
    this.alpha = Math.exp(Math.log(0.5) / halfLife);
  }

  sample(weight: number, value: number) {
    const adj = Math.pow(this.alpha, weight);
    this.value = value * (1 - adj) + adj * this.value;
    this.weight += weight;
  }

  /** Bias-corrected estimate (early samples aren't pulled towards 0). */
  get estimate(): number {
    const zero = 1 - Math.pow(this.alpha, this.weight);
    return zero > 0 ? this.value / zero : 0;
  }

  get totalWeight() {
    return this.weight;
  }
}

export class BandwidthEstimator {
  private fast = new Ewma(3);
  private slow = new Ewma(9);
  /** Samples smaller than this are dominated by latency, not throughput. */
  minBytes = 16 * 1024;
  samples = 0;

  /** A transfer of `bytes` that took `ms` (time from first to last byte). */
  add(bytes: number, ms: number) {
    if (bytes < this.minBytes || !(ms > 0)) return;
    const seconds = Math.max(ms, 1) / 1000;
    const bps = (bytes * 8) / seconds;
    // Weight by duration, but let tiny fast transfers still count a little.
    const w = Math.max(seconds, 0.05);
    this.fast.sample(w, bps);
    this.slow.sample(w, bps);
    this.samples++;
  }

  /** Seed with an earlier measurement (bandwidth probe / remembered value) worth `weight` seconds. */
  seed(bps: number, weight = 2) {
    if (!(bps > 0)) return;
    this.fast.sample(weight, bps);
    this.slow.sample(weight, bps);
  }

  /** bits/s, or null before any data. */
  get estimate(): number | null {
    if (this.fast.totalWeight <= 0) return null;
    return Math.min(this.fast.estimate, this.slow.estimate);
  }
}

/* ------------------------------ controller ------------------------------ */

export interface AbrLevel {
  /** Peak bits/s needed for this level. */
  bitrate: number;
  height?: number | null;
  label: string;
}

export interface AbrConfig {
  /** Share of the estimate a level may use when choosing a level (and when deciding to step down). */
  safety: number;
  /** Stricter share for stepping up (hysteresis between up and down thresholds). */
  upSafety: number;
  /** Below this much buffer (s), step down at once to a level that fits. */
  emergencyBufferS: number;
  /** Below this much buffer (s), step down without waiting for the hold time. */
  lowBufferS: number;
  /** Down condition must hold this long (ms) when the buffer is fine. */
  downHoldMs: number;
  /** Up condition must hold this long (ms). */
  upHoldMs: number;
  /** Minimum time (ms) since the last switch before stepping up. */
  minDwellMs: number;
  /** Need at least this much buffer (s) to step up. */
  minUpBufferS: number;
  /** Dropped-frame ratio above which the level is capped one step lower for `droppedPenaltyMs`. */
  droppedRatioMax: number;
  droppedPenaltyMs: number;
  /** A down switch within this time (ms) of an up switch counts as a flap; each doubles the dwell (max ×8). */
  flapWindowMs: number;
}

export const SEGMENT_ABR: AbrConfig = {
  safety: 0.8, upSafety: 0.65, emergencyBufferS: 2.5, lowBufferS: 8, downHoldMs: 3000, upHoldMs: 8000, minDwellMs: 15000, minUpBufferS: 12,
  droppedRatioMax: 0.15, droppedPenaltyMs: 60000, flapWindowMs: 120000,
};

/** Restart-based switching (direct play ↔ transcode, single-variant streams): each switch costs a reload, so be calmer. */
export const RESTART_ABR: AbrConfig = {
  ...SEGMENT_ABR, emergencyBufferS: 1.5, lowBufferS: 4, downHoldMs: 6000, upHoldMs: 20000, minDwellMs: 45000, minUpBufferS: 15,
};

export interface AbrInput {
  now: number;
  /** Estimated throughput, bits/s (null = unknown: no switching on bandwidth). */
  bandwidth: number | null;
  /** Seconds buffered ahead of the playhead. */
  bufferS: number;
  /** Dropped / total frames over the recent window, if known. */
  droppedRatio?: number | null;
  /** Playback is running (not paused / seeking). */
  playing: boolean;
}

export interface AbrDecision {
  level: number;
  direction: 'up' | 'down';
  reason: 'bandwidth' | 'buffer' | 'dropped-frames';
}

export class AbrController {
  readonly levels: AbrLevel[];
  current: number;
  private lastSwitch = -Infinity;
  private downSince: number | null = null;
  private upSince: number | null = null;
  private lastUpAt = -Infinity;
  private capUntil = 0;
  private cap = Infinity;
  flaps = 0;

  /** `levels` in any order; they are sorted by bitrate (index 0 = lowest). `start` is an index into the sorted list. */
  constructor(levels: AbrLevel[], start: number, readonly cfg: AbrConfig = SEGMENT_ABR, now = 0) {
    this.levels = [...levels].sort((a, b) => a.bitrate - b.bitrate);
    this.current = Math.max(0, Math.min(this.levels.length - 1, start));
    this.lastSwitch = now;
  }

  /** Highest level that fits `bps × share`. */
  fit(bps: number, share = this.cfg.safety): number {
    let best = 0;
    for (let i = 0; i < this.levels.length; i++) if (this.levels[i].bitrate <= bps * share) best = i;
    return best;
  }

  get dwellMs() {
    return this.cfg.minDwellMs * Math.pow(2, Math.min(this.flaps, 3));
  }

  /** Tell the controller the player switched by itself (or the user did). */
  setCurrent(level: number, now: number) {
    if (level === this.current) return;
    this.current = level;
    this.lastSwitch = now;
    this.downSince = this.upSince = null;
  }

  private commit(level: number, now: number, reason: AbrDecision['reason']): AbrDecision {
    const direction = level > this.current ? 'up' : 'down';
    if (direction === 'down' && now - this.lastUpAt < this.cfg.flapWindowMs) this.flaps++;
    if (direction === 'up') this.lastUpAt = now;
    this.current = level;
    this.lastSwitch = now;
    this.downSince = this.upSince = null;
    return { level, direction, reason };
  }

  update(i: AbrInput): AbrDecision | null {
    const { now } = i;
    if (this.levels.length < 2) return null;
    // Decoder can't keep up: cap one level below the current one for a while.
    if (i.droppedRatio != null && i.droppedRatio > this.cfg.droppedRatioMax && this.current > 0 && i.playing) {
      this.cap = this.current - 1;
      this.capUntil = now + this.cfg.droppedPenaltyMs;
      return this.commit(this.cap, now, 'dropped-frames');
    }
    if (now > this.capUntil) this.cap = Infinity;
    const maxLevel = Math.min(this.levels.length - 1, this.cap);
    if (i.bandwidth == null || !i.playing) {
      this.downSince = this.upSince = null;
      return null;
    }
    const target = Math.min(this.fit(i.bandwidth), maxLevel);

    if (target < this.current) {
      this.upSince = null;
      if (i.bufferS < this.cfg.emergencyBufferS) return this.commit(target, now, 'buffer');
      this.downSince ??= now;
      if (i.bufferS < this.cfg.lowBufferS || now - this.downSince >= this.cfg.downHoldMs) return this.commit(target, now, i.bufferS < this.cfg.lowBufferS ? 'buffer' : 'bandwidth');
      return null;
    }
    this.downSince = null;

    const next = this.current + 1;
    const upOk = next <= maxLevel && this.levels[next].bitrate <= i.bandwidth * this.cfg.upSafety && i.bufferS >= this.cfg.minUpBufferS;
    if (!upOk) {
      this.upSince = null;
      return null;
    }
    this.upSince ??= now;
    if (now - this.upSince >= this.cfg.upHoldMs && now - this.lastSwitch >= this.dwellMs) return this.commit(next, now, 'bandwidth');
    return null;
  }
}

/* ------------------------------ quality ladder ------------------------------ */

/** Bitrate steps (kbps) for restart-based switching, matching the server's rendition rungs. */
export const RESTART_STEPS: { kbps: number; label: string }[] = [
  { kbps: 720, label: '360p' },
  { kbps: 1500, label: '480p' },
  { kbps: 4000, label: '720p' },
  { kbps: 8000, label: '1080p' },
  { kbps: 20000, label: '4K' },
];

/**
 * Levels for restart mode: the steps below the source bitrate, plus the source itself ("Original", direct play) on top.
 * `kbps: null` marks the original.
 */
export function restartLevels(sourceKbps: number | null, capKbps: number | null): (AbrLevel & { kbps: number | null })[] {
  const src = sourceKbps && sourceKbps > 0 ? sourceKbps : null;
  const steps = RESTART_STEPS.filter((s) => (!src || s.kbps < src * 0.9) && (!capKbps || s.kbps <= capKbps));
  const out: (AbrLevel & { kbps: number | null })[] = steps.map((s) => ({ bitrate: s.kbps * 1000 * 1.1, label: s.label, kbps: s.kbps }));
  if (src && (!capKbps || src <= capKbps)) out.push({ bitrate: src * 1000 * 1.1, label: 'Original', kbps: null });
  return out;
}

export function formatBps(bps: number | null | undefined): string {
  if (!bps || !Number.isFinite(bps)) return '—';
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(bps >= 1e8 ? 0 : 1)} Mbps` : `${Math.round(bps / 1000)} kbps`;
}
