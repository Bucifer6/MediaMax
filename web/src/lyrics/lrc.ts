/**
 * LRC lyrics: parser / writer and timing lookups. Pure TypeScript, no imports, no DOM.
 *
 * Adapted from OpenDJ (MIT, github.com/Bucifer6/OpenDJ) — public/js/lyrics/lrc.js — with times in milliseconds
 * (Vibe convention) instead of seconds.
 *
 * The canonical copy lives in shared/src/lrc.ts; `node scripts/sync-types.mjs` copies it verbatim to
 * server/src/services/lrc.ts, web/src/lyrics/lrc.ts and apps/mobile/src/player/lrc.ts (a server test checks they match).
 *
 * Supported LRC: [mm:ss.xx] / [mm:ss.xxx] / [mm:ss] / [mm:ss:xx] line stamps (minutes may exceed 59), several stamps
 * per line ([00:12.00][01:30.00]chorus), metadata tags ([ti:] [ar:] [al:] [au:] [by:] [length:] [offset:+/-ms] …) and
 * enhanced (A2) word timing: [00:12.00]<00:12.00>Word <00:12.40>by <00:12.90>word<00:13.50> (a trailing stamp ends the
 * last word). Times are track times, already corrected by [offset:] (+ = lyrics come earlier).
 */

export interface LrcWord {
  startMs: number;
  text: string;
}

export interface LrcLine {
  /** null only for unsynced (plain) lines. */
  startMs: number | null;
  text: string;
  /** Enhanced (A2) word timing, when the source has it. */
  words?: LrcWord[];
  /** End of the line (A2 trailing stamp); otherwise the next line's start ends it. */
  endMs?: number;
}

export interface ParsedLrc {
  /** Synced lines sorted by time (empty when the text has no line stamps). */
  synced: LrcLine[];
  /** The text without stamps. */
  plain: string;
  /** Lower-cased metadata tags ([ti:], [ar:], …). */
  meta: Record<string, string>;
  /** [offset:] value in ms (already applied to the times). */
  offsetMs: number;
}

const TS = String.raw`(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?`;
const LINE_TS = new RegExp(String.raw`^\s*\[${TS}\]`);
const WORD_TS = new RegExp(String.raw`<${TS}>`, 'g');
const WORD_TS_STRIP = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;
const META = /^\s*\[([a-zA-Z#][\w#-]*):(.*)\]\s*$/;

/** "mm", "ss", "frac" groups → ms ([mm:ss.xx] = centiseconds, [mm:ss.xxx] = ms, [mm:ss.x] = tenths). */
function tsToMs(a: string, b: string, c?: string): number {
  const frac = c !== undefined ? Math.round(Number(`0.${c.padEnd(2, '0')}`) * 1000) : 0;
  return (Number(a) * 60 + Number(b)) * 1000 + frac;
}

/** Split a line's text into words with enhanced timing. */
function parseWords(raw: string, lineMs: number): { text: string; words: LrcWord[] | null; endMs: number | null } {
  WORD_TS.lastIndex = 0;
  if (!WORD_TS.test(raw)) return { text: raw.trim(), words: null, endMs: null };
  WORD_TS.lastIndex = 0;
  const words: LrcWord[] = [];
  let last = 0;
  let cur = lineMs;
  let endMs: number | null = null;
  let m: RegExpExecArray | null;
  const push = (txt: string, t: number) => {
    if (txt.length) words.push({ startMs: t, text: txt });
  };
  while ((m = WORD_TS.exec(raw))) {
    push(raw.slice(last, m.index), cur);
    cur = tsToMs(m[1], m[2], m[3]);
    last = m.index + m[0].length;
  }
  const tail = raw.slice(last);
  if (tail.trim().length) push(tail, cur);
  else endMs = cur;
  const clean = words.filter((w) => w.text.trim().length);
  const text = clean.map((w) => w.text).join('').replace(/\s+/g, ' ').trim();
  return { text, words: clean.length ? clean : null, endMs };
}

/** Parse LRC (or plain) text. */
export function parseLrc(input: string | null | undefined): ParsedLrc {
  const text = String(input ?? '').replace(/^﻿/, '');
  const meta: Record<string, string> = {};
  const entries: { t: number; text: string; words?: LrcWord[]; end?: number; i: number }[] = [];
  const plainLines: string[] = [];
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    let line = rawLine;
    const stamps: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = LINE_TS.exec(line))) {
      stamps.push(tsToMs(m[1], m[2], m[3]));
      line = line.slice(m[0].length);
    }
    if (stamps.length) {
      // Enhanced word stamps are absolute for the first line stamp; repeated stamps get them shifted.
      const parsed = parseWords(line, stamps[0]);
      for (const t of stamps) {
        const shift = t - stamps[0];
        const e: (typeof entries)[number] = { t, text: parsed.text, i: entries.length };
        if (parsed.words) e.words = parsed.words.map((w) => ({ startMs: w.startMs + shift, text: w.text }));
        if (parsed.endMs != null) e.end = parsed.endMs + shift;
        entries.push(e);
      }
      continue;
    }
    const mm = META.exec(line);
    if (mm && !/^\d+$/.test(mm[1])) {
      meta[mm[1].toLowerCase()] = mm[2].trim();
      continue;
    }
    if (line.trim()) plainLines.push(line.replace(WORD_TS_STRIP, '').trim());
  }
  const offsetMs = Number(String(meta.offset ?? '0').replace(/\s+/g, '')) || 0;
  const adj = (t: number) => Math.max(0, Math.round(t - offsetMs));
  const synced: LrcLine[] = entries
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((e) => {
      const out: LrcLine = { startMs: adj(e.t), text: e.text };
      if (e.words) out.words = e.words.map((w) => ({ startMs: adj(w.startMs), text: w.text }));
      if (e.end != null) out.endMs = adj(e.end);
      return out;
    });
  const plain = synced.length
    ? synced.map((l) => l.text).filter((s, i, a) => s || (i > 0 && a[i - 1])).join('\n').trim()
    : plainLines.join('\n');
  return { synced, plain, meta, offsetMs };
}

