import type {
  HomeRow, HomeRowConfig, Item, MusicInfo, SubtitleStream, Chapter, ItemQuery, ItemSort, MediaSource, Marker, Paged, Person, User, UserItemData, UpdateItemRequest, VideoRangeInfo,
} from '@mediamax/shared';
import { db, itemsVersion, type Param, type Row } from '../db.js';
import { imageUrl } from './images.js';
import { forbidden, notFound } from '../util/errors.js';
import { nowIso, parseJson, ratingLevel, resolutionLabel, sortTitle, toInt } from '../util/misc.js';
import { getBranding } from './branding.js';
import { events, bus } from './events.js';
import { getSettings } from './settings.js';
import { creditsFor } from './music/credits.js';

/* ----------------------------- access ------------------------------ */

export function allowedLibraryIds(user: User): string[] {
  const feats = getBranding().features;
  let rows = db.all<{ id: string; type: string }>('SELECT id, type FROM libraries');
  if (!feats.iptvVod) rows = rows.filter((r) => !r.type.startsWith('iptv-'));
  if (!feats.music) rows = rows.filter((r) => r.type !== 'music');
  if (!feats.photos) rows = rows.filter((r) => r.type !== 'photos');
  const ids = rows.map((r) => r.id);
  if (user.libraryIds === null || user.isAdmin) return ids;
  return ids.filter((id) => user.libraryIds!.includes(id));
}

/** SQL fragment restricting `alias` items to what `user` may see. */
export function accessClause(user: User, alias = 'i', opts: { libraryId?: string | null } = {}): { sql: string; params: Param[] } {
  const libs = allowedLibraryIds(user);
  const parts: string[] = [];
  const params: Param[] = [];
  // A query already restricted to one library the user may see (`library_id = X`) needs no library check: the clause
  // is true for every such row, and leaving it out lets SQLite answer from the (library_id, type, …) indexes.
  if (!(opts.libraryId && libs.includes(opts.libraryId))) {
    const libSql = libs.length ? `${alias}.library_id IN (${libs.map(() => '?').join(',')})` : '0';
    parts.push(`(${libSql} OR ${alias}.type = 'collection' OR (${alias}.type = 'playlist' AND ${alias}.owner_id = ?))`);
    params.push(...libs, user.id);
  }
  const max = ratingLevel(user.maxContentRating);
  if (max !== null && max >= 0) {
    // Effective rating: the item's own, else its show's/parent's. mm_rating_level() → age, NULL (unrated) or -1 (unknown).
    // Effective rating = own rating, else the show's/parent's (subquery only runs when the item has none).
    const eff = `COALESCE(${alias}.content_rating, CASE WHEN ${alias}.parent_id IS NOT NULL THEN (SELECT x.content_rating FROM items x WHERE x.id = COALESCE(${alias}.grandparent_id, ${alias}.parent_id)) END)`;
    // Unrated and unrecognised ratings are allowed by default, or hidden when blockUnratedForRestricted is on
    // (containers like collections/playlists and music stay visible).
    const unratedOk = getSettings().blockUnratedForRestricted || user.hideUnrated ? `${alias}.type IN ('collection','playlist','season','artist','album','track','photo')` : '1';
    parts.push(`mm_rating_ok(${eff}, ?, ${unratedOk}) = 1`);
    params.push(max);
  }
  return { sql: parts.length ? parts.join(' AND ') : '1', params };
}

export function assertCanSee(user: User, itemId: string): Row {
  const a = accessClause(user);
  const row = db.get(`SELECT i.* FROM items i WHERE i.id = ? AND ${a.sql}`, itemId, ...a.params);
  if (!row) throw notFound('Item not found');
  return row;
}

/* ----------------------------- mapping ----------------------------- */

const SELECT_COLS = (userParam = '?') => `
  SELECT i.*, p.title p_title, g.title g_title, p.poster p_poster, g.poster g_poster, p.backdrop p_backdrop, g.backdrop g_backdrop,
    p.logo p_logo, g.logo g_logo, p.content_rating p_rating, g.content_rating g_rating,
    ud.played u_played, ud.play_count u_play_count, ud.position_ms u_position, ud.favorite u_favorite, ud.last_played_at u_last, ud.rating u_rating,
    ud.not_interested u_not_interested, wl.added_at u_watchlist,
    CASE WHEN i.type IN ('collection','playlist') THEN (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = i.id)
         WHEN i.type IN ('show','season','artist','album','audiobook','podcast') THEN (SELECT COUNT(*) FROM items c WHERE c.parent_id = i.id) ELSE 0 END child_count,
    CASE WHEN i.type = 'show' THEN (SELECT COUNT(*) FROM items e LEFT JOIN user_data eu ON eu.item_id = e.id AND eu.user_id = ${userParam} WHERE e.grandparent_id = i.id AND e.type = 'episode' AND COALESCE(eu.played, 0) = 0)
         WHEN i.type = 'season' THEN (SELECT COUNT(*) FROM items e LEFT JOIN user_data eu ON eu.item_id = e.id AND eu.user_id = ${userParam} WHERE e.parent_id = i.id AND e.type = 'episode' AND COALESCE(eu.played, 0) = 0)
         ELSE NULL END unplayed`;

/** The joins every item query uses: parent/grandparent (art, titles), the viewer's user data (`ud`) and watchlist (`wl`). Binds the user id twice. */
const JOINS = (userParam = '?') => `
  FROM items i
  LEFT JOIN items p ON p.id = i.parent_id
  LEFT JOIN items g ON g.id = i.grandparent_id
  LEFT JOIN user_data ud ON ud.item_id = i.id AND ud.user_id = ${userParam}
  LEFT JOIN watchlist wl ON wl.item_id = i.id AND wl.user_id = ${userParam}`;

/**
 * Only the joins a filter/sort actually references. SQLite doesn't drop an unused LEFT JOIN here, so counting or
 * paging a 20k-title library probed user_data and the watchlist once per title for nothing (30+ ms per query).
 */
function neededJoins(sql: string, user: User): { sql: string; params: Param[] } {
  const parts = ['FROM items i'];
  const params: Param[] = [];
  if (/\bp\./.test(sql)) parts.push('LEFT JOIN items p ON p.id = i.parent_id');
  if (/\bg\./.test(sql)) parts.push('LEFT JOIN items g ON g.id = i.grandparent_id');
  if (/\bud\./.test(sql)) {
    parts.push('LEFT JOIN user_data ud ON ud.item_id = i.id AND ud.user_id = ?');
    params.push(user.id);
  }
  if (/\bwl\./.test(sql)) {
    parts.push('LEFT JOIN watchlist wl ON wl.item_id = i.id AND wl.user_id = ?');
    params.push(user.id);
  }
  return { sql: parts.join(' '), params };
}

/** COUNT(*) of items matching a WHERE (same joins rule as paging). */
function countWhere(user: User, whereSql: string, params: Param[]): number {
  const j = neededJoins(whereSql, user);
  return db.get<{ n: number }>(`SELECT COUNT(*) n ${j.sql} WHERE ${whereSql}`, ...j.params, ...params)!.n;
}

