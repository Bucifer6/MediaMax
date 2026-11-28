import type { ItemRatings } from '@mediamax/shared';
import { db, type Row } from '../db.js';
import { parseJson } from '../util/misc.js';
import { logger } from '../util/log.js';
import { getSettings } from './settings.js';
import { baseUrl, providerFetch } from './metadata/http.js';

const log = logger('mdblist');

/**
 * MDBList (mdblist.com), with the admin's API key (free tier: 1,000 requests a day, enforced in metadata/http.ts):
 *  - ratings from IMDb, TMDB, Trakt, Rotten Tomatoes (critics + audience), Metacritic, Letterboxd and MyAnimeList,
 *    merged into each movie's / show's `ratings` (a daily task, at most 900 titles a day, refreshed monthly);
 *  - Home rows from public MDBList lists: the titles of the list that are in the viewer's libraries.
 * Only public title ids and list names are sent.
 */

const key = () => getSettings().mdblist?.apiKey || null;

interface MdbRating { source?: string; value?: number | null; score?: number | null }

/** MDBList's ratings in Vibe's scales: imdb / tmdb / mal 0–10, letterboxd 0–5, the rest 0–100. */
export function mapMdbRatings(list: MdbRating[] | null | undefined): ItemRatings {
  const out: ItemRatings = {};
  for (const r of list ?? []) {
    const v = typeof r.value === 'number' && r.value >= 0 ? r.value : null;
    if (v == null) continue;
    switch (r.source) {
      case 'imdb': if (v <= 10) out.imdb = v; break;
      case 'tmdb': out.tmdb = Math.round((v > 10 ? v / 10 : v) * 10) / 10; break;
      case 'trakt': if (v <= 100) out.trakt = Math.round(v); break;
      case 'tomatoes': if (v <= 100) out.rottenTomatoes = Math.round(v); break;
      case 'popcorn': case 'audience': case 'tomatoesaudience': if (v <= 100) out.audience = Math.round(v); break;
      case 'metacritic': if (v <= 100) out.metacritic = Math.round(v); break;
      case 'letterboxd': out.letterboxd = Math.round((r.score != null ? r.score / 20 : v) * 10) / 10; break;
      case 'myanimelist': case 'mal': if (v <= 10) out.mal = v; break;
    }
  }
  return out;
}

/** Fetch and store one title's ratings. Returns false when MDBList doesn't know it. */
export async function refreshMdbRatings(item: Row): Promise<boolean> {
  const apiKey = key();
  if (!apiKey) return false;
  const ids = parseJson<Record<string, string>>(item.external_ids, {});
  const type = item.type === 'show' ? 'show' : 'movie';
  const path = ids.imdb ? `imdb/${type}/${encodeURIComponent(ids.imdb)}` : ids.tmdb ? `tmdb/${type}/${encodeURIComponent(ids.tmdb)}` : null;
  if (!path) return false;
  const r = await providerFetch<{ ratings?: MdbRating[] }>('mdblist', `${baseUrl('mdblist')}/${path}?apikey=${encodeURIComponent(apiKey)}`, { timeoutMs: 10000 });
  const mapped = mapMdbRatings(r.data?.ratings);
  // Re-read the extra JSON: the fetch may have waited on the rate limit while something else wrote it.
  const fresh = db.get<{ ratings: string | null; extra: string; locked_fields: string | null }>('SELECT ratings, extra, locked_fields FROM items WHERE id = ?', item.id);
  if (!fresh) return false;
  const nextExtra = { ...parseJson<Record<string, unknown>>(fresh.extra, {}), mdblistAt: new Date().toISOString() };
  // An admin who locked the ratings (Edit metadata) keeps them, as with every other metadata source.
  const locked = parseJson<string[]>(fresh.locked_fields, []).includes('ratings');
  const ratings = Object.keys(mapped).length && !locked ? { ...parseJson<ItemRatings>(fresh.ratings, {}), ...mapped } : null;
  db.run('UPDATE items SET extra = ?' + (ratings ? ', ratings = ?' : '') + ' WHERE id = ?', JSON.stringify(nextExtra), ...(ratings ? [JSON.stringify(ratings)] : []), item.id);
  return !!ratings;
}

