/**
 * Real Dolby Vision over HLS: what the remux writes and how the master playlist announces it.
 *
 * When a Dolby Vision source is remuxed (video copied) for a client that plays that DV profile, the fMP4 init
 * segment keeps the DV configuration box (`dvcC` for profiles ≤ 7, `dvvC` for 8–10) and the HLS master playlist
 * carries the DV codec string. Without this the stream is plain `hvc1`, and the client shows only the HDR10/HLG base
 * layer (profile 8) or a green/purple picture (profile 5).
 *
 * Signalling, following Dolby's "Dolby Vision streams within the ISO base media file format" and Apple's HLS
 * authoring spec:
 *
 * | Profile | Sample entry | CODECS                          | SUPPLEMENTAL-CODECS | VIDEO-RANGE |
 * |---------|--------------|---------------------------------|---------------------|-------------|
 * | 5       | `dvh1`       | `dvh1.05.LL`                    |                     | PQ          |
 * | 7       | `dvh1`       | `dvh1.07.LL`                    |                     | PQ          |
 * | 8.1     | `hvc1`+dvvC  | `hvc1.2.4.L153.B0`              | `dvh1.08.LL/db1p`   | PQ          |
 * | 8.4     | `hvc1`+dvvC  | `hvc1…`                         | `dvh1.08.LL/db4h`   | HLG         |
 * | 8.2     | `hvc1`+dvvC  | `hvc1…`                         | `dvh1.08.LL/db2g`   | SDR         |
 * | 10.x    | `av01`+dvvC  | `av01.0.LLM.10`                 | `dav1.10.LL[/db1p]` | PQ / HLG    |
 *
 * Profiles with a compatible base layer (8.x, 10.1/10.4) keep the standard `hvc1`/`av01` sample entry plus the DV
 * box: a decoder without Dolby Vision plays the base layer, one with Dolby Vision finds the `dvvC` box. hls.js
 * (1.6+) reads that box and opens its SourceBuffer as `dvh1.08.LL` when `MediaSource.isTypeSupported` says yes.
 * Media3 (ExoPlayer) maps the HLS CODECS string straight to a decoder MIME type, so for ExoPlayer clients the DV
 * codec goes into CODECS itself (`dvh1.08.06`) instead of SUPPLEMENTAL-CODECS.
 *
 * FFmpeg writes the DV box only with `-strict unofficial` (FFmpeg 6.x; newer builds also accept it). Whether this
 * build does is checked once at runtime (doviMuxSupported) by remuxing a tiny embedded HEVC file with an injected
 * `dvvC` box through the same HLS/fMP4 muxer and looking for the box in the output.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { DolbyVisionInfo } from '@mediamax/shared';
import { config } from '../config.js';
import { logger } from '../util/log.js';

const log = logger('dovi');

/* ------------------------------ codec strings ------------------------------ */

export type HlsVideoRange = 'PQ' | 'HLG' | 'SDR';
/** How the DV codec is announced: Apple-style SUPPLEMENTAL-CODECS (default), or the DV codec in CODECS (Media3). */
export type DoviCodecStyle = 'supplemental' | 'codecs';

export interface DoviSignal {
  /** DV profile as shown to people: "5", "7", "8.1", "8.4", "10.1" … */
  profile: string;
  level: number;
  /** Sample entry FFmpeg is told to write (`-tag:v`); `av01` needs no tag. */
  sampleEntry: 'dvh1' | 'hvc1' | 'av01';
  /** The Dolby Vision codec string, e.g. `dvh1.08.06`, `dvh1.05.06`, `dav1.10.06`. */
  dvCodec: string;
  /** Base-layer codec for CODECS when the DV codec goes in SUPPLEMENTAL-CODECS (null for profiles 5/7: no usable base layer). */
  baseCodec: string | null;
  /** Dolby brand for SUPPLEMENTAL-CODECS: db1p (HDR10 base), db4h (HLG base), db2g (SDR base). */
  brand: 'db1p' | 'db4h' | 'db2g' | null;
  videoRange: HlsVideoRange;
}

const two = (n: number) => String(Math.max(0, Math.min(99, Math.round(n)))).padStart(2, '0');

/**
 * Level used when the configuration record has none: 06 = 3840×2160 @ 24 fps, 05 = 1920×1080 @ 60 fps
 * (Dolby Vision levels 1–13, by pixel rate).
 */
