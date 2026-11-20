/**
 * HDR / Dolby Vision detection (from ffprobe JSON) and the matching playback decision for a client's video-range
 * capabilities. Pure functions so they are easy to unit-test with fixture JSON; probe.ts does the ffprobe calls.
 *
 * Decision summary (see docs/HDR.md):
 *   SDR                     → always fine.
 *   HDR10 / HDR10+ / HLG    → direct when the client supports that range (HDR10+ falls back to its static HDR10 layer).
 *   Dolby Vision 8.1 / 8.4  → direct to DV clients with that profile, else direct to HDR10 (8.1) / HLG (8.4) clients
 *                             (they ignore the RPU and play the base layer), else tone-map.
 *   Dolby Vision 8.2 / 9    → SDR base layer: always watchable.
 *   Dolby Vision 7 (Blu-ray)→ direct to clients that list profile 7; else copy the video and strip the RPU/EL NAL
 *                             units (types 62/63) so the HDR10 base layer plays cleanly; else tone-map.
 *   Dolby Vision 5          → only DV clients with profile 5; anything else has no usable fallback → tone-map
 *                             (libplacebo applies the RPU reshaping when available; otherwise colours will be off).
 *   Dolby Vision 10 (AV1)   → like 8.x: DV clients listing 10, else the AV1 HDR10/HLG base layer (10.1/10.4).
 *
 * "passthrough" for DV that has to be remuxed means real Dolby Vision through HLS: playback.ts decide() adds the
 * DV signalling from dovi.ts (DV box + codec strings), or falls back to these rules without DV when FFmpeg can't.
 */
