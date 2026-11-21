/**
 * TVHeadend (https://tvheadend.org) client — HTTP API on port 9981:
 *   /api/serverinfo, /api/channel/grid, /api/channeltag/grid, /api/status/inputs, /api/profile/list,
 *   /api/epg/events/grid, /api/dvr/entry/grid_finished; streams at /stream/channel/<uuid>?profile=<name>,
 *   channel icons at /imagecache/<id>. Falls back to /playlist/channels.m3u when the channel grid is not allowed.
 * Authentication: Digest (TVHeadend's default) or plain/Basic, handled by TunerHttp.
 */
import { parseM3u } from '../m3u.js';
import { TunerHttp, TunerHttpError, baseUrl, withUserInfo } from './http.js';
import { isoFromUnix, type GuideSink, type TunerCategory, type TunerChannel, type TunerDevice, type TunerOptions, type TunerSync } from './types.js';

export interface TvhSourceLike {
  url: string;
  username?: string | null;
  password?: string | null;
  options: TunerOptions;
  userAgent?: string | null;
}

interface Grid<T> {
  entries?: T[];
  total?: number;
  totalCount?: number;
}
interface TvhChannel { uuid: string; enabled?: boolean; name?: string; number?: number; icon?: string; icon_public_url?: string; tags?: string[] }
interface TvhTag { uuid: string; name: string; enabled?: boolean; internal?: boolean; index?: number }
interface TvhInput { uuid?: string; input?: string; stream?: string; subs?: number }
interface TvhEvent {
  eventId?: number; channelUuid?: string; channelName?: string; channelNumber?: string; start: number; stop: number; title?: string; subtitle?: string;
  summary?: string; description?: string; episodeOnscreen?: string; image?: string; genre?: number[]; seasonNumber?: number; episodeNumber?: number;
}
export interface TvhRecording {
  uuid: string; disp_title?: string; disp_subtitle?: string; disp_description?: string; disp_summary?: string; channelname?: string;
  start?: number; stop?: number; start_real?: number; stop_real?: number; filesize?: number; url?: string; status?: string;
}

export const client = (s: TvhSourceLike) => new TunerHttp({ username: s.username, password: s.password, authType: s.options.authType ?? 'auto' }, s.userAgent || 'Kinora/1.0');
const api = (s: TvhSourceLike, path: string) => `${baseUrl(s.url)}${path}`;

/** DVB content descriptor (ETSI EN 300 468) top-level nibble → genre. */
const GENRES: Record<number, string> = {
  0x10: 'Movie', 0x20: 'News', 0x30: 'Show', 0x40: 'Sports', 0x50: 'Children', 0x60: 'Music', 0x70: 'Arts', 0x80: 'Social', 0x90: 'Education', 0xa0: 'Leisure',
};
export const dvbGenre = (g?: number[] | null) => (g?.length ? GENRES[g[0] & 0xf0] ?? null : null);

function episodeNum(e: TvhEvent): string | null {
  if (e.seasonNumber && e.episodeNumber) return `S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')}`;
  const m = e.episodeOnscreen?.match(/S(\d+)\s*E(\d+)/i);
  return m ? `S${m[1].padStart(2, '0')}E${m[2].padStart(2, '0')}` : e.episodeOnscreen || null;
}

export function streamUrl(s: TvhSourceLike, uuid: string): string {
  return `${baseUrl(s.url)}/stream/channel/${encodeURIComponent(uuid)}?profile=${encodeURIComponent(s.options.profile || 'pass')}`;
}

function iconUrl(s: TvhSourceLike, c: { icon?: string; icon_public_url?: string }): string | null {
  const pub = c.icon_public_url || '';
  if (/^https?:\/\//i.test(pub)) return pub;
  if (pub) return withUserInfo(`${baseUrl(s.url)}/${pub.replace(/^\/+/, '')}`, s.username, s.password);
  return c.icon && /^https?:\/\//i.test(c.icon) ? c.icon : null;
}

export async function device(s: TvhSourceLike, http = client(s)): Promise<TunerDevice & { profiles: string[] }> {
  const info = await http.json<{ sw_version?: string; api_version?: number; name?: string }>(api(s, '/api/serverinfo'));
  if (!info || (info.sw_version == null && info.api_version == null)) throw new TunerHttpError('This does not look like a TVHeadend server (no /api/serverinfo)');
  let tuners: string[] = [];
  try {
    const inputs = await http.json<Grid<TvhInput>>(api(s, '/api/status/inputs'));
    tuners = (inputs.entries ?? []).map((i) => i.input || i.stream || 'Tuner');
  } catch (e) {
    if ((e as TunerHttpError).status !== 403) throw e;
  }
  let profiles: string[] = [];
  try {
    profiles = ((await http.json<Grid<{ key: string; val: string }>>(api(s, '/api/profile/list'))).entries ?? []).map((p) => p.val).filter(Boolean);
  } catch {
    /* profiles need admin rights on some setups */
  }
  return { name: info.name ?? 'TVHeadend', model: 'TVHeadend', version: info.sw_version ?? null, tuners, tunerCount: tuners.length || null, profiles };
}

async function grid<T>(http: TunerHttp, url: string, pageSize = 2000, maxPages = 50): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < maxPages; page++) {
    const sep = url.includes('?') ? '&' : '?';
    const r = await http.json<Grid<T>>(`${url}${sep}start=${page * pageSize}&limit=${pageSize}`, 60000);
    const entries = r.entries ?? [];
    out.push(...entries);
    const total = r.totalCount ?? r.total ?? out.length;
    if (!entries.length || out.length >= total) break;
  }
  return out;
}

