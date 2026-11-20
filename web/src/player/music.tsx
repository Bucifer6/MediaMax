import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Chapter, Item, PlaybackInfo } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { attachStream, type Attached } from './engine';
import { profileWithBitrate } from './deviceProfile';
import { useToast } from '../state/toast';
import { findNextEpisode, shuffled, tracksFor } from '../utils/playback';
import { hasAudioResume, isAudio, isResumable, isVideo, playLink } from '../utils/items';

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
  /** Chapters of the current item (audiobooks, podcasts with chapter marks). */
  chapters: Chapter[];
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
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const attached = useRef<Attached | null>(null);
  const sessionRef = useRef<string | null>(null);
  /** Media position at stream time 0 (non-zero when the server starts a transcode mid-file). */
  const offsetRef = useRef(0);
  const pendingSeek = useRef<number | null>(null);
  const stateRef = useRef({ queue, index, repeat, durationMs });
  stateRef.current = { queue, index, repeat, durationMs };
  const current = index >= 0 ? queue[index] ?? null : null;

  const report = useCallback((state: 'playing' | 'paused' | 'stopped', keepalive = false) => {
    const a = audioRef.current;
    const sid = sessionRef.current;
    if (!a || !sid) return;
    api.playback
      .progress(sid, { positionMs: Math.round(offsetRef.current + a.currentTime * 1000), durationMs: stateRef.current.durationMs || undefined, state, sessionId: sid }, keepalive)
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
    setChapters(current.chapters ?? []);
    const resumeMs = hasAudioResume(current) && isResumable(current) ? current.userData.positionMs : 0;
    (async () => {
      stopSession();
      attached.current?.destroy();
      attached.current = null;
      try {
        // Pick up the latest saved position (the queued copy may be stale) and the chapters,
        // which are only included on GET /items/:id.
        let startMs = resumeMs;
        if (hasAudioResume(current)) {
          const fresh = await api.items.get(current.id).catch(() => null);
          if (fresh) {
            startMs = isResumable(fresh) ? fresh.userData.positionMs : 0;
            if (!cancelled && fresh.chapters) setChapters(fresh.chapters);
          }
        }
        const pi = await api.playback.start(current.id, { startMs: startMs || undefined, deviceProfile: profileWithBitrate(null) });
        if (cancelled) {
          api.playback.stop(pi.sessionId).catch(() => {});
          return;
        }
        sessionRef.current = pi.sessionId;
        offsetRef.current = pi.streamStartMs ?? 0;
        pendingSeek.current = startMs > 0 ? startMs : null;
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

  /** Seek in media time; restarts the stream when the target is before a mid-file transcode start. */
  const seekRef = useRef<(ms: number) => void>(() => {});
  seekRef.current = (ms: number) => {
    const a = audioRef.current;
    const cur = stateRef.current.queue[stateRef.current.index];
    if (!a || !cur) return;
    const local = (ms - offsetRef.current) / 1000;
    if (local >= 0 && (!info?.isHls || (a.seekable.length && local <= a.seekable.end(a.seekable.length - 1) + 1))) {
      a.currentTime = local;
      return;
    }
    // Outside what the stream covers: ask the server for a new stream at that point.
    void (async () => {
      try {
        stopSession();
        attached.current?.destroy();
        const pi = await api.playback.start(cur.id, { startMs: Math.round(ms), deviceProfile: profileWithBitrate(null) });
        sessionRef.current = pi.sessionId;
        offsetRef.current = pi.streamStartMs ?? 0;
        pendingSeek.current = ms;
        setInfo(pi);
        attached.current = await attachStream(a, pi, { onFatal: (_k, msg) => toast.error(msg) });
        await a.play().catch(() => setPlaying(false));
      } catch (e) {
        toast.error(e);
      }
    })();
  };

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
    if (a && offsetRef.current + a.currentTime * 1000 > 4000) {
      if (offsetRef.current) seekRef.current(0);
      else a.currentTime = 0;
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
    const onTime = () => setPosition(offsetRef.current + a.currentTime * 1000);
    const onDur = () => {
      if (!isFinite(a.duration)) return;
      // Keep the item's full duration when the stream starts part-way through.
      setDuration((d) => Math.max(offsetRef.current + a.duration * 1000, offsetRef.current ? d : 0));
    };
    const onMeta = () => {
      const target = pendingSeek.current;
      pendingSeek.current = null;
      if (target == null) return;
      const local = (target - offsetRef.current) / 1000;
      if (local > 0.5) a.currentTime = local;
    };
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
    a.addEventListener('loadedmetadata', onMeta);
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
      a.removeEventListener('loadedmetadata', onMeta);
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
      queue, index, current, info, playing, loading, positionMs, durationMs, volume, muted, shuffle, repeat, chapters,
      playQueue: (items, start = 0) => {
        if (!items.length) return;
        const list = shuffle && !hasAudioResume(items[start]!) ? [items[start]!, ...shuffled(items.filter((_, i) => i !== start))] : items;
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
      seek: (ms) => seekRef.current(ms),
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
    [queue, index, current, info, playing, loading, positionMs, durationMs, volume, muted, shuffle, repeat, chapters, next, prev, goto],
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
        if (item.type === 'podcastepisode') {
          music.playQueue([item]);
          return;
        }
        if (item.type === 'podcast') {
          const ep = await api.items.next(item.id).catch(() => null);
          if (ep) music.playQueue([ep]);
          else toast.show('No episodes to play');
          return;
        }
        if (item.type === 'audiobook') {
          const parts = (await api.items.children(item.id, { sort: 'index', limit: 1000 })).items.filter(isAudio);
          if (!parts.length) {
            toast.show('Nothing to play');
            return;
          }
          const resumeAt = opts.fromStart ? null : await api.items.next(item.id).catch(() => null);
          const i = resumeAt ? parts.findIndex((p) => p.id === resumeAt.id) : 0;
          music.playQueue(i >= 0 && resumeAt ? parts.map((p) => (p.id === resumeAt.id ? resumeAt : p)) : parts, Math.max(0, i));
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
