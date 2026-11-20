/**
 * Recommendations, "because you watched", Top 10 and trending — all computed locally, no external services.
 *
 * Scoring (see docs/API.md → Discovery):
 *  - Every movie/show is a sparse feature vector: genres, top-billed cast, directors/creators, studios/networks and decade.
 *  - A viewer's taste profile is the weighted sum of the vectors of titles they watched, favourited, rated or put on
 *    My List (thumbs down / "not interested" count negatively), with recent plays weighted more.
 *  - Collaborative signal: cosine similarity between viewers' watch sets on this server ("people who watched X also
 *    watched Y"), from user_data (episodes roll up to their show).
 *  - Candidates are capped (SQL picks a few hundred by genre, people, co-watching and popularity), scored in JS,
 *    and cached per viewer for 10 minutes (dropped early when they play, rate or change their list).
 */
import type { HomeRow, HomeRowConfig, Item, Person, User } from '@mediamax/shared';
import { db, type Row } from '../db.js';
import { accessClause, assertCanSee, homeHooks, itemsByIds } from './items.js';
import { bus } from './events.js';
import { getBranding } from './branding.js';
import { parseJson } from '../util/misc.js';

/* ------------------------------ features ---------------------------- */

export interface Features {
  genres: string[];
  actors: string[];
  directors: string[];
  studios: string[];
  decade: number | null;
}

/** Relative importance of each kind of feature. */
export const WEIGHTS = { genre: 1.0, actor: 0.45, director: 1.3, studio: 0.5, decade: 0.35 } as const;

const norm = (s: string) => s.trim().toLowerCase();

export function featuresOf(r: { genres?: string | null; people?: string | null; studios?: string | null; year?: number | null }): Features {
  const people = parseJson<Person[]>(r.people ?? '[]', []);
  return {
    genres: [...new Set(parseJson<string[]>(r.genres ?? '[]', []).map(norm).filter(Boolean))],
    // Names keep their case: they come from one metadata source, and the indexed candidate lookup matches them exactly.
    actors: people.filter((p) => p.kind === 'actor').slice(0, 8).map((p) => p.name.trim()),
    // Directors for movies; creators (stored as writers with role "Creator") for shows.
    directors: [...new Set(people.filter((p) => p.kind === 'director' || (p.kind === 'writer' && /creator/i.test(p.role ?? ''))).map((p) => p.name.trim()))].slice(0, 4),
    studios: parseJson<string[]>(r.studios ?? '[]', []).slice(0, 3).map(norm).filter(Boolean),
    decade: r.year ? Math.floor(r.year / 10) * 10 : null,
  };
}

/** Weighted sparse vector for a title. Multi-genre titles share their genre weight so they aren't favoured. */
export function featureVector(f: Features): Map<string, number> {
  const v = new Map<string, number>();
  const g = f.genres.length ? WEIGHTS.genre / Math.sqrt(f.genres.length) : 0;
  for (const x of f.genres) v.set(`g:${x}`, g);
  f.actors.forEach((x, i) => v.set(`a:${x}`, WEIGHTS.actor * (1 - i * 0.07)));
  for (const x of f.directors) v.set(`d:${x}`, WEIGHTS.director);
  for (const x of f.studios) v.set(`s:${x}`, WEIGHTS.studio);
  if (f.decade != null) v.set(`y:${f.decade}`, WEIGHTS.decade);
  return v;
}

/** Cosine similarity of two titles' feature vectors, 0…1. */
export function similarity(a: Features, b: Features): number {
  const va = featureVector(a);
  const vb = featureVector(b);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, w] of va) {
    na += w * w;
    const o = vb.get(k);
    if (o) dot += w * o;
  }
  for (const w of vb.values()) nb += w * w;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export type Profile = Map<string, number>;

/** A viewer's taste: weighted sum of their titles' vectors, normalised by total positive weight. */
export function buildProfile(seeds: { f: Features; w: number }[]): Profile {
  const p: Profile = new Map();
  let total = 0;
  for (const { f, w } of seeds) {
    if (!w) continue;
    if (w > 0) total += w;
    for (const [k, fw] of featureVector(f)) p.set(k, (p.get(k) ?? 0) + w * fw);
  }
  if (total > 0) for (const [k, v] of p) p.set(k, v / total);
  return p;
}

