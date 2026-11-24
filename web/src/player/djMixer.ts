/**
 * DJ mixer automation: what every control of both decks does during a transition, per style.
 * Pure functions (no Web Audio) so they can be unit-tested and shared by the Web Audio path (scheduled curves)
 * and the element-volume fallback (evaluated per tick).
 *
 * Styles adapted from OpenDJ (MIT, github.com/Bucifer6/OpenDJ) — public/js/automix.js `mixLevels`
 * ('phrase'/'eqswap' bass swap, 'filter', 'echo', plain equal-power crossfade).
 */
import type { DjTransition, DjTransitionFx } from '@mediamax/shared';

export interface MixLevels {
  /** Dry gain of the outgoing / incoming deck (0–1). */
  outGain: number;
  inGain: number;
  /** Low band (below ~200 Hz) gain of each deck (0–1), for the bass swap. */
  outLow: number;
  inLow: number;
  /** Outgoing high-pass cutoff (Hz; 10 = open). */
  outHp: number;
  /** Incoming low-pass cutoff (Hz; 22000 = open). */
  inLp: number;
  /** Outgoing deck's send into the beat-synced echo (0–1). */
  echoSend: number;
}

export const OPEN_HP = 10;
export const OPEN_LP = 22000;
const ease = (x: number) => x * x * (3 - 2 * x);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Where (0–1 of the transition) the echo-out cuts the outgoing track's dry signal. */
export const ECHO_CUT = 0.75;
/** Echo delay in beats (dotted eighth) and feedback. */
export const ECHO_BEATS = 0.75;
export const ECHO_FEEDBACK = 0.55;

/**
 * Mixer settings at transition progress k (0–1).
 * kSwap = bass-swap point (0–1, bassSwap only); kCut = echo-out cut point (echo only).
 */
export function levelsAt(fx: DjTransitionFx, k: number, kSwap = 0.5, kCut = ECHO_CUT): MixLevels {
  k = clamp01(k);
  const base: MixLevels = { outGain: Math.cos((k * Math.PI) / 2), inGain: Math.sin((k * Math.PI) / 2), outLow: 1, inLow: 1, outHp: OPEN_HP, inLp: OPEN_LP, echoSend: 0 };
  switch (fx) {
    case 'bassSwap': {
      const s = Math.max(0.05, Math.min(0.95, kSwap));
      // Mids/highs of the new track come up to the swap point; the basslines change over on the phrase line;
      // then the old track's mids/highs leave.
      return {
        ...base,
        inGain: Math.sin((clamp01(k / s) * Math.PI) / 2),
        outGain: k < s ? 1 : Math.cos((clamp01((k - s) / (1 - s)) * Math.PI) / 2),
        outLow: k < s ? 1 : 0,
        inLow: k < s ? 0 : 1,
      };
    }
    case 'filter': {
      // HPF sweeps the old track out (20 Hz → 2.5 kHz over 90 %), LPF opens the new one (800 Hz → 20 kHz over 2/3).
      const h = clamp01(k / 0.9);
      const l = clamp01(k / 0.66);
      return {
        ...base,
        outHp: k <= 0 ? OPEN_HP : 20 * Math.pow(125, h),
        inLp: l >= 1 ? OPEN_LP : 800 * Math.pow(25, l),
        outGain: k < 0.5 ? 1 : Math.cos((clamp01((k - 0.5) / 0.5) * Math.PI) / 2),
        inGain: ease(l),
      };
    }
    case 'echo': {
      const c = Math.max(0.3, Math.min(0.95, kCut));
      return {
        ...base,
        outGain: k < c ? 1 : 0,
        echoSend: k >= 0.5 && k < c ? 1 : 0,
        // The new track sneaks in under the echo, then drops in fully at the cut.
        inGain: k < c ? 0.35 * ease(clamp01(k / c)) : 1,
      };
    }
    default:
      return base;
  }
}

/** Swap / cut points as fractions of the transition. */
export function transitionPoints(tr: Pick<DjTransition, 'fx' | 'swapAtMs' | 'crossfadeMs' | 'beatMs'>, rate = 1) {
  const L = Math.max(1, tr.crossfadeMs);
  const kSwap = tr.swapAtMs != null ? tr.swapAtMs / L : 0.5;
  let kCut = ECHO_CUT;
  if (tr.fx === 'echo' && tr.beatMs) {
    // Cut on a beat of the outgoing track (its beat lasts beatMs / rate on the wall clock).
    const beat = tr.beatMs / (rate || 1);
    kCut = Math.max(0.3, Math.min(0.95, (Math.round((L * ECHO_CUT) / beat) * beat) / L));
  }
  return { kSwap, kCut };
}

