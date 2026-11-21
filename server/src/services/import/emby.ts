import type { ImportLibraryMapping, ImportTestResult } from '@mediamax/shared';
import { logger } from '../../util/log.js';
import {
  type Conn, type Driver, type Entry, type Haul, type HistoryEntry, type MappedUser, type Matcher, type QuickCounts, type Query, type Session,
  type SourceUser, type SrcFolder, type SrcItem, type SrcList, type SrcSeries, type UserData, type Want,
  allPages, emptyHaul, folderKey, isoOrNull, libraryAccess, qs, ratingForAge, safeUsername, SOURCE_LABEL, unreachable, UpstreamError,
} from './common.js';

/**
 * Emby Server 4.x and Jellyfin 10.x (a fork of Emby's API) over REST with an admin API key.
 *
 * Differences handled here: Jellyfin authenticates with `Authorization: MediaBrowser Token="…"` (the legacy
 * `X-Emby-Token` header is sent too), names its stream limit `MaxActiveSessions` and scores `MaxParentalRating` as an
 * age, rejects Emby-only `Fields` values, spells the playlist query parameter `userId`, and since 10.9 serves user
 * items at `/Items?userId=` (the older `/Users/{id}/Items` is tried first). Both may have the Playback Reporting
 * plugin, whose SQL endpoint is used best-effort for play history.
 *
 * Like the *arr integration this uses plain `fetch` (not the SSRF-guarded `safeFetch`): the URL is set by an admin and
 * these servers almost always live on the LAN.
 */

const log = logger('server-import');
type Flavor = 'emby' | 'jellyfin';

/* ------------------------------ DTOs ------------------------------ */

interface EmbyUserData { Played?: boolean; PlaybackPositionTicks?: number; PlayCount?: number; IsFavorite?: boolean; LastPlayedDate?: string | null }
export interface EmbyItem {
  Id: string; Name?: string; Type?: string; ProductionYear?: number; ProviderIds?: Record<string, string>; Path?: string;
  SeriesId?: string; SeriesName?: string; ParentIndexNumber?: number; IndexNumber?: number; UserData?: EmbyUserData;
}
export interface EmbyPolicy {
  IsAdministrator?: boolean; IsHidden?: boolean; IsDisabled?: boolean; EnableRemoteAccess?: boolean; EnableLiveTvAccess?: boolean;
  EnableLiveTvManagement?: boolean; EnableContentDownloading?: boolean; EnableVideoPlaybackTranscoding?: boolean; EnableAllFolders?: boolean;
  EnabledFolders?: string[]; SimultaneousStreamLimit?: number; MaxParentalRating?: number | null;
  /** Jellyfin */
  MaxActiveSessions?: number; BlockedTags?: string[];
}
export interface EmbyUser { Id: string; Name: string; Policy?: EmbyPolicy; LastActivityDate?: string | null }
export interface EmbyFolder { Name: string; ItemId?: string; Guid?: string; Id?: string; Locations?: string[] }
interface EmbyInfo { Id?: string; ServerName?: string; Version?: string; ProductName?: string }

/* ------------------------------ client ------------------------------ */

const PAGE = 1000;

