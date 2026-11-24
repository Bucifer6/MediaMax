import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Chapter, DjMixRequest, Item, PlaybackInfo } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { errorMessage, withToken } from '../api/client';
import { attachStream } from './engine';
import { profileWithBitrate } from './deviceProfile';
import { absoluteUrl, CAST_OWNER_EVENT, castContentType, castDeviceProfile, castOwner, claimCast, useCast, type CastHandle, type CastOwner } from './cast';
import { isAlbumInOrder, MusicOutput, replayGainFactor, SUSPENDS_WEB_AUDIO_IN_BACKGROUND, type Deck } from './musicOutput';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { findNextEpisode, shuffled, tracksFor } from '../utils/playback';
import { hasAudioResume, isAudio, isResumable, isVideo, playLink } from '../utils/items';

type Repeat = 'off' | 'all' | 'one';

/** Sleep timer: pause after a number of minutes, at the end of the current chapter, or at the end of the current part. */
export type SleepTimer =
  | { mode: 'time'; minutes: number; endsAt: number }
  | { mode: 'chapter'; itemId: string; endMs: number }
  | { mode: 'part' };
export type SleepOption = { minutes: number } | 'chapter' | 'part';
/** How long the volume fades out before the sleep timer pauses. */
const SLEEP_FADE_MS = 12000;
/** Start preparing the next track this long before the current one ends (plus the crossfade). */
const PRELOAD_LEAD_MS = 30000;
/** Gapless: below this much remaining time, schedule the exact handover with a timer. */
const HANDOVER_WINDOW_MS = 600;
/** Start the next element this much early to cover its output start-up latency. */
const HANDOVER_LEAD_MS = 8;
/** Radio: fetch more tracks when fewer than this many are left after the current one. */
const RADIO_LOW_WATER = 5;

/** Song / album / artist radio: an endless DJ-style mix seeded from one item, played through the normal queue. */
export interface RadioState {
  seedId: string;
  /** "Radio based on <title>". */
  label: string;
}

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
  /** `startMs` starts the first item at that position instead of its saved resume point. */
  playQueue: (items: Item[], start?: number, startMs?: number) => void;
  enqueue: (items: Item[], next?: boolean) => void;
  toggle: () => void;
  pause: () => void;
  next: () => void;
  prev: () => void;
  seek: (ms: number) => void;
  jump: (i: number, startMs?: number) => void;
  removeAt: (i: number) => void;
  clear: () => void;
  setVolume: (v: number) => void;
  setMuted: (m: boolean) => void;
  setShuffle: (s: boolean) => void;
  setRepeat: (r: Repeat) => void;
  /** Google Cast state (button shown when `cast.available`). */
  cast: CastHandle;
  /** The current track is playing on a Cast device. */
  casting: boolean;
  sleep: SleepTimer | null;
  setSleep: (opt: SleepOption | null) => void;
  /** Active radio, if the queue is a radio mix. */
  radio: RadioState | null;
  /** Start a radio mix seeded from a track, album or artist; `title` names it ("Radio based on <title>"). */
  startRadio: (seedId: string, title: string) => Promise<void>;
  /** Local audio output hooks for lyrics, karaoke and visualisers (stable object). */
  output: MusicOutputApi;
  /** The live deck plays an alternative source (karaoke stem mix) instead of the track's own stream. */
  altSource: string | null;
}

export interface MusicOutputApi {
  /** Precise media position of the live deck (ms), for per-frame lyrics / visualisers. */
  timeMs: () => number;
  /** Audio output latency (ms). */
  latencyMs: () => number;
  /** Analyser tapped (fan-out) after the output chain; null when Web Audio isn't in use. */
  analyser: () => AnalyserNode | null;
  /** Create / resume the Web Audio graph (call from a user gesture). Returns whether Web Audio is active. */
  ensureGraph: () => boolean;
  /** Quick karaoke vocal level 0..1 (1 = off). */
  setVocalLevel: (level: number) => void;
  /** Play `url` (a seekable audio file, e.g. the server's karaoke mix) on the live deck from the current position; null = back to the normal stream. */
  setAltSource: (url: string | null) => Promise<void>;
}

const Ctx = createContext<MusicApi | null>(null);
/**
 * Stable actions for components that start playback but don't show player state (every poster card via
 * usePlayItem). The full context changes on every timeupdate while something plays, which re-rendered each card on
 * screen four times a second; this one never changes.
 */
