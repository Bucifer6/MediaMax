/** ISO 639-2 (B and T) and common names → ISO 639-1, for the languages subtitle sites use most. */
const TO2: Record<string, string> = {
  eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', ita: 'it', por: 'pt', jpn: 'ja', chi: 'zh', zho: 'zh', kor: 'ko',
  rus: 'ru', dut: 'nl', nld: 'nl', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi', pol: 'pl', rum: 'ro', ron: 'ro', tur: 'tr', ara: 'ar',
  hin: 'hi', heb: 'he', gre: 'el', ell: 'el', cze: 'cs', ces: 'cs', hun: 'hu', bul: 'bg', hrv: 'hr', srp: 'sr', scc: 'sr', slo: 'sk',
  slk: 'sk', slv: 'sl', ukr: 'uk', vie: 'vi', tha: 'th', ind: 'id', may: 'ms', msa: 'ms', per: 'fa', fas: 'fa', alb: 'sq', sqi: 'sq',
  romanian: 'ro', romana: 'ro', 'română': 'ro', english: 'en', engleza: 'en', 'engleză': 'en',
};

/** Lower-case ISO 639-1 code for a subtitle language ("rum" → "ro", "pt-BR" → "pt", "ro" → "ro"). */
export function lang2(l: string | null | undefined): string {
  const s = (l ?? '').trim().toLowerCase();
  if (!s) return 'und';
  return TO2[s] ?? s.slice(0, 2);
}
