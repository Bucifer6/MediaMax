/**
 * Instant play (client side): ask the server to get ready while the user is about to press Play.
 *
 *   - Play button hovered / focused for ≥ 400 ms (usePlayWarmup), item page opened, "Up next" shown in the player →
 *     prepareItem(item). The request is built exactly like the player's start request (buildPlaybackRequest), so the
 *     server's warm job (remux / transcode first segments) is adopted when Play is pressed.
 *   - Direct play: the server only caches its decision; we fetch the first 256 KB of the file (warms the server's disk
 *     and the connection).
 *   - Data saver / cellular (Network Information API): `metered: true`, the server starts no job.
 *   - The bandwidth probe the player would run before starting happens here instead (Auto quality).
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Item, PlaybackPrepareResult, User } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { getToken } from '../api/client';
import { getDeviceId } from '../api/device';
import { DEFAULT_PREFERENCES } from '../theme/defaults';
import { profileWithBitrate } from './deviceProfile';
import { capabilitiesReady } from './capabilities';
import { audioCaps, audioCapsReady } from './audioCaps';
import { comfortRequest, deviceComforts } from './audioFx';
import { initialBandwidth } from './bandwidth';
import { DwellTimer, buildPlaybackRequest, canWarmItem, isMeteredConnection, preferredAudioIndex, warmStartMs } from './warmupCore';

const PRELOAD_BYTES = 256 * 1024;
const preloaded = new Set<string>();

function metered(): boolean {
  return isMeteredConnection((navigator as unknown as { connection?: { saveData?: boolean; type?: string; effectiveType?: string } }).connection);
}

/** The request the player will send for `item` (see VideoPlayer playbackRequest), for user `user`. */
export async function warmRequest(item: Item, user: User | null) {
  const prefs = { ...DEFAULT_PREFERENCES, ...(user?.preferences ?? {}) };
  const auto = prefs.maxBitrate == null && prefs.autoQuality !== false;
  await Promise.all([capabilitiesReady(), audioCapsReady()]);
  let kbps: number | null = null;
  if (auto) {
    const bw = await initialBandwidth();
    kbps = bw.bps ? Math.round(bw.bps / 1000) : null;
  }
  return buildPlaybackRequest({
    startMs: warmStartMs(item),
    audioIndex: preferredAudioIndex(item, prefs.audioLanguage),
    subtitleIndex: null,
    burn: false,
    maxBitrate: prefs.maxBitrate ?? null,
    auto,
    kbps,
    profile: profileWithBitrate,
    comforts: comfortRequest(deviceComforts(user?.preferences, getDeviceId()), audioCaps()?.webAudioFx ?? false),
  });
}

/** Warm up playback of `item`. Never throws; resolves to the server's answer (null when skipped / failed). */
export async function prepareItem(item: Item | null | undefined, user: User | null, reason: 'hover' | 'focus' | 'open' | 'next'): Promise<PlaybackPrepareResult | null> {
  if (!item || !canWarmItem(item)) return null;
  try {
    const body = { ...(await warmRequest(item, user)), metered: metered() || undefined, reason };
    const res = await api.playback.prepare(item.id, body);
    if (res.method === 'direct' && res.preloadUrl && !body.metered) preloadDirect(res.preloadUrl);
    return res;
  } catch {
    return null;
  }
}

/** First bytes of a direct-play file (once per URL per page load). */
function preloadDirect(url: string) {
  const key = url.replace(/[?&]token=[^&]*/, '');
  if (preloaded.has(key)) return;
  preloaded.add(key);
  const token = getToken();
  fetch(url, { headers: { Range: `bytes=0-${PRELOAD_BYTES - 1}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) } })
    .then((r) => r.arrayBuffer())
    .catch(() => preloaded.delete(key));
}

/**
 * Hover / focus warm-up for Play buttons. `bind(item)` returns handlers to spread on the button; the item is prepared
 * once the pointer or focus has rested on it for 400 ms (not again within 25 s). `now(item)` prepares immediately.
 */
export function usePlayWarmup(user: User | null) {
  const items = useRef(new Map<string, Item>());
  const userRef = useRef(user);
  userRef.current = user;
  const timer = useMemo(() => new DwellTimer((id) => void prepareItem(items.current.get(id), userRef.current, 'hover')), []);
  useEffect(() => () => timer.reset(), [timer]);
  const bind = useCallback((item: Item | null | undefined) => {
    if (!item || !canWarmItem(item)) return {};
    const enter = () => {
      items.current.set(item.id, item);
      timer.enter(item.id);
    };
    const leave = () => timer.leave(item.id);
    return { onMouseEnter: enter, onMouseLeave: leave, onFocus: enter, onBlur: leave };
  }, [timer]);
  const now = useCallback((item: Item | null | undefined, reason: 'open' | 'next' = 'open') => {
    if (!item || !canWarmItem(item) || timer.recentlyFired(item.id)) return;
    items.current.set(item.id, item);
    // Mark as fired, then send with the right reason.
    timer.markFired(item.id);
    void prepareItem(item, userRef.current, reason);
  }, [timer]);
  return { bind, now };
}
