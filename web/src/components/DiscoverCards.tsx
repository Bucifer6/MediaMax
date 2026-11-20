import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DiscoverResult, MediaRequest, RequestMediaType, RequestOptions, RequestQuotaKind, RequestTvInfo, SeasonMode } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { seerrApi } from '../api/seerr';
import { ApiRequestError, errorMessage } from '../api/client';
import { useToast } from '../state/toast';
import { useAsync } from '../hooks';
import { Badge, Dropdown, Field, Img, Modal, Skeleton, Spinner } from './ui';
import { Icon, type IconName } from './Icon';
import { notifyRequestsChanged, parseSeasons } from '../utils/requests';
import '../styles/requests.css';

export const TYPE_LABEL: Record<RequestMediaType, string> = { movie: 'Movie', show: 'TV', artist: 'Artist', album: 'Album', book: 'Book' };
export const TYPE_ICON: Record<RequestMediaType, IconName> = { movie: 'film', show: 'shows', artist: 'music', album: 'music', book: 'book' };
export const keyOf = (r: DiscoverResult) => `${r.mediaType}:${r.externalId ?? r.tmdbId}`;
const quotaKindOf = (t: RequestMediaType): RequestQuotaKind => (t === 'movie' ? 'movie' : t === 'show' ? 'show' : t === 'book' ? 'book' : 'music');

/** May the viewer request this kind at all (permissions from /requests/options)? */
export function canRequestType(opts: RequestOptions | null, t: RequestMediaType): boolean {
  if (!opts) return true;
  const p = opts.permissions;
  if (!p) return t === 'movie' ? opts.movies : t === 'show' ? opts.shows : t === 'book' ? opts.books : opts.music;
  const k = t === 'movie' ? 'movie' : t === 'show' ? 'show' : t === 'book' ? 'book' : 'music';
  return p[k] !== 'none';
}

/** Friendly text for the errors POST /requests can return. */
export function requestErrorText(e: unknown): string {
  if (e instanceof ApiRequestError) {
    if (e.status === 429) return `Quota reached. ${e.message}`;
    if (e.status === 409) return `Already requested or available. ${e.message}`;
    if (e.status === 400 && /tmdb/i.test(e.message)) return `TMDB isn't configured on this server. ${e.message}`;
    if (e.status === 403) return e.message || 'Requests are turned off on this server.';
  }
  return errorMessage(e);
}

export interface CardActions {
  onRequest: (r: DiscoverResult) => void;
  onWatchlist?: (r: DiscoverResult) => void;
  onBlacklist?: (r: DiscoverResult) => void;
}

