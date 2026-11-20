/**
 * Channel ↔ guide matching.
 *
 * IPTV channel names are messy ("UK: BBC One HD", "|US| ESPN FHD", "bbc.one.uk"), guide channel names less so.
 * Both are normalised (country prefixes, quality tags, "+1", punctuation, number words, camelCase ids), then
 * compared in order of trust: exact guide id, tuner guide number, callsign, exact normalised name, and finally
 * fuzzy similarity (token Dice + trigram Dice + Jaro-Winkler) with penalties for numbers, countries and ambiguity.
 */

export const AUTO_THRESHOLD = 0.8;
export const SUGGEST_THRESHOLD = 0.5;

export interface LiveChannelIn {
  id: string;
  name: string;
  /** tvg-id / Xtream epg_channel_id / M3U tvg-name. */
  tvgId?: string | null;
  /** Tuner guide number ("7.1"); only compared when `byNumber` is set. */
  number?: string | null;
}

export interface GuideChannelIn {
  id: string;
  names: string[];
  callsign?: string | null;
  number?: string | null;
}

export type MatchMethod = 'id' | 'number' | 'callsign' | 'name' | 'fuzzy';

export interface MatchResult {
  guideId: string;
  confidence: number;
  method: MatchMethod;
  /** "+1" channels matched to the base channel play an hour later. */
  offsetMinutes: number;
}

export interface Normalized {
  tokens: string[];
  compact: string;
  country: string | null;
  plus: number;
  quality: boolean;
}

/* ------------------------------ normalisation ------------------------------ */

const COUNTRY_ALIASES: Record<string, string> = {
  uk: 'gb', gb: 'gb', en: 'gb', us: 'us', usa: 'us', ca: 'ca', can: 'ca', au: 'au', aus: 'au', nz: 'nz', ie: 'ie', irl: 'ie',
  de: 'de', ger: 'de', at: 'at', ch: 'ch', fr: 'fr', fra: 'fr', be: 'be', nl: 'nl', es: 'es', esp: 'es', pt: 'pt', it: 'it', ita: 'it',
  pl: 'pl', se: 'se', swe: 'se', no: 'no', dk: 'dk', fi: 'fi', gr: 'gr', tr: 'tr', ru: 'ru', ua: 'ua', ro: 'ro', hu: 'hu', cz: 'cz',
  in: 'in', ind: 'in', pk: 'pk', br: 'br', mx: 'mx', ar: 'ar', latam: 'latam', lat: 'latam', za: 'za', ae: 'ae', sa: 'sa', il: 'il',
  ph: 'ph', my: 'my', sg: 'sg', id: 'id', jp: 'jp', kr: 'kr', cn: 'cn', hk: 'hk', tw: 'tw', vn: 'vn', th: 'th', ex: 'ex', yu: 'yu',
  al: 'al', rs: 'rs', hr: 'hr', ba: 'ba', bg: 'bg', mk: 'mk', si: 'si', sk: 'sk', lt: 'lt', lv: 'lv', ee: 'ee', is: 'is', af: 'af', ir: 'ir',
  arab: 'arab', afr: 'afr', carib: 'carib',
};
/** Codes that are also common channel words — only treated as a country in prefix position with a separator. */
const AMBIGUOUS_COUNTRY = new Set(['in', 'is', 'no', 'it', 'my', 'id', 'en', 'ex', 'al', 'at', 'be', 'ch', 'can', 'sa', 'ar']);

const QUALITY = new Set(['hd', 'fhd', 'uhd', 'sd', '4k', '8k', 'hevc', 'h264', 'h265', 'x265', '1080p', '1080i', '720p', '576i', '576p', '2160p', '50fps', '60fps', 'fps', 'hdr', 'hq', 'lq', 'backup', 'raw', 'vip', 'dt', 'hd1', 'hd2', 'orig', 'original', 'source', 'multi', 'aac', 'ac3', 'dd', '51']);
const STOP = new Set(['the', 'a', 'of', 'tv', 'channel', 'network']);
const NUMBER_WORDS: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12' };

