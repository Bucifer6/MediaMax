import type { TvSchedule } from './metadata/tmdb.js';
import { db } from '../db.js';
import { nowIso } from '../util/misc.js';

/** Store a show's airing status and next episode (from TMDB) for the calendar. */
export function saveSchedule(showId: string, s: TvSchedule) {
  db.upsert('show_schedule', {
    show_id: showId,
    status: s.status,
    in_production: s.inProduction == null ? null : s.inProduction ? 1 : 0,
    last_air_date: s.lastAirDate,
    next_air_date: s.next?.airDate ?? null,
    next_season: s.next?.season ?? null,
    next_episode: s.next?.episode ?? null,
    next_title: s.next?.title ?? null,
    next_overview: s.next?.overview ?? null,
    updated_at: nowIso(),
  }, 'show_id');
}
