import type { FastifyInstance } from 'fastify';
import type { ClientEvent, ServerEvent } from '@mediamax/shared';
import { authenticate } from '../services/auth.js';
import { events, type WsClient } from '../services/events.js';
import { serverId } from '../services/settings.js';
import { handleSyncPlay, leaveAll } from '../services/syncplay.js';
import { listSessions } from '../services/playback.js';
import { newId } from '../util/ids.js';
import { extractToken } from '../http.js';

export default async function wsRoutes(app: FastifyInstance) {
  app.get('/ws', { websocket: true }, (socket, req) => {
    const ctx = authenticate(extractToken(req));
    if (!ctx) {
      socket.send(JSON.stringify({ type: 'error', message: 'Authentication required' } satisfies ServerEvent));
      socket.close(4001, 'unauthorized');
      return;
    }
    const client: WsClient = {
      id: newId(),
      userId: ctx.user.id,
      isAdmin: ctx.user.isAdmin,
      deviceRowId: ctx.deviceRowId,
      deviceName: ctx.device.deviceName,
      platform: ctx.device.platform,
      remoteState: null,
      send: (ev) => {
        if (socket.readyState === 1) socket.send(JSON.stringify(ev));
      },
    };
    events.add(client);
    events.announceTargets(ctx.user.id);
    client.send({ type: 'hello', serverId: serverId(), userId: ctx.user.id });
    if (ctx.user.isAdmin) client.send({ type: 'sessions.updated', sessions: listSessions() });
    const ping = setInterval(() => {
      try {
        socket.ping();
      } catch {
        /* ignore */
      }
    }, 30000);
    socket.on('message', (raw: Buffer) => {
      let ev: ClientEvent;
      try {
        ev = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!ev || typeof ev !== 'object' || typeof (ev as any).type !== 'string') return;
      if (ev.type === 'ping') return;
      try {
        if (ev.type.startsWith('syncplay.')) handleSyncPlay(client, ev);
        else if (ev.type === 'remote.state') {
          const s = ev.state;
          client.remoteState = s && typeof s === 'object' ? {
            itemId: s.itemId ?? null, channelId: s.channelId ?? null, title: s.title ? String(s.title).slice(0, 200) : null, subtitle: s.subtitle ? String(s.subtitle).slice(0, 200) : null,
            posterUrl: typeof s.posterUrl === 'string' && s.posterUrl.startsWith('/api/') ? s.posterUrl : null,
            positionMs: Math.max(0, Number(s.positionMs) || 0), durationMs: s.durationMs ? Number(s.durationMs) : null, paused: !!s.paused,
            volume: s.volume == null ? null : Math.max(0, Math.min(100, Number(s.volume))),
          } : null;
          events.announceTargets(client.userId);
        } else if (ev.type === 'remote.command') {
          // Only your own devices can be controlled.
          const targets = events.clients().filter((c) => c.userId === client.userId && c.deviceRowId === ev.targetDeviceId && c !== client);
          if (!targets.length) client.send({ type: 'error', message: 'That device is not online' });
          const ACTIONS = ['play', 'pause', 'togglePause', 'stop', 'seek', 'next', 'previous', 'setVolume', 'playItem', 'playChannel'];
          if (!ACTIONS.includes(ev.action)) return;
          for (const t of targets) {
            t.send({ type: 'remote.command', fromDeviceName: client.deviceName, action: ev.action, itemId: ev.itemId, channelId: ev.channelId,
              positionMs: ev.positionMs == null ? undefined : Number(ev.positionMs), volume: ev.volume == null ? undefined : Number(ev.volume) });
          }
        }
      } catch {
        client.send({ type: 'error', message: 'Invalid message' });
      }
    });
    socket.on('close', () => {
      clearInterval(ping);
      events.remove(client);
      leaveAll(client);
      events.announceTargets(client.userId);
    });
  });
}
