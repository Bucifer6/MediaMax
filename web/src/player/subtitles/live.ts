/**
 * Live TV captions: hls.js parses CEA-608/708 and WebVTT renditions (in JS) into text-track cues. We keep those tracks
 * in "hidden" mode — the platform never draws them — and render the active cues with our overlay.
 */
import { parseMarkup } from './text';
import type { Align, TextCue, VttLayout } from './types';

export function textTrackCueToCue(c: TextTrackCue): TextCue | null {
  const v = c as VTTCue;
  const text = typeof v.text === 'string' ? v.text : '';
  if (!text.trim()) return null;
  const { runs } = parseMarkup(text);
  const layout: VttLayout = {};
  if (typeof v.line === 'number') {
    layout.line = v.line;
    layout.snapToLines = v.snapToLines !== false;
  }
  if (typeof v.position === 'number') layout.position = v.position;
  if (typeof v.size === 'number' && v.size !== 100) layout.size = v.size;
  if (v.align) layout.align = (v.align === 'middle' as string ? 'center' : v.align) as Align;
  return { start: c.startTime * 1000, end: c.endTime * 1000, runs, ...(Object.keys(layout).length ? { vtt: layout } : {}) };
}

export function activeLiveCues(list: TextTrackCueList | null): TextCue[] {
  if (!list) return [];
  return Array.from(list).map(textTrackCueToCue).filter((x): x is TextCue => !!x);
}
