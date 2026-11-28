import { useCallback, useEffect, useRef, useState } from 'react';
import type { SyncPlayRoom } from '@mediamax/shared';
import { realtime } from '../api/ws';
import { clockOffset, driftCorrection, expectedPosition, type ClockSample, type RoomClock } from './syncClock';

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
  /** Server reports `by` as a display name; compare against both. */
  userName?: string;
  getPositionMs: () => number;
  isPaused: () => boolean;
  /** Apply a remote command without re-broadcasting it. */
  apply: (action: 'play' | 'pause' | 'seek', positionMs: number) => void;
  load: (itemId: string) => void;
  /** Drift correction: a playback rate close to 1 (never shown to the viewer as a speed change). */
  setRate?: (rate: number) => void;
  /** The player is waiting for data (reported so the room waits for this member). */
  isBuffering?: () => boolean;
}

/** Clock offset to the server, shared by every room this tab joins (recalibrated each minute while in a room). */
let offsetMs = 0;
const samples: ClockSample[] = [];

export function useSyncPlay(target: SyncTarget) {
  const [room, setLocalRoom] = useState<SyncPlayRoom | null>(currentRoom);
  const [pending, setPending] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = useRef(target);
  t.current = target;
  const lastSent = useRef<{ action: Action; at: number } | null>(null);
  /** The room's clock as the last command / state described it (server time). */
  const clock = useRef<RoomClock | null>(null);
  const [waiting, setWaiting] = useState(false);

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
      if (ev.type === 'syncplay.pong') {
        samples.push({ sentAt: ev.sentAt, serverAt: ev.serverAt, receivedAt: Date.now() });
        if (samples.length > 12) samples.splice(0, samples.length - 12);
        offsetMs = clockOffset(samples) ?? offsetMs;
        return;
      }
      if (ev.type === 'syncplay.state' && currentRoom && ev.room.id === currentRoom.id && pending === null) {
        // Waiting for someone who is buffering: hold here; resume where the room restarts its clock.
        const wasWaiting = !!clock.current?.waiting;
        clock.current = { state: ev.room.state, positionMs: ev.room.positionMs, updatedAt: ev.room.updatedAt, waiting: !!ev.room.waiting };
        setRoom(ev.room);
        setWaiting(!!ev.room.waiting);
        if (ev.room.waiting && !wasWaiting && !t.current.isPaused()) t.current.apply('pause', ev.room.positionMs);
        if (!ev.room.waiting && wasWaiting && ev.room.state === 'playing') t.current.apply('play', expectedPosition(clock.current, Date.now(), offsetMs));
        return;
      }
      if (ev.type === 'syncplay.state') {
        const joining = pending !== null || (currentRoom && currentRoom.id === ev.room.id);
        if (!joining) return;
        const firstSync = pending === 'join';
        const created = pending === 'create';
        setPending(null);
        setError(null);
        setRoom(ev.room);
        clock.current = { state: ev.room.state, positionMs: ev.room.positionMs, updatedAt: ev.room.updatedAt, waiting: !!ev.room.waiting };
        if (created) {
          const pos = t.current.getPositionMs();
          lastSent.current = { action: t.current.isPaused() ? 'pause' : 'play', at: Date.now() };
          realtime.send({ type: 'syncplay.command', room: ev.room.id, action: t.current.isPaused() ? 'pause' : 'play', positionMs: Math.round(pos) });
        }
        if (firstSync && ev.room.waiting) {
          // Joining a room that is waiting for someone: line up and wait with it.
          t.current.apply('seek', ev.room.positionMs);
          t.current.apply('pause', ev.room.positionMs);
        } else if (firstSync) {
          if (ev.room.itemId && ev.room.itemId !== t.current.itemId) t.current.load(ev.room.itemId);
          else {
            const pos = expectedPosition(clock.current, Date.now(), offsetMs);
            t.current.apply('seek', pos);
            t.current.apply(ev.room.state === 'playing' ? 'play' : 'pause', pos);
          }
        }
      } else if (ev.type === 'syncplay.command') {
        if (!currentRoom || ev.room !== currentRoom.id) return;
        if (ev.action !== 'load') {
          const state = ev.action === 'pause' ? 'paused' : ev.action === 'play' ? 'playing' : clock.current?.state ?? 'paused';
          // A pause ends a hold on the server; anything else keeps it (the server's clock stays frozen meanwhile).
          clock.current = { state, positionMs: ev.positionMs, updatedAt: ev.at, waiting: ev.action === 'pause' ? false : !!clock.current?.waiting };
        }
        const ls = lastSent.current;
        if ((ev.by === t.current.userId || (!!t.current.userName && ev.by === t.current.userName)) && ls && ls.action === ev.action && Date.now() - ls.at < 2000) return;
        if (ev.action === 'load') {
          if (ev.itemId && ev.itemId !== t.current.itemId) t.current.load(ev.itemId);
          return;
        }
        // Where the room is now, on the server's clock (corrects for network delay and for this device's clock skew).
        // During a hold a Play only moves the position: the room resumes when everyone is ready.
        if (ev.action === 'play' && clock.current?.waiting) {
          t.current.apply('pause', ev.positionMs);
          return;
        }
        t.current.apply(ev.action, ev.action === 'play' && clock.current ? expectedPosition({ ...clock.current, state: 'playing' }, Date.now(), offsetMs) : ev.positionMs);
      } else if (ev.type === 'error' && pending) {
        setPending(null);
        setError(ev.message);
      }
    });
  }, [pending]);

  // While in a room: calibrate the clock (5 quick pings, then one a minute), keep in step every 2 s with a small
  // rate change (a seek only when far off), and report buffering so the room waits for this member.
  const roomId = room?.id ?? null;
  useEffect(() => {
    if (!roomId) return;
    const ping = () => realtime.send({ type: 'syncplay.ping', sentAt: Date.now() });
    const quick = [0, 300, 600, 900, 1200].map((ms) => window.setTimeout(ping, ms));
    const slow = window.setInterval(ping, 60000);
    let lastBuffering = false;
    const buf = window.setInterval(() => {
      const b = !!t.current.isBuffering?.();
      if (b === lastBuffering) return;
      lastBuffering = b;
      realtime.send({ type: 'syncplay.buffering', room: roomId, buffering: b });
    }, 500);
    const drift = window.setInterval(() => {
      const c = clock.current;
      if (!c || c.state !== 'playing' || c.waiting || t.current.isPaused() || t.current.isBuffering?.()) {
        t.current.setRate?.(1);
        return;
      }
      const fix = driftCorrection(t.current.getPositionMs() - expectedPosition(c, Date.now(), offsetMs));
      if (fix.kind === 'seek') {
        t.current.setRate?.(1);
        t.current.apply('seek', expectedPosition(c, Date.now(), offsetMs));
      } else t.current.setRate?.(fix.rate);
    }, 2000);
    return () => {
      quick.forEach((x) => window.clearTimeout(x));
      window.clearInterval(slow);
      window.clearInterval(buf);
      window.clearInterval(drift);
      t.current.setRate?.(1);
    };
  }, [roomId]);

  const broadcast = useCallback((action: Action, positionMs: number, itemId?: string) => {
    if (!currentRoom) return;
    lastSent.current = { action, at: Date.now() };
    // Our own move is the room's new clock right away: a drift check before the echo arrives must not pull us back.
    if (action !== 'load') {
      const state = action === 'pause' ? 'paused' : action === 'play' ? 'playing' : clock.current?.state ?? 'paused';
      clock.current = { state, positionMs, updatedAt: Date.now() + offsetMs, waiting: action === 'pause' ? false : !!clock.current?.waiting };
    }
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

  return { room, pending, error, create, join, leave, broadcast, waiting };
}
