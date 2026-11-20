import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type {
  ActiveSession, AudioComforts, AudioStream, DeviceProfile, MediaSource, PlayMethod, PlaybackInfo, PlaybackRequest, SubtitleStream, SubtitleTrack, Marker,
} from '@mediamax/shared';
import { db, type Row } from '../db.js';
import { config } from '../config.js';
import { newId } from '../util/ids.js';
import { HttpError, badRequest, forbidden, notFound } from '../util/errors.js';
import { nowIso, parseJson, REMOTE_PROTOCOLS } from '../util/misc.js';
import { logger } from '../util/log.js';
import { TranscodeJob, encoderWorks, hasEncoder, type TranscodeOptions } from './transcoder.js';
import { chooseVideoCodec } from './hwaccel.js';
import { getSettings } from './settings.js';
import { assertCanSee, getItem, mediaRowToSource, nextItem, reportProgress } from './items.js';
import type { AuthContext } from './auth.js';
import { events, bus } from './events.js';
import { TEXT_SUB_CODECS } from './probe.js';
import { isLocalAddress } from './dlna.js';
import { outputRange, rangeDecision, type RangeDecision } from './hdr.js';
import { doviCodecStyle, doviMuxCapability, doviMuxSupported, doviSignal, type DoviSignal } from './dovi.js';
import { refreshVideoRange } from './hdrBackfill.js';
import { subtitleTrackList } from './subtitles.js';
import { anyComfort, decisionInfo, masterAudioFor, normalizeComforts, planAudio, refreshAudioStreams, type AudioPlan } from './audio.js';
import { bitrateCaps, buildLadder, createRenditionManager, pickStartRendition, streamingSettings, type RenditionManager } from './abr.js';

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
  /** Adaptive transcode: lazily encoded renditions of a multi-variant master playlist (abr.ts). `job` is the active one. */
  abr?: RenditionManager | null;
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
  /** Live multiview tile: several may run side by side on one device. */
  multiview?: boolean;
  /** Muted trailer preview (home hero / card hover): runs beside other playback, no history, scrobbles or webhooks. */
  preview?: boolean;
}

const MAX_MULTIVIEW = 4;

const sessions = new Map<string, PlaySession>();

export const getSession = (id: string) => sessions.get(id);

export function touchSession(id: string) {
  const s = sessions.get(id);
  if (s) {
    s.lastActivity = Date.now();
    s.job?.tick();
    s.abr?.tick();
  }
  return s;
}

function toActive(s: PlaySession): ActiveSession {
  return {
    id: s.id, userId: s.ctx.user.id, userName: s.ctx.user.parentUserId && s.ctx.user.ownerName ? `${s.ctx.user.ownerName} › ${s.ctx.user.displayName}` : s.ctx.user.displayName, deviceName: s.ctx.device.deviceName, platform: s.ctx.device.platform,
    itemId: s.itemId, channelId: s.channelId, title: s.title, subtitle: s.subtitle, posterUrl: s.posterUrl, method: s.method, state: s.state,
    positionMs: s.positionMs, durationMs: s.durationMs, startedAt: new Date(s.startedAt).toISOString(), remoteAddress: s.remoteAddr,
    transcodeInfo: s.job?.info && s.method !== 'direct' ? s.job.info : null,
  };
}

export const listSessions = (): ActiveSession[] => [...sessions.values()].filter((s) => !s.preview).map(toActive);
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
export function assertCanStartSession(ctx: AuthContext, remoteAddr: string | null, multiview = false) {
  const u = ctx.user;
  if (!u.allowRemote && !u.isAdmin && remoteAddr && !isLocalAddress(remoteAddr)) {
    throw new HttpError(403, 'Your account can only stream on the home network', 'remote_not_allowed');
  }
  if (u.maxStreams && !u.isAdmin) {
    // Other devices count; on this device only multiview tiles that will keep running alongside the new one count.
    // The limit is per account: the owner and all of its profiles share it.
    const account = u.parentUserId || u.id;
    const active = [...sessions.values()].filter((x) => !x.preview && (x.ctx.user.parentUserId || x.ctx.user.id) === account && (x.ctx.deviceRowId !== ctx.deviceRowId || (multiview && x.multiview))).length;
    if (active >= u.maxStreams) {
      const who = u.parentUserId ? 'Your account already has' : 'You already have';
      throw new HttpError(429, `${who} ${active} stream${active === 1 ? '' : 's'} playing (limit ${u.maxStreams}). Stop one and try again.`, 'stream_limit');
    }
  }
}

