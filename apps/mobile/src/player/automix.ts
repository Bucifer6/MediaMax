/**
 * Automix: the music player's "lite DJ" (mobile port of web/src/player/automix.ts — keep the two in step).
 * Albums, playlists, queues and radio blend from one track into the next like one continuous DJ set, with no
 * setup and no DJ controls.
 *
 * Pure planning only (no React Native imports), so it is unit-tested in Node (tests/automix.test.mjs). The
 * player (src/state/music.tsx) runs a plan on two expo-audio players with the scheduler and `BlendRunner` at the
 * end of this file.
 *
 * expo-audio has no EQ, filters or delay: on the phone every effect (bass swap, filter fade, echo-out) is played
 * as its volume shape (`fxGains`, shared with the advanced DJ), i.e. a smooth equal-power-style crossfade timed
 * like the web effect. Tempo matching uses the player's pitch-corrected playback rate.
 *
 * Plans come from the server's own DJ planner when it can give one (the same per-pair logic as advanced DJ mixes),
 * else from `planAutomix` below, which uses the track analysis (BPM, beat grid, phrases, energy, cue points):
 *   - close tempos (within ±6 %, half/double time aware) and a beat grid: a beat-matched blend on bar lines,
 *     tempo matched with pitch-corrected playback, effect picked per pair
 *     (mostly a bass swap; filter fade into a calmer track; echo-out for clashing keys / energetic style);
 *   - otherwise a plain equal-power crossfade of about 6 s between the audible ends (leading/trailing silence skipped).
 * Gapless albums (the next track of the same album, audio running straight on) are never crossfaded.
 *
 * Only the Vibe server is ever contacted (track analysis and the media streams): no AI, no third parties.
 */
import type { DjTransition, DjTransitionFx, DjTransitionPreference, Item, TrackAnalysis } from '../api/types';

/** First bar line at or after `posMs` on a grid of `bpm` anchored at `anchorMs` (4/4). Same as web djMixer.nextBarMs. */
export function nextBarMs(posMs: number, bpm: number | null | undefined, anchorMs: number | null | undefined): number | null {
  if (!bpm || anchorMs == null) return null;
  const bar = (60000 / bpm) * 4;
  return anchorMs + Math.ceil((posMs - anchorMs) / bar - 1e-9) * bar;
}

/** Echo-out: where the outgoing track drops out (fraction of the transition). Same as web djMixer.ECHO_CUT. */
export const ECHO_CUT = 0.75;

/** Bass swap / echo cut points as fractions of the transition (web djMixer.transitionPoints). */
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

/**
 * Rates for both players during a tempo-matched transition (web djMixer.matchRates): the incoming one plays at
 * tempoRatio × the outgoing rate; past ±maxStretch the outgoing one moves toward its own tempo instead.
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

/** How long a tempo glide back to 1× takes: `bars` bars at `bpm` (wall clock at `rate`), 8 s when unknown. */
export function glideMs(bars: number, bpm: number | null | undefined, rate: number): number {
  if (!bpm || bars <= 0) return 8000;
  return Math.round((bars * 4 * 60000) / (bpm * (rate || 1)));
}

/**
 * Volume shape of a transition effect, 0–1 for the outgoing and incoming player at progress `p`. expo-audio has no
 * EQ, filters or delay, so each effect is approximated with the two volumes, timed like the web mixer: bass swap =
 * the new track comes up to the phrase line, then the old one leaves; filter fade = old track holds, then fades
 * over the second half while the new one eases in; echo-out = the new track sneaks in, the old one drops out on
 * the beat at ~3/4 (no echo tail). 'none' = equal-power crossfade (cos / sin). Also used by the advanced DJ.
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

/** Automix default for music when the listener hasn't chosen (audiobooks and podcasts never automix). */
export const AUTOMIX_DEFAULT = true;
/** Largest tempo change Automix uses to beat-match (fraction). */
export const AUTOMIX_MAX_STRETCH = 0.06;
/** Plain crossfade length (ms) when tracks can't be beat-matched, per transition style. */
export const FIXED_FADE_MS: Record<DjTransitionPreference, number> = { auto: 6000, smooth: 8000, energetic: 5000, minimal: 3500 };
/** Beat-matched blend length in bars, per transition style. */
export const BLEND_BARS: Record<DjTransitionPreference, number> = { auto: 16, smooth: 32, energetic: 8, minimal: 4 };
/** Audio closer than this to the file's edge counts as running straight on (gapless). */
const CONTINUOUS_MS = 500;