export function defaultDoviLevel(height: number | null | undefined, fps?: number | null): number {
  const h = height ?? 2160;
  if (h <= 1080) return (fps ?? 24) > 30 ? 5 : 4;
  return (fps ?? 24) > 30 ? 9 : 6;
}

/** HEVC base-layer codec string (Main 10, high tier off) when the init segment can't be read. */
export function fallbackHevcCodec(height: number | null | undefined): string {
  return (height ?? 2160) > 1080 ? 'hvc1.2.4.L153.B0' : 'hvc1.2.4.L123.B0';
}
export function fallbackAv1Codec(height: number | null | undefined): string {
  return (height ?? 2160) > 1080 ? 'av01.0.13M.10' : 'av01.0.09M.10';
}

/**
 * Dolby Vision signalling for a copied (remuxed) stream, or null when the profile can't be carried natively
 * (profile 4/9, or a sample-entry-only DV stream whose profile is unknown).
 */
export function doviSignal(dv: DolbyVisionInfo, opts: { videoCodec?: string | null; height?: number | null; frameRate?: number | null; transfer?: string | null } = {}): DoviSignal | null {
  const level = dv.level && dv.level > 0 ? dv.level : defaultDoviLevel(opts.height, opts.frameRate);
  const ll = two(level);
  const codec = (opts.videoCodec ?? '').toLowerCase();
  const compat = dv.blCompatId;
  const baseRange = (): { brand: DoviSignal['brand']; videoRange: HlsVideoRange } => {
    if (compat === 4 || (compat == null && opts.transfer === 'arib-std-b67')) return { brand: 'db4h', videoRange: 'HLG' };
    if (compat === 2) return { brand: 'db2g', videoRange: 'SDR' };
    return { brand: 'db1p', videoRange: 'PQ' };
  };
  switch (dv.profile) {
    case 5:
      return { profile: '5', level, sampleEntry: 'dvh1', dvCodec: `dvh1.05.${ll}`, baseCodec: null, brand: null, videoRange: 'PQ' };
    case 7:
      return { profile: '7', level, sampleEntry: 'dvh1', dvCodec: `dvh1.07.${ll}`, baseCodec: null, brand: null, videoRange: 'PQ' };
    case 8: {
      if (codec && codec !== 'hevc' && codec !== 'h265') return null;
      const b = baseRange();
      const sub = compat === 1 || compat === 2 || compat === 4 ? `.${compat}` : '';
      return { profile: `8${sub}`, level, sampleEntry: 'hvc1', dvCodec: `dvh1.08.${ll}`, baseCodec: fallbackHevcCodec(opts.height), ...b };
    }
    case 10: {
      if (codec && codec !== 'av1') return null;
      if (compat === 0) {
        // 10.0: no compatible base layer (like profile 5, but AV1). FFmpeg can only write an av01 sample entry.
        return { profile: '10', level, sampleEntry: 'av01', dvCodec: `dav1.10.${ll}`, baseCodec: null, brand: null, videoRange: 'PQ' };
      }
      const b = baseRange();
      const sub = compat === 1 || compat === 2 || compat === 4 ? `.${compat}` : '';
      return { profile: `10${sub}`, level, sampleEntry: 'av01', dvCodec: `dav1.10.${ll}`, baseCodec: fallbackAv1Codec(opts.height), ...b };
    }
  }
  return null;
}

/**
 * The CODECS / SUPPLEMENTAL-CODECS pair for a DV variant. `video` overrides the base-layer codec (the exact string
 * read from the init segment); `audio` is the audio codec string (omitted when unknown).
 */
export function doviCodecsAttrs(s: DoviSignal, style: DoviCodecStyle, video?: string | null, audio?: string | null): { codecs: string; supplemental: string | null } {
  // Profiles without a compatible base layer (5, 7, 10.0) never announce the base codec, whatever the init segment says.
  const base = !s.baseCodec ? null : video && !/^dv|^dav1/.test(video) ? video : s.baseCodec;
  const join = (v: string) => (audio ? `${v},${audio}` : v);
  if (style === 'codecs' || !base) return { codecs: join(s.dvCodec), supplemental: null };
  return { codecs: join(base), supplemental: s.brand ? `${s.dvCodec}/${s.brand}` : s.dvCodec };
}

/** Codec announcement style for a client: Media3 needs the DV codec in CODECS; Apple and hls.js use SUPPLEMENTAL-CODECS. */
export const doviCodecStyle = (player: string | null | undefined): DoviCodecStyle => (player === 'exoplayer' ? 'codecs' : 'supplemental');