/** ORDER BY terms with the title tie-break, unless the sort already ends on it (a repeated term defeats the index). */
const orderBy = (terms: string[], dir: string) => [...terms.map((t) => `${t} ${dir}`), ...(terms[terms.length - 1] === 'i.sort_title' ? [] : ['i.sort_title'])].join(', ');

const SELECT = (userParam = '?') => `${SELECT_COLS(userParam)}${JOINS(userParam)}`;

/**
 * Paged item queries run in two steps: first the matching ids (filter + sort + LIMIT, with only the joins the
 * filter needs), then the full rows for just that page. SQLite computes every selected column, including the
 * child/unplayed count subqueries, for each row it sorts, so a one-step `ORDER BY … LIMIT 20` over a big library
 * ran those subqueries for every title instead of for the 20 it returned.
 */
function pagedRows(user: User, whereSql: string, params: Param[], tail: string, tailParams: Param[] = []): Row[] {
  const j = neededJoins(`${whereSql} ${tail}`, user);
  const ids = db.all<{ id: string }>(`SELECT i.id ${j.sql} WHERE ${whereSql} ${tail}`, ...j.params, ...params, ...tailParams).map((r) => r.id);
  return rowsByIds(user, ids);
}

/** Full item rows (SELECT columns) for ids, in the given order. Callers have already applied access rules. */
function rowsByIds(user: User, ids: string[]): Row[] {
  if (!ids.length) return [];
  const byId = new Map<string, Row>();
  for (let k = 0; k < ids.length; k += 400) {
    const chunk = ids.slice(k, k + 400);
    for (const r of db.all(`${SELECT()} WHERE i.id IN (${chunk.map(() => '?').join(',')})`, ...userParams(user), ...chunk)) byId.set(r.id, r);
  }
  return ids.map((id) => byId.get(id)).filter((r): r is Row => !!r);
}

/** SELECT() binds the viewer's id this many times, before any other parameter. */
const userParams = (user: User): Param[] => [user.id, user.id, user.id, user.id];

function userData(r: Row): UserItemData {
  const ud: UserItemData = {
    played: !!r.u_played,
    playCount: r.u_play_count ?? 0,
    positionMs: r.u_position ?? 0,
    favorite: !!r.u_favorite,
    lastPlayedAt: r.u_last ?? null,
    rating: r.u_rating ?? null,
    inWatchlist: r.u_watchlist != null,
    notInterested: !!r.u_not_interested,
  };
  if (r.unplayed !== null && r.unplayed !== undefined) {
    ud.unplayedCount = r.unplayed;
    ud.played = r.unplayed === 0 && r.child_count > 0;
  }
  return ud;
}

export function rowToItem(r: Row): Item {
  const isEpisodeLike = r.type === 'episode' || r.type === 'track' || r.type === 'bookpart' || r.type === 'podcastepisode';
  const isSeason = r.type === 'season';
  const poster = r.poster ?? (isSeason ? r.p_poster : null) ?? (isEpisodeLike ? (r.type === 'episode' ? r.g_poster ?? r.p_poster : r.p_poster) : null);
  const backdrop = r.backdrop ?? r.p_backdrop ?? r.g_backdrop ?? null;
  const extra = parseJson<Record<string, unknown>>(r.extra, {});
  return {
    id: r.id,
    libraryId: r.library_id,
    type: r.type,
    title: r.title,
    sortTitle: r.sort_title,
    originalTitle: r.original_title ?? null,
    year: r.year ?? null,
    overview: r.overview ?? null,
    tagline: r.tagline ?? null,
    communityRating: r.community_rating ?? null,
    contentRating: r.content_rating ?? r.p_rating ?? r.g_rating ?? null,
    durationMs: r.duration_ms ?? null,
    genres: parseJson<string[]>(r.genres, []),
    studios: parseJson<string[]>(r.studios, []),
    people: parseJson<Person[]>(r.people, []),
    posterUrl: imageUrl(poster),
    backdropUrl: imageUrl(backdrop),
    logoUrl: imageUrl(r.logo ?? r.p_logo ?? r.g_logo ?? null),
    thumbUrl: imageUrl(r.thumb ?? (r.type === 'episode' ? null : r.backdrop) ?? null),
    parentId: r.parent_id ?? null,
    grandparentId: r.grandparent_id ?? null,
    parentTitle: r.p_title ?? (extra.parentTitle as string) ?? null,
    grandparentTitle: r.g_title ?? null,
    index: r.idx ?? null,
    parentIndex: r.parent_idx ?? null,
    childCount: r.child_count ?? 0,
    addedAt: r.added_at,
    releaseDate: r.release_date ?? null,
    externalIds: parseJson(r.external_ids, {}),
    userData: userData(r),
    trailerUrl: r.trailer_url ?? null,
    ...(r.smart ? { smart: parseJson(r.smart, null) } : {}),
    ...((extra as any).series ? { series: (extra as any).series } : {}),
    ...((extra as any).extraType ? { extraType: (extra as any).extraType } : {}),
    ...((extra as any).replayGain ? { replayGain: (extra as any).replayGain } : {}),
    ...(!(extra as any).series && r.provider_meta && r.provider_meta !== '{}' && parseJson<any>(r.provider_meta, {}).series ? { series: parseJson<any>(r.provider_meta, {}).series } : {}),
    ...(r.ratings ? { ratings: parseJson(r.ratings, null) } : {}),
    ...(r.type === 'album' || r.type === 'track' ? musicInfo(r, extra) : {}),
    ...(r.type === 'show' ? { episodeOrder: (extra as any).episodeOrder === 'dvd' || (extra as any).episodeOrder === 'absolute' ? (extra as any).episodeOrder : 'aired' } : {}),
  };
}

export function mediaRowToSource(m: Row): MediaSource {
  return {
    id: m.id,
    container: m.container,
    durationMs: m.duration_ms ?? 0,
    size: m.size ?? 0,
    bitrate: m.bitrate,
    width: m.width,
    height: m.height,
    videoCodec: m.video_codec,
    resolutionLabel: resolutionLabel(m.width, m.height),
    hdr: !!m.hdr,
    videoRange: parseJson<VideoRangeInfo | null>(m.video_range, null),
    audioStreams: parseJson(m.audio, []),
    subtitleStreams: parseJson<(SubtitleStream & { path?: string })[]>(m.subs, []).map(({ path: _p, ...s }) => s),
    remote: !m.path && !!m.remote_url,
    edition: m.edition ?? null,
  };
}

/* ----------------------------- queries ----------------------------- */

const SORTS: Record<ItemSort, string[]> = {
  title: ['i.sort_title'],
  addedAt: ['i.added_at'],
  year: ['COALESCE(i.year, 0)'],
  releaseDate: ["COALESCE(i.release_date, '')"],
  rating: ['COALESCE(i.community_rating, 0)'],
  lastPlayed: ["COALESCE(ud.last_played_at, '')"],
  random: ['RANDOM()'],
  index: ['COALESCE(i.parent_idx, 0)', 'COALESCE(i.idx, 0)'],
};

