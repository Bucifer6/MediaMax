/**
 * Pure DSP for AI stem separation (no DOM, no ORT): runs in the browser's stems worker and the server's separation
 * process (and in Node tests).
 *  - FFT / Demucs-compatible STFT (spec) and inverse STFT (ispec), matching torch.stft/istft as used by HT-Demucs
 *  - chunk planning + streaming overlap-add (finished audio leaves the worker block by block)
 *  - Int16 helpers
 * Adapted from OpenDJ (MIT, github.com/Bucifer6/OpenDJ) — public/js/stems/stem-dsp.js.
 *
 * The canonical copy lives in shared/src/stems/; `node scripts/sync-types.mjs` copies it verbatim to web/src/stems/ and
 * server/src/services/separation/ (a server test checks they match).
 */

export const MODEL_RATE = 44100;
/** Stem order used everywhere in Vibe (files, uploads). */
export const STEMS = ['vocals', 'drums', 'bass', 'other'] as const;
/** HT-Demucs output order. */
export const DEMUCS_SOURCES = ['drums', 'bass', 'other', 'vocals'] as const;

interface FftPlan {
  n: number;
  fft(re: Float64Array, im: Float64Array): void;
}
const plans = new Map<number, FftPlan>();
/** Radix-2 complex FFT plan (in place on Float64Array re/im). */
export function fftPlan(n: number): FftPlan {
  const cached = plans.get(n);
  if (cached) return cached;
  if (n & (n - 1)) throw new Error('FFT size must be a power of 2');
  const rev = new Uint32Array(n), cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n);
    sin[i] = Math.sin((-2 * Math.PI * i) / n);
  }
  const plan: FftPlan = {
    n,
    fft(re, im) {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = 0, k = 0; j < half; j++, k += step) {
            const a = i + j, b = a + half, wr = cos[k], wi = sin[k];
            const tr = wr * re[b] - wi * im[b], ti = wr * im[b] + wi * re[b];
            re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          }
        }
      }
    },
  };
  plans.set(n, plan);
  return plan;
}

const hannCache = new Map<number, Float64Array>();
/** Periodic Hann window (torch.hann_window default). */
export function hann(n: number): Float64Array {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
    hannCache.set(n, w);
  }
  return w;
}

/** Reflect index into [0, n) (torch 'reflect' padding, edge sample not repeated). */
function reflect(i: number, n: number): number {
  if (n === 1) return 0;
  const p = 2 * (n - 1);
  i = ((i % p) + p) % p;
  return i < n ? i : p - i;
}

// HTDemucs._spec: hop 1024, nfft 4096, input reflect-padded by 3*hop/2 (+ up to a multiple of hop),
// torch.stft(center=True, reflect, normalized=True), last bin dropped, frames 2..2+le kept.
export const HOP = 1024, NFFT = 4096, BINS = 2048;
export const specFrames = (length: number) => Math.ceil(length / HOP);

/** Complex-as-channels spectrogram of a planar multichannel signal → [C*2][BINS][le]. */
export function demucsSpec(mix: Float32Array, channels: number, length: number): Float32Array {
  const le = specFrames(length), pad = (HOP / 2) * 3;
  const padLen = le * HOP + 2 * pad;
  const out = new Float32Array(channels * 2 * BINS * le);
  const plan = fftPlan(NFFT), w = hann(NFFT), norm = 1 / Math.sqrt(NFFT);
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
  const padded: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const src = mix.subarray(c * length, (c + 1) * length);
    const p1 = new Float32Array(padLen);
    for (let i = 0; i < padLen; i++) p1[i] = src[reflect(i - pad, length)];
    const p2 = new Float32Array(padLen + NFFT);
    for (let i = 0; i < p2.length; i++) p2[i] = p1[reflect(i - NFFT / 2, padLen)];
    padded.push(p2);
  }
  for (let c = 0; c < channels; c += 2) {
    const a = padded[c], b = padded[c + 1];
    for (let t = 0; t < le; t++) {
      const start = (t + 2) * HOP;
      for (let i = 0; i < NFFT; i++) {
        re[i] = a[start + i] * w[i] * norm;
        im[i] = b ? b[start + i] * w[i] * norm : 0;
      }
      plan.fft(re, im);
      for (let f = 0; f < BINS; f++) {
        const g = f === 0 ? 0 : NFFT - f;
        const zr = re[f], zi = im[f], cr = re[g], ci = -im[g];
        const base1 = (c * 2 * BINS + f) * le + t, base1i = ((c * 2 + 1) * BINS + f) * le + t;
        out[base1] = (zr + cr) / 2;
        out[base1i] = (zi + ci) / 2;
        if (b) {
          const base2 = ((c + 1) * 2 * BINS + f) * le + t, base2i = (((c + 1) * 2 + 1) * BINS + f) * le + t;
          out[base2] = (zi - ci) / 2;
          out[base2i] = -(zr - cr) / 2;
        }
      }
    }
  }
  return out;
}

