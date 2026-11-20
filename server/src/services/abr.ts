/**
 * Adaptive bitrate streaming for transcodes.
 *
 * A transcode can be offered as a multi-variant HLS master playlist (a "ladder" of renditions, e.g. 1080p/720p/480p/360p).
 * Renditions are encoded lazily: only the rendition the client is fetching has an encoder running. When the player
 * switches (hls.js ABR, AVPlayer, ExoPlayer), the new rendition's encoder starts at the requested segment. Every
 * rendition uses the same segment length and forced keyframes at n × segmentSeconds (see TranscodeJob / buildArgs), and
 * a run started at segment N seeks to exactly N × segmentSeconds, so segment N of every rendition covers the same media
 * time and players switch seamlessly. Idle rendition encoders are stopped after `renditionIdleSeconds`.
 *
 * With a single hardware encoder session (maxEncoderSessions = 1) only one rendition runs at a time: a switch stops the
 * old encoder and restarts at the new bitrate from the current segment — the "restart" fallback, still seamless for
 * players because segment numbering and timing don't change.
 */
import fs from 'node:fs';
import type { HlsRendition, StreamingSettings, TranscodeVideoCodec } from '@mediamax/shared';
import { getSettings } from './settings.js';
import { TranscodeJob, targetHeight, type TranscodeOptions } from './transcoder.js';
import { maxEncoderSessions } from './hwaccel.js';
import { logger } from '../util/log.js';

const log = logger('abr');

/* ------------------------------ settings ------------------------------ */

export const DEFAULT_STREAMING: StreamingSettings = { adaptive: true, renditionIdleSeconds: 20, remoteMaxBitrate: null, bandwidthTestMaxBytes: 20 * 1024 * 1024 };

export function streamingSettings(): StreamingSettings {
  return { ...DEFAULT_STREAMING, ...(getSettings().streaming ?? {}) };
}

/* ------------------------------- limits -------------------------------- */

/** Share of measured throughput a stream may use (headroom for bitrate peaks and other traffic). */
export const BANDWIDTH_SAFETY = 0.8;

export interface BitrateCaps {
  /** Hard cap from device profile, user preference and the remote limit (kbps); Infinity = none. */
  capKbps: number;
  /** Cap used for the direct-play decision: also limited by measured bandwidth. */
  decisionKbps: number;
  /** Measured bandwidth is the tighter limit. */
  bandwidthLimited: boolean;
}

export function bitrateCaps(i: { profileMax?: number | null; userMax?: number | null; isLocal: boolean; measuredKbps?: number | null; remoteMax?: number | null }): BitrateCaps {
  const caps = [i.profileMax, i.userMax, i.isLocal ? null : i.remoteMax].filter((x): x is number => typeof x === 'number' && x > 0);
  const capKbps = caps.length ? Math.min(...caps) : Infinity;
  const measured = i.measuredKbps && i.measuredKbps > 0 ? i.measuredKbps * BANDWIDTH_SAFETY : Infinity;
  return { capKbps, decisionKbps: Math.min(capKbps, measured), bandwidthLimited: measured < capKbps };
}

/* -------------------------------- ladder -------------------------------- */

/** Rungs (H.264-equivalent video kbps), matching the clients' quality presets. */
export const RUNGS: { height: number; kbps: number }[] = [
  { height: 2160, kbps: 20000 },
  { height: 1440, kbps: 10000 },
  { height: 1080, kbps: 8000 },
  { height: 720, kbps: 4000 },
  { height: 480, kbps: 1500 },
  { height: 360, kbps: 720 },
];
export const MAX_RENDITIONS = 4;
const MIN_KBPS = 300;

