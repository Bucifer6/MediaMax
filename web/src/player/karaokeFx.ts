/**
 * Quick karaoke (no AI model): centre-channel vocal reduction in Web Audio, with the low band preserved.
 *
 * Lead vocals are usually mixed dead centre, i.e. identical in both channels, so they live in the mid signal
 * M = (L+R)/2 and not in the side signal S = (L−R)/2. Removing M removes the vocals — but also the centred bass and
 * kick drum, so the mid's low band (Linkwitz-Riley 4th-order low-pass at 150 Hz) is kept:
 *
 *   L' = v·M + (1−v)·LP(M) + g·S      R' = v·M + (1−v)·LP(M) − g·S      (v = vocal level 0..1, g = 1 + (1−v)/2)
 *
 * At v = 1 this is exactly L / R (transparent); at v = 0 only the side signal and the centred lows remain. Anything
 * panned (guitars, keys, reverb tails) survives; the side gain g makes up most of the level a hard-panned instrument
 * loses with its mid half (−6 dB → −2.5 dB). Mono recordings lose everything above 150 Hz at v = 0, which is why
 * the AI stems mode exists.
 *
 * The mid/side split is adapted from OpenDJ (MIT, github.com/Bucifer6/OpenDJ) — "quick stems" in
 * public/js/audio/engine.js.
 */

export const VOCAL_CROSSOVER_HZ = 150;

export interface VocalReducer {
  input: AudioNode;
  output: AudioNode;
  /** Vocal level 0..1 (1 = untouched). */
  setLevel(level: number, rampSec?: number): void;
  readonly level: number;
  disconnect(): void;
}

/** Gains of the two mid paths for a vocal level (full mid, low-passed mid). */
export function vocalPathGains(level: number): { mid: number; low: number; side: number } {
  const v = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 1));
  return { mid: v, low: 1 - v, side: 1 + (1 - v) / 2 };
}

/** Build the reducer on any (offline or realtime) context. Input/output are stereo. */
export function buildVocalReducer(ctx: BaseAudioContext, crossoverHz = VOCAL_CROSSOVER_HZ): VocalReducer {
  const input = ctx.createGain();
  input.channelCount = 2;
  input.channelCountMode = 'explicit';
  input.channelInterpretation = 'speakers';
  const split = ctx.createChannelSplitter(2);
  input.connect(split);
  const g = (v: number) => {
    const n = ctx.createGain();
    n.gain.value = v;
    return n;
  };
  const mono = (n: GainNode) => {
    n.channelCount = 1;
    n.channelCountMode = 'explicit';
    return n;
  };
  const lM = g(0.5), rM = g(0.5), lS = g(0.5), rS = g(-0.5);
  const mid = mono(g(1));
  const side = mono(g(1));
  split.connect(lM, 0);
  split.connect(rM, 1);
  split.connect(lS, 0);
  split.connect(rS, 1);
  lM.connect(mid);
  rM.connect(mid);
  lS.connect(side);
  rS.connect(side);
  // LR4 low-pass = two cascaded Butterworth (Q = 1/√2) sections.
  const lp1 = ctx.createBiquadFilter();
  const lp2 = ctx.createBiquadFilter();
  for (const f of [lp1, lp2]) {
    f.type = 'lowpass';
    f.frequency.value = crossoverHz;
    f.Q.value = Math.SQRT1_2;
  }
  const midGain = mono(g(1));
  const lowGain = mono(g(0));
  mid.connect(midGain);
  mid.connect(lp1).connect(lp2).connect(lowGain);
  const centre = mono(g(1));
  midGain.connect(centre);
  lowGain.connect(centre);
  const sideGain = mono(g(1));
  side.connect(sideGain);
  const sideNeg = mono(g(-1));
  sideGain.connect(sideNeg);
  const merge = ctx.createChannelMerger(2);
  centre.connect(merge, 0, 0);
  centre.connect(merge, 0, 1);
  sideGain.connect(merge, 0, 0);
  sideNeg.connect(merge, 0, 1);
  const output = ctx.createGain();
  merge.connect(output);
  let level = 1;
  return {
    input,
    output,
    get level() {
      return level;
    },
    setLevel(v, rampSec = 0.08) {
      level = Math.max(0, Math.min(1, v));
      const p = vocalPathGains(level);
      const t = ctx.currentTime;
      if (rampSec > 0) {
        midGain.gain.setTargetAtTime(p.mid, t, rampSec / 3);
        lowGain.gain.setTargetAtTime(p.low, t, rampSec / 3);
        sideGain.gain.setTargetAtTime(p.side, t, rampSec / 3);
      } else {
        midGain.gain.setValueAtTime(p.mid, t);
        lowGain.gain.setValueAtTime(p.low, t);
        sideGain.gain.setValueAtTime(p.side, t);
      }
    },
    disconnect() {
      try {
        input.disconnect();
        output.disconnect();
      } catch {
        /* already gone */
      }
    },
  };
}
