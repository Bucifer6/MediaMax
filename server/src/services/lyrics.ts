/**
 * Lyrics for music tracks.
 *
 * Sources, in priority order (a synced hit wins at once; a plain hit keeps looking for a synced one further down):
 *   1. edits saved in Kinora (admins, `lyrics_edits`)
 *   2. a sidecar next to the audio file: Song.lrc, Song.LRC, Song.mp3.lrc, then Song.txt
 *   3. embedded tags: ID3 SYLT (synced, read from the tag ourselves; FFmpeg drops it), ID3 USLT / `lyrics-<lang>`,
 *      Vorbis/FLAC LYRICS / UNSYNCEDLYRICS, MP4 ©lyr (FFmpeg `lyrics`)
 *   4. LRCLIB (Server settings → Metadata → LRCLIB; off = never contacted)
 * Plain lyrics that are really LRC text (a whole .lrc pasted into a tag) are detected and parsed as synced.
 *
 * Parts adapted from OpenDJ (MIT, github.com/Bucifer6/OpenDJ) — server/lyrics.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LyricLine, Lyrics } from '@mediamax/shared';
import { db } from '../db.js';
import { ffprobeJson } from './probe.js';
import { parseJson } from '../util/misc.js';
import { logger } from '../util/log.js';
import { lrclibGet } from './metadata/providers/lrclib.js';
import { providerConfig } from './metadata/config.js';
import { buildLrc, normalizeLines, parseLrc as parseLrcText, plainToLines, type LrcLine } from './lrc.js';
import { readId3Lyrics, syltToLines } from './id3.js';
import { getSettings } from './settings.js';
import { badRequest } from '../util/errors.js';

const log = logger('lyrics');

/** Parse LRC (or plain) text into API lines (kept for callers of the old helper). */
export function parseLrc(text: string): LyricLine[] {
  const p = parseLrcText(text);
  return p.synced.length ? p.synced : plainToLines(p.plain);
}

/** Decode a lyrics text file: UTF-8 (BOM or not), UTF-16 with BOM, else Latin-1 when it is not valid UTF-8. */
export function decodeText(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const b = Buffer.from(buf.subarray(2));
    b.swap16();
    return b.toString('utf16le');
  }
  const s = buf.toString('utf8');
  return s.includes('�') ? buf.toString('latin1') : s.replace(/^﻿/, '');
}

type Source = Lyrics['source'];
interface Found {
  source: Source;
  lines: LrcLine[];
  synced: boolean;
  meta?: Record<string, string>;
}

/** Text (LRC or plain) → found lyrics; null when empty. */
export function fromText(text: string, source: Source): Found | null {
  const p = parseLrcText(text);
  if (p.synced.length) return { source, lines: p.synced, synced: true, meta: p.meta };
  const lines = plainToLines(p.plain);
  return lines.some((l) => l.text) ? { source, lines, synced: false, meta: p.meta } : null;
}

export function sidecarCandidates(file: string): { file: string; source: 'lrc' | 'txt' }[] {
  const base = file.replace(/\.[^./\\]+$/, '');
  return [
    { file: `${base}.lrc`, source: 'lrc' },
    { file: `${base}.LRC`, source: 'lrc' },
    { file: `${file}.lrc`, source: 'lrc' },
    { file: `${base}.txt`, source: 'txt' },
  ];
}

export function readSidecar(file: string): Found | null {
  for (const c of sidecarCandidates(file)) {
    let buf: Buffer;
    try {
      const st = fs.statSync(c.file);
      if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
      buf = fs.readFileSync(c.file);
    } catch {
      continue;
    }
    const f = fromText(decodeText(buf), c.source);
    if (f) return f;
  }
  return null;
}

/** Lyrics tag keys FFmpeg reports (lower-cased): lyrics, lyrics-eng, unsyncedlyrics, ©lyr, … */
const isLyricsKey = (k: string) => k === 'lyrics' || k.startsWith('lyrics-') || k === 'unsyncedlyrics' || k === 'unsynced lyrics' || k === 'syncedlyrics' || k === 'synced lyrics' || k === 'uslt' || k === '©lyr' || k === 'wm/lyrics';

/** Lyrics from FFmpeg tags: synced (LRC in a tag) first, then the first plain text. */
export function fromTags(rawTags: Record<string, unknown>): Found | null {
  let plain: Found | null = null;
  const keys = Object.keys(rawTags).filter((k) => isLyricsKey(k.toLowerCase()));
  // Prefer the plain "lyrics" key, then language variants.
  keys.sort((a, b) => Number(a.toLowerCase() !== 'lyrics') - Number(b.toLowerCase() !== 'lyrics'));
  for (const k of keys) {
    const v = rawTags[k];
    if (typeof v !== 'string' || !v.trim()) continue;
    const f = fromText(v, 'embedded');
    if (f?.synced) return f;
    if (f && !plain) plain = f;
  }
  return plain;
}

