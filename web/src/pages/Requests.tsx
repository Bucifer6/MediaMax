import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type {
  BlacklistEntry, MediaRequest, RequestActivity, RequestArrChoices, RequestArrOverrides, RequestMediaType, RequestQuotaKind, RequestQuotaStatus, RequestStatus, RequestTvInfo, User,
} from '@mediamax/shared';
import { api } from '../api/endpoints';
import { seerrApi } from '../api/seerr';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useAsync } from '../hooks';
import { Badge, EmptyState, ErrorState, Field, Img, Modal, ProgressBar, Skeleton, Spinner, Switch, Tabs } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';
import '../styles/arr.css';
import '../styles/requests.css';
import { formatDateTime, relativeTime } from '../utils/format';
import { canManageRequests, notifyRequestsChanged, REQUEST_STATUS_TONE } from '../utils/requests';
import { HelpLink } from '../components/HelpLink';

const STATUSES: RequestStatus[] = ['pending', 'approved', 'processing', 'available', 'declined', 'failed'];
const TYPE_LABEL: Record<RequestMediaType, string> = { movie: 'Movie', show: 'TV', artist: 'Artist', album: 'Album', book: 'Book' };
const TYPE_ICON: Record<RequestMediaType, IconName> = { movie: 'film', show: 'shows', artist: 'music', album: 'music', book: 'book' };
const ARR_FOR: Record<RequestMediaType, string> = { movie: 'Radarr', show: 'Sonarr', artist: 'Lidarr', album: 'Lidarr', book: 'Readarr' };
const QUOTA_LABEL: Record<RequestQuotaKind, [string, string]> = { movie: ['Movies', 'movies'], show: ['TV', 'seasons'], music: ['Music', 'requests'], book: ['Books', 'books'] };
const ACT_ICON: Record<RequestActivity['kind'], IconName> = {
  created: 'plus', approved: 'check', declined: 'x', processing: 'download', failed: 'alert', available: 'play', edited: 'edit', comment: 'info', retried: 'refresh',
};
const ACT_TEXT: Record<RequestActivity['kind'], string> = {
  created: 'requested', approved: 'approved', declined: 'declined', processing: 'Sent for download', failed: 'Sending failed', available: 'Now available', edited: 'edited the request', comment: 'commented', retried: 'retried',
};

function seasonText(r: MediaRequest): string {
  if (r.seasonMode === 'first') return 'First season';
  if (r.seasonMode === 'latest') return 'Latest season';
  if (r.seasons.length) return `Season${r.seasons.length > 1 ? 's' : ''} ${r.seasons.join(', ')}`;
  return 'All seasons';
}

/** Requester's remaining quota per kind. */
export function QuotaPills({ quotas }: { quotas: Record<RequestQuotaKind, RequestQuotaStatus> | null | undefined }) {
  if (!quotas) return null;
  const list = (Object.keys(QUOTA_LABEL) as RequestQuotaKind[]).filter((k) => quotas[k] && quotas[k].limit > 0 && !quotas[k].exempt);
  if (!list.length) return null;
  return (
    <div className="req-quota" aria-label="Your request quota">
      {list.map((k) => {
        const q = quotas[k];
        return (
          <span key={k} className={`quota-pill ${q.remaining === 0 ? 'is-out' : ''}`} title={q.resetsAt ? `Next slot frees up ${formatDateTime(q.resetsAt)}` : undefined}>
            {QUOTA_LABEL[k][0]}: <b>{q.remaining ?? '∞'}</b> of {q.limit} {QUOTA_LABEL[k][1]} left · {q.days} days
          </span>
        );
      })}
    </div>
  );
}

