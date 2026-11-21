/**
 * Release-name parsing and subtitle/release matching.
 *
 * Subtitles are timed against one release: a subtitle made for the same group and source as the media file almost
 * always fits, the same source usually fits, anything else may drift. The score (0-100) reflects that and is shown
 * in the manual search and used by the automatic download task.
 */
import { parseEpisodeName, stripExt, VIDEO_EXT, SUB_EXT } from '../parser.js';

export type ReleaseSource = 'remux' | 'bluray' | 'web-dl' | 'webrip' | 'web' | 'hdtv' | 'dvdrip';

export interface ReleaseInfo {
  source: ReleaseSource | null;
  resolution: string | null;
  group: string | null;
  season: number | null;
  episode: number | null;
  episodeEnd: number | null;
  /** Season pack ("S01" without an episode). */
  seasonPack: boolean;
}

const ARCHIVE_EXT = new Set(['zip', 'rar', '7z']);

/** Strip a known media/subtitle/archive extension (release names contain dots everywhere else). */
function stripKnownExt(name: string): string {
  const m = name.match(/\.([a-z0-9]{2,4})$/i);
  if (!m) return name;
  const e = m[1].toLowerCase();
  return VIDEO_EXT.has(e) || SUB_EXT.has(e) || ARCHIVE_EXT.has(e) ? stripExt(name) : name;
}

function parseSource(s: string): ReleaseSource | null {
  if (/\b(bd)?remux\b/i.test(s)) return 'remux';
  if (/\b(blu[ .-]?ray|bdrip|brrip|bd25|bd50|bluray)\b/i.test(s)) return 'bluray';
  if (/\bweb[ .-]?dl\b/i.test(s)) return 'web-dl';
  if (/\bweb[ .-]?rip\b/i.test(s)) return 'webrip';
  if (/\b(hdtv|pdtv|sdtv|dsr|tvrip)\b/i.test(s)) return 'hdtv';
  if (/\b(dvd[ .-]?rip|dvdr|dvd[59]?)\b/i.test(s)) return 'dvdrip';
  if (/\bweb\b/i.test(s) || /\b(amzn|nf|dsnp|hmax|atvp|hulu|pcok|pmtp)\b/i.test(s)) return 'web';
  return null;
}

function parseResolution(s: string): string | null {
  const m = s.match(/\b(2160|1080|720|576|480)[pi]\b/i);
  if (m) return `${m[1]}p`;
  if (/\b(4k|uhd)\b/i.test(s)) return '2160p';
  return null;
}

/** Trailing "-GROUP" (scene/P2P), or a leading/trailing "[Group]" (anime). */
function parseGroup(s: string): string | null {
  const t = s.trim().replace(/(\.(ro|rum|ron|en|eng|forced|sdh|hi|cc))+$/i, '');
  let m = t.match(/-([A-Za-z0-9][A-Za-z0-9_]{1,30})(?:\[[^\]]*\])?$/);
  if (m && !/^(dl|rip|hd|web|x26[45]|h26[45]|\d+p?)$/i.test(m[1])) return m[1];
  m = t.match(/^\[([^\]]{2,30})\]/) ?? t.match(/\[([A-Za-z][^\]]{1,30})\]$/);
  if (m && !/^\d+p?$/.test(m[1])) return m[1];
  return null;
}

/** Parse source, resolution, group and season/episode from a release or file name. */
export function parseRelease(name: string | null | undefined): ReleaseInfo {
  const empty: ReleaseInfo = { source: null, resolution: null, group: null, season: null, episode: null, episodeEnd: null, seasonPack: false };
  if (!name) return empty;
  const base = stripKnownExt(name.split(/[\\/]/).pop() ?? name);
  const out: ReleaseInfo = { ...empty, source: parseSource(base), resolution: parseResolution(base), group: parseGroup(base) };
  // SxxEyy / 1x02 via the library parser (only trust real season+episode matches, not "E05"-style guesses).
  const ep = /s\d{1,4}[\s._-]*e\d{1,4}|\b\d{1,2}x\d{1,3}\b/i.test(base) ? parseEpisodeName(`${base}.x`) : null; // parseEpisodeName strips an extension itself
  if (ep && ep.season != null && ep.episode != null && !ep.airDate) {
    out.season = ep.season;
    out.episode = ep.episode;
    out.episodeEnd = ep.episodeEnd;
  } else {
    const sp = base.match(/\bs(\d{1,2})(?![\d])(?![\s._-]*e\d)/i) ?? base.match(/\b(?:season|sezonul)[\s._-]*(\d{1,2})\b/i);
    if (sp) {
      out.season = +sp[1];
      out.seasonPack = true;
    }
  }
  return out;
}