export class EmbyClient {
  readonly label: string;
  /** Jellyfin 10.9+ dropped `/Users/{id}/Items`; flips to `/Items?userId=` on the first 404. */
  private legacyItems = true;
  constructor(private c: Conn, readonly flavor: Flavor) {
    this.label = SOURCE_LABEL[flavor];
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'X-Emby-Token': this.c.apiKey, Accept: 'application/json' };
    if (this.flavor === 'jellyfin') h.Authorization = `MediaBrowser Client="MediaMax", Device="MediaMax importer", DeviceId="mediamax-import", Version="1", Token="${this.c.apiKey}"`;
    return h;
  }

  async request<T>(method: 'GET' | 'POST', path: string, query: Query = {}, body?: unknown): Promise<T> {
    const code = `${this.flavor}_error`;
    let res: Response;
    try {
      res = await fetch(`${this.c.url}${path}${qs(query)}`, {
        method, headers: body === undefined ? this.headers() : { ...this.headers(), 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000),
      });
    } catch (e) {
      throw unreachable(e, this.label, `${this.flavor}_unreachable`);
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new UpstreamError(`${this.label} rejected the API key`, `${this.flavor}_unauthorized`, res.status);
    if (!res.ok) throw new UpstreamError(`${this.label} answered HTTP ${res.status} for ${path}`, code, res.status);
    try {
      return (text ? JSON.parse(text) : null) as T;
    } catch {
      throw new UpstreamError(`That address did not answer like a${this.flavor === 'emby' ? 'n Emby' : ' Jellyfin'} server (check the URL${this.flavor === 'emby' ? '; some setups need /emby at the end' : ''})`, code, res.status);
    }
  }

  get<T>(path: string, query: Query = {}): Promise<T> {
    return this.request<T>('GET', path, query);
  }

  /** Every page of a list (1000 per request, a few requests in flight). */
  paged(path: string, query: Query): Promise<EmbyItem[]> {
    return allPages(async (start, size) => {
      const r = await this.get<{ Items?: EmbyItem[]; TotalRecordCount?: number }>(path, { ...query, StartIndex: start, Limit: size });
      return { items: r?.Items ?? [], total: typeof r?.TotalRecordCount === 'number' ? r.TotalRecordCount : null };
    }, PAGE);
  }

  /** A user's items (`/Users/{id}/Items`, or `/Items?userId=` on newer Jellyfin). */
  private async userItemsPath<T>(userId: string, fn: (path: string, extra: Query) => Promise<T>): Promise<T> {
    if (this.legacyItems) {
      try {
        return await fn(`/Users/${encodeURIComponent(userId)}/Items`, {});
      } catch (e) {
        if (!(this.flavor === 'jellyfin' && e instanceof UpstreamError && e.upstream === 404)) throw e;
        this.legacyItems = false;
      }
    }
    return fn('/Items', { userId });
  }

  userItems(userId: string, query: Query): Promise<EmbyItem[]> {
    return this.userItemsPath(userId, (path, extra) => this.paged(path, { ...query, ...extra }));
  }

  userItemsByIds(userId: string, ids: string[], fields: string): Promise<EmbyItem[]> {
    return this.userItemsPath(userId, async (path, extra) => (await this.get<{ Items?: EmbyItem[] }>(path, { Ids: ids.join(','), Fields: fields, ...extra }))?.Items ?? []);
  }

  /** Count only (`Limit=0` still returns `TotalRecordCount`). */
  userCount(userId: string, query: Query): Promise<number> {
    return this.userItemsPath(userId, async (path, extra) => Number((await this.get<{ TotalRecordCount?: number }>(path, { ...query, ...extra, Limit: 0, EnableTotalRecordCount: true }))?.TotalRecordCount ?? 0));
  }
}

/* ---------------------------- mapping ---------------------------- */

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

/** Jellyfin 10.9+ scores ratings as ages (PG = 10, PG-13 = 13, R = 17, NC-17 = 18). */
export const jellyfinRating = (v: number | null | undefined) => ratingForAge(v);

export const embyFolder = (f: EmbyFolder): SrcFolder => ({
  id: String(f.ItemId ?? f.Id ?? f.Guid ?? f.Name),
  keys: [f.ItemId, f.Id, f.Guid].filter((k): k is string => !!k),
  name: f.Name,
  locations: f.Locations ?? [],
});

export function mapEmbyUser(flavor: Flavor, u: EmbyUser, folders: SrcFolder[], libs: ImportLibraryMapping[]): MappedUser {
  const p = u.Policy ?? {};
  // Emby lists enabled folders by the library's ItemId (some versions use its Guid); Jellyfin by GUID.
  const { libraryIds, unmappedFolders } = libraryAccess(p.EnableAllFolders === false ? (p.EnabledFolders ?? []).map(String) : null, folders, libs);
  const streams = Number((flavor === 'jellyfin' ? p.MaxActiveSessions : p.SimultaneousStreamLimit) ?? 0);
  const notes: string[] = [];
  if (p.BlockedTags?.length) notes.push(`Blocked tags not imported: ${p.BlockedTags.slice(0, 10).join(', ')}`);
  return {
    username: safeUsername(u.Name, u.Id),
    displayName: String(u.Name ?? '').trim().slice(0, 100) || undefined,
    isAdmin: !!p.IsAdministrator,
    libraryIds,
    maxContentRating: flavor === 'jellyfin' ? jellyfinRating(p.MaxParentalRating) : embyRating(p.MaxParentalRating),
    allowLiveTv: p.EnableLiveTvAccess !== false,
    allowDvr: !!p.EnableLiveTvManagement || !!p.IsAdministrator,
    allowDownloads: p.EnableContentDownloading !== false,
    allowTranscode: p.EnableVideoPlaybackTranscoding !== false,
    allowRemote: p.EnableRemoteAccess !== false,
    // 0 = unlimited on both.
    maxStreams: streams > 0 ? Math.min(100, Math.trunc(streams)) : null,
    disabled: !!p.IsDisabled,
    hiddenFromLogin: !!p.IsHidden,
    unmappedFolders,
    notes,
  };
}

