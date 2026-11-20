import { Link } from 'react-router-dom';
import type { HomeRow, ItemSort } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useAsync, useServerEvent } from '../hooks';
import { Hero, HeroSkeleton } from '../components/Hero';
import { Row } from '../components/Row';
import { CardSkeleton, ChannelCard, LandscapeCard, PosterCard, RankedCard, UpcomingCard } from '../components/Cards';
import { EmptyState, ErrorState } from '../components/ui';
import { Icon } from '../components/Icon';

function rowLink(row: HomeRow): string | undefined {
  const l = row.link;
  if (row.type === 'live-now' || row.type === 'favorite-channels') return '/livetv';
  if (row.type === 'recordings') return '/dvr';
  if (!l) return undefined;
  if (l.page === 'watchlist') return '/my-list';
  if (l.page === 'calendar') return '/calendar';
  if (l.itemId) return `/item/${l.itemId}`;
  if (l.libraryId) {
    const p = new URLSearchParams();
    if (l.genre) p.set('genre', l.genre);
    if (l.sort) p.set('sort', l.sort as ItemSort);
    const qs = p.toString();
    return `/library/${l.libraryId}${qs ? '?' + qs : ''}`;
  }
  return undefined;
}

function HomeRowView({ row }: { row: HomeRow }) {
  if (row.type === 'live-now' || row.type === 'favorite-channels') {
    const channels = row.channels ?? [];
    if (!channels.length) return null;
    return (
      <Row title={row.title} link={rowLink(row)} className="row-channels">
        {channels.map((c) => (
          <ChannelCard key={c.id} channel={c} />
        ))}
      </Row>
    );
  }
  if (!row.items.length) return null;
  if (row.type === 'top10') {
    return (
      <Row title={row.title} className="row-top10">
        {row.items.slice(0, 10).map((it, i) => <RankedCard key={it.id} item={it} rank={i + 1} />)}
      </Row>
    );
  }
  if (row.type === 'upcoming' && row.calendar?.length) {
    return (
      <Row title={row.title} link={rowLink(row)} className="row-wide row-upcoming">
        {row.calendar.map((e) => <UpcomingCard key={`${e.show.id}-${e.date}`} entry={e} />)}
      </Row>
    );
  }
  const wide = row.type === 'continue' || row.type === 'nextup' || row.type === 'recordings';
  return (
    <Row title={row.title} link={rowLink(row)} className={wide ? 'row-wide' : ''}>
      {row.items.map((it) => (wide ? <LandscapeCard key={it.id} item={it} /> : <PosterCard key={it.id} item={it} />))}
    </Row>
  );
}

export function Home() {
  const { theme, user, libraries } = useApp();
  const home = useAsync(() => api.items.home(), []);
  useServerEvent((ev) => {
    if (ev.type === 'library.updated' || (ev.type === 'library.scan' && ev.status === 'finished')) home.reload();
    if (ev.type === 'userdata.updated') {
      home.setData((d) =>
        d
          ? {
              rows: d.rows
                .map((r) => ({ ...r, items: r.items.map((i) => (i.id === ev.itemId ? { ...i, userData: ev.userData } : i)) }))
                // "Not interested" takes a title out of the discovery rows straight away.
                .map((r) =>
                  (ev.userData.notInterested && ['recommended', 'because', 'trending'].includes(r.type)) || (r.type === 'watchlist' && !ev.userData.inWatchlist)
                    ? { ...r, items: r.items.filter((i) => i.id !== ev.itemId) }
                    : r,
                ),
            }
          : d,
      );
    }
  });

  if (home.loading && !home.data) {
    return (
      <div className="home">
        {theme.heroStyle !== 'none' && <HeroSkeleton />}
        <div className="home-rows">
          {[0, 1, 2].map((r) => (
            <section className="row" key={r}>
              <div className="row-head"><div className="skeleton skeleton-line" style={{ width: 180, height: 20 }} /></div>
              <div className="row-scroller">{Array.from({ length: 8 }).map((_, i) => <CardSkeleton key={i} shape={r === 0 ? 'landscape' : 'poster'} />)}</div>
            </section>
          ))}
        </div>
      </div>
    );
  }
  if (home.error && !home.data) return <div className="page"><ErrorState message={home.error} onRetry={home.reload} /></div>;

  const rows = home.data?.rows ?? [];
  const heroRow = rows.find((r) => r.type === 'hero');
  const rest = rows.filter((r) => r.type !== 'hero');
  const hasContent = rows.some((r) => r.items.length || r.channels?.length);

  if (!hasContent) {
    return (
      <div className="page">
        <EmptyState
          icon="film"
          title={libraries.length ? 'Your libraries are filling up' : 'Nothing here yet'}
          message={
            libraries.length
              ? 'MediaMax is scanning your media. New movies and shows will appear here as soon as they are found.'
              : user?.isAdmin
                ? 'Add a library or an IPTV source to start building your collection.'
                : 'Ask your server admin to add some media.'
          }
          action={user?.isAdmin && (
            <div className="row-gap">
              <Link to="/admin/libraries" className="btn btn-primary"><Icon name="plus" size={16} /> Add library</Link>
              <Link to="/admin/livetv" className="btn"><Icon name="tv" size={16} /> Add IPTV</Link>
            </div>
          )}
        />
      </div>
    );
  }

  return (
    <div className={`home ${heroRow && theme.heroStyle !== 'none' && heroRow.items.length ? 'has-hero' : 'no-hero'}`}>
      {heroRow && theme.heroStyle !== 'none' && heroRow.items.length > 0 && <Hero items={heroRow.items} style={theme.heroStyle} />}
      <div className="home-rows">
        {rest.map((r) => (
          <HomeRowView key={r.id} row={r} />
        ))}
      </div>
    </div>
  );
}
