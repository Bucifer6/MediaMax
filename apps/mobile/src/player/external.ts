/**
 * "Open in external player" (Android / Android TV / Fire TV), pure parts: the players offered, the device profile
 * sent for them, and the position maths. The launch itself is ExternalPlayerScreen.tsx + MediaMaxMedia's
 * openExternalPlayer (modules/mediamax-media/android/.../ExternalPlayer.kt).
 */
import type { DeviceProfile, PlaybackInfo } from '../api/types';

export interface ExternalPlayerOption {
  /** Android package; null = Android's "Open with" chooser. */
  packageName: string | null;
  label: string;
  /** Sends the position back when it closes (resume + watched state in Vibe). */
  returnsPosition: boolean;
}

export const EXTERNAL_PLAYERS: ExternalPlayerOption[] = [
  { packageName: null, label: 'Ask every time', returnsPosition: false },
  { packageName: 'org.videolan.vlc', label: 'VLC', returnsPosition: true },
  { packageName: 'org.xbmc.kodi', label: 'Kodi', returnsPosition: false },
  { packageName: 'com.brouken.player', label: 'Just Player', returnsPosition: true },
  { packageName: 'com.mxtech.videoplayer.ad', label: 'MX Player', returnsPosition: true },
  { packageName: 'com.mxtech.videoplayer.pro', label: 'MX Player Pro', returnsPosition: true },
  { packageName: 'is.xyz.mpv', label: 'mpv', returnsPosition: true },
];

export interface ExternalPlayerSetting {
  enabled: boolean;
  packageName: string | null;
}

export const EXTERNAL_DEFAULT: ExternalPlayerSetting = { enabled: false, packageName: null };

/** Validate a stored setting (unknown / damaged values fall back to off). */
export function normalizeExternalSetting(v: unknown): ExternalPlayerSetting {
  if (!v || typeof v !== 'object') return EXTERNAL_DEFAULT;
  const o = v as Record<string, unknown>;
  const pkg = typeof o.packageName === 'string' && EXTERNAL_PLAYERS.some((p) => p.packageName === o.packageName) ? o.packageName : null;
  return { enabled: o.enabled === true, packageName: pkg };
}

export function externalPlayerLabel(packageName: string | null): string {
  return EXTERNAL_PLAYERS.find((p) => p.packageName === packageName)?.label ?? packageName ?? 'Ask every time';
}

/**
 * Profile for an external player: VLC / Kodi / mpv decode practically everything in software, so ask the server to
 * direct-play (no remux, no transcode) whatever the file is. Only the bitrate cap still applies. No `videoRange`, so the
 * server leaves HDR alone (the external player tone-maps or passes it through itself).
 */
export function externalPlayerProfile(maxBitrate?: number | null): DeviceProfile {
  return {
    maxBitrate: maxBitrate ?? null,
    maxWidth: null,
    videoCodecs: ['h264', 'hevc', 'av1', 'vp9', 'vp8', 'mpeg2video', 'mpeg4', 'vc1', 'msmpeg4v3', 'wmv3', 'theora'],
    audioCodecs: ['aac', 'mp3', 'mp2', 'ac3', 'eac3', 'eac3-joc', 'dts', 'dts-hd', 'dts-x', 'truehd', 'flac', 'alac', 'opus', 'vorbis', 'pcm', 'wmav2', 'wmapro'],
    containers: ['mkv', 'mp4', 'm4v', 'mov', 'webm', 'ts', 'm2ts', 'avi', 'wmv', 'asf', 'flv', 'ogv', 'mpg', 'mpeg', 'vob', '3gp'],
    supportsHls: true,
    player: 'external',
  };
}

/** Where to start the external player in stream time (the server's resume point minus where the stream begins). */
export function externalSeekMs(info: Pick<PlaybackInfo, 'startMs' | 'streamStartMs'>): number {
  return Math.max(0, Math.round((info.startMs ?? 0) - (info.streamStartMs ?? 0)));
}

export interface ExternalResult {
  launched: boolean;
  positionMs?: number | null;
  durationMs?: number | null;
  completed?: boolean;
  reason?: string;
}

/**
 * Progress to report once the external player returns. null when the player sent no position (Kodi, the chooser
 * picked a player without the result API): the server keeps the previous resume point.
 */
export function externalProgress(result: ExternalResult, info: Pick<PlaybackInfo, 'streamStartMs' | 'durationMs'>): { positionMs: number; durationMs?: number } | null {
  if (!result.launched) return null;
  const offset = info.streamStartMs ?? 0;
  const duration = info.durationMs ?? (result.durationMs != null ? result.durationMs + offset : undefined);
  if (result.completed && duration) return { positionMs: duration, durationMs: duration };
  if (result.positionMs == null || result.positionMs < 0) return null;
  const pos = Math.round(result.positionMs + offset);
  return { positionMs: duration ? Math.min(pos, duration) : pos, ...(duration ? { durationMs: duration } : {}) };
}

