/**
 * Small, dependency-free DSP for DJ analysis: FFT, tempo (BPM), key (Camelot), loudness/energy and mix points.
 * Input is mono float PCM at a low sample rate (11025 Hz is plenty for rhythm and harmony).
 */

/* ------------------------------- FFT -------------------------------- */

const twiddleCache = new Map<number, { cos: Float64Array; sin: Float64Array; rev: Uint32Array }>();
function plan(n: number) {
  let p = twiddleCache.get(n);
  if (p) return p;
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  p = { cos, sin, rev };
  twiddleCache.set(n, p);
  return p;
}

/** Magnitude spectrum (n/2 bins) of `frame` (length n, power of two), in place-safe scratch buffers. */
export function magnitudes(frame: Float64Array, out: Float64Array, re: Float64Array, im: Float64Array) {
  const n = frame.length;
  const { cos, sin, rev } = plan(n);
  for (let i = 0; i < n; i++) {
    re[rev[i]] = frame[i];
    im[rev[i]] = 0;
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const c = cos[k * step];
        const s = sin[k * step];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * c - im[b] * s;
        const ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  for (let i = 0; i < n / 2; i++) out[i] = Math.hypot(re[i], im[i]);
}

const hann = (n: number) => {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
};

/* ----------------------------- loudness ----------------------------- */

export interface Loudness {
  /** RMS in dBFS per frame. */
  frameDb: Float64Array;
  frameMs: number;
  meanDb: number;
}

export function loudness(pcm: Float32Array, rate: number, frame = 1024): Loudness {
  const n = Math.floor(pcm.length / frame);
  const frameDb = new Float64Array(n);
  let sumPow = 0;
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) s += pcm[i] * pcm[i];
    const ms = s / frame;
    sumPow += ms;
    frameDb[f] = 10 * Math.log10(ms + 1e-12);
  }
  return { frameDb, frameMs: (frame / rate) * 1000, meanDb: 10 * Math.log10(sumPow / Math.max(1, n) + 1e-12) };
}

/* ------------------------------- tempo ------------------------------ */

/** Onset strength envelope via log spectral flux (hop 256 → ~43 frames/s at 11025 Hz). */
export function onsetEnvelope(pcm: Float32Array, rate: number, n = 1024, hop = 256): { env: Float64Array; fps: number } {
  const frames = Math.max(0, Math.floor((pcm.length - n) / hop));
  const env = new Float64Array(frames);
  const win = hann(n);
  const frame = new Float64Array(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const prev = new Float64Array(n / 2);
  const cur = new Float64Array(n / 2);
  const maxBin = Math.min(n / 2, Math.round((5000 / rate) * n));
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < n; i++) frame[i] = pcm[off + i] * win[i];
    magnitudes(frame, cur, re, im);
    let flux = 0;
    for (let k = 1; k < maxBin; k++) {
      const v = Math.log1p(100 * cur[k]);
      const d = v - prev[k];
      if (d > 0) flux += d;
      prev[k] = v;
    }
    env[f] = flux;
  }
  return { env, fps: rate / hop };
}

/**
 * Tempo from the onset envelope: autocorrelation scored across 60–200 BPM with half/double-tempo support
 * and a gentle prior around 120 BPM (where most dance and pop music sits).
 */
