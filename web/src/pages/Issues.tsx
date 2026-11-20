import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Issue, IssueStatus } from '@mediamax/shared';
import { seerrApi } from '../api/seerr';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useAsync } from '../hooks';
import { Badge, EmptyState, ErrorState, Img, Skeleton, Spinner, useConfirm } from '../components/ui';
import { Icon } from '../components/Icon';
import { ArrItemActions } from '../components/ArrItemActions';
import { ISSUE_KINDS } from '../components/ReportIssue';
import { formatDateTime, relativeTime } from '../utils/format';
import { canManageRequests, notifyIssuesChanged } from '../utils/requests';
import '../styles/requests.css';

const kindOf = (k: string) => ISSUE_KINDS.find((x) => x.value === k) ?? ISSUE_KINDS[3];
const where = (i: Issue) => (i.season != null ? (i.episode != null ? `S${String(i.season).padStart(2, '0')}E${String(i.episode).padStart(2, '0')}` : `Season ${i.season}`) : null);

function IssueList() {
  const { user } = useApp();
  const manager = canManageRequests(user);
  const [status, setStatus] = useState<IssueStatus | ''>('open');
  const [kind, setKind] = useState('');
  const list = useAsync(() => seerrApi.issues({ status: status || undefined, kind: kind || undefined }), [status, kind]);
  return (
    <div className="page issues-page">
      <header className="page-head">
        <div className="page-title-wrap">
          <Icon name="flag" size={28} className="page-icon" />
          <h1>{manager ? 'Issues' : 'My issues'}</h1>
        </div>
        <Link to="/requests" className="btn"><Icon name="inbox" size={16} /> Requests</Link>
      </header>
      <div className="req-toolbar">
        <div className="chip-row">
          {(['open', 'resolved', ''] as const).map((s) => (
            <button key={s || 'all'} className={`chip ${status === s ? 'active' : ''}`} aria-pressed={status === s} onClick={() => setStatus(s)}>{s ? s[0].toUpperCase() + s.slice(1) : 'All'}</button>
          ))}
        </div>
        <select className="select" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Problem type">
          <option value="">All problems</option>
          {ISSUE_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
      </div>
      {list.loading && !list.data ? <Skeleton h={160} /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : !list.data?.length ? (
        <EmptyState icon="flag" title={status === 'open' ? 'No open issues' : 'No issues'} message="Use “Report issue” on a title's page when something doesn't play right — wrong audio, missing subtitles, a bad copy." />
      ) : (
        <ul className="issue-list">
          {list.data.map((i) => (
            <li key={i.id}>
              <Link to={`/issues/${i.id}`} className="issue-row">
                <span className="issue-poster"><Img src={i.posterUrl} width={110} alt="" fallback={<Icon name="film" size={18} />} /></span>
                <div style={{ minWidth: 0 }}>
                  <div className="issue-title">
                    {i.title} {where(i) && <span className="muted">{where(i)}</span>}
                    <Badge tone="muted"><Icon name={kindOf(i.kind).icon} size={11} /> {kindOf(i.kind).label}</Badge>
                  </div>
                  <p className="issue-msg">{i.message}</p>
                  <small className="muted">{manager ? `${i.createdBy?.displayName ?? 'Someone'} · ` : ''}{relativeTime(i.createdAt)}{i.commentCount ? ` · ${i.commentCount} comment${i.commentCount === 1 ? '' : 's'}` : ''}</small>
                </div>
                <Badge tone={i.status === 'open' ? 'warning' : 'success'}>{i.status}</Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function IssueDetail({ id }: { id: string }) {
  const { user } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const manager = canManageRequests(user);
  const issue = useAsync(() => seerrApi.issue(id), [id]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const i = issue.data;
  const run = async (fn: () => Promise<Issue>) => {
    setBusy(true);
    try {
      issue.setData(await fn());
      notifyIssuesChanged();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await confirm({ title: 'Delete this issue?', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await seerrApi.deleteIssue(id);
      notifyIssuesChanged();
      navigate('/issues');
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="page issues-page">
      <p><Link to="/issues" className="btn btn-sm btn-ghost"><Icon name="arrowLeft" size={14} /> Issues</Link></p>
      {issue.error ? (
        /not found/i.test(issue.error)
          ? <EmptyState icon="flag" title="Issue not found" message="It may have been deleted, or it belongs to someone else." action={<Link className="btn" to="/issues">All issues</Link>} />
          : <ErrorState message={issue.error} onRetry={issue.reload} />
      ) : !i ? <Skeleton h={240} /> : (
        <div className="issue-detail">
          <div style={{ minWidth: 0 }}>
            <header className="page-head" style={{ marginBottom: 12 }}>
              <div className="page-title-wrap">
                <Icon name={kindOf(i.kind).icon} size={26} className="page-icon" />
                <h1 style={{ fontSize: '1.5rem' }}>{kindOf(i.kind).label} issue · {i.title}{where(i) ? ` ${where(i)}` : ''}</h1>
              </div>
            </header>
            <ol className="timeline">
              <li className="tl-comment">
                <span className="tl-dot k-comment"><Icon name="flag" size={13} /></span>
                <div className="tl-body"><div><strong>{i.createdBy?.displayName ?? 'Someone'}</strong> reported <span className="muted" title={formatDateTime(i.createdAt)}>· {relativeTime(i.createdAt)}</span></div><p>{i.message}</p></div>
              </li>
              {(i.comments ?? []).map((c) => (
                <li key={c.id} className="tl-comment">
                  <span className="tl-dot k-comment"><Icon name="info" size={13} /></span>
                  <div className="tl-body"><div><strong>{c.user?.displayName ?? 'Someone'}</strong> <span className="muted" title={formatDateTime(c.createdAt)}>· {relativeTime(c.createdAt)}</span></div><p>{c.body}</p></div>
                </li>
              ))}
              {i.status === 'resolved' && (
                <li>
                  <span className="tl-dot k-available"><Icon name="check" size={13} /></span>
                  <div className="tl-body"><div><strong>{i.resolvedBy?.displayName ?? 'Someone'}</strong> resolved this <span className="muted">· {relativeTime(i.resolvedAt)}</span></div></div>
                </li>
              )}
            </ol>
            <div className="comment-box">
              <textarea className="textarea" rows={2} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply…" aria-label="Reply" />
              <button className="btn btn-primary" disabled={busy || !text.trim()} onClick={() => void run(async () => {
                const out = await seerrApi.commentIssue(id, text.trim());
                setText('');
                return out;
              })}>{busy ? <Spinner size={16} /> : 'Send'}</button>
            </div>
          </div>
          <aside className="issue-side">
            {i.posterUrl && <div className="issue-poster" style={{ width: 90 }}><Img src={i.posterUrl} width={180} alt="" /></div>}
            <dl>
              <dt>Status</dt><dd><Badge tone={i.status === 'open' ? 'warning' : 'success'}>{i.status}</Badge></dd>
              <dt>Title</dt><dd>{i.rootItemId ? <Link className="link-strong" to={`/item/${i.itemId ?? i.rootItemId}`}>{i.title}</Link> : i.title}</dd>
              {where(i) && <><dt>Where</dt><dd>{where(i)}</dd></>}
              <dt>Problem</dt><dd>{kindOf(i.kind).label}</dd>
              <dt>Reported</dt><dd>{i.createdBy?.displayName ?? '—'}, {formatDateTime(i.createdAt)}</dd>
            </dl>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {i.status === 'open'
                ? (manager || i.createdBy?.id === user?.id) && <button className="btn btn-primary" disabled={busy} onClick={() => void run(() => seerrApi.resolveIssue(id))}><Icon name="check" size={16} /> Resolve</button>
                : <button className="btn" disabled={busy} onClick={() => void run(() => seerrApi.reopenIssue(id))}><Icon name="refresh" size={16} /> Reopen</button>}
              {(manager || (i.createdBy?.id === user?.id && !i.commentCount)) && <button className="btn btn-ghost" onClick={() => void remove()}><Icon name="trash" size={16} /> Delete</button>}
            </div>
            {i.rootItemId && manager && (
              <div>
                <ArrItemActions item={{ id: i.itemId ?? i.rootItemId, type: (i.itemId && i.season != null && i.episode != null ? 'episode' : i.mediaType) as never }} />
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

export default function IssuesPage() {
  const { issueId } = useParams();
  return issueId ? <IssueDetail id={issueId} /> : <IssueList />;
}
