import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import type React from 'react';
import type { HeroStyle, Item } from '@mediamax/shared';
import { Icon } from './Icon';
import { Img } from './ui';
import { usePlayItem } from '../player/music';
import { formatDuration } from '../utils/format';
import { isResumable, itemLink } from '../utils/items';
import { TrailerPreview, usePreviewsEnabled } from './Preview';
import { WatchlistButton } from './Cards';
import { useAmbientFrom } from '../theme/ambient';
import { isCalm, isLite } from '../theme/fx';

/** Time each slide stays up before the reel advances (also drives the reel's progress fill, see --reel-ms). */
const SLIDE_MS = 9000;

/**
 * Scroll parallax: the backdrop drifts slower than the page and the title block lifts and fades as it scrolls away.
 * Writes one CSS variable (--hero-y, px) per frame; CSS does the transforms. Off in lite mode / reduced motion.
 */
function useHeroParallax(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el || isCalm()) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const y = Math.min(window.scrollY, el.offsetHeight);
      el.style.setProperty('--hero-y', String(Math.round(y)));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, [ref]);
}

/** Delay before a slide's trailer starts playing in the background. */
const PREVIEW_DELAY_MS = 3000;

export function Hero({ items, style = 'carousel' }: { items: Item[]; style?: HeroStyle }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const play = usePlayItem();
  const list = style === 'static' ? items.slice(0, 1) : items.slice(0, 8);
  const previews = usePreviewsEnabled();
  // Background trailer: armed ~3 s after a slide appears; while it plays the carousel waits for it to finish.
  const [armed, setArmed] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [muted, setMuted] = useState(true);
  const current = list[Math.min(index, list.length - 1)];
  const ref = useRef<HTMLElement>(null);
  useHeroParallax(ref);
  // The featured title's artwork lights the whole page (theme/ambient.ts), cross-fading with the slides.
  useAmbientFrom(current ? current.backdropUrl ?? current.thumbUrl ?? current.posterUrl : null);

  useEffect(() => {
    setArmed(false);
    setPreviewing(false);
    if (!previews || !current || (current.type !== 'movie' && current.type !== 'show')) return;
    const t = window.setTimeout(() => setArmed(true), PREVIEW_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [current?.id, previews]);

  useEffect(() => {
    if (style !== 'carousel' || paused || userPaused || previewing || list.length < 2) return;
    const t = window.setTimeout(() => setIndex((i) => (i + 1) % list.length), SLIDE_MS);
    return () => window.clearTimeout(t);
  }, [index, paused, userPaused, previewing, list.length, style]);

  if (!list.length || style === 'none') return null;
  const item = list[Math.min(index, list.length - 1)];

  const running = style === 'carousel' && !paused && !userPaused && !previewing && list.length > 1;
  return (
    <section
      ref={ref}
      className={`hero ${previewing ? 'hero-previewing' : ''} ${isLite() ? '' : 'hero-fx'}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setPaused(false)}
      aria-roledescription="carousel"
      aria-label="Featured"
      style={{ '--reel-ms': `${SLIDE_MS}ms` } as CSSProperties}
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
              if (list.length > 1 && style === 'carousel') setIndex((i) => (i + 1) % list.length);
            }}
          />
        )}
      </div>
      <div className="hero-shade" />
      <div className="hero-grain" aria-hidden="true" />
      {previewing && (
        <button className="btn-round hero-mute" onClick={() => setMuted((m) => !m)} aria-label={muted ? 'Unmute trailer' : 'Mute trailer'} title={muted ? 'Unmute' : 'Mute'}>
          <Icon name={muted ? 'mute' : 'volume'} size={20} />
        </button>
      )}
      <div className="hero-content" key={item.id} aria-live="polite">
        <p className="hero-eyebrow"><Icon name="sparkles" size={16} /> In the spotlight</p>
        <div className="hero-logo-layer">
          {item.logoUrl ? (
            <Img src={item.logoUrl} width={600} className="hero-logo" alt={item.title} fallback={<h1 className="hero-title">{item.title}</h1>} />
          ) : (
            <h1 className="hero-title">{item.title}</h1>
          )}
        </div>
        <div className="hero-info-layer">
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
            <button className="btn btn-primary btn-lg hero-play" onClick={() => play(item)} data-nav data-play>
              <Icon name="play" size={20} /> {isResumable(item) ? 'Resume' : 'Play'}
            </button>
            <Link className="btn btn-glass btn-lg" to={itemLink(item)} data-nav>
              <Icon name="info" size={20} /> More info
            </Link>
            {(item.type === 'movie' || item.type === 'show') && <WatchlistButton item={item} variant="hero" />}
          </div>
        </div>
      </div>
      {list.length > 1 && (
        // The reel: one frame per featured title; the current one fills as the slide's time runs out.
        <div className="hero-reel" role="group" aria-label="Featured titles">
          <div className="reel-heading"><span>Featured collection</span><button type="button" className="reel-pause" onClick={() => setUserPaused((p) => !p)} aria-label={userPaused ? 'Play featured carousel' : 'Pause featured carousel'} aria-pressed={userPaused}><Icon name={userPaused ? 'play' : 'pause'} size={16} /></button></div>
          <div className="reel-frames">
            {list.map((it, i) => (
              <button
                key={it.id}
                className={`reel-frame ${i === index ? 'active' : ''} ${i < index ? 'seen' : ''}`}
                onClick={() => setIndex(i)}
                aria-label={`Show ${it.title}`}
                aria-current={i === index ? 'true' : undefined}
                data-nav
              >
                <Img src={it.backdropUrl ?? it.thumbUrl ?? it.posterUrl} width={160} alt="" />
                <span className="reel-caption"><strong>{it.title}</strong><small>{[it.year, it.genres[0]].filter(Boolean).join(' · ')}</small></span>
                <span className="reel-progress">{i === index && <span className={`reel-fill ${running ? 'run' : ''}`} key={`${it.id}-${running}`} />}</span>
              </button>
            ))}
          </div>
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
