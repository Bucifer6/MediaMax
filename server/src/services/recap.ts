/**
 * "Previously on…" recaps. When a viewer comes back to a series after a break (Admin → AI → Recaps, default 7 days)
 * or starts a new season, the episode they are about to play offers a spoiler-safe recap built ONLY from the
 * overviews of the last 1-3 episodes they actually watched that come before it. Nothing after their last watched
 * episode is ever read, sent to a model or shown. With a language model the overviews are condensed into 3-5
 * sentences; without one (or if the reply fails the checks) a tidy list of those overviews is shown.
 * Cached per (user, show, last watched episode).
 */
import type { Marker, RecapResponse, User } from '@mediamax/shared';
import { db } from '../db.js';
import { accessClause, assertCanSee } from './items.js';
import { parseJson } from '../util/misc.js';
import { aiSettings, featureEnabled, llmAvailable, llmChat } from './ai/llm.js';
import { badRequest } from '../util/errors.js';

interface Ep { id: string; title: string; overview: string | null; season: number | null; episode: number | null; played: number | null; last: string | null; markers: string }

const code = (e: { season: number | null; episode: number | null }) => `S${String(e.season ?? 0).padStart(2, '0')}E${String(e.episode ?? 0).padStart(2, '0')}`;
const order = (a: { season: number | null; episode: number | null }, b: { season: number | null; episode: number | null }) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0);

/** First sentences of an overview, about `max` characters. */
export function shortOverview(text: string | null, max = 260): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > max * 0.4 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, '')}…`;
}

export const RECAP_SYSTEM = `You write a short "Previously on…" recap for a TV viewer who is about to continue a series.
Use ONLY the episode summaries you are given; they are the last episodes this viewer watched, in order.
Strict rules: write 3 to 5 sentences of plain prose in the past tense; never mention, hint at or speculate about anything that happens after the last summary; never predict what comes next; do not invent events, names or details that are not in the summaries; no headings, lists, quotes or emojis. Reply with the recap only.`;

/** Checks a model reply: plain prose, sane length, and none of the later episodes' titles. */
export function acceptRecap(text: string | null, laterTitles: string[]): string | null {
  if (!text) return null;
  const t = text.replace(/^["“']|["”']$/g, '').replace(/[*_#`>]/g, '').replace(/^\s*(previously on[^:]*:)\s*/i, '').replace(/\s+/g, ' ').trim();
  if (t.length < 40 || t.length > 1400) return null;
  const sentences = t.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 2);
  if (sentences.length < 2 || sentences.length > 7) return null;
  const low = t.toLowerCase();
  // A later episode's distinctive title showing up means the model leaked something it was never given: reject.
  if (laterTitles.some((x) => x.length >= 6 && !/^episode \d+$/i.test(x) && low.includes(x.toLowerCase()))) return null;
  return t;
}

export interface RecapOptions {
  /** Offer a recap even without a break (the "Recap" button). */
  force?: boolean;
  now?: Date;
  chat?: (system: string, user: string) => Promise<string | null>;
}

const empty = (reason: RecapResponse['reason'] = null): RecapResponse => ({ available: false, reason, showTitle: null, episodes: [], text: null, bullets: [], by: null, clip: null, daysSinceLastWatched: null });