export function queryItems(user: User, q: ItemQuery): Paged<Item> {
  const a = accessClause(user, 'i', { libraryId: q.libraryId });
  const where: string[] = [a.sql];
  const params: Param[] = [...userParams(user), ...a.params];
  const limit = toInt(q.limit, 50, 1, 500);
  const offset = toInt(q.offset, 0, 0);
  if (q.libraryId) {
    where.push('i.library_id = ?');
    params.push(q.libraryId);
  }
  if (q.parentId) {
    where.push('i.parent_id = ?');
    params.push(q.parentId);
  }
  if (q.ancestorId) {
    where.push('(i.parent_id = ? OR i.grandparent_id = ?)');
    params.push(q.ancestorId, q.ancestorId);
  }
  const types = q.type ? String(q.type).split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (types.length) {
    where.push(`i.type IN (${types.map(() => '?').join(',')})`);
    params.push(...types);
  } else if (!q.parentId && !q.ancestorId && !q.search) {
    // Library browsing defaults to top-level items.
    where.push("i.type IN ('movie','show','artist','photo','video','album','audiobook','podcast')");
    if (q.libraryId) {
      const lib = db.get<{ type: string }>('SELECT type FROM libraries WHERE id = ?', q.libraryId);
      if (lib?.type === 'music') where.push("i.type = 'artist'");
    }
  }
  // Extras (videos attached to a movie/show) only appear via their owner (GET /items/:id/extras).
  // (Redundant when the requested types exclude videos; leaving it out keeps the indexed browse queries covering.)
  if (!q.parentId && (!types.length || types.includes('video'))) where.push("NOT (i.type = 'video' AND i.parent_id IS NOT NULL)");
  if (q.genre) {
    where.push('EXISTS (SELECT 1 FROM json_each(i.genres) WHERE json_each.value = ?)');
    params.push(q.genre);
  }
  if (q.year) {
    where.push('i.year = ?');
    params.push(Number(q.year));
  }
  if (q.search) {
    where.push('(i.title LIKE ? OR i.original_title LIKE ?)');
    params.push(`%${q.search}%`, `%${q.search}%`);
  }
  if (q.series) {
    where.push("json_extract(i.extra, '$.series.name') = ?");
    params.push(String(q.series));
  }
  if (q.letter) {
    if (q.letter === '#') where.push("substr(i.sort_title,1,1) NOT BETWEEN 'a' AND 'z'");
    else {
      where.push('substr(i.sort_title,1,1) = ?');
      params.push(q.letter.toLowerCase().slice(0, 1));
    }
  }
  // `ud.x = 1` (not COALESCE(ud.x,0) = 1, same rows) lets SQLite start from the viewer's user_data rows.
  if (q.played !== undefined) where.push(String(q.played) === 'true' ? 'ud.played = 1' : 'COALESCE(ud.played,0) = 0');
  if (q.favorite !== undefined && String(q.favorite) === 'true') where.push('ud.favorite = 1');
  let sort = SORTS[q.sort as ItemSort] ?? (q.parentId || q.ancestorId ? SORTS.index : SORTS.title);
  if (q.series && !q.sort) sort = ["COALESCE(json_extract(i.extra, '$.series.index'), 9999)", 'i.year'];
  // Across several parents (an artist's albums, a show's seasons), keep each parent's children together.
  if (q.ancestorId && sort === SORTS.index) {
    sort = ['(SELECT COALESCE(x.year, 0) FROM items x WHERE x.id = i.parent_id)', '(SELECT x.sort_title FROM items x WHERE x.id = i.parent_id)', ...SORTS.index];
  }
  const dir = q.order === 'desc' ? 'DESC' : q.order === 'asc' ? 'ASC' : q.sort === 'addedAt' || q.sort === 'rating' || q.sort === 'lastPlayed' ? 'DESC' : 'ASC';
  const whereParams = params.slice(userParams(user).length);
  const total = countWhere(user, where.join(' AND '), whereParams);
  const rows = offset >= total ? [] : pagedRows(user, where.join(' AND '), whereParams, `ORDER BY ${orderBy(sort, dir)} LIMIT ? OFFSET ?`, [limit, offset]);
  return { items: rows.map(rowToItem), total, limit, offset };
}

/** Paged query with a caller-built WHERE (values must be bound params). Used by smart lists. */
export function queryWhere(user: User, whereSql: string, params: Param[], sort: ItemSort, order: 'asc' | 'desc', limit: number, offset: number, maxTotal: number | null = null): Paged<Item> {
  const a = accessClause(user);
  const where = `${a.sql} AND (${whereSql})`;
  let total = countWhere(user, where, [...a.params, ...params]);
  if (maxTotal) total = Math.min(total, maxTotal);
  const lim = Math.max(0, Math.min(limit, total - offset));
  if (lim <= 0) return { items: [], total, limit, offset };
  const s = SORTS[sort] ?? SORTS.title;
  const dir = order === 'desc' ? 'DESC' : 'ASC';
  const rows = pagedRows(user, where, [...a.params, ...params], `ORDER BY ${orderBy(s, dir)} LIMIT ? OFFSET ?`, [lim, offset]);
  return { items: rows.map(rowToItem), total, limit, offset };
}

/** Items matching a caller-built WHERE (bound params only), with access rules applied. `ud` and `wl` are the viewer's user data / watchlist rows. */
export function selectItems(user: User, whereSql: string, params: Param[], tail = ''): Item[] {
  const a = accessClause(user);
  // Sorted/limited selections fetch ids first (see pagedRows); unbounded ones are loaded in one go.
  if (/\bLIMIT\b/i.test(tail)) return pagedRows(user, `${a.sql} AND (${whereSql})`, [...a.params, ...params], tail).map(rowToItem);
  return db.all(`${SELECT()} WHERE ${a.sql} AND (${whereSql}) ${tail}`, ...userParams(user), ...a.params, ...params).map(rowToItem);
}

/** Items by id, in the given order (unknown or hidden ids are skipped). */
export function itemsByIds(user: User, ids: string[]): Item[] {
  if (!ids.length) return [];
  const out = new Map<string, Item>();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    for (const it of selectItems(user, `i.id IN (${chunk.map(() => '?').join(',')})`, chunk)) out.set(it.id, it);
  }
  return ids.map((id) => out.get(id)).filter((x): x is Item => !!x);
}

/** Release facts (albums) and the tagged artist string (tracks); credits are attached separately (withCredits). */
function musicInfo(r: Row, extra: Record<string, any>): Pick<Item, 'music'> {
  const pm = r.provider_meta && r.provider_meta !== '{}' ? parseJson<Record<string, any>>(r.provider_meta, {}) : {};
  if (r.type === 'album') {
    const m = extra.music ?? {};
    const mb = pm.mb ?? {};
    const music: MusicInfo = {
      releaseTypes: m.releaseTypes?.length ? m.releaseTypes : mb.types ?? [],
      releaseStatus: m.releaseStatus ?? mb.status ?? null,
      originalYear: m.originalYear ?? mb.firstYear ?? null,
      originalDate: m.originalDate ?? mb.firstDate ?? null,
      label: m.label ?? mb.label ?? null,
      catalogNumber: m.catalogNumber ?? mb.catalogNumber ?? null,
      barcode: m.barcode ?? mb.barcode ?? null,
      compilation: !!(m.compilation || (mb.types ?? []).includes('compilation')),
      ...(m.discTitles ? { discTitles: m.discTitles } : {}),
    };
    return { music };
  }
  return { music: { displayArtist: extra.tags?.artist || pm.identified?.artist || null, ...(pm.identified ? { identified: true } : {}) } };
}

