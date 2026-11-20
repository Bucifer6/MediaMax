/**
 * Pure transport / voice-search decisions shared by the audio player (src/state/music.tsx), the car
 * bridge (src/car/CarBridge.tsx) and the now-playing screen. No React or native imports (only
 * `import type`), so it is unit-tested with plain Node: `npm test` in apps/mobile
 * (tests/car-policy.test.mjs).
 */
import type { Item } from '@/api/types';

/**
 * Music tracks longer than this (DJ mixes, live sets, concerts, long classical movements) also get
 * ±15/30 s skip buttons — on the phone, the Android notification, CarPlay and Android Auto — while
 * keeping next/previous track. The one place to change the threshold.
 */
export const LONG_TRACK_MS = 10 * 60_000;
/** Same intervals as spoken audio (audiobooks, podcasts). */
export const SKIP_BACK_MS = 15_000;
export const SKIP_FORWARD_MS = 30_000;

/** A long music track (never spoken audio, which always has interval skips). */
export function isLongTrack(spoken: boolean, durationMs: number | null | undefined): boolean {
  return !spoken && typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > LONG_TRACK_MS;
}

export interface TransportMode {
  spoken: boolean;
  longTrack: boolean;
  /** Next / previous track on the system controls (music, long or not). */
  trackSkip: boolean;
  /** ±15/30 s offered somewhere (spoken: instead of track skip; long music: in addition to it). */
  intervalSkip: boolean;
}

export function transportMode(spoken: boolean, durationMs: number | null | undefined): TransportMode {
  const longTrack = isLongTrack(spoken, durationMs);
  return { spoken, longTrack, trackSkip: !spoken, intervalSkip: spoken || longTrack };
}

/** Options for expo-audio's `player.setActiveForLockScreen(true, meta, options)`. */
export interface LockScreenOptions {
  showNextTrack: boolean;
  showPreviousTrack: boolean;
  showSeekForward: boolean;
  showSeekBackward: boolean;
  seekForwardIntervalSeconds: number;
  seekBackwardIntervalSeconds: number;
}

/**
 * Lock screen / notification buttons.
 *
 * * Spoken audio: ±15/30 s (unchanged).
 * * Long music on Android: ±15/30 s in expo-audio's notification (a single expo-audio player has no
 *   next/previous there anyway; Android Auto adds its own buttons, see MediaMaxCarService).
 * * Long music on iOS: no seek buttons. expo-audio would enable MPRemoteCommandCenter's skip commands,
 *   and iOS then shows skip *instead of* next/previous on the lock screen, Control Centre and the
 *   CarPlay main controls. Next/previous stay there; CarPlay gets ±15/30 s as extra Now Playing
 *   buttons (CarPlayController) and the phone screen shows them too.
 */
export function lockScreenOptions(mode: TransportMode, platform: string, queueLength: number): LockScreenOptions {
  const seek = mode.spoken || (mode.longTrack && platform === 'android');
  return {
    showNextTrack: !mode.spoken || queueLength > 1,
    showPreviousTrack: !mode.spoken || queueLength > 1,
    showSeekForward: seek,
    showSeekBackward: seek,
    seekForwardIntervalSeconds: SKIP_FORWARD_MS / 1000,
    seekBackwardIntervalSeconds: SKIP_BACK_MS / 1000,
  };
}

/** Speed button (CarPlay / Android Auto): the next of the app's speeds, wrapping to the first. */
export function nextSpeed(rate: number, speeds: readonly number[]): number {
  return speeds.find((s) => s > rate + 0.001) ?? speeds[0];
}

/**
 * A speed asked for by the system (Assistant "play at 1.5x speed", Android Auto, a Media3 controller):
 * clamped to 0.5–3×, snapped to one of the app's speeds when within 0.03 of it.
 */
export function normalizeSpeed(value: number, speeds: readonly number[]): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const clamped = Math.max(0.5, Math.min(3, value));
  const near = speeds.find((s) => Math.abs(s - clamped) < 0.03);
  return near ?? Math.round(clamped * 100) / 100;
}

// ------------------------------------------------------------------------- voice search

/** What a voice request says it wants, when the assistant tells us (Siri INMediaSearch, Assistant extras). */
export type VoiceMediaType = 'track' | 'album' | 'artist' | 'playlist' | 'audiobook' | 'podcast' | 'episode' | 'music';

export interface VoiceSearchHints {
  type?: VoiceMediaType | null;
  artist?: string | null;
  album?: string | null;
}

const TYPES_FOR: Record<VoiceMediaType, Item['type'][]> = {
  track: ['track'],
  album: ['album'],
  artist: ['artist'],
  playlist: ['playlist'],
  audiobook: ['audiobook', 'bookpart'],
  podcast: ['podcast', 'podcastepisode'],
  episode: ['podcastepisode', 'podcast'],
  music: ['track', 'album', 'artist', 'playlist'],
};

const norm = (s: string | null | undefined) => (s ?? '').toLocaleLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim();

/** The text to search the server for: the title, else the album, else the artist. */
export function voiceQuery(query: string, hints?: VoiceSearchHints | null): string {
  const q = query.trim();
  if (q) return q;
  return (hints?.album ?? '').trim() || (hints?.artist ?? '').trim();
}

/**
 * Picks what to play from server search results (already in relevance order). Candidates are the
 * playable audio kinds in `order`; a requested media type wins, then an artist / album match, then
 * the server's order.
 */
export function pickBestMatch<T extends Pick<Item, 'type' | 'title' | 'parentTitle' | 'grandparentTitle'>>(
  items: readonly T[],
  order: readonly Item['type'][],
  hints?: VoiceSearchHints | null,
): T | null {
  const candidates = items.filter((it) => order.includes(it.type));
  if (!candidates.length) return null;
  const wanted = hints?.type ? TYPES_FOR[hints.type] : null;
  const artist = norm(hints?.artist);
  const album = norm(hints?.album);
  const score = (it: T, index: number): number => {
    let s = 0;
    if (wanted) {
      const k = wanted.indexOf(it.type);
      if (k >= 0) s += 100 - k * 10;
    }
    if (artist) {
      const by = it.type === 'artist' ? norm(it.title) : norm(it.type === 'album' ? it.parentTitle : it.grandparentTitle ?? it.parentTitle);
      if (by && (by === artist || by.includes(artist) || artist.includes(by))) s += 40;
    }
    if (album) {
      const on = it.type === 'album' ? norm(it.title) : norm(it.parentTitle);
      if (on && (on === album || on.includes(album))) s += 20;
    }
    return s - index * 0.01; // stable: the server's relevance order breaks ties
  };
  let best = candidates[0];
  let bestScore = score(best, 0);
  candidates.forEach((it, i) => {
    const s = score(it, i);
    if (s > bestScore) {
      best = it;
      bestScore = s;
    }
  });
  return best;
}
