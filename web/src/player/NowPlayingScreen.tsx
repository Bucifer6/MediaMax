/**
 * The full-screen "now playing" overlay. Split from NowPlaying.tsx so the visualiser and editor code only loads when
 * the overlay is first opened.
 *
 * Layout (Vibe): artwork-forward stage on the left; queue and time-synced lyrics side by side on the right on desktop
 * (each toggleable, remembered per device); tabs on phones. The transport bar at the bottom is identical in every
 * view, so controls never move. Audiobooks and podcasts get 15/30 s skip, speed, a sleep timer, chapters and bookmarks.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DjTransitionPreference, Item, NowPlayingView, VisualizerStyle } from '@mediamax/shared';
import { useMusic } from './music';
import { useKaraoke } from './karaoke';
import { SeekBar, VolumeControl } from './controls';
import { ChapterList, SleepTimerButton, radioMenuItems } from './MiniPlayer';
import { Icon, type IconName } from '../components/Icon';
import { Dropdown, Img, Popover, Spinner, type MenuItem } from '../components/ui';
import { PlayerBookmarks } from '../components/Bookmarks';
import { useToast } from '../state/toast';
import { useMediaQuery } from '../hooks';
import { formatClock, formatDuration } from '../utils/format';
import { mediaUrl } from '../api/client';
import { karaokeApi } from '../api/karaoke';
import { KaraokeLyrics } from '../lyrics/KaraokeLyrics';
import { LyricsEditor } from '../lyrics/LyricsEditor';
import { totalOffset, useLyrics, usePrefs } from '../lyrics/useLyrics';
import { Visualizer } from '../visualizer/Visualizer';
import { VISUALIZER_STYLES } from '../visualizer/styles';
import { isTvMode, KaraokeControls, useNowPlaying, VIEWS } from './NowPlaying';
import { useApp } from '../state/app';
import { advancedDjEnabled } from './djAccess';
import '../styles/listen.css';

type Panel = 'lyrics' | 'queue' | 'chapters' | 'bookmarks';
const PANEL_LABEL: Record<Panel, string> = { lyrics: 'Lyrics', queue: 'Up next', chapters: 'Chapters', bookmarks: 'Bookmarks' };
const PANEL_ICON: Record<Panel, IconName> = { lyrics: 'lyrics', queue: 'queue', chapters: 'chapters', bookmarks: 'flag' };
const PANELS_KEY = 'vibe.np.panels';
const SPEEDS = [0.75, 1, 1.15, 1.25, 1.5, 1.75, 2, 2.5];

function loadPanels(): Panel[] {
  try {
    const v = JSON.parse(localStorage.getItem(PANELS_KEY) || 'null') as Panel[] | null;
    if (Array.isArray(v)) return v;
  } catch {
    /* ignore */
  }
  return ['lyrics', 'queue', 'chapters'];
}
function savePanels(p: Panel[]) {
  try {
    localStorage.setItem(PANELS_KEY, JSON.stringify(p));
  } catch {
    /* private mode */
  }
}

const isSpoken = (t: Item | null) => t?.type === 'bookpart' || t?.type === 'podcastepisode';

/** Circular arrow with the number of seconds inside (15 s back / 30 s forward). */
function SkipIcon({ seconds, back = false }: { seconds: number; back?: boolean }) {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true" className="np-skip-icon" style={back ? undefined : { transform: 'scaleX(-1)' }}>
      <path d="M7.5 8.2A9 9 0 1 1 5 14" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M7.9 3.6v4.9h4.9" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      <text x="14" y="17.6" textAnchor="middle" fontSize="9.5" fontWeight="800" fill="currentColor" style={back ? undefined : { transform: 'scaleX(-1)', transformOrigin: '14px 14px' }} fontFamily="inherit">{seconds}</text>
    </svg>
  );
}

/* ------------------------------------------------------------------ queue */