/** Does Automix apply to this pair at all? Music tracks only (never audiobooks, podcasts or videos). */
export function automixApplies(a: Item | null | undefined, b: Item | null | undefined): boolean {
  return a?.type === 'track' && b?.type === 'track';
}

/**
 * The next track of the same album, played in order, with the audio running straight on (or unknown): a gapless
 * join, never a crossfade. Same-album tracks with real silence between them (both analysed) may blend.
 */
export function isGaplessJoin(a: Item, b: Item, aa: TrackAnalysis | null, ab: TrackAnalysis | null, shuffle: boolean): boolean {
  if (shuffle || !a.parentId || a.parentId !== b.parentId) return false;
  if (a.index != null && b.index != null && b.index !== a.index + 1) return false;
  if (!aa || !ab) return true;
  const durA = aa.durationMs || a.durationMs || 0;
  const tail = durA - aa.cueOutMs;
  return tail < CONTINUOUS_MS || ab.cueInMs < CONTINUOUS_MS;
}

/** bpmA / bpmB folded to the nearest of ×½, ×1, ×2 (half/double time mixes fine). */
export function foldTempo(bpmA: number, bpmB: number): number {
  let r = bpmA / bpmB;
  while (r > Math.SQRT2) r /= 2;
  while (r < Math.SQRT1_2) r *= 2;
  return r;
}

/** Camelot wheel relation of two keys ("8A", "9B"). */
export function camelotMatch(a: string | null | undefined, b: string | null | undefined): DjTransition['keyMatch'] {
  const pa = /^(\d{1,2})([AB])$/.exec(a ?? '');
  const pb = /^(\d{1,2})([AB])$/.exec(b ?? '');
  if (!pa || !pb) return 'unknown';
  const na = Number(pa[1]);
  const nb = Number(pb[1]);
  const step = Math.min((na - nb + 12) % 12, (nb - na + 12) % 12);
  if (step === 0 && pa[2] === pb[2]) return 'perfect';
  if ((step === 1 && pa[2] === pb[2]) || (step === 0 && pa[2] !== pb[2])) return 'compatible';
  if (step === 2 && pa[2] === pb[2]) return 'energy';
  return 'clash';
}

/** The effect for a beat-matched pair, the way the advanced DJ's 'auto' thinks about it: energy, key and style. */
export function pickFx(style: DjTransitionPreference, energyDelta: number, keyMatch: DjTransition['keyMatch'], beatMatched: boolean): DjTransitionFx {
  if (style === 'minimal') return 'none';
  if (!beatMatched) return style === 'energetic' ? 'echo' : style === 'smooth' ? 'filter' : 'none';
  if (keyMatch === 'clash') return style === 'smooth' ? 'filter' : 'echo';
  if (style === 'smooth') return energyDelta < 0 ? 'filter' : 'bassSwap';
  if (style === 'energetic') return energyDelta < -0.1 ? 'echo' : 'bassSwap';
  return energyDelta < -0.2 ? 'filter' : 'bassSwap';
}

const gridOf = (x: TrackAnalysis) => x.downbeatMs ?? x.beatOffsetMs;

