import { memo, useEffect, useRef, useState, type FocusEvent, type MouseEvent } from 'react';
import { TrailerPreview } from './Preview';
import { Link, useNavigate } from 'react-router-dom';
import type { CalendarEntry, Channel, Item } from '@mediamax/shared';
import { Icon } from './Icon';
import { Badge, Img, ProgressBar, qualityTags } from './ui';
import { usePlayItem } from '../player/music';
import { api } from '../api/endpoints';
import { useToast } from '../state/toast';
import { peekHandlers } from './Peek';
import { posterTransition } from '../utils/viewTransition';
import { episodeCode, isSquare, itemLink, itemSubtitle, landscapeFor, posterFor, progressPct } from '../utils/items';
import { formatTime } from '../utils/format';

/** Kinds of item that can go on My List. */
export const canWatchlist = (item: Pick<Item, 'type' | 'parentId'>) =>
  ['movie', 'show', 'episode', 'audiobook', 'podcast'].includes(item.type) || (item.type === 'video' && !item.parentId);

/** "+ My List" / "✓ In My List" toggle. `card` is a small round button for card hover actions. */
export function WatchlistButton({ item, variant = 'detail', onChange }: { item: Item; variant?: 'detail' | 'hero' | 'card' | 'peek'; onChange?: (on: boolean) => void }) {
  const toast = useToast();
  const [on, setOn] = useState(!!item.userData?.inWatchlist);
  const [busy, setBusy] = useState(false);
  useEffect(() => setOn(!!item.userData?.inWatchlist), [item.id, item.userData?.inWatchlist]);
  const toggle = async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    const next = !on;
    setOn(next);
    setBusy(true);
    try {
      const ud = await api.items.setWatchlist(item.id, next);
      setOn(ud.inWatchlist);
      onChange?.(ud.inWatchlist);
    } catch (err) {
      setOn(!next);
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  const label = on ? 'In My List' : 'My List';
  const title = on ? 'Remove from My List' : 'Add to My List';
  if (variant === 'peek') {
    return (
      <button className={`peek-btn ${on ? 'active' : ''}`} onClick={toggle} aria-label={title} title={title} aria-pressed={on}>
        <Icon name={on ? 'check' : 'plus'} size={20} />
      </button>
    );
  }
  if (variant === 'card') {
    return (
      <button className={`card-action ${on ? 'active' : ''}`} onClick={toggle} aria-label={title} title={title} aria-pressed={on} tabIndex={-1}>
        <Icon name={on ? 'check' : 'plus'} size={18} />
      </button>
    );
  }
  return (
    <button className={`btn btn-glass btn-lg watchlist-btn watchlist-${variant} ${variant === 'hero' ? 'on-media hero-secondary' : ''} ${on ? 'active' : ''}`} onClick={toggle} aria-pressed={on} title={title} data-nav>
      <Icon name={on ? 'check' : 'plus'} size={20} /> {variant === 'hero' ? <span className="hero-btn-label">{label}</span> : label}
    </button>
  );
}

/** Kinds of item that can be marked watched from a card. */
const canMarkWatched = (item: Pick<Item, 'type'>) => ['movie', 'show', 'season', 'episode', 'video', 'audiobook', 'podcastepisode'].includes(item.type);

/** "Mark watched" toggle for card quick actions (small round button). */
export function WatchedButton({ item, played, onChange }: { item: Item; played: boolean; onChange: (played: boolean) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const toggle = async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    const next = !played;
    onChange(next);
    setBusy(true);
    try {
      const ud = await api.items.setPlayed(item.id, next);
      onChange(!!ud.played);
    } catch (err) {
      onChange(!next);
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  const title = played ? 'Mark as unwatched' : 'Mark as watched';
  return (
    <button className={`card-action ${played ? 'active' : ''}`} onClick={toggle} aria-label={title} title={title} aria-pressed={played} tabIndex={-1}>
      <Icon name="eye" size={17} />
    </button>
  );
}

/** Added in the last two weeks and not started: shows a NEW tag on hover / focus. */
export function isNewItem(item: Item, now = Date.now()): boolean {
  if (item.userData?.played || (item.userData?.positionMs ?? 0) > 0) return false;
  const t = Date.parse(item.addedAt);
  return Number.isFinite(t) && now - t < 14 * 86_400_000 && ['movie', 'show', 'episode', 'album', 'audiobook'].includes(item.type);
}

/** Remaining time for a started item, e.g. "23 min left" / "1 h 5 min left" (null when not started or nearly done). */
export function remainingLabel(item: Item): string | null {
  const pos = item.userData?.positionMs ?? 0;
  if (!item.durationMs || pos <= 0) return null;
  const left = Math.round((item.durationMs - pos) / 60000);
  if (left < 1) return null;
  return left >= 60 ? `${Math.floor(left / 60)} h ${left % 60} min left` : `${left} min left`;
}

function Fallback({ title, icon = 'film' }: { title: string; icon?: Parameters<typeof Icon>[0]['name'] }) {
  return (
    <div className="card-fallback">
      <Icon name={icon} size={28} />
      <span>{title}</span>
    </div>
  );
}

function fallbackIcon(item: Item) {
  switch (item.type) {
    case 'album':
    case 'artist':
    case 'track':
      return 'music' as const;
    case 'photo':
      return 'image' as const;
    case 'audiobook':
    case 'bookpart':
      return 'book' as const;
    case 'podcast':
    case 'podcastepisode':
      return 'podcast' as const;
    case 'show':
    case 'season':
    case 'episode':
      return 'shows' as const;
    case 'playlist':
      return 'playlist' as const;
    case 'collection':
      return 'collection' as const;
    default:
      return 'film' as const;
  }
}

/**
 * Media card: poster (2:3), square (music, photos) or landscape (16:9 episodes / videos). Always shows watched state,
 * unplayed count and progress; hover / focus reveals quick actions (play, My List, watched) and badges (new, quality).
 */
/** The peek handlers plus the focus-trailer ones (both run: spreading one bag after the other would drop ours). */
function withTrailerFocus<H extends { onFocus?: (e: FocusEvent<HTMLElement>) => void; onBlur?: (e: FocusEvent<HTMLElement>) => void }>(
  h: H, on: boolean, focus: () => void, blur: () => void,
): H {
  if (!on) return h;
  return {
    ...h,
    onFocus: (e: FocusEvent<HTMLElement>) => {
      h.onFocus?.(e);
      if (e.currentTarget === e.target) focus();
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      h.onBlur?.(e);
      blur();
    },
  };
}

export const PosterCard = memo(function PosterCard({ item, shape, showProgress = true, width, quickActions = true, ratingPoster, focusTrailer }: {
  item: Item; shape?: 'poster' | 'square' | 'landscape'; showProgress?: boolean; width?: string; quickActions?: boolean;
  /** Use the server's rating poster (the page knows whether the admin turned it on for that screen). */
  ratingPoster?: boolean;
  /** TV: grow and play the trailer after a moment of focus ({ sound } = unmuted). */
  focusTrailer?: { sound: boolean } | null;
}) {
  const play = usePlayItem();
  const [trailerOn, setTrailerOn] = useState(false);
  const focusTimer = useRef(0);
  const canTrailer = !!focusTrailer && (item.type === 'movie' || item.type === 'show');
  useEffect(() => () => window.clearTimeout(focusTimer.current), []);
  const s = shape ?? (isSquare(item) ? 'square' : item.type === 'episode' || item.type === 'video' ? 'landscape' : 'poster');
  const img = s === 'landscape' ? landscapeFor(item) : (ratingPoster && item.ratingPosterUrl) || posterFor(item);
  const [played, setPlayed] = useState(!!item.userData?.played);
  useEffect(() => setPlayed(!!item.userData?.played), [item.id, item.userData?.played]);
  const pct = showProgress ? progressPct(item) : 0;
  const unplayed = item.userData?.unplayedCount;
  const navigate = useNavigate();
  const onPlay = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    play(item);
  };
  const fresh = isNewItem(item);
  const quality = qualityTags(item.media);
  const canPlay = item.type !== 'photo';
  return (
    <Link
      to={itemLink(item)}
      className={`card card-${s} ${trailerOn ? 'focus-trailer' : ''}`}
      style={width ? { width } : undefined}
      data-nav
      title={item.title}
      {...withTrailerFocus(peekHandlers(item), canTrailer, () => {
        window.clearTimeout(focusTimer.current);
        focusTimer.current = window.setTimeout(() => setTrailerOn(true), 1500);
      }, () => {
        window.clearTimeout(focusTimer.current);
        setTrailerOn(false);
      })}
      // Poster → title page as a shared-element transition where the browser supports it (utils/viewTransition.ts).
      onClick={s === 'poster' ? (e) => posterTransition(e, navigate, itemLink(item), item) : undefined}
    >
      <div className="card-art">
        <Img src={img} width={s === 'landscape' ? 400 : 260} alt={item.title} fallback={<Fallback title={item.title} icon={fallbackIcon(item)} />} />
        {trailerOn && <TrailerPreview itemId={item.id} active muted={!focusTrailer?.sound} onEnded={() => setTrailerOn(false)} />}
        {quickActions && (
          <div className="card-hover">
            <div className="card-hover-badges">
              {fresh && <Badge tone="new">New</Badge>}
              {quality.map((q) => <Badge key={q.label} tone="quality" title={q.title}>{q.label}</Badge>)}
            </div>
            <div className="card-quick">
              {canPlay && (
                <button className="card-play" data-play onClick={onPlay} aria-label={`Play ${item.title}`} title="Play" tabIndex={-1}>
                  <Icon name="play" size={18} />
                </button>
              )}
              {canWatchlist(item) && <WatchlistButton item={item} variant="card" />}
              {canMarkWatched(item) && <WatchedButton item={item} played={played} onChange={setPlayed} />}
            </div>
          </div>
        )}
        {played && item.type !== 'track' && (
          <span className="card-badge card-watched" title="Watched">
            <Icon name="check" size={13} />
          </span>
        )}
        {!played && unplayed != null && unplayed > 0 && <span className="card-badge card-count" title={`${unplayed} unwatched`}>{unplayed}</span>}
        {item.userData?.favorite && (
          <span className="card-fav" title="Favourite">
            <Icon name="heartFill" size={13} />
          </span>
        )}
        {pct > 0 && !played && <ProgressBar value={pct} className="card-progress" />}
      </div>
      <div className="card-meta">
        <div className="card-title">{item.title}</div>
        <div className="card-sub"><span>{itemSubtitle(item)}</span></div>
      </div>
    </Link>
  );
});

/**
 * Continue Watching / Next Up: a 16:9 still with progress along the bottom edge; title, episode and time left
 * below. One click resumes (when started); quick actions: My List and watched.
 */
export const LandscapeCard = memo(function LandscapeCard({ item }: { item: Item }) {
  const play = usePlayItem();
  const pct = progressPct(item);
  const left = pct > 0 ? remainingLabel(item) : null;
  const [played, setPlayed] = useState(!!item.userData?.played);
  useEffect(() => setPlayed(!!item.userData?.played), [item.id, item.userData?.played]);
  const isEp = item.type === 'episode';
  const title = isEp ? item.grandparentTitle ?? item.title : item.title;
  const code = episodeCode(item);
  const sub = isEp ? [code, item.title].filter(Boolean).join(' · ') : itemSubtitle(item);
  return (
    <Link
      to={itemLink(item)}
      className="card card-landscape card-continue"
      data-type={item.type}
      data-nav
      title={title}
      aria-label={`${pct > 0 ? 'Resume ' : ''}${title}${isEp ? `, ${sub}` : ''}${left ? `, ${left}` : ''}`}
      {...peekHandlers(item)}
      data-play={pct > 0 ? '' : undefined}
      onClick={(e) => {
        if (pct > 0) {
          e.preventDefault();
          play(item);
        }
      }}
    >
      <div className="card-art">
        <Img src={landscapeFor(item)} width={480} alt="" fallback={<Fallback title={title} icon={fallbackIcon(item)} />} />
        <div className="card-hover">
          <button className="card-play" data-play onClick={(e) => { e.preventDefault(); e.stopPropagation(); play(item); }} aria-label={`Play ${title}`} title={pct > 0 ? 'Resume' : 'Play'} tabIndex={-1}>
            <Icon name="play" size={22} />
          </button>
          <div className="cw-actions">
            {canWatchlist(item) && <WatchlistButton item={item} variant="card" />}
            {canMarkWatched(item) && <WatchedButton item={item} played={played} onChange={setPlayed} />}
          </div>
        </div>
        {played && <span className="card-badge card-watched" title="Watched"><Icon name="check" size={13} /></span>}
        {pct > 0 && !played && <ProgressBar value={pct} className="card-progress" />}
      </div>
      <div className="card-meta">
        <div className="card-title">{title}</div>
        <div className="card-sub">
          <span className={isEp ? 'cw-ep' : undefined}>{sub}</span>
          {left && <span className="card-left">{left}</span>}
        </div>
      </div>
    </Link>
  );
});

/** Netflix-style Top 10 card: a big outlined rank number beside the poster. */
export const RankedCard = memo(function RankedCard({ item, rank }: { item: Item; rank: number }) {
  return (
    <div className="ranked-card" data-rank={rank}>
      <span className="rank-num" aria-hidden>{rank}</span>
      <PosterCard item={item} shape="poster" />
      <span className="sr-only">Number {rank}</span>
    </div>
  );
});

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
/** "Today", "Tomorrow", or e.g. "Tue 24 Nov" for a YYYY-MM-DD date. */
export function dayLabel(date: string, now = new Date()): string {
  const d = new Date(`${date}T12:00:00`);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return dayFmt.format(d);
}

export function epCode(s: number | null, e: number | null): string {
  if (s != null && e != null) return `S${s} · E${e}`;
  return e != null ? `E${e}` : '';
}

/** Calendar card: show artwork with the air date and episode. */
export const UpcomingCard = memo(function UpcomingCard({ entry }: { entry: CalendarEntry }) {
  const it = entry.episode ?? entry.show;
  return (
    <Link to={itemLink(entry.episode ?? entry.show)} className="card card-landscape card-upcoming" data-nav title={entry.show.title}>
      <div className="card-art">
        <Img src={(entry.episode?.thumbUrl ?? null) || landscapeFor(entry.show)} width={480} alt={entry.show.title} fallback={<Fallback title={entry.show.title} icon="shows" />} />
        <span className={`date-chip ${entry.kind === 'added' ? 'new' : ''}`}>{entry.kind === 'added' ? 'New' : dayLabel(entry.date)}</span>
        {entry.following && <span className="follow-dot" title="You watch this show" />}
      </div>
      <div className="card-meta">
        <div className="card-title">{entry.show.title}</div>
        <div className="card-sub">{[epCode(entry.seasonNumber, entry.episodeNumber), entry.title ?? (it === entry.show ? null : it.title)].filter(Boolean).join(' — ') || 'New episode'}</div>
      </div>
    </Link>
  );
});

export function programProgress(start: string, end: string, now = Date.now()): number {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (!(e > s)) return 0;
  return Math.max(0, Math.min(100, ((now - s) / (e - s)) * 100));
}

export const ChannelCard = memo(function ChannelCard({ channel }: { channel: Channel }) {
  const now = channel.nowPlaying;
  return (
    <Link to={`/watch/live/${encodeURIComponent(channel.id)}`} className="card card-channel" data-nav title={channel.name}>
      <div className="card-art channel-art">
        {now?.iconUrl && <Img src={now.iconUrl} width={400} className="channel-program-art" />}
        <div className="channel-logo">
          <Img src={channel.logoUrl} width={160} alt={channel.name} fallback={<span className="channel-logo-text">{channel.name}</span>} />
        </div>
        <span className="live-pill">
          <span className="live-dot" /> LIVE
        </span>
        {channel.number != null && <span className="channel-num">{channel.number}</span>}
        <div className="card-hover">
          <span className="card-play">
            <Icon name="play" size={22} />
          </span>
        </div>
        {now && <ProgressBar value={programProgress(now.start, now.end)} className="card-progress" />}
      </div>
      <div className="card-meta">
        <div className="card-title">{now?.title ?? channel.name}</div>
        <div className="card-sub">
          {now ? `${channel.name} · ${formatTime(now.start)} – ${formatTime(now.end)}` : channel.categoryName ?? 'No guide data'}
        </div>
      </div>
    </Link>
  );
});

export function CardSkeleton({ shape = 'poster' }: { shape?: 'poster' | 'landscape' | 'square' }) {
  return (
    <div className={`card card-${shape} card-skeleton`}>
      <div className="card-art skeleton" />
      <div className="card-meta">
        <div className="skeleton skeleton-line" style={{ width: '80%' }} />
        <div className="skeleton skeleton-line" style={{ width: '50%' }} />
      </div>
    </div>
  );
}
