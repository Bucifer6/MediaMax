import type {
  ArtworkTarget, BuiltinProviderId, EpisodeOrder, ItemRatings, ItemType, MatchCandidate, MatchSearchResponse, MetadataProviderConfig,
  MetadataProviderId, MetadataProviderInfo, MetadataSettingsResponse, MetadataTestResult, Person,
} from '@mediamax/shared';
import { db, type Row } from '../../db.js';
import { nowIso, parseJson, sortTitle } from '../../util/misc.js';
import { badRequest, notFound } from '../../util/errors.js';
import { logger } from '../../util/log.js';
import { registerRemoteImage } from '../images.js';
import { SECRET_MASK } from '../settings.js';
import { getMetadataSettings, providerConfig, publicMetadataSettings } from './config.js';
import { cacheStats } from './http.js';
import * as tmdb from './tmdb.js';
import type { BuiltinProvider, ProviderItem, ProviderResult } from './providers/types.js';
import { tvdb } from './providers/tvdb.js';
import { fanart } from './providers/fanart.js';
import { audiodb } from './providers/audiodb.js';
import { audnexus } from './providers/audnexus.js';
import { googlebooks, openlibrary } from './providers/books.js';
import { lrclib } from './providers/lrclib.js';
import { omdb } from './providers/omdb.js';
import { musicbrainz } from './providers/musicbrainz.js';

const log = logger('metadata');

export const PROVIDERS: BuiltinProvider[] = [tvdb, fanart, audiodb, audnexus, openlibrary, googlebooks, lrclib, omdb, musicbrainz];
export const providerById = (id: string): BuiltinProvider | undefined => PROVIDERS.find((p) => p.id === id);

export const isReady = (p: BuiltinProvider, cfg: MetadataProviderConfig = providerConfig(p.id)) => cfg.enabled && (p.key !== 'required' || !!cfg.apiKey);
export const providerReady = (id: BuiltinProviderId) => {
  const p = providerById(id);
  return !!p && isReady(p);
};

/** Built-in providers that run for an item type, in the admin's priority order. */
export function providersFor(type: ItemType): BuiltinProvider[] {
  const s = getMetadataSettings();
  return s.order.map((id) => providerById(id)).filter((p): p is BuiltinProvider => !!p && p.types.includes(type) && isReady(p, s.providers[p.id]));
}

/* ------------------------------- applying ------------------------------- */

const ART_TARGET: Partial<Record<ItemType, ArtworkTarget>> = { movie: 'movie', show: 'show', season: 'show', artist: 'artist', album: 'album', audiobook: 'audiobook' };
const COLUMN_ART = new Set(['poster', 'backdrop', 'logo', 'thumb']);

export function isLocalImage(imgId: string | null | undefined): boolean {
  if (!imgId) return false;
  const r = db.get<{ source: string }>('SELECT source FROM images WHERE id = ?', imgId);
  return !!r && !/^https?:\/\//i.test(r.source);
}

/** Should `provider`'s artwork replace the item's current (non-empty) artwork? Never for local or locked art. */
export function prefersArtFrom(type: ItemType, provider: MetadataProviderId): boolean {
  const t = ART_TARGET[type];
  return !!t && getMetadataSettings().artwork[t] === provider;
}

const placeholderGenres = (type: string, v: unknown) => type === 'audiobook' && (v === '["Audiobook"]' || v === '[]');
const isEmpty = (row: Row, col: string) => {
  const v = row[col];
  return v === null || v === undefined || v === '' || v === '[]' || placeholderGenres(row.type, v);
};

/** The item as providers see it. */
export function providerItem(row: Row, replace = false): ProviderItem {
  const extra = parseJson<Record<string, any>>(row.extra, {});
  let parentTitle: string | null = null;
  if (row.type === 'album' && row.parent_id) parentTitle = db.get<{ title: string }>('SELECT title FROM items WHERE id = ?', row.parent_id)?.title ?? null;
  if (row.type === 'audiobook') {
    const author = parseJson<Person[]>(row.people, []).find((p) => /^author$/i.test(p.role ?? ''))?.name;
    parentTitle = extra.author ?? (author && author !== 'Unknown author' ? author : null);
    if (parentTitle === 'Unknown author') parentTitle = null;
  }
  const order = extra.episodeOrder;
  return {
    row, id: row.id, type: row.type, title: row.title, year: row.year ?? null, ids: parseJson<Record<string, string>>(row.external_ids, {}),
    parentTitle, episodeOrder: order === 'dvd' || order === 'absolute' ? order : 'aired', replace,
  };
}

