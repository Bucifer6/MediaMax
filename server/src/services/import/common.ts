import crypto from 'node:crypto';
import type {
  CreateUserRequest, ImportConfig, ImportLibraryMapping, ImportMatchCount, ImportPathMapping, ImportSource, ImportTestResult, User,
} from '@mediamax/shared';
import { db } from '../../db.js';
import { badRequest, HttpError } from '../../util/errors.js';
import { nowIso, parseJson } from '../../util/misc.js';
import { getKv, setKv, SECRET_MASK } from '../settings.js';
import { addToContainer, createContainer } from '../items.js';
import { logActivity } from '../activity.js';

/**
 * Source-neutral parts of "Import from another server" (Emby, Jellyfin, Plex): settings, path and library mapping,
 * the in-memory title matcher, user lookup, and the never-downgrade writers. Each source has a driver (emby.ts for
 * Emby and Jellyfin, plex.ts) that turns its API into the neutral shapes below; index.ts runs previews and jobs.
 */

export const SOURCE_LABEL: Record<ImportSource, string> = { emby: 'Emby', jellyfin: 'Jellyfin', plex: 'Plex' };
export const isSource = (s: unknown): s is ImportSource => s === 'emby' || s === 'jellyfin' || s === 'plex';
/** Set-password links are tagged with the importing source (`emby-import` predates the others). */
export const linkPurpose = (s: ImportSource) => `${s}-import`;

/* ------------------------------- settings ------------------------------ */

// The Emby key predates the other sources.
const configKey = (s: ImportSource) => (s === 'emby' ? 'embyImport:config' : `import:${s}:config`);

export function storedConfig(s: ImportSource): ImportConfig {
  const c = getKv<Partial<ImportConfig>>(configKey(s), {});
  return { url: c.url ?? '', apiKey: c.apiKey ?? '', pathMappings: Array.isArray(c.pathMappings) ? c.pathMappings : [] };
}

/** The importer settings as admins see them: the API key / token is write-only. */
export function getImportConfig(s: ImportSource): ImportConfig {
  const c = storedConfig(s);
  return { ...c, apiKey: c.apiKey ? SECRET_MASK : '' };
}

function normUrl(s: ImportSource, raw: unknown): string {
  const u = String(raw ?? '').trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\/[^/\s]+/i.test(u)) throw badRequest(`The ${SOURCE_LABEL[s]} URL must start with http:// or https://`);
  return u.slice(0, 500);
}

function normMappings(raw: unknown): ImportPathMapping[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((m) => ({ from: String(m?.from ?? '').trim().slice(0, 500), to: String(m?.to ?? '').trim().slice(0, 500) }))
    .filter((m) => m.from && m.to)
    .slice(0, 50);
}

export function saveImportConfig(s: ImportSource, patch: Partial<ImportConfig>, admin?: User): ImportConfig {
  const cur = storedConfig(s);
  const next: ImportConfig = {
    url: patch.url !== undefined ? normUrl(s, patch.url) : cur.url,
    // Saving the mask back (or leaving the field out) keeps the stored key.
    apiKey: patch.apiKey === undefined || patch.apiKey === SECRET_MASK ? cur.apiKey : String(patch.apiKey ?? '').trim().slice(0, 200),
    pathMappings: patch.pathMappings !== undefined ? normMappings(patch.pathMappings) : cur.pathMappings,
  };
  setKv(configKey(s), next);
  logActivity('settings', `${SOURCE_LABEL[s]} import settings saved`, { userId: admin?.id, userName: admin?.displayName });
  return getImportConfig(s);
}

export interface Conn { source: ImportSource; url: string; apiKey: string }

const KEY_HINT: Record<ImportSource, string> = {
  emby: 'Enter an Emby API key first (Emby: Settings → Advanced → API keys)',
  jellyfin: 'Enter a Jellyfin API key first (Jellyfin: Dashboard → API Keys)',
  plex: 'Enter your Plex token (X-Plex-Token) first',
};