/** Attach multi-artist credits to the tracks of a list (one query). */
export function withCredits(items: Item[]): Item[] {
  const ids = items.filter((i) => i.type === 'track').map((i) => i.id);
  if (!ids.length) return items;
  const map = creditsFor(ids);
  for (const it of items) {
    const c = map.get(it.id);
    if (c?.length) it.music = { ...(it.music ?? {}), credits: c };
  }
  return items;
}

export function getItem(user: User, id: string, withMedia = true): Item {
  const items = selectItems(user, 'i.id = ?', [id]);
  if (!items.length) throw notFound('Item not found');
  const item = items[0];
  if (item.type === 'track') withCredits([item]);
  if (item.smart && smartHooks.evaluate) item.childCount = smartHooks.evaluate(user, item.smart, 1, 0).total;
  if (withMedia) {
    item.media = db.all('SELECT * FROM media WHERE item_id = ? ORDER BY COALESCE(width,0) DESC', id).map(mediaRowToSource);
    const row = db.get('SELECT markers, locked_fields FROM items WHERE id = ?', id);
    item.markers = parseJson<Marker[]>(row?.markers, []);
    item.lockedFields = parseJson<string[]>(row?.locked_fields, []);
    const ch = db.get<{ chapters: string }>("SELECT chapters FROM media WHERE item_id = ? AND chapters != '[]' LIMIT 1", id);
    if (ch) item.chapters = parseJson<Chapter[]>(ch.chapters, []);
    // Built-in metadata providers: Audnexus chapters (audiobooks), fanart.tv/TheAudioDB extra art, artist facts.
    const pm = parseJson<{ chapters?: Chapter[]; art?: Record<string, string>; artistInfo?: Item['artistInfo'] }>(db.get<{ provider_meta: string }>('SELECT provider_meta FROM items WHERE id = ?', id)?.provider_meta, {});
    if (!item.chapters?.length && pm.chapters?.length && item.type === 'audiobook') item.chapters = pm.chapters;
    if (pm.art && Object.keys(pm.art).length) item.extraArt = { clearArtUrl: imageUrl(pm.art.clearart), discArtUrl: imageUrl(pm.art.discart), bannerUrl: imageUrl(pm.art.banner) };
    if (pm.artistInfo && item.type === 'artist') item.artistInfo = pm.artistInfo;
    if (item.type === 'show' || item.type === 'season') {
      // Aggregate duration hint for containers.
      item.media = [];
    }
  }
  return item;
}

/** Set by services/smart.ts (avoids a circular import). */
export const smartHooks: { evaluate?: (user: User, filter: any, limit: number, offset: number) => Paged<Item> } = {};

export function getChildren(user: User, id: string, q: { sort?: ItemSort; order?: 'asc' | 'desc'; limit?: number; offset?: number }): Paged<Item> {
  const parent = assertCanSee(user, id);
  const limit = toInt(q.limit, 500, 1, 2000);
  const offset = toInt(q.offset, 0, 0);
  if (parent.smart && smartHooks.evaluate) return smartHooks.evaluate(user, parseJson(parent.smart, null), limit, offset);
  if (parent.type === 'collection' || parent.type === 'playlist') {
    const a = accessClause(user);
    const rows = db.all(
      `${SELECT()} JOIN collection_items ci ON ci.item_id = i.id AND ci.collection_id = ? WHERE ${a.sql} ORDER BY ci.sort, i.sort_title LIMIT ? OFFSET ?`,
      ...userParams(user), id, ...a.params, limit, offset);
    const total = db.get<{ n: number }>('SELECT COUNT(*) n FROM collection_items WHERE collection_id = ?', id)!.n;
    return { items: withCredits(rows.map(rowToItem)), total, limit, offset };
  }
  const res = queryItems(user, { parentId: id, sort: q.sort ?? 'index', order: q.order, limit, offset, type: undefined });
  if (parent.type === 'album') withCredits(res.items);
  return res;
}

export function similarItems(user: User, id: string, limit = 12): Item[] {
  const row = assertCanSee(user, id);
  const genres = parseJson<string[]>(row.genres, []).slice(0, 6);
  const lim = toInt(limit, 12, 1, 50);
  if (!genres.length) return selectItems(user, 'i.type = ? AND i.id != ?', [row.type, id], `ORDER BY RANDOM() LIMIT ${lim}`);
  // Score by number of shared genres, then rating.
  const score = genres.map(() => '(EXISTS (SELECT 1 FROM json_each(i.genres) WHERE value = ?))').join(' + ');
  return selectItems(user, `i.type = ? AND i.id != ? AND (${score}) > 0`, [row.type, id, ...genres, ...genres],
    `ORDER BY (${score}) DESC, COALESCE(i.community_rating,0) DESC LIMIT ${lim}`);
}

/** Next episode (or track) after `id`. */
export function nextItem(user: User, id: string): Item | null {
  const row = assertCanSee(user, id);
  if (row.type === 'show' || row.type === 'season') {
    // Next up: resume an in-progress episode, else the first unplayed after the last watched, else the first episode.
    const col = row.type === 'show' ? 'grandparent_id' : 'parent_id';
    const order = 'ORDER BY COALESCE(i.parent_idx,0) = 0, COALESCE(i.parent_idx,0), COALESCE(i.idx,0)';
    const inProgress = selectItems(user, `i.${col} = ? AND i.type = 'episode' AND ud.position_ms > 0 AND COALESCE(ud.played,0) = 0`, [id], 'ORDER BY ud.last_played_at DESC LIMIT 1');
    if (inProgress[0]) return inProgress[0];
    const last = db.get(`SELECT i.parent_idx, i.idx FROM items i JOIN user_data ud ON ud.item_id = i.id AND ud.user_id = ? WHERE i.${col} = ? AND ud.played = 1 ORDER BY COALESCE(i.parent_idx,0) DESC, COALESCE(i.idx,0) DESC LIMIT 1`, user.id, id);
    if (last) {
      const n = selectItems(user, `i.${col} = ? AND i.type = 'episode' AND COALESCE(ud.played,0) = 0 AND (COALESCE(i.parent_idx,0) > ? OR (COALESCE(i.parent_idx,0) = ? AND COALESCE(i.idx,0) > ?))`, [id, last.parent_idx ?? 0, last.parent_idx ?? 0, last.idx ?? 0], `${order} LIMIT 1`);
      if (n[0]) return n[0];
    }
    return selectItems(user, `i.${col} = ? AND i.type = 'episode' AND COALESCE(ud.played,0) = 0`, [id], `${order} LIMIT 1`)[0] ?? null;
  }
  if (row.type === 'episode' && row.grandparent_id) {
    const r = selectItems(user, `i.grandparent_id = ? AND i.type = 'episode' AND (COALESCE(i.parent_idx,0) > ? OR (COALESCE(i.parent_idx,0) = ? AND COALESCE(i.idx,0) > ?))`,
      [row.grandparent_id, row.parent_idx ?? 0, row.parent_idx ?? 0, row.idx ?? 0], 'ORDER BY COALESCE(i.parent_idx,0), COALESCE(i.idx,0) LIMIT 1');
    return r[0] ?? null;
  }
  if (row.type === 'bookpart' && row.parent_id) {
    const r = selectItems(user, `i.parent_id = ? AND i.type = 'bookpart' AND COALESCE(i.idx,0) > ?`, [row.parent_id, row.idx ?? 0], 'ORDER BY COALESCE(i.idx,0) LIMIT 1');
    return r[0] ?? null;
  }
  if (row.type === 'audiobook' || row.type === 'podcast') {
    // Resume where the listener left off, else start at the first part / newest unplayed episode.
    const inProgress = selectItems(user, `i.parent_id = ? AND ud.position_ms > 0 AND COALESCE(ud.played,0) = 0`, [id], 'ORDER BY ud.last_played_at DESC LIMIT 1');
    if (inProgress[0]) return inProgress[0];
    const order = row.type === 'audiobook' ? 'ORDER BY COALESCE(i.idx,0)' : "ORDER BY COALESCE(i.release_date,'') DESC";
    return selectItems(user, `i.parent_id = ? AND COALESCE(ud.played,0) = 0`, [id], `${order} LIMIT 1`)[0] ?? null;
  }
  if (row.type === 'track' && row.parent_id) {
    const r = selectItems(user, `i.parent_id = ? AND i.type = 'track' AND (COALESCE(i.parent_idx,0) > ? OR (COALESCE(i.parent_idx,0) = ? AND COALESCE(i.idx,0) > ?))`,
      [row.parent_id, row.parent_idx ?? 0, row.parent_idx ?? 0, row.idx ?? 0], 'ORDER BY COALESCE(i.parent_idx,0), COALESCE(i.idx,0) LIMIT 1');
    return r[0] ?? null;
  }
  return null;
}

