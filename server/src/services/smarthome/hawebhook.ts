/**
 * Home Assistant webhook preset: a flat JSON body made for HA's webhook trigger (`/api/webhook/<id>`), so
 * automations can use `{{ trigger.json.action }}`, `{{ trigger.json.media_type }}` etc. without digging.
 */
import type { WebhookEvent } from '@mediamax/shared';
import { getSettings, serverId } from '../settings.js';
import { sessionEntry } from './nowplaying.js';
import { stopAction } from './homeassistant.js';
import type { PlaySession } from '../playback.js';

const ACTIONS: Record<WebhookEvent, string> = {
  'playback.start': 'started',
  'playback.pause': 'paused',
  'playback.resume': 'resumed',
  'playback.stop': 'stopped',
  'playback.scrobble': 'watched',
  'library.new': 'library_new',
  'user.login': 'login',
  'recording.completed': 'recording_completed',
  'recording.failed': 'recording_failed',
  'request.created': 'request_created',
  'request.available': 'request_available',
  'request.approved': 'request_approved',
  'request.declined': 'request_declined',
  'request.failed': 'request_failed',
  'issue.created': 'issue_created',
  'issue.resolved': 'issue_resolved',
};

/** Build HA's webhook URL from the HA base address and the webhook id (or accept a full URL as-is). */
export function haWebhookUrl(haUrl: string, webhookId: string): string {
  const id = webhookId.trim();
  const base = haUrl.trim().replace(/\/+$/, '');
  if (/\/api\/webhook\/[^/]+$/.test(base) && !id) return base;
  if (!/^https?:\/\//i.test(base)) throw new Error('Home Assistant URL must start with http:// or https://');
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error('Webhook ID may only contain letters, digits, - and _');
  return `${base}/api/webhook/${id}`;
}

export function haWebhookPayload(event: WebhookEvent | 'test', data: Record<string, any>, session?: PlaySession | null): Record<string, unknown> {
  const common = { event, server: getSettings().serverName, server_id: serverId(), at: new Date().toISOString() };
  if (session) {
    const e = sessionEntry(session);
    const action = event === 'playback.stop' ? stopAction(e) : ACTIONS[event as WebhookEvent] ?? event;
    return {
      ...common,
      action,
      state: action === 'paused' ? 'paused' : action === 'started' || action === 'resumed' ? 'playing' : 'idle',
      user: e.user, user_id: e.userId, device: e.device, platform: e.platform,
      media_type: e.mediaType, is_video: e.mediaType !== 'track' && e.mediaType !== 'audiobook' && e.mediaType !== 'bookpart' && e.mediaType !== 'podcastepisode',
      title: e.title, series: e.series, season: e.season, episode: e.episode, year: e.year,
      poster_url: e.posterUrl, position_seconds: e.positionSeconds, duration_seconds: e.durationSeconds, progress_percent: e.progressPercent,
      transcode: e.transcode, hdr: e.hdr, session_id: e.sessionId, item_id: e.itemId,
    };
  }
  if (event === 'test') {
    return {
      ...common, action: 'test', state: 'playing', user: 'Vibe', device: 'Test', platform: 'web', media_type: 'movie', is_video: true,
      title: 'Webhook test', series: null, season: null, episode: null, year: null, poster_url: null, position_seconds: 0, duration_seconds: 0,
      progress_percent: 0, transcode: false, hdr: false, session_id: null, item_id: null,
    };
  }
  const flat: Record<string, unknown> = { ...common, action: ACTIONS[event] ?? event };
  if (data.user) flat.user = data.user.name ?? data.user;
  if (data.item) Object.assign(flat, { title: data.item.title ?? null, media_type: data.item.type ?? null, year: data.item.year ?? null, item_id: data.item.id ?? null });
  if (event === 'library.new') {
    const items = (data.items ?? []) as { title: string; type: string }[];
    Object.assign(flat, { count: items.length, titles: items.slice(0, 10).map((i) => i.title), title: items[0]?.title ?? null, library_id: data.libraryId ?? null });
  }
  if (data.recording) Object.assign(flat, { title: data.recording.title ?? null, recording: data.recording });
  if (data.request) Object.assign(flat, { title: data.request.title ?? null, request: data.request });
  if (data.device) flat.device = data.device.deviceName ?? data.device;
  return flat;
}