function NpQueue() {
  const m = useMusic();
  const list = useRef<HTMLOListElement>(null);
  const jumpToCurrent = useCallback((smooth = true) => {
    const el = list.current?.querySelector<HTMLElement>('li.current');
    if (el && list.current) list.current.scrollTo({ top: el.offsetTop - 8, behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
  }, []);
  useEffect(() => jumpToCurrent(false), [m.index, jumpToCurrent]);
  const left = m.queue.length - m.index - 1;
  return (
    <>
      <div className="np-panel-head">
        <h2>{m.radio ? m.radio.label : 'Up next'}</h2>
        <span className="np-panel-sub">{left > 0 ? `${left} more` : 'End of queue'}</span>
        <span className="np-panel-actions">
          <button className="btn btn-xs btn-ghost on-media" onClick={() => jumpToCurrent()} title="Scroll to the track that is playing">
            <Icon name="music" size={14} /> Now playing
          </button>
          <button className="btn btn-xs btn-ghost on-media" onClick={m.clear}>Clear</button>
        </span>
      </div>
      <ol className="np-queue" ref={list}>
        {m.queue.map((q, i) => (
          <li key={`${q.id}-${i}`} className={i === m.index ? 'current' : i < m.index ? 'past' : ''}>
            <button className="np-q-item" onClick={() => m.jump(i)} aria-current={i === m.index ? 'true' : undefined}>
              <span className="np-q-art">
                <Img src={q.posterUrl ?? q.thumbUrl} width={80} fallback={<Icon name={q.type === 'track' ? 'music' : 'book'} size={16} />} />
                {i === m.index && m.playing && <span className="eq"><i /><i /><i /></span>}
              </span>
              <span className="np-q-text">
                <span>{q.title}</span>
                <small>{q.grandparentTitle ?? q.parentTitle}</small>
              </span>
              <small className="np-q-dur">{q.type === 'track' ? formatClock(q.durationMs ?? 0) : formatDuration(q.durationMs)}</small>
            </button>
            {i !== m.index && (
              <button className="btn-icon btn-icon-sm np-q-remove" onClick={() => m.removeAt(i)} aria-label={`Remove ${q.title} from the queue`}>
                <Icon name="x" size={14} />
              </button>
            )}
          </li>
        ))}
      </ol>
    </>
  );
}

/* ------------------------------------------------------------------ the overlay */

export default function NowPlaying() {
  const m = useMusic();
  const advancedDj = advancedDjEnabled(useApp().user);
  const k = useKaraoke();
  const np = useNowPlaying();
  const toast = useToast();
  const navigate = useNavigate();
  const [prefs, patchPrefs] = usePrefs();
  const t = m.current;
  const trackId = t?.type === 'track' ? t.id : null;
  const spoken = isSpoken(t);
  const { lyrics, setLyrics, reload } = useLyrics(trackId);
  const [style, setStyle] = useState<VisualizerStyle>(prefs?.visualizerStyle ?? 'ring');
  const [editing, setEditing] = useState(false);
  const [idle, setIdle] = useState(false);
  const [panels, setPanels] = useState<Panel[]>(loadPanels);
  /** Phones: what the stage shows instead of the view (queue, chapters, bookmarks). */
  const [phonePanel, setPhonePanel] = useState<Panel | null>(null);
  const wide = useMediaQuery('(min-width: 1000px)');
  const stage = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const tv = isTvMode();
  const rawView = np.screensaver ? 'visualizer' : np.view;
  // Lyrics and karaoke views only exist for music tracks.
  const view: NowPlayingView = spoken && (rawView === 'lyrics' || rawView === 'karaoke') ? 'cover' : rawView;
  const visStyle: VisualizerStyle = np.screensaver ? 'ambient' : style;
  const offset = totalOffset(lyrics, prefs);
  const art = m.info?.posterUrl ?? t?.posterUrl ?? t?.thumbUrl ?? null;
  const artist = t?.grandparentTitle ?? t?.parentTitle ?? m.info?.subtitle ?? '';
  const immersive = view === 'visualizer' || view === 'karaoke';

  // Karaoke view turns karaoke on; leaving it keeps the user's choice.
  useEffect(() => {
    if (view === 'karaoke' && !k.enabled && !np.screensaver) k.setEnabled(true);
    if (view === 'visualizer') m.output.ensureGraph();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Move focus into the overlay when it opens (it is a modal dialog); Tab then reaches the close button first.
  useEffect(() => {
    if (!tv) root.current?.focus({ preventScroll: true });
  }, [tv]);

  // Esc / Back closes; hide the chrome after a few idle seconds in visualiser / karaoke views.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (editing) return;
      if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack') {
        // An open menu / popover closes first.
        if (document.querySelector('.now-playing .menu, .now-playing .popover-panel')) return;
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
      if (immersive) timer = window.setTimeout(() => setIdle(true), tv ? 6000 : 4000);
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
  }, [immersive, tv]);

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
    setPhonePanel(null);
    np.setView(v);
    if (prefs && prefs.nowPlayingView !== v) void patchPrefs({ nowPlayingView: v });
  };
  const goTo = (to: string) => {
    np.close();
    navigate(to);
  };

  // Panels this item can show, and which are open on the desktop side.
  const available: Panel[] = spoken ? [...(m.chapters.length ? (['chapters'] as Panel[]) : []), 'bookmarks', 'queue'] : ['lyrics', 'queue'];
  const togglePanel = (p: Panel) => {
    const next = panels.includes(p) ? panels.filter((x) => x !== p) : [...panels, p];
    setPanels(next);
    savePanels(next);
  };
  const sideOpen = wide && !immersive && !tv ? available.filter((p) => panels.includes(p) && !(p === 'lyrics' && view === 'lyrics')) : [];
  const views = VIEWS.filter((v) => !spoken || v.id === 'cover' || v.id === 'visualizer');
  const phoneTabs: Panel[] = !wide && !tv ? available.filter((p) => p !== 'lyrics') : [];

  const lyricsTiming = lyrics?.synced ? (
    <span className="np-offset" title="Lyrics timing for this track (+ = lyrics earlier)">
      <button className="btn btn-xs btn-ghost on-media" onClick={() => void nudgeOffset(-100)} aria-label="Lyrics later">−0.1s</button>
      <output aria-label="Lyrics timing">{offset > 0 ? '+' : ''}{(offset / 1000).toFixed(1)}s</output>
      <button className="btn btn-xs btn-ghost on-media" onClick={() => void nudgeOffset(100)} aria-label="Lyrics earlier">+0.1s</button>
    </span>
  ) : null;

  const panelBody = (p: Panel) => {
    if (p === 'queue') return <NpQueue />;
    if (p === 'lyrics') {
      return (
        <>
          <div className="np-panel-head">
            <h2>Lyrics</h2>
            {lyrics?.synced && <span className="np-panel-sub">Synced</span>}
            <span className="np-panel-actions">{lyricsTiming}</span>
          </div>
          <KaraokeLyrics lyrics={lyrics} offsetMs={offset} onSeek={m.seek} className="np-side-lyrics" />
        </>
      );
    }
    if (p === 'chapters') {
      return (
        <>
          <div className="np-panel-head"><h2>Chapters</h2><span className="np-panel-sub">{m.chapters.length}</span></div>
          <div className="np-panel-scroll"><ChapterList chapters={m.chapters} positionMs={m.positionMs} onSeek={m.seek} /></div>
        </>
      );
    }
    return (
      <>
        <div className="np-panel-head"><h2>Bookmarks</h2></div>
        <div className="np-panel-scroll np-bookmarks"><PlayerBookmarks /></div>
      </>
    );
  };

  const trackMenu: MenuItem[] = [
    ...radioMenuItems(t, (id, title) => void m.startRadio(id, title)),
    ...(t.type === 'track' && advancedDj ? [{ label: 'DJ mix from this track', icon: 'music' as const, onClick: () => goTo(`/dj?seed=${encodeURIComponent(t.id)}`) }] : []),
    ...(t.type === 'track' ? [{ divider: true, label: '' }] : []),
    ...(t.parentId ? [{ label: t.type === 'track' ? 'Go to album' : t.type === 'podcastepisode' ? 'Go to podcast' : 'Go to book', icon: (t.type === 'track' ? 'music' : 'book') as IconName, onClick: () => goTo(`/item/${t.parentId}`) }] : []),
    ...(t.grandparentId ? [{ label: 'Go to artist', icon: 'user' as const, onClick: () => goTo(`/item/${t.grandparentId}`) }] : []),
    ...(lyrics?.canEdit && trackId ? [{ divider: true, label: '' }, { label: 'Edit lyrics', icon: 'edit' as const, onClick: () => setEditing(true) }] : []),
  ];

  const repeatLabel = m.repeat === 'off' ? 'Repeat off' : m.repeat === 'all' ? 'Repeat all' : 'Repeat one';

  return (
    <div className={`now-playing view-${view} ${idle ? 'idle' : ''} ${np.screensaver ? 'screensaver' : ''} ${tv ? 'np-tv' : ''} ${sideOpen.length ? `np-has-side np-cols-${sideOpen.length}` : ''}`} role="dialog" aria-modal="true" aria-label="Now playing" ref={root} tabIndex={-1}>
      <div className="np-backdrop" style={art ? { backgroundImage: `url("${mediaUrl(art, 480)}")` } : undefined} />
      {immersive && (
        <div className="np-stage" ref={stage} data-own-arrows="" tabIndex={view === 'visualizer' ? 0 : -1} aria-label={view === 'visualizer' ? `Visualiser: ${VISUALIZER_STYLES.find((s) => s.id === visStyle)?.label}. Left and right change the style.` : undefined}>
          <Visualizer style={view === 'karaoke' ? 'ambient' : visStyle} itemId={trackId} coverUrl={art} tv={tv} />
        </div>
      )}
      {!np.screensaver && (
        <header className="np-head">
          <button className="btn-icon np-close" onClick={np.close} aria-label="Close now playing" title="Close (Esc)"><Icon name="chevronDown" size={26} /></button>
          <div className="np-views" role="tablist" aria-label="View">
            {views.map((v) => {
              const on = view === v.id && !phonePanel;
              return (
                <button key={v.id} role="tab" aria-selected={on} className={`np-view-btn ${on ? 'active' : ''}`} onClick={() => setView(v.id)} title={v.label}>
                  <Icon name={v.icon} size={16} /> <span>{v.label}</span>
                </button>
              );
            })}
            {phoneTabs.map((p) => (
              <button key={p} role="tab" aria-selected={phonePanel === p} className={`np-view-btn ${phonePanel === p ? 'active' : ''}`} onClick={() => setPhonePanel(p)} title={PANEL_LABEL[p]}>
                <Icon name={PANEL_ICON[p]} size={16} /> <span>{PANEL_LABEL[p]}</span>
              </button>
            ))}
          </div>
          <div className="np-head-right">
            {wide && !immersive && !tv && available.map((p) => (p === 'lyrics' && view === 'lyrics' ? null : (
              <button key={p} className={`btn-icon np-panel-toggle ${sideOpen.includes(p) ? 'active' : ''}`} onClick={() => togglePanel(p)} aria-pressed={sideOpen.includes(p)} aria-label={`${PANEL_LABEL[p]} panel`} title={PANEL_LABEL[p]}>
                <Icon name={PANEL_ICON[p]} size={20} />
              </button>
            )))}
          </div>
        </header>
      )}

      <div className="np-body">
        <main className="np-main">
          {phonePanel ? (
            <section className="np-panel np-phone-panel" aria-label={PANEL_LABEL[phonePanel]}>{panelBody(phonePanel)}</section>
          ) : (
            <>
              {view === 'cover' && (
                <div className="np-cover-view">
                  <div className="np-art"><Img src={art ?? undefined} width={900} fallback={<Icon name={spoken ? 'book' : 'music'} size={64} />} /></div>
                </div>
              )}
              {view === 'lyrics' && (
                <div className="np-lyrics-view">
                  <div className="np-lyrics-top">
                    <span className="np-art np-art-thumb"><Img src={art ?? undefined} width={160} fallback={<Icon name="music" size={24} />} /></span>
                    {lyricsTiming}
                  </div>
                  <KaraokeLyrics lyrics={lyrics} offsetMs={offset} onSeek={m.seek} className="np-lyrics" />
                </div>
              )}
              {view === 'karaoke' && (
                <div className="np-karaoke-view">
                  <KaraokeLyrics lyrics={lyrics} offsetMs={offset} mode="karaoke" className="np-karaoke" />
                  {!np.screensaver && (
                    <div className="np-karaoke-bar">
                      <KaraokeControls />
                      {lyricsTiming}
                    </div>
                  )}
                </div>
              )}
              {view === 'visualizer' && !np.screensaver && (
                <div className="np-styles" role="radiogroup" aria-label="Visualiser style">
                  <button className="btn-icon btn-icon-sm" onClick={() => cycleStyle(-1)} aria-label="Previous style"><Icon name="chevronLeft" size={18} /></button>
                  {VISUALIZER_STYLES.map((s) => (
                    <button key={s.id} role="radio" aria-checked={s.id === style} className={`chip chip-sm ${s.id === style ? 'active' : ''}`} onClick={() => {
                      setStyle(s.id);
                      void patchPrefs({ visualizerStyle: s.id });
                    }}>{s.label}</button>
                  ))}
                  <button className="btn-icon btn-icon-sm" onClick={() => cycleStyle(1)} aria-label="Next style"><Icon name="chevronRight" size={18} /></button>
                </div>
              )}
            </>
          )}
        </main>
        {sideOpen.length > 0 && (
          <div className="np-side">
            {sideOpen.map((p) => <section key={p} className={`np-panel np-panel-${p}`} aria-label={PANEL_LABEL[p]}>{panelBody(p)}</section>)}
          </div>
        )}
      </div>

      <footer className="np-foot">
        <div className="np-seek-row">
          <span className="np-time">{formatClock(m.positionMs)}</span>
          <SeekBar className="np-seek" positionMs={m.positionMs} durationMs={m.durationMs} onSeek={m.seek} chapters={spoken && m.chapters.length ? m.chapters : null} />
          <span className="np-time">-{formatClock(Math.max(0, m.durationMs - m.positionMs))}</span>
        </div>
        <div className="np-bar">
          <div className="np-meta">
            <div className="np-title" title={t.title}>{t.title}</div>
            <div className="np-artist">
              {m.casting ? <><Icon name="cast" size={13} /> Casting to {m.cast.deviceName ?? 'device'}</> : artist}
              {m.radio && !m.casting && <span className="np-radio"><Icon name="antenna" size={12} /> {m.radio.label}</span>}
              {!m.casting && !spoken && <MixStatus />}
            </div>
          </div>
          {!np.screensaver && (
            <>
              <div className="np-controls">
                {spoken ? (
                  <button className="btn-icon np-skip" onClick={() => m.seek(Math.max(0, m.positionMs - 15000))} aria-label="Back 15 seconds" title="Back 15 s"><SkipIcon seconds={15} back /></button>
                ) : (
                  <button className={`btn-icon ${m.shuffle ? 'active' : ''}`} onClick={() => m.setShuffle(!m.shuffle)} aria-label="Shuffle" aria-pressed={m.shuffle} title="Shuffle"><Icon name="shuffle" size={20} /></button>
                )}
                <button className="btn-icon btn-icon-lg" onClick={m.prev} aria-label="Previous"><Icon name="prev" size={26} /></button>
                <button className="btn-icon np-play" onClick={m.toggle} aria-label={m.playing ? 'Pause' : 'Play'}>
                  {m.loading ? <Spinner size={24} /> : <Icon name={m.playing ? 'pause' : 'play'} size={30} />}
                </button>
                <button className="btn-icon btn-icon-lg" onClick={m.next} aria-label="Next"><Icon name="next" size={26} /></button>
                {spoken ? (
                  <button className="btn-icon np-skip" onClick={() => m.seek(Math.min(m.durationMs, m.positionMs + 30000))} aria-label="Forward 30 seconds" title="Forward 30 s"><SkipIcon seconds={30} /></button>
                ) : (
                  <button className={`btn-icon np-repeat ${m.repeat !== 'off' ? 'active' : ''}`} onClick={() => m.setRepeat(m.repeat === 'off' ? 'all' : m.repeat === 'all' ? 'one' : 'off')} aria-label={repeatLabel} title={repeatLabel}>
                    <Icon name="repeat" size={20} />
                    {m.repeat === 'one' && <span className="repeat-one">1</span>}
                  </button>
                )}
              </div>
              <div className="np-tools">
                {spoken && (
                  <Dropdown
                    className="np-speed"
                    trigger={({ onClick, open }) => (
                      <button className={`btn btn-xs btn-ghost on-media np-speed-btn ${m.rate !== 1 ? 'active' : ''}`} onClick={onClick} aria-expanded={open} aria-haspopup="menu" aria-label={`Playback speed ${m.rate}×`} title="Playback speed">
                        {m.rate}×
                      </button>
                    )}
                    items={SPEEDS.map((r) => ({ label: `${r}×${r === 1 ? ' (normal)' : ''}`, checked: m.rate === r, onClick: () => m.setRate(r) }))}
                  />
                )}
                {!spoken && t.type === 'track' && <AutomixMenu />}
                <SleepTimerButton />
                {t.type === 'track' && view !== 'karaoke' && (
                  <Popover
                    className="np-karaoke-pop"
                    label="Karaoke"
                    trigger={({ onClick, open }) => (
                      <button className={`btn-icon ${k.enabled ? 'active' : ''}`} onClick={onClick} aria-expanded={open} aria-label="Karaoke and vocals" title="Karaoke / vocals"><Icon name="sparkles" size={20} /></button>
                    )}
                  >
                    <KaraokeControls compact />
                  </Popover>
                )}
                <span className="np-volume"><VolumeControl volume={m.volume} muted={m.muted} onVolume={m.setVolume} onMute={m.setMuted} /></span>
                {trackMenu.length > 0 && (
                  <Dropdown
                    className="np-more"
                    trigger={({ onClick, open }) => (
                      <button className="btn-icon" onClick={onClick} aria-label="More options" title="More" aria-expanded={open} aria-haspopup="menu"><Icon name="more" size={20} /></button>
                    )}
                    items={trackMenu}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </footer>
      {editing && t && (
        <LyricsEditor track={t} lyrics={lyrics} onClose={() => setEditing(false)} onSaved={(l) => (l ? setLyrics({ ...l, canEdit: true }) : reload())} />
      )}
    </div>
  );
}

const MIX_STYLES: { value: DjTransitionPreference; label: string }[] = [
  { value: 'auto', label: 'Auto' }, { value: 'smooth', label: 'Smooth' }, { value: 'energetic', label: 'Energetic' }, { value: 'minimal', label: 'Minimal' },
];

/** "Mixing into <next> · Bass swap 40 %" during a blend; "Mix: <source>" otherwise. No DJ controls. */
function MixStatus() {
  const m = useMusic();
  if (m.blend) {
    return (
      <span className="np-radio np-mixing" role="status" aria-live="polite">
        <Icon name="layers" size={12} /> Mixing into {m.blend.into.title} · {m.blend.label}
        <i className="np-mix-progress" aria-hidden="true"><b style={{ width: `${Math.round(m.blend.progress * 100)}%` }} /></i>
      </span>
    );
  }
  if (m.mix) return <span className="np-radio"><Icon name="layers" size={12} /> Mix: {m.mix.label}</span>;
  return null;
}

/** Automix on/off, Endless and the transition style: the whole lite DJ. */
function AutomixMenu() {
  const m = useMusic();
  return (
    <Dropdown
      className="np-automix"
      trigger={({ onClick, open }) => (
        <button className={`btn-icon ${m.automix ? 'active' : ''}`} onClick={onClick} aria-expanded={open} aria-haspopup="menu" aria-label={`Automix ${m.automix ? 'on' : 'off'}`} title="Automix">
          <Icon name="layers" size={20} />
        </button>
      )}
      items={[
        { label: 'Automix', checked: m.automix, onClick: () => m.setAutomix(!m.automix) },
        ...(m.automix ? [{ label: 'Endless (keep going with similar songs)', checked: m.endless, onClick: () => m.setEndless(!m.endless) }] : []),
        { divider: true, label: '' },
        ...MIX_STYLES.map((x) => ({ label: `Transitions: ${x.label}`, checked: m.mixStyle === x.value, disabled: !m.automix, onClick: () => m.setMixStyle(x.value) })),
      ]}
    />
  );
}
