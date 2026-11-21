/**
 * "Ask" natural-language search: understanding (built-in parser, optionally the language model) → one indexed SQL
 * query over the viewer's own libraries (library access and parental ratings always apply) → ranking by keyword hits,
 * semantic similarity (optional embeddings), "like <title>" closeness and rating.
 */
import type { AskFilter, AskRequest, AskResponse, User } from '@mediamax/shared';
import { db, type Param } from '../../db.js';
import { accessClause, itemsByIds } from '../items.js';
import { extractJson, llmAvailable, llmChat } from '../ai/llm.js';
import { logger } from '../../util/log.js';
import { canonicalGenre, chipsFor, fold, GENRE_NAMES, GENRES, parseAsk, removeChips, validateFilter } from './parser.js';
import { currentModelId, embeddingsEnabled, embedTexts } from './embed.js';
import { itemVector, searchVectors, vectorCount } from './vectors.js';

const log = logger('ask');

/* ------------------------------ language model ------------------------------ */

const LLM_SYSTEM = `You turn a request for something to watch into a JSON search filter for a home media library (movies and TV shows).
The request may be in English or Romanian. Reply with ONE JSON object only, no prose. Allowed keys (omit what does not apply):
 "types": array of "movie" and/or "show",
 "genres": array chosen ONLY from ${JSON.stringify(GENRE_NAMES)},
 "excludeGenres": array from the same list,
 "minRuntimeMin", "maxRuntimeMin": integers (minutes),
 "yearFrom", "yearTo": integers,
 "unwatched": true when they want something they have not seen; "watched": true for a rewatch,
 "favorites": true for their favourites,
 "minRating": number 0-10 for "good"/"highly rated" (use 7),
 "language": ISO 639-1 code of the spoken language/country of origin (e.g. "ro" for Romanian films),
 "people": array of actor or director names they named,
 "likeTitle": a title they want something similar to,
 "tone": "lighter" or "darker",
 "keywords": up to 8 short ENGLISH words about plot, setting, objects or themes (translate Romanian words),
 "titles": up to 3 exact titles you believe they are describing, only when they describe a specific film or show,
 "sort": one of "relevance","rating","newest","oldest","shortest","longest","random".`;

const llmCache = new Map<string, { at: number; filter: AskFilter | null }>();

/** The language model's reading of the query, validated against the strict schema; null when unavailable/invalid. */
export async function llmFilter(q: string, chat: (s: string, u: string) => Promise<string | null> = (s, u) => llmChat(s, u, { feature: 'ask', json: true, temperature: 0.1, maxTokens: 300, timeoutMs: 8000 })): Promise<AskFilter | null> {
  const key = fold(q).replace(/\s+/g, ' ').trim();
  const hit = llmCache.get(key);
  if (hit && Date.now() - hit.at < 86400_000) return hit.filter;
  const reply = await chat(LLM_SYSTEM, q.slice(0, 300));
  if (reply == null) return null; // not cached: a later call may succeed
  const filter = validateFilter(extractJson(reply));
  if (llmCache.size > 500) llmCache.delete(llmCache.keys().next().value!);
  llmCache.set(key, { at: Date.now(), filter });
  return filter;
}
export const clearAskCache = () => llmCache.clear();

/* ------------------------------ keywords ------------------------------ */

