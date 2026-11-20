import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { Chapter, Item, Renderer } from '@mediamax/shared';
import { useMusic, type SleepTimer } from './music';
import { PlayerBookmarks } from '../components/Bookmarks';
import { useNow } from '../hooks';
import { SeekBar, VolumeControl } from './controls';
import { CastMenu } from './CastMenu';
import { useRendererRemote } from './renderers';
import { useToast } from '../state/toast';
import { Icon } from '../components/Icon';
import { Dropdown, Img, Spinner, type MenuItem } from '../components/ui';
import { formatClock, formatDuration } from '../utils/format';
import { KaraokeLyrics } from '../lyrics/KaraokeLyrics';
import { totalOffset, useLyrics, usePrefs } from '../lyrics/useLyrics';
import { useKaraoke } from './karaoke';
import { KaraokeControls, useNowPlaying } from './NowPlaying';

/** Index of the chapter containing `ms`. */
export function chapterAt(chapters: Chapter[], ms: number): number {
  let idx = -1;
  chapters.forEach((c, i) => {
    if (ms >= c.startMs) idx = i;
  });
  return idx;
}

export function ChapterList({ chapters, positionMs, onSeek }: { chapters: Chapter[]; positionMs: number; onSeek: (ms: number) => void }) {
  const cur = chapterAt(chapters, positionMs);
  return (
    <ol className="chapter-list">
      {chapters.map((c, i) => (
        <li key={`${c.startMs}-${i}`}>
          <button className={`chapter-item ${i === cur ? 'current' : ''}`} onClick={() => onSeek(c.startMs)} aria-current={i === cur ? 'true' : undefined}>
            <span className="chapter-num">{i + 1}</span>
            <span className="chapter-title">{c.title || `Chapter ${i + 1}`}</span>
            <small>{formatClock(c.startMs)}</small>
          </button>
        </li>
      ))}
    </ol>
  );
}

function LyricsView({ itemId, onSeek }: { itemId: string; onSeek: (ms: number) => void }) {
  const { lyrics } = useLyrics(itemId);
  const [prefs] = usePrefs();
  return <KaraokeLyrics lyrics={lyrics} offsetMs={totalOffset(lyrics, prefs)} onSeek={onSeek} />;
}

/** Karaoke popover: on/off, vocal level, AI preparation. */
function KaraokeButton() {
  const k = useKaraoke();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="karaoke-pop-wrap hide-sm" ref={ref}>
      <button className={`btn-icon ${k.enabled ? 'active' : ''}`} onClick={() => setOpen((o) => !o)} aria-label="Karaoke and vocals" title="Karaoke / vocals" aria-expanded={open}>
        <Icon name="sparkles" />
      </button>
      {open && (
        <div className="karaoke-pop" role="dialog" aria-label="Karaoke">
          <KaraokeControls compact />
        </div>
      )}
    </div>
  );
}

type Panel = null | 'queue' | 'chapters' | 'lyrics' | 'bookmarks';

function sleepLabel(s: SleepTimer, now: number): string {
  if (s.mode === 'time') return `${Math.max(1, Math.ceil((s.endsAt - now) / 60000))}m`;
  return s.mode === 'chapter' ? 'Ch.' : 'End';
}

