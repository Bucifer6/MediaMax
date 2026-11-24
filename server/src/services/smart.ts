import type { Item, Paged, SmartFilter, SmartRule, User } from '@mediamax/shared';
import type { Param } from '../db.js';
import { badRequest } from '../util/errors.js';
import { toInt } from '../util/misc.js';
import { queryWhere, smartHooks } from './items.js';

/** Item types a smart list returns when no `type` rule is given. */
const DEFAULT_TYPES = ['movie', 'show', 'video', 'audiobook', 'album', 'podcast'];
const RESOLUTION_MIN_HEIGHT: Record<string, number> = { '4k': 2000, '2160p': 2000, '1440p': 1400, '1080p': 1000, '720p': 700, '576p': 560, '480p': 470, sd: 0 };
const ITEM_TYPES = new Set(['movie', 'show', 'season', 'episode', 'artist', 'album', 'track', 'photo', 'video', 'audiobook', 'bookpart', 'podcast', 'podcastepisode']);
const SORTS = new Set(['title', 'addedAt', 'year', 'releaseDate', 'rating', 'lastPlayed', 'random', 'index']);

const num = (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw badRequest(`Expected a number, got "${String(v)}"`);
  return n;
};
const str = (v: unknown) => String(v ?? '').slice(0, 200);
const bool = (v: unknown) => v === true || v === 'true' || v === 1 || v === '1';

/** Validate and normalise a filter coming from a client. */
export function normaliseFilter(f: Partial<SmartFilter> | undefined): SmartFilter {
  if (!f || !Array.isArray(f.rules)) throw badRequest('A smart list needs at least one rule');
  if (f.rules.length > 25) throw badRequest('Too many rules (max 25)');
  return {
    match: f.match === 'any' ? 'any' : 'all',
    rules: f.rules.map((r) => ({ field: r.field, op: r.op, value: r.value }) as SmartRule),
    sort: SORTS.has(f.sort as string) ? f.sort! : 'addedAt',
    order: f.order === 'asc' ? 'asc' : 'desc',
    limit: f.limit ? toInt(f.limit, 100, 1, 1000) : null,
  };
}

function compare(col: string, op: string, value: unknown, scale = 1): { sql: string; params: Param[] } {
  switch (op) {
    case 'is': return { sql: `${col} = ?`, params: [num(value) * scale] };
    case 'isNot': return { sql: `COALESCE(${col}, -1) != ?`, params: [num(value) * scale] };
    case 'gte': return { sql: `${col} >= ?`, params: [num(value) * scale] };
    case 'lte': return { sql: `${col} <= ?`, params: [num(value) * scale] };
    case 'between': {
      const [a, b] = Array.isArray(value) ? value : [NaN, NaN];
      return { sql: `${col} BETWEEN ? AND ?`, params: [Math.min(num(a), num(b)) * scale, Math.max(num(a), num(b)) * scale] };
    }
    default: throw badRequest(`Operator "${op}" is not valid for this field`);
  }
}

function jsonList(col: string, op: string, value: unknown, path = ''): { sql: string; params: Param[] } {
  const v = path ? `json_extract(j.value, '${path}')` : 'j.value';
  const inner = op === 'contains' ? `${v} LIKE ?` : `LOWER(${v}) = LOWER(?)`;
  const param = op === 'contains' ? `%${str(value)}%` : str(value);
  const exists = `EXISTS (SELECT 1 FROM json_each(${col}) j WHERE ${inner})`;
  if (op === 'isNot') return { sql: `NOT ${exists}`, params: [param] };
  if (op !== 'is' && op !== 'contains') throw badRequest(`Operator "${op}" is not valid for this field`);
  return { sql: exists, params: [param] };
}