/** Genre lists per (library, access rules), valid until an item is added, removed or re-tagged (itemsVersion). */
const genreCache = new Map<string, { v: number; list: string[] }>();

export function genres(user: User, libraryId?: string): string[] {
  const a = accessClause(user);
  // The viewer's id is only bound for their own playlists, which genre lists never include: viewers with the same
  // libraries and rating limit share an entry.
  const key = `${libraryId ?? ''}|${a.sql}|${JSON.stringify(a.params.filter((p) => p !== user.id))}`;
  const v = itemsVersion();
  const hit = genreCache.get(key);
  if (hit && hit.v === v) return [...hit.list];
  const list = genresUncached(a, libraryId);
  if (genreCache.size > 500) genreCache.clear();
  genreCache.set(key, { v, list });
  return [...list];
}

function genresUncached(a: { sql: string; params: Param[] }, libraryId?: string): string[] {
  const rows = db.all<{ value: string }>(
    `SELECT DISTINCT j.value FROM items i, json_each(i.genres) j WHERE ${a.sql} ${libraryId ? 'AND i.library_id = ?' : ''} AND i.type IN ('movie','show','album','artist') ORDER BY j.value`,
    ...a.params, ...(libraryId ? [libraryId] : []));
  return rows.map((r) => r.value);
}

/* ---------------------------- user data ---------------------------- */

function ensureUd(userId: string, itemId: string) {
  db.run('INSERT OR IGNORE INTO user_data (user_id, item_id) VALUES (?, ?)', userId, itemId);
}

function currentUd(user: User, itemId: string): UserItemData {
  return getItem(user, itemId, false).userData;
}

function emitUd(user: User, itemId: string): UserItemData {
  const ud = currentUd(user, itemId);
  events.toUser(user.id, { type: 'userdata.updated', itemId, userData: ud });
  return ud;
}

/** Leaf items (playable) under an item, for cascade operations. */
function leafIds(itemId: string, type: string): string[] {
  if (type === 'show' || type === 'artist') return db.all<{ id: string }>("SELECT id FROM items WHERE grandparent_id = ? AND type IN ('episode','track')", itemId).map((r) => r.id);
  if (type === 'season' || type === 'album' || type === 'audiobook' || type === 'podcast') return db.all<{ id: string }>('SELECT id FROM items WHERE parent_id = ?', itemId).map((r) => r.id);
  if (type === 'collection' || type === 'playlist') return db.all<{ item_id: string }>('SELECT item_id FROM collection_items WHERE collection_id = ?', itemId).map((r) => r.item_id);
  return [itemId];
}

export function setPlayed(user: User, itemId: string, played: boolean): UserItemData {
  const row = assertCanSee(user, itemId);
  const ids = leafIds(itemId, row.type);
  const now = nowIso();
  db.tx(() => {
    for (const id of ids) {
      ensureUd(user.id, id);
      if (played) db.run('UPDATE user_data SET played = 1, play_count = play_count + 1, position_ms = 0, last_played_at = ? WHERE user_id = ? AND item_id = ?', now, user.id, id);
      else db.run('UPDATE user_data SET played = 0, position_ms = 0 WHERE user_id = ? AND item_id = ?', user.id, id);
    }
  });
  if (played) bus.emit('items.played', { user, itemIds: ids });
  return emitUd(user, itemId);
}

export function setFavorite(user: User, itemId: string, fav: boolean): UserItemData {
  assertCanSee(user, itemId);
  ensureUd(user.id, itemId);
  db.run('UPDATE user_data SET favorite = ? WHERE user_id = ? AND item_id = ?', fav, user.id, itemId);
  bus.emit('userdata.changed', { userId: user.id, itemId });
  return emitUd(user, itemId);
}

export function setRating(user: User, itemId: string, rating: number | null): UserItemData {
  assertCanSee(user, itemId);
  ensureUd(user.id, itemId);
  const r = rating === null ? null : Math.max(0, Math.min(10, Number(rating)));
  db.run('UPDATE user_data SET rating = ? WHERE user_id = ? AND item_id = ?', r, user.id, itemId);
  bus.emit('userdata.changed', { userId: user.id, itemId });
  return emitUd(user, itemId);
}

/** Add to / remove from the viewer's watchlist ("My List"). */
export function setWatchlist(user: User, itemId: string, on: boolean): UserItemData {
  assertCanSee(user, itemId);
  if (on) db.run('INSERT OR IGNORE INTO watchlist (user_id, item_id, added_at) VALUES (?, ?, ?)', user.id, itemId, nowIso());
  else db.run('DELETE FROM watchlist WHERE user_id = ? AND item_id = ?', user.id, itemId);
  if (on) {
    // Wanting to watch something overrides an earlier "not interested".
    db.run('UPDATE user_data SET not_interested = 0 WHERE user_id = ? AND item_id = ?', user.id, itemId);
  }
  bus.emit('userdata.changed', { userId: user.id, itemId });
  return emitUd(user, itemId);
}

