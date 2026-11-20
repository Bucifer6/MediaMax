import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ArrCalendarEntry, ArrHealthSection, ArrInstanceRef, ArrKind, ArrListResponse, ArrQueueItem, ArrSection, ArrWantedEntry } from '@mediamax/shared';
import { arrApi } from '../api/arr';
import { useAsync } from '../hooks';
import { useToast } from '../state/toast';
import { Badge, EmptyState, ErrorState, ProgressBar, Skeleton, Spinner, Tabs } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';
import { formatBytes, formatDate, formatDateTime, relativeTime } from '../utils/format';
import { AdminHeader } from './AdminRoutes';
import '../styles/arr.css';

type Tab = 'queue' | 'calendar' | 'wanted';

export const ARR_ICON: Record<ArrKind, IconName> = { radarr: 'film', sonarr: 'shows', lidarr: 'music', readarr: 'book', bazarr: 'subtitles' };
export const ARR_NAME: Record<ArrKind, string> = { radarr: 'Radarr', sonarr: 'Sonarr', lidarr: 'Lidarr', readarr: 'Readarr', bazarr: 'Bazarr' };

function InstanceTag({ i }: { i: ArrInstanceRef }) {
  return (
    <span className={`arr-tag arr-tag-${i.kind}`} title={`${ARR_NAME[i.kind]}${i.is4k ? ' (4K)' : ''}`}>
      <Icon name={ARR_ICON[i.kind]} size={13} /> {i.name}{i.is4k && <b>4K</b>}
    </span>
  );
}

/** Red card for an instance that couldn't be reached; the rest of the page keeps working. */
function SectionErrors<T>({ data }: { data?: ArrListResponse<T> }) {
  const bad = (data?.sections ?? []).filter((s) => !s.ok);
  if (!bad.length) return null;
  return (
    <div className="arr-errors">
      {bad.map((s) => (
        <div key={s.instance.id} className="arr-error-card" role="alert">
          <Icon name="alert" size={18} />
          <div><strong>{s.instance.name}</strong> <span className="muted">({ARR_NAME[s.instance.kind]})</span><p>{s.error}</p></div>
        </div>
      ))}
    </div>
  );
}

