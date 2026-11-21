import crypto from 'node:crypto';
import type {
  CreateUserRequest, EmbyImportConfig, EmbyImportJob, EmbyImportOptions, EmbyImportPreview, EmbyImportUserResult, EmbyLibraryMapping,
  EmbyMatchCount, EmbyPathMapping, EmbyPreviewUser, User,
} from '@mediamax/shared';
import { db } from '../db.js';
import { badRequest, conflict, HttpError } from '../util/errors.js';
import { nowIso, parseJson } from '../util/misc.js';
import { logger } from '../util/log.js';
import { getKv, setKv, SECRET_MASK } from './settings.js';
import { createUser, updateUser } from './auth.js';
import { createPasswordLink, passwordLinkUrl, passwordLinkUsed } from './passwordLinks.js';
import { addToContainer, createContainer } from './items.js';
import { logActivity } from './activity.js';
import { events } from './events.js';

/**
 * Emby → MediaMax migration (Admin → Import from Emby).
 *
 * Reads an Emby Server 4.x over its REST API with an admin API key (`X-Emby-Token`) and brings over users and their
 * permissions, library access, watched flags, resume positions, favourites, playlists and collections. Emby password
 * hashes can't be read over the API, so each new account gets a random password nobody knows plus a one-time
 * set-password link. Re-running is safe: users are recognised by an id map (or username), watch data is only ever
 * upgraded (never un-watched, play counts never go down), playlists/collections are topped up rather than duplicated.
 *
 * Like the *arr integration this uses plain `fetch` (not the SSRF-guarded `safeFetch`): the URL is set by an admin and
 * an Emby server almost always lives on the LAN.
 */

const log = logger('emby-import');
const CONFIG_KEY = 'embyImport:config';
const JOB_KEY = 'embyImport:lastJob';
export const LINK_PURPOSE = 'emby-import';
const ITEM_FIELDS = 'ProviderIds,Path,UserData,ProductionYear';

/* ------------------------------ Emby DTOs ------------------------------ */

interface EmbyUserData { Played?: boolean; PlaybackPositionTicks?: number; PlayCount?: number; IsFavorite?: boolean; LastPlayedDate?: string | null }
interface EmbyItem {
  Id: string; Name?: string; Type?: string; ProductionYear?: number; ProviderIds?: Record<string, string>; Path?: string;
  SeriesId?: string; SeriesName?: string; ParentIndexNumber?: number; IndexNumber?: number; UserData?: EmbyUserData;
}
interface EmbyPolicy {
  IsAdministrator?: boolean; IsHidden?: boolean; IsDisabled?: boolean; EnableRemoteAccess?: boolean; EnableLiveTvAccess?: boolean;
  EnableLiveTvManagement?: boolean; EnableContentDownloading?: boolean; EnableVideoPlaybackTranscoding?: boolean; EnableAllFolders?: boolean;
  EnabledFolders?: string[]; SimultaneousStreamLimit?: number; MaxParentalRating?: number | null;
}
interface EmbyUser { Id: string; Name: string; Policy?: EmbyPolicy; LastActivityDate?: string | null }
interface EmbyFolder { Name: string; ItemId?: string; Guid?: string; Id?: string; Locations?: string[] }
interface EmbyInfo { Id?: string; ServerName?: string; Version?: string }

/* ------------------------------- settings ------------------------------ */

function storedConfig(): EmbyImportConfig {
  const c = getKv<Partial<EmbyImportConfig>>(CONFIG_KEY, {});
  return { url: c.url ?? '', apiKey: c.apiKey ?? '', pathMappings: Array.isArray(c.pathMappings) ? c.pathMappings : [] };
}

/** The importer settings as admins see them: the API key is write-only. */
export function getImportConfig(): EmbyImportConfig {
  const c = storedConfig();
  return { ...c, apiKey: c.apiKey ? SECRET_MASK : '' };
}

function normUrl(raw: unknown): string {
  const u = String(raw ?? '').trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\/[^/\s]+/i.test(u)) throw badRequest('The Emby URL must start with http:// or https://');
  return u.slice(0, 500);
}

function normMappings(raw: unknown): EmbyPathMapping[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((m) => ({ from: String(m?.from ?? '').trim().slice(0, 500), to: String(m?.to ?? '').trim().slice(0, 500) }))
    .filter((m) => m.from && m.to)
    .slice(0, 50);
}

export function saveImportConfig(patch: Partial<EmbyImportConfig>, admin?: User): EmbyImportConfig {
  const cur = storedConfig();
  const next: EmbyImportConfig = {
    url: patch.url !== undefined ? normUrl(patch.url) : cur.url,
    // Saving the mask back (or leaving the field out) keeps the stored key.
    apiKey: patch.apiKey === undefined || patch.apiKey === SECRET_MASK ? cur.apiKey : String(patch.apiKey ?? '').trim().slice(0, 200),
    pathMappings: patch.pathMappings !== undefined ? normMappings(patch.pathMappings) : cur.pathMappings,
  };
  setKv(CONFIG_KEY, next);
  logActivity('settings', 'Emby import settings saved', { userId: admin?.id, userName: admin?.displayName });
  return getImportConfig();
}

