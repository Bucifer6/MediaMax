import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Icon } from './Icon';
import { Img, ProgressBar } from './ui';
import { usePlayItem } from '../player/music';
import { formatDuration } from '../utils/format';
import { isResumable, itemLink, landscapeFor, progressPct } from '../utils/items';
import { TrailerPreview, useHoverPreviews } from './Preview';
import { WatchlistButton, canWatchlist } from './Cards';
import { getAmbient, paletteFor, setAmbient, type Palette } from '../theme/ambient';
import { isCalm } from '../theme/fx';
import { cancelClose, closePeek, isTv, leave, type Peek } from './Peek';

/** The expanded quick-view card (see Peek.tsx for when it opens and closes). */
export default function PeekCard({ peek }: { peek: NonNullable<Peek> }) {
  const { item, el, via } = peek;
  const play = usePlayItem();
  const navigate = useNavigate();
  const previews = useHoverPreviews() && via === 'mouse' && (item.type === 'movie' || item.type === 'show');
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Geometry: grow out of the card, centred on it, kept inside the viewport.
  const r = el.getBoundingClientRect();
  const wide = r.width > r.height;
  const tv = isTv();
  const w = Math.min(window.innerWidth - 32, Math.max(wide ? r.width * 1.32 : r.width * 2.05, tv ? 440 : 320));
  const left = Math.min(Math.max(16, r.left + r.width / 2 - w / 2), window.innerWidth - 16 - w);
  const artH = (w * 9) / 16;
  const estH = artH + (tv ? 220 : 170);
  const top = Math.min(Math.max(16, r.top + r.height / 2 - estH / 2), Math.max(16, window.innerHeight - 16 - estH));
  const originX = r.left + r.width / 2 - left;
  const originY = r.top + r.height / 2 - top;
  const style = { left, top, width: w, '--peek-from': String(Math.min(1, r.width / w)), transformOrigin: `${originX}px ${originY}px` } as CSSProperties;

  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    // Marks the poster for TV spatial navigation (Down enters the peek, Up comes back).
    el.dataset.peeking = '1';
    return () => {
      cancelAnimationFrame(raf);
      delete el.dataset.peeking;
    };
  }, [el]);

  // The focused title lights the page while its peek is open; the previous light comes back afterwards.
  useEffect(() => {
    const prev = getAmbient();
    let mine: Palette | null = null;
    let alive = true;
    void paletteFor(item.backdropUrl ?? landscapeFor(item)).then((p) => {
      if (alive && p) {
        mine = p;
        setAmbient(p);
      }
    });
    return () => {
      alive = false;
      if (mine && getAmbient() === mine) setAmbient(prev);
    };
  }, [item]);

  const pct = progressPct(item);
  const left_ = item.durationMs && item.userData?.positionMs ? item.durationMs - item.userData.positionMs : 0;
  const title = item.type === 'episode' ? item.grandparentTitle ?? item.title : item.title;
  const meta = [
    item.type === 'episode' && item.index != null ? `S${item.parentIndex ?? '?'} · E${item.index}` : null,
    item.year ? String(item.year) : null,
    item.type === 'show' && item.childCount ? `${item.childCount} season${item.childCount === 1 ? '' : 's'}` : formatDuration(item.durationMs) || null,
  ].filter(Boolean) as string[];

  return (
    <div
      ref={ref}
      className={`peek ${shown ? 'in' : ''} ${isCalm() ? 'calm' : ''}`}
      style={style}
      role="group"
      aria-label={`${title}: quick view`}
      onMouseEnter={cancelClose}
      onMouseLeave={() => leave(el, 80)}
      onBlur={(e) => {
        const to = e.relatedTarget as Node | null;
        if (!to || (!ref.current?.contains(to) && to !== el)) leave(el, 60);
      }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, a')) return;
        closePeek();
        navigate(itemLink(item));
      }}
    >
      <div className="peek-art">
        <Img src={item.backdropUrl ?? landscapeFor(item)} width={Math.round(w)} alt="" />
        {previews && <TrailerPreview itemId={item.id} active className="peek-trailer" maxBitrate={3000} />}
        <div className="peek-art-shade" />
        <div className="peek-heading">
          {item.logoUrl && item.type !== 'episode' ? (
            <Img src={item.logoUrl} width={360} className="peek-logo" alt={title} fallback={<strong className="peek-title">{title}</strong>} />
          ) : (
            <strong className="peek-title">{title}</strong>
          )}
        </div>
      </div>
      <div className="peek-body">
        <div className="peek-actions">
          {item.type !== 'season' && (
            <button className="peek-play" onClick={() => { closePeek(); play(item); }} aria-label={`${isResumable(item) ? 'Resume' : 'Play'} ${title}`}>
              <Icon name="play" size={20} />
            </button>
          )}
          {canWatchlist(item) && <WatchlistButton item={item} variant="peek" />}
          <Link className="peek-btn" to={itemLink(item)} onClick={() => closePeek()} aria-label={`More about ${title}`} title="More info">
            <Icon name="chevronDown" size={20} />
          </Link>
          {item.communityRating != null && (
            <span className="peek-rating"><Icon name="starFill" size={13} /> {item.communityRating.toFixed(1)}</span>
          )}
        </div>
        <div className="peek-meta">
          {item.type === 'episode' && <span className="peek-ep">{item.title}</span>}
          {meta.map((m) => <span key={m}>{m}</span>)}
          {item.contentRating && <span className="badge badge-outline">{item.contentRating}</span>}
        </div>
        {item.genres?.length > 0 && <div className="peek-genres">{item.genres.slice(0, 3).join(' · ')}</div>}
        {pct > 0 && !item.userData?.played && (
          <div className="peek-progress">
            <ProgressBar value={pct} />
            {left_ > 60000 && <small>{Math.round(left_ / 60000)} min left</small>}
          </div>
        )}
      </div>
    </div>
  );
}