/** "Not interested": hides the title from recommendation, because-you-watched and trending rows for this viewer. */
export function setNotInterested(user: User, itemId: string, on: boolean): UserItemData {
  assertCanSee(user, itemId);
  ensureUd(user.id, itemId);
  db.run('UPDATE user_data SET not_interested = ? WHERE user_id = ? AND item_id = ?', on, user.id, itemId);
  if (on) db.run('DELETE FROM watchlist WHERE user_id = ? AND item_id = ?', user.id, itemId);
  bus.emit('userdata.changed', { userId: user.id, itemId });
  return emitUd(user, itemId);
}

/** The viewer's watchlist, newest first. */
export function listWatchlist(user: User, limit = 100, offset = 0): Paged<Item> {
  const lim = toInt(limit, 100, 1, 500);
  const off = toInt(offset, 0, 0);
  const a = accessClause(user);
  const total = db.get<{ n: number }>(`SELECT COUNT(*) n FROM watchlist wl JOIN items i ON i.id = wl.item_id WHERE wl.user_id = ? AND ${a.sql}`, user.id, ...a.params)!.n;
  // Page through the (small, indexed) watchlist first, then load just those items.
  const ids = db.all<{ item_id: string }>(`SELECT wl.item_id FROM watchlist wl JOIN items i ON i.id = wl.item_id WHERE wl.user_id = ? AND ${a.sql} ORDER BY wl.added_at DESC, wl.rowid DESC LIMIT ? OFFSET ?`,
    user.id, ...a.params, lim, off).map((r) => r.item_id);
  return { items: itemsByIds(user, ids), total, limit: lim, offset: off };
}

export function reportProgress(user: User, itemId: string, positionMs: number, durationMs?: number | null, state?: string): UserItemData {
  const row = assertCanSee(user, itemId);
  // Trust the library's duration first: while a transcode is still running the player only knows the length
  // transcoded so far, which would make a mid-film position look finished (and wipe the resume point).
  const dur = row.duration_ms || durationMs || 0;
  const pos = Math.max(0, Math.round(positionMs));
  ensureUd(user.id, itemId);
  const now = nowIso();
  const ud = db.get('SELECT * FROM user_data WHERE user_id = ? AND item_id = ?', user.id, itemId)!;
  const isAudio = row.type === 'track';
  if (dur > 0 && pos / dur >= 0.9) {
    // Scrobble once per completion.
    if (ud.position_ms > 0 || !ud.played || state === 'stopped') {
      db.run('UPDATE user_data SET played = 1, play_count = play_count + ?, position_ms = 0, last_played_at = ? WHERE user_id = ? AND item_id = ?',
        ud.position_ms > 0 || !ud.played ? 1 : 0, now, user.id, itemId);
      if (ud.position_ms > 0 || !ud.played) bus.emit('playback.scrobble', { user, itemId });
    }
  } else if (isAudio) {
    db.run('UPDATE user_data SET last_played_at = ? WHERE user_id = ? AND item_id = ?', now, user.id, itemId);
  } else if (pos > 30000 || (dur > 0 && pos / dur > 0.02)) {
    db.run('UPDATE user_data SET position_ms = ?, last_played_at = ? WHERE user_id = ? AND item_id = ?', pos, now, user.id, itemId);
  } else {
    db.run('UPDATE user_data SET last_played_at = ? WHERE user_id = ? AND item_id = ?', now, user.id, itemId);
  }
  return state === 'stopped' || state === 'paused' ? emitUd(user, itemId) : currentUd(user, itemId);
}

/* -------------------------- admin editing -------------------------- */

export function updateItem(id: string, req: UpdateItemRequest): void {
  const cur = db.get('SELECT * FROM items WHERE id = ?', id);
  if (!cur) throw notFound('Item not found');
  const patch: Row = { updated_at: nowIso() };
  const locked = new Set(parseJson<string[]>(cur.locked_fields, []));
  const map: [keyof UpdateItemRequest, string, (v: any) => any][] = [
    ['title', 'title', String], ['sortTitle', 'sort_title', (v) => String(v).toLowerCase()], ['originalTitle', 'original_title', (v) => v],
    ['year', 'year', (v) => (v == null ? null : Number(v))], ['overview', 'overview', (v) => v], ['tagline', 'tagline', (v) => v],
    ['contentRating', 'content_rating', (v) => v || null], ['communityRating', 'community_rating', (v) => (v == null ? null : Number(v))],
    ['genres', 'genres', (v) => JSON.stringify(v ?? [])], ['studios', 'studios', (v) => JSON.stringify(v ?? [])],
  ];
  for (const [k, col, fn] of map) {
    if (req[k] !== undefined) {
      patch[col] = fn(req[k]);
      locked.add(k);
    }
  }
  if (req.title !== undefined && req.sortTitle === undefined) patch.sort_title = sortTitle(req.title);
  if (req.lockedFields) {
    locked.clear();
    req.lockedFields.forEach((f) => locked.add(f));
  }
  patch.locked_fields = JSON.stringify([...locked]);
  if (req.markers) patch.markers = JSON.stringify(req.markers.filter((m) => m.endMs > m.startMs));
  if (req.episodeOrder !== undefined && cur.type === 'show' && ['aired', 'dvd', 'absolute'].includes(req.episodeOrder)) {
    patch.extra = JSON.stringify({ ...parseJson<Record<string, unknown>>(cur.extra, {}), episodeOrder: req.episodeOrder });
  }
  db.update('items', id, patch);
}

/* ------------------------- collections/playlists ------------------- */

