import type { TrackingSyncResult, User } from '@mediamax/shared';
import { db } from '../db.js';
import { nowIso, parseJson } from '../util/misc.js';
import { accessClause } from './items.js';
import { bus } from './events.js';

/**
 * Shared by the two-way tracking services (Trakt, SIMKL): find library titles by outside ids and write what the
 * service says into the viewer's own data.
 *
 * Imports write the database directly instead of going through setPlayed / setWatchlist / setRating: those emit the
 * events the services listen to, so an import would be sent straight back as new history. Imports only ever add
 * (watched, a resume point, My List, a rating); they never un-watch or remove anything.
 */

export interface OutsideIds {
  imdb?: string | null;
  tmdb?: string | number | null;
  tvdb?: string | number | null;
}

/** Movies and shows the viewer can see, by imdb / tmdb / tvdb id (built once per sync). */
export class LibraryIndex {
  private readonly movies = new Map<string, string>();
  private readonly shows = new Map<string, string>();

  constructor(readonly user: User) {
    const a = accessClause(user);
    const rows = db.all<{ id: string; type: string; external_ids: string }>(
      `SELECT i.id, i.type, i.external_ids FROM items i WHERE i.type IN ('movie','show') AND ${a.sql}`, ...a.params);
    for (const r of rows) {
      const ids = parseJson<Record<string, string>>(r.external_ids, {});
      const map = r.type === 'movie' ? this.movies : this.shows;
      for (const k of ['imdb', 'tmdb', 'tvdb'] as const) if (ids[k]) map.set(`${k}:${String(ids[k]).toLowerCase()}`, r.id);
    }
  }

  private find(map: Map<string, string>, ids: OutsideIds | null | undefined): string | null {
    if (!ids) return null;
    for (const k of ['imdb', 'tmdb', 'tvdb'] as const) {
      const v = ids[k];
      if (v != null && v !== '') {
        const hit = map.get(`${k}:${String(v).toLowerCase()}`);
        if (hit) return hit;
      }
    }
    return null;
  }

  movie(ids: OutsideIds | null | undefined) {
    return this.find(this.movies, ids);
  }

  show(ids: OutsideIds | null | undefined) {
    return this.find(this.shows, ids);
  }

  episode(showId: string, season: number, episode: number): string | null {
    return db.get<{ id: string }>("SELECT id FROM items WHERE type = 'episode' AND grandparent_id = ? AND parent_idx = ? AND idx = ?", showId, season, episode)?.id ?? null;
  }
}

const ensureUd = (userId: string, itemId: string) => db.run('INSERT OR IGNORE INTO user_data (user_id, item_id) VALUES (?, ?)', userId, itemId);

/** Collects changes during one sync, then applies them in one transaction. */
export class TrackingImport {
  readonly result: TrackingSyncResult = { watched: 0, resumed: 0, watchlist: 0, rated: 0, notInLibrary: 0 };
  private readonly changed = new Set<string>();

  constructor(readonly user: User) {}

  missing() {
    this.result.notInLibrary++;
  }

  /** Watched (keeps the service's date when it is newer than ours). */
  watched(itemId: string, at?: string | null) {
    ensureUd(this.user.id, itemId);
    const r = db.run('UPDATE user_data SET played = 1, play_count = MAX(play_count, 1), position_ms = 0, last_played_at = COALESCE(?, last_played_at, ?) WHERE user_id = ? AND item_id = ? AND played = 0',
      at ?? null, nowIso(), this.user.id, itemId);
    if (r.changes) {
      this.result.watched++;
      this.changed.add(itemId);
    }
  }

  /** A resume point, only for titles not watched and not already further along here. */
  resume(itemId: string, positionMs: number, at?: string | null) {
    if (!(positionMs > 0)) return;
    ensureUd(this.user.id, itemId);
    const r = db.run('UPDATE user_data SET position_ms = ?, last_played_at = COALESCE(last_played_at, ?) WHERE user_id = ? AND item_id = ? AND played = 0 AND position_ms < ?',
      Math.round(positionMs), at ?? nowIso(), this.user.id, itemId, Math.round(positionMs) - 5000);
    if (r.changes) {
      this.result.resumed++;
      this.changed.add(itemId);
    }
  }

  watchlist(itemId: string, at?: string | null) {
    const r = db.run('INSERT OR IGNORE INTO watchlist (user_id, item_id, added_at) VALUES (?, ?, ?)', this.user.id, itemId, at ?? nowIso());
    if (r.changes) {
      this.result.watchlist++;
      this.changed.add(itemId);
    }
  }

  /** A 1–10 rating, only where the viewer hasn't rated the title here. */
  rating(itemId: string, rating: number) {
    if (!(rating >= 1 && rating <= 10)) return;
    ensureUd(this.user.id, itemId);
    const r = db.run('UPDATE user_data SET rating = ? WHERE user_id = ? AND item_id = ? AND rating IS NULL', rating, this.user.id, itemId);
    if (r.changes) {
      this.result.rated++;
      this.changed.add(itemId);
    }
  }

  /** Tell server-side listeners (recommendation caches, ListenBrainz) that the viewer's data changed. */
  finish(): TrackingSyncResult {
    for (const itemId of this.changed) bus.emit('userdata.changed', { userId: this.user.id, itemId, imported: true });
    return this.result;
  }
}

/** Run an import in one transaction (a sync of thousands of titles stays fast and all-or-nothing). */
export function runImport(user: User, fill: (imp: TrackingImport, index: LibraryIndex) => void): TrackingSyncResult {
  const index = new LibraryIndex(user);
  const imp = new TrackingImport(user);
  db.tx(() => fill(imp, index));
  return imp.finish();
}