/** The stored connection, optionally overridden by unsaved form values (the mask means "the stored key"). */
export function connection(s: ImportSource, override: Partial<Pick<ImportConfig, 'url' | 'apiKey'>> = {}): Conn {
  const c = storedConfig(s);
  const url = override.url !== undefined && override.url !== '' ? normUrl(s, override.url) : c.url;
  const apiKey = override.apiKey && override.apiKey !== SECRET_MASK ? String(override.apiKey).trim() : c.apiKey;
  if (!url) throw badRequest(`Enter the address of your ${SOURCE_LABEL[s]} server first`);
  if (!apiKey) throw badRequest(KEY_HINT[s]);
  return { source: s, url, apiKey };
}

/* ------------------------------ HTTP helpers ----------------------------- */

/** An error answer from the source server; `upstream` is its HTTP status (0 = not reached). */
export class UpstreamError extends HttpError {
  constructor(message: string, code: string, public upstream: number) {
    super(502, message, code);
  }
}

const FRIENDLY: Record<string, string> = { ECONNREFUSED: 'connection refused', ENOTFOUND: 'host not found', EAI_AGAIN: 'host not found', ETIMEDOUT: 'timed out', EHOSTUNREACH: 'host unreachable', ECONNRESET: 'connection reset' };

/** "Can't reach X: connection refused" from a failed fetch (never includes the URL, which may carry a token). */
export function unreachable(e: unknown, label: string, code: string): UpstreamError {
  if (e instanceof HttpError) return e instanceof UpstreamError ? e : new UpstreamError(`Can't reach ${label}: ${e.message}`, code, 0);
  const err = e as Error & { cause?: { code?: string; message?: string } };
  const c = err.cause?.code;
  const msg = err.name === 'TimeoutError' ? 'timed out' : c ? FRIENDLY[c] ?? c : err.cause?.message ?? err.message;
  return new UpstreamError(`Can't reach ${label}: ${msg}`, code, 0);
}

export type Query = Record<string, string | number | boolean | undefined>;
export function qs(query: Query): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/**
 * Read every page of a list. The first page tells the total; the rest are fetched a few at a time. Without a total,
 * pages are read one after another until a short one.
 */
export async function allPages<T>(page: (start: number, size: number) => Promise<{ items: T[]; total: number | null }>, size: number, concurrency = 3, cap = 500000): Promise<T[]> {
  const first = await page(0, size);
  if (first.total == null) {
    const out = [...first.items];
    let last = first.items.length;
    while (last >= size && out.length < cap) {
      const p = await page(out.length, size);
      out.push(...p.items);
      last = p.items.length;
    }
    return out;
  }
  const total = Math.min(first.total, cap);
  if (first.items.length >= total || !first.items.length) return first.items;
  const starts: number[] = [];
  for (let s = first.items.length; s < total; s += size) starts.push(s);
  const pages: T[][] = new Array(starts.length);
  await pool(starts, concurrency, async (s, i) => {
    pages[i] = (await page(s, size)).items;
  });
  return [first.items, ...pages].flat();
}

/* --------------------------- paths & libraries --------------------------- */

