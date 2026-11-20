import type {
  HomeRow, HomeRowConfig, Item, SubtitleStream, ItemQuery, ItemSort, MediaSource, Marker, Paged, Person, User, UserItemData, UpdateItemRequest,
} from '@mediamax/shared';
import { db, type Param, type Row } from '../db.js';
import { imageUrl } from './images.js';
import { forbidden, notFound } from '../util/errors.js';
import { nowIso, parseJson, ratingLevel, resolutionLabel, sortTitle, toInt } from '../util/misc.js';
import { getBranding } from './branding.js';
import { events, bus } from './events.js';
import { getSettings } from './settings.js';

/* ----------------------------- access ------------------------------ */

const ALL_RATINGS = ['G', 'TV-Y', 'TV-G', 'U', 'TV-Y7', 'TV-Y7-FV', 'PG', 'TV-PG', '12', '12A', 'PG-13', 'TV-14', '15', 'R', 'TV-MA', 'NC-17', '18', 'R18', 'X'];

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
export function accessClause(user: User, alias = 'i'): { sql: string; params: Param[] } {
  const libs = allowedLibraryIds(user);
  const parts: string[] = [];
  const params: Param[] = [];
  const libSql = libs.length ? `${alias}.library_id IN (${libs.map(() => '?').join(',')})` : '0';
  parts.push(`(${libSql} OR ${alias}.type = 'collection' OR (${alias}.type = 'playlist' AND ${alias}.owner_id = ?))`);
  params.push(...libs, user.id);
  const max = ratingLevel(user.maxContentRating);
  if (max !== null) {
    const blocked = ALL_RATINGS.filter((r) => (ratingLevel(r) ?? 0) > max);
    if (blocked.length) {
      const eff = `COALESCE(${alias}.content_rating, (SELECT x.content_rating FROM items x WHERE x.id = COALESCE(${alias}.grandparent_id, ${alias}.parent_id)))`;
      // Unrated: allowed by default; optionally blocked (containers like collections/playlists are always visible).
      const unrated = getSettings().blockUnratedForRestricted ? `${alias}.type IN ('collection','playlist','season','artist','album','track','photo')` : `${eff} IS NULL`;
      parts.push(`((${eff} IS NULL AND (${unrated})) OR (${eff} IS NOT NULL AND UPPER(${eff}) NOT IN (${blocked.map(() => '?').join(',')})))`);
      params.push(...blocked);
    }
  }
  return { sql: parts.join(' AND '), params };
}

export function assertCanSee(user: User, itemId: string): Row {
  const a = accessClause(user);
  const row = db.get(`SELECT i.* FROM items i WHERE i.id = ? AND ${a.sql}`, itemId, ...a.params);
  if (!row) throw notFound('Item not found');
  return row;
}

/* ----------------------------- mapping ----------------------------- */

const SELECT = (userParam = '?') => `
  SELECT i.*, p.title p_title, g.title g_title, p.poster p_poster, g.poster g_poster, p.backdrop p_backdrop, g.backdrop g_backdrop,
    p.logo p_logo, g.logo g_logo, p.content_rating p_rating, g.content_rating g_rating,
    ud.played u_played, ud.play_count u_play_count, ud.position_ms u_position, ud.favorite u_favorite, ud.last_played_at u_last, ud.rating u_rating,
    CASE WHEN i.type IN ('collection','playlist') THEN (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = i.id)
         WHEN i.type IN ('show','season','artist','album') THEN (SELECT COUNT(*) FROM items c WHERE c.parent_id = i.id) ELSE 0 END child_count,
    CASE WHEN i.type = 'show' THEN (SELECT COUNT(*) FROM items e LEFT JOIN user_data eu ON eu.item_id = e.id AND eu.user_id = ${userParam} WHERE e.grandparent_id = i.id AND e.type = 'episode' AND COALESCE(eu.played, 0) = 0)
         WHEN i.type = 'season' THEN (SELECT COUNT(*) FROM items e LEFT JOIN user_data eu ON eu.item_id = e.id AND eu.user_id = ${userParam} WHERE e.parent_id = i.id AND e.type = 'episode' AND COALESCE(eu.played, 0) = 0)
         ELSE NULL END unplayed
  FROM items i
  LEFT JOIN items p ON p.id = i.parent_id
  LEFT JOIN items g ON g.id = i.grandparent_id
  LEFT JOIN user_data ud ON ud.item_id = i.id AND ud.user_id = ${userParam}`;