/** Inverse of demucsSpec for S sources: [S][C*2][BINS][le] → planar [S][C][length] (added into `out`). */
export function demucsISpec(z: ArrayLike<number>, sources: number, channels: number, length: number, out = new Float32Array(sources * channels * length)): Float32Array {
  const le = specFrames(length), pad = (HOP / 2) * 3;
  const plan = fftPlan(NFFT), w = hann(NFFT), norm = Math.sqrt(NFFT);
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
  const off = pad + NFFT / 2 - 2 * HOP;
  const env = new Float64Array(length);
  for (let t = -2; t < le + 2; t++) for (let i = 0; i < NFFT; i++) {
    const k = t * HOP + i - off;
    if (k >= 0 && k < length) env[k] += w[i] * w[i];
  }
  const scale = new Float64Array(NFFT);
  for (let i = 0; i < NFFT; i++) scale[i] = (w[i] * norm) / NFFT;
  const plane = BINS * le;
  for (let s = 0; s < sources; s++) {
    for (let c = 0; c < channels; c += 2) {
      const two = c + 1 < channels;
      const rA = (s * channels * 2 + c * 2) * plane, iA = rA + plane;
      const rB = rA + 2 * plane, iB = rA + 3 * plane;
      const oA = (s * channels + c) * length, oB = oA + length;
      for (let t = 0; t < le; t++) {
        for (let f = 0; f < BINS; f++) {
          const x1r = z[rA + f * le + t], x1i = f === 0 ? 0 : z[iA + f * le + t];
          const x2r = two ? z[rB + f * le + t] : 0, x2i = two && f !== 0 ? z[iB + f * le + t] : 0;
          re[f] = x1r - x2i;
          im[f] = x1i + x2r;
          if (f) {
            re[NFFT - f] = x1r + x2i;
            im[NFFT - f] = -x1i + x2r;
          }
        }
        re[BINS] = 0;
        im[BINS] = 0;
        for (let i = 0; i < NFFT; i++) im[i] = -im[i];
        plan.fft(re, im);
        const start = t * HOP - off;
        const i0 = Math.max(0, -start), i1 = Math.min(NFFT, length - start);
        for (let i = i0; i < i1; i++) {
          const k = start + i;
          out[oA + k] += (re[i] * scale[i]) / env[k];
          if (two) out[oB + k] += (-im[i] * scale[i]) / env[k];
        }
      }
    }
  }
  return out;
}

/** Demucs-style triangular weight (normalised to max 1). */
export function transitionWeight(segment: number): Float32Array {
  const w = new Float32Array(segment);
  const h = Math.floor(segment / 2);
  for (let i = 0; i <= h && i < segment; i++) w[i] = i + 1;
  for (let i = h + 1; i < segment; i++) w[i] = segment - i;
  let m = 0;
  for (const v of w) m = Math.max(m, v);
  for (let i = 0; i < segment; i++) w[i] /= m;
  return w;
}

/** Chunk offsets for a track with stride = (1 − overlap) · segment. */
export function planChunks(length: number, segment: number, overlap = 0.25) {
  const stride = Math.max(1, Math.floor((1 - overlap) * segment));
  const chunks: { offset: number; length: number }[] = [];
  for (let offset = 0; offset < length; offset += stride) chunks.push({ offset, length: Math.min(segment, length - offset) });
  return { stride, chunks };
}

