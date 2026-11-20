import { baseUrl, providerFetch, url } from '../http.js';
import type { BuiltinProvider } from './types.js';

/**
 * LRCLIB (https://lrclib.net, no key): GET /api/get?track_name&artist_name&album_name&duration →
 * { id, trackName, artistName, albumName, duration, instrumental, plainLyrics, syncedLyrics } or 404.
 * Used by services/lyrics.ts when a track has no .lrc file or embedded lyrics; results (and misses) are cached.
 */

export interface LrclibHit {
  synced: string | null;
  plain: string | null;
  instrumental: boolean;
}

export async function lrclibGet(q: { track: string; artist: string; album?: string | null; durationSec?: number | null }, ttlHours?: number): Promise<LrclibHit | null> {
  const params = { track_name: q.track, artist_name: q.artist, album_name: q.album ?? undefined, duration: q.durationSec ? Math.round(q.durationSec) : undefined };
  const r = await providerFetch<any>('lrclib', url(baseUrl('lrclib'), '/get', params), { ttlHours });
  const d = r.data;
  if (!d) return null;
  return { synced: d.syncedLyrics || null, plain: d.plainLyrics || null, instrumental: !!d.instrumental };
}

export const lrclib: BuiltinProvider = {
  id: 'lrclib',
  name: 'LRCLIB',
  types: ['track'],
  key: 'none',
  homepage: 'https://lrclib.net',
  keyUrl: null,
  cost: 'Free, no key.',
  description: 'Synced (time-stamped) lyrics for tracks without a local .lrc file or embedded lyrics. Fetched when lyrics are first opened, then cached.',
  rateLimit: '~10 requests/second (client-side); hits and misses are cached.',
  artwork: [],
  // Lyrics are fetched on demand by the lyrics endpoint, not during metadata refreshes.
  fetch: async () => null,
  async test() {
    const hit = await lrclibGet({ track: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', durationSec: 354 }, 0);
    if (!hit) throw new Error('LRCLIB returned nothing for a known track');
    return `LRCLIB works (${hit.synced ? 'synced' : hit.plain ? 'plain' : 'instrumental'} lyrics found)`;
  },
};