export function estimateTempo(env: Float64Array, fps: number): { bpm: number | null; confidence: number; beatOffsetMs: number | null } {
  if (env.length < fps * 8) return { bpm: null, confidence: 0, beatOffsetMs: null };
  // Remove the slow trend so loud sections don't dominate.
  const w = Math.round(fps);
  const x = new Float64Array(env.length);
  let acc = 0;
  for (let i = 0; i < env.length; i++) {
    acc += env[i];
    if (i >= w) acc -= env[i - w];
    const mean = acc / Math.min(i + 1, w);
    x[i] = Math.max(0, env[i] - mean);
  }
  const maxLag = Math.ceil((60 / 50) * fps) + 2;
  const ac = new Float64Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < x.length; i++) s += x[i] * x[i - lag];
    ac[lag] = s / (x.length - lag);
  }
  let zero = 0;
  for (let i = 0; i < x.length; i++) zero += x[i] * x[i];
  zero /= x.length;
  if (zero <= 0) return { bpm: null, confidence: 0, beatOffsetMs: null };
  const at = (lag: number) => {
    if (lag < 1 || lag >= maxLag) return 0;
    const i = Math.floor(lag);
    const t = lag - i;
    return ac[i] * (1 - t) + ac[i + 1] * t;
  };
  let best = 0;
  let bestBpm = 0;
  const scores: number[] = [];
  for (let bpm = 60; bpm <= 200; bpm += 0.25) {
    const lag = (60 / bpm) * fps;
    // A real beat period also correlates at 2× and 4× the lag.
    const s = at(lag) + 0.5 * at(lag * 2) + 0.25 * at(lag * 4) + 0.25 * at(lag / 2);
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 122) / 0.7, 2));
    const score = s * (0.35 + 0.65 * prior);
    scores.push(score);
    if (score > best) {
      best = score;
      bestBpm = bpm;
    }
  }
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const confidence = Math.max(0, Math.min(1, (best / (mean || 1) - 1) / 6));
  if (confidence < 0.35) return { bpm: null, confidence: Math.round(confidence * 100) / 100, beatOffsetMs: null };
  // Half-time fold: very fast readings whose half tempo is almost as strong are usually half-time grooves.
  let coarse = bestBpm;
  if (coarse > 150) {
    const half = coarse / 2;
    const lag = (60 / half) * fps;
    const sh = at(lag) + 0.5 * at(lag * 2) + 0.25 * at(lag * 4) + 0.25 * at(lag / 2);
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(half / 122) / 0.7, 2));
    if (sh * (0.35 + 0.65 * prior) >= best * 0.85) coarse = half;
  }
  const { bpm: fine, phase } = refineTempo(x, fps, coarse);
  // Phase in onset frames; analysis.ts adds the measured frame latency (~90 ms) to land on the audible beat.
  return { bpm: Math.round(fine * 100) / 100, confidence: Math.round(confidence * 100) / 100, beatOffsetMs: Math.round((phase / fps) * 1000) };
}

/**
 * Beat-grid refinement: for tempos within ±2 BPM, find the phase whose grid lands on the most onset energy
 * across the whole track. A long track pins the period down far more precisely than autocorrelation lags.
 */
function refineTempo(x: Float64Array, fps: number, bpm: number): { bpm: number; phase: number } {
  const sample = (t: number) => {
    const i = Math.floor(t);
    if (i < 0 || i + 1 >= x.length) return 0;
    const f = t - i;
    return x[i] * (1 - f) + x[i + 1] * f;
  };
  // Sharpen: local maximum within ±1 frame so slightly early/late hits still count.
  const hit = (t: number) => Math.max(sample(t - 1), sample(t), sample(t + 1));
  let bestBpm = bpm;
  let bestPhase = 0;
  let bestScore = -1;
  const search = (lo: number, hi: number, step: number) => {
    for (let b = lo; b <= hi + 1e-9; b += step) {
      const period = (60 / b) * fps;
      let local = -1;
      let localPhase = 0;
      for (let phase = 0; phase < period; phase += 0.5) {
        let s = 0;
        let n = 0;
        for (let t = phase; t < x.length; t += period) {
          s += hit(t);
          n++;
        }
        if (n && s / n > local) {
          local = s / n;
          localPhase = phase;
        }
      }
      if (local > bestScore) {
        bestScore = local;
        bestBpm = b;
        bestPhase = localPhase;
      }
    }
  };
  search(bpm - 2, bpm + 2, 0.1);
  const c = bestBpm;
  search(c - 0.1, c + 0.1, 0.01);
  return { bpm: bestBpm, phase: bestPhase };
}

/* -------------------------------- key ------------------------------- */

const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
// Krumhansl–Kessler key profiles.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
// Camelot numbers by tonic pitch class.
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];

export function chroma(pcm: Float32Array, rate: number, n = 4096, hop = 2048): Float64Array {
  const out = new Float64Array(12);
  const win = hann(n);
  const frame = new Float64Array(n);
  const mag = new Float64Array(n / 2);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const lo = Math.ceil((55 / rate) * n);
  const hi = Math.min(n / 2 - 1, Math.floor((2000 / rate) * n));
  const pc = new Int8Array(n / 2).fill(-1);
  for (let k = lo; k <= hi; k++) {
    const f = (k * rate) / n;
    const midi = 69 + 12 * Math.log2(f / 440);
    // Only bins close to a semitone centre; between-note bins blur the profile.
    if (Math.abs(midi - Math.round(midi)) < 0.35) pc[k] = ((Math.round(midi) % 12) + 12) % 12;
  }
  for (let off = 0; off + n <= pcm.length; off += hop) {
    let e = 0;
    for (let i = 0; i < n; i++) {
      frame[i] = pcm[off + i] * win[i];
      e += frame[i] * frame[i];
    }
    if (e < 1e-6) continue; // silence
    magnitudes(frame, mag, re, im);
    for (let k = lo; k <= hi; k++) if (pc[k] >= 0) out[pc[k]] += Math.sqrt(mag[k]);
  }
  return out;
}

