/**
 * Music queue + background audio via expo-audio, with lock-screen / control
 * centre metadata and server progress reporting.
 */
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { audioDeviceProfile } from '@/api/profiles';
import type { Item, PlaybackInfo } from '@/api/types';
import { useDownloads } from './downloads';
import { useSession } from './session';

export type RepeatMode = 'off' | 'all' | 'one';

interface MusicValue {
  queue: Item[];
  index: number;
  current: Item | null;
  playing: boolean;
  buffering: boolean;
  positionMs: number;
  durationMs: number;
  shuffle: boolean;
  repeat: RepeatMode;
  error: string | null;
  playQueue: (items: Item[], startIndex?: number, opts?: { shuffle?: boolean }) => void;
  enqueue: (items: Item[]) => void;
  playNextInQueue: (item: Item) => void;
  toggle: () => void;
  pause: () => void;
  next: () => void;
  previous: () => void;
  seek: (ms: number) => void;
  jumpTo: (index: number) => void;
  stop: () => void;
  setShuffle: (v: boolean) => void;
  cycleRepeat: () => void;
}

const Ctx = createContext<MusicValue | null>(null);

function shuffled<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function MusicProvider({ children }: { children: React.ReactNode }) {
  const { api } = useSession();
  const downloads = useDownloads();
  const player = useAudioPlayer(null, { updateInterval: 500 });
  const status = useAudioPlayerStatus(player);
  const [queue, setQueue] = useState<Item[]>([]);
  const [index, setIndex] = useState(0);
  const [shuffle, setShuffleState] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>('off');
  const [error, setError] = useState<string | null>(null);
  const session = useRef<PlaybackInfo | null>(null);
  const loadedId = useRef<string | null>(null);
  const current = queue[index] ?? null;

  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix' }).catch(() => undefined);
  }, []);

  const report = useCallback(
    (state: 'playing' | 'paused' | 'stopped') => {
      const s = session.current;
      if (!api || !s) return;
      const body = { positionMs: Math.round(player.currentTime * 1000), durationMs: Math.round(player.duration * 1000) || undefined, state, sessionId: s.sessionId };
      api.sessionProgress(s.sessionId, body).catch(() => undefined);
      if (state === 'stopped') api.stopSession(s.sessionId).catch(() => undefined);
    },
    [api, player],
  );

  // Load the current track.
  useEffect(() => {
    if (!current || !api) return;
    if (loadedId.current === current.id) return;
    loadedId.current = current.id;
    let alive = true;
    (async () => {
      setError(null);
      if (session.current) report('stopped');
      session.current = null;
      const local = downloads.get(current.id);
      let uri: string;
      if (local?.state === 'done' && local.fileUri) {
        uri = local.fileUri;
      } else {
        try {
          const info = await api.playback(current.id, { deviceProfile: audioDeviceProfile() });
          if (!alive) return;
          session.current = info;
          uri = api.absolute(info.url);
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Playback failed');
          return;
        }
      }
      player.replace({ uri, headers: api.headers(false) });
      player.play();
      const artwork = api.image(current.posterUrl ?? current.thumbUrl, 600) ?? undefined;
      const meta = { title: current.title, artist: current.grandparentTitle ?? current.parentTitle ?? undefined, albumTitle: current.parentTitle ?? undefined, artworkUrl: artwork };
      try {
        player.setActiveForLockScreen(true, meta, { showNextTrack: true, showPreviousTrack: true, showSeekForward: false, showSeekBackward: false });
      } catch {
        /* not supported on this platform */
      }
    })();
    return () => {
      alive = false;
    };
  }, [current, api, player, downloads, report]);

  // Progress every 10s.
  useEffect(() => {
    if (!status.playing) return;
    const timer = setInterval(() => report('playing'), 10000);
    return () => clearInterval(timer);
  }, [status.playing, report]);

  const advance = useCallback(
    (dir: 1 | -1, auto = false) => {
      if (!queue.length) return;
      if (auto && repeat === 'one') {
        void player.seekTo(0);
        player.play();
        return;
      }
      let ni = index + dir;
      if (ni >= queue.length) {
        if (repeat === 'all' || !auto) ni = 0;
        else {
          report('stopped');
          session.current = null;
          return;
        }
      }
      if (ni < 0) ni = queue.length - 1;
      loadedId.current = null;
      setIndex(ni);
    },
    [queue.length, index, repeat, player, report],
  );

  // Track finished.
  const finishedRef = useRef(false);
  useEffect(() => {
    if (status.didJustFinish && !finishedRef.current) {
      finishedRef.current = true;
      report('stopped');
      session.current = null;
      advance(1, true);
    } else if (!status.didJustFinish) finishedRef.current = false;
  }, [status.didJustFinish, advance, report]);

  const playQueue = useCallback((items: Item[], startIndex = 0, opts: { shuffle?: boolean } = {}) => {
    const tracks = items.filter((i) => i.type === 'track');
    if (!tracks.length) return;
    let list = tracks;
    let start = Math.max(0, Math.min(startIndex, tracks.length - 1));
    if (opts.shuffle) {
      const first = tracks[start];
      list = [first, ...shuffled(tracks.filter((t) => t.id !== first.id))];
      start = 0;
      setShuffleState(true);
    }
    loadedId.current = null;
    setQueue(list);
    setIndex(start);
  }, []);

  const value = useMemo<MusicValue>(
    () => ({
      queue,
      index,
      current,
      playing: status.playing,
      buffering: status.isBuffering,
      positionMs: Math.round((status.currentTime ?? 0) * 1000),
      durationMs: Math.round((status.duration || (current?.durationMs ?? 0) / 1000) * 1000),
      shuffle,
      repeat,
      error,
      playQueue,
      enqueue: (items) => setQueue((q) => [...q, ...items.filter((i) => i.type === 'track')]),
      playNextInQueue: (item) => setQueue((q) => [...q.slice(0, index + 1), item, ...q.slice(index + 1)]),
      toggle: () => {
        if (player.playing) {
          player.pause();
          report('paused');
        } else player.play();
      },
      pause: () => {
        if (player.playing) {
          player.pause();
          report('paused');
        }
      },
      next: () => advance(1),
      previous: () => {
        if (player.currentTime > 4) void player.seekTo(0);
        else advance(-1);
      },
      seek: (ms) => void player.seekTo(ms / 1000),
      jumpTo: (i) => {
        loadedId.current = null;
        setIndex(i);
      },
      stop: () => {
        player.pause();
        report('stopped');
        session.current = null;
        try {
          player.clearLockScreenControls();
        } catch {
          /* ignore */
        }
        loadedId.current = null;
        setQueue([]);
        setIndex(0);
      },
      setShuffle: (v) => {
        setShuffleState(v);
        if (v && queue.length > 1) {
          const cur = queue[index];
          setQueue([cur, ...shuffled(queue.filter((_, i) => i !== index))]);
          setIndex(0);
          loadedId.current = cur.id;
        }
      },
      cycleRepeat: () => setRepeat((r) => (r === 'off' ? 'all' : r === 'all' ? 'one' : 'off')),
    }),
    [queue, index, current, status, shuffle, repeat, error, playQueue, player, report, advance],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMusic(): MusicValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMusic outside MusicProvider');
  return v;
}
