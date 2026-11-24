import type {
  Channel, ChannelCategory, ChannelQuery, CreateLiveSourceRequest, GuideResponse, HomeRow, LivePlayRequest, LiveSource, Paged,
  PlaybackInfo, Program, TestSourceResponse, UpdateLiveSourceRequest, User, XtreamAccountInfo,
} from '@mediamax/shared';
import { db, type Row } from '../../db.js';
import { newId, stableId } from '../../util/ids.js';
import { HttpError, badRequest, forbidden, notFound } from '../../util/errors.js';
import { nowIso, parseJson, sortTitle, toInt, isSafeRemoteUrl } from '../../util/misc.js';
import { logger } from '../../util/log.js';
import { registerRemoteImage, imageUrl } from '../images.js';
import { getBranding } from '../branding.js';
import { getSettings } from '../settings.js';
import { events, bus } from '../events.js';
import { logActivity } from '../activity.js';
import { homeHooks } from '../items.js';
import { TranscodeJob } from '../transcoder.js';
import { assertCanStartSession, registerSession, stopSession, type PlaySession } from '../playback.js';
import { liveDetails, type ClientHints } from '../sessionDetails.js';
import { isLocalAddress } from '../dlna.js';
import type { AuthContext } from '../auth.js';
import * as xt from './xtream.js';
import { parseM3u, m3uCatchupUrl } from './m3u.js';
import * as epg from './epg/epg.js';
import * as tuners from './tuners/index.js';
import { Readable } from 'node:stream';

const log = logger('livetv');

/* ------------------------------ mapping ----------------------------- */

function toSource(r: Row): LiveSource {
  const tuner = tuners.isTunerType(r.type);
  const device = tuner ? parseJson<(LiveSource['deviceInfo'] & { tunerCount?: number | null }) | null>(r.account_info, null) : null;
  return {
    id: r.id, name: r.name, type: r.type, url: r.url, username: r.username ?? null, password: r.password ? '••••••••' : null,
    epgUrl: r.epg_url ?? null, enabled: !!r.enabled, proxyStreams: !!r.proxy_streams, importVod: !!r.import_vod, importSeries: !!r.import_series,
    userAgent: r.user_agent ?? null, refreshIntervalHours: r.refresh_hours, maxConnections: r.max_connections ?? null,
    lastRefreshAt: r.last_refresh_at ?? null, lastError: r.last_error ?? null,
    channelCount: db.get<{ n: number }>('SELECT COUNT(*) n FROM channels WHERE source_id = ?', r.id)!.n,
    accountInfo: tuner ? null : parseJson<XtreamAccountInfo | null>(r.account_info, null),
    ...(tuner ? {
      options: parseJson<tuners.TunerOptions>(r.options, {}), tunerCount: device?.tunerCount ?? null,
      deviceInfo: device ? { name: device.name, model: device.model, version: device.version, tuners: device.tuners ?? [] } : null,
    } : {}),
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
    logoUrl: imageUrl(custom.logo ? registerRemoteImage(custom.logo) : r.logo), categoryId: r.category_id ?? null, categoryName: r.cat_name ?? null,
    hasArchive: !!r.has_archive, archiveDays: r.archive_days ?? 0, favorite: !!r.fav, hidden: !!r.hidden,
    epgChannelId: r.guide_status != null ? (r.guide_key ? r.guide_channel_id ?? null : null) : custom.epgChannelId ?? r.epg_channel_id ?? null,
    epgSourceId: r.guide_key ? r.guide_source_id ?? null : null, guideStatus: r.guide_status ?? null, epgOffsetHours: (r.guide_offset ?? 0) / 60,
  };
}

