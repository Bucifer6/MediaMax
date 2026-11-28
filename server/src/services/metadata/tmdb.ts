import type { Person } from '@mediamax/shared';
import { getSettings } from '../settings.js';
import { logger } from '../../util/log.js';
import { sleep } from '../../util/misc.js';

const log = logger('tmdb');
const API = process.env.MEDIAMAX_TMDB_API_BASE ?? 'https://api.themoviedb.org/3'; // override only for tests
const IMG = process.env.MEDIAMAX_TMDB_IMAGE_BASE ?? 'https://image.tmdb.org/t/p/'; // override only for tests and screenshots

export interface RemoteMeta {
  tmdbId: string;
  imdbId?: string | null;
  tvdbId?: string | null;
  title: string;
  originalTitle?: string | null;
  /** ISO 639-1, e.g. "ja" (TMDB original_language). */
  originalLanguage?: string | null;
  /** Production companies (movies) or networks (shows) with TMDB ids and logo URLs. */
  companies?: { id: string; name: string; kind: 'studio' | 'network'; logo: string | null }[];
  overview?: string | null;
  tagline?: string | null;
  year?: number | null;
  releaseDate?: string | null;
  rating?: number | null;
  contentRating?: string | null;
  genres?: string[];
  studios?: string[];
  people?: Person[];
  runtimeMin?: number | null;
  poster?: string | null;
  backdrop?: string | null;
  logo?: string | null;
  trailerUrl?: string | null;
  collection?: { id: string; name: string; poster: string | null; backdrop: string | null } | null;
  /** Shows only: airing status and the next episode to air (for the calendar). */
  schedule?: TvSchedule | null;
}

export interface TvSchedule {
  status: string | null;
  inProduction: boolean | null;
  lastAirDate: string | null;
  next: { airDate: string; season: number | null; episode: number | null; title: string | null; overview: string | null } | null;
}

/** Status + next airing episode from a TMDB `/tv/{id}` response. */
export function scheduleFrom(t: any): TvSchedule {
  const n = t?.next_episode_to_air;
  return {
    status: typeof t?.status === 'string' ? t.status : null,
    inProduction: typeof t?.in_production === 'boolean' ? t.in_production : null,
    lastAirDate: t?.last_air_date || null,
    next: n?.air_date
      ? { airDate: String(n.air_date).slice(0, 10), season: n.season_number ?? null, episode: n.episode_number ?? null, title: n.name || null, overview: n.overview || null }
      : null,
  };
}

/** Just the airing schedule of a show (cheap: no credits/images). */
export async function tvSchedule(id: string): Promise<TvSchedule | null> {
  const t = await call<any>(`/tv/${id}`);
  return t ? scheduleFrom(t) : null;
}

export interface RemoteEpisode {
  season: number;
  episode: number;
  title: string;
  overview: string | null;
  airDate: string | null;
  rating: number | null;
  still: string | null;
  runtimeMin: number | null;
  people: Person[];
}

export const tmdbEnabled = () => !!getSettings().tmdbApiKey;

