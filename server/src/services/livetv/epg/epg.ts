/**
 * TV guide (EPG) providers.
 *
 * Guide sources (`epg_sources`) are XMLTV URLs/files (incl. iptv-org / epg.pw presets), Schedules Direct accounts,
 * HDHomeRun tuners, plus two kinds managed by a live source: each URL in its `epgUrl` field, and the provider's own
 * guide (Xtream xmltv.php / M3U url-tvg). Every guide's programmes are stored under the key
 * `<epgSourceId>:<guideChannelId>`; channels point at one key (`channels.guide_key`), chosen by:
 *   manual match > highest-priority automatic match whose guide has data > other automatic matches.
 * Matches below the auto threshold are kept as suggestions for review. A per-channel time shift is served
 * from shifted copies (`sh:` rows) keyed `<key>#<minutes>`, so every reader (guide, DVR, search) sees it.
 */
import type {
  ChannelMatch, CreateEpgSourceRequest, EpgGuideChannel, EpgSource, EpgSourceConfig, EpgSourceReport, MatchingResponse, Program,
  SdHeadend, SdLineup, SdStatus, SetChannelMatchRequest, UpdateEpgSourceRequest,
} from '@mediamax/shared';
import { db, type Row } from '../../../db.js';
import { newId, stableId } from '../../../util/ids.js';
import { HttpError, badRequest, notFound } from '../../../util/errors.js';
import { nowIso, parseJson } from '../../../util/misc.js';
import { logger } from '../../../util/log.js';
import { logActivity } from '../../activity.js';
import { bus } from '../../events.js';
import { openXmltv, parseXmltvReadable, isValidTimezone } from '../xmltv.js';
import { AUTO_THRESHOLD, SUGGEST_THRESHOLD, GuideIndex, normalizeName, nameSimilarity, type GuideChannelIn, type MatchResult } from './matcher.js';
import { SdClient, SdError, sha1Hex, sdChannelNumber, sdEpisodeNum, pickArtwork, type SdAiring, type SdLineupDetail, type SdProgram } from './schedulesdirect.js';
import { deviceAuth, fetchHdhrGuide } from './hdhomerun.js';
import { findPreset } from './presets.js';

const log = logger('epg');

export const guideKey = (sourceId: string, channelId: string) => `${sourceId}:${channelId}`;
/** Guides with more channels than this only store programmes for channels that are (or may be) matched. */
const STORE_ALL_LIMIT = 3000;
const KEEP_BACK_MS = 8 * 86400000;
const KEEP_AHEAD_MS = 14 * 86400000;
const SD_MIN_HOURS = 12;
const SD_MANUAL_COOLDOWN_MS = 15 * 60000;

/** SQL for a channel's effective programme key (falls back to the pre-matching fields until first resolved). */
export const EFF_EPG_SQL = `CASE WHEN c.guide_status IS NOT NULL THEN c.guide_key ELSE COALESCE(json_extract(c.custom,'$.epgChannelId'), c.epg_channel_id) END`;
export function effEpg(r: Row): string | null {
  if (r.guide_status != null) return r.guide_key ?? null;
  return parseJson<Record<string, any>>(r.custom, {}).epgChannelId ?? r.epg_channel_id ?? null;
}

/* ------------------------------ mapping ------------------------------ */

const refreshing = new Map<string, Promise<void>>();

function report(r: Row, matched: Map<string, number>): EpgSourceReport {
  const st = parseJson<Record<string, any>>(r.stats, {});
  const maxEnd = st.maxEnd ? Date.parse(st.maxEnd) : 0;
  return {
    channels: r.channel_count ?? 0,
    programmes: st.programmes ?? 0,
    matchedChannels: matched.get(r.id) ?? 0,
    daysAhead: maxEnd > Date.now() ? Math.round(((maxEnd - Date.now()) / 86400000) * 10) / 10 : 0,
    lastDurationMs: st.durationMs ?? null,
    warnings: st.warnings ?? [],
  };
}

const redactUrl = (u: string) => u.replace(/(password|pass|token|key|username|user)=[^&]*/gi, '$1=***').replace(/\/\/[^/@]+@/, '//***@');

function publicConfig(r: Row): EpgSource['config'] {
  const c = parseJson<Record<string, any>>(r.config, {});
  const out: EpgSource['config'] = {};
  if (r.kind === 'xmltv' || r.kind === 'provider') {
    if (c.url) out.url = r.kind === 'provider' ? redactUrl(c.url) : c.url;
    if (c.urls) out.url = (c.urls as string[]).map(redactUrl).join('\n');
    if (c.path) out.path = c.path;
    if (c.preset) out.preset = c.preset;
    if (c.driver) out.url = `${c.driver === 'tvheadend' ? 'TVHeadend' : c.driver === 'enigma2' ? 'OpenWebif' : c.driver} EPG API`;
    if (c.timezone) out.timezone = c.timezone;
  } else if (r.kind === 'schedulesdirect') {
    out.username = c.username ?? null;
    out.hasPassword = !!r.secret;
    out.days = c.days ?? 7;
    out.artwork = !!c.artwork;
    out.lineups = parseJson<{ lineups?: SdLineup[] }>(r.state, {}).lineups ?? [];
  } else if (r.kind === 'hdhomerun') {
    out.liveSourceId = c.liveSourceId ?? null;
    out.deviceUrl = c.deviceUrl ?? null;
    out.days = c.days ?? 1;
  }
  return out;
}

function toEpgSource(r: Row, matched: Map<string, number>): EpgSource {
  return {
    id: r.id, name: r.name, kind: r.kind, config: publicConfig(r), priority: r.priority, enabled: !!r.enabled,
    liveSourceIds: parseJson<string[] | null>(r.live_source_ids, null), ownerSourceId: r.owner_source_id ?? null, managedBy: r.managed_by ?? null,
    refreshIntervalHours: r.refresh_hours, lastRefreshAt: r.last_refresh_at ?? null, lastError: r.last_error ?? null, refreshing: refreshing.has(r.id),
    channelCount: r.channel_count ?? 0, report: report(r, matched),
  };
}

const matchedCounts = () => new Map(db.all<{ s: string; n: number }>('SELECT guide_source_id s, COUNT(*) n FROM channels WHERE guide_key IS NOT NULL GROUP BY guide_source_id').map((x) => [x.s, x.n]));

export function listEpgSources(): EpgSource[] {
  const m = matchedCounts();
  return db.all('SELECT * FROM epg_sources ORDER BY priority DESC, name').map((r) => toEpgSource(r, m));
}

export function getEpgSourceRow(id: string): Row {
  const r = db.get('SELECT * FROM epg_sources WHERE id = ?', id);
  if (!r) throw notFound('Guide source not found');
  return r;
}

export const getEpgSource = (id: string) => toEpgSource(getEpgSourceRow(id), matchedCounts());

/* ------------------------------ CRUD ------------------------------ */

