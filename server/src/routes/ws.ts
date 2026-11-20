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
      send: (ev) => {
        if (socket.readyState === 1) socket.send(JSON.stringify(ev));
      },
    };
    events.add(client);
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
      } catch {
        client.send({ type: 'error', message: 'Invalid message' });
      }
    });
    socket.on('close', () => {
      clearInterval(ping);
      events.remove(client);
      leaveAll(client);
    });
  });
}
