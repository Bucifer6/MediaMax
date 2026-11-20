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

/** Active cues at `ms`: binary-search the last cue starting before `ms`, then scan back a little for overlaps. */
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
  for (let i = last; i >= 0 && i > last - 20; i--) {
    if (cues[i].end > ms) out.unshift(cues[i]);
  }
  return out;
}