/** How well a title matches a taste profile (can be negative for disliked traits). */
export function profileScore(p: Profile, f: Features): number {
  let s = 0;
  for (const [k, fw] of featureVector(f)) {
    const pw = p.get(k);
    if (pw) s += pw * fw;
  }
  return s;
}

/** Weight of one title as a taste signal. */
export function signalWeight(s: { played?: boolean; inProgress?: boolean; episodes?: number; favorite?: boolean; rating?: number | null; watchlist?: boolean; notInterested?: boolean; ageDays?: number | null }): number {
  let w = 0;
  if (s.episodes) w += Math.min(1.5, 0.4 + 0.15 * s.episodes);
  else if (s.played) w += 1;
  else if (s.inProgress) w += 0.5;
  if (w && s.ageDays != null) w *= 0.5 + 0.5 * Math.exp(-Math.max(0, s.ageDays) / 120);
  if (s.favorite) w += 1.5;
  if (s.watchlist) w += 0.4;
  if (s.rating != null) {
    if (s.rating >= 8) w += 1.5;
    else if (s.rating >= 6) w += 0.4;
    else if (s.rating <= 4) w = -2;
  }
  if (s.notInterested) w = Math.min(w, 0) - 1.5;
  return w;
}

/* ------------------------- collaborative signal ---------------------- */

/** userId → titles (movie/show ids) they watched or liked; episodes roll up to the show. */
export type WatchMatrix = Map<string, Set<string>>;

let matrixCache: { at: number; m: WatchMatrix } | null = null;
let matrixDirtyAt = 0;

export function watchMatrix(): WatchMatrix {
  // Rebuilt every 10 minutes, or after a play — but at most once a minute.
  const now = Date.now();
  if (matrixCache && (now - matrixCache.at < 600_000) && !(matrixDirtyAt > matrixCache.at && now - matrixCache.at > 60_000)) return matrixCache.m;
  const rows = db.all<{ uid: string; tid: string }>(
    `SELECT ud.user_id uid, CASE WHEN i.type = 'episode' THEN i.grandparent_id ELSE i.id END tid
     FROM user_data ud JOIN items i ON i.id = ud.item_id
     WHERE i.type IN ('movie','show','episode') AND (ud.played = 1 OR ud.position_ms > 0 OR ud.favorite = 1 OR ud.rating >= 7)
       AND COALESCE(ud.rating, 10) > 4 AND ud.not_interested = 0
     GROUP BY 1, 2`);
  const m: WatchMatrix = new Map();
  for (const r of rows) {
    if (!r.tid) continue;
    let s = m.get(r.uid);
    if (!s) m.set(r.uid, (s = new Set()));
    s.add(r.tid);
  }
  matrixCache = { at: now, m };
  return m;
}

/** "Viewers like you also watched": titles other viewers watched, weighted by how similar their history is to yours. */
export function collabForUser(m: WatchMatrix, uid: string): Map<string, number> {
  const mine = m.get(uid);
  const out = new Map<string, number>();
  if (!mine?.size) return out;
  for (const [v, theirs] of m) {
    if (v === uid || !theirs.size) continue;
    let overlap = 0;
    for (const t of theirs) if (mine.has(t)) overlap++;
    if (!overlap) continue;
    const sim = overlap / Math.sqrt(mine.size * theirs.size);
    for (const t of theirs) if (!mine.has(t)) out.set(t, (out.get(t) ?? 0) + sim);
  }
  return out;
}

/** "People who watched X also watched Y", damped by Y's overall popularity so blockbusters don't dominate. */
export function coWatched(m: WatchMatrix, tid: string): Map<string, number> {
  const out = new Map<string, number>();
  const pop = new Map<string, number>();
  for (const s of m.values()) for (const t of s) pop.set(t, (pop.get(t) ?? 0) + 1);
  for (const s of m.values()) {
    if (!s.has(tid) || s.size < 2) continue;
    const w = 1 / Math.sqrt(s.size);
    for (const t of s) if (t !== tid) out.set(t, (out.get(t) ?? 0) + w);
  }
  for (const [t, v] of out) out.set(t, v / Math.sqrt(pop.get(t) ?? 1));
  return out;
}

/* ------------------------------- cache ------------------------------ */

const TTL = 10 * 60_000;
const cache = new Map<string, { at: number; value: unknown }>();

