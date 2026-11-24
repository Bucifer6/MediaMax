/**
 * Web Audio side of the DJ transition effects, shared by the advanced DJ engine (djEngine.ts) and the music
 * player's Automix (musicOutput.ts), so both sound the same. The levels themselves are the pure functions in
 * djMixer.ts.
 *
 *   input ─┬─ LR4 low-pass  ─ low  ─┐
 *          └─ LR4 high-pass ─ high ─┴→ HPF → LPF → (out: connect to the deck gain)
 *                                             LPF → echoSend → echo bus
 *
 * Only biquads and gains (no worklet): a few multiply-adds per sample, cheap enough to leave in the path.
 */
import type { DjTransitionFx } from '@mediamax/shared';
import { automationCurves, ECHO_BEATS, ECHO_FEEDBACK, OPEN_HP, OPEN_LP, usedControls, type MixLevels } from './djMixer';

/** Bass-swap crossover (Hz) and Butterworth Q in dB (Web Audio lowpass/highpass Q is in dB): LR4 = 2 × Butterworth. */
const XOVER = 200;
const Q_BUTTER_DB = -3.0103;

export interface FxStrip {
  input: GainNode;
  low: GainNode;
  high: GainNode;
  hp: BiquadFilterNode;
  lp: BiquadFilterNode;
  echoSend: GainNode;
  /** Last node of the dry path: connect it to the deck's gain. */
  out: AudioNode;
}

export interface EchoBus {
  delay: DelayNode;
  feedback: GainNode;
  ret: GainNode;
}

function biquad(ctx: BaseAudioContext, type: BiquadFilterType, f: number) {
  const b = ctx.createBiquadFilter();
  b.type = type;
  b.frequency.value = f;
  b.Q.value = Q_BUTTER_DB;
  return b;
}

/** Beat-synced echo (feedback delay) into `dest`. */
export function buildEcho(ctx: BaseAudioContext, dest: AudioNode): EchoBus {
  const delay = ctx.createDelay(4);
  const feedback = ctx.createGain();
  const ret = ctx.createGain();
  feedback.gain.value = ECHO_FEEDBACK;
  ret.gain.value = ECHO_FEEDBACK;
  delay.connect(feedback).connect(delay);
  delay.connect(ret).connect(dest);
  return { delay, feedback, ret };
}

/** One deck's effect strip; the echo send goes to `echo` when given. */
export function buildStrip(ctx: BaseAudioContext, echo: EchoBus | null): FxStrip {
  const input = ctx.createGain();
  const low = ctx.createGain();
  const high = ctx.createGain();
  const hp = biquad(ctx, 'highpass', OPEN_HP);
  const lp = biquad(ctx, 'lowpass', OPEN_LP);
  const echoSend = ctx.createGain();
  echoSend.gain.value = 0;
  input.connect(biquad(ctx, 'lowpass', XOVER)).connect(biquad(ctx, 'lowpass', XOVER)).connect(low).connect(hp);
  input.connect(biquad(ctx, 'highpass', XOVER)).connect(biquad(ctx, 'highpass', XOVER)).connect(high).connect(hp);
  hp.connect(lp);
  if (echo) lp.connect(echoSend).connect(echo.delay);
  return { input, low, high, hp, lp, echoSend, out: lp };
}

/** Put a strip's EQ / filters / echo send back to neutral at once. */
export function restStrip(ctx: BaseAudioContext, st: FxStrip | null | undefined) {
  if (!st) return;
  const t = ctx.currentTime;
  const set = (p: AudioParam, v: number) => {
    p.cancelScheduledValues(0);
    p.setValueAtTime(v, t);
  };
  set(st.low.gain, 1);
  set(st.high.gain, 1);
  set(st.hp.frequency, OPEN_HP);
  set(st.lp.frequency, OPEN_LP);
  set(st.echoSend.gain, 0);
}

export interface TransitionTargets {
  outGain: AudioParam | null | undefined;
  inGain: AudioParam | null | undefined;
  out: FxStrip | null | undefined;
  in: FxStrip | null | undefined;
  echo: EchoBus | null | undefined;
}

/**
 * Schedule a whole transition on the audio clock, starting at `t0` (context time) and lasting `durSec`.
 * `scale` multiplies a control's curve (e.g. the deck gains carry a ReplayGain factor).
 * `echoDelaySec` = the echo-out delay (beat-synced); only used by the echo style.
 */
export function scheduleTransition(
  ctx: BaseAudioContext, tg: TransitionTargets, fx: DjTransitionFx, t0: number, durSec: number, kSwap: number, kCut: number,
  opts: { scale?: Partial<Record<keyof MixLevels, number>>; echoDelaySec?: number | null } = {},
) {
  const curves = automationCurves(fx, durSec, kSwap, kCut);
  const params: Partial<Record<keyof MixLevels, AudioParam | null | undefined>> = {
    outGain: tg.outGain, inGain: tg.inGain,
    outLow: tg.out?.low.gain, inLow: tg.in?.low.gain,
    outHp: tg.out?.hp.frequency, inLp: tg.in?.lp.frequency,
    echoSend: tg.out?.echoSend.gain,
  };
  if (fx === 'echo' && tg.echo && opts.echoDelaySec) tg.echo.delay.delayTime.setValueAtTime(Math.min(3.9, opts.echoDelaySec), t0);
  for (const key of usedControls(fx)) {
    const p = params[key];
    if (!p) continue;
    const s = opts.scale?.[key] ?? 1;
    const c = s === 1 ? curves[key] : curves[key].map((v) => v * s);
    p.cancelScheduledValues(0);
    p.setValueAtTime(c[0], Math.max(0, t0 - 0.005));
    p.setValueCurveAtTime(c, t0, durSec);
  }
}

/** Echo-out delay for a beat length (ms) at a playback rate. */
export function echoDelaySec(beatMs: number | null | undefined, rate = 1): number | null {
  return beatMs ? (ECHO_BEATS * beatMs) / 1000 / (rate || 1) : null;
}
