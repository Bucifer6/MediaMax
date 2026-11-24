import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { DiscoverResult, Item, MediaRequest, RequestOptions, SearchResponse } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { arrApi } from '../api/arr';
import { useApp } from '../state/app';
import { useDebounced } from '../hooks';
import { CardSkeleton, ChannelCard, PosterCard } from '../components/Cards';
import { Chip, EmptyState, Img } from '../components/ui';
import { Icon } from '../components/Icon';
import { formatTime } from '../utils/format';
import { DecideBar } from '../components/decide/DecideBar';
import { AskResults } from '../components/AskResults';
import { DiscoverCard, keyOf, RequestModal, useCardActions } from '../components/DiscoverCards';
import { aiApi } from '../api/ai';
import '../styles/screens-browse.css';

const MODE_KEY = 'mm.search.mode';
const RECENT_KEY = 'vibe.search.recent';
const RECENT_MAX = 8;
const readMode = (): 'search' | 'ask' => {
  try {
    return localStorage.getItem(MODE_KEY) === 'ask' ? 'ask' : 'search';
  } catch {
    return 'search';
  }
};
function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}
function writeRecent(list: string[]) {
  try {
    if (list.length) localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    else localStorage.removeItem(RECENT_KEY);
  } catch {
    /* private mode */
  }
}

const GROUPS: { key: string; label: string; types: string[] }[] = [
  { key: 'movies', label: 'Movies', types: ['movie'] },
  { key: 'shows', label: 'TV Shows', types: ['show'] },
  { key: 'episodes', label: 'Episodes', types: ['episode', 'season'] },
  { key: 'artists', label: 'Artists', types: ['artist'] },
  { key: 'albums', label: 'Albums', types: ['album'] },
  { key: 'songs', label: 'Songs', types: ['track'] },
  { key: 'books', label: 'Audiobooks', types: ['audiobook'] },
  { key: 'lists', label: 'Collections & playlists', types: ['collection', 'playlist'] },
  { key: 'other', label: 'Other', types: ['video', 'photo'] },
];
const KNOWN = new Set(GROUPS.flatMap((g) => g.types));
const gridFor = (types: string[]) =>
  types.includes('episode') || types.includes('video') ? 'landscape' : types.some((t) => ['artist', 'album', 'track', 'playlist', 'photo', 'audiobook'].includes(t)) ? 'square' : 'poster';

/**
 * Arrow keys inside the results: ←/→ move through the results in reading order, ↑/↓ to the nearest result above or
 * below; ↑ from the first line goes back to the search field. TV mode has its own spatial navigation.
 */
