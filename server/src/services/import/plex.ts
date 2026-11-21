import { XMLParser } from 'fast-xml-parser';
import type { ImportLibraryMapping, ImportTestResult } from '@mediamax/shared';
import { safeFetch } from '../../util/net.js';
import { logger } from '../../util/log.js';
import {
  type Conn, type Driver, type Entry, type Haul, type HistoryEntry, type MappedUser, type Match, type Matcher, type Progress, type QuickCounts,
  type Query, type Session, type SourceUser, type SrcFolder, type SrcItem, type SrcList, type SrcSeries, type Want,
  allPages, emptyHaul, isoOrNull, libraryAccess, pool, qs, safeUsername, unreachable, UpstreamError,
} from './common.js';

/**
 * Plex Media Server, read with the owner's `X-Plex-Token`.
 *
 * - The server (usually on the LAN; plain `fetch`, like the Emby importer) gives libraries (`/library/sections`), the
 *   catalogue with GUIDs (`/library/sections/{id}/all?type=1|2|4&includeGuids=1`), collections, playlists and the
 *   play history (`/status/sessions/history/all`). Requests ask for JSON and are paged with
 *   `X-Plex-Container-Start/Size` (size 0 = count only).
 * - plex.tv (the public internet; SSRF-guarded `safeFetch`) gives the owner (`/api/v2/user`), the users the server is
 *   shared with (`/api/users`, XML) and, per shared user, a server access token (`/api/servers/{machineId}/shared_servers`,
 *   XML). With that token each user's own watched flags, resume points and playlists are read from the server. Managed
 *   Home users without a token fall back to the server's play history (watched only).
 *
 * The catalogue is read once and every title matched once (by `ratingKey`); per-user lists are then plain lookups.
 * Tokens are only ever sent in headers and never logged or returned.
 */

const log = logger('server-import');
const PAGE = 1000;
/** plex.tv's address; tests point it at a stub. */
export const plexTvBase = () => (process.env.MEDIAMAX_PLEX_TV_URL || 'https://plex.tv').replace(/\/+$/, '');
const CLIENT = { 'X-Plex-Product': 'Kinora', 'X-Plex-Client-Identifier': 'mediamax-importer', 'X-Plex-Version': '1' };
const OWNER_ACCOUNT = 1; // The owner's accountID in the server's own history.

/* ------------------------------ DTOs ------------------------------ */

interface PlexMd {
  ratingKey?: string; key?: string; type?: string; title?: string; year?: number; guid?: string; Guid?: { id: string }[];
  Media?: { Part?: { file?: string }[] }[]; Location?: { path?: string }[];
  grandparentRatingKey?: string; grandparentTitle?: string; grandparentGuid?: string; parentIndex?: number; index?: number;
  viewCount?: number; viewOffset?: number; lastViewedAt?: number; viewedAt?: number; accountID?: number; smart?: boolean | string | number;
}
interface PlexSection { key: string; title: string; type: string; Location?: { path?: string }[] }
interface PlexContainer { MediaContainer?: { size?: number; totalSize?: number; Metadata?: PlexMd[]; Directory?: PlexSection[]; machineIdentifier?: string; friendlyName?: string; version?: string } }

/** A plex.tv user, plus what the server's shared-server list says about them. */
export interface PlexRawUser {
  plexId: string; title: string; owner: boolean; home: boolean; restricted: boolean; token: string | null;
  /** Section keys shared with the user; null = all libraries. */
  sections: string[] | null; allowSync: boolean; allowTuners: number; filters: string[]; sectionsKnown: boolean;
}

/* ------------------------------ clients ------------------------------ */

