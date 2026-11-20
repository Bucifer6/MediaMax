import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Item, Marker, PlaybackInfo, TrickplayInfo } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useMusic } from './music';
import { attachStream, type Attached } from './engine';
import { profileWithBitrate, QUALITY_OPTIONS } from './deviceProfile';
import { OptionList, Popover, SeekBar, VolumeControl } from './controls';
import { useSyncPlay } from './syncplay';
import { Icon } from '../components/Icon';
import { Img, Spinner } from '../components/ui';
import { canSearchSubtitles, SubtitleSearchModal } from '../components/SubtitleSearch';
import { ChapterList } from './MiniPlayer';
import { DEFAULT_PREFERENCES } from '../theme/defaults';
import { isTypingTarget } from '../hooks';
import { formatClock, languageName } from '../utils/format';
import { isResumable } from '../utils/items';

type Menu = null | 'audio' | 'subs' | 'quality' | 'speed' | 'together' | 'chapters';
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

interface StartOpts {
  startMs: number;
  audioIndex?: number;
  subtitleIndex: number | null;
  burn: boolean;
  maxBitrate: number | null;
}

export default function VideoPlayer() {
  const { itemId = '' } = useParams();
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useApp();
  const toast = useToast();
  const music = useMusic();
  const prefs = { ...DEFAULT_PREFERENCES, ...(user?.preferences ?? {}) };

  const videoRef = useRef<HTMLVideoElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const attached = useRef<Attached | null>(null);
  const sessionRef = useRef<string | null>(null);
  const offsetRef = useRef(0);
  const pendingSeek = useRef<number | null>(null);
  const optsRef = useRef<StartOpts>({ startMs: 0, subtitleIndex: null, burn: false, maxBitrate: prefs.maxBitrate });
  const trackEls = useRef(new Map<number, HTMLTrackElement>());
  const skippedMarkers = useRef(new Set<string>());

  const [item, setItem] = useState<Item | null>(null);
  const [info, setInfo] = useState<PlaybackInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [buffering, setBuffering] = useState(true);
  const [paused, setPaused] = useState(true);
  const [positionMs, setPositionMs] = useState(0);
  const [bufferedMs, setBufferedMs] = useState(0);
  const [volume, setVolume] = useState(() => {
    try {
      const v = Number(localStorage.getItem('mm.videoVolume'));
      return isFinite(v) && v > 0 && v <= 1 ? v : 1;
    } catch {
      return 1;
    }
  });
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [controls, setControls] = useState(true);
  const [menu, setMenu] = useState<Menu>(null);
  const [subtitleIndex, setSubtitleIndex] = useState<number | null>(null);
  const [burned, setBurned] = useState(false);
  const [audioIndex, setAudioIndex] = useState<number | undefined>(undefined);
  const [maxBitrate, setMaxBitrate] = useState<number | null>(prefs.maxBitrate);
  const [nextItem, setNextItem] = useState<Item | null>(null);
  const [upNextDismissed, setUpNextDismissed] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [ended, setEnded] = useState(false);
  const [osd, setOsd] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [trickplay, setTrickplay] = useState<TrickplayInfo | null>(null);
  const [subSearch, setSubSearch] = useState(false);
  /** Subtitle index to select once the next PlaybackInfo arrives (after an online download). */
  const pendingSubPick = useRef<number | null>(null);

  const durationMs = info?.durationMs ?? item?.durationMs ?? 0;
  const markers: Marker[] = info?.markers?.length ? info.markers : item?.markers ?? [];

  /* ---------------- helpers ---------------- */
  const flash = useCallback((text: string) => {
    setOsd(text);
    window.clearTimeout((flash as unknown as { t?: number }).t);
    (flash as unknown as { t?: number }).t = window.setTimeout(() => setOsd(null), 900);
  }, []);

  const currentMs = useCallback(() => {
    const v = videoRef.current;
    return v ? offsetRef.current + v.currentTime * 1000 : 0;
  }, []);

  const report = useCallback((state: 'playing' | 'paused' | 'stopped', keepalive = false) => {
    const sid = sessionRef.current;
    if (!sid) return;
    api.playback.progress(sid, { positionMs: Math.round(currentMs()), durationMs: durationMs || undefined, state, sessionId: sid }, keepalive).catch(() => {});
  }, [currentMs, durationMs]);

  const endSession = useCallback((keepalive = false) => {
    const sid = sessionRef.current;
    if (!sid) return;
    report('stopped', keepalive);
    api.playback.stop(sid, keepalive).catch(() => {});
    sessionRef.current = null;
  }, [report]);

  /* ---------------- start / restart playback ---------------- */
  const start = useCallback(async (opts: StartOpts) => {
    const v = videoRef.current;
    if (!v) return;
    optsRef.current = opts;
    setError(null);
    setBuffering(true);
    endSession();
    attached.current?.destroy();
    attached.current = null;
    try {
      const pi = await api.playback.start(itemId, {
        startMs: Math.round(opts.startMs),
        audioStreamIndex: opts.audioIndex,
        subtitleStreamIndex: opts.burn ? opts.subtitleIndex : undefined,
        burnSubtitles: opts.burn || undefined,
        deviceProfile: profileWithBitrate(opts.maxBitrate),
      });
      sessionRef.current = pi.sessionId;
      offsetRef.current = 0;
      pendingSeek.current = opts.startMs > 0 ? opts.startMs : pi.startMs > 0 ? pi.startMs : null;
      setInfo(pi);
      setBurned(opts.burn);
      attached.current = await attachStream(v, pi, {
        onFatal: (kind, msg) => {
          if (kind === 'native' && pi.method === 'direct' && !opts.burn) {
            // Browser couldn't decode the original — ask the server to transcode.
            toast.show('Switching to a compatible stream…');
            void start({ ...opts, startMs: currentMs() || opts.startMs, burn: false, maxBitrate: opts.maxBitrate ?? 20000 });
            return;
          }
          setError(msg);
        },
      });
      v.playbackRate = rate;
      await v.play().catch(() => setPaused(true));
    } catch (e) {
      setError(errorMessage(e));
      setBuffering(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId, endSession, rate]);

  // Initial load whenever the item changes.
  useEffect(() => {
    let cancelled = false;
    music.pause();
    setItem(null);
    setInfo(null);
    setNextItem(null);
    setUpNextDismissed(false);
    setCountdown(null);
    setEnded(false);
    setTrickplay(null);
    setSubSearch(false);
    skippedMarkers.current.clear();
    // Scrub previews (404 until the server has generated them — just go without).
    const tpCtrl = new AbortController();
    api.items.trickplay(itemId, undefined, tpCtrl.signal).then((tp) => {
      if (!cancelled && tp.count > 0 && tp.sheets.length) setTrickplay(tp);
    }).catch(() => {});
    (async () => {
      const it = await api.items.get(itemId).catch(() => null);
      if (cancelled) return;
      setItem(it);
      const fromParam = sp.get('start');
      const startMs = fromParam != null ? Number(fromParam) || 0 : it && isResumable(it) ? it.userData.positionMs : 0;
      // Preferred audio language.
      let ai: number | undefined;
      const media = it?.media?.[0];
      if (media && prefs.audioLanguage) {
        const match = media.audioStreams.find((a) => a.language?.toLowerCase().startsWith(prefs.audioLanguage!.toLowerCase()));
        if (match && !match.default) ai = match.index;
      }
      setAudioIndex(ai);
      await start({ startMs, audioIndex: ai, subtitleIndex: null, burn: false, maxBitrate: prefs.maxBitrate });
    })();
    return () => {
      cancelled = true;
      tpCtrl.abort();
      endSession();
      attached.current?.destroy();
      attached.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  // Default subtitle choice once the playback info arrives.
  useEffect(() => {
    if (!info || burned) return;
    const subs = info.subtitles;
    let pick: number | null = null;
    const lang = prefs.subtitleLanguage?.toLowerCase();
    const byLang = (list: typeof subs) => (lang ? list.find((s) => s.language?.toLowerCase().startsWith(lang)) : undefined);
    if (prefs.subtitleMode === 'always') pick = (byLang(subs) ?? subs.find((s) => s.default) ?? subs[0])?.index ?? null;
    else if (prefs.subtitleMode === 'forced') pick = (byLang(subs.filter((s) => s.forced)) ?? subs.find((s) => s.forced))?.index ?? null;
    else if (prefs.subtitleMode === 'auto') pick = (subs.find((s) => s.forced) ?? subs.find((s) => s.default))?.index ?? null;
    const wanted = pendingSubPick.current;
    pendingSubPick.current = null;
    if (wanted != null && subs.some((s) => s.index === wanted)) {
      setSubtitleIndex(wanted);
      return;
    }
    setSubtitleIndex((cur) => (cur != null && subs.some((s) => s.index === cur) ? cur : pick));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.sessionId]);

  // Apply subtitle track modes.
  useEffect(() => {
    trackEls.current.forEach((el, idx) => {
      el.track.mode = !burned && idx === subtitleIndex ? 'showing' : 'disabled';
    });
  }, [subtitleIndex, info, burned]);

  /* ---------------- media element events ---------------- */
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onMeta = () => {
      const target = pendingSeek.current;
      pendingSeek.current = null;
      if (!info) return;
      // Stream time 0 corresponds to media position `streamStartMs` (0 for full-timeline streams).
      offsetRef.current = info.streamStartMs ?? 0;
      if (target != null) {
        const local = (target - offsetRef.current) / 1000;
        if (local > 0.5) v.currentTime = local;
      }
    };
    const onTime = () => {
      setPositionMs(offsetRef.current + v.currentTime * 1000);
      if (v.buffered.length) setBufferedMs(offsetRef.current + v.buffered.end(v.buffered.length - 1) * 1000);
    };
    const onPlay = () => {
      setPaused(false);
      setEnded(false);
      report('playing');
    };
    const onPause = () => {
      setPaused(true);
      if (!v.ended) report('paused');
    };
    const onWaiting = () => setBuffering(true);
    const onPlaying = () => setBuffering(false);
    const onEnded = () => {
      setEnded(true);
      report('stopped');
    };
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('progress', onTime);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('canplay', onPlaying);
    v.addEventListener('ended', onEnded);
    return () => {
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('progress', onTime);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('canplay', onPlaying);
      v.removeEventListener('ended', onEnded);
    };
  }, [info, durationMs, report]);

  // Progress every 10s + on unload.
  useEffect(() => {
    const iv = window.setInterval(() => {
      if (videoRef.current && !videoRef.current.paused) report('playing');
    }, 10000);
    const unload = () => endSession(true);
    window.addEventListener('pagehide', unload);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener('pagehide', unload);
    };
  }, [report, endSession]);

  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      v.volume = volume;
      v.muted = muted;
    }
    try {
      localStorage.setItem('mm.videoVolume', String(volume));
    } catch {
      /* ignore */
    }
  }, [volume, muted]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate]);

  /* ---------------- controls ---------------- */
  const seekTo = useCallback((ms: number, fromRemote = false) => {
    const v = videoRef.current;
    if (!v || !info) return;
    const target = Math.max(0, Math.min(durationMs || Infinity, ms));
    const local = (target - offsetRef.current) / 1000;
    let ok = info.method === 'direct' || !info.isHls;
    if (!ok && local >= 0 && v.seekable.length) {
      const endS = v.seekable.end(v.seekable.length - 1);
      ok = local <= endS + 1;
    }
    if (ok && local >= 0) v.currentTime = local;
    else void start({ ...optsRef.current, startMs: target });
    setPositionMs(target);
    if (!fromRemote) sync.broadcast('seek', target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, durationMs, start]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      void v.play();
      sync.broadcast('play', currentMs());
    } else {
      v.pause();
      sync.broadcast('pause', currentMs());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMs]);

  const sync = useSyncPlay({
    itemId,
    userId: user?.id ?? '',
    userName: user?.displayName || user?.username,
    getPositionMs: currentMs,
    isPaused: () => videoRef.current?.paused ?? true,
    apply: (action, pos) => {
      const v = videoRef.current;
      if (!v) return;
      if (action === 'seek' || Math.abs(currentMs() - pos) > 1500) seekTo(pos, true);
      if (action === 'play') void v.play();
      if (action === 'pause') v.pause();
    },
    load: (id) => navigate(`/play/${id}?start=0`, { replace: true }),
  });

  const goNext = useCallback(() => {
    if (!info?.nextItemId) return;
    sync.broadcast('load', 0, info.nextItemId);
    navigate(`/play/${info.nextItemId}?start=0`, { replace: true });
  }, [info?.nextItemId, navigate, sync]);

  const exit = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    if (window.history.length > 1) navigate(-1);
    else navigate(item ? `/item/${item.id}` : '/');
  }, [navigate, item]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void shellRef.current?.requestFullscreen?.().catch(() => {});
  }, []);
  useEffect(() => {
    const h = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);

  const togglePip = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch (e) {
      toast.error(e);
    }
  }, [toast]);

  const selectAudio = (idx: number) => {
    setMenu(null);
    setAudioIndex(idx);
    void start({ ...optsRef.current, startMs: currentMs(), audioIndex: idx });
  };

  const textSubs = info?.subtitles ?? [];
  const burnOnly = (item?.media?.[0]?.subtitleStreams ?? []).filter((s) => !textSubs.some((t) => t.index === s.index));
  const selectSubtitle = (idx: number | null, burn = false) => {
    setMenu(null);
    setSubtitleIndex(idx);
    if (burn || burned) void start({ ...optsRef.current, startMs: currentMs(), subtitleIndex: idx, burn });
  };
  const cycleSubtitles = () => {
    const list = [null, ...textSubs.map((s) => s.index)];
    const i = list.indexOf(subtitleIndex);
    const next = list[(i + 1) % list.length] ?? null;
    selectSubtitle(next);
    flash(next == null ? 'Subtitles off' : `Subtitles: ${textSubs.find((s) => s.index === next)?.title ?? languageName(textSubs.find((s) => s.index === next)?.language)}`);
  };

  const openSubSearch = () => {
    setMenu(null);
    setSubSearch(true);
  };
  /** A subtitle was downloaded or removed: re-request playback at the current spot so the track list updates. */
  const onSubtitlesChanged = (updated: Item) => {
    const before = new Set((item?.media?.[0]?.subtitleStreams ?? []).map((s) => s.index));
    const added = (updated.media?.[0]?.subtitleStreams ?? []).find((s) => !before.has(s.index));
    setItem(updated);
    pendingSubPick.current = added && !burned ? added.index : null;
    if (!added && subtitleIndex != null && !(updated.media?.[0]?.subtitleStreams ?? []).some((s) => s.index === subtitleIndex)) setSubtitleIndex(null);
    const wasPaused = videoRef.current?.paused ?? false;
    void start({ ...optsRef.current, startMs: currentMs() }).then(() => {
      if (wasPaused) videoRef.current?.pause();
    });
  };

  const selectQuality = (kbps: number | null) => {
    setMenu(null);
    setMaxBitrate(kbps);
    void start({ ...optsRef.current, startMs: currentMs(), maxBitrate: kbps });
  };

  /* ---------------- auto-hide controls ---------------- */
  const hideTimer = useRef<number | null>(null);
  const poke = useCallback(() => {
    setControls(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) {
        setControls(false);
        setMenu(null);
      }
    }, 3200);
  }, []);
  useEffect(() => {
    if (paused) setControls(true);
    else poke();
  }, [paused, poke]);

  /* ---------------- keyboard ---------------- */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (subSearch || isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const v = videoRef.current;
      if (!v) return;
      let handled = true;
      switch (e.key) {
        case ' ':
        case 'k':
        case 'MediaPlayPause':
          togglePlay();
          flash(v.paused ? 'Play' : 'Pause');
          break;
        case 'ArrowLeft':
        case 'j':
          seekTo(currentMs() - (e.shiftKey ? 30000 : 10000));
          flash('« 10s');
          break;
        case 'ArrowRight':
        case 'l':
          seekTo(currentMs() + (e.shiftKey ? 30000 : 10000));
          flash('10s »');
          break;
        case 'ArrowUp':
          setVolume((x) => Math.min(1, +(x + 0.05).toFixed(2)));
          setMuted(false);
          flash(`Volume ${Math.round(Math.min(1, volume + 0.05) * 100)}%`);
          break;
        case 'ArrowDown':
          setVolume((x) => Math.max(0, +(x - 0.05).toFixed(2)));
          flash(`Volume ${Math.round(Math.max(0, volume - 0.05) * 100)}%`);
          break;
        case 'f':
          toggleFullscreen();
          break;
        case 'm':
          setMuted((m) => !m);
          flash(muted ? 'Unmuted' : 'Muted');
          break;
        case 'c':
          cycleSubtitles();
          break;
        case 'p':
          void togglePip();
          break;
        case 'n':
        case 'MediaTrackNext':
          goNext();
          break;
        case '>':
          setRate((r) => SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(r) + 1)] ?? r);
          break;
        case '<':
          setRate((r) => SPEEDS[Math.max(0, SPEEDS.indexOf(r) - 1)] ?? r);
          break;
        case 'Escape':
        case 'Backspace':
          if (menu) setMenu(null);
          else if (!document.fullscreenElement) exit();
          break;
        default:
          if (/^[0-9]$/.test(e.key) && durationMs) seekTo((Number(e.key) / 10) * durationMs);
          else handled = false;
      }
      if (handled) {
        e.preventDefault();
        poke();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  /* ---------------- markers, up next ---------------- */
  const activeSkip = markers.find((m) => (m.type === 'intro' || m.type === 'recap') && positionMs >= m.startMs && positionMs < m.endMs - 1000);
  const inCredits = markers.find((m) => m.type === 'credits' && positionMs >= m.startMs && positionMs < m.endMs);

  useEffect(() => {
    if (!activeSkip || !prefs.skipIntros) return;
    const key = `${activeSkip.type}-${activeSkip.startMs}`;
    if (skippedMarkers.current.has(key)) return;
    skippedMarkers.current.add(key);
    seekTo(activeSkip.endMs);
    flash(`Skipped ${activeSkip.type}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSkip?.startMs]);

  const remaining = durationMs ? durationMs - positionMs : Infinity;
  const nearEnd = !!info?.nextItemId && (!!inCredits || remaining < 30000) && positionMs > 0;
  useEffect(() => {
    if (!info?.nextItemId || nextItem?.id === info.nextItemId) return;
    if (remaining < 90000 || inCredits) api.items.get(info.nextItemId).then(setNextItem).catch(() => {});
  }, [info?.nextItemId, remaining < 90000, !!inCredits]); // eslint-disable-line react-hooks/exhaustive-deps

  const showUpNext = (nearEnd || ended) && !!nextItem && !upNextDismissed;
  useEffect(() => {
    if (!showUpNext || !prefs.autoplayNext || paused && !ended) {
      setCountdown(null);
      return;
    }
    setCountdown((c) => c ?? 10);
  }, [showUpNext, prefs.autoplayNext, paused, ended]);
  useEffect(() => {
    if (countdown == null) return;
    if (countdown <= 0) {
      goNext();
      return;
    }
    const t = window.setTimeout(() => setCountdown((c) => (c == null ? c : c - 1)), 1000);
    return () => window.clearTimeout(t);
  }, [countdown, goNext]);

  /* ---------------- render ---------------- */
  const title = info?.title ?? item?.title ?? '';
  const subtitle = info?.subtitle ?? (item?.type === 'episode' ? `${item.grandparentTitle ?? ''} · S${item.parentIndex ?? '?'} E${item.index ?? '?'}` : item?.year ? String(item.year) : '');
  const qualityLabel = QUALITY_OPTIONS.find((q) => q.kbps === maxBitrate)?.label ?? 'Original';
  const audioStreams = info?.audioStreams ?? item?.media?.[0]?.audioStreams ?? [];
  const currentAudio = audioIndex ?? audioStreams.find((a) => a.default)?.index ?? audioStreams[0]?.index;

  const backdrop = useMemo(() => info?.backdropUrl ?? item?.backdropUrl ?? null, [info?.backdropUrl, item?.backdropUrl]);

  return (
    <div
      ref={shellRef}
      className={`player ${controls ? 'show-controls' : 'hide-controls'} ${fullscreen ? 'is-fs' : ''}`}
      onMouseMove={poke}
      onTouchStart={poke}
    >
      {backdrop && buffering && positionMs < 1000 && <div className="player-backdrop"><Img src={backdrop} width={1920} /></div>}
      <video
        ref={videoRef}
        className="player-video"
        playsInline
        crossOrigin="anonymous"
        onClick={() => { togglePlay(); poke(); }}
        onDoubleClick={toggleFullscreen}
        poster={undefined}
      >
        {!burned && textSubs.map((s) => (
          <track
            key={`${info?.sessionId}-${s.index}`}
            kind="subtitles"
            src={s.url}
            srcLang={s.language ?? undefined}
            label={s.title ?? languageName(s.language)}
            ref={(el) => {
              if (el) {
                trackEls.current.set(s.index, el);
                el.track.mode = s.index === subtitleIndex ? 'showing' : 'disabled';
                el.onload = () => {
                  const off = offsetRef.current / 1000;
                  if (!off || el.dataset.shifted) return;
                  el.dataset.shifted = '1';
                  const cues = el.track.cues;
                  if (cues) for (const c of Array.from(cues)) { c.startTime -= off; c.endTime -= off; }
                };
              } else trackEls.current.delete(s.index);
            }}
          />
        ))}
      </video>

      {(buffering && !error) && <div className="player-center"><Spinner size={56} /></div>}
      {osd && <div className="player-osd">{osd}</div>}

      {error && (
        <div className="player-error">
          <Icon name="alert" size={40} />
          <h2>Playback error</h2>
          <p>{error}</p>
          <div className="row-gap">
            <button className="btn btn-primary" onClick={() => start({ ...optsRef.current, startMs: currentMs() || optsRef.current.startMs })}>
              <Icon name="refresh" size={16} /> Retry
            </button>
            <button className="btn" onClick={() => start({ ...optsRef.current, startMs: currentMs() || optsRef.current.startMs, maxBitrate: 8000 })}>Try lower quality</button>
            <button className="btn btn-ghost" onClick={exit}>Exit</button>
          </div>
        </div>
      )}

      {/* Top bar */}
      <div className="player-top">
        <button className="btn-icon btn-icon-lg" onClick={exit} aria-label="Back"><Icon name="arrowLeft" size={26} /></button>
        <div className="player-titles">
          <div className="player-title">{title}</div>
          {subtitle && <div className="player-subtitle">{subtitle}</div>}
        </div>
        {info && <span className={`badge player-method method-${info.method}`} title="Playback method">{info.method === 'direct' ? 'Direct play' : info.method === 'remux' ? 'Direct stream' : info.method === 'transcode' ? 'Transcoding' : 'Live'}</span>}
        {sync.room && <span className="badge badge-accent"><Icon name="together" size={12} /> {sync.room.members.length} watching</span>}
      </div>

      {/* Skip intro / credits */}
      {activeSkip && !prefs.skipIntros && (
        <button className="skip-btn" onClick={() => seekTo(activeSkip.endMs)}>
          Skip {activeSkip.type === 'recap' ? 'recap' : 'intro'} <Icon name="skipFwd" size={16} />
        </button>
      )}
      {inCredits && !showUpNext && (
        <button className="skip-btn" onClick={() => (info?.nextItemId ? goNext() : seekTo(inCredits.endMs))}>
          {info?.nextItemId ? 'Next episode' : 'Skip credits'} <Icon name="skipFwd" size={16} />
        </button>
      )}

      {/* Up next */}
      {showUpNext && nextItem && (
        <div className="upnext">
          <div className="upnext-art">
            <Img src={nextItem.thumbUrl ?? nextItem.backdropUrl ?? nextItem.posterUrl} width={400} />
            {countdown != null && (
              <svg className="upnext-ring" viewBox="0 0 40 40">
                <circle cx="20" cy="20" r="17" />
                <circle cx="20" cy="20" r="17" className="ring-fill" style={{ strokeDashoffset: `${(countdown / 10) * 107}` }} />
              </svg>
            )}
          </div>
          <div className="upnext-body">
            <small>Up next{countdown != null ? ` in ${countdown}s` : ''}</small>
            <strong>{nextItem.title}</strong>
            {nextItem.type === 'episode' && <span className="muted">S{nextItem.parentIndex} · E{nextItem.index}</span>}
            <div className="row-gap">
              <button className="btn btn-primary btn-sm" onClick={goNext}><Icon name="play" size={14} /> Play now</button>
              <button className="btn btn-ghost btn-sm" onClick={() => { setUpNextDismissed(true); setCountdown(null); }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {ended && !showUpNext && (
        <div className="player-center ended">
          <button className="btn btn-primary btn-lg" onClick={() => seekTo(0)}><Icon name="refresh" size={18} /> Watch again</button>
          <button className="btn btn-glass btn-lg" onClick={exit}>Back</button>
        </div>
      )}

      {/* Bottom controls */}
      <div className="player-bottom" onClick={(e) => e.stopPropagation()}>
        <div className="player-seek-row">
          <span className="player-time">{formatClock(positionMs)}</span>
          <SeekBar positionMs={positionMs} durationMs={durationMs} bufferedMs={bufferedMs} onSeek={(ms) => seekTo(ms)} markers={markers} trickplay={trickplay} />
          <span className="player-time">-{formatClock(Math.max(0, durationMs - positionMs))}</span>
        </div>
        <div className="player-controls">
          <div className="pc-left">
            <button className="btn-icon btn-icon-lg" onClick={togglePlay} aria-label={paused ? 'Play' : 'Pause'}><Icon name={paused ? 'play' : 'pause'} size={30} /></button>
            <button className="btn-icon" onClick={() => seekTo(currentMs() - 10000)} aria-label="Back 10 seconds"><Icon name="rewind10" size={26} /></button>
            <button className="btn-icon" onClick={() => seekTo(currentMs() + 10000)} aria-label="Forward 10 seconds"><Icon name="forward10" size={26} /></button>
            {info?.nextItemId && <button className="btn-icon" onClick={goNext} aria-label="Next"><Icon name="next" size={24} /></button>}
            <VolumeControl volume={volume} muted={muted} onVolume={setVolume} onMute={setMuted} />
          </div>
          <div className="pc-right">
            <div className="pc-menu">
              <button className={`btn-icon ${subtitleIndex != null ? 'active' : ''}`} onClick={() => setMenu(menu === 'subs' ? null : 'subs')} aria-label="Subtitles"><Icon name="subtitles" size={24} /></button>
              <Popover open={menu === 'subs'} onClose={() => setMenu(null)}>
                <OptionList<string>
                  title="Subtitles"
                  value={subtitleIndex == null ? 'off' : `${burned ? 'b' : 't'}${subtitleIndex}`}
                  onSelect={(v) => (v === 'off' ? selectSubtitle(null) : selectSubtitle(Number(v.slice(1)), v[0] === 'b'))}
                  options={[
                    { label: 'Off', value: 'off' },
                    ...textSubs.map((s) => ({ label: s.title || languageName(s.language), value: `t${s.index}`, sub: [s.forced && 'Forced', s.default && 'Default'].filter(Boolean).join(' · ') || undefined })),
                    ...burnOnly.map((s) => ({ label: s.title || languageName(s.language), value: `b${s.index}`, sub: `${s.codec.toUpperCase()} · burn-in (transcodes)` })),
                  ]}
                />
                {canSearchSubtitles(item) && (
                  <button className="option option-action" onClick={openSubSearch}>
                    <span className="option-check"><Icon name="search" size={16} /></span>
                    <span className="option-label">Search online…</span>
                  </button>
                )}
              </Popover>
            </div>
            {(item?.chapters?.length ?? 0) > 0 && (
              <div className="pc-menu">
                <button className={`btn-icon ${menu === 'chapters' ? 'active' : ''}`} onClick={() => setMenu(menu === 'chapters' ? null : 'chapters')} aria-label="Chapters"><Icon name="chapters" size={22} /></button>
                <Popover open={menu === 'chapters'} onClose={() => setMenu(null)} className="chapters-popover">
                  <div className="option-title">Chapters</div>
                  <ChapterList chapters={item!.chapters!} positionMs={positionMs} onSeek={(ms) => { setMenu(null); seekTo(ms); }} />
                </Popover>
              </div>
            )}
            {audioStreams.length > 1 && (
              <div className="pc-menu">
                <button className="btn-icon" onClick={() => setMenu(menu === 'audio' ? null : 'audio')} aria-label="Audio track"><Icon name="audio" size={22} /></button>
                <Popover open={menu === 'audio'} onClose={() => setMenu(null)}>
                  <OptionList<number | undefined>
                    title="Audio"
                    value={currentAudio}
                    onSelect={(v) => v !== undefined && v !== currentAudio && selectAudio(v)}
                    options={audioStreams.map((a) => ({ label: a.title || languageName(a.language), value: a.index, sub: `${a.codec.toUpperCase()} · ${a.channels > 2 ? `${a.channels - 1}.1` : `${a.channels}.0`}` }))}
                  />
                </Popover>
              </div>
            )}
            <div className="pc-menu">
              <button className="btn-icon" onClick={() => setMenu(menu === 'quality' ? null : 'quality')} aria-label="Quality"><Icon name="gauge" size={22} /></button>
              <Popover open={menu === 'quality'} onClose={() => setMenu(null)}>
                <OptionList<number | null> title={`Quality · ${qualityLabel}`} value={maxBitrate} onSelect={selectQuality} options={QUALITY_OPTIONS.map((q) => ({ label: q.label, value: q.kbps }))} />
              </Popover>
            </div>
            <div className="pc-menu">
              <button className="btn-icon pc-speed" onClick={() => setMenu(menu === 'speed' ? null : 'speed')} aria-label="Playback speed">{rate === 1 ? <Icon name="speed" size={22} /> : <span>{rate}×</span>}</button>
              <Popover open={menu === 'speed'} onClose={() => setMenu(null)}>
                <OptionList<number> title="Speed" value={rate} onSelect={(r) => { setRate(r); setMenu(null); }} options={SPEEDS.map((s) => ({ label: s === 1 ? 'Normal' : `${s}×`, value: s }))} />
              </Popover>
            </div>
            <div className="pc-menu">
              <button className={`btn-icon ${sync.room ? 'active' : ''}`} onClick={() => setMenu(menu === 'together' ? null : 'together')} aria-label="Watch together"><Icon name="together" size={22} /></button>
              <Popover open={menu === 'together'} onClose={() => setMenu(null)} className="together-panel">
                <div className="option-title">Watch together</div>
                {sync.room ? (
                  <div className="together-room">
                    <p className="muted">Share this code with friends on any MediaMax device:</p>
                    <div className="room-code">
                      {sync.room.code}
                      <button className="btn-icon" onClick={() => { void navigator.clipboard?.writeText(sync.room!.code); toast.success('Code copied'); }} aria-label="Copy code"><Icon name="copy" size={16} /></button>
                    </div>
                    <ul className="room-members">
                      {sync.room.members.map((m) => (
                        <li key={m.userId}><Icon name="user" size={14} /> {m.displayName} {m.userId === sync.room!.ownerId && <span className="badge badge-muted">Host</span>}</li>
                      ))}
                    </ul>
                    <button className="btn btn-ghost btn-sm" onClick={sync.leave}>Leave room</button>
                  </div>
                ) : (
                  <div className="together-start">
                    <p className="muted">Play, pause and seek stay in sync for everyone in the room.</p>
                    <button className="btn btn-primary btn-block" onClick={sync.create} disabled={!!sync.pending}>
                      {sync.pending === 'create' ? <Spinner size={16} /> : <Icon name="plus" size={16} />} Start a room
                    </button>
                    <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (joinCode.trim()) sync.join(joinCode); }}>
                      <input className="input" value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())} placeholder="Room code" aria-label="Room code" />
                      <button className="btn" disabled={!joinCode.trim() || !!sync.pending}>{sync.pending === 'join' ? <Spinner size={16} /> : 'Join'}</button>
                    </form>
                    {sync.error && <p className="form-error">{sync.error}</p>}
                  </div>
                )}
              </Popover>
            </div>
            {'pictureInPictureEnabled' in document && document.pictureInPictureEnabled && (
              <button className="btn-icon" onClick={togglePip} aria-label="Picture in picture"><Icon name="pip" size={22} /></button>
            )}
            <button className="btn-icon" onClick={toggleFullscreen} aria-label="Fullscreen"><Icon name={fullscreen ? 'fullscreenExit' : 'fullscreen'} size={22} /></button>
          </div>
        </div>
      </div>
      {canSearchSubtitles(item) && (
        <SubtitleSearchModal open={subSearch} onClose={() => setSubSearch(false)} item={item} onUpdated={onSubtitlesChanged} container={shellRef.current} />
      )}
    </div>
  );
}