function userData(r: Row): UserItemData {
  const ud: UserItemData = {
    played: !!r.u_played,
    playCount: r.u_play_count ?? 0,
    positionMs: r.u_position ?? 0,
    favorite: !!r.u_favorite,
    lastPlayedAt: r.u_last ?? null,
    rating: r.u_rating ?? null,
  };
  if (r.unplayed !== null && r.unplayed !== undefined) {
    ud.unplayedCount = r.unplayed;
    ud.played = r.unplayed === 0 && r.child_count > 0;
  }
  return ud;
}

export function rowToItem(r: Row): Item {
  const isEpisodeLike = r.type === 'episode' || r.type === 'track';
  const isSeason = r.type === 'season';
  const poster = r.poster ?? (isSeason ? r.p_poster : null) ?? (isEpisodeLike ? (r.type === 'track' ? r.p_poster : r.g_poster ?? r.p_poster) : null);
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
    audioStreams: parseJson(m.audio, []),
    subtitleStreams: parseJson<(SubtitleStream & { path?: string })[]>(m.subs, []).map(({ path: _p, ...s }) => s),
    remote: !m.path && !!m.remote_url,
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
  const a = accessClause(user);
  const where: string[] = [a.sql];
  const params: Param[] = [user.id, user.id, user.id, ...a.params];
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
    where.push("i.type IN ('movie','show','artist','photo','video','album')");
    if (q.libraryId) {
      const lib = db.get<{ type: string }>('SELECT type FROM libraries WHERE id = ?', q.libraryId);
      if (lib?.type === 'music') where.push("i.type = 'artist'");
    }
  }
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
  if (q.letter) {
    if (q.letter === '#') where.push("substr(i.sort_title,1,1) NOT BETWEEN 'a' AND 'z'");
    else {
      where.push('substr(i.sort_title,1,1) = ?');
      params.push(q.letter.toLowerCase().slice(0, 1));
    }
  }
  if (q.played !== undefined) where.push(String(q.played) === 'true' ? 'COALESCE(ud.played,0) = 1' : 'COALESCE(ud.played,0) = 0');
  if (q.favorite !== undefined && String(q.favorite) === 'true') where.push('COALESCE(ud.favorite,0) = 1');
  const sort = SORTS[q.sort as ItemSort] ?? (q.parentId || q.ancestorId ? SORTS.index : SORTS.title);
  const dir = q.order === 'desc' ? 'DESC' : q.order === 'asc' ? 'ASC' : q.sort === 'addedAt' || q.sort === 'rating' || q.sort === 'lastPlayed' ? 'DESC' : 'ASC';
  const sql = `${SELECT()} WHERE ${where.join(' AND ')}`;
  const total = db.get<{ n: number }>(`SELECT COUNT(*) n FROM items i LEFT JOIN user_data ud ON ud.item_id = i.id AND ud.user_id = ? WHERE ${where.join(' AND ')}`, user.id, ...params.slice(3))!.n;
  const rows = db.all(`${sql} ORDER BY ${sort.map((s) => `${s} ${dir}`).join(', ')}, i.sort_title LIMIT ? OFFSET ?`, ...params, limit, offset);
  return { items: rows.map(rowToItem), total, limit, offset };
}

function selectItems(user: User, whereSql: string, params: Param[], tail = ''): Item[] {
  const a = accessClause(user);
  return db.all(`${SELECT()} WHERE ${a.sql} AND (${whereSql}) ${tail}`, user.id, user.id, user.id, ...a.params, ...params).map(rowToItem);
}