let lastCall = 0;
async function call<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T | null> {
  const key = getSettings().tmdbApiKey;
  if (!key) return null;
  const url = new URL(API + path);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (key.length > 40) headers.Authorization = `Bearer ${key}`;
  else url.searchParams.set('api_key', key);
  url.searchParams.set('language', getSettings().metadataLanguage || 'en-US');
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  // Gentle client-side rate limit (~35 req/s max).
  const wait = lastCall + 30 - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (res.status === 429) {
        await sleep(1000 * (attempt + 1) * 2);
        continue;
      }
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`TMDB ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      if (attempt === 2) {
        log.warn(`TMDB request failed ${path}`, (e as Error).message);
        return null;
      }
      await sleep(500 * (attempt + 1));
    }
  }
  return null;
}

const img = (p: string | null | undefined, size: string) => (p ? `${IMG}${size}${p}` : null);

function pickLogo(images: any): string | null {
  const logos: any[] = images?.logos ?? [];
  const lang = (getSettings().metadataLanguage || 'en').slice(0, 2);
  const best = logos.find((l) => l.iso_639_1 === lang && !l.file_path.endsWith('.svg')) ?? logos.find((l) => l.iso_639_1 === 'en') ?? logos[0];
  return best ? img(best.file_path, 'w500') : null;
}

function credits(c: any, limit = 20): Person[] {
  const people: Person[] = [];
  for (const a of (c?.cast ?? []).slice(0, limit)) people.push({ name: a.name, role: a.character ?? null, kind: 'actor', imageUrl: img(a.profile_path, 'w185') });
  for (const crew of c?.crew ?? []) {
    if (crew.job === 'Director') people.push({ name: crew.name, role: null, kind: 'director', imageUrl: img(crew.profile_path, 'w185') });
    else if (crew.job === 'Screenplay' || crew.job === 'Writer' || crew.job === 'Creator') people.push({ name: crew.name, role: crew.job, kind: 'writer', imageUrl: img(crew.profile_path, 'w185') });
  }
  return people;
}

function trailer(videos: any): string | null {
  const v = (videos?.results ?? []).find((x: any) => x.site === 'YouTube' && x.type === 'Trailer') ?? (videos?.results ?? []).find((x: any) => x.site === 'YouTube');
  return v ? `https://www.youtube.com/watch?v=${v.key}` : null;
}

export async function findByImdb(imdbId: string): Promise<{ movie?: string; tv?: string }> {
  const r = await call<any>(`/find/${imdbId}`, { external_source: 'imdb_id' });
  return { movie: r?.movie_results?.[0]?.id?.toString(), tv: r?.tv_results?.[0]?.id?.toString() };
}

/** TMDB show id for a TheTVDB series id. */
export async function findByTvdb(tvdbId: string): Promise<string | null> {
  const r = await call<any>(`/find/${encodeURIComponent(tvdbId)}`, { external_source: 'tvdb_id' });
  return r?.tv_results?.[0]?.id?.toString() ?? null;
}

export async function searchMovie(title: string, year?: number | null): Promise<string | null> {
  let r = await call<any>('/search/movie', { query: title, year: year ?? undefined, include_adult: 'false' });
  if (!r?.results?.length && year) r = await call<any>('/search/movie', { query: title, primary_release_year: year - 1 });
  if (!r?.results?.length && year) r = await call<any>('/search/movie', { query: title });
  const results: any[] = r?.results ?? [];
  if (!results.length) return null;
  // Prefer exact title + year matches.
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const exact = results.find((m) => norm(m.title) === norm(title) && (!year || m.release_date?.startsWith(String(year))));
  return String((exact ?? results[0]).id);
}

export async function movieDetails(id: string): Promise<RemoteMeta | null> {
  const m = await call<any>(`/movie/${id}`, { append_to_response: 'credits,images,release_dates,videos', include_image_language: 'en,null' });
  if (!m) return null;
  const country = (getSettings().metadataLanguage || 'en-US').split('-')[1] ?? 'US';
  const rel = (m.release_dates?.results ?? []).find((r: any) => r.iso_3166_1 === country) ?? (m.release_dates?.results ?? []).find((r: any) => r.iso_3166_1 === 'US');
  const cert = rel?.release_dates?.find((d: any) => d.certification)?.certification ?? null;
  return {
    tmdbId: String(m.id),
    imdbId: m.imdb_id ?? null,
    title: m.title,
    originalTitle: m.original_title !== m.title ? m.original_title : null,
    originalLanguage: m.original_language || null,
    overview: m.overview || null,
    tagline: m.tagline || null,
    year: m.release_date ? +m.release_date.slice(0, 4) : null,
    releaseDate: m.release_date || null,
    rating: m.vote_average ? Math.round(m.vote_average * 10) / 10 : null,
    contentRating: cert,
    genres: (m.genres ?? []).map((g: any) => g.name),
    studios: (m.production_companies ?? []).slice(0, 3).map((c: any) => c.name),
    companies: (m.production_companies ?? []).slice(0, 4).map((c: any) => ({ id: String(c.id), name: String(c.name), kind: 'studio' as const, logo: img(c.logo_path, 'w300') })),
    people: credits(m.credits),
    runtimeMin: m.runtime ?? null,
    poster: img(m.poster_path, 'w780'),
    backdrop: img(m.backdrop_path, 'w1280'),
    logo: pickLogo(m.images),
    trailerUrl: trailer(m.videos),
    collection: m.belongs_to_collection
      ? { id: String(m.belongs_to_collection.id), name: m.belongs_to_collection.name, poster: img(m.belongs_to_collection.poster_path, 'w780'), backdrop: img(m.belongs_to_collection.backdrop_path, 'w1280') }
      : null,
  };
}

