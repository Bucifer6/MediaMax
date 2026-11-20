import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type {
  ActiveSession, AudioStream, DeviceProfile, MediaSource, PlayMethod, PlaybackInfo, PlaybackRequest, SubtitleStream, SubtitleTrack, Marker,
} from '@mediamax/shared';
import { db, type Row } from '../db.js';
import { config } from '../config.js';
import { newId } from '../util/ids.js';
import { HttpError, badRequest, forbidden, notFound } from '../util/errors.js';
import { nowIso, parseJson, REMOTE_PROTOCOLS } from '../util/misc.js';
import { logger } from '../util/log.js';
import { TranscodeJob, type TranscodeOptions } from './transcoder.js';
import { getSettings } from './settings.js';
import { assertCanSee, getItem, mediaRowToSource, nextItem, reportProgress } from './items.js';
import type { AuthContext } from './auth.js';
import { events, bus } from './events.js';
import { TEXT_SUB_CODECS } from './probe.js';
import { isLocalAddress } from './dlna.js';

const log = logger('playback');

/* ------------------------------ sessions ---------------------------- */

export interface PlaySession {
  id: string;
  ctx: AuthContext;
  itemId: string | null;
  channelId: string | null;
  mediaId: string | null;
  method: PlayMethod;
  job: TranscodeJob | null;
  title: string;
  subtitle: string | null;
  posterUrl: string | null;
  durationMs: number | null;
  positionMs: number;
  state: 'playing' | 'paused' | 'buffering';
  startedAt: number;
  lastActivity: number;
  remoteAddr: string | null;
  historyId: number | null;
  /** Live sessions may hold an upstream provider connection. */
  onStop?: () => void;
}

const sessions = new Map<string, PlaySession>();

export const getSession = (id: string) => sessions.get(id);

export function touchSession(id: string) {
  const s = sessions.get(id);
  if (s) {
    s.lastActivity = Date.now();
    s.job?.tick();
  }
  return s;
}

function toActive(s: PlaySession): ActiveSession {
  return {
    id: s.id, userId: s.ctx.user.id, userName: s.ctx.user.displayName, deviceName: s.ctx.device.deviceName, platform: s.ctx.device.platform,
    itemId: s.itemId, channelId: s.channelId, title: s.title, subtitle: s.subtitle, posterUrl: s.posterUrl, method: s.method, state: s.state,
    positionMs: s.positionMs, durationMs: s.durationMs, startedAt: new Date(s.startedAt).toISOString(), remoteAddress: s.remoteAddr,
    transcodeInfo: s.job?.info && s.method !== 'direct' ? s.job.info : null,
  };
}

export const listSessions = (): ActiveSession[] => [...sessions.values()].map(toActive);
export const transcodeCount = () => [...sessions.values()].filter((s) => s.job && s.method === 'transcode').length;

let broadcastTimer: NodeJS.Timeout | null = null;
export function broadcastSessions() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    events.toAdmins({ type: 'sessions.updated', sessions: listSessions() });
  }, 300);
}

/**
 * Per-user limits: remote streaming permission and max simultaneous streams.
 * A new session on the same device replaces the old one, so it doesn't count against the limit.
 */
export function assertCanStartSession(ctx: AuthContext, remoteAddr: string | null) {
  const u = ctx.user;
  if (!u.allowRemote && !u.isAdmin && remoteAddr && !isLocalAddress(remoteAddr)) {
    throw new HttpError(403, 'Your account can only stream on the home network', 'remote_not_allowed');
  }
  if (u.maxStreams && !u.isAdmin) {
    const active = [...sessions.values()].filter((x) => x.ctx.user.id === u.id && x.ctx.deviceRowId !== ctx.deviceRowId).length;
    if (active >= u.maxStreams) {
      throw new HttpError(429, `You're already streaming on ${active} device${active === 1 ? '' : 's'} (limit ${u.maxStreams}). Stop one and try again.`, 'stream_limit');
    }
  }
}

