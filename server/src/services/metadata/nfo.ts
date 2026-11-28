import fs from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import type { Person } from '@mediamax/shared';

/** Kodi/Jellyfin/Emby .nfo reader. */
export interface NfoData {
  title?: string;
  originalTitle?: string;
  sortTitle?: string;
  year?: number;
  overview?: string;
  tagline?: string;
  rating?: number;
  contentRating?: string;
  genres?: string[];
  studios?: string[];
  people?: Person[];
  releaseDate?: string;
  runtimeMin?: number;
  season?: number;
  episode?: number;
  /** mal: MyAnimeList id (`<uniqueid type="mal">`), used for AniSkip segments. */
  ids: { tmdb?: string; imdb?: string; tvdb?: string; mal?: string };
  trailer?: string;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', isArray: (name) => ['genre', 'studio', 'actor', 'director', 'credits', 'uniqueid', 'country', 'tag'].includes(name) });

const text = (v: any): string | undefined => {
  if (v == null) return undefined;
  if (typeof v === 'object') return v['#text'] != null ? String(v['#text']) : undefined;
  const s = String(v).trim();
  return s || undefined;
};

export function readNfo(file: string): NfoData | null {
  let xml: string;
  try {
    xml = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  return parseNfo(xml);
}

/** readNfo without blocking the server: a read from a slow or sleeping network share can take many seconds. */
export async function readNfoAsync(file: string): Promise<NfoData | null> {
  let xml: string;
  try {
    xml = await fs.promises.readFile(file, 'utf8');
  } catch {
    return null;
  }
  return parseNfo(xml);
}

export function parseNfo(xml: string): NfoData | null {
  // Some NFOs are just a URL (IMDb/TMDB link).
  if (!xml.trimStart().startsWith('<')) {
    const imdb = xml.match(/tt\d{7,9}/)?.[0];
    const tmdb = xml.match(/themoviedb\.org\/(?:movie|tv)\/(\d+)/)?.[1];
    return { ids: { imdb, tmdb } };
  }
  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch {
    return null;
  }
  const root = doc.movie ?? doc.tvshow ?? doc.episodedetails ?? doc.musicvideo ?? doc.season ?? null;
  if (!root) return null;
  const ids: NfoData['ids'] = {};
  for (const u of root.uniqueid ?? []) {
    const type = (u['@type'] ?? '').toLowerCase();
    const val = text(u);
    if (val && (type === 'tmdb' || type === 'imdb' || type === 'tvdb')) ids[type as 'tmdb'] = val;
    else if (val && (type === 'mal' || type === 'myanimelist') && /^\d{1,9}$/.test(val)) ids.mal = val;
  }
  if (!ids.imdb && text(root.imdbid)) ids.imdb = text(root.imdbid);
  if (!ids.tmdb && text(root.tmdbid)) ids.tmdb = text(root.tmdbid);
  if (!ids.imdb && typeof root.id === 'string' && /^tt\d+/.test(root.id)) ids.imdb = root.id;
  const ratingVal = root.ratings?.rating ? (Array.isArray(root.ratings.rating) ? root.ratings.rating[0] : root.ratings.rating)?.value : root.rating;
  const people: Person[] = [];
  for (const a of root.actor ?? []) {
    const name = text(a.name);
    if (name) people.push({ name, role: text(a.role) ?? null, kind: 'actor', imageUrl: text(a.thumb) ?? null });
  }
  for (const d of root.director ?? []) {
    const name = text(d);
    if (name) people.push({ name, role: null, kind: 'director', imageUrl: null });
  }
  for (const w of root.credits ?? []) {
    const name = text(w);
    if (name) people.push({ name, role: null, kind: 'writer', imageUrl: null });
  }
  const num = (v: any) => {
    const n = parseFloat(text(v) ?? '');
    return Number.isFinite(n) ? n : undefined;
  };
  const mpaa = text(root.mpaa)?.replace(/^Rated\s+/i, '').replace(/^(US|UK|GB):/i, '');
  return {
    title: text(root.title),
    originalTitle: text(root.originaltitle),
    sortTitle: text(root.sorttitle),
    year: num(root.year),
    overview: text(root.plot) ?? text(root.outline),
    tagline: text(root.tagline),
    rating: num(ratingVal),
    contentRating: mpaa,
    genres: (root.genre ?? []).map(text).filter(Boolean),
    studios: (root.studio ?? []).map(text).filter(Boolean),
    people,
    releaseDate: text(root.premiered) ?? text(root.aired) ?? text(root.releasedate),
    runtimeMin: num(root.runtime),
    season: num(root.season),
    episode: num(root.episode),
    ids,
    trailer: text(root.trailer),
  };
}