export async function searchTv(title: string, year?: number | null): Promise<string | null> {
  let r = await call<any>('/search/tv', { query: title, first_air_date_year: year ?? undefined });
  if (!r?.results?.length && year) r = await call<any>('/search/tv', { query: title });
  const results: any[] = r?.results ?? [];
  if (!results.length) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const exact = results.find((m) => norm(m.name) === norm(title));
  return String((exact ?? results[0]).id);
}

export async function tvDetails(id: string): Promise<RemoteMeta | null> {
  const t = await call<any>(`/tv/${id}`, { append_to_response: 'credits,images,content_ratings,external_ids,videos', include_image_language: 'en,null' });
  if (!t) return null;
  const country = (getSettings().metadataLanguage || 'en-US').split('-')[1] ?? 'US';
  const cr = (t.content_ratings?.results ?? []).find((r: any) => r.iso_3166_1 === country) ?? (t.content_ratings?.results ?? []).find((r: any) => r.iso_3166_1 === 'US');
  const people = credits(t.credits);
  for (const c of t.created_by ?? []) people.push({ name: c.name, role: 'Creator', kind: 'writer', imageUrl: img(c.profile_path, 'w185') });
  return {
    tmdbId: String(t.id),
    imdbId: t.external_ids?.imdb_id ?? null,
    tvdbId: t.external_ids?.tvdb_id ? String(t.external_ids.tvdb_id) : null,
    title: t.name,
    originalTitle: t.original_name !== t.name ? t.original_name : null,
    originalLanguage: t.original_language || null,
    overview: t.overview || null,
    tagline: t.tagline || null,
    year: t.first_air_date ? +t.first_air_date.slice(0, 4) : null,
    releaseDate: t.first_air_date || null,
    rating: t.vote_average ? Math.round(t.vote_average * 10) / 10 : null,
    contentRating: cr?.rating ?? null,
    genres: (t.genres ?? []).map((g: any) => g.name),
    studios: (t.networks ?? []).slice(0, 3).map((c: any) => c.name),
    companies: (t.networks ?? []).slice(0, 4).map((c: any) => ({ id: String(c.id), name: String(c.name), kind: 'network' as const, logo: img(c.logo_path, 'w300') })),
    people,
    runtimeMin: t.episode_run_time?.[0] ?? null,
    poster: img(t.poster_path, 'w780'),
    backdrop: img(t.backdrop_path, 'w1280'),
    logo: pickLogo(t.images),
    trailerUrl: trailer(t.videos),
    schedule: scheduleFrom(t),
  };
}

export async function seasonDetails(tvId: string, season: number): Promise<{ poster: string | null; overview: string | null; name: string | null; episodes: RemoteEpisode[] } | null> {
  const s = await call<any>(`/tv/${tvId}/season/${season}`);
  if (!s) return null;
  return {
    poster: img(s.poster_path, 'w780'),
    overview: s.overview || null,
    name: s.name ?? null,
    episodes: (s.episodes ?? []).map((e: any) => ({
      season: e.season_number,
      episode: e.episode_number,
      title: e.name,
      overview: e.overview || null,
      airDate: e.air_date || null,
      rating: e.vote_average || null,
      still: img(e.still_path, 'w780'),
      runtimeMin: e.runtime ?? null,
      people: (e.guest_stars ?? []).slice(0, 8).map((g: any) => ({ name: g.name, role: g.character ?? null, kind: 'actor' as const, imageUrl: img(g.profile_path, 'w185') })),
    })),
  };
}

