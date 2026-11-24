/**
 * Music facts for the radio host. Local facts come from the library and the listener's real listening (plays chosen
 * by Your DJ are not counted). Online facts (opt-in, Admin → AI → "Online music facts") come from MusicBrainz (artist
 * type, origin, start year; 1 request/s with an identifying User-Agent, no personal data) and Wikidata (CC0 short
 * description), cached in the database for 30 days. With the toggle off nothing is ever requested.
 */
import type { User } from '@mediamax/shared';
import { db } from '../db.js';
import { config } from '../config.js';
import { getSettings } from './settings.js';
import { accessClause } from './items.js';
import { parseJson } from '../util/misc.js';
import { logger } from '../util/log.js';

const log = logger('facts');

export interface TrackInfo {
  id: string;
  title: string;
  artist: string | null;
  artistId: string | null;
  album: string | null;
  year: number | null;
  genres: string[];
  addedAt: string | null;
  durationMs: number | null;
  favorite: boolean;
  /** Real listens (not Your DJ picks). */
  plays: number;
  playsThisMonth: number;
  artistPlaysThisWeek: number;
  firstPlayedAt: string | null;
  lastPlayedAt: string | null;
  artistMbid: string | null;
}

/** Plays this listener chose themselves (Your DJ picks don't count as "you play this a lot"). */
export const REAL_PLAY = "COALESCE(h.source, '') <> 'yourdj'";

export function trackInfo(user: User, id: string | undefined | null): TrackInfo | null {
  if (!id) return null;
  const acc = accessClause(user, 'i');
  const r = db.get(
    `SELECT i.id, i.title, i.year, i.genres, i.added_at, i.duration_ms, i.grandparent_id artist_id, ar.title artist, ar.external_ids artist_ext,
       al.title album, al.year album_year, al.genres album_genres, ud.favorite
     FROM items i LEFT JOIN items al ON al.id = i.parent_id LEFT JOIN items ar ON ar.id = i.grandparent_id
     LEFT JOIN user_data ud ON ud.item_id = i.id AND ud.user_id = ? WHERE i.id = ? AND ${acc.sql}`, user.id, id, ...acc.params);
  if (!r) return null;
  const month = new Date(Date.now() - 30 * 86400000).toISOString();
  const week = new Date(Date.now() - 7 * 86400000).toISOString();
  const p = db.get<{ n: number; m: number; first: string | null; last: string | null }>(
    `SELECT COUNT(*) n, SUM(CASE WHEN h.started_at > ? THEN 1 ELSE 0 END) m, MIN(h.started_at) first, MAX(h.started_at) last
     FROM play_history h WHERE h.user_id = ? AND h.item_id = ? AND ${REAL_PLAY}`, month, user.id, id)!;
  const ap = r.artist_id
    ? db.get<{ n: number }>(`SELECT COUNT(*) n FROM play_history h JOIN items t ON t.id = h.item_id WHERE h.user_id = ? AND t.grandparent_id = ? AND h.started_at > ? AND ${REAL_PLAY}`, user.id, r.artist_id, week)!.n
    : 0;
  const own = parseJson<string[]>(r.genres, []);
  return {
    id: r.id, title: r.title, artist: r.artist ?? null, artistId: r.artist_id ?? null, album: r.album ?? null, year: r.year ?? r.album_year ?? null,
    genres: (own.length ? own : parseJson<string[]>(r.album_genres, [])).filter((g) => typeof g === 'string').slice(0, 3),
    addedAt: r.added_at ?? null, durationMs: r.duration_ms ?? null, favorite: !!r.favorite,
    plays: p.n ?? 0, playsThisMonth: p.m ?? 0, artistPlaysThisWeek: ap, firstPlayedAt: p.first, lastPlayedAt: p.last,
    artistMbid: parseJson<Record<string, string>>(r.artist_ext, {}).musicbrainzArtist ?? null,
  };
}

/* ------------------------------ online facts ------------------------------ */

export interface ArtistFacts {
  type: string | null;
  area: string | null;
  beginYear: number | null;
  ended: boolean;
  /** Wikidata's short English description, e.g. "English rock band". */
  description: string | null;
}

