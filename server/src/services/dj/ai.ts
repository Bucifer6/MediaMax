/**
 * AI DJ — everything free and self-hostable:
 *  - Natural-language mix requests: a built-in parser (no model needed), optionally upgraded by a local LLM
 *    (Ollama, or any OpenAI-compatible server such as LM Studio, llama.cpp, LocalAI or vLLM).
 *  - A radio-style host: short spoken links between tracks from varied templates, or the LLM.
 *  - Speech: Piper (open-source neural TTS) on the server, else each client's built-in voice.
 */
import type { DjEnergyCurve, DjHostLine, DjHostRequest, DjMixRequest, User } from '@mediamax/shared';
import { db } from '../../db.js';
import { speakChain } from '../ai/tts.js';
import { getSettings } from '../settings.js';
import { accessClause } from '../items.js';
import { logger } from '../../util/log.js';
import { getAnalysis } from './analysis.js';
import { extractJson, llmAvailable, llmChat as sharedChat, openaiUrl, type ChatOptions } from '../ai/llm.js';

const log = logger('ai-dj');

/* ------------------------------ LLM client ------------------------------ */

// The language model is shared by every AI feature and configured in Admin → AI (it used to live in the DJ settings).
export { openaiUrl };
export { llmUsage } from '../ai/llm.js';
/** Chat with the shared model on behalf of the DJ (null when not configured, switched off for the DJ or over budget). */
export const llmChat = (system: string, user: string, opts: Omit<ChatOptions, 'feature'> = {}) => sharedChat(system, user, { ...opts, feature: 'dj' });

/* --------------------------- prompt understanding --------------------------- */