export function registerSession(s: Omit<PlaySession, 'id' | 'startedAt' | 'lastActivity' | 'historyId' | 'state' | 'positionMs'> & { positionMs?: number }): PlaySession {
  assertCanStartSession(s.ctx, s.remoteAddr);
  // One active playback per device: replace the previous session.
  for (const old of sessions.values()) {
    if (old.ctx.deviceRowId === s.ctx.deviceRowId) stopSession(old.id, 'replaced', false);
  }
  const id = newId();
  const hist = db.run('INSERT INTO play_history (user_id, item_id, channel_id, started_at, method, platform) VALUES (?, ?, ?, ?, ?, ?)',
    s.ctx.user.id, s.itemId, s.channelId, nowIso(), s.method, s.ctx.device.platform);
  const session: PlaySession = { ...s, id, positionMs: s.positionMs ?? 0, state: 'buffering', startedAt: Date.now(), lastActivity: Date.now(), historyId: Number(hist.lastInsertRowid) };
  sessions.set(id, session);
  bus.emit('playback.start', session);
  broadcastSessions();
  return session;
}

export function stopSession(id: string, reason = 'stopped', notify = true) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  s.job?.stop();
  s.onStop?.();
  if (s.historyId) db.run('UPDATE play_history SET ended_at = ?, duration_ms = ? WHERE id = ?', nowIso(), Date.now() - s.startedAt, s.historyId);
  if (notify && reason !== 'stopped' && reason !== 'replaced') events.toUser(s.ctx.user.id, { type: 'session.terminated', sessionId: id, reason });
  bus.emit('playback.stop', s);
  broadcastSessions();
}

export function sessionProgress(ctx: AuthContext, id: string, positionMs: number, state: 'playing' | 'paused' | 'stopped', durationMs?: number) {
  const s = sessions.get(id);
  if (!s) return { ok: false };
  if (s.ctx.user.id !== ctx.user.id) throw forbidden();
  s.lastActivity = Date.now();
  const prev = s.state;
  s.positionMs = Math.max(0, positionMs);
  if (state !== 'stopped') s.state = state;
  if (s.itemId) reportProgress(ctx.user, s.itemId, s.positionMs, durationMs ?? s.durationMs, state);
  if (prev !== s.state) bus.emit(s.state === 'paused' ? 'playback.pause' : 'playback.resume', s);
  if (state === 'stopped') stopSession(id);
  else broadcastSessions();
  return { ok: true };
}

/** Reap idle sessions (no progress / segment requests). */
export function reapSessions() {
  const now = Date.now();
  for (const s of sessions.values()) {
    const idleLimit = s.state === 'paused' ? 30 * 60000 : s.method === 'direct' ? 5 * 60000 : 2 * 60000;
    if (now - s.lastActivity > idleLimit) {
      log.info(`Reaping idle session ${s.id} (${s.title})`);
      stopSession(s.id, 'idle', false);
    }
  }
}

/* ------------------------------ decisions --------------------------- */

const DEFAULT_PROFILE: Required<DeviceProfile> = {
  maxBitrate: null,
  maxWidth: null,
  videoCodecs: ['h264'],
  audioCodecs: ['aac', 'mp3', 'opus', 'flac'],
  containers: ['mp4', 'm4v', 'mov', 'webm', 'mp3', 'flac', 'm4a', 'ogg', 'aac', 'wav'],
  supportsHls: true,
};

export interface Decision {
  method: PlayMethod;
  videoCopy: boolean;
  audioCopy: boolean;
  reasons: string[];
}

