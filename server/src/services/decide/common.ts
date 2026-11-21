/**
 * Shared building blocks for the "help us decide" features (Movie Match, Roulette, Random marathon):
 * group access filters, mood presets, the filter → SQL builder and a seeded RNG.
 *
 * Access is never re-implemented here: every query is restricted with items.accessClause() for each viewer, so
 * library access, parental ratings, "hide unrated" and kids profiles behave exactly like the rest of the app.
 */
import type { RouletteFilters, RouletteMood, RouletteMoodPreset, User } from '@mediamax/shared';
import type { Param } from '../../db.js';
import { accessClause, allowedLibraryIds } from '../items.js';
import { ratingLevel } from '../../util/misc.js';

/** mulberry32: small, fast, deterministic PRNG in [0, 1). */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const rngFor = (seed?: number | null) => (typeof seed === 'number' && Number.isFinite(seed) ? seededRng(seed) : Math.random);

/** In-place Fisher–Yates shuffle with the given RNG. */
export function shuffle<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Weighted pick: index of the chosen weight (weights ≤ 0 are never picked unless all are). */
export function weightedIndex(weights: number[], rng: () => number): number {
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (total <= 0) return Math.floor(rng() * weights.length);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= Math.max(0, weights[i]);
    if (r < 0) return i;
  }
  return weights.length - 1;
}

/** Access restriction that every user in `users` passes (AND of each member's own accessClause). */
export function groupAccess(users: User[], alias = 'i'): { sql: string; params: Param[] } {
  const parts: string[] = [];
  const params: Param[] = [];
  for (const u of users) {
    const a = accessClause(u, alias);
    parts.push(`(${a.sql})`);
    params.push(...a.params);
  }
  return { sql: parts.length ? parts.join(' AND ') : '0', params };
}

/** Libraries every user in the group may open. */
export function groupLibraryIds(users: User[]): string[] {
  if (!users.length) return [];
  let ids = allowedLibraryIds(users[0]);
  for (const u of users.slice(1)) {
    const mine = new Set(allowedLibraryIds(u));
    ids = ids.filter((id) => mine.has(id));
  }
  return ids;
}

interface MoodDef extends RouletteMoodPreset {
  keywords: string[];
  avoid: string[];
  maxRuntimeMin?: number;
  maxRating?: string;
}

/** Mood presets → genres (any of), overview keywords (any of), genres to avoid, and optional runtime/rating caps. */
export const MOODS: Record<RouletteMood, MoodDef> = {
  'feel-good': { id: 'feel-good', label: 'Feel-good', genres: ['Comedy', 'Family', 'Romance', 'Animation', 'Music', 'Musical'], keywords: ['heartwarming', 'friendship', 'uplifting', 'feel-good'], avoid: ['Horror', 'War'] },
  edge: { id: 'edge', label: 'Edge of your seat', genres: ['Thriller', 'Action', 'Crime', 'Horror', 'Mystery', 'Suspense'], keywords: ['race against time', 'heist', 'hostage', 'chase'], avoid: [] },
  'mind-bending': { id: 'mind-bending', label: 'Mind-bending', genres: ['Science Fiction', 'Sci-Fi', 'Sci-Fi & Fantasy', 'Mystery', 'Fantasy'], keywords: ['time travel', 'dream', 'reality', 'simulation', 'parallel', 'memory', 'twist'], avoid: [] },
  laugh: { id: 'laugh', label: 'Laugh', genres: ['Comedy'], keywords: ['comedy', 'hilarious', 'sitcom'], avoid: ['Horror'] },
  family: { id: 'family', label: 'Family night', genres: ['Family', 'Animation', 'Kids'], keywords: ['family', 'adventure'], avoid: ['Horror'], maxRating: 'PG' },
  short: { id: 'short', label: 'Short & sweet', genres: [], keywords: [], avoid: [], maxRuntimeMin: 95 },
};

export const moodPresets = (): RouletteMoodPreset[] => Object.values(MOODS).map(({ id, label, genres }) => ({ id, label, genres }));

const genreAny = (genres: string[], params: Param[], alias = 'i') => {
  params.push(...genres);
  return `EXISTS (SELECT 1 FROM json_each(${alias}.genres) WHERE json_each.value IN (${genres.map(() => '?').join(',')}))`;
};