export const normPath = (p: string) => String(p ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
export const pathKey = (p: string) => normPath(p).toLowerCase();

/** Apply the longest matching prefix mapping (case-insensitive, `\` and `/` treated alike). */
export function mapPath(p: string, mappings: ImportPathMapping[]): string {
  const n = normPath(p);
  const low = n.toLowerCase();
  let best: { from: string; to: string } | null = null;
  for (const m of mappings) {
    const f = normPath(m.from);
    const fl = f.toLowerCase();
    if (!f || !(low === fl || low.startsWith(fl + '/'))) continue;
    if (!best || f.length > best.from.length) best = { from: f, to: normPath(m.to) };
  }
  return best ? best.to + n.slice(best.from.length) : n;
}

/** A library on the source server. `keys` are every id the source may use to refer to it (normalised by `folderKey`). */
export interface SrcFolder { id: string; keys: string[]; name: string; locations: string[] }
export const folderKey = (k: unknown) => String(k ?? '').toLowerCase().replace(/-/g, '');

interface LocalLibrary { id: string; name: string; paths: string[] }
export const localLibraries = (): LocalLibrary[] =>
  db.all<{ id: string; name: string; paths: string }>("SELECT id, name, paths FROM libraries WHERE type NOT LIKE 'iptv-%' ORDER BY sort_order, name")
    .map((l) => ({ id: l.id, name: l.name, paths: parseJson<string[]>(l.paths, []) }));

export function mapFolders(folders: SrcFolder[], mappings: ImportPathMapping[]): ImportLibraryMapping[] {
  const libs = localLibraries();
  const overlaps = (a: string, b: string) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
  return folders.map((f) => {
    const locs = f.locations.map((l) => pathKey(mapPath(l, mappings)));
    let lib = libs.find((l) => l.paths.some((p) => locs.some((x) => x && overlaps(x, pathKey(p)))));
    let method: ImportLibraryMapping['method'] = lib ? 'path' : null;
    if (!lib) {
      lib = libs.find((l) => l.name.trim().toLowerCase() === f.name.trim().toLowerCase());
      if (lib) method = 'name';
    }
    return { sourceId: f.id, name: f.name, locations: f.locations, libraryId: lib?.id ?? null, libraryName: lib?.name ?? null, method };
  });
}

/** Source library ids a user may see → MediaMax library ids (null = every library). */
export function libraryAccess(enabled: string[] | null, folders: SrcFolder[], libs: ImportLibraryMapping[]): { libraryIds: string[] | null; unmappedFolders: string[] } {
  if (enabled === null) return { libraryIds: null, unmappedFolders: [] };
  const byKey = new Map<string, ImportLibraryMapping>();
  folders.forEach((f, i) => {
    for (const k of [f.id, ...f.keys]) if (k) byKey.set(folderKey(k), libs[i]);
  });
  const ids = new Set<string>();
  const unmappedFolders: string[] = [];
  for (const id of enabled) {
    const m = byKey.get(folderKey(id));
    if (m?.libraryId) ids.add(m.libraryId);
    else unmappedFolders.push(m?.name ?? String(id));
  }
  return { libraryIds: [...ids], unmappedFolders };
}

/* ------------------------------ users ----------------------------------- */

export const safeUsername = (name: string, sourceId: string) => String(name ?? '').trim().replace(/[^\w.@ -]/g, '_').slice(0, 64) || `user_${String(sourceId).slice(0, 8)}`;

/** A source user turned into MediaMax account settings. */
export interface MappedUser extends CreateUserRequest { disabled: boolean; hiddenFromLogin: boolean; unmappedFolders: string[]; notes?: string[] }

/** A source user ready to preview/import. `raw` is whatever the driver needs later. */
export interface SourceUser<R = unknown> { id: string; name: string; lastActivity: string | null; mapped: MappedUser; raw: R }

export const setMap = (s: ImportSource, kind: string, sourceId: string, localId: string) =>
  db.upsert('import_map', { source: s, kind, source_id: sourceId, local_id: localId, imported_at: nowIso() }, 'source,kind,source_id');
export const getMap = (s: ImportSource, kind: string, sourceId: string) =>
  db.get<{ local_id: string }>('SELECT local_id FROM import_map WHERE source = ? AND kind = ? AND source_id = ?', s, kind, sourceId)?.local_id ?? null;

/** The MediaMax account a source user corresponds to: an earlier import's mapping first, then the username. */
export function existingUserId(s: ImportSource, u: SourceUser): string | null {
  const mapped = db.get<{ local_id: string }>("SELECT m.local_id FROM import_map m JOIN users u ON u.id = m.local_id WHERE m.source = ? AND m.kind = 'user' AND m.source_id = ?", s, u.id);
  if (mapped) return mapped.local_id;
  const byName = db.get<{ id: string }>('SELECT id FROM users WHERE username = ? AND parent_user_id IS NULL', u.mapped.username);
  if (!byName) return null;
  // That account already belongs to another user of this source (two names that sanitise alike): not this one.
  if (db.get("SELECT 1 FROM import_map WHERE source = ? AND kind = 'user' AND local_id = ? AND source_id != ?", s, byName.id, u.id)) return null;
  return byName.id;
}

export function freeUsername(base: string): string {
  if (!db.get('SELECT 1 FROM users WHERE username = ?', base)) return base;
  for (let i = 2; i < 1000; i++) {
    const name = `${base.slice(0, 60)}_${i}`;
    if (!db.get('SELECT 1 FROM users WHERE username = ?', name)) return name;
  }
  return `${base.slice(0, 50)}_${crypto.randomBytes(4).toString('hex')}`;
}

/** A US rating from an age limit (Jellyfin 10.9+ scores, Plex filters). */
export function ratingForAge(age: number | null | undefined): string | null {
  if (age == null || !Number.isFinite(age)) return null;
  if (age <= 6) return 'G';
  if (age <= 12) return 'PG';
  if (age <= 15) return 'PG-13';
  if (age <= 17) return 'R';
  return 'NC-17';
}

/* ------------------------------ item matching ---------------------------- */

/** A title on the source server, in neutral form. */
export interface SrcItem {
  id: string;
  kind: 'movie' | 'show' | 'episode' | 'other';
  /** Shown in "unmatched" examples (Movie, Episode, Series…). */
  typeLabel?: string;
  title?: string;
  year?: number;
  providerIds?: Record<string, string | null | undefined>;
  path?: string;
  seriesId?: string;
  seriesTitle?: string;
  season?: number;
  episode?: number;
}
export type SrcSeries = Pick<SrcItem, 'id' | 'title' | 'year' | 'providerIds' | 'path'>;

/** Per-user state of a title on the source. */
export interface UserData { played?: boolean; playCount?: number; positionMs?: number; lastPlayed?: string | null; favorite?: boolean }

export type How = 'provider' | 'path' | 'title';
export interface Match { id: string; how: How }
export interface Entry { item: SrcItem; m: Match | null; ud?: UserData }
export interface HistoryEntry { item: SrcItem; m: Match | null; at: string; durationMs?: number | null; client?: string | null }
export interface SrcList { id: string; name: string; items: Entry[] }

const normTitle = (t: string | null | undefined) => String(t ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, '');

/** Provider id keys (`tmdb:603`, `imdb:tt0133093`, `tvdb:121361`) from a source's ids or MediaMax's external_ids. */
export function providerKeys(ids: Record<string, unknown> | null | undefined): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(ids ?? {})) {
    const key = k.toLowerCase();
    if ((key === 'tmdb' || key === 'imdb' || key === 'tvdb') && v != null && String(v).trim()) out.push(`${key}:${String(v).trim().toLowerCase()}`);
  }
  return out;
}

