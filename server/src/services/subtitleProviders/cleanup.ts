/**
 * Post-download clean-up applied to every provider's subtitle:
 *  1. detect the encoding (UTF-8 ± BOM, UTF-16 BOM, Windows-1250, ISO-8859-2, ISO-8859-16, Windows-1252) → UTF-8;
 *  2. repair mojibake (UTF-8 read as Windows-1252, and for Romanian the classic "º þ ª Þ ã" cp1250-as-cp1252 damage);
 *  3. Romanian: cedilla ş ţ Ş Ţ → comma-below ș ț Ș Ț;
 *  4. normalise line endings to "\n";
 *  5. drop subtitle-site advert cues (conservatively: only lines that are an advert *and* name a site).
 */

export type SubtitleEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'windows-1250' | 'iso-8859-2' | 'iso-8859-16' | 'windows-1252';

const RO = new Set(['ro', 'rum', 'ron', 'mo', 'mol']);
/** Languages whose legacy single-byte encoding is Central European (cp1250 / ISO-8859-2 / -16). */
const CENTRAL = new Set([...RO, 'hu', 'hun', 'cs', 'cze', 'ces', 'sk', 'slo', 'slk', 'pl', 'pol', 'sl', 'slv', 'hr', 'hrv', 'scr', 'bs', 'bos', 'sr', 'srp', 'scc', 'sq', 'alb', 'sqi']);

export const isRomanian = (lang: string | null | undefined) => !!lang && RO.has(lang.toLowerCase().split(/[-_]/)[0]);

/* ---------------------------- decoding ---------------------------- */

/** ISO-8859-16 (Romanian) is not in the WHATWG encoding list, so Node's TextDecoder can't do it: table for 0xA0-0xFF. */
const ISO_8859_16_HIGH = [
  0x00a0, 0x0104, 0x0105, 0x0141, 0x20ac, 0x201e, 0x0160, 0x00a7, 0x0161, 0x00a9, 0x0218, 0x00ab, 0x0179, 0x00ad, 0x017a, 0x017b,
  0x00b0, 0x00b1, 0x010c, 0x0142, 0x017d, 0x201d, 0x00b6, 0x00b7, 0x017e, 0x010d, 0x0219, 0x00bb, 0x0152, 0x0153, 0x0178, 0x017c,
  0x00c0, 0x00c1, 0x00c2, 0x0102, 0x00c4, 0x0106, 0x00c6, 0x00c7, 0x00c8, 0x00c9, 0x00ca, 0x00cb, 0x00cc, 0x00cd, 0x00ce, 0x00cf,
  0x0110, 0x0143, 0x00d2, 0x00d3, 0x00d4, 0x0150, 0x00d6, 0x015a, 0x0170, 0x00d9, 0x00da, 0x00db, 0x00dc, 0x0118, 0x021a, 0x00df,
  0x00e0, 0x00e1, 0x00e2, 0x0103, 0x00e4, 0x0107, 0x00e6, 0x00e7, 0x00e8, 0x00e9, 0x00ea, 0x00eb, 0x00ec, 0x00ed, 0x00ee, 0x00ef,
  0x0111, 0x0144, 0x00f2, 0x00f3, 0x00f4, 0x0151, 0x00f6, 0x015b, 0x0171, 0x00f9, 0x00fa, 0x00fb, 0x00fc, 0x0119, 0x021b, 0x00ff,
];

function decodeIso885916(buf: Uint8Array): string {
  let s = '';
  for (const b of buf) s += String.fromCharCode(b >= 0xa0 ? ISO_8859_16_HIGH[b - 0xa0] : b);
  return s;
}

export function decodeAs(buf: Uint8Array, enc: SubtitleEncoding): string {
  switch (enc) {
    case 'utf-8-bom': return new TextDecoder('utf-8').decode(buf.subarray(3));
    case 'utf-16le': case 'utf-16be': return new TextDecoder(enc).decode(buf.subarray(2));
    case 'iso-8859-16': return decodeIso885916(buf);
    default: return new TextDecoder(enc).decode(buf);
  }
}

const RO_LETTERS = /[ăâîșțĂÂÎȘȚşţŞŢ]/g;
const C1 = /[\u0080-\u009f]/g;
const ODD = /[¤¦¨´¸ˇ˘˙˛˝¢¥¯¹²³¼-¾×÷]/g;

