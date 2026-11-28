import type { EpisodeRatings } from '@mediamax/shared';
import { db } from '../db.js';
import { badRequest, notFound } from '../util/errors.js';
import { parseJson } from '../util/misc.js';
import { logger } from '../util/log.js';
import { getMetadataSettings } from './metadata/config.js';
import { omdbLookup } from './metadata/providers/omdb.js';
import * as tmdb from './metadata/tmdb.js';

const log = logger('episode-ratings');

/**
 * Season × episode ratings for a show's detail page (the colour-coded grid). IMDb ratings through OMDb when the admin
 * enabled it (one cached request per season), else TMDB's episode scores. Episodes in the library link to their
 * items; ratings for ones that aren't there are still shown. Seasons 1+ only (specials skipped).
 */
export async function episodeRatings(showId: string): Promise<EpisodeRatings> {
  const show = db.get<{ type: string; external_ids: string }>('SELECT type, external_ids FROM items WHERE id = ?', showId);
  if (!show) throw notFound('Item not found');
  if (show.type !== 'show') throw badRequest('Episode ratings are for shows');
  const ids = parseJson<Record<string, string>>(show.external_ids, {});
  const local = db.all<{ id: string; parent_idx: number; idx: number; title: string }>(
    "SELECT id, parent_idx, idx, title FROM items WHERE grandparent_id = ? AND type = 'episode' AND parent_idx >= 1 AND idx IS NOT NULL", showId);
  const localOf = (s: number, e: number) => local.find((x) => x.parent_idx === s && x.idx === e) ?? null;
  const seasonNumbers = [...new Set(local.map((x) => x.parent_idx))].sort((a, b) => a - b);

  const omdb = getMetadataSettings().providers.omdb;
  if (omdb?.enabled && omdb.apiKey && ids.imdb) {
    try {
      // Only the seasons in the library (OMDb's 1,000 requests a day are shared with metadata refreshes).
      const seasons: EpisodeRatings['seasons'] = [];
      for (const s of seasonNumbers.slice(0, 20)) {
        const j = await omdbLookup(omdb, { i: ids.imdb, Season: String(s) });
        const eps = (j?.Episodes ?? []) as { Episode?: string; Title?: string; imdbRating?: string }[];
        if (!eps.length) continue;
        seasons.push({
          season: s,
          episodes: eps.map((e) => {
            const n = Number(e.Episode);
            const rating = Number(e.imdbRating);
            return { episode: n, title: e.Title ?? null, rating: Number.isFinite(rating) ? rating : null, itemId: localOf(s, n)?.id ?? null };
          }).filter((e) => e.episode > 0),
        });
      }
      if (seasons.length) return { source: 'imdb', seasons };
    } catch (e) {
      log.debug(`OMDb episode ratings: ${(e as Error).message}`);
    }
  }

  // TMDB: the seasons the library has (a long-running show would otherwise cost dozens of requests).
  const seasons: EpisodeRatings['seasons'] = [];
  if (ids.tmdb && tmdb.tmdbEnabled()) {
    for (const s of seasonNumbers.slice(0, 40)) {
      const d = await tmdb.seasonDetails(ids.tmdb, s).catch(() => null);
      if (!d?.episodes.length) continue;
      seasons.push({ season: s, episodes: d.episodes.map((e) => ({ episode: e.episode, title: e.title, rating: e.rating ? Math.round(e.rating * 10) / 10 : null, itemId: localOf(s, e.episode)?.id ?? null })) });
    }
  }
  return { source: 'tmdb', seasons };
}
