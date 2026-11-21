import crypto from 'node:crypto';
import type {
  ManualRendererRequest, Renderer, RendererAdminView, RendererCommandRequest, RendererKind, RendererPlayRequest, RendererPlayState, RendererSettings, RendererState,
} from '@mediamax/shared';
import { db, type Row } from '../../db.js';
import { config } from '../../config.js';
import { getKv, getSettings, setKv } from '../settings.js';
import { assertCanSee, getChildren, getItem } from '../items.js';
import { getSession, listSessions, registerSession, sessionProgress, stopSession, touchSession, transcodeCount, type PlaySession } from '../playback.js';
import type { AuthContext } from '../auth.js';
import { HttpError, badRequest, forbidden, notFound } from '../../util/errors.js';
import { parseJson } from '../../util/misc.js';
import { logger } from '../../util/log.js';
import { TEXT_SUB_CODECS } from '../probe.js';
import type { LoadMedia, RendererDriver } from './driver.js';
import { fetchDescription, ssdpSearch, type DeviceDescription } from './ssdp.js';
import { UpnpDriver } from './upnp.js';
import { KodiDriver, type KodiTarget } from './kodi.js';
import { mdnsBrowse } from './mdns.js';
import { localAddressFor, resolveLanHost } from './lan.js';
import { chooseFormat, signStream, streamExpiry, type StreamFormat } from './stream.js';

const log = logger('renderers');

/* ------------------------------- settings ------------------------------ */

export const DEFAULT_RENDERER_SETTINGS: RendererSettings = { enabled: true, mdns: true, allowPublicHosts: false, streamBaseUrl: null };

export const rendererSettings = (): RendererSettings => ({ ...DEFAULT_RENDERER_SETTINGS, ...getKv<Partial<RendererSettings>>('renderers.settings', {}) });

interface ManualEntry {
  id: string;
  kind: 'kodi' | 'dlna';
  name: string;
  host: string;
  port: number | null;
  username: string | null;
  password: string | null;
  descriptionUrl: string | null;
}

const manualEntries = () => getKv<ManualEntry[]>('renderers.manual', []);

export function saveRendererSettings(patch: Partial<RendererSettings>): RendererSettings {
  const cur = rendererSettings();
  let base = patch.streamBaseUrl === undefined ? cur.streamBaseUrl : patch.streamBaseUrl ? String(patch.streamBaseUrl).trim().replace(/\/+$/, '') : null;
  if (base) {
    try {
      const u = new URL(base);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
      base = u.origin + u.pathname.replace(/\/+$/, '');
    } catch {
      throw badRequest('Stream base URL must be an http(s) URL, e.g. http://192.168.1.10:8484');
    }
  }
  const next: RendererSettings = {
    enabled: patch.enabled ?? cur.enabled,
    mdns: patch.mdns ?? cur.mdns,
    allowPublicHosts: patch.allowPublicHosts ?? cur.allowPublicHosts,
    streamBaseUrl: base,
  };
  setKv('renderers.settings', next);
  if (!next.enabled) {
    for (const rs of [...active.values()]) void endSession(rs, 'Play to devices was disabled');
    devices.clear();
  }
  return next;
}

/* -------------------------------- devices ------------------------------ */

interface Known {
  id: string;
  kind: RendererKind;
  name: string;
  manufacturer: string | null;
  model: string | null;
  host: string;
  deviceIcon: string | null;
  supportsVideo: boolean;
  manual: boolean;
  lastSeen: number;
  desc?: DeviceDescription;
  kodi?: KodiTarget;
  sink?: { at: number; raw: string };
  driver?: RendererDriver;
}

const devices = new Map<string, Known>();
let lastDiscovery = 0;
let discovering: Promise<void> | null = null;

const hashId = (prefix: string, s: string) => prefix + crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

function fromDescription(d: DeviceDescription, manual: boolean, nameOverride?: string | null): Known {
  const host = new URL(d.avTransport!.controlUrl).hostname;
  const audioOnly = d.isSonos || /sonos|denon heos|bose|yamaha musiccast|bluesound/i.test(`${d.manufacturer} ${d.modelName}`);
  return {
    id: hashId('u', d.udn), kind: d.isSonos ? 'sonos' : 'dlna', name: nameOverride || d.friendlyName, manufacturer: d.manufacturer, model: d.modelName, host,
    deviceIcon: d.iconUrl, supportsVideo: !audioOnly, manual, lastSeen: Date.now(), desc: d,
  };
}

function upsert(k: Known) {
  const prev = devices.get(k.id);
  if (prev) {
    // Keep the live driver (and its cached Sink list) for an unchanged device.
    const same = prev.desc?.avTransport?.controlUrl === k.desc?.avTransport?.controlUrl && prev.kodi?.host === k.kodi?.host && prev.kodi?.port === k.kodi?.port
      && prev.kodi?.password === k.kodi?.password && prev.kodi?.username === k.kodi?.username;
    if (same) {
      k.driver = prev.driver;
      k.sink = prev.sink;
    }
    k.manual ||= prev.manual && k.manual;
  }
  devices.set(k.id, k);
}

