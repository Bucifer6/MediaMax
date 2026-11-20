import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { DiscoverResult, MediaRequest } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { ApiRequestError, errorMessage } from '../api/client';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useAsync, useDebounced, useInfiniteSentinel } from '../hooks';
import { CardSkeleton } from '../components/Cards';
import { Badge, EmptyState, Field, Img, Modal, Spinner } from '../components/ui';
import { Icon } from '../components/Icon';
import { notifyRequestsChanged, parseSeasons } from '../utils/requests';

type MediaFilter = 'all' | 'movie' | 'show';

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

function DiscoverCard({ r, onRequest }: { r: DiscoverResult; onRequest: (r: DiscoverResult) => void }) {
  const status = r.requestStatus && r.requestStatus !== 'declined' ? r.requestStatus : null;
  const art = (
    <div className="card-art">
      <Img src={r.posterUrl} width={260} alt={r.title} fallback={<div className="card-fallback"><Icon name={r.mediaType === 'show' ? 'shows' : 'film'} size={28} /><span>{r.title}</span></div>} />
      <span className="discover-type">{r.mediaType === 'show' ? 'TV' : 'Movie'}</span>
      {r.availableItemId ? (
        <span className="discover-badge"><Badge tone="success"><Icon name="check" size={12} /> In library</Badge></span>
      ) : status ? (
        <span className="discover-badge"><Badge tone={status === 'pending' ? 'warning' : 'primary'}>{status === 'pending' ? 'Pending' : 'Requested'}</Badge></span>
      ) : null}
    </div>
  );
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
        <div className="card-sub">
          {[r.year, r.rating ? `★ ${r.rating.toFixed(1)}` : null].filter(Boolean).join(' · ') || ' '}
        </div>
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

function RequestModal({ target, onClose, onDone }: { target: DiscoverResult | null; onClose: () => void; onDone: (r: DiscoverResult, req: MediaRequest) => void }) {
  const toast = useToast();
  const [allSeasons, setAllSeasons] = useState(true);
  const [seasonText, setSeasonText] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setAllSeasons(true);
    setSeasonText('');
    setNote('');
    setError(null);
  }, [target]);
  if (!target) return null;
  const isShow = target.mediaType === 'show';
  const seasons = isShow && !allSeasons ? parseSeasons(seasonText) : [];
  const seasonsInvalid = isShow && !allSeasons && (!seasons || seasons.length === 0);

  const submit = async () => {
    if (seasonsInvalid) return;
    setBusy(true);
    setError(null);
    try {
      const req = await api.requests.create({ tmdbId: target.tmdbId, mediaType: target.mediaType, seasons: seasons ?? [], note: note.trim() || undefined });
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
      title={`Request ${isShow ? 'show' : 'movie'}`}
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
        <div className="request-modal-poster"><Img src={target.posterUrl} width={200} alt="" fallback={<Icon name={isShow ? 'shows' : 'film'} size={28} />} /></div>
        <div className="form-grid">
          <div>
            <h3 className="request-modal-title">{target.title} {target.year && <span className="muted">({target.year})</span>}</h3>
            {target.overview && <p className="muted request-modal-overview">{target.overview}</p>}
          </div>
          {isShow && (
            <fieldset className="request-seasons">
              <legend className="field-label">Seasons</legend>
              <label className="check-inline">
                <input type="checkbox" checked={allSeasons} onChange={(e) => setAllSeasons(e.target.checked)} /> All seasons
              </label>
              {!allSeasons && (
                <Field label="Season numbers" hint="Comma separated; ranges work too (e.g. 1, 3-5).">
                  <input className="input" value={seasonText} onChange={(e) => setSeasonText(e.target.value)} placeholder="1, 2" inputMode="numeric" autoFocus />
                </Field>
              )}
              {!allSeasons && seasonText.trim() !== '' && seasonsInvalid && <p className="form-error">Enter season numbers like “1, 2” or “1-3”.</p>}
            </fieldset>
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

  // Admins can see up front whether requests can work, which avoids a pointless failing call.
  const setup = useAsync(async () => {
    if (!user?.isAdmin) return { ok: true, reason: '' };
    const s = await api.admin.settings();
    if (!s.requests?.enabled) return { ok: false, reason: 'off' };
    if (!s.tmdbApiKey) return { ok: false, reason: 'tmdb' };
    return { ok: true, reason: '' };
  }, [user?.isAdmin]);
  const ready = features.requests && !!setup.data?.ok;

  const load = useCallback(async (p: number, query: string, t: MediaFilter) => {
    const id = ++reqId.current;
    setLoading(true);
    if (p === 1) setError(null);
    try {
      const r = await api.discover.search({ q: query || undefined, type: t, page: p });
      if (id !== reqId.current) return;
      setResults((prev) => {
        const base = p === 1 ? [] : prev;
        const seen = new Set(base.map((x) => `${x.mediaType}:${x.tmdbId}`));
        return [...base, ...r.results.filter((x) => !seen.has(`${x.mediaType}:${x.tmdbId}`))];
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
    setResults((list) => list.map((x) => (x.tmdbId === r.tmdbId && x.mediaType === r.mediaType ? { ...x, requestId: req.id, requestStatus: req.status } : x)));
    setTarget(null);
  };

  let blocked: ReactNode = null;
  if (!features.requests || setup.data?.reason === 'off') {
    blocked = <EmptyState icon="compass" title="Requests are turned off" message={user?.isAdmin ? <>Turn them on in <Link className="link-strong" to="/admin/settings">Admin → Server settings → Requests</Link>.</> : 'Ask your server admin to enable requests.'} />;
  } else if (setup.data?.reason === 'tmdb') {
    blocked = <EmptyState icon="alert" title="TMDB isn't configured" message={<>Discover uses TMDB to find titles. Add a TMDB API key in <Link className="link-strong" to="/admin/settings">Admin → Server settings → General</Link>.</>} />;
  } else if (setup.error) {
    blocked = <EmptyState icon="alert" title="Couldn't check request settings" message={setup.error} />;
  }

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
                placeholder="Search for movies and shows to request…"
                aria-label="Search TMDB"
                onKeyDown={(e) => e.key === 'Escape' && setQ('')}
              />
              {q && (
                <button className="btn-icon" onClick={() => { setQ(''); input.current?.focus(); }} aria-label="Clear">
                  <Icon name="x" />
                </button>
              )}
            </div>
            <div className="segmented" role="radiogroup" aria-label="Media type">
              {(['all', 'movie', 'show'] as const).map((t) => (
                <button key={t} role="radio" aria-checked={type === t} className={type === t ? 'active' : ''} onClick={() => setType(t)}>
                  {t === 'all' ? 'All' : t === 'movie' ? 'Movies' : 'Shows'}
                </button>
              ))}
            </div>
          </div>
          <h2 className="section-title">{debounced ? <>Results for “{debounced}”</> : 'Trending this week'}</h2>
          {setup.loading && !setup.data ? (
            <div className="grid grid-poster">{Array.from({ length: 12 }).map((_, i) => <CardSkeleton key={i} />)}</div>
          ) : error && !results.length ? (
            <EmptyState icon="alert" title="Discover isn't available" message={error} action={<button className="btn" onClick={() => void load(1, debounced, type)}><Icon name="refresh" size={16} /> Try again</button>} />
          ) : !loading && page > 0 && !results.length ? (
            <EmptyState icon="search" title={debounced ? `Nothing found for "${debounced}"` : 'Nothing trending right now'} message="Try a different title or switch between movies and shows." />
          ) : (
            <>
              <div className="grid grid-poster discover-grid">
                {results.map((r) => <DiscoverCard key={`${r.mediaType}:${r.tmdbId}`} r={r} onRequest={setTarget} />)}
                {loading && Array.from({ length: results.length ? 6 : 12 }).map((_, i) => <CardSkeleton key={`s${i}`} />)}
              </div>
              {error && results.length > 0 && <p className="form-error" style={{ marginTop: 16 }}>{error}</p>}
              <div ref={sentinel} className="sentinel" />
            </>
          )}
        </>
      )}
      <RequestModal target={target} onClose={() => setTarget(null)} onDone={onDone} />
    </div>
  );
}
