import type { ReplayGain } from '@mediamax/shared';

const db = (v: string | undefined) => {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/db/i, '').trim());
  return Number.isFinite(n) && Math.abs(n) < 60 ? Math.round(n * 100) / 100 : null;
};
const peak = (v: string | undefined) => {
  if (v == null) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 && n < 10 ? Math.round(n * 1e6) / 1e6 : null;
};
/** Opus R128 gains are Q7.8 fixed-point dB relative to −23 LUFS; ReplayGain targets −18 LUFS (+5 dB). */
const r128 = (v: string | undefined) => {
  if (v == null || !/^-?\d+$/.test(v.trim())) return null;
  return Math.round((parseInt(v, 10) / 256 + 5) * 100) / 100;
};

/** Read ReplayGain (or Opus R128) loudness tags; keys must be lower-case. */
export function parseReplayGain(tags: Record<string, string>): ReplayGain | null {
  const rg: ReplayGain = {
    trackGainDb: db(tags.replaygain_track_gain) ?? r128(tags.r128_track_gain),
    trackPeak: peak(tags.replaygain_track_peak),
    albumGainDb: db(tags.replaygain_album_gain) ?? r128(tags.r128_album_gain),
    albumPeak: peak(tags.replaygain_album_peak),
  };
  return rg.trackGainDb == null && rg.albumGainDb == null ? null : rg;
}

/** The loudness tags worth caching with an item (so unchanged files keep their gain on rescans). */
export function gainTags(tags: Record<string, string>): Record<string, string> {
  const o: Record<string, string> = {};
  for (const k of ['replaygain_track_gain', 'replaygain_track_peak', 'replaygain_album_gain', 'replaygain_album_peak', 'r128_track_gain', 'r128_album_gain']) if (tags[k] != null) o[k] = tags[k];
  return o;
}