/** Sleep timer button + menu. */
export function SleepTimerButton() {
  const m = useMusic();
  useNow(10000); // keep the countdown fresh while paused
  const now = Date.now();
  const t = m.current;
  const partWord = t?.type === 'bookpart' ? 'part' : t?.type === 'podcastepisode' ? 'episode' : 'track';
  const items: MenuItem[] = [
    { label: 'Off', checked: !m.sleep, onClick: () => m.setSleep(null) },
    ...[15, 30, 45, 60].map((n) => ({ label: `${n} minutes`, checked: m.sleep?.mode === 'time' && m.sleep.minutes === n, onClick: () => m.setSleep({ minutes: n }) })),
    { label: 'End of chapter', checked: m.sleep?.mode === 'chapter', disabled: !m.chapters.length, onClick: () => m.setSleep('chapter') },
    { label: `End of ${partWord}`, checked: m.sleep?.mode === 'part', onClick: () => m.setSleep('part') },
  ];
  const desc = !m.sleep ? 'Sleep timer' : m.sleep.mode === 'time' ? `Sleep timer: ${sleepLabel(m.sleep, now)} left` : m.sleep.mode === 'chapter' ? 'Sleep timer: end of chapter' : `Sleep timer: end of ${partWord}`;
  return (
    <Dropdown
      className="sleep-dropdown"
      trigger={({ onClick, open }) => (
        <button className={`btn-icon sleep-btn ${m.sleep ? 'active' : ''}`} onClick={onClick} aria-label={desc} title={desc} aria-expanded={open} aria-haspopup="menu">
          <Icon name="clock" />
          {m.sleep && <span className="sleep-badge">{sleepLabel(m.sleep, now)}</span>}
        </button>
      )}
      items={items}
    />
  );
}

/** Radio entries for a track: song, album and artist radio. */
export function radioMenuItems(t: Item, start: (seedId: string, title: string) => void): MenuItem[] {
  if (t.type !== 'track') return [];
  return [
    { label: 'Start radio', icon: 'antenna', onClick: () => start(t.id, t.title) },
    ...(t.parentId ? [{ label: 'Album radio', icon: 'antenna' as const, onClick: () => start(t.parentId!, t.parentTitle ?? 'this album') }] : []),
    ...(t.grandparentId ? [{ label: 'Artist radio', icon: 'antenna' as const, onClick: () => start(t.grandparentId!, t.grandparentTitle ?? 'this artist') }] : []),
  ];
}

/** Track menu of the music player. */
function TrackMenu({ t }: { t: Item }) {
  const m = useMusic();
  const navigate = useNavigate();
  const items: MenuItem[] = [
    ...radioMenuItems(t, (id, title) => void m.startRadio(id, title)),
    ...(t.type === 'track' ? [{ divider: true, label: '' }] : []),
    ...(t.parentId ? [{ label: t.type === 'track' ? 'Go to album' : 'Go to book', icon: 'music' as const, onClick: () => navigate(`/item/${t.parentId}`) }] : []),
    ...(t.grandparentId ? [{ label: 'Go to artist', icon: 'user' as const, onClick: () => navigate(`/item/${t.grandparentId}`) }] : []),
  ];
  if (!items.length) return null;
  return (
    <Dropdown
      className="track-menu"
      trigger={({ onClick, open }) => (
        <button className="btn-icon" onClick={onClick} aria-label="More options" title="More" aria-expanded={open} aria-haspopup="menu">
          <Icon name="more" />
        </button>
      )}
      items={items}
    />
  );
}