/* ----------------------------- discover ---------------------------- */

export interface TmdbListResult {
  id: string;
  mediaType: 'movie' | 'show';
  title: string;
  year: number | null;
  overview: string | null;
  poster: string | null;
  backdrop: string | null;
  rating: number | null;
}

function mapListItem(r: any, forced?: 'movie' | 'show'): TmdbListResult | null {
  const mt = forced ?? (r.media_type === 'tv' ? 'show' : r.media_type === 'movie' ? 'movie' : null);
  if (!mt) return null;
  const date = r.release_date || r.first_air_date || '';
  return {
    id: String(r.id), mediaType: mt, title: r.title ?? r.name ?? 'Untitled', year: date ? +date.slice(0, 4) : null,
    overview: r.overview || null, poster: img(r.poster_path, 'w500'), backdrop: img(r.backdrop_path, 'w1280'), rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : null,
  };
}

/** Search movies + TV (or trending when the query is empty). */
export async function discover(query: string, type: 'movie' | 'show' | 'all', page: number): Promise<{ results: TmdbListResult[]; page: number; totalPages: number }> {
  const q = query.trim();
  let r: any;
  if (q) r = await call<any>(type === 'movie' ? '/search/movie' : type === 'show' ? '/search/tv' : '/search/multi', { query: q, page, include_adult: 'false' });
  else r = await call<any>(type === 'movie' ? '/trending/movie/week' : type === 'show' ? '/trending/tv/week' : '/trending/all/week', { page });
  const forced = type === 'movie' ? 'movie' : type === 'show' ? 'show' : undefined;
  return {
    results: (r?.results ?? []).map((x: any) => mapListItem(x, forced)).filter(Boolean) as TmdbListResult[],
    page: r?.page ?? page,
    totalPages: Math.min(r?.total_pages ?? 1, 50),
  };
}

export async function tvExternalIds(id: string): Promise<{ tvdb: string | null; imdb: string | null }> {
  const r = await call<any>(`/tv/${id}/external_ids`);
  return { tvdb: r?.tvdb_id ? String(r.tvdb_id) : null, imdb: r?.imdb_id ?? null };
}

/* ------------------------ requests / Discover ------------------------ */

export interface TmdbSeason {
  seasonNumber: number;
  name: string;
  episodeCount: number;
  airDate: string | null;
}

/** A show's seasons (with episode counts) for the request dialog and quota counting. */
export async function tvSeasons(id: string): Promise<{ title: string; seasons: TmdbSeason[]; tvdbId: string | null; rating: number | null } | null> {
  const t = await call<any>(`/tv/${id}`, { append_to_response: 'external_ids' });
  if (!t) return null;
  return {
    title: t.name,
    tvdbId: t.external_ids?.tvdb_id ? String(t.external_ids.tvdb_id) : null,
    rating: t.vote_average ? Math.round(t.vote_average * 10) / 10 : null,
    seasons: (t.seasons ?? []).map((s: any) => ({ seasonNumber: s.season_number, name: s.name || `Season ${s.season_number}`, episodeCount: s.episode_count ?? 0, airDate: s.air_date || null }))
      .sort((a: TmdbSeason, b: TmdbSeason) => a.seasonNumber - b.seasonNumber),
  };
}

const LIST_PATHS: Record<string, [string, 'movie' | 'show' | undefined, Record<string, string>?]> = {
  trending: ['/trending/all/week', undefined],
  'popular-movies': ['/movie/popular', 'movie'],
  'popular-shows': ['/tv/popular', 'show'],
  'upcoming-movies': ['/movie/upcoming', 'movie'],
  'upcoming-shows': ['/tv/on_the_air', 'show'],
  'top-movies': ['/movie/top_rated', 'movie'],
  'top-shows': ['/tv/top_rated', 'show'],
};

