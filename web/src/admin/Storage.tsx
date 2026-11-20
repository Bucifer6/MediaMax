import { useEffect, useState } from 'react';
import type { DiskPowerState, StorageSettings, StorageStatus } from '@mediamax/shared';
import { smartHomeApi } from '../api/smarthome';
import { useToast } from '../state/toast';
import { useAsync } from '../hooks';
import { Badge, ErrorState, Field, Skeleton, Spinner, Switch } from '../components/ui';
import { Icon } from '../components/Icon';
import { relativeTime } from '../utils/format';
import { AdminHeader } from './AdminRoutes';

const DISK_TONE: Record<DiskPowerState, 'success' | 'muted' | 'primary' | 'warning'> = { active: 'success', idle: 'primary', standby: 'muted', unknown: 'warning' };
const DISK_LABEL: Record<DiskPowerState, string> = { active: 'Active', idle: 'Idle', standby: 'Standby (asleep)', unknown: 'Unknown' };

function fmtTime(iso: string | null) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

export function StorageAdmin() {
  const toast = useToast();
  const status = useAsync(() => smartHomeApi.storage(), []);
  const [s, setS] = useState<StorageSettings | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (status.data) setS(status.data.settings);
  }, [status.data]);
  const set = (p: Partial<StorageSettings>) => setS((x) => (x ? { ...x, ...p } : x));
  const dirty = !!s && !!status.data && JSON.stringify(s) !== JSON.stringify(status.data.settings);
  const st: StorageStatus | undefined = status.data;

  const save = async () => {
    if (!s) return;
    setSaving(true);
    try {
      status.setData(await smartHomeApi.saveStorage(s));
      toast.success('Storage settings saved');
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };
  const runDeferred = async () => {
    try {
      await smartHomeApi.runDeferred();
      toast.success('Running postponed work now (this wakes the disks)');
      window.setTimeout(() => status.reload(), 1500);
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div>
      <AdminHeader
        title="Storage & disk spin-down"
        subtitle="Let NAS hard drives sleep when nobody is watching: background work waits for a maintenance window or for a disk that is awake anyway."
        actions={
          <>
            <button className="btn" onClick={status.reload}><Icon name="refresh" size={16} /> Refresh</button>
            <button className="btn btn-primary" onClick={save} disabled={!dirty || saving}>{saving ? <Spinner size={18} /> : 'Save changes'}</button>
          </>
        }
      />
      {status.loading && !st ? <Skeleton h={320} /> : status.error ? <ErrorState message={status.error} onRetry={status.reload} /> : st && s ? (
        <>
          <div className="settings-card">
            <h2><Icon name="clock" size={18} /> Disk-friendly mode</h2>
            <div className="form-grid">
              <Switch checked={s.diskFriendly} onChange={(v) => set({ diskFriendly: v })} label="Only touch media disks in the maintenance window"
                hint="Library scans, thumbnails, scrub previews, intro detection, DJ analysis, subtitle matching and HDR detection wait for the window. Playback, manual “Run now” and file-change detection are never held back." />
              <div className="form-row">
                <Field label="Window starts" hint={`Server time (${st.timeZone}).`}>
                  <input className="input" type="time" value={s.windowStart} onChange={(e) => set({ windowStart: e.target.value })} disabled={!s.diskFriendly} />
                </Field>
                <Field label="Window ends" hint="May wrap past midnight (e.g. 23:00–04:00).">
                  <input className="input" type="time" value={s.windowEnd} onChange={(e) => set({ windowEnd: e.target.value })} disabled={!s.diskFriendly} />
                </Field>
              </div>
              <Switch checked={s.piggyback} onChange={(v) => set({ piggyback: v })} label="Piggyback on awake disks"
                hint="When someone starts a stream from a disk (or files change on it), run that disk’s postponed work while it is spinning anyway." />
              <Switch checked={s.checkDiskState} onChange={(v) => set({ checkDiskState: v })} label="Check whether disks are asleep (Linux)"
                hint="Uses hdparm -C or smartctl -n standby when installed and permitted — both answer without waking the disk. Outside disk-friendly mode, sleeping disks are skipped by scheduled work." />
              <div className="form-row">
                <Field label="Detect new files" hint="Native uses inotify / FSEvents and never polls. Use polling only for network shares where native watching can’t see changes.">
                  <select className="select" value={s.watchMode} onChange={(e) => set({ watchMode: e.target.value as StorageSettings['watchMode'] })}>
                    <option value="native">Native file-change notifications (recommended)</option>
                    <option value="poll">Poll folder timestamps (network shares)</option>
                    <option value="off">Off — scheduled scans only</option>
                  </select>
                </Field>
                <Field label="Poll every (minutes)" hint="At least 60. Polling reads folder listings, which wakes disks.">
                  <input className="input" type="number" min={60} step={30} value={s.pollIntervalMinutes} disabled={s.watchMode !== 'poll'} onChange={(e) => set({ pollIntervalMinutes: Number(e.target.value) || 60 })} />
                </Field>
              </div>
            </div>
            <dl className="kv-list">
              <dt>Window</dt>
              <dd>{!st.settings.diskFriendly ? <span className="muted">Disk-friendly mode is off</span> : st.inWindow ? <Badge tone="success">Open now</Badge> : <><Badge tone="muted">Closed</Badge><span className="muted">opens {fmtTime(st.nextWindowAt)}</span></>}</dd>
              <dt>Postponed</dt>
              <dd>
                {st.deferred.length ? st.deferred.map((d) => <Badge key={d.taskId} tone="warning">{d.name} · since {relativeTime(d.since)}{d.doneDisks.length ? ` · ${d.doneDisks.length} disk(s) done` : ''}</Badge>) : <span className="muted">Nothing waiting</span>}
                {st.piggybackRunning && <Badge tone="primary">Running for {st.piggybackRunning}</Badge>}
                {st.deferred.length > 0 && <button className="btn btn-sm" onClick={runDeferred}><Icon name="play" size={14} /> Run now</button>}
              </dd>
            </dl>
          </div>

          <div className="settings-card">
            <h2><Icon name="database" size={18} /> Libraries &amp; disks</h2>
            {!st.tools.mountinfo && <p className="muted">Disk detection needs Linux (/proc/self/mountinfo). On this system each library folder is treated as its own disk.</p>}
            {st.tools.mountinfo && !st.tools.hdparm && !st.tools.smartctl && <p className="muted">Neither <code>hdparm</code> nor <code>smartctl</code> is available, so standby can’t be confirmed; “Idle” means no disk I/O for 10 minutes (from /sys, which never wakes a disk).</p>}
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Library</th><th>Folder</th><th>Mount</th><th>Disks</th><th>State</th><th>Watch</th></tr></thead>
                <tbody>
                  {st.libraries.flatMap((l) => (l.paths.length ? l.paths : [null]).map((p, i) => (
                    <tr key={`${l.id}-${i}`}>
                      <td>{i === 0 ? <strong>{l.name}</strong> : null}</td>
                      <td><code>{p?.path ?? '—'}</code></td>
                      <td>{p?.mountPoint ? <><code>{p.mountPoint}</code> <span className="muted">{p.fsType}{p.network ? ' · network' : ''}</span></> : <span className="muted">—</span>}</td>
                      <td>{p?.disks.length ? p.disks.map((d) => <span key={d.name} title={d.method ? `via ${d.method}` : undefined}><code>{d.name}</code>{d.rotational === false ? ' (SSD)' : ''} </span>) : <span className="muted">{p?.network ? 'Network share' : 'Unknown'}</span>}</td>
                      <td>{p ? <Badge tone={DISK_TONE[p.state]}>{DISK_LABEL[p.state]}</Badge> : null}</td>
                      <td>{i === 0 ? (l.watch.mode === 'native' ? <span title={l.watch.error ?? undefined}>{l.watch.directories} folders{l.watch.error ? <> · <span className="form-error">{l.watch.error}</span></> : null}</span> : <span className="muted">{l.watch.mode === 'poll' ? 'Polling' : 'Off'}</span>) : null}</td>
                    </tr>
                  )))}
                  {!st.libraries.length && <tr><td colSpan={6} className="muted">No libraries yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="settings-card guidance">
            <h2><Icon name="server" size={18} /> Keep MediaMax’s own files on an SSD</h2>
            <p className="muted">Artwork, thumbnails, scrub previews, downloaded subtitles and the database live in the data folder; transcodes in the transcode folder. Media-folder artwork is copied there on first view, so browsing never wakes a media disk.</p>
            <dl className="kv-list">
              <dt>Data folder</dt><dd><code>{st.dataDir}</code></dd>
              <dt>Transcode folder</dt><dd><code>{st.transcodeDir}</code></dd>
            </dl>
            <p className="muted">Synology: put these on an SSD volume. Unraid: use the cache pool (<code>/mnt/cache/appdata</code>, not <code>/mnt/user</code>). TrueNAS: an SSD pool or the boot pool’s app dataset. Map media folders to array disks read-only if you can.</p>
          </div>
        </>
      ) : null}
    </div>
  );
}