function cached<T>(key: string, fn: () => T): T {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value as T;
  const value = fn();
  if (cache.size > 5000) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function invalidateUser(userId: string) {
  for (const k of cache.keys()) if (k.startsWith(`u:${userId}:`)) cache.delete(k);
  matrixDirtyAt = Date.now();
}

export function clearRecommendationCache() {
  cache.clear();
  matrixCache = null;
}

bus.on('items.played', ({ user }: { user: User }) => invalidateUser(user.id));
bus.on('playback.scrobble', ({ user }: { user: User }) => invalidateUser(user.id));
bus.on('userdata.changed', ({ userId }: { userId: string }) => invalidateUser(userId));
bus.on('library.new', () => {
  for (const k of cache.keys()) if (!k.startsWith('u:')) cache.delete(k);
});

/* ---------------------------- user signals --------------------------- */

interface UserState {
  /** Titles the viewer has watched or started (excluded from recommendations). */
  seen: Set<string>;
  notInterested: Set<string>;
  seeds: { id: string; w: number }[];
}

function userState(userId: string): UserState {
  const seen = new Set<string>();
  const notInterested = new Set<string>();
  const sig = new Map<string, Parameters<typeof signalWeight>[0]>();
  const age = (at: string | null) => (at ? (Date.now() - Date.parse(at)) / 86_400_000 : null);
  for (const r of db.all(
    `SELECT i.id, i.type, ud.played, ud.position_ms, ud.favorite, ud.rating, ud.last_played_at, ud.not_interested
     FROM user_data ud JOIN items i ON i.id = ud.item_id WHERE ud.user_id = ? AND i.type IN ('movie','show')`, userId)) {
    if (r.played || r.position_ms > 0) seen.add(r.id);
    if (r.not_interested) notInterested.add(r.id);
    sig.set(r.id, { played: !!r.played, inProgress: r.position_ms > 0, favorite: !!r.favorite, rating: r.rating, notInterested: !!r.not_interested, ageDays: age(r.last_played_at) });
  }
  for (const r of db.all(
    `SELECT i.grandparent_id id, SUM(ud.played) eps, MAX(ud.last_played_at) last, MAX(ud.position_ms) pos
     FROM user_data ud JOIN items i ON i.id = ud.item_id
     WHERE ud.user_id = ? AND i.type = 'episode' AND i.grandparent_id IS NOT NULL AND (ud.played = 1 OR ud.position_ms > 0)
     GROUP BY i.grandparent_id`, userId)) {
    seen.add(r.id);
    const cur = sig.get(r.id) ?? {};
    sig.set(r.id, { ...cur, episodes: Math.max(1, r.eps ?? 0), ageDays: age(r.last) });
  }
  for (const r of db.all<{ item_id: string }>(`SELECT w.item_id FROM watchlist w JOIN items i ON i.id = w.item_id WHERE w.user_id = ? AND i.type IN ('movie','show')`, userId)) {
    sig.set(r.item_id, { ...(sig.get(r.item_id) ?? {}), watchlist: true });
  }
  const seeds = [...sig.entries()].map(([id, s]) => ({ id, w: signalWeight(s) })).filter((s) => s.w !== 0);
  seeds.sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  return { seen, notInterested, seeds: seeds.slice(0, 250) };
}

const FEATURE_COLS = 'i.id, i.type, i.genres, i.people, i.studios, i.year, i.community_rating, i.added_at';

function loadRows(ids: string[]): Map<string, Row> {
  const out = new Map<string, Row>();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    for (const r of db.all(`SELECT ${FEATURE_COLS} FROM items i WHERE i.id IN (${chunk.map(() => '?').join(',')})`, ...chunk)) out.set(r.id, r);
  }
  return out;
}

/** Candidate ids sharing genres or people with `keys` (profile keys like `g:drama`, `a:tom hanks`), access-filtered. */
function candidatesByFeatures(user: User, types: string[], genres: string[], people: string[], perSource: number): string[] {
  const a = accessClause(user);
  const typeSql = `i.type IN (${types.map(() => '?').join(',')})`;
  const out: string[] = [];
  if (genres.length) {
    out.push(...db.all<{ id: string }>(
      `SELECT i.id FROM items i WHERE ${typeSql} AND ${a.sql}
         AND EXISTS (SELECT 1 FROM json_each(i.genres) j WHERE lower(j.value) IN (${genres.map(() => '?').join(',')}))
       ORDER BY COALESCE(i.community_rating, 0) DESC LIMIT ${perSource}`, ...types, ...a.params, ...genres).map((r) => r.id));
  }
  if (people.length) {
    // item_people is an indexed copy of each title's cast & crew (see migration 13).
    out.push(...db.all<{ id: string }>(
      `SELECT DISTINCT i.id FROM item_people p JOIN items i ON i.id = p.item_id
       WHERE p.name IN (${people.map(() => '?').join(',')}) AND ${typeSql} AND ${a.sql} LIMIT ${perSource}`, ...people, ...types, ...a.params).map((r) => r.id));
  }
  return out;
}

