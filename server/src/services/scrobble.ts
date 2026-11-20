import { db } from '../db.js';
import { parseJson } from '../util/misc.js';
import { logger } from '../util/log.js';
import { bus } from './events.js';
import type { PlaySession } from './playback.js';
import { isMbid, parseMbTags } from './music/tags.js';

/**
 * One dispatcher for scrobbling services (Last.fm, ListenBrainz): every source of "now playing" and "listened"
 * events — MediaMax players and the DJ mix player (playback sessions), Subsonic clients (scrobble endpoint) — goes
 * through here, so each service gets the same events. Services decide themselves whether a listen counts.
 */

const log = logger('scrobble');

export interface ScrobbleTrack {
  itemId: string;
  title: string;
  /** Track artist as tagged ("A feat. B"). */
  artist: string;
  album: string | null;
  albumArtist: string | null;
  trackNumber: number | null;
  durationMs: number | null;
  recordingMbid: string | null;
  releaseMbid: string | null;
  releaseGroupMbid: string | null;
  releaseTrackMbid: string | null;
  artistMbids: string[];
  workMbids: string[];
}

export interface Scrobbler {
  id: string;
  nowPlaying(userId: string, t: ScrobbleTrack): Promise<void>;
  /** A finished listen: `startedAt` (ms) is when playback began, `listenedMs` how long it was listened to. */
  listen(userId: string, t: ScrobbleTrack, startedAt: number, listenedMs: number): Promise<void>;
}

const scrobblers: Scrobbler[] = [];
export function registerScrobbler(s: Scrobbler) {
  const i = scrobblers.findIndex((x) => x.id === s.id);
  if (i >= 0) scrobblers[i] = s;
  else scrobblers.push(s);
}

/**
 * Last.fm and ListenBrainz rule: a listen counts once half the track or 4 minutes were played, whichever is less.
 * Last.fm also ignores tracks shorter than 30 seconds (`minTrackMs`). Unknown durations need 4 minutes.
 */
export function listenCounts(durationMs: number | null | undefined, listenedMs: number, minTrackMs = 0): boolean {
  const dur = Number(durationMs) || 0;
  if (dur && dur < minTrackMs) return false;
  return listenedMs >= Math.min(dur ? dur / 2 : 240000, 240000);
}

/** Everything the services need about a library track (tags, MBIDs, AcoustID identifications). */
export function trackForScrobble(itemId: string): ScrobbleTrack | null {
  const t = db.get(`SELECT i.title, i.idx, i.duration_ms, i.extra, i.external_ids, i.provider_meta, p.title album, p.external_ids p_ids, g.title artist, g.external_ids g_ids
    FROM items i LEFT JOIN items p ON p.id = i.parent_id LEFT JOIN items g ON g.id = i.grandparent_id WHERE i.id = ? AND i.type = 'track'`, itemId);
  if (!t) return null;
  const extra = parseJson<{ tags?: Record<string, string | null>; mbTags?: Record<string, string> }>(t.extra, {});
  const tags = extra.tags ?? {};
  const mb = parseMbTags(extra.mbTags ?? {});
  const ids = parseJson<Record<string, string>>(t.external_ids, {});
  const pids = parseJson<Record<string, string>>(t.p_ids, {});
  const gids = parseJson<Record<string, string>>(t.g_ids, {});
  const pm = parseJson<{ identified?: { artist?: string }; credits?: { mbid: string | null }[] }>(t.provider_meta, {});
  const credited = db.all<{ mbid: string | null }>('SELECT mbid FROM track_artists WHERE track_id = ? ORDER BY position', itemId).map((r) => r.mbid).filter(isMbid);
  const artistMbids = mb.artists.length ? mb.artists : credited.length ? credited : gids.musicbrainzArtist ? [gids.musicbrainzArtist] : [];
  return {
    itemId,
    title: t.title,
    artist: tags.artist || pm.identified?.artist || t.artist || 'Unknown Artist',
    album: t.album ?? null,
    albumArtist: tags.album_artist || t.artist || null,
    trackNumber: t.idx ?? null,
    durationMs: t.duration_ms ?? null,
    recordingMbid: ids.musicbrainzRecording ?? null,
    releaseMbid: pids.musicbrainzRelease ?? null,
    releaseGroupMbid: pids.musicbrainzReleaseGroup ?? null,
    releaseTrackMbid: ids.musicbrainzReleaseTrack ?? null,
    artistMbids,
    workMbids: ids.musicbrainzWork ? [ids.musicbrainzWork] : [],
  };
}

async function each(fn: (s: Scrobbler) => Promise<void>) {
  await Promise.all(scrobblers.map((s) => fn(s).catch((e) => log.debug(`${s.id}: ${(e as Error).message}`))));
}

export async function dispatchNowPlaying(userId: string, itemId: string) {
  const t = trackForScrobble(itemId);
  if (t) await each((s) => s.nowPlaying(userId, t));
}

export async function dispatchListen(userId: string, itemId: string, startedAt: number, listenedMs: number) {
  const t = trackForScrobble(itemId);
  if (t) await each((s) => s.listen(userId, t, startedAt, listenedMs));
}

let started = false;
/** Playback sessions (web/mobile/TV players, DJ mix decks) → scrobblers. */
export function initScrobbling() {
  if (started) return;
  started = true;
  bus.on('playback.start', (s: PlaySession) => {
    if (s.itemId && !s.preview) void dispatchNowPlaying(s.ctx.user.id, s.itemId);
  });
  bus.on('playback.stop', (s: PlaySession) => {
    if (!s.itemId || s.preview) return;
    // Until the player's last sign of life, not "now": a session reaped minutes after the app was closed (or a
    // stop sent long after) must not turn a few seconds of listening into a scrobble.
    const listened = Math.max(s.positionMs, Math.min(Date.now(), s.lastActivity) - s.startedAt);
    void dispatchListen(s.ctx.user.id, s.itemId, s.startedAt, listened);
  });
}