type MusicActions = Pick<MusicApi, 'playQueue'>;
const ActionsCtx = createContext<MusicActions | null>(null);
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
  const outRef = useRef<MusicOutput | null>(null);
  if (!outRef.current && typeof Audio !== 'undefined') {
    outRef.current = new MusicOutput((el) => {
      // Lets DJ mode step aside when normal music starts (detached elements' events don't reach the document).
      el.addEventListener('play', () => window.dispatchEvent(new Event('mediamax:media-play')));
    });
  }
  const out = outRef.current;
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
  const [sleep, setSleepState] = useState<SleepTimer | null>(null);
  const [radio, setRadio] = useState<RadioState | null>(null);
  /** Requested start position for the next track load (bookmarks). */
  const startAtRef = useRef<{ id: string; ms: number } | null>(null);
  /** Load the next track paused (sleep timer "end of part"). */
  const holdRef = useRef(false);
  /** The live deck already plays this queue entry (gapless / crossfade handover): the load effect adopts it. */
  const adoptRef = useRef<{ itemId: string; index: number } | null>(null);
  /** A handover is scheduled or running (don't start another). */
  const handoverRef = useRef<{ timer: number | null; fromDeck: 0 | 1 } | null>(null);
  /** Sleep-timer fade factor (0–1) applied on top of the volume. */
  const sleepFactorRef = useRef(1);
  const { system, user } = useApp();
  const crossfadeSec = Math.max(0, Math.min(12, user?.preferences.musicCrossfadeSec ?? 0));
  const rgMode = user?.preferences.replayGain ?? 'auto';
  const current = index >= 0 ? queue[index] ?? null : null;
  const stateRef = useRef({ queue, index, repeat, durationMs, positionMs, chapters, volume, muted, sleep, shuffle, crossfadeSec, rgMode, radio });
  stateRef.current = { queue, index, repeat, durationMs, positionMs, chapters, volume, muted, sleep, shuffle, crossfadeSec, rgMode, radio };
  const playingRef = useRef(playing);
  playingRef.current = playing;
  /** Karaoke: the live deck plays this URL instead of the track's stream. */
  const altRef = useRef<{ itemId: string; url: string } | null>(null);
  const [altSource, setAltSourceState] = useState<string | null>(null);

  /** Route audio through Web Audio (gain ramps, ReplayGain boost) — except on iOS unless crossfade is on. */
  const wantGraph = () => !SUSPENDS_WEB_AUDIO_IN_BACKGROUND || stateRef.current.crossfadeSec > 0;
  /** The live deck's element (null during SSR). */
  const liveEl = () => out?.active.el ?? null;

  /* ---------------- output levels ---------------- */
  const applyMaster = useCallback(() => {
    const st = stateRef.current;
    out?.setMaster(st.muted ? 0 : st.volume * sleepFactorRef.current);
  }, [out]);

  /** ReplayGain for the item loaded on a deck, in the current queue context. */
  const deckGain = useCallback((d: Deck) => {
    const st = stateRef.current;
    const item = st.queue[d.queueIndex]?.id === d.itemId ? st.queue[d.queueIndex] : st.queue.find((q) => q.id === d.itemId);
    return replayGainFactor(item, st.rgMode, isAlbumInOrder(st.queue, item ?? null, st.shuffle));
  }, []);

  /* ---------------- Google Cast ---------------- */
  // The SDK is only loaded once something is playing.
  const cast = useCast(!!current);
  const castRef = useRef(cast);
  castRef.current = cast;
  const castingRef = useRef(false);
  const castSidRef = useRef<string | null>(null);
  const castOffsetRef = useRef(0);
  const [casting, setCasting] = useState(false);
  const castEndHandled = useRef<string | null>(null);

  const reportCast = useCallback((state: 'playing' | 'paused' | 'stopped', keepalive = false) => {
    const sid = castSidRef.current;
    if (!sid) return;
    const pos = castOffsetRef.current + castRef.current.remote.currentTime * 1000;
    api.playback.progress(sid, { positionMs: Math.round(pos), durationMs: stateRef.current.durationMs || undefined, state, sessionId: sid }, keepalive).catch(() => {});
  }, []);
  const endCastSession = useCallback((keepalive = false) => {
    const sid = castSidRef.current;
    if (!sid) return;
    reportCast('stopped', keepalive);
    api.playback.stop(sid, keepalive).catch(() => {});
    castSidRef.current = null;
  }, [reportCast]);

  /** Play `item` on the Cast device from `startMs`. */
  const castTrackRef = useRef<(item: Item, startMs: number) => Promise<void>>(async () => {});
  castTrackRef.current = async (item: Item, startMs: number) => {
    endCastSession();
    const pi = await api.playback.start(item.id, { startMs: startMs || undefined, deviceProfile: castDeviceProfile(null, true) });
    if (!castingRef.current) {
      api.playback.stop(pi.sessionId).catch(() => {});
      return;
    }
    castSidRef.current = pi.sessionId;
    castOffsetRef.current = pi.streamStartMs ?? 0;
    castEndHandled.current = null;
    setInfo(pi);
    setPosition(startMs);
    const base = system?.publicUrl;
    claimCast('music');
    await castRef.current.load({
      url: absoluteUrl(pi.url, base)!,
      contentType: castContentType(pi.mimeType, pi.isHls),
      kind: item.type === 'track' ? 'music' : 'generic',
      title: pi.title || item.title,
      subtitle: pi.subtitle ?? item.grandparentTitle ?? item.parentTitle ?? null,
      album: item.type === 'track' ? item.parentTitle : null,
      imageUrl: absoluteUrl(pi.posterUrl ?? item.posterUrl ?? item.thumbUrl, base),
      startSeconds: Math.max(0, (startMs - castOffsetRef.current) / 1000),
    });
    reportCast('playing');
  };

  /* ---------------- deck sessions ---------------- */
  const reportDeck = useCallback((d: Deck, state: 'playing' | 'paused' | 'stopped', keepalive = false) => {
    const sid = d.sessionId;
    if (!sid) return;
    api.playback
      .progress(sid, { positionMs: Math.round(d.offsetMs + d.el.currentTime * 1000), durationMs: (d.info?.durationMs ?? stateRef.current.durationMs) || undefined, state, sessionId: sid }, keepalive)
      .catch(() => {});
  }, []);
  const report = useCallback((state: 'playing' | 'paused' | 'stopped', keepalive = false) => {
    if (out) reportDeck(out.active, state, keepalive);
  }, [out, reportDeck]);

  /** Stop a deck: end its server session and detach its stream. `report` = it was heard (send a final progress). */
  const releaseDeck = useCallback((d: Deck, keepalive = false) => {
    d.token++;
    const sid = d.sessionId;
    if (sid) {
      // Only a deck that actually played reports progress; a preloaded one never started.
      if (d.el.currentTime > 0) reportDeck(d, 'stopped', keepalive);
      api.playback.stop(sid, keepalive).catch(() => {});
    }
    d.sessionId = null;
    d.attached?.destroy();
    d.attached = null;
    d.info = null;
    d.itemId = null;
    d.queueIndex = -1;
    d.pendingSeek = null;
    d.ready = false;
  }, [reportDeck]);

  const stopSession = useCallback((keepalive = false) => {
    if (out) releaseDeck(out.active, keepalive);
  }, [out, releaseDeck]);

  /** Cancel a scheduled handover and silence the deck that is fading out, if any. */
  const cancelHandover = useCallback(() => {
    const h = handoverRef.current;
    if (!h || !out) return;
    if (h.timer != null) window.clearTimeout(h.timer);
    handoverRef.current = null;
    const from = out.decks[h.fromDeck];
    if (from !== out.active) {
      from.el.pause();
      releaseDeck(from);
      out.setFade(from.id, 1);
    }
  }, [out, releaseDeck]);

  /** Attach `item` to deck `d`. Returns false when superseded or failed. */
  const loadDeck = useCallback(async (d: Deck, item: Item, queueIndex: number, startMs: number, onFatal: (msg: string) => void): Promise<boolean> => {
    releaseDeck(d);
    const token = ++d.token;
    d.itemId = item.id;
    d.queueIndex = queueIndex;
    const pi = await api.playback.start(item.id, { startMs: startMs || undefined, deviceProfile: profileWithBitrate(null) });
    if (token !== d.token || castingRef.current) {
      api.playback.stop(pi.sessionId).catch(() => {});
      return false;
    }
    d.sessionId = pi.sessionId;
    d.offsetMs = pi.streamStartMs ?? 0;
    d.pendingSeek = startMs > 0 ? startMs : null;
    d.info = pi;
    d.attached = await attachStream(d.el, pi, { onFatal: (_k, msg) => (token === d.token ? onFatal(msg) : undefined) });
    if (token !== d.token) return false;
    d.ready = true;
    return true;
  }, [releaseDeck]);

  const setMediaSession = (item: Item, pi: PlaybackInfo | null) => {
    if (!('mediaSession' in navigator)) return;
    const art = pi?.posterUrl || item.posterUrl;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: pi?.title || item.title,
      artist: pi?.subtitle ?? item.grandparentTitle ?? item.parentTitle ?? '',
      album: item.parentTitle ?? '',
      artwork: art ? [{ src: art, sizes: '512x512' }] : [],
    });
  };

  // Load the current track.
  useEffect(() => {
    if (!out) return;
    const d = out.active;
    if (altRef.current && altRef.current.itemId !== current?.id) {
      altRef.current = null;
      setAltSourceState(null);
    }
    if (!current) {
      adoptRef.current = null;
      cancelHandover();
      releaseDeck(out.standby);
      stopSession();
      if (castingRef.current && castSidRef.current) castRef.current.stop();
      endCastSession();
      setInfo(null);
      setPlaying(false);
      return;
    }
    setChapters(current.chapters ?? []);
    // Gapless / crossfade handover: the live deck already plays this entry.
    const adopt = adoptRef.current;
    if (adopt && adopt.itemId === current.id && adopt.index === index && d.itemId === current.id) {
      adoptRef.current = null;
      setInfo(d.info);
      setDuration(d.info?.durationMs ?? current.durationMs ?? 0);
      setPosition(d.offsetMs + d.el.currentTime * 1000);
      setLoading(false);
      setMediaSession(current, d.info);
      return;
    }
    adoptRef.current = null;
    cancelHandover();
    let cancelled = false;
    setLoading(true);
    setPosition(0);
    setDuration(current.durationMs ?? 0);
    const startAt = startAtRef.current?.id === current.id ? startAtRef.current.ms : null;
    startAtRef.current = null;
    const resumeMs = startAt ?? (hasAudioResume(current) && isResumable(current) ? current.userData.positionMs : 0);
    (async () => {
      try {
        // Next/previous onto the track the standby deck has already prepared: swap decks, no reload.
        const sb = out.standby;
        if (!castingRef.current && startAt == null && !hasAudioResume(current) && sb.ready && sb.itemId === current.id) {
          d.el.pause();
          stopSession();
          out.swap();
          sb.queueIndex = index;
          out.setFade(sb.id, 1);
          out.setReplayGain(sb.id, deckGain(sb));
          setInfo(sb.info);
          if (sb.el.currentTime > 0) sb.el.currentTime = 0;
          if (holdRef.current) {
            holdRef.current = false;
            setPlaying(false);
          } else await sb.el.play().catch(() => setPlaying(false));
          setMediaSession(current, sb.info);
          return;
        }
        d.el.pause();
        stopSession();
        // Pick up the latest saved position (the queued copy may be stale) and the chapters,
        // which are only included on GET /items/:id.
        let startMs = resumeMs;
        if (hasAudioResume(current)) {
          const fresh = await api.items.get(current.id).catch(() => null);
          if (fresh) {
            if (startAt == null) startMs = isResumable(fresh) ? fresh.userData.positionMs : 0;
            if (!cancelled && fresh.chapters) setChapters(fresh.chapters);
          }
        }
        if (cancelled) return;
        if (castingRef.current) {
          endCastSession();
          await castTrackRef.current(current, startMs);
          return;
        }
        const ok = await loadDeck(d, current, index, startMs, (msg) => {
          toast.error(`Can't play "${current.title}": ${msg}`);
          setPlaying(false);
        });
        if (!ok || cancelled) return;
        setInfo(d.info);
        out.setFade(d.id, 1);
        out.setReplayGain(d.id, deckGain(d));
        if (holdRef.current) {
          holdRef.current = false;
          setPlaying(false);
        } else await d.el.play().catch(() => setPlaying(false));
        setMediaSession(current, d.info);
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
    const cur = stateRef.current.queue[stateRef.current.index];
    if (!out || !cur) return;
    if (castingRef.current) {
      castRef.current.seek(Math.max(0, (ms - castOffsetRef.current) / 1000));
      setPosition(ms);
      return;
    }
    cancelHandover();
    const d = out.active;
    const a = d.el;
    const local = (ms - d.offsetMs) / 1000;
    if (local >= 0 && (!d.info?.isHls || (a.seekable.length && local <= a.seekable.end(a.seekable.length - 1) + 1))) {
      a.currentTime = local;
      return;
    }
    // Outside what the stream covers: ask the server for a new stream at that point.
    void (async () => {
      try {
        const ok = await loadDeck(d, cur, stateRef.current.index, Math.round(ms), (msg) => toast.error(msg));
        if (!ok) return;
        setInfo(d.info);
        await a.play().catch(() => setPlaying(false));
      } catch (e) {
        toast.error(e);
      }
    })();
  };

  /** Switch the live deck to / from an alternative source (karaoke mix), keeping the position. */
  const altSourceRef = useRef<(url: string | null) => Promise<void>>(async () => {});
  altSourceRef.current = async (url: string | null) => {
    const cur = stateRef.current.queue[stateRef.current.index];
    if (!out || !cur || castingRef.current) return;
    const same = url ? altRef.current?.url === url && altRef.current.itemId === cur.id : !altRef.current;
    if (same) return;
    const d = out.active;
    const pos = d.offsetMs + d.el.currentTime * 1000;
    const wasPlaying = !d.el.paused;
    if (url) {
      altRef.current = { itemId: cur.id, url };
      d.attached?.destroy();
      d.attached = null;
      d.offsetMs = 0;
      d.pendingSeek = pos;
      if (d.info) d.info = { ...d.info, isHls: false };
      d.el.src = withToken(url);
      setAltSourceState(url);
      if (wasPlaying) await d.el.play().catch(() => setPlaying(false));
      return;
    }
    altRef.current = null;
    setAltSourceState(null);
    try {
      const ok = await loadDeck(d, cur, stateRef.current.index, Math.round(pos), (msg) => toast.error(msg));
      if (ok) {
        setInfo(d.info);
        if (wasPlaying) await d.el.play().catch(() => setPlaying(false));
      }
    } catch (e) {
      toast.error(e);
    }
  };
  const outputApi = useMemo<MusicOutputApi>(() => ({
    timeMs: () => {
      const d = out?.active;
      return d ? d.offsetMs + d.el.currentTime * 1000 : 0;
    },
    latencyMs: () => out?.latencyMs ?? 0,
    analyser: () => out?.analyser ?? null,
    ensureGraph: () => {
      out?.prime(true);
      return !!out?.webAudio;
    },
    setVocalLevel: (v: number) => out?.setVocalLevel(v),
    setAltSource: (url: string | null) => altSourceRef.current(url),
  }), [out]);

  const goto = useCallback((i: number) => {
    const { queue: q } = stateRef.current;
    if (i < 0 || i >= q.length) return;
    setIndex(i);
  }, []);

  /** Queue position that follows the current one (-1 = none). */
  const nextIndexOf = useCallback(() => {
    const { queue: q, index: i, repeat: r } = stateRef.current;
    if (i + 1 < q.length) return i + 1;
    if (r === 'all' && q.length) return 0;
    return -1;
  }, []);

  const next = useCallback(() => {
    out?.prime(wantGraph());
    const n = nextIndexOf();
    if (n >= 0) setIndex(n);
    else {
      cancelHandover();
      liveEl()?.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextIndexOf, cancelHandover, out]);

  const prev = useCallback(() => {
    out?.prime(wantGraph());
    const a = liveEl();
    if (castingRef.current) {
      const pos = castOffsetRef.current + castRef.current.remote.currentTime * 1000;
      if (pos > 4000 || stateRef.current.index <= 0) seekRef.current(0);
      else setIndex(stateRef.current.index - 1);
      return;
    }
    const off = out?.active.offsetMs ?? 0;
    if (a && off + a.currentTime * 1000 > 4000) {
      if (off) seekRef.current(0);
      else a.currentTime = 0;
      return;
    }
    const { index: i } = stateRef.current;
    if (i > 0) setIndex(i - 1);
    else if (a) a.currentTime = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [out]);

  /* ---------------- gapless & crossfade ---------------- */
  /** Should the move from `a` to `b` crossfade (vs. a plain gapless join)? Albums played in order stay gapless. */
  const fadeSecFor = useCallback((a: Item | undefined, b: Item | undefined) => {
    const st = stateRef.current;
    if (!st.crossfadeSec || !a || !b || a.type !== 'track' || b.type !== 'track') return 0;
    if (!st.shuffle && a.parentId && a.parentId === b.parentId) return 0;
    const shortest = Math.min(a.durationMs || Infinity, b.durationMs || Infinity) / 1000;
    return Math.max(0, Math.min(st.crossfadeSec, shortest / 3));
  }, []);

  const preloadingRef = useRef(false);
  /** Prepare the next queue entry on the standby deck (music only, local playback). */
  const maybePreload = useCallback(() => {
    if (!out || castingRef.current || preloadingRef.current || handoverRef.current) return;
    const st = stateRef.current;
    if (st.repeat === 'one' || st.sleep?.mode === 'part') return;
    const n = nextIndexOf();
    const item = st.queue[n];
    const cur = st.queue[st.index];
    if (!item || !cur || hasAudioResume(item) || hasAudioResume(cur)) return;
    const sb = out.standby;
    if (sb.itemId === item.id && (sb.ready || sb.sessionId)) return;
    const d = out.active;
    const remaining = (d.el.duration - d.el.currentTime) * 1000;
    if (!Number.isFinite(remaining) || remaining > PRELOAD_LEAD_MS + fadeSecFor(cur, item) * 1000) return;
    preloadingRef.current = true;
    out.setFade(sb.id, 0);
    loadDeck(sb, item, n, 0, () => releaseDeck(sb))
      .then((ok) => {
        if (ok) out.setReplayGain(sb.id, deckGain(sb));
      })
      .catch(() => releaseDeck(sb)) // e.g. stream limit reached: fall back to a normal track change
      .finally(() => {
        preloadingRef.current = false;
      });
  }, [out, nextIndexOf, fadeSecFor, loadDeck, releaseDeck, deckGain]);

  /** Start the standby deck now: gapless join (fadeSec 0) or crossfade. */
  const handover = useCallback((fadeSec: number) => {
    if (!out) return false;
    const from = out.active;
    const to = out.standby;
    const n = nextIndexOf();
    const st = stateRef.current;
    if (n < 0 || !to.ready || to.itemId !== st.queue[n]?.id) return false;
    out.resume();
    to.queueIndex = n;
    out.swap();
    out.setReplayGain(to.id, deckGain(to));
    if (fadeSec > 0) {
      handoverRef.current = { timer: null, fromDeck: from.id };
      out.setFade(to.id, 0);
      void out.fadeTo(to.id, 1, fadeSec);
      void out.fadeTo(from.id, 0, fadeSec).then(() => {
        if (handoverRef.current?.fromDeck !== from.id) return;
        handoverRef.current = null;
        from.el.pause();
        releaseDeck(from);
        out.setFade(from.id, 1);
      });
    } else {
      out.setFade(to.id, 1);
      // The outgoing deck is freed when it ends; make sure it is even if 'ended' never comes.
      const tok = from.token;
      window.setTimeout(() => {
        if (from.token === tok && out.active !== from) {
          from.el.pause();
          releaseDeck(from);
        }
      }, 3000);
    }
    void to.el.play().catch(() => setPlaying(false));
    adoptRef.current = { itemId: to.itemId!, index: n };
    setIndex(n);
    setInfo(to.info);
    setPosition(0);
    setDuration(to.info?.durationMs ?? st.queue[n]?.durationMs ?? 0);
    return true;
  }, [out, nextIndexOf, deckGain, releaseDeck]);

  /** Called on every timeupdate of the live deck: preload, then start the next track on time. */
  const checkTransition = useCallback(() => {
    if (!out || castingRef.current || handoverRef.current) return;
    maybePreload();
    const st = stateRef.current;
    const d = out.active;
    const to = out.standby;
    if (!to.ready || d.el.paused) return;
    const remainingMs = ((d.el.duration - d.el.currentTime) * 1000) / (d.el.playbackRate || 1);
    if (!Number.isFinite(remainingMs)) return;
    const fade = fadeSecFor(st.queue[st.index], st.queue[nextIndexOf()]);
    if (fade > 0) {
      if (remainingMs <= fade * 1000) handover(Math.min(fade, remainingMs / 1000));
      return;
    }
    if (remainingMs <= HANDOVER_WINDOW_MS) {
      // timeupdate only fires every ~250 ms: time the gapless start precisely with a timer.
      const wait = Math.max(0, remainingMs - HANDOVER_LEAD_MS);
      const timer = window.setTimeout(() => {
        if (handoverRef.current?.timer !== timer) return;
        handoverRef.current = null;
        handover(0);
      }, wait);
      handoverRef.current = { timer, fromDeck: d.id };
    }
  }, [out, maybePreload, fadeSecFor, nextIndexOf, handover]);

  // A stale preload (queue edited, repeat/shuffle changed): drop it so the right track is prepared.
  useEffect(() => {
    if (!out || handoverRef.current) return;
    const sb = out.standby;
    // Not loaded, or the outgoing track of a gapless join playing out its last milliseconds.
    if (!sb.itemId || (!sb.el.paused && sb.el.currentTime > 0)) return;
    const n = nextIndexOf();
    if (queue[n]?.id !== sb.itemId || repeat === 'one') releaseDeck(sb);
  }, [queue, index, repeat, shuffle, out, nextIndexOf, releaseDeck]);

  // Element events (both decks; only the live one drives the UI).
  useEffect(() => {
    if (!out) return;
    const cleanups = out.decks.map((d) => {
      const a = d.el;
      const live = () => out.active === d;
      const onTime = () => {
        if (!live()) return;
        setPosition(d.offsetMs + a.currentTime * 1000);
        checkTransition();
      };
      const onDur = () => {
        if (!live() || !isFinite(a.duration)) return;
        // Keep the item's full duration when the stream starts part-way through.
        setDuration((dur) => Math.max(d.offsetMs + a.duration * 1000, d.offsetMs ? dur : 0));
      };
      const onMeta = () => {
        const target = d.pendingSeek;
        d.pendingSeek = null;
        if (target == null) return;
        const local = (target - d.offsetMs) / 1000;
        if (local > 0.5) a.currentTime = local;
      };
      const onPlay = () => {
        out.resume();
        if (!live()) return;
        setPlaying(true);
        report('playing');
      };
      const onPause = () => {
        if (!live()) return;
        setPlaying(false);
        if (!a.ended) report('paused');
      };
      const onEnded = () => {
        if (!live()) {
          // The outgoing deck of a gapless join finished: free it.
          if (d.el.currentTime > 0) releaseDeck(d);
          return;
        }
        const { repeat: r, sleep: sl } = stateRef.current;
        if (sl?.mode === 'part') {
          // Sleep timer "end of part": move on, but load the next part paused.
          setSleepState(null);
          sleepFactorRef.current = 1;
          applyMaster();
          holdRef.current = stateRef.current.index + 1 < stateRef.current.queue.length || r === 'all';
          next();
          return;
        }
        if (r === 'one') {
          a.currentTime = 0;
          void a.play();
          return;
        }
        // Gapless fallback when the timer didn't get there first.
        const h = handoverRef.current;
        if (h?.timer != null) window.clearTimeout(h.timer);
        handoverRef.current = null;
        if (!handover(0)) next();
      };
      a.addEventListener('timeupdate', onTime);
      a.addEventListener('loadedmetadata', onMeta);
      a.addEventListener('durationchange', onDur);
      a.addEventListener('play', onPlay);
      a.addEventListener('pause', onPause);
      a.addEventListener('ended', onEnded);
      return () => {
        a.removeEventListener('timeupdate', onTime);
        a.removeEventListener('loadedmetadata', onMeta);
        a.removeEventListener('durationchange', onDur);
        a.removeEventListener('play', onPlay);
        a.removeEventListener('pause', onPause);
        a.removeEventListener('ended', onEnded);
      };
    });
    const iv = window.setInterval(() => {
      if (!out.active.el.paused) report('playing');
    }, 10000);
    const unload = () => {
      releaseDeck(out.standby, true);
      stopSession(true);
    };
    window.addEventListener('pagehide', unload);
    return () => {
      cleanups.forEach((c) => c());
      window.clearInterval(iv);
      window.removeEventListener('pagehide', unload);
    };
  }, [out, next, report, stopSession, releaseDeck, checkTransition, handover, applyMaster]);

  useEffect(() => {
    if (castingRef.current) castRef.current.setVolume(volume);
    else applyMaster();
    try {
      localStorage.setItem(VOL_KEY, String(volume));
    } catch {
      /* ignore */
    }
  }, [volume, applyMaster]);
  useEffect(() => {
    if (castingRef.current) castRef.current.setMuted(muted);
    else applyMaster();
  }, [muted, applyMaster]);

  // ReplayGain follows the queue context (album in order or not) and the preference.
  useEffect(() => {
    if (!out) return;
    for (const d of out.decks) if (d.itemId) out.setReplayGain(d.id, deckGain(d));
  }, [out, queue, index, shuffle, rgMode, deckGain]);

  /** Start local playback of the current track at `ms` (after casting ends). */
  const resumeLocal = useCallback(async (ms: number, autoplay: boolean) => {
    const cur = stateRef.current.queue[stateRef.current.index];
    if (!out || !cur) return;
    try {
      const d = out.active;
      const ok = await loadDeck(d, cur, stateRef.current.index, Math.round(ms), (msg) => toast.error(msg));
      if (!ok) return;
      setInfo(d.info);
      out.setFade(d.id, 1);
      out.setReplayGain(d.id, deckGain(d));
      applyMaster();
      if (autoplay) await d.el.play().catch(() => setPlaying(false));
    } catch (e) {
      toast.error(e);
    }
  }, [out, loadDeck, deckGain, applyMaster, toast]);

  /** Move the current track to the Cast device. */
  const takeOverCast = useCallback(() => {
    const cur = stateRef.current.queue[stateRef.current.index];
    castingRef.current = true;
    setCasting(true);
    if (!out || !cur) return;
    cancelHandover();
    const d = out.active;
    const pos = d.offsetMs + d.el.currentTime * 1000;
    d.el.pause();
    stopSession();
    releaseDeck(out.standby);
    setLoading(true);
    castTrackRef.current(cur, pos)
      .catch((e) => toast.error(`Cast failed: ${errorMessage(e)}`))
      .finally(() => setLoading(false));
  }, [out, cancelHandover, stopSession, releaseDeck, toast]);

  // Hand over to / back from the Cast device. Music only claims a new Cast session when it's the
  // active player (not while a video or live channel is open, which cast themselves).
  useEffect(() => {
    if (cast.connected && !castingRef.current) {
      const onPlayerPage = /^\/(play|watch)\//.test(window.location.pathname);
      if (!onPlayerPage && stateRef.current.index >= 0) takeOverCast();
    } else if (!cast.connected && castingRef.current) {
      const pos = castOffsetRef.current + castRef.current.remote.currentTime * 1000;
      castingRef.current = false;
      setCasting(false);
      endCastSession();
      // Resume locally, paused: don't suddenly start playing out of this device's speakers.
      void resumeLocal(pos, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cast.connected]);

  // Another player took the Cast device: stop mirroring it.
  useEffect(() => {
    const h = (e: Event) => {
      if ((e as CustomEvent<CastOwner>).detail === 'music' || !castingRef.current) return;
      castingRef.current = false;
      setCasting(false);
      endCastSession();
      setPlaying(false);
    };
    window.addEventListener(CAST_OWNER_EVENT, h);
    return () => window.removeEventListener(CAST_OWNER_EVENT, h);
  }, [endCastSession]);

  // Mirror the remote player.
  const remote = cast.remote;
  useEffect(() => {
    if (!casting || castOwner() !== 'music') return;
    setPosition(castOffsetRef.current + remote.currentTime * 1000);
    if (remote.duration > 0) setDuration((d) => Math.max(d, castOffsetRef.current + remote.duration * 1000));
  }, [casting, remote.currentTime, remote.duration]);
  useEffect(() => {
    if (!casting || castOwner() !== 'music' || !castSidRef.current) return;
    const sid = castSidRef.current;
    if (remote.playerState === 'IDLE' && remote.idleReason === 'FINISHED') {
      if (castEndHandled.current === sid) return;
      castEndHandled.current = sid;
      setPlaying(false);
      reportCast('stopped');
      const { repeat: r, queue: q, index: i } = stateRef.current;
      if (r === 'one' && q[i]) void castTrackRef.current(q[i]!, 0).catch(() => undefined);
      else next();
      return;
    }
    const isPlaying = remote.playerState === 'PLAYING' || remote.playerState === 'BUFFERING';
    setPlaying(isPlaying && !remote.isPaused);
    if (remote.playerState === 'PLAYING' || remote.playerState === 'PAUSED') reportCast(remote.isPaused ? 'paused' : 'playing');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [casting, remote.playerState, remote.isPaused, remote.idleReason]);
  useEffect(() => {
    if (!casting) return;
    const iv = window.setInterval(() => {
      if (castOwner() === 'music' && !castRef.current.remote.isPaused) reportCast('playing');
    }, 10000);
    const unload = () => endCastSession(true);
    window.addEventListener('pagehide', unload);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener('pagehide', unload);
    };
  }, [casting, reportCast, endCastSession]);

  const togglePlayback = useCallback(() => {
    if (!out || stateRef.current.index < 0) return;
    if (castingRef.current) {
      castRef.current.playOrPause();
      return;
    }
    if (castRef.current.connected) {
      // Connected but another player had the device: bring the music back to it.
      takeOverCast();
      return;
    }
    out.prime(wantGraph());
    const a = out.active.el;
    if (a.paused) void a.play();
    else {
      cancelHandover();
      a.pause();
    }
  }, [out, takeOverCast, cancelHandover]);
  const pausePlayback = useCallback(() => {
    if (castingRef.current) {
      if (!castRef.current.remote.isPaused) castRef.current.playOrPause();
      return;
    }
    cancelHandover();
    liveEl()?.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancelHandover]);

  // Media session controls.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    try {
      ms.setActionHandler('play', () => (castingRef.current ? togglePlayback() : void liveEl()?.play()));
      ms.setActionHandler('pause', pausePlayback);
      ms.setActionHandler('nexttrack', next);
      ms.setActionHandler('previoustrack', prev);
    } catch {
      /* unsupported action */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [next, prev, togglePlayback, pausePlayback]);

  /* ---------------- Sleep timer ---------------- */
  const setSleep = useCallback((opt: SleepOption | null) => {
    sleepFactorRef.current = 1;
    if (!castingRef.current) applyMaster();
    if (!opt) {
      setSleepState(null);
      return;
    }
    if (opt === 'part') {
      setSleepState({ mode: 'part' });
      return;
    }
    if (opt === 'chapter') {
      const { chapters: ch, positionMs: pos, durationMs: dur, queue: q, index: i } = stateRef.current;
      const cur = q[i];
      if (!cur || !ch.length) return;
      const nextStart = ch.find((c) => c.startMs > pos + 500)?.startMs;
      setSleepState({ mode: 'chapter', itemId: cur.id, endMs: nextStart ?? dur });
      return;
    }
    setSleepState({ mode: 'time', minutes: opt.minutes, endsAt: Date.now() + opt.minutes * 60_000 });
  }, [applyMaster]);

  useEffect(() => {
    if (!sleep) return;
    const fire = () => {
      setSleepState(null);
      pausePlayback();
      window.setTimeout(() => {
        sleepFactorRef.current = 1;
        applyMaster();
      }, 300);
      toast.show('Sleep timer: playback paused');
    };
    const iv = window.setInterval(() => {
      const st = stateRef.current;
      const cur = st.queue[st.index];
      let remaining: number;
      if (sleep.mode === 'time') remaining = sleep.endsAt - Date.now();
      else if (sleep.mode === 'chapter') {
        if (!cur || cur.id !== sleep.itemId) {
          setSleepState(null);
          return;
        }
        remaining = sleep.endMs - st.positionMs;
      } else remaining = st.durationMs > 0 ? st.durationMs - st.positionMs : Infinity;
      if (sleep.mode !== 'time' && !playingRef.current) return;
      if (remaining <= 0 && sleep.mode !== 'part') {
        fire();
        return;
      }
      // Fade out over the last few seconds (local playback only).
      if (!castingRef.current && playingRef.current) {
        const f = Math.max(0, Math.min(1, remaining / SLEEP_FADE_MS));
        sleepFactorRef.current = sleep.mode === 'part' ? Math.max(f, 0.05) : f;
        applyMaster();
      }
    }, 250);
    return () => window.clearInterval(iv);
  }, [sleep, pausePlayback, applyMaster, toast]);

  /* ---------------- Radio ---------------- */
  const radioFetching = useRef(false);
  const radioReq = useRef<DjMixRequest>({});
  const startRadio = useCallback(async (seedId: string, title: string) => {
    out?.prime(wantGraph());
    const label = `Radio based on ${title}`;
    try {
      radioReq.current = { harmonic: true, curve: 'steady' };
      const mix = await api.dj.mix({ seedItemId: seedId, count: 25, harmonic: true, curve: 'steady' });
      if (mix.request) radioReq.current = { ...mix.request, harmonic: true, curve: 'steady' };
      const tracks = mix.tracks.map((t) => t.item).filter(isAudio);
      if (!tracks.length) {
        toast.show('Not enough music to build a radio from this yet');
        return;
      }
      const st = stateRef.current;
      const cur = st.queue[st.index];
      setShuffleState(false);
      setRepeat('off');
      setRadio({ seedId, label });
      if (cur && cur.id === seedId && (playingRef.current || castingRef.current)) {
        // Keep the seed playing; the mix becomes what comes next.
        setQueue([cur, ...tracks.filter((t) => t.id !== cur.id)]);
        if (st.index !== 0) adoptRef.current = { itemId: cur.id, index: 0 };
        if (out) out.active.queueIndex = 0;
        setIndex(0);
      } else {
        startAtRef.current = null;
        setQueue(tracks);
        setIndex(-1);
        window.setTimeout(() => setIndex(0), 0);
      }
      toast.show(label);
    } catch (e) {
      toast.error(e);
    }
  }, [out, toast]);

  // Keep the radio going: top up when only a few tracks are left.
  useEffect(() => {
    if (!radio || radioFetching.current || index < 0) return;
    if (queue.length - index - 1 >= RADIO_LOW_WATER) return;
    radioFetching.current = true;
    const history = queue.map((q) => q.id).slice(-200);
    api.dj
      .mix({ ...radioReq.current, seedItemId: undefined, history, count: 10 })
      .then((mix) => {
        if (stateRef.current.radio?.seedId !== radio.seedId) return;
        const seen = new Set(stateRef.current.queue.map((q) => q.id));
        const more = mix.tracks.map((t) => t.item).filter((t) => isAudio(t) && !seen.has(t.id));
        if (more.length) setQueue((q) => [...q, ...more]);
      })
      .catch(() => {})
      .finally(() => {
        radioFetching.current = false;
      });
  }, [radio, queue, index]);

  // Release the audio graph on unmount.
  useEffect(() => () => out?.close(), [out]);

  const value = useMemo<MusicApi>(
    () => ({
      queue, index, current, info, playing, loading, positionMs, durationMs, volume, muted, shuffle, repeat, chapters,
      playQueue: (items, start = 0, startMs) => {
        if (!items.length) return;
        out?.prime(wantGraph());
        setRadio(null);
        startAtRef.current = startMs != null && items[start] ? { id: items[start]!.id, ms: startMs } : null;
        const list = shuffle && !hasAudioResume(items[start]!) ? [items[start]!, ...shuffled(items.filter((_, i) => i !== start))] : items;
        setQueue(list);
        setIndex(-1);
        window.setTimeout(() => setIndex(shuffle ? 0 : start), 0);
      },
      enqueue: (items, playNext) => {
        setQueue((q) => {
          if (!q.length) {
            out?.prime(wantGraph());
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
      toggle: togglePlayback,
      pause: pausePlayback,
      next,
      prev,
      seek: (ms) => seekRef.current(ms),
      jump: (i, startMs) => {
        const item = stateRef.current.queue[i];
        if (!item) return;
        out?.prime(wantGraph());
        if (i === stateRef.current.index) {
          if (startMs != null) seekRef.current(startMs);
          return;
        }
        startAtRef.current = startMs != null ? { id: item.id, ms: startMs } : null;
        goto(i);
      },
      removeAt: (i) => {
        const cur = queue[index];
        // Removing an entry above the current one only shifts its position: the same track keeps playing.
        if (cur && i < index) adoptRef.current = { itemId: cur.id, index: index - 1 };
        setQueue((q) => q.filter((_, j) => j !== i));
        setIndex((cur) => (i < cur ? cur - 1 : i === cur ? Math.min(cur, queue.length - 2) : cur));
        if (out && out.active.queueIndex > i) out.active.queueIndex--;
      },
      clear: () => {
        cancelHandover();
        liveEl()?.pause();
        if (castingRef.current) castRef.current.stop();
        setRadio(null);
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
          if (cur && index !== 0) {
            // Same track keeps playing; only its queue position changes.
            adoptRef.current = { itemId: cur.id, index: 0 };
            if (out) out.active.queueIndex = 0;
          }
          setIndex(cur ? 0 : -1);
        }
      },
      setRepeat,
      cast,
      casting,
      sleep,
      setSleep,
      radio,
      startRadio,
      output: outputApi,
      altSource,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queue, index, current, info, playing, loading, positionMs, durationMs, volume, muted, shuffle, repeat, chapters, next, prev, goto, togglePlayback, pausePlayback, cast, casting, sleep, setSleep, radio, startRadio, cancelHandover, outputApi, altSource],
  );

  const latest = useRef(value);
  latest.current = value;
  const actions = useMemo<MusicActions>(() => ({ playQueue: (...a) => latest.current.playQueue(...a) }), []);

  return (
    <Ctx.Provider value={value}>
      <ActionsCtx.Provider value={actions}>{children}</ActionsCtx.Provider>
    </Ctx.Provider>
  );
}


/** One function that "plays" any item the right way. */
export function usePlayItem() {
  const navigate = useNavigate();
  const music = useContext(ActionsCtx);
  if (!music) throw new Error('usePlayItem outside MusicProvider');
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