function visibleIds(user: User, ids: string[]): Set<string> {
  const a = accessClause(user);
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    for (const r of db.all<{ id: string }>(`SELECT i.id FROM items i WHERE i.id IN (${chunk.map(() => '?').join(',')}) AND ${a.sql}`, ...chunk, ...a.params)) out.add(r.id);
  }
  return out;
}

const topKeys = (p: Profile, prefix: string, n: number) =>
  [...p.entries()].filter(([k, v]) => k.startsWith(prefix) && v > 0).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k.slice(prefix.length));

/* ---------------------------- recommended ---------------------------- */

export function recommendedIds(user: User, limit = 60): string[] {
  return cached(`u:${user.id}:rec`, () => {
    const st = userState(user.id);
    const seedRows = loadRows(st.seeds.map((s) => s.id));
    const profile = buildProfile(st.seeds.filter((s) => seedRows.has(s.id)).map((s) => ({ f: featuresOf(seedRows.get(s.id)!), w: s.w })));
    const collab = collabForUser(watchMatrix(), user.id);
    const exclude = (id: string) => st.seen.has(id) || st.notInterested.has(id);

    const pool = new Set<string>();
    const genres = topKeys(profile, 'g:', 6);
    const people = [...topKeys(profile, 'd:', 6), ...topKeys(profile, 'a:', 10)];
    for (const id of candidatesByFeatures(user, ['movie', 'show'], genres, people, 400)) pool.add(id);
    const collabTop = [...collab.entries()].sort((a, b) => b[1] - a[1]).slice(0, 200).map(([id]) => id);
    const vis = visibleIds(user, collabTop);
    for (const id of collabTop) if (vis.has(id)) pool.add(id);
    // Popular and well-rated titles keep the row useful for new viewers (cold start).
    for (const t of popularIds(user, 'trending').slice(0, 40)) pool.add(t);
    if (pool.size < 60) {
      const a = accessClause(user);
      for (const r of db.all<{ id: string }>(`SELECT i.id FROM items i WHERE i.type IN ('movie','show') AND ${a.sql} ORDER BY COALESCE(i.community_rating, 0) DESC, i.added_at DESC LIMIT 150`, ...a.params)) pool.add(r.id);
    }
    const ids = [...pool].filter((id) => !exclude(id));
    const rows = loadRows(ids);
    const maxCollab = Math.max(0, ...ids.map((id) => collab.get(id) ?? 0));
    const content = new Map(ids.map((id) => [id, rows.has(id) ? profileScore(profile, featuresOf(rows.get(id)!)) : 0]));
    const maxContent = Math.max(0, ...content.values());
    const recent = Date.now() - 30 * 86_400_000;
    const scored = ids.filter((id) => rows.has(id)).map((id) => {
      const r = rows.get(id)!;
      return {
        id,
        score: rankScore({
          content: maxContent > 0 ? content.get(id)! / maxContent : 0,
          collab: maxCollab > 0 ? (collab.get(id) ?? 0) / maxCollab : 0,
          rating: r.community_rating,
          fresh: Date.parse(r.added_at) > recent,
        }),
      };
    });
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return scored.slice(0, Math.max(limit, 60)).map((s) => s.id);
  });
}

/** Final blend for one candidate. `content` and `collab` are normalised to 0…1 (content may be negative). */
export function rankScore(c: { content: number; collab: number; rating: number | null; fresh: boolean }): number {
  return c.content + 0.6 * c.collab + 0.15 * ((c.rating ?? 6) / 10) + (c.fresh ? 0.05 : 0);
}

/* ------------------------------ similar ------------------------------ */

