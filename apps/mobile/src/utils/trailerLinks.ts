/** Pure trailer helpers (no React Native imports, so tests/trailer.test.mjs can load them). See ./trailer.ts. */
import type { Item } from '@/api/types';

/** YouTube video id from a watch / youtu.be / embed / shorts link, or null. */
export function youtubeId(url: string | null | undefined): string | null {
  if (!url || !/youtube(?:-nocookie)?\.com|youtu\.be/i.test(url)) return null;
  const m = url.match(/(?:[?&]v=|youtu\.be\/|embed\/|shorts\/)([\w-]{6,})/);
  return m ? m[1] : null;
}

/** The first local trailer among an item's extras. */
export function localTrailer(extras: Pick<Item, 'id' | 'extraType'>[] | null | undefined): Pick<Item, 'id' | 'extraType'> | null {
  return extras?.find((x) => x.extraType === 'trailer') ?? null;
}

/**
 * URLs to try, in order, for a remote trailer. Android TV / Fire TV have no browser: ask the YouTube app directly
 * (`vnd.youtube:` first, then the https watch link it also claims). Phones keep the original link.
 */
export function trailerUrlsFor(url: string, tv: boolean): string[] {
  const id = youtubeId(url);
  if (!id || !tv) return [url];
  return [`vnd.youtube:${id}`, `https://www.youtube.com/watch?v=${id}`];
}