/** One page of a Discover slider: fixed lists, or by genre / studio (movies) / network (shows). */
export async function discoverList(key: string, page = 1): Promise<{ results: TmdbListResult[]; page: number; totalPages: number } | null> {
  let path: string;
  let forced: 'movie' | 'show' | undefined;
  let params: Record<string, string | number> = { page };
  const m = key.match(/^(movie-genre|show-genre|studio|network)-(\d{1,9})$/);
  if (LIST_PATHS[key]) {
    [path, forced] = LIST_PATHS[key];
  } else if (m) {
    const show = m[1] === 'show-genre' || m[1] === 'network';
    path = show ? '/discover/tv' : '/discover/movie';
    forced = show ? 'show' : 'movie';
    const filter = m[1].endsWith('genre') ? 'with_genres' : m[1] === 'studio' ? 'with_companies' : 'with_networks';
    params = { ...params, [filter]: m[2], sort_by: 'popularity.desc', include_adult: 'false' };
  } else return null;
  const r = await call<any>(path, params);
  return {
    results: (r?.results ?? []).map((x: any) => mapListItem(x, forced)).filter(Boolean) as TmdbListResult[],
    page: r?.page ?? page,
    totalPages: Math.min(r?.total_pages ?? 1, 50),
  };
}

export async function genres(): Promise<{ movie: { id: number; name: string }[]; show: { id: number; name: string }[] }> {
  const [m, t] = await Promise.all([call<any>('/genre/movie/list'), call<any>('/genre/tv/list')]);
  return { movie: m?.genres ?? [], show: t?.genres ?? [] };
}

/** Name of a studio (company) or TV network, for slider titles. */
export async function companyName(kind: 'studio' | 'network', id: string): Promise<string | null> {
  const r = await call<any>(kind === 'studio' ? `/company/${id}` : `/network/${id}`);
  return r?.name ?? null;
}

export interface TmdbPerson {
  id: string;
  name: string;
  biography: string | null;
  birthday: string | null;
  deathday: string | null;
  placeOfBirth: string | null;
  knownFor: string | null;
  profile: string | null;
  cast: (TmdbListResult & { character: string | null })[];
  crew: (TmdbListResult & { job: string | null })[];
}

export async function person(id: string): Promise<TmdbPerson | null> {
  const p = await call<any>(`/person/${id}`, { append_to_response: 'combined_credits' });
  if (!p) return null;
  const pop = (a: any, b: any) => (b.popularity ?? 0) - (a.popularity ?? 0);
  const seen = new Set<string>();
  const uniq = <T extends TmdbListResult>(x: T | null): x is T => {
    if (!x) return false;
    const k = `${x.mediaType}:${x.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };
  const cast = [...(p.combined_credits?.cast ?? [])].sort(pop).map((c: any) => {
    const x = mapListItem(c);
    return x ? { ...x, character: c.character || null } : null;
  }).filter(uniq).slice(0, 80);
  seen.clear();
  const crew = [...(p.combined_credits?.crew ?? [])].sort(pop).map((c: any) => {
    const x = mapListItem(c);
    return x ? { ...x, job: c.job || null } : null;
  }).filter(uniq).slice(0, 60);
  return {
    id: String(p.id), name: p.name, biography: p.biography || null, birthday: p.birthday || null, deathday: p.deathday || null,
    placeOfBirth: p.place_of_birth || null, knownFor: p.known_for_department || null, profile: img(p.profile_path, 'h632'), cast, crew,
  };
}

/** Search people (for the Discover person search). */
export async function searchPeople(q: string): Promise<{ id: string; name: string; profile: string | null; knownFor: string | null }[]> {
  const r = await call<any>('/search/person', { query: q, include_adult: 'false' });
  return (r?.results ?? []).slice(0, 20).map((p: any) => ({ id: String(p.id), name: p.name, profile: img(p.profile_path, 'w185'), knownFor: p.known_for_department || null }));
}