const effEpg = epg.effEpg;

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
  if (req.type && !['xtream', 'm3u', 'hdhomerun', ...tuners.TUNER_TYPES].includes(req.type)) throw badRequest('Unknown source type');
  if (req.url !== undefined && !/^https?:\/\/|^[\w.-]+(:\d+)?/.test(req.url)) throw badRequest('Invalid URL');
  if (req.epgUrl) {
    const urls = splitEpgUrls(req.epgUrl);
    if (urls.length > 10) throw badRequest('At most 10 EPG URLs per source');
    for (const u of urls) if (!/^https?:\/\//i.test(u)) throw badRequest(`Invalid EPG URL: ${u.slice(0, 80)}`);
  }
}

/** A source's EPG field may hold several XMLTV URLs (comma- or newline-separated), in priority order. */
export const splitEpgUrls = (v: string | null | undefined) => [...new Set((v ?? '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean))];
const normEpg = (v: string | null | undefined) => splitEpgUrls(v).join('\n') || null;

export function createSource(req: CreateLiveSourceRequest): LiveSource {
  validateSource(req);
  if (!req.name || !req.url) throw badRequest('Name and URL are required');
  if (req.type === 'xtream' && (!req.username || !req.password)) throw badRequest('Xtream sources need a username and password');
  const tuner = tuners.isTunerType(req.type);
  const options = tuner ? tunerOptions(req.type, req.options) : {};
  const id = newId();
  db.insert('live_sources', {
    id, name: req.name.trim(), type: req.type, url: req.type === 'xtream' ? xt.normalizeBase(req.url) : req.url.trim(), username: req.username || null, password: req.password || null,
    // Tuner streams carry device credentials / RTSP: always through the server.
    epg_url: normEpg(req.epgUrl), enabled: req.enabled ?? true, proxy_streams: tuner ? true : req.proxyStreams ?? true, import_vod: req.importVod ?? req.type === 'xtream',
    import_series: req.importSeries ?? req.type === 'xtream', user_agent: req.userAgent || null, refresh_hours: req.refreshIntervalHours ?? 12, created_at: nowIso(),
    options: JSON.stringify(options),
  });
  logActivity('livetv.source', `Live TV source "${req.name}" added`);
  epg.syncLegacyGuides(id);
  void refreshSource(id);
  return toSource(getSourceRow(id));
}

export function updateSource(id: string, req: UpdateLiveSourceRequest): LiveSource {
  validateSource(req);
  const cur = getSourceRow(id);
  const patch: Row = {};
  const tuner = tuners.isTunerType(cur.type);
  if (req.type !== undefined && req.type !== cur.type) throw badRequest('The source type cannot be changed; add a new source instead');
  if (tuner && req.options !== undefined) patch.options = JSON.stringify(tunerOptions(cur.type, req.options, parseJson(cur.options, {})));
  if (req.name !== undefined) patch.name = req.name.trim();
  if (req.url !== undefined) patch.url = req.url.trim();
  if (req.username !== undefined) patch.username = req.username;
  if (req.password !== undefined && req.password !== '••••••••') patch.password = req.password;
  if (req.epgUrl !== undefined) patch.epg_url = normEpg(req.epgUrl);
  if (req.enabled !== undefined) patch.enabled = req.enabled;
  if (req.proxyStreams !== undefined && !tuner) patch.proxy_streams = req.proxyStreams;
  if (req.importVod !== undefined) patch.import_vod = req.importVod;
  if (req.importSeries !== undefined) patch.import_series = req.importSeries;
  if (req.userAgent !== undefined) patch.user_agent = req.userAgent || null;
  if (req.refreshIntervalHours !== undefined) patch.refresh_hours = Math.max(1, req.refreshIntervalHours);
  db.update('live_sources', id, patch);
  if (patch.epg_url !== undefined || patch.name !== undefined) epg.syncLegacyGuides(id);
  if (patch.url || patch.username || patch.password || patch.options !== undefined || patch.import_vod !== undefined || patch.import_series !== undefined || patch.epg_url !== undefined) void refreshSource(id);
  return toSource(getSourceRow(id));
}

export function deleteSource(id: string) {
  getSourceRow(id);
  db.tx(() => {
    epg.beforeLiveSourceDelete(id);
    db.run('DELETE FROM programs WHERE source_id = ?', id);
    db.run('DELETE FROM libraries WHERE source_id = ?', id);
    db.run('DELETE FROM live_sources WHERE id = ?', id);
  });
}

function tunerOptions(type: string, o: tuners.TunerOptions | null | undefined, prev: tuners.TunerOptions = {}): tuners.TunerOptions {
  try {
    return tuners.cleanOptions(type, o, prev);
  } catch (e) {
    throw badRequest((e as Error).message);
  }
}

export async function testSource(req: CreateLiveSourceRequest): Promise<TestSourceResponse> {
  // Editing: a blank password means "the saved one".
  if (req.sourceId && (req.password == null || req.password === '' || req.password === '••••••••')) {
    const saved = db.get('SELECT password, username, options FROM live_sources WHERE id = ?', req.sourceId);
    if (saved) req = { ...req, password: saved.password, options: { ...parseJson<tuners.TunerOptions>(saved.options, {}), ...(req.options ?? {}) } };
  }
  if (tuners.isTunerType(req.type)) {
    let options: tuners.TunerOptions;
    try {
      options = tuners.cleanOptions(req.type, req.options);
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    const r = await tuners.testTuner({ type: req.type, url: req.url, username: req.username, password: req.password, userAgent: req.userAgent, options });
    return { ok: r.ok, message: r.message, liveCount: r.liveCount, tunerCount: r.tunerCount, deviceInfo: r.device ?? null, bouquets: r.bouquets, profiles: r.profiles, warnings: r.warnings };
  }
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
    const res = await fetch(req.url, { headers: { 'User-Agent': req.userAgent || 'Kinora/1.0' }, signal: AbortSignal.timeout(60000) });
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
        source_id: sourceId, remote_id: c.remoteId, number: c.number ?? i + 1, name: c.name, logo: registerRemoteImage(c.logo),
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
  let providerEpg: string[] = [];
  const driver = tuners.guideDriverFor(src.type);
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
        providerEpg = [xt.epgUrl(c)];
        if (src.import_vod) await importVod(src).catch((e) => log.warn(`VOD import failed for ${src.name}`, e.message));
        else db.run("DELETE FROM libraries WHERE source_id = ? AND type = 'iptv-movies'", id);
        if (src.import_series) await importSeries(src).catch((e) => log.warn(`Series import failed for ${src.name}`, e.message));
        else db.run("DELETE FROM libraries WHERE source_id = ? AND type = 'iptv-shows'", id);
      } else if (src.type === 'm3u') {
        const res = await fetch(src.url, { headers: { 'User-Agent': src.user_agent || 'Kinora/1.0' }, signal: AbortSignal.timeout(120000) });
        if (!res.ok) throw new Error(`Playlist download failed: HTTP ${res.status}`);
        const pl = parseM3u(await res.text());
        const groups = [...new Set(pl.entries.map((e) => e.group).filter(Boolean))] as string[];
        // A tvg-id identifies a channel only when it's unique in the playlist (counted once: playlists can be huge).
        const idCount = new Map<string, number>();
        for (const e of pl.entries) if (e.tvgId) idCount.set(e.tvgId, (idCount.get(e.tvgId) ?? 0) + 1);
        const remoteIdOf = (e: (typeof pl.entries)[number]) => (e.tvgId && idCount.get(e.tvgId) === 1 ? `id:${e.tvgId}` : `url:${e.url}`);
        syncChannels(id, groups.map((g) => ({ remoteId: g, name: g })), pl.entries.map((e, i) => ({
          remoteId: remoteIdOf(e),
          name: e.name, number: e.chno ?? i + 1, logo: e.logo, category: e.group, streamUrl: e.url,
          archive: !!(e.catchup || e.catchupSource), archiveDays: e.catchupDays || (e.catchup ? 7 : 0), epgId: e.tvgId || e.tvgName || null,
          custom: {}, // keep custom for admin overrides
        })));
        // Store catch-up templates for each channel.
        for (const e of pl.entries) {
          if (!e.catchup && !e.catchupSource && !e.userAgent) continue;
          const cid = stableId(id, 'ch', remoteIdOf(e));
          const row = db.get('SELECT custom FROM channels WHERE id = ?', cid);
          if (row) db.run('UPDATE channels SET custom = ? WHERE id = ?', JSON.stringify({ ...parseJson(row.custom, {}), catchup: e.catchup, catchupSource: e.catchupSource, userAgent: e.userAgent }), cid);
        }
        providerEpg = splitEpgUrls(pl.epgUrl);
      } else if (src.type === 'hdhomerun') {
        const lineup = await hdhrLineup(src.url);
        syncChannels(id, [{ remoteId: 'hd', name: 'HD' }, { remoteId: 'sd', name: 'SD' }], lineup.map((l) => ({
          remoteId: l.GuideNumber, name: l.GuideName, number: parseFloat(l.GuideNumber) || null, logo: null, category: l.HD ? 'hd' : 'sd',
          streamUrl: l.URL, archive: false, archiveDays: 0, epgId: l.GuideNumber,
        })));
      } else if (tuners.isTunerType(src.type)) {
        const r = await tuners.syncTuner(tuners.sourceIn(src));
        if (!r.channels.length) throw new Error('The device reported no channels');
        syncChannels(id, r.categories, r.channels.map((c) => ({ ...c, archive: false, archiveDays: 0 })));
        const limit = tuners.streamLimit(tuners.sourceIn(src), r.device.tunerCount);
        db.run('UPDATE live_sources SET account_info = ?, max_connections = ? WHERE id = ?', JSON.stringify(r.device), limit, id);
        for (const w of r.warnings) log.warn(`${src.name}: ${w}`);
      }
    }
    if (!opts.epgOnly) epg.afterChannelSync(id);
    // The source's EPG-URL guides and the provider's own guide (lowest priority) are guide sources too; see epg/epg.ts.
    if (opts.epgOnly && !providerEpg.length) {
      if (src.type === 'xtream') providerEpg = [xt.epgUrl(creds(src))];
      else providerEpg = splitEpgUrls(parseJson<{ urls?: string[] }>(db.get("SELECT config FROM epg_sources WHERE owner_source_id = ? AND managed_by = 'provider'", id)?.config, {}).urls?.join('\n'));
    }
    await epg.refreshLiveSourceGuides(id, driver ? { driver } : [...new Set(providerEpg)], src.user_agent);
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
          poster: registerRemoteImage(v.stream_icon || null), added_at: added, updated_at: now, remote_ref: String(v.stream_id),
          genres: JSON.stringify(genre ? [genre] : []), external_ids: JSON.stringify({ xtream: String(v.stream_id), ...(v.tmdb ? { tmdb: String(v.tmdb) } : {}) }),
        });
      } else if (!ex.metadata_fetched_at) {
        db.run('UPDATE items SET title = ?, sort_title = ?, poster = COALESCE(?, poster), community_rating = ? WHERE id = ?', title, sortTitle(title), registerRemoteImage(v.stream_icon || null), rating, id);
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
        community_rating: s.rating != null && s.rating !== '' ? Number(s.rating) || null : null, poster: registerRemoteImage(s.cover || null), backdrop: registerRemoteImage(backdrop || null),
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
        overview: i.plot ?? i.description ?? target.overview, backdrop: bd ? registerRemoteImage(bd) : target.backdrop,
        poster: target.poster ?? registerRemoteImage(i.movie_image ?? i.cover_big ?? null), duration_ms: i.duration_secs ? i.duration_secs * 1000 : target.duration_ms,
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
          const fields = { library_id: target.library_id, type: 'season', title: meta?.name && !/^season \d+$/i.test(meta.name) ? meta.name : `Season ${sn}`, idx: sn, parent_id: target.id, poster: registerRemoteImage(meta?.cover_big || meta?.cover || null), overview: meta?.overview || null };
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
            overview: e.info?.plot || null, thumb: registerRemoteImage(e.info?.movie_image || null), duration_ms: e.info?.duration_secs ? e.info.duration_secs * 1000 : null,
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
  if (user.isAdmin && String(q.guideStatus) === 'true') {
    const has = epg.channelsWithGuide(items.map((c) => c.id));
    for (const c of items) c.hasGuide = has.has(c.id);
  }
  return { items, total, limit, offset };
}

