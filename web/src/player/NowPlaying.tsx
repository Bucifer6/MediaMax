/**
 * Full-screen music player ("now playing"): cover, lyrics (karaoke highlighting), visualiser and karaoke views,
 * karaoke controls (vocal level, AI stems), lyrics offset and editor. Also used by TV mode (10-foot styling, D-pad:
 * ←/→ on the stage switch visualiser styles) and as the TV music screensaver.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { NowPlayingView, VisualizerStyle } from '@mediamax/shared';
import { useMusic } from './music';
import { useKaraoke } from './karaoke';
import { SeekBar, VolumeControl } from './controls';
import { Icon } from '../components/Icon';
import { Img, Spinner } from '../components/ui';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { formatClock } from '../utils/format';
import { mediaUrl } from '../api/client';
import { karaokeApi } from '../api/karaoke';
import { KaraokeLyrics } from '../lyrics/KaraokeLyrics';
import { LyricsEditor } from '../lyrics/LyricsEditor';
import { totalOffset, useLyrics, usePrefs } from '../lyrics/useLyrics';
import { Visualizer } from '../visualizer/Visualizer';
import { VISUALIZER_STYLES } from '../visualizer/styles';

const VIEWS: { id: NowPlayingView; label: string; icon: 'music' | 'lyrics' | 'activity' | 'sparkles' }[] = [
  { id: 'cover', label: 'Cover', icon: 'music' },
  { id: 'lyrics', label: 'Lyrics', icon: 'lyrics' },
  { id: 'visualizer', label: 'Visualiser', icon: 'activity' },
  { id: 'karaoke', label: 'Karaoke', icon: 'sparkles' },
];

const isTvMode = () => typeof document !== 'undefined' && document.documentElement.classList.contains('tv');

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
      {open && <NowPlaying />}
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

export function KaraokeControls({ compact = false }: { compact?: boolean }) {
  const k = useKaraoke();
  const m = useMusic();
  const pct = k.preparing && k.preparing.total ? Math.round((k.preparing.done / k.preparing.total) * 100) : null;
  const phase: Record<string, string> = { 'model-download': 'Downloading the AI model', decoding: 'Decoding the track', 'loading-model': 'Loading the AI model', separating: 'Separating vocals', saving: 'Saving stems' };
  const canPrepare = !!k.status?.canPrepare && m.current?.type === 'track';
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
          <Spinner size={14} /> {phase[k.preparing.phase]}{pct != null ? ` · ${pct}%` : ''}
          <button className="btn btn-sm btn-ghost" onClick={k.cancelPrepare}>Cancel</button>
        </span>
      ) : (
        k.enabled && k.mode === 'quick' && canPrepare && (
          <button className="btn btn-sm" onClick={() => void k.prepare()} title="Separate the vocals with the AI model in this browser; afterwards every device can play the karaoke version">
            <Icon name="wand" size={14} /> Prepare (AI)
          </button>
        )
      )}
      {k.prepareError && <small className="karaoke-error">{k.prepareError}</small>}
    </div>
  );
}

/* ------------------------------------------------------------------ the overlay */

