import type { Platform, RemotePlayerState, RemoteTarget, ServerEvent } from '@mediamax/shared';
import { EventEmitter } from 'node:events';

export interface WsClient {
  id: string;
  userId: string;
  isAdmin: boolean;
  /** Device row id (one per signed-in device) — the "Play on…" target id. */
  deviceRowId: string;
  deviceName: string;
  platform: Platform;
  /** Last reported player state (for remote control UIs). */
  remoteState: RemotePlayerState | null;
  send: (ev: ServerEvent) => void;
  /** Send an already serialised event (broadcasts serialise once for every recipient). */
  sendRaw?: (json: string) => void;
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
    let json: string | null = null;
    for (const c of clients) {
      if (filter && !filter(c)) continue;
      try {
        if (c.sendRaw) c.sendRaw((json ??= JSON.stringify(ev)));
        else c.send(ev);
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
  /** The user's online devices (one entry per device even with several sockets). */
  remoteTargets(userId: string): RemoteTarget[] {
    const byDevice = new Map<string, RemoteTarget>();
    for (const c of clients) {
      if (c.userId !== userId || c.deviceRowId.startsWith('apikey:')) continue;
      const prev = byDevice.get(c.deviceRowId);
      byDevice.set(c.deviceRowId, { id: c.deviceRowId, deviceName: c.deviceName, platform: c.platform, state: c.remoteState ?? prev?.state ?? null });
    }
    return [...byDevice.values()];
  },
  announceTargets(userId: string) {
    this.toUser(userId, { type: 'remote.targets', targets: this.remoteTargets(userId) });
  },
};
