import type {
  Channel, ChannelCategory, ChannelQuery, CreateLiveSourceRequest, GuideResponse, HomeRow, LivePlayRequest, LiveSource, Paged,
  PlaybackInfo, Program, TestSourceResponse, UpdateLiveSourceRequest, User, XtreamAccountInfo,
} from '@mediamax/shared';
import { db, type Row } from '../../db.js';
import { newId, stableId } from '../../util/ids.js';
import { HttpError, badRequest, forbidden, notFound } from '../../util/errors.js';
import { nowIso, parseJson, sortTitle, toInt, isSafeRemoteUrl } from '../../util/misc.js';
import { logger } from '../../util/log.js';
import { registerImage, imageUrl } from '../images.js';
import { getBranding } from '../branding.js';
import { getSettings } from '../settings.js';
import { events, bus } from '../events.js';
import { logActivity } from '../activity.js';
import { homeHooks } from '../items.js';
import { TranscodeJob } from '../transcoder.js';
import { registerSession, stopSession, type PlaySession } from '../playback.js';
import type { AuthContext } from '../auth.js';
import * as xt from './xtream.js';
import { parseM3u, m3uCatchupUrl } from './m3u.js';
import { parseXmltvStream } from './xmltv.js';

const log = logger('livetv');

/* ------------------------------ mapping ----------------------------- */

function toSource(r: Row): LiveSource {
  return {
    id: r.id, name: r.name, type: r.type, url: r.url, username: r.username ?? null, password: r.password ? '••••••••' : null,
    epgUrl: r.epg_url ?? null, enabled: !!r.enabled, proxyStreams: !!r.proxy_streams, importVod: !!r.import_vod, importSeries: !!r.import_series,
    userAgent: r.user_agent ?? null, refreshIntervalHours: r.refresh_hours, maxConnections: r.max_connections ?? null,
    lastRefreshAt: r.last_refresh_at ?? null, lastError: r.last_error ?? null,
    channelCount: db.get<{ n: number }>('SELECT COUNT(*) n FROM channels WHERE source_id = ?', r.id)!.n,
    accountInfo: parseJson<XtreamAccountInfo | null>(r.account_info, null),
  };
}

const creds = (r: Row): xt.XtreamCreds => ({ url: r.url, username: r.username ?? '', password: r.password ?? '', userAgent: r.user_agent });

function toProgram(r: Row, channelId: string): Program {
  return {
    id: r.id, channelId, title: r.title, subtitle: r.subtitle ?? null, description: r.description ?? null, start: r.start, end: r.end,
    category: r.category ?? null, iconUrl: r.icon ?? null, episodeNum: r.episode_num ?? null, isNew: !!r.is_new, recordingId: r.recording_id ?? null,
  };
}

const CHANNEL_SELECT = `SELECT c.*, cat.name cat_name, (SELECT 1 FROM channel_favorites f WHERE f.channel_id = c.id AND f.user_id = ?) fav FROM channels c
  LEFT JOIN channel_categories cat ON cat.id = c.category_id JOIN live_sources s ON s.id = c.source_id`;

function toChannel(r: Row): Channel {
  const custom = parseJson<Record<string, any>>(r.custom, {});
  return {
    id: r.id, sourceId: r.source_id, number: custom.number ?? r.number ?? null, name: custom.name ?? r.name,
    logoUrl: imageUrl(custom.logo ? registerImage(custom.logo) : r.logo), categoryId: r.category_id ?? null, categoryName: r.cat_name ?? null,
    hasArchive: !!r.has_archive, archiveDays: r.archive_days ?? 0, favorite: !!r.fav, hidden: !!r.hidden, epgChannelId: custom.epgChannelId ?? r.epg_channel_id ?? null,
  };
}

const effEpg = (r: Row) => parseJson<Record<string, any>>(r.custom, {}).epgChannelId ?? r.epg_channel_id ?? null;

function attachNowNext(channels: Channel[], rows: Row[]) {
  const ids = [...new Set(rows.map(effEpg).filter(Boolean))] as string[];
  if (!ids.length) return;
  const now = nowIso();
  const progs = db.all(
    `SELECT * FROM programs WHERE epg_channel_id IN (${ids.map(() => '?').join(',')}) AND end > ? AND start < ? ORDER BY start`,
    ...ids, now, new Date(Date.now() + 6 * 3600000).toISOString());
  const byEpg = new Map<string, Row[]>();
  for (const p of progs) {
    const a = byEpg.get(p.epg_channel_id) ?? [];
    a.push(p);
    byEpg.set(p.epg_channel_id, a);
  }
  channels.forEach((c, i) => {
    const list = byEpg.get(effEpg(rows[i]) ?? '') ?? [];
    const cur = list.find((p) => p.start <= now && p.end > now) ?? null;
    const nxt = list.find((p) => p.start >= (cur?.end ?? now)) ?? null;
    c.nowPlaying = cur ? toProgram(cur, c.id) : null;
    c.next = nxt ? toProgram(nxt, c.id) : null;
  });
}

function assertLive(user: User) {
  if (!getBranding().features.liveTv) throw forbidden('Live TV is disabled');
  if (!user.allowLiveTv && !user.isAdmin) throw forbidden('Live TV is not enabled for your account');
}

/* ------------------------------ sources ----------------------------- */

export const listSources = () => db.all('SELECT * FROM live_sources ORDER BY name').map(toSource);
export function getSourceRow(id: string): Row {
  const r = db.get('SELECT * FROM live_sources WHERE id = ?', id);
  if (!r) throw notFound('Source not found');
  return r;
}

function validateSource(req: Partial<CreateLiveSourceRequest>) {
  if (req.type && !['xtream', 'm3u', 'hdhomerun'].includes(req.type)) throw badRequest('Unknown source type');
  if (req.url !== undefined && !/^https?:\/\/|^[\w.-]+(:\d+)?/.test(req.url)) throw badRequest('Invalid URL');
}

export function createSource(req: CreateLiveSourceRequest): LiveSource {
  validateSource(req);
  if (!req.name || !req.url) throw badRequest('Name and URL are required');
  if (req.type === 'xtream' && (!req.username || !req.password)) throw badRequest('Xtream sources need a username and password');
  const id = newId();
  db.insert('live_sources', {
    id, name: req.name.trim(), type: req.type, url: req.type === 'xtream' ? xt.normalizeBase(req.url) : req.url.trim(), username: req.username ?? null, password: req.password ?? null,
    epg_url: req.epgUrl || null, enabled: req.enabled ?? true, proxy_streams: req.proxyStreams ?? true, import_vod: req.importVod ?? req.type === 'xtream',
    import_series: req.importSeries ?? req.type === 'xtream', user_agent: req.userAgent || null, refresh_hours: req.refreshIntervalHours ?? 12, created_at: nowIso(),
  });
  logActivity('livetv.source', `Live TV source "${req.name}" added`);
  void refreshSource(id);
  return toSource(getSourceRow(id));
}

