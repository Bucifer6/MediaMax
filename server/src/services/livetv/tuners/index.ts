/**
 * Hardware tuner / set-top-box live sources: TVHeadend, SAT>IP (incl. FRITZ!Box Cable) and Enigma2 (OpenWebif).
 * livetv.ts calls into here for refresh, test, stream URLs and stream opening; the TVHeadend and Enigma2 guides
 * are registered with the EPG system as provider guides (priority 0) keyed by the same ids the channels carry.
 */
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { db, type Row } from '../../../db.js';
import { config } from '../../../config.js';
import { parseJson, REMOTE_PROTOCOLS } from '../../../util/misc.js';
import { logger } from '../../../util/log.js';
import { registerGuideDriver } from '../epg/epg.js';
import { TunerHttp, TunerHttpError, splitUserInfo, withUserInfo } from './http.js';
import * as tvh from './tvheadend.js';
import * as e2 from './enigma2.js';
import * as satip from './satip.js';
import type { TunerOptions, TunerSync } from './types.js';

export { discoverAll, discoverSatip, discoverHdhomerun, type DiscoveredDevice } from './discovery.js';
export type { TunerOptions } from './types.js';

const log = logger('tuners');

export const TUNER_TYPES = ['tvheadend', 'satip', 'enigma2'] as const;
export type TunerType = (typeof TUNER_TYPES)[number];
export const isTunerType = (t: string | null | undefined): t is TunerType => !!t && (TUNER_TYPES as readonly string[]).includes(t);

export const TUNER_LABELS: Record<TunerType, string> = { tvheadend: 'TVHeadend', satip: 'SAT>IP', enigma2: 'Enigma2' };

export interface TunerSourceIn {
  type: string;
  url: string;
  username?: string | null;
  password?: string | null;
  userAgent?: string | null;
  options?: TunerOptions | null;
}

export const sourceIn = (r: Row): TunerSourceIn => ({ type: r.type, url: r.url, username: r.username, password: r.password, userAgent: r.user_agent, options: parseJson<TunerOptions>(r.options, {}) });
const like = (s: TunerSourceIn) => ({ url: s.url, username: s.username ?? null, password: s.password ?? null, userAgent: s.userAgent ?? null, options: s.options ?? {} });