export function DiscoverCard({ r, opts, actions }: { r: DiscoverResult; opts: RequestOptions | null; actions: CardActions }) {
  const status = r.requestStatus && r.requestStatus !== 'declined' ? r.requestStatus : null;
  const square = r.mediaType === 'artist' || r.mediaType === 'album';
  const allowed = canRequestType(opts, r.mediaType) && !r.blacklisted;
  const moreSeasons = r.mediaType === 'show' && !!r.availableItemId && allowed;
  const art = (
    <div className="card-art" style={square ? { aspectRatio: '1 / 1' } : undefined}>
      <Img src={r.posterUrl} width={260} alt={r.title} fallback={<div className="card-fallback"><Icon name={TYPE_ICON[r.mediaType]} size={28} /><span>{r.title}</span></div>} />
      <span className="discover-type">{TYPE_LABEL[r.mediaType]}</span>
      {r.blacklisted ? (
        <span className="discover-badge"><Badge tone="danger"><Icon name="ban" size={12} /> Blacklisted</Badge></span>
      ) : r.availableItemId ? (
        <span className="discover-badge"><Badge tone="success"><Icon name="check" size={12} /> In library</Badge></span>
      ) : status ? (
        <span className="discover-badge"><Badge tone={status === 'pending' ? 'warning' : 'primary'}>{status === 'pending' ? 'Pending' : status === 'available' ? 'Available' : 'Requested'}</Badge></span>
      ) : null}
    </div>
  );
  const sub = [r.subtitle, r.year, r.rating ? `★ ${r.rating.toFixed(1)}` : null].filter(Boolean).join(' · ');
  const video = r.mediaType === 'movie' || r.mediaType === 'show';
  const menu = [
    ...(video && actions.onWatchlist ? [{ label: r.onWatchlist ? 'Remove from watchlist' : 'Add to watchlist', icon: (r.onWatchlist ? 'heartFill' : 'heart') as IconName, onClick: () => actions.onWatchlist!(r) }] : []),
    ...(actions.onBlacklist && opts?.canManage ? [{ label: r.blacklisted ? 'Remove from blacklist' : 'Blacklist', icon: 'ban' as IconName, onClick: () => actions.onBlacklist!(r) }] : []),
  ];
  return (
    <div className={`card card-poster discover-card ${r.blacklisted ? 'is-blacklisted' : ''}`} style={{ width: '100%' }}>
      <div style={{ position: 'relative' }}>
        {r.availableItemId ? (
          <Link to={`/item/${r.availableItemId}`} className="discover-art-link" data-nav title={`${r.title} — in your library`}>{art}</Link>
        ) : (
          <button type="button" className="discover-art-link" onClick={() => actions.onRequest(r)} data-nav title={status || !allowed ? r.title : `Request ${r.title}`} disabled={!!status || !allowed}>
            {art}
          </button>
        )}
        {menu.length > 0 && (
          <div className="disc-card-tools">
            <Dropdown
              trigger={({ onClick }) => <button className={`btn-icon ${r.onWatchlist ? 'on' : ''}`} onClick={onClick} aria-label={`More for ${r.title}`}><Icon name={r.onWatchlist ? 'heartFill' : 'more'} size={16} /></button>}
              items={menu}
            />
          </div>
        )}
      </div>
      <div className="card-meta">
        <div className="card-title" title={r.title}>{r.title}</div>
        <div className="card-sub" title={sub}>{sub || ' '}</div>
      </div>
      {moreSeasons ? (
        <button className="btn btn-sm discover-action" onClick={() => actions.onRequest(r)}><Icon name="plus" size={14} /> Request seasons</button>
      ) : r.availableItemId ? (
        <Link to={`/item/${r.availableItemId}`} className="btn btn-sm discover-action"><Icon name="play" size={14} /> View</Link>
      ) : status ? (
        <span className="btn btn-sm discover-action" aria-disabled="true"><Icon name="clock" size={14} /> {status === 'pending' ? 'Pending' : 'Requested'}</span>
      ) : allowed ? (
        <button className="btn btn-sm btn-primary discover-action" onClick={() => actions.onRequest(r)}><Icon name="plus" size={14} /> Request</button>
      ) : null}
    </div>
  );
}

/** Watchlist / blacklist actions with optimistic updates, shared by Discover and person pages. */
export function useCardActions(update: (r: DiscoverResult, patch: Partial<DiscoverResult>) => void, onRequest: (r: DiscoverResult) => void): CardActions {
  const toast = useToast();
  return {
    onRequest,
    onWatchlist: async (r) => {
      try {
        if (r.onWatchlist) {
          await seerrApi.removeWatchlist(r.mediaType, r.tmdbId);
          update(r, { onWatchlist: false });
          toast.success(`Removed ${r.title} from your watchlist`);
        } else {
          const w = await seerrApi.addWatchlist(r);
          update(r, { onWatchlist: true, ...(w.requestId ? { requestId: w.requestId, requestStatus: r.requestStatus ?? 'pending' } : {}) });
          toast.success(w.requestId ? `Added ${r.title} to your watchlist and requested it` : `Added ${r.title} to your watchlist`);
          if (w.requestId) notifyRequestsChanged();
        }
      } catch (e) {
        toast.error(e);
      }
    },
    onBlacklist: async (r) => {
      try {
        if (r.blacklisted) {
          await seerrApi.removeBlacklist(r.mediaType, r.externalId ?? r.tmdbId);
          update(r, { blacklisted: false });
          toast.success(`${r.title} can be requested again`);
        } else {
          await seerrApi.addBlacklist({ mediaType: r.mediaType, externalId: r.externalId ?? r.tmdbId, title: r.title });
          update(r, { blacklisted: true });
          toast.success(`Blacklisted ${r.title}`);
        }
      } catch (e) {
        toast.error(e);
      }
    },
  };
}

