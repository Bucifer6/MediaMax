import crypto from 'node:crypto';
import type { LastfmAuthStart, LastfmStatus } from '@mediamax/shared';
import { db } from '../db.js';
import { getSettings } from './settings.js';
import { badRequest, HttpError } from '../util/errors.js';
import { logger } from '../util/log.js';
import { initScrobbling, listenCounts, registerScrobbler, type ScrobbleTrack } from './scrobble.js';

const log = logger('lastfm');
const API = 'https://ws.audioscrobbler.com/2.0/';

const creds = () => {
  const l = getSettings().lastfm;
  return l.apiKey && l.sharedSecret ? { key: l.apiKey, secret: l.sharedSecret } : null;
};

/** Last.fm request signature: md5 of sorted key+value pairs (excluding format/callback) + secret. */
export function sign(params: Record<string, string>, secret: string): string {
  const base = Object.keys(params).filter((k) => k !== 'format' && k !== 'callback').sort().map((k) => k + params[k]).join('');
  return crypto.createHash('md5').update(base + secret, 'utf8').digest('hex');
}

async function call(method: string, params: Record<string, string>, post = false): Promise<any> {
  const c = creds();
  if (!c) throw badRequest('Last.fm is not configured on this server');
  const p: Record<string, string> = { ...params, method, api_key: c.key };
  p.api_sig = sign(p, c.secret);
  p.format = 'json';
  const body = new URLSearchParams(p);
  const res = post
    ? await fetch(API, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(15000) })
    : await fetch(`${API}?${body}`, { signal: AbortSignal.timeout(15000) });
  const j: any = await res.json().catch(() => ({}));
  if (j.error) throw new HttpError(j.error === 14 ? 409 : 502, j.message ?? 'Last.fm error', `lastfm_${j.error}`);
  return j;
}

export function lastfmStatus(userId: string): LastfmStatus {
  const a = db.get('SELECT * FROM lastfm_accounts WHERE user_id = ?', userId);
  return { available: !!creds(), connected: !!a?.session_key, username: a?.username ?? null, scrobble: a ? !!a.scrobble : false };
}

export async function startAuth(userId: string): Promise<LastfmAuthStart> {
  const j = await call('auth.getToken', {});
  db.upsert('lastfm_accounts', { user_id: userId, pending_token: j.token }, 'user_id');
  return { authUrl: `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(creds()!.key)}&token=${encodeURIComponent(j.token)}` };
}

/** Called when the client polls: exchange an approved token for a session. */
export async function pollAuth(userId: string): Promise<LastfmStatus> {
  const a = db.get('SELECT * FROM lastfm_accounts WHERE user_id = ?', userId);
  if (a?.pending_token && !a.session_key) {
    try {
      const j = await call('auth.getSession', { token: a.pending_token });
      db.run('UPDATE lastfm_accounts SET session_key = ?, username = ?, pending_token = NULL, scrobble = 1 WHERE user_id = ?', j.session.key, j.session.name, userId);
    } catch (e) {
      // 14 = not yet authorised; keep waiting. Other errors: drop the token.
      if ((e as HttpError).statusCode !== 409) db.run('UPDATE lastfm_accounts SET pending_token = NULL WHERE user_id = ?', userId);
    }
  }
  return lastfmStatus(userId);
}

export const disconnectLastfm = (userId: string) => db.run('DELETE FROM lastfm_accounts WHERE user_id = ?', userId);
export const setLastfmScrobble = (userId: string, on: boolean) => db.run('UPDATE lastfm_accounts SET scrobble = ? WHERE user_id = ?', on, userId);


function trackInfo(t: ScrobbleTrack): Record<string, string> {
  const info: Record<string, string> = { artist: t.artist, track: t.title };
  if (t.album) info.album = t.album;
  if (t.albumArtist) info.albumArtist = t.albumArtist;
  if (t.trackNumber) info.trackNumber = String(t.trackNumber);
  if (t.durationMs) info.duration = String(Math.round(t.durationMs / 1000));
  if (t.recordingMbid) info.mbid = t.recordingMbid;
  return info;
}

const account = (userId: string) => (creds() ? db.get('SELECT * FROM lastfm_accounts WHERE user_id = ? AND scrobble = 1 AND session_key IS NOT NULL', userId) : undefined);

/** Last.fm through the shared scrobble dispatcher (players, DJ mix, Subsonic clients). */
export function initLastfm() {
  registerScrobbler({
    id: 'lastfm',
    async nowPlaying(userId, t) {
      const a = account(userId);
      if (!a) return;
      try {
        await call('track.updateNowPlaying', { ...trackInfo(t), sk: a.session_key }, true);
      } catch (e) {
        log.debug(`now playing failed: ${(e as Error).message}`);
      }
    },
    async listen(userId, t, startedAt, listenedMs) {
      // Last.fm rule: tracks over 30 s, once played for half their length or 4 minutes.
      if (!listenCounts(t.durationMs, listenedMs, 30000)) return;
      const a = account(userId);
      if (!a) return;
      try {
        await call('track.scrobble', { ...trackInfo(t), timestamp: String(Math.floor(startedAt / 1000)), sk: a.session_key }, true);
      } catch (e) {
        log.debug(`scrobble failed: ${(e as Error).message}`);
      }
    },
  });
  initScrobbling();
}