interface ApplyState {
  replace: boolean;
  /** Fields/art kinds already set during this refresh (by TMDB or a higher-priority provider). */
  touched: Set<string>;
  changed: number;
}

function applyResult(row: Row, p: BuiltinProvider, res: ProviderResult, st: ApplyState) {
  const locked = new Set(parseJson<string[]>(row.locked_fields, []));
  const patch: Row = {};
  const can = (field: string, col: string) => !locked.has(field) && (isEmpty(row, col) || (st.replace && !st.touched.has(field)));
  const set = (field: string, col: string, v: unknown) => {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return;
    if (!can(field, col)) return;
    const val = Array.isArray(v) ? JSON.stringify(v) : v;
    if (row[col] !== val) patch[col] = val;
    st.touched.add(field);
  };
  const f = res.fields ?? {};
  if (st.replace && f.title && !locked.has('title') && !st.touched.has('title')) {
    patch.title = f.title;
    if (!locked.has('sortTitle')) patch.sort_title = sortTitle(f.title);
    st.touched.add('title');
  }
  set('overview', 'overview', f.overview);
  set('tagline', 'tagline', f.tagline);
  set('genres', 'genres', f.genres);
  set('year', 'year', f.year);
  set('releaseDate', 'release_date', f.releaseDate);
  set('communityRating', 'community_rating', f.communityRating);
  set('contentRating', 'content_rating', f.contentRating);
  set('studios', 'studios', f.studios);
  if (f.people?.length && !locked.has('people')) {
    const cur = parseJson<Person[]>(row.people, []);
    const realCur = cur.filter((x) => x.name !== 'Unknown author');
    if (st.replace && !st.touched.has('people')) patch.people = JSON.stringify(f.people);
    else if (!realCur.length) patch.people = JSON.stringify(f.people);
    else if (row.type === 'audiobook') {
      // Add narrators (or authors) the scan didn't know about; keep what's there.
      const add = f.people.filter((n) => !realCur.some((c) => c.name.toLowerCase() === n.name.toLowerCase()) && !realCur.some((c) => (c.role ?? '').toLowerCase() === (n.role ?? '').toLowerCase()));
      if (add.length) patch.people = JSON.stringify([...realCur, ...add]);
    }
    if (patch.people) st.touched.add('people');
  }
  // IDs: existing ones win unless this is a fix-match refresh.
  if (res.ids && Object.keys(res.ids).length) {
    const cur = parseJson<Record<string, string>>(row.external_ids, {});
    const next = st.replace ? { ...cur, ...res.ids } : { ...res.ids, ...cur };
    const s = JSON.stringify(next);
    if (s !== JSON.stringify(cur)) patch.external_ids = s;
  }
  if (res.ratings && Object.keys(res.ratings).length && !locked.has('ratings')) {
    const cur = parseJson<ItemRatings>(row.ratings, {});
    const s = JSON.stringify({ ...cur, ...res.ratings });
    if (s !== row.ratings) patch.ratings = s;
  }
  const meta = parseJson<Record<string, any>>(row.provider_meta, {});
  let metaChanged = false;
  if (res.meta?.chapters?.length && (!meta.chapters?.length || st.replace)) {
    meta.chapters = res.meta.chapters;
    metaChanged = true;
  }
  if (res.meta?.series && !locked.has('series') && (!meta.series || st.replace)) {
    meta.series = res.meta.series;
    metaChanged = true;
  }
  if (res.meta?.isbn && !meta.isbn) {
    meta.isbn = res.meta.isbn;
    metaChanged = true;
  }
  if (res.meta?.artistInfo) {
    const cur = meta.artistInfo ?? {};
    for (const [k, v] of Object.entries(res.meta.artistInfo)) {
      if (v !== null && v !== undefined && v !== '' && (cur[k] == null || st.replace)) {
        cur[k] = v;
        metaChanged = true;
      }
    }
    meta.artistInfo = cur;
  }
  // Artwork: fill gaps; replace remote art only for the admin's preferred source (or after Fix match). Local art always stays.
  const doneKinds = new Set<string>();
  for (const a of res.art ?? []) {
    if (a.season !== undefined || doneKinds.has(a.kind) || locked.has(a.kind)) continue;
    const cur: string | null = COLUMN_ART.has(a.kind) ? row[a.kind] : meta.art?.[a.kind] ?? null;
    const replaceable = !!cur && !isLocalImage(cur) && ((st.replace && !st.touched.has(a.kind)) || prefersArtFrom(row.type, p.id));
    if (cur && !replaceable) continue;
    const img = registerRemoteImage(a.url, { untrusted: true });
    if (!img || img === cur) continue;
    doneKinds.add(a.kind);
    st.touched.add(a.kind);
    if (COLUMN_ART.has(a.kind)) patch[a.kind] = img;
    else {
      meta.art = { ...(meta.art ?? {}), [a.kind]: img };
      metaChanged = true;
    }
  }
  if (metaChanged) patch.provider_meta = JSON.stringify(meta);
  if (Object.keys(patch).length) {
    patch.updated_at = nowIso();
    db.update('items', row.id, patch);
    Object.assign(row, patch);
    st.changed++;
  }
  // Season posters (shows).
  if (row.type === 'show') {
    for (const a of (res.art ?? []).filter((x) => x.season !== undefined)) {
      const season = db.get('SELECT id, poster, locked_fields FROM items WHERE parent_id = ? AND type = ? AND idx = ?', row.id, 'season', a.season!);
      if (!season || parseJson<string[]>(season.locked_fields, []).includes('poster')) continue;
      if (season.poster && (isLocalImage(season.poster) || !(prefersArtFrom('show', p.id) || st.replace))) continue;
      const img = registerRemoteImage(a.url, { untrusted: true });
      if (img && img !== season.poster) db.update('items', season.id, { poster: img, updated_at: nowIso() });
    }
  }
  if (row.type === 'show' && res.episodes?.length) applyEpisodes(row, res, st);
}

