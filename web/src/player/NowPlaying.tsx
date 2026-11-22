/**
 * Full-screen music player ("now playing"): cover, lyrics (karaoke highlighting), visualiser and karaoke views,
 * karaoke controls (vocal level, AI stems), lyrics offset and editor. Also used by TV mode (10-foot styling, D-pad:
 * ←/→ on the stage switch visualiser styles) and as the TV music screensaver.
 */
import { createContext, lazy, Suspense, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { NowPlayingView } from '@mediamax/shared';
import { useMusic } from './music';
import { useKaraoke } from './karaoke';
import { Icon } from '../components/Icon';
import { Spinner } from '../components/ui';
import { useApp } from '../state/app';

/** The overlay itself (visualiser, lyrics editor…) is a separate chunk, loaded the first time it opens. */
const NowPlaying = lazy(() => import('./NowPlayingScreen'));

export const VIEWS: { id: NowPlayingView; label: string; icon: 'music' | 'lyrics' | 'activity' | 'sparkles' }[] = [
  { id: 'cover', label: 'Cover', icon: 'music' },
  { id: 'lyrics', label: 'Lyrics', icon: 'lyrics' },
  { id: 'visualizer', label: 'Visualiser', icon: 'activity' },
  { id: 'karaoke', label: 'Karaoke', icon: 'sparkles' },
];

export const isTvMode = () => typeof document !== 'undefined' && document.documentElement.classList.contains('tv');

/* ------------------------------------------------------------------ open / close state */

interface NpState {
  open: boolean;
  view: NowPlayingView;
  screensaver: boolean;
  show: (view?: NowPlayingView, screensaver?: boolean) => void;
  close: () => void;
  setView: (v: NowPlayingView) => void;
}
const NpCtx = createContext<NpState | null>(null);
export function useNowPlaying(): NpState {
  const v = useContext(NpCtx);
  if (!v) throw new Error('useNowPlaying outside provider');
  return v;
}

export function NowPlayingProvider({ children }: { children: ReactNode }) {
  const { user } = useApp();
  const [open, setOpen] = useState(false);
  const [screensaver, setScreensaver] = useState(false);
  const [view, setView] = useState<NowPlayingView>(user?.preferences.nowPlayingView ?? 'cover');
  const value = useMemo<NpState>(() => ({
    open, view, screensaver,
    show: (v, ss = false) => {
      setView(v ?? user?.preferences.nowPlayingView ?? 'cover');
      setScreensaver(ss);
      setOpen(true);
    },
    close: () => {
      setOpen(false);
      setScreensaver(false);
    },
    setView,
  }), [open, view, screensaver, user?.preferences.nowPlayingView]);
  return (
    <NpCtx.Provider value={value}>
      {children}
      {open && <Suspense fallback={null}><NowPlaying /></Suspense>}
      <MusicScreensaver />
    </NpCtx.Provider>
  );
}

/* ------------------------------------------------------------------ screensaver (TV mode) */

/** TV mode: after N idle minutes while music plays, open the ambient visualiser; any key / pointer closes it. */
function MusicScreensaver() {
  const m = useMusic();
  const np = useNowPlaying();
  const { user } = useApp();
  const minutes = user?.preferences.musicScreensaverMinutes ?? 3;
  const last = useRef(Date.now());
  const live = useRef({ np, playing: m.playing });
  live.current = { np, playing: m.playing };
  useEffect(() => {
    if (!isTvMode() || !minutes) return;
    const bump = () => {
      last.current = Date.now();
    };
    const wake = (e: Event) => {
      bump();
      const { np: n } = live.current;
      if (n.open && n.screensaver) {
        e.preventDefault();
        e.stopPropagation();
        n.close();
      }
    };
    window.addEventListener('keydown', wake, true);
    window.addEventListener('pointerdown', wake, true);
    window.addEventListener('pointermove', bump, true);
    const iv = window.setInterval(() => {
      const { np: n, playing } = live.current;
      if (!playing) bump();
      else if (!n.open && Date.now() - last.current > minutes * 60000) n.show('visualizer', true);
    }, 5000);
    return () => {
      window.removeEventListener('keydown', wake, true);
      window.removeEventListener('pointerdown', wake, true);
      window.removeEventListener('pointermove', bump, true);
      clearInterval(iv);
    };
  }, [minutes]);
  return null;
}

/* ------------------------------------------------------------------ karaoke controls */

/** ONNX Runtime backend id → what to show: dml / coreml / cuda run on the GPU. */
export const backendLabel = (b: string) => ({ dml: 'GPU, DirectML', coreml: 'GPU, Core ML', cuda: 'GPU, CUDA', cpu: 'CPU', webgpu: 'GPU, WebGPU', wasm: 'CPU' } as Record<string, string>)[b] ?? b;

export function KaraokeControls({ compact = false }: { compact?: boolean }) {
  const k = useKaraoke();
  const m = useMusic();
  const pct = k.preparing && k.preparing.total ? Math.round((k.preparing.done / k.preparing.total) * 100) : null;
  const phase: Record<string, string> = { waiting: 'Waiting for the server', 'runtime-download': 'Downloading the AI runtime', 'model-download': 'Downloading the AI model', decoding: 'Decoding the track', 'loading-model': 'Loading the AI model', separating: 'Separating vocals', saving: 'Saving stems' };
  const canPrepare = !!k.status?.canPrepare && m.current?.type === 'track';
  const onServer = k.status?.engine === 'server';
  const p = k.preparing;
  const where = p?.where === 'server' ? (p.phase === 'waiting' && p.position && p.position > 1 ? ` (${p.position - 1} ahead)` : p.backend && p.phase === 'separating' ? ` on the server (${backendLabel(p.backend)})` : '') : '';
  return (
    <div className={`karaoke-controls ${compact ? 'compact' : ''}`}>
      <label className="karaoke-toggle">
        <input type="checkbox" className="switch" checked={k.enabled} onChange={(e) => k.setEnabled(e.target.checked)} />
        <span>Karaoke</span>
      </label>
      <label className="karaoke-vocals" title="Vocal level">
        <Icon name="audio" size={16} />
        <span className="karaoke-vocals-label">Vocals</span>
        <input type="range" min={0} max={100} step={5} value={k.vocalLevel} aria-label="Vocal level" onChange={(e) => {
          if (!k.enabled) k.setEnabled(true);
          k.setVocalLevel(Number(e.target.value));
        }} />
        <output>{k.vocalLevel}%</output>
      </label>
      {k.enabled && (
        <span className={`karaoke-mode badge ${k.mode === 'ai' ? 'badge-success' : 'badge-muted'}`} title={k.mode === 'ai' ? 'AI-separated stems (server mix)' : 'Quick vocal reduction (centre channel)'}>
          {k.mode === 'ai' ? 'AI stems' : 'Quick'}
        </span>
      )}
      {k.enabled && k.mode === 'quick' && k.quickUnavailable && <small className="muted">Quick mode needs Web Audio on this device.</small>}
      {k.preparing ? (
        <span className="karaoke-progress" role="status">
          <Spinner size={14} /> {phase[k.preparing.phase]}{where}{pct != null ? ` · ${pct}%` : ''}
          <button className="btn btn-sm btn-ghost" onClick={k.cancelPrepare}>Cancel</button>
        </span>
      ) : (
        k.enabled && k.mode === 'quick' && canPrepare && (
          <button className="btn btn-sm" onClick={() => void k.prepare()} title={onServer ? 'Separate the vocals with the AI model on the server; afterwards every device can play the karaoke version' : 'Separate the vocals with the AI model in this browser; afterwards every device can play the karaoke version'}>
            <Icon name="wand" size={14} /> Prepare (AI)
          </button>
        )
      )}
      {k.prepareError && <small className="karaoke-error">{k.prepareError}</small>}
    </div>
  );
}