export async function readEmbedded(file: string): Promise<Found | null> {
  let plain: Found | null = null;
  // ID3 SYLT / USLT straight from the tag (MP3, AIFF/WAV with an ID3 head).
  const id3 = await readId3Lyrics(file);
  if (id3) {
    let sampleRate = 44100;
    for (const f of id3.sylt) {
      if (f.format === 1) {
        try {
          const j = await ffprobeJson(file, [], 15000);
          sampleRate = Number(j.streams?.find((s: any) => s.codec_type === 'audio')?.sample_rate) || 44100;
        } catch { /* keep 44.1 kHz */ }
      }
      const lines = syltToLines(f.entries, { format: f.format, sampleRate });
      if (lines.length) return { source: 'embedded', lines, synced: true };
    }
    for (const u of id3.uslt) {
      const f = fromText(u.text, 'embedded');
      if (f?.synced) return f;
      if (f && !plain) plain = f;
    }
  }
  try {
    const j = await ffprobeJson(file, [], 15000);
    const tags: Record<string, unknown> = { ...(j.format?.tags ?? {}) };
    for (const s of j.streams ?? []) Object.assign(tags, s.tags ?? {});
    const f = fromTags(tags);
    if (f?.synced) return f;
    if (f && !plain) plain = f;
  } catch {
    /* no tags */
  }
  return plain;
}

/* ------------------------------------------------------------------ user edits & offsets */

export function getEdit(itemId: string): { lrc: string; editedAt: string } | null {
  const r = db.get<{ lrc: string; edited_at: string }>('SELECT lrc, edited_at FROM lyrics_edits WHERE item_id = ?', itemId);
  return r ? { lrc: r.lrc, editedAt: r.edited_at } : null;
}

export function getUserOffset(userId: string, itemId: string): number {
  return db.get<{ offset_ms: number }>('SELECT offset_ms FROM lyrics_offsets WHERE user_id = ? AND item_id = ?', userId, itemId)?.offset_ms ?? 0;
}

export function setUserOffset(userId: string, itemId: string, offsetMs: number): number {
  const v = Math.max(-30000, Math.min(30000, Math.round(Number(offsetMs) || 0)));
  if (!v) db.run('DELETE FROM lyrics_offsets WHERE user_id = ? AND item_id = ?', userId, itemId);
  else db.run('INSERT INTO lyrics_offsets (user_id, item_id, offset_ms) VALUES (?, ?, ?) ON CONFLICT(user_id, item_id) DO UPDATE SET offset_ms = excluded.offset_ms', userId, itemId, v);
  return v;
}

/** Metadata for a written LRC ([ti:], [ar:], [al:], [length:]). */
function trackMeta(itemId: string): Record<string, string> {
  const r = db.get(
    `SELECT t.title, t.duration_ms, a.title album, ar.title artist FROM items t
     LEFT JOIN items a ON a.id = t.parent_id LEFT JOIN items ar ON ar.id = t.grandparent_id WHERE t.id = ?`, itemId);
  if (!r) return {};
  const meta: Record<string, string> = {};
  if (r.title) meta.ti = r.title;
  if (r.artist) meta.ar = r.artist;
  if (r.album) meta.al = r.album;
  if (r.duration_ms) {
    const s = Math.round(r.duration_ms / 1000);
    meta.length = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }
  return meta;
}

/**
 * Save edited lyrics (LRC text or lines). Returns the stored LRC. With `writeSidecar` (and the admin setting on) the
 * LRC is also written next to the audio file; failures (read-only media) are reported, not thrown.
 */
