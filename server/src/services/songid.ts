/**
 * "What's this song?" for the second screen.
 *
 * Preferred path (no microphone): fingerprint the playing title's own audio around the current position —
 * ffmpeg cuts ~12 s of the selected audio track to WAV, Chromaprint (fpcalc, or ffmpeg's chromaprint muxer) makes a
 * fingerprint, and the existing AcoustID integration looks it up (its HTTP responses are cached for 30 days; matches
 * are also cached here per title and position). Fallback: a short microphone recording uploaded by the phone.
 *
 * The match is then looked up in the requesting user's music library (MusicBrainz recording id, else title + artist).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AcoustIdCandidate, SongIdResponse, SongMatch, User } from '@mediamax/shared';
import { config } from '../config.js';
import { db } from '../db.js';
import { HttpError, badRequest } from '../util/errors.js';
import { newId } from '../util/ids.js';
import { imageUrl } from './images.js';
import { accessClause, assertCanSee } from './items.js';
import { fingerprint, lookup, unavailableReason } from './music/acoustid.js';

export const SONG_ID = {
  /** Length of the snippet cut from the file. */
  clipMs: 12_000,
  /** Matches are cached per title, audio track and position bucket. */
  bucketMs: 15_000,
  cacheTtlMs: 24 * 3600_000,
  cacheMax: 500,
  /** Identifications per user per minute (each runs ffmpeg + an AcoustID request). */
  perMinute: 8,
};

const cache = new Map<string, { at: number; match: SongMatch | null }>();
const recent = new Map<string, number[]>();
/** Tests only. */
export function _resetSongId() {
  cache.clear();
  recent.clear();
}

function throttle(userId: string) {
  const now = Date.now();
  const list = (recent.get(userId) ?? []).filter((t) => t > now - 60_000);
  if (list.length >= SONG_ID.perMinute) throw new HttpError(429, 'Too many song lookups — try again in a minute', 'rate_limited');
  list.push(now);
  recent.set(userId, list);
}

function run(cmd: string, args: string[], timeoutMs = 30_000): Promise<{ code: number | null; err: string }> {
  return new Promise((resolve) => {
    let err = '';
    let p;
    try {
      p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, err: (e as Error).message });
    }
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, err: e.message });
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, err });
    });
  });
}

/** Cut `clipMs` of audio starting at `startMs` (selected audio stream, else the first) into a mono-mixed WAV file. */
export async function extractClip(file: string, startMs: number, out: string, audioStream?: number | null): Promise<void> {
  const map = audioStream != null && Number.isInteger(audioStream) && audioStream >= 0 ? `0:${audioStream}` : '0:a:0';
  const args = ['-hide_banner', '-v', 'error', '-nostdin', '-ss', (Math.max(0, startMs) / 1000).toFixed(3), '-i', file,
    '-t', (SONG_ID.clipMs / 1000).toFixed(3), '-map', map, '-vn', '-sn', '-ac', '2', '-ar', '44100', '-f', 'wav', '-y', out];
  const r = await run(config.ffmpeg, args);
  if (r.code !== 0 || !fs.existsSync(out) || fs.statSync(out).size < 1000) throw new Error(`Could not read the audio: ${r.err.trim().slice(0, 200) || `ffmpeg exit ${r.code}`}`);
}

/** The best usable AcoustID candidate (with a title), or null. */
export function bestCandidate(cands: AcoustIdCandidate[], minScore = 0.4): AcoustIdCandidate | null {
  return cands.find((c) => c.title && c.score >= minScore) ?? null;
}

/** Find the recording in `user`'s music library: MusicBrainz recording id first, then title + artist. */
export function libraryMatch(user: User, c: Pick<AcoustIdCandidate, 'recordingMbid' | 'title' | 'artists'>): SongMatch['libraryTrack'] {
  const a = accessClause(user, 'i');
  const sel = `SELECT i.id, i.title, i.parent_id, i.grandparent_id, COALESCE(i.poster, p.poster) poster FROM items i LEFT JOIN items p ON p.id = i.parent_id
    LEFT JOIN items g ON g.id = i.grandparent_id WHERE i.type = 'track' AND ${a.sql}`;
  let row = c.recordingMbid ? db.get(`${sel} AND json_extract(i.external_ids, '$.musicbrainzRecording') = ? LIMIT 1`, ...a.params, c.recordingMbid) : undefined;
  if (!row && c.title) {
    const names = c.artists.map((x) => x.name.toLowerCase()).filter(Boolean);
    const rows = db.all(`${sel.replace('COALESCE(i.poster, p.poster) poster', "COALESCE(i.poster, p.poster) poster, g.title artist, json_extract(i.extra, '$.tags.artist') tagartist")} AND i.title = ? COLLATE NOCASE LIMIT 20`, ...a.params, c.title);
    row = rows.find((r) => !names.length || names.some((n) => [r.artist, r.tagartist].some((x) => typeof x === 'string' && x.toLowerCase().includes(n)))) ?? undefined;
  }
  if (!row) return null;
  return { id: row.id, title: row.title, albumId: row.parent_id ?? null, artistId: row.grandparent_id ?? null, posterUrl: imageUrl(row.poster) };
}