export function createContainer(type: 'collection' | 'playlist', title: string, ownerId: string | null, itemIds: string[] = [], overview?: string): string {
  const id = `${type === 'collection' ? 'c' : 'p'}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const now = nowIso();
  db.insert('items', { id, library_id: null, type, title, sort_title: sortTitle(title), overview: overview ?? null, added_at: now, updated_at: now, owner_id: ownerId });
  addToContainer(id, itemIds);
  return id;
}

export function addToContainer(id: string, itemIds: string[]) {
  const max = db.get<{ m: number | null }>('SELECT MAX(sort) m FROM collection_items WHERE collection_id = ?', id)?.m ?? 0;
  let sort = max ?? 0;
  db.tx(() => {
    for (const itemId of itemIds) {
      if (!db.get('SELECT 1 FROM items WHERE id = ?', itemId)) continue;
      db.run('INSERT OR IGNORE INTO collection_items (collection_id, item_id, sort) VALUES (?, ?, ?)', id, itemId, ++sort);
    }
    // Use first member's artwork if the container has none.
    const c = db.get('SELECT poster, backdrop FROM items WHERE id = ?', id);
    if (c && !c.poster) {
      const first = db.get(`SELECT COALESCE(i.poster, g.poster) poster, COALESCE(i.backdrop, g.backdrop) backdrop FROM collection_items ci JOIN items i ON i.id = ci.item_id LEFT JOIN items g ON g.id = i.grandparent_id WHERE ci.collection_id = ? ORDER BY ci.sort LIMIT 1`, id);
      if (first) db.run('UPDATE items SET poster = ?, backdrop = COALESCE(backdrop, ?) WHERE id = ?', first.poster, first.backdrop, id);
    }
  });
}

export function removeFromContainer(id: string, itemId: string) {
  db.run('DELETE FROM collection_items WHERE collection_id = ? AND item_id = ?', id, itemId);
}

export function getContainer(id: string, type: 'collection' | 'playlist', user: User): Row {
  const row = db.get('SELECT * FROM items WHERE id = ? AND type = ?', id, type);
  if (!row) throw notFound(`${type} not found`);
  if (type === 'playlist' && row.owner_id !== user.id && !user.isAdmin) throw forbidden();
  return row;
}

export function listContainers(user: User, type: 'collection' | 'playlist'): Item[] {
  const items = type === 'collection'
    ? selectItems(user, "i.type = 'collection'", [], 'ORDER BY i.sort_title')
    : selectItems(user, "i.type = 'playlist' AND i.owner_id = ?", [user.id], 'ORDER BY i.sort_title');
  for (const it of items) if (it.smart && smartHooks.evaluate) it.childCount = smartHooks.evaluate(user, it.smart, 1, 0).total;
  return items;
}

/* ------------------------------- home ------------------------------ */

export function continueWatching(user: User, limit = 20): Item[] {
  return selectItems(user, "ud.position_ms > 0 AND i.type IN ('movie','episode','video','bookpart','podcastepisode')", [], `ORDER BY ud.last_played_at DESC LIMIT ${toInt(limit, 20, 1, 100)}`);
}

export function nextUp(user: User, limit = 20): Item[] {
  // Shows the viewer watched recently, each with the furthest episode they finished (season × 1e6 + episode).
  const recentShows = db.all<{ show: string; last: string; k: number }>(
    `SELECT i.grandparent_id show, MAX(ud.last_played_at) last, MAX(COALESCE(i.parent_idx,0) * 1000000 + COALESCE(i.idx,0)) k
     FROM user_data ud JOIN items i ON i.id = ud.item_id
     WHERE ud.user_id = ? AND i.type = 'episode' AND ud.played = 1 AND i.grandparent_id IS NOT NULL
     GROUP BY i.grandparent_id ORDER BY last DESC LIMIT 60`, user.id);
  if (!recentShows.length) return [];
  // For all of them at once: the first untouched episode after that one (one query instead of two per show).
  const a = accessClause(user);
  const next = db.all<{ show: string; id: string }>(
    `WITH w AS (SELECT json_extract(j.value, '$[0]') show, json_extract(j.value, '$[1]') k FROM json_each(?) j)
     SELECT i.grandparent_id show, i.id, MIN(COALESCE(i.parent_idx,0) * 1000000 + COALESCE(i.idx,0)) nk
     FROM w JOIN items i ON i.grandparent_id = w.show
     LEFT JOIN user_data ud ON ud.item_id = i.id AND ud.user_id = ?
     WHERE i.type = 'episode' AND COALESCE(ud.played,0) = 0 AND COALESCE(ud.position_ms,0) = 0 AND COALESCE(i.parent_idx,0) > 0
       AND COALESCE(i.parent_idx,0) * 1000000 + COALESCE(i.idx,0) > w.k AND ${a.sql}
     GROUP BY i.grandparent_id`,
    JSON.stringify(recentShows.map((r) => [r.show, r.k])), user.id, ...a.params);
  const byShow = new Map(next.map((r) => [r.show, r.id]));
  const ids = recentShows.map((r) => byShow.get(r.show)).filter((x): x is string => !!x).slice(0, limit);
  return rowsByIds(user, ids).map(rowToItem);
}

function recentlyAdded(user: User, libraryId: string | null, limit: number): Item[] {
  const lib = libraryId ? db.get<{ type: string }>('SELECT type FROM libraries WHERE id = ?', libraryId) : null;
  const t = lib?.type;
  if (t === 'podcasts') return selectItems(user, `i.type = 'podcastepisode' AND i.library_id = ?`, [libraryId], `ORDER BY COALESCE(i.release_date, i.added_at) DESC LIMIT ${limit}`);
  const types = t === 'shows' || t === 'iptv-shows' ? "('show')" : t === 'music' ? "('album')" : t === 'audiobooks' ? "('audiobook')" : t === 'photos' ? "('photo')" : t === 'videos' ? "('video')" : t ? "('movie')" : "('movie','show','album')";
  if (t === 'shows') {
    // Order shows by most recently added episode.
    return selectItems(user, `i.type = 'show' AND i.library_id = ?`, [libraryId],
      `ORDER BY (SELECT MAX(e.added_at) FROM items e WHERE e.grandparent_id = i.id) DESC LIMIT ${limit}`);
  }
  return selectItems(user, `i.type IN ${types}${libraryId ? ' AND i.library_id = ?' : ''}`, libraryId ? [libraryId] : [], `ORDER BY i.added_at DESC LIMIT ${limit}`);
}

const DEFAULT_TITLES: Record<string, string> = {
  hero: 'Featured', continue: 'Continue Watching', nextup: 'Next Up', recent: 'Recently Added', favorites: 'Favourites', 'live-now': 'On Now',
  'favorite-channels': 'Favourite Channels', recordings: 'Recordings', collection: 'Collection', genre: 'Genre', playlist: 'Playlist', 'library-recent': 'Recently Added',
  // {title} = the title a "because" row is based on; {server} = the server name.
  recommended: 'Recommended for you', because: 'Because you watched {title}', top10: 'Top 10 on {server} this week', trending: 'Popular right now',
  watchlist: 'My List', upcoming: 'Coming soon', spotlight: 'Spotlight',
};

/** 32-bit FNV-1a, for seeding the daily spotlight shuffle. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
/** mulberry32: small seeded PRNG (same seed → same sequence). */
function seededRandom(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * "Random spotlight" row: random movies/shows from the chosen libraries, limited to what the viewer may see (library
 * access, rating limit). `daily` shuffles with a seed from the server date and the row id, so picks hold all day.
 */
export function spotlightItems(user: User, cfg: Pick<HomeRowConfig, 'id' | 'libraryIds' | 'itemTypes' | 'rotation'>, limit: number, now = new Date()): Item[] {
  const allowed = allowedLibraryIds(user);
  const chosen = Array.isArray(cfg.libraryIds) && cfg.libraryIds.length ? allowed.filter((id) => cfg.libraryIds!.includes(id)) : allowed;
  if (!chosen.length) return [];
  const types = (Array.isArray(cfg.itemTypes) ? cfg.itemTypes : []).filter((t) => t === 'movie' || t === 'show');
  const typeList = types.length ? [...new Set(types)] : ['movie', 'show'];
  const where = `i.type IN (${typeList.map(() => '?').join(',')}) AND i.library_id IN (${chosen.map(() => '?').join(',')})`;
  const params = [...typeList, ...chosen];
  if (cfg.rotation !== 'daily') return selectItems(user, where, params, `ORDER BY RANDOM() LIMIT ${limit}`);
  const a = accessClause(user);
  const ids = db.all<{ id: string }>(`SELECT i.id FROM items i WHERE ${a.sql} AND ${where} ORDER BY i.id`, ...a.params, ...params).map((r) => r.id);
  const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  const rnd = seededRandom(hash32(`${day}|${cfg.id}`));
  // Partial Fisher–Yates: only the first `limit` positions are needed.
  for (let i = 0; i < Math.min(limit, ids.length); i++) {
    const j = i + Math.floor(rnd() * (ids.length - i));
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  }
  return itemsByIds(user, ids.slice(0, limit));
}

/** Home rows that depend on Live TV/DVR are filled by the live module via this hook. */
export const homeHooks: {
  liveRow?: (user: User, cfg: HomeRowConfig) => HomeRow | null;
  recordingsRow?: (user: User, cfg: HomeRowConfig) => HomeRow | null;
  /** recommended / because / top10 / trending / upcoming — filled by services/recommend.ts and services/calendar.ts. */
  discoveryRow?: (user: User, cfg: HomeRowConfig) => HomeRow | null;
} = {};

export function buildHome(user: User): HomeRow[] {
  const b = getBranding();
  const rows: HomeRow[] = [];
  for (const cfg of b.homeRows) {
    if (!cfg.enabled) continue;
    const limit = toInt(cfg.limit, 20, 1, 60);
    const title = cfg.title || DEFAULT_TITLES[cfg.type] || '';
    try {
      switch (cfg.type) {
        case 'hero': {
          // Never feature what the viewer said they don't want (not interested / thumbs down).
          // Titles added in the last 30 days first (random order), then random older ones: the recent ones come from a
          // small index range, so the whole library is only shuffled when there aren't enough new titles.
          const eligible = "i.type IN ('movie','show') AND i.backdrop IS NOT NULL AND COALESCE(ud.played,0) = 0 AND COALESCE(ud.not_interested,0) = 0 AND COALESCE(ud.rating, 10) > 4";
          const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
          let items = selectItems(user, `${eligible} AND i.added_at > ?`, [cutoff], `ORDER BY RANDOM() LIMIT ${limit}`);
          if (items.length < limit) items = [...items, ...selectItems(user, `${eligible} AND NOT (i.added_at > ?)`, [cutoff], `ORDER BY RANDOM() LIMIT ${limit - items.length}`)];
          if (items.length) rows.push({ id: cfg.id, type: 'hero', title, items });
          break;
        }
        case 'continue': {
          const items = continueWatching(user, limit);
          if (items.length) rows.push({ id: cfg.id, type: cfg.type, title, items });
          break;
        }
        case 'nextup': {
          const items = nextUp(user, limit);
          if (items.length) rows.push({ id: cfg.id, type: cfg.type, title, items });
          break;
        }
        case 'recent': {
          const items = recentlyAdded(user, null, limit);
          if (items.length) rows.push({ id: cfg.id, type: cfg.type, title, items, link: { sort: 'addedAt' } });
          break;
        }
        case 'library-recent': {
          const libs = cfg.libraryId ? [cfg.libraryId] : allowedLibraryIds(user);
          const ordered = db.all<{ id: string; name: string; type: string }>(`SELECT id, name, type FROM libraries ORDER BY sort_order, name`).filter((l) => libs.includes(l.id));
          for (const l of ordered) {
            const items = recentlyAdded(user, l.id, limit);
            if (items.length) rows.push({ id: `${cfg.id}:${l.id}`, type: cfg.type, title: cfg.title && cfg.libraryId ? cfg.title : `Recently Added in ${l.name}`, items, link: { libraryId: l.id, sort: 'addedAt' } });
          }
          break;
        }
        case 'favorites': {
          const items = selectItems(user, "ud.favorite = 1 AND i.type IN ('movie','show','episode','album','artist','video')", [], `ORDER BY i.sort_title LIMIT ${limit}`);
          if (items.length) rows.push({ id: cfg.id, type: cfg.type, title, items });
          break;
        }
        case 'collection':
        case 'playlist': {
          if (!cfg.itemId) break;
          const c = db.get('SELECT title FROM items WHERE id = ?', cfg.itemId);
          if (!c) break;
          const items = getChildren(user, cfg.itemId, { limit }).items;
          if (items.length) rows.push({ id: cfg.id, type: cfg.type, title: cfg.title || c.title, items, link: { itemId: cfg.itemId } });
          break;
        }
        case 'genre': {
          if (!cfg.genre) break;
          const items = queryItems(user, { genre: cfg.genre, libraryId: cfg.libraryId, sort: 'random', limit }).items;
          if (items.length) rows.push({ id: cfg.id, type: cfg.type, title: cfg.title || cfg.genre, items, link: { genre: cfg.genre, libraryId: cfg.libraryId } });
          break;
        }
        case 'live-now':
        case 'favorite-channels': {
          const r = homeHooks.liveRow?.(user, { ...cfg, title, limit });
          if (r) rows.push(r);
          break;
        }
        case 'recordings': {
          const r = homeHooks.recordingsRow?.(user, { ...cfg, title, limit });
          if (r) rows.push(r);
          break;
        }
        case 'spotlight': {
          const items = spotlightItems(user, cfg, limit);
          if (items.length) rows.push({ id: cfg.id, type: cfg.type, title, items });
          break;
        }
        case 'watchlist': {
          const items = listWatchlist(user, limit).items;
          if (items.length) rows.push({ id: cfg.id, type: cfg.type, title, items, link: { page: 'watchlist' } });
          break;
        }
        case 'recommended':
        case 'because':
        case 'top10':
        case 'trending':
        case 'upcoming': {
          const r = homeHooks.discoveryRow?.(user, { ...cfg, title, limit });
          if (r) rows.push(r);
          break;
        }
      }
    } catch {
      /* a broken row config must never break the home screen */
    }
  }
  return rows;
}

export function searchItems(user: User, q: string, limit = 30): Item[] {
  const term = q.trim();
  if (!term) return [];
  const like = `%${term}%`;
  // People match by name inside the cast JSON. A plain substring test on the raw JSON first skips the JSON parse for
  // the (nearly all) rows that can't match; it is exact for terms without characters JSON escapes (quotes, backslashes, control characters).
  // eslint-disable-next-line no-control-regex
  const rawOk = !/["\\\u0000-\u001f]/.test(term);
  // Tracks are also found by their featured / credited artists (track_artists, position > 0).
  return withCredits(selectItems(user,
    `(i.title LIKE ? OR i.original_title LIKE ? OR (${rawOk ? 'i.people LIKE ? AND ' : '? IS NOT NULL AND '}EXISTS (SELECT 1 FROM json_each(i.people) WHERE json_extract(json_each.value,'$.name') LIKE ?)) OR (i.type = 'track' AND EXISTS (SELECT 1 FROM track_artists ta WHERE ta.track_id = i.id AND ta.position > 0 AND ta.name LIKE ?))) AND i.type IN ('movie','show','episode','artist','album','track','collection','video','audiobook','podcast','podcastepisode') AND NOT (i.type = 'video' AND i.parent_id IS NOT NULL)`,
    [like, like, like, like, like, term, `${term}%`],
    `ORDER BY CASE WHEN i.title LIKE ? THEN 0 WHEN i.title LIKE ? THEN 1 ELSE 2 END, CASE i.type WHEN 'movie' THEN 0 WHEN 'show' THEN 0 WHEN 'artist' THEN 1 ELSE 2 END, i.sort_title LIMIT ${toInt(limit, 30, 1, 200)}`))

}
