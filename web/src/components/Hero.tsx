import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { HeroStyle, Item } from '@mediamax/shared';
import { Icon } from './Icon';
import { Img } from './ui';
import { usePlayItem } from '../player/music';
import { formatDuration } from '../utils/format';
import { isResumable, itemLink } from '../utils/items';
import { TrailerPreview, usePreviewsEnabled } from './Preview';
import { WatchlistButton } from './Cards';

/** Delay before a slide's trailer starts playing in the background. */
const PREVIEW_DELAY_MS = 3000;

export function Hero({ items, style = 'carousel' }: { items: Item[]; style?: HeroStyle }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const play = usePlayItem();
  const list = style === 'static' ? items.slice(0, 1) : items.slice(0, 8);
  const previews = usePreviewsEnabled();
  // Background trailer: armed ~3 s after a slide appears; while it plays the carousel waits for it to finish.
  const [armed, setArmed] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [muted, setMuted] = useState(true);
  const current = list[Math.min(index, list.length - 1)];

  useEffect(() => {
    setArmed(false);
    setPreviewing(false);
    if (!previews || !current || (current.type !== 'movie' && current.type !== 'show')) return;
    const t = window.setTimeout(() => setArmed(true), PREVIEW_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [current?.id, previews]);

  useEffect(() => {
    if (style !== 'carousel' || paused || previewing || list.length < 2) return;
    const t = window.setTimeout(() => setIndex((i) => (i + 1) % list.length), 9000);
    return () => window.clearTimeout(t);
  }, [index, paused, previewing, list.length, style]);

  if (!list.length || style === 'none') return null;
  const item = list[Math.min(index, list.length - 1)];

  return (
    <section className={`hero ${previewing ? 'hero-previewing' : ''}`} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} aria-roledescription="carousel">
      {list.map((it, i) => (
        <div key={it.id} className={`hero-bg ${i === index ? 'active' : ''}`} aria-hidden={i !== index}>
          <Img src={it.backdropUrl ?? it.thumbUrl ?? it.posterUrl} width={1920} />
        </div>
      ))}
      {armed && current && (
        <TrailerPreview
          key={current.id}
          itemId={current.id}
          active={armed}
          muted={muted}
          maxBitrate={8000}
          className="hero-trailer"
          onPlaying={setPreviewing}
          onEnded={() => {
            setArmed(false);
            if (list.length > 1 && style === 'carousel') setIndex((i) => (i + 1) % list.length);
          }}
        />
      )}
      <div className="hero-shade" />
      {previewing && (
        <button className="btn-round hero-mute" onClick={() => setMuted((m) => !m)} aria-label={muted ? 'Unmute trailer' : 'Mute trailer'} title={muted ? 'Unmute' : 'Mute'}>
          <Icon name={muted ? 'mute' : 'volume'} size={20} />
        </button>
      )}
      <div className="hero-content" key={item.id}>
        {item.logoUrl ? (
          <Img src={item.logoUrl} width={600} className="hero-logo" alt={item.title} fallback={<h1 className="hero-title">{item.title}</h1>} />
        ) : (
          <h1 className="hero-title">{item.title}</h1>
        )}
        <div className="hero-meta">
          {item.communityRating != null && (
            <span className="hero-rating">
              <Icon name="starFill" size={14} /> {item.communityRating.toFixed(1)}
            </span>
          )}
          {item.year && <span>{item.year}</span>}
          {item.contentRating && <span className="badge badge-outline">{item.contentRating}</span>}
          {item.durationMs ? <span>{formatDuration(item.durationMs)}</span> : null}
          {item.type === 'show' && item.childCount ? <span>{item.childCount} Seasons</span> : null}
          {item.genres.slice(0, 3).map((g) => (
            <span key={g} className="hero-genre">{g}</span>
          ))}
        </div>
        {item.tagline && <p className="hero-tagline">{item.tagline}</p>}
        {item.overview && <p className="hero-overview">{item.overview}</p>}
        <div className="hero-actions">
          <button className="btn btn-primary btn-lg" onClick={() => play(item)} data-nav data-play>
            <Icon name="play" size={20} /> {isResumable(item) ? 'Resume' : 'Play'}
          </button>
          <Link className="btn btn-glass btn-lg" to={itemLink(item)} data-nav>
            <Icon name="info" size={20} /> More info
          </Link>
          {(item.type === 'movie' || item.type === 'show') && <WatchlistButton item={item} variant="hero" />}
        </div>
      </div>
      {list.length > 1 && (
        <div className="hero-dots">
          {list.map((it, i) => (
            <button key={it.id} className={`hero-dot ${i === index ? 'active' : ''}`} onClick={() => setIndex(i)} aria-label={`Show ${it.title}`} tabIndex={-1}>
              {i === index && !paused && !previewing && style === 'carousel' && <span className="hero-dot-fill" />}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function HeroSkeleton() {
  return (
    <section className="hero hero-skeleton">
      <div className="hero-content">
        <div className="skeleton" style={{ width: 360, height: 64, maxWidth: '80%' }} />
        <div className="skeleton skeleton-line" style={{ width: 240, marginTop: 20 }} />
        <div className="skeleton skeleton-line" style={{ width: 480, maxWidth: '90%', marginTop: 16 }} />
        <div className="skeleton skeleton-line" style={{ width: 420, maxWidth: '85%' }} />
      </div>
    </section>
  );
}