/** Ids of the titles most similar to `id` (same kind: movies for a movie, shows for a show). */
export function similarIds(user: User, id: string, limit = 24): string[] {
  return cached(`u:${user.id}:sim:${id}`, () => {
    const row = db.get(`SELECT ${FEATURE_COLS} FROM items i WHERE i.id = ?`, id);
    if (!row) return [];
    const f = featuresOf(row);
    const types = [row.type];
    const pool = new Set(candidatesByFeatures(user, types, f.genres, [...f.directors, ...f.actors.slice(0, 6)], 400));
    const co = coWatched(watchMatrix(), id);
    const coTop = [...co.entries()].sort((a, b) => b[1] - a[1]).slice(0, 100).map(([t]) => t);
    const vis = visibleIds(user, coTop);
    for (const t of coTop) if (vis.has(t)) pool.add(t);
    pool.delete(id);
    const rows = loadRows([...pool]);
    const maxCo = Math.max(0, ...[...pool].map((t) => co.get(t) ?? 0));
    const scored = [...pool].filter((t) => rows.get(t)?.type === row.type).map((t) => {
      const r = rows.get(t)!;
      return { id: t, score: similarity(f, featuresOf(r)) + (maxCo > 0 ? 0.35 * ((co.get(t) ?? 0) / maxCo) : 0) + 0.05 * ((r.community_rating ?? 6) / 10) };
    });
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return scored.slice(0, Math.max(limit, 24)).map((s) => s.id);
  });
}

/** "More like this" for movies and shows; null for other kinds (callers use the genre-based fallback). */
export function similarTo(user: User, id: string, limit = 12): Item[] | null {
  const row = assertCanSee(user, id);
  if (row.type !== 'movie' && row.type !== 'show') return null;
  const hidden = userState(user.id).notInterested;
  return itemsByIds(user, similarIds(user, id, limit + hidden.size).filter((t) => !hidden.has(t)).slice(0, limit));
}

/* ------------------------------ because ------------------------------ */

/** A recently finished movie or show to base a "Because you watched" row on (rotates daily between the last few). */
export function becauseSeed(user: User): { id: string; title: string } | null {
  const movies = db.all<{ id: string; last: string }>(
    `SELECT i.id, ud.last_played_at last FROM user_data ud JOIN items i ON i.id = ud.item_id
     WHERE ud.user_id = ? AND i.type = 'movie' AND ud.played = 1 AND COALESCE(ud.rating, 10) > 4 AND ud.not_interested = 0 AND ud.last_played_at IS NOT NULL
     ORDER BY ud.last_played_at DESC LIMIT 5`, user.id);
  // A show counts once three episodes (or all of a short one) are finished.
  const shows = db.all<{ id: string; last: string }>(
    `SELECT i.grandparent_id id, MAX(ud.last_played_at) last FROM user_data ud JOIN items i ON i.id = ud.item_id
     WHERE ud.user_id = ? AND i.type = 'episode' AND ud.played = 1 AND i.grandparent_id IS NOT NULL
     GROUP BY i.grandparent_id
     HAVING COUNT(*) >= MIN(3, (SELECT COUNT(*) FROM items e WHERE e.grandparent_id = i.grandparent_id AND e.type = 'episode'))
     ORDER BY last DESC LIMIT 5`, user.id);
  const all = [...movies, ...shows].sort((a, b) => (b.last ?? '').localeCompare(a.last ?? ''));
  const vis = visibleIds(user, all.map((x) => x.id));
  const disliked = new Set(db.all<{ item_id: string }>('SELECT item_id FROM user_data WHERE user_id = ? AND (not_interested = 1 OR rating <= 4)', user.id).map((r) => r.item_id));
  const options = all.filter((x) => vis.has(x.id) && !disliked.has(x.id)).slice(0, 3);
  if (!options.length) return null;
  const pick = options[Math.floor(Date.now() / 86_400_000) % options.length];
  const t = db.get<{ title: string }>('SELECT title FROM items WHERE id = ?', pick.id);
  return t ? { id: pick.id, title: t.title } : null;
}

export function becauseItems(user: User, seedId: string, limit: number): Item[] {
  const st = userState(user.id);
  return itemsByIds(user, similarIds(user, seedId, limit * 3).filter((t) => !st.seen.has(t) && !st.notInterested.has(t)).slice(0, limit));
}

/* --------------------------- top 10 / trending ----------------------- */

/** Plays shorter than this don't count towards charts (someone opened it and left). */
const MIN_PLAY_MS = 120_000;

/**
 * Server-wide charts from play history, cached for 10 minutes. Episodes roll up to their show.
 * top10: distinct viewers in the last 7 days (plays break ties). trending: plays in the last 14 days, each worth
 * e^(−age/72h), so something watched tonight outranks something watched last week.
 */
