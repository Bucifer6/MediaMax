/**
 * Minimal ID3v2 (2.2 / 2.3 / 2.4) reader for lyrics frames: SYLT (synchronised lyrics) and USLT (unsynchronised).
 * FFmpeg exposes USLT as a `lyrics-<lang>` tag but drops SYLT, so synced lyrics embedded by taggers (MusicBee,
 * Mp3tag, foobar2000 …) are read straight from the tag at the head of the file. Reads are bounded (the tag only,
 * at most MAX_TAG bytes); compressed or encrypted frames are skipped.
 *
 * SYLT → lines logic adapted from OpenDJ (MIT, github.com/Bucifer6/OpenDJ) — server/lyrics.js syltToLines().
 */
import fs from 'node:fs';
import type { LrcLine } from './lrc.js';

const MAX_TAG = 16 * 1024 * 1024;

export interface SyltEntry {
  text: string;
  /** Raw timestamp (ms or MPEG frames, see `format`). */
  timestamp: number;
}
export interface SyltFrame {
  language: string;
  /** 1 = MPEG frames, 2 = milliseconds. */
  format: number;
  contentType: number;
  descriptor: string;
  entries: SyltEntry[];
}
export interface UsltFrame {
  language: string;
  descriptor: string;
  text: string;
}
export interface Id3Lyrics {
  sylt: SyltFrame[];
  uslt: UsltFrame[];
}

const syncsafe = (b: Buffer, o: number) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);

/** Undo ID3 unsynchronisation (0xFF 0x00 → 0xFF). */
function unsync(b: Buffer): Buffer {
  const out = Buffer.alloc(b.length);
  let j = 0;
  for (let i = 0; i < b.length; i++) {
    out[j++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0x00) i++;
  }
  return out.subarray(0, j);
}

/** Decode a string of ID3 text encoding `enc` (0 Latin-1, 1 UTF-16 + BOM, 2 UTF-16BE, 3 UTF-8). */
export function decodeId3Text(b: Buffer, enc: number): string {
  if (enc === 0) return b.toString('latin1');
  if (enc === 3) return b.toString('utf8');
  let le = enc === 1;
  let s = b;
  if (s.length >= 2 && s[0] === 0xff && s[1] === 0xfe) { le = true; s = s.subarray(2); }
  else if (s.length >= 2 && s[0] === 0xfe && s[1] === 0xff) { le = false; s = s.subarray(2); }
  if (le) return s.subarray(0, s.length & ~1).toString('utf16le');
  const sw = Buffer.from(s.subarray(0, s.length & ~1));
  sw.swap16();
  return sw.toString('utf16le');
}

/** Read a terminated string from `b` at `o`; returns [text, next offset]. */
function readTerminated(b: Buffer, o: number, enc: number): [string, number] {
  const wide = enc === 1 || enc === 2;
  if (!wide) {
    let e = b.indexOf(0, o);
    if (e < 0) e = b.length;
    return [decodeId3Text(b.subarray(o, e), enc), e + 1];
  }
  let e = o;
  while (e + 1 < b.length && !(b[e] === 0 && b[e + 1] === 0)) e += 2;
  if (e + 1 >= b.length) e = b.length;
  return [decodeId3Text(b.subarray(o, e), enc), e + 2];
}

export function parseSylt(body: Buffer): SyltFrame | null {
  if (body.length < 6) return null;
  const enc = body[0];
  const language = body.subarray(1, 4).toString('latin1');
  const format = body[4];
  const contentType = body[5];
  let [descriptor, o] = readTerminated(body, 6, enc);
  const entries: SyltEntry[] = [];
  while (o < body.length) {
    const [text, n] = readTerminated(body, o, enc);
    if (n + 4 > body.length) break;
    entries.push({ text, timestamp: body.readUInt32BE(n) });
    o = n + 4;
  }
  return { language, format, contentType, descriptor, entries };
}

export function parseUslt(body: Buffer): UsltFrame | null {
  if (body.length < 4) return null;
  const enc = body[0];
  const language = body.subarray(1, 4).toString('latin1');
  const [descriptor, o] = readTerminated(body, 4, enc);
  return { language, descriptor, text: decodeId3Text(body.subarray(Math.min(o, body.length)), enc).replace(/\0+$/, '') };
}

