/**
 * The viewer's subtitle preferences applied to a parsed track before it is drawn: hearing-impaired annotations
 * stripped (SDH) and AutoSync's time map applied to every cue. Pure data, runs under node:test (web/test/).
 */
import { applySyncMap, stripSdh, type SyncMap } from '../playerPrefs';
import type { ParsedText, TextCue } from './types';

export interface PrepareOptions {
  stripSdh?: boolean;
  syncMap?: SyncMap | null;
}

const plain = (c: TextCue) => c.runs.map((r) => (r.br ? '\n' : r.text)).join('');

/** A text cue with SDH removed; null when nothing spoken is left. Untouched cues keep their own styling. */
function stripCue(c: TextCue): TextCue | null {
  const before = plain(c);
  const after = stripSdh(before);
  const same = before.split('\n').map((l) => l.replace(/\s{2,}/g, ' ').trim()).filter(Boolean).join('\n');
  if (after === same) return c;
  if (!after) return null;
  // Styling inside a changed cue can't be mapped onto the shorter text: keep italics when the whole cue was italic.
  const italic = c.runs.every((r) => r.br || r.i);
  const runs = after.split('\n').flatMap((line, i) => [...(i ? [{ text: '', br: true }] : []), { text: line, ...(italic ? { i: true } : {}) }]);
  return { ...c, runs };
}

export function prepareText(parsed: ParsedText, o: PrepareOptions): ParsedText {
  if (!o.stripSdh && !o.syncMap) return parsed;
  const cues: TextCue[] = [];
  for (const c of parsed.cues) {
    // ASS drawn with the file's own styling keeps its text (signs, karaoke); only dialogue in "my style" is stripped.
    const s = o.stripSdh && !c.ass ? stripCue(c) : c;
    if (!s) continue;
    cues.push(o.syncMap ? { ...s, start: applySyncMap(s.start, o.syncMap), end: applySyncMap(s.end, o.syncMap) } : s);
  }
  return { ...parsed, cues };
}

/** Bitmap subtitle events (PGS) moved by an AutoSync map. */
export function prepareTimed<T extends { start: number; end: number }>(events: T[], map: SyncMap | null | undefined): T[] {
  if (!map) return events;
  return events.map((e) => ({ ...e, start: applySyncMap(e.start, map), end: applySyncMap(e.end, map) }));
}
