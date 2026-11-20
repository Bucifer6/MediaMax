/**
 * Minimal PGS (.sup) encoder for tests and demo media: ffmpeg can decode PGS but not encode it.
 * Each event becomes an epoch-start display set (PCS, WDS, PDS, ODS…, END) plus a clearing display set at its end.
 */
export interface PgsEncodeEvent {
  startMs: number;
  endMs: number;
  /** Indexed bitmap (0 = transparent). */
  bitmap: { x: number; y: number; width: number; height: number; pixels: Uint8Array };
  /** Palette entries in RGBA (0–255). */
  palette: { index: number; r: number; g: number; b: number; a: number }[];
  forced?: boolean;
}

const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const be24 = (n: number) => [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

function segment(ptsMs: number, type: number, payload: number[] | Uint8Array): Uint8Array {
  const pts = Math.round(ptsMs * 90) >>> 0;
  const head = [0x50, 0x47, (pts >>> 24) & 0xff, (pts >>> 16) & 0xff, (pts >>> 8) & 0xff, pts & 0xff, 0, 0, 0, 0, type, ...be16(payload.length)];
  const out = new Uint8Array(head.length + payload.length);
  out.set(head, 0);
  out.set(payload, head.length);
  return out;
}

/** BT.709 limited-range RGB → Y'CbCr. */
function rgbToYcc(r: number, g: number, b: number): [number, number, number] {
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Cb = (b - Y) / 1.8556;
  const Cr = (r - Y) / 1.5748;
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return [c(16 + (219 / 255) * Y), c(128 + (224 / 255) * Cr), c(128 + (224 / 255) * Cb)];
}

/** RLE-encode an indexed bitmap per the PGS spec. */
export function encodeRle(px: Uint8Array, width: number, height: number): Uint8Array {
  const out: number[] = [];
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      const c = px[y * width + x];
      let n = 1;
      while (x + n < width && px[y * width + x + n] === c && n < 16383) n++;
      if (c !== 0 && n <= 2) {
        for (let i = 0; i < n; i++) out.push(c);
      } else if (c === 0) {
        if (n < 64) out.push(0, n);
        else out.push(0, 0x40 | (n >> 8), n & 0xff);
      } else if (n < 64) out.push(0, 0x80 | n, c);
      else out.push(0, 0xc0 | (n >> 8), n & 0xff, c);
      x += n;
    }
    out.push(0, 0);
  }
  return Uint8Array.from(out);
}

export function encodeSup(events: PgsEncodeEvent[], video = { width: 1920, height: 1080 }): Uint8Array {
  const parts: Uint8Array[] = [];
  let comp = 0;
  for (const e of events) {
    const bm = e.bitmap;
    // PCS: epoch start with one object.
    parts.push(segment(e.startMs, 0x16, [
      ...be16(video.width), ...be16(video.height), 0x10, ...be16(comp++), 0x80, 0x00, 0x00, 0x01,
      ...be16(0), 0x00, e.forced ? 0x40 : 0x00, ...be16(bm.x), ...be16(bm.y),
    ]));
    // WDS: one window = the bitmap.
    parts.push(segment(e.startMs, 0x17, [0x01, 0x00, ...be16(bm.x), ...be16(bm.y), ...be16(bm.width), ...be16(bm.height)]));
    // PDS
    const pds: number[] = [0x00, 0x00];
    for (const p of e.palette) {
      const [Y, Cr, Cb] = rgbToYcc(p.r, p.g, p.b);
      pds.push(p.index, Y, Cr, Cb, p.a);
    }
    parts.push(segment(e.startMs, 0x14, pds));
    // ODS (fragmented when large)
    const rle = encodeRle(bm.pixels, bm.width, bm.height);
    const firstMax = 0xffff - 11;
    const restMax = 0xffff - 4;
    let off = 0;
    let first = true;
    while (off < rle.length || first) {
      const max = first ? firstMax : restMax;
      const chunk = rle.subarray(off, off + max);
      const last = off + chunk.length >= rle.length;
      const seq = (first ? 0x80 : 0) | (last ? 0x40 : 0);
      const head = first ? [...be16(0), 0x00, seq, ...be24(rle.length + 4), ...be16(bm.width), ...be16(bm.height)] : [...be16(0), 0x00, seq];
      const payload = new Uint8Array(head.length + chunk.length);
      payload.set(head, 0);
      payload.set(chunk, head.length);
      parts.push(segment(e.startMs, 0x15, payload));
      off += chunk.length;
      first = false;
      if (last) break;
    }
    parts.push(segment(e.startMs, 0x80, []));
    // Clear at end: PCS without objects, WDS, END.
    parts.push(segment(e.endMs, 0x16, [...be16(video.width), ...be16(video.height), 0x10, ...be16(comp++), 0x00, 0x00, 0x00, 0x00]));
    parts.push(segment(e.endMs, 0x17, [0x01, 0x00, ...be16(bm.x), ...be16(bm.y), ...be16(bm.width), ...be16(bm.height)]));
    parts.push(segment(e.endMs, 0x80, []));
  }
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A test bitmap: a filled rounded box with a 2-px outline and a diagonal stripe, palette 1 = fill, 2 = outline, 3 = stripe. */
export function sampleBitmap(width: number, height: number): Uint8Array {
  const px = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const edge = x < 2 || y < 2 || x >= width - 2 || y >= height - 2;
      const stripe = Math.abs(((x - y) % 40 + 40) % 40) < 6;
      px[y * width + x] = edge ? 2 : stripe ? 3 : 1;
    }
  }
  return px;
}
