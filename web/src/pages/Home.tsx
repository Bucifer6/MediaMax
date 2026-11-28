import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { HomeResponse, HomeRow, ItemSort } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { isTvMode } from '../player/NowPlaying';
import { usePreviewsEnabled } from '../components/Preview';
import { useAsync, useServerEvent } from '../hooks';
import { Hero, HeroSkeleton } from '../components/Hero';
import { Row } from '../components/Row';
import { CardSkeleton, ChannelCard, LandscapeCard, PosterCard, RankedCard, UpcomingCard } from '../components/Cards';
import { Button, EmptyState, ErrorState } from '../components/ui';
import { Icon } from '../components/Icon';
import { DecideLinks } from '../components/decide/DecideBar';
import { CustomizeHome } from '../components/CustomizeHome';
import '../styles/screens-browse.css';
import { prefetchCommonPagesWhenIdle } from '../utils/prefetch';
import { orderHomeRows } from '../utils/homeRows';
import { placeYourDj } from '../player/yourDj';
import { YOUR_DJ_ROW_ID, YourDjCard, useYourDjAvailable } from '../components/YourDjCard';

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
  const { user, system } = useApp();
  const ratingPosters = !!system?.ratingPosterScreens?.home;
  // TV focus trailers (Settings → Playback → TV); memoised so the memo'd cards don't all re-render.
  const previews = usePreviewsEnabled();
  const wantTrailers = isTvMode() && !!user?.preferences.focusTrailers && previews;
  const trailerSound = !!user?.preferences.trailerSound;
  const focusTrailer = useMemo(() => (wantTrailers ? { sound: trailerSound } : null), [wantTrailers, trailerSound]);
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
  // Spoiler blur (Settings → Playback): episode stills in Continue watching / Next up.
  const spoiler = (row.type === 'continue' || row.type === 'nextup') && !!user?.preferences.blurNextUp;
  return (
    <Row title={row.title} link={rowLink(row)} id={row.id} className={`${wide ? 'row-wide' : ''} home-row-${row.type} ${spoiler ? 'row-spoiler' : ''}`}>
      {row.items.map((it) => (wide ? <LandscapeCard key={it.id} item={it} /> : <PosterCard key={it.id} item={it} ratingPoster={ratingPosters} focusTrailer={focusTrailer} />))}
    </Row>
  );
}

/**
 * The last Home response (per signed-in profile). Coming back to Home shows it straight away while the fresh copy
 * loads (stale-while-revalidate), instead of a skeleton on every Back.
 */
let lastHome: { userId: string; data: HomeResponse } | null = null;

export function Home() {
  const { theme, user, libraries } = useApp();
  const userId = user?.id ?? '';
  const [customizing, setCustomizing] = useState(false);
  const customOrder = (user?.preferences?.homeLayout?.order?.length ?? 0) > 0;
  const home = useAsync(() => api.items.home().then((d) => {
    // Keep the featured titles the viewer is already looking at (the server picks new random ones each time), so the
    // hero doesn't swap under them when the fresh copy arrives.
    const shownHero = lastHome?.userId === userId ? lastHome.data.rows.find((r) => r.type === 'hero') : undefined;
    const data = shownHero && d.rows.some((r) => r.type === 'hero') ? { ...d, rows: d.rows.map((r) => (r.type === 'hero' ? shownHero : r)) } : d;
    lastHome = { userId, data };
    return data;
  }), []);
  const homeData = home.data ?? (lastHome?.userId === userId ? lastHome.data : undefined);
  // The likely next pages (title, library, search) load once Home is on screen and the browser is idle.
  const shown = !!homeData;
  useEffect(() => {
    if (shown) prefetchCommonPagesWhenIdle();
  }, [shown]);
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

  const djAvailable = useYourDjAvailable();
  const orderedRows = useMemo(() => orderHomeRows((homeData?.rows ?? []).filter((r) => r.type !== 'hero'), customOrder), [homeData, customOrder]);

  if (home.loading && !homeData) {
    return (
      <div className="home home-loading" aria-busy="true">
        {theme.heroStyle !== 'none' && <HeroSkeleton />}
        <div className="home-rows">
          <div className="home-head"><div className="skeleton skeleton-line" style={{ width: 120, height: 28 }} /></div>
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
  if (home.error && !homeData) return <div className="page"><ErrorState message={home.error} onRetry={home.reload} /></div>;

  const rows = homeData?.rows ?? [];
  const heroRow = rows.find((r) => r.type === 'hero');
  const rest = orderedRows;
  const layout = user?.preferences?.homeLayout;
  // Your DJ is a client row: Customize Home can hide and move it like the server's rows.
  const djAt = djAvailable ? placeYourDj(rest, layout?.order ?? [], layout?.hidden ?? []) : -1;
  const hasContent = rows.some((r) => r.items.length || r.channels?.length);

  if (!hasContent) {
    return (
      <div className="page">
        <EmptyState
          icon="film"
          title={libraries.length ? 'Your libraries are filling up' : 'Nothing here yet'}
          message={
            libraries.length
              ? 'Vibe is scanning your media. New movies and shows will appear here as soon as they are found.'
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

  const showHero = !!heroRow && theme.heroStyle !== 'none' && heroRow.items.length > 0;
  // Customize Home lists every row the server sent (empty ones too: they fill up later), hero first.
  const arrangeable = [...(heroRow ? [heroRow] : []), ...rest].map((r) => ({ id: r.id, title: r.title }));
  if (djAt >= 0) arrangeable.splice(djAt + (heroRow ? 1 : 0), 0, { id: YOUR_DJ_ROW_ID, title: 'Your DJ' });

  return (
    <div className={`home ${showHero ? 'has-hero' : 'no-hero'}`}>
      {showHero && <Hero items={heroRow!.items} style={theme.heroStyle} collapsible />}
      <div className="home-rows">
        <header className="home-head">
          <h1 className={`home-title ${showHero ? 'sr-only' : ''}`}>Home</h1>
          <div className="home-tools" role="group" aria-label="Home tools">
            <DecideLinks />
            <span className="home-tools-sep" aria-hidden />
            <Button variant="ghost" size="sm" icon="edit" className="home-customize" aria-label="Customize Home" title="Customize Home" onClick={() => setCustomizing(true)} data-nav>
              <span className="home-tool-label">Customize</span>
            </Button>
          </div>
        </header>
        {rest.map((r, i) => (
          <Fragment key={r.id}>
            {i === djAt && <YourDjCard />}
            <HomeRowView row={r} />
          </Fragment>
        ))}
        {djAt >= rest.length && <YourDjCard />}
      </div>
      <CustomizeHome open={customizing} onClose={() => setCustomizing(false)} rows={arrangeable} onSaved={home.reload} />
    </div>
  );
}