export function updateSource(id: string, req: UpdateLiveSourceRequest): LiveSource {
  validateSource(req);
  getSourceRow(id);
  const patch: Row = {};
  if (req.name !== undefined) patch.name = req.name.trim();
  if (req.url !== undefined) patch.url = req.url.trim();
  if (req.username !== undefined) patch.username = req.username;
  if (req.password !== undefined && req.password !== '••••••••') patch.password = req.password;
  if (req.epgUrl !== undefined) patch.epg_url = req.epgUrl || null;
  if (req.enabled !== undefined) patch.enabled = req.enabled;
  if (req.proxyStreams !== undefined) patch.proxy_streams = req.proxyStreams;
  if (req.importVod !== undefined) patch.import_vod = req.importVod;
  if (req.importSeries !== undefined) patch.import_series = req.importSeries;
  if (req.userAgent !== undefined) patch.user_agent = req.userAgent || null;
  if (req.refreshIntervalHours !== undefined) patch.refresh_hours = Math.max(1, req.refreshIntervalHours);
  db.update('live_sources', id, patch);
  if (patch.url || patch.username || patch.password || patch.import_vod !== undefined || patch.import_series !== undefined || patch.epg_url !== undefined) void refreshSource(id);
  return toSource(getSourceRow(id));
}

export function deleteSource(id: string) {
  getSourceRow(id);
  db.tx(() => {
    db.run('DELETE FROM programs WHERE source_id = ?', id);
    db.run('DELETE FROM libraries WHERE source_id = ?', id);
    db.run('DELETE FROM live_sources WHERE id = ?', id);
  });
}