export interface LadderInput {
  sourceWidth: number | null;
  sourceHeight: number | null;
  /** Source total bitrate (kbps), if known. */
  sourceKbps: number | null;
  /** Hard cap (kbps, Infinity = none). Measured bandwidth is NOT applied here: the ladder lets players step up later. */
  capKbps: number;
  /** Device max output height. */
  maxHeight: number | null;
  /** Audio bitrate per rendition (kbps). */
  audioKbps: number;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const rungs0 = (maxH: number) => RUNGS.filter((r) => r.height <= maxH);

/**
 * Renditions for a source: rungs no taller than the source/device, bitrates capped by the source bitrate and the hard
 * cap, rungs too close in bitrate to the one above dropped, at most MAX_RENDITIONS, highest first.
 */
export function buildLadder(i: LadderInput): HlsRendition[] {
  const srcH = i.sourceHeight ?? 1080;
  const maxH = Math.min(srcH, i.maxHeight ?? Infinity);
  const aspect = i.sourceWidth && i.sourceHeight ? i.sourceWidth / i.sourceHeight : 16 / 9;
  if (!rungs0(maxH).length) return [{ id: 0, height: srcH, width: even(srcH * aspect), videoKbps: Math.max(MIN_KBPS, Math.min((i.sourceKbps ?? 912) - i.audioKbps, Number.isFinite(i.capKbps) ? i.capKbps - i.audioKbps : 720)), bandwidth: 0, label: `${srcH}p` }].map((r) => ({ ...r, bandwidth: Math.round((r.videoKbps + i.audioKbps) * 1000 * 1.08) }));
  // Video share of the source bitrate: no point encoding above what the source carries.
  const srcVideo = i.sourceKbps ? Math.max(MIN_KBPS, i.sourceKbps - i.audioKbps) : Infinity;
  const cap = Number.isFinite(i.capKbps) ? Math.max(MIN_KBPS, i.capKbps - i.audioKbps) : Infinity;
  // (A source between rungs, e.g. 800p, starts at the next rung down: the transcoder picks output height by bitrate.)
  const rungs = RUNGS.filter((r) => r.height <= maxH);
  const out: { height: number; kbps: number }[] = [];
  for (const r of rungs) {
    const kbps = Math.round(Math.min(r.kbps, srcVideo, cap));
    // The bitrate has to be worth the height: targetHeight() is what the transcoder will actually output.
    const h = Math.min(r.height, targetHeight(kbps, srcH, r.height) ?? r.height);
    const prev = out[out.length - 1];
    if (prev && (kbps >= prev.kbps * 0.85 || h >= prev.height)) continue;
    out.push({ height: h, kbps });
  }
  if (!out.length) out.push({ height: Math.min(360, srcH), kbps: Math.max(MIN_KBPS, Math.min(cap, 720)) });
  return out.slice(0, MAX_RENDITIONS).map((r, idx) => ({
    id: idx,
    height: r.height,
    width: even(r.height * aspect),
    videoKbps: r.kbps,
    // Peak: rate control allows maxrate = target; add audio and ~8% container overhead.
    bandwidth: Math.round((r.kbps + i.audioKbps) * 1000 * 1.08),
    label: `${r.height}p`,
  }));
}

/** Best rendition for a measured bandwidth: the highest whose BANDWIDTH fits within the safety share, else the lowest. */
export function pickStartRendition(ladder: HlsRendition[], measuredKbps: number | null | undefined): number {
  if (!ladder.length) return 0;
  if (!measuredKbps || measuredKbps <= 0) return ladder[0].id;
  const budget = measuredKbps * 1000 * BANDWIDTH_SAFETY;
  const fit = ladder.find((r) => r.bandwidth <= budget);
  return (fit ?? ladder[ladder.length - 1]).id;
}

/** RFC 6381 codec string for a rendition, or null when unknown (CODECS is then omitted). */
export function codecsAttr(codec: TranscodeVideoCodec, height: number | null, audio: 'aac' | 'copy' | string | null): string | null {
  const big = (height ?? 1080) > 1080;
  const v = codec === 'hevc' ? (big ? 'hvc1.1.6.L153.90' : 'hvc1.1.6.L120.90') : codec === 'av1' ? 'av01.0.08M.08' : big ? 'avc1.640033' : 'avc1.640028';
  if (audio === 'aac') return `${v},mp4a.40.2`;
  if (audio == null) return v;
  return null;
}

/** Multi-variant master playlist. The start rendition is listed first (players without their own estimate start there). */
export function masterPlaylist(ladder: HlsRendition[], startId: number, query: string, codecs: (r: HlsRendition) => string | null): string {
  const ordered = [...ladder.filter((r) => r.id === startId), ...ladder.filter((r) => r.id !== startId)];
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const r of ordered) {
    const c = codecs(r);
    const attrs = [`BANDWIDTH=${r.bandwidth}`, `AVERAGE-BANDWIDTH=${Math.round(r.bandwidth * 0.85)}`];
    if (r.width && r.height) attrs.push(`RESOLUTION=${r.width}x${r.height}`);
    if (c) attrs.push(`CODECS="${c}"`);
    attrs.push(`NAME="${r.label}"`);
    lines.push(`#EXT-X-STREAM-INF:${attrs.join(',')}`, `r${r.id}.m3u8${query}`);
  }
  return lines.join('\n') + '\n';
}