/** Plain crossfade between the audible ends of two tracks. */
export function fixedFade(a: Item, aa: TrackAnalysis | null, b: Item, ab: TrackAnalysis | null, style: DjTransitionPreference = 'auto'): DjTransition {
  const durA = aa?.durationMs || a.durationMs || 0;
  const durB = ab?.durationMs || b.durationMs || 0;
  const end = aa?.cues?.endMs ?? aa?.cueOutMs;
  const cueOut = end && end > 0 ? Math.min(end, durA || Infinity) : durA;
  let len = FIXED_FADE_MS[style];
  // Never more than a third of either track.
  if (durA > 0) len = Math.min(len, durA / 3);
  if (durB > 0) len = Math.min(len, durB / 3);
  len = Math.max(0, Math.round(len));
  const beatMs = aa?.bpm ? 60000 / aa.bpm : null;
  const fx = pickFx(style, (ab?.energy ?? 0.5) - (aa?.energy ?? 0.5), camelotMatch(aa?.camelot, ab?.camelot), false);
  return {
    mixOutMs: Math.max(0, Math.round(cueOut - len)), mixInMs: Math.round(ab?.cues?.mixInMs ?? ab?.cueInMs ?? 0), crossfadeMs: len, tempoRatio: 1,
    style: 'fade', keyMatch: camelotMatch(aa?.camelot, ab?.camelot), bpmDelta: null, fx: fx === 'echo' && !beatMs ? 'none' : fx, beatMs,
    reason: aa && ab ? 'Tempos too far apart: crossfade' : 'Not analysed yet: crossfade',
  };
}

/**
 * Plan the transition from `a` into `b`. Beat-matched blend on bar lines when the tempos are within `maxStretch`
 * (half/double aware) and both tracks have a beat grid; otherwise `fixedFade`.
 */
export function planAutomix(
  a: Item, aa: TrackAnalysis | null, b: Item, ab: TrackAnalysis | null,
  style: DjTransitionPreference = 'auto', maxStretch = AUTOMIX_MAX_STRETCH,
): DjTransition {
  if (!aa?.bpm || !ab?.bpm || gridOf(aa) == null || gridOf(ab) == null || (ab.bpmConfidence ?? 0) < 0.35 || (aa.bpmConfidence ?? 0) < 0.35) {
    return fixedFade(a, aa, b, ab, style);
  }
  const ratio = foldTempo(aa.bpm, ab.bpm);
  if (Math.abs(ratio - 1) > maxStretch) return fixedFade(a, aa, b, ab, style);
  const durA = aa.durationMs || a.durationMs || 0;
  const durB = ab.durationMs || b.durationMs || 0;
  const beatA = 60000 / aa.bpm;
  const barA = beatA * 4;
  const gridA = gridOf(aa)!;
  const cueOutA = Math.min(aa.cues?.endMs ?? (aa.cueOutMs || durA), durA || Infinity);
  // Incoming: the server's mix-in cue (first downbeat after the leading silence), else the intro phrase / first bar line.
  const introB = ab.phrases?.find((p) => p.type === 'intro');
  const mixIn = ab.cues?.mixInMs ?? (introB && introB.startMs >= ab.cueInMs - 50 ? introB.startMs : nextBarMs(ab.cueInMs - 1, ab.bpm, gridOf(ab)) ?? ab.cueInMs);
  let bars = BLEND_BARS[style];
  const fits = (n: number) => {
    const len = n * barA;
    // At most ~34 s (16 bars down to ~113 BPM) and 40 % of either track (the incoming one covers len × ratio of its own time).
    return len <= 34000 && len <= durA * 0.4 && (durB <= 0 || len * ratio <= (durB - mixIn) * 0.6);
  };
  while (bars > 2 && !fits(bars)) bars /= 2;
  if (!fits(bars)) return fixedFade(a, aa, b, ab, style);
  const len = bars * barA;
  // Outgoing: the outro phrase when it leaves room for the blend; else the last bar line that still fits.
  const room = (ms: number | null | undefined) => ms != null && ms + len <= cueOutA + barA;
  const outro = aa.phrases?.find((p) => p.type === 'outro' && room(p.startMs)) ?? null;
  // The server's phrase-based mix-out cue, then the outro phrase, then the loudness outro.
  const cueOut = aa.cues && (aa.cues.source === 'outro' || aa.cues.source === 'phrase') && room(aa.cues.mixOutMs) ? aa.cues.mixOutMs : null;
  const outroStart = cueOut ?? outro?.startMs ?? (room(aa.outroStartMs) ? aa.outroStartMs : null);
  let mixOut: number;
  let phraseAligned = false;
  if (outroStart != null && outroStart >= durA * 0.5) {
    mixOut = nextBarMs(outroStart - 1, aa.bpm, gridA) ?? outroStart;
    phraseAligned = cueOut != null || !!outro;
  } else {
    const latest = cueOutA - len;
    const bar = nextBarMs(latest, aa.bpm, gridA) ?? latest;
    mixOut = bar > latest + 1 ? bar - barA : bar;
  }
  if (mixOut < 0) return fixedFade(a, aa, b, ab, style);
  const keyMatch = camelotMatch(aa.camelot, ab.camelot);
  const fx = pickFx(style, (ab.energy ?? 0.5) - (aa.energy ?? 0.5), keyMatch, true);
  return {
    mixOutMs: Math.round(mixOut), mixInMs: Math.round(mixIn), crossfadeMs: Math.round(len),
    tempoRatio: Math.round(ratio * 1e5) / 1e5, style: 'blend', keyMatch, bpmDelta: Math.round(Math.abs(ratio - 1) * 1000) / 10,
    fx, swapAtMs: fx === 'bassSwap' ? Math.round(Math.round(bars / 2) * barA) : undefined,
    phraseAligned, outPhrase: outro ? 'outro' : null, inPhrase: introB ? 'intro' : null, beatMs: beatA,
    reason: `Beat-matched over ${bars} bars`,
  };
}