export function getItem(user: User, id: string, withMedia = true): Item {
  const items = selectItems(user, 'i.id = ?', [id]);
  if (!items.length) throw notFound('Item not found');
  const item = items[0];
  if (withMedia) {
    item.media = db.all('SELECT * FROM media WHERE item_id = ? ORDER BY COALESCE(width,0) DESC', id).map(mediaRowToSource);
    const row = db.get('SELECT markers, locked_fields FROM items WHERE id = ?', id);
    item.markers = parseJson<Marker[]>(row?.markers, []);
    item.lockedFields = parseJson<string[]>(row?.locked_fields, []);
    if (item.type === 'show' || item.type === 'season') {
      // Aggregate duration hint for containers.
      item.media = [];
    }
  }
  return item;
}

export function getChildren(user: User, id: string, q: { sort?: ItemSort; order?: 'asc' | 'desc'; limit?: number; offset?: number }): Paged<Item> {
  const parent = assertCanSee(user, id);
  const limit = toInt(q.limit, 500, 1, 2000);
  const offset = toInt(q.offset, 0, 0);
  if (parent.type === 'collection' || parent.type === 'playlist') {
    const a = accessClause(user);
    const rows = db.all(
      `${SELECT()} JOIN collection_items ci ON ci.item_id = i.id AND ci.collection_id = ? WHERE ${a.sql} ORDER BY ci.sort, i.sort_title LIMIT ? OFFSET ?`,
      user.id, user.id, user.id, id, ...a.params, limit, offset);
    const total = db.get<{ n: number }>('SELECT COUNT(*) n FROM collection_items WHERE collection_id = ?', id)!.n;
    return { items: rows.map(rowToItem), total, limit, offset };
  }
  return queryItems(user, { parentId: id, sort: q.sort ?? 'index', order: q.order, limit, offset, type: undefined });
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
  if (row.type === 'track' && row.parent_id) {
    const r = selectItems(user, `i.parent_id = ? AND i.type = 'track' AND (COALESCE(i.parent_idx,0) > ? OR (COALESCE(i.parent_idx,0) = ? AND COALESCE(i.idx,0) > ?))`,
      [row.parent_id, row.parent_idx ?? 0, row.parent_idx ?? 0, row.idx ?? 0], 'ORDER BY COALESCE(i.parent_idx,0), COALESCE(i.idx,0) LIMIT 1');
    return r[0] ?? null;
  }
  return null;
}

export function genres(user: User, libraryId?: string): string[] {
  const a = accessClause(user);
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
  if (type === 'season' || type === 'album') return db.all<{ id: string }>('SELECT id FROM items WHERE parent_id = ?', itemId).map((r) => r.id);
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
  return emitUd(user, itemId);
}

export function setFavorite(user: User, itemId: string, fav: boolean): UserItemData {
  assertCanSee(user, itemId);
  ensureUd(user.id, itemId);
  db.run('UPDATE user_data SET favorite = ? WHERE user_id = ? AND item_id = ?', fav, user.id, itemId);
  return emitUd(user, itemId);
}

export function setRating(user: User, itemId: string, rating: number | null): UserItemData {
  assertCanSee(user, itemId);
  ensureUd(user.id, itemId);
  const r = rating === null ? null : Math.max(0, Math.min(10, Number(rating)));
  db.run('UPDATE user_data SET rating = ? WHERE user_id = ? AND item_id = ?', r, user.id, itemId);
  return emitUd(user, itemId);
}

export function reportProgress(user: User, itemId: string, positionMs: number, durationMs?: number | null, state?: string): UserItemData {
  const row = assertCanSee(user, itemId);
  const dur = durationMs || row.duration_ms || 0;
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
  return type === 'collection'
    ? selectItems(user, "i.type = 'collection'", [], 'ORDER BY i.sort_title')
    : selectItems(user, "i.type = 'playlist' AND i.owner_id = ?", [user.id], 'ORDER BY i.sort_title');
}

/* ------------------------------- home ------------------------------ */

