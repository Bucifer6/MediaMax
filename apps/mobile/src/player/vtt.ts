/** Minimal WebVTT parser for server sidecar subtitles (rendered by our own overlay). */
export interface Cue {
  start: number; // ms
  end: number; // ms
  text: string;
}

function toMs(ts: string): number {
  const parts = ts.trim().replace(',', '.').split(':');
  let h = 0;
  let m = 0;
  let s = 0;
  if (parts.length === 3) [h, m, s] = [Number(parts[0]), Number(parts[1]), Number(parts[2])];
  else if (parts.length === 2) [m, s] = [Number(parts[0]), Number(parts[1])];
  return Math.round(((h * 60 + m) * 60 + s) * 1000);
}

export function parseVtt(src: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = src.replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.length);
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx < 0) continue;
    const [a, b] = lines[idx].split('-->');
    const end = b.trim().split(/\s+/)[0];
    const text = lines
      .slice(idx + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '') // strip <i>, <c.x>, timestamps
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .trim();
    if (text) cues.push({ start: toMs(a), end: toMs(end), text });
  }
  return cues.sort((x, y) => x.start - y.start);
}

/** Per cue list: prefixEnd[i] = the latest end among cues[0..i] (non-decreasing). */
const prefixEnds = new WeakMap<Cue[], Float64Array>();
function prefixEnd(cues: Cue[]): Float64Array {
  let p = prefixEnds.get(cues);
  if (!p || p.length !== cues.length) {
    p = new Float64Array(cues.length);
    let max = -Infinity;
    for (let i = 0; i < cues.length; i++) p[i] = max = Math.max(max, cues[i].end);
    prefixEnds.set(cues, p);
  }
  return p;
}

/**
 * Active cues at `ms` (cues sorted by start): binary-search the last cue starting at or before `ms`, then walk back
 * while some earlier cue still ends after `ms` (prefix maximum of end times), so a long cue stays on screen however
 * many shorter cues start after it.
 */
export function activeCues(cues: Cue[], ms: number): Cue[] {
  let lo = 0;
  let hi = cues.length - 1;
  let last = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= ms) {
      last = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const out: Cue[] = [];
  if (last < 0) return out;
  const ends = prefixEnd(cues);
  for (let i = last; i >= 0 && ends[i] > ms; i--) {
    if (cues[i].end > ms) out.unshift(cues[i]);
  }
  return out;
}
