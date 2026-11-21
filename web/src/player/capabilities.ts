/**
 * Video-range (HDR / Dolby Vision) and 10-bit capability detection for the web player.
 *
 * Everything here probes what *our own engine* can feed to the hardware decoder — Media Source Extensions
 * (`MediaSource.isTypeSupported`, `MediaCapabilities.decodingInfo({ type: 'media-source' })`) — never what a TV's
 * built-in player could do. The TV apps (Samsung Tizen, LG webOS, Hisense VIDAA) play through hls.js/MSE like every browser, so
 * the server direct-streams (remuxes to fMP4/HLS) when MSE on that TV decodes HEVC/HDR10/HLG/E-AC3, and transcodes
 * otherwise. See docs/HDR.md.
 *
 * Detection is async (MediaCapabilities); call `initCapabilities()` early and `await capabilitiesReady()` before
 * requesting playback. Until it resolves the profile simply omits `videoRange` (legacy behaviour on the server).
 */
import type { VideoRangeCapabilities } from '@mediamax/shared';

export interface VideoCaps {
  videoRange: VideoRangeCapabilities;
  tenBitCodecs: string[];
  maxHeight: number | null;
  /** Short platform tag for the profile's `player` field / diagnostics. */
  platform: 'tizen' | 'webos' | 'vidaa' | 'safari' | 'browser';
}

/** Hisense VIDAA OS (its browser engine says "VIDAA"; some firmware only says "Hisense"). Not Hisense phones. */
export const isVidaaUa = (ua: string): boolean => /VIDAA/i.test(ua) || (/Hisense/i.test(ua) && !/Mobile/i.test(ua) && !/Android/i.test(ua));

/** The TV platforms whose wrapper apps load the web app in TV mode (see /tv). */
export const isTvPlatform = (p: VideoCaps['platform']): boolean => p === 'tizen' || p === 'webos' || p === 'vidaa';

let caps: VideoCaps | null = null;
let pending: Promise<VideoCaps> | null = null;

type MSClass = { isTypeSupported(type: string): boolean };
function msClass(): MSClass | null {
  const w = window as unknown as { ManagedMediaSource?: MSClass; MediaSource?: MSClass; WebKitMediaSource?: MSClass };
  return w.ManagedMediaSource ?? w.MediaSource ?? w.WebKitMediaSource ?? null;
}
function mse(type: string): boolean {
  try {
    return !!msClass()?.isTypeSupported(type);
  } catch {
    return false;
  }
}

export const platformTag = (): VideoCaps['platform'] => {
  const ua = navigator.userAgent;
  if (/Tizen/i.test(ua)) return 'tizen';
  if (/Web0S|WebOS|NetCast/i.test(ua)) return 'webos';
  if (isVidaaUa(ua)) return 'vidaa';
  if (/^((?!chrome|android|crios|fxios).)*safari/i.test(ua)) return 'safari';
  return 'browser';
};

interface VideoProbe {
  contentType: string;
  transferFunction?: 'srgb' | 'pq' | 'hlg';
  colorGamut?: 'srgb' | 'p3' | 'rec2020';
  hdrMetadataType?: 'smpteSt2086' | 'smpteSt2094-10' | 'smpteSt2094-40';
}

/** MediaCapabilities for MSE playback of a 4K24 stream with the given colour properties. */
async function decodes(p: VideoProbe, height = 2160): Promise<boolean> {
  const mc = (navigator as Navigator & { mediaCapabilities?: MediaCapabilities }).mediaCapabilities;
  if (!mc?.decodingInfo) return mse(p.contentType) && !p.transferFunction;
  try {
    const r = await mc.decodingInfo({
      type: 'media-source',
      video: { contentType: p.contentType, width: Math.round((height * 16) / 9), height, bitrate: 20_000_000, framerate: 24, ...(p.transferFunction ? { transferFunction: p.transferFunction, colorGamut: p.colorGamut ?? 'rec2020' } : {}), ...(p.hdrMetadataType ? { hdrMetadataType: p.hdrMetadataType } : {}) } as VideoConfiguration,
    });
    return !!r.supported;
  } catch {
    // Unknown dictionary members (old engines) throw: fall back to a plain type check, which can't confirm HDR.
    return false;
  }
}

