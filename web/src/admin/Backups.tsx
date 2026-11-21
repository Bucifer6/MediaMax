import { useEffect, useRef, useState } from 'react';
import type { BackupInfo, ServerSettings } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { API_BASE, ApiRequestError, withToken } from '../api/client';
import { useToast } from '../state/toast';
import { useAsync } from '../hooks';
import { Badge, EmptyState, ErrorState, Field, Modal, Skeleton, Spinner, useConfirm } from '../components/ui';
import { Icon } from '../components/Icon';
import { formatBytes, formatDateTime, relativeTime } from '../utils/format';
import { AdminHeader } from './AdminRoutes';

const REASONS: Record<string, { label: string; tone: 'primary' | 'muted' | 'warning' }> = {
  manual: { label: 'Manual', tone: 'primary' },
  scheduled: { label: 'Scheduled', tone: 'muted' },
  'pre-restore': { label: 'Before restore', tone: 'warning' },
};

/** "Restart now" → POST /admin/restart, then wait for the server to go away and come back, and reload. */
export function RestartPanel({ message }: { message: string }) {
  const toast = useToast();
  const [phase, setPhase] = useState<'idle' | 'restarting' | 'stuck'>('idle');
  useEffect(() => {
    if (phase !== 'restarting') return;
    let stopped = false;
    let sawDown = false;
    const started = Date.now();
    const tick = async () => {
      if (stopped) return;
      let up = false;
      try {
        up = (await fetch(`${API_BASE}/system/info`, { cache: 'no-store' })).ok;
      } catch {
        up = false;
      }
      if (stopped) return;
      if (!up) sawDown = true;
      const elapsed = Date.now() - started;
      // Back after going away, or never seemed to go away (a very quick restart).
      if (up && (sawDown || elapsed > 15000)) {
        location.reload();
        return;
      }
      if (elapsed > 120000) {
        setPhase('stuck');
        return;
      }
      window.setTimeout(tick, 1500);
    };
    const t = window.setTimeout(tick, 1500);
    return () => {
      stopped = true;
      window.clearTimeout(t);
    };
  }, [phase]);

  const restart = async () => {
    setPhase('restarting');
    try {
      await api.admin.restart();
    } catch (e) {
      // The server may drop the connection as it exits; only a real error response stops us.
      if (e instanceof ApiRequestError && e.status !== 0 && e.status < 500) {
        toast.error(e);
        setPhase('idle');
      }
    }
  };

  return (
    <div className="restart-banner" role="status" aria-live="polite">
      <Icon name={phase === 'stuck' ? 'alert' : 'refresh'} size={20} className={phase === 'restarting' ? 'spin' : ''} />
      <div className="restart-text">
        {phase === 'idle' && <><strong>Restart required.</strong> <span>{message}</span></>}
        {phase === 'restarting' && <><strong>Restarting…</strong> <span>This page reloads once Kinora is back.</span></>}
        {phase === 'stuck' && <><strong>The server hasn’t come back yet.</strong> <span>Kinora restarts itself only under Docker (with a restart policy) or systemd — start it manually if needed.</span></>}
      </div>
      {phase === 'idle' && <button className="btn btn-primary" onClick={restart}><Icon name="refresh" size={16} /> Restart now</button>}
      {phase === 'restarting' && <Spinner size={20} />}
      {phase === 'stuck' && <button className="btn" onClick={() => location.reload()}>Reload page</button>}
    </div>
  );
}

/** Restoring replaces everything, so ask the admin to type a word to confirm. */
function RestoreConfirm({ open, what, onCancel, onConfirm }: { open: boolean; what: string; onCancel: () => void; onConfirm: () => void }) {
  const [text, setText] = useState('');
  useEffect(() => {
    if (open) setText('');
  }, [open]);
  const ok = text.trim().toLowerCase() === 'restore';
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="Restore this backup?"
      size="sm"
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn btn-danger" disabled={!ok} onClick={onConfirm}>Restore</button>
        </>
      }
    >
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); if (ok) onConfirm(); }}>
        <p>Restoring <strong>{what}</strong> replaces <strong>all</strong> current users, settings, watch history, playlists and library data with the backup’s copy when the server next starts.</p>
        <p className="muted">A “before restore” backup of the current state is taken first, so you can go back.</p>
        <Field label={<>Type <code>restore</code> to confirm</>}>
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" spellCheck={false} autoFocus />
        </Field>
      </form>
    </Modal>
  );
}