/** Sampled automation curves for every control (for AudioParam.setValueCurveAtTime). ~20 ms resolution. */
export function automationCurves(fx: DjTransitionFx, durSec: number, kSwap: number, kCut: number) {
  const n = Math.max(64, Math.min(4096, Math.ceil(durSec / 0.02) + 1));
  const keys: (keyof MixLevels)[] = ['outGain', 'inGain', 'outLow', 'inLow', 'outHp', 'inLp', 'echoSend'];
  const out = Object.fromEntries(keys.map((k) => [k, new Float32Array(n)])) as Record<keyof MixLevels, Float32Array>;
  for (let i = 0; i < n; i++) {
    const l = levelsAt(fx, i / (n - 1), kSwap, kCut);
    for (const k of keys) out[k][i] = l[k];
  }
  return out;
}

/** Which controls a style actually moves (others stay at their resting values). */
export function usedControls(fx: DjTransitionFx): (keyof MixLevels)[] {
  switch (fx) {
    case 'bassSwap': return ['outGain', 'inGain', 'outLow', 'inLow'];
    case 'filter': return ['outGain', 'inGain', 'outHp', 'inLp'];
    case 'echo': return ['outGain', 'inGain', 'echoSend'];
    default: return ['outGain', 'inGain'];
  }
}

/** Human label for a transition (style + effect). */
export function transitionLabel(tr: Pick<DjTransition, 'style' | 'fx'>): string {
  switch (tr.fx) {
    case 'bassSwap': return 'Bass swap';
    case 'filter': return 'Filter fade';
    case 'echo': return 'Echo out';
    default: return tr.style === 'blend' ? 'Beat-matched blend' : tr.style === 'cut' ? 'Quick cut' : 'Crossfade';
  }
}

/* ------------------------------ tempo / key lock ------------------------------ */

export type KeyLockMode = 'auto' | 'native' | 'worklet' | 'off';

/** Pick the key-lock engine from what the browser can do. 'off' = no tempo matching (rate stays 1). */
export function resolveKeyLock(want: KeyLockMode, caps: { native: boolean; worklet: boolean }): 'native' | 'worklet' | 'off' {
  if (want === 'off') return 'off';
  if (want === 'worklet') return caps.worklet ? 'worklet' : caps.native ? 'native' : 'off';
  if (want === 'native') return caps.native ? 'native' : caps.worklet ? 'worklet' : 'off';
  return caps.native ? 'native' : caps.worklet ? 'worklet' : 'off';
}

/**
 * Playback rate for the incoming deck: the server's ratio (native tempos) times the rate the outgoing deck is
 * playing at (it may still be tempo-matched from the previous transition), clamped to ±maxStretch.
 */
export function incomingRate(tempoRatio: number, outgoingRate: number, maxStretch: number): number {
  const r = (tempoRatio || 1) * (outgoingRate || 1);
  return Math.max(1 - maxStretch, Math.min(1 + maxStretch, r));
}

/** How long (ms) to glide back to the native tempo: N bars of the track at its played tempo. */
export function glideMs(bars: number, bpm: number | null | undefined, rate: number): number {
  if (!bpm || bars <= 0) return 8000;
  return Math.round(((bars * 4 * 60000) / (bpm * (rate || 1))));
}

/**
 * Rates for both decks during a tempo-matched transition. The incoming deck plays at tempoRatio × the outgoing
 * deck's rate (beats line up). When that would pass ±maxStretch (the outgoing deck is still stretched from the
 * previous transition), the incoming deck takes the limit and the outgoing deck moves toward its own tempo so the
 * pair stays matched; only a ratio that is itself out of range is clamped (and then drifts).
 */
export function matchRates(tempoRatio: number, outgoingRate: number, maxStretch: number): { inRate: number; outRate: number } {
  const lo = 1 - maxStretch;
  const hi = 1 + maxStretch;
  const ratio = tempoRatio || 1;
  const out = outgoingRate || 1;
  const want = ratio * out;
  if (want >= lo && want <= hi) return { inRate: want, outRate: out };
  const inRate = Math.max(lo, Math.min(hi, want));
  const outRate = Math.max(lo, Math.min(hi, inRate / ratio));
  return { inRate, outRate };
}

/** Beat drift (ms) accumulated over `durMs` of wall time between two decks whose effective tempos differ. */
export function beatDriftMs(bpmOut: number, outRate: number, bpmIn: number, inRate: number, durMs: number): number {
  const a = bpmOut * outRate;
  const b = bpmIn * inRate;
  // Phase difference in beats × the outgoing beat length.
  return Math.abs(((b - a) * durMs) / 60000) * (60000 / a);
}

/** The first bar line at or after `posMs` on a grid of `bpm` anchored at `anchorMs` (a downbeat); null without a grid. */
export function nextBarMs(posMs: number, bpm: number | null | undefined, anchorMs: number | null | undefined): number | null {
  if (!bpm || anchorMs == null) return null;
  const bar = (60000 / bpm) * 4;
  return anchorMs + Math.ceil((posMs - anchorMs) / bar - 1e-9) * bar;
}

/** 0–1 progress of a transition that started at `start` and lasts `len` (same clock, ms). */
export function transitionProgress(now: number, start: number, len: number): number {
  return Math.max(0, Math.min(1, (now - start) / Math.max(1, len)));
}
