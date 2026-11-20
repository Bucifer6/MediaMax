import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useMusic } from './music';
import { SeekBar, VolumeControl } from './controls';
import { Icon } from '../components/Icon';
import { Img, Spinner } from '../components/ui';
import { formatClock, formatDuration } from '../utils/format';

export function MiniPlayer() {
  const m = useMusic();
  const [queueOpen, setQueueOpen] = useState(false);
  const loc = useLocation();
  if (!m.current) return null;
  if (loc.pathname.startsWith('/play/') || loc.pathname.startsWith('/watch/')) return null;
  const t = m.current;
  const art = m.info?.posterUrl ?? t.posterUrl ?? t.thumbUrl;
  const artist = t.grandparentTitle ?? t.parentTitle ?? m.info?.subtitle ?? '';
  return (
    <>
      <div className="miniplayer" role="region" aria-label="Music player">
        <SeekBar className="mini-seek" positionMs={m.positionMs} durationMs={m.durationMs} onSeek={m.seek} />
        <div className="mini-left">
          <Link to={t.parentId ? `/item/${t.parentId}` : `/item/${t.id}`} className="mini-art">
            <Img src={art} width={96} fallback={<Icon name="music" />} />
          </Link>
          <div className="mini-text">
            <div className="mini-title">{t.title}</div>
            <div className="mini-sub">{artist}</div>
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
          <button className={`btn-icon ${queueOpen ? 'active' : ''}`} onClick={() => setQueueOpen((o) => !o)} aria-label="Queue">
            <Icon name="queue" />
          </button>
          <button className="btn-icon hide-sm" onClick={m.clear} aria-label="Close player">
            <Icon name="x" size={18} />
          </button>
        </div>
      </div>
      {queueOpen && (
        <aside className="queue-panel">
          <div className="queue-head">
            <h3>Up next</h3>
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