export function continueWatching(user: User, limit = 20): Item[] {
  return selectItems(user, "ud.position_ms > 0 AND COALESCE(ud.played,0) = 0 AND i.type IN ('movie','episode','video')", [], `ORDER BY ud.last_played_at DESC LIMIT ${toInt(limit, 20, 1, 100)}`);
}

export function nextUp(user: User, limit = 20): Item[] {
  const recentShows = db.all<{ show: string; last: string }>(
    `SELECT i.grandparent_id show, MAX(ud.last_played_at) last FROM user_data ud JOIN items i ON i.id = ud.item_id
     WHERE ud.user_id = ? AND i.type = 'episode' AND ud.played = 1 AND i.grandparent_id IS NOT NULL
     GROUP BY i.grandparent_id ORDER BY last DESC LIMIT 60`, user.id);
  const out: Item[] = [];
  for (const { show } of recentShows) {
    if (out.length >= limit) break;
    const last = db.get(
      `SELECT i.parent_idx, i.idx FROM user_data ud JOIN items i ON i.id = ud.item_id WHERE ud.user_id = ? AND i.grandparent_id = ? AND ud.played = 1
       ORDER BY COALESCE(i.parent_idx,0) DESC, COALESCE(i.idx,0) DESC LIMIT 1`, user.id, show);
    if (!last) continue;
    const next = selectItems(user,
      `i.grandparent_id = ? AND i.type = 'episode' AND COALESCE(ud.played,0) = 0 AND COALESCE(ud.position_ms,0) = 0 AND COALESCE(i.parent_idx,0) > 0 AND (COALESCE(i.parent_idx,0) > ? OR (COALESCE(i.parent_idx,0) = ? AND COALESCE(i.idx,0) > ?))`,
      [show, last.parent_idx ?? 0, last.parent_idx ?? 0, last.idx ?? 0], 'ORDER BY COALESCE(i.parent_idx,0), COALESCE(i.idx,0) LIMIT 1');
    if (next[0]) out.push(next[0]);
  }
  return out;
}

function recentlyAdded(user: User, libraryId: string | null, limit: number): Item[] {
  const lib = libraryId ? db.get<{ type: string }>('SELECT type FROM libraries WHERE id = ?', libraryId) : null;
  const t = lib?.type;
  const types = t === 'shows' || t === 'iptv-shows' ? "('show')" : t === 'music' ? "('album')" : t === 'photos' ? "('photo')" : t === 'videos' ? "('video')" : t ? "('movie')" : "('movie','show','album')";
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
};

/** Home rows that depend on Live TV/DVR are filled by the live module via this hook. */
export const homeHooks: { liveRow?: (user: User, cfg: HomeRowConfig) => HomeRow | null; recordingsRow?: (user: User, cfg: HomeRowConfig) => HomeRow | null } = {};

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
          const items = selectItems(user, "i.type IN ('movie','show') AND i.backdrop IS NOT NULL AND COALESCE(ud.played,0) = 0",
            [], `ORDER BY (i.added_at > '${new Date(Date.now() - 30 * 86400000).toISOString()}') DESC, RANDOM() LIMIT ${limit}`);
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
          const items = selectItems(user, "COALESCE(ud.favorite,0) = 1 AND i.type IN ('movie','show','episode','album','artist','video')", [], `ORDER BY i.sort_title LIMIT ${limit}`);
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
  return selectItems(user,
    `(i.title LIKE ? OR i.original_title LIKE ? OR EXISTS (SELECT 1 FROM json_each(i.people) WHERE json_extract(json_each.value,'$.name') LIKE ?)) AND i.type IN ('movie','show','episode','artist','album','track','collection','video')`,
    [like, like, like, term, `${term}%`],
    `ORDER BY CASE WHEN i.title LIKE ? THEN 0 WHEN i.title LIKE ? THEN 1 ELSE 2 END, CASE i.type WHEN 'movie' THEN 0 WHEN 'show' THEN 0 WHEN 'artist' THEN 1 ELSE 2 END, i.sort_title LIMIT ${toInt(limit, 30, 1, 200)}`)

}
