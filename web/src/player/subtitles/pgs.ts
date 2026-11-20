/**
 * PGS (Blu-ray "SUP", HDMV Presentation Graphic Stream) parser and decoder — no DOM, no dependencies.
 *
 * A .sup file is a sequence of segments: "PG" magic, PTS and DTS (90 kHz), type, size, payload.
 *   0x16 PCS presentation composition: video size, composition state, palette id, composition objects (+ crop)
 *   0x17 WDS window definition
 *   0x14 PDS palette: entries of (id, Y, Cr, Cb, alpha)
 *   0x15 ODS object: RLE-compressed 8-bit indexed bitmap, possibly split across several segments
 *   0x80 END of display set
 * A display set (PCS … END) replaces what is on screen at its PTS; one without composition objects clears it.
 * Objects and palettes persist within an epoch (until a PCS with state "epoch start").
 *
 * Parsing keeps only RLE data; bitmaps are decoded when shown (decodeEvent), so a feature-length track stays small.
 */

export const SEG = { PDS: 0x14, ODS: 0x15, PCS: 0x16, WDS: 0x17, END: 0x80 } as const;

export interface PgsPalette {
  id: number;
  /** 256 entries of packed RGBA (r | g << 8 | b << 16 | a << 24), i.e. little-endian Uint32 for ImageData. */
  rgba: Uint32Array;
}

export interface PgsObject {
  id: number;
  width: number;
  height: number;
  /** RLE data (complete once the last fragment arrived). */
  rle: Uint8Array;
}

export interface PgsComposition {
  objectId: number;
  windowId: number;
  x: number;
  y: number;
  crop?: { x: number; y: number; w: number; h: number };
  forced: boolean;
}

export interface PgsEvent {
  /** ms */
  start: number;
  /** ms (start of the next display set, or start + 5 s for the last one). */
  end: number;
  videoWidth: number;
  videoHeight: number;
  compositions: { comp: PgsComposition; object: PgsObject; palette: PgsPalette }[];
}

export interface PgsParseResult {
  events: PgsEvent[];
  /** Bytes consumed (a partial file stops at the last complete segment). */
  consumed: number;
}

interface Segment {
  pts: number;
  type: number;
  data: Uint8Array;
}

/** Split a .sup buffer into segments; stops at the first incomplete or corrupt one. */
export function readSegments(buf: Uint8Array): { segments: Segment[]; consumed: number } {
  const segments: Segment[] = [];
  let off = 0;
  while (off + 13 <= buf.length) {
    if (buf[off] !== 0x50 || buf[off + 1] !== 0x47) {
      // Resync to the next "PG" (damaged file).
      let n = off + 1;
      while (n + 1 < buf.length && !(buf[n] === 0x50 && buf[n + 1] === 0x47)) n++;
      if (n + 1 >= buf.length) break;
      off = n;
      continue;
    }
    const pts = ((buf[off + 2] << 24) >>> 0) + (buf[off + 3] << 16) + (buf[off + 4] << 8) + buf[off + 5];
    const type = buf[off + 10];
    const size = (buf[off + 11] << 8) | buf[off + 12];
    if (off + 13 + size > buf.length) break;
    segments.push({ pts, type, data: buf.subarray(off + 13, off + 13 + size) });
    off += 13 + size;
  }
  return { segments, consumed: off };
}

const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** Limited-range Y'CbCr → packed RGBA. BT.709 for HD streams, BT.601 for SD (DVD-era sizes). */
export function ycbcrToRgba(y: number, cr: number, cb: number, a: number, bt709: boolean): number {
  const Y = 1.164383 * (y - 16);
  const Cb = cb - 128;
  const Cr = cr - 128;
  let r: number, g: number, b: number;
  if (bt709) {
    r = Y + 1.792741 * Cr;
    g = Y - 0.213249 * Cb - 0.532909 * Cr;
    b = Y + 2.112402 * Cb;
  } else {
    r = Y + 1.596027 * Cr;
    g = Y - 0.391762 * Cb - 0.812968 * Cr;
    b = Y + 2.017232 * Cb;
  }
  return (clamp8(r) | (clamp8(g) << 8) | (clamp8(b) << 16) | (a << 24)) >>> 0;
}