/** A channel row the user may access (hidden channels/categories and disabled sources excluded for non-admins). */
export function accessibleChannelRow(user: User, id: string): Row {
  assertLive(user);
  const w = channelWhere(user, {});
  const r = db.get(`SELECT c.* FROM channels c JOIN live_sources s ON s.id = c.source_id WHERE c.id = ? AND ${w.sql}`, id, ...w.params);
  if (!r) throw notFound('Channel not found');
  return r;
}

export function getChannel(user: User, id: string): Channel {
  accessibleChannelRow(user, id);
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
  if (patch.epgChannelId !== undefined) {
    // A bare guide id (older API): resolved against the guides by priority. PUT /livetv/channels/:id/match picks a guide too.
    delete custom.epgSourceId;
    delete custom.epgNone;
  }
  db.run('UPDATE channels SET custom = ?, hidden = ? WHERE id = ?', JSON.stringify(custom), patch.hidden ?? r.hidden, id);
  if (patch.epgChannelId !== undefined) epg.resolveMatches([id]);
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
  const r = accessibleChannelRow(user, id);
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
  // Programme keys: the channel's matched guide (with time shift), not the display id.
  const epgByChannel = new Map<string, string>();
  const ids = ch.items.map((c) => c.id);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of db.all(`SELECT id, custom, epg_channel_id, guide_status, guide_key FROM channels WHERE id IN (${chunk.map(() => '?').join(',')})`, ...chunk)) {
      const k = effEpg(r);
      if (k) epgByChannel.set(r.id, k);
    }
  }
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
    `SELECT p.*, MIN(c.id) cid FROM programs p JOIN channels c ON (${epg.EFF_EPG_SQL}) = p.epg_channel_id JOIN live_sources s ON s.id = c.source_id
     WHERE s.enabled = 1 AND c.hidden = 0 AND COALESCE((SELECT hidden FROM channel_categories x WHERE x.id = c.category_id), 0) = 0 AND p.title LIKE ? AND p.end > ? GROUP BY p.id ORDER BY p.start, p.id LIMIT ?`, `%${q}%`, now, limit);
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

