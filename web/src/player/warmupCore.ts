/**
 * Instant play — pure helpers (no DOM / API imports, unit-tested in test/warmup.test.ts).
 *
 * The warm-up request must equal the request the player sends when it starts (the server adopts a warm job only for
 * an identical decision key), so both are built by `buildPlaybackRequest`.
 */
import type { DeviceProfile, Item, PlaybackRequest, SubtitleFormat } from '@mediamax/shared';

export const SUBTITLE_FORMATS: SubtitleFormat[] = ['srt', 'vtt', 'ass', 'pgs'];

/** How long a pointer / focus must rest on a Play button before the server is asked to warm up. */
export const WARM_DWELL_MS = 400;
/** Don't ask again for the same item within this window (the server keeps warm state ~40 s). */
export const WARM_REPEAT_MS = 25_000;

export interface PlaybackRequestInput {
  startMs: number;
  audioIndex?: number;
  subtitleIndex: number | null;
  burn: boolean;
  /** Fixed quality cap (kbps) when not in Auto mode. */
  maxBitrate: number | null;
  auto: boolean;
  /** Auto mode: measured bandwidth (kbps). */
  kbps: number | null;
  profile: (maxBitrate: number | null) => DeviceProfile;
  comforts: Pick<PlaybackRequest, 'audioProcessing' | 'forceAudioProcessing'>;
}

export function buildPlaybackRequest(o: PlaybackRequestInput): PlaybackRequest {
  return {
    startMs: Math.round(o.startMs),
    audioStreamIndex: o.audioIndex,
    subtitleStreamIndex: o.burn ? o.subtitleIndex : undefined,
    burnSubtitles: o.burn || undefined,
    deviceProfile: o.profile(o.auto ? null : o.maxBitrate),
    subtitleFormats: SUBTITLE_FORMATS,
    ...o.comforts,
    ...(o.auto ? { adaptive: true, measuredBandwidth: o.kbps } : {}),
  };
}

/** The audio track the player picks for the user's preferred language (undefined = the server's default). */
export function preferredAudioIndex(item: Pick<Item, 'media'>, audioLanguage: string | null | undefined): number | undefined {
  const media = item.media?.[0];
  if (!media || !audioLanguage) return undefined;
  const match = media.audioStreams.find((a) => a.language?.toLowerCase().startsWith(audioLanguage.toLowerCase()));
  return match && !match.default ? match.index : undefined;
}

/** Where the player would start: the resume position when resumable (same rule as utils/items isResumable). */
export function warmStartMs(item: Pick<Item, 'durationMs' | 'userData'>): number {
  const d = item.durationMs ?? 0;
  const pos = item.userData?.positionMs ?? 0;
  const pct = d ? (pos / d) * 100 : 0;
  return pct > 1 && pct < 95 && !item.userData?.played ? pos : 0;
}

/** Only video items with local media are worth warming (shows / seasons resolve to an episode first). */
export function canWarmItem(item: Pick<Item, 'type' | 'media'> | null | undefined): boolean {
  if (!item) return false;
  if (!['movie', 'episode', 'video'].includes(item.type)) return false;
  // Unknown media (list endpoints may omit it): let the server decide.
  return !item.media || (item.media.length > 0 && !item.media[0].remote);
}

interface ConnectionLike {
  saveData?: boolean;
  type?: string;
  effectiveType?: string;
  metered?: boolean;
}

/** Data saver, cellular, or a slow link: tell the server not to start jobs on our behalf. */
export function isMeteredConnection(c: ConnectionLike | null | undefined): boolean {
  if (!c) return false;
  if (c.saveData || c.metered) return true;
  if (c.type === 'cellular') return true;
  return c.effectiveType === 'slow-2g' || c.effectiveType === '2g';
}

/**
 * Hover / focus dwell: `enter(key)` fires `fire(key)` after `delayMs` unless `leave(key)` comes first; a key that fired
 * recently doesn't fire again until `repeatMs` has passed.
 */
export class DwellTimer {
  private pending = new Map<string, unknown>();
  private fired = new Map<string, number>();

  constructor(
    private readonly fire: (key: string) => void,
    private readonly o: { delayMs?: number; repeatMs?: number; now?: () => number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (t: unknown) => void } = {},
  ) {}

  private now() {
    return this.o.now?.() ?? Date.now();
  }

  /** True when `key` fired within the repeat window. */
  recentlyFired(key: string) {
    const at = this.fired.get(key);
    return at != null && this.now() - at < (this.o.repeatMs ?? WARM_REPEAT_MS);
  }

  enter(key: string) {
    if (this.pending.has(key) || this.recentlyFired(key)) return;
    const set = this.o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.pending.set(key, set(() => this.trigger(key), this.o.delayMs ?? WARM_DWELL_MS));
  }

  /** Fire now (page open, "Up next" shown), still respecting the repeat window. */
  trigger(key: string) {
    this.pending.delete(key);
    if (this.recentlyFired(key)) return;
    this.fired.set(key, this.now());
    this.fire(key);
  }

  /** Record `key` as fired without calling `fire` (the caller sends it itself). */
  markFired(key: string) {
    this.leave(key);
    this.fired.set(key, this.now());
  }

  leave(key: string) {
    const t = this.pending.get(key);
    if (t === undefined) return;
    (this.o.clearTimer ?? ((x: unknown) => clearTimeout(x as ReturnType<typeof setTimeout>)))(t);
    this.pending.delete(key);
  }

  /** Forget the repeat window (e.g. the user changed quality settings). */
  reset() {
    for (const k of [...this.pending.keys()]) this.leave(k);
    this.fired.clear();
  }
}