function cleanConfig(kind: string, cfg: EpgSourceConfig, prev: Record<string, any> = {}): { config: Record<string, any>; secret?: string | null } {
  const c: Record<string, any> = { ...prev };
  let secret: string | null | undefined;
  if (kind === 'xmltv') {
    if (cfg.preset !== undefined) {
      const p = findPreset(cfg.preset);
      if (cfg.preset && !p) throw badRequest('Unknown guide preset');
      c.preset = p?.id ?? null;
      if (p && !cfg.url) c.url = p.url;
    }
    if (cfg.url !== undefined) c.url = cfg.url?.trim() || null;
    if (cfg.path !== undefined) c.path = cfg.path?.trim() || null;
    if (c.url && c.path) delete c[cfg.path !== undefined && cfg.path ? 'url' : 'path'];
    if (!c.url && !c.path) throw badRequest('An XMLTV guide needs a URL or a file path');
    if (c.url && !/^https?:\/\//i.test(c.url)) throw badRequest('Guide URL must start with http:// or https://');
    if (c.path && !/^(\/|[A-Za-z]:[\\/]|file:\/\/)/.test(c.path)) throw badRequest('Guide file path must be absolute');
    if (cfg.timezone !== undefined) {
      const tz = cfg.timezone?.trim() || null;
      if (tz && !isValidTimezone(tz)) throw badRequest(`Unknown time zone: ${tz}`);
      c.timezone = tz;
    }
  } else if (kind === 'schedulesdirect') {
    if (cfg.username !== undefined) c.username = cfg.username?.trim() || null;
    if (cfg.password) secret = sha1Hex(cfg.password);
    if (cfg.days !== undefined) c.days = Math.max(1, Math.min(21, Math.round(Number(cfg.days) || 7)));
    if (cfg.artwork !== undefined) c.artwork = !!cfg.artwork;
    if (!c.username) throw badRequest('Schedules Direct needs a username');
  } else if (kind === 'hdhomerun') {
    if (cfg.liveSourceId !== undefined) c.liveSourceId = cfg.liveSourceId || null;
    if (cfg.deviceUrl !== undefined) c.deviceUrl = cfg.deviceUrl?.trim() || null;
    if (cfg.days !== undefined) c.days = Math.max(1, Math.min(14, Math.round(Number(cfg.days) || 1)));
    if (c.liveSourceId) {
      const ls = db.get('SELECT type FROM live_sources WHERE id = ?', c.liveSourceId);
      if (!ls) throw badRequest('Live source not found');
      if (ls.type !== 'hdhomerun') throw badRequest('That live source is not an HDHomeRun');
    }
    if (!c.liveSourceId && !c.deviceUrl) throw badRequest('Pick an HDHomeRun live source or enter the device address');
  } else throw badRequest('Unknown guide kind');
  return { config: c, secret };
}

function validLiveIds(ids: string[] | null | undefined): string[] | null {
  if (ids == null) return null;
  if (!Array.isArray(ids)) throw badRequest('liveSourceIds must be an array or null');
  for (const id of ids) if (!db.get('SELECT 1 FROM live_sources WHERE id = ?', id)) throw badRequest(`Live source ${id} not found`);
  return [...new Set(ids)];
}

export async function createEpgSource(req: CreateEpgSourceRequest): Promise<EpgSource> {
  if (!req?.name?.trim()) throw badRequest('Name is required');
  if (!['xmltv', 'schedulesdirect', 'hdhomerun'].includes(req.kind)) throw badRequest('Unknown guide kind');
  const { config, secret } = cleanConfig(req.kind, req.config ?? {});
  if (req.kind === 'schedulesdirect' && !secret) throw badRequest('Schedules Direct needs a password');
  const id = newId();
  let liveIds = validLiveIds(req.liveSourceIds);
  if (req.kind === 'hdhomerun' && config.liveSourceId && liveIds == null) liveIds = [config.liveSourceId];
  const hours = Math.max(req.kind === 'schedulesdirect' ? SD_MIN_HOURS : 1, Math.round(req.refreshIntervalHours ?? (req.kind === 'hdhomerun' ? 4 : 12)));
  db.insert('epg_sources', {
    id, name: req.name.trim(), kind: req.kind, config: JSON.stringify(config), secret: secret ?? null, state: '{}', priority: clampPriority(req.priority ?? 50),
    enabled: req.enabled ?? true, live_source_ids: liveIds ? JSON.stringify(liveIds) : null, refresh_hours: hours, created_at: nowIso(),
  });
  if (req.kind === 'schedulesdirect') {
    // Check the login straight away (the token is cached, so this does not cost an extra login later).
    try {
      await sdSyncStatus(id);
    } catch (e) {
      db.run('DELETE FROM epg_sources WHERE id = ?', id);
      throw badRequest((e as Error).message);
    }
  }
  logActivity('livetv.epg', `Guide source "${req.name}" added`);
  if (req.enabled ?? true) void refreshEpgSource(id).catch(() => undefined);
  return getEpgSource(id);
}

const clampPriority = (p: number) => Math.max(-1000, Math.min(1000, Math.round(Number(p) || 0)));

export function updateEpgSource(id: string, req: UpdateEpgSourceRequest): EpgSource {
  const r = getEpgSourceRow(id);
  const patch: Row = {};
  if (req.priority !== undefined) patch.priority = clampPriority(req.priority);
  if (req.enabled !== undefined) patch.enabled = !!req.enabled;
  if (!r.managed_by) {
    if (req.name !== undefined) {
      if (!req.name.trim()) throw badRequest('Name is required');
      patch.name = req.name.trim();
    }
    if (req.config) {
      const { config, secret } = cleanConfig(r.kind, req.config, parseJson(r.config, {}));
      patch.config = JSON.stringify(config);
      if (secret) {
        patch.secret = secret;
        patch.state = JSON.stringify({ ...parseJson(r.state, {}), token: null, tokenAt: null });
      }
    }
    if (req.liveSourceIds !== undefined) patch.live_source_ids = req.liveSourceIds ? JSON.stringify(validLiveIds(req.liveSourceIds)) : null;
    if (req.refreshIntervalHours !== undefined) patch.refresh_hours = Math.max(r.kind === 'schedulesdirect' ? SD_MIN_HOURS : 1, Math.round(req.refreshIntervalHours));
  } else if (req.name !== undefined || req.config !== undefined || req.liveSourceIds !== undefined) {
    throw badRequest(r.managed_by === 'provider' ? "The provider's own guide follows the live source; only priority and enabled can change" : "This guide comes from the live source's EPG URL field; edit it there");
  }
  db.update('epg_sources', id, patch);
  if (patch.config || patch.enabled === true) void refreshEpgSource(id).catch(() => undefined);
  if (patch.priority !== undefined || patch.enabled !== undefined || patch.live_source_ids !== undefined) {
    if (patch.live_source_ids !== undefined) matchGuide(id);
    resolveMatches();
  }
  return getEpgSource(id);
}

function dropGuideData(ids: string[]) {
  for (const id of ids) db.run('DELETE FROM programs WHERE source_id = ?', id);
}

export function deleteEpgSource(id: string) {
  const r = getEpgSourceRow(id);
  if (r.managed_by) throw badRequest(r.managed_by === 'provider' ? "The provider's own guide can't be removed; disable it instead" : "Remove this URL from the live source's EPG URL field instead");
  db.tx(() => {
    dropGuideData([id]);
    db.run('DELETE FROM epg_sources WHERE id = ?', id);
    // Programme cache rows no other SD guide references.
    db.run("DELETE FROM epg_sd_programs WHERE program_id NOT IN (SELECT DISTINCT json_extract(j.value, '$.programID') FROM epg_sd_schedules s, json_each(s.data) j)");
  });
  logActivity('livetv.epg', `Guide source "${r.name}" removed`);
  resolveMatches();
}

/** Called before a live source is deleted: drop guide data of the guides it owns. */
export function beforeLiveSourceDelete(liveSourceId: string) {
  dropGuideData(db.all<{ id: string }>('SELECT id FROM epg_sources WHERE owner_source_id = ?', liveSourceId).map((r) => r.id));
}

/* --------------------- guides managed by live sources --------------------- */

const splitUrls = (v: string | null | undefined) => [...new Set((v ?? '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean))];

/**
 * A live source's `epgUrl` field keeps working: every URL in it becomes a guide source owned by that live source
 * (priority 100, 99, … in field order, so they beat global guides at the default 50 and the provider guide at 0).
 */
export function syncLegacyGuides(liveSourceId: string): boolean {
  const src = db.get('SELECT * FROM live_sources WHERE id = ?', liveSourceId);
  if (!src) return false;
  const urls = splitUrls(src.epg_url);
  const existing = db.all("SELECT * FROM epg_sources WHERE owner_source_id = ? AND managed_by = 'epgUrl'", liveSourceId);
  let changed = false;
  const keep = new Set<string>();
  urls.forEach((url, i) => {
    const ex = existing.find((e) => parseJson<any>(e.config, {}).url === url);
    if (ex) {
      keep.add(ex.id);
      return;
    }
    const id = newId();
    keep.add(id);
    db.insert('epg_sources', {
      id, name: `${src.name} · guide ${i + 1}`, kind: 'xmltv', config: JSON.stringify({ url }), state: '{}', priority: 100 - i, enabled: 1,
      live_source_ids: null, owner_source_id: liveSourceId, managed_by: 'epgUrl', refresh_hours: src.refresh_hours ?? 12, created_at: nowIso(),
    });
    changed = true;
  });
  for (const e of existing) {
    if (keep.has(e.id)) continue;
    db.tx(() => {
      dropGuideData([e.id]);
      db.run('DELETE FROM epg_sources WHERE id = ?', e.id);
    });
    changed = true;
  }
  return changed;
}

/**
 * Guide drivers: provider guides that come from a device API instead of XMLTV (TVHeadend, Enigma2/OpenWebif).
 * Registered by services/livetv/tuners; the provider-guide row then holds `{ driver }` instead of `{ urls }`.
 */
export interface GuideDriverSink {
  channel(c: GuideChannelRec): void;
  decide(): void;
  programme(p: ProgrammeRec): void;
}
export type GuideDriver = (liveSource: Row, sink: GuideDriverSink, warnings: string[]) => Promise<void>;
const guideDrivers = new Map<string, GuideDriver>();
export function registerGuideDriver(name: string, fn: GuideDriver) {
  guideDrivers.set(name, fn);
}

async function loadDriverGuide(g: Row, w: GuideWriter, warnings: string[], driver: string) {
  const fn = guideDrivers.get(driver);
  if (!fn) throw new Error(`No guide driver "${driver}"`);
  const src = db.get('SELECT * FROM live_sources WHERE id = ?', g.owner_source_id);
  if (!src) throw new Error('Live source not found');
  await fn(src, w, warnings);
}

/** Ensure the provider-guide row for a live source exists (or is removed when the provider has none). */
function ensureProviderGuide(liveSourceId: string, input: string[] | { driver: string }): Row | null {
  const urls = Array.isArray(input) ? input : [];
  const cfg = Array.isArray(input) ? { urls } : { driver: input.driver };
  const src = db.get('SELECT * FROM live_sources WHERE id = ?', liveSourceId);
  const ex = db.get("SELECT * FROM epg_sources WHERE owner_source_id = ? AND managed_by = 'provider'", liveSourceId);
  if (!src) return null;
  if (Array.isArray(input) && !urls.length) {
    if (ex) {
      dropGuideData([ex.id]);
      db.run('DELETE FROM epg_sources WHERE id = ?', ex.id);
    }
    return null;
  }
  if (ex) {
    db.run('UPDATE epg_sources SET config = ?, name = ? WHERE id = ?', JSON.stringify(cfg), `${src.name} · provider guide`, ex.id);
    return db.get('SELECT * FROM epg_sources WHERE id = ?', ex.id)!;
  }
  const id = newId();
  db.insert('epg_sources', {
    id, name: `${src.name} · provider guide`, kind: 'provider', config: JSON.stringify(cfg), state: '{}', priority: 0, enabled: 1,
    live_source_ids: null, owner_source_id: liveSourceId, managed_by: 'provider', refresh_hours: src.refresh_hours ?? 12, created_at: nowIso(),
  });
  return db.get('SELECT * FROM epg_sources WHERE id = ?', id)!;
}

/**
 * Live-source refresh hook: refresh the provider's own guide and the source's EPG-URL guides. Throws only when
 * every guide of the source failed (so the source shows an error), never empties existing data.
 */
export async function refreshLiveSourceGuides(liveSourceId: string, providerUrls: string[] | { driver: string }, userAgent: string | null): Promise<void> {
  syncLegacyGuides(liveSourceId);
  ensureProviderGuide(liveSourceId, providerUrls);
  const guides = db.all('SELECT id FROM epg_sources WHERE owner_source_id = ? AND enabled = 1 ORDER BY priority DESC', liveSourceId);
  let ok = 0;
  const errors: string[] = [];
  for (const g of guides) {
    try {
      await refreshEpgSource(g.id, { userAgent, skipResolve: true, throwOnError: true });
      ok++;
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  resolveMatches();
  // Pre-matching guide data stored under the live source itself is superseded once its guides have loaded.
  if (ok) db.run('DELETE FROM programs WHERE source_id = ?', liveSourceId);
  if (guides.length && !ok) throw new Error(errors.length > 1 ? 'All EPG downloads failed' : errors[0] ?? 'EPG download failed');
}

/* ------------------------------ refresh ------------------------------ */

export interface GuideChannelRec {
  id: string;
  name: string;
  altNames: string[];
  callsign: string | null;
  number: string | null;
  icon: string | null;
}

export interface ProgrammeRec {
  channel: string;
  start: string;
  end: string;
  title: string;
  subtitle?: string | null;
  description?: string | null;
  category?: string | null;
  icon?: string | null;
  episodeNum?: string | null;
  isNew?: boolean;
}

interface LiveChannelRow {
  id: string;
  name: string;
  tvgId: string | null;
  number: string | null;
  byNumber: boolean;
}

function applicableSql(g: Row): { sql: string; params: string[] } {
  if (g.owner_source_id) return { sql: 'c.source_id = ?', params: [g.owner_source_id] };
  const ids = parseJson<string[] | null>(g.live_source_ids, null);
  if (!ids) return { sql: '1', params: [] };
  if (!ids.length) return { sql: '0', params: [] };
  return { sql: `c.source_id IN (${ids.map(() => '?').join(',')})`, params: ids };
}

function liveChannelsFor(g: Row): LiveChannelRow[] {
  const w = applicableSql(g);
  return db.all(`SELECT c.id, c.name, c.custom, c.epg_channel_id, c.remote_id, s.type FROM channels c JOIN live_sources s ON s.id = c.source_id WHERE ${w.sql}`, ...w.params).map((r) => {
    const custom = parseJson<Record<string, any>>(r.custom, {});
    const tuner = r.type === 'hdhomerun';
    return { id: r.id, name: custom.name || r.name, tvgId: r.epg_channel_id ?? null, number: tuner ? r.remote_id : null, byNumber: tuner };
  });
}

function computeCandidates(g: Row, guideChannels: GuideChannelRec[]): Map<string, MatchResult> {
  const out = new Map<string, MatchResult>();
  if (!guideChannels.length) return out;
  const idx = new GuideIndex(guideChannels.map<GuideChannelIn>((c) => ({ id: c.id, names: [c.name, ...c.altNames], callsign: c.callsign, number: c.number })));
  for (const lc of liveChannelsFor(g)) {
    const m = idx.best({ id: lc.id, name: lc.name, tvgId: lc.tvgId, number: lc.number }, { byNumber: lc.byNumber });
    if (m && m.confidence >= SUGGEST_THRESHOLD * 0.8) out.set(lc.id, m);
  }
  return out;
}

function storeCandidates(guideId: string, cands: Map<string, MatchResult>, channelIds?: Set<string>) {
  db.tx(() => {
    if (channelIds) for (const id of channelIds) db.run('DELETE FROM epg_match_candidates WHERE epg_source_id = ? AND channel_id = ?', guideId, id);
    else db.run('DELETE FROM epg_match_candidates WHERE epg_source_id = ?', guideId);
    for (const [cid, m] of cands) {
      db.run('INSERT OR REPLACE INTO epg_match_candidates (channel_id, epg_source_id, guide_channel_id, confidence, method, offset_minutes) VALUES (?, ?, ?, ?, ?, ?)', cid, guideId, m.guideId, m.confidence, m.method, m.offsetMinutes);
    }
  });
}

function loadGuideChannels(guideId: string): GuideChannelRec[] {
  return db.all('SELECT * FROM epg_channels WHERE epg_source_id = ?', guideId).map((r) => ({ id: r.id, name: r.name, altNames: parseJson<string[]>(r.alt_names, []), callsign: r.callsign, number: r.number, icon: r.icon }));
}

/** Re-run automatic matching of one guide against all its live channels (no download). */
export function matchGuide(guideId: string) {
  const g = getEpgSourceRow(guideId);
  storeCandidates(guideId, computeCandidates(g, loadGuideChannels(guideId)));
}

export function matchAllGuides() {
  for (const g of db.all<{ id: string }>('SELECT id FROM epg_sources WHERE channel_count > 0')) matchGuide(g.id);
}

/** Collects one guide's channels and programmes into staging rows, then swaps them in atomically. */
class GuideWriter {
  readonly channels = new Map<string, GuideChannelRec>();
  readonly counts = new Map<string, number>();
  candidates: Map<string, MatchResult> | null = null;
  wanted: Set<string> | null = null;
  private filledBefore = new Set<string>();
  private filledNow = new Set<string>();
  private batch: Row[] = [];
  programmes = 0;
  maxEnd = '';
  private readonly keepFrom = new Date(Date.now() - KEEP_BACK_MS).toISOString();
  private readonly keepTo = new Date(Date.now() + KEEP_AHEAD_MS).toISOString();

  constructor(private readonly g: Row) {
    this.abort();
  }

  channel(c: GuideChannelRec) {
    if (!c.id) return;
    const ex = this.channels.get(c.id);
    if (ex) {
      for (const n of [c.name, ...c.altNames]) if (n && n !== ex.name && !ex.altNames.includes(n)) ex.altNames.push(n);
      ex.icon ??= c.icon;
      ex.callsign ??= c.callsign;
      ex.number ??= c.number;
    } else this.channels.set(c.id, { ...c, altNames: [...new Set(c.altNames.filter((n) => n && n !== c.name))] });
  }

  /** Decide which channels to store programmes for, once the channel list is known. */
  decide() {
    if (this.candidates) return;
    this.candidates = computeCandidates(this.g, [...this.channels.values()]);
    if (this.channels.size > STORE_ALL_LIMIT) {
      this.wanted = new Set([...this.candidates.values()].map((m) => m.guideId));
      for (const r of db.all<{ custom: string }>("SELECT custom FROM channels WHERE json_extract(custom, '$.epgChannelId') IS NOT NULL")) {
        const c = parseJson<Record<string, any>>(r.custom, {});
        if (!c.epgSourceId || c.epgSourceId === this.g.id) this.wanted.add(c.epgChannelId);
      }
    }
  }

  programme(p: ProgrammeRec) {
    if (!this.candidates) this.decide();
    if (!p.channel || !p.start || !p.end || !p.title || p.end < this.keepFrom || p.start > this.keepTo) return;
    if (this.wanted && !this.wanted.has(p.channel)) return;
    if (this.filledBefore.has(p.channel)) return;
    if (!this.channels.has(p.channel)) this.channels.set(p.channel, { id: p.channel, name: p.channel, altNames: [], callsign: null, number: null, icon: null });
    this.filledNow.add(p.channel);
    const id = stableId(this.g.id, p.channel, p.start);
    this.batch.push({
      id: `tmp:${id}`, source_id: this.g.id, epg_channel_id: `tmp:${guideKey(this.g.id, p.channel)}`, title: p.title, subtitle: p.subtitle ?? null,
      description: p.description ?? null, start: p.start, end: p.end, category: p.category ?? null, icon: p.icon ?? null, episode_num: p.episodeNum ?? null, is_new: !!p.isNew,
    });
    this.counts.set(p.channel, (this.counts.get(p.channel) ?? 0) + 1);
    this.programmes++;
    if (p.end > this.maxEnd) this.maxEnd = p.end;
    if (this.batch.length >= 2000) this.flush();
  }

  /** Multi-URL guides: a channel filled by an earlier URL is not overwritten by a later one. */
  nextInput() {
    this.flush();
    for (const c of this.filledNow) this.filledBefore.add(c);
    this.filledNow.clear();
  }

  /** Drop what one failed input added. */
  discardInput() {
    this.batch.length = 0;
    for (const c of this.filledNow) {
      db.run('DELETE FROM programs WHERE epg_channel_id = ?', `tmp:${guideKey(this.g.id, c)}`);
      this.programmes -= this.counts.get(c) ?? 0;
      this.counts.delete(c);
    }
    this.filledNow.clear();
  }

  flush() {
    if (!this.batch.length) return;
    db.tx(() => {
      for (const p of this.batch) db.upsert('programs', p);
    });
    this.batch.length = 0;
  }

  abort() {
    this.batch.length = 0;
    db.run("DELETE FROM programs WHERE source_id = ? AND id >= 'tmp:' AND id < 'tmp;'", this.g.id);
  }

  commit(extra: { warnings: string[]; durationMs: number }) {
    this.flush();
    this.decide();
    const id = this.g.id;
    db.tx(() => {
      db.run("DELETE FROM programs WHERE source_id = ? AND NOT (id >= 'tmp:' AND id < 'tmp;')", id);
      db.run("UPDATE programs SET id = substr(id, 5), epg_channel_id = substr(epg_channel_id, 5) WHERE source_id = ? AND id >= 'tmp:' AND id < 'tmp;'", id);
      db.run('DELETE FROM epg_channels WHERE epg_source_id = ?', id);
      for (const c of this.channels.values()) {
        db.run('INSERT INTO epg_channels (epg_source_id, id, name, alt_names, callsign, number, icon, programmes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          id, c.id, c.name || c.id, JSON.stringify(c.altNames.slice(0, 10)), c.callsign, c.number, c.icon, this.counts.get(c.id) ?? 0);
      }
      storeCandidates(id, this.candidates!);
      const st = { programmes: this.programmes, maxEnd: this.maxEnd || null, durationMs: extra.durationMs, warnings: extra.warnings.slice(0, 10), filtered: !!this.wanted };
      db.run('UPDATE epg_sources SET channel_count = ?, stats = ?, last_refresh_at = ?, last_success_at = ?, last_error = NULL WHERE id = ?', this.channels.size, JSON.stringify(st), nowIso(), nowIso(), id);
    });
  }
}

export interface RefreshOpts {
  userAgent?: string | null;
  /** Manual refresh from the API (Schedules Direct: rate-limited). */
  manual?: boolean;
  skipResolve?: boolean;
  throwOnError?: boolean;
}

export function refreshEpgSource(id: string, opts: RefreshOpts = {}): Promise<void> {
  const running = refreshing.get(id);
  if (running) return running;
  const p = doRefresh(id, opts).finally(() => refreshing.delete(id));
  refreshing.set(id, p);
  return p;
}

export const isRefreshing = (id: string) => refreshing.has(id);

async function doRefresh(id: string, opts: RefreshOpts) {
  const g = getEpgSourceRow(id);
  if (!g.enabled) return;
  const t0 = Date.now();
  const w = new GuideWriter(g);
  const warnings: string[] = [];
  try {
    const driver = g.kind === 'provider' ? parseJson<{ driver?: string }>(g.config, {}).driver : undefined;
    if (driver) await loadDriverGuide(g, w, warnings, driver);
    else if (g.kind === 'xmltv' || g.kind === 'provider') await loadXmltv(g, w, warnings, opts.userAgent ?? null);
    else if (g.kind === 'schedulesdirect') await loadSchedulesDirect(g, w, warnings);
    else if (g.kind === 'hdhomerun') await loadHdhomerun(g, w);
    else throw new Error(`Unknown guide kind ${g.kind}`);
    w.commit({ warnings, durationMs: Date.now() - t0 });
    log.info(`Guide "${g.name}": ${w.channels.size} channels, ${w.programmes} programmes in ${Date.now() - t0} ms`);
    if (!opts.skipResolve) resolveMatches();
    bus.emit('epg.refreshed', g.owner_source_id ?? id);
  } catch (e) {
    w.abort();
    const msg = (e as Error).message;
    db.run('UPDATE epg_sources SET last_error = ?, last_refresh_at = ? WHERE id = ?', msg, nowIso(), id);
    logActivity('livetv.epg', `Guide "${g.name}" refresh failed: ${msg}`, { severity: 'warning' });
    log.warn(`Guide "${g.name}" refresh failed: ${msg}`);
    if (opts.throwOnError) throw e;
  }
}

/* ------------------------------ XMLTV ------------------------------ */

async function loadXmltv(g: Row, w: GuideWriter, warnings: string[], ua: string | null) {
  const c = parseJson<Record<string, any>>(g.config, {});
  const inputs: string[] = c.urls ?? [c.url ?? c.path].filter(Boolean);
  if (!inputs.length) throw new Error('No guide URL configured');
  let ok = 0;
  let lastErr = '';
  for (const input of inputs) {
    try {
      const stream = await openXmltv(input, { userAgent: ua });
      await parseXmltvReadable(stream, {
        timezone: c.timezone ?? null,
        onChannel: (ch) => w.channel({ id: ch.id, name: ch.names[0] ?? ch.id, altNames: ch.names.slice(1), callsign: null, number: ch.number ?? null, icon: ch.icon }),
        onProgramme: (p) => w.programme(p),
      });
      w.nextInput();
      ok++;
    } catch (e) {
      w.discardInput();
      lastErr = (e as Error).message;
      warnings.push(`${redactUrl(input)}: ${lastErr}`);
      log.warn(`EPG ${redactUrl(input)} failed: ${lastErr}`);
    }
  }
  if (!ok) throw new Error(inputs.length > 1 ? `All ${inputs.length} guide downloads failed (${lastErr})` : lastErr || 'EPG download failed');
}

/* ------------------------------ HDHomeRun ------------------------------ */

async function loadHdhomerun(g: Row, w: GuideWriter) {
  const c = parseJson<Record<string, any>>(g.config, {});
  const url = c.liveSourceId ? db.get<{ url: string }>('SELECT url FROM live_sources WHERE id = ?', c.liveSourceId)?.url : c.deviceUrl;
  if (!url) throw new Error('HDHomeRun device not found');
  const { deviceAuth: auth } = await deviceAuth(url);
  const guide = await fetchHdhrGuide(auth, (c.days ?? 1) * 24);
  for (const ch of guide) {
    w.channel({ id: ch.GuideNumber, name: ch.GuideName, altNames: ch.Affiliate ? [ch.Affiliate] : [], callsign: ch.GuideName, number: ch.GuideNumber, icon: ch.ImageURL ?? null });
  }
  w.decide();
  for (const ch of guide) {
    for (const p of ch.Guide ?? []) {
      const first = p.First === 1 || (p.OriginalAirdate != null && Math.abs(p.OriginalAirdate - p.StartTime) < 86400);
      w.programme({
        channel: ch.GuideNumber, start: new Date(p.StartTime * 1000).toISOString(), end: new Date(p.EndTime * 1000).toISOString(), title: p.Title,
        subtitle: p.EpisodeTitle ?? null, description: p.Synopsis ?? null, category: p.Filter?.[0] ?? null, icon: p.ImageURL ?? null, episodeNum: p.EpisodeNumber ?? null, isNew: first,
      });
    }
  }
}

/* ------------------------------ Schedules Direct ------------------------------ */

function sdClient(id: string): SdClient {
  const r = getEpgSourceRow(id);
  if (r.kind !== 'schedulesdirect') throw badRequest('Not a Schedules Direct guide');
  const c = parseJson<Record<string, any>>(r.config, {});
  return new SdClient({
    username: c.username ?? '',
    passwordHash: r.secret ?? '',
    getToken: () => parseJson<Record<string, any>>(db.get('SELECT state FROM epg_sources WHERE id = ?', id)?.state, {}),
    saveToken: (t) => {
      const st = parseJson<Record<string, any>>(db.get('SELECT state FROM epg_sources WHERE id = ?', id)?.state, {});
      db.run('UPDATE epg_sources SET state = ? WHERE id = ?', JSON.stringify({ ...st, ...t }), id);
    },
  });
}

function patchState(id: string, patch: Record<string, unknown>) {
  const st = parseJson<Record<string, any>>(db.get('SELECT state FROM epg_sources WHERE id = ?', id)?.state, {});
  db.run('UPDATE epg_sources SET state = ? WHERE id = ?', JSON.stringify({ ...st, ...patch }), id);
}

const sdErr = (e: unknown) => (e instanceof SdError ? new HttpError(e.status === 401 || e.status === 403 || e.code === 4003 ? 400 : 502, e.message, 'schedules_direct') : e);

/** GET /status, keeping the account's lineup list in the source state. */
export async function sdSyncStatus(id: string): Promise<SdStatus> {
  const client = sdClient(id);
  const st = await client.status();
  const lineups: SdLineup[] = (st.lineups ?? []).filter((l) => !l.isDeleted).map((l) => ({ lineup: l.lineup, name: l.name ?? l.lineup, transport: l.transport ?? '', location: l.location ?? '' }));
  // /status lists lineup ids; /lineups has the names. One extra call only when names are missing.
  if (lineups.some((l) => l.name === l.lineup)) {
    const named = await client.lineups();
    for (const l of lineups) {
      const n = named.find((x) => x.lineup === l.lineup);
      if (n) Object.assign(l, { name: n.name, transport: n.transport, location: n.location });
    }
  }
  patchState(id, { lineups, lineupModified: Object.fromEntries((st.lineups ?? []).map((l) => [l.lineup, l.modified ?? null])) });
  const sys = st.systemStatus?.[0];
  return {
    accountExpires: st.account?.expires ?? null, maxLineups: st.account?.maxLineups ?? null, lastDataUpdate: st.lastDataUpdate ?? null,
    systemStatus: sys ? `${sys.status ?? ''}${sys.message ? ` — ${sys.message}` : ''}` : null, messages: (st.account?.messages ?? []).map((m) => m.message ?? '').filter(Boolean), lineups,
  };
}

export async function sdStatus(id: string): Promise<SdStatus> {
  try {
    return await sdSyncStatus(id);
  } catch (e) {
    throw sdErr(e);
  }
}

export async function sdHeadends(id: string, country: string, postalcode: string): Promise<SdHeadend[]> {
  if (!/^[A-Z]{3}$/.test(country)) throw badRequest('Country must be a 3-letter ISO code such as USA, CAN or GBR');
  if (!postalcode?.trim()) throw badRequest('Postal code is required');
  try {
    const r = await sdClient(id).headends(country, postalcode.trim());
    return r.map((h) => ({ headend: h.headend, transport: h.transport, location: h.location, lineups: (h.lineups ?? []).map((l) => ({ name: l.name, lineup: l.lineup })) }));
  } catch (e) {
    throw sdErr(e);
  }
}

export async function sdChangeLineup(id: string, lineup: string, add: boolean): Promise<{ status: SdStatus; changesRemaining: number | null }> {
  if (!/^[A-Z0-9-]{3,64}$/i.test(lineup)) throw badRequest('Invalid lineup id');
  try {
    const client = sdClient(id);
    const r = add ? await client.addLineup(lineup) : await client.removeLineup(lineup);
    if (!add) db.run('DELETE FROM epg_sd_lineups WHERE epg_source_id = ? AND lineup = ?', id, lineup);
    const status = await sdSyncStatus(id);
    void refreshEpgSource(id).catch(() => undefined);
    return { status, changesRemaining: r.changesRemaining ?? null };
  } catch (e) {
    throw sdErr(e);
  }
}

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function loadSchedulesDirect(g: Row, w: GuideWriter, warnings: string[]) {
  const id = g.id;
  const c = parseJson<Record<string, any>>(g.config, {});
  const client = sdClient(id);
  const st = await client.status();
  const sys = st.systemStatus?.[0];
  if (sys?.status && !/online/i.test(sys.status)) throw new Error(`Schedules Direct is ${sys.status}${sys.message ? `: ${sys.message}` : ''}`);
  if (st.account?.expires && Date.parse(st.account.expires) < Date.now()) throw new Error(`Schedules Direct account expired on ${st.account.expires.slice(0, 10)}`);
  const lineups = (st.lineups ?? []).filter((l) => !l.isDeleted);
  if (!lineups.length) throw new Error('No lineups on this Schedules Direct account yet — add one by country and postcode');
  patchState(id, { lineupModified: Object.fromEntries(lineups.map((l) => [l.lineup, l.modified ?? null])) });

  // 1) Lineups (station lists + channel maps): only re-downloaded when "modified" changes.
  const stations = new Map<string, GuideChannelRec>();
  for (const l of lineups) {
    const cached = db.get('SELECT * FROM epg_sd_lineups WHERE epg_source_id = ? AND lineup = ?', id, l.lineup);
    let detail: SdLineupDetail;
    if (cached && cached.modified && cached.modified === l.modified) detail = JSON.parse(cached.data);
    else {
      try {
        detail = await client.lineup(l.lineup);
      } catch (e) {
        if (!cached) throw e;
        warnings.push(`Lineup ${l.lineup}: ${(e as Error).message}; using the cached copy`);
        detail = JSON.parse(cached.data);
      }
      db.run('INSERT OR REPLACE INTO epg_sd_lineups (epg_source_id, lineup, modified, data) VALUES (?, ?, ?, ?)', id, l.lineup, l.modified ?? null, JSON.stringify({ map: detail.map ?? [], stations: detail.stations ?? [] }));
    }
    const numbers = new Map<string, string>();
    for (const m of detail.map ?? []) {
      const n = sdChannelNumber(m);
      if (n && !numbers.has(m.stationID)) numbers.set(m.stationID, n);
    }
    for (const s of detail.stations ?? []) {
      if (stations.has(s.stationID)) continue;
      stations.set(s.stationID, {
        id: s.stationID, name: s.name ?? s.callsign ?? s.stationID, altNames: [s.callsign, s.affiliate].filter((x): x is string => !!x),
        callsign: s.callsign ?? null, number: numbers.get(s.stationID) ?? null, icon: s.logo?.URL ?? s.stationLogo?.[0]?.URL ?? null,
      });
    }
  }
  db.run(`DELETE FROM epg_sd_lineups WHERE epg_source_id = ? AND lineup NOT IN (${lineups.map(() => '?').join(',')})`, id, ...lineups.map((l) => l.lineup));
  for (const s of stations.values()) w.channel(s);
  w.decide();

  // 2) Schedules: md5 per station/date first, then only the changed station/dates (batches of 5000 stations).
  const days = c.days ?? 7;
  const dates = Array.from({ length: days }, (_, i) => utcDate(Date.now() + i * 86400000));
  const stationIds = [...stations.keys()].filter((s) => !w.wanted || w.wanted.has(s));
  const cachedMd5 = new Map(db.all('SELECT station_id, date, md5 FROM epg_sd_schedules WHERE epg_source_id = ?', id).map((r) => [`${r.station_id}|${r.date}`, r.md5]));
  const md5s = stationIds.length ? await client.scheduleMd5(stationIds, dates) : {};
  const want = new Map<string, string[]>();
  for (const sid of stationIds) {
    for (const d of dates) {
      const m = md5s[sid]?.[d];
      if (!m || m.code !== 0) continue;
      if (cachedMd5.get(`${sid}|${d}`) !== m.md5) (want.get(sid) ?? want.set(sid, []).get(sid)!).push(d);
    }
  }
  if (want.size) {
    const scheds = await client.schedules(want);
    db.tx(() => {
      for (const s of scheds) {
        if (s.code || !s.programs) continue;
        const date = s.metadata?.startDate ?? s.programs[0]?.airDateTime?.slice(0, 10);
        if (!date) continue;
        db.run('INSERT OR REPLACE INTO epg_sd_schedules (epg_source_id, station_id, date, md5, data) VALUES (?, ?, ?, ?, ?)', id, s.stationID, date, s.metadata?.md5 ?? md5s[s.stationID]?.[date]?.md5 ?? '', JSON.stringify(s.programs));
      }
    });
  }
  // Drop cached days that fell out of the window and stations that left the lineups.
  db.run('DELETE FROM epg_sd_schedules WHERE epg_source_id = ? AND date < ?', id, dates[0]);
  if (stationIds.length) db.run(`DELETE FROM epg_sd_schedules WHERE epg_source_id = ? AND station_id NOT IN (${stationIds.map(() => '?').join(',')})`, id, ...stationIds);

  // 3) Programmes: fetch only ids whose md5 changed (batches of 5000).
  const scheds = db.all('SELECT station_id, data FROM epg_sd_schedules WHERE epg_source_id = ? ORDER BY station_id, date', id).map((r) => ({ station: r.station_id as string, airings: JSON.parse(r.data) as SdAiring[] }));
  const needMd5 = new Map<string, string>();
  for (const s of scheds) for (const a of s.airings) needMd5.set(a.programID, a.md5);
  const have = new Map<string, string>();
  const ids = [...needMd5.keys()];
  for (let i = 0; i < ids.length; i += 900) {
    const chunk = ids.slice(i, i + 900);
    for (const r of db.all(`SELECT program_id, md5 FROM epg_sd_programs WHERE program_id IN (${chunk.map(() => '?').join(',')})`, ...chunk)) have.set(r.program_id, r.md5);
  }
  const fetchIds = ids.filter((pid) => have.get(pid) !== needMd5.get(pid));
  if (fetchIds.length) {
    const progs = await client.programs(fetchIds);
    db.tx(() => {
      for (const p of progs) {
        if (!p.programID || (p.code && p.code !== 0)) continue;
        db.run('INSERT INTO epg_sd_programs (program_id, md5, data, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(program_id) DO UPDATE SET md5 = excluded.md5, data = excluded.data, fetched_at = excluded.fetched_at',
          p.programID, p.md5 ?? needMd5.get(p.programID) ?? '', JSON.stringify(p), nowIso());
      }
    });
  }

  // 4) Optional artwork, once per programme root.
  if (c.artwork) {
    const roots = [...new Set(ids.map((p) => p.slice(0, 10)))];
    const known = new Set<string>();
    for (let i = 0; i < ids.length; i += 900) {
      const chunk = ids.slice(i, i + 900);
      for (const r of db.all(`SELECT program_id FROM epg_sd_programs WHERE artwork IS NOT NULL AND program_id IN (${chunk.map(() => '?').join(',')})`, ...chunk)) known.add(r.program_id.slice(0, 10));
    }
    const missing = roots.filter((r) => !known.has(r)).slice(0, 5000);
    if (missing.length) {
      try {
        const art = await client.artwork(missing);
        const byRoot = new Map(art.map((a) => [a.programID, Array.isArray(a.data) ? pickArtwork(a.data) : null]));
        db.tx(() => {
          for (const pid of ids) if (byRoot.has(pid.slice(0, 10))) db.run('UPDATE epg_sd_programs SET artwork = ? WHERE program_id = ?', byRoot.get(pid.slice(0, 10)) ?? '', pid);
        });
      } catch (e) {
        warnings.push(`Artwork: ${(e as Error).message}`);
      }
    }
  }

  // 5) Build programmes from the caches.
  const details = new Map<string, { p: SdProgram; art: string | null }>();
  for (let i = 0; i < ids.length; i += 900) {
    const chunk = ids.slice(i, i + 900);
    for (const r of db.all(`SELECT program_id, data, artwork FROM epg_sd_programs WHERE program_id IN (${chunk.map(() => '?').join(',')})`, ...chunk)) details.set(r.program_id, { p: JSON.parse(r.data), art: r.artwork || null });
  }
  for (const s of scheds) {
    for (const a of s.airings) {
      const d = details.get(a.programID);
      const start = new Date(a.airDateTime);
      if (Number.isNaN(start.getTime())) continue;
      const p = d?.p;
      w.programme({
        channel: s.station, start: start.toISOString(), end: new Date(start.getTime() + (a.duration ?? 0) * 1000).toISOString(),
        title: p?.titles?.[0]?.title120 ?? 'Unknown programme', subtitle: p?.episodeTitle150 ?? null,
        description: p?.descriptions?.description1000?.[0]?.description ?? p?.descriptions?.description100?.[0]?.description ?? null,
        category: p?.genres?.[0] ?? null, icon: d?.art ?? null, episodeNum: p ? sdEpisodeNum(p) : null, isNew: !!a.new,
      });
    }
  }
  // Keep the shared programme cache bounded to what some SD guide still references.
  db.run('DELETE FROM epg_sd_programs WHERE program_id NOT IN (SELECT DISTINCT json_extract(j.value, \'$.programID\') FROM epg_sd_schedules s, json_each(s.data) j)');
  log.info(`Schedules Direct "${g.name}": ${stations.size} stations, ${want.size} station schedules and ${fetchIds.length} programmes downloaded (${client.requests} requests)`);
}

/** Manual refresh: Schedules Direct sources can be refreshed at most every 15 minutes. */
export function manualRefresh(id: string) {
  const g = getEpgSourceRow(id);
  if (g.kind === 'schedulesdirect' && g.last_refresh_at && Date.now() - Date.parse(g.last_refresh_at) < SD_MANUAL_COOLDOWN_MS && !refreshing.has(id)) {
    throw new HttpError(429, 'Schedules Direct asks clients not to hammer its servers — try again in a few minutes', 'rate_limited');
  }
  void refreshEpgSource(id, { manual: true }).catch(() => undefined);
}

/** Scheduled task: refresh global guides that are due (live-source guides refresh with their source). */
export async function refreshDueGuides() {
  for (const g of db.all("SELECT * FROM epg_sources WHERE enabled = 1 AND owner_source_id IS NULL")) {
    const last = g.last_refresh_at ? Date.parse(g.last_refresh_at) : 0;
    if (Date.now() - last > (g.refresh_hours || 12) * 3600000) await refreshEpgSource(g.id);
  }
}

/* ------------------------------ resolution ------------------------------ */

interface Resolved {
  status: 'manual' | 'auto' | 'review' | 'none';
  src: string | null;
  ch: string | null;
  conf: number | null;
  method: string | null;
  offset: number;
  key: string | null;
}

/** Pick each channel's guide (manual > best automatic by guide priority) and store it on the channel row. */
export function resolveMatches(channelIds?: string[]) {
  const guides = new Map(db.all('SELECT id, priority, enabled, live_source_ids, owner_source_id FROM epg_sources').map((r): [string, Row] => [r.id, { ...r, liveIds: parseJson<string[] | null>(r.live_source_ids, null) }]));
  const applies = (gid: string, liveId: string) => {
    const g = guides.get(gid);
    if (!g || !g.enabled) return false;
    if (g.owner_source_id) return g.owner_source_id === liveId;
    return !g.liveIds || g.liveIds.includes(liveId);
  };
  const progCount = (gid: string, ch: string) => db.get<{ programmes: number }>('SELECT programmes FROM epg_channels WHERE epg_source_id = ? AND id = ?', gid, ch)?.programmes;
  const rows = channelIds?.length
    ? db.all(`SELECT * FROM channels WHERE id IN (${channelIds.map(() => '?').join(',')})`, ...channelIds)
    : db.all('SELECT * FROM channels');
  const candRows = channelIds?.length
    ? db.all(`SELECT * FROM epg_match_candidates WHERE channel_id IN (${channelIds.map(() => '?').join(',')})`, ...channelIds)
    : db.all('SELECT * FROM epg_match_candidates');
  const cands = new Map<string, Row[]>();
  for (const c of candRows) (cands.get(c.channel_id) ?? cands.set(c.channel_id, []).get(c.channel_id)!).push(c);
  const byPriority = [...guides.values()].sort((a, b) => b.priority - a.priority);

  db.tx(() => {
    for (const r of rows) {
      const custom = parseJson<Record<string, any>>(r.custom, {});
      let res: Resolved = { status: 'none', src: null, ch: null, conf: null, method: null, offset: 0, key: null };
      let autoOffset = 0;
      if (custom.epgNone) res = { ...res, method: 'manual' };
      else if (custom.epgChannelId && custom.epgSourceId && applies(custom.epgSourceId, r.source_id)) {
        res = { status: 'manual', src: custom.epgSourceId, ch: custom.epgChannelId, conf: 1, method: 'manual', offset: 0, key: null };
      } else if (custom.epgChannelId) {
        // Legacy manual id (no guide source): the highest-priority guide that has a channel with that id.
        const g = byPriority.find((x) => applies(x.id, r.source_id) && progCount(x.id, custom.epgChannelId) !== undefined);
        res = g
          ? { status: 'manual', src: g.id, ch: custom.epgChannelId, conf: 1, method: 'manual', offset: 0, key: null }
          : { status: 'manual', src: null, ch: custom.epgChannelId, conf: 1, method: 'manual', offset: 0, key: custom.epgChannelId };
      } else {
        const list = (cands.get(r.id) ?? []).filter((c) => applies(c.epg_source_id, r.source_id));
        const prio = (c: Row) => guides.get(c.epg_source_id)!.priority;
        const autos = list.filter((c) => c.confidence >= AUTO_THRESHOLD).sort((a, b) => prio(b) - prio(a) || b.confidence - a.confidence);
        const pick = autos.find((c) => (progCount(c.epg_source_id, c.guide_channel_id) ?? 0) > 0) ?? autos[0];
        if (pick) {
          res = { status: 'auto', src: pick.epg_source_id, ch: pick.guide_channel_id, conf: pick.confidence, method: pick.method, offset: 0, key: null };
          autoOffset = pick.offset_minutes ?? 0;
        } else {
          const best = [...list].sort((a, b) => b.confidence - a.confidence || prio(b) - prio(a))[0];
          if (best && best.confidence >= SUGGEST_THRESHOLD) res = { status: 'review', src: best.epg_source_id, ch: best.guide_channel_id, conf: best.confidence, method: best.method, offset: best.offset_minutes ?? 0, key: null };
        }
      }
      if (res.status === 'manual' || res.status === 'auto') {
        res.offset = typeof custom.epgOffsetHours === 'number' ? Math.round(custom.epgOffsetHours * 60) : autoOffset;
        if (res.src && res.ch) res.key = guideKey(res.src, res.ch) + (res.offset ? `#${res.offset}` : '');
      } else if (typeof custom.epgOffsetHours === 'number') res.offset = Math.round(custom.epgOffsetHours * 60);
      if (r.guide_status !== res.status || r.guide_key !== res.key || r.guide_source_id !== res.src || r.guide_channel_id !== res.ch || r.guide_confidence !== res.conf || r.guide_method !== res.method || r.guide_offset !== res.offset) {
        db.run('UPDATE channels SET guide_status = ?, guide_key = ?, guide_source_id = ?, guide_channel_id = ?, guide_confidence = ?, guide_method = ?, guide_offset = ? WHERE id = ?',
          res.status, res.key, res.src, res.ch, res.conf, res.method, res.offset, r.id);
      }
    }
  });
  materializeShifts();
}

/** Rebuild time-shifted programme copies (`sh:<minutes>:<id>`) for channels with an offset. */
export function materializeShifts() {
  const needed = db.all<{ k: string; s: string; ch: string; off: number }>('SELECT DISTINCT guide_key k, guide_source_id s, guide_channel_id ch, guide_offset off FROM channels WHERE guide_key IS NOT NULL AND guide_offset != 0 AND guide_source_id IS NOT NULL');
  db.tx(() => {
    db.run("DELETE FROM programs WHERE id >= 'sh:' AND id < 'sh;'");
    for (const n of needed) {
      const mod = `${n.off >= 0 ? '+' : ''}${n.off} minutes`;
      db.run(`INSERT OR REPLACE INTO programs (id, source_id, epg_channel_id, title, subtitle, description, start, end, category, icon, episode_num, is_new)
        SELECT 'sh:' || ? || ':' || id, source_id, ?, title, subtitle, description, strftime('%Y-%m-%dT%H:%M:%fZ', start, ?), strftime('%Y-%m-%dT%H:%M:%fZ', end, ?), category, icon, episode_num, is_new
        FROM programs WHERE epg_channel_id = ?`, n.off, n.k, mod, mod, guideKey(n.s, n.ch));
    }
  });
}

/** After a live source's channel list changed: match its channels against every guide and resolve. */
export function afterChannelSync(liveSourceId: string) {
  const ids = new Set(db.all<{ id: string }>('SELECT id FROM channels WHERE source_id = ?', liveSourceId).map((r) => r.id));
  for (const g of db.all('SELECT * FROM epg_sources WHERE channel_count > 0')) {
    const w = applicableSql(g);
    if (w.sql === '0') continue;
    const cands = computeCandidates(g, loadGuideChannels(g.id));
    const mine = new Map([...cands].filter(([cid]) => ids.has(cid)));
    storeCandidates(g.id, mine, ids);
  }
  resolveMatches([...ids]);
}

/* ------------------------------ matching API ------------------------------ */

const HAS_GUIDE_SQL = `EXISTS (SELECT 1 FROM programs p WHERE p.epg_channel_id = (${EFF_EPG_SQL}) AND p.end > ?)`;

export function listMatching(q: { filter?: string; sourceId?: string; search?: string; offset?: number; limit?: number }): MatchingResponse {
  const now = nowIso();
  const where: string[] = ['1'];
  const params: any[] = [];
  if (q.sourceId) where.push('c.source_id = ?'), params.push(q.sourceId);
  if (q.search) where.push('(c.name LIKE ? OR json_extract(c.custom, \'$.name\') LIKE ?)'), params.push(`%${q.search}%`, `%${q.search}%`);
  const base = where.join(' AND ');
  const filterSql: Record<string, string> = {
    all: '1',
    matched: "c.guide_status IN ('manual','auto') AND c.guide_key IS NOT NULL",
    unmatched: "(c.guide_status IS NULL OR c.guide_status = 'none' OR (c.guide_status = 'manual' AND c.guide_key IS NULL))",
    review: "c.guide_status = 'review'",
    low: `(c.guide_status = 'review' OR (c.guide_status = 'auto' AND c.guide_confidence < 0.9))`,
    missing: `NOT ${HAS_GUIDE_SQL}`,
  };
  const f = filterSql[q.filter ?? 'all'] ?? '1';
  const fParams = q.filter === 'missing' ? [now] : [];
  const count = (sql: string, extra: any[] = []) => db.get<{ n: number }>(`SELECT COUNT(*) n FROM channels c WHERE ${base} AND ${sql}`, ...params, ...extra)!.n;
  const counts = {
    all: count('1'), matched: count(filterSql.matched), review: count(filterSql.review), unmatched: count(filterSql.unmatched), missingGuide: count(filterSql.missing, [now]),
  };
  const total = count(f, fParams);
  const limit = Math.max(1, Math.min(1000, q.limit ?? 200));
  const rows = db.all(
    `SELECT c.*, s.name source_name, g.name guide_name, ec.name guide_channel_name, ${HAS_GUIDE_SQL} has_guide
     FROM channels c JOIN live_sources s ON s.id = c.source_id LEFT JOIN epg_sources g ON g.id = c.guide_source_id
     LEFT JOIN epg_channels ec ON ec.epg_source_id = c.guide_source_id AND ec.id = c.guide_channel_id
     WHERE ${base} AND ${f} ORDER BY s.name, COALESCE(json_extract(c.custom,'$.number'), c.number), c.sort_order LIMIT ? OFFSET ?`,
    now, ...params, ...fParams, limit, q.offset ?? 0);
  return { items: rows.map(toMatch), total, counts, thresholds: { auto: AUTO_THRESHOLD, suggest: SUGGEST_THRESHOLD } };
}

function toMatch(r: Row): ChannelMatch {
  const custom = parseJson<Record<string, any>>(r.custom, {});
  return {
    channelId: r.id, channelName: custom.name ?? r.name, channelNumber: custom.number ?? r.number ?? null, logoUrl: null, sourceId: r.source_id, sourceName: r.source_name,
    status: (r.guide_status ?? 'none') as ChannelMatch['status'], epgSourceId: r.guide_source_id ?? null, epgSourceName: r.guide_name ?? null,
    epgChannelId: r.guide_channel_id ?? (r.guide_status == null ? effEpg(r) : null), epgChannelName: r.guide_channel_name ?? null,
    confidence: r.guide_confidence ?? null, method: r.guide_method ?? null, offsetHours: (r.guide_offset ?? 0) / 60, hasGuide: !!r.has_guide,
  };
}

export function getMatch(channelId: string): ChannelMatch {
  const r = db.get(
    `SELECT c.*, s.name source_name, g.name guide_name, ec.name guide_channel_name, ${HAS_GUIDE_SQL} has_guide FROM channels c JOIN live_sources s ON s.id = c.source_id
     LEFT JOIN epg_sources g ON g.id = c.guide_source_id LEFT JOIN epg_channels ec ON ec.epg_source_id = c.guide_source_id AND ec.id = c.guide_channel_id WHERE c.id = ?`, nowIso(), channelId);
  if (!r) throw notFound('Channel not found');
  return toMatch(r);
}

export function setChannelMatch(channelId: string, req: SetChannelMatchRequest): ChannelMatch {
  const r = db.get('SELECT * FROM channels WHERE id = ?', channelId);
  if (!r) throw notFound('Channel not found');
  const custom = parseJson<Record<string, any>>(r.custom, {});
  let refreshGuide: string | null = null;
  if (req.none) {
    custom.epgNone = true;
    delete custom.epgSourceId;
    delete custom.epgChannelId;
  } else if (req.epgChannelId) {
    if (!req.epgSourceId) throw badRequest('epgSourceId is required with epgChannelId');
    const g = getEpgSourceRow(req.epgSourceId);
    const gc = db.get('SELECT programmes FROM epg_channels WHERE epg_source_id = ? AND id = ?', g.id, req.epgChannelId);
    if (!gc) throw badRequest('That channel is not in the guide');
    custom.epgSourceId = g.id;
    custom.epgChannelId = req.epgChannelId;
    delete custom.epgNone;
    if (!gc.programmes && parseJson<any>(g.stats, {}).filtered) refreshGuide = g.id;
  } else if ('epgChannelId' in req || 'epgSourceId' in req) {
    delete custom.epgSourceId;
    delete custom.epgChannelId;
    delete custom.epgNone;
  }
  if (req.offsetHours !== undefined) {
    if (req.offsetHours === null) delete custom.epgOffsetHours;
    else {
      const h = Number(req.offsetHours);
      if (!Number.isFinite(h) || Math.abs(h) > 24) throw badRequest('offsetHours must be between -24 and 24');
      if (h === 0) delete custom.epgOffsetHours;
      else custom.epgOffsetHours = Math.round(h * 4) / 4;
    }
  }
  db.run('UPDATE channels SET custom = ? WHERE id = ?', JSON.stringify(custom), channelId);
  resolveMatches([channelId]);
  // Big guides only keep programmes for matched channels: fetch the newly chosen one.
  if (refreshGuide) void refreshEpgSource(refreshGuide).catch(() => undefined);
  return getMatch(channelId);
}

/** Turn every pending suggestion into a stored (manual) match. */
export function acceptAllSuggestions(q: { sourceId?: string; minConfidence?: number } = {}): { accepted: number } {
  const rows = db.all(`SELECT id, custom, guide_source_id, guide_channel_id FROM channels WHERE guide_status = 'review' AND guide_source_id IS NOT NULL ${q.sourceId ? 'AND source_id = ?' : ''} AND guide_confidence >= ?`,
    ...(q.sourceId ? [q.sourceId] : []), q.minConfidence ?? SUGGEST_THRESHOLD);
  db.tx(() => {
    for (const r of rows) {
      const custom = parseJson<Record<string, any>>(r.custom, {});
      custom.epgSourceId = r.guide_source_id;
      custom.epgChannelId = r.guide_channel_id;
      delete custom.epgNone;
      db.run('UPDATE channels SET custom = ? WHERE id = ?', JSON.stringify(custom), r.id);
    }
  });
  if (rows.length) resolveMatches(rows.map((r) => r.id));
  return { accepted: rows.length };
}

/** Guide channels across all sources, ranked by name similarity. */
export function searchGuideChannels(q: { q?: string; epgSourceId?: string; limit?: number }): EpgGuideChannel[] {
  const limit = Math.max(1, Math.min(200, q.limit ?? 50));
  const text = (q.q ?? '').trim();
  const where: string[] = [];
  const params: any[] = [];
  if (q.epgSourceId) where.push('ec.epg_source_id = ?'), params.push(q.epgSourceId);
  let rows: Row[];
  const sel = 'SELECT ec.*, g.name guide_name, g.priority FROM epg_channels ec JOIN epg_sources g ON g.id = ec.epg_source_id';
  if (!text) {
    rows = db.all(`${sel} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY g.priority DESC, ec.name LIMIT ?`, ...params, limit);
    return rows.map(toGuideChannel);
  }
  const like = (t: string) => {
    const p = `%${t}%`;
    return db.all(`${sel} WHERE ${[...where, '(ec.name LIKE ? OR ec.id LIKE ? OR ec.alt_names LIKE ? OR ec.callsign LIKE ? OR ec.number = ?)'].join(' AND ')} LIMIT 500`, ...params, p, p, p, p, t);
  };
  rows = like(text);
  const n = normalizeName(text);
  if (rows.length < 20 && n.tokens.length) {
    const seen = new Set(rows.map((r) => r.epg_source_id + '|' + r.id));
    const longest = [...n.tokens].sort((a, b) => b.length - a.length)[0];
    for (const r of like(longest)) if (!seen.has(r.epg_source_id + '|' + r.id)) rows.push(r);
  }
  const score = (r: Row) => Math.max(...[r.name, r.id, ...parseJson<string[]>(r.alt_names, [])].map((x) => nameSimilarity(n, normalizeName(String(x)))));
  return rows.map((r) => ({ r, s: score(r) })).sort((a, b) => b.s - a.s || b.r.priority - a.r.priority).slice(0, limit).map((x) => toGuideChannel(x.r));
}

function toGuideChannel(r: Row): EpgGuideChannel {
  return {
    epgSourceId: r.epg_source_id, epgSourceName: r.guide_name, id: r.id, name: r.name, altNames: parseJson<string[]>(r.alt_names, []),
    callsign: r.callsign ?? null, number: r.number ?? null, iconUrl: r.icon ?? null, programmes: r.programmes ?? 0,
  };
}

/** Now / next (and a few more) for a guide channel with an optional shift — the matching page's preview. */
export function previewGuideChannel(epgSourceId: string, epgChannelId: string, offsetHours = 0): { now: Program | null; next: Program | null; upcoming: Program[] } {
  const off = Math.round((Number(offsetHours) || 0) * 60) * 60000;
  const now = Date.now();
  const from = new Date(now - off - 6 * 3600000).toISOString();
  const to = new Date(now - off + 12 * 3600000).toISOString();
  const rows = db.all('SELECT * FROM programs WHERE epg_channel_id = ? AND end > ? AND start < ? ORDER BY start LIMIT 200', guideKey(epgSourceId, epgChannelId), from, to);
  const progs: Program[] = rows.map((p) => ({
    id: p.id, channelId: '', title: p.title, subtitle: p.subtitle ?? null, description: p.description ?? null,
    start: new Date(Date.parse(p.start) + off).toISOString(), end: new Date(Date.parse(p.end) + off).toISOString(),
    category: p.category ?? null, iconUrl: p.icon ?? null, episodeNum: p.episode_num ?? null, isNew: !!p.is_new,
  })).filter((p) => Date.parse(p.end) > now);
  const cur = progs.find((p) => Date.parse(p.start) <= now) ?? null;
  const rest = progs.filter((p) => p !== cur);
  return { now: cur, next: rest[0] ?? null, upcoming: rest.slice(0, 5) };
}

/** Ids of channels (among `ids`) that have guide data from now on. */
export function channelsWithGuide(ids: string[]): Set<string> {
  if (!ids.length) return new Set();
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of db.all<{ id: string }>(`SELECT c.id FROM channels c WHERE c.id IN (${chunk.map(() => '?').join(',')}) AND ${HAS_GUIDE_SQL}`, ...chunk, nowIso())) out.add(r.id);
  }
  return out;
}

/** Startup: turn existing `epgUrl` fields into guide sources (idempotent). */
export function initEpg() {
  try {
    for (const s of db.all<{ id: string }>('SELECT id FROM live_sources')) syncLegacyGuides(s.id);
  } catch (e) {
    log.warn(`EPG init: ${(e as Error).message}`);
  }
}