/** Daily task: titles never fetched first, then ones older than 30 days. */
export async function refreshAllMdbRatings(onProgress?: (p: number) => void, maxPerRun = 900): Promise<number> {
  if (!key() || !getSettings().mdblist?.ratings) return 0;
  const stale = new Date(Date.now() - 30 * 86400000).toISOString();
  const rows = db.all<Row>(
    `SELECT id, type, external_ids, ratings, extra FROM items WHERE type IN ('movie','show')
       AND (json_extract(external_ids, '$.imdb') IS NOT NULL OR json_extract(external_ids, '$.tmdb') IS NOT NULL)
       AND (json_extract(extra, '$.mdblistAt') IS NULL OR json_extract(extra, '$.mdblistAt') < ?)
     ORDER BY json_extract(extra, '$.mdblistAt') IS NOT NULL, added_at DESC LIMIT ?`, stale, maxPerRun);
  let n = 0;
  for (let i = 0; i < rows.length; i++) {
    try {
      if (await refreshMdbRatings(rows[i])) n++;
    } catch (e) {
      log.debug(`MDBList ratings for ${rows[i].id}: ${(e as Error).message}`);
      if (/daily request limit/.test((e as Error).message)) break;
    }
    onProgress?.((i + 1) / rows.length);
  }
  return n;
}

/* -------------------------------- list rows -------------------------------- */

/** "https://mdblist.com/lists/<user>/<slug>", "<user>/<slug>" or a numeric id → the API path; null when unusable. */
export function listPath(list: string | null | undefined): string | null {
  const s = String(list ?? '').trim();
  if (/^\d{1,12}$/.test(s)) return `lists/${s}/items`;
  const m = s.match(/^(?:https?:\/\/(?:www\.)?mdblist\.com\/lists\/)?([\w.-]{1,64})\/([\w.-]{1,128})\/?$/i);
  return m ? `lists/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}/items` : null;
}

interface ListEntry { imdb_id?: string | null; tvdb_id?: number | null; id?: number | null; mediatype?: string | null }

const LIST_TTL_MS = 6 * 3600000;
const listCache = new Map<string, { at: number; ids: string[]; loading?: boolean }>();

/** Library items (any library) matching a list, in list order. */
async function loadList(path: string): Promise<string[]> {
  const apiKey = key();
  if (!apiKey) return [];
  const r = await providerFetch<ListEntry[] | { movies?: ListEntry[]; shows?: ListEntry[] }>('mdblist', `${baseUrl('mdblist')}/${path}?apikey=${encodeURIComponent(apiKey)}&limit=200`, { ttlHours: 6, timeoutMs: 15000 });
  const d = r.data;
  const entries: ListEntry[] = Array.isArray(d) ? d : [...(d?.movies ?? []).map((e) => ({ ...e, mediatype: 'movie' })), ...(d?.shows ?? []).map((e) => ({ ...e, mediatype: 'show' }))];
  const out: string[] = [];
  for (const e of entries.slice(0, 200)) {
    const type = e.mediatype === 'show' ? 'show' : 'movie';
    const row = e.imdb_id
      ? db.get<{ id: string }>("SELECT id FROM items WHERE type = ? AND json_extract(external_ids, '$.imdb') = ? LIMIT 1", type, e.imdb_id)
      : e.id ? db.get<{ id: string }>("SELECT id FROM items WHERE type = ? AND json_extract(external_ids, '$.tmdb') = ? LIMIT 1", type, String(e.id)) : undefined;
    if (row && !out.includes(row.id)) out.push(row.id);
  }
  return out;
}

/**
 * Item ids for a Home row, from the cache (Home is built synchronously). A missing or stale list is fetched in the
 * background and shows up on the next Home load.
 */
export function mdblistRowIds(list: string | undefined): string[] {
  const path = listPath(list);
  if (!path || !key()) return [];
  const c = listCache.get(path);
  if (!c || (Date.now() - c.at > LIST_TTL_MS && !c.loading)) {
    const entry = c ?? { at: 0, ids: [] };
    entry.loading = true;
    listCache.set(path, entry);
    void loadList(path)
      .then((ids) => listCache.set(path, { at: Date.now(), ids }))
      .catch((e) => {
        log.debug(`MDBList list ${path}: ${(e as Error).message}`);
        listCache.set(path, { at: Date.now(), ids: entry.ids });
      });
  }
  return c?.ids ?? [];
}

export const clearMdbListCache = () => listCache.clear();
