/**
 * Karaoke state for the web / TV music player.
 *
 * - AI mode: the track has stems on the server → the live deck plays the server's karaoke mix
 *   (/items/:id/karaoke.mp3?vocals=<level>), which works on any device.
 * - Quick mode: no stems → centre-channel vocal reduction in Web Audio (karaokeFx.ts) on the local output.
 * Administrators can "Prepare (AI)" a track: on the server when it can separate, else in this browser (stems/prepare.ts).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { StemsStatus, TrackStems } from '@mediamax/shared';
import { karaokeApi } from '../api/karaoke';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useMusic } from './music';
import type { PrepareProgress } from '../stems/prepare';

export const DEFAULT_VOCAL_LEVEL = 15;

interface KaraokeApi {
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  /** Vocal level 0–100 (100 = original). */
  vocalLevel: number;
  setVocalLevel: (v: number) => void;
  mode: 'ai' | 'quick';
  /** Stems status of the current track (null = unknown / not a track). */
  stems: TrackStems | null;
  status: StemsStatus | null;
  /** Quick mode can't work: no Web Audio on this output. */
  quickUnavailable: boolean;
  preparing: PrepareProgress | null;
  prepareError: string | null;
  prepare: () => Promise<void>;
  cancelPrepare: () => void;
}

const Ctx = createContext<KaraokeApi | null>(null);
export function useKaraoke(): KaraokeApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useKaraoke outside provider');
  return v;
}

export function KaraokeProvider({ children }: { children: ReactNode }) {
  const m = useMusic();
  const { user, setUser } = useApp();
  const [enabled, setEnabled] = useState(false);
  const [vocalLevel, setVocalLevelState] = useState(user?.preferences.karaokeVocalLevel ?? DEFAULT_VOCAL_LEVEL);
  const [stems, setStems] = useState<TrackStems | null>(null);
  const [status, setStatus] = useState<StemsStatus | null>(null);
  const [preparing, setPreparing] = useState<PrepareProgress | null>(null);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [quickUnavailable, setQuickUnavailable] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const trackId = m.current?.type === 'track' ? m.current.id : null;

  useEffect(() => {
    if (user?.preferences.karaokeVocalLevel != null) setVocalLevelState(user.preferences.karaokeVocalLevel);
  }, [user?.preferences.karaokeVocalLevel]);

  // Stems status for the current track (only once karaoke is used).
  useEffect(() => {
    setStems(null);
    if (!trackId || !enabled) return;
    let off = false;
    karaokeApi.trackStems(trackId).then((s) => !off && setStems(s)).catch(() => {});
    if (!status) karaokeApi.stemsStatus().then((s) => !off && setStatus(s)).catch(() => {});
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId, enabled]);

  const mode: 'ai' | 'quick' = stems?.ready && stems.itemId === trackId ? 'ai' : 'quick';

  // Apply: AI mix source or quick vocal reduction (debounced while the slider moves).
  useEffect(() => {
    const out = m.output;
    if (!enabled || !trackId) {
      out.setVocalLevel(1);
      if (m.altSource) void out.setAltSource(null);
      return;
    }
    const t = window.setTimeout(() => {
      if (mode === 'ai') {
        out.setVocalLevel(1);
        void out.setAltSource(karaokeApi.mixUrl(trackId, vocalLevel));
      } else {
        if (m.altSource) void out.setAltSource(null);
        const ok = out.ensureGraph();
        setQuickUnavailable(!ok);
        out.setVocalLevel(vocalLevel / 100);
      }
    }, mode === 'ai' ? 350 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, trackId, mode, vocalLevel]);

  const setVocalLevel = useCallback((v: number) => {
    const lv = Math.max(0, Math.min(100, Math.round(v)));
    setVocalLevelState(lv);
    if (user) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        api.auth.updateMe({ preferences: { karaokeVocalLevel: lv } }).then(setUser).catch(() => {});
      }, 800);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const prepare = useCallback(async () => {
    if (!trackId || preparing) return;
    const ctrl = new AbortController();
    abort.current = ctrl;
    setPrepareError(null);
    setPreparing({ phase: 'decoding', done: 0, total: 0 });
    try {
      const stub = (window as unknown as { __mmStemsStub?: boolean }).__mmStemsStub === true;
      const { prepareStems } = await import('../stems/prepare'); // the AI stems code loads only when someone prepares a track
      const r = await prepareStems(trackId, setPreparing, { signal: ctrl.signal, stub });
      setStems(r);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setPrepareError((e as Error).message);
    } finally {
      setPreparing(null);
      abort.current = null;
    }
  }, [trackId, preparing]);

  // A server job for this track already queued / running (another tab, a reload): follow it.
  useEffect(() => {
    if (stems?.job && stems.itemId === trackId && !preparing && status?.canPrepare) void prepare();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stems?.job, status?.canPrepare]);

  const value = useMemo<KaraokeApi>(() => ({
    enabled, setEnabled: (on) => {
      if (on) m.output.ensureGraph();
      setEnabled(on);
    },
    vocalLevel, setVocalLevel, mode, stems, status, quickUnavailable, preparing, prepareError, prepare,
    cancelPrepare: () => abort.current?.abort(),
  }), [enabled, vocalLevel, setVocalLevel, mode, stems, status, quickUnavailable, preparing, prepareError, prepare, m.output]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
