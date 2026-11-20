import type { WebhookEvent } from '@mediamax/shared';
import { getSettings, serverId } from './settings.js';
import { bus } from './events.js';
import { db } from '../db.js';
import { config } from '../config.js';
import { logger } from '../util/log.js';
import type { PlaySession } from './playback.js';

const log = logger('webhooks');

export async function sendWebhook(url: string, payload: unknown): Promise<{ ok: boolean; status: number | null; error?: string }> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': `MediaMax/${config.version}` }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, status: null, error: (e as Error).message };
  }
}

function dispatch(event: WebhookEvent, data: Record<string, unknown>) {
  const hooks = getSettings().webhooks.filter((w) => w.enabled && w.events.includes(event));
  if (!hooks.length) return;
  const payload = { event, at: new Date().toISOString(), server: { id: serverId(), name: getSettings().serverName, version: config.version }, ...data };
  for (const h of hooks) {
    void sendWebhook(h.url, payload).then((r) => {
      if (!r.ok) log.warn(`Webhook ${h.url} failed for ${event}: ${r.error ?? r.status}`);
    });
  }
}

function sessionPayload(s: PlaySession) {
  const item = s.itemId ? db.get('SELECT id, type, title, year, parent_id, grandparent_id, idx, parent_idx, external_ids FROM items WHERE id = ?', s.itemId) : null;
  return {
    user: { id: s.ctx.user.id, name: s.ctx.user.displayName },
    player: { device: s.ctx.device.deviceName, platform: s.ctx.device.platform, address: s.remoteAddr },
    session: { id: s.id, method: s.method, positionMs: s.positionMs },
    item: item ? { ...item, external_ids: JSON.parse(item.external_ids ?? '{}') } : null,
    channel: s.channelId ? { id: s.channelId, name: s.title } : null,
  };
}

export function initWebhooks() {
  bus.on('playback.start', (s: PlaySession) => dispatch('playback.start', sessionPayload(s)));
  bus.on('playback.stop', (s: PlaySession) => dispatch('playback.stop', sessionPayload(s)));
  bus.on('playback.pause', (s: PlaySession) => dispatch('playback.pause', sessionPayload(s)));
  bus.on('playback.resume', (s: PlaySession) => dispatch('playback.resume', sessionPayload(s)));
  bus.on('playback.scrobble', ({ user, itemId }: any) => dispatch('playback.scrobble', { user: { id: user.id, name: user.displayName }, item: db.get('SELECT id, type, title, year FROM items WHERE id = ?', itemId) }));
  bus.on('library.new', ({ libraryId, itemIds }: any) => dispatch('library.new', { libraryId, items: itemIds.slice(0, 50).map((id: string) => db.get('SELECT id, type, title, year FROM items WHERE id = ?', id)).filter(Boolean) }));
  bus.on('user.login', ({ user, device }: any) => dispatch('user.login', { user: { id: user.id, name: user.displayName }, device }));
  bus.on('recording.completed', (r: any) => dispatch('recording.completed', { recording: r }));
  bus.on('recording.failed', (r: any) => dispatch('recording.failed', { recording: r }));
  bus.on('request.created', (r: any) => dispatch('request.created', { request: r }));
  bus.on('request.available', (r: any) => dispatch('request.available', { request: r }));
}
