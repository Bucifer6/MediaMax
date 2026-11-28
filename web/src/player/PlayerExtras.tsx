/**
 * Player add-ons for the web and TV player:
 *  - EpisodesDrawer: the season's episodes beside the picture, to switch without leaving playback;
 *  - PauseOverlay: title, episode and synopsis after a few seconds paused;
 *  - PlayerClock: the time now and when the title will end;
 *  - PostPlayRecs: "You might also like" near the end of a movie (Settings → Playback → threshold);
 *  - useLetterbox: the "Auto" picture mode's black-bar sampling.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Item } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { Img } from '../components/ui';
import { Icon } from '../components/Icon';
import { formatClock } from '../utils/format';
import { detectBars, settleBars, zoomForBars } from './letterbox';

export function EpisodesDrawer({ item, onClose, onPlay }: { item: Item; onClose: () => void; onPlay: (id: string) => void }) {
  const [eps, setEps] = useState<Item[] | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (!item.parentId) return;
    api.items.children(item.parentId, { sort: 'index', order: 'asc', limit: 500 }).then((r) => setEps(r.items)).catch(() => setEps([]));
  }, [item.parentId]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.current button')?.focus();
  }, [eps]);
  return (
    <aside className="episodes-drawer" role="dialog" aria-label="Episodes" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); }}>
      <div className="episodes-drawer-head">
        <strong>{item.parentTitle ?? `Season ${item.parentIndex ?? ''}`}</strong>
        <button className="btn-icon" onClick={onClose} aria-label="Close episodes"><Icon name="x" size={18} /></button>
      </div>
      <ol ref={listRef}>
        {(eps ?? []).map((e) => (
          <li key={e.id} className={e.id === item.id ? 'current' : ''}>
            <button onClick={() => (e.id === item.id ? onClose() : onPlay(e.id))} aria-current={e.id === item.id ? 'true' : undefined}>
              <span className="ed-still"><Img src={e.thumbUrl ?? e.backdropUrl} width={240} alt="" /></span>
              <span className="ed-text">
                <span className="ed-title">{e.index ?? '?'}. {e.title}</span>
                {e.durationMs ? <span className="muted small">{formatClock(e.durationMs)}{e.userData.played ? ' · Watched' : ''}</span> : null}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </aside>
  );
}

const PAUSE_OVERLAY_MS = 5000;

export function PauseOverlay({ item, paused, controlsVisible }: { item: Item | null; paused: boolean; controlsVisible: boolean }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    setShow(false);
    if (!paused) return;
    const t = window.setTimeout(() => setShow(true), PAUSE_OVERLAY_MS);
    return () => window.clearTimeout(t);
  }, [paused]);
  if (!show || !item || controlsVisible) return null;
  const sub = item.type === 'episode' ? `${item.grandparentTitle ?? ''} · S${item.parentIndex ?? '?'} E${item.index ?? '?'}` : [item.year, item.contentRating].filter(Boolean).join(' · ');
  return (
    <div className="pause-overlay" aria-live="polite">
      <span className="muted">Paused</span>
      <h2>{item.title}</h2>
      {sub && <p className="pause-sub">{sub}</p>}
      {item.overview && <p className="pause-overview">{item.overview}</p>}
    </div>
  );
}

export function PlayerClock({ positionMs, durationMs, rate }: { positionMs: number; durationMs: number; rate: number }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 15000);
    return () => window.clearInterval(t);
  }, []);
  const hm = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const left = durationMs > 0 ? Math.max(0, durationMs - positionMs) / (rate || 1) : 0;
  return (
    <span className="player-clock" aria-label={`Time ${hm(now)}${left ? `, ends at ${hm(new Date(now.getTime() + left))}` : ''}`}>
      {hm(now)}{left > 60000 ? <small> · ends {hm(new Date(now.getTime() + left))}</small> : null}
    </span>
  );
}

export function PostPlayRecs({ item, onDismiss, onPlay }: { item: Item; onDismiss: () => void; onPlay: (id: string) => void }) {
  const navigate = useNavigate();
  const [recs, setRecs] = useState<Item[]>([]);
  useEffect(() => {
    api.items.similar(item.id, 6).then((r) => setRecs(r.filter((x) => x.type === 'movie' || x.type === 'show'))).catch(() => setRecs([]));
  }, [item.id]);
  if (!recs.length) return null;
  return (
    <div className="postplay" role="region" aria-label="You might also like" onClick={(e) => e.stopPropagation()}>
      <div className="postplay-head">
        <strong>You might also like</strong>
        <button className="btn-icon" onClick={onDismiss} aria-label="Hide suggestions"><Icon name="x" size={16} /></button>
      </div>
      <div className="postplay-row">
        {recs.slice(0, 5).map((r) => (
          <button key={r.id} className="postplay-card" onClick={() => (r.type === 'movie' ? onPlay(r.id) : navigate(`/item/${r.id}`))} title={r.title}>
            <Img src={r.posterUrl} width={180} alt={r.title} />
            <span>{r.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * "Auto" picture mode: sample a 64-px frame every 2 s for the first samples, then every 15 s, and settle on the
 * smallest bar seen. Canvas reads of a cross-origin stream throw (tainted canvas): Auto then simply stays at 1×.
 */
export function useLetterbox(video: HTMLVideoElement | null, active: boolean, key: string): number {
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    setZoom(1);
    if (!video || !active) return;
    const canvas = document.createElement('canvas');
    const W = 64;
    const samples: number[] = [];
    let stopped = false;
    let timer = 0;
    const sample = () => {
      if (stopped) return;
      try {
        if (video.paused) {
          // Nothing new to look at while paused: check again in a while.
          timer = window.setTimeout(sample, 5000);
          return;
        }
        if (video.readyState >= 2 && video.videoWidth) {
          const H = Math.max(8, Math.round((W * video.videoHeight) / video.videoWidth));
          canvas.width = W;
          canvas.height = H;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) return;
          ctx.drawImage(video, 0, 0, W, H);
          samples.push(detectBars(ctx.getImageData(0, 0, W, H).data, W, H));
          if (samples.length > 12) samples.shift();
          setZoom(zoomForBars(settleBars(samples)));
        }
      } catch {
        stopped = true;
        return;
      }
      timer = window.setTimeout(sample, samples.length < 5 ? 2000 : 15000);
    };
    timer = window.setTimeout(sample, 1500);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [video, active, key]);
  return zoom;
}