/** Parse the lyrics frames of an ID3v2 tag held in `buf` (which starts with "ID3"). */
export function parseId3Lyrics(buf: Buffer): Id3Lyrics {
  const out: Id3Lyrics = { sylt: [], uslt: [] };
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return out;
  const ver = buf[3];
  const flags = buf[5];
  const size = syncsafe(buf, 6);
  if (ver < 2 || ver > 4) return out;
  let tag = buf.subarray(10, Math.min(buf.length, 10 + size));
  if (flags & 0x80 && ver < 4) tag = unsync(tag); // whole-tag unsynchronisation (v2.2/2.3)
  let o = 0;
  if (flags & 0x40 && ver >= 3) {
    // extended header
    const ext = ver === 4 ? syncsafe(tag, 0) : tag.readUInt32BE(0) + 4;
    o = ext;
  }
  const idLen = ver === 2 ? 3 : 4;
  const hdrLen = ver === 2 ? 6 : 10;
  while (o + hdrLen <= tag.length) {
    const id = tag.toString('latin1', o, o + idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break; // padding
    const fsize = ver === 2 ? tag.readUIntBE(o + 3, 3) : ver === 4 ? syncsafe(tag, o + 4) : tag.readUInt32BE(o + 4);
    const fflags = ver === 2 ? 0 : tag.readUInt16BE(o + 8);
    const start = o + hdrLen;
    const end = start + fsize;
    if (fsize <= 0 || end > tag.length) break;
    o = end;
    const isSylt = id === 'SYLT' || id === 'SLT';
    const isUslt = id === 'USLT' || id === 'ULT';
    if (!isSylt && !isUslt) continue;
    let body = tag.subarray(start, end);
    if (ver === 4) {
      if (fflags & 0x000c) continue; // compressed / encrypted
      if (fflags & 0x0001) body = body.subarray(4); // data length indicator
      if (fflags & 0x0002 || flags & 0x80) body = unsync(body);
    } else if (ver === 3 && fflags & 0x00c0) continue; // compressed / encrypted
    if (isSylt) {
      const f = parseSylt(body);
      if (f && f.entries.length) out.sylt.push(f);
    } else {
      const f = parseUslt(body);
      if (f && f.text.trim()) out.uslt.push(f);
    }
  }
  return out;
}

/** Read the ID3v2 tag at the head of `file` (bounded) and return its lyrics frames, or null when there is none. */
export async function readId3Lyrics(file: string): Promise<Id3Lyrics | null> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(file, 'r');
    const head = Buffer.alloc(10);
    const { bytesRead } = await fh.read(head, 0, 10, 0);
    if (bytesRead < 10 || head.toString('latin1', 0, 3) !== 'ID3') return null;
    const size = syncsafe(head, 6);
    if (size <= 0 || size > MAX_TAG) return null;
    const buf = Buffer.alloc(10 + size);
    head.copy(buf);
    await fh.read(buf, 10, size, 10);
    const r = parseId3Lyrics(buf);
    return r.sylt.length || r.uslt.length ? r : null;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * SYLT entries → lines. Lines break on "\n" at the start (or end) of a syllable; without any newline every entry is a
 * line. Format 2 = ms, 1 = MPEG frames (converted with the frame duration).
 */
export function syltToLines(entries: SyltEntry[], { format = 2, sampleRate = 44100, samplesPerFrame = 1152 } = {}): LrcLine[] {
  const toMs = (ts: number) => Math.round(format === 1 ? (ts * samplesPerFrame * 1000) / sampleRate : ts);
  const items = (entries || []).filter((e) => e && Number.isFinite(e.timestamp)).map((e) => ({ t: toMs(e.timestamp), text: String(e.text ?? '') }));
  if (!items.length) return [];
  const anyBreak = items.some((e) => /[\r\n]/.test(e.text));
  if (!anyBreak) return items.map((e) => ({ startMs: e.t, text: e.text.trim() })).filter((l) => l.text);
  const lines: { t: number; words: { startMs: number; text: string }[]; closed?: boolean }[] = [];
  let cur: (typeof lines)[number] | null = null;
  for (const e of items) {
    const startsNew = /^[\r\n]/.test(e.text) || !cur || cur.closed;
    const txt = e.text.replace(/^[\r\n]+/, '');
    const closes = /[\r\n]$/.test(txt);
    const clean = txt.replace(/[\r\n]+$/, '');
    if (startsNew) {
      cur = { t: e.t, words: [] };
      lines.push(cur);
    }
    if (clean) cur!.words.push({ startMs: e.t, text: clean });
    if (closes) cur!.closed = true;
  }
  return lines
    .map((l) => {
      const text = l.words.map((w) => w.text).join('').replace(/\s+/g, ' ').trim();
      const o: LrcLine = { startMs: l.t, text };
      if (l.words.length > 1) o.words = l.words;
      return o;
    })
    .filter((l) => l.text || l.words);
}
