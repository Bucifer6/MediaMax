/**
 * Roulette ("Can't decide? Spin"): one random movie or show for the filters, plus ~20 decoy posters for the reel.
 *
 * Cost: one indexed candidate query of slim columns (capped), one query for the full pick, and for series one or
 * two small episode queries. No per-candidate queries.
 */
import type { Item, RouletteDecoy, RouletteFilters, RouletteKind, RouletteMood, RouletteSpinRequest, RouletteSpinResponse, User } from '@mediamax/shared';
import { db, type Param } from '../../db.js';
import { accessClause, itemsByIds, selectItems, nextItem } from '../items.js';
import { imageUrl } from '../images.js';
import { MOODS, clampList, filterSql, numOrNull, pickWeight, rngFor, shuffle, weightedIndex } from './common.js';

/** Upper bound on candidates considered per spin (keeps big libraries fast). */
export const CANDIDATE_CAP = 1500;
export const DECOYS = 20;

interface Candidate {
  id: string;
  title: string;
  poster: string | null;
  community_rating: number | null;
  added_at: string | null;
}

/** Normalise untrusted request input into filters. */
export function parseFilters(b: Partial<RouletteSpinRequest> | undefined): RouletteFilters {
  const body = b ?? {};
  const kind: RouletteKind = body.kind === 'series' ? 'series' : 'movie';
  const mood = typeof body.mood === 'string' && body.mood in MOODS ? (body.mood as RouletteMood) : null;
  return {
    kind,
    libraryIds: clampList(body.libraryIds),
    genres: clampList(body.genres),
    maxRuntimeMin: numOrNull(body.maxRuntimeMin, 1, 1000),
    decade: numOrNull(body.decade, 1880, 2100),
    minRating: numOrNull(body.minRating, 0, 10),
    unwatchedOnly: !!body.unwatchedOnly,
    fromMyList: !!body.fromMyList,
    mood,
    weighted: body.weighted !== false,
    randomEpisode: !!body.randomEpisode,
  };
}

/** Slim candidate rows for the filters (access applied), deterministic order when seeded. */
export function candidates(user: User, f: RouletteFilters, exclude: string[], seeded: boolean, cap = CANDIDATE_CAP): Candidate[] {
  const a = accessClause(user);
  const fs = filterSql(user, f);
  const params: Param[] = [user.id, ...a.params, ...fs.params];
  let ex = '';
  if (exclude.length) {
    ex = ` AND i.id NOT IN (${exclude.map(() => '?').join(',')})`;
    params.push(...exclude);
  }
  return db.all<Candidate>(
    `SELECT i.id, i.title, i.poster, i.community_rating, i.added_at FROM items i
     LEFT JOIN user_data ud ON ud.item_id = i.id AND ud.user_id = ?
     WHERE ${a.sql} AND ${fs.sql}${ex}
     ORDER BY ${seeded ? 'i.id' : 'RANDOM()'} LIMIT ${cap}`, ...params);
}

/**
 * The episode to play for a show: `random` → a random (unplayed when `unwatchedOnly`) regular-season episode;
 * otherwise next up when the viewer has started the show, else S1E1.
 */
export function chooseEpisode(user: User, showId: string, mode: 'next' | 'random', rng: () => number = Math.random, unwatchedOnly = false, exclude: string[] = []): Item | null {
  const order = 'ORDER BY COALESCE(i.parent_idx,0) = 0, COALESCE(i.parent_idx,0), COALESCE(i.idx,0), i.id';
  if (mode === 'random') {
    const a = accessClause(user);
    const params: Param[] = [user.id, showId, ...a.params];
    let extra = unwatchedOnly ? ' AND COALESCE(ud.played,0) = 0' : '';
    if (exclude.length) {
      extra += ` AND i.id NOT IN (${exclude.map(() => '?').join(',')})`;
      params.push(...exclude);
    }
    const run = (specials: boolean) => db.all<{ id: string }>(
      `SELECT i.id FROM items i LEFT JOIN user_data ud ON ud.item_id = i.id AND ud.user_id = ?
       WHERE i.grandparent_id = ? AND i.type = 'episode' AND ${a.sql}${specials ? '' : ' AND COALESCE(i.parent_idx,0) > 0'}${extra} ORDER BY i.id`, ...params);
    let ids = run(false);
    if (!ids.length) ids = run(true);
    if (!ids.length) return null;
    return itemsByIds(user, [ids[Math.floor(rng() * ids.length)].id])[0] ?? null;
  }
  const started = db.get(`SELECT 1 x FROM user_data ud JOIN items i ON i.id = ud.item_id WHERE ud.user_id = ? AND i.grandparent_id = ? AND (ud.played = 1 OR ud.position_ms > 0) LIMIT 1`, user.id, showId);
  if (started) {
    const n = nextItem(user, showId);
    if (n) return n;
  }
  return selectItems(user, `i.grandparent_id = ? AND i.type = 'episode'`, [showId], `${order} LIMIT 1`)[0] ?? null;
}

export function spin(user: User, req: Partial<RouletteSpinRequest> | undefined): RouletteSpinResponse {
  const f = parseFilters(req);
  const exclude = clampList(req?.excludeIds, 500);
  const seeded = typeof req?.seed === 'number' && Number.isFinite(req.seed);
  const rng = rngFor(seeded ? req!.seed : null);
  const pool = candidates(user, f, exclude, seeded);
  if (!pool.length) return { pick: null, episode: null, decoys: [], poolSize: 0 };
  const idx = f.weighted ? weightedIndex(pool.map((c) => pickWeight(c)), rng) : Math.floor(rng() * pool.length);
  const chosen = pool[idx];
  const pick = itemsByIds(user, [chosen.id])[0] ?? null;
  const others = pool.filter((c) => c.id !== chosen.id);
  const withPosters = others.filter((c) => c.poster);
  const decoys: RouletteDecoy[] = shuffle(withPosters.length >= Math.min(DECOYS, others.length) ? withPosters : others, rng)
    .slice(0, DECOYS)
    .map((c) => ({ id: c.id, title: c.title, posterUrl: imageUrl(c.poster) }));
  const episode = pick && f.kind === 'series' ? chooseEpisode(user, pick.id, f.randomEpisode ? 'random' : 'next', rng, !!f.unwatchedOnly) : null;
  return { pick, episode, decoys, poolSize: pool.length };
}
