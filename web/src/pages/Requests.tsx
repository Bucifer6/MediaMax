import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { MediaRequest, RequestStatus } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useAsync } from '../hooks';
import { Badge, EmptyState, ErrorState, Field, Img, Modal, Skeleton, Spinner, useConfirm } from '../components/ui';
import { Icon } from '../components/Icon';
import { formatDateTime, relativeTime } from '../utils/format';
import { notifyRequestsChanged, REQUEST_STATUS_TONE } from '../utils/requests';

const STATUSES: RequestStatus[] = ['pending', 'approved', 'processing', 'available', 'declined', 'failed'];

function RequestRow({
  r, isAdmin, mine, busy, onApprove, onDecline, onDelete,
}: {
  r: MediaRequest; isAdmin: boolean; mine: boolean; busy: boolean;
  onApprove: (r: MediaRequest) => void; onDecline: (r: MediaRequest) => void; onDelete: (r: MediaRequest) => void;
}) {
  const poster = <Img src={r.posterUrl} width={120} alt="" fallback={<Icon name={r.mediaType === 'show' ? 'shows' : 'film'} size={20} />} />;
  return (
    <li className="req-row">
      {r.itemId ? <Link to={`/item/${r.itemId}`} className="req-poster" tabIndex={-1}>{poster}</Link> : <span className="req-poster">{poster}</span>}
      <div className="req-info">
        <div className="req-title">
          {r.itemId ? <Link to={`/item/${r.itemId}`}>{r.title}</Link> : r.title}
          {r.year && <span className="muted">({r.year})</span>}
          <Badge tone="muted">{r.mediaType === 'show' ? 'TV' : 'Movie'}</Badge>
        </div>
        <div className="muted req-sub">
          {r.mediaType === 'show' && <span>{r.seasons.length ? `Season${r.seasons.length > 1 ? 's' : ''} ${r.seasons.join(', ')}` : 'All seasons'} · </span>}
          {isAdmin && !mine && <span>{r.requestedBy.displayName} · </span>}
          <span title={formatDateTime(r.requestedAt)}>requested {relativeTime(r.requestedAt)}</span>
          {r.decidedBy && r.decidedAt && <span> · {r.status === 'declined' ? 'declined' : 'approved'} by {r.decidedBy.displayName}</span>}
        </div>
        {r.note && <p className="req-note"><Icon name="info" size={13} /> {r.note}</p>}
        {r.error && <p className="form-error">{r.error}</p>}
      </div>
      <Badge tone={REQUEST_STATUS_TONE[r.status]} className="req-status">{r.status}</Badge>
      <div className="req-actions">
        {r.itemId && r.status === 'available' && (
          <Link to={`/item/${r.itemId}`} className="btn btn-sm btn-primary"><Icon name="play" size={14} /> View</Link>
        )}
        {isAdmin && ['pending', 'failed', 'declined'].includes(r.status) && (
          <button className="btn btn-sm btn-primary" onClick={() => onApprove(r)} disabled={busy}>
            {busy ? <Spinner size={14} /> : <Icon name="check" size={14} />} {r.status === 'pending' ? 'Approve' : 'Retry'}
          </button>
        )}
        {isAdmin && r.status === 'pending' && (
          <button className="btn btn-sm" onClick={() => onDecline(r)} disabled={busy}><Icon name="x" size={14} /> Decline</button>
        )}
        {(isAdmin || (mine && r.status === 'pending')) && (
          <button className="btn-icon" onClick={() => onDelete(r)} disabled={busy} aria-label={mine && r.status === 'pending' ? 'Withdraw request' : 'Delete request'} title={mine && r.status === 'pending' ? 'Withdraw' : 'Delete'}>
            <Icon name="trash" size={16} />
          </button>
        )}
      </div>
    </li>
  );
}

