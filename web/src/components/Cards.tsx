import { memo, useEffect, useRef, useState, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import type { CalendarEntry, Channel, Item } from '@mediamax/shared';
import { Icon } from './Icon';
import { Img, ProgressBar } from './ui';
import { usePlayItem } from '../player/music';
import { api } from '../api/endpoints';
import { useToast } from '../state/toast';
import { TrailerPreview, useHoverPreviews } from './Preview';
import { isSquare, itemLink, itemSubtitle, landscapeFor, posterFor, progressPct } from '../utils/items';
import { formatTime } from '../utils/format';

/** Kinds of item that can go on My List. */
export const canWatchlist = (item: Pick<Item, 'type' | 'parentId'>) =>
  ['movie', 'show', 'episode', 'audiobook', 'podcast'].includes(item.type) || (item.type === 'video' && !item.parentId);

/** "+ My List" / "✓ In My List" toggle. `card` is a small round button for card hover actions. */
export function WatchlistButton({ item, variant = 'detail', onChange }: { item: Item; variant?: 'detail' | 'hero' | 'card'; onChange?: (on: boolean) => void }) {
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
  if (variant === 'card') {
    return (
      <button className={`card-action ${on ? 'active' : ''}`} onClick={toggle} aria-label={title} title={title} aria-pressed={on} tabIndex={-1}>
        <Icon name={on ? 'check' : 'plus'} size={18} />
      </button>
    );
  }
  return (
    <button className={`btn btn-glass btn-lg watchlist-btn watchlist-${variant} ${on ? 'active' : ''}`} onClick={toggle} aria-pressed={on} title={title} data-nav>
      <Icon name={on ? 'check' : 'plus'} size={20} /> {label}
    </button>
  );
}

/** Hover a card for this long (desktop only) before its trailer starts. */
const HOVER_PREVIEW_MS = 1000;

function useHoverPreview(item: Item) {
  const allowed = useHoverPreviews() && (item.type === 'movie' || item.type === 'show');
  const [active, setActive] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);
  if (!allowed) return { active: false, handlers: {} };
  return {
    active,
    handlers: {
      onMouseEnter: () => {
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setActive(true), HOVER_PREVIEW_MS);
      },
      onMouseLeave: () => {
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = null;
        setActive(false);
      },
    },
  };
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

export const PosterCard = memo(function PosterCard({ item, shape, showProgress = true, width }: { item: Item; shape?: 'poster' | 'square' | 'landscape'; showProgress?: boolean; width?: string }) {
  const play = usePlayItem();
  const s = shape ?? (isSquare(item) ? 'square' : item.type === 'episode' || item.type === 'video' ? 'landscape' : 'poster');
  const img = s === 'landscape' ? landscapeFor(item) : posterFor(item);
  const pct = showProgress ? progressPct(item) : 0;
  const unplayed = item.userData?.unplayedCount;
  const hover = useHoverPreview(item);
  const onPlay = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    play(item);
  };
  return (
    <Link to={itemLink(item)} className={`card card-${s}`} style={width ? { width } : undefined} data-nav title={item.title} {...hover.handlers}>
      <div className="card-art">
        <Img src={img} width={s === 'landscape' ? 400 : 260} alt={item.title} fallback={<Fallback title={item.title} icon={fallbackIcon(item)} />} />
        {hover.active && <TrailerPreview itemId={item.id} active className="card-trailer" maxBitrate={2000} />}
        <div className="card-hover">
          {item.type !== 'photo' && (
            <button className="card-play" onClick={onPlay} aria-label={`Play ${item.title}`} tabIndex={-1}>
              <Icon name="play" size={22} />
            </button>
          )}
          {canWatchlist(item) && (
            <div className="card-actions">
              <WatchlistButton item={item} variant="card" />
            </div>
          )}
        </div>
        {item.userData?.played && item.type !== 'track' && (
          <span className="card-badge card-watched" title="Watched">
            <Icon name="check" size={13} />
          </span>
        )}
        {!item.userData?.played && unplayed != null && unplayed > 0 && <span className="card-badge card-count">{unplayed}</span>}
        {item.userData?.favorite && (
          <span className="card-fav">
            <Icon name="heartFill" size={13} />
          </span>
        )}
        {pct > 0 && !item.userData?.played && <ProgressBar value={pct} className="card-progress" />}
      </div>
      <div className="card-meta">
        <div className="card-title">{item.title}</div>
        <div className="card-sub">{itemSubtitle(item)}</div>
      </div>
    </Link>
  );
});

/** Wide card used by Continue Watching / Next Up. */
export const LandscapeCard = memo(function LandscapeCard({ item }: { item: Item }) {
  const play = usePlayItem();
  const pct = progressPct(item);
  const remaining = item.durationMs && item.userData?.positionMs ? item.durationMs - item.userData.positionMs : null;
  const title = item.type === 'episode' ? item.grandparentTitle ?? item.title : item.title;
  const sub = item.type === 'episode' ? `${item.parentIndex != null ? `S${item.parentIndex} · ` : ''}E${item.index ?? '?'} — ${item.title}` : itemSubtitle(item);
  return (
    <Link
      to={itemLink(item)}
      className="card card-landscape card-continue"
      data-nav
      onClick={(e) => {
        if (pct > 0) {
          e.preventDefault();
          play(item);
        }
      }}
    >
      <div className="card-art">
        <Img src={landscapeFor(item)} width={480} alt={title} fallback={<Fallback title={title} icon={fallbackIcon(item)} />} />
        <div className="card-hover">
          <button className="card-play" onClick={(e) => { e.preventDefault(); e.stopPropagation(); play(item); }} aria-label={`Play ${title}`} tabIndex={-1}>
            <Icon name="play" size={22} />
          </button>
        </div>
        {remaining != null && remaining > 60000 && pct > 0 && <span className="card-remaining">{Math.round(remaining / 60000)} min left</span>}
        {pct > 0 && <ProgressBar value={pct} className="card-progress" />}
      </div>
      <div className="card-meta">
        <div className="card-title">{title}</div>
        <div className="card-sub">{sub}</div>
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
