/**
 * Automix: the music player's "lite DJ". Albums, playlists, queues and radio blend from one track into the next
 * like one continuous DJ set, with no setup and no DJ controls.
 *
 * Pure planning only (no DOM / Web Audio), so it is unit-tested in Node. The player (music.tsx) executes a plan
 * with the same effect code as the advanced DJ (djStrip.ts + djMixer.ts), so both sound the same.
 *
 * Plans come from the server's own DJ planner when it can give one (the same per-pair logic as advanced DJ mixes),
 * else from `planAutomix` below, which uses the track analysis (BPM, beat grid, phrases, energy, cue points):
 *   - close tempos (within ±6 %, half/double time aware) and a beat grid: a beat-matched blend on bar lines,
 *     tempo matched with the browser's own pitch-preserving playback (no worklet), effect picked per pair
 *     (mostly an EQ bass swap; filter fade into a calmer track; echo-out for clashing keys / energetic style);
 *   - otherwise a plain equal-power crossfade of about 6 s between the audible ends (leading/trailing silence skipped).
 * Gapless albums (the next track of the same album, audio running straight on) are never crossfaded.
 *
 * Only the Vibe server is ever contacted (track analysis and the media streams): no AI, no third parties.
 */
import type { DjTransition, DjTransitionFx, DjTransitionPreference, Item, TrackAnalysis } from '@mediamax/shared';
import { nextBarMs } from './djMixer';

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
  const cueOut = aa?.cueOutMs && aa.cueOutMs > 0 ? Math.min(aa.cueOutMs, durA || Infinity) : durA;
  let len = FIXED_FADE_MS[style];
  // Never more than a third of either track.
  if (durA > 0) len = Math.min(len, durA / 3);
  if (durB > 0) len = Math.min(len, durB / 3);
  len = Math.max(0, Math.round(len));
  const beatMs = aa?.bpm ? 60000 / aa.bpm : null;
  const fx = pickFx(style, (ab?.energy ?? 0.5) - (aa?.energy ?? 0.5), camelotMatch(aa?.camelot, ab?.camelot), false);
  return {
    mixOutMs: Math.max(0, Math.round(cueOut - len)), mixInMs: Math.round(ab?.cueInMs ?? 0), crossfadeMs: len, tempoRatio: 1,
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
  const cueOutA = Math.min(aa.cueOutMs || durA, durA || Infinity);
  // Incoming: its first bar line at or after the audible start (phrase-aligned when B has an intro phrase).
  const introB = ab.phrases?.find((p) => p.type === 'intro');
  const mixIn = introB && introB.startMs >= ab.cueInMs - 50 ? introB.startMs : nextBarMs(ab.cueInMs - 1, ab.bpm, gridOf(ab)) ?? ab.cueInMs;
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
  const outro = aa.phrases?.find((p) => p.type === 'outro' && p.startMs + len <= cueOutA + barA) ?? null;
  const outroStart = outro?.startMs ?? (aa.outroStartMs != null && aa.outroStartMs + len <= cueOutA + barA ? aa.outroStartMs : null);
  let mixOut: number;
  let phraseAligned = false;
  if (outroStart != null && outroStart >= durA * 0.5) {
    mixOut = nextBarMs(outroStart - 1, aa.bpm, gridA) ?? outroStart;
    phraseAligned = !!outro;
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

/** "Mixing into" label for Now Playing. */
export function automixLabel(tr: Pick<DjTransition, 'fx' | 'style'>): string {
  switch (tr.fx) {
    case 'bassSwap': return 'Bass swap';
    case 'filter': return 'Filter fade';
    case 'echo': return 'Echo out';
    default: return tr.style === 'blend' ? 'Beat-matched blend' : 'Crossfade';
  }
}
