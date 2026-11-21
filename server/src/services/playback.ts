import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type {
  ActiveSession, SessionDetails, AudioComforts, AudioStream, DeviceProfile, HlsRendition, MediaSource, PlayMethod, PlaybackInfo, PlaybackPrepareRequest, PlaybackPrepareResult, PlaybackRequest,
  SubtitleStream, SubtitleTrack, Marker, User,
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
import { mediaDetails, withJob, withSubtitle, type ClientHints } from './sessionDetails.js';
import { bitrateCaps, buildLadder, createRenditionManager, pickStartRendition, streamingSettings, type RenditionManager } from './abr.js';
import { PlanCache, WarmSlots, bandwidthBucket, canWarm, stableJson, type WarmJobHandle } from './warmup.js';

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
  /** Dashboard breakdown decided at start (sessionDetails.ts); the encoder's live state is merged in when listing. */
  details?: SessionDetails | null;
  /** Subtitle streams of the playing file, to name the one the player reports. */
  subs?: SubtitleStream[];
  /** Audio output bitrate when the audio is encoded (kbps), for the stream's total output bitrate. */
  audioOutKbps?: number | null;
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
    details: s.details ? withJob(s.details, s.method !== 'direct' && s.method !== 'live' ? s.job?.info : null, s.audioOutKbps ?? null) : null,
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
/**
 * "Allow remote streaming" off: media bytes (direct streams, downloads, Subsonic, karaoke mixes, live TV) are only
 * served to the home network, not just new playback sessions.
 */
export function assertRemoteAllowed(u: Pick<User, 'allowRemote' | 'isAdmin'>, remoteAddr: string | null | undefined) {
  if (!u.allowRemote && !u.isAdmin && remoteAddr && !isLocalAddress(remoteAddr)) {
    throw new HttpError(403, 'Your account can only stream on the home network', 'remote_not_allowed');
  }
}

export function assertCanStartSession(ctx: AuthContext, remoteAddr: string | null, multiview = false) {
  const u = ctx.user;
  assertRemoteAllowed(u, remoteAddr);
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

export function sessionProgress(ctx: AuthContext, id: string, positionMs: number, state: 'playing' | 'paused' | 'stopped', durationMs?: number, subtitleIndex?: number | null) {
  const s = sessions.get(id);
  if (!s) return { ok: false };
  if (s.ctx.user.id !== ctx.user.id) throw forbidden();
  s.lastActivity = Date.now();
  if (subtitleIndex !== undefined && s.details && s.subs) s.details = withSubtitle(s.details, s.subs, subtitleIndex == null ? null : Number(subtitleIndex));
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
  warmSlots.clear();
}

/** End every session of an account and its profiles (the account or profile is being deleted). */
export function stopUserSessions(userId: string, reason = 'user_deleted') {
  for (const s of [...sessions.values()]) {
    if (s.ctx.user.id === userId || s.ctx.user.parentUserId === userId) stopSession(s.id, reason, false);
  }
  warmSlots.clear((e) => e.userId === userId || e.ownerId === userId);
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
  // Even: 4:2:0 encoders reject odd frame heights.
  return limits.length ? Math.max(2, Math.floor(Math.min(...limits) / 2) * 2) : null;
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

/* ------------------------------ planning ---------------------------- */

/**
 * Everything startPlayback decides before it creates a session: the media, audio/subtitle choice, the playback
 * decision and the job options. Cached briefly (instant play, warmup.ts) so a prepare → start pair decides once.
 */
export interface PlaybackPlan {
  key: string;
  itemId: string;
  preview: boolean;
  mediaRow: Row;
  media: MediaSource;
  rawSubs: (SubtitleStream & { path?: string })[];
  audio: AudioStream | null;
  effectiveBurn: (SubtitleStream & { path?: string }) | null;
  isAudioOnly: boolean;
  isLocal: boolean;
  caps: ReturnType<typeof bitrateCaps>;
  decision: Decision;
  bandwidthLimited: boolean;
  /** Remux / transcode job options (null for direct play). */
  opts: TranscodeOptions | null;
  /** Adaptive rendition ladder (more than one rung = multi-variant master playlist). */
  ladder: HlsRendition[];
  startRendition: number | null;
  /** For cache validation: the settings object the plan was made with, and the media row's signature. */
  settings: ReturnType<typeof getSettings>;
  mediaSig: string;
}

/** Cache key: the same user, device, item and (decision-relevant parts of the) request decide the same way. */
export function playbackPlanKey(ctx: AuthContext, itemId: string, req: PlaybackRequest, isLocal: boolean): string {
  const u = ctx.user;
  return stableJson({
    u: u.id, d: ctx.deviceRowId, i: itemId, m: req.mediaId ?? null, a: req.audioStreamIndex ?? null, s: req.subtitleStreamIndex ?? null,
    b: !!req.burnSubtitles, f: !!req.forceTranscode, p: req.deviceProfile ?? null, bw: bandwidthBucket(req.measuredBandwidth), ad: !!req.adaptive,
    ap: req.audioProcessing ?? null, fap: !!req.forceAudioProcessing, sf: req.subtitleFormats ?? null, pv: !!req.preview, l: isLocal,
    // User-level inputs of the decision: a changed preference or permission must not reuse an old plan.
    ut: u.allowTranscode, ub: u.preferences.maxBitrate ?? null, ul: u.preferences.audioLanguage ?? null,
  });
}

const mediaSignature = (r: Row | undefined) =>
  r ? `${r.mtime ?? ''}|${r.size ?? ''}|${r.probed_at ?? ''}|${r.video_range ?? ''}|${r.audio ?? ''}|${r.subs ?? ''}` : '';

export const PLAN_TTL_MS = 60_000;
/** Decisions cached by prepare / start. Invalid once the settings change or the file is rescanned (new probe data). */
export const planCache = new PlanCache<PlaybackPlan>({
  ttlMs: PLAN_TTL_MS,
  maxEntries: 500,
  validate: (p) => p.settings === getSettings()
    && mediaSignature(db.get('SELECT mtime, size, probed_at, video_range, audio, subs FROM media WHERE id = ?', p.media.id)) === p.mediaSig,
});

/** Run the playback decision for a request (lazy probes included). No session, job or history: see startPlayback. */
export async function planPlayback(ctx: AuthContext, itemId: string, req: PlaybackRequest, remoteAddr: string | null, key?: string): Promise<PlaybackPlan> {
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
      else throw new Error('no video stream');
    } catch {
      // Keep the plain HDR flag, and mark the file as probed (as the backfill task does) so it isn't probed on every play.
      db.run("UPDATE media SET video_range = 'null' WHERE id = ? AND video_range IS NULL", mediaRow.id);
      mediaRow.video_range = 'null';
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
  const imageSubSelected = req.subtitleStreamIndex != null ? rawSubs.find((s) => s.index === req.subtitleStreamIndex && !TEXT_SUB_CODECS.has(s.codec)) ?? null : null;
  const effectiveBurn = burnSub ?? imageSubSelected;

  const isAudioOnly = item.type === 'track' || !media.videoCodec;
  // Bitrate limits: device profile, user preference, the remote cap (non-LAN clients) and — for the direct-play
  // decision only — the client's measured bandwidth (abr.ts). LAN clients are unlimited unless they measured otherwise.
  const isLocal = !!remoteAddr && isLocalAddress(remoteAddr);
  const caps = bitrateCaps({ profileMax: req.deviceProfile?.maxBitrate, userMax: prefs.maxBitrate, isLocal, measuredKbps: req.measuredBandwidth, remoteMax: streamingSettings().remoteMaxBitrate });
  const decideProfile = Number.isFinite(caps.decisionKbps) ? { ...(req.deviceProfile ?? {}), maxBitrate: Math.round(caps.decisionKbps) } : req.deviceProfile;
  // Real Dolby Vision through a remux depends on this FFmpeg build (checked once, ~100 ms; dovi.ts).
  if (media.videoRange?.dolbyVision && req.deviceProfile?.videoRange?.dolbyVision) await doviMuxSupported().catch(() => false);
  const audioProcessing = req.audioProcessing ? normalizeComforts(req.audioProcessing) : null;
  const decideOpts = {
    audio, burnSubs: !!effectiveBurn, forceTranscode: !!req.forceTranscode, allowTranscode: ctx.user.allowTranscode,
    userMaxBitrate: prefs.maxBitrate, isAudioOnly, audioProcessing, forceAudioProcessing: !!req.forceAudioProcessing,
  };
  const decision = decide(media, decideProfile, decideOpts);
  // Transcoding only because of measured bandwidth (without it: direct play or remux)? Then the client may go back up.
  const bandwidthLimited = decision.method === 'transcode' && caps.bandwidthLimited && !!media.bitrate && media.bitrate > caps.decisionKbps
    && decide(media, Number.isFinite(caps.capKbps) ? { ...(req.deviceProfile ?? {}), maxBitrate: caps.capKbps } : req.deviceProfile, decideOpts).method !== 'transcode';

  let opts: TranscodeOptions | null = null;
  let ladder: HlsRendition[] = [];
  let startRendition: number | null = null;
  if (decision.method !== 'direct') {
    const p = { ...DEFAULT_PROFILE, ...(req.deviceProfile ?? {}) };
    // Adaptive (multi-rendition) transcodes let the player climb to the hard cap; single-variant streams start at the measured fit.
    const adaptive = decision.method === 'transcode' && !!req.adaptive && streamingSettings().adaptive && !isAudioOnly && !preview && !!media.durationMs;
    const maxBitrate = adaptive ? caps.capKbps : caps.decisionKbps;
    const target = Math.min(Number.isFinite(maxBitrate) ? maxBitrate : getSettings().transcoding.defaultBitrate, media.bitrate ? Math.max(media.bitrate, 1500) : Infinity, getSettings().transcoding.defaultBitrate * 4);
    opts = {
      // Always encode against the full timeline (segments are produced on demand),
      // the client seeks to startMs. This keeps PTS == playlist time for every player.
      input: mediaRow.path ?? mediaRow.remote_url, inputArgs: mediaRow.remote_url ? remoteInputArgs(mediaRow) : [], startSec: 0, durationSec: media.durationMs ? media.durationMs / 1000 : null,
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
    ladder = adaptive
      ? buildLadder({ sourceWidth: media.width, sourceHeight: media.height, sourceKbps: media.bitrate, capKbps: caps.capKbps, maxHeight: opts.maxHeight, audioKbps: decision.audio?.bitrateKbps ?? (opts.audioCopy ? 320 : (audio?.channels ?? 2) > 2 ? 384 : 192) })
      : [];
    if (ladder.length > 1) startRendition = pickStartRendition(ladder, req.measuredBandwidth);
  }
  return {
    key: key ?? playbackPlanKey(ctx, itemId, req, isLocal), itemId, preview, mediaRow, media, rawSubs, audio, effectiveBurn, isAudioOnly, isLocal, caps,
    decision, bandwidthLimited, opts, ladder, startRendition, settings: getSettings(), mediaSig: mediaSignature(mediaRow),
  };
}

/** The cached plan for this request, or a fresh one (then cached). */
async function resolvePlan(ctx: AuthContext, itemId: string, req: PlaybackRequest, remoteAddr: string | null): Promise<{ plan: PlaybackPlan; cached: boolean }> {
  const isLocal = !!remoteAddr && isLocalAddress(remoteAddr);
  const key = playbackPlanKey(ctx, itemId, req, isLocal);
  const hit = planCache.get(key);
  if (hit) return { plan: hit, cached: true };
  const plan = await planPlayback(ctx, itemId, req, remoteAddr, key);
  planCache.set(key, plan);
  return { plan, cached: false };
}

/* ---------------------------- job spawning --------------------------- */

interface SpawnedJob {
  job: TranscodeJob;
  abr: RenditionManager | null;
  /** Session the adaptive manager reports rendition switches to (set once the session exists). */
  holder: { s: PlaySession | null };
  startSegment: number;
}

function spawnJob(plan: PlaybackPlan, startMs: number, id = newId()): SpawnedJob {
  const opts = plan.opts!;
  const holder: { s: PlaySession | null } = { s: null };
  if (plan.ladder.length > 1) {
    const startSegment = startMs > 0 ? Math.floor(startMs / 1000 / getSettings().transcoding.segmentSeconds) : 0;
    const abr = createRenditionManager(id, opts, plan.ladder, plan.startRendition ?? plan.ladder[0].id, startSegment, {
      otherEncoders: () => [...sessions.values()].filter((x) => x.job && !x.abr && x.method !== 'direct' && !x.job.exited).length + warmSlots.entries().filter((e) => !e.job.spawned.abr).length,
      masterAudio: masterAudioFor(plan.decision.audio, plan.audio),
      onActiveChange: (j) => {
        if (!holder.s) return;
        holder.s.job = j as TranscodeJob;
        broadcastSessions();
      },
    });
    return { job: abr.activeJob as TranscodeJob, abr, holder, startSegment };
  }
  const job = new TranscodeJob(id, opts);
  const startSegment = plan.decision.method === 'transcode' && startMs > 0 ? Math.floor(startMs / 1000 / job.segmentSeconds) : 0;
  job.start(startSegment);
  return { job, abr: null, holder, startSegment };
}

/* ------------------------------ warm-up ----------------------------- */

/** Unused warm jobs are stopped after this. */
export const WARM_TTL_MS = 40_000;
/** Warm jobs server-wide (each device holds at most one). */
export const WARM_MAX_JOBS = 2;
/** Minimum time between two new warm jobs of one device (tests lower it). */
export const warmTuning = { minIntervalMs: 1000 };
const lastWarmSpawn = new Map<string, number>();
/** Segments a warm job encodes ahead of the start position before it is paused (SIGSTOP) until adopted. */
const WARM_AHEAD_SEGMENTS = 2;

interface WarmHandle extends WarmJobHandle { spawned: SpawnedJob; release(): void }

function warmHandle(sp: SpawnedJob): WarmHandle {
  const job = () => (sp.abr ? (sp.abr.activeJob as TranscodeJob | null) : sp.job);
  job()?.hold(sp.startSegment + WARM_AHEAD_SEGMENTS);
  // The encoder only pauses itself when polled.
  const timer = setInterval(() => job()?.tick(), 250);
  timer.unref?.();
  return {
    spawned: sp,
    stop: () => {
      clearInterval(timer);
      if (sp.abr) sp.abr.stop();
      else sp.job.stop();
    },
    dead: () => !!job()?.failed,
    release: () => {
      clearInterval(timer);
      job()?.release();
    },
  };
}

export const warmSlots = new WarmSlots<WarmHandle>({
  maxJobs: WARM_MAX_JOBS,
  ttlMs: WARM_TTL_MS,
  onEvent: (ev, e) => log.debug(`warm ${e.kind} for item ${e.itemId}: ${ev}`),
});

/** Free transcoder capacity held by warm jobs (other devices first) before a real transcode or conversion starts. */
export function reclaimWarmTranscodes(busyAfterStart: number, exceptDevice?: string) {
  return warmSlots.reclaim(busyAfterStart, getSettings().transcoding.maxConcurrent, exceptDevice);
}

const preread = new Map<string, number>();
/** Pull the start and end of a file (headers, MP4 moov at either end) into the OS cache / spin the disk up. */
async function prereadFile(file: string | null | undefined) {
  if (!file || !path.isAbsolute(file)) return;
  const now = Date.now();
  if ((preread.get(file) ?? 0) > now - 30_000) return;
  preread.set(file, now);
  if (preread.size > 200) for (const [k, t] of preread) if (t < now - 30_000) preread.delete(k);
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(file, 'r');
    const { size } = await fh.stat();
    const chunk = Math.min(1 << 20, size);
    const buf = Buffer.allocUnsafe(chunk);
    await fh.read(buf, 0, chunk, 0);
    if (size > chunk) await fh.read(buf, 0, chunk, Math.max(chunk, size - chunk));
  } catch {
    /* best effort */
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * POST /playback/:itemId/prepare — the user is about to press Play. Decide now (cached for startPlayback), read the
 * file's headers, and for remux / transcode start the job in a warm slot: no session, no history, no stream-limit use.
 */
export async function preparePlayback(ctx: AuthContext, itemId: string, req: PlaybackPrepareRequest, remoteAddr: string | null): Promise<PlaybackPrepareResult> {
  assertCanSee(ctx.user, itemId);
  assertRemoteAllowed(ctx.user, remoteAddr);
  const { plan } = await resolvePlan(ctx, itemId, req, remoteAddr);
  const method = plan.decision.method;
  const decisionOnly = (reason: PlaybackPrepareResult['reason'] = null): PlaybackPrepareResult => ({ method, warm: 'decision', reason, expiresInMs: PLAN_TTL_MS });
  if (method === 'direct') {
    void prereadFile(plan.mediaRow.path);
    return { ...decisionOnly(), preloadUrl: plan.mediaRow.path ? `/api/v1/stream/direct/${plan.media.id}${tokenQuery(ctx)}` : null };
  }
  void prereadFile(plan.mediaRow.path);
  // IPTV / remote files: a warm job would hold one of the provider's (few) connections.
  if (req.metered) return decisionOnly('metered');
  if (plan.preview) return decisionOnly('preview');
  if (plan.mediaRow.remote_url || !plan.opts) return decisionOnly('remote_source');
  try {
    assertCanStartSession(ctx, remoteAddr);
  } catch {
    return decisionOnly('stream_limit');
  }
  const device = ctx.deviceRowId;
  if (warmSlots.refresh(device, plan.key)) return { method, warm: 'job', reason: null, expiresInMs: WARM_TTL_MS };
  const kind = method === 'transcode' ? 'transcode' : 'remux';
  const own = warmSlots.entries().find((e) => e.device === device);
  const room = canWarm(kind, {
    runningTranscodes: transcodeCount(), warmTranscodes: warmSlots.transcodeCount() - (own?.kind === 'transcode' ? 1 : 0),
    maxConcurrent: getSettings().transcoding.maxConcurrent, slotFree: warmSlots.hasRoom(device),
  });
  if (!room.ok) return decisionOnly(room.reason);
  // A client flicking through items (TV focus) must not churn encoders: one new warm job per device per second.
  const last = lastWarmSpawn.get(device) ?? 0;
  if (Date.now() - last < warmTuning.minIntervalMs) return decisionOnly('capacity');
  lastWarmSpawn.set(device, Date.now());
  if (lastWarmSpawn.size > 1000) for (const [k, t] of lastWarmSpawn) if (t < Date.now() - 60_000) lastWarmSpawn.delete(k);
  // Stop the device's previous warm job before the new encoder starts.
  warmSlots.drop(device, 'replaced');
  const pos = db.get<{ position_ms: number }>('SELECT position_ms FROM user_data WHERE user_id = ? AND item_id = ?', ctx.user.id, itemId)?.position_ms ?? 0;
  const startMs = Math.max(0, req.startMs ?? pos);
  const sp = spawnJob(plan, startMs);
  const entry = warmSlots.put({ key: plan.key, device, userId: ctx.user.id, ownerId: ctx.user.parentUserId || ctx.user.id, itemId, kind, job: warmHandle(sp), startSegment: sp.startSegment });
  if (!entry) {
    sp.abr ? sp.abr.stop() : sp.job.stop();
    return decisionOnly('capacity');
  }
  return { method, warm: 'job', reason: null, expiresInMs: WARM_TTL_MS };
}

/* -------------------------------- start ----------------------------- */

export async function startPlayback(ctx: AuthContext, itemId: string, req: PlaybackRequest, remoteAddr: string | null, hints?: ClientHints): Promise<PlaybackInfo> {
  assertCanSee(ctx.user, itemId);
  assertCanStartSession(ctx, remoteAddr);
  const { plan } = await resolvePlan(ctx, itemId, req, remoteAddr);
  // Fresh item (resume position, next up) even when the decision came from the cache.
  const item = getItem(ctx.user, itemId, true);
  const { media, decision, rawSubs, effectiveBurn, isAudioOnly, isLocal, caps, preview } = plan;
  // A warm job prepared for exactly this request is adopted; any other warm job of this device is no longer wanted.
  // (Muted trailer previews run beside playback and leave the device's warm job alone.)
  const warm = preview ? null : decision.method === 'direct' ? (warmSlots.drop(ctx.deviceRowId), null) : warmSlots.take(ctx.deviceRowId, plan.key);
  if (decision.method === 'transcode') {
    if (!warm) reclaimWarmTranscodes(transcodeCount() + 1, ctx.deviceRowId);
    if (transcodeCount() >= getSettings().transcoding.maxConcurrent) {
      warm?.job.stop();
      throw new HttpError(503, 'The server is busy transcoding other streams. Try again shortly or choose original quality.', 'transcoder_busy');
    }
  }
  const startMs = Math.max(0, req.startMs ?? item.userData.positionMs ?? 0);
  const next = item.type === 'episode' || item.type === 'track' ? nextItem(ctx.user, itemId) : null;
  const markers: Marker[] = item.markers ?? [];
  const subtitleText = item.type === 'episode'
    ? `${item.grandparentTitle ?? ''} · S${item.parentIndex ?? 0}E${item.index ?? 0}`
    : item.type === 'track' ? [item.grandparentTitle, item.parentTitle].filter(Boolean).join(' — ') : item.year ? String(item.year) : null;

  const audio = plan.audio;
  const details = mediaDetails({
    platform: ctx.device.platform, appVersion: ctx.device.appVersion, hints, local: isLocal, media, isAudioOnly,
    method: decision.method === 'live' ? 'direct' : decision.method, videoCopy: decision.videoCopy, audioCopy: decision.audioCopy,
    audio, audioPlan: decision.audio ?? null, reasons: decision.reasons, adaptive: plan.ladder.length > 1,
    burnSub: effectiveBurn || null, rangeDelivery: decision.range?.delivery ?? null,
  });
  const base = {
    ctx, itemId, channelId: null, mediaId: media.id, title: item.title, subtitle: subtitleText, posterUrl: item.posterUrl,
    durationMs: media.durationMs || item.durationMs, remoteAddr, positionMs: preview ? 0 : startMs, preview,
    details, subs: rawSubs.map(({ index, codec, language, title, default: d, forced, external }) => ({ index, codec, language, title, default: d, forced, external })),
    audioOutKbps: decision.audioCopy ? audio?.bitrate ?? null : decision.audio?.bitrateKbps ?? ((audio?.channels ?? 2) > 2 ? 384 : 192),
  };

  let session: PlaySession;
  let url: string;
  let mimeType: string;
  let isHls = false;
  const responseStart = startMs;
  let abr: RenditionManager | null = null;
  let renditions: HlsRendition[] | undefined;
  let startRendition: number | null = null;
  if (decision.method === 'direct') {
    session = registerSession({ ...base, method: 'direct', job: null });
    url = `/api/v1/stream/direct/${media.id}${tokenQuery(ctx, session.id)}`;
    mimeType = MIME_BY_CONTAINER[media.container ?? ''] ?? (isAudioOnly ? 'audio/mpeg' : 'video/mp4');
  } else {
    const sp = warm ? warm.job.spawned : spawnJob(plan, startMs);
    warm?.job.release();
    const job = sp.job;
    abr = sp.abr;
    try {
      session = registerSession({ ...base, method: decision.method, job, ...(abr ? { abr } : {}) });
    } catch (e) {
      if (abr) abr.stop();
      else job.stop();
      throw e;
    }
    sp.holder.s = session;
    if (abr) {
      renditions = plan.ladder;
      startRendition = plan.startRendition;
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
    log.info(`${ctx.user.displayName} → ${decision.method}${warm ? ' (warm)' : ''} "${item.title}": ${decision.reasons.join('; ')}`);
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
    bandwidthLimited: plan.bandwidthLimited,
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