export function decide(media: MediaSource, profile: DeviceProfile | undefined, opts: { audio: AudioStream | null; burnSubs: boolean; forceTranscode: boolean; allowTranscode: boolean; userMaxBitrate: number | null; isAudioOnly: boolean }): Decision {
  const p = { ...DEFAULT_PROFILE, ...(profile ?? {}) };
  const norm = (c: string | null) => (c ?? '').toLowerCase().replace('h265', 'hevc').replace('avc', 'h264');
  const vcodecs = (p.videoCodecs ?? []).map(norm);
  const acodecs = (p.audioCodecs ?? []).map(norm);
  const containers = (p.containers ?? []).map((c) => c.toLowerCase());
  const reasons: string[] = [];
  const maxBitrate = [p.maxBitrate, opts.userMaxBitrate].filter((x): x is number => !!x).reduce((a, b) => Math.min(a, b), Infinity);

  const videoOk = opts.isAudioOnly || !media.videoCodec || vcodecs.includes(norm(media.videoCodec));
  if (!videoOk) reasons.push(`video codec ${media.videoCodec} not supported`);
  const audioOk = !opts.audio || acodecs.includes(norm(opts.audio.codec));
  if (!audioOk) reasons.push(`audio codec ${opts.audio?.codec} not supported`);
  const containerOk = !!media.container && containers.includes(media.container.toLowerCase());
  if (!containerOk) reasons.push(`container ${media.container} not supported`);
  const bitrateOk = !media.bitrate || media.bitrate <= maxBitrate;
  if (!bitrateOk) reasons.push(`bitrate ${media.bitrate}k exceeds ${maxBitrate}k`);
  const widthOk = !p.maxWidth || !media.width || media.width <= p.maxWidth;
  if (!widthOk) reasons.push(`resolution exceeds ${p.maxWidth}`);
  // Non-default audio track: most players can't switch tracks in a progressive file.
  const audioTrackOk = !opts.audio || opts.audio.default || opts.isAudioOnly;
  if (!audioTrackOk) reasons.push('non-default audio track selected');

  const canTranscode = opts.allowTranscode && getSettings().transcoding.enabled;
  if (!opts.forceTranscode && !opts.burnSubs && videoOk && audioOk && containerOk && bitrateOk && widthOk && audioTrackOk) {
    return { method: 'direct', videoCopy: true, audioCopy: true, reasons: [] };
  }
  if (!canTranscode) {
    // Best effort: direct play even if probably unsupported.
    return { method: 'direct', videoCopy: true, audioCopy: true, reasons: [...reasons, 'transcoding not permitted'] };
  }
  // Remux when only the container (or audio) is the problem and HLS is available.
  if (!opts.forceTranscode && !opts.burnSubs && videoOk && bitrateOk && widthOk && p.supportsHls !== false && !opts.isAudioOnly) {
    return { method: 'remux', videoCopy: true, audioCopy: audioOk, reasons };
  }
  return { method: 'transcode', videoCopy: false, audioCopy: audioOk && !opts.forceTranscode && !opts.isAudioOnly ? true : false, reasons };
}

/* -------------------------------- start ----------------------------- */

const tokenQuery = (ctx: AuthContext, sessionId?: string) => `?token=${encodeURIComponent(ctx.token)}${sessionId ? `&session=${sessionId}` : ''}`;

const MIME_BY_CONTAINER: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', ts: 'video/mp2t', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', wav: 'audio/wav', opus: 'audio/ogg',
};

export function subtitleTracks(ctx: AuthContext, mediaId: string, subs: SubtitleStream[]): SubtitleTrack[] {
  return subs.filter((s) => TEXT_SUB_CODECS.has(s.codec)).map((s) => ({
    index: s.index, language: s.language, title: s.title, default: s.default, forced: s.forced,
    url: `/api/v1/stream/subtitles/${mediaId}/${s.index}.vtt${tokenQuery(ctx)}`,
  }));
}

