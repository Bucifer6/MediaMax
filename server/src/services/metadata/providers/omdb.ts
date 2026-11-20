import type { ItemRatings, MetadataProviderConfig } from '@mediamax/shared';
import { baseUrl, providerFetch, ProviderError, url } from '../http.js';
import type { BuiltinProvider, ProviderItem, ProviderResult } from './types.js';

/**
 * OMDb (https://www.omdbapi.com, free key = 1,000 requests/day): ?i={imdb id} or ?t={title}&y={year}&type=movie|series.
 * Supplies IMDb, Rotten Tomatoes and Metacritic ratings (stored in Item.ratings) and fills gaps in plot, genres,
 * content rating and poster. Same logic as the omdb-ratings example plugin, which keeps working alongside.
 */

const na = (v: unknown): string | undefined => (typeof v === 'string' && v && v !== 'N/A' ? v : undefined);

export function omdbRatings(j: any): ItemRatings {
  const out: ItemRatings = {};
  const imdb = parseFloat(na(j.imdbRating) ?? '');
  if (Number.isFinite(imdb)) out.imdb = imdb;
  for (const r of j.Ratings ?? []) {
    const v = String(r.Value ?? '');
    if (r.Source === 'Rotten Tomatoes') {
      const n = parseInt(v, 10);
      if (Number.isFinite(n)) out.rottenTomatoes = n;
    } else if (r.Source === 'Metacritic') {
      const n = parseInt(v, 10);
      if (Number.isFinite(n)) out.metacritic = n;
    } else if (r.Source === 'Internet Movie Database' && out.imdb === undefined) {
      const n = parseFloat(v);
      if (Number.isFinite(n)) out.imdb = n;
    }
  }
  const ms = parseInt(na(j.Metascore) ?? '', 10);
  if (out.metacritic === undefined && Number.isFinite(ms)) out.metacritic = ms;
  return out;
}

async function lookup(cfg: MetadataProviderConfig, q: Record<string, string | undefined>, ttlHours?: number): Promise<any | null> {
  if (!cfg.apiKey) throw new ProviderError('OMDb needs an API key');
  let r;
  try {
    r = await providerFetch('omdb', url(baseUrl('omdb'), '/', { apikey: cfg.apiKey, ...q }), { ttlHours });
  } catch (e) {
    if ((e as ProviderError).status === 401) throw new ProviderError('OMDb rejected the API key (or its daily limit is used up)', 401);
    throw e;
  }
  const j = r.data;
  if (!j || j.Response !== 'True') {
    if (j?.Error && /api key/i.test(j.Error)) throw new ProviderError(`OMDb: ${j.Error}`, 401);
    return null;
  }
  return j;
}

async function fetchOmdb(item: ProviderItem, cfg: MetadataProviderConfig): Promise<ProviderResult | null> {
  if (item.type !== 'movie' && item.type !== 'show') return null;
  const j = item.ids.imdb
    ? await lookup(cfg, { i: item.ids.imdb })
    : await lookup(cfg, { t: item.title, y: item.year ? String(item.year) : undefined, type: item.type === 'show' ? 'series' : 'movie' });
  if (!j) return null;
  const ratings = omdbRatings(j);
  return {
    fields: {
      overview: na(j.Plot) ?? null,
      genres: na(j.Genre)?.split(',').map((g) => g.trim()).filter(Boolean) ?? [],
      contentRating: na(j.Rated) && !/^(not rated|unrated)$/i.test(j.Rated) ? j.Rated : null,
      communityRating: ratings.imdb ?? null,
    },
    art: na(j.Poster) ? [{ kind: 'poster', url: j.Poster }] : [],
    ids: na(j.imdbID) ? { imdb: j.imdbID } : {},
    ratings,
  };
}

export const omdb: BuiltinProvider = {
  id: 'omdb',
  name: 'OMDb',
  types: ['movie', 'show'],
  key: 'required',
  homepage: 'https://www.omdbapi.com',
  keyUrl: 'https://www.omdbapi.com/apikey.aspx',
  cost: 'Free key: 1,000 requests/day (Patreon tiers for more).',
  description: 'IMDb, Rotten Tomatoes and Metacritic ratings (shown as badges on the item page); fills missing plots, genres and posters.',
  rateLimit: '1,000 requests/day on the free key (enforced client-side); responses are cached.',
  artwork: ['movie', 'show'],
  fetch: fetchOmdb,
  async test(cfg) {
    const j = await lookup(cfg, { i: 'tt0133093' }, 0);
    if (!j) throw new ProviderError('OMDb returned no data for a known title');
    const r = omdbRatings(j);
    return `OMDb key works (${j.Title}: IMDb ${r.imdb ?? '–'}, RT ${r.rottenTomatoes ?? '–'}%, MC ${r.metacritic ?? '–'})`;
  },
  missing: { label: 'movies and shows without IMDb ratings', where: "i.type IN ('movie','show') AND json_extract(COALESCE(i.ratings, '{}'), '$.imdb') IS NULL" },
};