/** Plausibility of decoded text: letters count, C1 controls and odd symbols count against it. */
function plausibility(text: string, lang: string | null): number {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const c1 = text.match(C1)?.length ?? 0;
  const odd = text.match(ODD)?.length ?? 0;
  let score = letters - c1 * 10 - odd * 3;
  if (isRomanian(lang)) {
    score += (text.match(RO_LETTERS)?.length ?? 0) * 3;
    // cp1252 renders Romanian cp1250 bytes as ordinal indicators and Icelandic letters.
    score -= (text.match(/[ºªþÞ]/g)?.length ?? 0) * 3;
  }
  return score;
}

/** Detect the encoding of a subtitle file. Pure function of the bytes plus a language hint. */
export function detectEncoding(buf: Uint8Array, lang: string | null = null): SubtitleEncoding {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8-bom';
  if (buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  if (buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return 'utf-8';
  } catch {
    /* single-byte */
  }
  const l = (lang ?? '').toLowerCase().split(/[-_]/)[0];
  const candidates: SubtitleEncoding[] = CENTRAL.has(l)
    ? (isRomanian(l) ? ['windows-1250', 'iso-8859-16', 'iso-8859-2', 'windows-1252'] : ['windows-1250', 'iso-8859-2', 'iso-8859-16', 'windows-1252'])
    : ['windows-1252', 'windows-1250', 'iso-8859-2', 'iso-8859-16'];
  // Bytes 0x80-0x9F are printable in the Windows code pages and C1 controls in ISO-8859-x: their presence decides.
  let hasC1Range = false;
  for (const b of buf) if (b >= 0x80 && b <= 0x9f) { hasC1Range = true; break; }
  let best = candidates[0];
  let bestScore = -Infinity;
  candidates.forEach((enc, i) => {
    if (hasC1Range && enc.startsWith('iso-')) return;
    // A small prior keeps the language's usual code page on ties.
    const s = plausibility(decodeAs(buf, enc), lang) - i * 0.5;
    if (s > bestScore) {
      bestScore = s;
      best = enc;
    }
  });
  return best;
}

/* ---------------------------- repairs ---------------------------- */

let cp1252Reverse: Map<string, number> | null = null;
/** Encode text back to Windows-1252 bytes (null when a character has no cp1252 byte). */
function encodeCp1252(text: string): Buffer | null {
  if (!cp1252Reverse) {
    cp1252Reverse = new Map();
    const all = new TextDecoder('windows-1252').decode(Uint8Array.from({ length: 256 }, (_, i) => i));
    for (let i = 0; i < 256; i++) cp1252Reverse.set(all[i], i);
  }
  const out = Buffer.alloc(text.length);
  let n = 0;
  for (const ch of text) {
    const b = cp1252Reverse.get(ch);
    if (b === undefined) return null;
    out[n++] = b;
  }
  return out.subarray(0, n);
}

/** "Äƒ" / "È™" / "Ã®": UTF-8 that was decoded as cp1252 and saved again. Undo it when it clearly happened. */
export function fixDoubleUtf8(text: string): string {
  const hits = text.match(/[ÃÄÅÈÉ][\u0080-¿ŒœŠšŸŽžƒˆ˜–—‘-„†-•…‰‹›€™]/g)?.length ?? 0;
  if (hits < 3) return text;
  // Line by line so one odd line can't block the rest.
  return text.split('\n').map((line) => {
    if (!/[ÃÄÅÈÉ]/.test(line)) return line;
    const bytes = encodeCp1252(line);
    if (!bytes) return line;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return line;
    }
  }).join('\n');
}

const RO_MOJIBAKE: Record<string, string> = { 'º': 'ș', 'þ': 'ț', 'ª': 'Ș', 'Þ': 'Ț', 'ã': 'ă', 'Ã': 'Ă' };

/**
 * Romanian cp1250 text read as cp1252 ("pentru cã eºti aºa"): º þ ª Þ ã Ã → ș ț Ș Ț ă Ă.
 * Only when the language is Romanian and the damage is clear: several º/þ and no real ș/ț in the text.
 */
export function fixRomanianMojibake(text: string): string {
  const marks = text.match(/[ºþªÞ]/g)?.length ?? 0;
  const real = text.match(/[șțȘȚşţŞŢ]/g)?.length ?? 0;
  if (marks < 3 || real > marks / 10) return text;
  // "º" also appears legitimately as "nº"/"1º": leave it after a digit.
  return text.replace(/(\d)?([ºþªÞãÃ])/g, (m, digit: string | undefined, ch: string) => (digit && ch === 'º' ? m : (digit ?? '') + RO_MOJIBAKE[ch]));
}

