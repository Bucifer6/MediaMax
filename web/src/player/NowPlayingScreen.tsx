/**
 * The full-screen "now playing" overlay (cover, lyrics, visualiser, karaoke views and the lyrics editor). Split from
 * NowPlaying.tsx so the visualiser and editor code only loads when the overlay is first opened.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NowPlayingView, VisualizerStyle } from '@mediamax/shared';
import { useMusic } from './music';
import { useKaraoke } from './karaoke';
import { SeekBar, VolumeControl } from './controls';
import { Icon } from '../components/Icon';
import { Img, Spinner } from '../components/ui';
import { useToast } from '../state/toast';
import { formatClock } from '../utils/format';
import { mediaUrl } from '../api/client';
import { karaokeApi } from '../api/karaoke';
import { KaraokeLyrics } from '../lyrics/KaraokeLyrics';
import { LyricsEditor } from '../lyrics/LyricsEditor';
import { totalOffset, useLyrics, usePrefs } from '../lyrics/useLyrics';
import { Visualizer } from '../visualizer/Visualizer';
import { VISUALIZER_STYLES } from '../visualizer/styles';
import { isTvMode, KaraokeControls, useNowPlaying, VIEWS } from './NowPlaying';

/* ------------------------------------------------------------------ the overlay */

export default function NowPlaying() {
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
