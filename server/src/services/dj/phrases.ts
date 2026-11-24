/**
 * Phrase (song structure) detection for DJ mode: intro / verse / build / drop / breakdown / outro sections on
 * 8/16/32-bar boundaries, found from per-bar low/mid/high energy and a multi-scale novelty curve.
 *
 * Adapted from OpenDJ (MIT, github.com/Bucifer6/OpenDJ) — public/js/audio/analysis-core.js
 * (computeWaveform, detectPhrases, mixPoints). Changes: typed, milliseconds in/out, works on Vibe's
 * 11025 Hz analysis PCM, and returns the phrase list in the shared `DjPhrase` shape.
 */
import type { DjPhrase, DjPhraseType } from '@mediamax/shared';

/** Waveform points per second. */
const WAVE_RATE = 150;
/** Low / mid / high weights for section distances. */
const BAND_W = [1.5, 1, 0.8];

interface Waveform {
  rate: number;
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
}

const onePole = (fc: number, sr: number) => 1 - Math.exp((-2 * Math.PI * fc) / sr);

/** Three-band peak waveform (0–1 per band, normalised to the track's maximum). */
export function bandWaveform(pcm: Float32Array, sr: number, rate = WAVE_RATE): Waveform {
  const hop = sr / rate;
  const n = Math.ceil(pcm.length / hop);
  const low = new Float32Array(n);
  const mid = new Float32Array(n);
  const high = new Float32Array(n);
  const aL = onePole(220, sr);
  const aM = onePole(2600, sr);
  let lp1 = 0, lp1b = 0, lp2 = 0, lp2b = 0;
  for (let i = 0, k = 0, next = hop; i < pcm.length; i++) {
    const x = pcm[i];
    lp1 += aL * (x - lp1);
    lp1b += aL * (lp1 - lp1b);
    lp2 += aM * (x - lp2);
    lp2b += aM * (lp2 - lp2b);
    const lo = Math.abs(lp1b), mi = Math.abs(lp2b - lp1b), hi = Math.abs(x - lp2b);
    if (lo > low[k]) low[k] = lo;
    if (mi > mid[k]) mid[k] = mi;
    if (hi > high[k]) high[k] = hi;
    if (i >= next) {
      k++;
      next += hop;
      if (k >= n) break;
    }
  }
  const norm = (a: Float32Array) => {
    let mx = 1e-9;
    for (const v of a) if (v > mx) mx = v;
    for (let i = 0; i < a.length; i++) a[i] /= mx;
    return a;
  };
  return { rate, low: norm(low), mid: norm(mid), high: norm(high) };
}

/** Mean low / mid / high level of each beat, beats starting at t0 (seconds). */
function beatBands(w: Waveform, t0: number, beat: number, nb: number): Float32Array[] {
  const n = w.low.length;
  const lo = new Float32Array(nb), mi = new Float32Array(nb), hi = new Float32Array(nb);
  for (let b = 0; b < nb; b++) {
    const i0 = Math.max(0, Math.round((t0 + b * beat) * w.rate));
    const i1 = Math.min(n, Math.round((t0 + (b + 1) * beat) * w.rate));
    if (i1 <= i0) continue;
    let sl = 0, sm = 0, sh = 0;
    for (let i = i0; i < i1; i++) {
      sl += w.low[i];
      sm += w.mid[i];
      sh += w.high[i];
    }
    const c = i1 - i0;
    lo[b] = sl / c;
    mi[b] = sm / c;
    hi[b] = sh / c;
  }
  return [lo, mi, hi];
}

function prefix(a: ArrayLike<number>) {
  const p = new Float64Array(a.length + 1);
  for (let i = 0; i < a.length; i++) p[i + 1] = p[i] + a[i];
  return p;
}

/** Weighted distance between the mean feature vectors of [a0,a1) and [b0,b1). */
function segDist(P: Float64Array[], a0: number, a1: number, b0: number, b1: number) {
  let d = 0;
  for (let j = 0; j < P.length; j++) {
    const x = (P[j][a1] - P[j][a0]) / (a1 - a0);
    const y = (P[j][b1] - P[j][b0]) / (b1 - b0);
    d += BAND_W[j] * (x - y) * (x - y);
  }
  return Math.sqrt(d);
}

export interface PhraseResult {
  phrases: DjPhrase[];
  downbeatMs: number;
}

/**
 * Bar / phrase structure from PCM, a tempo and a beat-grid anchor.
 * startMs/endMs bound the audible part (cue-in / cue-out); phrases outside it are not reported.
 */
