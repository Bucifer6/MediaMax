/** Lyrics data + timing for the web music player (karaoke display, editor, offsets). */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Lyrics, UserPreferences } from '@mediamax/shared';
import { karaokeApi } from '../api/karaoke';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { lyricsTime, type LrcLine } from './lrc';

/** Lyrics of a track: `undefined` while loading, `null` when there are none. */
export function useLyrics(itemId: string | null) {
  const [lyrics, setLyrics] = useState<Lyrics | null | undefined>(undefined);
  const [rev, setRev] = useState(0);
  useEffect(() => {
    if (!itemId) {
      setLyrics(null);
      return;
    }
    const ctrl = new AbortController();
    setLyrics(undefined);
    karaokeApi.lyrics(itemId, ctrl.signal).then(setLyrics).catch((e) => {
      if ((e as Error).name !== 'AbortError') setLyrics(null);
    });
    return () => ctrl.abort();
  }, [itemId, rev]);
  const reload = useCallback(() => setRev((r) => r + 1), []);
  return { lyrics, setLyrics, reload };
}

/** API lines → LRC lines (same shape; kept separate so the display code only depends on lrc.ts). */
export const asLrcLines = (l: Lyrics | null | undefined): LrcLine[] => (l?.lines ?? []) as LrcLine[];

/** Current user's preferences plus an optimistic patcher. */
export function usePrefs(): [UserPreferences | null, (patch: Partial<UserPreferences>) => Promise<void>] {
  const { user, setUser } = useApp();
  const patch = useCallback(async (p: Partial<UserPreferences>) => {
    if (!user) return;
    setUser({ ...user, preferences: { ...user.preferences, ...p } });
    try {
      setUser(await api.auth.updateMe({ preferences: p }));
    } catch {
      /* keep optimistic value; the next refresh corrects it */
    }
  }, [user, setUser]);
  return [user?.preferences ?? null, patch];
}

/** Total lyrics offset (ms, + = earlier): the user's per-track offset plus their global offset. */
export function totalOffset(lyrics: Lyrics | null | undefined, prefs: UserPreferences | null): number {
  return (lyrics?.userOffsetMs ?? 0) + (prefs?.lyricsOffsetMs ?? 0);
}

/**
 * Per-frame lyrics clock: calls `onFrame(lyricsMs)` on every animation frame while mounted (and once when paused),
 * using the precise deck position, the output latency and the offset. Paused when the page is hidden.
 */
export function useLyricsClock(getTime: () => number, getLatency: () => number, offsetMs: number, playing: boolean, onFrame: (ms: number) => void) {
  const cb = useRef(onFrame);
  cb.current = onFrame;
  const live = useRef({ offsetMs, playing });
  live.current = { offsetMs, playing };
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const { offsetMs: o, playing: p } = live.current;
      cb.current(lyricsTime(getTime(), o, getLatency(), p));
      if (p && !document.hidden) raf = requestAnimationFrame(tick);
    };
    tick();
    const onVis = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onVis);
    // While paused, still follow seeks.
    const iv = window.setInterval(() => {
      if (!live.current.playing) cb.current(lyricsTime(getTime(), live.current.offsetMs, 0, false));
    }, 250);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [getTime, getLatency, playing, offsetMs]);
}