export function registerSession(s: Omit<PlaySession, 'id' | 'startedAt' | 'lastActivity' | 'historyId' | 'state' | 'positionMs'> & { positionMs?: number }): PlaySession {
  assertCanStartSession(s.ctx, s.remoteAddr, !!s.multiview);
  if (s.preview) {
    // Previews only replace an earlier preview on this device and stay out of history, stats and integrations.
    for (const old of [...sessions.values()]) if (old.preview && old.ctx.deviceRowId === s.ctx.deviceRowId) stopSession(old.id, 'replaced', false);
    const session: PlaySession = { ...s, id: newId(), positionMs: s.positionMs ?? 0, state: 'buffering', startedAt: Date.now(), lastActivity: Date.now(), historyId: null };
    sessions.set(session.id, session);
    return session;
  }
  // One active playback per device: replace the previous session. Multiview tiles coexist with each other (up to 4).
  const mine = [...sessions.values()].filter((o) => o.ctx.deviceRowId === s.ctx.deviceRowId && !o.preview).sort((a, b) => a.startedAt - b.startedAt);
  const keep = s.multiview ? mine.filter((o) => o.multiview).slice(-(MAX_MULTIVIEW - 1)) : [];
  for (const old of mine) if (!keep.includes(old)) stopSession(old.id, 'replaced', false);
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
  s.abr?.stop();
  s.onStop?.();
  if (s.preview) return;
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
  if (s.preview) {
    if (state === 'stopped') stopSession(id);
    return { ok: true };
  }
  if (s.itemId) reportProgress(ctx.user, s.itemId, s.positionMs, durationMs ?? s.durationMs, state);
  if (prev !== s.state) bus.emit(s.state === 'paused' ? 'playback.pause' : 'playback.resume', s);
  if (state === 'stopped') stopSession(id);
  else broadcastSessions();
  return { ok: true };
}

/** Server shutdown: stop every session so no ffmpeg transcode outlives the server. */
export function stopAllSessions() {
  for (const id of [...sessions.keys()]) stopSession(id, 'shutdown', false);
}

