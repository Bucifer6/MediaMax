/**
 * SyncPlay ("watch together") over the realtime socket.
 *
 * The room lives here, above the router, so it survives player remounts (next
 * episode, a `load` from another member) and can be joined from outside the
 * player ("Join watch party"). The mounted video player registers itself as
 * the sync target: user actions are broadcast with `broadcast()`, incoming
 * commands are handed to `target.apply()` (which must never re-broadcast).
 *
 * The server echoes every command to every member, including the sender, with
 * `at` = server time. Our own echoes are dropped, and used to estimate the
 * server clock offset so play/seek can be compensated for latency.
 */
import { router } from 'expo-router';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { SyncPlayRoom } from '@/api/types';
import { useCapabilities, useSession } from './session';
import { clockOffset, driftCorrection, expectedPosition, type ClockSample } from '../player/syncClock';

export type SyncAction = 'play' | 'pause' | 'seek' | 'load';
type ApplyAction = 'play' | 'pause' | 'seek';

export interface SyncTarget {
  itemId: string;
  getPositionMs: () => number;
  isPaused: () => boolean;
  /** Apply a remote command to the player. Must NOT broadcast. */
  apply: (action: ApplyAction, positionMs: number, by: string | null) => void;
  /** Drift correction: a playback rate close to 1. */
  setRate?: (rate: number) => void;
  /** The player is waiting for data (the room waits for this member). */
  isBuffering?: () => boolean;
}

interface SyncPlayValue {
  enabled: boolean;
  room: SyncPlayRoom | null;
  pending: 'create' | 'join' | null;
  error: string | null;
  create: (itemId?: string) => void;
  join: (code: string) => void;
  leave: () => void;
  broadcast: (action: SyncAction, positionMs: number, itemId?: string) => void;
  /** The video player registers while mounted. Returns unregister. */
  register: (target: SyncTarget) => () => void;
  /** Keep the room alive without a player (the "Join watch party" screen). */
  hold: () => () => void;
  /** Room position now (ms), advancing while the room is playing. */
  roomPosition: () => number | null;
  /** Called by a freshly loaded player: true once if this device sent the `load` for itemId. */
  consumeOwnLoad: (itemId: string) => boolean;
}

const Ctx = createContext<SyncPlayValue | null>(null);

/** Latency compensation is capped so a bad clock can never jump far. */
const MAX_LATENCY_MS = 5000;
const ECHO_WINDOW_MS = 3000;
const LEAVE_GRACE_MS = 3000;