// Concept groups (folded, English + Romanian): a keyword also matches its group, so "jaf" finds an English "heist" plot.
const GROUPS: string[][] = [
  ['heist', 'heists', 'robbery', 'robbers', 'rob', 'thief', 'thieves', 'steal', 'stealing', 'vault', 'jaf', 'jafuri', 'spargere', 'hoti', 'hot'],
  ['space', 'astronaut', 'astronauts', 'planet', 'galaxy', 'spaceship', 'spatiu', 'cosmos', 'nava spatiala'],
  ['alien', 'aliens', 'extraterrestrial', 'extraterestri', 'extraterestru'],
  ['zombie', 'zombies', 'undead', 'zombi'],
  ['vampire', 'vampires', 'vampir', 'vampiri'],
  ['christmas', 'santa', 'holiday', 'craciun', 'mos craciun'],
  ['nature', 'wildlife', 'animals', 'natura', 'animale', 'salbatic'],
  ['love', 'romance', 'dragoste', 'iubire'],
  ['friendship', 'friends', 'prietenie', 'prieteni'],
  ['war', 'soldier', 'soldiers', 'razboi', 'soldat', 'soldati'],
  ['dog', 'dogs', 'puppy', 'caine', 'caini', 'catel'],
  ['cat', 'cats', 'pisica', 'pisici'],
  ['ocean', 'sea', 'mare', 'ocean', 'submarine'],
  ['school', 'high school', 'college', 'scoala', 'liceu', 'facultate'],
  ['wedding', 'marriage', 'nunta', 'casatorie'],
  ['prison', 'jail', 'inmate', 'inchisoare', 'puscarie'],
  ['murder', 'killer', 'serial killer', 'crima', 'ucigas'],
  ['police', 'cop', 'cops', 'detective', 'politie', 'politist', 'detectiv'],
  ['dinosaur', 'dinosaurs', 'dinozaur', 'dinozauri'],
  ['shark', 'sharks', 'rechin', 'rechini'],
  ['robot', 'robots', 'android', 'artificial intelligence', 'robot', 'roboti'],
  ['time travel', 'time machine', 'calatorie in timp'],
  ['football', 'soccer', 'fotbal'],
  ['boxing', 'boxer', 'box', 'boxeur'],
  ['witch', 'witches', 'vrajitoare', 'vrajitoare'],
  ['pirate', 'pirates', 'pirat', 'pirati'],
  ['spy', 'spies', 'agent', 'espionage', 'spion', 'spioni', 'spionaj'],
  ['superhero', 'superheroes', 'supererou', 'supereroi'],
  ['mafia', 'mob', 'gangster', 'gangsters', 'mafie'],
  ['car', 'cars', 'racing', 'masina', 'masini', 'curse'],
  ['communism', 'communist', 'ceausescu', 'comunism', 'comunist', 'revolutie', 'revolution'],
];
const GROUP_OF = new Map<string, string[]>();
for (const g of GROUPS) for (const w of g) GROUP_OF.set(w, [...new Set([...(GROUP_OF.get(w) ?? []), ...g])]);

/** A keyword and its concept group, folded. */
export const expandKeyword = (k: string) => {
  const f = fold(k);
  return GROUP_OF.get(f) ?? GROUP_OF.get(f.replace(/s$/, '')) ?? [f];
};

const escLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/* ------------------------------ SQL ------------------------------ */

const LANG_CODES: Record<string, string[]> = { ro: ['ro', 'rum', 'ron', 'mol'], en: ['en', 'eng'], fr: ['fr', 'fre', 'fra'], de: ['de', 'ger', 'deu'], es: ['es', 'spa'], it: ['it', 'ita'], ko: ['ko', 'kor'], ja: ['ja', 'jpn'], hu: ['hu', 'hun'], tr: ['tr', 'tur'], ru: ['ru', 'rus'], hi: ['hi', 'hin'], sv: ['sv', 'swe'], da: ['da', 'dan'], pt: ['pt', 'por'], nl: ['nl', 'dut', 'nld'], pl: ['pl', 'pol'], zh: ['zh', 'chi', 'zho'] };

/** Runtime: the item's own, else its longest file (the subquery only runs when the item has none). */
const RT = '(COALESCE(i.duration_ms, (SELECT MAX(m.duration_ms) FROM media m WHERE m.item_id = i.id)))';

interface Candidate { id: string; type: string; title: string; original_title: string | null; overview: string | null; tagline: string | null; genres: string; year: number | null; rating: number | null; rt: number | null }

