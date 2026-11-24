/**
 * The radio host's break planner (Radio Host add-on and Your DJ commentary). Most transitions stay quiet; when the
 * host talks it fits the time it has:
 *  - over the next track's intro: a frontsell of at most min(10 s, intro − 1 s) at ~3 words/s (stops before the vocals);
 *  - otherwise in the gap or over the previous track's outro (backsell + frontsell);
 *  - now and then (at most 1–3 an hour) a full break of up to ~40 s with a fact, a joke, the time or the weather.
 * Time checks and weather come near the top or bottom of the hour. Nothing is repeated within a session, and jokes,
 * facts and phrases are remembered per listener for a few days. Text comes from many template variants, optionally
 * rewritten by the language-model chain using ONLY the facts given (grounded); speech from the TTS chain, else the
 * device voice. Every failure is silent: worst case the host says nothing.
 */
import crypto from 'node:crypto';
import type { DjBreak, DjBreakKind, DjBreakRequest, DjSegment, HostChattiness, RadioHostPrefs, User, YourDjCommentary } from '@mediamax/shared';
import { getSettings } from '../../settings.js';
import { llmAvailable, llmChat } from '../../ai/llm.js';
import { speakChain } from '../../ai/tts.js';
import { artistFacts, trackInfo, type ArtistFacts, type TrackInfo } from '../../facts.js';
import { currentWeather, weatherLocation } from '../../weather.js';
import { JOKES } from './jokes.js';
import { countSince, lastAt, remember, sessionSaid, used, usedKeys } from './memory.js';
import { logger } from '../../../util/log.js';

const log = logger('dj-host');

export const DEFAULT_RADIO_HOST: RadioHostPrefs = {
  enabled: false, chattiness: 'light',
  categories: { announce: true, facts: true, jokes: true, weather: true, time: true, stats: true },
  voice: null,
};

export function radioHostPrefs(user: User): RadioHostPrefs {
  const p = user.preferences?.radioHost;
  return { ...DEFAULT_RADIO_HOST, ...(p ?? {}), categories: { ...DEFAULT_RADIO_HOST.categories, ...(p?.categories ?? {}) } };
}
export const yourDjCommentary = (user: User): YourDjCommentary => user.preferences?.yourDj?.commentary ?? 'full';

/* ------------------------------ text helpers ------------------------------ */

export const WORDS_PER_SEC = 3;
export const wordCount = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
const by = (t: TrackInfo) => (t.artist ? `${t.title} by ${t.artist}` : t.title);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthYear = (iso: string) => {
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};
const an = (w: string) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

interface Piece {
  /** Anti-repeat key (template id, or fact/joke key). */
  key: string;
  /** 'phrase' | 'fact' | 'joke' | 'time' | 'weather' */
  kind: string;
  slot: string;
  text: string;
  /** Grounded facts behind it (for the language model). */
  facts: string[];
}

type Variant = [id: string, make: () => string | null];

/** First variant not said this session nor (preferably) recently; random among those left. */
function choose(userId: string, said: Set<string>, slot: string, variants: Variant[], rng: () => number): Piece | null {
  const ok = variants.map(([id, f]) => ({ id: `${slot}:${id}`, text: f() })).filter((v): v is { id: string; text: string } => !!v.text && !said.has(v.text));
  if (!ok.length) return null;
  const recent = usedKeys(userId, 'phrase');
  const fresh = ok.filter((v) => !recent.has(v.id));
  const pool = fresh.length ? fresh : ok;
  const v = pool[Math.floor(rng() * pool.length)];
  return { key: v.id, kind: 'phrase', slot, text: v.text, facts: [] };
}