function driverFor(k: Known): RendererDriver {
  if (k.driver) return k.driver;
  k.driver = k.kind === 'kodi' ? new KodiDriver(k.kodi!) : new UpnpDriver(k.desc!);
  return k.driver;
}

async function sinkFor(k: Known): Promise<string> {
  if (k.kind === 'kodi') return '';
  if (k.sink && Date.now() - k.sink.at < 10 * 60000) return k.sink.raw;
  const raw = await (driverFor(k).sinkProtocols?.() ?? Promise.resolve('')).catch(() => '');
  k.sink = { at: Date.now(), raw };
  return raw;
}

async function loadManual(m: ManualEntry): Promise<Known | null> {
  if (m.kind === 'kodi') {
    return {
      id: m.id, kind: 'kodi', name: m.name, manufacturer: 'Kodi', model: null, host: m.host, deviceIcon: null, supportsVideo: true, manual: true, lastSeen: Date.now(),
      kodi: { host: m.host, port: m.port ?? 8080, username: m.username, password: m.password },
    };
  }
  if (!m.descriptionUrl) return null;
  const d = await fetchDescription(m.descriptionUrl).catch(() => null);
  if (!d) return null;
  const k = fromDescription(d, true, m.name);
  k.id = m.id;
  return k;
}

/** Search the network (SSDP + mDNS) and refresh manual devices. Concurrent calls share one run. */
export function discover(timeoutMs = 3000): Promise<void> {
  if (!rendererSettings().enabled) return Promise.resolve();
  if (discovering) return discovering;
  discovering = (async () => {
    const s = rendererSettings();
    const [hits, kodis] = await Promise.all([
      ssdpSearch(timeoutMs).catch(() => []),
      s.mdns ? mdnsBrowse('_xbmc-jsonrpc-h._tcp.local', Math.min(timeoutMs, 2500)).catch(() => []) : Promise.resolve([]),
    ]);
    await Promise.all(hits.slice(0, 64).map(async (h) => {
      try {
        const d = await fetchDescription(h.location);
        if (d?.avTransport) upsert(fromDescription(d, false));
      } catch (e) {
        log.debug(`Renderer at ${h.location} skipped: ${(e as Error).message}`);
      }
    }));
    for (const k of kodis) {
      upsert({
        id: hashId('k', `${k.address}:${k.port}`), kind: 'kodi', name: k.instance || 'Kodi', manufacturer: 'Kodi', model: null, host: k.address, deviceIcon: null,
        supportsVideo: true, manual: false, lastSeen: Date.now(), kodi: { host: k.address, port: k.port },
      });
    }
    for (const m of manualEntries()) {
      const k = await loadManual(m).catch(() => null);
      if (k) upsert(k);
    }
    // Forget devices not seen for an hour (manual ones stay listed while their entry exists).
    const manualIds = new Set(manualEntries().map((m) => m.id));
    for (const [id, k] of devices) if (!manualIds.has(id) && Date.now() - k.lastSeen > 3600_000 && !active.has(id)) devices.delete(id);
    lastDiscovery = Date.now();
  })().finally(() => {
    discovering = null;
  });
  return discovering;
}

/** Kodi found over JSON-RPC also shows up as a UPnP renderer: list it once, as Kodi. */
function visible(): Known[] {
  const kodiHosts = new Set([...devices.values()].filter((d) => d.kind === 'kodi').map((d) => d.host));
  return [...devices.values()].filter((d) => !(d.kind === 'dlna' && kodiHosts.has(d.host) && /kodi|xbmc/i.test(`${d.manufacturer} ${d.model} ${d.name}`)));
}

function toRenderer(k: Known): Renderer {
  const rs = active.get(k.id);
  return {
    id: k.id, kind: k.kind, name: k.name, manufacturer: k.manufacturer, model: k.model, host: k.host,
    iconUrl: k.deviceIcon ? `/api/v1/renderers/${k.id}/icon` : null, supportsVideo: k.supportsVideo, manual: k.manual,
    online: Date.now() - k.lastSeen < 20 * 60000 || k.manual, lastSeenAt: new Date(k.lastSeen).toISOString(),
    nowPlaying: rs && rs.state !== 'stopped' ? { title: rs.queue[rs.index]?.title ?? '', userName: rs.user.user.displayName, state: rs.state } : null,
  };
}

export function listRenderers(): Renderer[] {
  if (!rendererSettings().enabled) return [];
  if (Date.now() - lastDiscovery > 2 * 60000) void discover();
  return visible().map(toRenderer).sort((a, b) => a.name.localeCompare(b.name));
}

export const lastDiscoveryAt = () => (lastDiscovery ? new Date(lastDiscovery).toISOString() : null);

function getKnown(id: string): Known {
  if (!rendererSettings().enabled) throw notFound('Play to devices is disabled');
  const k = devices.get(id);
  if (!k) throw notFound('Device not found — try searching again');
  return k;
}