function buildWhere(user: User, f: AskFilter, kwRequired: { words: string[]; semIds: string[] } | null): { sql: string; params: Param[] } {
  const a = accessClause(user, 'i');
  const where: string[] = [a.sql];
  const params: Param[] = [...a.params];
  const types = f.types?.length ? f.types : ['movie', 'show'];
  where.push(`i.type IN (${types.map(() => '?').join(',')})`);
  params.push(...types);
  where.push('COALESCE(ud.not_interested, 0) = 0');
  const genreSql = (g: string) => {
    const names = (GENRES[g] ?? [g]).map((n) => n.toLowerCase());
    params.push(...names);
    return `EXISTS (SELECT 1 FROM json_each(i.genres) jg WHERE LOWER(jg.value) IN (${names.map(() => '?').join(',')}))`;
  };
  for (const g of f.genres ?? []) where.push(genreSql(g));
  for (const g of f.excludeGenres ?? []) where.push(`NOT ${genreSql(g)}`);
  if (f.maxRuntimeMin != null) {
    where.push(`${RT} > 0 AND ${RT} <= ?`);
    params.push(f.maxRuntimeMin * 60000);
  }
  if (f.minRuntimeMin != null) {
    where.push(`${RT} >= ?`);
    params.push(f.minRuntimeMin * 60000);
  }
  if (f.yearFrom != null) {
    where.push('i.year >= ?');
    params.push(f.yearFrom);
  }
  if (f.yearTo != null) {
    where.push('i.year <= ?');
    params.push(f.yearTo);
  }
  const showSeen = `EXISTS (SELECT 1 FROM items e JOIN user_data eu ON eu.item_id = e.id AND eu.user_id = ? WHERE e.grandparent_id = i.id AND e.type = 'episode' AND eu.played = 1)`;
  if (f.unwatched) {
    where.push(`((i.type = 'movie' AND COALESCE(ud.played, 0) = 0) OR (i.type = 'show' AND NOT ${showSeen}))`);
    params.push(user.id);
  } else if (f.watched) {
    where.push(`((i.type = 'movie' AND COALESCE(ud.played, 0) = 1) OR (i.type = 'show' AND ${showSeen}))`);
    params.push(user.id);
  }
  if (f.favorites) where.push('COALESCE(ud.favorite, 0) = 1');
  if (f.minRating != null) {
    where.push('i.community_rating >= ?');
    params.push(f.minRating);
  }
  if (f.language) {
    const codes = LANG_CODES[f.language] ?? [f.language];
    const ph = codes.map(() => '?').join(',');
    // The first audio track is the original one in practically every release; shows look at one of their episodes.
    where.push(`(EXISTS (SELECT 1 FROM media m WHERE m.item_id = i.id AND LOWER(json_extract(m.audio, '$[0].language')) IN (${ph}))
      OR (i.type = 'show' AND EXISTS (SELECT 1 FROM items e JOIN media m ON m.item_id = e.id WHERE e.grandparent_id = i.id AND LOWER(json_extract(m.audio, '$[0].language')) IN (${ph}))))`);
    params.push(...codes, ...codes);
  }
  for (const p of f.people ?? []) {
    where.push(`EXISTS (SELECT 1 FROM json_each(i.people) jp WHERE json_extract(jp.value, '$.name') LIKE ? ESCAPE '\\')`);
    params.push(`%${escLike(p)}%`);
  }
  if (kwRequired) {
    const ors: string[] = [];
    for (const w of kwRequired.words) {
      ors.push(`i.title LIKE ? ESCAPE '\\' OR i.overview LIKE ? ESCAPE '\\' OR i.tagline LIKE ? ESCAPE '\\' OR i.original_title LIKE ? ESCAPE '\\'`);
      const like = `%${escLike(w)}%`;
      params.push(like, like, like, like);
    }
    if (kwRequired.semIds.length) {
      ors.push(`i.id IN (${kwRequired.semIds.map(() => '?').join(',')})`);
      params.push(...kwRequired.semIds);
    }
    where.push(ors.length ? `(${ors.join(' OR ')})` : '0');
  }
  return { sql: where.join(' AND '), params };
}

