/** Mini remote for a TV / speaker / Kodi box Kinora is playing to (DLNA, Sonos, Kodi). */
import { useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Img, Spinner } from '../components/ui';
import { useToast } from '../state/toast';
import { formatClock } from '../utils/format';
import { SeekBar, VolumeControl } from './controls';
import { useRendererPolling, useRendererRemote } from './renderers';

export function RendererBar() {
  useRendererPolling();
  const { active, state, command, dismiss } = useRendererRemote();
  const toast = useToast();
  const loc = useLocation();
  const [pending, setPending] = useState<string | null>(null);
  const [dragVol, setDragVol] = useState<number | null>(null);
  const volTimer = useRef(0);
  if (!active || !state) return null;
  if (loc.pathname.startsWith('/play/') || loc.pathname.startsWith('/watch/')) return null;
  const run = async (action: Parameters<typeof command>[0], body?: Parameters<typeof command>[1]) => {
    setPending(action);
    try {
      await command(action, body);
    } catch (e) {
      toast.error(e);
    } finally {
      setPending(null);
    }
  };
  const ended = state.state === 'stopped' || state.state === 'idle';
  const paused = state.state === 'paused';
  const vol = dragVol ?? state.volume ?? 0;
  // Volume sliders fire continuously: send the last value after a short pause.
  const setVol = (v: number) => {
    setDragVol(v);
    window.clearTimeout(volTimer.current);
    volTimer.current = window.setTimeout(() => {
      void command('volume', { volume: v }).catch((e) => toast.error(e)).finally(() => setDragVol(null));
    }, 250);
  };
  return (
    <div className="renderer-bar" role="region" aria-label={`Playing on ${active.name}`}>
      {!ended && <SeekBar className="renderer-seek" positionMs={state.positionMs} durationMs={state.durationMs ?? 0} onSeek={(ms) => void run('seek', { positionMs: ms })} />}
      <div className="renderer-art">
        <Img src={state.posterUrl} width={96} fallback={<Icon name="cast" />} />
      </div>
      <div className="renderer-text">
        <div className="renderer-title">{state.title ?? (ended ? 'Finished' : 'Starting…')}</div>
        <div className="renderer-sub">
          <Icon name="cast" size={13} /> {ended ? (state.error ?? `Stopped on ${active.name}`) : `${state.state === 'buffering' ? 'Starting on' : paused ? 'Paused on' : 'Playing on'} ${active.name}`}
          {state.queue && !ended ? ` · ${state.queue.index}/${state.queue.total}` : ''}
          {!ended && state.durationMs ? <span className="hide-sm"> · {formatClock(state.positionMs)} / {formatClock(state.durationMs)}</span> : null}
        </div>
      </div>
      <div className="renderer-controls">
        {!ended && (
          <>
            {state.queue && (
              <button className="btn-icon" onClick={() => void run('previous')} aria-label="Previous" disabled={!!pending}><Icon name="prev" size={18} /></button>
            )}
            <button className="btn-icon btn-play-round" onClick={() => void run(paused ? 'resume' : 'pause')} aria-label={paused ? 'Resume' : 'Pause'} disabled={!!pending}>
              {pending === 'pause' || pending === 'resume' || state.state === 'buffering' ? <Spinner size={18} /> : <Icon name={paused ? 'play' : 'pause'} size={20} />}
            </button>
            {state.queue && (
              <button className="btn-icon" onClick={() => void run('next')} aria-label="Next" disabled={!!pending || state.queue.index >= state.queue.total}><Icon name="next" size={18} /></button>
            )}
            {state.volume != null && (
              <span className="hide-sm">
                <VolumeControl volume={vol / 100} muted={state.muted} onVolume={(v) => setVol(Math.round(v * 100))} onMute={(m) => void run('volume', { muted: m })} />
              </span>
            )}
            <button className="btn-icon" onClick={() => void run('stop')} aria-label={`Stop playing on ${active.name}`} title="Stop" disabled={!!pending}>
              <Icon name="x" size={18} />
            </button>
          </>
        )}
        {ended && (
          <button className="btn btn-sm" onClick={dismiss}>Close</button>
        )}
      </div>
    </div>
  );
}
