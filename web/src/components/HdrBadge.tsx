import type { HdrFormat, MediaSource, PlaybackInfo, VideoRangeInfo } from '@mediamax/shared';

const SHORT: Record<HdrFormat, string> = { sdr: 'SDR', hdr10: 'HDR10', hdr10plus: 'HDR10+', hlg: 'HLG', dolbyvision: 'Dolby Vision' };

/** HDR10 / HDR10+ / HLG / Dolby Vision badge. `label` (e.g. "Dolby Vision 8.1") shows as the tooltip. */
export function RangeBadge({ format, label, title }: { format: HdrFormat; label?: string; title?: string }) {
  if (format === 'sdr') return null;
  return (
    <span className={`badge badge-hdr badge-hdr-${format}`} title={title ?? label ?? SHORT[format]}>
      {format === 'dolbyvision' ? <><b>DOLBY</b> VISION</> : SHORT[format]}
    </span>
  );
}

/** Badge for a media source; falls back to a plain "HDR" badge for files scanned before HDR detection. */
export function MediaRangeBadge({ media }: { media: MediaSource }) {
  const r = media.videoRange;
  if (r && r.hdrFormat !== 'sdr') return <RangeBadge format={r.hdrFormat} label={r.label} title={rangeDetails(r)} />;
  if (media.hdr) return <span className="badge badge-hdr badge-hdr-hdr10" title="HDR">HDR</span>;
  return null;
}

/** "Dolby Vision 8.1 · HDR10 fallback · 10-bit · MaxCLL 1000 nits" */
export function rangeDetails(r: VideoRangeInfo): string {
  const parts = [r.label];
  if (r.dolbyVision?.level) parts.push(`level ${r.dolbyVision.level}`);
  if (r.fallback && r.hdrFormat !== r.fallback) parts.push(r.fallback === 'none' ? 'no HDR10 fallback' : `${r.fallback.toUpperCase()} fallback`);
  if (r.dolbyVision?.el) parts.push('dual layer');
  if (r.bitDepth) parts.push(`${r.bitDepth}-bit`);
  if (r.masteringDisplay?.maxLuminance) parts.push(`mastered ${Math.round(r.masteringDisplay.maxLuminance)} nits`);
  if (r.contentLight?.maxCll) parts.push(`MaxCLL ${r.contentLight.maxCll}`);
  return parts.join(' · ');
}

/** How the range reaches this device, for the player's info overlay. */
export function rangeDeliveryText(v: NonNullable<PlaybackInfo['videoRange']>): string {
  switch (v.delivery) {
    case 'passthrough': return `${v.label} (native)`;
    case 'base-layer': return `${v.label} → played as its HDR base layer`;
    case 'strip-dovi': return `${v.label} → HDR10 base layer (Dolby Vision layers removed)`;
    case 'tonemap': return `${v.label} → tone-mapped to SDR`;
    default: return v.label;
  }
}