export function chartScores(kind: 'top10' | 'trending', now = Date.now()): { id: string; score: number }[] {
  return cached(`chart:${kind}`, () => {
    const days = kind === 'top10' ? 7 : 14;
    const rows = db.all<{ tid: string; uid: string; started_at: string }>(
      `SELECT CASE WHEN i.type = 'episode' THEN i.grandparent_id ELSE i.id END tid, h.user_id uid, h.started_at
       FROM play_history h JOIN items i ON i.id = h.item_id
       WHERE h.started_at >= ? AND i.type IN ('movie','episode') AND (h.duration_ms IS NULL OR h.duration_ms >= ?)`,
      new Date(now - days * 86_400_000).toISOString(), MIN_PLAY_MS);
    return rankCharts(kind, rows, now);
  });
}

export function rankCharts(kind: 'top10' | 'trending', rows: { tid: string | null; uid: string; started_at: string }[], now = Date.now()): { id: string; score: number }[] {
  const score = new Map<string, number>();
  if (kind === 'top10') {
    const viewers = new Map<string, Set<string>>();
    const plays = new Map<string, number>();
    for (const r of rows) {
      if (!r.tid) continue;
      if (!viewers.has(r.tid)) viewers.set(r.tid, new Set());
      viewers.get(r.tid)!.add(r.uid);
      plays.set(r.tid, (plays.get(r.tid) ?? 0) + 1);
    }
    for (const [t, v] of viewers) score.set(t, v.size * 1000 + Math.min(999, plays.get(t) ?? 0));
  } else {
    for (const r of rows) {
      if (!r.tid) continue;
      const ageH = Math.max(0, (now - Date.parse(r.started_at)) / 3_600_000);
      score.set(r.tid, (score.get(r.tid) ?? 0) + Math.exp(-ageH / 72));
    }
  }
  return [...score.entries()].map(([id, s]) => ({ id, score: s })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 100);
}

/** Chart ids the viewer may see; trending also drops their "not interested" titles. */
export function popularIds(user: User, kind: 'top10' | 'trending'): string[] {
  const ids = chartScores(kind).map((c) => c.id);
  const vis = visibleIds(user, ids);
  const hidden = kind === 'trending' ? new Set(db.all<{ item_id: string }>('SELECT item_id FROM user_data WHERE user_id = ? AND not_interested = 1', user.id).map((r) => r.item_id)) : new Set<string>();
  return ids.filter((id) => vis.has(id) && !hidden.has(id));
}

/* ------------------------------ home rows ---------------------------- */

const fill = (title: string, vars: Record<string, string>) => title.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);

export function discoveryRow(user: User, cfg: HomeRowConfig): HomeRow | null {
  const limit = cfg.limit ?? 20;
  const title = cfg.title ?? '';
  const server = getBranding().serverName;
  switch (cfg.type) {
    case 'recommended': {
      const items = itemsByIds(user, recommendedIds(user, limit).slice(0, limit));
      return items.length ? { id: cfg.id, type: cfg.type, title: fill(title, { server }), items } : null;
    }
    case 'because': {
      const seed = becauseSeed(user);
      if (!seed) return null;
      const items = becauseItems(user, seed.id, limit);
      return items.length >= 3 ? { id: cfg.id, type: cfg.type, title: fill(title, { title: seed.title, server }), items, seedItemId: seed.id, link: { itemId: seed.id } } : null;
    }
    case 'top10': {
      const items = itemsByIds(user, popularIds(user, 'top10').slice(0, Math.min(10, limit)));
      return items.length >= 3 ? { id: cfg.id, type: cfg.type, title: fill(title, { server }), items } : null;
    }
    case 'trending': {
      const items = itemsByIds(user, popularIds(user, 'trending').slice(0, limit));
      return items.length >= 3 ? { id: cfg.id, type: cfg.type, title: fill(title, { server }), items } : null;
    }
    case 'upcoming':
      return calendarHooks.upcomingRow?.(user, { ...cfg, title: fill(title, { server }) }) ?? null;
    default:
      return null;
  }
}

/** Set by services/calendar.ts. */
export const calendarHooks: { upcomingRow?: (user: User, cfg: HomeRowConfig) => HomeRow | null } = {};

homeHooks.discoveryRow = discoveryRow;

