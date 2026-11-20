export const nowIso = () => new Date().toISOString();

/** Remote media must use a network protocol — never file:, concat:, pipe: etc. (a hostile playlist could read local files). */
export const SAFE_URL = /^(https?|rtmps?|rtsp|rtp|udp|srt):\/\//i;
export const isSafeRemoteUrl = (u: string | null | undefined) => !!u && SAFE_URL.test(u.trim());
/** FFmpeg input options that restrict remote inputs to network protocols. */
export const REMOTE_PROTOCOLS = ['-protocol_whitelist', 'http,https,tcp,tls,crypto,rtmp,rtmps,rtmpt,rtsp,rtp,udp,srt,httpproxy'];

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (s == null || s === '') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export const bool = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true';

export function toInt(v: unknown, def: number, min = -Infinity, max = Infinity): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export function sortTitle(title: string): string {
  return title
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .toLowerCase();
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run async tasks with limited concurrency. */
export async function pool<T>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

export function resolutionLabel(width: number | null, height: number | null): string | null {
  if (!width || !height) return null;
  if (width >= 3800 || height >= 2100) return '4K';
  if (width >= 2500 || height >= 1400) return '1440p';
  if (width >= 1900 || height >= 1000) return '1080p';
  if (width >= 1200 || height >= 700) return '720p';
  if (height >= 560) return '576p';
  if (height >= 470) return '480p';
  return 'SD';
}

/** Ordered content ratings → numeric level (US + UK + common TV ratings). */
const RATING_LEVELS: Record<string, number> = {
  // US film / TV
  'G': 0, 'TV-Y': 0, 'TV-G': 0, 'TV-Y7': 7, 'TV-Y7-FV': 7, 'PG': 10, 'TV-PG': 10, 'PG-13': 13, 'TV-14': 14, 'R': 17, 'TV-MA': 17, 'NC-17': 18,
  // UK (BBFC)
  'U': 0, 'UC': 0, '12A': 12, 'R18': 19,
  // Australia
  'E': 0, 'M': 15, 'MA15+': 15, 'MA 15+': 15, 'R18+': 18, 'R 18+': 18, 'X18+': 19, 'X 18+': 19, 'RC': 19, 'C': 0, 'P': 0,
  // Canada / misc
  '14A': 14, '18A': 18, 'A': 18,
  // Generic labels used by IPTV providers and streaming services
  'ALL': 0, 'ALL AGES': 0, 'KIDS': 0, 'FAMILY': 0, 'TEEN': 13, 'TEENS': 13, 'ADULT': 18, 'ADULTS': 18, 'XXX': 19, 'MATURE': 17,
};
/** Values that mean "no rating" (treated like NULL). */
const UNRATED = new Set(['NR', 'NOT RATED', 'UNRATED', 'N/A', 'NA', 'UR', '-', '']);

/**
 * Map a content rating from any common system to a minimum age. Returns null for unrated values and
 * -1 for ratings we don't recognise (callers treat those as "unrated", never as "allowed").
 */
export function ratingLevel(r: string | null | undefined): number | null {
  if (r == null) return null;
  const k = String(r).toUpperCase().trim().replace(/^(US|GB|UK|DE|AU|CA|FR|NL|IE|NZ|FSK|USK|PEGI)[\s:/-]+/, '').replace(/^AGE\s*/, '').replace(/\s+/g, ' ');
  if (UNRATED.has(k)) return null;
  if (k in RATING_LEVELS) return RATING_LEVELS[k];
  // Plain ages: "16", "16+", "Ab 16", "FSK 16", "PEGI 18", "-12".
  const age = k.match(/^(?:AB\s*)?-?(\d{1,2})\s*\+?$/);
  if (age) return Math.min(19, parseInt(age[1], 10));
  return -1;
}
