/**
 * Discover parity with Overseerr: sliders (trending, popular, upcoming, top rated, by genre / studio / network),
 * person pages, recently requested / recently added rows, and a Discover watchlist that can auto-request.
 */
import type { DiscoverGenres, DiscoverPerson, DiscoverResult, DiscoverSlider, DiscoverWatchlistEntry, User } from '@mediamax/shared';
import { db } from '../db.js';
import { badRequest, notFound } from '../util/errors.js';
import { nowIso } from '../util/misc.js';
import { logger } from '../util/log.js';
import * as tmdb from './metadata/tmdb.js';
import { imageUrl, registerImage } from './images.js';
import { accessClause } from './items.js';
import { getSettings } from './settings.js';
import { createRequest, decorate, findAvailable, recentlyRequested } from './requests.js';
import { effectivePermissions } from './requestPerms.js';
import { forbidden } from '../util/errors.js';

const log = logger('discover');

/* Short in-memory cache for TMDB lists (Discover loads many sliders at once). */
const cache = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, fn: () => Promise<T>, ttlMs = 15 * 60_000): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  return v;
}

const FIXED: { key: DiscoverSlider['key']; title: string }[] = [
  { key: 'trending', title: 'Trending' },
  { key: 'popular-movies', title: 'Popular movies' },
  { key: 'upcoming-movies', title: 'Upcoming movies' },
  { key: 'popular-shows', title: 'Popular shows' },
  { key: 'upcoming-shows', title: 'Currently airing' },
  { key: 'top-movies', title: 'Top rated movies' },
  { key: 'top-shows', title: 'Top rated shows' },
];

function assertTmdb() {
  if (!tmdb.tmdbEnabled()) throw badRequest('Discover needs a TMDB API key (Admin → Settings → Metadata)');
}

export async function listPage(user: User, key: string, page: number, hideAvailable?: boolean): Promise<{ results: DiscoverResult[]; page: number; totalPages: number; title: string }> {
  assertTmdb();
  const r = await cached(`list:${key}:${page}`, () => tmdb.discoverList(key, page));
  if (!r) throw notFound('Unknown Discover list');
  return { ...r, results: decorate(user, r.results, { hideAvailable }), title: await sliderTitle(key) };
}

async function sliderTitle(key: string): Promise<string> {
  const fixed = FIXED.find((f) => f.key === key);
  if (fixed) return fixed.title;
  const m = key.match(/^(movie-genre|show-genre|studio|network)-(\d+)$/);
  if (!m) return key;
  if (m[1].endsWith('genre')) {
    const g = await genres();
    const name = (m[1] === 'movie-genre' ? g.movie : g.show).find((x) => String(x.id) === m[2])?.name ?? 'Genre';
    return `${name} ${m[1] === 'movie-genre' ? 'movies' : 'shows'}`;
  }
  return (await cached(`co:${key}`, () => tmdb.companyName(m[1] as 'studio' | 'network', m[2]), 24 * 3600_000)) ?? (m[1] === 'studio' ? 'Studio' : 'Network');
}

export const genres = (): Promise<DiscoverGenres> => cached('genres', () => tmdb.genres(), 24 * 3600_000);

/** Recently added movies/shows the viewer can see, as Discover cards (link to the library item). */
function recentlyAdded(user: User, limit = 20): DiscoverResult[] {
  const a = accessClause(user);
  return db.all(`SELECT i.id, i.type, i.title, i.year, i.poster, i.external_ids FROM items i WHERE i.type IN ('movie','show') AND ${a.sql} ORDER BY i.added_at DESC LIMIT ?`, ...a.params, limit)
    .map((r) => {
      const tmdbId = String(JSON.parse(r.external_ids ?? '{}').tmdb ?? '') || r.id;
      return {
        tmdbId, externalId: tmdbId, mediaType: r.type, title: r.title, year: r.year ?? null, overview: null, rating: null,
        posterUrl: imageUrl(r.poster), backdropUrl: null, availableItemId: r.id, requestId: null, requestStatus: null,
      } as DiscoverResult;
    });
}

/** The Discover home: watchlist, recently added/requested, then the TMDB sliders. */
export async function sliders(user: User, hideAvailable?: boolean): Promise<DiscoverSlider[]> {
  const out: DiscoverSlider[] = [];
  const wl = watchlist(user);
  if (wl.length) {
    out.push({
      key: 'watchlist', title: 'Your watchlist', results: wl.map((w) => ({
        tmdbId: w.externalId, externalId: w.externalId, mediaType: w.mediaType, title: w.title, year: w.year, overview: null, rating: null,
        posterUrl: w.posterUrl, backdropUrl: null, availableItemId: w.availableItemId, requestId: w.requestId, requestStatus: null, onWatchlist: true,
      })),
    });
  }
  const added = recentlyAdded(user);
  if (added.length) out.push({ key: 'recently-added', title: 'Recently added', results: added });
  const reqd = recentlyRequested(user);
  if (reqd.length) out.push({ key: 'recently-requested', title: 'Recently requested', results: reqd });
  if (!tmdb.tmdbEnabled()) return out;
  const lists = await Promise.all(FIXED.map((f) => cached(`list:${f.key}:1`, () => tmdb.discoverList(f.key, 1)).catch((e) => {
    log.warn(`Discover list ${f.key} failed: ${(e as Error).message}`);
    return null;
  })));
  FIXED.forEach((f, i) => {
    const r = lists[i];
    if (r?.results.length) out.push({ key: f.key, title: f.title, results: decorate(user, r.results, { hideAvailable }) });
  });
  return out;
}