function applyEpisodes(show: Row, res: ProviderResult, st: ApplyState) {
  const order = providerItem(show).episodeOrder;
  const list = res.episodes!;
  const auth = !!res.episodesAuthoritative;
  const eps = db.all("SELECT * FROM items WHERE grandparent_id = ? AND type = 'episode'", show.id);
  for (const ep of eps) {
    if (ep.idx == null) continue;
    const season = ep.parent_idx ?? 1;
    const re = order === 'absolute'
      ? list.find((e) => e.season === season && e.episode === ep.idx && season !== 1) ?? list.find((e) => (e.absolute ?? (e.season === 1 ? e.episode : null)) === ep.idx)
      : list.find((e) => e.season === season && e.episode === ep.idx);
    if (!re) continue;
    const locked = new Set(parseJson<string[]>(ep.locked_fields, []));
    const p: Row = {};
    const placeholder = /^episode \d+$/i.test(ep.title ?? '');
    if (re.title && !locked.has('title') && (auth || placeholder) && re.title !== ep.title) {
      p.title = re.title;
      p.sort_title = sortTitle(re.title);
    }
    if (re.overview && !locked.has('overview') && (auth || !ep.overview) && re.overview !== ep.overview) p.overview = re.overview;
    if (re.airDate && !locked.has('releaseDate') && (auth || !ep.release_date) && re.airDate !== ep.release_date) {
      p.release_date = re.airDate;
      if (!locked.has('year')) p.year = Number(re.airDate.slice(0, 4));
    }
    if (re.image && !locked.has('thumb') && (!ep.thumb || (auth && !isLocalImage(ep.thumb)))) {
      const img = registerRemoteImage(re.image, { untrusted: true });
      if (img && img !== ep.thumb) p.thumb = img;
    }
    if (Object.keys(p).length) {
      p.updated_at = nowIso();
      st.changed++;
    }
    if (!ep.metadata_fetched_at) p.metadata_fetched_at = nowIso();
    if (Object.keys(p).length) db.update('items', ep.id, p);
  }
}

/**
 * Run the enabled built-in providers for one item (movie, show, artist, album, audiobook), in priority order.
 * Fill-only by default; `replace` (Fix match) lets the first provider that has a value overwrite unlocked fields.
 * `touched` lists fields TMDB already set in this refresh (so replace mode doesn't undo them).
 */
export async function applyBuiltinProviders(itemId: string, opts: { replace?: boolean; touched?: Iterable<string>; only?: BuiltinProviderId[] } = {}): Promise<number> {
  const row = db.get('SELECT * FROM items WHERE id = ?', itemId);
  if (!row) return 0;
  const list = providersFor(row.type).filter((p) => !opts.only || opts.only.includes(p.id));
  const st: ApplyState = { replace: !!opts.replace, touched: new Set(opts.touched ?? []), changed: 0 };
  for (const p of list) {
    try {
      const item = providerItem(row, st.replace);
      const res = await p.fetch(item, providerConfig(p.id));
      if (!res) continue;
      if (p.id === 'tvdb') res.episodesAuthoritative = item.episodeOrder !== 'aired' || !tmdb.tmdbEnabled();
      applyResult(row, p, res, st);
    } catch (e) {
      log.warn(`${p.name} failed for "${row.title}": ${(e as Error).message}`);
    }
  }
  const done: Row = { providers_fetched_at: nowIso() };
  // Protect provider-filled music/audiobook fields from being overwritten by the next scan (movies/shows use TMDB's marker).
  if (st.changed && !row.metadata_fetched_at && !['movie', 'show'].includes(row.type)) done.metadata_fetched_at = nowIso();
  db.update('items', itemId, done);
  return st.changed;
}

