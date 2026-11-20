/**
 * Remote control ("Play on…") over the realtime socket.
 *
 *  - Reports this device's player state (`remote.state`) on change and every
 *    ~10 s while playing, from the mounted video player if there is one,
 *    otherwise from the audio queue (src/state/music.tsx).
 *  - Applies `remote.command`s sent from the user's other devices: transport
 *    commands go to the mounted video player (which registers a handle) or the
 *    audio queue; `playItem` / `playChannel` open the right player.
 *  - Keeps the list of the user's other online devices (`remote.targets`) for
 *    the "Play on…" picker and sends commands to them.
 *
 * Lives inside MusicProvider and above the router, so it survives player
 * remounts. Music playback keeps going through the music state (CarPlay /
 * Android Auto drive the same queue).
 */
import { router } from 'expo-router';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Item, RemoteAction, RemotePlayerState, RemoteTarget, ServerEvent } from '@/api/types';
import { isAudioItem } from '@/utils/library';
import { useMusic } from './music';
import { useCapabilities, useSession } from './session';

export type RemoteCommand = Extract<ServerEvent, { type: 'remote.command' }>;
export type RemoteCommandOptions = { itemId?: string; channelId?: string; positionMs?: number; volume?: number };

/** A mounted player (the video player) that reports state and takes transport commands. */
export interface RemotePlayerHandle {
  getState: () => RemotePlayerState | null;
  /** Apply a transport command (play/pause/togglePause/stop/seek/next/previous/setVolume). */
  handle: (cmd: RemoteCommand) => void;
}

interface RemoteValue {
  /** Signed in with a live socket. */
  enabled: boolean;
  /** The user's other online devices (this one excluded). */
  targets: RemoteTarget[];
  loading: boolean;
  refreshTargets: () => Promise<void>;
  /** Send a command to another of the user's devices. */
  send: (targetDeviceId: string, action: RemoteAction, opts?: RemoteCommandOptions) => void;
  /** The video player registers while mounted. Returns unregister. */
  registerPlayer: (h: RemotePlayerHandle) => () => void;
  /** Last command received from another device (for a small notice), cleared after a few seconds. */
  lastCommand: { from: string; action: RemoteAction } | null;
}

const Ctx = createContext<RemoteValue | null>(null);

const STATE_INTERVAL_MS = 10000;
/** Position drift (vs. what the last report implies) that counts as a seek and is reported at once. */
const SEEK_DRIFT_MS = 3000;

function sameState(a: RemotePlayerState, b: RemotePlayerState) {
  return a.itemId === b.itemId && a.channelId === b.channelId && a.paused === b.paused && a.title === b.title && a.volume === b.volume && a.durationMs === b.durationMs;
}

