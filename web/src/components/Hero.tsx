import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { HeroStyle, Item } from '@mediamax/shared';
import { Icon } from './Icon';
import { Img } from './ui';
import { usePlayItem } from '../player/music';
import { formatDuration } from '../utils/format';
import { isResumable, itemLink } from '../utils/items';
import { TrailerPreview, usePreviewsEnabled } from './Preview';
import { WatchlistButton } from './Cards';
import { useAmbientFrom } from '../theme/ambient';
import { isCalm } from '../theme/fx';

/** Time each slide stays up before a carousel advances (only for themes that choose the carousel hero). */
const SLIDE_MS = 9000;

/** Delay before a slide's trailer starts playing in the background (only when the viewer enabled previews). */
const PREVIEW_DELAY_MS = 3000;

const COLLAPSE_KEY = 'vibe.hero.collapsed';

function useCollapsed(enabled: boolean): [boolean, (v: boolean) => void] {
  const [collapsed, set] = useState(() => {
    if (!enabled) return false;
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const update = (v: boolean) => {
    set(v);
    try {
      localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0');
    } catch {
      /* storage blocked */
    }
  };
  return [enabled && collapsed, update];
}

/**
 * The featured hero: quiet and static by default. Backdrop + logo (or title) + one meta line + overview + Play / More
 * info / My List. `style="carousel"` (a theme choice) adds dots and slow auto-advance, paused on hover / focus;
 * trailers play only when the viewer turned previews on. `collapsible` adds a hide button (remembered per device).
 */
export function Hero({ items, style = 'static', collapsible = false, eyebrow }: { items: Item[]; style?: HeroStyle; collapsible?: boolean; eyebrow?: string }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const play = usePlayItem();
  const list = style === 'carousel' ? items.slice(0, 6) : items.slice(0, 1);
  const previews = usePreviewsEnabled();
  const [armed, setArmed] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [muted, setMuted] = useState(true);
  const [collapsed, setCollapsed] = useCollapsed(collapsible);
  const current = list[Math.min(index, list.length - 1)];
  const ref = useRef<HTMLElement>(null);
  useAmbientFrom(current && !collapsed ? current.backdropUrl ?? current.thumbUrl ?? current.posterUrl : null);

  useEffect(() => {
    setArmed(false);
    setPreviewing(false);
    if (collapsed || !previews || isCalm() || !current || (current.type !== 'movie' && current.type !== 'show')) return;
    const t = window.setTimeout(() => setArmed(true), PREVIEW_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [current?.id, previews, collapsed]);

  useEffect(() => {
    if (style !== 'carousel' || paused || previewing || collapsed || list.length < 2 || isCalm()) return;
    const t = window.setTimeout(() => setIndex((i) => (i + 1) % list.length), SLIDE_MS);
    return () => window.clearTimeout(t);
  }, [index, paused, previewing, list.length, style, collapsed]);

  if (!list.length || style === 'none') return null;
  const item = list[Math.min(index, list.length - 1)];

  if (collapsed) {
    return (
      <div className="hero-collapsed">
        <Icon name="sparkles" size={16} />
        <span>Featured: <strong>{item.title}</strong></span>
        <span className="spacer" />
        <button className="btn btn-sm btn-ghost" onClick={() => setCollapsed(false)}>
          <Icon name="chevronDown" size={14} /> Show
        </button>
      </div>
    );
  }

  const meta: ReactNode[] = [];
  if (item.year) meta.push(<span key="y">{item.year}</span>);
  if (item.communityRating != null) meta.push(<span key="r" className="hero-rating"><Icon name="starFill" size={13} /> {item.communityRating.toFixed(1)}</span>);
  if (item.durationMs && item.type !== 'show') meta.push(<span key="d">{formatDuration(item.durationMs)}</span>);
  if (item.type === 'show' && item.childCount) meta.push(<span key="s">{item.childCount} {item.childCount === 1 ? 'Season' : 'Seasons'}</span>);
  if (item.genres.length) meta.push(<span key="g">{item.genres.slice(0, 2).join(', ')}</span>);

  return (
    <section
      ref={ref}
      className={`hero ${previewing ? 'hero-previewing' : ''}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setPaused(false)}
      aria-roledescription={list.length > 1 ? 'carousel' : undefined}
      aria-label="Featured"
    >
      <div className="hero-stage">
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
              if (list.length > 1) setIndex((i) => (i + 1) % list.length);
            }}
          />
        )}
      </div>
      <div className="hero-shade" />
      {collapsible && (
        <button className="btn-icon btn-icon-sm hero-collapse" onClick={() => setCollapsed(true)} aria-label="Hide the featured title" title="Hide">
          <Icon name="chevronUp" size={16} />
        </button>
      )}
      {previewing && (
        <button className="btn-round hero-mute" onClick={() => setMuted((m) => !m)} aria-label={muted ? 'Unmute trailer' : 'Mute trailer'} title={muted ? 'Unmute' : 'Mute'}>
          <Icon name={muted ? 'mute' : 'volume'} size={20} />
        </button>
      )}
      <div className="hero-content" key={item.id} aria-live={list.length > 1 ? 'polite' : undefined}>
        {eyebrow && <div className="hero-eyebrow">{eyebrow}</div>}
        {item.logoUrl ? (
          <Img src={item.logoUrl} width={600} className="hero-logo" alt={item.title} fallback={<h2 className="hero-title">{item.title}</h2>} />
        ) : (
          <h2 className="hero-title">{item.title}</h2>
        )}
        <div className="hero-meta">
          {meta}
          {item.contentRating && <span className="badge badge-outline">{item.contentRating}</span>}
        </div>
        {item.overview && <p className="hero-overview">{item.overview}</p>}
        <div className="hero-actions">
          <button className="btn btn-play btn-lg hero-play" onClick={() => play(item)} data-nav data-play>
            <Icon name="play" size={20} /> {isResumable(item) ? 'Resume' : 'Play'}
          </button>
          <Link className="btn btn-glass btn-lg on-media hero-secondary" to={itemLink(item)} title="More info" data-nav>
            <Icon name="info" size={20} /> <span className="hero-btn-label">More info</span>
          </Link>
          {(item.type === 'movie' || item.type === 'show') && <WatchlistButton item={item} variant="hero" />}
        </div>
      </div>
      {list.length > 1 && (
        <div className="hero-dots" role="group" aria-label="Featured titles">
          {list.map((it, i) => (
            <button key={it.id} className={`hero-dot ${i === index ? 'active' : ''}`} onClick={() => setIndex(i)} aria-label={`Show ${it.title}`} aria-current={i === index ? 'true' : undefined} tabIndex={-1} />
          ))}
        </div>
      )}
    </section>
  );
}

export function HeroSkeleton() {
  return (
    <section className="hero hero-skeleton" aria-hidden="true">
      <div className="hero-content">
        <div className="skeleton" style={{ width: 360, height: 56, maxWidth: '80%' }} />
        <div className="skeleton skeleton-line" style={{ width: 240, marginTop: 20 }} />
        <div className="skeleton skeleton-line" style={{ width: 480, maxWidth: '90%', marginTop: 16 }} />
        <div className="skeleton skeleton-line" style={{ width: 420, maxWidth: '85%' }} />
      </div>
    </section>
  );
}
