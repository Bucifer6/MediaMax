import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { DiscoverResult, MediaRequest, RequestMediaType, RequestOptions, SeasonMode } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { arrApi } from '../api/arr';
import { ApiRequestError, errorMessage } from '../api/client';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useAsync, useDebounced, useInfiniteSentinel } from '../hooks';
import { CardSkeleton } from '../components/Cards';
import { Badge, EmptyState, Field, Img, Modal, Spinner } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';
import { notifyRequestsChanged, parseSeasons } from '../utils/requests';
import '../styles/arr.css';

type MediaFilter = 'all' | 'movie' | 'show' | 'music' | 'books';
const TAB_LABEL: Record<MediaFilter, string> = { all: 'All', movie: 'Movies', show: 'Shows', music: 'Music', books: 'Books' };
const TYPE_LABEL: Record<RequestMediaType, string> = { movie: 'Movie', show: 'TV', artist: 'Artist', album: 'Album', book: 'Book' };
const TYPE_ICON: Record<RequestMediaType, IconName> = { movie: 'film', show: 'shows', artist: 'music', album: 'music', book: 'book' };
const PLACEHOLDER: Record<MediaFilter, string> = {
  all: 'Search for movies and shows to request…', movie: 'Search for movies to request…', show: 'Search for shows to request…',
  music: 'Search for artists and albums…', books: 'Search for books and authors…',
};
const isArrTab = (t: MediaFilter): t is 'music' | 'books' => t === 'music' || t === 'books';

/** Friendly text for the errors POST /requests can return. */
function requestErrorText(e: unknown): string {
  if (e instanceof ApiRequestError) {
    if (e.status === 429) return `Weekly limit reached. ${e.message}`;
    if (e.status === 409) return `Already requested or available. ${e.message}`;
    if (e.status === 400 && /tmdb/i.test(e.message)) return `TMDB isn't configured on this server. ${e.message}`;
    if (e.status === 403) return e.message || 'Requests are turned off on this server.';
  }
  return errorMessage(e);
}

const keyOf = (r: DiscoverResult) => `${r.mediaType}:${r.externalId ?? r.tmdbId}`;

function DiscoverCard({ r, onRequest }: { r: DiscoverResult; onRequest: (r: DiscoverResult) => void }) {
  const status = r.requestStatus && r.requestStatus !== 'declined' ? r.requestStatus : null;
  const square = r.mediaType === 'artist' || r.mediaType === 'album';
  const art = (
    <div className="card-art" style={square ? { aspectRatio: '1 / 1' } : undefined}>
      <Img src={r.posterUrl} width={260} alt={r.title} fallback={<div className="card-fallback"><Icon name={TYPE_ICON[r.mediaType]} size={28} /><span>{r.title}</span></div>} />
      <span className="discover-type">{TYPE_LABEL[r.mediaType]}</span>
      {r.availableItemId ? (
        <span className="discover-badge"><Badge tone="success"><Icon name="check" size={12} /> In library</Badge></span>
      ) : status ? (
        <span className="discover-badge"><Badge tone={status === 'pending' ? 'warning' : 'primary'}>{status === 'pending' ? 'Pending' : 'Requested'}</Badge></span>
      ) : null}
    </div>
  );
  const sub = [r.subtitle, r.year, r.rating ? `★ ${r.rating.toFixed(1)}` : null].filter(Boolean).join(' · ');
  return (
    <div className="card card-poster discover-card" style={{ width: '100%' }}>
      {r.availableItemId ? (
        <Link to={`/item/${r.availableItemId}`} className="discover-art-link" data-nav title={`${r.title} — in your library`}>{art}</Link>
      ) : (
        <button type="button" className="discover-art-link" onClick={() => onRequest(r)} data-nav title={status ? r.title : `Request ${r.title}`} disabled={!!status}>
          {art}
        </button>
      )}
      <div className="card-meta">
        <div className="card-title" title={r.title}>{r.title}</div>
        <div className="card-sub" title={sub}>{sub || ' '}</div>
      </div>
      {r.availableItemId ? (
        <Link to={`/item/${r.availableItemId}`} className="btn btn-sm discover-action"><Icon name="play" size={14} /> View</Link>
      ) : status ? (
        <span className="btn btn-sm discover-action" aria-disabled="true"><Icon name="clock" size={14} /> {status === 'pending' ? 'Pending' : 'Requested'}</span>
      ) : (
        <button className="btn btn-sm btn-primary discover-action" onClick={() => onRequest(r)}><Icon name="plus" size={14} /> Request</button>
      )}
    </div>
  );
}