/**
 * Make a plan (server's or local) safe for the player: Automix never stretches past its own limit (it then
 * becomes a plain crossfade), and the crossfade fits before the end of the outgoing track.
 */
export function sanitizePlan(tr: DjTransition, a: Item, aa: TrackAnalysis | null, b: Item, ab: TrackAnalysis | null, style: DjTransitionPreference, maxStretch = AUTOMIX_MAX_STRETCH): DjTransition {
  if (tr.style === 'blend' && Math.abs((tr.tempoRatio || 1) - 1) > maxStretch + 1e-9) return fixedFade(a, aa, b, ab, style);
  const durA = aa?.durationMs || a.durationMs || 0;
  if (durA > 0 && tr.mixOutMs + tr.crossfadeMs > durA + 50) {
    const len = Math.min(tr.crossfadeMs, Math.max(0, durA - tr.mixOutMs));
    return { ...tr, crossfadeMs: len, swapAtMs: tr.swapAtMs != null ? Math.min(tr.swapAtMs, len / 2) : undefined };
  }
  return tr;
}

/** Wall-clock length of a transition (the plan is in the outgoing track's own time). */
export function blendWallMs(tr: Pick<DjTransition, 'crossfadeMs'>, outRate = 1): number {
  return Math.max(0, tr.crossfadeMs / (outRate || 1));
}

/**
 * Beat-phase correction for the incoming deck after it started: playback can start a few tens of ms off the
 * planned beat (timer jitter, output start-up). Returns a short rate nudge (like a DJ touching the platter) that
 * removes `errMs` (incoming ahead > 0) within `windowMs`, or null when it's already tight.
 */
export function phaseNudge(errMs: number, rate: number, windowMs = 2000, maxNudge = 0.02): { rate: number; holdMs: number } | null {
  if (!Number.isFinite(errMs) || Math.abs(errMs) < 12 || Math.abs(errMs) > 400) return null;
  // Removing e ms of media time at rate r × (1 ± n) takes e / (r × n) ms.
  const n = Math.min(maxNudge, Math.abs(errMs) / (rate * windowMs));
  const holdMs = Math.abs(errMs) / (rate * n);
  return { rate: rate * (errMs > 0 ? 1 - n : 1 + n), holdMs: Math.round(holdMs) };
}

