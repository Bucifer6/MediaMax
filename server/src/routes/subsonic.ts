import { securityEvent } from '../util/securityLog.js';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Item, User } from '@mediamax/shared';
import { db } from '../db.js';
import { config } from '../config.js';
import { authenticateApiKey, getUser, verifySecret } from '../services/auth.js';
import { getItem, getChildren, queryItems, searchItems, setFavorite, reportProgress, allowedLibraryIds, addToContainer, createContainer, removeFromContainer, listContainers } from '../services/items.js';
import { resolveImage } from '../services/images.js';
import { isLocalAddress } from '../services/dlna.js';
import { getLyrics } from '../services/lyrics.js';
import { creditsFor } from '../services/music/credits.js';
import { dispatchListen, dispatchNowPlaying } from '../services/scrobble.js';
import { parseJson } from '../util/misc.js';
import { logger } from '../util/log.js';
import { sha256 } from '../util/ids.js';
import { Pending, sweepExpired, type Failure } from '../util/lockout.js';
import { fileExists } from '../util/fileAsync.js';

/**
 * Subsonic / OpenSubsonic API (music) at /rest/*.view — lets Symfonium, Feishin, play:Sub, Amperfy, Substreamer,
 * Sonos bridges etc. use the Vibe music library. Auth: OpenSubsonic `apiKey` (Vibe API key) or `u`+`p`
 * (password, plain or `enc:` hex). Salted-token auth (`t`+`s`) needs plaintext passwords, which Vibe never stores.
 */
const log = logger('subsonic');
const API_VERSION = '1.16.1';

type Obj = Record<string, unknown>;
class SubsonicError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

function xmlEscape(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/** Subsonic XML: scalars become attributes, objects/arrays become child elements. */
function toXml(name: string, value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => toXml(name, v)).join('');
  if (value === null || typeof value !== 'object') return `<${name}>${xmlEscape(String(value ?? ''))}</${name}>`;
  const attrs: string[] = [];
  const children: string[] = [];
  for (const [k, v] of Object.entries(value as Obj)) {
    if (v === undefined || v === null) continue;
    if (k === 'value' && typeof v === 'string') children.push(xmlEscape(v));
    else if (typeof v === 'object') children.push(toXml(k, v));
    else attrs.push(`${k}="${xmlEscape(String(v))}"`);
  }
  return `<${name}${attrs.length ? ' ' + attrs.join(' ') : ''}${children.length ? `>${children.join('')}</${name}>` : '/>'}`;
}

function send(req: FastifyRequest, reply: FastifyReply, body: Obj = {}, status: 'ok' | 'failed' = 'ok') {
  const f = param(req, 'f');
  const payload = { status, version: API_VERSION, type: 'mediamax', serverVersion: config.version, openSubsonic: true, ...body };
  if (f === 'json' || f === 'jsonp') {
    reply.header('Content-Type', 'application/json');
    return { 'subsonic-response': payload };
  }
  reply.header('Content-Type', 'text/xml; charset=utf-8');
  return `<?xml version="1.0" encoding="UTF-8"?>${toXml('subsonic-response', { xmlns: 'http://subsonic.org/restapi', ...payload }).replace('<subsonic-response ', '<subsonic-response ')}`;
}

function param(req: FastifyRequest, k: string): string | undefined {
  const q = req.query as Obj;
  const b = (req.body ?? {}) as Obj;
  const v = q[k] ?? b[k];
  return Array.isArray(v) ? String(v[0]) : v == null ? undefined : String(v);
}
function params(req: FastifyRequest, k: string): string[] {
  const v = (req.query as Obj)[k] ?? ((req.body ?? {}) as Obj)[k];
  return v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)];
}

const failures = new Map<string, Failure>();
const pending = new Pending();

/**
 * Per-IP limit on failed sign-ins (wrong password, unknown user, invalid API key), on top of the per-account lockout:
 * one address can't spray guesses across many usernames. Only failures count, so a client syncing thousands of
 * covers and streams with valid credentials is never slowed down.
 */