export interface MatchScore {
  score: number;
  reasons: string[];
  /** The subtitle is for another episode/season: never pick it automatically. */
  mismatch: boolean;
}

const WEB: ReleaseSource[] = ['web-dl', 'webrip', 'web'];
const DISC: ReleaseSource[] = ['remux', 'bluray'];

/**
 * Score one subtitle against the media file.
 *  - 100: OpenSubtitles file-hash match.
 *  - group + source match: 70 (+10 same resolution) — the best non-hash match.
 *  - same source only: 30 (+10 same resolution); compatible sources (WEB-DL vs WEBRip, BluRay vs REMUX): 15-25.
 *  - wrong episode/season: 0 and `mismatch`.
 * Release text may list several releases ("…-NTb / …-FLUX"); the best one counts.
 */
export function scoreRelease(media: ReleaseInfo, subtitleRelease: string | null | undefined, opts: { hashMatch?: boolean; season?: number | null; episode?: number | null; aiTranslated?: boolean } = {}): MatchScore {
  if (opts.hashMatch) return { score: 100, reasons: ['file hash match'], mismatch: false };
  const season = opts.season ?? media.season;
  const episode = opts.episode ?? media.episode;
  const variants = (subtitleRelease ?? '').split(/\s*(?:\/|\||;|\n|,\s(?=\S+[.-]\S+))\s*/).map((v) => v.trim()).filter(Boolean);
  if (!variants.length) variants.push('');
  let best: MatchScore | null = null;
  for (const v of variants) {
    const r = scoreOne(media, parseRelease(v), season, episode);
    if (!best || r.score > best.score || (best.mismatch && !r.mismatch)) best = r;
  }
  const out = best!;
  if (opts.aiTranslated && !out.mismatch) {
    out.score = Math.max(0, out.score - 20);
    out.reasons.push('machine translated');
  }
  return out;
}

function scoreOne(media: ReleaseInfo, sub: ReleaseInfo, season: number | null, episode: number | null): MatchScore {
  const reasons: string[] = [];
  if (season != null && sub.season != null && sub.season !== season) return { score: 0, reasons: [`for season ${sub.season}`], mismatch: true };
  if (episode != null && sub.episode != null && !(sub.episode === episode || (sub.episodeEnd != null && episode >= sub.episode && episode <= sub.episodeEnd))) {
    return { score: 0, reasons: [`for episode ${sub.episode}`], mismatch: true };
  }
  let score = 0;
  const sameGroup = !!media.group && !!sub.group && media.group.toLowerCase() === sub.group.toLowerCase();
  if (sameGroup) {
    score += 40;
    reasons.push('same group');
  }
  if (media.source && sub.source) {
    if (media.source === sub.source) {
      score += 30;
      reasons.push('same source');
    } else if (DISC.includes(media.source) && DISC.includes(sub.source)) {
      score += 25;
      reasons.push('Blu-ray family');
    } else if (WEB.includes(media.source) && WEB.includes(sub.source)) {
      score += media.source === 'web' || sub.source === 'web' ? 20 : 15;
      reasons.push('web family');
    }
  }
  if (media.resolution && sub.resolution && media.resolution === sub.resolution) {
    score += 10;
    reasons.push('same resolution');
  }
  if (episode != null && sub.episode === episode) {
    score += 5;
    reasons.push('episode named');
  } else if (sub.seasonPack) reasons.push('season pack');
  return { score: Math.min(99, score), reasons, mismatch: false };
}
