import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Item, PlaybackInfo } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { attachStream, type Attached } from './engine';
import { profileWithBitrate } from './deviceProfile';
import { useToast } from '../state/toast';
import { findNextEpisode, shuffled, tracksFor } from '../utils/playback';
import { isAudio, isVideo, playLink } from '../utils/items';

type Repeat = 'off' | 'all' | 'one';

interface MusicApi {
  queue: Item[];
  index: number;
  current: Item | null;
  info: PlaybackInfo | null;
  playing: boolean;
  loading: boolean;
  positionMs: number;
  durationMs: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: Repeat;
  playQueue: (items: Item[], start?: number) => void;
  enqueue: (items: Item[], next?: boolean) => void;
  toggle: () => void;
  pause: () => void;
  next: () => void;
  prev: () => void;
  seek: (ms: number) => void;
  jump: (i: number) => void;
  removeAt: (i: number) => void;
  clear: () => void;
  setVolume: (v: number) => void;
  setMuted: (m: boolean) => void;
  setShuffle: (s: boolean) => void;
  setRepeat: (r: Repeat) => void;
}

const Ctx = createContext<MusicApi | null>(null);
export function useMusic(): MusicApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMusic outside provider');
  return v;
}

const VOL_KEY = 'mm.volume';
function loadVolume() {
  try {
    const v = Number(localStorage.getItem(VOL_KEY));
    return isFinite(v) && v > 0 && v <= 1 ? v : 0.9;
  } catch {
    return 0.9;
  }
}

