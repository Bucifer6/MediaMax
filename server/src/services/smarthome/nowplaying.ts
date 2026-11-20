/** A smart-home friendly snapshot of what is playing (REST endpoint, MQTT sensors, Home Assistant webhooks). */
import type { NowPlayingEntry, NowPlayingStatus } from '@mediamax/shared';
import { db } from '../../db.js';
import { config } from '../../config.js';
import { getSettings, serverId } from '../settings.js';
import { getSession, listSessions, type PlaySession } from '../playback.js';
import { imageUrl } from '../images.js';

/** Make a server-relative URL absolute with the configured public URL (HA fetches posters itself). */
export function absoluteUrl(u: string | null): string | null {
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  const base = getSettings().publicUrl?.replace(/\/+$/, '');
  return base ? base + u : u;
}

interface ItemInfo { mediaType: string | null; series: string | null; season: number | null; episode: number | null; year: number | null; title: string | null }

export function itemInfo(itemId: string | null): ItemInfo {
  if (!itemId) return { mediaType: null, series: null, season: null, episode: null, year: null, title: null };
  const r = db.get(`SELECT i.type, i.title, i.year, i.idx, i.parent_idx, p.title ptitle, g.title gtitle FROM items i
    LEFT JOIN items p ON p.id = i.parent_id LEFT JOIN items g ON g.id = i.grandparent_id WHERE i.id = ?`, itemId);
  if (!r) return { mediaType: null, series: null, season: null, episode: null, year: null, title: null };
  const episodic = r.type === 'episode';
  return {
    mediaType: r.type,
    title: r.title,
    series: episodic || r.type === 'track' ? r.gtitle ?? r.ptitle ?? null : null,
    season: episodic ? r.parent_idx ?? null : null,
    episode: episodic || r.type === 'track' ? r.idx ?? null : null,
    year: r.year ?? null,
  };
}

function mediaInfo(mediaId: string | null): { hdr: boolean; bitrate: number | null } {
  if (!mediaId) return { hdr: false, bitrate: null };
  const m = db.get('SELECT * FROM media WHERE id = ?', mediaId);
  if (!m) return { hdr: false, bitrate: null };
  let hdr = !!m.hdr;
  if (!hdr && m.video_range) {
    try {
      const vr = JSON.parse(m.video_range);
      hdr = !!vr && typeof vr === 'object' && !!vr.hdrFormat && vr.hdrFormat !== 'sdr';
    } catch {
      /* unparseable: keep the hdr column */
    }
  }
  return { hdr, bitrate: m.bitrate ?? null };
}

/** Build the entry for one live session (also used for webhook/MQTT payloads of stopped sessions). */
export function sessionEntry(s: PlaySession): NowPlayingEntry {
  const info = itemInfo(s.itemId);
  const media = mediaInfo(s.mediaId);
  const transcode = s.method === 'transcode';
  const bitrate = transcode && s.job?.info?.bitrate ? s.job.info.bitrate + 192 : media.bitrate;
  const pos = Math.round(s.positionMs / 1000);
  const dur = s.durationMs ? Math.round(s.durationMs / 1000) : null;
  return {
    sessionId: s.id,
    state: s.state,
    userId: s.ctx.user.id,
    user: s.ctx.user.displayName,
    deviceId: s.ctx.deviceRowId,
    device: s.ctx.device.deviceName,
    platform: s.ctx.device.platform,
    itemId: s.itemId,
    mediaType: s.channelId ? 'livetv' : info.mediaType,
    title: s.title,
    series: info.series,
    season: info.season,
    episode: info.episode,
    year: info.year,
    posterUrl: absoluteUrl(s.posterUrl),
    positionSeconds: pos,
    durationSeconds: dur,
    progressPercent: dur ? Math.min(100, Math.round((pos / dur) * 1000) / 10) : null,
    transcode,
    method: s.method,
    hdr: media.hdr,
    bitrateKbps: bitrate,
    startedAt: new Date(s.startedAt).toISOString(),
  };
}

export function recentlyAdded(limit = 5): NowPlayingStatus['recentlyAdded'] {
  return db.all(`SELECT i.id, i.type, i.title, i.year, i.added_at, COALESCE(i.poster, i.thumb, p.poster, g.poster) img, g.title gtitle, p.title ptitle FROM items i
    LEFT JOIN items p ON p.id = i.parent_id LEFT JOIN items g ON g.id = i.grandparent_id
    WHERE i.type IN ('movie','episode','album','audiobook','video') ORDER BY i.added_at DESC, i.rowid DESC LIMIT ?`, limit).map((r) => ({
    id: r.id, type: r.type, title: r.title, series: r.type === 'episode' ? r.gtitle ?? null : r.type === 'album' ? r.ptitle ?? null : null,
    year: r.year ?? null, addedAt: r.added_at, posterUrl: absoluteUrl(imageUrl(r.img ?? null)),
  }));
}

export function nowPlaying(filterUserId?: string): NowPlayingStatus {
  const sessions = listSessions()
    .filter((a) => !filterUserId || a.userId === filterUserId)
    .map((a) => getSession(a.id))
    .filter((s): s is PlaySession => !!s)
    .map(sessionEntry);
  const transcodes = sessions.filter((s) => s.transcode).length;
  return {
    server: { id: serverId(), name: getSettings().serverName, version: config.version },
    watching: sessions.some((s) => s.state !== 'paused'),
    activeStreams: sessions.length,
    transcodes,
    directStreams: sessions.length - transcodes,
    bandwidthKbps: sessions.reduce((n, s) => n + (s.state === 'paused' ? 0 : s.bitrateKbps ?? 0), 0),
    sessions,
    recentlyAdded: recentlyAdded(),
    generatedAt: new Date().toISOString(),
  };
}