function NowPlaying() {
  const m = useMusic();
  const k = useKaraoke();
  const np = useNowPlaying();
  const toast = useToast();
  const [prefs, patchPrefs] = usePrefs();
  const t = m.current;
  const trackId = t?.type === 'track' ? t.id : null;
  const { lyrics, setLyrics, reload } = useLyrics(trackId);
  const [style, setStyle] = useState<VisualizerStyle>(prefs?.visualizerStyle ?? 'ring');
  const [editing, setEditing] = useState(false);
  const [idle, setIdle] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const tv = isTvMode();
  const view = np.screensaver ? 'visualizer' : np.view;
  const visStyle: VisualizerStyle = np.screensaver ? 'ambient' : style;
  const offset = totalOffset(lyrics, prefs);
  const art = m.info?.posterUrl ?? t?.posterUrl ?? t?.thumbUrl ?? null;
  const artist = t?.grandparentTitle ?? t?.parentTitle ?? m.info?.subtitle ?? '';

  // Karaoke view turns karaoke on; leaving it keeps the user's choice.
  useEffect(() => {
    if (view === 'karaoke' && !k.enabled && !np.screensaver) k.setEnabled(true);
    if (view === 'visualizer') m.output.ensureGraph();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Esc / Back closes; hide the chrome after a few idle seconds in visualiser / karaoke views.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (editing) return;
      if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack') {
        e.preventDefault();
        e.stopPropagation();
        np.close();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [np, editing]);
  useEffect(() => {
    let timer = 0;
    const bump = () => {
      setIdle(false);
      clearTimeout(timer);
      if (view === 'visualizer' || view === 'karaoke') timer = window.setTimeout(() => setIdle(true), tv ? 6000 : 4000);
    };
    bump();
    window.addEventListener('pointermove', bump);
    window.addEventListener('pointerdown', bump);
    window.addEventListener('keydown', bump);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointermove', bump);
      window.removeEventListener('pointerdown', bump);
      window.removeEventListener('keydown', bump);
    };
  }, [view, tv]);

  const cycleStyle = useCallback((dir: 1 | -1) => {
    const i = VISUALIZER_STYLES.findIndex((s) => s.id === style);
    const next = VISUALIZER_STYLES[(i + dir + VISUALIZER_STYLES.length) % VISUALIZER_STYLES.length].id;
    setStyle(next);
    void patchPrefs({ visualizerStyle: next });
  }, [style, patchPrefs]);

  // D-pad on the visualiser stage: ←/→ switch styles.
  useEffect(() => {
    if (view !== 'visualizer') return;
    const key = (e: KeyboardEvent) => {
      if (document.activeElement !== stage.current) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        cycleStyle(e.key === 'ArrowRight' ? 1 : -1);
      }
    };
    window.addEventListener('keydown', key, true);
    if (tv) stage.current?.focus();
    return () => window.removeEventListener('keydown', key, true);
  }, [view, cycleStyle, tv]);

  const nudgeOffset = async (d: number) => {
    if (!trackId || !lyrics) return;
    const next = (lyrics.userOffsetMs ?? 0) + d;
    setLyrics({ ...lyrics, userOffsetMs: next });
    try {
      await karaokeApi.setOffset(trackId, next);
    } catch (e) {
      toast.error(e);
    }
  };

  if (!t) return null;
  const setView = (v: NowPlayingView) => {
    np.setView(v);
    if (prefs && prefs.nowPlayingView !== v) void patchPrefs({ nowPlayingView: v });
  };

  return (
    <div className={`now-playing view-${view} ${idle ? 'idle' : ''} ${np.screensaver ? 'screensaver' : ''} ${tv ? 'np-tv' : ''}`} role="dialog" aria-modal="true" aria-label="Now playing">
      <div className="np-backdrop" style={art ? { backgroundImage: `url("${mediaUrl(art, 480)}")` } : undefined} />
      {(view === 'visualizer' || view === 'karaoke') && (
        <div className="np-stage" ref={stage} data-own-arrows="" tabIndex={view === 'visualizer' ? 0 : -1} aria-label={view === 'visualizer' ? `Visualiser: ${VISUALIZER_STYLES.find((s) => s.id === visStyle)?.label}. Left and right change the style.` : undefined}>
          <Visualizer style={view === 'karaoke' ? 'ambient' : visStyle} itemId={trackId} coverUrl={art} tv={tv} />
        </div>
      )}
      {!np.screensaver && (
        <header className="np-head">
          <button className="btn-icon" onClick={np.close} aria-label="Close now playing" title="Close (Esc)"><Icon name="x" /></button>
          <nav className="np-views" role="tablist" aria-label="View">
            {VIEWS.map((v) => (
              <button key={v.id} role="tab" aria-selected={view === v.id} className={`np-view-btn ${view === v.id ? 'active' : ''}`} onClick={() => setView(v.id)}>
                <Icon name={v.icon} size={16} /> <span>{v.label}</span>
              </button>
            ))}
          </nav>
          <span className="np-head-right">
            {lyrics?.canEdit && trackId && (
              <button className="btn btn-sm btn-ghost" onClick={() => setEditing(true)}><Icon name="edit" size={14} /> Edit lyrics</button>
            )}
          </span>
        </header>
      )}

      <main className="np-main">
        {view === 'cover' && (
          <div className="np-cover-view">
            <div className="np-art"><Img src={art ?? undefined} width={720} fallback={<Icon name="music" size={64} />} /></div>
          </div>
        )}
        {view === 'lyrics' && (
          <div className="np-lyrics-view">
            <div className="np-art small hide-sm"><Img src={art ?? undefined} width={480} fallback={<Icon name="music" size={48} />} /></div>
            <KaraokeLyrics lyrics={lyrics} offsetMs={offset} onSeek={m.seek} className="np-lyrics" />
          </div>
        )}
        {view === 'karaoke' && <KaraokeLyrics lyrics={lyrics} offsetMs={offset} mode="karaoke" className="np-karaoke" />}
        {view === 'visualizer' && !np.screensaver && (
          <div className="np-styles" role="radiogroup" aria-label="Visualiser style">
            <button className="btn-icon" onClick={() => cycleStyle(-1)} aria-label="Previous style"><Icon name="prev" size={18} /></button>
            {VISUALIZER_STYLES.map((s) => (
              <button key={s.id} role="radio" aria-checked={s.id === style} className={`chip ${s.id === style ? 'active' : ''}`} onClick={() => {
                setStyle(s.id);
                void patchPrefs({ visualizerStyle: s.id });
              }}>{s.label}</button>
            ))}
            <button className="btn-icon" onClick={() => cycleStyle(1)} aria-label="Next style"><Icon name="next" size={18} /></button>
          </div>
        )}
      </main>

      <footer className="np-foot">
        <div className="np-meta">
          <div className="np-title">{t.title}</div>
          <div className="np-artist">{artist}</div>
        </div>
        {!np.screensaver && (
          <>
            <SeekBar className="np-seek" positionMs={m.positionMs} durationMs={m.durationMs} onSeek={m.seek} />
            <div className="np-times"><span>{formatClock(m.positionMs)}</span><span>{formatClock(m.durationMs)}</span></div>
            <div className="np-controls">
              <button className={`btn-icon ${m.shuffle ? 'active' : ''}`} onClick={() => m.setShuffle(!m.shuffle)} aria-label="Shuffle"><Icon name="shuffle" size={20} /></button>
              <button className="btn-icon" onClick={m.prev} aria-label="Previous"><Icon name="prev" size={26} /></button>
              <button className="btn-icon btn-play-round np-play" onClick={m.toggle} aria-label={m.playing ? 'Pause' : 'Play'}>
                {m.loading ? <Spinner size={24} /> : <Icon name={m.playing ? 'pause' : 'play'} size={30} />}
              </button>
              <button className="btn-icon" onClick={m.next} aria-label="Next"><Icon name="next" size={26} /></button>
              <span className="hide-sm"><VolumeControl volume={m.volume} muted={m.muted} onVolume={m.setVolume} onMute={m.setMuted} /></span>
            </div>
            <div className="np-extras">
              {t.type === 'track' && <KaraokeControls />}
              {lyrics?.synced && (view === 'lyrics' || view === 'karaoke') && (
                <span className="np-offset" title="Lyrics timing for this track (+ = lyrics earlier)">
                  <span className="muted">Lyrics timing</span>
                  <button className="btn btn-sm" onClick={() => void nudgeOffset(-100)} aria-label="Lyrics later">−0.1s</button>
                  <output>{offset > 0 ? '+' : ''}{(offset / 1000).toFixed(1)}s</output>
                  <button className="btn btn-sm" onClick={() => void nudgeOffset(100)} aria-label="Lyrics earlier">+0.1s</button>
                </span>
              )}
            </div>
          </>
        )}
      </footer>
      {editing && t && (
        <LyricsEditor track={t} lyrics={lyrics} onClose={() => setEditing(false)} onSaved={(l) => (l ? setLyrics({ ...l, canEdit: true }) : reload())} />
      )}
    </div>
  );
}
