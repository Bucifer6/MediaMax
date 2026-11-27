/**
 * Beat timing for the music visualiser (src/player/Visualizer.tsx). Android only gives live audio samples with the
 * microphone permission, so the visualiser follows the server's beat analysis instead (GET /items/:id/analysis, the
 * same grid Automix and Your DJ use), like the web visualiser does when it has no Web Audio data.
 */

/** Tempo used for tracks without a steady beat (ambient, speech): a slow, calm breathing. */
export const CALM_BPM = 60;

export interface BeatGrid {
  /** Milliseconds between beats. */
  beatMs: number;
  /** Where one beat falls on the track's timeline. */
  offsetMs: number;
  /** False when the track has no usable beat: animate gently instead of punching. */
  steady: boolean;
  /** 0–1 overall intensity: scales how far the bars kick. */
  energy: number;
}

/** The grid for a track's analysis (null = not analysed: calm motion, medium energy). */
export function beatGrid(a: { bpm: number | null; bpmConfidence?: number; beatOffsetMs: number | null; energy?: number } | null): BeatGrid {
  const energy = clamp(a?.energy ?? 0.5, 0.15, 1);
  const bpm = a?.bpm ?? null;
  // Below ~0.3 confidence the estimate is often half or double the real tempo: better calm than visibly wrong.
  const steady = !!bpm && bpm >= 40 && bpm <= 220 && (a?.bpmConfidence ?? 1) >= 0.3;
  if (!steady) return { beatMs: 60000 / CALM_BPM, offsetMs: 0, steady: false, energy: Math.min(energy, 0.5) };
  return { beatMs: 60000 / bpm!, offsetMs: a?.beatOffsetMs ?? 0, steady: true, energy };
}

/** Milliseconds from `positionMs` to the next beat (0 < result ≤ beatMs) and that beat's number. */
export function nextBeat(positionMs: number, g: Pick<BeatGrid, 'beatMs' | 'offsetMs'>): { inMs: number; index: number } {
  const since = positionMs - g.offsetMs;
  const index = Math.floor(since / g.beatMs) + 1;
  const inMs = index * g.beatMs - since;
  return { inMs: inMs <= 0 ? g.beatMs : inMs, index };
}

/**
 * How far each bar kicks on a beat (0–1), low frequencies on the left as on a spectrum: bass bars hit hardest on the
 * beat, high bars more on the half-beats. `seed` varies the shape from beat to beat so it doesn't look canned.
 */
export function barLevels(count: number, energy: number, beatIndex: number, offbeat: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const x = count > 1 ? i / (count - 1) : 0;
    const shape = offbeat ? 0.25 + 0.55 * x : 1 - 0.55 * x; // bass on the beat, treble in between
    const jitter = 0.55 + 0.45 * hash(i * 7919 + beatIndex * 104729 + (offbeat ? 31 : 0));
    out.push(clamp(shape * jitter * (0.35 + 0.65 * energy), 0.06, 1));
  }
  return out;
}

/** Deterministic 0–1 noise. */
function hash(n: number): number {
  const x = Math.sin(n) * 43758.5453;
  return x - Math.floor(x);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
