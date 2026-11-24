/** Extended M3U playlist parser (tvg-*, group-title, catchup attributes). */
export interface M3uEntry {
  name: string;
  url: string;
  tvgId: string | null;
  tvgName: string | null;
  logo: string | null;
  group: string | null;
  chno: number | null;
  catchup: string | null;
  catchupSource: string | null;
  catchupDays: number;
  userAgent: string | null;
}

export interface M3uPlaylist {
  epgUrl: string | null;
  entries: M3uEntry[];
}

const ATTR = /([\w-]+)="([^"]*)"/g;

/** Index of the comma that starts the channel name: the first one outside a quoted attribute value (names may contain commas). */
function nameComma(line: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ',' && !quoted) return i;
  }
  return line.lastIndexOf(','); // unbalanced quotes: best effort
}

export function parseM3u(text: string): M3uPlaylist {
  const lines = text.split(/\r?\n/);
  let epgUrl: string | null = null;
  const entries: M3uEntry[] = [];
  let cur: Partial<M3uEntry> | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTM3U')) {
      const m = line.match(/(?:url-tvg|x-tvg-url)="([^"]+)"/);
      if (m) epgUrl = m[1].split(',')[0].trim();
      continue;
    }
    if (line.startsWith('#EXTINF')) {
      const attrs: Record<string, string> = {};
      for (const m of line.matchAll(ATTR)) attrs[m[1].toLowerCase()] = m[2];
      const comma = nameComma(line);
      const name = comma >= 0 ? line.slice(comma + 1).trim() : attrs['tvg-name'] ?? 'Channel';
      cur = {
        name: name || attrs['tvg-name'] || 'Channel',
        tvgId: attrs['tvg-id'] || null,
        tvgName: attrs['tvg-name'] || null,
        logo: attrs['tvg-logo'] || null,
        group: attrs['group-title'] || null,
        chno: attrs['tvg-chno'] ? Number(attrs['tvg-chno']) || null : null,
        catchup: attrs['catchup'] || attrs['catchup-type'] || null,
        catchupSource: attrs['catchup-source'] || null,
        catchupDays: Number(attrs['catchup-days'] || attrs['timeshift'] || 0) || 0,
        userAgent: attrs['user-agent'] || null,
      };
      continue;
    }
    if (line.startsWith('#EXTGRP:') && cur) {
      cur.group = line.slice(8).trim();
      continue;
    }
    if (line.startsWith('#EXTVLCOPT:') && cur) {
      const m = line.match(/http-user-agent=(.+)$/i);
      if (m) cur.userAgent = m[1].trim();
      continue;
    }
    if (line.startsWith('#')) continue;
    if (cur) {
      entries.push({ ...(cur as M3uEntry), url: line });
      cur = null;
    }
  }
  return { epgUrl, entries };
}

/** Build a catch-up URL from M3U catchup attributes (supports common placeholder styles). */
export function m3uCatchupUrl(e: { url: string; catchup: string | null; catchupSource: string | null }, start: Date, durationMin: number): string | null {
  const startSec = Math.floor(start.getTime() / 1000);
  const endSec = startSec + durationMin * 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  const fill = (tpl: string) =>
    tpl
      .replace(/\$?\{utc\}|\$\{start\}/g, String(startSec))
      .replace(/\$?\{utcend\}|\$\{end\}/g, String(endSec))
      .replace(/\$?\{lutc\}|\$?\{now\}|\$\{timestamp\}/g, String(Math.floor(Date.now() / 1000)))
      .replace(/\$?\{duration\}/g, String(durationMin * 60))
      .replace(/\$?\{offset\}/g, String(Math.floor(Date.now() / 1000) - startSec))
      .replace(/\{Y\}/g, String(start.getUTCFullYear())).replace(/\{m\}/g, pad(start.getUTCMonth() + 1)).replace(/\{d\}/g, pad(start.getUTCDate()))
      .replace(/\{H\}/g, pad(start.getUTCHours())).replace(/\{M\}/g, pad(start.getUTCMinutes())).replace(/\{S\}/g, pad(start.getUTCSeconds()));
  const type = (e.catchup ?? '').toLowerCase();
  if (e.catchupSource) {
    const src = fill(e.catchupSource);
    return type === 'append' ? e.url + src : /^https?:/.test(src) ? src : e.url + src;
  }
  if (type === 'shift' || type === 'timeshift') return `${e.url}${e.url.includes('?') ? '&' : '?'}utc=${startSec}&lutc=${Math.floor(Date.now() / 1000)}`;
  if (type === 'flussonic' || type === 'fs') return e.url.replace(/\/(index|video|mono)(\.m3u8|\.ts)/, `/$1-${startSec}-${durationMin * 60}$2`);
  return null;
}