function candidates(user: User, f: AskFilter, kwRequired: { words: string[]; semIds: string[] } | null, cap = 4000): Candidate[] {
  const w = buildWhere(user, f, kwRequired);
  return db.all<Candidate>(
    `SELECT i.id, i.type, i.title, i.original_title, i.overview, i.tagline, i.genres, i.year, i.community_rating rating, ${RT} rt
     FROM items i LEFT JOIN user_data ud ON ud.item_id = i.id AND ud.user_id = ?
     WHERE ${w.sql} ORDER BY COALESCE(i.community_rating, 0) DESC LIMIT ${cap}`,
    user.id, ...w.params);
}

/* ------------------------------ ranking ------------------------------ */

const LIGHT = new Set(['Comedy', 'Family', 'Animation', 'Adventure', 'Romance', 'Music']);
const DARK = new Set(['Horror', 'Thriller', 'War', 'Crime']);
const canonGenres = (json: string) => {
  try {
    return [...new Set((JSON.parse(json || '[]') as string[]).map(canonicalGenre).filter((g): g is string => !!g))];
  } catch {
    return [];
  }
};

/** Find the "like <title>" item in the viewer's libraries (exact title first, then prefix, then contains). */
export function findLikeItem(user: User, title: string): { id: string; title: string; genres: string } | null {
  const a = accessClause(user, 'i');
  const t = title.trim();
  if (!t) return null;
  return db.get<{ id: string; title: string; genres: string }>(
    `SELECT i.id, i.title, i.genres FROM items i WHERE ${a.sql} AND i.type IN ('movie','show') AND (i.title LIKE ? ESCAPE '\\' OR i.original_title LIKE ? ESCAPE '\\')
     ORDER BY CASE WHEN LOWER(i.title) = LOWER(?) THEN 0 WHEN i.title LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END, COALESCE(i.community_rating, 0) DESC LIMIT 1`,
    ...a.params, `%${escLike(t)}%`, `%${escLike(t)}%`, t, `${escLike(t)}%`) ?? null;
}

export interface AskOptions {
  /** Inject a model for tests. */
  chat?: (s: string, u: string) => Promise<string | null>;
  /** Inject an embedder for tests. */
  embed?: (texts: string[]) => Promise<Float32Array[] | null>;
}

