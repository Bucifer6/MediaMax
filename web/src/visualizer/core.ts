/**
 * Visualiser maths (pure, no DOM): spectrum → bars, beat phase from the DJ analysis beat grid, onset detection from
 * the analyser when there is no beat grid, and a small colour palette from cover-art pixels.
 */

/** Log-spaced bars from an analyser's byte frequency data (0..1 per bar). */
export function barLevels(freq: ArrayLike<number>, bars: number, sampleRate = 48000, minHz = 40, maxHz = 16000, out = new Float32Array(bars)): Float32Array {
  const n = freq.length;
  if (!n || bars <= 0) return out.fill(0);
  const nyquist = sampleRate / 2;
  const hzPerBin = nyquist / n;
  const lo = Math.max(1, minHz);
  const hi = Math.min(maxHz, nyquist);
  for (let b = 0; b < bars; b++) {
    const f0 = lo * Math.pow(hi / lo, b / bars);
    const f1 = lo * Math.pow(hi / lo, (b + 1) / bars);
    let i0 = Math.floor(f0 / hzPerBin);
    let i1 = Math.max(i0 + 1, Math.ceil(f1 / hzPerBin));
    i0 = Math.min(n - 1, i0);
    i1 = Math.min(n, i1);
    let m = 0;
    for (let i = i0; i < i1; i++) if (freq[i] > m) m = freq[i];
    out[b] = m / 255;
  }
  return out;
}

/** Exponential smoothing towards `target` (fast attack, slower release). */
export function smoothInto(cur: Float32Array, target: ArrayLike<number>, attack = 0.55, release = 0.12): Float32Array {
  for (let i = 0; i < cur.length; i++) {
    const t = target[i] ?? 0;
    cur[i] += (t - cur[i]) * (t > cur[i] ? attack : release);
  }
  return cur;
}

/** Beat grid position at `timeMs`: beat number and phase (0 at the beat, → 1 just before the next). */
export function beatPhase(timeMs: number, bpm: number | null | undefined, beatOffsetMs: number | null | undefined): { beat: number; phase: number } | null {
  if (!bpm || !Number.isFinite(bpm) || bpm <= 0) return null;
  const period = 60000 / bpm;
  const x = (timeMs - (beatOffsetMs ?? 0)) / period;
  const beat = Math.floor(x);
  return { beat, phase: x - beat };
}

/** Pulse envelope 0..1 from a beat phase: sharp attack on the beat, exponential decay. */
export const pulseFromPhase = (phase: number, decay = 5) => Math.exp(-Math.max(0, phase) * decay);

/** Bass energy 0..1 from byte frequency data (bins below `hz`). */
export function bassEnergy(freq: ArrayLike<number>, sampleRate = 48000, hz = 160): number {
  const n = freq.length;
  if (!n) return 0;
  const bins = Math.max(1, Math.min(n, Math.round((hz / (sampleRate / 2)) * n)));
  let s = 0;
  for (let i = 0; i < bins; i++) s += freq[i];
  return s / (bins * 255);
}

/** RMS 0..1 of byte time-domain data (128 = silence). */
export function rmsLevel(wave: ArrayLike<number>): number {
  if (!wave.length) return 0;
  let s = 0;
  for (let i = 0; i < wave.length; i++) {
    const v = (wave[i] - 128) / 128;
    s += v * v;
  }
  return Math.sqrt(s / wave.length);
}

/**
 * Onset (beat) detector for analyser data when no beat grid is known: spectral flux of the low band against an
 * adaptive threshold (mean + k·σ of recent flux), with a refractory period.
 */
export class OnsetDetector {
  private prev: Float32Array | null = null;
  private hist: number[] = [];
  private lastOnset = -Infinity;
  /** Pulse 0..1 that decays after each onset. */
  pulse = 0;
  constructor(private readonly bins = 24, private readonly k = 1.4, private readonly refractoryMs = 180, private readonly window = 43) {}

  /** Feed one frame of byte frequency data; returns true on an onset. */
  update(freq: ArrayLike<number>, nowMs: number, dtMs = 16): boolean {
    const n = Math.min(this.bins, freq.length);
    const cur = new Float32Array(n);
    let flux = 0;
    for (let i = 0; i < n; i++) {
      cur[i] = freq[i] / 255;
      const d = cur[i] - (this.prev?.[i] ?? cur[i]);
      if (d > 0) flux += d;
    }
    this.prev = cur;
    this.hist.push(flux);
    if (this.hist.length > this.window) this.hist.shift();
    const mean = this.hist.reduce((a, b) => a + b, 0) / this.hist.length;
    const sd = Math.sqrt(this.hist.reduce((a, b) => a + (b - mean) * (b - mean), 0) / this.hist.length);
    this.pulse *= Math.exp(-dtMs / 160);
    const onset = this.hist.length >= 8 && flux > mean + this.k * sd && flux > 0.05 && nowMs - this.lastOnset > this.refractoryMs;
    if (onset) {
      this.lastOnset = nowMs;
      this.pulse = 1;
    }
    return onset;
  }
}

/** Mirror bars around the centre for a symmetric display: [b0..bn] → [bn..b0, b0..bn]. */
export function mirrored(levels: ArrayLike<number>): number[] {
  const a = Array.from(levels);
  return [...a.slice().reverse(), ...a];
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * A small palette from RGBA pixels (cover art scaled down): colours are bucketed (4 bits per channel), very dark and
 * very grey buckets are de-weighted, and the `count` most common distinct buckets are returned (most vivid first).
 */
export function paletteFromPixels(px: ArrayLike<number>, count = 3): Rgb[] {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i + 3 < px.length; i += 4) {
    if (px[i + 3] < 128) continue;
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++;
    e.r += r;
    e.g += g;
    e.b += b;
    buckets.set(key, e);
  }
  const scored = [...buckets.values()].map((e) => {
    const c = { r: e.r / e.n, g: e.g / e.n, b: e.b / e.n };
    const max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b);
    const sat = max ? (max - min) / max : 0;
    const light = max / 255;
    return { c, score: e.n * (0.25 + sat) * (light < 0.12 ? 0.2 : 1) };
  });
  scored.sort((a, b) => b.score - a.score);
  const out: Rgb[] = [];
  for (const s of scored) {
    if (out.every((o) => Math.abs(o.r - s.c.r) + Math.abs(o.g - s.c.g) + Math.abs(o.b - s.c.b) > 60)) out.push({ r: Math.round(s.c.r), g: Math.round(s.c.g), b: Math.round(s.c.b) });
    if (out.length >= count) break;
  }
  return out;
}

/** '#rrggbb' / 'rgb()' + alpha → rgba(). Adapted from OpenDJ (MIT, github.com/Bucifer6/OpenDJ) visualizer.js. */
export function withAlpha(c: string, a: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c).trim());
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    const n = parseInt(h, 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }
  const r = /rgba?\(([^)]+)\)/.exec(c);
  if (r) return `rgba(${r[1].split(',').slice(0, 3).join(',')},${a})`;
  return `rgba(62,166,255,${a})`;
}

/** Device pixel ratio cap: TVs and big screens render at 1×, others at up to 2×. */
export const capDpr = (dpr: number, tv: boolean, cssWidth: number) => Math.max(1, Math.min(tv || cssWidth > 2200 ? 1 : 2, dpr || 1));