/** Validate and normalise the options the admin sent for a tuner source. */
export function cleanOptions(type: string, o: TunerOptions | null | undefined, prev: TunerOptions = {}): TunerOptions {
  const out: TunerOptions = { ...prev };
  if (!o) return out;
  const port = (v: unknown) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 1 || n > 65535) throw new TunerHttpError('Port must be between 1 and 65535');
    return n;
  };
  if (o.maxStreams !== undefined) out.maxStreams = o.maxStreams == null || !Number(o.maxStreams) ? null : Math.max(1, Math.min(64, Math.round(Number(o.maxStreams))));
  if (o.authType !== undefined) out.authType = o.authType && ['auto', 'basic', 'digest'].includes(o.authType) ? o.authType : 'auto';
  if (type === 'tvheadend' && o.profile !== undefined) {
    const p = (o.profile ?? '').trim();
    if (p && !/^[\w.\- ]{1,64}$/.test(p)) throw new TunerHttpError('Invalid stream profile name');
    out.profile = p || null;
  }
  if (type === 'satip') {
    if (o.satipMode !== undefined) out.satipMode = o.satipMode === 'fritzbox' || o.satipMode === 'm3u' ? o.satipMode : null;
    if (o.fritzLists !== undefined) out.fritzLists = (o.fritzLists ?? []).filter((l) => l in satip.FRITZ_LISTS);
    if (o.playlistUrl !== undefined) {
      const u = (o.playlistUrl ?? '').trim();
      if (u && !/^https?:\/\//i.test(u)) throw new TunerHttpError('The channel list URL must start with http:// or https://');
      out.playlistUrl = u || null;
    }
    if (o.rtspTransport !== undefined) out.rtspTransport = o.rtspTransport === 'tcp' || o.rtspTransport === 'udp' ? o.rtspTransport : null;
    if (o.descriptionUrl !== undefined) {
      const u = (o.descriptionUrl ?? '').trim();
      if (u && !/^https?:\/\//i.test(u)) throw new TunerHttpError('The description URL must start with http://');
      out.descriptionUrl = u || null;
    }
  }
  if (type === 'enigma2') {
    if (o.bouquets !== undefined) out.bouquets = Array.isArray(o.bouquets) ? [...new Set(o.bouquets.map(String).filter((b) => b.length < 512))].slice(0, 100) : null;
    if (o.streamPort !== undefined) out.streamPort = o.streamPort ? port(o.streamPort) : null;
    if (o.transcodePort !== undefined) out.transcodePort = o.transcodePort ? port(o.transcodePort) : null;
    if (o.useTranscoding !== undefined) out.useTranscoding = !!o.useTranscoding;
    if (o.streamAuth !== undefined) out.streamAuth = !!o.streamAuth;
    if (o.guideDays !== undefined) out.guideDays = o.guideDays ? Math.max(1, Math.min(14, Math.round(Number(o.guideDays)))) : null;
  }
  return out;
}

export async function syncTuner(s: TunerSourceIn): Promise<TunerSync & { bouquets?: { ref: string; name: string }[]; profiles?: string[] }> {
  const l = like(s);
  if (s.type === 'tvheadend') {
    const r = await tvh.sync(l);
    return { ...r, profiles: (r.device as { profiles?: string[] }).profiles };
  }
  if (s.type === 'enigma2') return e2.sync(l);
  if (s.type === 'satip') return satip.sync(l);
  throw new TunerHttpError(`Unknown tuner type ${s.type}`);
}

/** Streams the source may run at once: the admin's limit, else the device's tuner count. */
export const streamLimit = (s: TunerSourceIn, tunerCount: number | null) => s.options?.maxStreams || tunerCount || null;

export interface TunerTestResult {
  ok: boolean;
  message: string;
  liveCount?: number;
  tunerCount?: number | null;
  device?: { name: string | null; model: string | null; version: string | null; tuners: string[] } | null;
  bouquets?: { ref: string; name: string }[];
  profiles?: string[];
  warnings?: string[];
}

export async function testTuner(s: TunerSourceIn): Promise<TunerTestResult> {
  try {
    const r = await syncTuner(s);
    const d = r.device;
    const tuners = d.tunerCount != null ? `${d.tunerCount} tuner${d.tunerCount === 1 ? '' : 's'}` : 'tuner count unknown';
    return {
      ok: true,
      message: `Connected to ${[d.name, d.version].filter(Boolean).join(' ')} · ${tuners} · ${r.channels.length} channels${r.bouquets ? ` in ${s.options?.bouquets?.length || 1} of ${r.bouquets.length} bouquets` : ''}.`,
      liveCount: r.channels.length, tunerCount: d.tunerCount, device: { name: d.name, model: d.model, version: d.version, tuners: d.tuners },
      bouquets: r.bouquets, profiles: r.profiles, warnings: r.warnings,
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/** The URL FFmpeg (or the proxy) opens for a channel: credentials added for TVHeadend and Enigma2 streamauth. */
export function tunerStreamUrl(src: Row, streamUrl: string): string {
  if (src.type === 'tvheadend' && src.username) return withUserInfo(streamUrl, src.username, src.password);
  if (src.type === 'enigma2' && src.username && parseJson<TunerOptions>(src.options, {}).streamAuth) return withUserInfo(streamUrl, src.username, src.password);
  return streamUrl;
}

/** Extra FFmpeg input options (RTSP transport for SAT>IP). */
export function tunerInputArgs(src: Row, url: string): string[] {
  if (src.type !== 'satip') return [];
  const o = parseJson<TunerOptions>(src.options, {});
  return satip.ffmpegInputArgs(url, o, o.satipMode === 'fritzbox' || /fritz/i.test(parseJson<{ name?: string }>(src.account_info, {}).name ?? ''));
}

/**
 * Open a tuner stream as MPEG-TS: RTSP (SAT>IP) is remuxed by FFmpeg, HTTP goes through the authenticating client.
 * Resolves once the first bytes arrived, so a busy tuner turns into an error instead of an empty 200.
 */
export async function openTunerStream(src: Row, url: string, userAgent: string, signal: AbortSignal): Promise<Readable> {
  if (/^rtsp:/i.test(url)) {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...tunerInputArgs(src, url), '-user_agent', userAgent, ...REMOTE_PROTOCOLS, '-i', url,
      '-map', '0:v?', '-map', '0:a?', '-map', '0:s?', '-c', 'copy', '-f', 'mpegts', 'pipe:1'];
    const p = spawn(config.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err = (err + d.toString()).slice(-500)));
    const kill = () => p.kill('SIGKILL');
    signal.addEventListener('abort', kill, { once: true });
    p.stdout.on('close', kill);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        kill();
        reject(new TunerHttpError('The tuner did not deliver a stream within 20 s'));
      }, 20000);
      p.stdout.once('readable', () => {
        clearTimeout(t);
        resolve();
      });
      p.once('error', (e) => {
        clearTimeout(t);
        reject(new TunerHttpError(`FFmpeg could not start: ${e.message}`));
      });
      p.once('exit', (code) => {
        clearTimeout(t);
        reject(new TunerHttpError(`The tuner refused the stream${err.trim() ? `: ${err.trim().split('\n').pop()}` : ` (FFmpeg exit ${code})`}`));
      });
    });
    return p.stdout;
  }
  const { url: clean, username, password } = splitUserInfo(url);
  const http = new TunerHttp({ username, password, authType: parseJson<TunerOptions>(src.options, {}).authType ?? 'auto' }, userAgent);
  const res = await http.fetch(clean, { signal });
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => undefined);
    throw new TunerHttpError(res.status === 503 || res.status === 509 ? 'No free tuner on the device' : `The device returned HTTP ${res.status}`, res.status);
  }
  return Readable.fromWeb(res.body as never);
}