export function detectPhrases(pcm: Float32Array, sr: number, bpm: number | null, gridOffsetMs: number | null, opts: { startMs?: number; endMs?: number } = {}): PhraseResult {
  const duration = pcm.length / sr;
  const startTime = Math.max(0, (opts.startMs ?? 0) / 1000);
  const endTime = Math.min(duration, (opts.endMs ?? duration * 1000) / 1000);
  if (!bpm || gridOffsetMs == null || !(endTime > startTime)) return { phrases: [], downbeatMs: Math.round(startTime * 1000) };
  const waveform = bandWaveform(pcm, sr);
  const beat = 60 / bpm;
  const bar = beat * 4;
  const gridOffset = gridOffsetMs / 1000;
  const t0 = gridOffset - Math.floor(gridOffset / beat) * beat;
  const nb = Math.max(0, Math.floor((duration - t0) / beat));
  const PB = beatBands(waveform, t0, beat, nb).map(prefix);

  // 1) Downbeat phase: the bar phase where the big energy changes line up.
  const firstBeat = Math.max(0, Math.ceil((startTime - t0) / beat - 0.25));
  const lastBeat = Math.min(nb, Math.floor((endTime - t0) / beat));
  const score = [0, 0, 0, 0];
  for (let b = firstBeat + 4; b <= lastBeat - 4; b++) {
    const d = segDist(PB, b - 4, b, b, b + 4);
    score[b % 4] += d * d;
  }
  const fallback = firstBeat % 4; // prior: music starts on a downbeat
  score[fallback] *= 1.1;
  let phase = fallback;
  for (let p = 0; p < 4; p++) if (score[p] > score[phase] + 1e-9) phase = p;
  let db = phase;
  while (db < firstBeat) db += 4;
  const downbeat = t0 + db * beat;
  const ms = (s: number) => Math.round(s * 1000);

  // 2) Per-bar features.
  const K = Math.floor((lastBeat - db) / 4);
  if (K < 4) {
    return { phrases: [{ startMs: ms(Math.min(downbeat, startTime)), endMs: ms(endTime), type: 'verse', energy: 1, bars: Math.max(0, K) }], downbeatMs: ms(downbeat) };
  }
  const F = [new Float32Array(K), new Float32Array(K), new Float32Array(K)];
  for (let j = 0; j < 3; j++) {
    const P = PB[j];
    let mx = 1e-6;
    for (let k = 0; k < K; k++) {
      F[j][k] = (P[db + 4 * k + 4] - P[db + 4 * k]) / 4;
      if (F[j][k] > mx) mx = F[j][k];
    }
    for (let k = 0; k < K; k++) F[j][k] /= mx;
  }
  const PF = F.map(prefix);

  // 3) Novelty between bars (multi-scale before/after contrast ≈ checkerboard kernel on the self-similarity matrix).
  const nov = new Float32Array(K + 1);
  let maxNov = 0;
  for (let k = 1; k < K; k++) {
    let v = 0;
    for (const [W, wt] of [[2, 0.5], [4, 1], [8, 1]] as const) {
      const w = Math.min(W, k, K - k);
      if (w < Math.min(2, W)) continue;
      v += wt * (w / W) * segDist(PF, k - w, k, k, k + w);
    }
    nov[k] = v;
    if (v > maxNov) maxNov = v;
  }
  const thr = Math.max(0.06, 0.2 * maxNov);
  // Phrase prior: sections change on 16/8/4-bar lines.
  const prior = (k: number) => (k % 16 === 0 ? 1.3 : k % 8 === 0 ? 1.2 : k % 4 === 0 ? 1.05 : 1);
  const cands: { k: number; s: number }[] = [];
  for (let k = 2; k <= K - 2; k++) {
    if (nov[k] < thr) continue;
    let isMax = true;
    for (let j = Math.max(1, k - 2); j <= Math.min(K - 1, k + 2); j++) {
      if (j !== k && (nov[j] > nov[k] || (nov[j] === nov[k] && j < k))) {
        isMax = false;
        break;
      }
    }
    if (isMax) cands.push({ k, s: nov[k] * prior(k) });
  }
  cands.sort((a, b) => b.s - a.s);
  const bounds: number[] = [];
  for (const c of cands) {
    if (c.k < 4 || K - c.k < 4) continue;
    if (bounds.every((k) => Math.abs(k - c.k) >= 8)) bounds.push(c.k);
  }
  bounds.sort((a, b) => a - b);
  const edges = [0, ...bounds, K];

  // 4) Section stats + labels.
  interface Sec { a: number; b: number; lo: number; e: number; slope: number; eRel: number; loRel: number; full: boolean; type: DjPhraseType }
  const secs: Sec[] = [];
  const m = (j: number, x: number, y: number) => (PF[j][y] - PF[j][x]) / (y - x);
  const en = (x: number, y: number) => 0.5 * m(0, x, y) + 0.3 * m(1, x, y) + 0.2 * m(2, x, y);
  for (let i = 0; i + 1 < edges.length; i++) {
    const a = edges[i], b = edges[i + 1];
    const q = Math.max(1, Math.floor((b - a) / 4));
    secs.push({ a, b, lo: m(0, a, b), e: en(a, b), slope: en(b - q, b) - en(a, a + q), eRel: 0, loRel: 0, full: false, type: 'verse' });
  }
  const maxE = Math.max(...secs.map((s) => s.e), 1e-6);
  const maxLo = Math.max(...secs.map((s) => s.lo), 1e-6);
  for (const s of secs) {
    s.eRel = s.e / maxE;
    s.loRel = s.lo / maxLo;
    s.full = s.loRel >= 0.7 && s.eRel >= 0.75;
  }
  const n = secs.length;
  let hadDrop = false;
  secs.forEach((s, i) => {
    if (n === 1) s.type = s.full ? 'drop' : 'verse';
    else if (i === 0) s.type = 'intro';
    else if (i === n - 1) s.type = 'outro';
    else if (s.full) s.type = 'drop';
    else {
      const next = secs[i + 1];
      const nextDrop = i + 1 < n - 1 && next.full;
      if (nextDrop && (s.slope > 0.06 || s.b - s.a <= 8) && !(hadDrop && s.loRel < 0.35 && s.b - s.a > 8)) s.type = 'buildup';
      else if (hadDrop && s.loRel < 0.6) s.type = 'breakdown';
      else if (nextDrop) s.type = 'buildup';
      else s.type = 'verse';
    }
    if (s.type === 'drop' || s.full) hadDrop = true; // a full-energy intro counts as a drop for what follows
  });

  // 5) Phrases: sections longer than 32 bars are split into 16-bar phrases.
  const parts: { a: number; b: number; s: Sec }[] = [];
  for (const s of secs) {
    let a = s.a;
    if (s.b - a > 32) {
      while (s.b - a >= 24) {
        parts.push({ a, b: a + 16, s });
        a += 16;
      }
    }
    parts.push({ a, b: s.b, s });
  }
  const phrases = parts.map(({ a, b, s }, i): DjPhrase => ({
    startMs: ms(i === 0 ? Math.max(0, Math.min(downbeat, startTime)) : downbeat + a * bar),
    endMs: ms(i === parts.length - 1 ? Math.max(downbeat + b * bar, endTime) : downbeat + b * bar),
    type: s.type,
    energy: Math.round(s.eRel * 100) / 100,
    bars: b - a,
  }));
  return { phrases, downbeatMs: ms(downbeat) };
}

