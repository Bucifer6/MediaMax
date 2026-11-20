import type { ScheduledTask } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useToast } from '../state/toast';
import { useAsync, useServerEvent } from '../hooks';
import { Badge, EmptyState, ErrorState, ProgressBar, Skeleton } from '../components/ui';
import { Icon } from '../components/Icon';
import { relativeTime } from '../utils/format';
import { AdminHeader } from './AdminRoutes';

function interval(min: number | null) {
  if (!min) return 'Manual';
  if (min % 1440 === 0) return `Every ${min / 1440 === 1 ? 'day' : `${min / 1440} days`}`;
  if (min % 60 === 0) return `Every ${min / 60 === 1 ? 'hour' : `${min / 60} hours`}`;
  return `Every ${min} min`;
}

export function TasksAdmin() {
  const toast = useToast();
  const tasks = useAsync(() => api.admin.tasks(), []);
  useServerEvent((ev) => {
    if (ev.type === 'task.updated') tasks.setData((l) => (l ?? []).some((t) => t.id === ev.task.id) ? (l ?? []).map((t) => (t.id === ev.task.id ? ev.task : t)) : [...(l ?? []), ev.task]);
  });
  const run = async (t: ScheduledTask) => {
    try {
      await api.admin.runTask(t.id);
      tasks.setData((l) => (l ?? []).map((x) => (x.id === t.id ? { ...x, running: true, progress: 0 } : x)));
      toast.success(`${t.name} started`);
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div>
      <AdminHeader title="Scheduled tasks" subtitle="Background jobs that keep libraries, guides and recordings fresh." actions={<button className="btn" onClick={tasks.reload}><Icon name="refresh" size={16} /> Refresh</button>} />
      {tasks.loading && !tasks.data ? <Skeleton h={300} /> : tasks.error ? <ErrorState message={tasks.error} onRetry={tasks.reload} /> : !tasks.data?.length ? <EmptyState icon="clock" title="No tasks" /> : (
        <div className="task-list">
          {tasks.data.map((t) => (
            <div key={t.id} className="task-card">
              <div className="task-info">
                <strong>{t.name}</strong>
                <p className="muted">{t.description}</p>
                <div className="task-meta">
                  <span><Icon name="clock" size={13} /> {interval(t.intervalMinutes)}</span>
                  <span>Last run {relativeTime(t.lastRunAt)}{t.lastDurationMs != null ? ` · took ${(t.lastDurationMs / 1000).toFixed(1)}s` : ''}</span>
                  {t.lastResult && <Badge tone={t.lastResult === 'ok' ? 'success' : 'danger'}>{t.lastResult}</Badge>}
                </div>
                {t.lastError && <p className="form-error">{t.lastError}</p>}
                {t.running && <ProgressBar value={t.progress != null ? (t.progress <= 1 ? t.progress * 100 : t.progress) : 0} className={t.progress == null ? 'indeterminate' : ''} />}
              </div>
              <button className="btn btn-sm" onClick={() => run(t)} disabled={t.running}>
                <Icon name={t.running ? 'refresh' : 'play'} size={14} className={t.running ? 'spin' : ''} /> {t.running ? 'Running' : 'Run now'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