function frontsell(next: TrackInfo): Variant[] {
  const a = next.artist;
  return [
    ['up-next', () => `Up next, ${by(next)}.`],
    ['heres', () => (a ? `Here's ${a} with ${next.title}.` : `Here's ${next.title}.`)],
    ['this-is', () => (a ? `This is ${next.title}, from ${a}.` : `This is ${next.title}.`)],
    ['coming-up', () => (a ? `Coming up: ${a}, ${next.title}.` : `Coming up: ${next.title}.`)],
    ['lets-go', () => (a ? `Let's go to ${a}. This one's ${next.title}.` : null)],
    ['stay', () => `Stay with me for ${by(next)}.`],
    ['and-now', () => (a ? `And now, ${a}.` : null)],
    ['keep', () => `Keeping it going with ${next.title}.`],
    ['next-with', () => (a ? `${a} next, with ${next.title}.` : null)],
    ['turn-up', () => `Turn this one up: ${next.title}.`],
  ];
}

function backsell(prev: TrackInfo): Variant[] {
  const a = prev.artist;
  return [
    ['that-was', () => `That was ${by(prev)}.`],
    ['there', () => (a ? `${a} there, with ${prev.title}.` : null)],
    ['heard', () => `You just heard ${prev.title}.`],
    ['thats', () => (a ? `That's ${a}, ${prev.title}.` : null)],
    ['lovely', () => (a ? `Lovely stuff from ${a}.` : null)],
    ['great', () => (a ? `${prev.title}, from ${a}. Great track.` : null)],
    ['for-you', () => (a ? `There's ${a} for you.` : null)],
  ];
}

function localFactPieces(user: User, t: TrackInfo, cats: RadioHostPrefs['categories'], said: Set<string>): Piece[] {
  const out: Piece[] = [];
  const used3 = usedKeys(user.id, 'fact');
  const add = (type: string, text: string | null, fact: string) => {
    const key = `${t.id}:${type}`;
    if (!text || used3.has(key) || said.has(text)) return;
    out.push({ key, kind: 'fact', slot: type === 'plays' || type === 'artist-week' ? 'stats' : 'fact', text, facts: [fact] });
  };
  if (cats.facts) {
    if (t.year) add('year', [`${t.title} came out in ${t.year}.`, `This one's from ${t.year}.`, `Back to ${t.year} with this one.`][t.year % 3], `released in ${t.year}`);
    if (t.album && t.album !== t.title) add('album', [`It's from the album ${t.album}.`, `Taken from ${t.album}.`][t.title.length % 2], `from the album "${t.album}"`);
    if (t.genres[0]) add('genre', `A bit of ${t.genres[0].toLowerCase()} for you.`, `genre: ${t.genres[0]}`);
    if (t.addedAt) {
      const days = Math.floor((Date.now() - Date.parse(t.addedAt)) / 86400000);
      if (days >= 0 && days <= 30) add('added', days <= 1 ? 'A brand-new addition to your library.' : `A recent addition: you added this ${days} days ago.`, `added to the library ${days} days ago`);
      else if (days > 30) add('added', `You added this to your library in ${monthYear(t.addedAt)}.`, `added to the library in ${monthYear(t.addedAt)}`);
    }
  }
  if (cats.stats) {
    if (t.plays >= 5) add('plays', `You've played this ${t.plays} times.`, `the listener has played it ${t.plays} times`);
    else if (t.plays === 0) add('plays', `You haven't played this one here before.`, 'the listener has not played it here before');
    if (t.favorite) add('favorite', 'One of your favourites.', 'it is one of the listener\'s favourites');
    if (t.artistPlaysThisWeek >= 3 && t.artist) add('artist-week', `That's ${t.artistPlaysThisWeek} tracks from ${t.artist} this week.`, `${t.artistPlaysThisWeek} plays of ${t.artist} this week`);
  }
  return out;
}