/** What a Dolby Vision remux job needs: the signalling plus what the master playlist reports. */
export interface DoviRemux extends DoviSignal {
  style: DoviCodecStyle;
  bandwidthKbps: number | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
}

/* ------------------------------ master playlist ------------------------------ */

export interface DoviMasterOptions {
  uri: string;
  bandwidth: number;
  codecs: string;
  supplemental: string | null;
  videoRange: HlsVideoRange;
  width?: number | null;
  height?: number | null;
  frameRate?: number | null;
}

/** Single-variant master playlist for a Dolby Vision remux. */
export function doviMasterPlaylist(o: DoviMasterOptions): string {
  const attrs = [`BANDWIDTH=${Math.round(o.bandwidth)}`, `AVERAGE-BANDWIDTH=${Math.round(o.bandwidth * 0.85)}`, `CODECS="${o.codecs}"`];
  if (o.supplemental) attrs.push(`SUPPLEMENTAL-CODECS="${o.supplemental}"`);
  if (o.width && o.height) attrs.push(`RESOLUTION=${o.width}x${o.height}`);
  if (o.frameRate) attrs.push(`FRAME-RATE=${o.frameRate.toFixed(3)}`);
  attrs.push(`VIDEO-RANGE=${o.videoRange}`);
  return ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS', `#EXT-X-STREAM-INF:${attrs.join(',')}`, o.uri].join('\n') + '\n';
}

/**
 * Master playlist for a Dolby Vision remux job. Codec strings come from the init segment FFmpeg actually wrote
 * (exact HEVC/AV1 profile and level, the real audio codec), falling back to the probed values. If the init segment
 * has no DV configuration box after all, the DV codec is left out so the client plays the base layer instead of
 * expecting Dolby Vision it won't get.
 */
export async function doviMasterForJob(dv: DoviRemux, initSegment: () => Promise<string>, uri: string): Promise<string> {
  let init: InitInfo | null = null;
  try {
    init = parseInit(fs.readFileSync(await initSegment()));
  } catch (e) {
    log.debug(`Dolby Vision master: init segment unreadable (${(e as Error).message})`);
  }
  const audio = init?.audio?.codec ?? null;
  const video = init?.video?.codec ?? null;
  const kbps = dv.bandwidthKbps && dv.bandwidthKbps > 0 ? dv.bandwidthKbps : 25000;
  const common = { uri, bandwidth: kbps * 1000 * 1.1, width: dv.width, height: dv.height, frameRate: dv.frameRate };
  if (init?.video && !init.video.dovi) {
    log.warn('Dolby Vision remux: FFmpeg wrote no DV configuration box; announcing the base layer only');
    const codecs = [video ?? dv.baseCodec, audio].filter(Boolean).join(',');
    return doviMasterPlaylist({ ...common, codecs, supplemental: null, videoRange: dv.videoRange });
  }
  const { codecs, supplemental } = doviCodecsAttrs(dv, dv.style, video, audio);
  return doviMasterPlaylist({ ...common, codecs, supplemental, videoRange: dv.videoRange });
}

/* ------------------------------ MP4 boxes ------------------------------ */

export interface Box { type: string; start: number; size: number; header: number; children?: Box[] }

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'edts', 'dinf', 'moof', 'traf']);
/** Bytes between a box header and its first child, for boxes that hold children after fixed fields. */
const SKIP: Record<string, number> = { stsd: 8 };
const VISUAL = new Set(['hvc1', 'hev1', 'dvh1', 'dvhe', 'avc1', 'avc3', 'dva1', 'dvav', 'av01', 'dav1', 'vp09', 'encv']);
const AUDIO = new Set(['mp4a', 'ac-3', 'ec-3', 'ac-4', 'fLaC', 'Opus', 'mlpa', 'alac', 'dtsc', 'dtsh', 'dtsl', 'dtse', 'dtsx', 'enca']);

/** Walk the boxes of an MP4 buffer (recursing into containers and sample entries). */
export function walkBoxes(b: Uint8Array, start = 0, end = b.length): Box[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    let header = 8;
    if (size === 1 && p + 16 <= end) {
      size = Number(dv.getBigUint64(p + 8));
      header = 16;
    } else if (size === 0) size = end - p;
    if (size < header || p + size > end) break;
    const box: Box = { type, start: p, size, header };
    const childStart = CONTAINERS.has(type) ? p + header : type in SKIP ? p + header + SKIP[type] : VISUAL.has(type) ? p + header + 78 : AUDIO.has(type) ? p + header + 28 : -1;
    if (childStart >= 0 && childStart <= p + size) box.children = walkBoxes(b, childStart, p + size);
    out.push(box);
    p += size;
  }
  return out;
}

