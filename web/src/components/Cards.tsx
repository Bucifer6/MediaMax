import { memo, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import type { Channel, Item } from '@mediamax/shared';
import { Icon } from './Icon';
import { Img, ProgressBar } from './ui';
import { usePlayItem } from '../player/music';
import { isSquare, itemLink, itemSubtitle, landscapeFor, posterFor, progressPct } from '../utils/items';
import { formatTime } from '../utils/format';

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
  const onPlay = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    play(item);
  };
  return (
    <Link to={itemLink(item)} className={`card card-${s}`} style={width ? { width } : undefined} data-nav title={item.title}>
      <div className="card-art">
        <Img src={img} width={s === 'landscape' ? 400 : 260} alt={item.title} fallback={<Fallback title={item.title} icon={fallbackIcon(item)} />} />
        <div className="card-hover">
          {item.type !== 'photo' && (
            <button className="card-play" onClick={onPlay} aria-label={`Play ${item.title}`} tabIndex={-1}>
              <Icon name="play" size={22} />
            </button>
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
