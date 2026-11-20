import { useEffect, useRef, useState } from 'react';
import type { Item } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { attachStream, type Attached } from '../player/engine';
import { profileWithBitrate } from '../player/deviceProfile';

/** Trailer extra for a movie/show, looked up once per page load. */
const trailerCache = new Map<string, Promise<Item | null>>();
export function trailerFor(itemId: string): Promise<Item | null> {
  let p = trailerCache.get(itemId);
  if (!p) {
    p = api.items.extras(itemId).then((x) => x.find((e) => e.extraType === 'trailer') ?? null).catch(() => null);
    trailerCache.set(itemId, p);
  }
  return p;
}

function useMediaQuery(q: string): boolean {
  const [m, setM] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(q).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(q);
    if (!mq) return;
    const h = () => setM(mq.matches);
    h();
    mq.addEventListener?.('change', h);
    return () => mq.removeEventListener?.('change', h);
  }, [q]);
  return m;
}

/** Previews play only when the viewer wants them and hasn't asked the OS for reduced motion. */
export function usePreviewsEnabled(): boolean {
  const { user } = useApp();
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  return user?.preferences.autoplayPreviews !== false && !reduced;
}

/** Card hover previews also need a real mouse (not touch, not a TV remote). */
export function useHoverPreviews(): boolean {
  const enabled = usePreviewsEnabled();
  const fine = useMediaQuery('(hover: hover) and (pointer: fine)');
  return enabled && fine && !document.documentElement.classList.contains('tv');
}

function usePageVisible(): boolean {
  const [v, setV] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const h = () => setV(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', h);
    return () => document.removeEventListener('visibilitychange', h);
  }, []);
  return v;
}

/**
 * Muted trailer preview for `itemId`, drawn as a `<video>` that fades in once it's playing. Starts a `preview`
 * playback session (never replaces other playback, not recorded in history) and stops it on unmount, when `active`
 * turns false, when the trailer ends, or when the tab is hidden.
 */
export function TrailerPreview({ itemId, active, muted = true, className, onPlaying, onEnded, maxBitrate = 4000 }: {
  itemId: string;
  active: boolean;
  muted?: boolean;
  className?: string;
  onPlaying?: (playing: boolean) => void;
  onEnded?: () => void;
  maxBitrate?: number;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const visible = usePageVisible();
  const [playing, setPlaying] = useState(false);
  const run = active && visible;
  const cbs = useRef({ onPlaying, onEnded });
  cbs.current = { onPlaying, onEnded };

  useEffect(() => {
    if (!run) return;
    let cancelled = false;
    let attached: Attached | null = null;
    let sessionId: string | null = null;
    const el = ref.current;
    const stop = () => {
      attached?.destroy();
      attached = null;
      if (sessionId) api.playback.stop(sessionId, true).catch(() => undefined);
      sessionId = null;
    };
    (async () => {
      const trailer = await trailerFor(itemId);
      if (cancelled || !trailer || !el) return;
      try {
        const info = await api.playback.start(trailer.id, { deviceProfile: profileWithBitrate(maxBitrate), preview: true });
        sessionId = info.sessionId;
        if (cancelled) return stop();
        attached = await attachStream(el, info, { onFatal: () => stop() });
        if (cancelled) return stop();
        el.muted = true;
        await el.play().catch(() => undefined);
      } catch {
        stop();
      }
    })();
    return () => {
      cancelled = true;
      stop();
      setPlaying(false);
      cbs.current.onPlaying?.(false);
      if (el) {
        el.pause();
        el.removeAttribute('src');
      }
    };
  }, [run, itemId, maxBitrate]);

  useEffect(() => {
    if (ref.current) ref.current.muted = muted;
  }, [muted]);

  return (
    <video
      ref={ref}
      className={`trailer-preview ${playing ? 'playing' : ''} ${className ?? ''}`}
      muted
      playsInline
      preload="none"
      aria-hidden
      tabIndex={-1}
      onPlaying={() => {
        setPlaying(true);
        cbs.current.onPlaying?.(true);
      }}
      onEnded={() => {
        setPlaying(false);
        cbs.current.onPlaying?.(false);
        cbs.current.onEnded?.();
      }}
    />
  );
}