function RequestRow({
  r, manager, mine, busy, selected, onSelect, onApprove, onQuickApprove, onDecline, onDelete, onOpen,
}: {
  r: MediaRequest; manager: boolean; mine: boolean; busy: boolean; selected: boolean; onSelect: (on: boolean) => void;
  onApprove: (r: MediaRequest) => void; onQuickApprove: (r: MediaRequest) => void; onDecline: (r: MediaRequest) => void; onDelete: (r: MediaRequest) => void; onOpen: (r: MediaRequest) => void;
}) {
  const poster = <Img src={r.posterUrl} width={120} alt="" fallback={<Icon name={TYPE_ICON[r.mediaType] ?? 'film'} size={20} />} />;
  return (
    <li className={`req-row ${selected ? 'is-selected' : ''}`}>
      {manager && <input type="checkbox" className="req-check" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Select ${r.title}`} />}
      {r.itemId ? <Link to={`/item/${r.itemId}`} className="req-poster" tabIndex={-1}>{poster}</Link> : <span className="req-poster">{poster}</span>}
      <div className="req-info">
        <div className="req-title">
          <button type="button" className="link-strong" style={{ background: 'none', border: 0, padding: 0, font: 'inherit', cursor: 'pointer', color: 'inherit', textAlign: 'left' }} onClick={() => onOpen(r)}>{r.title}</button>
          {r.year && <span className="muted">({r.year})</span>}
          <Badge tone="muted">{TYPE_LABEL[r.mediaType] ?? r.mediaType}</Badge>
          {r.also4k && <Badge tone="accent">+4K</Badge>}
        </div>
        <div className="muted req-sub">
          {r.subtitle && <span>{r.mediaType === 'book' ? 'by ' : ''}{r.subtitle} · </span>}
          {r.mediaType === 'show' && <span>{seasonText(r)} · </span>}
          {r.mediaType === 'artist' && <span>{r.monitor === 'future' ? 'Future albums' : 'All albums'} · </span>}
          {manager && !mine && <span>{r.requestedBy.displayName} · </span>}
          <span title={formatDateTime(r.requestedAt)}>requested {relativeTime(r.requestedAt)}</span>
          {r.decidedBy && r.decidedAt && <span> · {r.status === 'declined' ? 'declined' : 'approved'} by {r.decidedBy.displayName}</span>}
        </div>
        {r.note && <p className="req-note"><Icon name="info" size={13} /> {r.note}</p>}
        {r.status === 'declined' && r.declineReason && <p className="req-note"><Icon name="x" size={13} /> Declined: {r.declineReason}</p>}
        {r.download && (
          <div className="req-download" title={`${r.download.instance}: ${r.download.status}`}>
            <Icon name="download" size={14} />
            <span>Downloading {r.download.progress}%</span>
            <ProgressBar value={r.download.progress} />
            {r.download.timeLeft && <span className="muted">{r.download.timeLeft.replace(/^00:/, '')}</span>}
          </div>
        )}
        {r.error && <p className="form-error">{r.error}</p>}
        <div className="req-meta-line muted">
          {manager && r.arr && (r.arr.instanceId || r.arr.qualityProfileId || r.arr.rootFolderPath) && <span><Icon name="settings" size={12} /> Custom download settings</span>}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onOpen(r)}><Icon name="clock" size={12} /> Timeline{r.commentCount ? ` · ${r.commentCount} comment${r.commentCount === 1 ? '' : 's'}` : ''}</button>
        </div>
      </div>
      <Badge tone={REQUEST_STATUS_TONE[r.status]} className="req-status">{r.download ? `Downloading ${r.download.progress}%` : r.status}</Badge>
      <div className="req-actions">
        {r.itemId && r.status === 'available' && (
          <Link to={`/item/${r.itemId}`} className="btn btn-sm btn-primary"><Icon name="play" size={14} /> View</Link>
        )}
        {manager && r.status === 'pending' && (
          <>
            <button className="btn btn-sm btn-primary" onClick={() => onQuickApprove(r)} disabled={busy}>{busy ? <Spinner size={14} /> : <Icon name="check" size={14} />} Approve</button>
            <button className="btn btn-sm" onClick={() => onApprove(r)} disabled={busy} title="Change seasons, instance, quality profile, root folder or tags, then approve"><Icon name="edit" size={14} /> Edit</button>
          </>
        )}
        {manager && ['failed', 'declined'].includes(r.status) && (
          <button className="btn btn-sm btn-primary" onClick={() => onApprove(r)} disabled={busy}>{busy ? <Spinner size={14} /> : <Icon name="refresh" size={14} />} {r.status === 'failed' ? 'Retry' : 'Approve'}</button>
        )}
        {manager && ['pending', 'failed', 'approved'].includes(r.status) && (
          <button className="btn btn-sm" onClick={() => onDecline(r)} disabled={busy}><Icon name="x" size={14} /> Decline</button>
        )}
        {(manager || (mine && r.status === 'pending')) && (
          <button className="btn-icon" onClick={() => onDelete(r)} disabled={busy} aria-label={mine && r.status === 'pending' && !manager ? 'Withdraw request' : 'Delete request'} title={mine && r.status === 'pending' && !manager ? 'Withdraw' : 'Delete'}>
            <Icon name="trash" size={16} />
          </button>
        )}
      </div>
    </li>
  );
}

/** Edit before approve: seasons, 4K, instance, quality profile, root folder, language profile, tags. */
function ApproveModal({ req, onClose, onDone }: { req: MediaRequest | null; onClose: () => void; onDone: (r: MediaRequest) => void }) {
  const toast = useToast();
  const choices = useAsync<RequestArrChoices | null>(() => (req ? seerrApi.arrChoices(req.id) : Promise.resolve(null)), [req?.id]);
  const tv = useAsync<RequestTvInfo | null>(() => (req?.mediaType === 'show' ? seerrApi.tv(req.tmdbId).catch(() => null) : Promise.resolve(null)), [req?.id]);
  const [ov, setOv] = useState<RequestArrOverrides>({});
  const [seasons, setSeasons] = useState<number[] | null>(null);
  const [also4k, setAlso4k] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setOv(req?.arr ?? {});
    setSeasons(req && req.mediaType === 'show' && req.seasonMode === 'specific' ? req.seasons : null);
    setAlso4k(!!req?.also4k);
  }, [req]);
  if (!req) return null;
  const main = (choices.data?.instances ?? []).filter((i) => !i.is4k);
  const instId = ov.instanceId ?? main[0]?.id ?? null;
  const inst = choices.data?.instances.find((i) => i.id === instId) ?? null;
  const has4k = (choices.data?.instances ?? []).some((i) => i.is4k);
  const d = inst?.defaults ?? {};
  const val = <K extends keyof RequestArrOverrides>(k: K) => (ov[k] !== undefined && ov[k] !== null ? ov[k] : d[k]) as RequestArrOverrides[K];
  const set = (p: Partial<RequestArrOverrides>) => setOv((o) => ({ ...o, ...p }));
  const tags = val('tags') ?? [];
  const submit = async () => {
    setBusy(true);
    try {
      const body = {
        arr: ov,
        ...(req.mediaType === 'show' ? (seasons ? { seasonMode: 'specific' as const, seasons } : { seasonMode: req.seasonMode === 'specific' ? 'all' as const : req.seasonMode }) : {}),
        ...(also4k !== req.also4k ? { also4k } : {}),
      };
      const out = req.status === 'pending' || req.status === 'failed' || req.status === 'declined' ? await seerrApi.approve(req.id, body) : await seerrApi.edit(req.id, body);
      if (out.status === 'failed') toast.show(`Approved, but sending to ${ARR_FOR[req.mediaType]} failed: ${out.error ?? 'unknown error'}`, 'error');
      else toast.success(`Approved ${req.title}`);
      onDone(out);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} size="lg" title={`Review “${req.title}”`}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={() => void submit()} disabled={busy || (seasons !== null && !seasons.length)}>{busy ? <Spinner size={16} /> : <Icon name="check" size={16} />} {req.status === 'failed' ? 'Retry' : 'Approve'}</button></>}>
      <div className="form-grid">
        <p className="muted" style={{ margin: 0 }}>Requested by <strong>{req.requestedBy.displayName}</strong> {relativeTime(req.requestedAt)}{req.note ? <> · “{req.note}”</> : null}</p>
        {req.mediaType === 'show' && (
          <fieldset className="request-seasons">
            <legend className="field-label">Seasons</legend>
            {tv.loading && !tv.data ? <Skeleton h={120} /> : tv.data ? (
              <div className="season-wrap">
                <table className="season-table">
                  <thead><tr><th><input type="checkbox" aria-label="All seasons" checked={seasons === null} onChange={(e) => setSeasons(e.target.checked ? null : req.seasons.length ? req.seasons : [])} /></th><th>Season</th><th>Episodes</th><th>Status</th></tr></thead>
                  <tbody>
                    {tv.data.seasons.map((s) => {
                      const on = seasons === null || seasons.includes(s.seasonNumber);
                      return (
                        <tr key={s.seasonNumber}>
                          <td><input type="checkbox" checked={on} aria-label={s.name} onChange={(e) => setSeasons((cur) => {
                            const base = cur ?? tv.data!.seasons.map((x) => x.seasonNumber);
                            return (e.target.checked ? [...base, s.seasonNumber] : base.filter((n) => n !== s.seasonNumber)).sort((a, b) => a - b);
                          })} /></td>
                          <td>{s.name}</td>
                          <td>{s.libraryEpisodes ? `${s.libraryEpisodes}/` : ''}{s.episodeCount}</td>
                          <td><Badge tone={s.status === 'available' ? 'success' : s.status === 'missing' ? 'muted' : 'warning'}>{s.status}</Badge></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : <p className="muted">{seasonText(req)} (season list unavailable)</p>}
          </fieldset>
        )}
        {(req.mediaType === 'movie' || req.mediaType === 'show') && has4k && <Switch checked={also4k} onChange={setAlso4k} label="Also send to the 4K instance" />}
        {choices.loading && !choices.data ? <Skeleton h={120} /> : choices.error ? <ErrorState message={choices.error} /> : !main.length ? (
          <p className="callout-warning"><Icon name="alert" size={16} /> No {ARR_FOR[req.mediaType]} is set up — approving keeps the request “approved”.</p>
        ) : (
          <>
            <div className="form-row">
              <Field label={`${ARR_FOR[req.mediaType]} instance`}>
                <select className="select" value={instId ?? ''} onChange={(e) => setOv({ instanceId: e.target.value })}>
                  {main.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </select>
              </Field>
              <Field label="Quality profile">
                <select className="select" value={val('qualityProfileId') ?? ''} onChange={(e) => set({ qualityProfileId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">Instance default</option>
                  {(inst?.options.qualityProfiles ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
            </div>
            <div className="form-row">
              <Field label="Root folder">
                <select className="select" value={val('rootFolderPath') ?? ''} onChange={(e) => set({ rootFolderPath: e.target.value || null })}>
                  <option value="">Instance default</option>
                  {(inst?.options.rootFolders ?? []).map((f) => <option key={f.path} value={f.path}>{f.path}</option>)}
                </select>
              </Field>
              {!!inst?.options.languageProfiles?.length && (
                <Field label="Language profile">
                  <select className="select" value={val('languageProfileId') ?? ''} onChange={(e) => set({ languageProfileId: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">Instance default</option>
                    {inst.options.languageProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </Field>
              )}
            </div>
            {!!inst?.options.tags?.length && (
              <div className="field">
                <span className="field-label">Tags</span>
                <div className="event-chips">
                  {inst.options.tags.map((t) => (
                    <label key={t.id} className={`check-chip ${tags.includes(t.id) ? 'on' : ''}`}>
                      <input type="checkbox" checked={tags.includes(t.id)} onChange={(e) => set({ tags: e.target.checked ? [...tags, t.id] : tags.filter((x) => x !== t.id) })} /> {t.label}
                    </label>
                  ))}
                </div>
              </div>
            )}
            {inst && !inst.options.ok && <p className="form-error">{inst.name}: {inst.options.message}</p>}
          </>
        )}
      </div>
    </Modal>
  );
}

/** Status timeline + comments between requester and managers. */
function RequestDetail({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: (r: MediaRequest) => void }) {
  const toast = useToast();
  const req = useAsync(() => (id ? seerrApi.request(id) : Promise.resolve(null)), [id]);
  const act = useAsync(() => (id ? seerrApi.activity(id) : Promise.resolve([] as RequestActivity[])), [id]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  if (!id) return null;
  const r = req.data;
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await seerrApi.comment(id, text.trim());
      setText('');
      act.reload();
      if (r) onChanged({ ...r, commentCount: (r.commentCount ?? 0) + 1 });
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} size="md" title={r ? `${r.title}${r.year ? ` (${r.year})` : ''}` : 'Request'}>
      {req.error ? <ErrorState message={req.error} /> : !r ? <Skeleton h={160} /> : (
        <div className="form-grid">
          <div className="badge-row">
            <Badge tone={REQUEST_STATUS_TONE[r.status]}>{r.status}</Badge>
            <Badge tone="muted">{TYPE_LABEL[r.mediaType]}</Badge>
            {r.mediaType === 'show' && <Badge tone="muted">{seasonText(r)}</Badge>}
            {r.also4k && <Badge tone="accent">+4K</Badge>}
          </div>
          {act.loading && !act.data ? <Skeleton h={100} /> : (
            <ol className="timeline" aria-label="Request timeline">
              {(act.data ?? []).map((a) => (
                <li key={a.id} className={a.kind === 'comment' ? 'tl-comment' : ''}>
                  <span className={`tl-dot k-${a.kind}`}><Icon name={ACT_ICON[a.kind] ?? 'info'} size={13} /></span>
                  <div className="tl-body">
                    <div><strong>{a.user?.displayName ?? (a.kind === 'processing' || a.kind === 'failed' || a.kind === 'available' ? '' : 'Kinora')}</strong> {a.user ? ACT_TEXT[a.kind] : ACT_TEXT[a.kind]} <span className="muted" title={formatDateTime(a.createdAt)}>· {relativeTime(a.createdAt)}</span></div>
                    {a.body && <p>{a.body}</p>}
                  </div>
                </li>
              ))}
            </ol>
          )}
          <div className="comment-box">
            <textarea className="textarea" rows={2} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a comment for the requester / admins…" aria-label="Comment" />
            <button className="btn btn-primary" onClick={() => void send()} disabled={busy || !text.trim()}>{busy ? <Spinner size={16} /> : 'Send'}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function BlacklistPanel() {
  const toast = useToast();
  const list = useAsync(() => seerrApi.blacklist(), []);
  const remove = async (b: BlacklistEntry) => {
    try {
      await seerrApi.removeBlacklist(b.mediaType, b.externalId);
      list.setData((l) => (l ?? []).filter((x) => !(x.mediaType === b.mediaType && x.externalId === b.externalId)));
      toast.success(`${b.title} can be requested again`);
    } catch (e) {
      toast.error(e);
    }
  };
  if (list.loading && !list.data) return <Skeleton h={120} />;
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />;
  if (!list.data?.length) return <EmptyState icon="shield" title="Nothing blacklisted" message="Blacklist titles from their card on Discover (⋯ → Blacklist). Nobody can request them." />;
  return (
    <ul className="req-list">
      {list.data.map((b) => (
        <li key={`${b.mediaType}:${b.externalId}`} className="req-row">
          <div className="req-info">
            <div className="req-title">{b.title} <Badge tone="muted">{TYPE_LABEL[b.mediaType]}</Badge></div>
            <div className="muted req-sub">{b.reason ? `${b.reason} · ` : ''}by {b.createdBy?.displayName ?? 'unknown'} {relativeTime(b.createdAt)}</div>
          </div>
          <div className="req-actions"><button className="btn btn-sm" onClick={() => void remove(b)}><Icon name="x" size={14} /> Remove</button></div>
        </li>
      ))}
    </ul>
  );
}

export default function RequestsPage() {
  const { user, features } = useApp();
  const toast = useToast();
  const manager = canManageRequests(user);
  // Kids profiles and accounts without any request permission: say so instead of pointing them at Discover.
  const canRequest = !!user && (user.isAdmin || !user.requestPermissions || (['movie', 'show', 'music', 'book'] as const).some((k) => user.requestPermissions![k] !== 'none'));
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<'requests' | 'blacklist'>('requests');
  const [status, setStatus] = useState<RequestStatus | ''>(manager ? 'pending' : '');
  const [mediaType, setMediaType] = useState<RequestMediaType | ''>('');
  const [userId, setUserId] = useState('');
  const [sort, setSort] = useState<'requested' | 'updated' | 'title' | 'status'>('requested');
  const [mineOnly, setMineOnly] = useState(false);
  const query = { status: status || undefined, mediaType: mediaType || undefined, userId: manager && userId ? userId : undefined, sort, mine: manager && mineOnly ? true : undefined };
  const res = useAsync(() => seerrApi.requests(query), [status, mediaType, userId, sort, mineOnly, manager]);
  const users = useAsync<User[]>(() => (user?.isAdmin ? api.users.list() : Promise.resolve([])), [user?.isAdmin]);
  const quota = useAsync(() => (manager ? Promise.resolve(null) : seerrApi.quota().catch(() => null)), [manager]);
  const { setData: setList } = res;
  const live = (res.data ?? []).some((r) => r.status === 'processing' || !!r.download);
  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      seerrApi.requests(query).then((l) => setList(l)).catch(() => undefined);
    }, 15000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, status, mediaType, userId, sort, mineOnly, setList]);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [declining, setDeclining] = useState<MediaRequest[] | null>(null);
  const [reason, setReason] = useState('');
  const [deleting, setDeleting] = useState<MediaRequest[] | null>(null);
  const [alsoArr, setAlsoArr] = useState(false);
  const [approving, setApproving] = useState<MediaRequest | null>(null);
  const detailId = params.get('id');
  const openDetail = (r: MediaRequest | null) => setParams((p) => {
    const n = new URLSearchParams(p);
    if (r) n.set('id', r.id);
    else n.delete('id');
    return n;
  }, { replace: true });
  useEffect(() => setSelected(new Set()), [status, mediaType, userId, sort, mineOnly]);

  const list = res.data ?? [];
  const selList = useMemo(() => list.filter((r) => selected.has(r.id)), [list, selected]);
  const replace = (r: MediaRequest) => {
    res.setData((l) => (l ?? []).map((x) => (x.id === r.id ? r : x)).filter((x) => !status || x.status === status));
    notifyRequestsChanged();
  };
  const quickApprove = async (r: MediaRequest) => {
    setBusy(r.id);
    try {
      const out = await seerrApi.approve(r.id);
      replace(out);
      if (out.status === 'failed') toast.show(`Approved, but sending to ${ARR_FOR[r.mediaType] ?? 'the download manager'} failed: ${out.error ?? 'unknown error'}`, 'error');
      else toast.success(`Approved ${r.title}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const bulk = async (action: 'approve' | 'decline' | 'delete', items: MediaRequest[], extra: { note?: string; removeFromArr?: boolean } = {}) => {
    setBusy('bulk');
    try {
      const out = await seerrApi.bulk({ ids: items.map((r) => r.id), action, ...extra });
      if (out.failed.length) toast.show(`${out.ok.length} done, ${out.failed.length} failed: ${out.failed[0].error}`, 'error');
      else toast.success(`${action === 'approve' ? 'Approved' : action === 'decline' ? 'Declined' : 'Deleted'} ${out.ok.length} request${out.ok.length === 1 ? '' : 's'}`);
      setSelected(new Set());
      res.reload();
      notifyRequestsChanged();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const decline = async () => {
    if (!declining) return;
    const items = declining;
    if (items.length > 1 || !manager) await bulk('decline', items, { note: reason.trim() || undefined });
    else {
      setBusy(items[0].id);
      try {
        replace(await seerrApi.decline(items[0].id, reason.trim() || undefined));
        toast.success(`Declined ${items[0].title}`);
      } catch (e) {
        toast.error(e);
      } finally {
        setBusy(null);
      }
    }
    setDeclining(null);
  };
  const remove = async () => {
    if (!deleting) return;
    const items = deleting;
    setDeleting(null);
    if (items.length > 1) return bulk('delete', items, { removeFromArr: alsoArr });
    const r = items[0];
    setBusy(r.id);
    try {
      const out = await seerrApi.remove(r.id, manager && alsoArr);
      res.setData((l) => (l ?? []).filter((x) => x.id !== r.id));
      notifyRequestsChanged();
      toast.success(out.removedFrom.length ? `Deleted and removed from ${out.removedFrom.join(', ')}` : 'Request deleted');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const withdraw = deleting?.length === 1 && deleting[0].requestedBy.id === user?.id && deleting[0].status === 'pending' && !manager;
  const arrDeletable = (deleting ?? []).some((r) => (r.mediaType === 'movie' || r.mediaType === 'show') && ['approved', 'processing', 'available', 'failed'].includes(r.status));

  return (
    <div className="page requests-page">
      <header className="page-head">
        <div className="page-title-wrap">
          <Icon name="inbox" size={28} className="page-icon" />
          <h1>{manager ? 'Requests' : 'My requests'} <HelpLink slug="requesting" label="Requests" /></h1>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(manager || user?.requestPermissions?.reportIssues !== false) && <Link to="/issues" className="btn"><Icon name="flag" size={16} /> Issues</Link>}
          {features.requests && canRequest && <Link to="/discover" className="btn btn-primary"><Icon name="compass" size={16} /> Discover</Link>}
        </div>
      </header>

      {manager && <Tabs value={view} onChange={setView} tabs={[{ value: 'requests', label: 'Requests' }, { value: 'blacklist', label: 'Blacklist' }]} className="arr-tabs" />}
      {view === 'blacklist' && manager ? <BlacklistPanel /> : (
        <>
          {!manager && <QuotaPills quotas={quota.data} />}
          <div className="toolbar req-filters" role="toolbar" aria-label="Filter requests">
            <div className="chip-row">
              <button className={`chip ${status === '' ? 'active' : ''}`} onClick={() => setStatus('')} aria-pressed={status === ''}>All</button>
              {STATUSES.map((s) => (
                <button key={s} className={`chip ${status === s ? 'active' : ''}`} onClick={() => setStatus(s)} aria-pressed={status === s} style={{ textTransform: 'capitalize' }}>{s}</button>
              ))}
            </div>
          </div>
          <div className="req-toolbar">
            <select className="select" value={mediaType} onChange={(e) => setMediaType(e.target.value as RequestMediaType | '')} aria-label="Type">
              <option value="">All types</option>
              <option value="movie">Movies</option>
              <option value="show">Shows</option>
              <option value="artist">Music</option>
              <option value="book">Books</option>
            </select>
            {manager && user?.isAdmin && (
              <select className="select" value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Requested by">
                <option value="">Everyone</option>
                {(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.displayName || u.username}</option>)}
              </select>
            )}
            <select className="select" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort">
              <option value="requested">Newest requests</option>
              <option value="updated">Recently updated</option>
              <option value="title">Title</option>
              <option value="status">Status</option>
            </select>
            {manager && (
              <label className="check-inline">
                <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} /> Only mine
              </label>
            )}
            <span className="grow" />
            {manager && list.length > 0 && (
              <label className="check-inline">
                <input type="checkbox" checked={list.length > 0 && list.every((r) => selected.has(r.id))} onChange={(e) => setSelected(e.target.checked ? new Set(list.map((r) => r.id)) : new Set())} /> Select all
              </label>
            )}
          </div>
          {manager && selList.length > 0 && (
            <div className="users-bulkbar" role="region" aria-label="Bulk actions">
              <strong>{selList.length} selected</strong>
              <span className="grow" />
              <button className="btn btn-sm btn-primary" disabled={busy === 'bulk'} onClick={() => void bulk('approve', selList.filter((r) => ['pending', 'failed', 'declined'].includes(r.status)))}><Icon name="check" size={14} /> Approve</button>
              <button className="btn btn-sm" disabled={busy === 'bulk'} onClick={() => { setReason(''); setDeclining(selList); }}><Icon name="x" size={14} /> Decline</button>
              <button className="btn btn-sm" disabled={busy === 'bulk'} onClick={() => { setAlsoArr(false); setDeleting(selList); }}><Icon name="trash" size={14} /> Delete</button>
            </div>
          )}

          {res.loading && !res.data ? (
            <ul className="req-list">{[0, 1, 2].map((i) => <Skeleton key={i} h={96} />)}</ul>
          ) : res.error ? (
            <ErrorState message={res.error} onRetry={res.reload} />
          ) : !list.length ? (
            <EmptyState
              icon="inbox"
              title={status ? `No ${status} requests` : 'No requests yet'}
              message={!features.requests ? 'Requests are turned off on this server.' : !canRequest ? "You can't request titles. Ask your server admin for request permissions." : <>Find something to watch on <Link className="link-strong" to="/discover">Discover</Link> and request it.</>}
            />
          ) : (
            <ul className="req-list">
              {list.map((r) => (
                <RequestRow
                  key={r.id}
                  r={r}
                  manager={manager}
                  mine={r.requestedBy.id === user?.id}
                  busy={busy === r.id}
                  selected={selected.has(r.id)}
                  onSelect={(on) => setSelected((s) => {
                    const n = new Set(s);
                    if (on) n.add(r.id);
                    else n.delete(r.id);
                    return n;
                  })}
                  onApprove={setApproving}
                  onQuickApprove={(x) => void quickApprove(x)}
                  onDecline={(x) => { setReason(''); setDeclining([x]); }}
                  onDelete={(x) => { setAlsoArr(false); setDeleting([x]); }}
                  onOpen={openDetail}
                />
              ))}
            </ul>
          )}
        </>
      )}

      <ApproveModal req={approving} onClose={() => setApproving(null)} onDone={(r) => { replace(r); setApproving(null); }} />
      <RequestDetail id={detailId} onClose={() => openDetail(null)} onChanged={replace} />

      <Modal
        open={!!declining}
        onClose={() => setDeclining(null)}
        title={declining?.length === 1 ? `Decline "${declining[0].title}"` : `Decline ${declining?.length ?? 0} requests`}
        size="sm"
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setDeclining(null)}>Cancel</button>
            <button className="btn btn-danger" onClick={() => void decline()} disabled={!!busy}>Decline</button>
          </>
        }
      >
        <Field label="Reason" hint="Optional. The requester sees this and gets a notification.">
          <textarea className="textarea" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Already available on another service" autoFocus />
        </Field>
      </Modal>

      <Modal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={withdraw ? `Withdraw request for "${deleting?.[0]?.title}"?` : deleting?.length === 1 ? `Delete request for "${deleting[0].title}"?` : `Delete ${deleting?.length ?? 0} requests?`}
        size="sm"
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setDeleting(null)}>Cancel</button>
            <button className="btn btn-danger" onClick={() => void remove()}>{withdraw ? 'Withdraw' : 'Delete'}</button>
          </>
        }
      >
        <p className="muted" style={{ marginTop: 0 }}>{withdraw ? 'The admins will no longer see it.' : 'The request and its timeline are removed. Files in your libraries are not touched.'}</p>
        {manager && arrDeletable && <Switch checked={alsoArr} onChange={setAlsoArr} label="Also remove from Radarr/Sonarr" hint="Stops monitoring and downloading. Files already downloaded are kept." />}
      </Modal>
    </div>
  );
}