export async function testSource(req: CreateLiveSourceRequest): Promise<TestSourceResponse> {
  try {
    if (req.type === 'xtream') {
      const c = { url: req.url, username: req.username ?? '', password: req.password ?? '', userAgent: req.userAgent };
      const auth = await xt.authenticate(c);
      const [live, vod, series] = await Promise.all([xt.liveStreams(c).catch(() => []), xt.vodStreams(c).catch(() => []), xt.seriesList(c).catch(() => [])]);
      return { ok: true, message: `Connected. Account ${auth.account.status}${auth.account.expiresAt ? `, expires ${auth.account.expiresAt.slice(0, 10)}` : ''}.`, liveCount: live.length, vodCount: vod.length, seriesCount: series.length, accountInfo: auth.account };
    }
    if (req.type === 'hdhomerun') {
      const lineup = await hdhrLineup(req.url);
      return { ok: true, message: `Found ${lineup.length} channels on the tuner.`, liveCount: lineup.length };
    }
    const res = await fetch(req.url, { headers: { 'User-Agent': req.userAgent || 'MediaMax/1.0' }, signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const pl = parseM3u(await res.text());
    if (!pl.entries.length) throw new Error('No channels found in playlist');
    return { ok: true, message: `Found ${pl.entries.length} channels.${pl.epgUrl ? ' Playlist includes an EPG URL.' : ''}`, liveCount: pl.entries.length };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

async function hdhrLineup(url: string): Promise<{ GuideNumber: string; GuideName: string; URL: string; HD?: number }[]> {
  const base = url.replace(/\/+$/, '').replace(/\/lineup\.json$/, '');
  const res = await fetch(`${/^https?:/.test(base) ? base : 'http://' + base}/lineup.json`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HDHomeRun returned HTTP ${res.status}`);
  return res.json() as any;
}

/* ------------------------------ refresh ----------------------------- */

const refreshing = new Map<string, Promise<void>>();
const sourceTimezones = new Map<string, string | null>();

export function refreshSource(id: string, opts: { epgOnly?: boolean } = {}): Promise<void> {
  const running = refreshing.get(id);
  if (running) return running;
  const p = doRefresh(id, opts).finally(() => refreshing.delete(id));
  refreshing.set(id, p);
  return p;
}

interface ChannelIn {
  remoteId: string;
  name: string;
  number: number | null;
  logo: string | null;
  category: string | null;
  streamUrl: string;
  archive: boolean;
  archiveDays: number;
  epgId: string | null;
  custom?: Record<string, unknown>;
}

function syncChannels(sourceId: string, cats: { remoteId: string; name: string }[], allChans: ChannelIn[]) {
  const chans = allChans.filter((c) => isSafeRemoteUrl(c.streamUrl));
  if (chans.length < allChans.length) log.warn(`Ignored ${allChans.length - chans.length} channel(s) with unsupported stream URLs`);
  db.tx(() => {
    const catIds = new Map<string, string>();
    const seenCats = new Set<string>();
    cats.forEach((c, i) => {
      const cid = stableId(sourceId, 'cat', c.remoteId);
      catIds.set(c.remoteId, cid);
      seenCats.add(cid);
      const ex = db.get('SELECT id FROM channel_categories WHERE id = ?', cid);
      if (ex) db.run('UPDATE channel_categories SET name = ? WHERE id = ?', c.name, cid);
      else db.insert('channel_categories', { id: cid, source_id: sourceId, remote_id: c.remoteId, kind: 'live', name: c.name, hidden: 0, sort_order: i });
    });
    for (const r of db.all<{ id: string }>("SELECT id FROM channel_categories WHERE source_id = ? AND kind = 'live'", sourceId)) {
      if (!seenCats.has(r.id)) db.run('DELETE FROM channel_categories WHERE id = ?', r.id);
    }
    const seen = new Set<string>();
    chans.forEach((c, i) => {
      const id = stableId(sourceId, 'ch', c.remoteId);
      seen.add(id);
      const row = {
        source_id: sourceId, remote_id: c.remoteId, number: c.number ?? i + 1, name: c.name, logo: registerImage(c.logo),
        category_id: c.category ? catIds.get(c.category) ?? null : null, stream_url: c.streamUrl, has_archive: c.archive, archive_days: c.archiveDays,
        epg_channel_id: c.epgId, sort_order: i,
      };
      if (db.get('SELECT 1 FROM channels WHERE id = ?', id)) db.update('channels', id, row);
      else db.insert('channels', { id, ...row, hidden: 0, custom: JSON.stringify(c.custom ?? {}) });
    });
    for (const r of db.all<{ id: string }>('SELECT id FROM channels WHERE source_id = ?', sourceId)) if (!seen.has(r.id)) db.run('DELETE FROM channels WHERE id = ?', r.id);
  });
}

async function doRefresh(id: string, opts: { epgOnly?: boolean }) {
  const src = getSourceRow(id);
  if (!src.enabled) return;
  log.info(`Refreshing live source "${src.name}" (${src.type})`);
  let epgUrl: string | null = src.epg_url;
  try {
    if (!opts.epgOnly) {
      if (src.type === 'xtream') {
        const c = creds(src);
        const auth = await xt.authenticate(c);
        sourceTimezones.set(id, auth.timezone);
        db.run('UPDATE live_sources SET account_info = ?, max_connections = ? WHERE id = ?', JSON.stringify(auth.account), auth.account.maxConnections || null, id);
        const ext = auth.formats.includes('ts') ? 'ts' : auth.formats.includes('m3u8') ? 'm3u8' : 'ts';
        const [cats, streams] = await Promise.all([xt.liveCategories(c), xt.liveStreams(c)]);
        syncChannels(id, (cats ?? []).map((x) => ({ remoteId: String(x.category_id), name: x.category_name })),
          (streams ?? []).map((s) => ({
            remoteId: String(s.stream_id), name: s.name?.trim() || `Channel ${s.stream_id}`, number: s.num ?? null, logo: s.stream_icon || null,
            category: s.category_id != null ? String(s.category_id) : null, streamUrl: xt.liveUrl(c, s.stream_id, ext),
            archive: Number(s.tv_archive) === 1, archiveDays: Number(s.tv_archive_duration) || 0, epgId: s.epg_channel_id || null,
          })));
        epgUrl = epgUrl || xt.epgUrl(c);
        if (src.import_vod) await importVod(src).catch((e) => log.warn(`VOD import failed for ${src.name}`, e.message));
        else db.run("DELETE FROM libraries WHERE source_id = ? AND type = 'iptv-movies'", id);
        if (src.import_series) await importSeries(src).catch((e) => log.warn(`Series import failed for ${src.name}`, e.message));
        else db.run("DELETE FROM libraries WHERE source_id = ? AND type = 'iptv-shows'", id);
      } else if (src.type === 'm3u') {
        const res = await fetch(src.url, { headers: { 'User-Agent': src.user_agent || 'MediaMax/1.0' }, signal: AbortSignal.timeout(120000) });
        if (!res.ok) throw new Error(`Playlist download failed: HTTP ${res.status}`);
        const pl = parseM3u(await res.text());
        const groups = [...new Set(pl.entries.map((e) => e.group).filter(Boolean))] as string[];
        syncChannels(id, groups.map((g) => ({ remoteId: g, name: g })), pl.entries.map((e, i) => ({
          remoteId: e.tvgId && pl.entries.filter((x) => x.tvgId === e.tvgId).length === 1 ? `id:${e.tvgId}` : `url:${e.url}`,
          name: e.name, number: e.chno ?? i + 1, logo: e.logo, category: e.group, streamUrl: e.url,
          archive: !!(e.catchup || e.catchupSource), archiveDays: e.catchupDays || (e.catchup ? 7 : 0), epgId: e.tvgId || e.tvgName || null,
          custom: {}, // keep custom for admin overrides
        })));
        // Store catch-up templates for each channel.
        for (const e of pl.entries) {
          if (!e.catchup && !e.catchupSource && !e.userAgent) continue;
          const cid = stableId(id, 'ch', e.tvgId && pl.entries.filter((x) => x.tvgId === e.tvgId).length === 1 ? `id:${e.tvgId}` : `url:${e.url}`);
          const row = db.get('SELECT custom FROM channels WHERE id = ?', cid);
          if (row) db.run('UPDATE channels SET custom = ? WHERE id = ?', JSON.stringify({ ...parseJson(row.custom, {}), catchup: e.catchup, catchupSource: e.catchupSource, userAgent: e.userAgent }), cid);
        }
        epgUrl = epgUrl || pl.epgUrl;
      } else if (src.type === 'hdhomerun') {
        const lineup = await hdhrLineup(src.url);
        syncChannels(id, [{ remoteId: 'hd', name: 'HD' }, { remoteId: 'sd', name: 'SD' }], lineup.map((l) => ({
          remoteId: l.GuideNumber, name: l.GuideName, number: parseFloat(l.GuideNumber) || null, logo: null, category: l.HD ? 'hd' : 'sd',
          streamUrl: l.URL, archive: false, archiveDays: 0, epgId: l.GuideNumber,
        })));
      }
    }
    if (epgUrl) await refreshEpg(id, epgUrl, src.user_agent);
    db.run('UPDATE live_sources SET last_refresh_at = ?, last_error = NULL WHERE id = ?', nowIso(), id);
    bus.emit('epg.refreshed', id);
    log.info(`Live source "${src.name}" refreshed`);
  } catch (e) {
    const msg = (e as Error).message;
    db.run('UPDATE live_sources SET last_error = ?, last_refresh_at = ? WHERE id = ?', msg, nowIso(), id);
    logActivity('livetv.source', `Refresh of "${src.name}" failed: ${msg}`, { severity: 'error' });
    log.warn(`Refresh of "${src.name}" failed: ${msg}`);
  }
}

async function refreshEpg(sourceId: string, url: string, ua: string | null) {
  // Map XMLTV channel ids (and display names) onto our channels' epg ids.
  const chans = db.all<{ epg_channel_id: string | null; name: string; custom: string }>('SELECT epg_channel_id, name, custom FROM channels WHERE source_id = ?', sourceId);
  const wanted = new Set<string>();
  for (const c of chans) {
    const e = effEpg(c);
    if (e) wanted.add(e);
  }
  const nameToEpg = new Map<string, string>();
  for (const c of chans) if (!effEpg(c)) nameToEpg.set(c.name.toLowerCase(), '');
  const aliases = new Map<string, string>(); // xmltv id → our epg id
  const keepFrom = new Date(Date.now() - 8 * 86400000).toISOString();
  const keepTo = new Date(Date.now() + 14 * 86400000).toISOString();
  const batch: Row[] = [];
  const flush = () => {
    if (!batch.length) return;
    db.tx(() => {
      for (const p of batch) db.upsert('programs', p);
    });
    batch.length = 0;
  };
  db.run('DELETE FROM programs WHERE source_id = ?', sourceId);
  const res = await parseXmltvStream(url, {
    userAgent: ua,
    onChannel: (c) => {
      if (wanted.has(c.id)) return;
      // Match channels whose epg id equals a display-name (common for M3U tvg-name).
      for (const n of c.names) {
        if (wanted.has(n)) aliases.set(c.id, n);
        const lower = n.toLowerCase();
        if (nameToEpg.has(lower) && !nameToEpg.get(lower)) nameToEpg.set(lower, c.id);
      }
    },
    onProgramme: (p) => {
      const target = wanted.has(p.channel) ? p.channel : aliases.get(p.channel) ?? ([...nameToEpg.values()].includes(p.channel) ? p.channel : null);
      if (!target || p.end < keepFrom || p.start > keepTo) return;
      batch.push({
        id: stableId(sourceId, target, p.start), source_id: sourceId, epg_channel_id: target, title: p.title, subtitle: p.subtitle,
        description: p.description, start: p.start, end: p.end, category: p.category, icon: p.icon, episode_num: p.episodeNum, is_new: p.isNew,
      });
      if (batch.length >= 2000) flush();
    },
  });
  flush();
  // Auto-assign epg ids for channels matched by display name.
  for (const c of db.all('SELECT id, name, custom, epg_channel_id FROM channels WHERE source_id = ?', sourceId)) {
    if (effEpg(c)) continue;
    const m = nameToEpg.get(c.name.toLowerCase());
    if (m) db.run('UPDATE channels SET epg_channel_id = ? WHERE id = ?', m, c.id);
  }
  log.info(`EPG for source ${sourceId}: ${res.channels} channels, ${res.programmes} programmes parsed`);
}

/* ---------------------------- VOD import ---------------------------- */

function ensureIptvLibrary(src: Row, type: 'iptv-movies' | 'iptv-shows'): string {
  const ex = db.get('SELECT id FROM libraries WHERE source_id = ? AND type = ?', src.id, type);
  if (ex) return ex.id;
  const id = stableId('iptvlib', src.id, type);
  const max = db.get<{ m: number | null }>('SELECT MAX(sort_order) m FROM libraries')?.m ?? 0;
  db.insert('libraries', { id, name: `${src.name} ${type === 'iptv-movies' ? 'Movies' : 'Series'}`, type, paths: '[]', source_id: src.id, fetch_metadata: 0, sort_order: (max ?? 0) + 1, created_at: nowIso() });
  return id;
}

function yearFrom(name: string, y?: string | null): number | null {
  const n = parseInt(y ?? '', 10);
  if (n > 1880 && n < 2100) return n;
  const m = name.match(/\((\d{4})\)|\b(19\d{2}|20\d{2})\b/);
  return m ? +(m[1] ?? m[2]) : null;
}

const cleanName = (n: string) => n.replace(/^\s*(?:[A-Z]{2,3}|4K|VOD)\s*[|:-]\s*/i, '').replace(/\s*\(\d{4}\)\s*$/, '').trim() || n;

async function importVod(src: Row) {
  const c = creds(src);
  const libId = ensureIptvLibrary(src, 'iptv-movies');
  const [cats, vods] = await Promise.all([xt.vodCategories(c), xt.vodStreams(c)]);
  const catName = new Map((cats ?? []).map((x) => [String(x.category_id), x.category_name]));
  const now = nowIso();
  const seen = new Set<string>();
  db.tx(() => {
    for (const v of vods ?? []) {
      const id = stableId(libId, 'xvod', v.stream_id);
      seen.add(id);
      const title = cleanName(v.name ?? `Movie ${v.stream_id}`);
      const added = v.added && Number(v.added) > 0 ? new Date(Number(v.added) * 1000).toISOString() : now;
      const genre = v.category_id ? catName.get(String(v.category_id)) : null;
      const ex = db.get('SELECT id, metadata_fetched_at FROM items WHERE id = ?', id);
      const rating = v.rating != null && v.rating !== '' ? Number(v.rating) || null : null;
      if (!ex) {
        db.insert('items', {
          id, library_id: libId, type: 'movie', title, sort_title: sortTitle(title), year: yearFrom(v.name ?? '', v.year), community_rating: rating,
          poster: registerImage(v.stream_icon || null), added_at: added, updated_at: now, remote_ref: String(v.stream_id),
          genres: JSON.stringify(genre ? [genre] : []), external_ids: JSON.stringify({ xtream: String(v.stream_id), ...(v.tmdb ? { tmdb: String(v.tmdb) } : {}) }),
        });
      } else if (!ex.metadata_fetched_at) {
        db.run('UPDATE items SET title = ?, sort_title = ?, poster = COALESCE(?, poster), community_rating = ? WHERE id = ?', title, sortTitle(title), registerImage(v.stream_icon || null), rating, id);
      }
      db.upsert('media', { id: stableId('xmedia', id), item_id: id, path: null, remote_url: xt.vodUrl(c, v.stream_id, v.container_extension || 'mp4'), container: (v.container_extension || 'mp4').toLowerCase(), probed_at: null });
    }
    for (const r of db.all<{ id: string }>('SELECT id FROM items WHERE library_id = ?', libId)) if (!seen.has(r.id)) db.run('DELETE FROM items WHERE id = ?', r.id);
  });
  db.run('UPDATE libraries SET last_scan_at = ? WHERE id = ?', nowIso(), libId);
  events.broadcast({ type: 'library.updated', libraryId: libId });
  log.info(`Imported ${vods?.length ?? 0} VOD titles from ${src.name}`);
}

async function importSeries(src: Row) {
  const c = creds(src);
  const libId = ensureIptvLibrary(src, 'iptv-shows');
  const [cats, list] = await Promise.all([xt.seriesCategories(c), xt.seriesList(c)]);
  const catName = new Map((cats ?? []).map((x) => [String(x.category_id), x.category_name]));
  const now = nowIso();
  const seen = new Set<string>();
  db.tx(() => {
    for (const s of list ?? []) {
      const id = stableId(libId, 'xseries', s.series_id);
      seen.add(id);
      const title = cleanName(s.name ?? `Series ${s.series_id}`);
      const genres = [s.category_id ? catName.get(String(s.category_id)) : null, ...(s.genre ? s.genre.split(/[,/]/).map((g) => g.trim()) : [])].filter(Boolean);
      const modified = s.last_modified && Number(s.last_modified) > 0 ? new Date(Number(s.last_modified) * 1000).toISOString() : now;
      const backdrop = Array.isArray(s.backdrop_path) ? s.backdrop_path[0] : null;
      const ex = db.get('SELECT id, extra FROM items WHERE id = ?', id);
      const fields = {
        title, sort_title: sortTitle(title), year: yearFrom(s.name ?? '', s.year ?? s.releaseDate ?? s.release_date), overview: s.plot || null,
        community_rating: s.rating != null && s.rating !== '' ? Number(s.rating) || null : null, poster: registerImage(s.cover || null), backdrop: registerImage(backdrop || null),
        genres: JSON.stringify([...new Set(genres)]), trailer_url: s.youtube_trailer ? `https://www.youtube.com/watch?v=${s.youtube_trailer}` : null,
        people: JSON.stringify((s.cast ?? '').split(',').map((n) => n.trim()).filter(Boolean).slice(0, 15).map((name) => ({ name, role: null, kind: 'actor', imageUrl: null }))),
      };
      if (!ex) {
        db.insert('items', { id, library_id: libId, type: 'show', ...fields, added_at: modified, updated_at: now, remote_ref: String(s.series_id),
          external_ids: JSON.stringify({ xtream: String(s.series_id), ...(s.tmdb ? { tmdb: String(s.tmdb) } : {}) }), extra: JSON.stringify({ modified }) });
      } else {
        const prev = parseJson<{ modified?: string }>(ex.extra, {});
        db.update('items', id, { ...fields, updated_at: now, extra: JSON.stringify({ ...prev, modified, stale: prev.modified !== modified }) });
      }
    }
    for (const r of db.all<{ id: string }>("SELECT id FROM items WHERE library_id = ? AND type = 'show'", libId)) if (!seen.has(r.id)) db.run('DELETE FROM items WHERE id = ? OR grandparent_id = ? OR parent_id = ?', r.id, r.id, r.id);
  });
  db.run('UPDATE libraries SET last_scan_at = ? WHERE id = ?', nowIso(), libId);
  events.broadcast({ type: 'library.updated', libraryId: libId });
  log.info(`Imported ${list?.length ?? 0} series from ${src.name}`);
}

function sourceForItem(item: Row): Row | null {
  if (!item.library_id) return null;
  return db.get('SELECT s.* FROM live_sources s JOIN libraries l ON l.source_id = s.id WHERE l.id = ?', item.library_id) ?? null;
}

/** Lazily fetch full details for IPTV movies and episodes lists for IPTV series. */
export async function ensureIptvDetails(itemId: string): Promise<void> {
  const item = db.get('SELECT i.*, l.type ltype FROM items i JOIN libraries l ON l.id = i.library_id WHERE i.id = ?', itemId);
  if (!item || !String(item.ltype).startsWith('iptv-')) return;
  const target = item.type === 'season' || item.type === 'episode' ? db.get('SELECT * FROM items WHERE id = ?', item.type === 'season' ? item.parent_id : item.grandparent_id) : item;
  if (!target) return;
  const src = sourceForItem(target);
  if (!src) return;
  const c = creds(src);
  try {
    if (target.type === 'movie' && !target.metadata_fetched_at) {
      const info = await xt.vodInfo(c, target.remote_ref);
      const i = info?.info ?? {};
      const bd = Array.isArray(i.backdrop_path) ? i.backdrop_path[0] : i.backdrop_path;
      const people = [
        ...String(i.cast ?? i.actors ?? '').split(',').map((n) => n.trim()).filter(Boolean).slice(0, 15).map((name) => ({ name, role: null, kind: 'actor', imageUrl: null })),
        ...String(i.director ?? '').split(',').map((n) => n.trim()).filter(Boolean).map((name) => ({ name, role: null, kind: 'director', imageUrl: null })),
      ];
      const genres = String(i.genre ?? '').split(/[,/]/).map((g) => g.trim()).filter(Boolean);
      const rel = i.releasedate ?? i.release_date ?? null;
      db.update('items', target.id, {
        overview: i.plot ?? i.description ?? target.overview, backdrop: bd ? registerImage(bd) : target.backdrop,
        poster: target.poster ?? registerImage(i.movie_image ?? i.cover_big ?? null), duration_ms: i.duration_secs ? i.duration_secs * 1000 : target.duration_ms,
        people: people.length ? JSON.stringify(people) : target.people, genres: genres.length ? JSON.stringify([...new Set([...parseJson<string[]>(target.genres, []), ...genres])]) : target.genres,
        release_date: rel, year: target.year ?? (rel ? parseInt(rel, 10) || null : null), content_rating: i.mpaa_rating || i.age || null,
        trailer_url: i.youtube_trailer ? `https://www.youtube.com/watch?v=${i.youtube_trailer}` : null, original_title: i.o_name && i.o_name !== target.title ? i.o_name : null,
        metadata_fetched_at: nowIso(),
      });
      if (i.duration_secs) db.run('UPDATE media SET duration_ms = ? WHERE item_id = ?', i.duration_secs * 1000, target.id);
    } else if (target.type === 'show') {
      const extra = parseJson<{ stale?: boolean }>(target.extra, {});
      const hasSeasons = db.get('SELECT 1 FROM items WHERE parent_id = ?', target.id);
      if (hasSeasons && !extra.stale && target.metadata_fetched_at) return;
      const info = await xt.seriesInfo(c, target.remote_ref);
      const eps = info?.episodes ? (Array.isArray(info.episodes) ? info.episodes.flat() : Object.values(info.episodes).flat()) : [];
      const now = nowIso();
      db.tx(() => {
        const seasonNums = [...new Set(eps.map((e) => Number(e.season) || 1))].sort((a, b) => a - b);
        for (const sn of seasonNums) {
          const sid = stableId(target.id, 'season', sn);
          const meta = info.seasons?.find((s) => Number(s.season_number) === sn);
          const fields = { library_id: target.library_id, type: 'season', title: meta?.name && !/^season \d+$/i.test(meta.name) ? meta.name : `Season ${sn}`, idx: sn, parent_id: target.id, poster: registerImage(meta?.cover_big || meta?.cover || null), overview: meta?.overview || null };
          if (db.get('SELECT 1 FROM items WHERE id = ?', sid)) db.update('items', sid, { ...fields, updated_at: now });
          else db.insert('items', { id: sid, ...fields, sort_title: fields.title.toLowerCase(), added_at: now, updated_at: now });
        }
        for (const e of eps) {
          const sn = Number(e.season) || 1;
          const sid = stableId(target.id, 'season', sn);
          const eid = stableId(sid, 'xep', e.id);
          const en = Number(e.episode_num) || null;
          const title = (e.title ?? '').replace(new RegExp(`^${(target.title as string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*-\\s*`, 'i'), '').replace(/^S\d+E\d+\s*-?\s*/i, '').trim() || `Episode ${en ?? ''}`;
          const fields = {
            library_id: target.library_id, type: 'episode', title, sort_title: sortTitle(title), idx: en, parent_idx: sn, parent_id: sid, grandparent_id: target.id,
            overview: e.info?.plot || null, thumb: registerImage(e.info?.movie_image || null), duration_ms: e.info?.duration_secs ? e.info.duration_secs * 1000 : null,
            release_date: e.info?.releasedate || e.info?.air_date || null, community_rating: e.info?.rating ? Number(e.info.rating) || null : null, remote_ref: String(e.id),
          };
          if (db.get('SELECT 1 FROM items WHERE id = ?', eid)) db.update('items', eid, { ...fields, updated_at: now });
          else db.insert('items', { id: eid, ...fields, added_at: now, updated_at: now });
          db.upsert('media', { id: stableId('xmedia', eid), item_id: eid, path: null, remote_url: xt.episodeUrl(c, e.id, e.container_extension || 'mp4'), container: (e.container_extension || 'mp4').toLowerCase(), duration_ms: fields.duration_ms });
        }
        db.update('items', target.id, { metadata_fetched_at: now, extra: JSON.stringify({ ...extra, stale: false }) });
      });
    }
  } catch (e) {
    log.warn(`Could not load IPTV details for ${target.title}: ${(e as Error).message}`);
  }
}

/* ---------------------------- channels/EPG -------------------------- */

export function listCategories(user: User, sourceId?: string): ChannelCategory[] {
  assertLive(user);
  const rows = db.all(
    `SELECT cat.*, (SELECT COUNT(*) FROM channels c WHERE c.category_id = cat.id AND c.hidden = 0) n FROM channel_categories cat JOIN live_sources s ON s.id = cat.source_id
     WHERE s.enabled = 1 AND cat.kind = 'live' ${sourceId ? 'AND cat.source_id = ?' : ''} ${user.isAdmin ? '' : 'AND cat.hidden = 0'} ORDER BY s.name, cat.sort_order, cat.name`,
    ...(sourceId ? [sourceId] : []));
  return rows.map((r) => ({ id: r.id, sourceId: r.source_id, name: r.name, channelCount: r.n, hidden: !!r.hidden, sortOrder: r.sort_order }));
}

export function updateCategory(id: string, patch: { hidden?: boolean; sortOrder?: number; name?: string }): ChannelCategory {
  const r = db.get('SELECT * FROM channel_categories WHERE id = ?', id);
  if (!r) throw notFound('Category not found');
  const p: Row = {};
  if (patch.hidden !== undefined) p.hidden = patch.hidden;
  if (patch.sortOrder !== undefined) p.sort_order = patch.sortOrder;
  if (patch.name) p.name = patch.name;
  db.update('channel_categories', id, p);
  const n = db.get<{ n: number }>('SELECT COUNT(*) n FROM channels WHERE category_id = ?', id)!.n;
  const u = db.get('SELECT * FROM channel_categories WHERE id = ?', id)!;
  return { id, sourceId: u.source_id, name: u.name, channelCount: n, hidden: !!u.hidden, sortOrder: u.sort_order };
}

function channelWhere(user: User, q: ChannelQuery & { favorite?: boolean | string }): { sql: string; params: any[] } {
  const where = ['s.enabled = 1'];
  const params: any[] = [];
  if (!user.isAdmin) where.push('c.hidden = 0', 'COALESCE((SELECT hidden FROM channel_categories x WHERE x.id = c.category_id), 0) = 0');
  if (q.sourceId) where.push('c.source_id = ?'), params.push(q.sourceId);
  if (q.categoryId) where.push('c.category_id = ?'), params.push(q.categoryId);
  if (q.search) where.push('c.name LIKE ?'), params.push(`%${q.search}%`);
  if (String(q.favorite) === 'true') where.push('EXISTS (SELECT 1 FROM channel_favorites f WHERE f.channel_id = c.id AND f.user_id = ?)'), params.push(user.id);
  return { sql: where.join(' AND '), params };
}

export function listChannels(user: User, q: ChannelQuery & { favorite?: boolean | string }): Paged<Channel> {
  assertLive(user);
  const limit = toInt(q.limit, 200, 1, 2000);
  const offset = toInt(q.offset, 0, 0);
  const w = channelWhere(user, q);
  const total = db.get<{ n: number }>(`SELECT COUNT(*) n FROM channels c JOIN live_sources s ON s.id = c.source_id WHERE ${w.sql}`, ...w.params)!.n;
  const rows = db.all(`${CHANNEL_SELECT} WHERE ${w.sql} ORDER BY COALESCE(json_extract(c.custom,'$.number'), c.number), c.sort_order LIMIT ? OFFSET ?`, user.id, ...w.params, limit, offset);
  const items = rows.map(toChannel);
  if (String(q.withEpg) !== 'false') attachNowNext(items, rows);
  return { items, total, limit, offset };
}

export function getChannel(user: User, id: string): Channel {
  assertLive(user);
  const r = db.get(`${CHANNEL_SELECT} WHERE c.id = ?`, user.id, id);
  if (!r) throw notFound('Channel not found');
  const c = toChannel(r);
  attachNowNext([c], [r]);
  return c;
}

export function updateChannel(id: string, patch: { number?: number; name?: string; hidden?: boolean; epgChannelId?: string; logoUrl?: string }): void {
  const r = db.get('SELECT * FROM channels WHERE id = ?', id);
  if (!r) throw notFound('Channel not found');
  const custom = parseJson<Record<string, unknown>>(r.custom, {});
  if (patch.number !== undefined) custom.number = patch.number;
  if (patch.name !== undefined) custom.name = patch.name || undefined;
  if (patch.epgChannelId !== undefined) custom.epgChannelId = patch.epgChannelId || undefined;
  if (patch.logoUrl !== undefined) custom.logo = patch.logoUrl || undefined;
  db.run('UPDATE channels SET custom = ?, hidden = ? WHERE id = ?', JSON.stringify(custom), patch.hidden ?? r.hidden, id);
}

export function setChannelFavorite(user: User, id: string, fav: boolean) {
  if (!db.get('SELECT 1 FROM channels WHERE id = ?', id)) throw notFound('Channel not found');
  if (fav) db.run('INSERT OR IGNORE INTO channel_favorites (user_id, channel_id) VALUES (?, ?)', user.id, id);
  else db.run('DELETE FROM channel_favorites WHERE user_id = ? AND channel_id = ?', user.id, id);
  return { favorite: fav };
}

function recordingMap(ids: string[]): Map<string, string> {
  if (!ids.length) return new Map();
  const rows = db.all<{ id: string; program_id: string }>(`SELECT id, program_id FROM recordings WHERE program_id IN (${ids.map(() => '?').join(',')}) AND status IN ('scheduled','recording','completed')`, ...ids);
  return new Map(rows.map((r) => [r.program_id, r.id]));
}

export function channelPrograms(user: User, id: string, start?: string, end?: string): Program[] {
  assertLive(user);
  const r = db.get('SELECT * FROM channels WHERE id = ?', id);
  if (!r) throw notFound('Channel not found');
  const epg = effEpg(r);
  if (!epg) return [];
  const s = start ?? new Date(Date.now() - 3 * 3600000).toISOString();
  const e = end ?? new Date(Date.now() + 24 * 3600000).toISOString();
  const rows = db.all('SELECT * FROM programs WHERE epg_channel_id = ? AND end > ? AND start < ? ORDER BY start', epg, s, e);
  const recs = recordingMap(rows.map((x) => x.id));
  return rows.map((p) => ({ ...toProgram(p, id), recordingId: recs.get(p.id) ?? null }));
}

export function guide(user: User, q: { start?: string; end?: string; categoryId?: string; favorite?: string; offset?: number; limit?: number; sourceId?: string }): GuideResponse {
  assertLive(user);
  const start = q.start ? new Date(q.start) : new Date(Date.now() - 30 * 60000);
  const end = q.end ? new Date(q.end) : new Date(start.getTime() + 6.5 * 3600000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw badRequest('Invalid time range');
  if (end.getTime() - start.getTime() > 3 * 86400000) throw badRequest('Guide window too large (max 3 days)');
  const ch = listChannels(user, { categoryId: q.categoryId, favorite: q.favorite as any, offset: q.offset, limit: q.limit ?? 300, withEpg: false, sourceId: q.sourceId });
  const epgByChannel = new Map<string, string>();
  for (const c of ch.items) if (c.epgChannelId) epgByChannel.set(c.id, c.epgChannelId);
  const epgIds = [...new Set(epgByChannel.values())];
  const programs: Program[] = [];
  if (epgIds.length) {
    const rows = db.all(`SELECT * FROM programs WHERE epg_channel_id IN (${epgIds.map(() => '?').join(',')}) AND end > ? AND start < ? ORDER BY start`, ...epgIds, start.toISOString(), end.toISOString());
    const byEpg = new Map<string, Row[]>();
    for (const r of rows) (byEpg.get(r.epg_channel_id) ?? byEpg.set(r.epg_channel_id, []).get(r.epg_channel_id)!).push(r);
    const recs = recordingMap(rows.map((r) => r.id));
    for (const c of ch.items) {
      for (const r of byEpg.get(epgByChannel.get(c.id) ?? '') ?? []) programs.push({ ...toProgram(r, c.id), recordingId: recs.get(r.id) ?? null });
    }
  }
  return { start: start.toISOString(), end: end.toISOString(), channels: ch.items, programs };
}

export function searchLive(user: User, q: string, limit = 20): { channels: Channel[]; programs: Program[] } {
  if (!getBranding().features.liveTv || (!user.allowLiveTv && !user.isAdmin)) return { channels: [], programs: [] };
  const channels = listChannels(user, { search: q, limit }).items;
  const now = nowIso();
  const rows = db.all(
    `SELECT p.*, c.id cid FROM programs p JOIN channels c ON COALESCE(json_extract(c.custom,'$.epgChannelId'), c.epg_channel_id) = p.epg_channel_id JOIN live_sources s ON s.id = c.source_id
     WHERE s.enabled = 1 AND c.hidden = 0 AND p.title LIKE ? AND p.end > ? GROUP BY p.id ORDER BY p.start LIMIT ?`, `%${q}%`, now, limit);
  return { channels, programs: rows.map((r) => toProgram(r, r.cid)) };
}

/* ------------------------------ playback ---------------------------- */

interface SharedLive {
  job: TranscodeJob;
  refs: number;
  sourceId: string;
}
/** Tuner sharing: one upstream connection per channel, shared by every viewer. */
const sharedLive = new Map<string, SharedLive>();
const upstreamCounts = new Map<string, number>();

export const activeUpstreams = (sourceId: string) => (upstreamCounts.get(sourceId) ?? 0) + [...sharedLive.values()].filter((s) => s.sourceId === sourceId).length;

function checkConnectionLimit(src: Row) {
  const max = src.max_connections;
  if (max && activeUpstreams(src.id) >= max) {
    throw new HttpError(503, `All ${max} connection(s) to "${src.name}" are in use. Stop another live stream and try again.`, 'tuner_busy');
  }
}

export function channelStreamUrl(r: Row, catchup?: { start: Date; durationMin: number }): string {
  if (!catchup) return r.stream_url;
  const src = getSourceRow(r.source_id);
  if (src.type === 'xtream') return xt.timeshiftUrl(creds(src), r.remote_id, catchup.start, catchup.durationMin, sourceTimezones.get(src.id) ?? parseJson<any>(src.account_info, null)?.timezone ?? null);
  const custom = parseJson<Record<string, any>>(r.custom, {});
  const url = m3uCatchupUrl({ url: r.stream_url, catchup: custom.catchup ?? null, catchupSource: custom.catchupSource ?? null }, catchup.start, catchup.durationMin);
  if (!url || !isSafeRemoteUrl(url)) throw badRequest('This channel does not support catch-up');
  return url;
}

export function channelUserAgent(r: Row): string {
  const custom = parseJson<Record<string, any>>(r.custom, {});
  const src = db.get<{ user_agent: string | null }>('SELECT user_agent FROM live_sources WHERE id = ?', r.source_id);
  return custom.userAgent || src?.user_agent || 'MediaMax/1.0';
}

export async function playChannel(ctx: AuthContext, channelId: string, req: LivePlayRequest & { deviceProfile?: { containers?: string[] } }, remoteAddr: string | null): Promise<PlaybackInfo> {
  assertLive(ctx.user);
  const r = db.get('SELECT * FROM channels WHERE id = ?', channelId);
  if (!r) throw notFound('Channel not found');
  const src = getSourceRow(r.source_id);
  const channel = getChannel(ctx.user, channelId);
  let catchup: { start: Date; durationMin: number } | undefined;
  if (req.catchupStart) {
    if (!r.has_archive) throw badRequest('This channel does not support catch-up');
    const st = new Date(req.catchupStart);
    if (Number.isNaN(st.getTime()) || st.getTime() > Date.now()) throw badRequest('Invalid catch-up start time');
    catchup = { start: st, durationMin: req.catchupDurationMin ?? Math.max(30, Math.ceil((Date.now() - st.getTime()) / 60000)) };
  }
  const upstream = channelStreamUrl(r, catchup);
  const q = `?token=${encodeURIComponent(ctx.token)}`;
  const wantsTs = !req.forceHls && (req.deviceProfile?.containers ?? []).map((c) => c.toLowerCase()).includes('ts');
  const isUpstreamHls = /\.m3u8(\?|$)/i.test(upstream);
  const now = channel.nowPlaying;
  const base = {
    ctx, itemId: null, channelId, mediaId: null, title: channel.name, subtitle: catchup ? `Catch-up · ${catchup.start.toLocaleString()}` : now?.title ?? null,
    posterUrl: channel.logoUrl, durationMs: catchup ? catchup.durationMin * 60000 : null, remoteAddr,
  };
  const info = (session: PlaySession, url: string, mimeType: string, isHls: boolean): PlaybackInfo => ({
    sessionId: session.id, itemId: null, channelId, method: 'live', url, mimeType, isHls, startMs: 0, streamStartMs: 0, durationMs: base.durationMs,
    audioStreams: [], subtitles: [], markers: [], nextItemId: null, title: channel.name, subtitle: base.subtitle, posterUrl: channel.logoUrl, backdropUrl: null,
  });

  // 1) Provider HLS, not proxied: hand the URL straight to the client.
  if (!src.proxy_streams && isUpstreamHls) {
    const s = registerSession({ ...base, method: 'live', job: null });
    return info(s, upstream, 'application/x-mpegURL', true);
  }
  // 2) MPEG-TS for clients that can play it (VLC/ExoPlayer/mpegts.js): proxy or direct.
  if (wantsTs && !isUpstreamHls) {
    if (!src.proxy_streams) {
      const s = registerSession({ ...base, method: 'live', job: null });
      return info(s, upstream, 'video/mp2t', false);
    }
    checkConnectionLimit(src);
    const s = registerSession({ ...base, method: 'live', job: null });
    const extra = catchup ? `&catchupStart=${encodeURIComponent(catchup.start.toISOString())}&duration=${catchup.durationMin}` : '';
    return info(s, `/api/v1/livetv/stream/${channelId}${q}&session=${s.id}${extra}`, 'video/mp2t', false);
  }
  // 3) Remux to HLS (shared between viewers of the same live channel).
  const key = catchup ? `${channelId}@${catchup.start.getTime()}@${ctx.deviceRowId}` : channelId;
  let shared = sharedLive.get(key);
  if (!shared) {
    checkConnectionLimit(src);
    const job = new TranscodeJob(newId(), {
      input: upstream, inputArgs: ['-user_agent', channelUserAgent(r)], startSec: 0, durationSec: null, mode: 'live',
      audioIndex: null, audioCopy: false, videoCopy: true, bitrate: 8000, maxHeight: null, sourceHeight: null, sourceCodec: null, hdr: false, hasVideo: true,
    });
    job.start(0);
    shared = { job, refs: 0, sourceId: src.id };
    sharedLive.set(key, shared);
    try {
      await job.waitForPlaylist(30000);
    } catch (e) {
      sharedLive.delete(key);
      job.stop();
      throw new HttpError(502, `The channel did not start: ${(e as Error).message}`, 'stream_failed');
    }
  }
  shared.refs++;
  const sh = shared;
  const s = registerSession({
    ...base, method: 'live', job: null,
    onStop: () => {
      sh.refs--;
      if (sh.refs <= 0) {
        // Keep the tuner warm briefly so channel-flipping back is instant.
        setTimeout(() => {
          if (sh.refs <= 0 && sharedLive.get(key) === sh) {
            sharedLive.delete(key);
            sh.job.stop();
          }
        }, 15000);
      }
    },
  });
  liveJobBySession.set(s.id, sh.job);
  return info(s, `/api/v1/livetv/hls/${s.id}/index.m3u8${q}`, 'application/x-mpegURL', true);
}

export const liveJobBySession = new Map<string, TranscodeJob>();
bus.on('playback.stop', (s: PlaySession) => liveJobBySession.delete(s.id));

export function trackUpstream(sourceId: string, delta: number) {
  upstreamCounts.set(sourceId, Math.max(0, (upstreamCounts.get(sourceId) ?? 0) + delta));
}

/* ------------------------------ home hooks -------------------------- */

homeHooks.liveRow = (user, cfg): HomeRow | null => {
  if (!getBranding().features.liveTv || (!user.allowLiveTv && !user.isAdmin)) return null;
  if (!db.get('SELECT 1 FROM channels LIMIT 1')) return null;
  const favs = listChannels(user, { favorite: true as any, limit: cfg.limit ?? 20 }).items;
  let channels = favs;
  if (cfg.type === 'live-now' && channels.length < 4) {
    const more = listChannels(user, { limit: (cfg.limit ?? 20) * 3 }).items.filter((c) => c.nowPlaying && !favs.some((f) => f.id === c.id));
    channels = [...favs, ...more].slice(0, cfg.limit ?? 20);
  }
  if (!channels.length) return null;
  return { id: cfg.id, type: cfg.type, title: cfg.title ?? 'On Now', items: [], channels };
};

/* ------------------------------ scheduling -------------------------- */

export async function refreshDueSources() {
  const epgHours = getSettings().epgRefreshHours;
  for (const s of db.all('SELECT * FROM live_sources WHERE enabled = 1')) {
    const last = s.last_refresh_at ? Date.parse(s.last_refresh_at) : 0;
    const hours = Math.min(s.refresh_hours || 12, epgHours || 12);
    if (Date.now() - last > hours * 3600000) await refreshSource(s.id);
  }
}

bus.on('iptv.refreshLibrary', (sourceId: string) => {
  if (sourceId) void refreshSource(sourceId);
});

export function pruneOldPrograms() {
  db.run('DELETE FROM programs WHERE end < ?', new Date(Date.now() - 8 * 86400000).toISOString());
}

export { stopSession };
