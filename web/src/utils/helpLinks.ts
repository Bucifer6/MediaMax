/**
 * Help Centre links for the player's "Why" line: each transcode/remux reason the server produces
 * (server/src/services/playback.ts, hdr.ts, audio.ts) → the matching section of the troubleshooting article.
 * server/test/help.test.ts checks every anchor here exists.
 */
const RULES: [RegExp, string][] = [
  [/audio processing requested/i, 'why-transcoding#audio-processing'],
  [/transcoding requested/i, 'why-transcoding#audio-format'],
  [/^video codec .* not supported/i, 'why-transcoding#video-codec'],
  [/^10-bit /i, 'why-transcoding#ten-bit'],
  [/^resolution exceeds/i, 'why-transcoding#resolution'],
  [/dual-layer\) remuxed/i, 'why-transcoding#dolby-vision-dual-layer'],
  [/can't be remuxed with its Dolby Vision/i, 'why-transcoding#dolby-vision-ffmpeg'],
  [/tone-mapping/i, 'why-transcoding#hdr-tone-mapping'],
  [/^audio codec .* not supported|→ .*: device |DTS core/i, 'why-transcoding#audio-format'],
  [/^container .* not supported/i, 'why-transcoding#container'],
  [/^bitrate .* exceeds/i, 'why-transcoding#bitrate'],
  [/non-default audio track/i, 'why-transcoding#audio-track'],
  [/transcoding not permitted/i, 'why-transcoding#transcoding-not-permitted'],
];

/** "why-transcoding#bitrate" for a reason string; the general article when nothing more specific matches. */
export function helpForReason(reason: string): string {
  const r = reason.trim();
  for (const [re, slug] of RULES) if (re.test(r)) return slug;
  return 'why-transcoding#methods';
}

/** In-app path of a help slug ("slug" or "slug#anchor"). */
export const helpPath = (slug: string) => {
  const [s, anchor] = slug.split('#');
  return `/help/${s}${anchor ? `#${anchor}` : ''}`;
};