export async function sync(s: TvhSourceLike): Promise<TunerSync> {
  const http = client(s);
  const dev = await device(s, http);
  const warnings: string[] = [];
  let channels: TunerChannel[] = [];
  let categories: TunerCategory[] = [];
  try {
    const [chans, tags] = await Promise.all([grid<TvhChannel>(http, api(s, '/api/channel/grid?sort=number&dir=ASC')), grid<TvhTag>(http, api(s, '/api/channeltag/grid')).catch(() => [] as TvhTag[])]);
    const usable = tags.filter((t) => t.enabled !== false && !t.internal).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const tagIds = new Set(usable.map((t) => t.uuid));
    categories = usable.map((t) => ({ remoteId: t.uuid, name: t.name }));
    channels = chans.filter((c) => c.enabled !== false && c.uuid).map((c) => ({
      remoteId: c.uuid, name: c.name?.trim() || `Channel ${c.number ?? ''}`.trim(), number: c.number || null, logo: iconUrl(s, c),
      category: (c.tags ?? []).find((t) => tagIds.has(t)) ?? null, streamUrl: streamUrl(s, c.uuid), epgId: c.uuid,
    }));
  } catch (e) {
    // Users with streaming-only rights cannot read the channel grid; the playlist works for them.
    if ((e as TunerHttpError).status !== 403 && (e as TunerHttpError).status !== 404) throw e;
    warnings.push('Channel grid not allowed for this user; using /playlist/channels.m3u');
    const pl = parseM3u(await http.text(api(s, '/playlist/channels.m3u'), 60000));
    const groups = [...new Set(pl.entries.map((e) => e.group).filter(Boolean))] as string[];
    categories = groups.map((g) => ({ remoteId: g, name: g }));
    channels = pl.entries.map((e, i) => {
      const uuid = e.tvgId && /^[0-9a-f]{32}$/i.test(e.tvgId) ? e.tvgId : e.url.match(/\/stream\/channel(?:id)?\/([^/?]+)/)?.[1] ?? null;
      const clean = (() => {
        const u = new URL(e.url);
        u.searchParams.delete('ticket');
        u.searchParams.set('profile', s.options.profile || 'pass');
        return u.toString();
      })();
      return { remoteId: uuid ?? `url:${clean}`, name: e.name, number: e.chno ?? i + 1, logo: e.logo, category: e.group, streamUrl: uuid && /^[0-9a-f]{32}$/i.test(uuid) ? streamUrl(s, uuid) : clean, epgId: uuid };
    });
  }
  return { device: dev, categories, channels, warnings };
}

/** The TVHeadend EPG (/api/epg/events/grid), keyed by channel uuid — the same id the channels carry, so matching is exact. */
export async function loadGuide(s: TvhSourceLike, sink: GuideSink) {
  const http = client(s);
  const events = await grid<TvhEvent>(http, api(s, '/api/epg/events/grid'), 5000, 40);
  const chans = new Map<string, { name: string; number: string | null }>();
  for (const e of events) if (e.channelUuid && !chans.has(e.channelUuid)) chans.set(e.channelUuid, { name: e.channelName ?? e.channelUuid, number: e.channelNumber ?? null });
  try {
    for (const c of await grid<TvhChannel>(http, api(s, '/api/channel/grid'))) {
      if (c.enabled !== false && !chans.has(c.uuid)) chans.set(c.uuid, { name: c.name ?? c.uuid, number: c.number != null ? String(c.number) : null });
    }
  } catch {
    /* EPG-only users */
  }
  for (const [id, c] of chans) sink.channel({ id, name: c.name, altNames: [], callsign: null, number: c.number, icon: null });
  sink.decide();
  for (const e of events) {
    if (!e.channelUuid || !e.title || !e.start || !e.stop) continue;
    sink.programme({
      channel: e.channelUuid, start: isoFromUnix(e.start), end: isoFromUnix(e.stop), title: e.title, subtitle: e.subtitle || null,
      description: e.description || e.summary || null, category: dvbGenre(e.genre), icon: e.image && /^https?:/i.test(e.image) ? e.image : null, episodeNum: episodeNum(e),
    });
  }
  return events.length;
}

/** Finished TVHeadend recordings (read-only list). */
export async function recordings(s: TvhSourceLike): Promise<TvhRecording[]> {
  return grid<TvhRecording>(client(s), api(s, '/api/dvr/entry/grid_finished?sort=start&dir=DESC'), 500, 10);
}

export const recordingUrl = (s: TvhSourceLike, uuid: string) => `${baseUrl(s.url)}/dvrfile/${encodeURIComponent(uuid)}`;