function onlinePieces(user: User, t: TrackInfo, f: ArtistFacts | null, said: Set<string>): Piece[] {
  if (!f || !t.artist) return [];
  const out: Piece[] = [];
  const isGroup = /group|orchestra|choir/i.test(f.type ?? '');
  const add = (type: string, text: string, fact: string) => {
    const key = `${t.artistId ?? t.artist}:${type}`;
    if (!used(user.id, 'fact', key) && !said.has(text)) out.push({ key, kind: 'fact', slot: 'online', text, facts: [fact] });
  };
  if (f.area && f.beginYear) add('origin', `${t.artist} ${isGroup ? 'got together' : 'started out'} in ${f.area} in ${f.beginYear}.`, `${t.artist}: from ${f.area}, active since ${f.beginYear} (MusicBrainz)`);
  else if (f.area) add('origin', `${t.artist} ${isGroup ? 'are' : 'is'} from ${f.area}.`, `${t.artist}: from ${f.area} (MusicBrainz)`);
  if (f.description) add('desc', `${t.artist}: ${an(f.description)} ${f.description}.`.replace(/: (an?) /, `, ${isGroup ? 'they are' : 'that is'} $1 `), `${t.artist}: "${f.description}" (Wikidata)`);
  return out;
}

const NUMS = ['twelve', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven'];
function timePiece(h: number, m: number, rng: () => number): Piece {
  const h12 = h % 12;
  const hh = h12 === 0 ? 12 : h12;
  const part = h < 5 ? 'night' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
  const nextH = NUMS[(h + 1) % 12];
  const text = m >= 55 ? `Coming up to ${nextH} o'clock.`
    : m <= 3 ? [`It's just gone ${NUMS[h12]} o'clock.`, `${cap(NUMS[h12])} o'clock on a ${part} like this.`][Math.floor(rng() * 2)]
    : m >= 27 && m <= 33 ? [`It's half past ${NUMS[h12]}.`, `Half past ${NUMS[h12]} this ${part}.`][Math.floor(rng() * 2)]
    : `It's ${hh}:${String(m).padStart(2, '0')}.`;
  return { key: `time:${h}:${m}`, kind: 'time', slot: 'time', text, facts: [`local time ${h}:${String(m).padStart(2, '0')}`] };
}

/* ------------------------------ language model ------------------------------ */

const REWRITE_SYSTEM = (host: string) => `You are ${host}, a warm, upbeat radio presenter on a personal music station.
Rewrite the given talking points into what you say on air, in natural spoken English.
Rules: use ONLY the facts provided — never invent dates, numbers, chart positions, trivia or quotes; keep every song and artist name exactly as given;
at most the given number of words; 1–2 sentences (up to 4 for a long break); no emojis, hashtags, stage directions or quotation marks.
If "end_with" is given, end with that introduction of the next song.`;

/** Every number in the reply must appear in the facts (a cheap grounding check), and it must stay within budget. */
function grounded(reply: string, source: string, maxWords: number, mustName: string | null): boolean {
  if (wordCount(reply) > maxWords + 2 || reply.length < 8) return false;
  const nums = reply.match(/\d+/g) ?? [];
  if (nums.some((n) => !source.includes(n))) return false;
  if (mustName && !reply.toLowerCase().includes(mustName.toLowerCase().slice(0, 24))) return false;
  return true;
}

async function rewrite(pieces: Piece[], maxWords: number, next: TrackInfo | null): Promise<string | null> {
  if (!llmAvailable('dj')) return null;
  const host = getSettings().aiDj.hostName;
  const front = pieces.find((p) => p.slot === 'frontsell' || p.slot === 'segment');
  const points = pieces.map((p) => p.text);
  const facts = pieces.flatMap((p) => p.facts);
  const src = JSON.stringify({ talking_points: points, facts, max_words: maxWords, end_with: front?.text ?? null });
  const reply = await llmChat(REWRITE_SYSTEM(host), src, {
    temperature: 0.8, maxTokens: Math.min(400, maxWords * 3 + 20), timeoutMs: 12000,
    validate: (t) => grounded(clean(t, host), src, maxWords, next && front ? next.title : null),
  });
  return reply ? clean(reply, host) : null;
}

const clean = (t: string, host: string) =>
  t.replace(/^["'“”]+|["'“”]+$/g, '').replace(new RegExp(`^${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*`, 'i'), '').replace(/[*_#`]/g, '').replace(/\s+/g, ' ').trim();

/* --------------------------------- planner --------------------------------- */

export interface PlanContext {
  user: User;
  req: DjBreakRequest;
  /** Your DJ: the segment that starts with `nextItemId`, if any. */
  segmentStart?: DjSegment | null;
  rng?: () => number;
  now?: Date;
  /** Max wait for server speech before falling back to device speech (ms). */
  ttsWaitMs?: number;
}

interface Plan {
  kind: DjBreakKind;
  placement: DjBreak['placement'];
  maxMs: number;
  pieces: Piece[];
}

const FREQ: Record<Exclude<HostChattiness, 'off'>, { minTracks: number; minMs: number; prob: number; fullPerHour: number; extras: number }> = {
  intros: { minTracks: 3, minMs: 8 * 60000, prob: 0.5, fullPerHour: 0, extras: 0 },
  light: { minTracks: 3, minMs: 9 * 60000, prob: 0.5, fullPerHour: 1, extras: 1 },
  chatty: { minTracks: 1, minMs: 3 * 60000, prob: 0.65, fullPerHour: 3, extras: 2 },
};

/** Budget for talking over the next intro (null = too short, talk elsewhere). */
export function introBudgetMs(introMs: number | undefined | null): number | null {
  if (introMs == null || !Number.isFinite(introMs)) return null;
  const ms = Math.min(10000, introMs - 1000);
  return ms >= 3000 ? ms : null;
}

const nearHourMark = (m: number) => m >= 57 || m <= 3 || (m >= 27 && m <= 33);

/** Decide whether and what to say at this transition. Pure apart from the anti-repeat log and fact lookups. */
export async function planBreak(ctx: PlanContext): Promise<Plan | null> {
  const { user, req } = ctx;
  const rng = ctx.rng ?? Math.random;
  const now = ctx.now ?? new Date();
  const hour = Number.isInteger(req.hour) && req.hour! >= 0 && req.hour! < 24 ? req.hour! : now.getHours();
  const minute = Number.isInteger(req.minute) && req.minute! >= 0 && req.minute! < 60 ? req.minute! : now.getMinutes();
  const next = trackInfo(user, req.nextItemId);
  if (!next) return null;
  const prev = trackInfo(user, req.previousItemId);
  const sessKey = req.sessionId ? `s:${req.sessionId}` : `radio:${user.id}`;
  const said = sessionSaid(sessKey);
  const intro = introBudgetMs(req.introMs);

  let chattiness: HostChattiness;
  let cats: RadioHostPrefs['categories'];
  if (req.mode === 'yourdj') {
    const c = yourDjCommentary(user);
    if (c === 'off') return null;
    // Your DJ talks with the listener's Radio Host topic choices (all on by default).
    cats = radioHostPrefs(user).categories;
    // A new segment: introduce it (both "intros" and "full").
    if (ctx.segmentStart) {
      const seg = ctx.segmentStart;
      const pieces: Piece[] = [];
      const intros: Variant[] = [
        ['title', () => `${seg.title}. ${seg.reason}.`],
        ['next-up', () => `Next up: ${seg.title.toLowerCase()}. ${seg.reason}.`],
        ['switch', () => `Let's switch it up. ${seg.title}: ${seg.reason.charAt(0).toLowerCase()}${seg.reason.slice(1)}.`],
        ['got', () => `I've got something for you: ${seg.title.toLowerCase()}. ${seg.reason}.`],
      ];
      const p = choose(user.id, said, 'segment', intros, rng);
      if (p) pieces.push({ ...p, facts: [`segment: ${seg.title} — ${seg.reason}`] });
      const f = choose(user.id, said, 'frontsell', frontsell(next), rng);
      if (f) pieces.push({ ...f, facts: [`next song: "${next.title}"${next.artist ? ` by ${next.artist}` : ''}`] });
      if (!pieces.length) return null;
      return { kind: 'segment-intro', placement: intro ? 'over-intro' : 'gap', maxMs: intro ? Math.max(intro, 6000) : 12000, pieces };
    }
    if (c === 'intros') return null;
    chattiness = req.chattiness && req.chattiness !== 'off' ? req.chattiness : 'light';
  } else {
    const prefs = radioHostPrefs(user);
    if (!prefs.enabled) return null;
    chattiness = req.chattiness ?? prefs.chattiness;
    cats = prefs.categories;
  }
  if (chattiness === 'off') return null;
  const f = FREQ[chattiness];
  const tracks = Math.max(0, Number(req.tracksSinceBreak) || 0);
  const sinceMs = Math.max(0, Number(req.msSinceBreak) || 0);
  const timeDue = cats.time && chattiness !== 'intros' && nearHourMark(minute) && Date.now() - lastAt(user.id, 'time') > 25 * 60000;
  const due = tracks >= f.minTracks && sinceMs >= f.minMs;
  if (!due && !(timeDue && tracks >= 1)) return null;
  // Vary the spacing: even when due, the host often lets one more song go by.
  if (!timeDue && rng() > f.prob + Math.min(0.3, (tracks - f.minTracks) * 0.1)) return null;

  const pieces: Piece[] = [];
  const nextFact = (t: string) => `next song: "${next.title}"${next.artist ? ` by ${next.artist}` : ''}${t}`;
  const front = cats.announce || chattiness === 'intros' ? choose(user.id, said, 'frontsell', frontsell(next), rng) : null;
  const back = prev && cats.announce && chattiness !== 'intros' ? choose(user.id, said, 'backsell', backsell(prev), rng) : null;

  // Optional content, best first; each kind at most once.
  const extras: Piece[] = [];
  if (chattiness !== 'intros') {
    if (timeDue) extras.push(timePiece(hour, minute, rng));
    if (cats.weather && weatherLocation() && nearHourMark(minute) && Date.now() - lastAt(user.id, 'weather') > 50 * 60000) {
      const w = await currentWeather();
      if (w) {
        const text = [`In ${w.place} it's ${w.tempC} degrees and ${w.description}.`, `${w.place} weather: ${w.description}, ${w.tempC} degrees.`][Math.floor(rng() * 2)];
        extras.push({ key: `weather:${hour}`, kind: 'weather', slot: 'weather', text, facts: [`weather in ${w.place}: ${w.tempC} °C, ${w.description} (Open-Meteo)`] });
      }
    }
    const local = localFactPieces(user, next, cats, said);
    const online = cats.facts ? onlinePieces(user, next, await artistFacts(next.artist, next.artistMbid, 2500), said) : [];
    const facts = [...online, ...local].sort(() => rng() - 0.5);
    extras.push(...facts.slice(0, 2));
  }

  // Full break: in the gap, now and then.
  const full = f.fullPerHour > 0 && tracks >= 3 && countSince(user.id, 'break-full', 3600000) < f.fullPerHour && rng() < 0.3;
  if (full) {
    if (cats.jokes) {
      const done = usedKeys(user.id, 'joke');
      const left = JOKES.map((j, i) => ({ j, i })).filter((x) => !done.has(String(x.i)) && !said.has(x.j));
      if (left.length) {
        const x = left[Math.floor(rng() * left.length)];
        const lead = ['Here\'s one for you.', 'Quick one before the next song.', 'I heard this one the other day.'][Math.floor(rng() * 3)];
        extras.push({ key: String(x.i), kind: 'joke', slot: 'joke', text: `${lead} ${x.j}`, facts: [`joke (tell as written): ${x.j}`] });
      }
    }
    const content = extras.slice(0, 4);
    if (!content.length && !back) return null;
    return { kind: 'full', placement: 'gap', maxMs: 40000, pieces: [...(back ? [back] : []), ...content, ...(front ? [{ ...front, facts: [nextFact('')] }] : [])] };
  }

  // Short break: over the intro if it is long enough, else in the gap / over the outro.
  // Time and weather go together (one "extra"), and get a little more room in the gap.
  const clock = extras.filter((x) => x.slot === 'time' || x.slot === 'weather');
  const placement: DjBreak['placement'] = intro ? 'over-intro' : clock.length ? 'gap' : prev ? 'over-outro' : 'gap';
  const maxMs = intro ?? (clock.length ? 15000 : prev ? 8000 : 10000);
  const budget = Math.floor((maxMs / 1000) * WORDS_PER_SEC);
  let words = 0;
  const fit = (p: Piece | null) => {
    if (!p) return false;
    const n = wordCount(p.text);
    if (words + n > budget) return false;
    words += n;
    return true;
  };
  // The frontsell always fits first (it leads into the song), then a backsell, then extras.
  if (front && fit(front)) front.facts = [nextFact('')];
  else if (front) return null;
  const chosen: Piece[] = [];
  if (back && fit(back)) chosen.push(back);
  for (const x of extras.slice(0, f.extras + (clock.length > 1 ? 1 : 0))) if (fit(x)) chosen.push(x);
  if (front) chosen.push(front);
  if (!chosen.length) return null;
  const kind: DjBreakKind = chosen.length === 1 && front ? 'frontsell' : back && chosen.includes(back) && chosen.length === 2 ? 'link' : back && !front ? 'backsell' : 'link';
  return { kind, placement, maxMs, pieces: chosen };
}

/** Plan, write (LLM or templates) and voice a break. Null = stay quiet. Never throws. */
export async function makeBreak(ctx: PlanContext): Promise<DjBreak | null> {
  let plan: Plan | null;
  try {
    plan = await planBreak(ctx);
  } catch (e) {
    log.warn(`Break planning failed: ${(e as Error).message}`);
    return null;
  }
  if (!plan) return null;
  const { user, req } = ctx;
  const maxWords = Math.floor((plan.maxMs / 1000) * WORDS_PER_SEC);
  const next = trackInfo(user, req.nextItemId);
  let text = plan.pieces.map((p) => p.text).join(' ');
  let byWho: DjBreak['by'] = 'template';
  const better = await rewrite(plan.pieces, maxWords, next).catch(() => null);
  if (better) {
    text = better;
    byWho = 'llm';
  }
  // Templates over budget (a long title): keep the frontsell only.
  if (wordCount(text) > maxWords + 2) text = plan.pieces[plan.pieces.length - 1].text;
  // Remember what was said (session + per listener).
  const said = sessionSaid(req.sessionId ? `s:${req.sessionId}` : `radio:${user.id}`);
  for (const p of plan.pieces) {
    said.add(p.text);
    if (said.size > 400) said.delete(said.values().next().value!);
    remember(user.id, p.kind, p.key);
  }
  remember(user.id, 'break', plan.kind);
  if (plan.kind === 'full') remember(user.id, 'break-full', '1');
  // Server voice if one is set up and answers in time, else the device speaks the caption.
  const wait = ctx.ttsWaitMs ?? 20000;
  const voice = await Promise.race([speakChain(text, { feature: 'dj' }), new Promise<null>((r) => setTimeout(() => r(null), wait).unref?.())]).catch(() => null);
  let placement = plan.placement;
  if (voice?.durationMs && placement === 'over-intro' && voice.durationMs > plan.maxMs + 500) placement = 'gap';
  return {
    id: crypto.randomUUID(), kind: plan.kind, text, placement, maxMs: plan.maxMs,
    audioUrl: voice ? `/api/v1/dj/voice/${voice.file}` : null, durationMs: voice?.durationMs ?? null,
    slots: plan.pieces.map((p) => p.slot), by: byWho,
  };
}