function ScheduleCard() {
  const toast = useToast();
  const settings = useAsync(() => api.admin.settings(), []);
  const [b, setB] = useState<ServerSettings['backups'] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (settings.data) setB(settings.data.backups ?? { intervalDays: 7, keep: 5 });
  }, [settings.data]);
  if (settings.error) return <div className="settings-card"><p className="form-error">{settings.error}</p></div>;
  if (!b || !settings.data) return <div className="settings-card"><Skeleton h={90} /></div>;
  const dirty = b.intervalDays !== settings.data.backups?.intervalDays || b.keep !== settings.data.backups?.keep;
  const save = async () => {
    setBusy(true);
    try {
      settings.setData(await api.admin.saveSettingsPatch({ backups: b }));
      toast.success('Backup schedule saved');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-card">
      <h2>Automatic backups</h2>
      <p className="muted">Backups include the database, settings, branding, avatars and plugins — not your media files, caches or transcodes.</p>
      <div className="form-row">
        <Field label="Back up every (days)" hint="0 turns automatic backups off.">
          <input className="input" type="number" min={0} max={365} value={b.intervalDays} onChange={(e) => setB({ ...b, intervalDays: Math.max(0, Math.floor(Number(e.target.value)) || 0) })} />
        </Field>
        <Field label="Keep the newest" hint="Older automatic backups are deleted. Manual backups are kept.">
          <input className="input" type="number" min={1} max={100} value={b.keep} onChange={(e) => setB({ ...b, keep: Math.max(1, Math.floor(Number(e.target.value)) || 1) })} />
        </Field>
      </div>
      <div className="form-actions">
        <button className="btn btn-primary" onClick={save} disabled={!dirty || busy}>{busy ? <Spinner size={16} /> : 'Save schedule'}</button>
      </div>
    </div>
  );
}

export function BackupsAdmin() {
  const toast = useToast();
  const confirm = useConfirm();
  const backups = useAsync(() => api.admin.backups(), []);
  const [creating, setCreating] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<{ kind: 'backup'; backup: BackupInfo } | { kind: 'file'; file: File } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const create = async () => {
    setCreating(true);
    try {
      const b = await api.admin.createBackup();
      backups.setData((l) => [b, ...(l ?? []).filter((x) => x.id !== b.id)]);
      toast.success('Backup created');
    } catch (e) {
      toast.error(e);
    } finally {
      setCreating(false);
    }
  };
  const remove = async (b: BackupInfo) => {
    if (!(await confirm({ title: 'Delete this backup?', message: `${formatDateTime(b.createdAt)} · ${formatBytes(b.sizeBytes)}. This can’t be undone.`, confirmLabel: 'Delete backup', danger: true }))) return;
    try {
      await api.admin.removeBackup(b.id);
      backups.setData((l) => (l ?? []).filter((x) => x.id !== b.id));
    } catch (e) {
      toast.error(e);
    }
  };
  const doRestore = async () => {
    const t = restoreTarget;
    if (!t) return;
    setRestoreTarget(null);
    setRestoring(true);
    try {
      const r = t.kind === 'backup' ? await api.admin.restoreBackup(t.backup.id) : await api.admin.restoreUpload(t.file);
      if (r.restartRequired) setRestartNeeded(true);
      toast.success('Restore staged — restart Kinora to apply it');
      backups.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div>
      <AdminHeader help="admin-backups"
        title="Backups"
        subtitle="Snapshots of your server’s database and settings."
        actions={
          <>
            <button className="btn" onClick={() => fileInput.current?.click()} disabled={restoring}><Icon name="upload" size={16} /> Restore from file</button>
            <button className="btn btn-primary" onClick={create} disabled={creating}>{creating ? <Spinner size={16} /> : <Icon name="database" size={16} />} Back up now</button>
          </>
        }
      />
      <input
        ref={fileInput}
        type="file"
        accept=".gz,.tgz,.tar.gz,application/gzip"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) setRestoreTarget({ kind: 'file', file: f });
        }}
      />
      {restartNeeded && <RestartPanel message="The restore is applied when Kinora next starts." />}
      {restoring && <div className="restart-banner"><Spinner size={18} /> <span>Uploading and checking the backup…</span></div>}
      {backups.loading && !backups.data ? <Skeleton h={200} /> : backups.error ? <ErrorState message={backups.error} onRetry={backups.reload} /> : !backups.data?.length ? (
        <EmptyState icon="database" title="No backups yet" message="Create one now, or turn on automatic backups below." />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Date</th><th>Size</th><th>Type</th><th /></tr></thead>
            <tbody>
              {backups.data.map((b) => {
                const r = REASONS[b.reason] ?? { label: b.reason, tone: 'muted' as const };
                return (
                  <tr key={b.id}>
                    <td>
                      <strong>{formatDateTime(b.createdAt)}</strong>
                      <div className="muted">{relativeTime(b.createdAt)}</div>
                    </td>
                    <td>{formatBytes(b.sizeBytes)}</td>
                    <td><Badge tone={r.tone}>{r.label}</Badge></td>
                    <td className="td-actions">
                      <div className="row-gap row-end">
                        <a className="btn btn-sm" href={withToken(api.admin.backupDownloadUrl(b.id))} download aria-label={`Download backup from ${formatDateTime(b.createdAt)}`}><Icon name="download" size={14} /> <span className="hide-sm">Download</span></a>
                        <button className="btn btn-sm" onClick={() => setRestoreTarget({ kind: 'backup', backup: b })} disabled={restoring}><Icon name="refresh" size={14} /> <span className="hide-sm">Restore this backup</span></button>
                        <button className="btn-icon" onClick={() => remove(b)} aria-label="Delete backup" title="Delete"><Icon name="trash" size={16} /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <ScheduleCard />
      <RestoreConfirm
        open={!!restoreTarget}
        what={restoreTarget?.kind === 'backup' ? `the backup from ${formatDateTime(restoreTarget.backup.createdAt)}` : restoreTarget?.kind === 'file' ? restoreTarget.file.name : ''}
        onCancel={() => setRestoreTarget(null)}
        onConfirm={doRestore}
      />
    </div>
  );
}
