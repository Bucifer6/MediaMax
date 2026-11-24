/**
 * DJ rules: what Your DJ, Mix / endless continuation and /dj/order|/dj/mix may play. A listener keeps presets in
 * their preferences; an admin can enforce restrictions per user (e.g. a kids' profile) that always apply on top.
 * Rules become SQL on the track alias `i` (plus filters for analysis-based ranges), so they bound every candidate
 * query; several rule sets are AND-ed (the effective set is "user ∩ enforced").
 */
import type { DjRules, DjRulesResponse, User } from '@mediamax/shared';
import { db, type Param } from '../../db.js';
import { parseJson } from '../../util/misc.js';
import { sourceWhere } from './mix.js';
import { normaliseHostPrefs, normalisePresets, normaliseRules, rulesEmpty } from './rulesNormalise.js';

export { normaliseRules, normalisePresets, rulesEmpty, normaliseHostPrefs };

/* ---------------------------- enforced (admin) ---------------------------- */

export function getEnforced(userId: string): DjRules {
  const row = db.get<{ rules: string }>('SELECT rules FROM dj_restrictions WHERE user_id = ?', userId);
  return row ? normaliseRules(parseJson(row.rules, {})) : {};
}

export function setEnforced(userId: string, rules: unknown): DjRules {
  const r = normaliseRules(rules);
  if (rulesEmpty(r)) db.run('DELETE FROM dj_restrictions WHERE user_id = ?', userId);
  else db.run('INSERT INTO dj_restrictions (user_id, rules, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET rules = excluded.rules, updated_at = excluded.updated_at', userId, JSON.stringify(r), new Date().toISOString());
  return r;
}

/* ------------------------------ combination ------------------------------ */

const lowerSet = (a?: string[]) => new Set((a ?? []).map((x) => x.toLowerCase()));
function meetLists(a?: string[], b?: string[]): string[] | undefined {
  if (!a?.length) return b?.length ? b : undefined;
  if (!b?.length) return a;
  const lb = lowerSet(b);
  return a.filter((x) => lb.has(x.toLowerCase())); // may be empty: nothing matches both
}
function joinLists(a?: string[], b?: string[]): string[] | undefined {
  const out = [...(a ?? [])];
  const seen = lowerSet(a);
  for (const x of b ?? []) if (!seen.has(x.toLowerCase())) out.push(x);
  return out.length ? out : undefined;
}
const maxOf = (a?: number, b?: number) => (a == null ? b : b == null ? a : Math.max(a, b));
const minOf = (a?: number, b?: number) => (a == null ? b : b == null ? a : Math.min(a, b));

/**
 * One rule set equivalent to "a AND b" for display (the filters themselves always apply every set, so sources from
 * both sides are honoured even though only the enforced side's list is shown when both have one).
 */
export function intersectRules(a: DjRules, b: DjRules): DjRules {
  const r: DjRules = {
    includeGenres: meetLists(a.includeGenres, b.includeGenres), excludeGenres: joinLists(a.excludeGenres, b.excludeGenres),
    includeArtists: meetLists(a.includeArtists, b.includeArtists), excludeArtists: joinLists(a.excludeArtists, b.excludeArtists),
    sources: b.sources?.length ? b.sources : a.sources,
    yearMin: maxOf(a.yearMin, b.yearMin), yearMax: minOf(a.yearMax, b.yearMax),
    bpmMin: maxOf(a.bpmMin, b.bpmMin), bpmMax: minOf(a.bpmMax, b.bpmMax),
    energyMin: maxOf(a.energyMin, b.energyMin), energyMax: minOf(a.energyMax, b.energyMax),
    cleanOnly: a.cleanOnly || b.cleanOnly || undefined,
    minRating: maxOf(a.minRating, b.minRating), maxDurationSec: minOf(a.maxDurationSec, b.maxDurationSec),
  };
  for (const k of Object.keys(r) as (keyof DjRules)[]) if (r[k] === undefined) delete r[k];
  return r;
}

/** The rules a request runs under: explicit `rules`, else `presetId`, else the active preset; then ∩ enforced. */
export interface EffectiveRules {
  /** Combined, for display. */
  effective: DjRules;
  enforced: DjRules;
  /** Every set that must hold (user set and enforced set). */
  sets: DjRules[];
}

export function effectiveRules(user: User, req: { rules?: unknown; presetId?: unknown } = {}): EffectiveRules {
  const enforced = getEnforced(user.id);
  const prefs = normalisePresets(user.preferences?.djRules);
  let mine: DjRules = {};
  if (req.rules && typeof req.rules === 'object') mine = normaliseRules(req.rules);
  else {
    const id = typeof req.presetId === 'string' ? req.presetId : prefs?.activePresetId;
    mine = prefs?.presets.find((p) => p.id === id)?.rules ?? {};
  }
  return { effective: intersectRules(mine, enforced), enforced, sets: [mine, enforced].filter((r) => !rulesEmpty(r)) };
}

export function rulesResponse(user: User): DjRulesResponse {
  const prefs = normalisePresets(user.preferences?.djRules) ?? { activePresetId: null, presets: [] };
  const e = effectiveRules(user);
  return { effective: e.effective, enforced: e.enforced, presets: prefs.presets, activePresetId: prefs.activePresetId ?? null };
}

/* --------------------------------- SQL --------------------------------- */

const ph = (n: number) => Array.from({ length: n }, () => '?').join(',');
/** Genre match on the track's own tags, or its album's when the track has none (as the genre source does). */
const genreSql = (n: number) => `(EXISTS (SELECT 1 FROM json_each(i.genres) j WHERE LOWER(j.value) IN (${ph(n)}))
  OR (COALESCE(i.genres, '[]') = '[]' AND EXISTS (SELECT 1 FROM items ga, json_each(ga.genres) j WHERE ga.id = i.parent_id AND LOWER(j.value) IN (${ph(n)}))))`;