/**
 * Phrase-based mix points: mix in on the first downbeat; mix out at the start of the trailing outro (8–64 bars),
 * else the last 32 (short tracks: 16) bars on an 8-bar line.
 */
export function phraseMixPoints(phrases: DjPhrase[], downbeatMs: number, bpm: number | null, endMs: number): { mixInMs: number; mixOutMs: number; fromOutro: boolean } {
  if (!bpm || !phrases.length) return { mixInMs: downbeatMs, mixOutMs: Math.max(downbeatMs, endMs - 30000), fromOutro: false };
  const bar = 240000 / bpm;
  const K = Math.floor((endMs - downbeatMs) / bar + 1e-6);
  const last = phrases[phrases.length - 1];
  let oi = phrases.length - 1;
  while (oi > 0 && phrases[oi - 1].type === 'outro') oi--;
  const outroBars = Math.round((endMs - phrases[oi].startMs) / bar);
  let mixOut: number;
  let fromOutro = false;
  if (last.type === 'outro' && oi > 0 && outroBars >= 8 && outroBars <= 64) {
    mixOut = phrases[oi].startMs;
    fromOutro = true;
  } else {
    const L = K >= 64 ? 32 : K >= 24 ? 16 : Math.max(1, Math.floor(K / 2));
    const k = Math.max(0, L >= 8 ? Math.floor((K - L) / 8) * 8 : K - L);
    mixOut = downbeatMs + k * bar;
  }
  if (mixOut <= downbeatMs) mixOut = Math.max(downbeatMs, endMs - Math.min(30000, (endMs - downbeatMs) / 2));
  return { mixInMs: Math.round(downbeatMs), mixOutMs: Math.round(mixOut), fromOutro };
}

/** The phrase that contains `ms` (or null). */
export function phraseAt(phrases: DjPhrase[] | null | undefined, ms: number): DjPhrase | null {
  if (!phrases?.length) return null;
  for (const p of phrases) if (ms >= p.startMs - 50 && ms < p.endMs - 50) return p;
  return null;
}