/** True when text looks like LRC (at least two timed lines, or one plus metadata) rather than plain lyrics. */
export function looksLikeLrc(text: string | null | undefined): boolean {
  const s = String(text ?? '');
  const stamped = s.split(/\r\n|\r|\n/).filter((l) => LINE_TS.test(l)).length;
  return stamped >= 2 || (stamped === 1 && /^\s*\[(ti|ar|al|offset|length|by):/im.test(s));
}

/** mm:ss.xx */
export function formatLrcTime(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

/** Lines → LRC text (enhanced word stamps when words are present). Times are written without [offset:]. */
export function buildLrc(lines: LrcLine[], meta: Record<string, string> = {}, tool = 'Vibe'): string {
  const out: string[] = [];
  for (const k of ['ti', 'ar', 'al', 'au', 'length', 'by']) if (meta[k]) out.push(`[${k}:${meta[k]}]`);
  out.push(`[re:${tool}]`);
  const synced = lines.filter((l) => l.startMs != null);
  if (synced.length) {
    for (const l of synced) {
      if (l.words?.length) {
        const body = l.words.map((w) => `<${formatLrcTime(w.startMs)}>${w.text}`).join('') + (l.endMs != null ? `<${formatLrcTime(l.endMs)}>` : '');
        out.push(`[${formatLrcTime(l.startMs!)}]${body}`);
      } else out.push(`[${formatLrcTime(l.startMs!)}]${l.text || ''}`);
    }
  } else out.push(...lines.map((l) => l.text));
  return out.join('\n') + '\n';
}

/** Plain text → unsynced lines (no runs of empty lines). */
export function plainToLines(plain: string): LrcLine[] {
  return String(plain || '')
    .split(/\r?\n/)
    .map((text) => ({ startMs: null, text: text.trim() }))
    .filter((l, i, a) => l.text || (i > 0 && a[i - 1].text));
}

/** Coerce anything lyrics-like (API payloads, user input) into clean, sorted, bounded lines. */
export function normalizeLines(v: unknown): LrcLine[] {
  const src = Array.isArray(v) ? v : [];
  const clamp = (t: unknown) => (t !== null && t !== '' && Number.isFinite(Number(t)) && Number(t) >= 0 ? Math.round(Number(t)) : null);
  const timed = src.some((l) => clamp((l as LrcLine)?.startMs) != null);
  const out: LrcLine[] = [];
  for (const raw of src.slice(0, 5000)) {
    const l = (raw ?? {}) as Partial<LrcLine>;
    const t = clamp(l.startMs);
    if (timed && t == null) continue;
    const o: LrcLine = { startMs: timed ? t : null, text: String(l.text ?? '').slice(0, 1000) };
    if (timed && Array.isArray(l.words) && l.words.length) {
      const words = l.words.map((w) => ({ startMs: clamp(w?.startMs), text: String(w?.text ?? '').slice(0, 200) })).filter((w): w is LrcWord => w.startMs != null && !!w.text);
      if (words.length) o.words = words.slice(0, 200);
    }
    const end = clamp(l.endMs);
    if (timed && end != null && t != null && end >= t) o.endMs = end;
    out.push(o);
  }
  return timed ? out.sort((a, b) => a.startMs! - b.startMs!) : out;
}

/** Index of the line playing at `ms` (last line with startMs ≤ ms), −1 before the first. Binary search. */
export function lineIndexAt(lines: LrcLine[], ms: number): number {
  let lo = 0;
  let hi = (lines?.length || 0) - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = lines[mid].startMs;
    if (t != null && t <= ms) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export interface LyricState {
  index: number;
  line: LrcLine | null;
  next: LrcLine | null;
  prev: LrcLine | null;
  /** 0..1 through the current line (until the next line or its end stamp). */
  progress: number;
  /** Current word (A2 timing), −1 when the line has no word timing or before its first word. */
  wordIndex: number;
  /** 0..1 through the current word. */
  wordProgress: number;
  /** Between a line's end and the next line (instrumental part), or on an empty line. */
  gap: boolean;
}

/** End of the last word: its explicit end, else an estimate from its length. */
function lineWordEnd(line: LrcLine): number {
  if (line.endMs != null) return line.endMs;
  const w = line.words![line.words!.length - 1];
  return w.startMs + Math.max(300, Math.min(2000, w.text.trim().length * 90));
}

/** Where we are in the lyrics at track time `ms`. */
export function lyricStateAt(lines: LrcLine[], ms: number): LyricState {
  const s = lines || [];
  const index = lineIndexAt(s, ms);
  const line = index >= 0 ? s[index] : null;
  const next = s[index + 1] ?? null;
  const prev = index > 0 ? s[index - 1] : null;
  const out: LyricState = { index, line, next, prev, progress: 0, wordIndex: -1, wordProgress: 0, gap: false };
  if (!line || line.startMs == null) return out;
  const t0 = line.startMs;
  const nextT = next?.startMs ?? Infinity;
  const lineEnd = line.endMs ?? (line.words?.length ? Math.min(nextT, lineWordEnd(line)) : next?.startMs ?? t0 + 5000);
  out.gap = !line.text || ms > lineEnd;
  out.progress = lineEnd > t0 ? Math.max(0, Math.min(1, (ms - t0) / (lineEnd - t0))) : 1;
  if (line.words?.length) {
    const w = line.words;
    let wi = -1;
    for (let i = 0; i < w.length; i++) {
      if (w[i].startMs <= ms) wi = i;
      else break;
    }
    out.wordIndex = wi;
    if (wi >= 0) {
      const wEnd = w[wi + 1]?.startMs ?? lineEnd;
      out.wordProgress = wEnd > w[wi].startMs ? Math.max(0, Math.min(1, (ms - w[wi].startMs) / (wEnd - w[wi].startMs))) : 1;
    }
  }
  return out;
}

/**
 * Words of a line with their highlight fill (0..1) at `ms`, for karaoke display. With A2 word timing each word fills
 * over its own span; with only line timing the fill wipes across the line in proportion to word length.
 */
export function wordFills(line: LrcLine, state: Pick<LyricState, 'progress' | 'wordIndex' | 'wordProgress'>): { text: string; fill: number }[] {
  if (line.words?.length) {
    return line.words.map((w, i) => ({ text: w.text, fill: i < state.wordIndex ? 1 : i === state.wordIndex ? state.wordProgress : 0 }));
  }
  const parts = line.text.split(/(\s+)/).filter((p) => p.length);
  const total = parts.reduce((n, p) => n + p.length, 0) || 1;
  let acc = 0;
  const pos = state.progress * total;
  return parts.map((p) => {
    const a = acc;
    acc += p.length;
    return { text: p, fill: Math.max(0, Math.min(1, (pos - a) / p.length)) };
  });
}

/** Shift every time by `dtMs` (offset nudge in the editor). */
export function shiftLines(lines: LrcLine[], dtMs: number): LrcLine[] {
  const sh = (t: number) => Math.max(0, Math.round(t + dtMs));
  return lines.map((l) => ({
    ...l,
    startMs: l.startMs == null ? null : sh(l.startMs),
    ...(l.endMs != null ? { endMs: sh(l.endMs) } : {}),
    ...(l.words ? { words: l.words.map((w) => ({ ...w, startMs: sh(w.startMs) })) } : {}),
  }));
}

/**
 * Lyrics time for a playback position. `offsetMs` is the user's total offset (per-track + global): positive shows
 * the lyrics earlier. `lagMs` is audio output latency (what is still in the pipeline has not been heard yet).
 */
export function lyricsTime(positionMs: number, offsetMs = 0, lagMs = 0, playing = true): number {
  return Math.max(0, positionMs + offsetMs - (playing ? lagMs : 0));
}