/** Split camelCase ids: "BBCOneHD" → "BBC One HD", "SkySportsMainEvent" → "Sky Sports Main Event". */
const splitCamel = (s: string) => (/\s/.test(s.trim()) ? s : s.replace(/([a-z]{2})([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2'));

/** "itv1" → ["itv", "1"], "5usa" → ["5", "usa"]; keeps "4k", "1080p", "50fps", "1st". */
function splitAlnum(t: string): string[] {
  if (QUALITY.has(t) || /^\d+(st|nd|rd|th|k|p|i|fps)$/.test(t)) return [t];
  return t.replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2').split(' ');
}

export function normalizeName(raw: string): Normalized {
  let s = (raw ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
  let country: string | null = null;
  // Guide-id style "BBCOne.uk@HD" / "bbc.one.uk": drop the @feed, take the country suffix.
  s = s.replace(/@[\w-]+$/, '');
  const idSuffix = s.match(/^[^\s]+\.([a-z]{2,3})$/i);
  if (idSuffix && COUNTRY_ALIASES[idSuffix[1].toLowerCase()]) {
    country = COUNTRY_ALIASES[idSuffix[1].toLowerCase()];
    s = s.slice(0, -idSuffix[1].length - 1);
  }
  // Country prefixes: "UK: ", "US| ", "|UK| ", "[DE] ", "FR - ", "UK ▎".
  const pre = s.match(/^\s*[[(|]?\s*([A-Za-z]{2,5})\s*(?:[\])|:▎│┃»]|\s-\s|-\s|\s[|:])\s*/);
  if (pre && COUNTRY_ALIASES[pre[1].toLowerCase()]) {
    country = COUNTRY_ALIASES[pre[1].toLowerCase()];
    s = s.slice(pre[0].length);
  }
  // "+1" / "+24" timeshift channels.
  let plus = 0;
  s = s.replace(/\s*\+\s?(\d{1,2})\b/, (_m, n) => {
    plus = Number(n);
    return ' ';
  });
  s = splitCamel(s).replace(/&/g, ' and ').replace(/[^A-Za-z0-9]+/g, ' ').toLowerCase();
  let quality = false;
  const tokens: string[] = [];
  for (const raw of s.split(' ')) {
    if (!raw) continue;
    for (const t of splitAlnum(raw)) {
      if (!t) continue;
      if (QUALITY.has(t)) {
        quality = true;
        continue;
      }
      tokens.push(NUMBER_WORDS[t] ?? t);
    }
  }
  // Trailing country word ("BBC One UK", "ESPN US"), only if something else is left.
  if (tokens.length > 1) {
    const last = tokens[tokens.length - 1];
    if (COUNTRY_ALIASES[last] && !AMBIGUOUS_COUNTRY.has(last) && tokens.slice(0, -1).some((t) => t.length >= 2 && !isNum(t))) {
      country ??= COUNTRY_ALIASES[last];
      tokens.pop();
    }
  }
  const meaningful = tokens.filter((t) => !STOP.has(t));
  const final = meaningful.length ? meaningful : tokens;
  return { tokens: final, compact: final.join(''), country, plus, quality };
}

/* ------------------------------ similarity ------------------------------ */

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a ? 1 : 0;
  if (!a || !b) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array<boolean>(a.length).fill(false);
  const bm = new Array<boolean>(b.length).fill(false);
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (bm[j] || a[i] !== b[j]) continue;
      am[i] = bm[j] = true;
      m++;
      break;
    }
  }
  if (!m) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (m / a.length + m / b.length + (m - t / 2) / m) / 3;
  let p = 0;
  while (p < 4 && p < a.length && p < b.length && a[p] === b[p]) p++;
  return jaro + p * 0.1 * (1 - jaro);
}

function trigrams(s: string): Map<string, number> {
  const g = new Map<string, number>();
  const p = `  ${s} `;
  for (let i = 0; i < p.length - 2; i++) {
    const k = p.slice(i, i + 3);
    g.set(k, (g.get(k) ?? 0) + 1);
  }
  return g;
}

export function trigramDice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ga = trigrams(a);
  const gb = trigrams(b);
  let inter = 0;
  let na = 0;
  let nb = 0;
  for (const v of ga.values()) na += v;
  for (const v of gb.values()) nb += v;
  for (const [k, v] of ga) inter += Math.min(v, gb.get(k) ?? 0);
  return (2 * inter) / (na + nb);
}

const isNum = (t: string) => /^\d+$/.test(t);
const tokenEq = (a: string, b: string) => a === b || (a.length >= 5 && b.length >= 5 && jaroWinkler(a, b) >= 0.94);

/** Similarity of two normalised names, 0–1 (before plus/country adjustments). */
export function nameSimilarity(a: Normalized, b: Normalized): number {
  if (!a.compact || !b.compact) return 0;
  if (a.compact === b.compact) return 1;
  const da = a.tokens.filter(isNum);
  const db = b.tokens.filter(isNum);
  const numsDiffer = da.length > 0 && db.length > 0 && (da.length !== db.length || da.some((d) => !db.includes(d)));
  // Token overlap (soft Dice).
  const used = new Set<number>();
  let common = 0;
  for (const t of a.tokens) {
    const j = b.tokens.findIndex((u, i) => !used.has(i) && tokenEq(t, u));
    if (j >= 0) {
      used.add(j);
      common++;
    }
  }
  const dice = (2 * common) / (a.tokens.length + b.tokens.length);
  // One name is the other plus extra words ("BBC One London" ⊃ "BBC One").
  const short = Math.min(a.tokens.length, b.tokens.length);
  const long = Math.max(a.tokens.length, b.tokens.length);
  const shortToks = a.tokens.length <= b.tokens.length ? a.tokens : b.tokens;
  const subset = common === short && short > 0 && shortToks.some((t) => t.length >= 2 && !isNum(t)) ? 0.72 + 0.2 * (short / long) : 0;
  const chars = 0.5 * trigramDice(a.compact, b.compact) + 0.5 * jaroWinkler(a.compact, b.compact);
  let s = Math.max(dice, subset, chars * 0.95);
  if (numsDiffer) s = Math.min(s, 0.35);
  else if ((da.length > 0) !== (db.length > 0)) s *= 0.85;
  return s;
}

/* ------------------------------ index ------------------------------ */

interface Variant {
  idx: number;
  n: Normalized;
}

const callsignOf = (s: string | null | undefined) => {
  const m = (s ?? '').toUpperCase().replace(/[-\s](DT\d?|HD|TV|CD|LP|LD)$/, '').trim();
  return /^[KWCX][A-Z]{2,3}$/.test(m) ? m : null;
};

/** Pre-indexed guide channel list, so matching thousands of channels against thousands of guide channels stays fast. */
export class GuideIndex {
  private readonly byId = new Map<string, number>();
  private readonly byNumber = new Map<string, number>();
  private readonly byCallsign = new Map<string, number>();
  private readonly byCompact = new Map<string, number[]>();
  private readonly byToken = new Map<string, number[]>();
  private readonly variants: Variant[][] = [];

  constructor(readonly channels: GuideChannelIn[]) {
    channels.forEach((c, i) => {
      if (!this.byId.has(c.id.toLowerCase())) this.byId.set(c.id.toLowerCase(), i);
      if (c.number && !this.byNumber.has(normNumber(c.number))) this.byNumber.set(normNumber(c.number), i);
      const cs = callsignOf(c.callsign) ?? null;
      if (cs && !this.byCallsign.has(cs)) this.byCallsign.set(cs, i);
      const names = [...new Set([...c.names, ...(c.callsign ? [c.callsign] : []), c.id])].filter(Boolean);
      const vs: Variant[] = [];
      const seen = new Set<string>();
      for (const name of names) {
        const n = normalizeName(name);
        if (!n.compact || seen.has(n.compact + '|' + n.plus)) continue;
        seen.add(n.compact + '|' + n.plus);
        vs.push({ idx: i, n });
        push(this.byCompact, n.compact, i);
        for (const t of new Set(n.tokens)) push(this.byToken, t, i);
      }
      this.variants.push(vs);
    });
  }

  /** Best guide channel for a live channel, or null. `byNumber` compares tuner guide numbers (HDHomeRun). */
  best(live: LiveChannelIn, opts: { byNumber?: boolean } = {}): MatchResult | null {
    const r = this.rank(live, opts);
    return r[0] ?? null;
  }

  rank(live: LiveChannelIn, opts: { byNumber?: boolean } = {}): MatchResult[] {
    const g = this.channels;
    if (live.tvgId) {
      const i = this.byId.get(live.tvgId.trim().toLowerCase());
      if (i !== undefined) return [{ guideId: g[i].id, confidence: 1, method: 'id', offsetMinutes: 0 }];
    }
    if (opts.byNumber && live.number) {
      const i = this.byNumber.get(normNumber(live.number));
      if (i !== undefined) return [{ guideId: g[i].id, confidence: 0.99, method: 'number', offsetMinutes: 0 }];
    }
    for (const cand of [live.name, live.tvgId]) {
      const cs = callsignOf(cand);
      const i = cs ? this.byCallsign.get(cs) : undefined;
      if (i !== undefined) return [{ guideId: g[i].id, confidence: 0.96, method: 'callsign', offsetMinutes: 0 }];
    }
    const lvs = [live.name, live.tvgId && !/^\d+$/.test(live.tvgId) ? live.tvgId : null].filter((x): x is string => !!x).map(normalizeName).filter((n) => n.compact);
    if (!lvs.length) return [];
    // Blocking: only score guide channels sharing a compact name or a reasonably rare token.
    const cands = new Set<number>();
    for (const n of lvs) {
      for (const i of this.byCompact.get(n.compact) ?? []) cands.add(i);
      const posts = n.tokens.map((t) => this.byToken.get(t) ?? []).filter((p) => p.length);
      const rare = posts.filter((p) => p.length <= 400);
      for (const p of rare.length ? rare : posts.slice(0, 1)) for (const i of p.slice(0, 2000)) cands.add(i);
      // Joined-name variants ("bbcone" vs "bbc one") only share a compact prefix: look those up too.
      if (n.tokens.length === 1) for (const [k, list] of this.byCompact) if (k.length >= 3 && n.compact.length >= 3 && (k.startsWith(n.compact) || n.compact.startsWith(k)) && list.length < 50) for (const i of list) cands.add(i);
    }
    const scored: MatchResult[] = [];
    for (const i of cands) {
      let best: MatchResult | null = null;
      for (const lv of lvs) {
        for (const gv of this.variants[i]) {
          const sim = nameSimilarity(lv, gv.n);
          if (sim <= 0) continue;
          let conf = sim === 1 ? 0.95 : sim * 0.95;
          let offset = 0;
          if (lv.plus !== gv.n.plus) {
            if (lv.plus > 0 && gv.n.plus === 0) {
              conf *= 0.97;
              offset = lv.plus * 60;
            } else conf *= 0.5;
          }
          if (lv.country && gv.n.country && lv.country !== gv.n.country) conf *= 0.85;
          if (lv.quality === gv.n.quality) conf += 0.001; // tie-break HD ↔ HD feeds
          const r: MatchResult = { guideId: g[i].id, confidence: Math.min(conf, 0.95), method: sim === 1 ? 'name' : 'fuzzy', offsetMinutes: offset };
          if (!best || r.confidence > best.confidence) best = r;
        }
      }
      if (best) scored.push(best);
    }
    scored.sort((a, b) => b.confidence - a.confidence || (a.method === 'name' ? -1 : 1));
    // Ambiguity: a fuzzy winner with a near-tie is not trustworthy enough to auto-apply.
    if (scored.length > 1 && scored[0].method === 'fuzzy' && scored[1].confidence >= scored[0].confidence - 0.02) {
      const top = scored[0].confidence;
      for (let k = 0; k < scored.length && scored[k].confidence >= top - 0.02; k++) scored[k] = { ...scored[k], confidence: scored[k].confidence * 0.9 };
    }
    return scored.slice(0, 5).map((s) => ({ ...s, confidence: Math.round(s.confidence * 1000) / 1000 }));
  }
}

function push(m: Map<string, number[]>, k: string, v: number) {
  const a = m.get(k);
  if (!a) m.set(k, [v]);
  else if (a[a.length - 1] !== v) a.push(v);
}

const normNumber = (n: string) => String(n).trim().replace(/[-_]/g, '.').replace(/^0+(?=\d)/, '');
