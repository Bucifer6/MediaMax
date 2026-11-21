/**
 * Instant play (mobile): POST /playback/:id/prepare when an item screen opens, so the server has decided and (for
 * remux / transcode) produced the first segments by the time Play is tapped. The request is built by the same
 * function the player uses (videoPlaybackRequest) so the server adopts the warm stream. On cellular the server is
 * told `metered` and only caches its decision.
 */
import type { MediaMaxClient } from '@/api/client';
import { comfortRequest, deviceComforts } from '@/api/audio';
import { videoDeviceProfile } from '@/api/profiles';
import type { Item, PlaybackRequest, UserPreferences } from '@/api/types';
import { isMetered } from '@/utils/connectivity';
import { measureBandwidth } from './bandwidth';

export function videoPlaybackRequest(o: {
  mediaId?: string;
  startMs: number;
  audio?: number;
  /** Bitmap subtitle to burn in. */
  burn: number | null;
  auto: boolean;
  bitrate: number | null;
  /** Measured bandwidth (bits/s), Auto quality. */
  measuredBps: number | null;
  prefs: UserPreferences | null | undefined;
}): PlaybackRequest {
  return {
    mediaId: o.mediaId,
    startMs: Math.round(o.startMs),
    audioStreamIndex: o.audio,
    // Text subtitles are fetched and drawn by our overlay; only bitmap tracks are burned in, on request.
    subtitleStreamIndex: o.burn ?? null,
    ...(o.burn != null ? { burnSubtitles: true } : {}),
    subtitleFormats: ['srt', 'vtt', 'ass'],
    deviceProfile: videoDeviceProfile(o.auto ? null : o.bitrate),
    // Night mode / dialogue boost / normalise / lip-sync: applied by the server (audio-only re-encode).
    ...comfortRequest(deviceComforts(o.prefs)),
    ...(o.auto ? { adaptive: true, measuredBandwidth: o.measuredBps ? Math.round(o.measuredBps / 1000) : null } : {}),
  };
}

const recent = new Map<string, number>();

/** Warm up playback of a video item (once per 25 s per item). Never throws. */
export async function prepareVideo(api: MediaMaxClient | null, item: Item | null | undefined, prefs: UserPreferences | null | undefined, mediaId?: string) {
  if (!api || !item || !['movie', 'episode', 'video'].includes(item.type) || item.media?.[0]?.remote) return;
  const key = `${item.id}:${mediaId ?? ''}`;
  if ((recent.get(key) ?? 0) > Date.now() - 25_000) return;
  recent.set(key, Date.now());
  try {
    const auto = prefs?.maxBitrate == null && prefs?.autoQuality !== false;
    const metered = await isMetered();
    // The player measures bandwidth before it starts; doing it now (remembered for 10 min) saves that wait too.
    const measuredBps = auto && !metered ? await measureBandwidth(api) : null;
    const d = item.durationMs ?? 0;
    const pos = item.userData?.positionMs ?? 0;
    const resumable = d > 0 && pos / d > 0.01 && pos / d < 0.95 && !item.userData?.played;
    await api.preparePlayback(item.id, {
      ...videoPlaybackRequest({ mediaId, startMs: resumable ? pos : 0, burn: null, auto, bitrate: prefs?.maxBitrate ?? null, measuredBps, prefs }),
      metered: metered || undefined,
      reason: 'open',
    });
  } catch {
    /* best effort */
  }
}