export async function startPlayback(ctx: AuthContext, itemId: string, req: PlaybackRequest, remoteAddr: string | null): Promise<PlaybackInfo> {
  assertCanSee(ctx.user, itemId);
  assertCanStartSession(ctx, remoteAddr);
  const item = getItem(ctx.user, itemId, true);
  if (!item.media?.length) {
    if (item.type === 'show' || item.type === 'season') {
      // Play the next-up/first episode of a container.
      throw badRequest('Choose an episode to play');
    }
    throw notFound('No playable media for this item');
  }
  const mediaRow = req.mediaId
    ? db.get('SELECT * FROM media WHERE id = ? AND item_id = ?', req.mediaId, itemId)
    : db.get('SELECT * FROM media WHERE item_id = ? ORDER BY COALESCE(width,0) DESC LIMIT 1', itemId);
  if (!mediaRow) throw notFound('Media not found');
  if (item.type === 'photo') throw badRequest('Photos are not playable');
  const media = mediaRowToSource(mediaRow);
  const rawSubs = parseJson<(SubtitleStream & { path?: string })[]>(mediaRow.subs, []);
  const prefs = ctx.user.preferences;

  // Pick audio track: explicit → preferred language → default.
  let audio: AudioStream | null = null;
  if (req.audioStreamIndex != null) audio = media.audioStreams.find((a) => a.index === req.audioStreamIndex) ?? null;
  if (!audio && prefs.audioLanguage) audio = media.audioStreams.find((a) => a.language === prefs.audioLanguage) ?? null;
  if (!audio) audio = media.audioStreams.find((a) => a.default) ?? media.audioStreams[0] ?? null;

  const burnSub = req.burnSubtitles && req.subtitleStreamIndex != null ? rawSubs.find((s) => s.index === req.subtitleStreamIndex) ?? null : null;
  // Image-based subtitles can only be shown by burning them in.
  const imageSubSelected = req.subtitleStreamIndex != null && rawSubs.find((s) => s.index === req.subtitleStreamIndex && !TEXT_SUB_CODECS.has(s.codec));
  const effectiveBurn = burnSub ?? (imageSubSelected || null);

  const isAudioOnly = item.type === 'track' || !media.videoCodec;
  const decision = decide(media, req.deviceProfile, {
    audio, burnSubs: !!effectiveBurn, forceTranscode: !!req.forceTranscode, allowTranscode: ctx.user.allowTranscode,
    userMaxBitrate: prefs.maxBitrate, isAudioOnly,
  });
  if (decision.method !== 'direct' && transcodeCount() >= getSettings().transcoding.maxConcurrent && decision.method === 'transcode') {
    throw new HttpError(503, 'The server is busy transcoding other streams. Try again shortly or choose original quality.', 'transcoder_busy');
  }
  const startMs = Math.max(0, req.startMs ?? item.userData.positionMs ?? 0);
  const next = item.type === 'episode' || item.type === 'track' ? nextItem(ctx.user, itemId) : null;
  const markers: Marker[] = item.markers ?? [];
  const subtitleText = item.type === 'episode'
    ? `${item.grandparentTitle ?? ''} · S${item.parentIndex ?? 0}E${item.index ?? 0}`
    : item.type === 'track' ? [item.grandparentTitle, item.parentTitle].filter(Boolean).join(' — ') : item.year ? String(item.year) : null;

  const base = {
    ctx, itemId, channelId: null, mediaId: media.id, title: item.title, subtitle: subtitleText, posterUrl: item.posterUrl,
    durationMs: media.durationMs || item.durationMs, remoteAddr, positionMs: startMs,
  };
  const input = mediaRow.path ?? mediaRow.remote_url;
  const inputArgs = mediaRow.remote_url ? remoteInputArgs(mediaRow) : [];

  let session: PlaySession;
  let url: string;
  let mimeType: string;
  let isHls = false;
  let responseStart = startMs;
  if (decision.method === 'direct') {
    session = registerSession({ ...base, method: 'direct', job: null });
    url = `/api/v1/stream/direct/${media.id}${tokenQuery(ctx, session.id)}`;
    mimeType = MIME_BY_CONTAINER[media.container ?? ''] ?? (isAudioOnly ? 'audio/mpeg' : 'video/mp4');
  } else {
    const p = { ...DEFAULT_PROFILE, ...(req.deviceProfile ?? {}) };
    const maxBitrate = [p.maxBitrate, prefs.maxBitrate].filter((x): x is number => !!x).reduce((a, b) => Math.min(a, b), Infinity);
    const target = Math.min(Number.isFinite(maxBitrate) ? maxBitrate : getSettings().transcoding.defaultBitrate, media.bitrate ? Math.max(media.bitrate, 1500) : Infinity, getSettings().transcoding.defaultBitrate * 4);
    const opts: TranscodeOptions = {
      // Always encode against the full timeline (segments are produced on demand),
      // the client seeks to startMs. This keeps PTS == playlist time for every player.
      input, inputArgs, startSec: 0, durationSec: media.durationMs ? media.durationMs / 1000 : null,
      mode: decision.method === 'remux' ? 'remux' : 'transcode',
      audioIndex: audio?.index ?? null, audioCopy: decision.audioCopy, videoCopy: decision.videoCopy,
      bitrate: Math.round(target), maxHeight: p.maxWidth ? Math.round((p.maxWidth * 9) / 16) : null, sourceHeight: media.height,
      sourceCodec: media.videoCodec, hdr: media.hdr, audioChannels: audio?.channels, hasVideo: !isAudioOnly,
      burnSubtitle: effectiveBurn
        ? effectiveBurn.external
          ? { kind: 'external', file: effectiveBurn.path }
          : TEXT_SUB_CODECS.has(effectiveBurn.codec)
            ? { kind: 'embedded-text', relIndex: rawSubs.filter((s) => !s.external).findIndex((s) => s.index === effectiveBurn.index) }
            : { kind: 'embedded-image', streamIndex: effectiveBurn.index }
        : null,
    };
    const job = new TranscodeJob(newId(), opts);
    session = registerSession({ ...base, method: decision.method, job });
    job.start(decision.method === 'transcode' && startMs > 0 ? Math.floor(startMs / 1000 / job.segmentSeconds) : 0);
    if (decision.method === 'remux') {
      try {
        await job.waitForPlaylist();
      } catch (e) {
        stopSession(session.id);
        throw new HttpError(500, `Could not start stream: ${(e as Error).message}`, 'stream_failed');
      }
    }
    url = `/api/v1/stream/hls/${session.id}/master.m3u8${tokenQuery(ctx)}`;
    mimeType = 'application/x-mpegURL';
    isHls = true;
    log.info(`${ctx.user.displayName} → ${decision.method} "${item.title}": ${decision.reasons.join('; ')}`);
  }
  return {
    sessionId: session.id,
    itemId,
    channelId: null,
    method: decision.method,
    url,
    mimeType,
    isHls,
    startMs: responseStart,
    streamStartMs: 0,
    durationMs: media.durationMs || item.durationMs,
    audioStreams: media.audioStreams,
    subtitles: effectiveBurn ? [] : subtitleTracks(ctx, media.id, rawSubs),
    markers,
    nextItemId: next?.id ?? null,
    title: item.title,
    subtitle: subtitleText,
    posterUrl: item.posterUrl,
    backdropUrl: item.backdropUrl,
  };
}