export function MiniPlayer() {
  const m = useMusic();
  const [panel, setPanel] = useState<Panel>(null);
  const queueOpen = panel === 'queue';
  const setQueueOpen = (fn: boolean | ((o: boolean) => boolean)) => setPanel((p) => ((typeof fn === 'function' ? fn(p === 'queue') : fn) ? 'queue' : null));
  const loc = useLocation();
  const remote = useRendererRemote();
  const toast = useToast();
  const np = useNowPlaying();
  if (!m.current) return null;
  if (loc.pathname.startsWith('/play/') || loc.pathname.startsWith('/watch/')) return null;
  const t = m.current;
  const art = m.info?.posterUrl ?? t.posterUrl ?? t.thumbUrl;
  /** Send the rest of the queue to a network renderer (Sonos, DLNA, Kodi) and pause here. */
  const playToRenderer = async (r: Renderer) => {
    const rest = m.queue.slice(m.index, m.index + 200).map((q) => q.id);
    await remote.start(r, { itemId: t.id, startMs: Math.round(m.positionMs), queueItemIds: rest.length > 1 ? rest : undefined });
    m.pause();
    toast.show(`Playing on ${r.name}`);
  };
  const artist = t.grandparentTitle ?? t.parentTitle ?? m.info?.subtitle ?? '';
  return (
    <>
      <div className="miniplayer" role="region" aria-label="Music player">
        <SeekBar className="mini-seek" positionMs={m.positionMs} durationMs={m.durationMs} onSeek={m.seek} />
        <div className="mini-left">
          <button className="mini-art" onClick={() => np.show()} aria-label="Open the full-screen player" title="Full-screen player">
            <Img src={art} width={96} fallback={<Icon name={t.type === 'bookpart' ? 'book' : t.type === 'podcastepisode' ? 'podcast' : 'music'} />} />
            <span className="mini-art-expand"><Icon name="fullscreen" size={18} /></span>
          </button>
          <div className="mini-text">
            <div className="mini-title"><Link to={t.parentId ? `/item/${t.parentId}` : `/item/${t.id}`}>{t.title}</Link></div>
            <div className="mini-sub">
              {m.casting ? <span className="mini-casting"><Icon name="cast" size={13} /> Casting to {m.cast.deviceName ?? 'device'}</span> : artist}
              {m.radio && !m.casting && <span className="mini-radio" title={m.radio.label}><Icon name="antenna" size={12} /> {m.radio.label}</span>}
            </div>
          </div>
        </div>
        <div className="mini-center">
          <button className={`btn-icon ${m.shuffle ? 'active' : ''} hide-sm`} onClick={() => m.setShuffle(!m.shuffle)} aria-label="Shuffle">
            <Icon name="shuffle" size={18} />
          </button>
          <button className="btn-icon" onClick={m.prev} aria-label="Previous">
            <Icon name="prev" />
          </button>
          <button className="btn-icon btn-play-round" onClick={m.toggle} aria-label={m.playing ? 'Pause' : 'Play'}>
            {m.loading ? <Spinner size={20} /> : <Icon name={m.playing ? 'pause' : 'play'} size={22} />}
          </button>
          <button className="btn-icon" onClick={m.next} aria-label="Next">
            <Icon name="next" />
          </button>
          <button
            className={`btn-icon ${m.repeat !== 'off' ? 'active' : ''} hide-sm`}
            onClick={() => m.setRepeat(m.repeat === 'off' ? 'all' : m.repeat === 'all' ? 'one' : 'off')}
            aria-label={`Repeat ${m.repeat}`}
          >
            <Icon name="repeat" size={18} />
            {m.repeat === 'one' && <span className="repeat-one">1</span>}
          </button>
        </div>
        <div className="mini-right">
          <span className="mini-time hide-sm">
            {formatClock(m.positionMs)} / {formatClock(m.durationMs)}
          </span>
          <span className="hide-sm">
            <VolumeControl volume={m.volume} muted={m.muted} onVolume={m.setVolume} onMute={m.setMuted} />
          </span>
          {m.chapters.length > 0 && (
            <button className={`btn-icon ${panel === 'chapters' ? 'active' : ''}`} onClick={() => setPanel((p) => (p === 'chapters' ? null : 'chapters'))} aria-label="Chapters" title="Chapters">
              <Icon name="chapters" />
            </button>
          )}
          {(t.type === 'bookpart' || t.type === 'podcastepisode') && (
            <button className={`btn-icon ${panel === 'bookmarks' ? 'active' : ''}`} onClick={() => setPanel((p) => (p === 'bookmarks' ? null : 'bookmarks'))} aria-label="Bookmarks" title="Bookmarks">
              <Icon name="flag" />
            </button>
          )}
          <SleepTimerButton />
          {t.type === 'track' && (
            <button className={`btn-icon ${panel === 'lyrics' ? 'active' : ''}`} onClick={() => setPanel((p) => (p === 'lyrics' ? null : 'lyrics'))} aria-label="Lyrics" title="Lyrics">
              <Icon name="lyrics" />
            </button>
          )}
          {t.type === 'track' && <KaraokeButton />}
          <CastMenu cast={m.cast} media="audio" size={20} onPlayTo={playToRenderer} />
          <TrackMenu t={t} />
          <button className={`btn-icon ${queueOpen ? 'active' : ''}`} onClick={() => setQueueOpen((o) => !o)} aria-label="Queue">
            <Icon name="queue" />
          </button>
          <button className="btn-icon hide-sm" onClick={m.clear} aria-label="Close player">
            <Icon name="x" size={18} />
          </button>
        </div>
      </div>
      {panel === 'chapters' && m.chapters.length > 0 && (
        <aside className="queue-panel" aria-label="Chapters">
          <div className="queue-head">
            <h3>Chapters</h3>
            <button className="btn-icon" onClick={() => setPanel(null)} aria-label="Close chapters"><Icon name="x" size={18} /></button>
          </div>
          <ChapterList chapters={m.chapters} positionMs={m.positionMs} onSeek={m.seek} />
        </aside>
      )}
      {panel === 'bookmarks' && (t.type === 'bookpart' || t.type === 'podcastepisode') && (
        <aside className="queue-panel" aria-label="Bookmarks">
          <div className="queue-head">
            <h3>Bookmarks</h3>
            <button className="btn-icon" onClick={() => setPanel(null)} aria-label="Close bookmarks"><Icon name="x" size={18} /></button>
          </div>
          <PlayerBookmarks />
        </aside>
      )}
      {panel === 'lyrics' && t.type === 'track' && (
        <aside className="queue-panel lyrics-panel" aria-label="Lyrics">
          <div className="queue-head">
            <h3>Lyrics</h3>
            <button className="btn-icon" onClick={() => setPanel(null)} aria-label="Close lyrics"><Icon name="x" size={18} /></button>
          </div>
          <LyricsView itemId={t.id} onSeek={m.seek} />
        </aside>
      )}
      {queueOpen && (
        <aside className="queue-panel">
          <div className="now-playing-card">
            <span className="queue-art"><Img src={art} width={96} fallback={<Icon name="music" size={18} />} /></span>
            <span className="queue-text">
              <small className="now-playing-kicker">Now playing</small>
              <span>{t.title}</span>
              <small>{artist}</small>
            </span>
            {t.type === 'track' && (
              <button className="btn btn-sm" onClick={() => void m.startRadio(t.id, t.title)} title={`Radio based on ${t.title}`}>
                <Icon name="antenna" size={14} /> Start radio
              </button>
            )}
          </div>
          <div className="queue-head">
            <h3>{m.radio ? m.radio.label : 'Up next'}</h3>
            <div>
              <button className="btn btn-ghost btn-sm" onClick={m.clear}>Clear</button>
              <button className="btn-icon" onClick={() => setQueueOpen(false)} aria-label="Close queue">
                <Icon name="x" size={18} />
              </button>
            </div>
          </div>
          <ol className="queue-list">
            {m.queue.map((q, i) => (
              <li key={`${q.id}-${i}`} className={i === m.index ? 'current' : i < m.index ? 'past' : ''}>
                <button className="queue-item" onClick={() => m.jump(i)}>
                  <span className="queue-art">
                    <Img src={q.posterUrl ?? q.thumbUrl} width={64} fallback={<Icon name="music" size={16} />} />
                    {i === m.index && m.playing && <span className="eq"><i /><i /><i /></span>}
                  </span>
                  <span className="queue-text">
                    <span>{q.title}</span>
                    <small>{q.grandparentTitle ?? q.parentTitle}</small>
                  </span>
                  <small className="queue-dur">{formatDuration(q.durationMs)}</small>
                </button>
                <button className="btn-icon" onClick={() => m.removeAt(i)} aria-label="Remove from queue">
                  <Icon name="x" size={14} />
                </button>
              </li>
            ))}
          </ol>
        </aside>
      )}
    </>
  );
}
