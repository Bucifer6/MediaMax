import type { ClientEvent, SyncPlayRoom } from '@mediamax/shared';
import { newId, shortCode } from '../util/ids.js';
import type { WsClient } from './events.js';
import { db } from '../db.js';

/** Watch-together rooms. Any member can play/pause/seek; commands are broadcast with a server timestamp. */
const rooms = new Map<string, SyncPlayRoom>();
const memberSockets = new Map<string, Set<WsClient>>();

function broadcastRoom(room: SyncPlayRoom) {
  for (const c of memberSockets.get(room.id) ?? []) c.send({ type: 'syncplay.state', room });
}

function displayName(userId: string) {
  return db.get<{ display_name: string }>('SELECT display_name FROM users WHERE id = ?', userId)?.display_name ?? 'Someone';
}

function join(room: SyncPlayRoom, c: WsClient) {
  const set = memberSockets.get(room.id) ?? new Set();
  set.add(c);
  memberSockets.set(room.id, set);
  if (!room.members.some((m) => m.userId === c.userId)) room.members.push({ userId: c.userId, displayName: displayName(c.userId) });
  broadcastRoom(room);
}

export function leaveAll(c: WsClient) {
  for (const [id, set] of memberSockets) {
    if (!set.delete(c)) continue;
    const room = rooms.get(id);
    if (!room) continue;
    if (![...set].some((x) => x.userId === c.userId)) room.members = room.members.filter((m) => m.userId !== c.userId);
    if (!set.size) {
      rooms.delete(id);
      memberSockets.delete(id);
    } else broadcastRoom(room);
  }
}

export function handleSyncPlay(c: WsClient, ev: ClientEvent) {
  switch (ev.type) {
    case 'syncplay.create': {
      let code = shortCode(5);
      while ([...rooms.values()].some((r) => r.code === code)) code = shortCode(5);
      const room: SyncPlayRoom = { id: newId(), code, ownerId: c.userId, members: [], itemId: ev.itemId ?? null, state: 'paused', positionMs: 0, updatedAt: Date.now() };
      rooms.set(room.id, room);
      join(room, c);
      break;
    }
    case 'syncplay.join': {
      const room = rooms.get(ev.room) ?? [...rooms.values()].find((r) => r.code === String(ev.room).toUpperCase());
      if (!room) return c.send({ type: 'error', message: 'Watch-together room not found' });
      join(room, c);
      break;
    }
    case 'syncplay.leave': {
      const set = memberSockets.get(ev.room);
      if (set?.has(c)) {
        set.delete(c);
        const room = rooms.get(ev.room);
        if (room) {
          room.members = room.members.filter((m) => m.userId !== c.userId || [...set].some((x) => x.userId === c.userId));
          if (!set.size) rooms.delete(ev.room);
          else broadcastRoom(room);
        }
      }
      break;
    }
    case 'syncplay.command': {
      const room = rooms.get(ev.room);
      if (!room || !memberSockets.get(room.id)?.has(c)) return c.send({ type: 'error', message: 'Not in that room' });
      room.positionMs = Math.max(0, ev.positionMs);
      room.updatedAt = Date.now();
      if (ev.action === 'play') room.state = 'playing';
      if (ev.action === 'pause') room.state = 'paused';
      if (ev.action === 'load') {
        room.itemId = ev.itemId ?? room.itemId;
        room.state = 'paused';
      }
      const by = displayName(c.userId);
      for (const s of memberSockets.get(room.id) ?? []) s.send({ type: 'syncplay.command', room: room.id, action: ev.action, positionMs: room.positionMs, itemId: room.itemId ?? undefined, at: room.updatedAt, by });
      break;
    }
  }
}
