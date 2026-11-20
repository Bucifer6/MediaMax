import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Channel } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { useMusic } from './music';
import { attachStream, type Attached } from './engine';
import { Icon } from '../components/Icon';
import { Img, Spinner } from '../components/ui';
import { isTypingTarget } from '../hooks';

const MAX_TILES = 4;

/** One live channel in the multiview grid: its own playback session, muted unless it has audio focus. */
function Tile({ channel, focused, onFocus, onRemove, onSwap, onFull }: {
  channel: Channel;
  focused: boolean;
  onFocus: () => void;
  onRemove: () => void;
  onSwap: () => void;
  onFull: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [buffering, setBuffering] = useState(true);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let attached: Attached | null = null;
    let sessionId: string | null = null;
    let cancelled = false;
    let beat: ReturnType<typeof setInterval> | undefined;
    const start = async (forceHls: boolean) => {
      setError(null);
      setBuffering(true);
      try {
        const pi = await api.livetv.play(channel.id, { forceHls: forceHls || undefined, multiview: true });
        if (cancelled) {
          api.playback.stop(pi.sessionId).catch(() => {});
          return;
        }
        sessionId = pi.sessionId;
        attached = await attachStream(v, pi, {
          live: true,
          onFatal: (kind, msg) => {
            if ((kind === 'mpegts' || kind === 'native') && !forceHls) {
              attached?.destroy();
              if (sessionId) api.playback.stop(sessionId).catch(() => {});
              void start(true);
            } else setError(msg);
          },
        });
        v.muted = true; // autoplay policy; audio focus unmutes below
        await v.play().catch(() => {});
        // Keep the session alive; the server reaps silent sessions.
        clearInterval(beat);
        beat = setInterval(() => {
          if (sessionId) api.playback.progress(sessionId, { positionMs: Math.round(v.currentTime * 1000), state: 'playing', sessionId }).catch(() => {});
        }, 60_000);
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
        setBuffering(false);
      }
    };
    void start(false);
    const onWait = () => setBuffering(true);
    const onPlaying = () => setBuffering(false);
    v.addEventListener('waiting', onWait);
    v.addEventListener('playing', onPlaying);
    const onHide = () => {
      if (sessionId) api.playback.stop(sessionId, true).catch(() => {});
      sessionId = null;
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      cancelled = true;
      window.removeEventListener('pagehide', onHide);
      clearInterval(beat);
      v.removeEventListener('waiting', onWait);
      v.removeEventListener('playing', onPlaying);
      attached?.destroy();
      if (sessionId) api.playback.stop(sessionId, true).catch(() => {});
    };
  }, [channel.id, retry]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !focused;
    if (focused) v.play().catch(() => {});
  }, [focused]);

  const now = channel.nowPlaying;
  return (
    <div className={`mv-tile${focused ? ' focused' : ''}`} onClick={onFocus} onDoubleClick={onFull} role="group" aria-label={`${channel.name}${focused ? ' (audio)' : ''}`}>
      <video ref={videoRef} playsInline muted />
      {buffering && !error && <div className="mv-center"><Spinner size={32} /></div>}
      {error && (
        <div className="mv-center mv-error">
          <p>{error}</p>
          <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setRetry((n) => n + 1); }}>Retry</button>
        </div>
      )}
      <div className="mv-bar">
        {channel.logoUrl ? <Img src={channel.logoUrl} alt="" className="mv-logo" /> : null}
        <div className="mv-meta">
          <strong>{channel.number != null ? `${channel.number} · ` : ''}{channel.name}</strong>
          {now && <span className="muted">{now.title}</span>}
        </div>
        <Icon name={focused ? 'volume' : 'mute'} size={16} />
        <button className="btn-icon" title="Change channel" aria-label="Change channel" onClick={(e) => { e.stopPropagation(); onSwap(); }}><Icon name="refresh" size={16} /></button>
        <button className="btn-icon" title="Open full screen" aria-label="Open in full player" onClick={(e) => { e.stopPropagation(); onFull(); }}><Icon name="fullscreen" size={16} /></button>
        <button className="btn-icon" title="Remove" aria-label="Remove from multiview" onClick={(e) => { e.stopPropagation(); onRemove(); }}><Icon name="x" size={16} /></button>
      </div>
    </div>
  );
}