async function pms<T>(url: string, token: string, path: string, query: Query = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${url}${path}${qs(query)}`, { headers: { ...CLIENT, 'X-Plex-Token': token, Accept: 'application/json' }, signal: AbortSignal.timeout(120000) });
  } catch (e) {
    throw unreachable(e, 'Plex', 'plex_unreachable');
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new UpstreamError('Plex rejected the token', 'plex_unauthorized', res.status);
  if (!res.ok) throw new UpstreamError(`Plex answered HTTP ${res.status} for ${path}`, 'plex_error', res.status);
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new UpstreamError('That address did not answer like a Plex Media Server (check the URL, usually http://<server>:32400)', 'plex_error', res.status);
  }
}

const mcItems = (r: PlexContainer) => r?.MediaContainer?.Metadata ?? [];

function pmsAll(url: string, token: string, path: string, query: Query = {}): Promise<PlexMd[]> {
  return allPages(async (start, size) => {
    const r = await pms<PlexContainer>(url, token, path, { ...query, 'X-Plex-Container-Start': start, 'X-Plex-Container-Size': size });
    const mc = r?.MediaContainer;
    return { items: mcItems(r), total: typeof mc?.totalSize === 'number' ? mc.totalSize : null };
  }, PAGE);
}

async function pmsCount(url: string, token: string, path: string, query: Query = {}): Promise<number> {
  const mc = (await pms<PlexContainer>(url, token, path, { ...query, 'X-Plex-Container-Start': 0, 'X-Plex-Container-Size': 0 }))?.MediaContainer;
  return Number(mc?.totalSize ?? mc?.size ?? 0);
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', isArray: (n) => n === 'User' || n === 'Server' || n === 'Section' || n === 'SharedServer' });

async function plexTv(path: string, token: string, format: 'xml' | 'json'): Promise<any> {
  let res: Response;
  try {
    res = await safeFetch(`${plexTvBase()}${path}`, { headers: { ...CLIENT, 'X-Plex-Token': token, Accept: format === 'json' ? 'application/json' : 'application/xml' }, signal: AbortSignal.timeout(60000) });
  } catch (e) {
    throw unreachable(e, 'plex.tv', 'plex_tv_unreachable');
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new UpstreamError('plex.tv rejected the token (use the server owner\'s token)', 'plex_tv_unauthorized', res.status);
  if (!res.ok) throw new UpstreamError(`plex.tv answered HTTP ${res.status} for ${path.replace(/\/servers\/[^/]+\//, '/servers/…/')}`, 'plex_tv_error', res.status);
  try {
    return format === 'json' ? JSON.parse(text) : xml.parse(text);
  } catch {
    throw new UpstreamError('plex.tv sent an answer Kinora could not read', 'plex_tv_error', res.status);
  }
}

/* ---------------------------- mapping ---------------------------- */

/** `imdb://tt…`, `tmdb://…`, `tvdb://…` (new agents) or a legacy agent guid (movies and shows only) → provider ids. */
export function plexIds(md: PlexMd): Record<string, string> {
  const out: Record<string, string> = {};
  for (const g of md.Guid ?? []) {
    const m = /^(imdb|tmdb|tvdb):\/\/([^?/]+)/i.exec(String(g?.id ?? ''));
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  // com.plexapp.agents.imdb://tt0133093?lang=en, …themoviedb://603, …thetvdb://81189 (episode guids carry the show's id: skipped).
  const lg = /^com\.plexapp\.agents\.(imdb|themoviedb|thetvdb)(?:-\w+)?:\/\/([^?/]+)/i.exec(String(md.guid ?? ''));
  if (lg && md.type !== 'episode') {
    const k = { imdb: 'imdb', themoviedb: 'tmdb', thetvdb: 'tvdb' }[lg[1].toLowerCase()]!;
    out[k] ??= lg[2];
  }
  return out;
}

const KIND: Record<string, SrcItem['kind']> = { movie: 'movie', show: 'show', episode: 'episode' };
const TYPE_LABEL: Record<string, string> = { movie: 'Movie', show: 'Show', episode: 'Episode' };
const plexSrc = (md: PlexMd): SrcItem => ({
  id: String(md.ratingKey ?? md.key ?? ''), kind: KIND[md.type ?? ''] ?? 'other', typeLabel: TYPE_LABEL[md.type ?? ''] ?? 'Item', title: md.title,
  year: md.year, providerIds: plexIds(md), path: md.Media?.[0]?.Part?.[0]?.file ?? md.Location?.[0]?.path,
  seriesId: md.grandparentRatingKey, seriesTitle: md.grandparentTitle, season: md.parentIndex, episode: md.index,
});
const secs = (n: number | undefined) => (n && n > 0 ? isoOrNull(n * 1000) : null);

const RATINGS = ['G', 'PG', 'PG-13', 'R', 'NC-17'];
const RATING_OF: Record<string, string> = {
  g: 'G', 'tv-y': 'G', 'tv-g': 'G', 'tv-y7': 'G', 'tv-y7-fv': 'G', pg: 'PG', 'tv-pg': 'PG', 'pg-13': 'PG-13', 'tv-14': 'PG-13', r: 'R', 'tv-ma': 'R', 'nc-17': 'NC-17',
};

/**
 * A Kinora rating limit from Plex sharing filters (`filterMovies="contentRating=G%2CPG"`): the highest allowed
 * rating of each filter, the strictest across filters. `deny` when a filter excludes ratings instead (not mappable).
 */
export function plexFilterRating(filters: string[]): { rating: string | null; deny: boolean } {
  let best: number | null = null;
  let deny = false;
  for (const f of filters) {
    let s = String(f ?? '');
    try {
      s = decodeURIComponent(s);
    } catch {
      /* keep as is */
    }
    for (const m of s.matchAll(/contentRating(!?)=([^|&]*)/g)) {
      if (m[1]) {
        deny = true;
        continue;
      }
      const ranks = m[2].split(',').map((v) => RATINGS.indexOf(RATING_OF[v.trim().toLowerCase()] ?? '')).filter((r) => r >= 0);
      if (!ranks.length) continue;
      const top = Math.max(...ranks);
      best = best == null ? top : Math.min(best, top);
    }
  }
  return { rating: best == null ? null : RATINGS[best], deny };
}

export function mapPlexUser(name: string, u: PlexRawUser, folders: SrcFolder[], libs: ImportLibraryMapping[]): MappedUser {
  const notes: string[] = [];
  if (u.owner) {
    return {
      username: safeUsername(name, u.plexId), displayName: (u.title || name).slice(0, 100) || undefined, isAdmin: true, libraryIds: null, maxContentRating: null,
      allowLiveTv: true, allowDvr: true, allowDownloads: true, allowTranscode: true, allowRemote: true, maxStreams: null,
      disabled: false, hiddenFromLogin: false, unmappedFolders: [], notes,
    };
  }
  const { libraryIds, unmappedFolders } = libraryAccess(u.sections, folders, libs);
  if (!u.sectionsKnown) notes.push('Library sharing unknown: no libraries given (choose them under Users after the import)');
  const f = plexFilterRating(u.filters);
  let rating = f.rating;
  if (f.deny) notes.push('A Plex "exclude rating" filter could not be copied');
  if (u.restricted && !rating) {
    rating = 'PG';
    notes.push('Restricted in Plex: limited to PG (adjust if needed)');
  }
  if (!u.token) notes.push(u.home ? 'Managed user without a shared-server token: watched status from Plex play history only (no resume points or playlists)' : 'No shared-server token: watched status from Plex play history only');
  return {
    username: safeUsername(name, u.plexId), displayName: (u.title || name).slice(0, 100) || undefined, isAdmin: false, libraryIds, maxContentRating: rating,
    // Plex has no per-user remote-access or stream limits.
    allowLiveTv: u.allowTuners > 0, allowDvr: u.allowTuners > 1, allowDownloads: u.allowSync, allowTranscode: true, allowRemote: true, maxStreams: null,
    disabled: false,
    // Plex Home members are on the Plex user picker; friends aren't.
    hiddenFromLogin: !u.home,
    unmappedFolders, notes,
  };
}

/* ------------------------------ driver ------------------------------ */

const flag = (v: unknown) => v === '1' || v === 1 || v === true || v === 'true';
const arr = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

interface PlexUserRow { id: string; name: string; raw: PlexRawUser }

/** Owner, then every plex.tv user who can use this server (shared with them, or a Plex Home member). */
async function readUsers(token: string, machineId: string): Promise<PlexUserRow[]> {
  const me = await plexTv('/api/v2/user', token, 'json');
  const ownerName = String(me?.username || me?.title || 'owner');
  const out: PlexUserRow[] = [{
    id: String(me?.id ?? 'owner'), name: ownerName,
    raw: { plexId: String(me?.id ?? 'owner'), title: String(me?.title || ownerName), owner: true, home: true, restricted: false, token, sections: null, allowSync: true, allowTuners: 2, filters: [], sectionsKnown: true },
  }];
  const users = arr<any>((await plexTv('/api/users', token, 'xml'))?.MediaContainer?.User);
  let shared: any[] = [];
  try {
    shared = arr<any>((await plexTv(`/api/servers/${encodeURIComponent(machineId)}/shared_servers`, token, 'xml'))?.MediaContainer?.SharedServer);
  } catch (e) {
    log.warn(`Plex shared servers unavailable: ${(e as Error).message}`);
  }
  const sharedBy = new Map(shared.map((s) => [String(s.userID), s]));
  for (const u of users) {
    const id = String(u.id ?? '');
    if (!id || id === out[0].id) continue;
    const server = arr<any>(u.Server).find((s) => String(s.machineIdentifier) === machineId);
    const ss = sharedBy.get(id);
    const home = flag(u.home);
    if (!server && !ss && !home) continue; // A friend of another of the owner's servers.
    let sections: string[] | null = [];
    let known = true;
    if (ss) sections = flag(ss.allLibraries) ? null : arr<any>(ss.Section).filter((x) => flag(x.shared)).map((x) => String(x.key));
    else if (server && arr<any>(server.Section).length) sections = arr<any>(server.Section).filter((x) => x.shared === undefined || flag(x.shared)).map((x) => String(x.key ?? x.id));
    else if (server && flag(server.allLibraries)) sections = null;
    else known = false; // Unknown: give no libraries rather than too many.
    out.push({
      id, name: String(u.username || u.title || `plex_${id}`),
      raw: {
        plexId: id, title: String(u.title || u.username || ''), owner: false, home, restricted: flag(u.restricted), token: ss?.accessToken ? String(ss.accessToken) : null, sections, sectionsKnown: known,
        allowSync: flag(ss?.allowSync ?? u.allowSync), allowTuners: Number(ss?.allowTuners ?? u.allowTuners ?? 0) || 0,
        filters: [u.filterMovies, u.filterTelevision, u.filterAll].filter((x) => typeof x === 'string' && x),
      },
    });
  }
  return out;
}

async function identity(c: Conn): Promise<{ machineId: string; name: string; version: string }> {
  // /identity needs no token: tells a Plex server apart from anything else.
  const id = (await pms<PlexContainer>(c.url, c.apiKey, '/identity'))?.MediaContainer;
  if (!id?.machineIdentifier) throw new UpstreamError('That address did not answer like a Plex Media Server', 'plex_error', 200);
  // The root needs the token (so it checks it) and has the friendly name.
  const root = (await pms<PlexContainer>(c.url, c.apiKey, '/'))?.MediaContainer;
  return { machineId: id.machineIdentifier, name: root?.friendlyName || 'Plex', version: root?.version || id.version || '' };
}

export const plexDriver: Driver = {
  source: 'plex',

  async test(c: Conn): Promise<ImportTestResult> {
    try {
      const id = await identity(c);
      let users: number | undefined;
      let extra = '';
      try {
        users = (await readUsers(c.apiKey, id.machineId)).length;
      } catch (e) {
        extra = ` (users unavailable: ${(e as Error).message})`;
      }
      return { ok: !extra, message: `Connected to ${id.name} ${id.version}`.trim() + extra, serverName: id.name, version: id.version, users };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  },

  async open(c: Conn, matcher: Matcher | null, want: Want): Promise<Session> {
    const id = await identity(c);
    const sections = (await pms<PlexContainer>(c.url, c.apiKey, '/library/sections'))?.MediaContainer?.Directory ?? [];
    const video = sections.filter((s) => s.type === 'movie' || s.type === 'show');
    const folders: SrcFolder[] = sections.map((s) => ({ id: String(s.key), keys: [String(s.key)], name: s.title, locations: (s.Location ?? []).map((l) => String(l.path ?? '')).filter(Boolean) }));
    const users = await readUsers(c.apiKey, id.machineId);
    const notes = ['Plex has no favourites: none are imported'];

    /* Catalogue: ratingKey → matched title (owner's view: every library). */
    const catalog = new Map<string, { item: SrcItem; m: Match | null }>();
    const shows = new Map<string, SrcSeries>();
    const lookup = (md: PlexMd): { item: SrcItem; m: Match | null } => {
      const hit = catalog.get(String(md.ratingKey ?? ''));
      if (hit) return hit;
      // Not in the catalogue (deleted since, or a library the owner can't list): match what the entry says.
      const item = plexSrc(md);
      return { item, m: matcher ? matcher.match(item, item.seriesId ? shows.get(item.seriesId) ?? null : null) : null };
    };

    /* Play history, all accounts, read once (lazily). */
    let historyAll: Promise<Map<number, PlexMd[]>> | null = null;
    const history = () => (historyAll ??= pmsAll(c.url, c.apiKey, '/status/sessions/history/all', { sort: 'viewedAt:asc' }).then((rows) => {
      const by = new Map<number, PlexMd[]>();
      for (const r of rows) {
        const acc = Number(r.accountID ?? 0);
        if (!by.has(acc)) by.set(acc, []);
        by.get(acc)!.push(r);
      }
      return by;
    }));
    const accountsOf = (u: PlexRawUser) => (u.owner ? [OWNER_ACCOUNT, Number(u.plexId)] : [Number(u.plexId)]);
    const historyOf = async (u: PlexRawUser) => {
      const by = await history();
      return [...new Set(accountsOf(u))].flatMap((a) => by.get(a) ?? []).filter((r) => r.type === 'movie' || r.type === 'episode');
    };
    const sectionsOf = (u: PlexRawUser) => video.filter((s) => u.sections === null || u.sections.includes(String(s.key)));

    return {
      server: { id: id.machineId, name: id.name, version: id.version },
      folders,
      notes,
      users: (libs) => users.map((u) => ({ id: u.id, name: u.name, lastActivity: null, mapped: mapPlexUser(u.name, u.raw, folders, libs), raw: u.raw })),

      async prepare(progress: Progress) {
        if (!matcher) return;
        for (let i = 0; i < video.length; i++) {
          const s = video[i];
          progress(`Reading Plex library ${s.title} (${i + 1} of ${video.length})`, i / Math.max(1, video.length));
          const base = `/library/sections/${encodeURIComponent(s.key)}/all`;
          if (s.type === 'movie') {
            for (const md of await pmsAll(c.url, c.apiKey, base, { type: 1, includeGuids: 1 })) {
              const item = plexSrc(md);
              catalog.set(item.id, { item, m: matcher.match(item) });
            }
          } else {
            for (const md of await pmsAll(c.url, c.apiKey, base, { type: 2, includeGuids: 1 })) {
              const item = plexSrc(md);
              shows.set(item.id, item);
              catalog.set(item.id, { item, m: matcher.match(item) });
            }
            for (const md of await pmsAll(c.url, c.apiKey, base, { type: 4, includeGuids: 1 })) {
              const item = plexSrc(md);
              catalog.set(item.id, { item, m: matcher.match(item, item.seriesId ? shows.get(item.seriesId) ?? null : null) });
            }
          }
        }
      },

      async collectUser(su: SourceUser, w: Want): Promise<Haul> {
        const u = su.raw as PlexRawUser;
        const haul = emptyHaul();
        const entry = (md: PlexMd): Entry => ({
          ...lookup(md), ud: { played: (md.viewCount ?? 0) > 0, playCount: md.viewCount ?? 0, positionMs: md.viewOffset ?? 0, lastPlayed: secs(md.lastViewedAt) },
        });
        if (u.token) {
          const token = u.token;
          for (const s of sectionsOf(u)) {
            const base = `/library/sections/${encodeURIComponent(s.key)}/all`;
            const type = s.type === 'movie' ? 1 : 4;
            try {
              // The filters keep the transfer small; the client-side check keeps it right if a server ignores them.
              if (w.watched) haul.watched.push(...(await pmsAll(c.url, token, base, { type, unwatched: 0 })).filter((md) => (md.viewCount ?? 0) > 0).map(entry));
              if (w.resume) haul.resume.push(...(await pmsAll(c.url, token, base, { type, inProgress: 1 })).filter((md) => (md.viewOffset ?? 0) > 0).map(entry));
            } catch (e) {
              if (!(e instanceof UpstreamError) || e.upstream === 0) throw e;
              haul.notes.push(`Library ${s.title} not readable with this user's token (${e.message})`);
            }
          }
          if (w.playlists) {
            try {
              for (const pl of await pmsAll(c.url, token, '/playlists', { playlistType: 'video' })) {
                const items = await pmsAll(c.url, token, `/playlists/${encodeURIComponent(String(pl.ratingKey))}/items`);
                haul.playlists.push({ id: String(pl.ratingKey), name: pl.title ?? 'Playlist', items: items.map((md) => ({ ...lookup(md) })) });
              }
            } catch (e) {
              if (!(e instanceof UpstreamError) || e.upstream === 0) throw e;
              haul.notes.push(`Playlists not readable (${e.message})`);
            }
          }
        } else if (w.watched) {
          // No token for this user: watched (with the last viewing date) from the server's play history.
          const by = new Map<string, { md: PlexMd; n: number; last: number }>();
          for (const r of await historyOf(u)) {
            const k = String(r.ratingKey ?? '');
            if (!k) continue;
            const cur = by.get(k) ?? { md: r, n: 0, last: 0 };
            cur.n++;
            cur.last = Math.max(cur.last, r.viewedAt ?? 0);
            by.set(k, cur);
          }
          haul.watched = [...by.values()].map((x) => ({ ...lookup(x.md), ud: { played: true, playCount: x.n, lastPlayed: secs(x.last) } }));
        }
        if (w.history) {
          haul.history = (await historyOf(u)).filter((r) => r.viewedAt).map((r): HistoryEntry => ({ ...lookup(r), at: secs(r.viewedAt)!, durationMs: null }));
        }
        return haul;
      },

      async countUser(su: SourceUser, w: Want): Promise<QuickCounts> {
        const u = su.raw as PlexRawUser;
        const out: QuickCounts = { watched: 0, resume: 0, favorites: 0, playlists: 0, history: 0, notes: [] };
        const hist = async () => (await Promise.all([...new Set(accountsOf(u))].filter((a) => a > 0).map((a) => pmsCount(c.url, c.apiKey, '/status/sessions/history/all', { accountID: a })))).reduce((a, b) => a + b, 0);
        if (u.token) {
          const token = u.token;
          await pool(sectionsOf(u), 3, async (s) => {
            const base = `/library/sections/${encodeURIComponent(s.key)}/all`;
            const type = s.type === 'movie' ? 1 : 4;
            try {
              // Await first, then add: `x += await …` would race with the other sections.
              const [nw, nr] = await Promise.all([w.watched ? pmsCount(c.url, token, base, { type, unwatched: 0 }) : 0, w.resume ? pmsCount(c.url, token, base, { type, inProgress: 1 }) : 0]);
              out.watched += nw;
              out.resume += nr;
            } catch (e) {
              if (!(e instanceof UpstreamError) || e.upstream === 0) throw e;
              out.notes.push(`Library ${s.title} not readable with this user's token`);
            }
          });
          if (w.playlists) out.playlists = await pmsCount(c.url, token, '/playlists', { playlistType: 'video' }).catch(() => 0);
        } else if (w.watched) out.watched = await hist();
        if (w.history) out.history = u.token || !w.watched ? await hist() : out.watched;
        return out;
      },

      async collections(): Promise<SrcList[]> {
        const out: SrcList[] = [];
        for (const s of video) {
          for (const col of await pmsAll(c.url, c.apiKey, `/library/sections/${encodeURIComponent(s.key)}/collections`)) {
            const items = await pmsAll(c.url, c.apiKey, `/library/collections/${encodeURIComponent(String(col.ratingKey))}/children`);
            out.push({ id: String(col.ratingKey), name: col.title ?? 'Collection', items: items.map((md) => ({ ...lookup(md) })) });
          }
        }
        return out;
      },

      async countCollections(): Promise<number> {
        let n = 0;
        for (const s of video) n += await pmsCount(c.url, c.apiKey, `/library/sections/${encodeURIComponent(s.key)}/collections`);
        return n;
      },
    };
  },
};