/**
 * In-memory index of the MediaMax catalogue, built once per preview/run (two queries), so matching tens of thousands
 * of source titles costs map lookups, not SQL. Order: provider ids → file path (after path mappings) → title + year.
 */
export class Matcher {
  private movieBy = new Map<string, string>();
  private showBy = new Map<string, string>();
  private episodeBy = new Map<string, string>();
  private episodeByNum = new Map<string, string>();
  private byPath = new Map<string, string>();
  private movieByTitle = new Map<string, string | null>();
  private showByTitle = new Map<string, string | null>();
  private duration = new Map<string, number>();

  constructor(private mappings: ImportPathMapping[]) {
    const rows = db.all<{ id: string; type: string; title: string; year: number | null; external_ids: string; path: string | null; grandparent_id: string | null; parent_idx: number | null; idx: number | null; duration_ms: number | null }>(
      "SELECT id, type, title, year, external_ids, path, grandparent_id, parent_idx, idx, duration_ms FROM items WHERE type IN ('movie','show','episode') AND library_id IS NOT NULL");
    const addTitle = (m: Map<string, string | null>, key: string, id: string) => m.set(key, m.has(key) && m.get(key) !== id ? null : id);
    for (const r of rows) {
      const keys = providerKeys(parseJson<Record<string, unknown>>(r.external_ids, {}));
      const target = r.type === 'movie' ? this.movieBy : r.type === 'show' ? this.showBy : this.episodeBy;
      for (const k of keys) if (!target.has(k)) target.set(k, r.id);
      if (r.duration_ms) this.duration.set(r.id, r.duration_ms);
      if (r.path && /[/\\]/.test(r.path) && !this.byPath.has(pathKey(r.path))) this.byPath.set(pathKey(r.path), r.id);
      if (r.type === 'episode' && r.grandparent_id && r.parent_idx != null && r.idx != null) this.episodeByNum.set(`${r.grandparent_id}|${r.parent_idx}|${r.idx}`, r.id);
      if (r.type === 'movie' || r.type === 'show') {
        const m = r.type === 'movie' ? this.movieByTitle : this.showByTitle;
        const t = normTitle(r.title);
        if (!t) continue;
        addTitle(m, `${t}|${r.year ?? ''}`, r.id);
        addTitle(m, `${t}|*`, r.id);
      }
    }
    for (const m of db.all<{ item_id: string; path: string }>('SELECT item_id, path FROM media WHERE path IS NOT NULL')) this.byPath.set(pathKey(m.path), m.item_id);
  }