const artistSql = (n: number) => `(EXISTS (SELECT 1 FROM items ar WHERE ar.id = i.grandparent_id AND (ar.id IN (${ph(n)}) OR LOWER(ar.title) IN (${ph(n)})))
  OR EXISTS (SELECT 1 FROM track_artists tar WHERE tar.track_id = i.id AND (tar.artist_id IN (${ph(n)}) OR LOWER(tar.name) IN (${ph(n)}))))`;
/** Explicit content: an "explicit" tag, an explicit content rating, or "(Explicit)" in the title (track or album). */
const EXPLICIT_SQL = `(LOWER(COALESCE(i.content_rating, '')) IN ('explicit','e','parental advisory','advisory')
  OR EXISTS (SELECT 1 FROM json_each(i.genres) j WHERE LOWER(j.value) = 'explicit')
  OR LOWER(i.title) LIKE '%(explicit)%' OR LOWER(i.title) LIKE '%[explicit]%'
  OR EXISTS (SELECT 1 FROM items xa WHERE xa.id = i.parent_id AND (LOWER(COALESCE(xa.content_rating, '')) IN ('explicit','e','parental advisory','advisory') OR LOWER(xa.title) LIKE '%(explicit)%')))`;

/** SQL (alias i = a track) for one rule set. A source the user can't see matches nothing. */
export function ruleSetWhere(user: User, r: DjRules): { where: string[]; params: Param[] } {
  const where: string[] = [];
  const params: Param[] = [];
  const g = (list?: string[]) => (list ?? []).map((x) => x.toLowerCase());
  if (r.includeGenres) {
    const l = g(r.includeGenres);
    if (!l.length) where.push('0');
    else {
      where.push(genreSql(l.length));
      params.push(...l, ...l);
    }
  }
  if (r.excludeGenres?.length) {
    const l = g(r.excludeGenres);
    where.push(`NOT ${genreSql(l.length)}`);
    params.push(...l, ...l);
  }
  const artistParams = (list: string[]) => [...list, ...g(list), ...list, ...g(list)];
  if (r.includeArtists) {
    if (!r.includeArtists.length) where.push('0');
    else {
      where.push(artistSql(r.includeArtists.length));
      params.push(...artistParams(r.includeArtists));
    }
  }
  if (r.excludeArtists?.length) {
    where.push(`NOT ${artistSql(r.excludeArtists.length)}`);
    params.push(...artistParams(r.excludeArtists));
  }
  if (r.sources?.length) {
    const ors: string[] = [];
    for (const s of r.sources) {
      try {
        const w = sourceWhere(user, s);
        ors.push(`(${w.where.join(' AND ')})`);
        params.push(...w.params);
      } catch {
        /* a source this user can't see (or that no longer exists) contributes nothing */
      }
    }
    where.push(ors.length ? `(${ors.join(' OR ')})` : '0');
  }
  const year = `COALESCE(i.year, (SELECT ya.year FROM items ya WHERE ya.id = i.parent_id))`;
  if (r.yearMin != null) {
    where.push(`${year} >= ?`);
    params.push(r.yearMin);
  }
  if (r.yearMax != null) {
    where.push(`${year} <= ?`);
    params.push(r.yearMax);
  }
  if (r.bpmMin != null || r.bpmMax != null) {
    const lo = r.bpmMin ?? 0;
    const hi = r.bpmMax ?? 1000;
    // Half / double time counts as in range (a 70 BPM track fits a 130–150 window).
    where.push(`EXISTS (SELECT 1 FROM track_analysis tb WHERE tb.item_id = i.id AND tb.bpm > 0 AND ((tb.bpm BETWEEN ? AND ?) OR (tb.bpm * 2 BETWEEN ? AND ?) OR (tb.bpm / 2 BETWEEN ? AND ?)))`);
    params.push(lo, hi, lo, hi, lo, hi);
  }
  if (r.energyMin != null || r.energyMax != null) {
    where.push('EXISTS (SELECT 1 FROM track_analysis te WHERE te.item_id = i.id AND te.error IS NULL AND te.energy BETWEEN ? AND ?)');
    params.push(r.energyMin ?? 0, r.energyMax ?? 1);
  }
  if (r.cleanOnly) where.push(`NOT ${EXPLICIT_SQL}`);
  if (r.minRating != null && r.minRating > 0) {
    where.push('EXISTS (SELECT 1 FROM user_data ur WHERE ur.item_id = i.id AND ur.user_id = ? AND ur.rating >= ?)');
    params.push(user.id, r.minRating);
  }
  if (r.maxDurationSec != null) {
    where.push('(COALESCE(i.duration_ms, 0) = 0 OR i.duration_ms <= ?)');
    params.push(r.maxDurationSec * 1000);
  }
  return { where, params };
}

/** SQL for every set of an effective rule (all must hold). Empty when there are no rules. */
export function rulesWhere(user: User, e: Pick<EffectiveRules, 'sets'> | null | undefined): { where: string[]; params: Param[] } {
  const where: string[] = [];
  const params: Param[] = [];
  for (const s of e?.sets ?? []) {
    const w = ruleSetWhere(user, s);
    where.push(...w.where);
    params.push(...w.params);
  }
  return { where, params };
}

/** Does this track pass the rules? (one query; for single checks such as "start with X"). */
export function trackAllowed(user: User, itemId: string, e: Pick<EffectiveRules, 'sets'>): boolean {
  if (!e.sets.length) return true;
  const w = rulesWhere(user, e);
  return !!db.get(`SELECT 1 FROM items i WHERE i.id = ? AND ${w.where.join(' AND ')}`, itemId, ...w.params);
}