/** End every session of an account and its profiles (the account or profile is being deleted). */
export function stopUserSessions(userId: string, reason = 'user_deleted') {
  for (const s of [...sessions.values()]) {
    if (s.ctx.user.id === userId || s.ctx.user.parentUserId === userId) stopSession(s.id, reason, false);
  }
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

const DEFAULT_PROFILE: DeviceProfile & Required<Pick<DeviceProfile, 'maxBitrate' | 'maxWidth' | 'videoCodecs' | 'audioCodecs' | 'containers' | 'supportsHls'>> = {
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
  /** HDR → SDR tone-mapping when transcoding (undefined = legacy client: admin setting decides). See hdr.ts. */
  toneMap?: boolean;
  /** Bitstream filter for copied video (Dolby Vision profile 7 → HDR10 base layer). */
  videoBsf?: string | null;
  /** How the source's dynamic range reaches the client. */
  range?: RangeDecision;
  /** Remux keeps real Dolby Vision (DV configuration box + DV codec strings in the master playlist). See dovi.ts. */
  dolbyVision?: DoviSignal | null;
  /** Audio delivery for the selected track (audio.ts); null for audio-only items and files without audio. */
  audio?: AudioPlan | null;
}

export function decide(media: MediaSource, profile: DeviceProfile | undefined, opts: {
  audio: AudioStream | null; burnSubs: boolean; forceTranscode: boolean; allowTranscode: boolean; userMaxBitrate: number | null; isAudioOnly: boolean;
  /** FFmpeg keeps Dolby Vision configuration when remuxing (dovi.ts doviMuxSupported); defaults to the cached check. */
  doviMux?: boolean;
  /** Listening comforts to apply when the audio is encoded; with `forceAudioProcessing` the audio is re-encoded for them. */
  audioProcessing?: AudioComforts | null; forceAudioProcessing?: boolean;
}): Decision {
  const p = { ...DEFAULT_PROFILE, ...(profile ?? {}) };
  const norm = (c: string | null) => (c ?? '').toLowerCase().replace('h265', 'hevc').replace('avc', 'h264');
  const vcodecs = (p.videoCodecs ?? []).map(norm);
  const acodecs = (p.audioCodecs ?? []).map(norm);
  const containers = (p.containers ?? []).map((c) => c.toLowerCase());
  const reasons: string[] = [];
  const maxBitrate = [p.maxBitrate, opts.userMaxBitrate].filter((x): x is number => !!x).reduce((a, b) => Math.min(a, b), Infinity);

  const videoOk = opts.isAudioOnly || !media.videoCodec || vcodecs.includes(norm(media.videoCodec));
  if (!videoOk) reasons.push(`video codec ${media.videoCodec} not supported`);
  // HDR / Dolby Vision vs. the client's video-range capabilities, 10-bit decode and max height (hdr.ts).
  const range = rangeDecision(media.videoRange, media.hdr, p.videoRange);
  const rangeOk = opts.isAudioOnly || range.ok;
  if (!rangeOk) reasons.push(...range.reasons);
  const tenBitOk = opts.isAudioOnly || !p.tenBitCodecs || !media.videoRange?.bitDepth || media.videoRange.bitDepth <= 8 || p.tenBitCodecs.map(norm).includes(norm(media.videoCodec));
  if (!tenBitOk && videoOk) reasons.push(`10-bit ${media.videoCodec} not supported`);
  const heightOk = !p.maxHeight || !media.height || media.height <= p.maxHeight;
  if (!heightOk) reasons.push(`resolution exceeds ${p.maxHeight}p`);
  const videoPlayable = videoOk && rangeOk && tenBitOk && heightOk;
  // Formats the client bitstreams to an AV receiver count as supported audio.
  for (const a of p.audioPassthrough ?? []) if (!acodecs.includes(norm(a))) acodecs.push(norm(a));
  // Audio decision (audio.ts): copy / DTS core / E-AC-3 / AAC 7.1·5.1·stereo. Music keeps the plain codec check.
  const comforts = normalizeComforts(opts.audioProcessing);
  const planOpts = { comforts, forceProcessing: !!opts.forceAudioProcessing && anyComfort(comforts), hasEncoder };
  let audioPlan = opts.audio && !opts.isAudioOnly ? planAudio(opts.audio, p, planOpts) : null;
  const audioOk = !opts.audio || (audioPlan ? audioPlan.copyOk : acodecs.includes(norm(opts.audio.codec)));
  // Smart clients (and processing requests) get the specific reason, e.g. "TrueHD Atmos → E-AC-3 5.1: device can't play TrueHD".
  if (!audioOk) reasons.push(audioPlan?.reason && (p.maxAudioChannels || planOpts.forceProcessing) ? audioPlan.reason : `audio codec ${opts.audio?.codec} not supported`);
  const containerOk = !!media.container && containers.includes(media.container.toLowerCase());
  if (!containerOk) reasons.push(`container ${media.container} not supported`);
  const bitrateOk = !media.bitrate || media.bitrate <= maxBitrate;
  if (!bitrateOk) reasons.push(`bitrate ${media.bitrate}k exceeds ${maxBitrate}k`);
  const widthOk = !p.maxWidth || !media.width || media.width <= p.maxWidth;
  if (!widthOk) reasons.push(`resolution exceeds ${p.maxWidth}`);
  // Non-default audio track: most players can't switch tracks in a progressive file.
  const audioTrackOk = !opts.audio || opts.audio.default || opts.isAudioOnly || !!p.canSelectAudioTrack;
  if (!audioTrackOk) reasons.push('non-default audio track selected');

  const canTranscode = opts.allowTranscode && getSettings().transcoding.enabled;
  // Dual-layer Dolby Vision for an HDR10 client: the video can be copied, but only with its DV layers stripped.
  const needsRemux = !opts.isAudioOnly && range.needsRemux;
  if (needsRemux) reasons.push(...range.reasons.filter((r) => !reasons.includes(r)));
  // Transcoding an HDR source: the transcoder outputs 8-bit SDR, so tone-map (legacy clients: admin setting decides).
  // A Dolby Vision stream with an SDR base layer (8.2 / 9) is already SDR: tone-mapping it would distort the picture.
  const sdrBaseLayer = !!media.videoRange?.dolbyVision && media.videoRange.fallback === 'sdr';
  const hdrOut = range.delivery === 'tonemap' || (!sdrBaseLayer && outputRange(media.videoRange, media.hdr, range.delivery) !== 'sdr');
  const toneMap = range.legacy ? undefined : !opts.isAudioOnly && hdrOut;
  if (!opts.forceTranscode && !opts.burnSubs && videoPlayable && !needsRemux && audioOk && containerOk && bitrateOk && widthOk && audioTrackOk) {
    return { method: 'direct', videoCopy: true, audioCopy: true, reasons: [], range, audio: audioPlan };
  }
  if (!canTranscode) {
    // Best effort: direct play even if probably unsupported.
    return { method: 'direct', videoCopy: true, audioCopy: true, reasons: [...reasons, 'transcoding not permitted'], range, audio: audioPlan };
  }
  // Remux when only the container (or audio) is the problem and HLS is available.
  if (!opts.forceTranscode && !opts.burnSubs && videoPlayable && bitrateOk && widthOk && p.supportsHls !== false && !opts.isAudioOnly) {
    const dv = media.videoRange?.dolbyVision;
    if (range.delivery !== 'passthrough' || !dv || !p.videoRange) {
      return { method: 'remux', videoCopy: true, audioCopy: audioOk, reasons, range, videoBsf: range.videoBsf, audio: audioPlan };
    }
    // Dolby Vision to a DV client through a remux: keep the DV configuration box and announce the DV codec (dovi.ts).
    const signal = doviSignal(dv, { videoCodec: media.videoCodec, height: media.height, frameRate: media.videoRange?.frameRate, transfer: media.videoRange?.colorTransfer });
    if (signal && (opts.doviMux ?? doviMuxCapability() ?? false)) {
      return { method: 'remux', videoCopy: true, audioCopy: audioOk, reasons, range, videoBsf: null, dolbyVision: signal, audio: audioPlan };
    }
    // This FFmpeg can't carry Dolby Vision through the remux: decide as for a device without Dolby Vision.
    const base = rangeDecision(media.videoRange, media.hdr, { ...p.videoRange, dolbyVision: false });
    const why = `Dolby Vision ${signal?.profile ?? ''} can't be remuxed with its Dolby Vision signalling by this FFmpeg`.replace('  ', ' ');
    if (base.ok) return { method: 'remux', videoCopy: true, audioCopy: audioOk, reasons: [...reasons, why], range: base, videoBsf: base.videoBsf, audio: audioPlan };
    reasons.push(why, ...base.reasons);
    const tm: RangeDecision = { ...base, delivery: 'tonemap', toneMap: true };
    return { method: 'transcode', videoCopy: false, audioCopy: audioOk && !opts.forceTranscode, reasons, toneMap: true, range: tm, audio: audioPlan };
  }
  const willToneMap = toneMap ?? (hdrOut && !opts.isAudioOnly && getSettings().transcoding.toneMapHdr);
  const tmRange: RangeDecision = willToneMap ? { ...range, delivery: 'tonemap', toneMap: true }
    : sdrBaseLayer && range.delivery === 'passthrough' ? { ...range, delivery: 'base-layer' } : range;
  const audioCopy = audioOk && !opts.forceTranscode && !opts.isAudioOnly;
  // Forced transcodes re-encode the audio too (as before), with the same target choice.
  if (audioPlan && !audioCopy && audioPlan.delivery === 'copy') audioPlan = planAudio(opts.audio!, p, { ...planOpts, noCopy: true });
  // "remuxed to its HDR10 base layer" doesn't apply once the video is encoded.
  const why = needsRemux ? reasons.filter((r) => !range.reasons.includes(r)) : reasons;
  return { method: 'transcode', videoCopy: false, audioCopy, reasons: why, toneMap, range: tmRange, audio: audioPlan };
}

/**
 * Tallest output a transcode may produce for a client: its `maxHeight`, and the height at which the source's aspect
 * ratio reaches its `maxWidth` (a 2.39:1 film at 1920 wide is ~804 lines, not 1080). Null = no limit.
 */
export function outputMaxHeight(p: Pick<DeviceProfile, 'maxWidth' | 'maxHeight'>, sourceWidth: number | null, sourceHeight: number | null): number | null {
  const aspect = sourceWidth && sourceHeight ? sourceWidth / sourceHeight : 16 / 9;
  // Narrower-than-16:9 sources keep the old 16:9 assumption (maxWidth usually describes a 16:9 screen).
  const limits = [p.maxHeight, p.maxWidth ? Math.round(p.maxWidth / Math.max(aspect, 16 / 9)) : null]
    .filter((x): x is number => typeof x === 'number' && x > 0);
  return limits.length ? Math.min(...limits) : null;
}

/** Output codec for a transcode: HEVC/AV1 with the hardware encoder when the client plays it (see chooseVideoCodec). */
export function transcodeCodecFor(profile: DeviceProfile | undefined) {
  const t = getSettings().transcoding;
  return chooseVideoCodec({
    clientCodecs: profile?.videoCodecs ?? DEFAULT_PROFILE.videoCodecs, preferred: t.preferredCodecs ?? ['h264'],
    allowHevc: t.allowHevcEncoding ?? false, allowAv1: t.allowAv1Encoding ?? false, hw: t.hwAccel,
    codecWorks: (c) => encoderWorks(t.hwAccel, c),
  });
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
  const preview = !!req.preview;
  if (preview && !(item.type === 'video' && item.parentId && item.extraType === 'trailer')) throw badRequest('Previews are only available for trailers');
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
  // Empty or unreadable local files (ffprobe failed at scan time): say so instead of handing the player a broken stream.
  if (mediaRow.path && !mediaRow.remote_url && (mediaRow.size === 0 || (!mediaRow.probed_at && !mediaRow.video_codec && !parseJson<unknown[]>(mediaRow.audio, []).length))) {
    throw new HttpError(422, 'This file could not be read. It may be damaged or still being copied; rescan the library once it is complete.', 'unreadable_media');
  }
  // Files scanned before HDR detection: identify the HDR format now (one quick ffprobe, stored for next time).
  if (mediaRow.hdr && mediaRow.video_range == null && mediaRow.path) {
    try {
      const vr = await refreshVideoRange(mediaRow.id);
      if (vr) mediaRow.video_range = JSON.stringify(vr);
    } catch {
      /* keep the plain HDR flag */
    }
  }
  // Files scanned before audio-format detection: read profiles / layouts / Atmos flags now (one quick ffprobe, stored).
  if (item.type !== 'track' && mediaRow.path && mediaRow.video_codec !== null && parseJson<AudioStream[]>(mediaRow.audio, []).some((a) => a.formatLabel === undefined)) {
    try {
      const streams = await refreshAudioStreams(mediaRow.id);
      if (streams) mediaRow.audio = JSON.stringify(streams);
    } catch {
      /* keep what was stored */
    }
  }
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
  // Bitrate limits: device profile, user preference, the remote cap (non-LAN clients) and — for the direct-play
  // decision only — the client's measured bandwidth (abr.ts). LAN clients are unlimited unless they measured otherwise.
  const isLocal = !!remoteAddr && isLocalAddress(remoteAddr);
  const caps = bitrateCaps({ profileMax: req.deviceProfile?.maxBitrate, userMax: prefs.maxBitrate, isLocal, measuredKbps: req.measuredBandwidth, remoteMax: streamingSettings().remoteMaxBitrate });
  const decideProfile = Number.isFinite(caps.decisionKbps) ? { ...(req.deviceProfile ?? {}), maxBitrate: Math.round(caps.decisionKbps) } : req.deviceProfile;
  // Real Dolby Vision through a remux depends on this FFmpeg build (checked once, ~100 ms; dovi.ts).
  if (media.videoRange?.dolbyVision && req.deviceProfile?.videoRange?.dolbyVision) await doviMuxSupported().catch(() => false);
  const audioProcessing = req.audioProcessing ? normalizeComforts(req.audioProcessing) : null;
  const decision = decide(media, decideProfile, {
    audio, burnSubs: !!effectiveBurn, forceTranscode: !!req.forceTranscode, allowTranscode: ctx.user.allowTranscode,
    userMaxBitrate: prefs.maxBitrate, isAudioOnly, audioProcessing, forceAudioProcessing: !!req.forceAudioProcessing,
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
    durationMs: media.durationMs || item.durationMs, remoteAddr, positionMs: preview ? 0 : startMs, preview,
  };
  const input = mediaRow.path ?? mediaRow.remote_url;
  const inputArgs = mediaRow.remote_url ? remoteInputArgs(mediaRow) : [];

  let session: PlaySession;
  let url: string;
  let mimeType: string;
  let isHls = false;
  let responseStart = startMs;
  let abr: RenditionManager | null = null;
  let renditions: ReturnType<typeof buildLadder> | undefined;
  let startRendition: number | null = null;
  if (decision.method === 'direct') {
    session = registerSession({ ...base, method: 'direct', job: null });
    url = `/api/v1/stream/direct/${media.id}${tokenQuery(ctx, session.id)}`;
    mimeType = MIME_BY_CONTAINER[media.container ?? ''] ?? (isAudioOnly ? 'audio/mpeg' : 'video/mp4');
  } else {
    const p = { ...DEFAULT_PROFILE, ...(req.deviceProfile ?? {}) };
    // Adaptive (multi-rendition) transcodes let the player climb to the hard cap; single-variant streams start at the measured fit.
    const adaptive = decision.method === 'transcode' && !!req.adaptive && streamingSettings().adaptive && !isAudioOnly && !preview && !!media.durationMs;
    const maxBitrate = adaptive ? caps.capKbps : caps.decisionKbps;
    const target = Math.min(Number.isFinite(maxBitrate) ? maxBitrate : getSettings().transcoding.defaultBitrate, media.bitrate ? Math.max(media.bitrate, 1500) : Infinity, getSettings().transcoding.defaultBitrate * 4);
    const opts: TranscodeOptions = {
      // Always encode against the full timeline (segments are produced on demand),
      // the client seeks to startMs. This keeps PTS == playlist time for every player.
      input, inputArgs, startSec: 0, durationSec: media.durationMs ? media.durationMs / 1000 : null,
      mode: decision.method === 'remux' ? 'remux' : 'transcode',
      audioIndex: audio?.index ?? null, audioCopy: decision.audioCopy, videoCopy: decision.videoCopy,
      bitrate: Math.round(target), maxHeight: outputMaxHeight(p, media.width, media.height), sourceHeight: media.height,
      // Decoding Dolby Vision 8.2 / 9 gives its SDR base layer: nothing to tone-map.
      sourceCodec: media.videoCodec, hdr: media.hdr && !(media.videoRange?.dolbyVision && media.videoRange.fallback === 'sdr'), audioChannels: audio?.channels, hasVideo: !isAudioOnly,
      burnSubtitle: effectiveBurn
        ? effectiveBurn.external
          ? { kind: 'external', file: effectiveBurn.path }
          : TEXT_SUB_CODECS.has(effectiveBurn.codec)
            ? { kind: 'embedded-text', relIndex: rawSubs.filter((s) => !s.external).findIndex((s) => s.index === effectiveBurn.index) }
            : { kind: 'embedded-image', streamIndex: effectiveBurn.index }
        : null,
    };
    if (!decision.videoCopy && !isAudioOnly) opts.videoCodec = transcodeCodecFor(req.deviceProfile);
    if (decision.toneMap !== undefined) opts.toneMap = decision.toneMap;
    if (decision.videoCopy && decision.videoBsf) opts.videoBsf = decision.videoBsf;
    if (decision.videoCopy && decision.dolbyVision) {
      opts.dolbyVision = {
        ...decision.dolbyVision, style: doviCodecStyle(req.deviceProfile?.player),
        bandwidthKbps: media.bitrate ?? null, width: media.width, height: media.height, frameRate: media.videoRange?.frameRate ?? null,
      };
    }
    if (decision.audio) opts.audioPlan = decision.audio;
    const ladder = adaptive
      ? buildLadder({ sourceWidth: media.width, sourceHeight: media.height, sourceKbps: media.bitrate, capKbps: caps.capKbps, maxHeight: opts.maxHeight, audioKbps: decision.audio?.bitrateKbps ?? (opts.audioCopy ? 320 : (audio?.channels ?? 2) > 2 ? 384 : 192) })
      : [];
    let job: TranscodeJob;
    if (ladder.length > 1) {
      const startSegment = startMs > 0 ? Math.floor(startMs / 1000 / getSettings().transcoding.segmentSeconds) : 0;
      startRendition = pickStartRendition(ladder, req.measuredBandwidth);
      const holder: { s: PlaySession | null } = { s: null };
      abr = createRenditionManager(newId(), opts, ladder, startRendition, startSegment, {
        otherEncoders: () => [...sessions.values()].filter((x) => x.job && !x.abr && x.method !== 'direct' && !x.job.exited).length,
        masterAudio: masterAudioFor(decision.audio, audio),
        onActiveChange: (j) => {
          if (!holder.s) return;
          holder.s.job = j as TranscodeJob;
          broadcastSessions();
        },
      });
      renditions = ladder;
      job = abr.activeJob as TranscodeJob;
      try {
        session = registerSession({ ...base, method: decision.method, job, abr });
      } catch (e) {
        abr.stop();
        throw e;
      }
      holder.s = session;
    } else {
      job = new TranscodeJob(newId(), opts);
      session = registerSession({ ...base, method: decision.method, job });
      job.start(decision.method === 'transcode' && startMs > 0 ? Math.floor(startMs / 1000 / job.segmentSeconds) : 0);
    }
    job.onInfoChange = broadcastSessions;
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
  const subs = subtitleTrackList(tokenQuery(ctx), media.id, rawSubs, req.subtitleFormats);
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
    subtitles: effectiveBurn ? [] : subs.tracks,
    burnInSubtitles: subs.burnIn,
    renditions,
    startRendition,
    adaptiveMode: abr ? 'renditions' : isAudioOnly || preview ? null : 'restart',
    maxBitrate: Number.isFinite(caps.capKbps) ? caps.capKbps : null,
    sourceBitrate: media.bitrate,
    isLocal,
    // Transcoding only because of measured bandwidth (without it: direct play or remux)? Then the client may go back up.
    bandwidthLimited: decision.method === 'transcode' && caps.bandwidthLimited && !!media.bitrate && media.bitrate > caps.decisionKbps
      && decide(media, Number.isFinite(caps.capKbps) ? { ...(req.deviceProfile ?? {}), maxBitrate: caps.capKbps } : req.deviceProfile, {
        audio, burnSubs: !!effectiveBurn, forceTranscode: !!req.forceTranscode, allowTranscode: ctx.user.allowTranscode, userMaxBitrate: prefs.maxBitrate, isAudioOnly,
        audioProcessing, forceAudioProcessing: !!req.forceAudioProcessing,
      }).method !== 'transcode',
    markers,
    nextItemId: next?.id ?? null,
    title: item.title,
    subtitle: subtitleText,
    posterUrl: item.posterUrl,
    backdropUrl: item.backdropUrl,
    reasons: decision.reasons,
    audio: decisionInfo(decision.audio ?? null, decision.method),
    videoRange: !isAudioOnly && (media.hdr || media.videoRange) && decision.range
      ? {
          source: media.videoRange?.hdrFormat ?? 'hdr10', label: media.videoRange?.label ?? 'HDR', delivery: decision.range.delivery,
          output: outputRange(media.videoRange, media.hdr, decision.range.delivery), frameRate: media.videoRange?.frameRate ?? null,
        }
      : null,
    dolbyVision: !isAudioOnly && media.videoRange?.dolbyVision && decision.range ? dolbyVisionPlayback(media, decision) : null,
  };
}

/** How a Dolby Vision source reaches this client (player info overlay). */
export function dolbyVisionPlayback(media: MediaSource, d: Decision): PlaybackInfo['dolbyVision'] {
  const dv = media.videoRange?.dolbyVision;
  if (!dv || !d.range) return null;
  const range = media.videoRange!;
  const profile = range.label.replace(/^Dolby Vision\s*/, '').replace(/\s*\+.*$/, '') || null;
  const delivery = d.range.delivery;
  const native = delivery === 'passthrough' && (d.method === 'direct' || !!d.dolbyVision);
  return {
    profile, level: dv.level,
    mode: native ? 'native' : delivery === 'strip-dovi' ? 'stripped' : delivery === 'tonemap' ? 'tonemap' : 'base-layer',
    baseLayer: range.fallback === 'hdr10' || range.fallback === 'hlg' || range.fallback === 'sdr' ? range.fallback : null,
    codec: d.dolbyVision?.dvCodec ?? null,
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
