/**
 * Random marathon ("fall-asleep mode"): a server-side queue that keeps handing out random titles for the same
 * roulette filters, never repeating one played (or skipped) in this marathon and never suggesting disliked titles.
 * Works for movies and for "random episodes, forever" (one show, or any show matching the filters).
 *
 * Clients ask POST /marathon/:id/next when a title ends; the answer says whether to ask "Are you still watching?"
 * first (stillWatchingDue) so nobody streams to a sleeping viewer all night.
 */
import type { CreateMarathonRequest, Item, MarathonNextRequest, MarathonNextResponse, MarathonState, RouletteFilters, StillWatchingSettings, User } from '@mediamax/shared';
import { assertCanSee, itemsByIds } from '../items.js';
import { newId } from '../../util/ids.js';
import { nowIso } from '../../util/misc.js';
import { notFound, badRequest } from '../../util/errors.js';
import { candidates, chooseEpisode, parseFilters } from './roulette.js';
import { clampList, pickWeight, rngFor, weightedIndex } from './common.js';

export const MARATHON_TTL_MS = 12 * 3600_000;
export const MAX_MARATHONS_PER_USER = 5;
export const DEFAULT_STILL_WATCHING: StillWatchingSettings = { enabled: true, afterItems: 2, afterMinutes: 240 };

interface Marathon extends MarathonState {
  userId: string;
  touchedAt: number;
  /** Skipped titles: excluded but not counted as played. */
  skipped: string[];
  rng: () => number;
}

const marathons = new Map<string, Marathon>();

export const _resetMarathons = () => marathons.clear();

export function normalizeStillWatching(s: Partial<StillWatchingSettings> | undefined): StillWatchingSettings {
  const d = DEFAULT_STILL_WATCHING;
  const n = (v: unknown, min: number, max: number, def: number) => (Number.isFinite(Number(v)) && v != null ? Math.max(min, Math.min(max, Math.round(Number(v)))) : def);
  return { enabled: s?.enabled !== false, afterItems: n(s?.afterItems, 1, 20, d.afterItems), afterMinutes: n(s?.afterMinutes, 15, 24 * 60, d.afterMinutes) };
}

/**
 * The "Are you still watching?" rule: ask when the viewer has let `afterItems` titles finish in a row without any
 * input, or `afterMinutes` have passed without input. Disabled → never.
 */
export function stillWatchingDue(s: StillWatchingSettings, itemsSinceInput: number, msSinceInput: number): boolean {
  if (!s.enabled) return false;
  return itemsSinceInput >= s.afterItems || msSinceInput >= s.afterMinutes * 60_000;
}

function sweep(now = Date.now()) {
  for (const [id, m] of marathons) if (now - m.touchedAt > MARATHON_TTL_MS) marathons.delete(id);
}

const view = (m: Marathon): MarathonState => ({ id: m.id, filters: m.filters, showId: m.showId, stillWatching: m.stillWatching, played: [...m.played], startedAt: m.startedAt });

function get(user: User, id: string): Marathon {
  sweep();
  const m = marathons.get(id);
  if (!m || m.userId !== user.id) throw notFound('Marathon not found');
  m.touchedAt = Date.now();
  return m;
}

/** The next playable title (movie or episode) for the marathon, honouring access, filters and exclusions. */
export function pickNext(user: User, m: Pick<Marathon, 'filters' | 'showId' | 'played' | 'skipped' | 'rng'>): Item | null {
  const exclude = [...m.played, ...m.skipped];
  if (m.showId) return chooseEpisode(user, m.showId, 'random', m.rng, !!m.filters.unwatchedOnly, exclude);
  if (m.filters.kind === 'series') {
    // Any matching show: pick a show, then a random episode not yet played in this marathon. Shows whose episodes
    // are all used up are skipped (a few tries, then give up).
    const shows = candidates(user, m.filters, [], false, 300);
    for (let tries = 0; tries < 8 && shows.length; tries++) {
      const i = m.filters.weighted ? weightedIndex(shows.map((c) => pickWeight(c)), m.rng) : Math.floor(m.rng() * shows.length);
      const ep = chooseEpisode(user, shows[i].id, 'random', m.rng, !!m.filters.unwatchedOnly, exclude);
      if (ep) return ep;
      shows.splice(i, 1);
    }
    return null;
  }
  const pool = candidates(user, m.filters, exclude, false);
  if (!pool.length) return null;
  const i = m.filters.weighted ? weightedIndex(pool.map((c) => pickWeight(c)), m.rng) : Math.floor(m.rng() * pool.length);
  return itemsByIds(user, [pool[i].id])[0] ?? null;
}

export function createMarathon(user: User, req: Partial<CreateMarathonRequest> & { seed?: number } = {}): MarathonNextResponse {
  sweep();
  const filters: RouletteFilters = parseFilters(req);
  const showId = typeof req.showId === 'string' && req.showId ? req.showId : null;
  if (showId) {
    const row = assertCanSee(user, showId);
    if (row.type !== 'show') throw badRequest('Not a show');
    filters.kind = 'series';
  }
  // Keep at most a few marathons per viewer (oldest dropped).
  const mine = [...marathons.values()].filter((x) => x.userId === user.id).sort((a, b) => a.touchedAt - b.touchedAt);
  while (mine.length >= MAX_MARATHONS_PER_USER) marathons.delete(mine.shift()!.id);
  const m: Marathon = {
    id: newId(), userId: user.id, filters, showId, stillWatching: normalizeStillWatching(req.stillWatching),
    played: [], skipped: clampList((req as any).excludeIds, 500), startedAt: nowIso(), touchedAt: Date.now(), rng: rngFor(req.seed),
  };
  marathons.set(m.id, m);
  return { marathon: view(m), item: pickNext(user, m), stillWatchingCheck: false };
}

export function nextInMarathon(user: User, id: string, req: MarathonNextRequest = {}): MarathonNextResponse {
  const m = get(user, id);
  if (typeof req.finishedItemId === 'string' && req.finishedItemId && !m.played.includes(req.finishedItemId)) m.played.push(req.finishedItemId);
  if (typeof req.skippedItemId === 'string' && req.skippedItemId && !m.skipped.includes(req.skippedItemId)) m.skipped.push(req.skippedItemId);
  const item = pickNext(user, m);
  const check = stillWatchingDue(m.stillWatching, Math.max(0, Number(req.itemsSinceInput) || 0), Math.max(0, Number(req.msSinceInput) || 0));
  return { marathon: view(m), item, stillWatchingCheck: !!item && check };
}

export function getMarathon(user: User, id: string): MarathonState {
  return view(get(user, id));
}

export function endMarathon(user: User, id: string) {
  get(user, id);
  marathons.delete(id);
}