const KIND: Record<string, SrcItem['kind']> = { Movie: 'movie', Series: 'show', Episode: 'episode' };
const toSrc = (i: EmbyItem): SrcItem => ({
  id: i.Id, kind: KIND[i.Type ?? ''] ?? 'other', typeLabel: i.Type ?? 'Item', title: i.Name, year: i.ProductionYear, providerIds: i.ProviderIds, path: i.Path,
  seriesId: i.SeriesId, seriesTitle: i.SeriesName, season: i.ParentIndexNumber, episode: i.IndexNumber,
});
const toUd = (u: EmbyUserData | undefined): UserData => ({
  played: u?.Played, playCount: u?.PlayCount, positionMs: Math.max(0, Math.round((u?.PlaybackPositionTicks ?? 0) / 10000)), lastPlayed: u?.LastPlayedDate ?? null, favorite: u?.IsFavorite,
});

/* ------------------------ Playback Reporting ------------------------ */

interface ReportRow { at: string; itemId: string; durationMs: number | null; client: string | null }
const REPORT_PATH = '/user_usage_stats/submit_custom_query';
/** User ids go into SQL: hex digits only. */
const hexId = (id: string) => String(id).replace(/[^a-fA-F0-9]/g, '').toLowerCase();

/** The plugin stores local times without a zone ("2024-01-02 20:15:33.1234567"). */
const reportDate = (s: string) => isoOrNull(String(s ?? '').trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1'));

async function reportQuery(client: EmbyClient, sql: string): Promise<string[][]> {
  const r = await client.request<{ colums?: string[]; columns?: string[]; results?: string[][] }>('POST', REPORT_PATH, {}, { CustomQueryString: sql, ReplaceUserId: false });
  if (!r || !Array.isArray(r.results)) throw new Error('unexpected answer');
  return r.results;
}

/* ------------------------------ driver ------------------------------ */

export function embyDriver(flavor: Flavor): Driver {
  const fields = flavor === 'emby' ? 'ProviderIds,Path,UserData,ProductionYear' : 'ProviderIds,Path';
  const seriesFields = flavor === 'emby' ? 'ProviderIds,Path,ProductionYear' : 'ProviderIds,Path';

  async function info(client: EmbyClient): Promise<EmbyInfo> {
    const i = await client.get<EmbyInfo>('/System/Info');
    if (!i || typeof i !== 'object' || !('Version' in i)) throw new UpstreamError(`That address did not answer like a${flavor === 'emby' ? 'n Emby' : ' Jellyfin'} server`, `${flavor}_error`, 200);
    return i;
  }

  return {
    source: flavor,

    async test(c: Conn): Promise<ImportTestResult> {
      try {
        const client = new EmbyClient(c, flavor);
        const i = await info(client);
        const users = await client.get<EmbyUser[]>('/Users');
        return { ok: true, message: `Connected to ${i.ServerName ?? client.label} ${i.Version ?? ''}`.trim(), serverName: i.ServerName, version: i.Version, users: Array.isArray(users) ? users.length : 0 };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },

    async open(c: Conn, matcher: Matcher | null, want: Want): Promise<Session> {
      const client = new EmbyClient(c, flavor);
      const i = await info(client);
      const rawFolders = (await client.get<EmbyFolder[]>('/Library/VirtualFolders')) ?? [];
      let rawUsers = (await client.get<EmbyUser[]>('/Users')) ?? [];
      if (!Array.isArray(rawUsers)) rawUsers = [];
      // Older servers leave the policy out of the list; fetch it per user.
      rawUsers = await Promise.all(rawUsers.map(async (u) => (u.Policy ? u : { ...u, ...(await client.get<EmbyUser>(`/Users/${encodeURIComponent(u.Id)}`)) })));
      const folders = (Array.isArray(rawFolders) ? rawFolders : []).map(embyFolder);
      const notes: string[] = [];

      // Playback Reporting plugin: best-effort, skipped cleanly when it isn't installed.
      let reporting = false;
      if (want.history) {
        try {
          await reportQuery(client, 'SELECT COUNT(*) FROM PlaybackActivity');
          reporting = true;
        } catch (e) {
          const missing = e instanceof UpstreamError && (e.upstream === 404 || e.upstream === 405);
          notes.push(missing ? `Playback Reporting plugin not found on ${client.label}: play history skipped` : `Play history skipped (Playback Reporting: ${(e as Error).message})`);
        }
      }

      const series = new Map<string, SrcSeries | null>();
      async function loadSeries(userId: string, items: EmbyItem[]) {
        const missing = [...new Set(items.filter((x) => x.Type === 'Episode' && x.SeriesId && !series.has(x.SeriesId)).map((x) => x.SeriesId!))];
        for (let k = 0; k < missing.length; k += 50) {
          const ids = missing.slice(k, k + 50);
          for (const s of await client.userItemsByIds(userId, ids, seriesFields)) series.set(s.Id, toSrc(s));
          for (const id of ids) if (!series.has(id)) series.set(id, null);
        }
      }
      const match = (x: EmbyItem) => {
        const src = toSrc(x);
        return { item: src, m: matcher ? matcher.match(src, src.seriesId ? series.get(src.seriesId) ?? null : null) : null };
      };
      const entries = (list: EmbyItem[]): Entry[] => list.map((x) => ({ ...match(x), ud: toUd(x.UserData) }));

      async function history(u: SourceUser, known: Map<string, EmbyItem>): Promise<HistoryEntry[]> {
        const uid = hexId(u.id);
        const rows: ReportRow[] = [];
        for (let offset = 0; offset < 200000; offset += 5000) {
          const page = await reportQuery(client, `SELECT DateCreated, ItemId, PlayDuration, ClientName FROM PlaybackActivity WHERE lower(replace(UserId, '-', '')) = '${uid}' ORDER BY DateCreated LIMIT 5000 OFFSET ${offset}`);
          for (const r of page) {
            const at = reportDate(r[0]);
            if (at && r[1]) rows.push({ at, itemId: String(r[1]), durationMs: Number(r[2]) > 0 ? Number(r[2]) * 1000 : null, client: r[3] ? String(r[3]) : null });
          }
          if (page.length < 5000) break;
        }
        const byKey = new Map([...known.values()].map((x) => [folderKey(x.Id), x]));
        const missing = [...new Set(rows.map((r) => folderKey(r.itemId)).filter((id) => !byKey.has(id)))];
        for (let k = 0; k < missing.length; k += 100) {
          for (const x of await client.userItemsByIds(u.id, missing.slice(k, k + 100), fields)) byKey.set(folderKey(x.Id), x);
        }
        await loadSeries(u.id, [...byKey.values()]);
        const out: HistoryEntry[] = [];
        for (const r of rows) {
          const x = byKey.get(folderKey(r.itemId));
          // Deleted on the source: nothing to match it by.
          const mm = x ? match(x) : { item: { id: r.itemId, kind: 'other' as const, title: `Deleted item ${r.itemId}` }, m: null };
          out.push({ ...mm, at: r.at, durationMs: r.durationMs, client: r.client });
        }
        return out;
      }

      return {
        server: { id: i.Id ?? null, name: i.ServerName ?? client.label, version: i.Version ?? '' },
        folders,
        notes,
        users: (libs) => rawUsers.map((u) => ({ id: u.Id, name: u.Name, lastActivity: u.LastActivityDate ?? null, mapped: mapEmbyUser(flavor, u, folders, libs), raw: u })),

        async collectUser(u: SourceUser, w: Want): Promise<Haul> {
          const q = { Recursive: true, Fields: fields };
          const watched = w.watched ? await client.userItems(u.id, { ...q, IncludeItemTypes: 'Movie,Episode', Filters: 'IsPlayed' }) : [];
          const resume = w.resume ? await client.userItems(u.id, { ...q, IncludeItemTypes: 'Movie,Episode', Filters: 'IsResumable' }) : [];
          const favorites = w.favorites ? await client.userItems(u.id, { ...q, IncludeItemTypes: 'Movie,Episode,Series', Filters: 'IsFavorite' }) : [];
          const playlists: { pl: EmbyItem; items: EmbyItem[] }[] = [];
          if (w.playlists) {
            for (const pl of await client.userItems(u.id, { Recursive: true, IncludeItemTypes: 'Playlist' })) {
              playlists.push({ pl, items: await client.paged(`/Playlists/${encodeURIComponent(pl.Id)}/Items`, { [flavor === 'emby' ? 'UserId' : 'userId']: u.id, Fields: fields }) });
            }
          }
          await loadSeries(u.id, [...watched, ...resume, ...favorites, ...playlists.flatMap((p) => p.items)]);
          const haul = emptyHaul();
          haul.watched = entries(watched);
          haul.resume = entries(resume);
          haul.favorites = entries(favorites);
          haul.playlists = playlists.map((p) => ({ id: p.pl.Id, name: p.pl.Name ?? 'Playlist', items: entries(p.items) }));
          if (w.history && reporting) {
            try {
              haul.history = await history(u, new Map([...watched, ...resume].map((x) => [x.Id, x])));
            } catch (e) {
              haul.notes.push(`Play history skipped: ${(e as Error).message}`);
              log.warn(`Playback Reporting history for ${u.name} failed: ${(e as Error).message}`);
            }
          }
          return haul;
        },

        async countUser(u: SourceUser, w: Want): Promise<QuickCounts> {
          const q = { Recursive: true };
          const n = (on: boolean, query: Query) => (on ? client.userCount(u.id, { ...q, ...query }) : Promise.resolve(0));
          const [watched, resume, favorites, playlists] = await Promise.all([
            n(w.watched, { IncludeItemTypes: 'Movie,Episode', Filters: 'IsPlayed' }),
            n(w.resume, { IncludeItemTypes: 'Movie,Episode', Filters: 'IsResumable' }),
            n(w.favorites, { IncludeItemTypes: 'Movie,Episode,Series', Filters: 'IsFavorite' }),
            n(w.playlists, { IncludeItemTypes: 'Playlist' }),
          ]);
          let hist = 0;
          const notes: string[] = [];
          if (w.history && reporting) {
            try {
              hist = Number((await reportQuery(client, `SELECT COUNT(*) FROM PlaybackActivity WHERE lower(replace(UserId, '-', '')) = '${hexId(u.id)}'`))[0]?.[0] ?? 0);
            } catch (e) {
              notes.push(`Play history skipped: ${(e as Error).message}`);
            }
          }
          return { watched, resume, favorites, playlists, history: hist, notes };
        },

        async collections(): Promise<SrcList[]> {
          // Collections are server-wide; read them as an administrator (who can see every library).
          const viewer = rawUsers.find((u) => u.Policy?.IsAdministrator && !u.Policy?.IsDisabled) ?? rawUsers[0];
          if (!viewer) return [];
          const out: SrcList[] = [];
          for (const bs of await client.userItems(viewer.Id, { Recursive: true, IncludeItemTypes: 'BoxSet' })) {
            const items = await client.userItems(viewer.Id, { ParentId: bs.Id, Fields: fields });
            await loadSeries(viewer.Id, items);
            out.push({ id: bs.Id, name: bs.Name ?? 'Collection', items: entries(items) });
          }
          return out;
        },

        async countCollections(): Promise<number> {
          const viewer = rawUsers.find((u) => u.Policy?.IsAdministrator && !u.Policy?.IsDisabled) ?? rawUsers[0];
          return viewer ? client.userCount(viewer.Id, { Recursive: true, IncludeItemTypes: 'BoxSet' }) : 0;
        },
      };
    },
  };
}
