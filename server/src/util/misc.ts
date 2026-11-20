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
  'G': 0, 'TV-Y': 0, 'TV-G': 0, 'U': 0, 'TV-Y7': 7, 'TV-Y7-FV': 7, 'PG': 10, 'TV-PG': 10,
  '12': 12, '12A': 12, 'PG-13': 13, 'TV-14': 14, '15': 15, 'R': 17, 'TV-MA': 17, 'NC-17': 18, '18': 18, 'R18': 19, 'X': 19,
};
export function ratingLevel(r: string | null | undefined): number | null {
  if (!r) return null;
  const k = r.toUpperCase().replace(/^(US|GB|UK)[:/-]/, '').trim();
  return RATING_LEVELS[k] ?? null;
}
