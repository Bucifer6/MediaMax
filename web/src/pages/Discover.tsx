import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { DiscoverResult, DiscoverSlider, MediaRequest } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { arrApi } from '../api/arr';
import { seerrApi } from '../api/seerr';
import { useApp } from '../state/app';
import { useAsync, useDebounced, useInfiniteSentinel } from '../hooks';
import { CardSkeleton } from '../components/Cards';
import { EmptyState, Img, PageHeader } from '../components/ui';
import { Icon } from '../components/Icon';
import { DiscoverCard, keyOf, RequestModal, requestErrorText, useCardActions } from '../components/DiscoverCards';
import { QuotaPills } from './Requests';
import { canManageRequests } from '../utils/requests';
import '../styles/arr.css';
import '../styles/requests.css';
import '../styles/screens-browse.css';

type MediaFilter = 'all' | 'movie' | 'show' | 'music' | 'books' | 'people';
const TAB_LABEL: Record<MediaFilter, string> = { all: 'All', movie: 'Movies', show: 'Shows', music: 'Music', books: 'Books', people: 'People' };
const PLACEHOLDER: Record<MediaFilter, string> = {
  all: 'Search for movies and shows to request…', movie: 'Search for movies to request…', show: 'Search for shows to request…',
  music: 'Search for artists and albums…', books: 'Search for books and authors…', people: 'Search for actors, directors…',
};
const isArrTab = (t: MediaFilter): t is 'music' | 'books' => t === 'music' || t === 'books';
const HIDE_KEY = 'mm.discover.hideAvailable';
const readHide = () => {
  try {
    return localStorage.getItem(HIDE_KEY) === '1';
  } catch {
    return false;
  }
};

function Slider({ s, render }: { s: DiscoverSlider; render: (r: DiscoverResult) => ReactNode }) {
  const more = !['watchlist', 'recently-added', 'recently-requested'].includes(s.key);
  return (
    <section className="disc-slider">
      <header>
        <h2>{s.title}</h2>
        {more && <Link to={`/discover?list=${encodeURIComponent(s.key)}`} className="btn btn-sm btn-ghost">See all <Icon name="chevronRight" size={14} /></Link>}
      </header>
      <div className="disc-track">{s.results.map((r) => <div key={keyOf(r)}>{render(r)}</div>)}</div>
    </section>
  );
}