/* ------------------------------ admin info ------------------------------ */

const TMDB_INFO: Omit<MetadataProviderInfo, 'enabled' | 'ready' | 'missing' | 'missingLabel'> = {
  id: 'tmdb', name: 'TMDB', types: ['movie', 'show', 'season', 'episode'], key: 'required',
  homepage: 'https://www.themoviedb.org', keyUrl: 'https://www.themoviedb.org/settings/api',
  cost: 'Free for non-commercial use (API key or read access token).',
  description: 'Primary source for movies and shows: titles, plots, cast, posters, backdrops, logos, trailers, collections. The key is set on the General tab; TMDB always runs first.',
  rateLimit: '~35 requests/second (client-side).', artwork: ['movie', 'show'],
};

function countMissing(where: string): number | null {
  try {
    return db.get<{ n: number }>(`SELECT COUNT(*) n FROM items i JOIN libraries l ON l.id = i.library_id WHERE l.fetch_metadata = 1 AND ${where}`)!.n;
  } catch {
    return null;
  }
}

export function metadataAdminState(): MetadataSettingsResponse {
  const s = getMetadataSettings();
  const providers: MetadataProviderInfo[] = [
    {
      ...TMDB_INFO, enabled: tmdb.tmdbEnabled(), ready: tmdb.tmdbEnabled(),
      missing: countMissing("i.type IN ('movie','show') AND json_extract(i.external_ids, '$.tmdb') IS NULL"), missingLabel: 'movies and shows without a TMDB match',
    },
    ...PROVIDERS.map((p) => {
      const { fetch: _f, test: _t, search: _s, matchIdKey: _m, missing, ...info } = p;
      return { ...info, enabled: s.providers[p.id].enabled, ready: isReady(p, s.providers[p.id]), missing: missing ? countMissing(missing.where) : null, missingLabel: missing?.label ?? null };
    }),
  ];
  // List in priority order.
  providers.sort((a, b) => s.order.indexOf(a.id) - s.order.indexOf(b.id));
  return { settings: publicMetadataSettings(s), providers, cache: cacheStats() };
}

/** "Test" button: a live request with the stored config, or with an unsaved key/PIN from the form. */
export async function testProvider(id: MetadataProviderId, override: { apiKey?: string | null; pin?: string | null } = {}): Promise<MetadataTestResult> {
  const started = Date.now();
  try {
    let message: string;
    if (id === 'tmdb') {
      if (!tmdb.tmdbEnabled()) throw new Error('No TMDB API key (General tab)');
      const r = await tmdb.discover('The Matrix', 'movie', 1);
      if (!r.results.length) throw new Error('TMDB returned no results — check the API key');
      message = `TMDB works (${r.results[0].title})`;
    } else {
      const p = providerById(id);
      if (!p) throw badRequest('Unknown provider');
      const stored = providerConfig(p.id);
      const pick = (v: string | null | undefined, cur: string | null | undefined) => (v === undefined || v === SECRET_MASK ? cur ?? null : v?.trim() || null);
      const cfg: MetadataProviderConfig = { ...stored, enabled: true, apiKey: pick(override.apiKey, stored.apiKey), pin: pick(override.pin, stored.pin) };
      if (p.key === 'required' && !cfg.apiKey) throw new Error(`${p.name} needs an API key`);
      message = await p.test(cfg);
    }
    return { ok: true, message, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, message: (e as Error).message, ms: Date.now() - started };
  }
}

/* -------------------------------- fix match ------------------------------ */

function matchProviders(type: ItemType): MetadataProviderId[] {
  const out: MetadataProviderId[] = [];
  if ((type === 'movie' || type === 'show') && tmdb.tmdbEnabled()) out.push('tmdb');
  if (type === 'show' && providerReady('tvdb')) out.push('tvdb');
  if ((type === 'artist' || type === 'album') && providerReady('musicbrainz')) out.push('musicbrainz');
  if (type === 'audiobook') for (const id of ['audnexus', 'googlebooks', 'openlibrary'] as const) if (providerReady(id)) out.push(id);
  return out;
}