export function MusicProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  if (!audioRef.current && typeof Audio !== 'undefined') {
    audioRef.current = new Audio();
    audioRef.current.preload = 'auto';
  }
  const toast = useToast();
  const [queue, setQueue] = useState<Item[]>([]);
  const [index, setIndex] = useState(-1);
  const [info, setInfo] = useState<PlaybackInfo | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [positionMs, setPosition] = useState(0);
  const [durationMs, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(loadVolume);
  const [muted, setMuted] = useState(false);
  const [shuffle, setShuffleState] = useState(false);
  const [repeat, setRepeat] = useState<Repeat>('off');
  const attached = useRef<Attached | null>(null);
  const sessionRef = useRef<string | null>(null);
  const stateRef = useRef({ queue, index, repeat });
  stateRef.current = { queue, index, repeat };
  const current = index >= 0 ? queue[index] ?? null : null;

  const report = useCallback((state: 'playing' | 'paused' | 'stopped', keepalive = false) => {
    const a = audioRef.current;
    const sid = sessionRef.current;
    if (!a || !sid) return;
    api.playback
      .progress(sid, { positionMs: Math.round(a.currentTime * 1000), durationMs: isFinite(a.duration) ? Math.round(a.duration * 1000) : undefined, state, sessionId: sid }, keepalive)
      .catch(() => {});
  }, []);

  const stopSession = useCallback((keepalive = false) => {
    const sid = sessionRef.current;
    if (!sid) return;
    report('stopped', keepalive);
    api.playback.stop(sid, keepalive).catch(() => {});
    sessionRef.current = null;
  }, [report]);

  // Load the current track.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (!current) {
      attached.current?.destroy();
      attached.current = null;
      stopSession();
      setInfo(null);
      setPlaying(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setPosition(0);
    setDuration(current.durationMs ?? 0);
    (async () => {
      stopSession();
      attached.current?.destroy();
      attached.current = null;
      try {
        const pi = await api.playback.start(current.id, { deviceProfile: profileWithBitrate(null) });
        if (cancelled) {
          api.playback.stop(pi.sessionId).catch(() => {});
          return;
        }
        sessionRef.current = pi.sessionId;
        setInfo(pi);
        attached.current = await attachStream(a, pi, {
          onFatal: (_k, msg) => {
            toast.error(`Can't play "${current.title}": ${msg}`);
            setPlaying(false);
          },
        });
        if (cancelled) return;
        await a.play().catch(() => setPlaying(false));
        if ('mediaSession' in navigator) {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: pi.title || current.title,
            artist: pi.subtitle ?? current.grandparentTitle ?? current.parentTitle ?? '',
            album: current.parentTitle ?? '',
            artwork: pi.posterUrl || current.posterUrl ? [{ src: (pi.posterUrl || current.posterUrl)!, sizes: '512x512' }] : [],
          });
        }
      } catch (e) {
        if (!cancelled) {
          toast.error(`Playback failed: ${errorMessage(e)}`);
          setPlaying(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, index]);

  const goto = useCallback((i: number) => {
    const { queue: q } = stateRef.current;
    if (i < 0 || i >= q.length) return;
    setIndex(i);
  }, []);

  const next = useCallback(() => {
    const { queue: q, index: i, repeat: r } = stateRef.current;
    if (i + 1 < q.length) setIndex(i + 1);
    else if (r === 'all' && q.length) setIndex(0);
    else {
      audioRef.current?.pause();
    }
  }, []);

  const prev = useCallback(() => {
    const a = audioRef.current;
    if (a && a.currentTime > 4) {
      a.currentTime = 0;
      return;
    }
    const { index: i } = stateRef.current;
    if (i > 0) setIndex(i - 1);
    else if (a) a.currentTime = 0;
  }, []);

  // Element events.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    a.volume = volume;
    const onTime = () => setPosition(a.currentTime * 1000);
    const onDur = () => isFinite(a.duration) && setDuration(a.duration * 1000);
    const onPlay = () => {
      setPlaying(true);
      report('playing');
    };
    const onPause = () => {
      setPlaying(false);
      if (!a.ended) report('paused');
    };
    const onEnded = () => {
      const { repeat: r } = stateRef.current;
      if (r === 'one') {
        a.currentTime = 0;
        void a.play();
      } else next();
    };
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('durationchange', onDur);
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('ended', onEnded);
    const iv = window.setInterval(() => {
      if (!a.paused) report('playing');
    }, 10000);
    const unload = () => stopSession(true);
    window.addEventListener('pagehide', unload);
    return () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('durationchange', onDur);
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('ended', onEnded);
      window.clearInterval(iv);
      window.removeEventListener('pagehide', unload);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [next, report, stopSession]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
    try {
      localStorage.setItem(VOL_KEY, String(volume));
    } catch {
      /* ignore */
    }
  }, [volume]);
  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = muted;
  }, [muted]);

  // Media session controls.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    try {
      ms.setActionHandler('play', () => void audioRef.current?.play());
      ms.setActionHandler('pause', () => audioRef.current?.pause());
      ms.setActionHandler('nexttrack', next);
      ms.setActionHandler('previoustrack', prev);
    } catch {
      /* unsupported action */
    }
  }, [next, prev]);

  const value = useMemo<MusicApi>(
    () => ({
      queue, index, current, info, playing, loading, positionMs, durationMs, volume, muted, shuffle, repeat,
      playQueue: (items, start = 0) => {
        if (!items.length) return;
        const list = shuffle ? [items[start]!, ...shuffled(items.filter((_, i) => i !== start))] : items;
        setQueue(list);
        setIndex(-1);
        window.setTimeout(() => setIndex(shuffle ? 0 : start), 0);
      },
      enqueue: (items, playNext) => {
        setQueue((q) => {
          if (!q.length) {
            window.setTimeout(() => setIndex(0), 0);
            return items;
          }
          if (playNext) {
            const i = stateRef.current.index;
            return [...q.slice(0, i + 1), ...items, ...q.slice(i + 1)];
          }
          return [...q, ...items];
        });
      },
      toggle: () => {
        const a = audioRef.current;
        if (!a || !current) return;
        if (a.paused) void a.play();
        else a.pause();
      },
      pause: () => audioRef.current?.pause(),
      next,
      prev,
      seek: (ms) => {
        if (audioRef.current) audioRef.current.currentTime = ms / 1000;
      },
      jump: goto,
      removeAt: (i) => {
        setQueue((q) => q.filter((_, j) => j !== i));
        setIndex((cur) => (i < cur ? cur - 1 : i === cur ? Math.min(cur, queue.length - 2) : cur));
      },
      clear: () => {
        audioRef.current?.pause();
        setQueue([]);
        setIndex(-1);
      },
      setVolume: (v) => setVolumeState(Math.max(0, Math.min(1, v))),
      setMuted,
      setShuffle: (s) => {
        setShuffleState(s);
        if (s && queue.length > 1) {
          const cur = queue[index];
          const rest = shuffled(queue.filter((_, i) => i !== index));
          setQueue(cur ? [cur, ...rest] : rest);
          setIndex(cur ? 0 : -1);
        }
      },
      setRepeat,
    }),
    [queue, index, current, info, playing, loading, positionMs, durationMs, volume, muted, shuffle, repeat, next, prev, goto],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** One function that "plays" any item the right way. */
export function usePlayItem() {
  const navigate = useNavigate();
  const music = useMusic();
  const toast = useToast();
  return useCallback(
    async (item: Item, opts: { shuffle?: boolean; fromStart?: boolean } = {}) => {
      try {
        if (isVideo(item)) {
          navigate(playLink(item, opts));
          return;
        }
        if (item.type === 'show' || item.type === 'season') {
          const ep = await findNextEpisode(item);
          if (ep) navigate(playLink(ep));
          else toast.show('No episodes to play');
          return;
        }
        if (isAudio(item) && item.parentId) {
          const album = (await api.items.children(item.parentId, { sort: 'index', limit: 1000 }).catch(() => null))?.items.filter(isAudio) ?? [];
          const i = album.findIndex((t) => t.id === item.id);
          if (i >= 0) music.playQueue(album, i);
          else music.playQueue([item]);
          return;
        }
        if (item.type === 'album' || item.type === 'artist' || item.type === 'playlist' || item.type === 'track') {
          let tracks = await tracksFor(item);
          if (!tracks.length && item.type === 'playlist') {
            const kids = (await api.items.children(item.id, { limit: 500 })).items;
            const firstVideo = kids.find(isVideo);
            if (firstVideo) {
              navigate(playLink(firstVideo));
              return;
            }
          }
          if (!tracks.length) {
            toast.show('Nothing to play');
            return;
          }
          if (opts.shuffle) tracks = shuffled(tracks);
          music.playQueue(tracks, 0);
          return;
        }
        if (item.type === 'collection') {
          const kids = (await api.items.children(item.id, { limit: 200 })).items;
          const first = kids.find(isVideo);
          if (first) navigate(playLink(first));
          else navigate(`/item/${item.id}`);
          return;
        }
        navigate(`/item/${item.id}`);
      } catch (e) {
        toast.error(e);
      }
    },
    [navigate, music, toast],
  );
}