const IP_MAX_FAILURES = 30;
const IP_WINDOW_MS = 15 * 60000;
const ipFailures = new Map<string, Failure>();
const ipKey = (req: FastifyRequest) => `ip:${req.ip ?? 'unknown'}`;
function checkIp(req: FastifyRequest) {
  const k = ipKey(req);
  const f = ipFailures.get(k);
  if ((f && f.until > Date.now() ? f.n : 0) + pending.count(k) >= IP_MAX_FAILURES) throw new SubsonicError(40, 'Too many failed attempts, try later');
}
function recordIpFailure(req: FastifyRequest) {
  const k = ipKey(req);
  const cur = ipFailures.get(k);
  if (!cur || cur.until < Date.now()) {
    sweepExpired(ipFailures);
    ipFailures.set(k, { n: 1, until: Date.now() + IP_WINDOW_MS });
  } else cur.n++;
}

/**
 * Subsonic clients send u+p on every request; an scrypt check (~40 ms CPU) each time would starve the server during
 * a library sync. Successful checks are remembered for a while, keyed by user + presented secret + stored hash, so a
 * password change (new hash) or a different password never hits an old entry. Failures are never cached.
 */
const VERIFIED_TTL = 10 * 60000;
const VERIFIED_MAX = 1000;
const verified = new Map<string, number>(); // key → expiry; insertion order = age
const verifiedKey = (userId: string, secret: string, hash: string) => sha256(`${userId}\0${secret}\0${hash}`);
async function verifyCached(userId: string, secret: string, hash: string): Promise<boolean> {
  const k = verifiedKey(userId, secret, hash);
  const exp = verified.get(k);
  if (exp && exp > Date.now()) return true;
  if (exp) verified.delete(k);
  if (!(await verifySecret(secret, hash))) return false;
  while (verified.size >= VERIFIED_MAX) verified.delete(verified.keys().next().value!);
  verified.set(k, Date.now() + VERIFIED_TTL);
  return true;
}
/** Tests only. */
export const _subsonicAuthCache = { size: () => verified.size, clear: () => { verified.clear(); ipFailures.clear(); failures.clear(); }, max: VERIFIED_MAX, ipMax: IP_MAX_FAILURES };

async function authenticate(req: FastifyRequest): Promise<User> {
  const apiKey = param(req, 'apiKey');
  if (apiKey) {
    checkIp(req);
    const ctx = authenticateApiKey(apiKey);
    if (!ctx) {
      recordIpFailure(req);
      throw new SubsonicError(44, 'Invalid API key');
    }
    return ctx.user;
  }
  const u = param(req, 'u');
  if (param(req, 't')) throw new SubsonicError(41, 'Token authentication is not supported. Use your password (or an API key with the apiKey parameter).');
  let p = param(req, 'p');
  if (!u || p == null) throw new SubsonicError(10, 'Required parameter is missing');
  const key = `s:${u.toLowerCase()}`;
  const f = failures.get(key);
  if ((f && f.until > Date.now() ? f.n : 0) + pending.count(key) >= 10) throw new SubsonicError(40, 'Too many failed attempts, try later');
  checkIp(req);
  if (p.startsWith('enc:')) p = Buffer.from(p.slice(4), 'hex').toString('utf8');
  const secret = p;
  const row = await pending.run(key, () => pending.run(ipKey(req), async () => {
    const row = db.get('SELECT * FROM users WHERE username = ? AND disabled = 0', u);
    const passwordOk = !!row?.password_hash && (await verifyCached(row.id, secret, row.password_hash));
    if (!passwordOk || row!.totp_enabled) {
      const cur = failures.get(key);
      if (!cur || cur.until < Date.now()) sweepExpired(failures);
      failures.set(key, !cur || cur.until < Date.now() ? { n: 1, until: Date.now() + 15 * 60000 } : { ...cur, n: cur.n + 1 });
      recordIpFailure(req);
      securityEvent('AUTH_FAIL', req.ip, { user: u, reason: 'subsonic' });
      // Two-factor status is only revealed to someone who already knows the password.
      throw new SubsonicError(40, passwordOk ? 'This account uses two-factor sign-in; create an API key and use the apiKey parameter' : 'Wrong username or password');
    }
    return row;
  }));
  failures.delete(key);
  return getUser(row.id);
}

/* ------------------------------- mapping ------------------------------ */

const year = (i: Item) => i.year ?? undefined;
const secs = (ms: number | null | undefined) => (ms ? Math.round(ms / 1000) : undefined);
const starred = (i: Item) => (i.userData.favorite ? i.userData.lastPlayedAt ?? i.addedAt : undefined);

