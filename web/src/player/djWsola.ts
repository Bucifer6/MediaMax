/**
 * WSOLA (waveform-similarity overlap-add) time-stretch / key lock for the DJ engine.
 *
 * Adapted from OpenDJ (MIT, github.com/Bucifer6/OpenDJ) — public/js/audio/worklets.js (DeckProcessor's granular
 * key lock: two sin²-windowed grains half a grain apart, each re-seeded near the play head at the offset whose
 * waveform best continues the other grain, read with 4-point Hermite interpolation).
 *
 * Two uses:
 *  - `stretch()` — offline: change tempo, keep pitch (OpenDJ's deck algorithm; used by tests and tools).
 *  - `KeyLockShifter` — streaming, for the AudioWorklet: the deck's <audio> plays at the matched tempo with
 *    preservesPitch off (so it is resampled: faster *and* higher), and the shifter moves the pitch back by
 *    1/rate while keeping the stream's timing. Net effect: tempo changed, key unchanged. It always runs with the
 *    same fixed latency (bypassed or not), so both decks stay in step.
 *
 * No DOM or Web Audio types here: the same code runs in the worklet scope and in Node tests.
 */

/** Grain length in frames (~43 ms at 48 kHz). */
export const GRAIN = 2048;
const SEARCH = 320;
const WIN = 192;
const STRIDE = 3;

/** 4-point Hermite interpolation of `buf` at fractional index x (0 outside [0, n)). */
function hermite(buf: Float32Array, x: number, n: number): number {
  const i = Math.floor(x);
  const f = x - i;
  if (i < 1 || i + 2 >= n) return i >= 0 && i < n ? buf[i] : 0;
  const y0 = buf[i - 1], y1 = buf[i], y2 = buf[i + 1], y3 = buf[i + 2];
  const c1 = 0.5 * (y2 - y0);
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
  return ((c3 * f + c2) * f + c1) * f + y1;
}

interface Grain {
  p: number;
  age: number;
}

/**
 * Offline time-stretch of a mono signal: output length ≈ input length / tempo, pitch unchanged.
 * tempo > 1 = faster/shorter.
 */
export function stretch(input: Float32Array, tempo: number, grain = GRAIN): Float32Array {
  const n = input.length;
  if (!(tempo > 0) || n === 0) return input.slice();
  const outLen = Math.floor(n / tempo);
  const out = new Float32Array(outLen);
  if (Math.abs(tempo - 1) < 1e-6) {
    out.set(input.subarray(0, outLen));
    return out;
  }
  const grains: Grain[] = [{ p: 0, age: 0 }, { p: 0, age: grain / 2 }];
  let pos = 0;
  const seed = (other: Grain) => {
    const target = pos;
    const ref = other.p;
    if (ref < 0 || ref + WIN >= n || target - SEARCH < 1 || target + SEARCH + WIN >= n) return target;
    let best = 0;
    let bestScore = -Infinity;
    for (let d = -SEARCH; d <= SEARCH; d += 4) {
      let c = 0;
      for (let k = 0; k < WIN; k += STRIDE) c += input[Math.floor(ref + k)] * input[Math.floor(target + d + k)];
      if (c > bestScore) {
        bestScore = c;
        best = d;
      }
    }
    return target + best;
  };
  for (let i = 0; i < outLen; i++) {
    let s = 0;
    for (const g of grains) {
      const w = Math.sin((Math.PI * g.age) / grain);
      s += hermite(input, g.p, n) * w * w;
      g.p += 1; // key lock: grains read at the original speed (original pitch)
      g.age++;
      if (g.age >= grain) {
        g.age = 0;
        g.p = seed(g === grains[0] ? grains[1] : grains[0]);
      }
    }
    out[i] = s;
    pos += tempo; // the play head moves at the tempo rate
  }
  return out;
}

/**
 * Streaming pitch shifter on a ring buffer (one per deck, inside the AudioWorklet).
 * pitch = factor applied to frequencies (1/playbackRate to undo the element's resampling).
 * Latency is fixed at `LATENCY` frames whether or not it is shifting.
 */
export class KeyLockShifter {
  static readonly LATENCY = 1024;
  private readonly cap: number;
  private readonly mask: number;
  private readonly ring: Float32Array[];
  /** Total frames written. */
  private w = 0;
  private grains: Grain[] = [{ p: 0, age: 0 }, { p: 0, age: GRAIN / 2 }];
  private shifting = false;
  pitch = 1;