export default function RequestsPage() {
  const { user, features } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const isAdmin = !!user?.isAdmin;
  const [status, setStatus] = useState<RequestStatus | ''>(isAdmin ? 'pending' : '');
  const [mineOnly, setMineOnly] = useState(false);
  const res = useAsync(() => api.requests.list({ status: status || undefined, mine: isAdmin && mineOnly ? true : undefined }), [status, mineOnly, isAdmin]);
  const [busy, setBusy] = useState<string | null>(null);
  const [declining, setDeclining] = useState<MediaRequest | null>(null);
  const [note, setNote] = useState('');

  const replace = (r: MediaRequest) => {
    res.setData((list) => (list ?? []).map((x) => (x.id === r.id ? r : x)).filter((x) => !status || x.status === status));
    notifyRequestsChanged();
  };
  const approve = async (r: MediaRequest) => {
    setBusy(r.id);
    try {
      const out = await api.requests.approve(r.id);
      replace(out);
      if (out.status === 'failed') toast.show(`Approved, but sending to ${r.mediaType === 'movie' ? 'Radarr' : 'Sonarr'} failed: ${out.error ?? 'unknown error'}`, 'error');
      else toast.success(`Approved ${r.title}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const decline = async () => {
    if (!declining) return;
    const r = declining;
    setBusy(r.id);
    try {
      replace(await api.requests.decline(r.id, note.trim() || undefined));
      toast.success(`Declined ${r.title}`);
      setDeclining(null);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const remove = async (r: MediaRequest) => {
    const withdraw = r.requestedBy.id === user?.id && r.status === 'pending';
    if (!(await confirm({ title: withdraw ? `Withdraw request for "${r.title}"?` : `Delete request for "${r.title}"?`, confirmLabel: withdraw ? 'Withdraw' : 'Delete', danger: true }))) return;
    setBusy(r.id);
    try {
      await api.requests.remove(r.id);
      res.setData((list) => (list ?? []).filter((x) => x.id !== r.id));
      notifyRequestsChanged();
      toast.success(withdraw ? 'Request withdrawn' : 'Request deleted');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const list = res.data ?? [];
  return (
    <div className="page requests-page">
      <header className="page-head">
        <div className="page-title-wrap">
          <Icon name="inbox" size={28} className="page-icon" />
          <h1>{isAdmin ? 'Requests' : 'My requests'}</h1>
        </div>
        {features.requests && <Link to="/discover" className="btn btn-primary"><Icon name="compass" size={16} /> Discover</Link>}
      </header>

      <div className="toolbar req-filters" role="toolbar" aria-label="Filter requests">
        <div className="chip-row">
          <button className={`chip ${status === '' ? 'active' : ''}`} onClick={() => setStatus('')} aria-pressed={status === ''}>All</button>
          {STATUSES.map((s) => (
            <button key={s} className={`chip ${status === s ? 'active' : ''}`} onClick={() => setStatus(s)} aria-pressed={status === s} style={{ textTransform: 'capitalize' }}>{s}</button>
          ))}
        </div>
        {isAdmin && (
          <label className="check-inline">
            <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} /> Only mine
          </label>
        )}
      </div>

      {res.loading && !res.data ? (
        <ul className="req-list">{[0, 1, 2].map((i) => <Skeleton key={i} h={96} />)}</ul>
      ) : res.error ? (
        <ErrorState message={res.error} onRetry={res.reload} />
      ) : !list.length ? (
        <EmptyState
          icon="inbox"
          title={status ? `No ${status} requests` : 'No requests yet'}
          message={features.requests ? <>Find something to watch on <Link className="link-strong" to="/discover">Discover</Link> and request it.</> : 'Requests are turned off on this server.'}
        />
      ) : (
        <ul className="req-list">
          {list.map((r) => (
            <RequestRow
              key={r.id}
              r={r}
              isAdmin={isAdmin}
              mine={r.requestedBy.id === user?.id}
              busy={busy === r.id}
              onApprove={(x) => void approve(x)}
              onDecline={(x) => { setNote(''); setDeclining(x); }}
              onDelete={(x) => void remove(x)}
            />
          ))}
        </ul>
      )}

      <Modal
        open={!!declining}
        onClose={() => setDeclining(null)}
        title={`Decline "${declining?.title ?? ''}"`}
        size="sm"
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setDeclining(null)}>Cancel</button>
            <button className="btn btn-danger" onClick={() => void decline()} disabled={!!busy}>Decline</button>
          </>
        }
      >
        <Field label="Note" hint={`Optional. ${declining?.requestedBy.displayName ?? 'The requester'} will see this.`}>
          <textarea className="textarea" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Already available on another service" autoFocus />
        </Field>
      </Modal>
    </div>
  );
}