/** Model input for one chunk (planar [C][segment]); short final chunks are centred with real audio as context. */
export function chunkInput(channelsData: Float32Array[], length: number, offset: number, chunkLen: number, segment: number, out = new Float32Array(channelsData.length * segment)) {
  const start = offset - Math.floor((segment - chunkLen) / 2);
  out.fill(0);
  for (let c = 0; c < channelsData.length; c++) {
    const src = channelsData[c], base = c * segment;
    const a = Math.max(0, start), b = Math.min(length, start + segment);
    if (b > a) out.set(src.subarray(a, b), base + (a - start));
  }
  return out;
}

export interface Block {
  frame: number;
  frames: number;
  /** planar [S][C][frames] */
  data: Float32Array;
}

/** Streaming overlap-add: add chunks in order, take out the samples no later chunk can touch. */
export class StreamingOLA {
  private weight: Float32Array;
  private acc: Float32Array;
  private wsum: Float32Array;
  private base = 0;
  constructor(private sources: number, private channels: number, private length: number, private segment: number, private stride: number) {
    this.weight = transitionWeight(segment);
    this.acc = new Float32Array(sources * channels * segment);
    this.wsum = new Float32Array(segment);
  }
  add(out: ArrayLike<number>, chunkLen: number): Block {
    const { sources, channels, segment, weight, acc, wsum } = this;
    const trim = Math.floor((segment - chunkLen) / 2);
    for (let k = 0; k < sources * channels; k++) {
      const o = k * segment, a = k * segment + trim;
      for (let t = 0; t < chunkLen; t++) acc[o + t] += weight[t] * out[a + t];
    }
    for (let t = 0; t < chunkLen; t++) wsum[t] += weight[t];
    const last = this.base + this.stride >= this.length;
    const n = last ? this.length - this.base : this.stride;
    const data = new Float32Array(sources * channels * n);
    for (let k = 0; k < sources * channels; k++) {
      const o = k * segment, d = k * n;
      for (let t = 0; t < n; t++) data[d + t] = wsum[t] > 0 ? acc[o + t] / wsum[t] : 0;
    }
    const block = { frame: this.base, frames: n, data };
    for (let k = 0; k < sources * channels; k++) {
      const o = k * segment;
      acc.copyWithin(o, o + n, o + segment);
      acc.fill(0, o + segment - n, o + segment);
    }
    wsum.copyWithin(0, n);
    wsum.fill(0, segment - n);
    this.base += n;
    return block;
  }
}

/** Separate a whole track chunk by chunk; `onBlock` receives finished audio in order. */
export async function separateChunked(o: {
  channels: Float32Array[]; length: number; segment: number; overlap?: number; sources: number;
  runChunk: (input: Float32Array) => Promise<ArrayLike<number>>;
  onBlock?: (b: Block) => void | Promise<void>;
  onProgress?: (done: number, total: number) => void;
  shouldStop?: () => boolean;
}) {
  const C = o.channels.length;
  const { stride, chunks } = planChunks(o.length, o.segment, o.overlap ?? 0.25);
  const ola = new StreamingOLA(o.sources, C, o.length, o.segment, stride);
  const input = new Float32Array(C * o.segment);
  o.onProgress?.(0, chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    if (o.shouldStop?.()) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    const { offset, length: n } = chunks[i];
    chunkInput(o.channels, o.length, offset, n, o.segment, input);
    const out = await o.runChunk(input);
    await o.onBlock?.(ola.add(out, n));
    o.onProgress?.(i + 1, chunks.length);
  }
  return { chunks: chunks.length, stride };
}

/** Planar float [C][n] of one source → interleaved Int16 [n][C] (rounded, clipped). */
export function interleaveInt16(planar: Float32Array, channels: number, n: number, offset = 0, out = new Int16Array(n * channels)): Int16Array {
  for (let c = 0; c < channels; c++) {
    const base = offset + c * n;
    for (let i = 0; i < n; i++) {
      let v = planar[base + i] * 32767;
      v = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
      out[i * channels + c] = Math.round(v);
    }
  }
  return out;
}