  /** Runtime of a MediaMax item (for history rows whose source has no duration). */
  durationOf(id: string): number | null {
    return this.duration.get(id) ?? null;
  }

  private path(p: string | undefined): string | null {
    return p ? this.byPath.get(pathKey(mapPath(p, this.mappings))) ?? null : null;
  }

  private byTitle(m: Map<string, string | null>, name: string | undefined, year: number | undefined): string | null {
    const t = normTitle(name);
    if (!t) return null;
    // Exact title + year; without a year only a title that is unique in MediaMax.
    return (year ? m.get(`${t}|${year}`) : m.get(`${t}|*`)) ?? null;
  }

  show(s: SrcSeries): Match | null {
    for (const k of providerKeys(s.providerIds)) {
      const id = this.showBy.get(k);
      if (id) return { id, how: 'provider' };
    }
    const p = this.path(s.path);
    if (p) return { id: p, how: 'path' };
    const t = this.byTitle(this.showByTitle, s.title, s.year);
    return t ? { id: t, how: 'title' } : null;
  }

  /**
   * Match one source title. For episodes, `series` is the source series (null/undefined when unknown: then the
   * series name is tried).
   */
  match(item: SrcItem, series?: SrcSeries | null): Match | null {
    if (item.kind === 'movie') {
      for (const k of providerKeys(item.providerIds)) {
        const id = this.movieBy.get(k);
        if (id) return { id, how: 'provider' };
      }
      const p = this.path(item.path);
      if (p) return { id: p, how: 'path' };
      const t = this.byTitle(this.movieByTitle, item.title, item.year);
      return t ? { id: t, how: 'title' } : null;
    }
    if (item.kind === 'show') return this.show(item);
    if (item.kind === 'episode') {
      for (const k of providerKeys(item.providerIds)) {
        const id = this.episodeBy.get(k);
        if (id) return { id, how: 'provider' };
      }
      const show = series ? this.show(series) : null;
      const num = (showId: string) => (item.season != null && item.episode != null ? this.episodeByNum.get(`${showId}|${item.season}|${item.episode}`) ?? null : null);
      if (show?.how === 'provider') {
        const id = num(show.id);
        if (id) return { id, how: 'provider' };
      }
      const p = this.path(item.path);
      if (p) return { id: p, how: 'path' };
      if (show) {
        const id = num(show.id);
        if (id) return { id, how: show.how };
      }
      // Series unknown: fall back to its name.
      if (!series && item.seriesTitle) {
        const s = this.byTitle(this.showByTitle, item.seriesTitle, undefined);
        const id = s ? num(s) : null;
        if (id) return { id, how: 'title' };
      }
      return null;
    }
    // Anything else (music tracks in playlists, home videos…): by file path only.
    const p = this.path(item.path);
    return p ? { id: p, how: 'path' } : null;
  }
}

