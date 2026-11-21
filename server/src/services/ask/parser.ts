/**
 * "Ask": the built-in understanding of natural-language searches, in English and Romanian. Instant, offline, no model.
 * Turns "something funny under 90 minutes we haven't seen" / "comedii românești din anii 2000" into an AskFilter.
 * Also validates filters coming from a language model (strict schema) and builds the "Understood as" chips.
 */
import type { AskChip, AskFilter } from '@mediamax/shared';

/** Canonical genres (TMDB English names) and every name a library may store them under (TMDB English/Romanian, TV variants). */
export const GENRES: Record<string, string[]> = {
  Action: ['Action', 'Action & Adventure', 'Acțiune', 'Actiune', 'Acţiune', 'Acțiune și aventură'],
  Adventure: ['Adventure', 'Action & Adventure', 'Aventură', 'Aventura', 'Acțiune și aventură'],
  Animation: ['Animation', 'Animație', 'Animatie', 'Animaţie', 'Anime'],
  Comedy: ['Comedy', 'Comedie'],
  Crime: ['Crime', 'Crimă', 'Crima', 'Crimă și mister'],
  Documentary: ['Documentary', 'Documentar'],
  Drama: ['Drama', 'Dramă', 'Dramă'],
  Family: ['Family', 'Familie', 'Kids', 'Copii'],
  Fantasy: ['Fantasy', 'Sci-Fi & Fantasy', 'Fantastic', 'Fantezie', 'SF și Fantastic'],
  History: ['History', 'Istoric', 'Istorie'],
  Horror: ['Horror', 'Groază', 'Groaza'],
  Music: ['Music', 'Muzică', 'Muzica', 'Musical', 'Muzical'],
  Mystery: ['Mystery', 'Mister', 'Mistery', 'Crimă și mister'],
  Romance: ['Romance', 'Romantic', 'Dragoste'],
  'Science Fiction': ['Science Fiction', 'Sci-Fi & Fantasy', 'SF', 'Științifico-Fantastic', 'Stiintifico-Fantastic', 'Ştiinţifico-Fantastic', 'SF și Fantastic'],
  Thriller: ['Thriller'],
  War: ['War', 'War & Politics', 'Război', 'Razboi', 'Război și politică'],
  Western: ['Western'],
  Reality: ['Reality'],
};
export const GENRE_NAMES = Object.keys(GENRES);
const GENRE_LOWER = new Map(GENRE_NAMES.map((g) => [g.toLowerCase(), g]));
/** Library genre name (any language) → canonical. */
export const canonicalGenre = (g: string): string | null => {
  const l = g.trim().toLowerCase();
  if (GENRE_LOWER.has(l)) return GENRE_LOWER.get(l)!;
  for (const [c, names] of Object.entries(GENRES)) if (names.some((n) => n.toLowerCase() === l)) return c;
  return null;
};

