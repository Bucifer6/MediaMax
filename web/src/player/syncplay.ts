import { useCallback, useEffect, useRef, useState } from 'react';
import type { SyncPlayRoom } from '@mediamax/shared';
import { realtime } from '../api/ws';

type Action = 'play' | 'pause' | 'seek' | 'load';

/* Module-level store so a room survives player remounts (e.g. next episode). */
let currentRoom: SyncPlayRoom | null = null;
let leaveTimer: number | null = null;
const listeners = new Set<(r: SyncPlayRoom | null) => void>();
function setRoom(r: SyncPlayRoom | null) {
  currentRoom = r;
  listeners.forEach((l) => l(r));
}

export interface SyncTarget {
  itemId: string;
  userId: string;
  getPositionMs: () => number;
  isPaused: () => boolean;
  /** Apply a remote command without re-broadcasting it. */
  apply: (action: 'play' | 'pause' | 'seek', positionMs: number) => void;
  load: (itemId: string) => void;
}

export function useSyncPlay(target: SyncTarget) {
  const [room, setLocalRoom] = useState<SyncPlayRoom | null>(currentRoom);
  const [pending, setPending] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = useRef(target);
  t.current = target;
  const lastSent = useRef<{ action: Action; at: number } | null>(null);

  useEffect(() => {
    if (leaveTimer) {
      window.clearTimeout(leaveTimer);
      leaveTimer = null;
    }
    listeners.add(setLocalRoom);
    return () => {
      listeners.delete(setLocalRoom);
      if (currentRoom) {
        const id = currentRoom.id;
        leaveTimer = window.setTimeout(() => {
          realtime.send({ type: 'syncplay.leave', room: id });
          setRoom(null);
          leaveTimer = null;
        }, 2500);
      }
    };
  }, []);

  useEffect(() => {
    return realtime.subscribe((ev) => {
      if (ev.type === 'syncplay.state') {
        const joining = pending !== null || (currentRoom && currentRoom.id === ev.room.id);
        if (!joining) return;
        const firstSync = pending === 'join';
        const created = pending === 'create';
        setPending(null);
        setError(null);
        setRoom(ev.room);
        if (created) {
          const pos = t.current.getPositionMs();
          lastSent.current = { action: t.current.isPaused() ? 'pause' : 'play', at: Date.now() };
          realtime.send({ type: 'syncplay.command', room: ev.room.id, action: t.current.isPaused() ? 'pause' : 'play', positionMs: Math.round(pos) });
        }
        if (firstSync) {
          if (ev.room.itemId && ev.room.itemId !== t.current.itemId) t.current.load(ev.room.itemId);
          else {
            const pos = ev.room.positionMs + (ev.room.state === 'playing' ? Math.min(5000, Math.max(0, Date.now() - ev.room.updatedAt)) : 0);
            t.current.apply('seek', pos);
            t.current.apply(ev.room.state === 'playing' ? 'play' : 'pause', pos);
          }
        }
      } else if (ev.type === 'syncplay.command') {
        if (!currentRoom || ev.room !== currentRoom.id) return;
        const ls = lastSent.current;
        if (ev.by === t.current.userId && ls && ls.action === ev.action && Date.now() - ls.at < 2000) return;
        if (ev.action === 'load') {
          if (ev.itemId && ev.itemId !== t.current.itemId) t.current.load(ev.itemId);
          return;
        }
        const latency = ev.action === 'play' ? Math.min(5000, Math.max(0, Date.now() - ev.at)) : 0;
        t.current.apply(ev.action, ev.positionMs + latency);
      } else if (ev.type === 'error' && pending) {
        setPending(null);
        setError(ev.message);
      }
    });
  }, [pending]);

  const broadcast = useCallback((action: Action, positionMs: number, itemId?: string) => {
    if (!currentRoom) return;
    lastSent.current = { action, at: Date.now() };
    realtime.send({ type: 'syncplay.command', room: currentRoom.id, action, positionMs: Math.round(positionMs), itemId });
  }, []);

  const create = useCallback(() => {
    setPending('create');
    setError(null);
    realtime.send({ type: 'syncplay.create', itemId: t.current.itemId });
  }, []);

  const join = useCallback((code: string) => {
    setPending('join');
    setError(null);
    realtime.send({ type: 'syncplay.join', room: code.trim().toUpperCase() });
  }, []);

  const leave = useCallback(() => {
    if (currentRoom) realtime.send({ type: 'syncplay.leave', room: currentRoom.id });
    setRoom(null);
  }, []);

  return { room, pending, error, create, join, leave, broadcast };
}