/** Parse a whole (or partial) .sup buffer into display events. */
export function parsePgs(buf: Uint8Array): PgsParseResult {
  const { segments, consumed } = readSegments(buf);
  const events: PgsEvent[] = [];
  let palettes = new Map<number, PgsPalette>();
  let objects = new Map<number, PgsObject>();
  /** ODS fragments being assembled: id → chunks + expected length. */
  let partial = new Map<number, { width: number; height: number; len: number; chunks: Uint8Array[]; got: number }>();
  let pcs: { pts: number; w: number; h: number; paletteId: number; comps: PgsComposition[] } | null = null;
  let bt709 = true;

  for (const s of segments) {
    const d = s.data;
    switch (s.type) {
      case SEG.PCS: {
        if (d.length < 11) break;
        const w = (d[0] << 8) | d[1];
        const h = (d[2] << 8) | d[3];
        const state = d[7];
        bt709 = h > 576;
        if (state & 0x80) {
          // Epoch start: forget everything defined before.
          palettes = new Map();
          objects = new Map();
          partial = new Map();
        }
        const paletteId = d[9];
        const n = d[10];
        const comps: PgsComposition[] = [];
        let o = 11;
        for (let i = 0; i < n && o + 8 <= d.length; i++) {
          const objectId = (d[o] << 8) | d[o + 1];
          const windowId = d[o + 2];
          const flags = d[o + 3];
          const x = (d[o + 4] << 8) | d[o + 5];
          const y = (d[o + 6] << 8) | d[o + 7];
          o += 8;
          // Flags as in ffmpeg's pgssubdec: 0x80 = cropped (crop rectangle follows), 0x40 = forced.
          const c: PgsComposition = { objectId, windowId, x, y, forced: (flags & 0x40) !== 0 };
          if (flags & 0x80 && o + 8 <= d.length) {
            c.crop = { x: (d[o] << 8) | d[o + 1], y: (d[o + 2] << 8) | d[o + 3], w: (d[o + 4] << 8) | d[o + 5], h: (d[o + 6] << 8) | d[o + 7] };
            o += 8;
          }
          comps.push(c);
        }
        pcs = { pts: s.pts, w, h, paletteId, comps };
        break;
      }
      case SEG.PDS: {
        if (d.length < 2) break;
        const id = d[0];
        const pal = palettes.get(id) ?? { id, rgba: new Uint32Array(256) };
        // Palette updates replace entries; a fresh copy keeps earlier events intact.
        const next: PgsPalette = { id, rgba: new Uint32Array(pal.rgba) };
        for (let o = 2; o + 5 <= d.length; o += 5) next.rgba[d[o]] = ycbcrToRgba(d[o + 1], d[o + 2], d[o + 3], d[o + 4], bt709);
        palettes.set(id, next);
        break;
      }
      case SEG.ODS: {
        if (d.length < 4) break;
        const id = (d[0] << 8) | d[1];
        const seq = d[3];
        if (seq & 0x80) {
          if (d.length < 11) break;
          const len = (d[4] << 16) | (d[5] << 8) | d[6]; // includes the 4 bytes of width/height
          const width = (d[7] << 8) | d[8];
          const height = (d[9] << 8) | d[10];
          const chunk = d.subarray(11);
          partial.set(id, { width, height, len: Math.max(0, len - 4), chunks: [chunk], got: chunk.length });
        } else {
          const p = partial.get(id);
          if (p) {
            const chunk = d.subarray(4);
            p.chunks.push(chunk);
            p.got += chunk.length;
          }
        }
        const p = partial.get(id);
        if (p && (seq & 0x40 || p.got >= p.len)) {
          const rle = new Uint8Array(p.got);
          let o = 0;
          for (const c of p.chunks) {
            rle.set(c, o);
            o += c.length;
          }
          objects.set(id, { id, width: p.width, height: p.height, rle });
          partial.delete(id);
        }
        break;
      }
      case SEG.END: {
        if (!pcs) break;
        const start = pcs.pts / 90;
        const prev = events[events.length - 1];
        if (prev && prev.end > start) prev.end = start;
        const palette = palettes.get(pcs.paletteId) ?? { id: pcs.paletteId, rgba: new Uint32Array(256) };
        const comps = pcs.comps
          .map((comp) => ({ comp, object: objects.get(comp.objectId)!, palette }))
          .filter((c) => !!c.object);
        if (comps.length) events.push({ start, end: Infinity, videoWidth: pcs.w, videoHeight: pcs.h, compositions: comps });
        pcs = null;
        break;
      }
      default:
        break;
    }
  }
  for (const e of events) if (!Number.isFinite(e.end)) e.end = e.start + 5000;
  return { events, consumed };
}

/** Decode one object's RLE into palette indices (width × height). Tolerates short/long lines. */
export function decodeRle(rle: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  let i = 0;
  let x = 0;
  let y = 0;
  while (i < rle.length && y < height) {
    let color = 0;
    let count = 1;
    const b = rle[i++];
    if (b !== 0) {
      color = b;
    } else {
      const f = rle[i++] ?? 0;
      if (f === 0) {
        // End of line.
        x = 0;
        y++;
        continue;
      }
      const long = (f & 0x40) !== 0;
      count = long ? ((f & 0x3f) << 8) | (rle[i++] ?? 0) : f & 0x3f;
      color = f & 0x80 ? rle[i++] ?? 0 : 0;
    }
    const n = Math.min(count, width - x);
    if (n > 0 && color !== 0) out.fill(color, y * width + x, y * width + x + n);
    x += count;
  }
  return out;
}

export interface DecodedBitmap {
  x: number;
  y: number;
  width: number;
  height: number;
  /** RGBA pixels, ready for `new ImageData(rgba, width, height)`. */
  rgba: Uint8ClampedArray;
}

/** Decode the bitmaps of an event (crop applied). */
export function decodeEvent(e: PgsEvent): DecodedBitmap[] {
  return e.compositions.map(({ comp, object, palette }) => {
    const idx = decodeRle(object.rle, object.width, object.height);
    const cx = comp.crop ? comp.crop.x : 0;
    const cy = comp.crop ? comp.crop.y : 0;
    const w = comp.crop ? Math.min(comp.crop.w, object.width - cx) : object.width;
    const h = comp.crop ? Math.min(comp.crop.h, object.height - cy) : object.height;
    const px = new Uint32Array(Math.max(0, w * h));
    for (let yy = 0; yy < h; yy++) {
      const src = (yy + cy) * object.width + cx;
      for (let xx = 0; xx < w; xx++) px[yy * w + xx] = palette.rgba[idx[src + xx]];
    }
    // Uint32 packed as little-endian RGBA bytes.
    const bytes = new Uint8ClampedArray(px.buffer);
    if (!littleEndian) swapToLE(bytes);
    return { x: comp.x, y: comp.y, width: w, height: h, rgba: bytes };
  });
}

const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
function swapToLE(b: Uint8ClampedArray) {
  for (let i = 0; i < b.length; i += 4) {
    const r = b[i + 3], g = b[i + 2], bb = b[i + 1], a = b[i];
    b[i] = r; b[i + 1] = g; b[i + 2] = bb; b[i + 3] = a;
  }
}