export async function searchMatch(itemId: string, q: { provider?: string; query?: string; year?: number | null }): Promise<MatchSearchResponse> {
  const row = db.get('SELECT * FROM items WHERE id = ?', itemId);
  if (!row) throw notFound('Item not found');
  if (row.type === 'season' || row.type === 'episode') throw badRequest("Fix the show's match instead");
  const providers = matchProviders(row.type);
  if (!providers.length) throw badRequest(`No metadata provider that can search ${row.type}s is enabled`);
  const provider = (q.provider && providers.includes(q.provider as MetadataProviderId) ? q.provider : providers[0]) as MetadataProviderId;
  const item = providerItem(row);
  const query = (q.query ?? '').trim() || (provider === 'audnexus' ? item.ids.asin ?? row.title : row.title);
  const year = q.year === undefined ? row.year ?? null : q.year;
  let results: MatchCandidate[] = [];
  if (provider === 'tmdb') {
    const r = await tmdb.discover(query, row.type === 'movie' ? 'movie' : 'show', 1);
    results = r.results.map((x) => ({ provider: 'tmdb', id: x.id, title: x.title, year: x.year, subtitle: x.rating ? `★ ${x.rating}` : null, overview: x.overview, imageUrl: x.poster }));
    if (year) results.sort((a, b) => Number(b.year === year) - Number(a.year === year));
  } else {
    const p = providerById(provider)!;
    results = (await p.search?.(row.type, query, year, providerConfig(p.id), item.parentTitle)) ?? [];
  }
  return { providers, provider, results: results.slice(0, 20) };
}

const ID_RE = /^[\w-]{1,80}$/;
/** External ids that belong to the old match and must go when the admin picks another one. */
const MATCH_IDS: Record<string, string[]> = {
  movie: ['tmdb', 'imdb', 'tvdb'],
  show: ['tmdb', 'imdb', 'tvdb'],
  artist: ['musicbrainzArtist', 'audiodbArtist'],
  album: ['musicbrainzReleaseGroup', 'audiodbAlbum'],
  audiobook: ['asin', 'isbn', 'googleBooks', 'openLibrary'],
};

/** Point an item at a specific provider id, clear what came from the old match, and refresh in replace mode. */
export async function applyMatch(itemId: string, provider: MetadataProviderId, id: string, refresh: (itemId: string, opts: { replace: boolean }) => Promise<void>) {
  const row = db.get('SELECT * FROM items WHERE id = ?', itemId);
  if (!row) throw notFound('Item not found');
  if (!matchProviders(row.type).includes(provider)) throw badRequest('That provider cannot match this item');
  if (!ID_RE.test(String(id ?? ''))) throw badRequest('Invalid id');
  const ids = parseJson<Record<string, string>>(row.external_ids, {});
  for (const k of MATCH_IDS[row.type] ?? []) delete ids[k];
  if (provider === 'tmdb') {
    ids.tmdb = id;
    if (row.type === 'show') {
      const x = await tmdb.tvExternalIds(id);
      if (x.tvdb) ids.tvdb = x.tvdb;
      if (x.imdb) ids.imdb = x.imdb;
    }
  } else if (provider === 'tvdb') {
    ids.tvdb = id;
    if (tmdb.tmdbEnabled()) {
      const t = await tmdb.findByTvdb(id);
      if (t) ids.tmdb = t;
    }
  } else {
    const key = providerById(provider)?.matchIdKey?.(row.type);
    if (!key) throw badRequest('That provider cannot match this item');
    ids[key] = id;
  }
  const locked = new Set(parseJson<string[]>(row.locked_fields, []));
  const patch: Row = { external_ids: JSON.stringify(ids), metadata_fetched_at: null, providers_fetched_at: null, updated_at: nowIso() };
  // Remote art from the wrong match goes (local and locked art stays); the refresh fills it again.
  for (const k of ['poster', 'backdrop', 'logo', 'thumb']) if (row[k] && !locked.has(k) && !isLocalImage(row[k])) patch[k] = null;
  if (!locked.has('ratings')) patch.ratings = null;
  const meta = parseJson<Record<string, unknown>>(row.provider_meta, {});
  patch.provider_meta = JSON.stringify({ ...(meta.series && locked.has('series') ? { series: meta.series } : {}) });
  db.update('items', itemId, patch);
  await refresh(itemId, { replace: true });
}

/** Episode order of a show (stored in its extra JSON). */
export function episodeOrderOf(row: Row): EpisodeOrder {
  return providerItem(row).episodeOrder;
}