/** Cedilla ş ţ Ş Ţ (U+015F/0163/015E/0162) → comma-below ș ț Ș Ț (U+0219/021B/0218/021A). */
export function fixRomanianDiacritics(text: string): string {
  return text.replace(/[şţŞŢ]/g, (c) => ({ 'ş': 'ș', 'ţ': 'ț', 'Ş': 'Ș', 'Ţ': 'Ț' })[c]!);
}

export const normaliseLineEndings = (text: string) => text.replace(/\r\n?/g, '\n');

/* ---------------------------- adverts ---------------------------- */

/** A site / domain mention (required for a line to count as an advert). */
const SITE = /(https?:\/\/|www\.|\b[\w-]+\.(com|ro|net|org|info|tv|io|me|link|club)\b)/i;
/** Advert phrasing typical of subtitle sites and sync credits. */
const AD = [
  /\b(opensubtitles|subs\.ro|subtitrari[-\s]?noi|titrari\.ro|subtitrari\.|addic7ed|podnapisi|subscene|yifysubtitles|osdb\.link|subdl|tvsubtitles|regielive|subsunacs)\b/i,
  /\b(downloaded|download(ed)?\s+from|subtitles?\s+(by|from|downloaded)|subtitrare|subtitrarea|traducerea|traducere|sincronizare|sincronizarea|sync(ed|hronized)?|resync(ed)?|corrected|ripped|encoded)\b.*\b(by|de|from|cu|pe|realizat[aă]?)\b/i,
  /\b(advertise your product|become (a )?vip member|support us and become|remove all ads|best watched using|visit us at|vizitati|vizitează|vizitati-ne)\b/i,
];

export function isAdvertLine(line: string): boolean {
  const plain = line.replace(/<[^>]*>/g, '').replace(/\{[^}]*\}/g, '').trim();
  if (!plain || !SITE.test(plain)) return false;
  return AD.some((re) => re.test(plain));
}

/** Remove SRT cues whose text lines are all adverts, then renumber. Non-SRT text is returned unchanged. */
export function stripSrtAdverts(text: string): { text: string; removed: number } {
  const blocks = text.split(/\n{2,}/);
  const timing = /^\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/;
  if (!blocks.some((b) => timing.test(b.split('\n')[1] ?? '') || timing.test(b.split('\n')[0] ?? ''))) return { text, removed: 0 };
  let removed = 0;
  const kept: string[] = [];
  for (const b of blocks) {
    const lines = b.split('\n').filter((l, i) => !(i === 0 && l.trim() === ''));
    const ti = lines.findIndex((l) => timing.test(l));
    if (ti < 0) {
      if (b.trim()) kept.push(b);
      continue;
    }
    const body = lines.slice(ti + 1).filter((l) => l.trim());
    if (body.length && body.every(isAdvertLine)) {
      removed++;
      continue;
    }
    kept.push(lines.slice(ti).join('\n'));
  }
  if (!removed) return { text, removed: 0 };
  let n = 0;
  return { text: kept.map((b) => (timing.test(b.split('\n')[0]) ? `${++n}\n${b}` : b)).join('\n\n').trimEnd() + '\n', removed };
}

/* ---------------------------- pipeline ---------------------------- */

export interface CleanResult {
  text: string;
  encoding: SubtitleEncoding;
  fixes: string[];
}

/** Full clean-up of a downloaded subtitle file's bytes. `format` is the file extension (srt/ass/vtt/ssa). */
export function cleanSubtitle(buf: Uint8Array, lang: string | null, format = 'srt'): CleanResult {
  const fixes: string[] = [];
  const encoding = detectEncoding(buf, lang);
  let text = decodeAs(buf, encoding);
  if (encoding !== 'utf-8') fixes.push(`converted from ${encoding}`);
  const before = text;
  text = fixDoubleUtf8(text);
  if (text !== before) fixes.push('repaired double-encoded UTF-8');
  if (isRomanian(lang)) {
    const b2 = text;
    text = fixRomanianMojibake(text);
    if (text !== b2) fixes.push('repaired Romanian mojibake');
    const b3 = text;
    text = fixRomanianDiacritics(text);
    if (text !== b3) fixes.push('cedilla → comma-below diacritics');
  }
  const b4 = text;
  text = normaliseLineEndings(text);
  if (text !== b4) fixes.push('normalised line endings');
  if (format === 'srt') {
    const r = stripSrtAdverts(text);
    if (r.removed) fixes.push(`removed ${r.removed} advert cue(s)`);
    text = r.text;
  }
  return { text, encoding, fixes };
}
