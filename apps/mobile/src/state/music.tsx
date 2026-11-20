/**
 * Audio queue + background audio via expo-audio, with lock-screen / control
 * centre metadata and server progress reporting. Plays music tracks plus
 * spoken-word audio (audiobook parts, podcast episodes), which additionally
 * resume where you left off, offer playback speed and expose chapters.
 */
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { audioDeviceProfile } from '@/api/profiles';
import type { Chapter, Item, PlaybackInfo } from '@/api/types';
import { isAudioItem, isSpokenAudio } from '@/utils/library';
import { useDownloads } from './downloads';
import { useSession } from './session';

export type RepeatMode = 'off' | 'all' | 'one';
export const SPEEDS = [0.8, 1, 1.1, 1.25, 1.5, 1.75, 2];

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
  /** Current item is an audiobook part / podcast episode. */
  spoken: boolean;
  /** Spoken-word playback speed (music always plays at 1x). */
  rate: number;
  setRate: (rate: number) => void;
  /** Chapters of the current item (from GET /items/:id), if any. */
  chapters: Chapter[];
  /** Relative seek, e.g. -15 s / +30 s for spoken audio. */
  skip: (deltaMs: number) => void;
  /** `startMs` overrides the resume position of the first item. */
  playQueue: (items: Item[], startIndex?: number, opts?: { shuffle?: boolean; startMs?: number }) => void;
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
  const [rate, setRateState] = useState(1);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const session = useRef<PlaybackInfo | null>(null);
  const loadedId = useRef<string | null>(null);
  /** Resume position to apply once the source has loaded (spoken audio). */
  const pendingSeek = useRef<number | null>(null);
  /** One-shot start override from playQueue(…, { startMs }). */
  const startOverride = useRef<{ id: string; ms: number } | null>(null);
  const current = queue[index] ?? null;
  const spoken = !!current && isSpokenAudio(current.type);
  const spokenRef = useRef(spoken);
  spokenRef.current = spoken;
  const rateRef = useRef(rate);
  rateRef.current = rate;
  const currentRef = useRef<Item | null>(current);
  currentRef.current = current;

  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix' }).catch(() => undefined);
  }, []);

  const report = useCallback(
    (state: 'playing' | 'paused' | 'stopped') => {
      const s = session.current;
      const positionMs = Math.round(player.currentTime * 1000);
      // Offline spoken audio: keep the resume position locally, like offline video.
      const cur = currentRef.current;
      if (!s && cur && spokenRef.current && positionMs > 0) downloads.updateLocalPosition(cur.id, positionMs);
      if (!api || !s) return;
      const body = { positionMs, durationMs: Math.round(player.duration * 1000) || undefined, state, sessionId: s.sessionId };
      api.sessionProgress(s.sessionId, body).catch(() => undefined);
      if (state === 'stopped') api.stopSession(s.sessionId).catch(() => undefined);
    },
    [api, player, downloads],
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
      const isSpoken = isSpokenAudio(current.type);
      // Spoken audio resumes; music always starts at the top.
      const override = startOverride.current?.id === current.id ? startOverride.current.ms : null;
      startOverride.current = null;
      const dur = current.durationMs ?? 0;
      const saved = local?.state === 'done' && local.positionMs ? local.positionMs : current.userData.positionMs;
      let startMs = isSpoken ? override ?? (dur && saved > dur * 0.95 ? 0 : saved) : 0;
      setChapters([]);
      if (isSpoken) {
        api
          .item(current.id)
          .then((full) => alive && setChapters(full.chapters ?? []))
          .catch(() => undefined);
      }
      let uri: string;
      if (local?.state === 'done' && local.fileUri) {
        uri = local.fileUri;
      } else {
        try {
          const info = await api.playback(current.id, { deviceProfile: audioDeviceProfile(), startMs: isSpoken && startMs > 0 ? Math.round(startMs) : undefined });
          if (!alive) return;
          session.current = info;
          if (isSpoken && info.startMs) startMs = info.startMs;
          uri = api.absolute(info.url);
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Playback failed');
          return;
        }
      }
      player.replace({ uri, headers: api.headers(false) });
      pendingSeek.current = startMs > 1000 ? startMs : null;
      try {
        player.setPlaybackRate(isSpoken ? rateRef.current : 1);
      } catch {
        /* ignore */
      }
      player.play();
      const artwork = api.image(current.posterUrl ?? current.thumbUrl, 600) ?? undefined;
      const meta = { title: current.title, artist: current.grandparentTitle ?? current.parentTitle ?? undefined, albumTitle: current.parentTitle ?? undefined, artworkUrl: artwork };
      try {
        player.setActiveForLockScreen(true, meta, { showNextTrack: !isSpoken || queue.length > 1, showPreviousTrack: !isSpoken || queue.length > 1, showSeekForward: isSpoken, showSeekBackward: isSpoken });
      } catch {
        /* not supported on this platform */
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, api, player, downloads, report]);

  // Apply the resume position once the new source is ready.
  useEffect(() => {
    if (!status.isLoaded || pendingSeek.current == null) return;
    const ms = pendingSeek.current;
    pendingSeek.current = null;
    void player.seekTo(ms / 1000);
  }, [status.isLoaded, player]);

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

  const playQueue = useCallback((items: Item[], startIndex = 0, opts: { shuffle?: boolean; startMs?: number } = {}) => {
    const wanted = items[startIndex];
    const tracks = items.filter((i) => isAudioItem(i.type));
    if (!tracks.length) return;
    let list = tracks;
    let start = Math.max(0, wanted ? tracks.indexOf(wanted) : Math.min(startIndex, tracks.length - 1));
    if (opts.startMs != null && tracks[start]) startOverride.current = { id: tracks[start].id, ms: opts.startMs };
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
      spoken,
      rate,
      setRate: (r) => {
        setRateState(r);
        try {
          if (spokenRef.current) player.setPlaybackRate(r);
        } catch {
          /* ignore */
        }
      },
      chapters,
      skip: (deltaMs) => {
        const d = player.duration > 0 ? player.duration : Infinity;
        void player.seekTo(Math.max(0, Math.min(d - 1, player.currentTime + deltaMs / 1000)));
      },
      playQueue,
      enqueue: (items) => setQueue((q) => [...q, ...items.filter((i) => isAudioItem(i.type))]),
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
    [queue, index, current, status, shuffle, repeat, error, spoken, rate, chapters, playQueue, player, report, advance],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMusic(): MusicValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMusic outside MusicProvider');
  return v;
}