/** First box found by a path of types, e.g. ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']. */
export function findBox(boxes: Box[], pathTypes: string[]): Box | null {
  let level: Box[] | undefined = boxes;
  let found: Box | null = null;
  for (const t of pathTypes) {
    found = level?.find((x) => x.type === t) ?? null;
    if (!found) return null;
    level = found.children;
  }
  return found;
}

export interface DoviBox { box: 'dvcC' | 'dvvC' | 'dvwC'; profile: number; level: number; rpu: boolean; el: boolean; bl: boolean; blCompatId: number }

export function parseDoviBox(b: Uint8Array, box: Box): DoviBox {
  const p = box.start + box.header;
  const v = (b[p + 2] << 8) | b[p + 3];
  return {
    box: box.type as DoviBox['box'],
    profile: (v >> 9) & 0x7f,
    level: (v >> 3) & 0x3f,
    rpu: !!(v & 4),
    el: !!(v & 2),
    bl: !!(v & 1),
    blCompatId: b[p + 4] >> 4,
  };
}

/** RFC 6381 string from an hvcC box (ISO/IEC 14496-15 Annex E), e.g. `hvc1.2.4.L153.B0`. */
function hevcCodec(entry: string, b: Uint8Array, box: Box): string {
  const p = box.start + box.header;
  const profileByte = b[p + 1];
  const space = ['', 'A', 'B', 'C'][profileByte >> 6];
  const idc = profileByte & 0x1f;
  const compat = ((b[p + 2] << 24) | (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5]) >>> 0;
  let rev = 0;
  for (let i = 0; i < 32; i++) rev = (rev | (((compat >>> i) & 1) << (31 - i))) >>> 0;
  const tier = profileByte & 0x20 ? 'H' : 'L';
  const level = b[p + 12];
  const cons = Array.from(b.subarray(p + 6, p + 12));
  while (cons.length && cons[cons.length - 1] === 0) cons.pop();
  return `${entry}.${space}${idc}.${rev.toString(16).toUpperCase()}.${tier}${level}${cons.map((x) => '.' + x.toString(16).toUpperCase()).join('')}`;
}

/** `av01.P.LLT.DD` from an av1C box. */
function av1Codec(b: Uint8Array, box: Box): string {
  const p = box.start + box.header;
  const profile = b[p + 1] >> 5;
  const level = b[p + 1] & 0x1f;
  const tier = b[p + 2] & 0x80 ? 'H' : 'M';
  const depth = b[p + 2] & 0x40 ? (profile === 2 && b[p + 2] & 0x20 ? 12 : 10) : 8;
  return `av01.${profile}.${two(level)}${tier}.${two(depth)}`;
}

/** Read an MPEG-4 descriptor length (1–4 bytes, 7 bits each). */
function descLen(b: Uint8Array, i: number): [number, number] {
  let len = 0;
  for (let n = 0; n < 4; n++) {
    const x = b[i++];
    len = (len << 7) | (x & 0x7f);
    if (!(x & 0x80)) break;
  }
  return [len, i];
}

function mp4aCodec(b: Uint8Array, entry: Box): string {
  const esds = entry.children?.find((c) => c.type === 'esds');
  if (!esds) return 'mp4a.40.2';
  const end = esds.start + esds.size;
  let i = esds.start + esds.header + 4; // full box
  let oti = 0x40;
  while (i < end) {
    const tag = b[i];
    const [len, body] = descLen(b, i + 1);
    if (tag === 0x03) { i = body + 3; continue; } // ES_Descriptor: ES_ID + flags (no optional fields from FFmpeg)
    if (tag === 0x04) { oti = b[body]; i = body + 13; continue; } // DecoderConfigDescriptor
    if (tag === 0x05) {
      if (oti !== 0x40) break;
      let aot = b[body] >> 3;
      if (aot === 31) aot = 32 + (((b[body] & 7) << 3) | (b[body + 1] >> 5));
      return `mp4a.40.${aot}`;
    }
    i = body + len;
  }
  if (oti === 0x6b || oti === 0x69) return 'mp4a.40.34';
  return `mp4a.${oti.toString(16).toUpperCase()}`;
}

export interface InitInfo {
  video: { entry: string; codec: string; dovi: DoviBox | null; width: number; height: number } | null;
  audio: { entry: string; codec: string } | null;
}