export async function ask(user: User, req: AskRequest, opts: AskOptions = {}): Promise<AskResponse> {
  const t0 = performance.now();
  const q = String(req.q ?? '').trim().slice(0, 300);
  const limit = Math.max(1, Math.min(100, Math.round(Number(req.limit) || 40)));
  let filter: AskFilter;
  let by: AskResponse['by'] = 'rules';
  if (req.filter) {
    filter = validateFilter(req.filter) ?? {};
  } else {
    const rules = parseAsk(q);
    filter = rules.filter;
    // The model is only asked when the rules left something unexplained (keeps p95 low and saves the daily budget).
    const needModel = !!rules.leftover.length || !rules.structured;
    if (needModel && (opts.chat || llmAvailable('ask'))) {
      const m = await llmFilter(q, opts.chat);
      if (m) {
        filter = { ...rules.filter, ...m };
        by = 'llm';
      }
    }
  }
  if (req.remove?.length) filter = removeChips(filter, req.remove.map(String).slice(0, 20));

  const like = filter.likeTitle ? findLikeItem(user, filter.likeTitle) : null;
  const likeGenres = like ? canonGenres(like.genres) : [];
  const kwGroups = (filter.keywords ?? []).map(expandKeyword);
  const allWords = [...new Set(kwGroups.flat())].slice(0, 40);
  const titleGuesses = (filter.titles ?? []).map(fold);

  // Semantic similarity (when built): to the "like" title's own vector, else to the query text.
  let sem = new Map<string, number>();
  const model = currentModelId();
  const semanticOn = (embeddingsEnabled() || !!opts.embed) && !!model && vectorCount(model) > 0;
  if (semanticOn && (like || allWords.length || !Object.keys(filter).length)) {
    try {
      let qv = like ? itemVector(like.id, model!) : null;
      if (!qv) {
        const text = like ? like.title : [q, ...(filter.keywords ?? [])].join(' ');
        qv = (await Promise.race([(opts.embed ?? embedTexts)([text]), new Promise<null>((r) => setTimeout(() => r(null), 1500))]))?.[0] ?? null;
      }
      if (qv) sem = await searchVectors(model!, qv, 300);
    } catch (e) {
      log.debug(`Semantic search skipped: ${(e as Error).message}`);
    }
  }

  // With nothing structured to filter on, keywords (or semantic neighbours / title guesses) decide what qualifies.
  const structured = !!(filter.genres?.length || filter.excludeGenres?.length || filter.maxRuntimeMin || filter.minRuntimeMin || filter.yearFrom || filter.yearTo || filter.unwatched || filter.watched || filter.favorites || filter.minRating || filter.language || filter.people?.length || filter.types?.length || like);
  const needKw = !structured && (allWords.length > 0 || titleGuesses.length > 0);
  const kwRequired = needKw ? { words: [...allWords, ...(filter.titles ?? [])].slice(0, 40), semIds: [...sem.keys()].slice(0, 300) } : null;
  const rows = candidates(user, filter, kwRequired);

  const scored = rows.filter((r) => r.id !== like?.id).map((r) => {
    const title = fold(`${r.title} ${r.original_title ?? ''}`);
    const body = fold(`${r.tagline ?? ''} ${r.overview ?? ''}`);
    let s = 0;
    for (const group of kwGroups) {
      if (group.some((w) => title.includes(w))) s += 2;
      else if (group.some((w) => body.includes(w))) s += 1.2;
    }
    for (const g of titleGuesses) if (g && (title.includes(g) || g.includes(fold(r.title)))) s += 10;
    const sim = sem.get(r.id);
    if (sim != null) s += Math.max(0, sim) * 6;
    if (like) {
      const gs = canonGenres(r.genres);
      s += gs.filter((g) => likeGenres.includes(g)).length * 1.2;
      if (filter.tone) for (const g of gs) s += (filter.tone === 'lighter' ? 1 : -1) * (LIGHT.has(g) ? 1 : DARK.has(g) ? -1.5 : 0);
    }
    s += ((r.rating ?? 6) / 10) * 0.8;
    return { r, s };
  });

  const sort = filter.sort ?? 'relevance';
  const by2: Record<string, (a: (typeof scored)[0], b: (typeof scored)[0]) => number> = {
    relevance: (a, b) => b.s - a.s,
    rating: (a, b) => (b.r.rating ?? 0) - (a.r.rating ?? 0),
    newest: (a, b) => (b.r.year ?? 0) - (a.r.year ?? 0) || b.s - a.s,
    oldest: (a, b) => (a.r.year ?? 9999) - (b.r.year ?? 9999) || b.s - a.s,
    shortest: (a, b) => (a.r.rt ?? Infinity) - (b.r.rt ?? Infinity),
    longest: (a, b) => (b.r.rt ?? 0) - (a.r.rt ?? 0),
    random: () => Math.random() - 0.5,
  };
  scored.sort(by2[sort] ?? by2.relevance);
  // itemsByIds re-applies library access and parental ratings.
  const items = itemsByIds(user, scored.slice(0, limit).map((x) => x.r.id));
  return {
    query: q, filter, chips: chipsFor(filter), items, by, semantic: sem.size > 0,
    likeItem: like ? { id: like.id, title: like.title } : null, tookMs: Math.round(performance.now() - t0),
  };
}
