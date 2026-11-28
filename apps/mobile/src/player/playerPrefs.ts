/**
 * Playback preferences shared by the server and every player: which audio / subtitle track to start with, which
 * segments to skip by themselves, subtitle text clean-up (SDH tags, right-to-left punctuation), HDR subtitle colours
 * and AutoSync time maps. Pure TypeScript, no imports, no DOM.
 *
 * The canonical copy lives in shared/src/playerPrefs.ts; `node scripts/sync-types.mjs` copies it verbatim to
 * server/src/services/playerPrefs.ts, web/src/player/playerPrefs.ts and apps/mobile/src/player/playerPrefs.ts.
 */

/* --------------------------------- languages -------------------------------- */

/** ISO 639-2 (B and T) → ISO 639-1 for the languages media files use most. */
const TO2: Record<string, string> = {
  eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', ita: 'it', por: 'pt', jpn: 'ja', chi: 'zh', zho: 'zh', kor: 'ko',
  rus: 'ru', dut: 'nl', nld: 'nl', swe: 'sv', nor: 'no', nob: 'no', nno: 'no', dan: 'da', fin: 'fi', pol: 'pl', rum: 'ro', ron: 'ro',
  tur: 'tr', ara: 'ar', hin: 'hi', heb: 'he', gre: 'el', ell: 'el', cze: 'cs', ces: 'cs', hun: 'hu', bul: 'bg', hrv: 'hr', srp: 'sr',
  slo: 'sk', slk: 'sk', slv: 'sl', ukr: 'uk', vie: 'vi', tha: 'th', ind: 'id', may: 'ms', msa: 'ms', per: 'fa', fas: 'fa', alb: 'sq',
  sqi: 'sq', ice: 'is', isl: 'is', est: 'et', lav: 'lv', lit: 'lt', cat: 'ca', baq: 'eu', eus: 'eu', glg: 'gl', tam: 'ta', tel: 'te',
  ben: 'bn', urd: 'ur', fil: 'tl', tgl: 'tl', cmn: 'zh', yue: 'zh',
};

/** Lower-case ISO 639-1 code ("jpn" → "ja", "pt-BR" → "pt"); '' for unknown / undetermined. */
export function lang2(l: string | null | undefined): string {
  const s = (l ?? '').trim().toLowerCase();
  if (!s || s === 'und' || s === 'mul' || s === 'zxx') return '';
  if (TO2[s]) return TO2[s];
  const base = s.split(/[-_]/)[0];
  // An unknown 3-letter code stays whole: cutting it to 2 letters would match other languages (mal/mar → "ma").
  return base.length === 2 ? base : TO2[base] ?? base;
}

export function sameLanguage(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = lang2(a);
  return !!x && x === lang2(b);
}

/* -------------------------------- track choice ------------------------------- */

export interface AudioChoice {
  index: number;
  language: string | null;
  default?: boolean;
}

export interface AudioPrefs {
  audioLanguage?: string | null;
  secondaryAudioLanguage?: string | null;
}

/**
 * The audio track to start with from the viewer's preferences, or null for "the file's default". 'original' means the
 * title's original language; when that is unknown (or the file has no such track) the default track is the best guess.
 */
export function pickAudio<T extends AudioChoice>(streams: T[], prefs: AudioPrefs, originalLanguage?: string | null): T | null {
  for (const want of [prefs.audioLanguage, prefs.secondaryAudioLanguage]) {
    if (!want) continue;
    const lang = want === 'original' ? originalLanguage : want;
    if (!lang) continue;
    const match = streams.find((s) => sameLanguage(s.language, lang));
    if (match) return match;
  }
  return null;
}

export interface SubtitleChoice {
  index: number;
  language: string | null;
  default: boolean;
  forced: boolean;
}

export interface SubtitlePrefs {
  subtitleMode?: 'off' | 'auto' | 'always' | 'forced';
  subtitleLanguage?: string | null;
  secondarySubtitleLanguage?: string | null;
  showOnlyPreferredSubtitles?: boolean;
}

const subtitleLanguages = (p: SubtitlePrefs) => [p.subtitleLanguage, p.secondarySubtitleLanguage].filter((l): l is string => !!lang2(l));

