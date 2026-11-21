import type { FastifyInstance } from 'fastify';
import type { ClientEvent, ServerEvent } from '@mediamax/shared';
import { authenticate } from '../services/auth.js';
import { events, type WsClient } from '../services/events.js';
import { serverId } from '../services/settings.js';
import { handleSyncPlay, leaveAll } from '../services/syncplay.js';
import { listSessions } from '../services/playback.js';
import { newId } from '../util/ids.js';
import { extractToken } from '../http.js';
import { announcePairedFor, announceTv, commandTargets, keyTargets, remoteStateExtras, REMOTE_KEYS } from '../services/pairing.js';

/** How often an open socket pings and re-checks its session (tests shorten it). */
let WS_RECHECK_MS = 30000;
export const setWsRecheckMs = (ms: number) => {
  WS_RECHECK_MS = ms;
};

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
      sendRaw: (json) => {
        if (socket.readyState === 1) socket.send(json);
      },
    };
    events.add(client);
    events.announceTargets(ctx.user.id);
    announceTv(client.deviceRowId);
    client.send({ type: 'hello', serverId: serverId(), userId: ctx.user.id });
    if (ctx.user.isAdmin) client.send({ type: 'sessions.updated', sessions: listSessions() });
    announcePairedFor(client.deviceRowId);
    const token = extractToken(req);
    const ping = setInterval(() => {
      // A signed-out, revoked, disabled or demoted session must not keep receiving events on an old socket.
      const now = authenticate(token);
      if (!now || now.user.id !== ctx.user.id || now.user.isAdmin !== ctx.user.isAdmin) {
        socket.close(4001, 'unauthorized');
        return;
      }
      try {
        socket.ping();
      } catch {
        /* ignore */
      }
    }, WS_RECHECK_MS);
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
            ...remoteStateExtras(s as unknown as Record<string, unknown>),
          } : null;
          events.announceTargets(client.userId);
          announceTv(client.deviceRowId);
        } else if (ev.type === 'remote.command') {
          // Your own devices, or a TV you are paired with (another user's TV: transport and allowed titles only).
          const ACTIONS = ['play', 'pause', 'togglePause', 'stop', 'seek', 'next', 'previous', 'setVolume', 'playItem', 'playChannel', 'setAudioTrack', 'setSubtitleTrack', 'skipSegment'];
          if (!ACTIONS.includes(ev.action)) return;
          const targets = commandTargets(client, String(ev.targetDeviceId ?? ''), ev.action, typeof ev.itemId === 'string' ? ev.itemId : undefined);
          if (!targets.length) client.send({ type: 'error', message: 'That device is not online' });
          for (const t of targets) {
            t.send({ type: 'remote.command', fromDeviceName: client.deviceName, action: ev.action, itemId: ev.itemId, channelId: ev.channelId,
              positionMs: ev.positionMs == null ? undefined : Number(ev.positionMs), volume: ev.volume == null ? undefined : Number(ev.volume),
              ...(ev.trackIndex !== undefined ? { trackIndex: ev.trackIndex == null ? null : Number(ev.trackIndex) } : {}) });
          }
        } else if (ev.type === 'remote.key') {
          // D-pad / text from a phone remote: only along an active pairing (QR), never to unpaired devices.
          if (!REMOTE_KEYS.has(ev.key)) return;
          const targets = keyTargets(client, String(ev.targetDeviceId ?? ''));
          if (!targets.length) {
            client.send({ type: 'error', message: 'Not paired with that TV' });
            return;
          }
          const text = ev.key === 'text' && typeof ev.text === 'string' ? ev.text.slice(0, 200) : undefined;
          for (const t of targets) t.send({ type: 'remote.key', fromDeviceName: client.deviceName, key: ev.key, ...(text !== undefined ? { text } : {}) });
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
      announceTv(client.deviceRowId);
    });
  });
}
