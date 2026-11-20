/**
 * Upcoming-episodes calendar: next airing episodes (stored from TMDB when a show's metadata refreshes, and by the
 * daily "Refresh TV schedules" task) plus episodes recently added to the viewer's libraries.
 */
import type { CalendarEntry, CalendarResponse, HomeRow, HomeRowConfig, User } from '@mediamax/shared';
import { db } from '../db.js';
import { accessClause, itemsByIds, selectItems } from './items.js';
import { calendarHooks } from './recommend.js';
import { tmdbEnabled, tvSchedule } from './metadata/tmdb.js';
import { saveSchedule } from './schedule.js';
import { parseJson } from '../util/misc.js';
import { logger } from '../util/log.js';

const log = logger('calendar');
const DAY = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Normalise a requested range: defaults to the last 7 days → next 30 days, at most 120 days long. */
export function calendarRange(from?: string | null, to?: string | null, now = new Date()): { from: string; to: string } {
  const f = from && DATE.test(from) && !Number.isNaN(Date.parse(from)) ? from : ymd(new Date(now.getTime() - 7 * DAY));
  let t = to && DATE.test(to) && !Number.isNaN(Date.parse(to)) ? to : ymd(new Date(Date.parse(f) + 37 * DAY));
  if (t < f) t = f;
  const max = ymd(new Date(Date.parse(f) + 120 * DAY));
  if (t > max) t = max;
  return { from: f, to: t };
}

/** Shows the viewer follows: they've watched or started an episode, or the show is on My List. */
export function followedShows(userId: string): Set<string> {
  return new Set(db.all<{ id: string }>(
    `SELECT DISTINCT i.grandparent_id id FROM user_data ud JOIN items i ON i.id = ud.item_id
     WHERE ud.user_id = ? AND i.type = 'episode' AND i.grandparent_id IS NOT NULL AND (ud.played = 1 OR ud.position_ms > 0)
     UNION SELECT w.item_id id FROM watchlist w JOIN items s ON s.id = w.item_id WHERE w.user_id = ? AND s.type = 'show'`, userId, userId).map((r) => r.id));
}

function upcomingEntries(user: User, from: string, to: string, following: Set<string>): CalendarEntry[] {
  const a = accessClause(user);
  const rows = db.all(
    `SELECT s.* FROM show_schedule s JOIN items i ON i.id = s.show_id
     WHERE s.next_air_date IS NOT NULL AND s.next_air_date >= ? AND s.next_air_date <= ? AND ${a.sql}
     ORDER BY s.next_air_date LIMIT 500`, from, to, ...a.params);
  const shows = new Map(itemsByIds(user, rows.map((r) => r.show_id)).map((s) => [s.id, s]));
  return rows.filter((r) => shows.has(r.show_id)).map((r) => ({
    kind: 'upcoming' as const,
    date: r.next_air_date,
    show: shows.get(r.show_id)!,
    episode: null,
    seasonNumber: r.next_season ?? null,
    episodeNumber: r.next_episode ?? null,
    title: r.next_title ?? null,
    overview: r.next_overview ?? null,
    following: following.has(r.show_id),
  }));
}

function addedEntries(user: User, from: string, to: string, following: Set<string>, limit = 300): CalendarEntry[] {
  const eps = selectItems(user, `i.type = 'episode' AND i.added_at >= ? AND i.added_at < ?`, [`${from}T00:00:00.000Z`, `${ymd(new Date(Date.parse(to) + DAY))}T00:00:00.000Z`],
    `ORDER BY i.added_at DESC LIMIT ${limit}`);
  const shows = new Map(itemsByIds(user, [...new Set(eps.map((e) => e.grandparentId).filter((x): x is string => !!x))]).map((s) => [s.id, s]));
  return eps.filter((e) => e.grandparentId && shows.has(e.grandparentId)).map((e) => ({
    kind: 'added' as const,
    date: e.addedAt.slice(0, 10),
    show: shows.get(e.grandparentId!)!,
    episode: e,
    seasonNumber: e.parentIndex,
    episodeNumber: e.index,
    title: e.title,
    overview: e.overview,
    following: following.has(e.grandparentId!),
  }));
}

export function calendarFor(user: User, fromQ?: string | null, toQ?: string | null, now = new Date()): CalendarResponse {
  const { from, to } = calendarRange(fromQ, toQ, now);
  const today = ymd(now);
  const following = followedShows(user.id);
  // Upcoming = from today on (a stored "next episode" whose date has passed is stale until the next refresh).
  const upFrom = from > today ? from : today;
  const upcoming = upFrom <= to ? upcomingEntries(user, upFrom, to, following) : [];
  const added = from <= today ? addedEntries(user, from, to < today ? to : today, following) : [];
  const entries = [...added, ...upcoming].sort((x, y) => x.date.localeCompare(y.date) || Number(y.following) - Number(x.following) || x.show.sortTitle.localeCompare(y.show.sortTitle));
  return { from, to, tmdbConfigured: tmdbEnabled(), entries };
}

/** Home row: next airing episodes over the coming three weeks, shows the viewer follows first. */
export function upcomingRow(user: User, cfg: HomeRowConfig): HomeRow | null {
  const now = new Date();
  const following = followedShows(user.id);
  const entries = upcomingEntries(user, ymd(now), ymd(new Date(now.getTime() + 21 * DAY)), following)
    .sort((x, y) => Number(y.following) - Number(x.following) || x.date.localeCompare(y.date))
    .slice(0, cfg.limit ?? 20);
  if (!entries.length) return null;
  return { id: cfg.id, type: 'upcoming', title: cfg.title ?? 'Coming soon', items: entries.map((e) => e.show), calendar: entries, link: { page: 'calendar' } };
}

calendarHooks.upcomingRow = upcomingRow;

/**
 * Daily task: refresh the airing schedule of shows that may still air (metadata refreshes only happen when new
 * episodes arrive, so without this the next-episode date would go stale).
 */
export async function refreshSchedules(progress?: (p: number) => void, max = 400): Promise<number> {
  if (!tmdbEnabled()) return 0;
  const cutoff = new Date(Date.now() - 20 * 3_600_000).toISOString();
  const rows = db.all<{ id: string; external_ids: string }>(
    `SELECT i.id, i.external_ids FROM items i LEFT JOIN show_schedule s ON s.show_id = i.id
     WHERE i.type = 'show' AND json_extract(i.external_ids, '$.tmdb') IS NOT NULL
       AND (s.show_id IS NULL OR (s.updated_at < ? AND COALESCE(s.status, '') NOT IN ('Ended', 'Canceled')))
     ORDER BY s.next_air_date IS NULL, s.next_air_date LIMIT ?`, cutoff, max);
  let done = 0;
  for (const r of rows) {
    const tmdbId = parseJson<{ tmdb?: string }>(r.external_ids, {}).tmdb;
    if (tmdbId) {
      try {
        const s = await tvSchedule(tmdbId);
        if (s) saveSchedule(r.id, s);
      } catch (e) {
        log.warn(`Schedule refresh failed for ${r.id}`, (e as Error).message);
      }
    }
    progress?.(Math.round((++done / rows.length) * 100));
  }
  return done;
}

