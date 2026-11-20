import type { XtreamAccountInfo } from '@mediamax/shared';

/** Minimal, robust Xtream Codes (player_api.php) client. */
export interface XtreamCreds {
  url: string;
  username: string;
  password: string;
  userAgent?: string | null;
}

export function normalizeBase(url: string): string {
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  u = u.replace(/\/(player_api|get|xmltv)\.php.*$/i, '').replace(/\/+$/, '');
  return u;
}

async function getJson<T>(c: XtreamCreds, params: Record<string, string>, timeoutMs = 60000): Promise<T> {
  const url = new URL(normalizeBase(c.url) + '/player_api.php');
  url.searchParams.set('username', c.username);
  url.searchParams.set('password', c.password);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { 'User-Agent': c.userAgent || 'MediaMax/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Provider returned HTTP ${res.status}`);
  const text = await res.text();
  if (!text.trim()) return [] as unknown as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('Provider returned an invalid response (not JSON)');
  }
}

export interface XtreamAuth {
  user_info?: { auth?: number; status?: string; exp_date?: string | null; active_cons?: string | number; max_connections?: string | number; is_trial?: string | number; allowed_output_formats?: string[] };
  server_info?: { url?: string; port?: string; https_port?: string; server_protocol?: string; timezone?: string; timestamp_now?: number };
}

export async function authenticate(c: XtreamCreds): Promise<{ account: XtreamAccountInfo; timezone: string | null; formats: string[] }> {
  const r = await getJson<XtreamAuth>(c, {}, 20000);
  if (!r?.user_info || r.user_info.auth === 0) throw new Error('Invalid username or password for this provider');
  const ui = r.user_info;
  const exp = ui.exp_date && Number(ui.exp_date) > 0 ? new Date(Number(ui.exp_date) * 1000).toISOString() : null;
  return {
    account: {
      status: ui.status ?? 'Active',
      expiresAt: exp,
      activeConnections: Number(ui.active_cons ?? 0),
      maxConnections: Number(ui.max_connections ?? 1),
      isTrial: String(ui.is_trial) === '1',
    },
    timezone: r.server_info?.timezone ?? null,
    formats: ui.allowed_output_formats ?? ['ts'],
  };
}

export interface XCategory { category_id: string; category_name: string; parent_id?: number }
export interface XLiveStream { num?: number; name: string; stream_id: number; stream_icon?: string; epg_channel_id?: string | null; category_id?: string; category_ids?: number[]; tv_archive?: number; tv_archive_duration?: number | string; custom_sid?: string }
export interface XVodStream { num?: number; name: string; stream_id: number; stream_icon?: string; rating?: string | number; rating_5based?: number; added?: string; category_id?: string; container_extension?: string; tmdb?: string | number; year?: string }
export interface XSeries { series_id: number; name: string; cover?: string; plot?: string; cast?: string; director?: string; genre?: string; releaseDate?: string; release_date?: string; rating?: string | number; backdrop_path?: string[]; category_id?: string; last_modified?: string; youtube_trailer?: string; tmdb?: string | number; year?: string }

export const liveCategories = (c: XtreamCreds) => getJson<XCategory[]>(c, { action: 'get_live_categories' });
export const liveStreams = (c: XtreamCreds) => getJson<XLiveStream[]>(c, { action: 'get_live_streams' }, 120000);
export const vodCategories = (c: XtreamCreds) => getJson<XCategory[]>(c, { action: 'get_vod_categories' });
export const vodStreams = (c: XtreamCreds) => getJson<XVodStream[]>(c, { action: 'get_vod_streams' }, 180000);
export const seriesCategories = (c: XtreamCreds) => getJson<XCategory[]>(c, { action: 'get_series_categories' });
export const seriesList = (c: XtreamCreds) => getJson<XSeries[]>(c, { action: 'get_series' }, 180000);

export interface XVodInfo {
  info?: { plot?: string; description?: string; cast?: string; actors?: string; director?: string; genre?: string; releasedate?: string; release_date?: string; duration_secs?: number; duration?: string; backdrop_path?: string[] | string; movie_image?: string; cover_big?: string; tmdb_id?: string | number; rating?: string | number; youtube_trailer?: string; age?: string; mpaa_rating?: string; o_name?: string; country?: string };
  movie_data?: { stream_id: number; container_extension?: string; name?: string };
}
export const vodInfo = (c: XtreamCreds, id: string) => getJson<XVodInfo>(c, { action: 'get_vod_info', vod_id: id });

export interface XEpisode { id: string; episode_num: number | string; title?: string; container_extension?: string; season?: number | string; info?: { plot?: string; duration_secs?: number; movie_image?: string; releasedate?: string; rating?: string | number; air_date?: string } }
export interface XSeriesInfo {
  seasons?: { season_number: number; name?: string; cover?: string; cover_big?: string; overview?: string; air_date?: string }[];
  info?: XSeries;
  episodes?: Record<string, XEpisode[]> | XEpisode[][];
}
export const seriesInfo = (c: XtreamCreds, id: string) => getJson<XSeriesInfo>(c, { action: 'get_series_info', series_id: id });

export const liveUrl = (c: XtreamCreds, id: number | string, ext = 'ts') => `${normalizeBase(c.url)}/live/${encodeURIComponent(c.username)}/${encodeURIComponent(c.password)}/${id}.${ext}`;
export const vodUrl = (c: XtreamCreds, id: number | string, ext = 'mp4') => `${normalizeBase(c.url)}/movie/${encodeURIComponent(c.username)}/${encodeURIComponent(c.password)}/${id}.${ext || 'mp4'}`;
export const episodeUrl = (c: XtreamCreds, id: number | string, ext = 'mp4') => `${normalizeBase(c.url)}/series/${encodeURIComponent(c.username)}/${encodeURIComponent(c.password)}/${id}.${ext || 'mp4'}`;
export const epgUrl = (c: XtreamCreds) => `${normalizeBase(c.url)}/xmltv.php?username=${encodeURIComponent(c.username)}&password=${encodeURIComponent(c.password)}`;

/** Format a Date in the provider's timezone as YYYY-MM-DD:HH-MM (Xtream timeshift format). */
export function timeshiftStamp(d: Date, timezone: string | null): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${g('year')}-${g('month')}-${g('day')}:${g('hour') === '24' ? '00' : g('hour')}-${g('minute')}`;
}

export const timeshiftUrl = (c: XtreamCreds, id: number | string, start: Date, durationMin: number, tz: string | null) =>
  `${normalizeBase(c.url)}/timeshift/${encodeURIComponent(c.username)}/${encodeURIComponent(c.password)}/${Math.max(1, Math.round(durationMin))}/${timeshiftStamp(start, tz)}/${id}.ts`;