const SEASON_MODES: { value: SeasonMode; label: string }[] = [
  { value: 'all', label: 'All seasons' }, { value: 'first', label: 'First season' }, { value: 'latest', label: 'Latest season' }, { value: 'specific', label: 'Specific seasons' },
];

function RequestModal({ target, opts, onClose, onDone }: { target: DiscoverResult | null; opts: RequestOptions | null; onClose: () => void; onDone: (r: DiscoverResult, req: MediaRequest) => void }) {
  const toast = useToast();
  const [seasonMode, setSeasonMode] = useState<SeasonMode>('all');
  const [seasonText, setSeasonText] = useState('');
  const [monitor, setMonitor] = useState<'all' | 'future'>('all');
  const [also4k, setAlso4k] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSeasonMode('all');
    setSeasonText('');
    setMonitor('all');
    setAlso4k(false);
    setNote('');
    setError(null);
  }, [target]);
  if (!target) return null;
  const type = target.mediaType;
  const isShow = type === 'show';
  const seasons = isShow && seasonMode === 'specific' ? parseSeasons(seasonText) : [];
  const seasonsInvalid = isShow && seasonMode === 'specific' && (!seasons || seasons.length === 0);
  const can4k = (type === 'movie' && opts?.can4k.movie) || (type === 'show' && opts?.can4k.show);

  const submit = async () => {
    if (seasonsInvalid) return;
    setBusy(true);
    setError(null);
    try {
      const req = await api.requests.create({
        tmdbId: target.tmdbId, externalId: target.externalId ?? target.tmdbId, mediaType: type, title: target.title,
        ...(isShow ? { seasonMode, seasons: seasons ?? [] } : {}),
        ...(type === 'artist' ? { monitor } : {}),
        ...(can4k && also4k ? { also4k: true } : {}),
        note: note.trim() || undefined,
      });
      toast.success(req.status === 'pending' ? `Requested ${target.title}` : `${target.title} approved${req.status === 'processing' ? ' and sent for download' : ''}`);
      notifyRequestsChanged();
      onDone(target, req);
    } catch (e) {
      setError(requestErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={`Request ${TYPE_LABEL[type] === 'TV' ? 'show' : TYPE_LABEL[type].toLowerCase()}`}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy || seasonsInvalid}>
            {busy ? <Spinner size={16} /> : <Icon name="plus" size={16} />} Request
          </button>
        </>
      }
    >
      <div className="request-modal">
        <div className="request-modal-poster"><Img src={target.posterUrl} width={200} alt="" fallback={<Icon name={TYPE_ICON[type]} size={28} />} /></div>
        <div className="form-grid">
          <div>
            <h3 className="request-modal-title">{target.title} {target.year && <span className="muted">({target.year})</span>}</h3>
            {target.subtitle && <p className="muted" style={{ margin: '2px 0 0' }}>{type === 'book' ? 'by ' : ''}{target.subtitle}</p>}
            {target.overview && <p className="muted request-modal-overview">{target.overview}</p>}
          </div>
          {isShow && (
            <fieldset className="request-seasons">
              <legend className="field-label">Seasons</legend>
              <div className="segmented" role="radiogroup" aria-label="Seasons">
                {SEASON_MODES.map((m) => (
                  <button key={m.value} type="button" role="radio" aria-checked={seasonMode === m.value} className={seasonMode === m.value ? 'active' : ''} onClick={() => setSeasonMode(m.value)}>{m.label}</button>
                ))}
              </div>
              {seasonMode === 'specific' && (
                <Field label="Season numbers" hint="Comma separated; ranges work too (e.g. 1, 3-5).">
                  <input className="input" value={seasonText} onChange={(e) => setSeasonText(e.target.value)} placeholder="1, 2" inputMode="numeric" autoFocus />
                </Field>
              )}
              {seasonMode === 'specific' && seasonText.trim() !== '' && seasonsInvalid && <p className="form-error">Enter season numbers like “1, 2” or “1-3”.</p>}
            </fieldset>
          )}
          {type === 'artist' && (
            <fieldset className="request-seasons">
              <legend className="field-label">Albums</legend>
              <div className="segmented" role="radiogroup" aria-label="Albums to monitor">
                <button type="button" role="radio" aria-checked={monitor === 'all'} className={monitor === 'all' ? 'active' : ''} onClick={() => setMonitor('all')}>All albums</button>
                <button type="button" role="radio" aria-checked={monitor === 'future'} className={monitor === 'future' ? 'active' : ''} onClick={() => setMonitor('future')}>Future albums only</button>
              </div>
            </fieldset>
          )}
          {can4k && (
            <label className="check-inline request-4k">
              <input type="checkbox" checked={also4k} onChange={(e) => setAlso4k(e.target.checked)} /> Also request in 4K
            </label>
          )}
          <Field label="Note" hint="Optional, for the admins.">
            <textarea className="textarea" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. the 2019 version, please" />
          </Field>
          {error && (
            <div className="callout-warning" role="alert">
              <Icon name="alert" size={18} />
              <p>{error}</p>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default function DiscoverPage() {
  const { user, features } = useApp();
  const [q, setQ] = useState('');
  const [type, setType] = useState<MediaFilter>('all');
  const debounced = useDebounced(q.trim(), 350);
  const [results, setResults] = useState<DiscoverResult[]>([]);
  const [page, setPage] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<DiscoverResult | null>(null);
  const reqId = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  // What this server can request (TMDB, Lidarr, Readarr, 4K); admins also see whether requests are switched on.
  const setup = useAsync(async () => {
    const opts = await arrApi.requestOptions().catch(() => null);
    if (!user?.isAdmin) return { ok: true, reason: '', opts };
    const s = await api.admin.settings();
    if (!s.requests?.enabled) return { ok: false, reason: 'off', opts };
    if (!s.tmdbApiKey && !opts?.music && !opts?.books) return { ok: false, reason: 'tmdb', opts };
    return { ok: true, reason: '', opts };
  }, [user?.isAdmin]);
  const opts = setup.data?.opts ?? null;
  const tabs: MediaFilter[] = [...(opts?.tmdb !== false ? (['all', 'movie', 'show'] as const) : []), ...(opts?.music ? (['music'] as const) : []), ...(opts?.books ? (['books'] as const) : [])];
  const ready = features.requests && !!setup.data?.ok && tabs.includes(type);

  // Land on a tab that exists (e.g. Music when there is no TMDB key).
  useEffect(() => {
    if (setup.data && tabs.length && !tabs.includes(type)) setType(tabs[0]);
  }, [setup.data, tabs, type]);

  const load = useCallback(async (p: number, query: string, t: MediaFilter) => {
    const id = ++reqId.current;
    setLoading(true);
    if (p === 1) setError(null);
    try {
      const r = isArrTab(t)
        ? query ? await arrApi.discover(t, query) : { results: [], page: 1, totalPages: 1 }
        : await api.discover.search({ q: query || undefined, type: t, page: p });
      if (id !== reqId.current) return;
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

  useEffect(() => {
    if (!ready) return;
    setResults([]);
    setPage(0);
    setTotalPages(1);
    void load(1, debounced, type);
  }, [debounced, type, ready, load]);

  const hasMore = ready && !error && page > 0 && page < totalPages && page < 50;
  const sentinel = useInfiniteSentinel(() => {
    if (!loading && hasMore) void load(page + 1, debounced, type);
  }, hasMore && !loading);

  const onDone = (r: DiscoverResult, req: MediaRequest) => {
    setResults((list) => list.map((x) => (keyOf(x) === keyOf(r) ? { ...x, requestId: req.id, requestStatus: req.status } : x)));
    setTarget(null);
  };

  let blocked: ReactNode = null;
  if (!features.requests || setup.data?.reason === 'off') {
    blocked = <EmptyState icon="compass" title="Requests are turned off" message={user?.isAdmin ? <>Turn them on in <Link className="link-strong" to="/admin/settings?tab=requests">Admin → Server settings → Requests</Link>.</> : 'Ask your server admin to enable requests.'} />;
  } else if (setup.data?.reason === 'tmdb') {
    blocked = <EmptyState icon="alert" title="TMDB isn't configured" message={<>Discover uses TMDB to find movies and shows. Add a TMDB API key in <Link className="link-strong" to="/admin/settings">Admin → Server settings → General</Link>, or connect Lidarr/Readarr for music and books.</>} />;
  } else if (setup.error) {
    blocked = <EmptyState icon="alert" title="Couldn't check request settings" message={setup.error} />;
  }

  const heading = isArrTab(type)
    ? debounced ? <>Results for “{debounced}”</> : null
    : debounced ? <>Results for “{debounced}”</> : 'Trending this week';

  return (
    <div className="page discover-page">
      <header className="page-head">
        <div className="page-title-wrap">
          <Icon name="compass" size={28} className="page-icon" />
          <h1>Discover</h1>
        </div>
        <Link to="/requests" className="btn"><Icon name="inbox" size={16} /> {user?.isAdmin ? 'Requests' : 'My requests'}</Link>
      </header>

      {blocked ?? (
        <>
          <div className="discover-controls">
            <div className="search-box discover-search">
              <Icon name="search" size={22} />
              <input
                ref={input}
                className="search-input"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={PLACEHOLDER[type]}
                aria-label="Search titles to request"
                onKeyDown={(e) => e.key === 'Escape' && setQ('')}
              />
              {q && (
                <button className="btn-icon" onClick={() => { setQ(''); input.current?.focus(); }} aria-label="Clear">
                  <Icon name="x" />
                </button>
              )}
            </div>
            {tabs.length > 1 && (
              <div className="segmented" role="radiogroup" aria-label="Media type">
                {tabs.map((t) => (
                  <button key={t} role="radio" aria-checked={type === t} className={type === t ? 'active' : ''} onClick={() => setType(t)}>{TAB_LABEL[t]}</button>
                ))}
              </div>
            )}
          </div>
          {heading && <h2 className="section-title">{heading}</h2>}
          {setup.loading && !setup.data ? (
            <div className="grid grid-poster">{Array.from({ length: 12 }).map((_, i) => <CardSkeleton key={i} />)}</div>
          ) : isArrTab(type) && !debounced ? (
            <EmptyState icon={type === 'music' ? 'music' : 'book'} title={type === 'music' ? 'Find music to request' : 'Find books to request'} message={type === 'music' ? 'Search for an artist or album. Requests go to Lidarr.' : 'Search for a book or author. Requests go to Readarr.'} />
          ) : error && !results.length ? (
            <EmptyState icon="alert" title="Discover isn't available" message={error} action={<button className="btn" onClick={() => void load(1, debounced, type)}><Icon name="refresh" size={16} /> Try again</button>} />
          ) : !loading && page > 0 && !results.length ? (
            <EmptyState icon="search" title={debounced ? `Nothing found for "${debounced}"` : 'Nothing trending right now'} message={isArrTab(type) ? 'Try a different spelling.' : 'Try a different title or switch between movies and shows.'} />
          ) : (
            <>
              <div className="grid grid-poster discover-grid">
                {results.map((r) => <DiscoverCard key={keyOf(r)} r={r} onRequest={setTarget} />)}
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