const HEVC10 = 'video/mp4; codecs="hvc1.2.4.L153.B0"';
const AV1_10 = 'video/mp4; codecs="av01.0.12M.10"';
const VP9_10 = 'video/mp4; codecs="vp09.02.51.10.01.09.16.09.00"';

function displayIsHdr(): boolean {
  try {
    return window.matchMedia('(dynamic-range: high)').matches || window.matchMedia('(video-dynamic-range: high)').matches;
  } catch {
    return false;
  }
}

async function detect(): Promise<VideoCaps> {
  const platform = platformTag();
  const tenBitCodecs: string[] = [];
  if (mse(HEVC10)) tenBitCodecs.push('hevc');
  if (mse(AV1_10)) tenBitCodecs.push('av1');
  if (mse(VP9_10) || mse('video/webm; codecs="vp09.02.10.10"')) tenBitCodecs.push('vp9');

  const hdrDisplay = displayIsHdr();
  const anyPq = async (meta: VideoProbe['hdrMetadataType']) => {
    for (const ct of [HEVC10, AV1_10, VP9_10]) if (await decodes({ contentType: ct, transferFunction: 'pq', hdrMetadataType: meta })) return true;
    return false;
  };
  const pq = await anyPq('smpteSt2086');
  const hlg = (await decodes({ contentType: HEVC10, transferFunction: 'hlg' })) || (await decodes({ contentType: VP9_10, transferFunction: 'hlg' }));
  const hdr10Plus = pq && (await anyPq('smpteSt2094-40'));
  // Decoders accept PQ on SDR screens too. Count it as supported only when the screen is HDR, or the platform
  // tone-maps HDR video itself (Safari/macOS/iOS, Chrome & Edge on Windows/macOS).
  const tonemapsItself = platform === 'safari' || (/Chrome\//.test(navigator.userAgent) && /Windows|Macintosh/.test(navigator.userAgent));
  const tv = isTvPlatform(platform);
  const usable = (ok: boolean) => ok && (hdrDisplay || tonemapsItself || tv);

  const videoRange: VideoRangeCapabilities = {
    hdr10: usable(pq),
    hdr10Plus: usable(hdr10Plus),
    hlg: usable(hlg),
    dolbyVision: false,
    hdrDisplay,
  };
  // Dolby Vision: the server remuxes DV with its configuration box and announces dvh1/dav1 codecs (server dovi.ts),
  // so any engine whose MSE (or native HLS, Safari) accepts the DV codec strings gets real Dolby Vision.
  const detected = trustedDolbyVision(platform, await detectDolbyVision(platform));
  const profiles = applyDolbyVisionOverride(detected.length && (hdrDisplay || tonemapsItself || tv) ? detected : [], dolbyVisionOverride());
  if (profiles.length) {
    videoRange.dolbyVision = true;
    videoRange.dolbyVisionProfiles = profiles;
  }
  const sh = Math.round(Math.min(window.screen?.width ?? 1920, window.screen?.height ?? 1080) * Math.min(window.devicePixelRatio || 1, 2));
  // TVs report a 1080p CSS viewport even on 4K panels; let MSE decide whether 2160p decodes.
  const maxHeight = tv ? ((await decodes({ contentType: HEVC10 }, 2160)) ? 2160 : 1080) : sh >= 2000 ? 2160 : null;
  return { videoRange, tenBitCodecs, maxHeight, platform };
}

/* ------------------------------ Dolby Vision ------------------------------ */

/** Codec strings per Dolby Vision profile, as the server's DV master playlists announce them (level 06 = 4K24). */
export const DV_PROBES: { profiles: string[]; codecs: string[] }[] = [
  { profiles: ['5'], codecs: ['dvh1.05.06'] },
  { profiles: ['8.1', '8.4'], codecs: ['dvh1.08.06'] },
  { profiles: ['7'], codecs: ['dvhe.07.06', 'dvh1.07.06'] },
  { profiles: ['10'], codecs: ['dav1.10.06'] },
];

/** Dolby Vision profiles this engine decodes. `probe` checks one codec string (exported for tests). */
export async function dolbyVisionProfiles(probe: (codec: string) => Promise<boolean>): Promise<string[]> {
  const out: string[] = [];
  for (const p of DV_PROBES) {
    for (const c of p.codecs) {
      if (await probe(c)) {
        out.push(...p.profiles);
        break;
      }
    }
  }
  return out;
}

async function detectDolbyVision(platform: VideoCaps['platform']): Promise<string[]> {
  const v = typeof document !== 'undefined' ? document.createElement('video') : null;
  return dolbyVisionProfiles(async (codec) => {
    const type = `video/mp4; codecs="${codec}"`;
    // Safari plays HLS natively, so canPlayType counts there; everywhere else only MSE (our hls.js engine) matters.
    const typeOk = mse(type) || (platform === 'safari' && !!v && v.canPlayType(type) !== '');
    if (!typeOk) return false;
    const mc = (navigator as Navigator & { mediaCapabilities?: MediaCapabilities }).mediaCapabilities;
    if (!mc?.decodingInfo) return true;
    // MediaCapabilities with Dolby Vision metadata (SMPTE ST 2094-10). Engines that don't know the members throw or
    // say "unsupported" for every DV query; then the MSE answer stands (LG webOS reports dvh1 through MSE only).
    try {
      const r = await mc.decodingInfo({
        type: 'media-source',
        video: { contentType: type, width: 3840, height: 2160, bitrate: 20_000_000, framerate: 24, hdrMetadataType: 'smpteSt2094-10', transferFunction: 'pq', colorGamut: 'rec2020' } as VideoConfiguration,
      });
      if (r.supported) return true;
      const plain = await mc.decodingInfo({ type: 'media-source', video: { contentType: type, width: 3840, height: 2160, bitrate: 20_000_000, framerate: 24 } });
      // A plain "yes" but a "no" with DV metadata means this engine decodes the base layer only.
      return !plain.supported;
    } catch {
      return true;
    }
  });
}

/**
 * Auto-detected Dolby Vision profiles we act on. VIDAA: none. Community reports say its browser hangs or shows a black
 * picture on Dolby Vision in MP4 (our remux is fMP4 with the DV configuration box), even on panels that play DV MKV
 * files in the TV's own media player, and MSE answers for dvh1 aren't confirmed there. So VIDAA gets the HDR10/HLG base
 * layer unless the user sets "This device supports Dolby Vision" to Yes. Exported for tests.
 */
export function trustedDolbyVision(platform: VideoCaps['platform'], detected: string[]): string[] {
  return platform === 'vidaa' ? [] : detected;
}

/** Settings → Playback → This device: "This device supports Dolby Vision": auto (detect), yes, no. */
export type DolbyVisionOverride = 'auto' | 'yes' | 'no';
const DV_KEY = 'mediamax.dolbyVision';

export function dolbyVisionOverride(): DolbyVisionOverride {
  try {
    const v = localStorage.getItem(DV_KEY);
    return v === 'yes' || v === 'no' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function setDolbyVisionOverride(v: DolbyVisionOverride) {
  try {
    if (v === 'auto') localStorage.removeItem(DV_KEY);
    else localStorage.setItem(DV_KEY, v);
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
  resetCapabilities();
}

/** Apply the user's override: "yes" adds the single-layer profiles every DV TV plays (5, 8.1, 8.4); "no" removes all. */
export function applyDolbyVisionOverride(detected: string[], o: DolbyVisionOverride): string[] {
  if (o === 'no') return [];
  if (o === 'yes') return [...new Set(['5', '8.1', '8.4', ...detected])];
  return detected;
}

const resetListeners = new Set<() => void>();
/** Called when capabilities are detected again (the device profile drops its cached copy). */
export const onCapabilitiesReset = (fn: () => void) => {
  resetListeners.add(fn);
  return () => resetListeners.delete(fn);
};

/** Forget the detected capabilities (after a setting changed); the next initCapabilities() detects again. */
export function resetCapabilities() {
  caps = null;
  pending = null;
  for (const fn of resetListeners) fn();
}

export function initCapabilities(): Promise<VideoCaps> {
  if (!pending) {
    pending = detect().then((c) => (caps = c)).catch(() => {
      caps = { videoRange: { hdr10: false, hlg: false, hdr10Plus: false, dolbyVision: false }, tenBitCodecs: [], maxHeight: null, platform: platformTag() };
      return caps;
    });
  }
  return pending;
}

/** Resolves once detection finished, or after `timeoutMs` (playback must never wait long for this). */
export async function capabilitiesReady(timeoutMs = 1500): Promise<VideoCaps | null> {
  const p = initCapabilities();
  return Promise.race([p, new Promise<null>((r) => window.setTimeout(() => r(null), timeoutMs))]);
}

export const videoCaps = () => caps;