/** Input options for remote (IPTV) files. */
export function remoteInputArgs(mediaRow: Row): string[] {
  const ua = mediaRow.remote_url ? db.get<{ user_agent: string | null }>(
    `SELECT s.user_agent FROM live_sources s JOIN libraries l ON l.source_id = s.id JOIN items i ON i.library_id = l.id WHERE i.id = ?`, mediaRow.item_id)?.user_agent : null;
  return ['-user_agent', ua || 'MediaMax/1.0', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];
}

/* ------------------------------ subtitles --------------------------- */

const subInflight = new Map<string, Promise<string>>();

export async function subtitleVtt(mediaId: string, index: number): Promise<string> {
  const m = db.get('SELECT * FROM media WHERE id = ?', mediaId);
  if (!m) throw notFound('Media not found');
  const subs = parseJson<(SubtitleStream & { path?: string })[]>(m.subs, []);
  const s = subs.find((x) => x.index === index);
  if (!s) throw notFound('Subtitle not found');
  if (!TEXT_SUB_CODECS.has(s.codec)) throw badRequest('Image subtitles must be burned in');
  const dir = path.join(config.cacheDir, 'subs');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${mediaId}_${index}_${m.mtime ?? 0}.vtt`);
  if (fs.existsSync(out)) return out;
  let p = subInflight.get(out);
  if (!p) {
    p = new Promise<string>((resolve, reject) => {
      const input = s.external ? s.path! : m.path ?? m.remote_url;
      const args = ['-v', 'error', '-y', ...(path.isAbsolute(input) ? [] : REMOTE_PROTOCOLS), '-i', input];
      if (!s.external) args.push('-map', `0:${s.index}`);
      args.push('-f', 'webvtt', out + '.tmp');
      const proc = spawn(config.ffmpeg, args);
      let err = '';
      proc.stderr.on('data', (d) => (err += d));
      proc.on('error', reject);
      proc.on('exit', (code) => {
        if (code === 0) {
          fs.renameSync(out + '.tmp', out);
          resolve(out);
        } else reject(new Error(err.trim() || 'Subtitle conversion failed'));
      });
    }).finally(() => subInflight.delete(out));
    subInflight.set(out, p);
  }
  return p;
}