const TTL = 30 * 86400000;
const UA = () => `Vibe/${config.version} (self-hosted media server)`;
export const onlineFactsEnabled = () => getSettings().ai?.onlineFacts === true;

// One request per second to MusicBrainz (its rate limit), shared by every caller.
let nextSlot = 0;
async function mbFetch(pathAndQuery: string): Promise<unknown> {
  const wait = Math.max(0, nextSlot - Date.now());
  nextSlot = Math.max(Date.now(), nextSlot) + 1100;
  if (wait) await new Promise((r) => setTimeout(r, wait));
  const res = await fetch(`https://musicbrainz.org/ws/2/${pathAndQuery}`, { headers: { 'User-Agent': UA(), Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`MusicBrainz HTTP ${res.status}`);
  return res.json();
}

interface MbArtist {
  id?: string;
  type?: string;
  score?: number;
  name?: string;
  area?: { name?: string };
  'begin-area'?: { name?: string };
  'life-span'?: { begin?: string; ended?: boolean };
  relations?: { type?: string; url?: { resource?: string } }[];
}

async function fetchArtistFacts(name: string, mbid: string | null): Promise<ArtistFacts | null> {
  let id = mbid;
  if (!id) {
    const q = encodeURIComponent(`artist:"${name.replace(/"/g, '')}"`);
    const s = (await mbFetch(`artist?query=${q}&limit=1&fmt=json`)) as { artists?: MbArtist[] };
    const a = s.artists?.[0];
    if (!a?.id || (a.score ?? 0) < 95 || (a.name ?? '').toLowerCase() !== name.toLowerCase()) return null;
    id = a.id;
  }
  const a = (await mbFetch(`artist/${encodeURIComponent(id)}?inc=url-rels&fmt=json`)) as MbArtist;
  const year = Number((a['life-span']?.begin ?? '').slice(0, 4));
  let description: string | null = null;
  const wd = a.relations?.find((r) => r.type === 'wikidata')?.url?.resource?.match(/(Q\d+)$/)?.[1];
  if (wd) {
    try {
      const res = await fetch(`https://www.wikidata.org/wiki/Special:EntityData/${wd}.json`, { headers: { 'User-Agent': UA(), Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const j = (await res.json()) as { entities?: Record<string, { descriptions?: { en?: { value?: string } } }> };
        const d = j.entities?.[wd]?.descriptions?.en?.value;
        if (d && d.length <= 80 && !/disambiguation/i.test(d)) description = d;
      }
    } catch {
      /* description is optional */
    }
  }
  return {
    type: a.type ?? null, area: a['begin-area']?.name ?? a.area?.name ?? null,
    beginYear: Number.isFinite(year) && year > 1000 ? year : null, ended: !!a['life-span']?.ended, description,
  };
}

const inflight = new Map<string, Promise<ArtistFacts | null>>();

/**
 * Online facts about an artist: from the cache, else fetched (waiting at most `waitMs`; a slower lookup finishes in
 * the background and is cached for next time). Null when the toggle is off or nothing is known. Never throws.
 */
export async function artistFacts(name: string | null, mbid: string | null, waitMs = 3000): Promise<ArtistFacts | null> {
  if (!onlineFactsEnabled() || !name) return null;
  const key = `mb:artist:${mbid ?? name.toLowerCase()}`;
  const row = db.get<{ data: string; fetched_at: string }>('SELECT data, fetched_at FROM dj_cache WHERE key = ?', key);
  if (row && Date.now() - Date.parse(row.fetched_at) < TTL) return parseJson<ArtistFacts | null>(row.data, null);
  let p = inflight.get(key);
  if (!p) {
    p = fetchArtistFacts(name, mbid)
      .then((f) => {
        db.run('INSERT INTO dj_cache (key, data, fetched_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at', key, JSON.stringify(f), new Date().toISOString());
        return f;
      })
      .catch((e) => {
        log.info(`Online facts for "${name}" unavailable: ${(e as Error).message}`);
        return null;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), waitMs).unref?.())]);
}
