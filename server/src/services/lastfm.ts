import crypto from 'node:crypto';
import type { LastfmAuthStart, LastfmStatus } from '@mediamax/shared';
import { db } from '../db.js';
import { getSettings } from './settings.js';
import { bus } from './events.js';
import { badRequest, HttpError } from '../util/errors.js';
import { parseJson } from '../util/misc.js';
import { logger } from '../util/log.js';
import type { PlaySession } from './playback.js';

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

function trackInfo(itemId: string): Record<string, string> | null {
  const t = db.get(`SELECT i.title, i.idx, i.duration_ms, i.extra, p.title album, g.title artist FROM items i
    LEFT JOIN items p ON p.id = i.parent_id LEFT JOIN items g ON g.id = i.grandparent_id WHERE i.id = ? AND i.type = 'track'`, itemId);
  if (!t) return null;
  const tags = parseJson<{ tags?: Record<string, string | null> }>(t.extra, {}).tags ?? {};
  const info: Record<string, string> = { artist: tags.artist || t.artist || 'Unknown Artist', track: t.title };
  if (t.album) info.album = t.album;
  if (tags.album_artist || t.artist) info.albumArtist = String(tags.album_artist || t.artist);
  if (t.idx) info.trackNumber = String(t.idx);
  if (t.duration_ms) info.duration = String(Math.round(t.duration_ms / 1000));
  return info;
}

const nowPlayingSent = new Set<string>();

async function onStart(s: PlaySession) {
  if (!s.itemId) return;
  const a = db.get('SELECT * FROM lastfm_accounts WHERE user_id = ? AND scrobble = 1 AND session_key IS NOT NULL', s.ctx.user.id);
  const info = a && creds() ? trackInfo(s.itemId) : null;
  if (!a || !info) return;
  nowPlayingSent.add(s.id);
  try {
    await call('track.updateNowPlaying', { ...info, sk: a.session_key }, true);
  } catch (e) {
    log.debug(`now playing failed: ${(e as Error).message}`);
  }
}

async function onStop(s: PlaySession) {
  if (!s.itemId || !nowPlayingSent.delete(s.id)) return;
  const a = db.get('SELECT * FROM lastfm_accounts WHERE user_id = ? AND scrobble = 1 AND session_key IS NOT NULL', s.ctx.user.id);
  const info = a && creds() ? trackInfo(s.itemId) : null;
  if (!a || !info) return;
  // Last.fm rule: scrobble tracks > 30s once played for half their length or 4 minutes.
  const dur = Number(info.duration ?? 0) * 1000;
  const listened = Math.max(s.positionMs, Date.now() - s.startedAt);
  if (dur && dur < 30000) return;
  if (listened < Math.min(dur ? dur / 2 : 240000, 240000)) return;
  try {
    await call('track.scrobble', { ...info, timestamp: String(Math.floor(s.startedAt / 1000)), sk: a.session_key }, true);
  } catch (e) {
    log.debug(`scrobble failed: ${(e as Error).message}`);
  }
}

export function initLastfm() {
  bus.on('playback.start', (s: PlaySession) => void onStart(s));
  bus.on('playback.stop', (s: PlaySession) => void onStop(s));
}