function ruleSql(r: SmartRule): { sql: string; params: Param[] } {
  switch (r.field) {
    case 'genre': return jsonList('i.genres', r.op, r.value);
    case 'studio': return jsonList('i.studios', r.op, r.value);
    case 'person': return jsonList('i.people', r.op === 'is' ? 'contains' : r.op, r.value, '$.name');
    case 'year': return compare('i.year', r.op, r.value);
    case 'rating': return compare('i.community_rating', r.op, r.value);
    case 'durationMin': return compare('i.duration_ms', r.op, r.value, 60000);
    case 'addedDays': {
      // "added in the last N days" (lte) / "added more than N days ago" (gte)
      const days = Math.max(0, num(r.value));
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      if (r.op === 'lte') return { sql: 'i.added_at >= ?', params: [cutoff] };
      if (r.op === 'gte') return { sql: 'i.added_at < ?', params: [cutoff] };
      throw badRequest('Use "within the last" (lte) or "more than" (gte) for added date');
    }
    case 'contentRating': {
      if (r.op === 'is') return { sql: 'UPPER(TRIM(i.content_rating)) = UPPER(?)', params: [str(r.value)] };
      if (r.op === 'isNot') return { sql: "UPPER(TRIM(COALESCE(i.content_rating, ''))) != UPPER(?)", params: [str(r.value)] };
      throw badRequest('Use is / is not for content rating');
    }
    case 'played': return { sql: `COALESCE(ud.played, 0) = ?`, params: [bool(r.value) !== (r.op === 'isNot') ? 1 : 0] };
    case 'favorite': return { sql: `COALESCE(ud.favorite, 0) = ?`, params: [bool(r.value) !== (r.op === 'isNot') ? 1 : 0] };
    case 'inProgress': {
      const yes = bool(r.value) !== (r.op === 'isNot');
      return { sql: yes ? '(ud.position_ms > 0 AND COALESCE(ud.played, 0) = 0)' : '(COALESCE(ud.position_ms, 0) = 0 OR COALESCE(ud.played, 0) = 1)', params: [] };
    }
    case 'library': return r.op === 'isNot' ? { sql: 'COALESCE(i.library_id, \'\') != ?', params: [str(r.value)] } : { sql: 'i.library_id = ?', params: [str(r.value)] };
    case 'type': {
      const t = str(r.value);
      if (!ITEM_TYPES.has(t)) throw badRequest(`Unknown item type "${t}"`);
      return r.op === 'isNot' ? { sql: 'i.type != ?', params: [t] } : { sql: 'i.type = ?', params: [t] };
    }
    case 'title': {
      if (r.op === 'contains') return { sql: 'i.title LIKE ?', params: [`%${str(r.value)}%`] };
      if (r.op === 'is') return { sql: 'LOWER(i.title) = LOWER(?)', params: [str(r.value)] };
      if (r.op === 'isNot') return { sql: 'LOWER(i.title) != LOWER(?)', params: [str(r.value)] };
      throw badRequest('Use is / is not / contains for title');
    }
    case 'resolution': {
      const min = RESOLUTION_MIN_HEIGHT[str(r.value).toLowerCase()];
      if (min === undefined) throw badRequest('Resolution must be 4K, 1080p, 720p, 480p or SD');
      // For shows/seasons, look at their episodes' files.
      const has = `EXISTS (SELECT 1 FROM media m JOIN items x ON x.id = m.item_id WHERE (x.id = i.id OR x.parent_id = i.id OR x.grandparent_id = i.id) AND COALESCE(m.height, 0) >= ?)`;
      return r.op === 'isNot' ? { sql: `NOT ${has}`, params: [min] } : { sql: has, params: [min] };
    }
    default: throw badRequest(`Unknown rule field "${String((r as SmartRule).field)}"`);
  }
}

export function buildSmartWhere(filter: SmartFilter): { sql: string; params: Param[] } {
  const parts = filter.rules.map(ruleSql);
  const params: Param[] = [];
  const joined = parts.map((p) => {
    params.push(...p.params);
    return `(${p.sql})`;
  }).join(filter.match === 'any' ? ' OR ' : ' AND ');
  // Allowed item types: with "match all" a `type is X` rule narrows on its own; otherwise the default
  // types plus any types the rules mention. Lists never contain collections/playlists (or themselves).
  const typeRules = filter.rules.filter((r) => r.field === 'type' && r.op === 'is').map((r) => String(r.value));
  const allowed = filter.match === 'all' && typeRules.length ? typeRules : [...new Set([...DEFAULT_TYPES, ...typeRules])];
  const typeSql = `i.type IN (${allowed.map(() => '?').join(',')})`;
  params.unshift(...allowed);
  return { sql: `${typeSql} AND (${joined || '1'})`, params };
}

export function evaluateSmart(user: User, filter: SmartFilter, limit = 100, offset = 0): Paged<Item> {
  const w = buildSmartWhere(filter);
  return queryWhere(user, w.sql, w.params, filter.sort, filter.order, toInt(limit, 100, 1, 1000), toInt(offset, 0, 0), filter.limit);
}

smartHooks.evaluate = (user, filter, limit, offset) => evaluateSmart(user, filter as SmartFilter, limit, offset);
