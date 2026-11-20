/**
 * Audio capability detection for the web player (browsers and the Samsung Tizen / LG webOS TV apps).
 *
 * Like capabilities.ts this probes what our own engine (hls.js → Media Source Extensions) can feed the decoder:
 * `MediaSource.isTypeSupported` for AC-3 / E-AC-3 / Opus / FLAC, `MediaCapabilities.decodingInfo` for multichannel AAC
 * (channels "6"/"8") and Dolby Atmos (`spatialRendering: true` on E-AC-3), and the speaker count from
 * `AudioContext.destination.maxChannelCount`. Browsers often report 2 channels even on a 5.1 HDMI setup, so the count
 * is a hint; TVs that decode AC-3 / E-AC-3 through MSE pass them on to a soundbar over ARC/eARC and report 6.
 * The server uses `maxAudioChannels` to choose AAC 7.1 / 5.1 / stereo (with a proper downmix) or E-AC-3. See docs/AUDIO.md.
 */
export interface AudioCaps {
  /** Extra codec tokens for the device profile ("ac3", "eac3", "eac3-joc", "opus", "flac" …). */
  audioCodecs: string[];
  /** Codecs decoded with more than two channels. */
  multichannelAudioCodecs: string[];
  maxAudioChannels: number;
  /** E-AC-3 JOC (Dolby Atmos) renders spatially (Safari on Apple devices with spatial audio, some TVs). */
  atmos: boolean;
  /** Web Audio can process the element's sound here (night mode / dialogue boost / delay during direct play). */
  webAudioFx: boolean;
}

let caps: AudioCaps | null = null;
let pending: Promise<AudioCaps> | null = null;

type MSClass = { isTypeSupported(type: string): boolean };
function mse(type: string): boolean {
  try {
    const w = window as unknown as { ManagedMediaSource?: MSClass; MediaSource?: MSClass; WebKitMediaSource?: MSClass };
    return !!(w.ManagedMediaSource ?? w.MediaSource ?? w.WebKitMediaSource)?.isTypeSupported(type);
  } catch {
    return false;
  }
}

function canPlay(type: string): boolean {
  try {
    return document.createElement('audio').canPlayType(type) !== '';
  } catch {
    return false;
  }
}

const isTv = () => /Tizen|Web0S|WebOS|NetCast/i.test(navigator.userAgent);

/** MediaCapabilities check for an audio configuration (MSE). Unknown dictionary members make old engines throw → false. */
async function decodesAudio(contentType: string, channels: number, extra: Record<string, unknown> = {}): Promise<boolean | null> {
  const mc = (navigator as Navigator & { mediaCapabilities?: MediaCapabilities }).mediaCapabilities;
  if (!mc?.decodingInfo) return null;
  try {
    const r = await mc.decodingInfo({
      type: 'media-source',
      audio: { contentType, channels: String(channels), bitrate: channels > 2 ? 640_000 : 192_000, samplerate: 48000, ...extra } as AudioConfiguration,
    });
    return !!r.supported;
  } catch {
    return false;
  }
}

function speakerChannels(): number {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return 2;
    const ctx = new Ctx();
    const n = ctx.destination.maxChannelCount || 2;
    void ctx.close().catch(() => {});
    return n;
  } catch {
    return 2;
  }
}

async function detect(): Promise<AudioCaps> {
  const audioCodecs: string[] = [];
  const multi: string[] = [];
  const t = (type: string) => mse(type) || canPlay(type);
  const ac3 = t('audio/mp4; codecs="ac-3"');
  const eac3 = t('audio/mp4; codecs="ec-3"');
  if (ac3) audioCodecs.push('ac3');
  if (eac3) audioCodecs.push('eac3');
  if (t('audio/mp4; codecs="opus"') || t('audio/webm; codecs="opus"')) audioCodecs.push('opus');
  if (t('audio/mp4; codecs="flac"') || canPlay('audio/flac')) audioCodecs.push('flac');

  // Multichannel decode. Most engines answer "supported" (they decode and downmix), so this mainly catches refusals.
  const aac6 = await decodesAudio('audio/mp4; codecs="mp4a.40.2"', 6);
  const aac8 = await decodesAudio('audio/mp4; codecs="mp4a.40.2"', 8);
  if (aac6 !== false) multi.push('aac');
  if (eac3 && (await decodesAudio('audio/mp4; codecs="ec-3"', 6)) !== false) multi.push('eac3');
  if (ac3) multi.push('ac3');
  if (audioCodecs.includes('opus')) multi.push('opus');
  if (audioCodecs.includes('flac')) multi.push('flac');

  // Atmos: E-AC-3 JOC with spatial rendering (Safari on AirPods / spatial-audio Macs, some TVs).
  const atmos = eac3 && (await decodesAudio('audio/mp4; codecs="ec-3"', 16, { spatialRendering: true })) === true;
  if (atmos) audioCodecs.push('eac3-joc');

  const tv = isTv();
  let maxAudioChannels = Math.max(2, Math.min(8, speakerChannels()));
  // A TV that decodes Dolby formats through MSE sends them on to the soundbar / AV receiver (ARC / eARC).
  if (tv && (ac3 || eac3)) maxAudioChannels = Math.max(maxAudioChannels, 6);
  if (maxAudioChannels >= 8 && aac8 === false) maxAudioChannels = 6;
  return {
    audioCodecs,
    multichannelAudioCodecs: multi,
    maxAudioChannels,
    atmos,
    // TV media pipelines decode in hardware outside Web Audio's reach (MediaElementSource goes silent).
    webAudioFx: !tv && typeof window.AudioContext !== 'undefined',
  };
}

export function initAudioCaps(): Promise<AudioCaps> {
  if (!pending) {
    pending = detect().then((c) => (caps = c)).catch(() => {
      caps = { audioCodecs: [], multichannelAudioCodecs: ['aac'], maxAudioChannels: 2, atmos: false, webAudioFx: false };
      return caps;
    });
  }
  return pending;
}

/** Resolves once detection finished, or after `timeoutMs`. */
export async function audioCapsReady(timeoutMs = 1000): Promise<AudioCaps | null> {
  const p = initAudioCaps();
  return Promise.race([p, new Promise<null>((r) => window.setTimeout(() => r(null), timeoutMs))]);
}

export const audioCaps = () => caps;