export async function personPage(user: User, id: string): Promise<DiscoverPerson> {
  assertTmdb();
  if (!/^\d{1,12}$/.test(id)) throw badRequest('Invalid person id');
  const p = await cached(`person:${id}`, () => tmdb.person(id), 3600_000);
  if (!p) throw notFound('Person not found');
  const deco = <T extends tmdb.TmdbListResult>(list: T[]) => {
    const cards = decorate(user, list);
    const byKey = new Map(cards.map((c) => [`${c.mediaType}:${c.tmdbId}`, c]));
    return list.flatMap((x) => {
      const c = byKey.get(`${x.mediaType}:${x.id}`);
      return c ? [{ c, x }] : [];
    });
  };
  return {
    id: p.id, name: p.name, biography: p.biography, birthday: p.birthday, deathday: p.deathday, placeOfBirth: p.placeOfBirth, knownFor: p.knownFor,
    profileUrl: imageUrl(registerImage(p.profile)),
    cast: deco(p.cast).map(({ c, x }) => ({ ...c, character: x.character })),
    crew: deco(p.crew).map(({ c, x }) => ({ ...c, job: x.job })),
  };
}

export async function searchPeople(q: string) {
  assertTmdb();
  const term = q.trim();
  if (!term) return [];
  return (await tmdb.searchPeople(term)).map((p) => ({ ...p, profileUrl: imageUrl(registerImage(p.profile)) }));
}

/* ------------------------------ watchlist ------------------------------ */

export function watchlist(user: User): DiscoverWatchlistEntry[] {
  return db.all('SELECT w.*, r.status req_status FROM discover_watchlist w LEFT JOIN media_requests r ON r.id = w.request_id WHERE w.user_id = ? ORDER BY w.added_at DESC', user.id).map((r) => ({
    mediaType: r.media_type, externalId: r.external_id, title: r.title, year: r.year ?? null, posterUrl: imageUrl(r.poster), addedAt: r.added_at,
    requestId: r.request_id ?? null, autoRequestError: r.auto_error ?? null, availableItemId: findAvailable(r.external_id, r.media_type),
  }));
}

/**
 * Add a title to the viewer's Discover watchlist. With the "watchlist auto-request" permission, titles that aren't in
 * the library are requested right away (permissions, quotas and the blacklist still apply; the reason is kept if not).
 */
export async function addToWatchlist(user: User, b: { mediaType: 'movie' | 'show'; tmdbId: string }): Promise<DiscoverWatchlistEntry> {
  assertTmdb();
  if (b?.mediaType !== 'movie' && b?.mediaType !== 'show') throw badRequest('mediaType must be movie or show');
  const id = String(b.tmdbId ?? '');
  if (!/^\d+$/.test(id)) throw badRequest('Invalid TMDB id');
  const m = b.mediaType === 'movie' ? await tmdb.movieDetails(id) : await tmdb.tvDetails(id);
  if (!m) throw notFound('Title not found on TMDB');
  db.upsert('discover_watchlist', {
    user_id: user.id, media_type: b.mediaType, external_id: id, title: m.title, year: m.year ?? null, poster: registerImage(m.poster), added_at: nowIso(),
  }, 'user_id,media_type,external_id');
  if (effectivePermissions(user).watchlistAutoRequest && getSettings().requests.enabled && !findAvailable(id, b.mediaType)) {
    const open = db.get("SELECT id FROM media_requests WHERE tmdb_id = ? AND media_type = ? AND status IN ('pending','approved','processing','available')", id, b.mediaType);
    if (open) db.run('UPDATE discover_watchlist SET request_id = ?, auto_error = NULL WHERE user_id = ? AND media_type = ? AND external_id = ?', open.id, user.id, b.mediaType, id);
    else {
      try {
        const r = await createRequest(user, { mediaType: b.mediaType, tmdbId: id, title: m.title }, 'watchlist');
        db.run('UPDATE discover_watchlist SET request_id = ?, auto_error = NULL WHERE user_id = ? AND media_type = ? AND external_id = ?', r.id, user.id, b.mediaType, id);
      } catch (e) {
        db.run('UPDATE discover_watchlist SET auto_error = ? WHERE user_id = ? AND media_type = ? AND external_id = ?', (e as Error).message.slice(0, 300), user.id, b.mediaType, id);
      }
    }
  }
  const entry = watchlist(user).find((w) => w.mediaType === b.mediaType && w.externalId === id);
  if (!entry) throw forbidden();
  return entry;
}

export function removeFromWatchlist(user: User, mediaType: string, tmdbId: string) {
  db.run('DELETE FROM discover_watchlist WHERE user_id = ? AND media_type = ? AND external_id = ?', user.id, mediaType, tmdbId);
}
