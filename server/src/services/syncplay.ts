import type { ClientEvent, SyncPlayRoom } from '@mediamax/shared';
import { newId, shortCode } from '../util/ids.js';
import type { WsClient } from './events.js';
import { db } from '../db.js';

/**
 * Watch-together rooms. Any member can play/pause/seek; commands are broadcast with a server timestamp. Clients
 * calibrate their clock offset with syncplay.ping / pong and keep in step with gentle rate changes (syncClock.ts).
 * While any member is buffering the room waits: its clock is held, and resumes for everyone once all are ready.
 */
const rooms = new Map<string, SyncPlayRoom>();
const memberSockets = new Map<string, Set<WsClient>>();
/** Sockets (devices) currently buffering, per room: a user with two devices is buffering while either one is. */
const bufferingSockets = new Map<string, Set<WsClient>>();
/** A hold never lasts longer than this: a stalled player mustn't stop the room for good. */
const MAX_HOLD_MS = 15000;
const holdTimers = new Map<string, ReturnType<typeof setTimeout>>();

function syncBuffering(room: SyncPlayRoom) {
  const set = bufferingSockets.get(room.id);
  for (const m of room.members) m.buffering = [...(set ?? [])].some((c) => c.userId === m.userId);
}

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
    bufferingSockets.get(id)?.delete(c);
    if (!set.delete(c)) continue;
    const room = rooms.get(id);
    if (!room) continue;
    if (![...set].some((x) => x.userId === c.userId)) room.members = room.members.filter((m) => m.userId !== c.userId);
    if (!set.size) {
      rooms.delete(id);
      memberSockets.delete(id);
      bufferingSockets.delete(id);
      clearTimeout(holdTimers.get(id));
      holdTimers.delete(id);
    } else {
      // A member who left while buffering must not keep the room waiting.
      if (room.waiting) updateWaiting(room);
      broadcastRoom(room);
    }
  }
}

/** Hold or release the room clock as members start / stop buffering (only while playing). */
function updateWaiting(room: SyncPlayRoom) {
  syncBuffering(room);
  const waiting = room.state === 'playing' && room.members.some((m) => m.buffering);
  if (waiting === !!room.waiting) return;
  clearTimeout(holdTimers.get(room.id));
  holdTimers.delete(room.id);
  if (waiting) {
    holdTimers.set(room.id, setTimeout(() => {
      holdTimers.delete(room.id);
      bufferingSockets.delete(room.id);
      if (rooms.get(room.id) === room) updateWaiting(room);
    }, MAX_HOLD_MS));
  }
  const now = Date.now();
  // Freeze at the position the room had reached; on release, restart the clock from here.
  if (waiting) room.positionMs = room.positionMs + Math.max(0, now - room.updatedAt);
  room.updatedAt = now;
  room.waiting = waiting;
  broadcastRoom(room);
}

export function handleSyncPlay(c: WsClient, ev: ClientEvent) {
  switch (ev.type) {
    case 'syncplay.ping': {
      c.send({ type: 'syncplay.pong', sentAt: Number(ev.sentAt) || 0, serverAt: Date.now() });
      break;
    }
    case 'syncplay.buffering': {
      const room = rooms.get(ev.room);
      if (!room || !memberSockets.get(room.id)?.has(c)) return;
      const bset = bufferingSockets.get(room.id) ?? new Set<WsClient>();
      if (ev.buffering === true) bset.add(c);
      else bset.delete(c);
      bufferingSockets.set(room.id, bset);
      const before = room.members.map((m) => !!m.buffering).join();
      syncBuffering(room);
      const changed = before !== room.members.map((m) => !!m.buffering).join();
      const wasWaiting = !!room.waiting;
      updateWaiting(room);
      if (changed && wasWaiting === !!room.waiting) broadcastRoom(room);
      break;
    }
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
        bufferingSockets.get(ev.room)?.delete(c);
        const room = rooms.get(ev.room);
        if (room) {
          room.members = room.members.filter((m) => m.userId !== c.userId || [...set].some((x) => x.userId === c.userId));
          if (!set.size) rooms.delete(ev.room);
          else {
            if (room.waiting) updateWaiting(room);
            broadcastRoom(room);
          }
        }
      }
      break;
    }
    case 'syncplay.command': {
      const room = rooms.get(ev.room);
      if (!room || !memberSockets.get(room.id)?.has(c)) return c.send({ type: 'error', message: 'Not in that room' });
      room.positionMs = Math.max(0, Number(ev.positionMs) || 0);
      room.updatedAt = Date.now();
      if (ev.action === 'play') room.state = 'playing';
      if (ev.action === 'pause') room.state = 'paused';
      // Pausing or a new title ends any hold; players then report buffering afresh and decide when the room moves on.
      if (ev.action === 'pause' || ev.action === 'load') room.waiting = false;
      if (ev.action === 'load') {
        room.itemId = ev.itemId ?? room.itemId;
        room.state = 'paused';
      }
      const by = displayName(c.userId);
      for (const s of memberSockets.get(room.id) ?? []) s.send({ type: 'syncplay.command', room: room.id, action: ev.action, positionMs: room.positionMs, itemId: room.itemId ?? undefined, at: room.updatedAt, by });
      updateWaiting(room);
      break;
    }
  }
}