export function RemoteProvider({ children }: { children: React.ReactNode }) {
  const { api, socket, status } = useSession();
  const caps = useCapabilities();
  const music = useMusic();
  const enabled = status === 'signed-in' && !!socket && !!api;

  const [targets, setTargets] = useState<RemoteTarget[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastCommand, setLastCommand] = useState<RemoteValue['lastCommand']>(null);
  const players = useRef<RemotePlayerHandle[]>([]);
  const musicRef = useRef(music);
  musicRef.current = music;
  const apiRef = useRef(api);
  apiRef.current = api;
  const capsRef = useRef(caps);
  capsRef.current = caps;
  /** This device's row id (from GET /auth/devices `current`), to drop it from `remote.targets` pushes. */
  const selfId = useRef<string | null>(null);
  const lastSent = useRef<{ state: RemotePlayerState | null; at: number } | undefined>(undefined);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshTargets = useCallback(async () => {
    const a = apiRef.current;
    if (!a?.token) return;
    setLoading(true);
    try {
      setTargets(await a.remoteTargets());
    } catch {
      /* keep the old list */
    } finally {
      setLoading(false);
    }
  }, []);

  // ----- state reporting -----
  const musicState = useCallback((): RemotePlayerState | null => {
    const m = musicRef.current;
    const cur = m.current;
    if (!cur) return null;
    return {
      itemId: cur.id,
      channelId: null,
      title: cur.title,
      subtitle: cur.grandparentTitle ?? cur.parentTitle ?? null,
      posterUrl: cur.posterUrl ?? cur.thumbUrl ?? null,
      positionMs: Math.round(m.positionMs),
      durationMs: m.durationMs > 0 ? Math.round(m.durationMs) : cur.durationMs ?? null,
      paused: !m.playing,
      volume: Math.round(m.volume * 100),
    };
  }, []);

  const currentState = useCallback((): RemotePlayerState | null => {
    const top = players.current[players.current.length - 1];
    if (top) return top.getState();
    return musicState();
  }, [musicState]);

  const pushState = useCallback(
    (force = false) => {
      if (!socket?.connected) return;
      const st = currentState();
      const now = Date.now();
      const last = lastSent.current;
      let send = force || last === undefined;
      if (!send && last) {
        if (!st || !last.state) send = st !== last.state;
        else if (!sameState(st, last.state)) send = true;
        else {
          const expected = last.state.positionMs + (last.state.paused ? 0 : now - last.at);
          if (Math.abs(st.positionMs - expected) > SEEK_DRIFT_MS) send = true;
          else if (!st.paused && now - last.at >= STATE_INTERVAL_MS) send = true;
        }
      }
      if (!send) return;
      socket.send({ type: 'remote.state', state: st });
      lastSent.current = { state: st, at: now };
    },
    [socket, currentState],
  );

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => pushState(), 1000);
    return () => clearInterval(timer);
  }, [enabled, pushState]);

  // ----- incoming commands -----
  const playItemCommand = useCallback(async (itemId: string, startMs?: number) => {
    const a = apiRef.current;
    if (!a) return;
    const m = musicRef.current;
    const videoOpen = players.current.length > 0;
    const item: Item = await a.item(itemId);
    const start = startMs != null && startMs > 0 ? startMs : undefined;
    if (isAudioItem(item.type) || item.type === 'album' || item.type === 'audiobook' || item.type === 'playlist' || item.type === 'podcast') {
      // Audio goes to the music queue; close a video player first.
      if (videoOpen) players.current[players.current.length - 1]?.handle({ type: 'remote.command', fromDeviceName: '', action: 'stop' });
      if (isAudioItem(item.type)) {
        if (item.type === 'bookpart' && item.parentId) {
          const parts = (await a.children(item.parentId, { sort: 'index', order: 'asc', limit: 1000 })).items.filter((x) => isAudioItem(x.type));
          const i = parts.findIndex((x) => x.id === item.id);
          if (i >= 0) return m.playQueue(parts, i, start != null ? { startMs: start } : undefined);
        }
        return m.playQueue([item], 0, start != null ? { startMs: start } : undefined);
      }
      const kids = (await a.children(item.id, { sort: item.type === 'album' || item.type === 'audiobook' ? 'index' : undefined, order: 'asc', limit: 1000 })).items.filter((x) => isAudioItem(x.type));
      if (!kids.length) return;
      let i = 0;
      if (item.type === 'audiobook' || item.type === 'podcast') {
        const next = await a.next(item.id).catch(() => null);
        const ni = next ? kids.findIndex((x) => x.id === next.id) : -1;
        if (ni >= 0) i = ni;
      }
      return m.playQueue(kids, i);
    }
    // Containers of videos (show, season, collection): the server picks what's next.
    let videoId = item.id;
    if (item.type === 'show' || item.type === 'season' || item.type === 'collection') {
      const next = await a.next(item.id).catch(() => null);
      if (!next) return;
      videoId = next.id;
    }
    const path = `/player/${videoId}${start != null ? `?start=${Math.round(start)}` : ''}`;
    if (videoOpen) router.replace(path as never);
    else router.push(path as never);
  }, []);

  const handleCommand = useCallback(
    (cmd: RemoteCommand) => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      setLastCommand({ from: cmd.fromDeviceName, action: cmd.action });
      noticeTimer.current = setTimeout(() => setLastCommand(null), 3500);

      if (cmd.action === 'playItem') {
        if (cmd.itemId) void playItemCommand(cmd.itemId, cmd.positionMs).catch(() => undefined);
        return;
      }
      if (cmd.action === 'playChannel') {
        if (!cmd.channelId || !capsRef.current.liveTv) return;
        const path = `/live/${cmd.channelId}`;
        if (players.current.length) router.replace(path as never);
        else router.push(path as never);
        return;
      }
      const top = players.current[players.current.length - 1];
      if (top) return top.handle(cmd);
      const m = musicRef.current;
      if (!m.current) return;
      switch (cmd.action) {
        case 'play':
          if (!m.playing) m.toggle();
          break;
        case 'pause':
          m.pause();
          break;
        case 'togglePause':
          m.toggle();
          break;
        case 'stop':
          m.stop();
          break;
        case 'seek':
          if (typeof cmd.positionMs === 'number') m.seek(cmd.positionMs);
          break;
        case 'next':
          m.next();
          break;
        case 'previous':
          m.previous();
          break;
        case 'setVolume':
          if (typeof cmd.volume === 'number') m.setVolume(cmd.volume / 100);
          break;
      }
      // Report the result right away.
      setTimeout(() => pushState(), 600);
    },
    [playItemCommand, pushState],
  );
  const handleRef = useRef(handleCommand);
  handleRef.current = handleCommand;

  useEffect(() => {
    if (!socket || !api?.token) return;
    selfId.current = null;
    lastSent.current = undefined;
    api
      .devices()
      .then((list) => {
        selfId.current = list.find((d) => d.current)?.id ?? null;
      })
      .catch(() => undefined);
    void refreshTargets();
    const unsub = socket.subscribe((evt) => {
      if (evt.type === 'remote.command') handleRef.current(evt);
      else if (evt.type === 'remote.targets') {
        if (selfId.current) setTargets(evt.targets.filter((x) => x.id !== selfId.current));
        else void refreshTargets();
      }
    });
    // (Re)connected: the server forgot our state, so report it again.
    const unOpen = socket.onOpen(() => {
      lastSent.current = undefined;
      void refreshTargets();
    });
    return () => {
      unsub();
      unOpen();
    };
  }, [socket, api, refreshTargets]);

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  const send = useCallback(
    (targetDeviceId: string, action: RemoteAction, opts: RemoteCommandOptions = {}) => {
      socket?.send({ type: 'remote.command', targetDeviceId, action, ...opts });
    },
    [socket],
  );

  const registerPlayer = useCallback(
    (h: RemotePlayerHandle) => {
      players.current = [...players.current, h];
      setTimeout(() => pushState(true), 0);
      return () => {
        players.current = players.current.filter((x) => x !== h);
        setTimeout(() => pushState(true), 0);
      };
    },
    [pushState],
  );

  const value = useMemo<RemoteValue>(
    () => ({ enabled, targets, loading, refreshTargets, send, registerPlayer, lastCommand }),
    [enabled, targets, loading, refreshTargets, send, registerPlayer, lastCommand],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRemote(): RemoteValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useRemote outside RemoteProvider');
  return v;
}