/* ------------------------------ guides ------------------------------ */

registerGuideDriver('tvheadend', async (src, sink) => {
  await tvh.loadGuide(like(sourceIn(src)), sink);
});
registerGuideDriver('enigma2', async (src, sink) => {
  const chans = db.all<{ remote_id: string; name: string }>('SELECT remote_id, name FROM channels WHERE source_id = ?', src.id).map((c) => ({ ref: c.remote_id, name: c.name }));
  if (!chans.length) throw new TunerHttpError('No channels yet — refresh the source first');
  await e2.loadGuide(like(sourceIn(src)), sink, chans);
});

/** The guide driver a tuner source registers (SAT>IP has none: XMLTV / iptv-org guides are matched by name). */
export const guideDriverFor = (type: string): string | null => (type === 'tvheadend' || type === 'enigma2' ? type : null);

/* ------------------------------ TVHeadend recordings ------------------------------ */

export interface TunerRecordingOut {
  id: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  channelName: string | null;
  start: string | null;
  end: string | null;
  sizeBytes: number | null;
  status: string | null;
}

export async function listRecordings(src: Row): Promise<TunerRecordingOut[]> {
  if (src.type !== 'tvheadend') throw new TunerHttpError('Only TVHeadend sources have a recordings list');
  const list = await tvh.recordings(like(sourceIn(src)));
  return list.map((r) => ({
    id: r.uuid, title: r.disp_title || 'Recording', subtitle: r.disp_subtitle || null, description: r.disp_description || r.disp_summary || null, channelName: r.channelname ?? null,
    start: r.start ? new Date((r.start_real ?? r.start) * 1000).toISOString() : null, end: r.stop ? new Date((r.stop_real ?? r.stop) * 1000).toISOString() : null,
    sizeBytes: r.filesize ?? null, status: r.status ?? null,
  }));
}

export async function openRecording(src: Row, uuid: string, signal: AbortSignal, range?: string): Promise<Response> {
  if (src.type !== 'tvheadend' || !/^[0-9a-f]{32}$/i.test(uuid)) throw new TunerHttpError('Recording not found', 404);
  const s = sourceIn(src);
  const http = tvh.client(like(s));
  return http.fetch(tvh.recordingUrl(like(s), uuid), { signal, headers: range ? { Range: range } : {} });
}

log.debug('Tuner drivers registered');