export const emptyCount = (): ImportMatchCount => ({ total: 0, matched: 0, byProviderId: 0, byPath: 0, byTitle: 0 });
export function addCount(c: ImportMatchCount, m: Match | null) {
  c.total++;
  if (!m) return;
  c.matched++;
  if (m.how === 'provider') c.byProviderId++;
  else if (m.how === 'path') c.byPath++;
  else c.byTitle++;
}
export const sumCounts = (a: ImportMatchCount, b: ImportMatchCount): ImportMatchCount => ({
  total: a.total + b.total, matched: a.matched + b.matched, byProviderId: a.byProviderId + b.byProviderId, byPath: a.byPath + b.byPath, byTitle: a.byTitle + b.byTitle,
});
const TYPE_LABEL: Record<SrcItem['kind'], string> = { movie: 'Movie', show: 'Series', episode: 'Episode', other: 'Item' };
export const label = (i: SrcItem) =>
  `${i.typeLabel ?? TYPE_LABEL[i.kind]}: ${i.kind === 'episode'
    ? `${i.seriesTitle ?? 'Episode'} S${String(i.season ?? 0).padStart(2, '0')}E${String(i.episode ?? 0).padStart(2, '0')}`
    : `${i.title ?? i.id}${i.year ? ` (${i.year})` : ''}`}`;

/* ------------------------------ writing data ------------------------------ */

export const isoOrNull = (s: string | number | null | undefined) => {
  if (s == null || s === '') return null;
  const t = typeof s === 'number' ? s : Date.parse(s);
  return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null;
};

/** Watched on the source → played here. Never un-watches, never lowers the play count, keeps the later last-played date. */
export function applyWatched(userId: string, itemId: string, ud: UserData | undefined) {
  const last = isoOrNull(ud?.lastPlayed);
  db.run('INSERT OR IGNORE INTO user_data (user_id, item_id) VALUES (?, ?)', userId, itemId);
  db.run(
    `UPDATE user_data SET played = 1, position_ms = 0, play_count = MAX(play_count, ?),
       last_played_at = CASE WHEN ? IS NOT NULL AND (last_played_at IS NULL OR last_played_at < ?) THEN ? ELSE last_played_at END
     WHERE user_id = ? AND item_id = ?`,
    Math.max(1, Math.trunc(ud?.playCount ?? 1)), last, last, last, userId, itemId);
}

/** A resume point, unless the item is already watched here or has a more recent position. */
export function applyResume(userId: string, itemId: string, ud: UserData | undefined): boolean {
  const pos = Math.max(0, Math.round(ud?.positionMs ?? 0));
  if (!pos) return false;
  const last = isoOrNull(ud?.lastPlayed) ?? nowIso();
  db.run('INSERT OR IGNORE INTO user_data (user_id, item_id) VALUES (?, ?)', userId, itemId);
  const r = db.run(
    `UPDATE user_data SET position_ms = ?, last_played_at = ?
     WHERE user_id = ? AND item_id = ? AND played = 0 AND (position_ms = 0 OR last_played_at IS NULL OR last_played_at <= ?)`,
    pos, last, userId, itemId, last);
  return r.changes > 0;
}

export function applyFavorite(userId: string, itemId: string) {
  db.run('INSERT OR IGNORE INTO user_data (user_id, item_id) VALUES (?, ?)', userId, itemId);
  db.run('UPDATE user_data SET favorite = 1 WHERE user_id = ? AND item_id = ?', userId, itemId);
}

/**
 * One play history row (stats, "year in review"), unless the same play is already there. Rows get an end time so they
 * count as finished plays; without a source duration the item's runtime is used.
 */