/**
 * WHERE fragment (bound params) for roulette/marathon filters on top-level movies or shows (alias `i`, with the
 * viewer's user_data joined as `ud`). Disliked / not-interested titles are always left out.
 */
export function filterSql(user: User, f: RouletteFilters): { sql: string; params: Param[] } {
  const where: string[] = [];
  const params: Param[] = [];
  const series = f.kind === 'series';
  where.push(series ? "i.type = 'show'" : "i.type = 'movie'");
  if (f.libraryIds?.length) {
    where.push(`i.library_id IN (${f.libraryIds.map(() => '?').join(',')})`);
    params.push(...f.libraryIds);
  }
  if (f.genres?.length) where.push(genreAny(f.genres, params));
  const mood = f.mood ? MOODS[f.mood] : null;
  if (mood) {
    const any: string[] = [];
    if (mood.genres.length) any.push(genreAny(mood.genres, params));
    for (const k of mood.keywords) {
      any.push("COALESCE(i.overview, '') LIKE ?");
      params.push(`%${k}%`);
    }
    if (any.length) where.push(`(${any.join(' OR ')})`);
    if (mood.avoid.length) where.push(`NOT ${genreAny(mood.avoid, params)}`);
    if (mood.maxRating) {
      where.push('mm_rating_ok(i.content_rating, ?, 1) = 1');
      params.push(ratingLevel(mood.maxRating) ?? 99);
    }
  }
  const maxMin = f.maxRuntimeMin ?? (mood?.maxRuntimeMin && !series ? mood.maxRuntimeMin : mood?.id === 'short' ? 30 : null);
  if (maxMin && maxMin > 0) {
    if (series) where.push("(SELECT AVG(e.duration_ms) FROM items e WHERE e.grandparent_id = i.id AND e.type = 'episode') <= ?");
    else where.push('i.duration_ms IS NOT NULL AND i.duration_ms <= ?');
    params.push(Math.round(maxMin * 60000));
  }
  if (f.decade) {
    where.push('i.year BETWEEN ? AND ?');
    params.push(Math.floor(f.decade / 10) * 10, Math.floor(f.decade / 10) * 10 + 9);
  }
  if (f.minRating != null && f.minRating > 0) {
    where.push('COALESCE(i.community_rating, 0) >= ?');
    params.push(f.minRating);
  }
  if (f.unwatchedOnly) {
    if (series) {
      where.push(`EXISTS (SELECT 1 FROM items e LEFT JOIN user_data eu ON eu.item_id = e.id AND eu.user_id = ? WHERE e.grandparent_id = i.id AND e.type = 'episode' AND COALESCE(eu.played, 0) = 0)`);
      params.push(user.id);
    } else where.push('COALESCE(ud.played, 0) = 0');
  }
  if (f.fromMyList) {
    where.push('EXISTS (SELECT 1 FROM watchlist w WHERE w.user_id = ? AND w.item_id = i.id)');
    params.push(user.id);
  }
  // Explicit negative signals (thumbs down ≤ 4/10, "Not interested") are never suggested.
  where.push('COALESCE(ud.not_interested, 0) = 0 AND COALESCE(ud.rating, 10) > 4');
  return { sql: where.join(' AND '), params };
}

/** Roulette weighting: higher community rating and recently added titles are more likely. */
export function pickWeight(r: { community_rating: number | null; added_at: string | null }, now = Date.now()): number {
  const rating = r.community_rating ?? 6;
  let w = 0.25 + Math.max(0, rating - 4) ** 1.5 / 6; // ~0.25 for ≤4, ~2.1 for 8, ~3.2 for 9.5
  const added = r.added_at ? Date.parse(r.added_at) : NaN;
  if (Number.isFinite(added)) {
    const days = (now - added) / 86400000;
    if (days < 30) w *= 1.8;
    else if (days < 90) w *= 1.35;
  }
  return w;
}

export const clampList = (v: unknown, max = 50): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 200).slice(0, max) : []);
export const numOrNull = (v: unknown, min: number, max: number): number | null => {
  const n = Number(v);
  return v == null || v === '' || !Number.isFinite(n) ? null : Math.max(min, Math.min(max, n));
};
