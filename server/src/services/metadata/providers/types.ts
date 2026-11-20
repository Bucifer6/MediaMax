import type { ArtworkTarget, BuiltinProviderId, Chapter, EpisodeOrder, ItemRatings, ItemType, MatchCandidate, MetadataProviderConfig, Person } from '@mediamax/shared';
import type { Row } from '../../../db.js';

/** What a provider sees of an item (search terms and ids only — never user data). */
export interface ProviderItem {
  row: Row;
  id: string;
  type: ItemType;
  title: string;
  year: number | null;
  ids: Record<string, string>;
  /** Album → artist name, audiobook → author. */
  parentTitle: string | null;
  /** Shows: chosen episode ordering. */
  episodeOrder: EpisodeOrder;
  /** Fill-only (default) or replace (after "Fix match"). */
  replace: boolean;
}

export type ArtKind = 'poster' | 'backdrop' | 'logo' | 'thumb' | 'clearart' | 'discart' | 'banner';
export interface ArtCandidate {
  kind: ArtKind;
  url: string;
  /** Season poster for this season number (shows). */
  season?: number;
}

export interface RemoteEpisodeInfo {
  season: number;
  episode: number;
  absolute: number | null;
  title: string | null;
  overview: string | null;
  airDate: string | null;
  image: string | null;
}

export interface ProviderResult {
  fields?: {
    title?: string | null;
    overview?: string | null;
    tagline?: string | null;
    genres?: string[];
    year?: number | null;
    releaseDate?: string | null;
    communityRating?: number | null;
    contentRating?: string | null;
    studios?: string[];
    people?: Person[];
  };
  art?: ArtCandidate[];
  ids?: Record<string, string>;
  ratings?: ItemRatings;
  /** Merged into the item's provider_meta (chapters, series, artist facts). */
  meta?: {
    chapters?: Chapter[];
    series?: { name: string; index: number | null };
    artistInfo?: { formedYear?: number | null; country?: string | null; mood?: string | null; style?: string | null };
    isbn?: string;
    /** MusicBrainz release facts (release types, status, first release date, label, catalogue no., barcode). */
    mb?: Record<string, unknown>;
  };
  /** Shows: per-episode data in the show's chosen ordering. */
  episodes?: RemoteEpisodeInfo[];
  /** Episode data should override unlocked titles/overviews (non-aired order, or no TMDB). */
  episodesAuthoritative?: boolean;
}

export interface BuiltinProvider {
  id: BuiltinProviderId;
  name: string;
  types: ItemType[];
  key: 'required' | 'optional' | 'none';
  pin?: boolean;
  homepage: string;
  keyUrl: string | null;
  cost: string;
  description: string;
  rateLimit: string;
  artwork: ArtworkTarget[];
  fetch(item: ProviderItem, cfg: MetadataProviderConfig): Promise<ProviderResult | null>;
  /** Live check with the given config; resolves to a human message, throws on failure. */
  test(cfg: MetadataProviderConfig): Promise<string>;
  /** "Fix match" search for these item types. */
  search?(type: ItemType, query: string, year: number | null, cfg: MetadataProviderConfig, parentTitle: string | null): Promise<MatchCandidate[]>;
  /** External-id key written by "Fix match" (e.g. tvdb, asin, musicbrainzArtist). */
  matchIdKey?(type: ItemType): string;
  /** SQL condition (on items alias i) for items this provider could still fill. */
  missing?: { label: string; where: string };
}

export const stripHtml = (s: string | null | undefined): string | null => {
  if (!s) return null;
  const t = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p[^>]*>/gi, '\n\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n').trim();
  return t || null;
};

export const yearOf = (d: string | number | null | undefined): number | null => {
  const m = String(d ?? '').match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
};

/** "2008-01-20T00:00:00Z" → "2008-01-20" (date part only, if it looks like one). */
export const dateOf = (d: string | null | undefined): string | null => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null);

/** Metadata language "en-US" → ISO 639-1 "en". */
export const lang2 = (metadataLanguage: string | null | undefined) => (metadataLanguage || 'en-US').slice(0, 2).toLowerCase();