/** The channel's shared job, dropping one whose ffmpeg has stopped (upstream dropped): nothing restarts it, so the next viewer gets a fresh one. */
function liveShared(key: string): SharedLive | undefined {
  const sh = sharedLive.get(key);
  if (sh && (sh.job.exited || sh.job.failed)) {
    sharedLive.delete(key);
    // Viewers still on it stop it when they leave (onStop); with none left it goes now.
    if (sh.refs <= 0) sh.job.stop();
    return undefined;
  }
  return sh;
}

export const activeUpstreams = (sourceId: string) => (upstreamCounts.get(sourceId) ?? 0) + [...sharedLive.keys()].filter((k) => liveShared(k)?.sourceId === sourceId).length;

/** Transcode job ids (directories) of live remuxes in use: shared channel jobs and the jobs viewers still hold. */
export const liveJobIds = (): string[] => [...new Set([...[...sharedLive.values()].map((s) => s.job.id), ...[...liveJobBySession.values()].map((j) => j.id)])];

export function checkConnectionLimit(src: Row) {
  const max = src.max_connections;
  if (max && activeUpstreams(src.id) >= max) {
    throw new HttpError(503, `All ${max} connection(s) to "${src.name}" are in use. Stop another live stream and try again.`, 'tuner_busy');
  }
}

