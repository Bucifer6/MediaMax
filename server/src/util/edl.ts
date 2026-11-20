import type { Marker } from '@mediamax/shared';

/**
 * Parse a Kodi/MythTV/comskip EDL file: one "start end [action]" line per segment, times in seconds.
 * Action 0 (cut) and 3 (commercial break) become commercial markers; 1 (mute) and 2 (scene) are ignored.
 */
export function parseEdl(text: string): Marker[] {
  const out: Marker[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)(?:\s+(\d))?/);
    if (!m) continue;
    const action = m[3] === undefined ? 0 : Number(m[3]);
    if (action !== 0 && action !== 3) continue;
    const startMs = Math.round(Number(m[1]) * 1000);
    const endMs = Math.round(Number(m[2]) * 1000);
    if (endMs - startMs >= 1000) out.push({ type: 'commercial', startMs, endMs });
  }
  return out.sort((a, b) => a.startMs - b.startMs).slice(0, 500);
}
