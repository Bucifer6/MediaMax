import { useEffect, useRef, useState } from 'react';
import type { UpdateStatus } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { API_BASE, ApiRequestError } from '../api/client';
import { useToast } from '../state/toast';
import { useAsync, useServerEvent } from '../hooks';
import { Badge, ErrorState, ProgressBar, Skeleton, Spinner, Switch, useConfirm } from '../components/ui';
import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { formatDateTime, relativeTime } from '../utils/format';
import { AdminHeader } from './AdminRoutes';

/** After Update now: wait for the server to go away and come back on the new version, then reload. */
function useWaitForVersion(target: string | null) {
  const [phase, setPhase] = useState<'idle' | 'waiting' | 'stuck'>('idle');
  useEffect(() => {
    if (!target) return;
    setPhase('waiting');
    let stopped = false;
    const started = Date.now();
    const tick = async () => {
      if (stopped) return;
      try {
        const r = await fetch(`${API_BASE}/system/info`, { cache: 'no-store' });
        if (r.ok && (await r.json()).version === target) {
          location.reload();
          return;
        }
      } catch {
        /* down while setup runs */
      }
      if (Date.now() - started > 10 * 60000) {
        setPhase('stuck');
        return;
      }
      window.setTimeout(tick, 3000);
    };
    const t = window.setTimeout(tick, 3000);
    return () => {
      stopped = true;
      window.clearTimeout(t);
    };
  }, [target]);
  return phase;
}

const INSTALL_LABEL: Record<UpdateStatus['install'], string> = {
  'windows-setup': 'Windows (setup program)',
  'windows-portable': 'Windows (portable zip)',
  linux: 'Linux binary',
  docker: 'Docker container',
  source: 'Source checkout',
};

