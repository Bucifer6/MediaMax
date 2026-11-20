import type { ServerEvent } from '@mediamax/shared';
import { EventEmitter } from 'node:events';

export interface WsClient {
  id: string;
  userId: string;
  isAdmin: boolean;
  send: (ev: ServerEvent) => void;
}

const clients = new Set<WsClient>();
/** In-process bus for server-side listeners (webhooks, DVR, etc.). */
export const bus = new EventEmitter();
bus.setMaxListeners(50);

export const events = {
  add(c: WsClient) {
    clients.add(c);
  },
  remove(c: WsClient) {
    clients.delete(c);
  },
  clients() {
    return [...clients];
  },
  broadcast(ev: ServerEvent, filter?: (c: WsClient) => boolean) {
    for (const c of clients) {
      if (filter && !filter(c)) continue;
      try {
        c.send(ev);
      } catch {
        /* ignore broken sockets */
      }
    }
  },
  toUser(userId: string, ev: ServerEvent) {
    this.broadcast(ev, (c) => c.userId === userId);
  },
  toAdmins(ev: ServerEvent) {
    this.broadcast(ev, (c) => c.isAdmin);
  },
};