function ChannelPicker({ channels, exclude, onPick, onClose }: { channels: Channel[]; exclude: string[]; onPick: (c: Channel) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return channels.filter((c) => !exclude.includes(c.id) && (!t || c.name.toLowerCase().includes(t) || String(c.number ?? '') === t || c.nowPlaying?.title.toLowerCase().includes(t))).slice(0, 200);
  }, [channels, exclude, q]);
  return (
    <div className="mv-picker" role="dialog" aria-label="Choose a channel" onClick={onClose}>
      <div className="mv-picker-panel" onClick={(e) => e.stopPropagation()}>
        <div className="mv-picker-head">
          <input className="input" placeholder="Search channels or programmes" value={q} onChange={(e) => setQ(e.target.value)} autoFocus
            onKeyDown={(e) => { if (e.key === 'Escape') onClose(); if (e.key === 'Enter' && list[0]) onPick(list[0]); }} />
          <button className="btn-icon" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
        </div>
        <ul className="mv-picker-list">
          {list.map((c) => (
            <li key={c.id}>
              <button onClick={() => onPick(c)}>
                <span className="mv-picker-num">{c.number ?? ''}</span>
                <span className="mv-picker-name">{c.name}</span>
                <span className="muted">{c.nowPlaying?.title ?? ''}</span>
              </button>
            </li>
          ))}
          {!list.length && <li className="muted" style={{ padding: 16 }}>{q.trim() ? 'No channels match.' : 'Every channel is already on screen.'}</li>}
        </ul>
      </div>
    </div>
  );
}

/** Watch up to four live channels at once (sports days, news). URL: /watch/multiview?ch=id1,id2,… */
export default function Multiview() {
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const music = useMusic();
  const ids = useMemo(() => (sp.get('ch') ?? '').split(',').filter(Boolean).slice(0, MAX_TILES), [sp]);
  const [lineup, setLineup] = useState<Channel[]>([]);
  const [focus, setFocus] = useState(0);
  const [picker, setPicker] = useState<{ slot: number } | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    music.pause();
    const load = () => api.livetv.channels({ limit: 2000, withEpg: true }).then((r) => setLineup(r.items)).catch(() => {});
    void load();
    const t = setInterval(load, 5 * 60_000); // keep "now playing" fresh
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const byId = useMemo(() => new Map(lineup.map((c) => [c.id, c])), [lineup]);
  const tiles = ids.map((id) => byId.get(id)).filter((c): c is Channel => !!c);
  const setIds = useCallback((next: string[]) => setSp((p) => {
    const n = new URLSearchParams(p);
    if (next.length) n.set('ch', next.join(','));
    else n.delete('ch');
    return n;
  }, { replace: true }), [setSp]);

  useEffect(() => {
    if (focus >= ids.length) setFocus(Math.max(0, ids.length - 1));
  }, [ids.length, focus]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || picker) return;
      const n = Number(e.key);
      if (n >= 1 && n <= ids.length) setFocus(n - 1);
      else if (e.key === 'Tab' && ids.length) {
        e.preventDefault();
        setFocus((f) => (f + (e.shiftKey ? ids.length - 1 : 1)) % ids.length);
      } else if (e.key === 'f' || e.key === 'F') {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void shellRef.current?.requestFullscreen().catch(() => {});
      } else if (e.key === 'Escape' && !document.fullscreenElement) navigate(-1);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [ids.length, picker, navigate]);

  const pick = (c: Channel) => {
    if (!picker) return;
    const next = [...ids];
    if (picker.slot < next.length) next[picker.slot] = c.id;
    else next.push(c.id);
    setIds(next.slice(0, MAX_TILES));
    setFocus(Math.min(picker.slot, MAX_TILES - 1));
    setPicker(null);
  };

  const layout = tiles.length <= 1 ? 'one' : tiles.length === 2 ? 'two' : 'four';
  return (
    <div className="mv-shell" ref={shellRef}>
      <header className="mv-head">
        <button className="btn-icon" onClick={() => navigate(-1)} aria-label="Back"><Icon name="arrowLeft" size={20} /></button>
        <h1><Icon name="grid" size={18} /> Multiview</h1>
        <span className="muted mv-hint">Click a tile for its sound · 1–4 / Tab to switch · double-click for full screen · F for full window</span>
        {ids.length < MAX_TILES && (
          <button className="btn btn-sm btn-primary" onClick={() => setPicker({ slot: ids.length })}><Icon name="plus" size={14} /> Add channel</button>
        )}
      </header>
      {tiles.length === 0 ? (
        <div className="mv-empty">
          <Icon name="grid" size={48} />
          <h2>Watch up to four channels at once</h2>
          <p className="muted">Each tile uses one stream (and one provider connection unless someone else is already watching that channel).</p>
          <button className="btn btn-primary" onClick={() => setPicker({ slot: 0 })}><Icon name="plus" size={16} /> Add a channel</button>
        </div>
      ) : (
        <div className={`mv-grid mv-${layout}`}>
          {tiles.map((c, i) => (
            <Tile
              key={c.id}
              channel={c}
              focused={i === focus}
              onFocus={() => setFocus(i)}
              onRemove={() => setIds(ids.filter((x) => x !== c.id))}
              onSwap={() => setPicker({ slot: i })}
              onFull={() => navigate(`/watch/live/${c.id}`)}
            />
          ))}
          {layout === 'four' && tiles.length === 3 && (
            <button className="mv-tile mv-add" onClick={() => setPicker({ slot: 3 })}><Icon name="plus" size={32} /><span>Add channel</span></button>
          )}
        </div>
      )}
      {picker && <ChannelPicker channels={lineup} exclude={ids} onPick={pick} onClose={() => setPicker(null)} />}
    </div>
  );
}
