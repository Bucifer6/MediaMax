/**
 * Lyrics editor model (pure): tap-to-sync, undo, shifting, untimed-line interpolation and conversion to LRC.
 * Adapted from OpenDJ (MIT, github.com/Bucifer6/OpenDJ) — public/js/lyrics/editor.js.
 */
import { buildLrc, parseLrc, plainToLines, type LrcLine } from './lrc';

/** Editor lines from LRC / plain text. */
export function linesFromText(text: string): LrcLine[] {
  const p = parseLrc(text);
  return p.synced.length ? p.synced.map((l) => ({ ...l })) : plainToLines(text);
}

/** Stamp line `i` with time `ms`; word stamps move with the line, untimed words are dropped. */
export function tapLine(lines: LrcLine[], i: number, ms: number): LrcLine[] {
  const out = lines.map((l) => ({ ...l }));
  const l = out[i];
  if (!l) return out;
  const t = Math.max(0, Math.round(ms));
  if (l.words && l.startMs != null) {
    const d = t - l.startMs;
    l.words = l.words.map((w) => ({ ...w, startMs: Math.max(0, w.startMs + d) }));
    if (l.endMs != null) l.endMs = Math.max(0, l.endMs + d);
  } else {
    delete l.words;
    delete l.endMs;
  }
  l.startMs = t;
  return out;
}

/** Shift every timed line by `dtMs`. */
export function shiftAll(lines: LrcLine[], dtMs: number): LrcLine[] {
  return lines.map((l) => (l.startMs == null ? l : tapLine([l], 0, l.startMs + dtMs)[0]));
}

/** First line without a time (the tap cursor's natural start), or 0. */
export const firstUntimed = (lines: LrcLine[]) => Math.max(0, lines.findIndex((l) => l.startMs == null));

/**
 * Lines ready to save: when some lines are timed, untimed ones get times interpolated between their timed neighbours
 * (or 2 s after the previous line at the end), and the result is sorted. All-untimed stays plain.
 */
export function fillUntimed(lines: LrcLine[]): LrcLine[] {
  if (!lines.some((l) => l.startMs != null)) return lines.map((l) => ({ ...l }));
  const out = lines.map((l) => ({ ...l }));
  for (let i = 0; i < out.length; i++) {
    if (out[i].startMs != null) continue;
    let j = i;
    while (j < out.length && out[j].startMs == null) j++;
    const prev = i > 0 ? out[i - 1].startMs! : null;
    const next = j < out.length ? out[j].startMs! : null;
    const n = j - i + 1;
    for (let k = i; k < j; k++) {
      const step = k - i + 1;
      out[k].startMs = prev != null && next != null ? Math.round(prev + ((next - prev) * step) / n) : prev != null ? prev + 2000 * step : Math.max(0, next! - 2000 * (j - k));
    }
    i = j;
  }
  return out.sort((a, b) => a.startMs! - b.startMs!);
}

/** LRC text for the editor's lines (plain text when nothing is timed). */
export function linesToLrc(lines: LrcLine[], meta: Record<string, string> = {}): string {
  if (!lines.some((l) => l.startMs != null)) return lines.map((l) => l.text).join('\n').trim() + '\n';
  return buildLrc(fillUntimed(lines), meta);
}