/** "01:02:03" or "1.02:03:04" → "1 h 2 min" */
function timeLeft(t: string | null): string {
  if (!t) return '—';
  const m = t.match(/^(?:(\d+)\.)?(\d+):(\d+):(\d+)/);
  if (!m) return t;
  const d = Number(m[1] ?? 0), h = Number(m[2]), min = Number(m[3]), s = Number(m[4]);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${min} min`;
  if (min) return `${min} min`;
  return `${s} s`;
}

function HealthCard({ s }: { s: ArrHealthSection }) {
  const problems = s.checks.filter((c) => c.type !== 'ok');
  return (
    <div className={`arr-health ${!s.ok ? 'is-down' : problems.some((c) => c.type === 'error') ? 'is-error' : problems.length ? 'is-warn' : 'is-ok'}`}>
      <div className="arr-health-head">
        <Icon name={ARR_ICON[s.instance.kind]} size={18} />
        <strong>{s.instance.name}</strong>
        {s.instance.is4k && <Badge tone="accent">4K</Badge>}
        <span className="arr-health-state">{!s.ok ? 'Unreachable' : problems.length ? `${problems.length} issue${problems.length > 1 ? 's' : ''}` : 'Healthy'}</span>
      </div>
      <div className="muted arr-health-sub">
        {ARR_NAME[s.instance.kind]}{s.version ? ` ${s.version}` : ''} · <a href={s.instance.url} target="_blank" rel="noreferrer" className="link-strong">Open <Icon name="external" size={11} /></a>
      </div>
      {!s.ok && <p className="arr-health-error">{s.error}</p>}
      {problems.length > 0 && (
        <ul className="arr-checks">
          {problems.slice(0, 4).map((c, i) => (
            <li key={i} className={`sev-${c.type}`}>
              <Icon name="alert" size={13} />
              <span>{c.wikiUrl ? <a href={c.wikiUrl} target="_blank" rel="noreferrer">{c.message}</a> : c.message}</span>
            </li>
          ))}
          {problems.length > 4 && <li className="muted">+{problems.length - 4} more</li>}
        </ul>
      )}
      {s.disks.length > 0 && (
        <div className="arr-disks">
          {s.disks.slice(0, 3).map((d) => {
            const used = d.totalSpace ? Math.round(((d.totalSpace - d.freeSpace) / d.totalSpace) * 100) : 0;
            return (
              <div key={d.path} className="arr-disk" title={`${d.path}: ${formatBytes(d.freeSpace)} free of ${formatBytes(d.totalSpace)}`}>
                <div className="arr-disk-label"><span className="mono">{d.label || d.path}</span><span className="muted">{formatBytes(d.freeSpace)} free</span></div>
                <ProgressBar value={used} className={used > 90 ? 'arr-disk-full' : ''} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function QueueTable({ data }: { data: ArrListResponse<ArrQueueItem> }) {
  const rows = data.sections.flatMap((s) => s.items.map((q) => ({ q, i: s.instance })));
  if (!rows.length) return <EmptyState icon="download" title="Nothing downloading" message="Grabbed releases show up here with their progress." />;
  return (
    <div className="table-wrap">
      <table className="table arr-queue">
        <thead>
          <tr><th>Title</th><th>Instance</th><th>Quality</th><th style={{ minWidth: 150 }}>Progress</th><th>Status</th></tr>
        </thead>
        <tbody>
          {rows.map(({ q, i }) => (
            <tr key={`${i.id}:${q.id}`}>
              <td>
                <div className="arr-title">{q.title}</div>
                {q.subtitle && <div className="muted arr-sub">{q.subtitle}</div>}
                {q.warnings.length > 0 && (
                  <ul className="arr-warnings">{q.warnings.slice(0, 3).map((w, n) => <li key={n}><Icon name="alert" size={12} /> {w}</li>)}</ul>
                )}
              </td>
              <td><InstanceTag i={i} /></td>
              <td>{q.quality ?? '—'}</td>
              <td>
                <div className="arr-progress"><ProgressBar value={q.progress} /><span>{Math.round(q.progress)}%</span></div>
                <div className="muted arr-sub nowrap">{formatBytes(q.size)}{q.timeLeft ? ` · ${timeLeft(q.timeLeft)} left` : ''}</div>
              </td>
              <td>
                <Badge tone={q.warnings.length ? 'warning' : q.status === 'downloading' ? 'primary' : q.status === 'completed' ? 'success' : 'muted'} className="arr-status">{q.status}</Badge>
                <div className="muted arr-sub">{[q.trackedState && q.trackedState !== q.status ? q.trackedState.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() : null, q.downloadClient].filter(Boolean).join(' · ')}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CalendarList({ data }: { data: ArrListResponse<ArrCalendarEntry> }) {
  const days = useMemo(() => {
    const all = data.sections.flatMap((s) => s.items.map((e) => ({ e, i: s.instance })));
    all.sort((a, b) => a.e.date.localeCompare(b.e.date));
    const out = new Map<string, typeof all>();
    for (const x of all) {
      const k = new Date(x.e.date).toDateString();
      out.set(k, [...(out.get(k) ?? []), x]);
    }
    return [...out.entries()];
  }, [data]);
  if (!days.length) return <EmptyState icon="calendar" title="Nothing coming up" message="Monitored releases for the next 14 days appear here." />;
  return (
    <div className="arr-calendar">
      {days.map(([k, list]) => (
        <section key={k} className="arr-day">
          <h3>{formatDate(list[0].e.date, { weekday: 'long', month: 'short', day: 'numeric' })}</h3>
          <ul>
            {list.map(({ e, i }) => (
              <li key={`${i.id}:${e.id}:${e.date}`}>
                <Icon name={ARR_ICON[i.kind]} size={16} />
                <div className="arr-cal-main">
                  <div className="arr-title">{e.title}</div>
                  <div className="muted arr-sub">{[e.subtitle, e.releaseType].filter(Boolean).join(' · ')}{i.kind === 'sonarr' ? ` · ${formatDateTime(e.date).split(',').pop()?.trim()}` : ''}</div>
                </div>
                <InstanceTag i={i} />
                {e.hasFile ? <Badge tone="success"><Icon name="check" size={12} /> Downloaded</Badge> : !e.monitored ? <Badge tone="muted">Unmonitored</Badge> : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function WantedList({ data, onSearch, busy }: { data: ArrListResponse<ArrWantedEntry>; onSearch: (s: ArrSection<ArrWantedEntry>, ids: number[], label: string) => void; busy: string | null }) {
  const sections = data.sections.filter((s) => s.ok && s.items.length);
  if (!sections.length) return <EmptyState icon="check" title="Nothing missing" message="Monitored titles without a file appear here." />;
  return (
    <div className="arr-wanted">
      {sections.map((s) => (
        <section key={s.instance.id} className="arr-wanted-section">
          <header>
            <InstanceTag i={s.instance} />
            <span className="muted">{s.items.length} missing</span>
            <button className="btn btn-sm" onClick={() => onSearch(s, s.items.map((x) => x.id), `${s.items.length} items`)} disabled={busy === `${s.instance.id}:all`}>
              {busy === `${s.instance.id}:all` ? <Spinner size={14} /> : <Icon name="search" size={14} />} Search all
            </button>
          </header>
          <ul>
            {s.items.map((w) => (
              <li key={w.id}>
                <div className="arr-cal-main">
                  <div className="arr-title">{w.title}</div>
                  <div className="muted arr-sub">{[w.subtitle, w.date ? formatDate(w.date) : null].filter(Boolean).join(' · ')}</div>
                </div>
                <button className="btn btn-sm" onClick={() => onSearch(s, [w.id], w.title)} disabled={busy === `${s.instance.id}:${w.id}`} aria-label={`Search for ${w.title}`}>
                  {busy === `${s.instance.id}:${w.id}` ? <Spinner size={14} /> : <Icon name="search" size={14} />} Search
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function DownloadsAdmin() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('queue');
  const [busy, setBusy] = useState<string | null>(null);
  const health = useAsync(() => arrApi.health(), []);
  const queue = useAsync(() => arrApi.queue(), []);
  const calendar = useAsync(async () => (tab === 'calendar' ? arrApi.calendar(14) : undefined), [tab]);
  const wanted = useAsync(async () => (tab === 'wanted' ? arrApi.wanted() : undefined), [tab]);

  // Live refresh of the queue every 10 s while the page is open and visible.
  const { setData: setQueue } = queue;
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      arrApi.queue().then((q) => setQueue(q)).catch(() => undefined);
    }, 10000);
    return () => window.clearInterval(t);
  }, [setQueue]);

  const search = async (s: ArrSection<ArrWantedEntry>, ids: number[], label: string) => {
    const key = `${s.instance.id}:${ids.length > 1 ? 'all' : ids[0]}`;
    setBusy(key);
    try {
      await arrApi.search(s.instance.id, { ids });
      toast.success(`${s.instance.name} is searching for ${label}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const refresh = () => {
    health.reload();
    queue.reload();
    if (tab === 'calendar') calendar.reload();
    if (tab === 'wanted') wanted.reload();
  };

  const none = health.data && health.data.sections.length === 0;
  const downloading = queue.data?.sections.reduce((n, s) => n + s.items.length, 0) ?? 0;

  return (
    <div className="arr-dashboard">
      <AdminHeader
        title="Downloads"
        subtitle="Queue, upcoming releases and missing titles across your Radarr, Sonarr, Lidarr and Readarr instances."
        actions={
          <>
            <Link to="/admin/settings?tab=arr" className="btn"><Icon name="settings" size={16} /> Instances</Link>
            <button className="btn" onClick={refresh} disabled={queue.loading && !!queue.data}><Icon name="refresh" size={16} /> Refresh</button>
          </>
        }
      />
      {health.error ? (
        <ErrorState message={health.error} onRetry={health.reload} />
      ) : none ? (
        <EmptyState icon="download" title="No *arr apps connected" message={<>Add Radarr, Sonarr, Lidarr, Readarr or Bazarr in <Link className="link-strong" to="/admin/settings?tab=arr">Server settings → Media automation</Link>.</>} />
      ) : (
        <>
          <div className="arr-health-grid">
            {!health.data ? [0, 1, 2].map((i) => <Skeleton key={i} h={120} r={16} />) : health.data.sections.map((s) => <HealthCard key={s.instance.id} s={s} />)}
          </div>
          <Tabs<Tab> value={tab} onChange={setTab} className="arr-tabs" tabs={[
            { value: 'queue', label: <>Queue{downloading ? <span className="arr-count">{downloading}</span> : null}</> },
            { value: 'calendar', label: 'Calendar' },
            { value: 'wanted', label: 'Wanted' },
          ]} />
          {tab === 'queue' && (
            <div aria-live="polite">
              <SectionErrors data={queue.data} />
              {queue.error ? <ErrorState message={queue.error} onRetry={queue.reload} /> : !queue.data ? <Skeleton h={220} r={16} /> : <QueueTable data={queue.data} />}
              {queue.data && <p className="muted arr-updated">Updated {relativeTime(queue.data.fetchedAt)} · refreshes every 10 seconds</p>}
            </div>
          )}
          {tab === 'calendar' && (
            <>
              <SectionErrors data={calendar.data} />
              {calendar.error ? <ErrorState message={calendar.error} onRetry={calendar.reload} /> : !calendar.data ? <Skeleton h={220} r={16} /> : <CalendarList data={calendar.data} />}
            </>
          )}
          {tab === 'wanted' && (
            <>
              <SectionErrors data={wanted.data} />
              {wanted.error ? <ErrorState message={wanted.error} onRetry={wanted.reload} /> : !wanted.data ? <Skeleton h={220} r={16} /> : <WantedList data={wanted.data} onSearch={(s, ids, l) => void search(s, ids, l)} busy={busy} />}
            </>
          )}
        </>
      )}
    </div>
  );
}