export async function getRecap(user: User, episodeId: string, opts: RecapOptions = {}): Promise<RecapResponse> {
  if (!featureEnabled('recaps')) return empty();
  const target = assertCanSee(user, episodeId);
  if (target.type !== 'episode' || !target.grandparent_id) throw badRequest('Recaps are for TV episodes');
  const cfg = aiSettings().recaps;
  const now = opts.now ?? new Date();
  const a = accessClause(user, 'i');
  const eps = db.all<Ep>(
    `SELECT i.id, i.title, i.overview, i.parent_idx season, i.idx episode, ud.played, ud.last_played_at last, i.markers FROM items i
     LEFT JOIN user_data ud ON ud.item_id = i.id AND ud.user_id = ?
     WHERE i.grandparent_id = ? AND i.type = 'episode' AND ${a.sql}`, user.id, target.grandparent_id, ...a.params).sort(order);
  const t = { season: target.parent_idx ?? null, episode: target.idx ?? null };
  // Spoiler wall: only episodes strictly before the one about to play, and only ones this viewer finished.
  const before = eps.filter((e) => e.id !== target.id && order(e, t) < 0);
  const watched = before.filter((e) => e.played === 1);
  if (!watched.length) return empty();
  const last = watched[watched.length - 1];
  const lastAt = watched.map((e) => e.last).filter((x): x is string => !!x).sort().at(-1) ?? null;
  const days = lastAt ? Math.floor((now.getTime() - new Date(lastAt).getTime()) / 86400_000) : null;
  const firstOfSeason = !eps.some((e) => e.season === t.season && order(e, t) < 0);
  const newSeason = (t.season ?? 0) > (last.season ?? 0) && firstOfSeason;
  const gap = days != null && days >= cfg.minGapDays;
  const reason: RecapResponse['reason'] = gap ? 'gap' : newSeason ? 'new-season' : null;
  if (!reason && !opts.force) return { ...empty(), daysSinceLastWatched: days };

  const recapEps = watched.slice(-cfg.maxEpisodes);
  const show = db.get<{ title: string }>('SELECT title FROM items WHERE id = ?', target.grandparent_id);
  const markers = parseJson<Marker[]>(target.markers, []);
  const rm = markers.find((m) => m.type === 'recap' && m.endMs > m.startMs);
  const clip = rm ? { itemId: target.id, startMs: rm.startMs, endMs: rm.endMs } : null;
  const episodes = recapEps.map((e) => ({ id: e.id, title: e.title, season: e.season, episode: e.episode, overview: e.overview }));
  const base = { available: true, reason: reason ?? 'gap', showTitle: show?.title ?? null, episodes, clip, daysSinceLastWatched: days } as const;

  const cached = db.get<{ source: string; text: string | null; bullets: string }>('SELECT source, text, bullets FROM recap_cache WHERE user_id = ? AND show_id = ? AND last_episode_id = ?', user.id, target.grandparent_id, last.id);
  if (cached) return { ...base, text: cached.text, bullets: parseJson<string[]>(cached.bullets, []), by: cached.source as RecapResponse['by'] };

  const bullets = recapEps.map((e) => `${code(e)} · ${e.title}${e.overview ? ` — ${shortOverview(e.overview)}` : ''}`);
  let text: string | null = null;
  const withOverview = recapEps.filter((e) => e.overview?.trim());
  if (withOverview.length && (opts.chat || llmAvailable('recaps'))) {
    const payload = { show: show?.title ?? null, episodes: withOverview.map((e) => ({ episode: code(e), title: e.title, summary: e.overview })) };
    const chat = opts.chat ?? ((s: string, u: string) => llmChat(s, u, { feature: 'recaps', temperature: 0.3, maxTokens: 260, timeoutMs: 20000 }));
    const later = eps.filter((e) => order(e, last) > 0).map((e) => e.title);
    text = acceptRecap(await chat(RECAP_SYSTEM, JSON.stringify(payload)), later);
  }
  const by: RecapResponse['by'] = text ? 'llm' : 'list';
  // Cache only a model recap or a final list (a failed model call is retried next time).
  if (text || !(opts.chat || llmAvailable('recaps'))) {
    db.upsert('recap_cache', { user_id: user.id, show_id: target.grandparent_id, last_episode_id: last.id, source: by, text, bullets: JSON.stringify(bullets), episodes: JSON.stringify(episodes.map((e) => e.id)), created_at: now.toISOString() }, 'user_id,show_id,last_episode_id');
  }
  return { ...base, text, bullets, by };
}

/** Drop cached recaps older than 60 days (they are cheap to rebuild). */
export function pruneRecaps() {
  db.run('DELETE FROM recap_cache WHERE created_at < ?', new Date(Date.now() - 60 * 86400_000).toISOString());
}