function moveFocus(e: ReactKeyboardEvent<HTMLElement>, container: HTMLElement | null, input: HTMLInputElement | null) {
  if (!container || document.documentElement.classList.contains('tv')) return;
  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const t = e.target as HTMLElement;
  if (t.closest('input, select, textarea, [role="menu"], [role="dialog"]')) return;
  const all = Array.from(container.querySelectorAll<HTMLElement>('[data-nav]')).filter((el) => el.offsetParent !== null && !(el as HTMLButtonElement).disabled);
  const from = all.findIndex((el) => el === t || el.contains(t));
  if (from < 0) return;
  let next: HTMLElement | undefined;
  if (e.key === 'ArrowRight') next = all[from + 1];
  else if (e.key === 'ArrowLeft') next = all[from - 1];
  else {
    const r = all[from]!.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const down = e.key === 'ArrowDown';
    let best = Infinity;
    for (const el of all) {
      const b = el.getBoundingClientRect();
      const dy = down ? b.top - r.bottom : r.top - b.bottom;
      if (dy < -4) continue;
      const score = dy * 4 + Math.abs(b.left + b.width / 2 - cx);
      if (score < best) {
        best = score;
        next = el;
      }
    }
    if (!next && !down) {
      e.preventDefault();
      input?.focus();
      return;
    }
  }
  if (!next) return;
  e.preventDefault();
  next.focus();
  next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

export function SearchPage() {
  const { features } = useApp();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const debounced = useDebounced(q.trim(), 250);
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [recent, setRecent] = useState<string[]>(readRecent);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  // "Ask": natural-language search (rules on the server, plus the AI model when an admin set one up).
  const [askOn, setAskOn] = useState(false);
  const [mode, setModeState] = useState<'search' | 'ask'>(() => (params.get('ask') === '1' ? 'ask' : readMode()));
  const [askQ, setAskQ] = useState(mode === 'ask' ? q.trim() : '');
  const askDebounced = useDebounced(q.trim(), 700);
  // "Not in your library": titles from Discover (TMDB / Lidarr / Readarr) that can be requested.
  const [reqOpts, setReqOpts] = useState<RequestOptions | null>(null);
  const [outside, setOutside] = useState<DiscoverResult[]>([]);
  const [target, setTarget] = useState<DiscoverResult | null>(null);

  const setMode = (m: 'search' | 'ask') => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* private mode */
    }
    if (m === 'ask') setAskQ(q.trim());
    input.current?.focus();
  };
  useEffect(() => {
    aiApi.features().then((f) => setAskOn(f.ask)).catch(() => setAskOn(false));
  }, []);
  useEffect(() => {
    if (!features.requests) return;
    arrApi.requestOptions().then(setReqOpts).catch(() => setReqOpts(null));
  }, [features.requests]);
  useEffect(() => {
    if (mode === 'ask') setAskQ(askDebounced);
  }, [askDebounced, mode]);
  const asking = askOn && mode === 'ask';

  useEffect(() => {
    input.current?.focus();
  }, []);

  const remember = (term: string) => {
    const t = term.trim();
    if (t.length < 2) return;
    setRecent((list) => {
      const next = [t, ...list.filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, RECENT_MAX);
      writeRecent(next);
      return next;
    });
  };
  const forget = (term: string | null) => {
    setRecent((list) => {
      const next = term == null ? [] : list.filter((x) => x !== term);
      writeRecent(next);
      return next;
    });
  };

  useEffect(() => {
    setParams(debounced ? { q: debounced, ...(asking ? { ask: '1' } : {}) } : asking ? { ask: '1' } : {}, { replace: true });
    setFilter('all');
    if (!debounced || asking) {
      setRes(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    api.items
      .search(debounced, 40, ctrl.signal)
      .then(setRes)
      .catch((e) => (e as Error).name !== 'AbortError' && setError((e as Error).message))
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, asking]);

  // Requestable titles that aren't in the library (only when requests are on and TMDB is set up).
  const tmdbOn = !!reqOpts && reqOpts.tmdb !== false;
  useEffect(() => {
    setOutside([]);
    if (!features.requests || !tmdbOn || !debounced || asking || debounced.length < 2) return;
    const ctrl = new AbortController();
    api.discover
      .search({ q: debounced, type: 'all', page: 1, hideAvailable: true }, ctrl.signal)
      .then((r) => setOutside(r.results.filter((x) => !x.availableItemId).slice(0, 12)))
      .catch(() => setOutside([]));
    return () => ctrl.abort();
  }, [debounced, asking, features.requests, tmdbOn]);
  const updateOutside = (r: DiscoverResult, patch: Partial<DiscoverResult>) => setOutside((list) => list.map((x) => (keyOf(x) === keyOf(r) ? { ...x, ...patch } : x)));
  const actions = useCardActions(updateOutside, setTarget);

  const items = res?.items ?? [];
  const grouped = [
    ...GROUPS.map((g) => ({ ...g, items: items.filter((i) => g.types.includes(i.type)) })),
    { key: 'more', label: 'More', types: [] as string[], items: items.filter((i) => !KNOWN.has(i.type)) },
  ].filter((g) => g.items.length);
  const channels = res?.channels ?? [];
  const programs = res?.programs ?? [];
  const total = items.length + channels.length + programs.length;
  const facets = [
    ...grouped.map((g) => ({ key: g.key, label: g.label, n: g.items.length })),
    ...(channels.length ? [{ key: 'channels', label: 'Channels', n: channels.length }] : []),
    ...(programs.length ? [{ key: 'tv', label: 'On TV', n: programs.length }] : []),
    ...(outside.length ? [{ key: 'request', label: 'Not in your library', n: outside.length }] : []),
  ];
  const show = (key: string) => filter === 'all' || filter === key;
  const requestsLink = features.requests ? `/discover?q=${encodeURIComponent(debounced)}` : null;

  return (
    <div className="page search-page">
      <h1 className="sr-only">Search</h1>
      <div className="search-field" role="search">
        <Icon name={asking ? 'sparkles' : 'search'} size={22} />
        <input
          ref={input}
          className="search-field-input"
          type="search"
          enterKeyHint="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={asking ? 'Ask: “something funny under 90 minutes we haven’t seen”…' : 'Movies, shows, music, channels…'}
          aria-label={asking ? 'Ask' : 'Search'}
          aria-controls="search-results"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQ('');
            if (e.key === 'Enter') {
              remember(q);
              if (asking) setAskQ(q.trim());
            }
            if (e.key === 'ArrowDown' && !asking) {
              const first = results.current?.querySelector<HTMLElement>('[data-nav]');
              if (first) {
                e.preventDefault();
                first.focus();
              }
            }
          }}
        />
        {q && (
          <button className="btn-icon btn-icon-sm" onClick={() => { setQ(''); input.current?.focus(); }} aria-label="Clear search">
            <Icon name="x" size={16} />
          </button>
        )}
        {askOn && (
          <div className="segmented search-mode" role="radiogroup" aria-label="Search mode">
            <button role="radio" aria-checked={!asking} className={!asking ? 'active' : ''} onClick={() => setMode('search')} data-nav>Search</button>
            <button role="radio" aria-checked={asking} className={asking ? 'active' : ''} onClick={() => setMode('ask')} data-nav><Icon name="sparkles" size={14} /> Ask</button>
          </div>
        )}
      </div>

      <div id="search-results" ref={results} onKeyDown={(e) => moveFocus(e, results.current, input.current)} onClickCapture={(e) => (e.target as HTMLElement).closest('a') && remember(debounced)}>
        {asking ? (
          <AskResults q={askQ} onPick={(e) => {
            setQ(e);
            setAskQ(e);
          }} />
        ) : !debounced ? (
          <div className="search-start">
            {recent.length > 0 && (
              <section className="search-recent" aria-labelledby="search-recent-h">
                <div className="search-section-head">
                  <h2 id="search-recent-h" className="search-section-title">Recent searches</h2>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => forget(null)}>Clear</button>
                </div>
                <ul className="search-recent-list">
                  {recent.map((t) => (
                    <li key={t}>
                      <button type="button" className="search-recent-item" data-nav onClick={() => { setQ(t); input.current?.focus(); }}>
                        <Icon name="clock" size={16} /> <span>{t}</span>
                      </button>
                      <button type="button" className="btn-icon btn-icon-sm search-recent-x" onClick={() => forget(t)} aria-label={`Remove “${t}” from recent searches`} tabIndex={-1}>
                        <Icon name="x" size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <EmptyState
              compact={recent.length > 0}
              icon="search"
              title="Find anything"
              message={<>Search every library, live channel and the TV guide. Press <kbd>/</kbd> anywhere to jump here.</>}
              action={<DecideBar />}
            />
          </div>
        ) : loading && !res ? (
          <div className="grid grid-poster" aria-busy="true">{Array.from({ length: 12 }).map((_, i) => <CardSkeleton key={i} />)}</div>
        ) : error ? (
          <EmptyState icon="alert" title="Search failed" message={error} />
        ) : total === 0 && !outside.length ? (
          <EmptyState
            icon="search"
            title={`No results for “${debounced}”`}
            message="Check the spelling or try a different term."
            action={
              <div className="row-gap">
                {askOn && debounced.split(/\s+/).length >= 3 && <button className="btn" onClick={() => setMode('ask')}><Icon name="sparkles" size={16} /> Ask instead</button>}
                {requestsLink && <Link className="btn" to={requestsLink}><Icon name="compass" size={16} /> Request it</Link>}
              </div>
            }
          />
        ) : (
          <div className={`search-results ${loading ? 'dim' : ''}`}>
            <p className="sr-only" aria-live="polite">{total} results in your library{outside.length ? `, ${outside.length} more to request` : ''}</p>
            {facets.length > 1 && (
              <div className="search-facets" role="group" aria-label="Show">
                <Chip active={filter === 'all'} onClick={() => setFilter('all')}>All</Chip>
                {facets.map((f) => (
                  <Chip key={f.key} active={filter === f.key} onClick={() => setFilter(filter === f.key ? 'all' : f.key)}>
                    {f.label} <span className="search-facet-n">{f.n}</span>
                  </Chip>
                ))}
              </div>
            )}
            {grouped.map((g) => show(g.key) && (
              <section key={g.key} className="search-group" aria-labelledby={`sg-${g.key}`}>
                <h2 className="search-section-title" id={`sg-${g.key}`}>{g.label} <span className="search-count">{g.items.length}</span></h2>
                <div className={`grid grid-${g.key === 'more' ? 'poster' : gridFor(g.types)}`}>
                  {g.items.map((it: Item) => <PosterCard key={it.id} item={it} width="100%" />)}
                </div>
              </section>
            ))}
            {channels.length > 0 && show('channels') && (
              <section className="search-group" aria-labelledby="sg-channels">
                <h2 className="search-section-title" id="sg-channels">Channels <span className="search-count">{channels.length}</span></h2>
                <div className="grid grid-landscape">
                  {channels.map((c) => <ChannelCard key={c.id} channel={c} />)}
                </div>
              </section>
            )}
            {programs.length > 0 && show('tv') && (
              <section className="search-group" aria-labelledby="sg-tv">
                <h2 className="search-section-title" id="sg-tv">On TV <span className="search-count">{programs.length}</span></h2>
                <div className="program-results">
                  {programs.map((p) => {
                    const now = Date.now();
                    const live = new Date(p.start).getTime() <= now && new Date(p.end).getTime() > now;
                    return (
                      <Link key={p.id} to={live ? `/watch/live/${p.channelId}` : `/livetv/guide?at=${encodeURIComponent(p.start)}&program=${encodeURIComponent(p.id)}`} className="program-result" data-nav>
                        <span className="program-art"><Img src={p.iconUrl} width={160} fallback={<Icon name="tv" size={20} />} /></span>
                        <span className="program-text">
                          <strong>{p.title}</strong>
                          <small>
                            {live && <span className="live-pill small"><span className="live-dot" /> LIVE</span>}{' '}
                            {new Date(p.start).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} · {formatTime(p.start)} – {formatTime(p.end)}
                            {p.subtitle ? ` · ${p.subtitle}` : ''}
                          </small>
                        </span>
                        {p.recordingId && <Icon name="record" size={14} className="text-danger" />}
                      </Link>
                    );
                  })}
                </div>
              </section>
            )}
            {outside.length > 0 && show('request') && (
              <section className="search-group search-outside" aria-labelledby="sg-request">
                <div className="search-section-head">
                  <h2 className="search-section-title" id="sg-request">Not in your library <span className="search-count">{outside.length}</span></h2>
                  {requestsLink && <Link to={requestsLink} className="see-all" data-nav>More in Discover <Icon name="chevronRight" size={16} /></Link>}
                </div>
                <p className="search-outside-sub">Request a title and it's added when it becomes available.</p>
                <div className="grid grid-poster">
                  {outside.map((r) => <div key={keyOf(r)} className="grid-cell"><DiscoverCard r={r} opts={reqOpts} actions={actions} /></div>)}
                </div>
              </section>
            )}
            {!outside.length && requestsLink && (
              <p className="search-request-hint">
                Can't find it? <Link to={requestsLink} className="link-strong">Request it in Discover</Link>
              </p>
            )}
          </div>
        )}
      </div>
      <RequestModal
        target={target}
        opts={reqOpts}
        onClose={() => setTarget(null)}
        onDone={(r: DiscoverResult, req: MediaRequest) => {
          updateOutside(r, { requestId: req.id, requestStatus: req.status });
          setTarget(null);
        }}
      />
    </div>
  );
}