/** What an fMP4 init segment (or a whole MP4) contains: sample entries, RFC 6381 codec strings, DV config box. */
export function parseInit(b: Uint8Array): InitInfo {
  const boxes = walkBoxes(b);
  const moov = boxes.find((x) => x.type === 'moov');
  const info: InitInfo = { video: null, audio: null };
  for (const trak of moov?.children?.filter((x) => x.type === 'trak') ?? []) {
    const stsd = findBox([trak], ['trak', 'mdia', 'minf', 'stbl', 'stsd']);
    const entry = stsd?.children?.[0];
    if (!entry) continue;
    if (VISUAL.has(entry.type) && !info.video) {
      const kid = (t: string) => entry.children?.find((c) => c.type === t);
      const dvBox = kid('dvvC') ?? kid('dvcC') ?? kid('dvwC');
      const hvcC = kid('hvcC');
      const av1C = kid('av1C');
      const avcC = kid('avcC');
      let codec = entry.type;
      if (hvcC) codec = hevcCodec(/^dv/.test(entry.type) ? 'hvc1' : entry.type, b, hvcC);
      else if (av1C) codec = av1Codec(b, av1C);
      else if (avcC) codec = `avc1.${Array.from(b.subarray(avcC.start + avcC.header + 1, avcC.start + avcC.header + 4)).map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      info.video = {
        entry: entry.type, codec, dovi: dvBox ? parseDoviBox(b, dvBox) : null,
        width: dv.getUint16(entry.start + entry.header + 24), height: dv.getUint16(entry.start + entry.header + 26),
      };
    } else if (AUDIO.has(entry.type) && !info.audio) {
      const codec = entry.type === 'mp4a' ? mp4aCodec(b, entry) : entry.type;
      info.audio = { entry: entry.type, codec };
    }
  }
  return info;
}

/**
 * Add a Dolby Vision configuration box to the first video sample entry of an MP4 whose `moov` follows `mdat`
 * (FFmpeg's default layout, so chunk offsets stay valid). Used by the runtime check and the tests: FFmpeg can't
 * encode Dolby Vision, but this gives its demuxer a stream with DOVI configuration side data.
 */
export function injectDoviConfig(mp4: Uint8Array, cfg: { profile: number; level: number; blCompatId: number; rpu?: boolean; el?: boolean; bl?: boolean }): Buffer {
  const b = Buffer.from(mp4);
  const boxes = walkBoxes(b);
  const chain: Box[] = [];
  const visit = (list: Box[] | undefined): boolean => {
    for (const x of list ?? []) {
      chain.push(x);
      if (VISUAL.has(x.type)) return true;
      if (visit(x.children)) return true;
      chain.pop();
    }
    return false;
  };
  if (!visit(boxes)) throw new Error('No video sample entry');
  const entry = chain[chain.length - 1];
  const mdat = boxes.find((x) => x.type === 'mdat');
  if (mdat && mdat.start > entry.start) throw new Error('moov must follow mdat');
  const box = Buffer.alloc(32);
  box.writeUInt32BE(32, 0);
  box.write(cfg.profile > 7 ? 'dvvC' : 'dvcC', 4, 'latin1');
  box[8] = 1; // dv_version_major
  box[9] = 0;
  box.writeUInt16BE(((cfg.profile & 0x7f) << 9) | ((cfg.level & 0x3f) << 3) | ((cfg.rpu ?? true) ? 4 : 0) | (cfg.el ? 2 : 0) | ((cfg.bl ?? true) ? 1 : 0), 10);
  box[12] = (cfg.blCompatId & 0xf) << 4;
  const at = entry.start + entry.size;
  const out = Buffer.concat([b.subarray(0, at), box, b.subarray(at)]);
  for (const x of chain) {
    if (x.header !== 8) throw new Error('64-bit box sizes are not supported');
    out.writeUInt32BE(out.readUInt32BE(x.start) + 32, x.start);
  }
  return out;
}

/* ------------------------------ ffmpeg capability ------------------------------ */

/**
 * One frame of 64×64 10-bit HEVC (libx265, BT.2020/PQ) in MP4 with `moov` after `mdat`: input for the runtime check,
 * so it works without an HEVC encoder in the FFmpeg build.
 */
const TINY_HEVC_MP4 =
  'AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAAAhmcmVlAAAAFW1kYXQAAAAJKAGsdg2QkdI4AAADUm1vb3YAAABsbXZoZAAAAAAAAAAAAA' +
  'AAAAAAA+gAAAAqAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAIAAAKhdHJhawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAQAAAAAAAAAqAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQ' +
  'AAAAAAAAAAAAAAAAAAQAAAAABAAAAAQAAAAAAAJGVkdHMAAAAcZWxzdAAAAAAAAAABAAAAKgAAAAAAAQAAAAACGW1kaWEAAAAgbWRoZAAAAAAA' +
  'AAAAAAAAAAAAMAAAAAIAVcQAAAAAAC1oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAAAcRtaW5mAAAAFHZtaGQAAA' +
  'ABAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAGEc3RibAAAASBzdHNkAAAAAAAAAAEAAAEQaHZjMQAAAAAA' +
  'AAABAAAAAAAAAAAAAAAAAAAAAABAAEAASAAAAEgAAAAAAAAAAQxMYXZjIGxpYngyNjUAAAAAAAAAAAAAAAAAAAAAAAAAABj//wAAAHlodmNDAQ' +
  'IgAAAAkAAAAAAAHvAA/P36+gAADwOgAAEAGEABDAH//wIgAAADAJAAAAMAAAMAHpWUCaEAAQAtQgEBAiAAAAMAkAAAAwAAAwAeoCCBBNllZUpM' +
  'LwFqEiASCAAAAwAIAAADAMBAogABAAZEAcBzwIkAAAAKZmllbAEAAAAAE2NvbHJuY2x4AAkAEAAJAAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydA' +
  'AAAAAAAAnAAAAJwAAAABhzdHRzAAAAAAAAAAEAAAABAAACAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAAANAAAA' +
  'AQAAABRzdGNvAAAAAAAAAAEAAAAsAAAAPXVkdGEAAAA1bWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAIaWxzdA' +
  '==';

let doviMux: boolean | null = null;
let doviMuxPending: Promise<boolean> | null = null;

/** Cached result of the runtime check (null = not checked yet). */
export const doviMuxCapability = () => doviMux;
/** For tests. */
export const setDoviMuxCapability = (v: boolean | null) => {
  doviMux = v;
  doviMuxPending = null;
};

/** The FFmpeg arguments that keep Dolby Vision signalling when copying video into fMP4 (see transcoder.ts). */
export function doviMuxArgs(sampleEntry: DoviSignal['sampleEntry']): string[] {
  const a = ['-strict', 'unofficial'];
  if (sampleEntry !== 'av01') a.push('-tag:v', sampleEntry);
  return a;
}

/**
 * Does this FFmpeg keep the Dolby Vision configuration box when remuxing to HLS fMP4? Runs once (about 100 ms) and
 * caches the answer. False when FFmpeg is missing or too old.
 */
export function doviMuxSupported(ffmpeg = config.ffmpeg): Promise<boolean> {
  if (doviMux != null) return Promise.resolve(doviMux);
  doviMuxPending ??= (async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-dovi-'));
    try {
      const input = path.join(dir, 'in.mp4');
      fs.writeFileSync(input, injectDoviConfig(Buffer.from(TINY_HEVC_MP4, 'base64'), { profile: 8, level: 6, blCompatId: 1 }));
      const ok = await new Promise<boolean>((resolve) => {
        const p = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input, '-map', '0:v:0', '-c:v', 'copy', ...doviMuxArgs('dvh1'),
          '-f', 'hls', '-hls_time', '1', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
          '-hls_segment_filename', path.join(dir, 'seg%d.m4s'), '-hls_list_size', '0', path.join(dir, 'out.m3u8')], { stdio: 'ignore' });
        const t = setTimeout(() => p.kill('SIGKILL'), 15000);
        p.on('error', () => { clearTimeout(t); resolve(false); });
        p.on('exit', (code) => { clearTimeout(t); resolve(code === 0); });
      });
      const init = path.join(dir, 'init.mp4');
      const v = ok && fs.existsSync(init) ? parseInit(fs.readFileSync(init)).video : null;
      doviMux = !!v?.dovi && v.dovi.profile === 8 && v.entry === 'dvh1';
    } catch (e) {
      log.debug(`Dolby Vision mux check failed: ${(e as Error).message}`);
      doviMux = false;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    log.info(doviMux ? 'FFmpeg keeps Dolby Vision configuration when remuxing (real Dolby Vision over HLS enabled)' : 'FFmpeg does not write Dolby Vision configuration boxes; Dolby Vision is delivered as its base layer');
    return doviMux;
  })();
  return doviMuxPending;
}