/** Music genres in the libraries this user can see. */
export function libraryGenres(user: User): string[] {
  const acc = accessClause(user, 'i');
  const rows = db.all<{ g: string }>(
    `SELECT DISTINCT j.value g FROM items i, json_each(i.genres) j WHERE ${acc.sql} AND i.type IN ('track','album') AND j.value IS NOT NULL LIMIT 2000`, ...acc.params);
  return [...new Set(rows.map((r) => String(r.g).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

// Words people use → genres a library is likely to have.
const GENRE_SYNONYMS: Record<string, string[]> = {
  edm: ['electronic', 'dance', 'house', 'techno', 'trance', 'edm'],
  electronic: ['electronic', 'electronica', 'house', 'techno', 'idm'],
  dance: ['dance', 'house', 'disco', 'electronic', 'pop'],
  'hip hop': ['hip hop', 'hip-hop', 'rap'],
  hiphop: ['hip hop', 'hip-hop', 'rap'],
  rap: ['rap', 'hip hop', 'hip-hop'],
  rnb: ['r&b', 'rnb', 'soul'],
  'r&b': ['r&b', 'rnb', 'soul'],
  dnb: ['drum and bass', 'drum & bass', 'dnb', 'jungle'],
  'drum and bass': ['drum and bass', 'drum & bass', 'dnb'],
  rock: ['rock', 'alternative', 'indie rock', 'hard rock', 'classic rock'],
  indie: ['indie', 'indie rock', 'indie pop', 'alternative'],
  metal: ['metal', 'heavy metal', 'hard rock'],
  jazz: ['jazz', 'smooth jazz', 'bebop', 'swing'],
  classical: ['classical', 'orchestral', 'baroque', 'piano'],
  country: ['country', 'americana', 'folk'],
  folk: ['folk', 'acoustic', 'singer-songwriter', 'americana'],
  acoustic: ['acoustic', 'folk', 'singer-songwriter'],
  reggae: ['reggae', 'dancehall', 'dub', 'ska'],
  latin: ['latin', 'reggaeton', 'salsa', 'bachata'],
  pop: ['pop', 'dance pop', 'synthpop'],
  soul: ['soul', 'r&b', 'funk', 'motown'],
  funk: ['funk', 'disco', 'soul'],
  lofi: ['lo-fi', 'lofi', 'chillhop', 'chill'],
  'lo-fi': ['lo-fi', 'lofi', 'chillhop'],
  ambient: ['ambient', 'chillout', 'downtempo', 'new age'],
};

const CHILL = /\b(chill|chilled|relax(?:ing|ed)?|calm|mellow|sleep|study|studying|focus|lazy|sunday|wind(?:ing)? down|dinner|background|ambient|gentle|soft|quiet|cosy|cozy|rainy)\b/;
const PARTY = /\b(party|dance(?:floor)?|hype|banger|bangers|energetic|upbeat|pump(?:ed)?|club|rave|festival|friday night|saturday night)\b/;
const WORKOUT = /\b(workout|gym|run|running|jog|jogging|cardio|spin|training|lifting)\b/;
const BUILD = /\b(build(?:s|ing)? up|warm(?:ing)? up|start(?:s)? slow|getting going|pre-?party)\b/;
const PEAK = /\b(peak|climax|big finish)\b/;
const WAVE = /\b(ups and downs|rollercoaster|waves?)\b/;

function decadeRange(p: string): { from?: number; to?: number; label?: string } {
  const words: Record<string, number> = { fifties: 1950, sixties: 1960, seventies: 1970, eighties: 1980, nineties: 1990, noughties: 2000, 'two thousands': 2000, tens: 2010, twenties: 2020 };
  for (const [w, y] of Object.entries(words)) if (new RegExp(`\\b${w}\\b`).test(p)) return { from: y, to: y + 9, label: `${y}s` };
  let m = /\b(?:19|20)?([0-9])0'?s\b/.exec(p);
  if (m && !/\b\d0\s*(?:min|bpm)/.test(m[0])) {
    const full = /\b(19|20)[0-9]0'?s\b/.exec(p);
    const y = full ? Number(full[0].slice(0, 4)) : Number(m[1]) >= 5 ? 1900 + Number(m[1]) * 10 : 2000 + Number(m[1]) * 10;
    return { from: y, to: y + 9, label: `${y}s` };
  }
  m = /\b(?:from|since|after)\s+((?:19|20)\d\d)\b/.exec(p);
  if (m) return { from: Number(m[1]), label: `since ${m[1]}` };
  m = /\b(?:before|until|up to)\s+((?:19|20)\d\d)\b/.exec(p);
  if (m) return { to: Number(m[1]), label: `before ${m[1]}` };
  m = /\b((?:19|20)\d\d)\s*(?:-|to|–)\s*((?:19|20)\d\d)\b/.exec(p);
  if (m) return { from: Number(m[1]), to: Number(m[2]), label: `${m[1]}–${m[2]}` };
  return {};
}

export interface ParsedPrompt {
  request: DjMixRequest;
  continuous: boolean;
  summary: string;
  by: 'llm' | 'rules';
  /** Name the listener asked to start from / sound like, if any. */
  seedName?: string;
}

/** Rules-only understanding of a mix request. Free, instant and works offline. */
export function parsePromptRules(prompt: string, genres: string[]): ParsedPrompt {
  const p = ` ${prompt.toLowerCase().replace(/[’']/g, "'")} `;
  const req: DjMixRequest = { prompt };
  const bits: string[] = [];
  // Genres: library genres mentioned directly, then common synonyms.
  const lib = genres.map((g) => ({ g, l: g.toLowerCase() }));
  const hit = new Set<string>();
  for (const { g, l } of lib) if (new RegExp(`(^|[^a-z])${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(p)) hit.add(g);
  for (const [word, targets] of Object.entries(GENRE_SYNONYMS)) {
    if (!new RegExp(`\\b${word.replace(/[&]/g, '\\$&')}\\b`).test(p)) continue;
    for (const { g, l } of lib) if (targets.some((t) => l === t || l.includes(t))) hit.add(g);
  }
  if (hit.size) {
    req.genres = [...hit].slice(0, 12);
    bits.push(req.genres.slice(0, 3).join(', ') + (req.genres.length > 3 ? '…' : ''));
  }
  const dec = decadeRange(p);
  if (dec.from) req.yearFrom = dec.from;
  if (dec.to) req.yearTo = dec.to;
  if (dec.label) bits.push(dec.label);
  // Mood → energy curve and tempo.
  let curve: DjEnergyCurve = 'steady';
  if (WORKOUT.test(p)) {
    curve = 'build';
    req.bpmMin = 118;
    bits.push('workout');
  } else if (PARTY.test(p)) {
    curve = 'peak';
    bits.push('party');
  } else if (CHILL.test(p)) {
    curve = 'chill';
    bits.push('chill');
  }
  if (BUILD.test(p)) curve = 'build';
  else if (PEAK.test(p)) curve = 'peak';
  else if (WAVE.test(p)) curve = 'wave';
  req.curve = curve;
  // Tempo words and explicit BPM.
  let m = /\b(\d{2,3})\s*(?:-|to|–)\s*(\d{2,3})\s*bpm\b/.exec(p);
  if (m) {
    req.bpmMin = Number(m[1]);
    req.bpmMax = Number(m[2]);
  } else if ((m = /\b(\d{2,3})\s*bpm\b/.exec(p))) {
    req.bpmMin = Number(m[1]) - 4;
    req.bpmMax = Number(m[1]) + 4;
  } else if (/\b(fast|quick|uptempo|up-tempo|high tempo)\b/.test(p)) req.bpmMin = Math.max(req.bpmMin ?? 0, 124);
  else if (/\b(slow|slower|downtempo|low tempo)\b/.test(p)) req.bpmMax = 100;
  if (req.bpmMin || req.bpmMax) bits.push(`${req.bpmMin ?? ''}${req.bpmMin && req.bpmMax ? '–' : req.bpmMin ? '+' : '≤'}${req.bpmMax ?? ''} BPM`);
  // Length.
  let continuous = /\b(all night|non-?stop|endless|forever|keep (?:it )?going|radio)\b/.test(p);
  if ((m = /\b(\d+(?:\.\d+)?)\s*(hours?|hrs?|h)\b/.exec(p))) req.durationMin = Math.round(Number(m[1]) * 60);
  else if ((m = /\b(\d+)\s*(?:minutes?|mins?)\b(?!\s*(?:long|or less|max))/.exec(p)) && !/(?:over|longer than|under|shorter than|max)\s*\d+\s*min/.test(p)) req.durationMin = Number(m[1]);
  else if (/\b(an|one) hour\b/.test(p)) req.durationMin = 60;
  else if (/\bhalf an hour\b/.test(p)) req.durationMin = 30;
  if (req.durationMin) {
    continuous = false;
    bits.push(`${req.durationMin} min`);
  } else if (continuous) bits.push('non-stop');
  if ((m = /\b(?:nothing|no songs?|no tracks?)\s+(?:over|longer than|above)\s+(\d+)\s*min/.exec(p)) || (m = /\b(?:under|shorter than|max(?:imum)?)\s+(\d+)\s*min(?:ute)?s?\s*(?:each|long|per)/.exec(p))) {
    req.maxTrackMinutes = Number(m[1]);
    bits.push(`≤${m[1]} min tracks`);
  } else if (/\bshort (?:songs|tracks)\b/.test(p)) req.maxTrackMinutes = 4;
  if (/\b(no|without) (?:key|harmonic)/.test(p)) req.harmonic = false;
  if (/\b(my )?favou?rites?\b|\bstuff i love\b/.test(p)) {
    req.preferFavorites = true;
    bits.push('favourites');
  }
  // "like Daft Punk", "similar to …", "starting with …", "start with …"
  const seed = /\b(?:like|similar to|sounds? like|in the style of|starting with|start(?:ing)? (?:off )?with|kick off with)\s+([^,.;!?]+?)(?:\s+(?:but|and|for|from|with|in|at)\b|[,.;!?]|$)/.exec(prompt);
  const seedName = seed?.[1]?.trim().replace(/^(?:the music of|some)\s+/i, '');
  if (seedName) bits.push(`like ${seedName}`);
  if (curve !== 'steady' && !bits.some((b) => ['chill', 'party', 'workout'].includes(b))) bits.push(curve);
  return { request: req, continuous, summary: bits.join(' · ') || 'A mix from your library', by: 'rules', seedName };
}

const PARSE_SYSTEM = `You turn a listener's request into settings for an automatic DJ mix. Reply with ONE JSON object only, no prose.
Keys (all optional):
 "genres": array of genre names chosen ONLY from the provided list (empty if none fit),
 "yearFrom", "yearTo": integers,
 "curve": one of "steady","build","peak","wave","chill",
 "bpmMin", "bpmMax": integers (50-200),
 "durationMin": integer minutes (omit for non-stop),
 "continuous": boolean (true for "all night", "non-stop", radio),
 "maxTrackMinutes": integer,
 "seed": an artist, album or song name the mix should start from or sound like,
 "preferFavorites": boolean,
 "summary": a short label like "Chilled 90s house · 1 hour".`;

/** Understand a mix prompt: the local LLM when configured (validated and merged with the rules), else rules. */
export async function parsePrompt(user: User, prompt: string): Promise<ParsedPrompt> {
  const genres = libraryGenres(user);
  const rules = parsePromptRules(prompt, genres);
  const reply = await llmChat(PARSE_SYSTEM, `Available genres: ${JSON.stringify(genres.slice(0, 200))}\nRequest: ${prompt.slice(0, 500)}`, { json: true, temperature: 0.2, maxTokens: 250 });
  const j = reply ? extractJson(reply) : null;
  if (!j) return rules;
  const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : undefined);
  const lower = new Map(genres.map((g) => [g.toLowerCase(), g]));
  const req: DjMixRequest = { prompt };
  const gs = Array.isArray(j.genres) ? (j.genres as unknown[]).map((g) => lower.get(String(g).toLowerCase())).filter((g): g is string => !!g) : [];
  if (gs.length) req.genres = [...new Set(gs)].slice(0, 12);
  req.yearFrom = num(j.yearFrom, 1900, 2100);
  req.yearTo = num(j.yearTo, 1900, 2100);
  req.bpmMin = num(j.bpmMin, 50, 220);
  req.bpmMax = num(j.bpmMax, 50, 220);
  req.durationMin = num(j.durationMin, 5, 600);
  req.maxTrackMinutes = num(j.maxTrackMinutes, 1, 60);
  if (['steady', 'build', 'peak', 'wave', 'chill'].includes(String(j.curve))) req.curve = j.curve as DjEnergyCurve;
  if (j.preferFavorites === true) req.preferFavorites = true;
  // Anything the model left out falls back to what the rules found.
  const merged: DjMixRequest = { ...rules.request, ...Object.fromEntries(Object.entries(req).filter(([, v]) => v !== undefined)) };
  const summary = typeof j.summary === 'string' && j.summary.length <= 120 ? j.summary : rules.summary;
  const seedName = typeof j.seed === 'string' && j.seed.trim() ? j.seed.trim().slice(0, 100) : rules.seedName;
  return { request: merged, continuous: j.continuous === true || (!merged.durationMin && rules.continuous), summary, by: 'llm', seedName };
}

/** Find a library item (artist, album or track) by name for "like X" / "start with X". */
export function findSeed(user: User, name: string): string | null {
  const acc = accessClause(user, 'i');
  const q = name.trim().toLowerCase();
  if (!q) return null;
  const row = db.get<{ id: string }>(
    `SELECT i.id FROM items i WHERE ${acc.sql} AND i.type IN ('artist','album','track') AND (LOWER(i.title) = ? OR LOWER(i.title) LIKE ?)
     ORDER BY CASE i.type WHEN 'artist' THEN 0 WHEN 'album' THEN 1 ELSE 2 END, CASE WHEN LOWER(i.title) = ? THEN 0 ELSE 1 END, LENGTH(i.title) LIMIT 1`,
    ...acc.params, q, `%${q}%`, q);
  return row?.id ?? null;
}

/* ------------------------------- the host ------------------------------- */

const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];

interface TrackFacts { title: string; artist: string | null; album: string | null; year: number | null; bpm: number | null; key: string | null; energy: number | null; plays: number; favorite: boolean }

function facts(user: User, id: string | undefined): TrackFacts | null {
  if (!id) return null;
  const acc = accessClause(user, 'i');
  const r = db.get(
    `SELECT i.title, i.year, ar.title artist, al.title album, al.year album_year, ud.play_count, ud.favorite FROM items i
     LEFT JOIN items al ON al.id = i.parent_id LEFT JOIN items ar ON ar.id = i.grandparent_id
     LEFT JOIN user_data ud ON ud.item_id = i.id AND ud.user_id = ? WHERE i.id = ? AND ${acc.sql}`, user.id, id, ...acc.params);
  if (!r) return null;
  const a = getAnalysis(id);
  return { title: r.title, artist: r.artist ?? null, album: r.album ?? null, year: r.year ?? r.album_year ?? null, bpm: a?.bpm ? Math.round(a.bpm) : null, key: a?.key ?? null, energy: a?.energy ?? null, plays: r.play_count ?? 0, favorite: !!r.favorite };
}

function templateLine(host: string, prev: TrackFacts | null, next: TrackFacts, req: DjHostRequest): string {
  const by = (t: TrackFacts) => (t.artist ? `${t.title} by ${t.artist}` : t.title);
  const hour = req.hour ?? new Date().getHours();
  const greeting = hour < 5 ? 'Late-night crew' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  if (!prev) {
    return pick([
      `${greeting}! ${host} here, and I've got a mix lined up for you. Let's start with ${by(next)}.`,
      `${greeting}, this is ${host}. ${req.prompt ? 'You asked, I listened. ' : ''}Kicking things off with ${by(next)}.`,
      `Hey, it's ${host}. Settle in — first up, ${by(next)}.`,
    ]);
  }
  const lines: string[] = [];
  lines.push(pick([`That was ${by(prev)}.`, `You just heard ${by(prev)}.`, `${by(prev)}, lovely.`, `Nice one from ${prev.artist ?? 'that last track'}.`]));
  const extras: string[] = [];
  if (next.favorite) extras.push(pick(['Here\'s one of your favourites.', 'I know you love this one.']));
  else if (next.plays >= 10) extras.push(`You've played this one ${next.plays} times — you clearly have taste.`);
  else if (next.plays === 0) extras.push(pick(['Here\'s something you haven\'t played yet.', 'Something new for you now.']));
  if (prev.energy != null && next.energy != null) {
    if (next.energy - prev.energy > 0.08) extras.push(pick(['Let\'s turn it up a notch.', 'Picking up the pace.', 'Time to lift the energy.']));
    else if (prev.energy - next.energy > 0.08) extras.push(pick(['Bringing it down a little.', 'Easing off for a moment.', 'Something smoother now.']));
  }
  if (next.year && prev.year && Math.abs(next.year - prev.year) >= 15) extras.push(`Jumping ${next.year > prev.year ? 'forward' : 'back'} to ${next.year}.`);
  else if (next.year && next.year < 2000 && Math.random() < 0.3) extras.push(`A bit of ${Math.floor(next.year / 10) * 10}s magic.`);
  if (extras.length) lines.push(pick(extras));
  lines.push(pick([`Here's ${by(next)}.`, `Coming up: ${by(next)}.`, `Next, ${by(next)}.`, `This is ${by(next)}.`]));
  if (req.position > 0 && req.position % 8 === 0) lines.push(pick([`You're listening to ${host} on Vibe.`, `${host} on Vibe — stay with me.`]));
  return lines.join(' ');
}

const HOST_SYSTEM = (host: string) => `You are ${host}, a warm, upbeat radio DJ hosting a personal music mix for one listener.
Write what you say between two songs: 1–2 short sentences, at most 35 words, natural spoken English, no emojis, no hashtags, no stage directions.
If "opening" is true, greet the listener and introduce the first song (there is no previous song). Mention the songs by name. Use ONLY the facts provided — never invent chart positions, dates, trivia or quotes. Don't repeat the same opener every time.`;

/** A short spoken link between tracks (or the opening line). */
export async function hostLine(user: User, req: DjHostRequest): Promise<DjHostLine> {
  const cfg = getSettings().aiDj;
  const next = facts(user, req.nextItemId);
  if (!next) return { text: '', audioUrl: null, durationMs: null, by: 'template' };
  const prev = facts(user, req.previousItemId);
  let text = '';
  let by: DjHostLine['by'] = 'template';
  if (llmAvailable('dj')) {
    const hour = req.hour ?? new Date().getHours();
    const ctx = { opening: !prev, listenerRequest: req.prompt ?? null, localHour: hour, tracksPlayedSoFar: req.position, previous: prev, next };
    const reply = await llmChat(HOST_SYSTEM(cfg.hostName), JSON.stringify(ctx), { temperature: 0.9, maxTokens: 90 });
    // Keep it short and plain; models occasionally wrap in quotes or add a speaker label.
    const clean = reply?.replace(/^["'“]|["'”]$/g, '').replace(new RegExp(`^${cfg.hostName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*`, 'i'), '').replace(/[*_#`]/g, '').trim();
    if (clean && clean.length >= 8 && clean.length <= 320) {
      text = clean;
      by = 'llm';
    }
  }
  if (!text) text = templateLine(cfg.hostName, prev, next, req);
  const voice = await speak(text);
  return { text, audioUrl: voice ? `/api/v1/dj/voice/${voice.file}` : null, durationMs: voice?.durationMs ?? null, by };
}

/* ------------------------------- speech ------------------------------- */

// Speech goes through the TTS provider chain (Admin → AI); null = the apps speak with the device's voice.
export { serverVoiceConfigured, voiceFile, pruneVoices } from '../ai/tts.js';
/** Render `text` with the first working server voice (cached). Null when the apps should speak it themselves. */
export const speak = (text: string) => speakChain(text, { feature: 'dj' });

/* ------------------------------- feedback ------------------------------- */

export function recordFeedback(user: User, itemId: string, kind: 'skip' | 'love') {
  db.run('INSERT INTO dj_feedback (user_id, item_id, kind, at) VALUES (?, ?, ?, ?)', user.id, itemId, kind, new Date().toISOString());
  if (kind === 'love') {
    db.run(`INSERT INTO user_data (user_id, item_id, favorite) VALUES (?, ?, 1) ON CONFLICT(user_id, item_id) DO UPDATE SET favorite = 1`, user.id, itemId);
  }
}

/** Recent skips for this user: per track and per artist counts (last 60 days). */
export function skipStats(userId: string): { tracks: Map<string, number>; artists: Map<string, number> } {
  const rows = db.all<{ item_id: string; artist: string | null; n: number }>(
    `SELECT f.item_id, i.grandparent_id artist, COUNT(*) n FROM dj_feedback f JOIN items i ON i.id = f.item_id
     WHERE f.user_id = ? AND f.kind = 'skip' AND f.at > ? GROUP BY f.item_id`, userId, new Date(Date.now() - 60 * 86400000).toISOString());
  const tracks = new Map<string, number>();
  const artists = new Map<string, number>();
  for (const r of rows) {
    tracks.set(r.item_id, r.n);
    if (r.artist) artists.set(r.artist, (artists.get(r.artist) ?? 0) + r.n);
  }
  return { tracks, artists };
}

