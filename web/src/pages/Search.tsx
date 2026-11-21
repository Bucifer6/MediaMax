import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Item, SearchResponse } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useDebounced } from '../hooks';
import { CardSkeleton, ChannelCard, PosterCard } from '../components/Cards';
import { EmptyState, Img } from '../components/ui';
import { Icon } from '../components/Icon';
import { formatTime } from '../utils/format';
import { DecideBar } from '../components/decide/DecideBar';
import { AskResults } from '../components/AskResults';
import { aiApi } from '../api/ai';

const MODE_KEY = 'mm.search.mode';
const readMode = (): 'search' | 'ask' => {
  try {
    return localStorage.getItem(MODE_KEY) === 'ask' ? 'ask' : 'search';
  } catch {
    return 'search';
  }
};

const GROUPS: { label: string; types: string[] }[] = [
  { label: 'Movies', types: ['movie'] },
  { label: 'TV Shows', types: ['show'] },
  { label: 'Episodes', types: ['episode', 'season'] },
  { label: 'Artists', types: ['artist'] },
  { label: 'Albums', types: ['album'] },
  { label: 'Songs', types: ['track'] },
  { label: 'Collections & playlists', types: ['collection', 'playlist'] },
  { label: 'Other', types: ['video', 'photo'] },
];

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const debounced = useDebounced(q.trim(), 250);
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // "Ask": natural-language search (rules on the server, plus the AI model when an admin set one up).
  const [askOn, setAskOn] = useState(false);
  const [mode, setModeState] = useState<'search' | 'ask'>(() => (params.get('ask') === '1' ? 'ask' : readMode()));
  const [askQ, setAskQ] = useState(mode === 'ask' ? q.trim() : '');
  const askDebounced = useDebounced(q.trim(), 700);
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
    if (mode === 'ask') setAskQ(askDebounced);
  }, [askDebounced, mode]);
  const asking = askOn && mode === 'ask';

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    setParams(debounced ? { q: debounced, ...(asking ? { ask: '1' } : {}) } : asking ? { ask: '1' } : {}, { replace: true });
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

  const total = res ? res.items.length + res.channels.length + res.programs.length : 0;
  const grouped = GROUPS.map((g) => ({ ...g, items: (res?.items ?? []).filter((i) => g.types.includes(i.type)) })).filter((g) => g.items.length);

  return (
    <div className="page search-page">
      <h1 className="sr-only">Search</h1>
      <div className="search-box">
        <Icon name="search" size={24} />
        <input
          ref={input}
          className="search-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={asking ? 'Ask: “something funny under 90 minutes we haven’t seen”…' : 'Search movies, shows, music, channels and programmes…'}
          aria-label={asking ? 'Ask' : 'Search'}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQ('');
            if (e.key === 'Enter' && asking) setAskQ(q.trim());
          }}
        />
        {q && (
          <button className="btn-icon" onClick={() => { setQ(''); input.current?.focus(); }} aria-label="Clear">
            <Icon name="x" />
          </button>
        )}
        {askOn && (
          <div className="search-mode" role="radiogroup" aria-label="Search mode">
            <button role="radio" aria-checked={!asking} className={`search-mode-btn ${!asking ? 'active' : ''}`} onClick={() => setMode('search')} data-nav>Search</button>
            <button role="radio" aria-checked={asking} className={`search-mode-btn ${asking ? 'active' : ''}`} onClick={() => setMode('ask')} data-nav><Icon name="sparkles" size={14} /> Ask</button>
          </div>
        )}
      </div>

      {asking ? (
        <AskResults q={askQ} onPick={(e) => {
          setQ(e);
          setAskQ(e);
        }} />
      ) : !debounced ? (
        <EmptyState icon="search" title="Find anything" message={<>Search across every library, live channel and the TV guide. Press <kbd>/</kbd> anywhere to jump here.</>} action={<DecideBar />} />
      ) : loading && !res ? (
        <div className="grid grid-poster">{Array.from({ length: 12 }).map((_, i) => <CardSkeleton key={i} />)}</div>
      ) : error ? (
        <EmptyState icon="alert" title="Search failed" message={error} />
      ) : total === 0 ? (
        <EmptyState icon="search" title={`No results for "${debounced}"`} message="Check the spelling or try a different term."
          action={askOn && debounced.split(/\s+/).length >= 3 ? <button className="btn" onClick={() => setMode('ask')}><Icon name="sparkles" size={16} /> Ask instead</button> : undefined} />
      ) : (
        <div className={`search-results ${loading ? 'dim' : ''}`}>
          {grouped.map((g) => (
            <section key={g.label} className="search-group">
              <h2 className="section-title">{g.label} <span className="muted">{g.items.length}</span></h2>
              <div className={`grid grid-${g.types.includes('episode') || g.types.includes('video') ? 'landscape' : g.types.some((t) => ['artist', 'album', 'track', 'playlist', 'photo'].includes(t)) ? 'square' : 'poster'}`}>
                {g.items.map((it: Item) => <PosterCard key={it.id} item={it} width="100%" />)}
              </div>
            </section>
          ))}
          {res!.channels.length > 0 && (
            <section className="search-group">
              <h2 className="section-title">Channels <span className="muted">{res!.channels.length}</span></h2>
              <div className="grid grid-landscape">
                {res!.channels.map((c) => <ChannelCard key={c.id} channel={c} />)}
              </div>
            </section>
          )}
          {res!.programs.length > 0 && (
            <section className="search-group">
              <h2 className="section-title">On TV <span className="muted">{res!.programs.length}</span></h2>
              <div className="program-results">
                {res!.programs.map((p) => {
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
        </div>
      )}
    </div>
  );
}