/* ------------------------------ Emby client ---------------------------- */

export interface Conn { url: string; apiKey: string }

/** The stored connection, optionally overridden by unsaved form values (the mask means "the stored key"). */
export function connection(override: Partial<Pick<EmbyImportConfig, 'url' | 'apiKey'>> = {}): Conn {
  const c = storedConfig();
  const url = override.url !== undefined && override.url !== '' ? normUrl(override.url) : c.url;
  const apiKey = override.apiKey && override.apiKey !== SECRET_MASK ? String(override.apiKey).trim() : c.apiKey;
  if (!url) throw badRequest('Enter the address of your Emby server first');
  if (!apiKey) throw badRequest('Enter an Emby API key first (Emby: Settings → Advanced → API keys)');
  return { url, apiKey };
}

type Query = Record<string, string | number | boolean | undefined>;

async function embyGet<T>(c: Conn, path: string, query: Query = {}): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
  const q = qs.toString();
  let res: Response;
  try {
    res = await fetch(`${c.url}${path}${q ? `?${q}` : ''}`, { headers: { 'X-Emby-Token': c.apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const FRIENDLY: Record<string, string> = { ECONNREFUSED: 'connection refused', ENOTFOUND: 'host not found', EAI_AGAIN: 'host not found', ETIMEDOUT: 'timed out', EHOSTUNREACH: 'host unreachable', ECONNRESET: 'connection reset' };
    const code = err.cause?.code;
    const msg = err.name === 'TimeoutError' ? 'timed out' : code ? FRIENDLY[code] ?? code : err.cause?.message ?? err.message;
    throw new HttpError(502, `Can't reach Emby: ${msg}`, 'emby_unreachable');
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new HttpError(502, 'Emby rejected the API key', 'emby_unauthorized');
  if (!res.ok) throw new HttpError(502, `Emby answered HTTP ${res.status} for ${path}`, 'emby_error');
  try {
    return (text ? JSON.parse(text) : null) as T;
  } catch {
    throw new HttpError(502, 'That address did not answer like an Emby server (check the URL; some setups need /emby at the end)', 'emby_error');
  }
}

async function embyPaged(c: Conn, path: string, query: Query): Promise<EmbyItem[]> {
  const out: EmbyItem[] = [];
  const limit = 500;
  for (let start = 0; ;) {
    const r = await embyGet<{ Items?: EmbyItem[]; TotalRecordCount?: number }>(c, path, { ...query, StartIndex: start, Limit: limit });
    const items = r?.Items ?? [];
    out.push(...items);
    start += items.length;
    if (!items.length || start >= (r?.TotalRecordCount ?? 0) || out.length >= 200000) break;
  }
  return out;
}

export async function testConnection(override: Partial<Pick<EmbyImportConfig, 'url' | 'apiKey'>> = {}): Promise<{ ok: boolean; message: string; serverName?: string; version?: string; users?: number }> {
  try {
    const c = connection(override);
    const info = await embyGet<EmbyInfo>(c, '/System/Info');
    if (!info || typeof info !== 'object' || !('Version' in info)) return { ok: false, message: 'That address did not answer like an Emby server' };
    const users = await embyGet<EmbyUser[]>(c, '/Users');
    return { ok: true, message: `Connected to ${info.ServerName ?? 'Emby'} ${info.Version ?? ''}`.trim(), serverName: info.ServerName, version: info.Version, users: Array.isArray(users) ? users.length : 0 };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/* --------------------------- paths & libraries --------------------------- */

const normPath = (p: string) => String(p ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
const pathKey = (p: string) => normPath(p).toLowerCase();

/** Apply the longest matching prefix mapping (case-insensitive, `\` and `/` treated alike). */
export function mapPath(p: string, mappings: EmbyPathMapping[]): string {
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

interface LocalLibrary { id: string; name: string; paths: string[] }
const localLibraries = (): LocalLibrary[] =>
  db.all<{ id: string; name: string; paths: string }>("SELECT id, name, paths FROM libraries WHERE type NOT LIKE 'iptv-%' ORDER BY sort_order, name")
    .map((l) => ({ id: l.id, name: l.name, paths: parseJson<string[]>(l.paths, []) }));

export function mapLibraries(folders: EmbyFolder[], mappings: EmbyPathMapping[]): EmbyLibraryMapping[] {
  const libs = localLibraries();
  const overlaps = (a: string, b: string) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
  return folders.map((f) => {
    const locs = (f.Locations ?? []).map((l) => pathKey(mapPath(l, mappings)));
    let lib = libs.find((l) => l.paths.some((p) => locs.some((x) => x && overlaps(x, pathKey(p)))));
    let method: EmbyLibraryMapping['method'] = lib ? 'path' : null;
    if (!lib) {
      lib = libs.find((l) => l.name.trim().toLowerCase() === f.Name.trim().toLowerCase());
      if (lib) method = 'name';
    }
    return { embyId: String(f.ItemId ?? f.Id ?? f.Guid ?? f.Name), name: f.Name, locations: f.Locations ?? [], libraryId: lib?.id ?? null, libraryName: lib?.name ?? null, method };
  });
}

/* ------------------------------ user mapping ----------------------------- */

/** Emby's parental rating number → a rating MediaMax understands (US scale; values above 10 are ages). */
export function embyRating(v: number | null | undefined): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (v <= 1) return 'G';
  if (v <= 5) return 'PG';
  if (v <= 7) return 'PG-13';
  if (v <= 9) return 'R';
  if (v === 10) return 'NC-17';
  return String(Math.min(18, Math.round(v)));
}

export const safeUsername = (name: string, embyId: string) => String(name ?? '').trim().replace(/[^\w.@ -]/g, '_').slice(0, 64) || `user_${embyId.slice(0, 8)}`;

interface MappedUser extends CreateUserRequest { disabled: boolean; hiddenFromLogin: boolean; unmappedFolders: string[] }

export function mapUser(u: EmbyUser, folders: EmbyFolder[], libs: EmbyLibraryMapping[]): MappedUser {
  const p = u.Policy ?? {};
  // Emby lists enabled folders by the library's ItemId (some versions use its Guid).
  const byKey = new Map<string, EmbyLibraryMapping>();
  folders.forEach((f, i) => {
    for (const k of [f.ItemId, f.Id, f.Guid]) if (k) byKey.set(String(k).toLowerCase().replace(/-/g, ''), libs[i]);
  });
  let libraryIds: string[] | null = null;
  const unmappedFolders: string[] = [];
  if (p.EnableAllFolders === false) {
    const ids = new Set<string>();
    for (const id of p.EnabledFolders ?? []) {
      const m = byKey.get(String(id).toLowerCase().replace(/-/g, ''));
      if (m?.libraryId) ids.add(m.libraryId);
      else unmappedFolders.push(m?.name ?? String(id));
    }
    libraryIds = [...ids];
  }
  const streams = Number(p.SimultaneousStreamLimit ?? 0);
  return {
    username: safeUsername(u.Name, u.Id),
    displayName: String(u.Name ?? '').trim().slice(0, 100) || undefined,
    isAdmin: !!p.IsAdministrator,
    libraryIds,
    maxContentRating: embyRating(p.MaxParentalRating),
    allowLiveTv: p.EnableLiveTvAccess !== false,
    allowDvr: !!p.EnableLiveTvManagement || !!p.IsAdministrator,
    allowDownloads: p.EnableContentDownloading !== false,
    allowTranscode: p.EnableVideoPlaybackTranscoding !== false,
    allowRemote: p.EnableRemoteAccess !== false,
    // Emby: 0 = unlimited.
    maxStreams: streams > 0 ? Math.min(100, Math.trunc(streams)) : null,
    disabled: !!p.IsDisabled,
    hiddenFromLogin: !!p.IsHidden,
    unmappedFolders,
  };
}

/** The MediaMax account an Emby user corresponds to: an earlier import's mapping first, then the username. */
function existingUserId(u: EmbyUser): string | null {
  const mapped = db.get<{ local_id: string }>("SELECT m.local_id FROM emby_import_map m JOIN users u ON u.id = m.local_id WHERE m.kind = 'user' AND m.emby_id = ?", u.Id);
  if (mapped) return mapped.local_id;
  const byName = db.get<{ id: string }>('SELECT id FROM users WHERE username = ? AND parent_user_id IS NULL', safeUsername(u.Name, u.Id));
  if (!byName) return null;
  // That account already belongs to another Emby user (two Emby names that sanitise alike): not this one.
  if (db.get("SELECT 1 FROM emby_import_map WHERE kind = 'user' AND local_id = ? AND emby_id != ?", byName.id, u.Id)) return null;
  return byName.id;
}

function freeUsername(base: string): string {
  if (!db.get('SELECT 1 FROM users WHERE username = ?', base)) return base;
  for (let i = 2; i < 1000; i++) {
    const name = `${base.slice(0, 60)}_${i}`;
    if (!db.get('SELECT 1 FROM users WHERE username = ?', name)) return name;
  }
  return `${base.slice(0, 50)}_${crypto.randomBytes(4).toString('hex')}`;
}

const setMap = (kind: string, embyId: string, localId: string) => db.upsert('emby_import_map', { kind, emby_id: embyId, local_id: localId, imported_at: nowIso() }, 'kind,emby_id');
const getMap = (kind: string, embyId: string) => db.get<{ local_id: string }>('SELECT local_id FROM emby_import_map WHERE kind = ? AND emby_id = ?', kind, embyId)?.local_id ?? null;

/* ------------------------------ item matching ---------------------------- */

type How = 'provider' | 'path' | 'title';
interface Match { id: string; how: How }

const normTitle = (t: string | null | undefined) => String(t ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, '');

/** Provider id keys (`tmdb:603`, `imdb:tt0133093`, `tvdb:121361`) from Emby's ProviderIds or MediaMax's external_ids. */
function providerKeys(ids: Record<string, unknown> | null | undefined): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(ids ?? {})) {
    const key = k.toLowerCase();
    if ((key === 'tmdb' || key === 'imdb' || key === 'tvdb') && v != null && String(v).trim()) out.push(`${key}:${String(v).trim().toLowerCase()}`);
  }
  return out;
}

/** In-memory index of the MediaMax catalogue, built once per preview/run. */
export class Matcher {
  private movieBy = new Map<string, string>();
  private showBy = new Map<string, string>();
  private episodeBy = new Map<string, string>();
  private episodeByNum = new Map<string, string>();
  private byPath = new Map<string, string>();
  private movieByTitle = new Map<string, string | null>();
  private showByTitle = new Map<string, string | null>();
  private series = new Map<string, EmbyItem | null>();

  constructor(private mappings: EmbyPathMapping[]) {
    const rows = db.all<{ id: string; type: string; title: string; year: number | null; external_ids: string; path: string | null; grandparent_id: string | null; parent_idx: number | null; idx: number | null }>(
      "SELECT id, type, title, year, external_ids, path, grandparent_id, parent_idx, idx FROM items WHERE type IN ('movie','show','episode') AND library_id IS NOT NULL");
    const addTitle = (m: Map<string, string | null>, key: string, id: string) => m.set(key, m.has(key) && m.get(key) !== id ? null : id);
    for (const r of rows) {
      const keys = providerKeys(parseJson<Record<string, unknown>>(r.external_ids, {}));
      const target = r.type === 'movie' ? this.movieBy : r.type === 'show' ? this.showBy : this.episodeBy;
      for (const k of keys) if (!target.has(k)) target.set(k, r.id);
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

  private path(p: string | undefined): string | null {
    return p ? this.byPath.get(pathKey(mapPath(p, this.mappings))) ?? null : null;
  }

  private byTitle(m: Map<string, string | null>, name: string | undefined, year: number | undefined): string | null {
    const t = normTitle(name);
    if (!t) return null;
    // Exact title + year; without a year only a title that is unique in MediaMax.
    return (year ? m.get(`${t}|${year}`) : m.get(`${t}|*`)) ?? null;
  }

  /** Fetch the series of these episodes (their provider ids and folders are needed to find the MediaMax show). */
  async loadSeries(c: Conn, embyUserId: string, items: EmbyItem[]) {
    const missing = [...new Set(items.filter((i) => i.Type === 'Episode' && i.SeriesId && !this.series.has(i.SeriesId)).map((i) => i.SeriesId!))];
    for (let i = 0; i < missing.length; i += 50) {
      const ids = missing.slice(i, i + 50);
      const r = await embyGet<{ Items?: EmbyItem[] }>(c, `/Users/${encodeURIComponent(embyUserId)}/Items`, { Ids: ids.join(','), Fields: 'ProviderIds,Path,ProductionYear' });
      for (const s of r?.Items ?? []) this.series.set(s.Id, s);
      for (const id of ids) if (!this.series.has(id)) this.series.set(id, null);
    }
  }

  private show(s: EmbyItem): Match | null {
    for (const k of providerKeys(s.ProviderIds)) {
      const id = this.showBy.get(k);
      if (id) return { id, how: 'provider' };
    }
    const p = this.path(s.Path);
    if (p) return { id: p, how: 'path' };
    const t = this.byTitle(this.showByTitle, s.Name, s.ProductionYear);
    return t ? { id: t, how: 'title' } : null;
  }

  match(item: EmbyItem): Match | null {
    if (item.Type === 'Movie') {
      for (const k of providerKeys(item.ProviderIds)) {
        const id = this.movieBy.get(k);
        if (id) return { id, how: 'provider' };
      }
      const p = this.path(item.Path);
      if (p) return { id: p, how: 'path' };
      const t = this.byTitle(this.movieByTitle, item.Name, item.ProductionYear);
      return t ? { id: t, how: 'title' } : null;
    }
    if (item.Type === 'Series') return this.show(item);
    if (item.Type === 'Episode') {
      for (const k of providerKeys(item.ProviderIds)) {
        const id = this.episodeBy.get(k);
        if (id) return { id, how: 'provider' };
      }
      const series = item.SeriesId ? this.series.get(item.SeriesId) ?? null : null;
      const show = series ? this.show(series) : null;
      const num = (showId: string) => (item.ParentIndexNumber != null && item.IndexNumber != null ? this.episodeByNum.get(`${showId}|${item.ParentIndexNumber}|${item.IndexNumber}`) ?? null : null);
      if (show?.how === 'provider') {
        const id = num(show.id);
        if (id) return { id, how: 'provider' };
      }
      const p = this.path(item.Path);
      if (p) return { id: p, how: 'path' };
      if (show) {
        const id = num(show.id);
        if (id) return { id, how: show.how };
      }
      // Series not fetched (or unknown): fall back to its name.
      if (!series && item.SeriesName) {
        const s = this.byTitle(this.showByTitle, item.SeriesName, undefined);
        const id = s ? num(s) : null;
        if (id) return { id, how: 'title' };
      }
      return null;
    }
    // Anything else (music tracks in playlists, home videos…): by file path only.
    const p = this.path(item.Path);
    return p ? { id: p, how: 'path' } : null;
  }
}

const emptyCount = (): EmbyMatchCount => ({ total: 0, matched: 0, byProviderId: 0, byPath: 0, byTitle: 0 });
function addCount(c: EmbyMatchCount, m: Match | null) {
  c.total++;
  if (!m) return;
  c.matched++;
  if (m.how === 'provider') c.byProviderId++;
  else if (m.how === 'path') c.byPath++;
  else c.byTitle++;
}
const sumCounts = (a: EmbyMatchCount, b: EmbyMatchCount): EmbyMatchCount => ({
  total: a.total + b.total, matched: a.matched + b.matched, byProviderId: a.byProviderId + b.byProviderId, byPath: a.byPath + b.byPath, byTitle: a.byTitle + b.byTitle,
});
const label = (i: EmbyItem) =>
  i.Type === 'Episode' ? `${i.SeriesName ?? 'Episode'} S${String(i.ParentIndexNumber ?? 0).padStart(2, '0')}E${String(i.IndexNumber ?? 0).padStart(2, '0')}` : `${i.Name ?? i.Id}${i.ProductionYear ? ` (${i.ProductionYear})` : ''}`;

/* ------------------------------ fetching a user ---------------------------- */

interface Matched { item: EmbyItem; m: Match | null }
interface Haul { watched: Matched[]; resume: Matched[]; favorites: Matched[]; playlists: { emby: EmbyItem; items: Matched[] }[] }
interface Want { watched: boolean; resume: boolean; favorites: boolean; playlists: boolean }

async function collectUser(c: Conn, u: EmbyUser, matcher: Matcher, want: Want): Promise<Haul> {
  const base = `/Users/${encodeURIComponent(u.Id)}/Items`;
  const q = { Recursive: true, Fields: ITEM_FIELDS };
  const watched = want.watched ? await embyPaged(c, base, { ...q, IncludeItemTypes: 'Movie,Episode', Filters: 'IsPlayed' }) : [];
  const resume = want.resume ? await embyPaged(c, base, { ...q, IncludeItemTypes: 'Movie,Episode', Filters: 'IsResumable' }) : [];
  const favorites = want.favorites ? await embyPaged(c, base, { ...q, IncludeItemTypes: 'Movie,Episode,Series', Filters: 'IsFavorite' }) : [];
  const playlists: { emby: EmbyItem; items: EmbyItem[] }[] = [];
  if (want.playlists) {
    for (const pl of await embyPaged(c, base, { Recursive: true, IncludeItemTypes: 'Playlist' })) {
      playlists.push({ emby: pl, items: await embyPaged(c, `/Playlists/${encodeURIComponent(pl.Id)}/Items`, { UserId: u.Id, Fields: ITEM_FIELDS }) });
    }
  }
  await matcher.loadSeries(c, u.Id, [...watched, ...resume, ...favorites, ...playlists.flatMap((p) => p.items)]);
  const m = (list: EmbyItem[]) => list.map((item) => ({ item, m: matcher.match(item) }));
  return { watched: m(watched), resume: m(resume), favorites: m(favorites), playlists: playlists.map((p) => ({ emby: p.emby, items: m(p.items) })) };
}

async function collectCollections(c: Conn, users: EmbyUser[], matcher: Matcher): Promise<{ emby: EmbyItem; items: Matched[] }[]> {
  // Collections are server-wide; read them as an administrator (who can see every library).
  const viewer = users.find((u) => u.Policy?.IsAdministrator && !u.Policy?.IsDisabled) ?? users[0];
  if (!viewer) return [];
  const base = `/Users/${encodeURIComponent(viewer.Id)}/Items`;
  const out: { emby: EmbyItem; items: Matched[] }[] = [];
  for (const bs of await embyPaged(c, base, { Recursive: true, IncludeItemTypes: 'BoxSet' })) {
    const items = await embyPaged(c, base, { ParentId: bs.Id, Fields: ITEM_FIELDS });
    await matcher.loadSeries(c, viewer.Id, items);
    out.push({ emby: bs, items: items.map((item) => ({ item, m: matcher.match(item) })) });
  }
  return out;
}

async function pool<T>(list: T[], n: number, fn: (x: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (next < list.length) {
      const i = next++;
      await fn(list[i], i);
    }
  }));
}

/* --------------------------------- source --------------------------------- */

async function readSource(c: Conn) {
  const info = await embyGet<EmbyInfo>(c, '/System/Info');
  if (!info || typeof info !== 'object' || !('Version' in info)) throw new HttpError(502, 'That address did not answer like an Emby server', 'emby_error');
  const folders = (await embyGet<EmbyFolder[]>(c, '/Library/VirtualFolders')) ?? [];
  let users = (await embyGet<EmbyUser[]>(c, '/Users')) ?? [];
  // Older servers leave the policy out of the list; fetch it per user.
  users = await Promise.all(users.map(async (u) => (u.Policy ? u : { ...u, ...(await embyGet<EmbyUser>(c, `/Users/${encodeURIComponent(u.Id)}`)) })));
  return { info, folders: Array.isArray(folders) ? folders : [], users: Array.isArray(users) ? users : [] };
}

const want = (o: EmbyImportOptions): Want => ({ watched: o.importWatched !== false, resume: o.importResume !== false, favorites: o.importFavorites !== false, playlists: o.importPlaylists !== false });

function actionFor(existing: string | null, mapped: MappedUser, o: EmbyImportOptions): EmbyPreviewUser['action'] {
  if (!existing) return mapped.disabled && o.includeDisabled === false ? 'skip' : 'create';
  if (o.updateExisting) return 'update';
  return o.mergeExisting !== false ? 'merge' : 'skip';
}

/* --------------------------------- preview -------------------------------- */

export async function previewImport(o: EmbyImportOptions = {}): Promise<EmbyImportPreview> {
  const c = connection();
  const mappings = storedConfig().pathMappings;
  const { info, folders, users } = await readSource(c);
  const libs = mapLibraries(folders, mappings);
  const libName = new Map(localLibraries().map((l) => [l.id, l.name]));
  const matcher = new Matcher(mappings);
  const samples = new Set<string>();
  const sample = (list: Matched[]) => {
    for (const x of list) if (!x.m && samples.size < 40) samples.add(`${x.item.Type ?? 'Item'}: ${label(x.item)}`);
  };
  const out: EmbyPreviewUser[] = new Array(users.length);
  await pool(users, 4, async (u, i) => {
    const mapped = mapUser(u, folders, libs);
    const existing = existingUserId(u);
    const action = actionFor(existing, mapped, o);
    const haul = action === 'skip' ? { watched: [], resume: [], favorites: [], playlists: [] } : await collectUser(c, u, matcher, want(o));
    const count = (list: Matched[]) => {
      const n = emptyCount();
      list.forEach((x) => addCount(n, x.m));
      sample(list);
      return n;
    };
    const plItems = haul.playlists.flatMap((p) => p.items);
    out[i] = {
      embyId: u.Id, username: mapped.username, renamedFrom: mapped.username !== u.Name ? u.Name : null, displayName: mapped.displayName ?? mapped.username,
      isAdmin: !!mapped.isAdmin, disabled: mapped.disabled, hidden: mapped.hiddenFromLogin, allowRemote: mapped.allowRemote !== false,
      allowLiveTv: mapped.allowLiveTv !== false, allowDownloads: mapped.allowDownloads !== false, maxStreams: mapped.maxStreams ?? null,
      maxContentRating: mapped.maxContentRating ?? null, libraries: mapped.libraryIds ? mapped.libraryIds.map((id) => libName.get(id) ?? id) : null,
      unmappedFolders: mapped.unmappedFolders, lastActivity: u.LastActivityDate ?? null, action, existingUserId: existing,
      watched: count(haul.watched), resume: count(haul.resume), favorites: count(haul.favorites), playlists: haul.playlists.length, playlistItems: count(plItems),
    };
  });
  const cols = o.importCollections !== false ? await collectCollections(c, users, matcher) : [];
  const colCount = emptyCount();
  for (const col of cols) {
    col.items.forEach((x) => addCount(colCount, x.m));
    sample(col.items);
  }
  const by = (a: EmbyPreviewUser['action']) => out.filter((u) => u.action === a).length;
  return {
    server: { id: info.Id ?? null, name: info.ServerName ?? 'Emby', version: info.Version ?? '' },
    libraries: libs,
    users: out,
    collections: cols.length,
    collectionItems: colCount,
    totals: {
      users: out.length, create: by('create'), update: by('update'), merge: by('merge'), skip: by('skip'),
      watched: out.reduce((a, u) => sumCounts(a, u.watched), emptyCount()),
      resume: out.reduce((a, u) => sumCounts(a, u.resume), emptyCount()),
      favorites: out.reduce((a, u) => sumCounts(a, u.favorites), emptyCount()),
    },
    unmatchedSamples: [...samples],
  };
}

/* ------------------------------ writing data ------------------------------ */

const isoOrNull = (s: string | null | undefined) => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null;
};

/** Watched in Emby → played here. Never un-watches, never lowers the play count, keeps the later last-played date. */
function applyWatched(userId: string, itemId: string, ud: EmbyUserData | undefined) {
  const last = isoOrNull(ud?.LastPlayedDate);
  db.run('INSERT OR IGNORE INTO user_data (user_id, item_id) VALUES (?, ?)', userId, itemId);
  db.run(
    `UPDATE user_data SET played = 1, position_ms = 0, play_count = MAX(play_count, ?),
       last_played_at = CASE WHEN ? IS NOT NULL AND (last_played_at IS NULL OR last_played_at < ?) THEN ? ELSE last_played_at END
     WHERE user_id = ? AND item_id = ?`,
    Math.max(1, Math.trunc(ud?.PlayCount ?? 1)), last, last, last, userId, itemId);
}

/** A resume point, unless the item is already watched here or has a more recent position. */
function applyResume(userId: string, itemId: string, ud: EmbyUserData | undefined): boolean {
  const pos = Math.max(0, Math.round((ud?.PlaybackPositionTicks ?? 0) / 10000));
  if (!pos) return false;
  const last = isoOrNull(ud?.LastPlayedDate) ?? nowIso();
  db.run('INSERT OR IGNORE INTO user_data (user_id, item_id) VALUES (?, ?)', userId, itemId);
  const r = db.run(
    `UPDATE user_data SET position_ms = ?, last_played_at = ?
     WHERE user_id = ? AND item_id = ? AND played = 0 AND (position_ms = 0 OR last_played_at IS NULL OR last_played_at <= ?)`,
    pos, last, userId, itemId, last);
  return r.changes > 0;
}

function applyFavorite(userId: string, itemId: string) {
  db.run('INSERT OR IGNORE INTO user_data (user_id, item_id) VALUES (?, ?)', userId, itemId);
  db.run('UPDATE user_data SET favorite = 1 WHERE user_id = ? AND item_id = ?', userId, itemId);
}

const uniqIds = (list: Matched[]) => [...new Set(list.filter((x) => x.m).map((x) => x.m!.id))];

/** Find (or make) the MediaMax playlist/collection for an Emby one, then add the matched items it doesn't have yet. */
function upsertContainer(kind: 'playlist' | 'collection', emby: EmbyItem, ownerId: string | null, items: Matched[]): { id: string; created: boolean } {
  const title = (emby.Name ?? (kind === 'playlist' ? 'Playlist' : 'Collection')).slice(0, 200);
  const mapKey = kind === 'playlist' ? `${ownerId}:${emby.Id}` : emby.Id;
  let id = getMap(kind, mapKey);
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
  setMap(kind, mapKey, id);
  addToContainer(id, uniqIds(items));
  return { id, created };
}

/* ---------------------------------- run ---------------------------------- */

let current: EmbyImportJob | null = null;
let lastEmit = 0;

export function getJob(): EmbyImportJob | null {
  return current ?? getKv<EmbyImportJob | null>(JOB_KEY, null);
}

function emit(force = false) {
  if (!current) return;
  if (!force && Date.now() - lastEmit < 1000) return;
  lastEmit = Date.now();
  events.toAdmins({ type: 'embyImport.updated', job: current });
}

function cleanOptions(o: EmbyImportOptions): EmbyImportOptions {
  return {
    userIds: Array.isArray(o.userIds) ? o.userIds.map(String).slice(0, 10000) : null,
    updateExisting: !!o.updateExisting,
    mergeExisting: o.mergeExisting !== false,
    includeDisabled: o.includeDisabled !== false,
    importWatched: o.importWatched !== false,
    importResume: o.importResume !== false,
    importFavorites: o.importFavorites !== false,
    importPlaylists: o.importPlaylists !== false,
    importCollections: o.importCollections !== false,
    linkExpiryDays: Math.max(1, Math.min(365, Math.round(Number(o.linkExpiryDays) || 30))),
  };
}

/** Start an import in the background. Progress goes to admins as `embyImport.updated` events; GET the job to poll. */
export function startImport(admin: User, options: EmbyImportOptions, origin: string): EmbyImportJob {
  if (current?.status === 'running') throw conflict('An Emby import is already running');
  const c = connection();
  const o = cleanOptions(options ?? {});
  const job: EmbyImportJob = {
    id: crypto.randomBytes(6).toString('hex'), status: 'running', phase: 'Connecting to Emby', progress: 0, startedAt: nowIso(), finishedAt: null,
    error: null, options: o, results: [], collections: { created: 0, updated: 0, items: 0 },
  };
  current = job;
  logActivity('emby.import', 'Emby import started', { userId: admin.id, userName: admin.displayName });
  emit(true);
  void runImport(c, admin, job, origin)
    .catch((e) => {
      log.error('Emby import failed', e);
      job.status = 'error';
      job.error = (e as Error).message;
      logActivity('emby.import', `Emby import failed: ${job.error}`, { userId: admin.id, userName: admin.displayName, severity: 'error' });
    })
    .finally(() => {
      job.finishedAt = nowIso();
      if (job.status === 'running') job.status = 'done';
      job.phase = job.status === 'done' ? 'Finished' : 'Failed';
      if (job.status === 'done') job.progress = 100;
      setKv(JOB_KEY, job);
      emit(true);
      if (current === job) current = null;
    });
  return job;
}

/** Run an import to the end (tests and the background job). */
export async function runImport(c: Conn, admin: User, job: EmbyImportJob, origin: string): Promise<EmbyImportJob> {
  const o = job.options;
  const mappings = storedConfig().pathMappings;
  const { folders, users } = await readSource(c);
  const libs = mapLibraries(folders, mappings);
  const matcher = new Matcher(mappings);
  const selected = users.filter((u) => !o.userIds || o.userIds.includes(u.Id));
  const w = want(o);

  for (let i = 0; i < selected.length; i++) {
    const u = selected[i];
    job.phase = `Importing ${u.Name} (${i + 1} of ${selected.length})`;
    job.progress = Math.round((i / Math.max(1, selected.length)) * 90);
    emit();
    const mapped = mapUser(u, folders, libs);
    const res: EmbyImportUserResult = {
      embyId: u.Id, username: mapped.username, displayName: mapped.displayName ?? mapped.username, userId: null, status: 'skipped', message: null,
      setPasswordUrl: null, setPasswordExpiresAt: null, watched: 0, resume: 0, favorites: 0, playlists: 0, unmatched: 0,
    };
    job.results.push(res);
    try {
      const existing = existingUserId(u);
      const action = actionFor(existing, mapped, o);
      if (action === 'skip') {
        res.userId = existing;
        res.message = existing ? 'Account already exists' : 'Disabled in Emby';
        continue;
      }
      const { disabled, hiddenFromLogin, unmappedFolders, ...req } = mapped;
      let userId: string;
      const notes: string[] = [];
      if (existing) {
        userId = existing;
        res.username = db.get<{ username: string }>('SELECT username FROM users WHERE id = ?', existing)!.username;
        if (action === 'update') {
          try {
            updateUser(existing, { ...req, username: undefined, password: undefined, disabled }, admin.id);
            db.run('UPDATE users SET hidden_login = ? WHERE id = ?', hiddenFromLogin, existing);
          } catch (e) {
            // e.g. "You cannot remove your own admin rights": keep going with the watch data.
            notes.push(`Permissions not changed: ${(e as Error).message}`);
          }
          res.status = 'updated';
        } else res.status = 'merged';
      } else {
        // Nobody knows this password: the user picks their own with the set-password link.
        const created = createUser({ ...req, username: freeUsername(mapped.username), password: crypto.randomBytes(24).toString('base64url'), hiddenFromLogin });
        userId = created.id;
        res.username = created.username;
        if (disabled) db.run('UPDATE users SET disabled = 1 WHERE id = ?', userId);
        res.status = 'created';
      }
      res.userId = userId;
      setMap('user', u.Id, userId);
      if (unmappedFolders.length) notes.push(`No MediaMax library for: ${unmappedFolders.join(', ')}`);

      // A link for accounts this importer created whose owner hasn't chosen a password yet (also on re-runs).
      const row = db.get<{ disabled: number; totp_enabled: number }>('SELECT disabled, totp_enabled FROM users WHERE id = ?', userId)!;
      const importCreated = res.status === 'created' || !!db.get('SELECT 1 FROM password_links WHERE user_id = ? AND purpose = ?', userId, LINK_PURPOSE);
      if (importCreated && !passwordLinkUsed(userId, LINK_PURPOSE) && !row.disabled && !row.totp_enabled) {
        const link = createPasswordLink(userId, LINK_PURPOSE, admin.id, o.linkExpiryDays);
        res.setPasswordUrl = passwordLinkUrl(link.token, origin);
        res.setPasswordExpiresAt = link.expiresAt;
      } else if (importCreated && row.disabled) notes.push('Disabled: no set-password link');

      const haul = await collectUser(c, u, matcher, w);
      db.tx(() => {
        for (const x of haul.watched) if (x.m) applyWatched(userId, x.m.id, x.item.UserData);
        for (const x of haul.resume) if (x.m && applyResume(userId, x.m.id, x.item.UserData)) res.resume++;
        for (const x of haul.favorites) if (x.m) applyFavorite(userId, x.m.id);
      });
      res.watched = haul.watched.filter((x) => x.m).length;
      res.favorites = haul.favorites.filter((x) => x.m).length;
      for (const pl of haul.playlists) {
        upsertContainer('playlist', pl.emby, userId, pl.items);
        res.playlists++;
      }
      res.unmatched = [...haul.watched, ...haul.resume, ...haul.favorites, ...haul.playlists.flatMap((p) => p.items)].filter((x) => !x.m).length;
      res.message = notes.join(' · ') || null;
    } catch (e) {
      res.status = 'error';
      res.message = (e as Error).message;
      log.warn(`Emby import of ${u.Name} failed: ${res.message}`);
    }
  }

  if (o.importCollections) {
    job.phase = 'Importing collections';
    job.progress = 92;
    emit(true);
    for (const col of await collectCollections(c, users, matcher)) {
      const r = upsertContainer('collection', col.emby, null, col.items);
      if (r.created) job.collections.created++;
      else job.collections.updated++;
      job.collections.items += uniqIds(col.items).length;
    }
  }

  const n = (s: EmbyImportUserResult['status']) => job.results.filter((r) => r.status === s).length;
  logActivity('emby.import', `Emby import finished: ${n('created')} created, ${n('updated') + n('merged')} updated, ${n('skipped')} skipped, ${n('error')} failed`, {
    userId: admin.id, userName: admin.displayName, severity: n('error') ? 'warning' : 'info',
  });
  return job;
}