function toMatch(user: User, c: AcoustIdCandidate): SongMatch {
  const libraryTrack = libraryMatch(user, c);
  return {
    title: c.title ?? 'Unknown', artists: c.artists.map((a) => a.name).filter(Boolean), album: c.releaseGroup?.title ?? null,
    coverUrl: libraryTrack?.posterUrl ?? (c.releaseGroup ? `https://coverartarchive.org/release-group/${c.releaseGroup.mbid}/front-250` : null),
    recordingMbid: c.recordingMbid, score: Math.round(c.score * 100) / 100, libraryTrack,
  };
}

async function identifyWav(wav: string): Promise<AcoustIdCandidate | null> {
  const fp = await fingerprint(wav, SONG_ID.clipMs);
  return bestCandidate(await lookup(fp.fingerprint, fp.duration || SONG_ID.clipMs / 1000));
}

const tmpFile = (ext: string) => path.join(os.tmpdir(), `mm-songid-${process.pid}-${newId()}.${ext}`);

/**
 * Identify the music playing in a title at `positionMs`, from the media file itself. `viewer` must be allowed to see
 * the title (the TV's user for a paired phone); `libraryUser` is whose music library the match is looked up in.
 */
export async function identifyAt(viewer: User, libraryUser: User, itemId: string, positionMs: number, audioStream?: number | null): Promise<SongIdResponse> {
  assertCanSee(viewer, itemId);
  const pos = Math.max(0, Math.round(Number(positionMs) || 0));
  const base = { source: 'file' as const, positionMs: pos };
  const reason = await unavailableReason();
  if (reason) return { available: false, reason, match: null, cached: false, ...base };
  const m = db.get<{ path: string | null; duration_ms: number | null }>("SELECT path, duration_ms FROM media WHERE item_id = ? AND path IS NOT NULL AND path NOT LIKE 'http%' ORDER BY COALESCE(width,0) DESC LIMIT 1", itemId);
  if (!m?.path || !fs.existsSync(m.path)) return { available: false, reason: 'This title has no local file to listen to — try the microphone instead.', match: null, cached: false, ...base };
  const key = `${itemId}:${audioStream ?? 'a'}:${Math.floor(pos / SONG_ID.bucketMs)}:${libraryUser.id}`;
  const hit = cache.get(key);
  if (hit && hit.at > Date.now() - SONG_ID.cacheTtlMs) return { available: true, reason: null, match: hit.match, cached: true, ...base };
  throttle(libraryUser.id);
  // Centre the snippet on the position (what was heard a moment ago is usually what the viewer asks about).
  const start = Math.max(0, Math.min(pos - SONG_ID.clipMs / 2, (m.duration_ms ?? Infinity) - SONG_ID.clipMs));
  const wav = tmpFile('wav');
  try {
    await extractClip(m.path, start, wav, audioStream);
    const best = await identifyWav(wav);
    const match = best ? toMatch(libraryUser, best) : null;
    if (cache.size >= SONG_ID.cacheMax) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: Date.now(), match });
    return { available: true, reason: null, match, cached: false, ...base };
  } finally {
    fs.rmSync(wav, { force: true });
  }
}

/** Identify a short microphone recording (any format ffmpeg reads; the phone records ~10 s). */
export async function identifyClip(user: User, audio: Buffer): Promise<SongIdResponse> {
  const base = { source: 'microphone' as const, positionMs: null };
  if (!audio?.length) throw badRequest('No recording received');
  if (audio.length > 5 * 1024 * 1024) throw badRequest('That recording is too long');
  const reason = await unavailableReason();
  if (reason) return { available: false, reason, match: null, cached: false, ...base };
  throttle(user.id);
  const src = tmpFile('rec');
  const wav = tmpFile('wav');
  try {
    fs.writeFileSync(src, audio);
    await extractClip(src, 0, wav, null);
    const best = await identifyWav(wav);
    return { available: true, reason: null, match: best ? toMatch(user, best) : null, cached: false, ...base };
  } finally {
    fs.rmSync(src, { force: true });
    fs.rmSync(wav, { force: true });
  }
}