export default function DiscoverPage() {
  const { user, features } = useApp();
  const [params, setParams] = useSearchParams();
  const listKey = params.get('list');
  const [q, setQ] = useState(() => params.get('q') ?? '');
  const [type, setType] = useState<MediaFilter>('all');
  const [hideAvailable, setHideAvailable] = useState(readHide);
  const debounced = useDebounced(q.trim(), 350);
  const [results, setResults] = useState<DiscoverResult[]>([]);
  const [listTitle, setListTitle] = useState('');
  const [page, setPage] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<DiscoverResult | null>(null);
  const reqId = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const manager = canManageRequests(user);

  // What this server can request (TMDB, Lidarr, Readarr, 4K) and what this user may request; admins also see whether requests are on.
  const setup = useAsync(async () => {
    const opts = await arrApi.requestOptions().catch(() => null);
    if (!user?.isAdmin) return { ok: true, reason: '', opts };
    const s = await api.admin.settings();
    if (!s.requests?.enabled) return { ok: false, reason: 'off', opts };
    if (!s.tmdbApiKey && !opts?.music && !opts?.books) return { ok: false, reason: 'tmdb', opts };
    return { ok: true, reason: '', opts };
  }, [user?.isAdmin]);
  const opts = setup.data?.opts ?? null;
  const tmdbOn = opts?.tmdb !== false;
  const tabs: MediaFilter[] = [...(tmdbOn ? (['all', 'movie', 'show'] as const) : []), ...(opts?.music ? (['music'] as const) : []), ...(opts?.books ? (['books'] as const) : []), ...(tmdbOn ? (['people'] as const) : [])];
  const ready = features.requests && !!setup.data?.ok && tabs.includes(type);
  const home = ready && type === 'all' && !debounced && !listKey;

  useEffect(() => {
    if (setup.data && tabs.length && !tabs.includes(type)) setType(tabs[0]);
  }, [setup.data, tabs, type]);
  useEffect(() => {
    try {
      localStorage.setItem(HIDE_KEY, hideAvailable ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [hideAvailable]);

  const sliders = useAsync(() => (home && tmdbOn ? seerrApi.sliders(hideAvailable) : Promise.resolve([] as DiscoverSlider[])), [home, tmdbOn, hideAvailable]);
  const genres = useAsync(() => (home && tmdbOn ? seerrApi.genres().catch(() => null) : Promise.resolve(null)), [home, tmdbOn]);
  const people = useAsync(() => (ready && type === 'people' && debounced ? seerrApi.people(debounced) : Promise.resolve([])), [ready, type, debounced]);

  const load = useCallback(async (p: number, query: string, t: MediaFilter, list: string | null, hide: boolean) => {
    const id = ++reqId.current;
    setLoading(true);
    if (p === 1) setError(null);
    try {
      const r = list
        ? await seerrApi.list(list, p, hide)
        : isArrTab(t)
          ? query ? await arrApi.discover(t, query) : { results: [], page: 1, totalPages: 1 }
          : await api.discover.search({ q: query || undefined, type: t as 'all' | 'movie' | 'show', page: p, ...(hide ? { hideAvailable: true } : {}) });
      if (id !== reqId.current) return;
      if (list && 'title' in r) setListTitle((r as { title: string }).title);
      setResults((prev) => {
        const base = p === 1 ? [] : prev;
        const seen = new Set(base.map(keyOf));
        return [...base, ...r.results.filter((x) => !seen.has(keyOf(x)))];
      });
      setPage(r.page || p);
      setTotalPages(r.totalPages || 1);
    } catch (e) {
      if (id === reqId.current) setError(requestErrorText(e));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  const gridMode = ready && !home && type !== 'people';
  useEffect(() => {
    if (!gridMode) return;
    setResults([]);
    setPage(0);
    setTotalPages(1);
    void load(1, debounced, type, listKey, hideAvailable);
  }, [debounced, type, gridMode, load, listKey, hideAvailable]);

  const hasMore = gridMode && !error && page > 0 && page < totalPages && page < 50;
  const sentinel = useInfiniteSentinel(() => {
    if (!loading && hasMore) void load(page + 1, debounced, type, listKey, hideAvailable);
  }, hasMore && !loading);

  const update = (r: DiscoverResult, patch: Partial<DiscoverResult>) => {
    setResults((list) => list.map((x) => (keyOf(x) === keyOf(r) ? { ...x, ...patch } : x)));
    sliders.setData((ss) => (ss ?? []).map((s) => ({ ...s, results: s.results.map((x) => (keyOf(x) === keyOf(r) ? { ...x, ...patch } : x)) })));
  };
  const actions = useCardActions(update, setTarget);
  const onDone = (r: DiscoverResult, req: MediaRequest) => {
    update(r, { requestId: req.id, requestStatus: req.status });
    setTarget(null);
  };
  const card = (r: DiscoverResult) => <DiscoverCard r={r} opts={opts} actions={actions} />;

  let blocked: ReactNode = null;
  if (!features.requests || setup.data?.reason === 'off') {
    blocked = <EmptyState icon="compass" title="Requests are turned off" message={user?.isAdmin ? <>Turn them on in <Link className="link-strong" to="/admin/settings?tab=requests">Admin → Server settings → Requests</Link>.</> : 'Ask your server admin to enable requests.'} />;
  } else if (setup.data?.reason === 'tmdb') {
    blocked = <EmptyState icon="alert" title="TMDB isn't configured" message={<>Discover uses TMDB to find movies and shows. Add a TMDB API key in <Link className="link-strong" to="/admin/settings">Admin → Server settings → General</Link>, or connect Lidarr/Readarr for music and books.</>} />;
  } else if (setup.error) {
    blocked = <EmptyState icon="alert" title="Couldn't check request settings" message={setup.error} />;
  } else if (opts?.permissions && !opts.movies && !opts.shows && !opts.music && !opts.books) {
    blocked = <EmptyState icon="lock" title="You can't request titles" message="Ask your server admin for request permissions." />;
  }

  const heading = listKey ? listTitle || 'Discover' : debounced ? <>Results for “{debounced}”</> : isArrTab(type) || type === 'people' ? null : 'Trending this week';
  const setTypeTab = (t: MediaFilter) => {
    setType(t);
    if (listKey) setParams({}, { replace: true });
  };

  return (
    <div className="page discover-page">
      <PageHeader
        title="Discover"
        subtitle="Find something new and request it for the library"
        actions={<Link to="/requests" className="btn"><Icon name="inbox" size={16} /> {manager ? 'Requests' : 'My requests'}</Link>}
      />

      {blocked ?? (
        <>
          {!manager && <QuotaPills quotas={opts?.quotas} />}
          <div className="discover-controls">
            <div className="search-field discover-search" role="search">
              <Icon name="search" size={20} />
              <input
                ref={input}
                type="search"
                className="search-field-input"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  if (listKey) setParams({}, { replace: true });
                }}
                placeholder={PLACEHOLDER[type]}
                aria-label="Search titles to request"
                onKeyDown={(e) => e.key === 'Escape' && setQ('')}
              />
              {q && (
                <button className="btn-icon btn-icon-sm" onClick={() => { setQ(''); input.current?.focus(); }} aria-label="Clear search">
                  <Icon name="x" size={16} />
                </button>
              )}
            </div>
            {tabs.length > 1 && (
              <div className="segmented" role="radiogroup" aria-label="Media type">
                {tabs.map((t) => (
                  <button key={t} role="radio" aria-checked={type === t && !listKey} className={type === t && !listKey ? 'active' : ''} onClick={() => setTypeTab(t)}>{TAB_LABEL[t]}</button>
                ))}
              </div>
            )}
            {!isArrTab(type) && type !== 'people' && (
              <label className="check-inline"><input type="checkbox" checked={hideAvailable} onChange={(e) => setHideAvailable(e.target.checked)} /> Hide what's in the library</label>
            )}
          </div>

          {listKey && <p style={{ marginTop: -12 }}><button className="btn btn-sm btn-ghost" onClick={() => setParams({})}><Icon name="arrowLeft" size={14} /> Back to Discover</button></p>}
          {heading && !home && <h2 className="section-title">{heading}</h2>}

          {setup.loading && !setup.data ? (
            <div className="grid grid-poster">{Array.from({ length: 12 }).map((_, i) => <CardSkeleton key={i} />)}</div>
          ) : home ? (
            <>
              {sliders.loading && !sliders.data ? (
                <div className="disc-track">{Array.from({ length: 8 }).map((_, i) => <CardSkeleton key={i} />)}</div>
              ) : sliders.error ? (
                <EmptyState icon="alert" title="Discover isn't available" message={sliders.error} action={<button className="btn" onClick={sliders.reload}><Icon name="refresh" size={16} /> Try again</button>} />
              ) : (
                (sliders.data ?? []).map((s) => <Slider key={s.key} s={s} render={card} />)
              )}
              {genres.data && (
                <>
                  <h2 className="section-title">Movie genres</h2>
                  <div className="disc-genres">{genres.data.movie.map((g) => <Link key={g.id} className="chip" to={`/discover?list=movie-genre-${g.id}`}>{g.name}</Link>)}</div>
                  <h2 className="section-title">Show genres</h2>
                  <div className="disc-genres">{genres.data.show.map((g) => <Link key={g.id} className="chip" to={`/discover?list=show-genre-${g.id}`}>{g.name}</Link>)}</div>
                </>
              )}
            </>
          ) : type === 'people' ? (
            !debounced ? <EmptyState icon="users" title="Find people" message="Search for an actor or director to see their films and shows, and request them." />
              : people.loading && !people.data ? <div className="grid grid-poster">{Array.from({ length: 6 }).map((_, i) => <CardSkeleton key={i} />)}</div>
                : !(people.data ?? []).length ? <EmptyState icon="search" title={`Nobody found for "${debounced}"`} />
                  : (
                    <div className="grid grid-poster">
                      {(people.data ?? []).map((p) => (
                        <Link key={p.id} to={`/discover/person/${p.id}`} className="card card-poster" style={{ width: '100%' }}>
                          <div className="card-art"><Img src={p.profileUrl} width={260} alt={p.name} fallback={<div className="card-fallback"><Icon name="user" size={28} /><span>{p.name}</span></div>} /></div>
                          <div className="card-meta"><div className="card-title">{p.name}</div><div className="card-sub">{p.knownFor ?? ' '}</div></div>
                        </Link>
                      ))}
                    </div>
                  )
          ) : isArrTab(type) && !debounced ? (
            <EmptyState icon={type === 'music' ? 'music' : 'book'} title={type === 'music' ? 'Find music to request' : 'Find books to request'} message={type === 'music' ? 'Search for an artist or album. Requests go to Lidarr.' : 'Search for a book or author. Requests go to Readarr.'} />
          ) : error && !results.length ? (
            <EmptyState icon="alert" title="Discover isn't available" message={error} action={<button className="btn" onClick={() => void load(1, debounced, type, listKey, hideAvailable)}><Icon name="refresh" size={16} /> Try again</button>} />
          ) : !loading && page > 0 && !results.length ? (
            <EmptyState icon="search" title={debounced ? `Nothing found for "${debounced}"` : 'Nothing here right now'} message={isArrTab(type) ? 'Try a different spelling.' : 'Try a different title or switch between movies and shows.'} />
          ) : (
            <>
              <div className="grid grid-poster discover-grid">
                {results.map((r) => <div key={keyOf(r)} style={{ minWidth: 0 }}>{card(r)}</div>)}
                {loading && Array.from({ length: results.length ? 6 : 12 }).map((_, i) => <CardSkeleton key={`s${i}`} />)}
              </div>
              {error && results.length > 0 && <p className="form-error" style={{ marginTop: 16 }}>{error}</p>}
              <div ref={sentinel} className="sentinel" />
            </>
          )}
        </>
      )}
      <RequestModal target={target} opts={opts} onClose={() => setTarget(null)} onDone={onDone} />
    </div>
  );
}