/** The first track matching the preferred languages in order. */
function byLanguage<T extends SubtitleChoice>(tracks: T[], langs: string[]): T | undefined {
  for (const l of langs) {
    const t = tracks.find((s) => sameLanguage(s.language, l));
    if (t) return t;
  }
  return undefined;
}

/**
 * The subtitle track to start with (null = off).
 *  - always: full subtitles in a preferred language, else the default track, else the first
 *  - forced: forced subtitles in a preferred language, else any forced track
 *  - auto:   forced subtitles (preferred language first); when the audio isn't in a preferred subtitle language (a
 *            foreign-language film), full subtitles in a preferred language; else the file's default track
 */
export function pickSubtitle<T extends SubtitleChoice>(tracks: T[], prefs: SubtitlePrefs, audioLanguage?: string | null): T | null {
  const mode = prefs.subtitleMode ?? 'auto';
  if (mode === 'off' || !tracks.length) return null;
  const langs = subtitleLanguages(prefs);
  const forced = tracks.filter((t) => t.forced);
  const full = tracks.filter((t) => !t.forced);
  if (mode === 'forced') return byLanguage(forced, langs) ?? forced[0] ?? null;
  if (mode === 'always') return byLanguage(full, langs) ?? byLanguage(tracks, langs) ?? tracks.find((t) => t.default) ?? tracks[0];
  const forcedPick = byLanguage(forced, langs) ?? (langs.length ? undefined : forced[0]);
  if (forcedPick) return forcedPick;
  if (langs.length && lang2(audioLanguage) && !langs.some((l) => sameLanguage(l, audioLanguage))) {
    const foreign = byLanguage(full, langs);
    if (foreign) return foreign;
  }
  return tracks.find((t) => t.default) ?? null;
}

/** The subtitle list to offer: only the preferred languages when asked (all of them when none match). */
export function visibleSubtitles<T extends SubtitleChoice>(tracks: T[], prefs: SubtitlePrefs): T[] {
  const langs = subtitleLanguages(prefs);
  if (!prefs.showOnlyPreferredSubtitles || !langs.length) return tracks;
  const keep = tracks.filter((t) => langs.some((l) => sameLanguage(t.language, l)));
  return keep.length ? keep : tracks;
}

/**
 * Subtitles to hand to an external player: the track our player would show first (the player switches it on), then
 * the other text tracks in the viewer's languages; none when our player would show none. Image tracks are left out.
 */
export function externalSubtitles<T extends SubtitleChoice & { url: string; isImage?: boolean }>(
  tracks: T[], prefs: SubtitlePrefs, audioLanguage?: string | null,
): T[] {
  // The same choice as our own player (Auto with own-language audio → none); the first track is the one switched on.
  const text = tracks.filter((t) => !t.isImage && t.url);
  const first = pickSubtitle(text, prefs, audioLanguage);
  if (!first) return [];
  return [first, ...visibleSubtitles(text, prefs).filter((t) => t !== first)];
}

/* --------------------------------- auto-skip --------------------------------- */

export type SkipType = 'intro' | 'recap' | 'preview' | 'commercial' | 'credits';

export interface SkipPrefs {
  skipIntros?: boolean;
  autoSkip?: Partial<Record<SkipType, boolean>>;
}

/** Whether the player skips this segment by itself. Unset keys follow the legacy `skipIntros` (credits: off). */
export function shouldAutoSkip(prefs: SkipPrefs | null | undefined, type: string): boolean {
  if (!prefs) return false;
  const own = prefs.autoSkip?.[type as SkipType];
  if (typeof own === 'boolean') return own;
  return type === 'credits' ? false : !!prefs.skipIntros;
}

/* ------------------------------ subtitle text -------------------------------- */

/**
 * Removes hearing-impaired annotations: [music playing], (sighs), ♪-only lines are kept (lyrics), speaker labels in
 * capitals ("JOHN:", "MAN 2:") at the start of a line, and lines left empty or holding only a dash.
 * Returns '' when nothing spoken is left (the cue is then hidden).
 */