export function SyncPlayProvider({ children }: { children: React.ReactNode }) {
  const { socket, user } = useSession();
  const caps = useCapabilities();
  const enabled = caps.syncPlay && !!socket;

  const [room, setRoomState] = useState<SyncPlayRoom | null>(null);
  const [pending, setPendingState] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const roomRef = useRef<SyncPlayRoom | null>(null);
  const pendingRef = useRef<'create' | 'join' | null>(null);
  const targetRef = useRef<SyncTarget | null>(null);
  const holdersRef = useRef(0);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Commands we sent whose echo has not come back yet. */
  const sent = useRef<{ action: SyncAction; at: number }[]>([]);
  /** server clock − local clock, from our own echoes (best = lowest round trip). */
  const clock = useRef<{ offset: number; rtt: number }>({ offset: 0, rtt: Infinity });
  /** syncplay.ping / pong samples (the better offset source; echoes are the fallback). */
  const samples = useRef<ClockSample[]>([]);
  const ownLoad = useRef<string | null>(null);
  const rejoining = useRef(false);
  const socketRef = useRef(socket);
  socketRef.current = socket;
  const nameRef = useRef<string | null>(null);
  nameRef.current = user?.displayName || user?.username || null;

  const setRoom = useCallback((r: SyncPlayRoom | null) => {
    roomRef.current = r;
    setRoomState(r);
  }, []);
  const setPending = useCallback((p: 'create' | 'join' | null) => {
    pendingRef.current = p;
    setPendingState(p);
  }, []);

  const elapsedSince = (serverAt: number) => Math.max(0, Math.min(MAX_LATENCY_MS, Date.now() + clock.current.offset - serverAt));

  const roomPosition = useCallback(() => {
    const r = roomRef.current;
    if (!r) return null;
    return r.positionMs + (r.state === 'playing' ? elapsedSince(r.updatedAt) : 0);
  }, []);

  const broadcast = useCallback((action: SyncAction, positionMs: number, itemId?: string) => {
    const r = roomRef.current;
    if (!r || !socketRef.current) return;
    const now = Date.now();
    sent.current = [...sent.current.filter((x) => now - x.at < ECHO_WINDOW_MS), { action, at: now }];
    if (action === 'load' && itemId) ownLoad.current = itemId;
    // Our own move is the room's clock right away (a drift check before the echo must not pull us back).
    if (action !== 'load') {
      setRoom({ ...r, positionMs: Math.max(0, Math.round(positionMs)), updatedAt: now + clock.current.offset, state: action === 'pause' ? 'paused' : action === 'play' ? 'playing' : r.state, waiting: action === 'pause' ? false : r.waiting });
    }
    socketRef.current.send({ type: 'syncplay.command', room: r.id, action, positionMs: Math.max(0, Math.round(positionMs)), itemId });
  }, []);

  /** Open the room's item in the player (replacing the current player / waiting screen). */
  const openItem = useCallback((itemId: string, startMs: number) => {
    const href = `/player/${itemId}?start=${Math.max(0, Math.round(startMs))}`;
    if (targetRef.current || holdersRef.current > 0) router.replace(href as never);
    else router.push(href as never);
  }, []);

  // Incoming events.
  useEffect(() => {
    if (!socket) return;
    const off = socket.subscribe((ev) => {
      if (ev.type === 'syncplay.pong') {
        samples.current = [...samples.current.slice(-11), { sentAt: ev.sentAt, serverAt: ev.serverAt, receivedAt: Date.now() }];
        const o = clockOffset(samples.current);
        if (o != null) clock.current = { offset: o, rtt: 0 };
        return;
      }
      if (ev.type === 'syncplay.state') {
        const cur = roomRef.current;
        const p = pendingRef.current;
        if (!p && !(cur && cur.id === ev.room.id)) return;
        // Someone started / finished buffering: hold here, then resume where the room restarts its clock.
        if (!p && cur) {
          const target = targetRef.current;
          if (ev.room.waiting && !cur.waiting && target && !target.isPaused()) target.apply('pause', ev.room.positionMs, null);
          if (!ev.room.waiting && cur.waiting && ev.room.state === 'playing' && target) {
            target.apply('play', expectedPosition(ev.room, Date.now(), clock.current.offset), null);
          }
        }
        rejoining.current = false;
        setPending(null);
        setError(null);
        setRoom(ev.room);
        const target = targetRef.current;
        if (p === 'create' && target) {
          // Tell everyone where we are; the server starts rooms paused at 0.
          broadcast(target.isPaused() ? 'pause' : 'play', target.getPositionMs());
        } else if (p === 'join') {
          const pos = expectedPosition(ev.room, Date.now(), clock.current.offset);
          if (ev.room.itemId && target?.itemId !== ev.room.itemId) openItem(ev.room.itemId, pos);
          else if (target) {
            target.apply('seek', pos, null);
            target.apply(ev.room.state === 'playing' && !ev.room.waiting ? 'play' : 'pause', pos, null);
          }
        }
        return;
      }
      if (ev.type === 'syncplay.command') {
        const cur = roomRef.current;
        if (!cur || ev.room !== cur.id) return;
        // Keep a local copy of the room state for late joiners / roomPosition().
        setRoom({
          ...cur,
          positionMs: ev.positionMs,
          updatedAt: ev.at,
          itemId: ev.itemId ?? cur.itemId,
          state: ev.action === 'play' ? 'playing' : ev.action === 'pause' || ev.action === 'load' ? 'paused' : cur.state,
          waiting: ev.action === 'pause' || ev.action === 'load' ? false : cur.waiting,
        });
        // Our own echo: never re-apply, but learn the clock offset from it.
        const now = Date.now();
        const mine = ev.by === nameRef.current ? sent.current.findIndex((x) => x.action === ev.action && now - x.at < ECHO_WINDOW_MS) : -1;
        if (mine >= 0) {
          const ls = sent.current[mine];
          sent.current = sent.current.filter((_, i) => i !== mine);
          const rtt = now - ls.at;
          if (rtt <= clock.current.rtt) clock.current = { rtt, offset: ev.at - (ls.at + rtt / 2) };
          return;
        }
        const target = targetRef.current;
        if (ev.action === 'load') {
          if (ev.itemId && target?.itemId !== ev.itemId && (target || holdersRef.current > 0)) openItem(ev.itemId, 0);
          return;
        }
        if (!target || (ev.itemId && ev.itemId !== target.itemId)) return;
        const wasPlaying = cur.state === 'playing';
        const compensate = ev.action === 'play' || (ev.action === 'seek' && wasPlaying);
        // During a hold a Play only moves the position: the room resumes when everyone is ready.
        if (ev.action === 'play' && cur.waiting) {
          target.apply('pause', ev.positionMs, ev.by);
          return;
        }
        target.apply(ev.action, ev.positionMs + (compensate ? elapsedSince(ev.at) : 0), ev.by);
        return;
      }
      if (ev.type === 'error') {
        if (pendingRef.current) {
          setPending(null);
          setError(ev.message);
        } else if (rejoining.current) {
          // The room closed while we were disconnected.
          rejoining.current = false;
          setRoom(null);
          setError(ev.message);
        }
      }
    });
    // Rejoin after a reconnect: the server drops members whose socket closed.
    const offOpen = socket.onOpen(() => {
      const r = roomRef.current;
      if (!r) return;
      rejoining.current = true;
      socket.send({ type: 'syncplay.join', room: r.id });
    });
    return () => {
      off();
      offOpen();
    };
  }, [socket, broadcast, openItem, setPending, setRoom]);

  // While in a room: calibrate the clock (5 quick pings, then one a minute), keep the player in step every 2 s with a
  // small rate change (a seek only when far off), and report buffering so the room waits for this device.
  const roomId = room?.id ?? null;
  useEffect(() => {
    if (!roomId || !socket) return;
    const ping = () => socket.send({ type: 'syncplay.ping', sentAt: Date.now() });
    const quick = [0, 300, 600, 900, 1200].map((ms) => setTimeout(ping, ms));
    const slow = setInterval(ping, 60000);
    let lastBuffering = false;
    const buf = setInterval(() => {
      const b = !!targetRef.current?.isBuffering?.();
      if (b === lastBuffering) return;
      lastBuffering = b;
      socket.send({ type: 'syncplay.buffering', room: roomId, buffering: b });
    }, 500);
    const drift = setInterval(() => {
      const r = roomRef.current;
      const target = targetRef.current;
      if (!target) return;
      if (!r || r.state !== 'playing' || r.waiting || target.isPaused() || target.isBuffering?.()) {
        target.setRate?.(1);
        return;
      }
      const expected = expectedPosition(r, Date.now(), clock.current.offset);
      const fix = driftCorrection(target.getPositionMs() - expected);
      if (fix.kind === 'seek') {
        target.setRate?.(1);
        target.apply('seek', expected, null);
      } else target.setRate?.(fix.rate);
    }, 2000);
    return () => {
      quick.forEach(clearTimeout);
      clearInterval(slow);
      clearInterval(buf);
      clearInterval(drift);
      targetRef.current?.setRate?.(1);
    };
  }, [roomId, socket]);

  // Signed out / feature turned off: forget the room.
  useEffect(() => {
    if (!enabled && roomRef.current) {
      setRoom(null);
      setPending(null);
    }
  }, [enabled, setRoom, setPending]);

  const leave = useCallback(() => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
    const r = roomRef.current;
    if (r) socketRef.current?.send({ type: 'syncplay.leave', room: r.id });
    setRoom(null);
    setPending(null);
    setError(null);
    ownLoad.current = null;
  }, [setRoom, setPending]);

  const retain = useCallback(() => {
    holdersRef.current += 1;
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holdersRef.current -= 1;
      if (holdersRef.current <= 0 && (roomRef.current || pendingRef.current)) {
        // Grace period so a player remount (next episode, remote `load`) keeps the room.
        if (leaveTimer.current) clearTimeout(leaveTimer.current);
        leaveTimer.current = setTimeout(() => {
          leaveTimer.current = null;
          if (holdersRef.current <= 0) leave();
        }, LEAVE_GRACE_MS);
      }
    };
  }, [leave]);

  const register = useCallback(
    (target: SyncTarget) => {
      targetRef.current = target;
      const release = retain();
      return () => {
        if (targetRef.current === target) targetRef.current = null;
        release();
      };
    },
    [retain],
  );

  const create = useCallback(
    (itemId?: string) => {
      if (!socketRef.current) return;
      setPending('create');
      setError(null);
      socketRef.current.send({ type: 'syncplay.create', itemId });
    },
    [setPending],
  );

  const join = useCallback(
    (code: string) => {
      const c = code.trim().toUpperCase();
      if (!c || !socketRef.current) return;
      if (roomRef.current && roomRef.current.id !== c && roomRef.current.code !== c) socketRef.current.send({ type: 'syncplay.leave', room: roomRef.current.id });
      setPending('join');
      setError(null);
      socketRef.current.send({ type: 'syncplay.join', room: c });
    },
    [setPending],
  );

  const consumeOwnLoad = useCallback((itemId: string) => {
    if (ownLoad.current !== itemId) return false;
    ownLoad.current = null;
    return true;
  }, []);

  // A join that never gets an answer (socket down) should not spin forever.
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => {
      if (pendingRef.current) {
        setPending(null);
        setError(socketRef.current?.connected ? 'No answer from the server' : 'Not connected to the server');
      }
    }, 10000);
    return () => clearTimeout(timer);
  }, [pending, setPending]);

  const value = useMemo<SyncPlayValue>(
    () => ({ enabled, room, pending, error, create, join, leave, broadcast, register, hold: retain, roomPosition, consumeOwnLoad }),
    [enabled, room, pending, error, create, join, leave, broadcast, register, retain, roomPosition, consumeOwnLoad],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSyncPlay(): SyncPlayValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSyncPlay outside SyncPlayProvider');
  return ctx;
}