const SEASON_MODES: { value: SeasonMode; label: string }[] = [
  { value: 'all', label: 'All seasons' }, { value: 'first', label: 'First season' }, { value: 'latest', label: 'Latest season' }, { value: 'specific', label: 'Specific seasons' },
];
const SEASON_TONE = { available: 'success', partial: 'accent', requested: 'primary', pending: 'warning', missing: 'muted' } as const;

/** The request dialog: seasons with per-season availability, 4K when permitted, quota, note. */
export function RequestModal({ target, opts, onClose, onDone }: { target: DiscoverResult | null; opts: RequestOptions | null; onClose: () => void; onDone: (r: DiscoverResult, req: MediaRequest) => void }) {
  const toast = useToast();
  const [seasonMode, setSeasonMode] = useState<SeasonMode>('all');
  const [picked, setPicked] = useState<number[]>([]);
  const [seasonText, setSeasonText] = useState('');
  const [monitor, setMonitor] = useState<'all' | 'future'>('all');
  const [also4k, setAlso4k] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isShow = target?.mediaType === 'show';
  const tv = useAsync<RequestTvInfo | null>(() => (target && isShow ? seerrApi.tv(target.tmdbId).catch(() => null) : Promise.resolve(null)), [target?.tmdbId, isShow]);
  const quota = useAsync(() => (target ? seerrApi.quota().catch(() => opts?.quotas ?? null) : Promise.resolve(null)), [target]);
  useEffect(() => {
    setSeasonMode('all');
    setPicked([]);
    setSeasonText('');
    setMonitor('all');
    setAlso4k(false);
    setNote('');
    setError(null);
  }, [target]);
  // Partially available show: preselect the missing seasons.
  const free = (tv.data?.seasons ?? []).filter((s) => s.status === 'missing' || s.status === 'partial').map((s) => s.seasonNumber);
  const someTaken = (tv.data?.seasons ?? []).some((s) => s.status !== 'missing');
  useEffect(() => {
    if (tv.data && someTaken) {
      setSeasonMode('specific');
      setPicked(free);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tv.data]);
  if (!target) return null;
  const type = target.mediaType;
  const useTable = isShow && !!tv.data?.seasons.length;
  const seasons = !isShow || seasonMode !== 'specific' ? [] : useTable ? picked : parseSeasons(seasonText) ?? [];
  const seasonsInvalid = isShow && seasonMode === 'specific' && seasons.length === 0;
  const can4k = (type === 'movie' && opts?.can4k.movie) || (type === 'show' && opts?.can4k.show);
  const level = opts?.permissions ? opts.permissions[type === 'movie' ? 'movie' : type === 'show' ? 'show' : type === 'book' ? 'book' : 'music'] : 'request';
  const q = quota.data?.[quotaKindOf(type)] ?? null;
  const regular = (tv.data?.seasons ?? []).map((s) => s.seasonNumber);
  const units = !isShow ? 1 : seasonMode === 'specific' ? seasons.length : seasonMode === 'all' ? Math.max(1, regular.filter((n) => free.includes(n) || !someTaken).length) : 1;
  const overQuota = !!q && q.remaining !== null && q.remaining < units;
  const nothingLeft = isShow && !!tv.data && free.length === 0 && tv.data.seasons.length > 0;

  const submit = async () => {
    if (seasonsInvalid || overQuota) return;
    setBusy(true);
    setError(null);
    try {
      const req = await api.requests.create({
        tmdbId: target.tmdbId, externalId: target.externalId ?? target.tmdbId, mediaType: type, title: target.title,
        ...(isShow ? { seasonMode, seasons } : {}),
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

  const unit = isShow ? 'season' : type === 'movie' ? 'movie' : type === 'book' ? 'book' : 'request';
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={`Request ${TYPE_LABEL[type] === 'TV' ? 'show' : TYPE_LABEL[type].toLowerCase()}`}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy || seasonsInvalid || overQuota || nothingLeft}>
            {busy ? <Spinner size={16} /> : <Icon name="plus" size={16} />} {level === 'auto' ? 'Request' : 'Request (needs approval)'}
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
              {!someTaken && (
                <div className="segmented" role="radiogroup" aria-label="Seasons">
                  {SEASON_MODES.map((m) => (
                    <button key={m.value} type="button" role="radio" aria-checked={seasonMode === m.value} className={seasonMode === m.value ? 'active' : ''} onClick={() => setSeasonMode(m.value)}>{m.label}</button>
                  ))}
                </div>
              )}
              {tv.loading && !tv.data ? <Skeleton h={100} /> : useTable ? (
                <div className="season-wrap">
                  <table className="season-table">
                    <thead><tr><th /><th>Season</th><th>Episodes</th><th>Status</th></tr></thead>
                    <tbody>
                      {tv.data!.seasons.map((s) => {
                        const open = s.status === 'missing' || s.status === 'partial';
                        const on = !open ? false : seasonMode === 'specific' ? picked.includes(s.seasonNumber) : seasonMode === 'all' || (seasonMode === 'first' ? s.seasonNumber === regular[0] : s.seasonNumber === regular[regular.length - 1]);
                        return (
                          <tr key={s.seasonNumber} className={open ? '' : 'is-off'}>
                            <td><input type="checkbox" checked={on} disabled={!open} aria-label={s.name} onChange={(e) => {
                              setSeasonMode('specific');
                              const base = seasonMode === 'specific' ? picked : regular.filter((n) => free.includes(n) && (seasonMode === 'all' || (seasonMode === 'first' ? n === regular[0] : n === regular[regular.length - 1])));
                              setPicked((e.target.checked ? [...base, s.seasonNumber] : base.filter((n) => n !== s.seasonNumber)).sort((a, b) => a - b));
                            }} /></td>
                            <td>{s.name}</td>
                            <td>{s.libraryEpisodes ? `${s.libraryEpisodes}/` : ''}{s.episodeCount}</td>
                            <td><Badge tone={SEASON_TONE[s.status]}>{s.status === 'partial' ? 'partly in library' : s.status === 'available' ? 'in library' : s.status}</Badge></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : seasonMode === 'specific' && (
                <Field label="Season numbers" hint="Comma separated; ranges work too (e.g. 1, 3-5).">
                  <input className="input" value={seasonText} onChange={(e) => setSeasonText(e.target.value)} placeholder="1, 2" inputMode="numeric" autoFocus />
                </Field>
              )}
              {nothingLeft && <p className="muted">Every season is already in the library or requested.</p>}
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
          {q && !q.exempt && q.limit > 0 && (
            <div className={`quota-note ${overQuota ? 'is-out' : ''}`} role="status">
              <Icon name={overQuota ? 'alert' : 'clock'} size={16} />
              <span>
                {overQuota
                  ? q.remaining ? `This needs ${units} ${unit}s but you have ${q.remaining} left.` : `You've used all ${q.limit} ${unit} requests for the last ${q.days} days.`
                  : `${q.remaining} of ${q.limit} ${unit} request${q.limit === 1 ? '' : 's'} left in the last ${q.days} days${isShow && units > 1 ? ` — this uses ${units}` : ''}.`}
                {q.resetsAt && overQuota ? ` Next one frees up ${new Date(q.resetsAt).toLocaleDateString()}.` : ''}
              </span>
            </div>
          )}
          {level === 'auto' && <p className="muted" style={{ margin: 0, fontSize: '0.84rem' }}><Icon name="zap" size={13} /> Approved automatically.</p>}
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