export function channelStreamUrl(r: Row, catchup?: { start: Date; durationMin: number }): string {
  if (!catchup) {
    const s = db.get('SELECT * FROM live_sources WHERE id = ?', r.source_id);
    return s && tuners.isTunerType(s.type) ? tuners.tunerStreamUrl(s, r.stream_url) : r.stream_url;
  }
  const src = getSourceRow(r.source_id);
  if (src.type === 'xtream') return xt.timeshiftUrl(creds(src), r.remote_id, catchup.start, catchup.durationMin, sourceTimezones.get(src.id) ?? parseJson<any>(src.account_info, null)?.timezone ?? null);
  const custom = parseJson<Record<string, any>>(r.custom, {});
  const url = m3uCatchupUrl({ url: r.stream_url, catchup: custom.catchup ?? null, catchupSource: custom.catchupSource ?? null }, catchup.start, catchup.durationMin);
  if (!url || !isSafeRemoteUrl(url)) throw badRequest('This channel does not support catch-up');
  return url;
}

/** FFmpeg input options for a channel's upstream (User-Agent; RTSP transport for SAT>IP). */
export function channelInputArgs(r: Row, url: string = r.stream_url): string[] {
  const s = db.get('SELECT * FROM live_sources WHERE id = ?', r.source_id);
  return [...(s ? tuners.tunerInputArgs(s, url) : []), '-user_agent', channelUserAgent(r)];
}