/**
 * "Mixing into" label for Now Playing. On the phone the EQ effects play as their volume shape, so they're named
 * for what you hear rather than the web effect.
 */
export function automixLabel(tr: Pick<DjTransition, 'fx' | 'style'>): string {
  const beat = tr.style === 'blend';
  switch (tr.fx) {
    case 'bassSwap': return beat ? 'Beat-matched swap' : 'Swap';
    case 'filter': return 'Slow fade';
    case 'echo': return 'Drop out';
    default: return beat ? 'Beat-matched blend' : 'Crossfade';
  }
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Scheduling and running a blend on two players (pure; src/state/music.tsx supplies the players and the clock). */
/* ------------------------------------------------------------------------------------------------------------ */

/** Prepare the next track on the standby player this long (wall clock) before the planned mix-out point. */
export const AUTOMIX_PRELOAD_LEAD_MS = 15000;
/** Within this long of the mix-out point, a one-shot timer starts the blend exactly on time. */
export const AUTOMIX_ARM_MS = 600;
/** Further past the planned mix-out than this (a seek, a late load), a blend becomes a short plain fade. */
export const AUTOMIX_LATE_MS = 4000;
/** The short fade used then (ms). */
export const AUTOMIX_LATE_FADE_MS = 3000;

/** Next queue position after `index` (-1 at the end), the way the player advances. */
export function nextQueueIndex(length: number, index: number, repeat: 'off' | 'all' | 'one'): number {
  if (length <= 0 || index < 0) return -1;
  if (index + 1 < length) return index + 1;
  return repeat === 'all' ? 0 : -1;
}

export type AutomixAction =
  /** Nothing to do yet. */
  | { kind: 'none' }
  /** Load the next track on the standby player, cued at `startMs`. */
  | { kind: 'preload'; startMs: number }
  /** Start the blend in `waitMs` (wall clock): arm a one-shot timer. */
  | { kind: 'arm'; waitMs: number }
  /** Start the blend now. */
  | { kind: 'start' };

export interface AutomixTick {
  /** Outgoing (live) position and duration in media ms (duration 0 = unknown). */
  posMs: number;
  durMs: number;
  /** Outgoing playback rate. */
  rate: number;
  playing: boolean;
  /** The plan into the next track: undefined = not planned yet, null = gapless join (no blend). */
  tr: DjTransition | null | undefined;
  /** The standby player: nothing for the next track, loading it, or ready (cued). */
  standby: 'none' | 'loading' | 'ready';
  /** The standby is cued somewhere the plan doesn't want (re-cue it). */
  standbyStale?: boolean;
}

/** What the scheduler should do on this tick (called every ~50 ms and on every player status update). */
export function automixAction(s: AutomixTick): AutomixAction {
  if (s.tr === undefined) return { kind: 'none' };
  const rate = s.rate || 1;
  if (s.tr === null) {
    // Gapless join: the next track waits on the standby player from its very start; the player swaps at the end.
    const left = s.durMs > 0 ? (s.durMs - s.posMs) / rate : Infinity;
    return (s.standby === 'none' || s.standbyStale) && left <= AUTOMIX_PRELOAD_LEAD_MS ? { kind: 'preload', startMs: 0 } : { kind: 'none' };
  }
  const until = (s.tr.mixOutMs - s.posMs) / rate;
  if (s.standby === 'none' || s.standbyStale) return until <= AUTOMIX_PRELOAD_LEAD_MS ? { kind: 'preload', startMs: s.tr.mixInMs } : { kind: 'none' };
  if (s.standby !== 'ready' || !s.playing) return { kind: 'none' };
  // Not enough of the outgoing track left for anything but a cut: let it end (the player swaps at the end).
  if (s.durMs > 0 && s.durMs - s.posMs < 400) return { kind: 'none' };
  if (until <= 0) return { kind: 'start' };
  if (until <= AUTOMIX_ARM_MS) return { kind: 'arm', waitMs: until };
  return { kind: 'none' };
}

/** A plan made ready to run from where the outgoing track actually is. */
export interface BlendPlan {
  tr: DjTransition;
  /** Wall-clock length (ms). */
  durMs: number;
  inRate: number;
  outRate: number;
  /** The outgoing rate before the blend (restored when it is cut). */
  prevOutRate: number;
  /** Where the incoming track should be when it starts (media ms): the mix-in point, plus how late we start. */
  startInMs: number;
  kSwap: number;
  kCut: number;
  /** Tempo-matched (beats meant to line up). */
  beat: boolean;
  label: string;
}

/**
 * Turn a plan into what to run now (as web music.tsx startBlend): far past the mix-out point → a short plain fade;
 * a beat-matched blend starts the incoming track as far into it as we are late (so the beats still meet), at
 * matched rates; the length never passes the end of the outgoing track.
 */
export function prepareBlend(
  planned: DjTransition,
  at: { posMs: number; durMs: number; rate: number },
  maxStretch = AUTOMIX_MAX_STRETCH,
): BlendPlan {
  let tr = planned;
  const rate0 = at.rate || 1;
  const endMs = at.durMs > 0 ? at.durMs : at.posMs + tr.crossfadeMs;
  const leftWall = Math.max(0, (endMs - at.posMs) / rate0);
  const late = (at.posMs - tr.mixOutMs) / rate0;
  if (late > AUTOMIX_LATE_MS) tr = { ...tr, style: 'fade', tempoRatio: 1, fx: 'none', crossfadeMs: Math.min(AUTOMIX_LATE_FADE_MS, leftWall * rate0) };
  const beat = tr.style === 'blend' && Math.abs((tr.tempoRatio || 1) - 1) <= maxStretch + 1e-9;
  const rates = beat ? matchRates(tr.tempoRatio, rate0, maxStretch) : { inRate: 1, outRate: rate0 };
  const startInMs = tr.mixInMs + (beat && late > 0 ? late * rates.inRate : 0);
  const durMs = Math.max(200, Math.min(tr.crossfadeMs / rates.outRate, leftWall));
  const { kSwap, kCut } = transitionPoints(tr, rates.outRate);
  return { tr, durMs, inRate: rates.inRate, outRate: rates.outRate, prevOutRate: rate0, startInMs: Math.max(0, startInMs), kSwap, kCut, beat, label: automixLabel(tr) };
}

/** One player as the blend sees it. */
export interface MixDeck {
  setVolume(v: number): void;
  setRate(r: number): void;
  play(): void;
  pause(): void;
}

export type BlendState = 'idle' | 'running' | 'done' | 'cut';

/**
 * Runs one blend: both volumes follow the effect's shape (`fxGains`) over the plan's length, on whatever clock
 * the host steps it with (a 50 ms timer in the foreground, player status updates in the background, where
 * Android pauses JS timers). `levels()` is each player's full level (volume × ReplayGain × sleep fade).
 *  - complete(): the incoming track takes over (the blend ran its course, or the listener skipped);
 *  - cut(): pause / seek / track change: the outgoing track is back at full level, the incoming one dropped.
 */
export class BlendRunner {
  state: BlendState = 'idle';
  startedAt = 0;
  /** Beat-phase nudge in progress: back to the matched rate at this time. */
  private nudgeUntil: number | null = null;
  readonly plan: BlendPlan;
  private readonly out: MixDeck;
  private readonly inc: MixDeck;
  private readonly host: { now: () => number; levels: () => { out: number; inc: number } };

  // Plain fields (no parameter properties): Node's type stripping runs this file in the tests.
  constructor(plan: BlendPlan, out: MixDeck, inc: MixDeck, host: { now: () => number; levels: () => { out: number; inc: number } }) {
    this.plan = plan;
    this.out = out;
    this.inc = inc;
    this.host = host;
  }

  start(): void {
    if (this.state !== 'idle') return;
    this.inc.setVolume(0);
    this.inc.setRate(this.plan.inRate);
    if (Math.abs(this.plan.outRate - this.plan.prevOutRate) > 1e-4) this.out.setRate(this.plan.outRate);
    this.inc.play();
    this.startedAt = this.host.now();
    this.state = 'running';
    this.step();
  }

  progress(): number {
    if (this.state === 'done') return 1;
    if (this.state !== 'running') return 0;
    return Math.max(0, Math.min(1, (this.host.now() - this.startedAt) / Math.max(1, this.plan.durMs)));
  }

  /** Advance the volumes; completes the blend at its end. Returns the state after the step. */
  step(): BlendState {
    if (this.state !== 'running') return this.state;
    const now = this.host.now();
    if (this.nudgeUntil != null && now >= this.nudgeUntil) {
      this.nudgeUntil = null;
      this.inc.setRate(this.plan.inRate);
    }
    const p = this.progress();
    const g = fxGains(this.plan.tr.fx ?? 'none', p, this.plan.kSwap, this.plan.kCut);
    const lv = this.host.levels();
    this.out.setVolume(lv.out * g.out);
    this.inc.setVolume(lv.inc * g.inc);
    if (p >= 1) this.complete();
    return this.state;
  }

  /** How far the incoming track is off the outgoing one's beat (ms, incoming ahead > 0); null unless beat-matched. */
  phaseError(outPosMs: number, inPosMs: number): number | null {
    if (!this.plan.beat || this.state !== 'running') return null;
    const { tr, inRate, outRate } = this.plan;
    return inPosMs - (tr.mixInMs + (outPosMs - tr.mixOutMs) * (inRate / outRate));
  }

  /** Nudge the incoming rate briefly to remove a phase error (like touching the platter). True when applied. */
  nudge(errMs: number): boolean {
    if (this.state !== 'running' || this.nudgeUntil != null) return false;
    const n = phaseNudge(errMs, this.plan.inRate);
    if (!n) return false;
    this.inc.setRate(n.rate);
    this.nudgeUntil = this.host.now() + n.holdMs;
    return true;
  }

  /** The incoming track takes over now. False when the blend wasn't running. */
  complete(): boolean {
    if (this.state !== 'running') return false;
    this.state = 'done';
    if (this.nudgeUntil != null) {
      this.nudgeUntil = null;
      this.inc.setRate(this.plan.inRate);
    }
    this.inc.setVolume(this.host.levels().inc);
    this.out.pause();
    this.out.setVolume(0);
    return true;
  }

  /** Cut the blend: the outgoing track stays (full level, its own rate), the incoming one stops. */
  cut(): boolean {
    if (this.state !== 'running') return false;
    this.state = 'cut';
    this.nudgeUntil = null;
    this.inc.pause();
    this.inc.setVolume(0);
    this.inc.setRate(1);
    if (Math.abs(this.plan.outRate - this.plan.prevOutRate) > 1e-4) this.out.setRate(this.plan.prevOutRate);
    this.out.setVolume(this.host.levels().out);
    return true;
  }
}

/** Rate of a tempo glide back to 1× (`from` at t = 0, 1× after `ms`, at least 0.5 s). */
export function glideRate(from: number, elapsedMs: number, ms: number): number {
  const x = Math.max(0, Math.min(1, elapsedMs / Math.max(500, ms)));
  return from + (1 - from) * x;
}

/**
 * Has the outgoing player been paused from outside during a blend (lock screen, headset, a call)? Only once it
 * has been stopped (not buffering) for `holdMs`, and not when it simply reached its end.
 */
export function pausedFromOutside(s: { playing: boolean; buffering: boolean; posMs: number; durMs: number; stoppedSinceMs: number | null; now: number }, holdMs = 300): boolean {
  if (s.playing || s.buffering || s.stoppedSinceMs == null) return false;
  if (s.durMs > 0 && s.posMs >= s.durMs - 500) return false;
  return s.now - s.stoppedSinceMs >= holdMs;
}
