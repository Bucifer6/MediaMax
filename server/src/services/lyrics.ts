import fs from 'node:fs';
import path from 'node:path';
import type { LyricLine, Lyrics } from '@mediamax/shared';
import { db } from '../db.js';
import { ffprobeJson } from './probe.js';

/** Parse LRC ("[mm:ss.xx] text", multiple timestamps per line, [offset:+/-ms]). */
export function parseLrc(text: string): LyricLine[] {
  const offset = parseInt(text.match(/^\[offset:\s*([+-]?\d+)\]/im)?.[1] ?? '0', 10) || 0;
  const out: LyricLine[] = [];
  let synced = false;
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    const body = raw.replace(/\[[^\]]*\]/g, '').trim();
    if (stamps.length) {
      synced = true;
      for (const s of stamps) {
        const frac = s[3] ? parseInt(s[3].padEnd(3, '0').slice(0, 3), 10) : 0;
        out.push({ startMs: Math.max(0, (parseInt(s[1], 10) * 60 + parseInt(s[2], 10)) * 1000 + frac - offset), text: body });
      }
    } else if (!/^\[[a-z]+:/i.test(raw.trim()) && raw.trim()) out.push({ startMs: null, text: raw.trim() });
  }
  return synced ? out.filter((l) => l.startMs !== null).sort((a, b) => a.startMs! - b.startMs!) : out;
}

export async function getLyrics(itemId: string): Promise<Lyrics | null> {
  const m = db.get('SELECT path FROM media WHERE item_id = ? AND path IS NOT NULL LIMIT 1', itemId);
  if (!m?.path) return null;
  const base = m.path.replace(/\.[^.]+$/, '');
  for (const [ext, source] of [['.lrc', 'lrc'], ['.LRC', 'lrc'], ['.txt', 'txt']] as const) {
    const p = base + ext;
    if (fs.existsSync(p)) {
      const lines = parseLrc(fs.readFileSync(p, 'utf8'));
      if (lines.length) return { itemId, synced: lines[0].startMs !== null, source, lines };
    }
  }
  try {
    const j = await ffprobeJson(m.path, [], 15000);
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...(j.format?.tags ?? {}), ...(j.streams?.[0]?.tags ?? {}) })) tags[k.toLowerCase()] = String(v);
    const key = Object.keys(tags).find((k) => k === 'lyrics' || k.startsWith('lyrics-') || k === 'unsyncedlyrics' || k === 'uslt' || k === '©lyr');
    if (key) {
      const lines = parseLrc(tags[key]);
      if (lines.length) return { itemId, synced: lines[0].startMs !== null, source: 'embedded', lines };
    }
  } catch {
    /* no tags */
  }
  void path;
  return null;
}
