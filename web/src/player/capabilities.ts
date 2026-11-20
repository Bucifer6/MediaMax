/**
 * Video-range (HDR / Dolby Vision) and 10-bit capability detection for the web player.
 *
 * Everything here probes what *our own engine* can feed to the hardware decoder — Media Source Extensions
 * (`MediaSource.isTypeSupported`, `MediaCapabilities.decodingInfo({ type: 'media-source' })`) — never what a TV's
 * built-in player could do. The TV apps (Samsung Tizen, LG webOS) play through hls.js/MSE like every browser, so
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
  platform: 'tizen' | 'webos' | 'safari' | 'browser';
}

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
  const tv = platform === 'tizen' || platform === 'webos';
  const usable = (ok: boolean) => ok && (hdrDisplay || tonemapsItself || tv);

  const videoRange: VideoRangeCapabilities = {
    hdr10: usable(pq),
    hdr10Plus: usable(hdr10Plus),
    hlg: usable(hlg),
    // Dolby Vision is only claimed by engines that play DV-tagged streams themselves (Safari / AVFoundation).
    // Through MSE our remuxed fMP4 is tagged hvc1, so DV 8.x reaches TVs and browsers as its HDR10/HLG base layer.
    dolbyVision: false,
    hdrDisplay,
  };
  if (platform === 'safari') {
    const v = document.createElement('video');
    const dv = (c: string) => v.canPlayType(`video/mp4; codecs="${c}"`) !== '' || mse(`video/mp4; codecs="${c}"`);
    const profiles: string[] = [];
    if (dv('dvh1.05.06')) profiles.push('5');
    if (dv('dvh1.08.06')) profiles.push('8.1', '8.4');
    if (profiles.length && (hdrDisplay || tonemapsItself)) {
      videoRange.dolbyVision = true;
      videoRange.dolbyVisionProfiles = profiles;
    }
  }
  const sh = Math.round(Math.min(window.screen?.width ?? 1920, window.screen?.height ?? 1080) * Math.min(window.devicePixelRatio || 1, 2));
  // TVs report a 1080p CSS viewport even on 4K panels; let MSE decide whether 2160p decodes.
  const maxHeight = tv ? ((await decodes({ contentType: HEVC10 }, 2160)) ? 2160 : 1080) : sh >= 2000 ? 2160 : null;
  return { videoRange, tenBitCodecs, maxHeight, platform };
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