/** OpenSubsonic ArtistID3 references for a track's credited artists (id only when the artist is in the library). */
function creditedArtists(t: Item): Obj[] {
  const credits = t.music?.credits ?? creditsFor([t.id]).get(t.id) ?? [];
  if (!credits.length) return t.grandparentId ? [{ id: t.grandparentId, name: t.grandparentTitle ?? '' }] : [];
  return credits.map((c) => ({ id: c.artistId ?? undefined, name: c.name, musicBrainzId: c.mbid ?? undefined }));
}

/** "1999-05-01" / "1999" → OpenSubsonic ItemDate. */
function itemDate(d: string | null | undefined, year?: number | null): Obj | undefined {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(d ?? '');
  if (m) return { year: Number(m[1]), month: m[2] ? Number(m[2]) : undefined, day: m[3] ? Number(m[3]) : undefined };
  return year ? { year } : undefined;
}

function songOf(t: Item): Obj {
  const m = db.get('SELECT * FROM media WHERE item_id = ? LIMIT 1', t.id);
  const artists = creditedArtists(t);
  const display = t.music?.displayArtist ?? t.grandparentTitle ?? undefined;
  const suffix = (m?.container ?? (m?.path ? path.extname(m.path).slice(1) : 'mp3')).toLowerCase();
  const ct: Record<string, string> = { mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav' };
  return {
    id: t.id, parent: t.parentId ?? undefined, isDir: false, title: t.title, album: t.parentTitle ?? undefined, artist: display,
    track: t.index ?? undefined, discNumber: t.parentIndex ?? undefined, year: year(t), genre: t.genres[0], coverArt: t.parentId ?? t.id,
    size: m?.size ?? undefined, contentType: ct[suffix] ?? 'audio/mpeg', suffix, duration: secs(t.durationMs), bitRate: m?.bitrate ?? undefined,
    path: m?.path ? path.basename(m.path) : undefined, albumId: t.parentId ?? undefined, artistId: t.grandparentId ?? undefined, type: 'music',
    mediaType: 'song', starred: starred(t), playCount: t.userData.playCount, played: t.userData.lastPlayedAt ?? undefined,
    userRating: t.userData.rating ? Math.round(t.userData.rating / 2) : undefined, created: t.addedAt,
    // OpenSubsonic extras
    genres: t.genres.map((g) => ({ name: g })), displayArtist: display, displayAlbumArtist: t.grandparentTitle ?? undefined,
    musicBrainzId: t.externalIds.musicbrainzRecording ?? '', artists,
    albumArtists: t.grandparentId ? [{ id: t.grandparentId, name: t.grandparentTitle ?? '' }] : [],
    replayGain: t.replayGain ? { trackGain: t.replayGain.trackGainDb ?? undefined, albumGain: t.replayGain.albumGainDb ?? undefined, trackPeak: t.replayGain.trackPeak ?? undefined, albumPeak: t.replayGain.albumPeak ?? undefined } : undefined,
  };
}
function albumOf(a: Item): Obj {
  const mu = a.music ?? {};
  const discTitles = Object.entries(mu.discTitles ?? {}).map(([disc, title]) => ({ disc: Number(disc), title }));
  return {
    musicBrainzId: a.externalIds.musicbrainzRelease ?? '',
    releaseTypes: (mu.releaseTypes ?? []).map((x) => x.replace(/^ep$/, 'EP').replace(/^\w/, (c) => c.toUpperCase())),
    originalReleaseDate: itemDate(mu.originalDate, mu.originalYear),
    recordLabels: mu.label ? [{ name: mu.label }] : [],
    isCompilation: !!mu.compilation,
    discTitles,
    artists: a.parentId ? [{ id: a.parentId, name: a.parentTitle ?? '' }] : [],
    id: a.id, name: a.title, title: a.title, album: a.title, artist: a.parentTitle ?? undefined, artistId: a.parentId ?? undefined, coverArt: a.id,
    songCount: a.childCount, duration: secs(a.durationMs) ?? 0, created: a.addedAt, year: year(a), genre: a.genres[0], starred: starred(a),
    playCount: a.userData.playCount, isDir: true, parent: a.parentId ?? undefined, genres: a.genres.map((g) => ({ name: g })),
    displayArtist: a.parentTitle ?? undefined, userRating: a.userData.rating ? Math.round(a.userData.rating / 2) : undefined, mediaType: 'album',
  };
}
function artistOf(a: Item): Obj {
  return { id: a.id, name: a.title, coverArt: a.id, artistImageUrl: undefined, albumCount: a.childCount, starred: starred(a), mediaType: 'artist', musicBrainzId: a.externalIds.musicbrainzArtist ?? '' };
}

const musicLibraries = (u: User) => db.all("SELECT * FROM libraries WHERE type = 'music' ORDER BY sort_order, name").filter((l) => allowedLibraryIds(u).includes(l.id));

function ensureType(u: User, id: string | undefined, type: Item['type']): Item {
  if (!id) throw new SubsonicError(10, 'Required parameter is missing: id');
  let it: Item;
  try {
    it = getItem(u, id, false);
  } catch {
    throw new SubsonicError(70, 'The requested data was not found');
  }
  if (it.type !== type) throw new SubsonicError(70, 'The requested data was not found');
  return it;
}

/* -------------------------------- routes ------------------------------ */

export default async function subsonicRoutes(app: FastifyInstance) {
  const handlers: Record<string, (req: FastifyRequest, reply: FastifyReply, u: User) => unknown> = {
    ping: () => ({}),
    getLicense: () => ({ license: { valid: true, email: 'mediamax@localhost', licenseExpires: '2099-12-31T00:00:00' } }),
    getOpenSubsonicExtensions: () => ({ openSubsonicExtensions: [{ name: 'apiKeyAuthentication', versions: [1] }, { name: 'songLyrics', versions: [1] }, { name: 'formPost', versions: [1] }] }),
    getUser: (_r, _p, u) => ({
      user: { username: u.username, email: '', scrobblingEnabled: true, adminRole: u.isAdmin, settingsRole: true, downloadRole: u.allowDownloads, uploadRole: false,
        playlistRole: true, coverArtRole: true, commentRole: false, podcastRole: false, streamRole: true, jukeboxRole: false, shareRole: false, folder: musicLibraries(u).map((l) => l.id) },
    }),
    getMusicFolders: (_r, _p, u) => ({ musicFolders: { musicFolder: musicLibraries(u).map((l) => ({ id: l.id, name: l.name })) } }),
    getGenres: (_r, _p, u) => {
      const libs = musicLibraries(u).map((l) => l.id);
      if (!libs.length) return { genres: {} };
      const rows = db.all(`SELECT j.value g, SUM(CASE WHEN i.type = 'track' THEN 1 ELSE 0 END) songs, SUM(CASE WHEN i.type = 'album' THEN 1 ELSE 0 END) albums
        FROM items i, json_each(i.genres) j WHERE i.library_id IN (${libs.map(() => '?').join(',')}) GROUP BY j.value ORDER BY j.value`, ...libs);
      return { genres: { genre: rows.map((r) => ({ value: r.g, songCount: r.songs, albumCount: r.albums })) } };
    },
    getArtists: (req, _p, u) => {
      const folder = param(req, 'musicFolderId');
      const libs = musicLibraries(u).filter((l) => !folder || l.id === folder);
      const artists = libs.flatMap((l) => queryItems(u, { libraryId: l.id, type: 'artist', sort: 'title', limit: 500 }).items);
      const groups = new Map<string, Obj[]>();
      for (const a of artists) {
        const letter = /^[a-z]/i.test(a.sortTitle) ? a.sortTitle[0].toUpperCase() : '#';
        groups.set(letter, [...(groups.get(letter) ?? []), artistOf(a)]);
      }
      return { artists: { ignoredArticles: 'The A An', index: [...groups.entries()].map(([name, artist]) => ({ name, artist })) } };
    },
    getIndexes: (req, reply, u) => {
      const r = handlers.getArtists(req, reply, u) as { artists: Obj };
      return { indexes: { ...r.artists, lastModified: Date.now() } };
    },
    getArtist: (req, _p, u) => {
      const a = ensureType(u, param(req, 'id'), 'artist');
      const albums = getChildren(u, a.id, { sort: 'year', limit: 500 }).items;
      return { artist: { ...artistOf(a), album: albums.map(albumOf) } };
    },
    getAlbum: (req, _p, u) => {
      const a = ensureType(u, param(req, 'id'), 'album');
      const songs = getChildren(u, a.id, { sort: 'index', limit: 2000 }).items;
      return { album: { ...albumOf(a), song: songs.map(songOf) } };
    },
    getSong: (req, _p, u) => ({ song: songOf(ensureType(u, param(req, 'id'), 'track')) }),
    getMusicDirectory: (req, _p, u) => {
      const id = param(req, 'id');
      if (!id) throw new SubsonicError(10, 'Required parameter is missing: id');
      const lib = musicLibraries(u).find((l) => l.id === id);
      if (lib) {
        const artists = queryItems(u, { libraryId: lib.id, type: 'artist', sort: 'title', limit: 500 }).items;
        return { directory: { id, name: lib.name, child: artists.map((a) => ({ id: a.id, parent: id, isDir: true, title: a.title, artist: a.title, coverArt: a.id })) } };
      }
      let it: Item;
      try {
        it = getItem(u, id, false);
      } catch {
        throw new SubsonicError(70, 'The requested data was not found');
      }
      const kids = getChildren(u, id, { sort: it.type === 'album' ? 'index' : 'year', limit: 2000 }).items;
      return { directory: { id, name: it.title, parent: it.parentId ?? it.libraryId ?? undefined, child: kids.map((k) => (k.type === 'track' ? songOf(k) : { ...albumOf(k), title: k.title })) } };
    },
    getAlbumList2: (req, _p, u) => {
      const type = param(req, 'type') ?? 'newest';
      const size = Math.min(500, Number(param(req, 'size') ?? 10) || 10);
      const offset = Number(param(req, 'offset') ?? 0) || 0;
      const folder = param(req, 'musicFolderId');
      const libs = musicLibraries(u).filter((l) => !folder || l.id === folder);
      if (!libs.length) return { albumList2: {} };
      const sortMap: Record<string, [any, 'asc' | 'desc']> = {
        newest: ['addedAt', 'desc'], recent: ['lastPlayed', 'desc'], frequent: ['lastPlayed', 'desc'], random: ['random', 'asc'],
        alphabeticalByName: ['title', 'asc'], alphabeticalByArtist: ['title', 'asc'], highest: ['rating', 'desc'], starred: ['title', 'asc'], byYear: ['year', 'asc'], byGenre: ['title', 'asc'],
      };
      const [sort, order] = sortMap[type] ?? sortMap.newest;
      const q: Record<string, unknown> = { type: 'album', sort, order, limit: size, offset };
      if (libs.length === 1) q.libraryId = libs[0].id;
      if (type === 'starred') q.favorite = true;
      if (type === 'byGenre') q.genre = param(req, 'genre');
      let items = queryItems(u, q as any).items.filter((a) => libs.some((l) => l.id === a.libraryId));
      if (type === 'recent' || type === 'frequent') items = items.filter((a) => a.userData.lastPlayedAt);
      if (type === 'byYear') {
        const from = Number(param(req, 'fromYear') ?? 0);
        const to = Number(param(req, 'toYear') ?? 9999);
        items = items.filter((a) => a.year && a.year >= Math.min(from, to) && a.year <= Math.max(from, to));
      }
      return { albumList2: { album: items.map(albumOf) } };
    },
    getRandomSongs: (req, _p, u) => {
      const size = Math.min(500, Number(param(req, 'size') ?? 10) || 10);
      const songs = queryItems(u, { type: 'track', sort: 'random', limit: size, genre: param(req, 'genre') }).items;
      return { randomSongs: { song: songs.map(songOf) } };
    },
    getSongsByGenre: (req, _p, u) => {
      const songs = queryItems(u, { type: 'track', genre: param(req, 'genre'), limit: Math.min(500, Number(param(req, 'count') ?? 10) || 10), offset: Number(param(req, 'offset') ?? 0) || 0 }).items;
      return { songsByGenre: { song: songs.map(songOf) } };
    },
    search3: (req, _p, u) => {
      const q = (param(req, 'query') ?? '').replace(/^"|"$/g, '').trim();
      const ac = Number(param(req, 'artistCount') ?? 20), bc = Number(param(req, 'albumCount') ?? 20), sc = Number(param(req, 'songCount') ?? 20);
      // An empty query lists everything (clients use this to sync the library).
      const pick = (type: string, n: number, off: string) => (q ? searchItems(u, q, 100).filter((i) => i.type === type).slice(0, n) : queryItems(u, { type, sort: 'title', limit: Math.min(n, 500), offset: Number(param(req, off) ?? 0) || 0 }).items);
      return { searchResult3: { artist: pick('artist', ac, 'artistOffset').map(artistOf), album: pick('album', bc, 'albumOffset').map(albumOf), song: pick('track', sc, 'songOffset').map(songOf) } };
    },
    getStarred2: (_r, _p, u) => {
      const fav = (type: string) => queryItems(u, { type, favorite: true, limit: 500 }).items;
      return { starred2: { artist: fav('artist').map(artistOf), album: fav('album').map(albumOf), song: fav('track').map(songOf) } };
    },
    star: (req, _p, u) => {
      for (const id of [...params(req, 'id'), ...params(req, 'albumId'), ...params(req, 'artistId')]) setFavorite(u, id, true);
      return {};
    },
    unstar: (req, _p, u) => {
      for (const id of [...params(req, 'id'), ...params(req, 'albumId'), ...params(req, 'artistId')]) setFavorite(u, id, false);
      return {};
    },
    scrobble: (req, _p, u) => {
      const submission = param(req, 'submission') !== 'false';
      const times = params(req, 'time').map(Number);
      params(req, 'id').forEach((id, i) => {
        try {
          const it = getItem(u, id, false);
          if (submission) {
            reportProgress(u, id, it.durationMs ?? 0, it.durationMs, 'stopped');
            // The client decided the track counts as played; `time` (ms) is when it was listened to.
            const at = times[i] > 0 ? times[i] : Date.now() - (it.durationMs ?? 0);
            void dispatchListen(u.id, id, at, it.durationMs ?? 240000);
          } else {
            reportProgress(u, id, 1000, it.durationMs, 'playing');
            void dispatchNowPlaying(u.id, id);
          }
        } catch {
          /* ignore unknown ids */
        }
      });
      return {};
    },
    getPlaylists: (_r, _p, u) => ({
      playlists: { playlist: listContainers(u, 'playlist').map((p) => ({ id: p.id, name: p.title, owner: u.username, public: false, songCount: p.childCount, duration: 0, created: p.addedAt, changed: p.addedAt, coverArt: p.id })) },
    }),
    getPlaylist: (req, _p, u) => {
      const p = ensureType(u, param(req, 'id'), 'playlist');
      const entries = getChildren(u, p.id, { limit: 2000 }).items.filter((i) => i.type === 'track');
      return { playlist: { id: p.id, name: p.title, owner: u.username, public: false, songCount: entries.length, duration: entries.reduce((a, s) => a + (secs(s.durationMs) ?? 0), 0), created: p.addedAt, changed: p.addedAt, coverArt: p.id, entry: entries.map(songOf) } };
    },
    createPlaylist: (req, reply, u) => {
      const existing = param(req, 'playlistId');
      const songs = params(req, 'songId');
      let id = existing;
      if (existing) {
        ensureType(u, existing, 'playlist');
        db.run('DELETE FROM collection_items WHERE collection_id = ?', existing);
        addToContainer(existing, songs);
      } else {
        id = createContainer('playlist', param(req, 'name') ?? 'New playlist', u.id, songs);
      }
      return handlers.getPlaylist({ ...req, query: { ...(req.query as Obj), id } } as FastifyRequest, reply, u);
    },
    updatePlaylist: (req, _p, u) => {
      const p = ensureType(u, param(req, 'playlistId'), 'playlist');
      const name = param(req, 'name');
      if (name) db.run('UPDATE items SET title = ? WHERE id = ?', name, p.id);
      const idx = params(req, 'songIndexToRemove').map(Number).sort((a, b) => b - a);
      if (idx.length) {
        const entries = getChildren(u, p.id, { limit: 2000 }).items;
        for (const i of idx) if (entries[i]) removeFromContainer(p.id, entries[i].id);
      }
      addToContainer(p.id, params(req, 'songIdToAdd'));
      return {};
    },
    deletePlaylist: (req, _p, u) => {
      const p = ensureType(u, param(req, 'id'), 'playlist');
      db.run('DELETE FROM items WHERE id = ? AND owner_id = ?', p.id, u.id);
      return {};
    },
    getLyricsBySongId: async (req, _p, u) => {
      const s = ensureType(u, param(req, 'id'), 'track');
      const l = await getLyrics(s.id);
      return { lyricsList: { structuredLyrics: l ? [{ lang: 'xxx', synced: l.synced, displayArtist: s.grandparentTitle ?? undefined, displayTitle: s.title, line: l.lines.map((x) => ({ start: x.startMs ?? undefined, value: x.text })) }] : [] } };
    },
    getLyrics: async (req, _p, u) => {
      const title = param(req, 'title');
      const hit = title ? searchItems(u, title, 20).find((i) => i.type === 'track' && (!param(req, 'artist') || i.grandparentTitle === param(req, 'artist'))) : undefined;
      const l = hit ? await getLyrics(hit.id) : null;
      return { lyrics: { artist: hit?.grandparentTitle ?? undefined, title: hit?.title, value: l ? l.lines.map((x) => x.text).join('\n') : '' } };
    },
    getNowPlaying: () => ({ nowPlaying: {} }),
    getScanStatus: () => ({ scanStatus: { scanning: false, count: db.get<{ n: number }>("SELECT COUNT(*) n FROM items WHERE type = 'track'")!.n } }),
  };

  // Binary endpoints
  const stream = async (req: FastifyRequest, reply: FastifyReply, u: User) => {
    if (!u.allowRemote && !u.isAdmin && req.ip && !isLocalAddress(req.ip)) throw new SubsonicError(50, 'Your account can only stream on the home network');
    const t = ensureType(u, param(req, 'id'), 'track');
    const m = db.get('SELECT * FROM media WHERE item_id = ? LIMIT 1', t.id);
    if (!m?.path || !(await fileExists(m.path))) throw new SubsonicError(70, 'File not found');
    const maxBitRate = Number(param(req, 'maxBitRate') ?? 0);
    const format = param(req, 'format');
    const needTranscode = (format && format !== 'raw' && format !== m.container) || (maxBitRate > 0 && (m.bitrate ?? 0) > maxBitRate);
    if (!needTranscode || !u.allowTranscode) {
      const { sendFileRange } = await import('./playback.js');
      const ct: Record<string, string> = { mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', aac: 'audio/aac' };
      return sendFileRange(req, reply, m.path, ct[(m.container ?? '').toLowerCase()] ?? 'application/octet-stream');
    }
    const target = format === 'opus' ? 'opus' : 'mp3';
    const kbps = Math.max(32, Math.min(320, maxBitRate || 192));
    const args = ['-v', 'error', '-i', m.path, '-map', '0:a:0', '-vn', ...(target === 'opus' ? ['-c:a', 'libopus', '-b:a', `${kbps}k`, '-f', 'ogg'] : ['-c:a', 'libmp3lame', '-b:a', `${kbps}k`, '-f', 'mp3']), 'pipe:1'];
    const p = spawn(config.ffmpeg, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    req.raw.on('close', () => p.kill('SIGKILL'));
    reply.header('Content-Type', target === 'opus' ? 'audio/ogg' : 'audio/mpeg');
    return reply.send(p.stdout);
  };
  const coverArt = async (req: FastifyRequest, reply: FastifyReply, u: User) => {
    const id = param(req, 'id');
    if (!id) throw new SubsonicError(10, 'Required parameter is missing: id');
    let imgId: string | null = null;
    try {
      const it = getItem(u, id.replace(/^(al|ar|tr|pl)-/, ''), false);
      imgId = (it.posterUrl ?? it.thumbUrl)?.split('/').pop() ?? null;
    } catch {
      /* fall through */
    }
    if (!imgId) throw new SubsonicError(70, 'Cover art not found');
    const img = await resolveImage(imgId, Number(param(req, 'size') ?? 0) || undefined);
    reply.type(img.mime).header('Cache-Control', 'public, max-age=604800');
    return fs.createReadStream(img.path);
  };

  const handle = async (req: FastifyRequest<{ Params: { method: string } }>, reply: FastifyReply) => {
    const method = req.params.method.replace(/\.view$/, '');
    try {
      const u = await authenticate(req);
      if (method === 'stream' || method === 'download') return await stream(req, reply, u);
      if (method === 'getCoverArt') return await coverArt(req, reply, u);
      const h = handlers[method];
      if (!h) throw new SubsonicError(0, `Method "${method}" is not supported by Vibe`);
      return send(req, reply, (await h(req, reply, u)) as Obj);
    } catch (e) {
      const code = e instanceof SubsonicError ? e.code : 0;
      if (!(e instanceof SubsonicError)) log.warn(`${method} failed: ${(e as Error).message}`);
      return send(req, reply, { error: { code, message: (e as Error).message } }, 'failed');
    }
  };
  // OpenSubsonic "formPost": accept urlencoded bodies.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of new URLSearchParams(String(body))) out[k] = k in out ? ([] as string[]).concat(out[k], v) : v;
    done(null, out);
  });
  app.get('/rest/:method', handle);
  app.post('/rest/:method', handle);
  void parseJson;
}