export function applyHistory(s: ImportSource, userId: string, itemId: string, at: string, durationMs: number | null): boolean {
  if (db.get('SELECT 1 FROM play_history WHERE user_id = ? AND started_at = ? AND item_id = ?', userId, at, itemId)) return false;
  const ms = durationMs && durationMs > 0 ? Math.round(durationMs) : null;
  db.run('INSERT INTO play_history (user_id, item_id, started_at, ended_at, duration_ms, method, platform) VALUES (?, ?, ?, ?, ?, ?, ?)',
    userId, itemId, at, ms ? new Date(Date.parse(at) + ms).toISOString() : at, ms, 'import', s);
  return true;
}

export const uniqIds = (list: { m: Match | null }[]) => [...new Set(list.filter((x) => x.m).map((x) => x.m!.id))];

/** Find (or make) the MediaMax playlist/collection for a source one, then add the matched items it doesn't have yet. */
export function upsertContainer(s: ImportSource, kind: 'playlist' | 'collection', src: { id: string; name: string }, ownerId: string | null, items: { m: Match | null }[]): { id: string; created: boolean } {
  const title = (src.name || (kind === 'playlist' ? 'Playlist' : 'Collection')).slice(0, 200);
  const mapKey = kind === 'playlist' ? `${ownerId}:${src.id}` : src.id;
  let id = getMap(s, kind, mapKey);
  if (id && !db.get('SELECT 1 FROM items WHERE id = ? AND type = ?', id, kind)) id = null;
  if (!id) {
    id = kind === 'playlist'
      ? db.get<{ id: string }>("SELECT id FROM items WHERE type = 'playlist' AND owner_id = ? AND title = ? AND smart IS NULL", ownerId, title)?.id ?? null
      : db.get<{ id: string }>("SELECT id FROM items WHERE type = 'collection' AND title = ? AND smart IS NULL", title)?.id ?? null;
  }
  let created = false;
  if (!id) {
    id = createContainer(kind, title, ownerId, [], undefined);
    created = true;
  }
  setMap(s, kind, mapKey, id);
  addToContainer(id, uniqIds(items));
  return { id, created };
}

/** Run `fn` over `list` with at most `n` in flight. */
export async function pool<T>(list: T[], n: number, fn: (x: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (next < list.length) {
      const i = next++;
      await fn(list[i], i);
    }
  }));
}

/* --------------------------------- drivers -------------------------------- */

export interface Want { watched: boolean; resume: boolean; favorites: boolean; playlists: boolean; history: boolean }

/** Everything read for one user. `notes` end up in the preview/results. */
export interface Haul { watched: Entry[]; resume: Entry[]; favorites: Entry[]; playlists: SrcList[]; history: HistoryEntry[]; notes: string[] }
export const emptyHaul = (): Haul => ({ watched: [], resume: [], favorites: [], playlists: [], history: [], notes: [] });

/** Count-only totals for the quick preview. */
export interface QuickCounts { watched: number; resume: number; favorites: number; playlists: number; history: number; notes: string[] }

export type Progress = (phase: string, fraction?: number) => void;

/** One connected read of a source server (a preview or an import). */
export interface Session {
  server: { id: string | null; name: string; version: string };
  folders: SrcFolder[];
  /** Source-wide caveats. */
  notes: string[];
  users(libs: ImportLibraryMapping[]): SourceUser[];
  /** Work done once before users are read (e.g. Plex: index the whole catalogue). Full previews and imports only. */
  prepare?(progress: Progress): Promise<void>;
  collectUser(u: SourceUser, want: Want): Promise<Haul>;
  countUser(u: SourceUser, want: Want): Promise<QuickCounts>;
  collections(): Promise<SrcList[]>;
  countCollections(): Promise<number>;
}

export interface Driver {
  source: ImportSource;
  test(c: Conn): Promise<ImportTestResult>;
  /** `matcher` is null for a quick preview (nothing is matched). */
  open(c: Conn, matcher: Matcher | null, want: Want): Promise<Session>;
}