export function saveEdit(itemId: string, body: { lrc?: string; lines?: unknown; writeSidecar?: boolean }, userId: string | null): { lrc: string; wroteSidecar: string | null; sidecarError: string | null } {
  let lines: LrcLine[];
  let meta: Record<string, string> = {};
  if (typeof body.lrc === 'string') {
    if (body.lrc.length > 500_000) throw badRequest('Lyrics are too long');
    const p = parseLrcText(body.lrc);
    lines = p.synced.length ? p.synced : plainToLines(p.plain);
    meta = p.meta;
  } else lines = normalizeLines(body.lines);
  if (!lines.some((l) => l.text.trim() || l.words?.length)) throw badRequest('No lyrics to save');
  const lrc = buildLrc(lines, { ...trackMeta(itemId), ...pick(meta, ['by']) });
  db.run(
    'INSERT INTO lyrics_edits (item_id, lrc, edited_by, edited_at) VALUES (?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET lrc = excluded.lrc, edited_by = excluded.edited_by, edited_at = excluded.edited_at',
    itemId, lrc, userId, new Date().toISOString());
  let wroteSidecar: string | null = null;
  let sidecarError: string | null = null;
  if (body.writeSidecar) {
    if (!getSettings().karaoke?.writeLrcSidecars) sidecarError = 'Writing .lrc files is turned off (Server settings → Karaoke & lyrics)';
    else {
      const m = db.get<{ path: string }>('SELECT path FROM media WHERE item_id = ? AND path IS NOT NULL LIMIT 1', itemId);
      if (!m?.path || !path.isAbsolute(m.path)) sidecarError = 'This track has no local file';
      else {
        const target = m.path.replace(/\.[^./\\]+$/, '') + '.lrc';
        try {
          fs.writeFileSync(target, lrc, 'utf8');
          wroteSidecar = target;
        } catch (e) {
          sidecarError = `Could not write ${path.basename(target)}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`;
        }
      }
    }
  }
  return { lrc, wroteSidecar, sidecarError };
}

export function deleteEdit(itemId: string) {
  db.run('DELETE FROM lyrics_edits WHERE item_id = ?', itemId);
}

const pick = (o: Record<string, string>, keys: string[]) => Object.fromEntries(keys.filter((k) => o[k]).map((k) => [k, o[k]]));

/* ------------------------------------------------------------------ lookup */

function toLyrics(itemId: string, f: Found, extra: Partial<Lyrics> = {}): Lyrics {
  return { itemId, synced: f.synced, source: f.source, lines: f.lines, lrc: buildLrc(f.lines, f.meta ?? {}), meta: f.meta, ...extra };
}

/** Local lyrics for a file (sidecar → embedded); synced beats plain. */
export async function localLyrics(file: string): Promise<{ synced: Found | null; plain: Found | null }> {
  let plain: Found | null = null;
  const side = readSidecar(file);
  if (side?.synced) return { synced: side, plain: null };
  if (side) plain = side;
  const emb = await readEmbedded(file);
  if (emb?.synced) return { synced: emb, plain };
  if (emb && !plain) plain = emb;
  return { synced: null, plain };
}

/** Lyrics for a track, following the source priority. `userId` adds that user's saved offset. */
export async function getLyrics(itemId: string, userId?: string): Promise<Lyrics | null> {
  const extra: Partial<Lyrics> = userId ? { userOffsetMs: getUserOffset(userId, itemId) } : {};
  const edit = getEdit(itemId);
  if (edit) {
    const f = fromText(edit.lrc, 'user');
    if (f) return toLyrics(itemId, f, { ...extra, editedAt: edit.editedAt });
  }
  const m = db.get('SELECT path FROM media WHERE item_id = ? AND path IS NOT NULL LIMIT 1', itemId);
  let plain: Found | null = null;
  if (m?.path) {
    const local = await localLyrics(m.path);
    if (local.synced) return toLyrics(itemId, local.synced, extra);
    plain = local.plain;
  }
  const online = await fetchLrclib(itemId);
  if (online && (online.synced || !plain)) return { ...online, ...extra };
  return plain ? toLyrics(itemId, plain, extra) : null;
}

/** LRCLIB fallback (Server settings → Metadata): synced lyrics by track/artist/album/duration; hits and misses are cached. */
export async function fetchLrclib(itemId: string): Promise<Lyrics | null> {
  if (!providerConfig('lrclib').enabled) return null;
  const r = db.get(
    `SELECT t.type, t.title, t.duration_ms, t.extra, a.title album, ar.title artist FROM items t
     LEFT JOIN items a ON a.id = t.parent_id LEFT JOIN items ar ON ar.id = t.grandparent_id WHERE t.id = ?`, itemId);
  if (!r || r.type !== 'track') return null;
  const tags = parseJson<{ tags?: Record<string, string | null> }>(r.extra, {}).tags ?? {};
  const artist = tags.artist || r.artist;
  if (!r.title || !artist) return null;
  try {
    const hit = await lrclibGet({ track: tags.title || r.title, artist, album: tags.album || r.album, durationSec: r.duration_ms ? r.duration_ms / 1000 : null });
    const text = hit?.synced || hit?.plain;
    if (!text) return null;
    const f = fromText(text, 'lrclib');
    return f ? { itemId, synced: f.synced, source: 'lrclib', lines: f.lines } : null;
  } catch (e) {
    log.debug(`LRCLIB lookup failed: ${(e as Error).message}`);
    return null;
  }
}