/**
 * Open a channel's upstream as an MPEG-TS byte stream for the restream endpoint: plain fetch for IPTV, the
 * authenticating client for tuner boxes, an FFmpeg remux for RTSP (SAT>IP).
 */
export async function openChannelStream(r: Row, url: string, signal: AbortSignal): Promise<Readable> {
  const src = getSourceRow(r.source_id);
  if (tuners.isTunerType(src.type)) {
    try {
      return await tuners.openTunerStream(src, url, channelUserAgent(r), signal);
    } catch (e) {
      if (signal.aborted) throw e;
      throw new HttpError(502, (e as Error).message, 'stream_failed');
    }
  }
  const res = await fetch(url, { headers: { 'User-Agent': channelUserAgent(r) }, signal, redirect: 'follow' });
  if (!res.ok || !res.body) throw notFound(`Provider returned ${res.status}`);
  return Readable.fromWeb(res.body as any);
}

export function channelUserAgent(r: Row): string {
  const custom = parseJson<Record<string, any>>(r.custom, {});
  const src = db.get<{ user_agent: string | null }>('SELECT user_agent FROM live_sources WHERE id = ?', r.source_id);
  return custom.userAgent || src?.user_agent || 'Kinora/1.0';
}

export async function playChannel(ctx: AuthContext, channelId: string, req: LivePlayRequest & { deviceProfile?: { containers?: string[] } }, remoteAddr: string | null, hints?: ClientHints): Promise<PlaybackInfo> {
  const r = accessibleChannelRow(ctx.user, channelId);
  assertCanStartSession(ctx, remoteAddr, !!req.multiview && !req.catchupStart);
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
    posterUrl: channel.logoUrl, durationMs: catchup ? catchup.durationMin * 60000 : null, remoteAddr, multiview: !!req.multiview && !catchup,
  };
  const local = !!remoteAddr && isLocalAddress(remoteAddr);
  const srcContainer = isUpstreamHls ? 'HLS' : 'MPEG-TS';
  const det = (delivery: string, note?: string) => liveDetails(ctx.device.platform, ctx.device.appVersion, hints, local, { container: srcContainer, delivery, note });
  const info = (session: PlaySession, url: string, mimeType: string, isHls: boolean): PlaybackInfo => ({
    sessionId: session.id, itemId: null, channelId, method: 'live', url, mimeType, isHls, startMs: 0, streamStartMs: 0, durationMs: base.durationMs,
    audioStreams: [], subtitles: [], markers: [], nextItemId: null, title: channel.name, subtitle: base.subtitle, posterUrl: channel.logoUrl, backdropUrl: null,
  });

  // Tuner boxes are always restreamed (device credentials, RTSP).
  if (tuners.isTunerType(src.type)) src.proxy_streams = 1;
  // 1) Provider HLS, not proxied: hand the URL straight to the client.
  if (!src.proxy_streams && isUpstreamHls) {
    const s = registerSession({ ...base, method: 'live', job: null, details: det('Direct from provider') });
    return info(s, upstream, 'application/x-mpegURL', true);
  }
  // 2) MPEG-TS for clients that can play it (VLC/ExoPlayer/mpegts.js): proxy or direct.
  if (wantsTs && !isUpstreamHls) {
    if (!src.proxy_streams) {
      const s = registerSession({ ...base, method: 'live', job: null, details: det('Direct from provider') });
      return info(s, upstream, 'video/mp2t', false);
    }
    checkConnectionLimit(src);
    const s = registerSession({ ...base, method: 'live', job: null, details: det('MPEG-TS (proxied)', 'Restreamed through Kinora') });
    const extra = catchup ? `&catchupStart=${encodeURIComponent(catchup.start.toISOString())}&duration=${catchup.durationMin}` : '';
    return info(s, `/api/v1/livetv/stream/${channelId}${q}&session=${s.id}${extra}`, 'video/mp2t', false);
  }
  // 3) Remux to HLS (shared between viewers of the same live channel).
  const key = catchup ? `${channelId}@${catchup.start.getTime()}@${ctx.deviceRowId}` : channelId;
  let shared = liveShared(key);
  if (!shared) {
    checkConnectionLimit(src);
    const job = new TranscodeJob(newId(), {
      input: upstream, inputArgs: channelInputArgs(r, upstream), startSec: 0, durationSec: null, mode: 'live',
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
    ...base, method: 'live', job: null, details: det('HLS (remux)', 'Remuxed to HLS, shared with other viewers of this channel'),
    onStop: () => {
      sh.refs--;
      if (sh.refs <= 0 && sharedLive.get(key) !== sh) {
        // Dropped after its ffmpeg stopped (a fresh job serves the channel now): nothing to keep warm.
        sh.job.stop();
      } else if (sh.refs <= 0) {
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
  await epg.refreshDueGuides().catch((e) => log.warn(`Guide refresh failed: ${(e as Error).message}`));
}

bus.on('iptv.refreshLibrary', (sourceId: string) => {
  if (sourceId) void refreshSource(sourceId);
});

export function pruneOldPrograms() {
  db.run('DELETE FROM programs WHERE end < ?', new Date(Date.now() - 8 * 86400000).toISOString());
}

/** Tuner sources keep driver settings in live_sources.options (a migration adds it; this guards out-of-order schemas). */
function ensureOptionsColumn() {
  try {
    if (!db.all<{ name: string }>('PRAGMA table_info(live_sources)').some((c) => c.name === 'options')) db.exec("ALTER TABLE live_sources ADD COLUMN options TEXT NOT NULL DEFAULT '{}'");
  } catch (e) {
    log.warn(`live_sources.options: ${(e as Error).message}`);
  }
}
ensureOptionsColumn();
epg.initEpg();

/* ------------------------------ tuner extras ------------------------------ */

export const discoverTuners = () => tuners.discoverAll();

export async function tunerRecordings(sourceId: string) {
  const src = getSourceRow(sourceId);
  try {
    return await tuners.listRecordings(src);
  } catch (e) {
    throw new HttpError((e as { status?: number }).status === 404 ? 404 : 502, (e as Error).message, 'tuner_error');
  }
}

export async function openTunerRecording(sourceId: string, recId: string, signal: AbortSignal, range?: string) {
  const src = getSourceRow(sourceId);
  try {
    return await tuners.openRecording(src, recId, signal, range);
  } catch (e) {
    throw new HttpError((e as { status?: number }).status === 404 ? 404 : 502, (e as Error).message, 'tuner_error');
  }
}

export { stopSession };