  constructor(readonly channels = 2, capacity = 16384) {
    let c = 1;
    while (c < capacity) c <<= 1;
    this.cap = c;
    this.mask = c - 1;
    this.ring = Array.from({ length: channels }, () => new Float32Array(c));
  }

  private at(ch: number, x: number): number {
    // Hermite on the ring (absolute frame index x).
    const r = this.ring[ch];
    const i = Math.floor(x);
    const f = x - i;
    const m = this.mask;
    const y0 = r[(i - 1) & m], y1 = r[i & m], y2 = r[(i + 1) & m], y3 = r[(i + 2) & m];
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * f + c2) * f + c1) * f + y1;
  }

  /** WSOLA seed: start the new grain near the play head where it best continues `other` (channel-summed). */
  private seed(other: Grain, pos: number, speed: number): number {
    const ref = other.p;
    const oldest = this.w - this.cap + 8;
    const newest = this.w - 4;
    if (ref < oldest || ref + WIN * speed >= newest || pos - SEARCH < oldest || pos + SEARCH + WIN * speed >= newest) return pos;
    let best = 0;
    let bestScore = -Infinity;
    const m = this.mask;
    for (let d = -SEARCH; d <= SEARCH; d += 4) {
      let c = 0;
      for (let k = 0; k < WIN; k += STRIDE) {
        const a = Math.floor(ref + k * speed) & m;
        const b = Math.floor(pos + d + k * speed) & m;
        let sa = 0, sb = 0;
        for (let ch = 0; ch < this.channels; ch++) {
          sa += this.ring[ch][a];
          sb += this.ring[ch][b];
        }
        c += sa * sb;
      }
      if (c > bestScore) {
        bestScore = c;
        best = d;
      }
    }
    return pos + best;
  }

  /**
   * Process one block. `input[ch]` may be missing/short (silence); `output[ch]` is filled.
   * Channels beyond the input count repeat the last input channel.
   */
  process(input: ArrayLike<Float32Array | undefined>, output: Float32Array[]): void {
    const frames = output[0]?.length ?? 0;
    const m = this.mask;
    const L = KeyLockShifter.LATENCY;
    const speed = Math.max(0.5, Math.min(2, this.pitch || 1));
    const shift = Math.abs(speed - 1) > 0.002;
    for (let n = 0; n < frames; n++) {
      // Write.
      const wi = this.w & m;
      for (let ch = 0; ch < this.channels; ch++) {
        const src = input[Math.min(ch, input.length - 1)] ?? input[0];
        this.ring[ch][wi] = src && n < src.length ? src[n] : 0;
      }
      const pos = this.w - L;
      this.w++;
      if (!shift) {
        if (this.shifting) {
          this.shifting = false;
        }
        for (let ch = 0; ch < output.length; ch++) output[ch][n] = this.ring[Math.min(ch, this.channels - 1)][pos & m];
        this.grains[0].p = this.grains[1].p = pos;
        continue;
      }
      if (!this.shifting) {
        this.shifting = true;
        this.grains[0].p = pos;
        this.grains[0].age = 0;
        this.grains[1].p = pos;
        this.grains[1].age = GRAIN / 2;
      }
      for (let ch = 0; ch < output.length; ch++) output[ch][n] = 0;
      for (const g of this.grains) {
        const wv = Math.sin((Math.PI * g.age) / GRAIN);
        const ww = wv * wv;
        for (let ch = 0; ch < output.length; ch++) output[ch][n] += this.at(Math.min(ch, this.channels - 1), g.p) * ww;
        g.p += speed;
        g.age++;
        if (g.age >= GRAIN) {
          g.age = 0;
          g.p = this.seed(g === this.grains[0] ? this.grains[1] : this.grains[0], pos, speed);
        }
      }
    }
  }
}

/** Resample by `rate` (linear) — what an <audio> element with preservesPitch = false does. For tests. */
export function resample(input: Float32Array, rate: number): Float32Array {
  const out = new Float32Array(Math.floor(input.length / rate));
  for (let i = 0; i < out.length; i++) {
    const x = i * rate;
    const k = Math.floor(x);
    const f = x - k;
    out[i] = (input[k] ?? 0) * (1 - f) + (input[k + 1] ?? 0) * f;
  }
  return out;
}