export function UpdatesAdmin() {
  const toast = useToast();
  const confirm = useConfirm();
  const status = useAsync(() => api.admin.updates(), []);
  const settings = useAsync(() => api.admin.settings(), []);
  const [busy, setBusy] = useState<'check' | 'install' | null>(null);
  const [waitFor, setWaitFor] = useState<string | null>(null);
  const phase = useWaitForVersion(waitFor);
  const checkedOnce = useRef(false);
  useServerEvent((ev) => {
    if (ev.type === 'update.status') status.setData(ev.status);
  });

  // Opening the page with no check yet (new install, or automatic checks off): look once.
  useEffect(() => {
    if (status.data && !status.data.checkedAt && !checkedOnce.current) {
      checkedOnce.current = true;
      void api.admin.checkUpdates().then(status.setData).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.data]);

  const check = async () => {
    setBusy('check');
    try {
      const s = await api.admin.checkUpdates();
      status.setData(s);
      if (s.lastError) toast.error(s.lastError);
      else toast.success(s.updateAvailable ? `Vibe ${s.latest?.version} is available` : 'Vibe is up to date');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const install = async () => {
    const s = status.data;
    if (!s?.latest) return;
    const ok = await confirm({
      title: `Update to Vibe ${s.latest.version}?`,
      message: 'Vibe downloads the new version, checks it, installs it and restarts. Playback stops for a minute or two; your library, users and settings are kept. If Vibe runs as the tray app, Windows asks for permission first.',
      confirmLabel: 'Update now',
    });
    if (!ok) return;
    setBusy('install');
    try {
      const r = await api.admin.installUpdate();
      status.setData(r);
      setWaitFor(s.latest.version);
    } catch (e) {
      // Setup may stop the server before the answer arrives.
      if (e instanceof ApiRequestError && e.status === 0) setWaitFor(s.latest.version);
      else toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const setAutoCheck = async (on: boolean) => {
    if (!settings.data) return;
    try {
      settings.setData(await api.admin.saveSettingsPatch({ updates: { ...settings.data.updates, autoCheck: on } }));
      status.setData((s) => (s ? { ...s, autoCheck: on } : s));
    } catch (e) {
      toast.error(e);
    }
  };
  const setPrereleases = async (on: boolean) => {
    if (!settings.data) return;
    try {
      settings.setData(await api.admin.saveSettingsPatch({ updates: { ...settings.data.updates, includePrereleases: on } }));
    } catch (e) {
      toast.error(e);
    }
  };

  const s = status.data;
  return (
    <div>
      <AdminHeader
        title="Updates"
        subtitle="New versions of Vibe from GitHub releases."
        help="admin-updates"
        actions={<button className="btn" onClick={check} disabled={!!busy || s?.state !== 'idle'}>{busy === 'check' || s?.state === 'checking' ? <Spinner size={16} /> : <Icon name="refresh" size={16} />} Check now</button>}
      />
      {status.loading && !s ? <Skeleton h={220} /> : status.error ? <ErrorState message={status.error} onRetry={status.reload} /> : s && (
        <>
          {(waitFor || s.state === 'installing') && (
            <div className="restart-banner" role="status" aria-live="polite">
              <Icon name={phase === 'stuck' ? 'alert' : 'refresh'} size={20} className={phase === 'stuck' ? '' : 'spin'} />
              <div className="restart-text">
                {phase === 'stuck'
                  ? <><strong>Vibe hasn’t come back on the new version yet.</strong> <span>Check the Windows setup log in %TEMP% (Setup Log *.txt), or run the setup program from the release page by hand.</span></>
                  : <><strong>Installing Vibe {s.latest?.version}…</strong> <span>Vibe stops, updates and starts again. This page reloads when it is back.</span></>}
              </div>
              {phase === 'stuck' ? <button className="btn" onClick={() => location.reload()}>Reload page</button> : <Spinner size={20} />}
            </div>
          )}

          <div className="settings-card">
            <h2>Version</h2>
            <dl className="kv-list">
              <dt>This server</dt><dd><strong>{s.currentVersion}</strong> <span className="muted">· {INSTALL_LABEL[s.install]}</span></dd>
              <dt>Latest release</dt>
              <dd>
                {s.latest ? <><strong>{s.latest.version}</strong>{s.latest.prerelease && <> <Badge tone="warning">Pre-release</Badge></>} {s.updateAvailable ? <Badge tone="new">Update available</Badge> : <Badge tone="success">Up to date</Badge>}</> : <span className="muted">Not checked yet</span>}
              </dd>
              <dt>Last checked</dt><dd>{s.checkedAt ? <span title={formatDateTime(s.checkedAt)}>{relativeTime(s.checkedAt)}</span> : <span className="muted">Never</span>}</dd>
            </dl>
            {s.lastError && <p className="form-error"><Icon name="alert" size={14} /> {s.lastError}</p>}

            {s.updateAvailable && s.latest && (
              <div className="form-actions">
                {s.canSelfUpdate ? (
                  <button className="btn btn-primary" onClick={install} disabled={!!busy || s.state !== 'idle' || !!waitFor}>
                    {s.state === 'downloading' || busy === 'install' ? <Spinner size={16} /> : <Icon name="download" size={16} />} Update now to {s.latest.version}
                  </button>
                ) : null}
                <a className="btn" href={s.latest.url} target="_blank" rel="noreferrer"><Icon name="external" size={16} /> Release page</a>
              </div>
            )}
            {s.state === 'downloading' && (
              <div className="update-progress">
                <ProgressBar value={(s.progress ?? 0) * 100} label="Download progress" />
                <span className="muted">Downloading {Math.round((s.progress ?? 0) * 100)}%</span>
              </div>
            )}
            {s.updateAvailable && !s.canSelfUpdate && s.manualSteps && (
              <div className="update-manual">
                <h3>How to update this server</h3>
                <Markdown source={s.manualSteps} />
              </div>
            )}
          </div>

          {s.updateAvailable && s.latest?.notes && (
            <div className="settings-card">
              <h2>What’s new in {s.latest.name}</h2>
              {s.latest.publishedAt && <p className="muted">Released {formatDateTime(s.latest.publishedAt)}</p>}
              <Markdown source={s.latest.notes} />
            </div>
          )}

          <div className="settings-card">
            <h2>Checking for updates</h2>
            <Switch checked={s.autoCheck} onChange={setAutoCheck} disabled={!settings.data} label="Check for new versions automatically" hint="Every 12 hours. Updates are only installed when you press Update now." />
            <Switch checked={!!settings.data?.updates.includePrereleases} onChange={setPrereleases} disabled={!settings.data} label="Include pre-releases" hint="Offer test versions (for example 1.2.0-beta.1) as well." />
          </div>
        </>
      )}
    </div>
  );
}