/** Lower case, no diacritics, straight apostrophes: "Românești" → "romanesti". */
export const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[şș]/g, 's').replace(/[ţț]/g, 't').replace(/[’‘`´]/g, "'").toLowerCase();

// Mood and genre words (folded, so no diacritics) → genres. English and Romanian.
const GENRE_WORDS: [RegExp, string[]][] = [
  [/\b(funny|hilarious|comed(?:y|ies)|laugh(?:s|ing)?|lol|silly|goofy|amuzant[ae]?|amuzante|haio(?:s|asa|ase|si)|comedi(?:e|i|ile)|de ras|sa (?:rad|radem))\b/, ['Comedy']],
  [/\b(feel[- ]?good|uplifting|heart[- ]?warming|light[- ]?hearted|cheerful|optimist[ae]?|vesel[ae]?|relaxant[ae]?)\b/, ['Comedy']],
  [/\b(scary|horror|spooky|creepy|terrifying|frightening|groaza|horror(?:uri)?|infricosat\w*|de speriat|inspaimantat\w*)\b/, ['Horror']],
  [/\b(romantic|romance|romcom|rom-com|love stor(?:y|ies)|date night|romantic[ae]?|romantice|de dragoste|iubire)\b/, ['Romance']],
  [/\b(action|explosions?|shoot[- ]?em[- ]?up|martial arts|actiune|de actiune|bataie)\b/, ['Action']],
  [/\b(adventure|adventurous|quest|treasure|aventur[aai]|aventuri)\b/, ['Adventure']],
  [/\b(thrillers?|suspense|suspenseful|tense|edge of (?:my|your) seat|suspans|tensionat\w*)\b/, ['Thriller']],
  [/\b(sci[- ]?fi|science fiction|space|outer space|aliens?|robots?|futuristic|dystopian|time travel|sf|stiintifico[- ]fantastic\w*|spatiu|extraterestri?|roboti|viitor)\b/, ['Science Fiction']],
  [/\b(animated|animation|cartoons?|anime|pixar|animat[ae]?|animatie|desene animate)\b/, ['Animation']],
  [/\b(family|for kids|for the kids|for children|kid[- ]friendly|familie|de familie|pentru copii|copii)\b/, ['Family']],
  [/\b(documentar(?:y|ies)|docs?|documentar(?:e|ul)?)\b/, ['Documentary']],
  [/\b(war|wartime|ww2|wwii|world war|razboi|de razboi)\b/, ['War']],
  [/\b(westerns?|cowboys?|wild west|vestul salbatic)\b/, ['Western']],
  [/\b(myster(?:y|ies)|whodunn?it|detective|mister(?:e|ioas\w*)?|detectiv|politist[ae]?)\b/, ['Mystery']],
  [/\b(crime|criminal|gangsters?|mafia|mob|heists?|robbery|crima|crime|mafie|gangsteri|jaf|jafuri|spargere)\b/, ['Crime']],
  [/\b(fantasy|magic(?:al)?|dragons?|wizards?|fairy tale|fantezie|fantastic[ae]?|magie|dragoni|basm)\b/, ['Fantasy']],
  [/\b(musicals?|music|muzical[ae]?|muzica)\b/, ['Music']],
  [/\b(historical|history|period drama|period piece|istoric[ae]?|istorie|de epoca)\b/, ['History']],
  [/\b(dramas?|emotional|tear[- ]?jerker|sad|moving|drama|drame|trist[ae]?|emotionant\w*)\b/, ['Drama']],
];

const TYPE_MOVIE = /\b(movies?|films?|filme(?:le)?|filmul|pelicul[ae])\b/;
const TYPE_SHOW = /\b(series|tv shows?|shows?|sitcoms?|seriale?(?:le)?|serialul|emisiuni)\b/;

// "we haven't seen" / "nu l-am văzut" (folded).
const UNWATCHED = /\b(haven'?t (?:seen|watched)|have not (?:seen|watched)|not (?:yet )?(?:seen|watched)|unwatched|unseen|new to (?:me|us)|never (?:seen|watched)|didn'?t (?:see|watch)|nevazut[ea]?|nevazute|nu (?:l-|le-|o |i-)?am (?:vazut|urmarit)|n-am (?:vazut|urmarit)|nu (?:l-|le-)?am mai vazut)\b/;
const WATCHED = /\b(rewatch|watch again|seen before|already seen|again|re-?watch|din nou|deja vazut[ea]?|revazut|sa revad|vazute)\b/;
const FAVORITES = /\b(my )?(favou?rites?|favorite(?:le)?(?: mele)?|preferat(?:e|ele)(?: mele)?)\b/;
const RATED = /\b(highly rated|top rated|best|acclaimed|well reviewed|critically acclaimed|great|masterpieces?|bine cotat[ea]?|cele mai bune|foarte bun[ea]?|apreciat[ea]?|capodoper[ae])\b/;
const LIGHTER = /\b(lighter|less dark|more fun|happier|mai usor|mai lejer|mai vesel|mai amuzant)\b/;
const DARKER = /\b(darker|grittier|more serious|mai intunecat|mai serios|mai dur)\b/;

// Spoken language / country words (folded) → ISO 639-1.
const LANGUAGES: [RegExp, string, string][] = [
  [/\b(romanian|romania|romanesti|romanesc|romaneasca|romanesti|romane|romanest|in romana|autohton\w*)\b/, 'ro', 'Romanian'],
  [/\b(english|in engleza|englezesti|britanic\w*|american\w*)\b/, 'en', 'English'],
  [/\b(french|france|frantuzesti|frantuzesc|franceze?|frantuzeasc\w*)\b/, 'fr', 'French'],
  [/\b(german|germany|nemtesti|germane?)\b/, 'de', 'German'],
  [/\b(spanish|spain|spaniole?|spaniol)\b/, 'es', 'Spanish'],
  [/\b(italian|italy|italiene?|italienesti)\b/, 'it', 'Italian'],
  [/\b(korean|korea|coreene?|coreean\w*)\b/, 'ko', 'Korean'],
  [/\b(japanese|japan|japoneze?|japonez\w*)\b/, 'ja', 'Japanese'],
  [/\b(hungarian|maghiare?|unguresti)\b/, 'hu', 'Hungarian'],
  [/\b(turkish|turcesti|turcesc)\b/, 'tr', 'Turkish'],
  [/\b(russian|rusesti|rusesc)\b/, 'ru', 'Russian'],
  [/\b(indian|bollywood|hindi|indiene?)\b/, 'hi', 'Hindi'],
  [/\b(swedish|scandinavian|suedeze?)\b/, 'sv', 'Swedish'],
  [/\b(danish|daneze?)\b/, 'da', 'Danish'],
];
export const LANGUAGE_LABEL: Record<string, string> = Object.fromEntries(LANGUAGES.map(([, c, l]) => [c, l]));

const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, an: 1, a: 1, o: 1, un: 1, una: 1, doua: 2, doi: 2, trei: 3 };
const toNum = (s: string) => (NUM_WORDS[s] ?? Number(s.replace(',', '.')));

const STOP = new Set(`a an the some something anything any film films movie movies show shows series tv watch watching want wanna to for of in on with and or that this which who we i me my us our you your is are was be it its about like similar from under over less more than tonight today now please find show give get me good nice one ones kind sort type maybe really very just
but yet also though dar insa directed starring featuring regizat regia regizor
ceva un o niste film filme filmul serial seriale cu si sau de din la in pe care ce vreau sa vedem vad uitam ma noi eu mi imi pentru despre gen ca un una unul acest aceasta fie mai foarte bun bune buna ceva nou noi seara asta azi acum te rog da-mi arata cauta sub peste decat minute ore an anii anul`.split(/\s+/));

const KEEP_TOPICS = /\b(heists?|robbery|jaf|jafuri|spargere|mafia|mafie|gangsters?|aliens?|extraterestri|robots?|roboti|time travel|dragons?|dragoni|zombies?|zombi|vampires?|vampiri|space|spatiu|pirates?|pirati|dinosaurs?|dinozauri|superheroes?|supereroi|spies|spy|spion\w*|boxing|football|fotbal|christmas|craciun|halloween)\b/g;

export interface ParseResult {
  filter: AskFilter;
  /** Words left over after the structured parts were recognised (free-text keywords). */
  leftover: string[];
  /** Strong structured meaning found (genre, runtime, decade, unwatched, people, like…). */
  structured: boolean;
}

/** Built-in understanding. `now` (for "recent") is injectable for tests. */
export function parseAsk(query: string, now = new Date()): ParseResult {
  const raw = query.trim().slice(0, 300);
  const p = ` ${fold(raw).replace(/\s+/g, ' ')} `;
  const f: AskFilter = {};
  let rest = p;
  const eat = (re: RegExp) => {
    rest = rest.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), ' ');
  };

  // "like Inception but lighter" / "ceva ca Inception, dar mai vesel" — the title is taken from the original text.
  const like = /\b(?:something |ceva )?(?:like|similar to|in the style of|reminds? me of|asemanator cu|similar cu|in stilul|gen|ca si|ca)\s+(.+?)(?=\s+(?:but|dar|only|doar|with|cu|from|din|under|sub|that|care|we|pe)\b|[,.;!?]|$)/i;
  const lm = like.exec(fold(raw));
  if (lm && lm[1].trim().length >= 2 && !/^(that|this|asta|ala|el|ea)$/.test(lm[1].trim())) {
    const start = lm.index + lm[0].length - lm[1].length;
    const title = raw.slice(start, start + lm[1].length).trim().replace(/^["“'‘]|["”'’]$/g, '');
    if (title && !/^(a|an|the|un|o)$/i.test(title)) {
      f.likeTitle = title.slice(0, 120);
      eat(new RegExp(lm[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  }
  if (LIGHTER.test(p)) {
    f.tone = 'lighter';
    eat(LIGHTER);
  } else if (DARKER.test(p)) {
    f.tone = 'darker';
    eat(DARKER);
  }

  // People: "with Tom Hanks", "starring …", "directed by …", "cu Tom Hanks", "regizat de …" (capitalised names only).
  const people: string[] = [];
  const pr = /\b(?:with|starring|featuring|directed by|by|cu|regizat de|in regia lui|regia)\s+((?:[A-ZĂÂÎȘȚŞŢ][\p{L}'’.-]+)(?:\s+(?:de |van |von |da |del |la )?[A-ZĂÂÎȘȚŞŢ][\p{L}'’.-]+){1,3})/gu;
  for (const m of raw.matchAll(pr)) {
    const name = m[1].trim();
    if (f.likeTitle && f.likeTitle.includes(name)) continue;
    people.push(name);
    eat(new RegExp(fold(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  if (people.length) f.people = [...new Set(people)].slice(0, 3);

  // Type.
  const movie = TYPE_MOVIE.test(p);
  const show = TYPE_SHOW.test(p);
  if (movie !== show) f.types = [movie ? 'movie' : 'show'];

  // Runtime. "under 90 minutes", "less than 2 hours", "sub 90 de minute", "mai putin de doua ore", "o ora si jumatate".
  const dur = (m: RegExpExecArray) => Math.round(toNum(m[1]) * (/^(h|hours?|hrs?|ore|ora|ceas)/.test(m[3]) ? 60 : 1) + (m[2]?.trim() || m[4]?.trim() ? 30 : 0));
  const UNIT = '(minutes?|mins?|min|m|hours?|hrs?|h|minute|ore|ora)';
  const HALF = '((?:\\s+(?:and a half|si jumatate))?)';
  const QTY = `(\\d+(?:[.,]\\d+)?|one|two|three|an|a|o|un|doua|doi|trei)${HALF}\\s*(?:de\\s+)?${UNIT}${HALF}`;
  let m: RegExpExecArray | null;
  const maxRe = new RegExp(`\\b(?:under|less than|shorter than|max(?:imum)?|at most|no more than|up to|within|sub|mai putin de|mai scurt de|maxim|cel mult|pana in|pana la)\\s+${QTY}`);
  const maxRe2 = new RegExp(`\\b${QTY}\\s+(?:or less|max|tops|or shorter|sau mai putin|maxim)\\b`);
  const minRe = new RegExp(`\\b(?:over|more than|longer than|at least|min(?:imum)?|peste|mai mult de|mai lung de|cel putin|minim)\\s+${QTY}`);
  const maxHit = maxRe.exec(p) ? maxRe : maxRe2.exec(p) ? maxRe2 : null;
  if (maxHit && (m = maxHit.exec(p))) {
    f.maxRuntimeMin = dur(m);
    eat(maxHit);
  } else if (/\b(short|quick|shorter|scurt[ae]?|scurte)\b/.test(p) && !/\bshort films?\b/.test(p)) {
    f.maxRuntimeMin = 100;
    eat(/\b(short|quick|shorter|scurt[ae]?|scurte)\b/);
  }
  if ((m = minRe.exec(p))) {
    f.minRuntimeMin = dur(m);
    eat(minRe);
  } else if (/\b(long|epic|lung[ae]?|lungi)\b/.test(p)) {
    f.minRuntimeMin = 140;
    eat(/\b(long|epic|lung[ae]?|lungi)\b/);
  }
  if (f.maxRuntimeMin != null && !f.types) f.types = ['movie'];

  // Years and decades: "2000s", "90s", "'80s", "eighties", "anii 2000", "anii '90", "from 2015", "dupa 2015", "between 1990 and 2000".
  const words: Record<string, number> = { fifties: 1950, sixties: 1960, seventies: 1970, eighties: 1980, nineties: 1990, noughties: 2000, 'two thousands': 2000 };
  let dec: number | null = null;
  for (const [w, y] of Object.entries(words)) if (new RegExp(`\\b${w}\\b`).test(p)) {
    dec = y;
    eat(new RegExp(`\\b(?:the )?${w}\\b`));
  }
  if (dec == null && (m = /\b(?:anii|din anii|in anii)\s+'?((?:19|20)?\d0)\b/.exec(p))) {
    const v = Number(m[1]);
    dec = v >= 1900 ? v : v >= 30 ? 1900 + v : 2000 + v;
    eat(/\b(?:din |in )?anii\s+'?(?:19|20)?\d0\b/);
  }
  if (dec == null && (m = /(?:^|\s)'?((?:19|20)?\d0)'?s\b/.exec(p))) {
    const v = Number(m[1]);
    dec = v >= 1900 ? v : v >= 30 ? 1900 + v : 2000 + v;
    eat(/(?:^|\s)(?:from |in |the |din )*'?(?:19|20)?\d0'?s\b/);
  }
  if (dec != null) {
    f.yearFrom = dec;
    f.yearTo = dec + 9;
  } else if ((m = /\b(?:between|from|intre|din)\s+((?:19|20)\d\d)\s+(?:and|to|-|si|pana in)\s+((?:19|20)\d\d)\b/.exec(p)) || (m = /\b((?:19|20)\d\d)\s*(?:-|–|to)\s*((?:19|20)\d\d)\b/.exec(p))) {
    f.yearFrom = Math.min(+m[1], +m[2]);
    f.yearTo = Math.max(+m[1], +m[2]);
    eat(/\b(?:between|from|intre|din)?\s*(?:19|20)\d\d\s*(?:and|to|-|–|si|pana in)\s*(?:19|20)\d\d\b/);
  } else {
    if ((m = /\b(?:since|after|from|newer than|dupa|din|incepand cu)\s+((?:19|20)\d\d)\b/.exec(p))) {
      f.yearFrom = +m[1] + (/after|dupa|newer/.test(m[0]) ? 1 : 0);
      eat(/\b(?:since|after|from|newer than|dupa|din|incepand cu)\s+(?:19|20)\d\d\b/);
    }
    if ((m = /\b(?:before|until|older than|pre|inainte de|pana in)\s+((?:19|20)\d\d)\b/.exec(p))) {
      f.yearTo = +m[1] - (/before|older|inainte|pre/.test(m[0]) ? 1 : 0);
      eat(/\b(?:before|until|older than|pre|inainte de|pana in)\s+(?:19|20)\d\d\b/);
    }
    if (f.yearFrom == null && f.yearTo == null && (m = /\b(?:in|from|din|of)\s+((?:19|20)\d\d)\b/.exec(p))) {
      f.yearFrom = f.yearTo = +m[1];
      eat(/\b(?:in|from|din|of)\s+(?:19|20)\d\d\b/);
    }
    if (f.yearFrom == null && /\b(recent|new|newest|latest|this year|recente?|noi|nou|noutati|de anul asta)\b/.test(p)) {
      f.yearFrom = now.getFullYear() - 3;
      eat(/\b(recent|new|newest|latest|this year|recente?|noi|nou|noutati|de anul asta)\b/);
    } else if (f.yearTo == null && /\b(old|classic|classics|vintage|vechi|clasic[ae]?|clasice)\b/.test(p)) {
      f.yearTo = 1985;
      eat(/\b(old|classic|classics|vintage|vechi|clasic[ae]?|clasice)\b/);
    }
  }

  // Watched state, favourites, rating.
  if (UNWATCHED.test(p)) {
    f.unwatched = true;
    eat(UNWATCHED);
  } else if (WATCHED.test(p)) {
    f.watched = true;
    eat(WATCHED);
  }
  if (FAVORITES.test(p)) {
    f.favorites = true;
    eat(FAVORITES);
  }
  if ((m = /\b(?:rated|rating|nota|notat[ae]?|scor)\s+(?:above|over|at least|peste|minim|cel putin|>)?\s*(\d(?:[.,]\d)?)\b/.exec(p)) || (m = /\b(\d(?:[.,]\d)?)\s*\+\s*(?:rating|stars?|stele)?/.exec(p))) {
    f.minRating = Math.max(0, Math.min(10, Number(m[1].replace(',', '.'))));
    eat(/\b(?:rated|rating|nota|notat[ae]?|scor)\s+(?:above|over|at least|peste|minim|cel putin|>)?\s*\d(?:[.,]\d)?\b|\b\d(?:[.,]\d)?\s*\+\s*(?:rating|stars?|stele)?/);
  } else if (RATED.test(p)) {
    f.minRating = 7;
    eat(RATED);
  }

  // Language / country.
  for (const [re, code] of LANGUAGES) if (re.test(rest)) {
    f.language = code;
    eat(re);
    break;
  }

  // Genres and moods.
  const genres = new Set<string>();
  for (const [re, gs] of GENRE_WORDS) if (re.test(rest)) {
    gs.forEach((g) => genres.add(g));
    eat(re);
  }
  if (/\b(not|no|without|fara|nu)\s+(horror|scary|groaza)\b/.test(p)) {
    genres.delete('Horror');
    f.excludeGenres = ['Horror'];
  }
  if (genres.size) f.genres = [...genres].slice(0, 4);
  if (f.tone === 'lighter') f.excludeGenres = [...new Set([...(f.excludeGenres ?? []), 'Horror'])];

  // Sorting words.
  if (/\b(newest|latest|cele mai noi)\b/.test(p)) f.sort = 'newest';
  else if (/\b(shortest|cel mai scurt|cele mai scurte)\b/.test(p)) f.sort = 'shortest';
  else if (/\b(random|surprise me|orice|la intamplare|surprinde-ma)\b/.test(p)) {
    f.sort = 'random';
    eat(/\b(random|surprise me|orice|la intamplare|surprinde-ma)\b/);
  }

  // Concrete topics stay keywords even when they also implied a genre ("heist" → Crime + "heist").
  const topics = [...p.matchAll(KEEP_TOPICS)].map((x) => x[1]);
  const leftover = [...topics, ...rest.split(/[^\p{L}\p{N}'-]+/u).map((w) => w.replace(/^'+|'+$/g, '')).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w))];
  const kw = [...new Set(leftover)].slice(0, 8);
  if (kw.length) f.keywords = kw;
  const structured = !!(f.genres || f.maxRuntimeMin || f.minRuntimeMin || f.yearFrom || f.yearTo || f.unwatched || f.watched || f.favorites || f.minRating || f.language || f.people || f.likeTitle || f.types);
  return { filter: f, leftover: kw, structured };
}

/* ------------------------------ validation ------------------------------ */

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const strList = (v: unknown, max: number, len = 80) => (Array.isArray(v) ? [...new Set(v.filter(isStr).map((s) => s.trim().slice(0, len)))].slice(0, max) : undefined);
const num = (v: unknown, lo: number, hi: number) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi ? n : undefined;
};

/**
 * Strict validation of a filter from a client or a language model: unknown keys dropped, wrong types dropped, numbers
 * range-checked, genres mapped to the canonical list (unknown genres dropped). Returns null when nothing valid is left.
 */
export function validateFilter(input: unknown): AskFilter | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const x = input as Record<string, unknown>;
  const f: AskFilter = {};
  const types = strList(x.types, 2)?.map((t) => t.toLowerCase()).map((t) => (t === 'tv' || t === 'series' || t === 'tvshow' ? 'show' : t === 'film' ? 'movie' : t)).filter((t): t is 'movie' | 'show' => t === 'movie' || t === 'show');
  if (types?.length) f.types = [...new Set(types)];
  const g = strList(x.genres, 6)?.map(canonicalGenre).filter((v): v is string => !!v);
  if (g?.length) f.genres = [...new Set(g)];
  const xg = strList(x.excludeGenres, 6)?.map(canonicalGenre).filter((v): v is string => !!v);
  if (xg?.length) f.excludeGenres = [...new Set(xg)];
  const r1 = num(x.minRuntimeMin, 1, 600);
  const r2 = num(x.maxRuntimeMin, 1, 600);
  if (r1 != null) f.minRuntimeMin = Math.round(r1);
  if (r2 != null) f.maxRuntimeMin = Math.round(r2);
  if (f.minRuntimeMin != null && f.maxRuntimeMin != null && f.minRuntimeMin > f.maxRuntimeMin) delete f.minRuntimeMin;
  const y1 = num(x.yearFrom, 1880, 2100);
  const y2 = num(x.yearTo, 1880, 2100);
  if (y1 != null) f.yearFrom = Math.round(y1);
  if (y2 != null) f.yearTo = Math.round(y2);
  if (f.yearFrom != null && f.yearTo != null && f.yearFrom > f.yearTo) [f.yearFrom, f.yearTo] = [f.yearTo, f.yearFrom];
  if (x.unwatched === true) f.unwatched = true;
  else if (x.watched === true) f.watched = true;
  if (x.favorites === true) f.favorites = true;
  const mr = num(x.minRating, 0, 10);
  if (mr != null && mr > 0) f.minRating = Math.round(mr * 10) / 10;
  if (isStr(x.language)) {
    const l = x.language.trim().toLowerCase().slice(0, 2);
    if (/^[a-z]{2}$/.test(l)) f.language = l;
  }
  const people = strList(x.people, 3, 60);
  if (people?.length) f.people = people;
  if (isStr(x.likeTitle)) f.likeTitle = x.likeTitle.trim().slice(0, 120);
  if (x.tone === 'lighter' || x.tone === 'darker') f.tone = x.tone;
  const kw = strList(x.keywords, 10, 40)?.map((k) => k.toLowerCase());
  if (kw?.length) f.keywords = kw;
  const titles = strList(x.titles, 5, 120);
  if (titles?.length) f.titles = titles;
  if (['relevance', 'rating', 'newest', 'oldest', 'shortest', 'longest', 'random'].includes(String(x.sort))) f.sort = x.sort as AskFilter['sort'];
  return Object.keys(f).length ? f : null;
}

/* -------------------------------- chips -------------------------------- */

function yearsLabel(f: AskFilter): string | null {
  const a = f.yearFrom;
  const b = f.yearTo;
  if (a == null && b == null) return null;
  if (a != null && b != null) {
    if (a === b) return String(a);
    if (a % 10 === 0 && b === a + 9) return `${a}s`;
    return `${a}–${b}`;
  }
  return a != null ? `since ${a}` : `before ${b! + 1}`;
}

const SORT_LABEL: Record<NonNullable<AskFilter['sort']>, string> = { relevance: 'Best match', rating: 'Top rated', newest: 'Newest first', oldest: 'Oldest first', shortest: 'Shortest first', longest: 'Longest first', random: 'Surprise me' };

/** "Understood as" chips, in reading order. Each key can be passed back in `remove`. */
export function chipsFor(f: AskFilter): AskChip[] {
  const c: AskChip[] = [];
  if (f.likeTitle) c.push({ key: 'likeTitle', label: `Like ${f.likeTitle}` });
  if (f.tone) c.push({ key: 'tone', label: f.tone === 'lighter' ? 'Lighter' : 'Darker' });
  if (f.types?.length === 1) c.push({ key: 'types', label: f.types[0] === 'movie' ? 'Movies' : 'TV shows' });
  for (const g of f.genres ?? []) c.push({ key: `genres:${g}`, label: g });
  for (const g of f.excludeGenres ?? []) c.push({ key: `excludeGenres:${g}`, label: `No ${g}` });
  if (f.maxRuntimeMin != null) c.push({ key: 'maxRuntimeMin', label: `≤ ${f.maxRuntimeMin} min` });
  if (f.minRuntimeMin != null) c.push({ key: 'minRuntimeMin', label: `≥ ${f.minRuntimeMin} min` });
  const y = yearsLabel(f);
  if (y) c.push({ key: 'years', label: y });
  if (f.language) c.push({ key: 'language', label: LANGUAGE_LABEL[f.language] ?? f.language.toUpperCase() });
  for (const p of f.people ?? []) c.push({ key: `people:${p}`, label: p });
  if (f.unwatched) c.push({ key: 'unwatched', label: 'Unwatched' });
  if (f.watched) c.push({ key: 'watched', label: 'Watched' });
  if (f.favorites) c.push({ key: 'favorites', label: 'Favourites' });
  if (f.minRating != null) c.push({ key: 'minRating', label: `★ ${f.minRating}+` });
  for (const k of f.keywords ?? []) c.push({ key: `keywords:${k}`, label: `“${k}”` });
  if (f.sort && f.sort !== 'relevance') c.push({ key: 'sort', label: SORT_LABEL[f.sort] });
  return c;
}

/** Drop what the removed chips stand for. */
export function removeChips(f: AskFilter, keys: string[]): AskFilter {
  const out: AskFilter = JSON.parse(JSON.stringify(f));
  for (const key of keys) {
    const [k, v] = key.split(/:(.*)/s);
    if (k === 'years') {
      delete out.yearFrom;
      delete out.yearTo;
    } else if (v !== undefined && ['genres', 'excludeGenres', 'people', 'keywords'].includes(k)) {
      const list = (out as Record<string, string[] | undefined>)[k]?.filter((x) => x !== v);
      if (list?.length) (out as Record<string, unknown>)[k] = list;
      else delete (out as Record<string, unknown>)[k];
    } else if (k in out) {
      delete (out as Record<string, unknown>)[k];
      if (k === 'likeTitle') delete out.tone;
    }
  }
  return out;
}