function corr(a: ArrayLike<number>, b: number[]) {
  let ma = 0;
  for (let i = 0; i < 12; i++) ma += a[i] / 12;
  const mb = b.reduce((s, v) => s + v, 0) / 12;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < 12; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db || 1);
}

export function estimateKey(ch: Float64Array): { key: string | null; camelot: string | null; confidence: number } {
  if (ch.every((v) => v === 0)) return { key: null, camelot: null, confidence: 0 };
  let best = { r: -2, tonic: 0, minor: false };
  let second = -2;
  for (let t = 0; t < 12; t++) {
    for (const minor of [false, true]) {
      const prof = minor ? MINOR : MAJOR;
      const rot = Array.from({ length: 12 }, (_, i) => prof[(i - t + 12) % 12]);
      const r = corr(ch, rot);
      if (r > best.r) {
        second = best.r;
        best = { r, tonic: t, minor };
      } else if (r > second) second = r;
    }
  }
  if (best.r < 0.3) return { key: null, camelot: null, confidence: Math.max(0, best.r) };
  const camelot = `${(best.minor ? CAMELOT_MINOR : CAMELOT_MAJOR)[best.tonic]}${best.minor ? 'A' : 'B'}`;
  return { key: `${NOTES[best.tonic]} ${best.minor ? 'minor' : 'major'}`, camelot, confidence: Math.round((best.r - Math.max(0, second)) * 100) / 100 };
}

/** How well two Camelot keys mix. Same key or ±1 on the wheel (or the relative major/minor) are safe. */
export function keyCompatibility(a: string | null, b: string | null): 'perfect' | 'compatible' | 'energy' | 'clash' | 'unknown' {
  if (!a || !b) return 'unknown';
  const pa = /^(\d+)([AB])$/.exec(a);
  const pb = /^(\d+)([AB])$/.exec(b);
  if (!pa || !pb) return 'unknown';
  const na = +pa[1];
  const nb = +pb[1];
  const dist = Math.min((na - nb + 12) % 12, (nb - na + 12) % 12);
  if (a === b) return 'perfect';
  if (pa[2] === pb[2] && dist === 1) return 'compatible';
  if (na === nb) return 'compatible'; // relative major/minor
  if (pa[2] === pb[2] && dist === 2) return 'energy'; // "energy boost" (+2) mixes are a deliberate DJ move
  return 'clash';
}

/* ---------------------------- mix points ---------------------------- */

export function mixPoints(l: Loudness, durationMs: number) {
  const db = l.frameDb;
  const n = db.length;
  if (!n) return { cueInMs: 0, cueOutMs: durationMs, introEndMs: null, outroStartMs: null };
  let peak = -120;
  for (const v of db) peak = Math.max(peak, v);
  const floor = Math.max(-55, peak - 40);
  let first = 0;
  while (first < n - 1 && db[first] < floor) first++;
  let last = n - 1;
  while (last > first && db[last] < floor) last--;
  // ~3 s moving average for section-level energy.
  const w = Math.max(1, Math.round(3000 / l.frameMs));
  const sm = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += Math.pow(10, db[i] / 10);
    if (i >= w) acc -= Math.pow(10, db[i - w] / 10);
    sm[i] = 10 * Math.log10(acc / Math.min(i + 1, w) + 1e-12);
  }
  const body = Array.from(sm.slice(first, last + 1)).sort((a, b) => a - b);
  const median = body[Math.floor(body.length * 0.6)] ?? -30;
  const maxEdge = Math.min(Math.round(60000 / l.frameMs), Math.floor((last - first) / 3));
  // Intro: the track starts clearly quieter than its body and then reaches it.
  let introEnd: number | null = null;
  if (sm[Math.min(n - 1, first + w)] < median - 6) {
    for (let i = first + w; i < first + maxEdge; i++) if (sm[i] >= median - 3) { introEnd = i; break; }
  }
  // Outro: the last point (within the final minute) where the body level still holds.
  let outroStart: number | null = null;
  for (let i = last; i > last - maxEdge && i > first; i--) {
    if (sm[i] >= median - 3) {
      if (last - i > Math.round(4000 / l.frameMs)) outroStart = i;
      break;
    }
  }
  const ms = (i: number) => Math.round(i * l.frameMs);
  return {
    cueInMs: ms(first),
    cueOutMs: Math.min(durationMs, ms(last + 1)),
    introEndMs: introEnd != null ? ms(introEnd) : null,
    outroStartMs: outroStart != null ? ms(outroStart) : null,
  };
}