/** VOD media playlist of one rendition: every segment listed up front (segments are produced on demand). */
export function renditionPlaylist(prefix: string, durationSec: number, seg: number, segExt: string, fmp4: boolean, query: string): string {
  const count = Math.max(1, Math.ceil(durationSec / seg));
  const lines = ['#EXTM3U', `#EXT-X-VERSION:${fmp4 ? 7 : 3}`, `#EXT-X-TARGETDURATION:${seg}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS'];
  if (fmp4) lines.push(`#EXT-X-MAP:URI="${prefix}init.mp4${query}"`);
  for (let n = 0; n < count; n++) {
    const d = n === count - 1 ? durationSec - n * seg || seg : seg;
    lines.push(`#EXTINF:${d.toFixed(3)},`, `${prefix}seg${n}.${segExt}${query}`);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

/* --------------------------- rendition manager --------------------------- */

/** Minimal job surface the manager needs (TranscodeJob; a fake in tests). */
export interface RenditionJob {
  readonly segmentType: 'mpegts' | 'fmp4';
  readonly segmentExt: string;
  readonly exited: boolean;
  info: TranscodeJob['info'];
  start(fromSegment?: number): void;
  stop(): void;
  tick(): void;
  waitForSegment(n: number, timeoutMs?: number): Promise<string>;
  initSegment(timeoutMs?: number): Promise<string>;
}

export interface RenditionManagerOptions {
  sessionId: string;
  ladder: HlsRendition[];
  startRendition: number;
  startSegment: number;
  durationSec: number;
  segmentSeconds: number;
  /** Encoders this session may run at once (1 = restart-style switching). */
  maxActive: number;
  idleMs: number;
  createJob: (id: string, r: HlsRendition) => RenditionJob;
  /** May one more encoder start now (hardware session limit across the server)? */
  canStartExtra?: () => boolean;
  codecs?: (r: HlsRendition) => string | null;
  onActiveChange?: (job: RenditionJob) => void;
  now?: () => number;
}

interface Entry { job: RenditionJob; lastUsed: number; started: boolean }

let incarnation = 0;
const managers = new Set<RenditionManager>();
/** Encoders running for adaptive sessions across the server. */
export const adaptiveEncoderCount = () => [...managers].reduce((a, m) => a + m.runningCount(), 0);

export class RenditionManager {
  private readonly entries = new Map<number, Entry>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Rendition most recently requested by the player. */
  activeId: number;
  /** Rendition switches seen (for the dashboard / tests). */
  switches = 0;

  constructor(readonly o: RenditionManagerOptions) {
    this.activeId = o.startRendition;
    managers.add(this);
    // Warm up the expected first rendition so the first segment is ready sooner.
    this.ensure(o.startRendition, o.startSegment);
    this.timer = setInterval(() => this.reapIdle(), Math.min(5000, Math.max(250, o.idleMs / 4)));
    this.timer.unref?.();
  }

  private now() {
    return this.o.now?.() ?? Date.now();
  }

  get ladder() {
    return this.o.ladder;
  }

  rendition(id: number): HlsRendition | undefined {
    return this.o.ladder.find((r) => r.id === id);
  }

  runningCount() {
    return [...this.entries.values()].filter((e) => e.started && !e.job.exited).length;
  }

  /** Job ids currently held (running or finished but not reaped). */
  heldRenditions(): number[] {
    return [...this.entries.keys()].sort((a, b) => a - b);
  }

  get activeJob(): RenditionJob | null {
    return this.entries.get(this.activeId)?.job ?? null;
  }

  /** Get (creating and starting at `segment` if needed) the job for a rendition, enforcing the encoder budget. */
  private ensure(id: number, segment: number): Entry {
    const r = this.rendition(id);
    if (!r) throw new Error(`Unknown rendition ${id}`);
    let e = this.entries.get(id);
    if (!e) {
      // Budget: stop least-recently-used renditions first.
      const extraAllowed = this.o.canStartExtra ? this.o.canStartExtra() : true;
      const limit = extraAllowed ? this.o.maxActive : 1;
      const others = [...this.entries.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      while (others.length && others.length >= limit) {
        const [oid, old] = others.shift()!;
        old.job.stop();
        this.entries.delete(oid);
      }
      e = { job: this.o.createJob(`${this.o.sessionId}-r${id}-${++incarnation}`, r), lastUsed: this.now(), started: false };
      this.entries.set(id, e);
    }
    if (!e.started) {
      e.job.start(segment);
      e.started = true;
    }
    e.lastUsed = this.now();
    if (this.activeId !== id) {
      log.debug(`Session ${this.o.sessionId}: rendition ${this.activeId} → ${id} at segment ${segment}`);
      this.activeId = id;
      this.switches++;
      this.o.onActiveChange?.(e.job);
    }
    return e;
  }

  master(query: string): string {
    // CODECS from the encoder the running job actually uses (a hardware → software fallback can change it).
    const info = this.activeJob?.info;
    const codec = codecOfEncoder(info?.videoCodec);
    const codecs = this.o.codecs ?? ((r: HlsRendition) => (codec ? codecsAttr(codec, r.height, info?.audioCodec === 'aac' ? 'aac' : 'unknown') : null));
    return masterPlaylist(this.o.ladder, this.o.startRendition, query, codecs);
  }

  media(id: number, query: string): string {
    const r = this.rendition(id);
    if (!r) throw new Error(`Unknown rendition ${id}`);
    // Segment container is decided by codec, identical for every rendition; ask any job (or create the entry lazily).
    const sample = this.entries.get(id)?.job ?? this.activeJob ?? [...this.entries.values()][0]?.job;
    const ext = sample?.segmentExt ?? 'ts';
    return renditionPlaylist(`r${id}_`, this.o.durationSec, this.o.segmentSeconds, ext, sample?.segmentType === 'fmp4', query);
  }

  async segment(id: number, n: number): Promise<string> {
    const e = this.ensure(id, n);
    return e.job.waitForSegment(n);
  }

  async init(id: number): Promise<string> {
    const e = this.ensure(id, 0);
    return e.job.initSegment();
  }

  tick() {
    for (const e of this.entries.values()) e.job.tick();
  }

  /** Stop encoders of renditions the player hasn't asked for in `idleMs` (the active one stays until the session ends). */
  reapIdle() {
    const now = this.now();
    for (const [id, e] of [...this.entries.entries()]) {
      if (id === this.activeId) continue;
      if (now - e.lastUsed > this.o.idleMs) {
        log.debug(`Session ${this.o.sessionId}: stopping idle rendition ${id}`);
        e.job.stop();
        this.entries.delete(id);
      }
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const e of this.entries.values()) e.job.stop();
    this.entries.clear();
    managers.delete(this);
  }
}

/**
 * Handle a rendition request inside a session's HLS directory: `r<id>.m3u8`, `r<id>_seg<n>.<ts|m4s>`, `r<id>_init.mp4`.
 * Returns null when `file` isn't a rendition path.
 */
export async function renditionRequest(m: RenditionManager, file: string, query: string): Promise<{ kind: 'playlist'; body: string } | { kind: 'file'; path: string; type: string } | null> {
  let x = file.match(/^r(\d+)\.m3u8$/);
  if (x) return { kind: 'playlist', body: m.media(Number(x[1]), query) };
  x = file.match(/^r(\d+)_seg(\d+)\.(ts|m4s)$/);
  if (x) {
    const p = await m.segment(Number(x[1]), Number(x[2]));
    if (!fs.existsSync(p)) throw new Error('Segment not available');
    return { kind: 'file', path: p, type: x[3] === 'm4s' ? 'video/mp4' : 'video/mp2t' };
  }
  x = file.match(/^r(\d+)_init\.mp4$/);
  if (x) return { kind: 'file', path: await m.init(Number(x[1])), type: 'video/mp4' };
  return null;
}

/* ------------------------- wiring for playback.ts ------------------------- */

/** Encoders one adaptive session may run at once: 2 (old + new during a switch), 1 with a single hardware session. */
export function sessionEncoderLimit(hw = getSettings().transcoding.hwAccel): number {
  const limit = maxEncoderSessions(hw);
  return limit != null && limit < 2 ? 1 : 2;
}

/** Whether another encoder may start, given the hardware's session limit and encoders already running elsewhere. */
export function hardwareHasRoom(otherEncoders: number, hw = getSettings().transcoding.hwAccel): boolean {
  const limit = maxEncoderSessions(hw);
  if (limit == null) return true;
  return otherEncoders + adaptiveEncoderCount() + 1 <= limit;
}

export function createRenditionManager(sessionId: string, base: TranscodeOptions, ladder: HlsRendition[], startRendition: number, startSegment: number, hooks: { otherEncoders: () => number; onActiveChange?: (job: RenditionJob) => void }): RenditionManager {
  const s = getSettings().transcoding;
  const st = streamingSettings();
  const durationSec = base.durationSec ?? 0;
  return new RenditionManager({
    sessionId, ladder, startRendition, startSegment, durationSec, segmentSeconds: s.segmentSeconds,
    maxActive: sessionEncoderLimit(s.hwAccel),
    idleMs: Math.max(5, st.renditionIdleSeconds) * 1000,
    createJob: (id, r) => new TranscodeJob(id, { ...base, bitrate: r.videoKbps, maxHeight: r.height }),
    canStartExtra: () => hardwareHasRoom(hooks.otherEncoders(), s.hwAccel),
    onActiveChange: hooks.onActiveChange,
  });
}

/** Output codec from the encoder name a job reports (libx264, hevc_vaapi, av1_nvenc …). */
export function codecOfEncoder(encoder: string | null | undefined): TranscodeVideoCodec | null {
  if (!encoder) return null;
  if (/264/.test(encoder)) return 'h264';
  if (/hevc|265/.test(encoder)) return 'hevc';
  if (/av1/.test(encoder)) return 'av1';
  return null;
}
