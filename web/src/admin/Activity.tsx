import { useEffect, useRef, useState } from 'react';
import type { ActivityEntry } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { EmptyState, ErrorState, Skeleton, Spinner, Tabs } from '../components/ui';
import { Icon } from '../components/Icon';
import { formatDateTime } from '../utils/format';
import { AdminHeader } from './AdminRoutes';
import { downloadDiagnostics } from '../api/help';
import { useToast } from '../state/toast';

const PAGE = 50;

/** Download a ZIP with versions, hardware, settings (secrets removed) and recent logs, for bug reports. */
function DiagnosticsButton() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await downloadDiagnostics();
      toast.success('Diagnostics downloaded. Passwords, keys and tokens were removed; check the files before sharing.');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="btn" onClick={() => void run()} disabled={busy} title="Versions, hardware, settings without secrets, and recent logs">
      {busy ? <Spinner size={16} /> : <Icon name="download" size={16} />} Download diagnostics
    </button>
  );
}

function Logs() {
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const ref = useRef<HTMLPreElement>(null);
  const load = () => {
    setError(null);
    api.system.logs(1000).then((r) => setLines(r.lines)).catch((e) => setError((e as Error).message));
  };
  useEffect(load, []);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!lines) return <Skeleton h={400} />;
  const shown = filter ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase())) : lines;
  return (
    <div>
      <div className="toolbar">
        <input className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter log lines" />
        <button className="btn btn-sm" onClick={load}><Icon name="refresh" size={14} /> Reload</button>
      </div>
      <pre className="log-view" ref={ref}>{shown.map((l, i) => <div key={i} className={/error|fatal/i.test(l) ? 'log-err' : /warn/i.test(l) ? 'log-warn' : ''}>{l}</div>)}</pre>
    </div>
  );
}

export function ActivityAdmin() {
  const [tab, setTab] = useState<'activity' | 'logs'>('activity');
  const [items, setItems] = useState<ActivityEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sev, setSev] = useState<'' | ActivityEntry['severity']>('');

  const load = async (offset: number) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.admin.activity(PAGE, offset);
      setItems((l) => (offset ? [...l, ...r.items] : r.items));
      setTotal(r.total);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load(0);
  }, []);

  const shown = sev ? items.filter((i) => i.severity === sev) : items;
  return (
    <div>
      <AdminHeader help="admin-updates" title="Activity & logs" actions={<DiagnosticsButton />} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'activity', label: 'Activity' }, { value: 'logs', label: 'Server log' }]} />
      {tab === 'logs' ? <Logs /> : (
        <>
          <div className="toolbar">
            <div className="segmented">
              {(['', 'info', 'warning', 'error'] as const).map((s) => <button key={s} className={sev === s ? 'active' : ''} onClick={() => setSev(s)}>{s || 'All'}</button>)}
            </div>
            <button className="btn btn-sm" onClick={() => load(0)}><Icon name="refresh" size={14} /> Refresh</button>
          </div>
          {loading && !items.length ? <Skeleton h={300} /> : error && !items.length ? <ErrorState message={error} onRetry={() => load(0)} /> : !shown.length ? <EmptyState icon="activity" title="No activity" /> : (
            <ul className="activity-list">
              {shown.map((a) => (
                <li key={a.id} className={`sev-${a.severity}`}>
                  <span className="activity-dot" />
                  <div className="activity-body">
                    <span className="activity-msg">{a.message}</span>
                    <span className="muted">{a.type}{a.userName ? ` · ${a.userName}` : ''}</span>
                  </div>
                  <span className="muted activity-time">{formatDateTime(a.at)}</span>
                </li>
              ))}
            </ul>
          )}
          {items.length < total && <div className="center-pad"><button className="btn" onClick={() => load(items.length)} disabled={loading}>{loading ? <Spinner size={16} /> : 'Load more'}</button></div>}
        </>
      )}
    </div>
  );
}