/** 0–1 intensity from loudness and onset density (both normalised to typical music ranges). */
export function energyScore(meanDb: number, env: Float64Array, fps: number) {
  const loud = Math.max(0, Math.min(1, (meanDb + 32) / 24));
  let s = 0;
  for (const v of env) s += v;
  const density = env.length ? s / env.length : 0;
  const dens = Math.max(0, Math.min(1, density / 60));
  void fps;
  return Math.round((0.65 * loud + 0.35 * dens) * 1000) / 1000;
}

/* ------------------------------ timbre ------------------------------ */

let melCache: { n: number; rate: number; bank: { lo: number; mid: number; hi: number }[] } | null = null;
function melBank(n: number, rate: number, filters = 26, fmax = 5000) {
  if (melCache && melCache.n === n && melCache.rate === rate) return melCache.bank;
  const mel = (f: number) => 2595 * Math.log10(1 + f / 700);
  const inv = (m: number) => 700 * (Math.pow(10, m / 2595) - 1);
  const top = mel(Math.min(fmax, rate / 2));
  const pts = Array.from({ length: filters + 2 }, (_, i) => Math.round((inv((top * i) / (filters + 1)) / rate) * n));
  const bank = Array.from({ length: filters }, (_, i) => ({ lo: pts[i], mid: Math.max(pts[i] + 1, pts[i + 1]), hi: Math.max(pts[i] + 2, pts[i + 2]) }));
  melCache = { n, rate, bank };
  return bank;
}

/**
 * Timbre fingerprint: means and standard deviations of MFCC 1–12, plus mean spectral centroid (0–1 of Nyquist)
 * and spectral flatness. 26 numbers; compare after z-scoring across the library.
 */
export function timbre(pcm: Float32Array, rate: number, n = 1024, hop = 2048): number[] | null {
  const win = hann(n);
  const frame = new Float64Array(n);
  const mag = new Float64Array(n / 2);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const bank = melBank(n, rate);
  const C = 13;
  const sums = new Float64Array(C);
  const sq = new Float64Array(C);
  let centroid = 0;
  let flat = 0;
  let frames = 0;
  const energies = new Float64Array(bank.length);
  for (let off = 0; off + n <= pcm.length; off += hop) {
    let e = 0;
    for (let i = 0; i < n; i++) {
      frame[i] = pcm[off + i] * win[i];
      e += frame[i] * frame[i];
    }
    if (e < 1e-5) continue; // skip silence
    magnitudes(frame, mag, re, im);
    for (let b = 0; b < bank.length; b++) {
      const { lo, mid, hi } = bank[b];
      let s = 0;
      for (let k = lo; k < hi && k < mag.length; k++) {
        const w = k < mid ? (k - lo) / (mid - lo) : (hi - k) / (hi - mid);
        s += w * mag[k] * mag[k];
      }
      energies[b] = Math.log(s + 1e-10);
    }
    for (let c = 1; c < C; c++) {
      let v = 0;
      for (let b = 0; b < bank.length; b++) v += energies[b] * Math.cos((Math.PI * c * (b + 0.5)) / bank.length);
      sums[c] += v;
      sq[c] += v * v;
    }
    let num = 0;
    let den = 0;
    let logSum = 0;
    let linSum = 0;
    for (let k = 1; k < mag.length; k++) {
      num += k * mag[k];
      den += mag[k];
      logSum += Math.log(mag[k] + 1e-10);
      linSum += mag[k];
    }
    centroid += den ? num / den / mag.length : 0;
    flat += Math.exp(logSum / (mag.length - 1)) / (linSum / (mag.length - 1) + 1e-10);
    frames++;
  }
  if (frames < 10) return null;
  const out: number[] = [];
  for (let c = 1; c < C; c++) {
    const mean = sums[c] / frames;
    out.push(mean, Math.sqrt(Math.max(0, sq[c] / frames - mean * mean)));
  }
  out.push(centroid / frames, flat / frames);
  return out.map((v) => Math.round(v * 1000) / 1000);
}

/** Cosine similarity of two z-scored vectors (−1…1). */
export function similarity(a: number[], b: number[], mean: number[], std: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = (a[i] - mean[i]) / (std[i] || 1);
    const y = (b[i] - mean[i]) / (std[i] || 1);
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