export function stripSdh(text: string): string {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    let line = raw
      .replace(/\[[^\]\n]*\]/g, '')
      .replace(/\([^)\n]*\)/g, '')
      .replace(/^(\s*-?\s*)[\p{Lu}][\p{Lu}\d .'’-]{1,30}:\s*/u, '$1');
    line = line.replace(/\s{2,}/g, ' ').trim();
    if (!line || /^[-–—:.,\s]*$/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n');
}

const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const RLM = '‏';

/**
 * Right-to-left lines (Arabic, Hebrew, Persian …): subtitle files written for players without bidi support often
 * end up with the sentence's punctuation on the wrong end. Wrapping each RTL line in right-to-left marks makes the
 * renderer treat the line as RTL from end to end, so "!", "?", "." and "…" stay at its left (reading) end.
 */
export function fixRtl(text: string): string {
  return text
    .split('\n')
    .map((l) => (RTL.test(l) && !l.startsWith(RLM) ? `${RLM}${l}${RLM}` : l))
    .join('\n');
}

/** The cue text as the viewer wants to read it ('' = hide the cue). */
export function cleanCueText(text: string, style: { stripSdh?: boolean; rtlFix?: boolean } | null | undefined): string {
  let t = text;
  if (style?.stripSdh) t = stripSdh(t);
  if (style?.rtlFix !== false) t = fixRtl(t);
  return t;
}

/* ------------------------------ HDR comfort ---------------------------------- */

const HEX = /^#([0-9a-f]{6})$/i;
export const isHexColor = (v: unknown): v is string => typeof v === 'string' && HEX.test(v);

/** `#rrggbb` dimmed for HDR playback: brightness 0–100 maps to 30–100 % of the colour's intensity. */
export function dimColor(hex: string, brightness: number): string {
  const m = HEX.exec(hex);
  if (!m) return hex;
  const b = Math.max(0, Math.min(100, Number.isFinite(brightness) ? brightness : 100));
  const f = 0.3 + 0.7 * (b / 100);
  const n = parseInt(m[1], 16);
  const ch = (shift: number) => Math.round(((n >> shift) & 255) * f).toString(16).padStart(2, '0');
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

export interface HdrStylePrefs {
  hdrStyleEnabled?: boolean;
  hdrTextColor?: string;
  hdrBrightness?: number;
  hdrDimPlayerControls?: boolean;
}

/** Whether HDR comfort applies: HDR reaches the display (passed through or as its HDR10 base layer, not tone-mapped). */
export function hdrActive(range: { delivery?: string } | null | undefined): boolean {
  return !!range && !!range.delivery && range.delivery !== 'sdr' && range.delivery !== 'tonemap';
}

/** Subtitle text colour during HDR playback, or null to keep the normal colour. */
export function hdrSubtitleColor(style: HdrStylePrefs | null | undefined, hdr: boolean): string | null {
  if (!hdr || !style?.hdrStyleEnabled) return null;
  return dimColor(isHexColor(style.hdrTextColor) ? style.hdrTextColor : '#ffffff', style.hdrBrightness ?? 70);
}

/** Opacity for the player controls during HDR playback (1 = unchanged). */
export function hdrControlsOpacity(style: HdrStylePrefs | null | undefined, hdr: boolean): number {
  if (!hdr || !style?.hdrStyleEnabled || !style.hdrDimPlayerControls) return 1;
  return Math.round((0.3 + 0.7 * (Math.max(0, Math.min(100, style.hdrBrightness ?? 70)) / 100)) * 100) / 100;
}

/* -------------------------------- AutoSync ----------------------------------- */

export interface SyncMap {
  ratio: number;
  offsetMs: number;
  groups: { fromMs: number; offsetMs: number }[];
}

/** A cue time (ms, in the subtitle file's own clock) moved by an AutoSync map. */
export function applySyncMap(ms: number, map: SyncMap | null | undefined): number {
  if (!map) return ms;
  let t = ms * map.ratio + map.offsetMs;
  let extra = 0;
  for (const g of map.groups) {
    if (t >= g.fromMs) extra = g.offsetMs;
    else break;
  }
  t += extra;
  return Math.max(0, Math.round(t));
}