import type { DeviceProfile, DolbyVisionInfo, HdrFormat, VideoRangeCapabilities, VideoRangeDelivery, VideoRangeInfo } from '@mediamax/shared';

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v);
  if (s.includes('/')) {
    const [a, b] = s.split('/').map(Number);
    return b ? a / b : null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const isHdr10Plus = (sd: any) => /SMPTE\s*2094-40|HDR10\+/i.test(sd?.side_data_type ?? '');
const isDoviConfig = (sd: any) => /DOVI configuration/i.test(sd?.side_data_type ?? '');
const isDoviAny = (sd: any) => /DOVI|Dolby Vision/i.test(sd?.side_data_type ?? '');

/** Base-layer fallback for a DV stream. */
function doviFallback(dv: DolbyVisionInfo, transfer: string | null): VideoRangeInfo['fallback'] {
  if (dv.profile === 5) return 'none';
  switch (dv.blCompatId) {
    case 1: case 6: return 'hdr10';
    case 2: return 'sdr';
    case 4: return 'hlg';
    case 0: return dv.profile === 7 || dv.profile === 8 ? (transfer === 'arib-std-b67' ? 'hlg' : 'hdr10') : 'none';
  }
  // Unknown compat id: judge by the stream's own transfer characteristics.
  if (transfer === 'smpte2084') return 'hdr10';
  if (transfer === 'arib-std-b67') return 'hlg';
  return dv.profile === 9 || dv.profile === 10 ? 'sdr' : null;
}

export function doviProfileLabel(dv: DolbyVisionInfo): string {
  // 8.1 / 8.2 / 8.4 (HEVC) and 10.1 / 10.2 / 10.4 (AV1): profile + base-layer compatibility id.
  if ((dv.profile === 8 || dv.profile === 10) && dv.blCompatId != null && [1, 2, 4].includes(dv.blCompatId)) return `${dv.profile}.${dv.blCompatId}`;
  return String(dv.profile);
}

function parseDovi(sd: any): DolbyVisionInfo {
  return {
    profile: num(sd.dv_profile) ?? 0,
    level: num(sd.dv_level),
    blCompatId: num(sd.dv_bl_signal_compatibility_id),
    rpu: !!num(sd.rpu_present_flag),
    el: !!num(sd.el_present_flag),
    bl: sd.bl_present_flag == null ? true : !!num(sd.bl_present_flag),
  };
}

/**
 * Work out the video range from an ffprobe video stream and, optionally, the side data of its first frame
 * (`-show_frames -read_intervals %+#1`), which is where HDR10+ and (for MKV) mastering metadata show up.
 * Returns null for streams without a video codec.
 */
export function parseVideoRange(stream: any, firstFrameSideData: any[] = []): VideoRangeInfo | null {
  if (!stream || stream.codec_type !== 'video') return null;
  const sideData: any[] = [...(stream.side_data_list ?? []), ...firstFrameSideData];
  const transfer: string | null = stream.color_transfer ?? null;
  const tag = String(stream.codec_tag_string ?? '').toLowerCase();
  const doviSd = sideData.find(isDoviConfig);
  let dolbyVision: DolbyVisionInfo | null = doviSd ? parseDovi(doviSd) : null;
  if (!dolbyVision && (/^dv(he|h1|a1|av)$/.test(tag) || sideData.some(isDoviAny))) {
    // DV signalled by the sample entry / RPU only (no configuration record): profile unknown.
    dolbyVision = { profile: tag === 'dvh1' || tag === 'dvhe' ? 8 : 0, level: null, blCompatId: null, rpu: true, el: false, bl: true };
  }
  const hdr10Plus = sideData.some(isHdr10Plus);
  let hdrFormat: HdrFormat = 'sdr';
  if (dolbyVision) hdrFormat = 'dolbyvision';
  else if (transfer === 'smpte2084') hdrFormat = hdr10Plus ? 'hdr10plus' : 'hdr10';
  else if (transfer === 'arib-std-b67') hdrFormat = 'hlg';

  const md = sideData.find((s) => /Mastering display/i.test(s.side_data_type ?? ''));
  const cl = sideData.find((s) => /Content light level/i.test(s.side_data_type ?? ''));
  const pix: string | null = stream.pix_fmt ?? null;
  const pixDepth = pix ? /p(\d{2})(le|be)$/.exec(pix)?.[1] : undefined;
  const bitDepth = num(stream.bits_per_raw_sample) ?? (pixDepth ? Number(pixDepth) : pix && /^(yuv|nv12|yuvj)/.test(pix) ? 8 : null);
  const fps = num(stream.avg_frame_rate) || num(stream.r_frame_rate);

  let fallback: VideoRangeInfo['fallback'] = null;
  if (dolbyVision) fallback = doviFallback(dolbyVision, transfer);
  else if (hdrFormat === 'hdr10plus') fallback = 'hdr10';

  const label = dolbyVision
    ? `Dolby Vision${dolbyVision.profile ? ` ${doviProfileLabel(dolbyVision)}` : ''}${hdr10Plus ? ' + HDR10+' : ''}`
    : hdrFormat === 'hdr10plus' ? 'HDR10+' : hdrFormat === 'hdr10' ? 'HDR10' : hdrFormat === 'hlg' ? 'HLG' : 'SDR';

  return {
    hdrFormat,
    fallback,
    label,
    bitDepth: bitDepth && bitDepth > 0 ? bitDepth : null,
    pixFmt: pix,
    codecProfile: stream.profile ?? null,
    colorTransfer: transfer,
    colorPrimaries: stream.color_primaries ?? null,
    colorSpace: stream.color_space ?? null,
    frameRate: fps ? Math.round(fps * 1000) / 1000 : null,
    dolbyVision,
    masteringDisplay: md ? { minLuminance: num(md.min_luminance), maxLuminance: num(md.max_luminance) } : null,
    contentLight: cl && (num(cl.max_content) || num(cl.max_average)) ? { maxCll: num(cl.max_content) ?? 0, maxFall: num(cl.max_average) ?? 0 } : null,
  };
}

/** Whether a first-frame probe could add anything (HDR10+ / mastering metadata only exist on PQ streams). */
export const wantsFrameProbe = (stream: any) => stream?.codec_type === 'video' && stream.color_transfer === 'smpte2084';

/* ------------------------------ decisions ------------------------------ */

export interface RangeDecision {
  /** The client can play the video stream as-is (possibly as its HDR10/HLG/SDR base layer). */
  ok: boolean;
  delivery: VideoRangeDelivery;
  /** When transcoding anyway: tone-map HDR → SDR. */
  toneMap: boolean;
  /** When copying video (remux): bitstream filter to apply (DV profile 7 → HDR10 base layer). */
  videoBsf: string | null;
  /** Remux is required to strip DV layers (direct play of the file would show a broken picture). */
  needsRemux: boolean;
  reasons: string[];
}

/** FFmpeg bitstream filter that drops Dolby Vision RPU (NAL 62) and enhancement-layer (NAL 63) units from HEVC. */
export const STRIP_DOVI_BSF = 'filter_units=remove_types=62|63';

const OK = (delivery: VideoRangeDelivery): RangeDecision => ({ ok: true, delivery, toneMap: false, videoBsf: null, needsRemux: false, reasons: [] });
const TONEMAP = (reason: string): RangeDecision => ({ ok: false, delivery: 'tonemap', toneMap: true, videoBsf: null, needsRemux: false, reasons: [reason] });

export function doviProfileSupported(caps: VideoRangeCapabilities, dv: DolbyVisionInfo): boolean {
  if (!caps.dolbyVision) return false;
  const list = caps.dolbyVisionProfiles;
  // A DV client without a list: assume the common single-layer profiles 5 and 8.x.
  if (!list?.length) return dv.profile === 5 || dv.profile === 8;
  const label = doviProfileLabel(dv);
  return list.some((p) => p === label || (p === String(dv.profile) && dv.profile !== 7) || (p === '7' && dv.profile === 7) || (dv.profile === 8 && p === '8'));
}

/**
 * Decide how a source's dynamic range reaches a client. `caps` undefined = legacy client: every range is "ok"
 * (MediaMax's previous behaviour), and tone-mapping is left to the admin setting.
 */
export function rangeDecision(range: VideoRangeInfo | null | undefined, hdrFlag: boolean, caps: VideoRangeCapabilities | undefined): RangeDecision & { legacy: boolean } {
  const fmt: HdrFormat = range?.hdrFormat ?? (hdrFlag ? 'hdr10' : 'sdr');
  if (fmt === 'sdr') return { ...OK('sdr'), legacy: !caps };
  if (!caps) return { ...OK('passthrough'), legacy: true };
  const r = (d: RangeDecision) => ({ ...d, legacy: false });
  const hdr10 = !!caps.hdr10;
  const hlg = !!caps.hlg;
  switch (fmt) {
    case 'hdr10':
      return r(hdr10 ? OK('passthrough') : TONEMAP('HDR10 needs tone-mapping for this SDR device'));
    case 'hdr10plus':
      if (caps.hdr10Plus) return r(OK('passthrough'));
      return r(hdr10 ? OK('base-layer') : TONEMAP('HDR10+ needs tone-mapping for this SDR device'));
    case 'hlg':
      return r(hlg ? OK('passthrough') : TONEMAP('HLG needs tone-mapping for this device'));
    case 'dolbyvision': {
      const dv = range?.dolbyVision;
      const fb = range?.fallback ?? null;
      if (dv && doviProfileSupported(caps, dv)) return r(OK('passthrough'));
      const label = dv?.profile ? `Dolby Vision profile ${doviProfileLabel(dv)}` : 'Dolby Vision';
      if (dv?.profile === 7 || dv?.el) {
        // Dual-layer: the BL is HDR10, but the EL/RPU NAL units trip up many decoders — strip them.
        if (hdr10 && (fb === 'hdr10' || fb == null)) {
          return r({ ok: true, delivery: 'strip-dovi', toneMap: false, videoBsf: STRIP_DOVI_BSF, needsRemux: true, reasons: [`${label} (dual-layer) remuxed to its HDR10 base layer`] });
        }
        return r(TONEMAP(`${label} needs tone-mapping for this device`));
      }
      if (fb === 'sdr') return r(OK('base-layer'));
      if (fb === 'hdr10' && hdr10) return r(OK('base-layer'));
      if (fb === 'hlg' && hlg) return r(OK('base-layer'));
      if (fb === 'none') return r(TONEMAP(`${label} has no HDR10 fallback layer; tone-mapping`));
      return r(TONEMAP(`${label} needs tone-mapping for this ${hdr10 ? 'device' : 'SDR device'}`));
    }
  }
  return { ...OK('passthrough'), legacy: false };
}

/** Normalise DeviceProfile range caps (accepts legacy profiles without the field). */
export const rangeCaps = (p: DeviceProfile | undefined): VideoRangeCapabilities | undefined => p?.videoRange ?? undefined;

/** The range a client's display ends up showing for a delivery decision (for display-mode matching). */
export function outputRange(range: VideoRangeInfo | null | undefined, hdrFlag: boolean, delivery: VideoRangeDelivery): 'sdr' | 'hdr10' | 'hlg' | 'dolbyvision' {
  const fmt: HdrFormat = range?.hdrFormat ?? (hdrFlag ? 'hdr10' : 'sdr');
  switch (delivery) {
    case 'sdr': case 'tonemap': return 'sdr';
    case 'strip-dovi': return 'hdr10';
    case 'base-layer': return range?.fallback === 'hlg' ? 'hlg' : range?.fallback === 'sdr' || range?.fallback === 'none' ? 'sdr' : 'hdr10';
    case 'passthrough': return fmt === 'hdr10plus' ? 'hdr10' : fmt === 'sdr' ? 'sdr' : fmt;
  }
}