export async function rendererIcon(id: string): Promise<{ body: Buffer; type: string }> {
  const k = getKnown(id);
  if (!k.deviceIcon) throw notFound();
  const { deviceFetch } = await import('./lan.js');
  const res = await deviceFetch(k.deviceIcon, k.host, { timeoutMs: 4000 });
  const type = res.headers.get('content-type') ?? 'image/png';
  if (!res.ok || !/^image\//.test(type)) throw notFound();
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > 512 * 1024) throw notFound();
  return { body, type };
}

/* ---------------------------- manual devices --------------------------- */

export function adminView(): RendererAdminView {
  return {
    settings: rendererSettings(),
    manual: manualEntries().map((m) => ({ id: m.id, kind: m.kind, name: m.name, host: m.host, port: m.port, username: m.username, hasPassword: !!m.password, descriptionUrl: m.descriptionUrl })),
    renderers: rendererSettings().enabled ? visible().map(toRenderer) : [],
    lastDiscoveryAt: lastDiscoveryAt(),
  };
}

export async function addManual(req: ManualRendererRequest): Promise<RendererAdminView> {
  const s = rendererSettings();
  if (!s.enabled) throw badRequest('Enable Play to devices first');
  const list = manualEntries();
  if (list.length >= 50) throw badRequest('Too many manual devices');
  if (req.kind === 'kodi') {
    const host = String(req.host ?? '').trim();
    if (!host || host.length > 253 || /[\s/@?#]/.test(host)) throw badRequest('Enter the Kodi host name or IP address');
    const port = req.port == null ? 8080 : Math.round(Number(req.port));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw badRequest('Invalid port');
    const ip = await resolveLanHost(host, s.allowPublicHosts);
    const target: KodiTarget = { host: ip, port, username: req.username?.trim() || null, password: req.password || null };
    let name = req.name?.trim() || '';
    try {
      const probed = await new KodiDriver(target).probe();
      name ||= probed;
    } catch (e) {
      throw new HttpError(400, `Could not reach Kodi at ${host}:${port} — ${(e as Error).message}. In Kodi enable Settings → Services → Control → "Allow remote control via HTTP".`, 'unreachable');
    }
    const entry: ManualEntry = { id: hashId('k', `${ip}:${port}`), kind: 'kodi', name: name.slice(0, 80) || 'Kodi', host: ip, port, username: target.username ?? null, password: target.password ?? null, descriptionUrl: null };
    setKv('renderers.manual', [...list.filter((m) => m.id !== entry.id), entry]);
    upsert((await loadManual(entry))!);
    return adminView();
  }
  if (req.kind === 'dlna') {
    let u: URL;
    try {
      u = new URL(String(req.descriptionUrl ?? '').trim());
    } catch {
      throw badRequest('Enter the device description URL, e.g. http://192.168.1.20:1400/xml/device_description.xml');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw badRequest('The description URL must be http(s)');
    const ip = await resolveLanHost(u.hostname, s.allowPublicHosts);
    u.hostname = ip.includes(':') ? `[${ip}]` : ip;
    const d = await fetchDescription(u.toString()).catch((e) => {
      throw new HttpError(400, `Could not read the device description: ${(e as Error).message}`, 'unreachable');
    });
    if (!d?.avTransport) throw badRequest("That device isn't a UPnP media renderer (no AVTransport service)");
    const k = fromDescription(d, true, req.name?.trim() || null);
    const entry: ManualEntry = { id: k.id, kind: 'dlna', name: k.name.slice(0, 80), host: k.host, port: null, username: null, password: null, descriptionUrl: u.toString() };
    setKv('renderers.manual', [...list.filter((m) => m.id !== entry.id), entry]);
    upsert(k);
    return adminView();
  }
  throw badRequest('kind must be kodi or dlna');
}

export function removeManual(id: string): RendererAdminView {
  const list = manualEntries();
  if (!list.some((m) => m.id === id)) throw notFound('Not a manually added device');
  setKv('renderers.manual', list.filter((m) => m.id !== id));
  const rs = active.get(id);
  if (rs) void endSession(rs, 'Device removed');
  devices.delete(id);
  return adminView();
}

/* -------------------------------- sessions ----------------------------- */

interface QueueEntry {
  itemId: string;
  mediaId: string;
  title: string;
  subtitle: string | null;
  posterUrl: string | null;
  durationMs: number | null;
  format: StreamFormat;
}

interface RendererSession {
  key: string;
  rendererId: string;
  user: AuthContext;
  /** The synthetic per-renderer auth context the play session runs under. */
  ctx: AuthContext;
  playSessionId: string | null;
  queue: QueueEntry[];
  index: number;
  /** Device position + offsetMs = item position (transcodes restart at the seek target). */
  offsetMs: number;
  audioIndex: number | null;
  subtitleIndex: number | null;
  subtitleUrl: string | null;
  nativeQueue: boolean;
  state: RendererPlayState;
  positionMs: number;
  durationMs: number | null;
  volume: number | null;
  muted: boolean;
  error: string | null;
  sawPlaying: boolean;
  loadedAt: number;
  failures: number;
  polls: number;
  lastReport: number;
  timer: NodeJS.Timeout | null;
  ended: boolean;
  busy: Promise<unknown> | null;
}

const active = new Map<string, RendererSession>();
/** Live transcode processes per session key (counted against the transcoding limit). */
export const rendererTranscodes = new Map<string, number>();
const totalRendererTranscodes = () => [...rendererTranscodes.values()].reduce((a, b) => a + b, 0);

/** Is this signed stream claim still valid (session alive, media in its queue)? */
export function streamTarget(key: string, mediaId: string): { session: RendererSession; entry: QueueEntry } | null {
  for (const rs of active.values()) {
    if (rs.key !== key || rs.ended) continue;
    const entry = rs.queue.find((q) => q.mediaId === mediaId);
    if (entry) return { session: rs, entry };
  }
  return null;
}

export function touchStream(rs: RendererSession) {
  if (rs.playSessionId) touchSession(rs.playSessionId);
}

export const sessionSubtitleUrl = (rs: RendererSession) => rs.subtitleUrl;

function baseUrlFor(k: Known): string {
  const s = rendererSettings();
  if (s.streamBaseUrl) return s.streamBaseUrl;
  const ip = localAddressFor(k.host);
  return `http://${ip.includes(':') ? `[${ip}]` : ip}:${config.port}`;
}

const CLASS: Record<string, string> = { movie: 'object.item.videoItem.movie', episode: 'object.item.videoItem', track: 'object.item.audioItem.musicTrack', video: 'object.item.videoItem' };

function mediaRowFor(itemId: string, mediaId?: string): Row {
  const row = mediaId ? db.get('SELECT * FROM media WHERE id = ? AND item_id = ?', mediaId, itemId) : db.get('SELECT * FROM media WHERE item_id = ? ORDER BY COALESCE(width,0) DESC LIMIT 1', itemId);
  if (!row) throw notFound('No playable media for this item');
  return row;
}

function buildEntry(rs: Pick<RendererSession, 'user' | 'audioIndex'>, k: Known, sink: string, itemId: string, mediaId?: string, applyAudio = true): QueueEntry {
  const item = getItem(rs.user.user, itemId, true);
  if (item.type === 'photo' || item.type === 'show' || item.type === 'season' || item.type === 'album' || item.type === 'artist') throw badRequest(`"${item.title}" can't be played directly — choose an episode or track`);
  const row = mediaRowFor(itemId, mediaId);
  const audio = parseJson<{ index: number; codec: string; default?: boolean }[]>(row.audio, []);
  const chosen = (applyAudio && rs.audioIndex != null ? audio.find((a) => a.index === rs.audioIndex) : null) ?? audio.find((a) => a.default) ?? audio[0] ?? null;
  const isAudio = item.type === 'track' || !row.video_codec;
  if (!isAudio && !k.supportsVideo) throw badRequest(`${k.name} plays audio only`);
  const format = chooseFormat(k.kind, sink, {
    container: row.container, videoCodec: row.video_codec, audioCodec: chosen?.codec ?? null, isAudio,
    nonDefaultAudio: !!chosen && audio.length > 1 && !chosen.default && !isAudio, remote: !row.path && !!row.remote_url,
  });
  const subtitle = item.type === 'episode'
    ? `${item.grandparentTitle ?? ''} · S${item.parentIndex ?? 0}E${item.index ?? 0}`
    : item.type === 'track' ? [item.grandparentTitle, item.parentTitle].filter(Boolean).join(' — ') : item.year ? String(item.year) : null;
  return { itemId, mediaId: row.id, title: item.title, subtitle, posterUrl: item.posterUrl, durationMs: row.duration_ms || item.durationMs || null, format };
}

function loadMediaFor(rs: RendererSession, k: Known, e: QueueEntry, startMs: number): LoadMedia {
  const row = mediaRowFor(e.itemId, e.mediaId);
  const item = getItem(rs.user.user, e.itemId, false);
  const base = baseUrlFor(k);
  const transcoded = e.format.method === 'transcode';
  const tSec = transcoded ? Math.floor(startMs / 1000) : 0;
  const exp = streamExpiry(e.durationMs);
  const token = signStream({ s: rs.key, m: e.mediaId, f: e.format.f, t: tSec, a: rs.audioIndex, x: exp });
  const url = `${base}/api/v1/renderers/stream/${rs.key}/${token}.${e.format.ext}`;
  let subtitleUrl: string | null = null;
  if (rs.subtitleIndex != null && item.type !== 'track') {
    const subs = parseJson<{ index: number; codec: string }[]>(row.subs, []);
    if (subs.some((s) => s.index === rs.subtitleIndex && TEXT_SUB_CODECS.has(s.codec))) {
      subtitleUrl = `${base}/api/v1/renderers/stream/${rs.key}/${signStream({ s: rs.key, m: e.mediaId, f: 'srt', t: tSec, a: rs.subtitleIndex, x: exp })}.srt`;
    }
  }
  const art = item.posterUrl ?? item.thumbUrl ?? null;
  const artUrl = art ? `${base}${art}?w=600` : null;
  const isAudio = item.type === 'track' || !row.video_codec;
  const durationMs = e.durationMs ? Math.max(0, e.durationMs - tSec * 1000) : null;
  return {
    url, mime: e.format.mime, protocolInfo: e.format.protocolInfo, title: e.title, subtitle: e.subtitle, artUrl, durationMs,
    startMs: transcoded ? 0 : startMs, isAudio, seekable: !transcoded, subtitleUrl,
    didl: {
      id: `mediamax:${e.itemId}`, title: item.type === 'episode' && e.subtitle ? `${e.subtitle} · ${e.title}` : e.title,
      upnpClass: CLASS[item.type] ?? (isAudio ? 'object.item.audioItem.musicTrack' : 'object.item.videoItem'),
      artist: item.type === 'track' ? item.grandparentTitle ?? null : null, album: item.type === 'track' ? item.parentTitle ?? null : null,
      genre: item.genres?.[0] ?? null, description: item.overview ?? null, trackNumber: item.type === 'track' ? item.index ?? null : null,
      date: item.year ? `${item.year}-01-01` : null, artUrl,
      res: { url, protocolInfo: e.format.protocolInfo, durationMs, size: transcoded ? null : row.size, resolution: !isAudio && row.width && row.height ? `${row.width}x${row.height}` : null },
      subtitleUrl,
    },
  };
}

function rendererCtx(user: AuthContext, k: Known): AuthContext {
  return {
    user: user.user,
    deviceRowId: `renderer:${k.id}`,
    token: '',
    device: { deviceId: `renderer:${k.id}`, deviceName: k.name, platform: 'other', appVersion: k.kind === 'kodi' ? 'Kodi' : k.kind === 'sonos' ? 'Sonos' : 'DLNA' },
  };
}

function assertTranscodeAllowed(user: AuthContext, e: QueueEntry) {
  if (e.format.method !== 'transcode') return;
  if (!user.user.allowTranscode && !user.user.isAdmin) throw forbidden(`This device can't play "${e.title}" as is, and your account isn't allowed to transcode`);
  if (!getSettings().transcoding.enabled) throw new HttpError(409, `This device can't play "${e.title}" as is, and transcoding is turned off`, 'transcoding_disabled');
  if (transcodeCount() + totalRendererTranscodes() >= getSettings().transcoding.maxConcurrent) throw new HttpError(503, 'The server is busy transcoding other streams. Try again shortly.', 'transcoder_busy');
}

/** Register the play session for the current queue entry (watch history, stream limits, dashboard). */
function openPlaySession(rs: RendererSession, k: Known, e: QueueEntry, startMs: number): PlaySession {
  const ps = registerSession({
    ctx: rs.ctx, itemId: e.itemId, channelId: null, mediaId: e.mediaId, method: e.format.method === 'direct' ? 'direct' : 'transcode', job: null,
    title: e.title, subtitle: e.subtitle, posterUrl: e.posterUrl, durationMs: e.durationMs, remoteAddr: k.host, positionMs: startMs,
    onStop: () => {
      // Stopped from outside (admin, reaper) — not when we switch items ourselves.
      if (rs.playSessionId === ps.id) {
        rs.playSessionId = null;
        void endSession(rs, null, true);
      }
    },
  });
  rs.playSessionId = ps.id;
  return ps;
}

function closePlaySession(rs: RendererSession, finalState: 'stopped' = 'stopped') {
  const sid = rs.playSessionId;
  if (!sid) return;
  rs.playSessionId = null;
  try {
    sessionProgress(rs.ctx, sid, rs.positionMs, finalState, rs.durationMs ?? undefined);
  } catch {
    stopSession(sid);
  }
  stopSession(sid);
}

function stateOf(rs: RendererSession | undefined, k: Known): RendererState {
  const e = rs?.queue[rs.index];
  return {
    rendererId: k.id, rendererName: k.name, state: rs?.state ?? 'idle', sessionId: rs?.playSessionId ?? null, userId: rs?.user.user.id ?? null,
    itemId: e?.itemId ?? null, title: e?.title ?? null, subtitle: e?.subtitle ?? null, posterUrl: e?.posterUrl ?? null,
    positionMs: rs?.positionMs ?? 0, durationMs: rs?.durationMs ?? e?.durationMs ?? null, volume: rs?.volume ?? null, muted: rs?.muted ?? false,
    method: e ? e.format.method : null, queue: rs && rs.queue.length > 1 ? { index: rs.index + 1, total: rs.queue.length } : null, error: rs?.error ?? null,
  };
}

export async function rendererState(ctx: AuthContext, id: string): Promise<RendererState> {
  const k = getKnown(id);
  const rs = active.get(id);
  if (!rs) {
    // Idle: report the device volume so the remote can show it.
    const v = await driverFor(k).getVolume().catch(() => ({ volume: null, muted: false }));
    return { ...stateOf(undefined, k), volume: v.volume, muted: v.muted };
  }
  const st = stateOf(rs, k);
  if (rs.user.user.id !== ctx.user.id && !ctx.user.isAdmin) return { ...st, itemId: null, title: 'In use', subtitle: rs.user.user.displayName, posterUrl: null };
  return st;
}

export async function playOnRenderer(ctx: AuthContext, id: string, req: RendererPlayRequest): Promise<RendererState> {
  const k = getKnown(id);
  if (!req?.itemId) throw badRequest('itemId is required');
  const existing = active.get(id);
  if (existing && !existing.ended && existing.user.user.id !== ctx.user.id && !ctx.user.isAdmin) throw new HttpError(409, `${k.name} is playing for ${existing.user.user.displayName}`, 'renderer_busy');
  assertCanSee(ctx.user, req.itemId);

  let ids = [req.itemId];
  const top = getItem(ctx.user, req.itemId, false);
  if (['album', 'playlist', 'season', 'collection'].includes(top.type) && !req.queueItemIds?.length) {
    // An album / playlist / season: play its tracks or episodes in order.
    const kids = getChildren(ctx.user, req.itemId, { limit: 500, offset: 0 }).items.filter((c) => !!db.get('SELECT 1 FROM media WHERE item_id = ?', c.id)).map((c) => c.id);
    if (!kids.length) throw badRequest(`"${top.title}" has nothing to play`);
    req = { ...req, itemId: kids[0], queueItemIds: kids, startMs: req.startMs ?? 0 };
    ids = kids;
  } else if (Array.isArray(req.queueItemIds) && req.queueItemIds.length > 1) {
    ids = [...new Set(req.queueItemIds.map(String))].slice(0, 500).filter((x) => {
      try {
        assertCanSee(ctx.user, x);
        return !!db.get('SELECT 1 FROM media WHERE item_id = ?', x);
      } catch {
        return false;
      }
    });
    if (!ids.includes(req.itemId)) ids.unshift(req.itemId);
  }

  const sink = await sinkFor(k);
  const proto = {
    user: ctx, audioIndex: req.audioStreamIndex != null && Number.isInteger(Number(req.audioStreamIndex)) ? Number(req.audioStreamIndex) : null,
  };
  const startIndex = ids.indexOf(req.itemId);
  const queue = ids.map((x, i) => (i === startIndex ? buildEntry(proto, k, sink, x, req.mediaId) : buildEntry(proto, k, sink, x, undefined, false)));
  assertTranscodeAllowed(ctx, queue[startIndex]);

  if (existing) await endSession(existing, null, false, true);
  // Hand-off: the sending device's own stream of this item ends (so it doesn't count twice against stream limits).
  for (const a of listSessions()) {
    const ps = getSession(a.id);
    if (ps && ps.ctx.deviceRowId === ctx.deviceRowId && ids.includes(ps.itemId ?? '')) stopSession(ps.id, 'replaced', false);
  }

  const userData = db.get<{ position_ms: number }>('SELECT position_ms FROM user_data WHERE user_id = ? AND item_id = ?', ctx.user.id, req.itemId);
  const startMs = Math.max(0, Math.round(req.startMs ?? userData?.position_ms ?? 0));
  const rs: RendererSession = {
    key: crypto.randomBytes(12).toString('base64url'), rendererId: id, user: ctx, ctx: rendererCtx(ctx, k), playSessionId: null, queue, index: startIndex,
    offsetMs: 0, audioIndex: proto.audioIndex, subtitleIndex: req.subtitleStreamIndex != null ? Number(req.subtitleStreamIndex) : null, subtitleUrl: null,
    nativeQueue: k.kind === 'sonos' && queue.length > 1 && !!k.desc?.rinconId, state: 'buffering', positionMs: startMs, durationMs: queue[startIndex].durationMs,
    volume: null, muted: false, error: null, sawPlaying: false, loadedAt: Date.now(), failures: 0, polls: 0, lastReport: 0, timer: null, ended: false, busy: null,
  };
  openPlaySession(rs, k, queue[startIndex], startMs); // throws on stream limits
  active.set(id, rs);
  try {
    await loadCurrent(rs, k, startMs);
  } catch (e) {
    await endSession(rs, null, false);
    active.delete(id);
    throw new HttpError(502, `${k.name} refused the stream: ${(e as Error).message}`, 'renderer_failed');
  }
  if (k.kind === 'kodi') void driverFor(k).notify?.('Kinora', `Playing ${queue[startIndex].title}`, null).catch(() => undefined);
  log.info(`${ctx.user.displayName} → ${k.name} (${k.kind}): "${queue[startIndex].title}" ${queue[startIndex].format.method}${queue[startIndex].format.reasons.length ? ` (${queue[startIndex].format.reasons.join('; ')})` : ''}`);
  schedule(rs, 1500);
  return stateOf(rs, k);
}

async function loadCurrent(rs: RendererSession, k: Known, startMs: number) {
  const e = rs.queue[rs.index];
  rs.offsetMs = e.format.method === 'transcode' ? Math.floor(startMs / 1000) * 1000 : 0;
  rs.sawPlaying = false;
  rs.loadedAt = Date.now();
  rs.state = 'buffering';
  rs.error = null;
  rs.positionMs = startMs;
  rs.durationMs = e.durationMs;
  const d = driverFor(k);
  if (rs.nativeQueue && d.loadQueue) {
    const items = rs.queue.map((q, i) => loadMediaFor(rs, k, q, i === rs.index ? startMs : 0));
    rs.subtitleUrl = null;
    await d.loadQueue(items, rs.index);
  } else {
    const m = loadMediaFor(rs, k, e, startMs);
    rs.subtitleUrl = m.subtitleUrl;
    await d.load(m);
  }
}

/** Move to another queue entry (end of item, next / previous). */
async function switchTo(rs: RendererSession, k: Known, index: number, viaDevice = false) {
  if (index < 0 || index >= rs.queue.length) return endSession(rs, null);
  const e = rs.queue[index];
  try {
    assertTranscodeAllowed(rs.user, e);
  } catch (err) {
    return endSession(rs, (err as Error).message);
  }
  closePlaySession(rs);
  rs.index = index;
  openPlaySession(rs, k, e, 0);
  if (viaDevice) {
    // Sonos advanced its own queue.
    rs.positionMs = 0;
    rs.durationMs = e.durationMs;
    return;
  }
  await loadCurrent(rs, k, 0);
}

function schedule(rs: RendererSession, ms: number) {
  if (rs.ended) return;
  if (rs.timer) clearTimeout(rs.timer);
  rs.timer = setTimeout(() => void poll(rs), ms);
  rs.timer.unref?.();
}

/** One status poll. Exported for tests. */
export async function poll(rs: RendererSession): Promise<void> {
  if (rs.ended) return;
  const k = devices.get(rs.rendererId);
  if (!k) return endSession(rs, 'Device disappeared');
  if (rs.busy) {
    schedule(rs, 1000);
    return;
  }
  const d = driverFor(k);
  rs.polls++;
  try {
    const st = await d.status();
    if (rs.polls % 5 === 1) {
      const v = await d.getVolume().catch(() => null);
      if (v) {
        rs.volume = v.volume;
        rs.muted = v.muted;
      }
    }
    rs.failures = 0;
    const e = rs.queue[rs.index];
    // Someone started something else on the device (TV remote, another app).
    const foreign = st.uri && /^(https?|x-rincon|x-sonos)/i.test(st.uri) && !st.uri.includes(`/stream/${rs.key}/`) && !st.uri.startsWith('x-rincon-queue:');
    if (foreign && rs.sawPlaying && !rs.nativeQueue) return endSession(rs, null);
    if (rs.nativeQueue && st.track && st.track - 1 !== rs.index && st.track - 1 < rs.queue.length) await switchTo(rs, k, st.track - 1, true);

    if (st.state === 'playing' || st.state === 'paused') {
      rs.sawPlaying = true;
      rs.state = st.state;
      if (st.positionMs != null) rs.positionMs = rs.offsetMs + st.positionMs;
      if (st.durationMs && e.format.method === 'direct') rs.durationMs = st.durationMs;
    } else if (st.state === 'buffering') {
      rs.state = 'buffering';
    } else if (rs.sawPlaying) {
      // Stopped / no media after playing: finished or stopped on the device.
      const dur = rs.durationMs ?? 0;
      const nearEnd = dur > 0 && rs.positionMs >= Math.min(dur - 20000, dur * 0.95);
      if (nearEnd) {
        rs.positionMs = dur;
        if (rs.index + 1 < rs.queue.length && !rs.nativeQueue) {
          await switchTo(rs, k, rs.index + 1);
          schedule(rs, 1500);
          return;
        }
      }
      return endSession(rs, null);
    } else if (Date.now() - rs.loadedAt > 30000) {
      return endSession(rs, `${k.name} didn't start playing`);
    }

    if (rs.playSessionId && (Date.now() - rs.lastReport > 5000 || rs.polls <= 2)) {
      rs.lastReport = Date.now();
      sessionProgress(rs.ctx, rs.playSessionId, rs.positionMs, rs.state === 'paused' ? 'paused' : 'playing', rs.durationMs ?? undefined);
    } else if (rs.playSessionId) touchSession(rs.playSessionId);
  } catch (err) {
    rs.failures++;
    if (rs.failures >= 8) return endSession(rs, `Lost contact with ${k.name}: ${(err as Error).message}`);
    if (rs.playSessionId) touchSession(rs.playSessionId);
  }
  schedule(rs, rs.state === 'playing' ? 1000 : rs.state === 'buffering' ? 1500 : rs.state === 'paused' ? 4000 : 2000);
}

/** End a renderer session: final progress, stop the device (optional), close the play session. */
async function endSession(rs: RendererSession, error: string | null, stopDevice = false, replacing = false) {
  if (rs.ended) return;
  rs.ended = true;
  if (rs.timer) clearTimeout(rs.timer);
  rs.timer = null;
  rs.state = 'stopped';
  rs.error = error;
  closePlaySession(rs);
  const k = devices.get(rs.rendererId);
  if (stopDevice && k && !replacing) await driverFor(k).stop().catch(() => undefined);
  // Keep the final state visible briefly so the remote bar can show what happened.
  setTimeout(() => {
    if (active.get(rs.rendererId) === rs) active.delete(rs.rendererId);
  }, error ? 30000 : 3000).unref?.();
  if (error) log.warn(`Renderer session on ${k?.name ?? rs.rendererId} ended: ${error}`);
}

function controllable(ctx: AuthContext, id: string): { rs: RendererSession; k: Known } {
  const k = getKnown(id);
  const rs = active.get(id);
  if (!rs || rs.ended) throw new HttpError(409, `Nothing from Kinora is playing on ${k.name}`, 'not_playing');
  if (rs.user.user.id !== ctx.user.id && !ctx.user.isAdmin) throw forbidden(`${k.name} is playing for ${rs.user.user.displayName}`);
  return { rs, k };
}

export async function rendererCommand(ctx: AuthContext, id: string, action: string, body: RendererCommandRequest = {}): Promise<RendererState> {
  if (action === 'volume') {
    const k = getKnown(id);
    const rs = active.get(id);
    if (rs && !rs.ended && rs.user.user.id !== ctx.user.id && !ctx.user.isAdmin) throw forbidden(`${k.name} is playing for ${rs.user.user.displayName}`);
    const d = driverFor(k);
    if (body.volume != null) {
      const v = Number(body.volume);
      if (!Number.isFinite(v)) throw badRequest('volume must be 0–100');
      await d.setVolume(v);
      if (rs) rs.volume = Math.max(0, Math.min(100, Math.round(v)));
    }
    if (body.muted != null) {
      await d.setMuted(!!body.muted);
      if (rs) rs.muted = !!body.muted;
    }
    return rs ? stateOf(rs, k) : rendererState(ctx, id);
  }
  const { rs, k } = controllable(ctx, id);
  const d = driverFor(k);
  const run = async () => {
    switch (action) {
      case 'pause':
        await d.pause();
        rs.state = 'paused';
        if (rs.playSessionId) sessionProgress(rs.ctx, rs.playSessionId, rs.positionMs, 'paused', rs.durationMs ?? undefined);
        break;
      case 'resume':
        await d.play();
        rs.state = 'playing';
        if (rs.playSessionId) sessionProgress(rs.ctx, rs.playSessionId, rs.positionMs, 'playing', rs.durationMs ?? undefined);
        break;
      case 'stop':
        await d.stop().catch(() => undefined);
        await endSession(rs, null);
        break;
      case 'seek': {
        const target = Math.max(0, Math.round(Number(body.positionMs)));
        if (!Number.isFinite(target)) throw badRequest('positionMs is required');
        const dur = rs.durationMs ?? 0;
        const pos = dur ? Math.min(target, Math.max(0, dur - 2000)) : target;
        const e = rs.queue[rs.index];
        if (e.format.method === 'transcode' && !rs.nativeQueue) await loadCurrent(rs, k, pos); // restart the conversion at the target
        else await d.seek(pos - rs.offsetMs);
        rs.positionMs = pos;
        break;
      }
      case 'next':
      case 'previous': {
        if (rs.nativeQueue && d.next && d.previous) await (action === 'next' ? d.next() : d.previous());
        else {
          const to = action === 'next' ? rs.index + 1 : rs.positionMs > 5000 ? rs.index : rs.index - 1;
          if (to >= rs.queue.length) throw badRequest('This is the last item');
          await switchTo(rs, k, Math.max(0, to));
        }
        break;
      }
      default:
        throw badRequest(`Unknown action ${action}`);
    }
  };
  rs.busy = run();
  try {
    await rs.busy;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `${k.name}: ${(e as Error).message}`, 'renderer_failed');
  } finally {
    rs.busy = null;
  }
  if (!rs.ended) schedule(rs, 700);
  return stateOf(rs, k);
}

/* ------------------------------- lifecycle ----------------------------- */

let interval: NodeJS.Timeout | null = null;

export function startRenderers() {
  if (!rendererSettings().enabled) return;
  setTimeout(() => void discover().catch(() => undefined), 5000).unref?.();
  interval = setInterval(() => {
    // Keep the device list warm only while something is playing or someone looked recently.
    if (rendererSettings().enabled && (active.size || Date.now() - lastDiscovery < 30 * 60000)) void discover().catch(() => undefined);
  }, 10 * 60000);
  interval.unref?.();
}

export async function stopRenderers() {
  if (interval) clearInterval(interval);
  interval = null;
  for (const rs of [...active.values()]) await endSession(rs, null);
}

/* -------------------------------- testing ------------------------------ */

export const _test = {
  devices, active, upsert, fromDescription,
  addKodi(host: string, port: number, name = 'Kodi'): string {
    const id = hashId('k', `${host}:${port}`);
    upsert({ id, kind: 'kodi', name, manufacturer: 'Kodi', model: null, host, deviceIcon: null, supportsVideo: true, manual: false, lastSeen: Date.now(), kodi: { host, port } });
    return id;
  },
  reset() {
    for (const rs of active.values()) {
      if (rs.timer) clearTimeout(rs.timer);
      rs.ended = true;
    }
    active.clear();
    devices.clear();
    lastDiscovery = 0;
  },
  session: (id: string) => active.get(id),
  getSession,
};
