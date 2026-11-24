import type React from 'react';
import { useEffect, useState } from 'react';
import type { RemoteAccessStatus, ServerSettings } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useAsync } from '../hooks';
import { Badge, ErrorState, Field, Skeleton, Spinner, Switch } from '../components/ui';
import { Icon } from '../components/Icon';
import { relativeTime } from '../utils/format';
import { AdminHeader } from './AdminRoutes';

function StatusRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (<><dt>{label}</dt><dd>{children}</dd></>);
}

function UpnpStatus({ st }: { st: RemoteAccessStatus }) {
  const u = st.upnp;
  const tone = !u.enabled ? 'muted' : u.mapped ? 'success' : u.error ? 'danger' : 'warning';
  const label = !u.enabled ? 'Off' : u.mapped ? 'Port forwarded' : u.error ? 'Not working' : 'Waiting';
  return (
    <dl className="kv-list">
      <StatusRow label="UPnP"><Badge tone={tone}>{label}</Badge></StatusRow>
      <StatusRow label="Router">{u.router ?? <span className="muted">Not found</span>}</StatusRow>
      <StatusRow label="External address">
        {u.externalIp ? <code>{u.externalIp}{u.externalPort ? `:${u.externalPort}` : ''}</code> : <span className="muted">Unknown</span>}
      </StatusRow>
      {u.error && <StatusRow label="Error"><span className="form-error">{u.error}</span></StatusRow>}
      <StatusRow label="Last checked">{u.lastCheckedAt ? relativeTime(u.lastCheckedAt) : <span className="muted">Never</span>}</StatusRow>
    </dl>
  );
}

export function RemoteAccessAdmin() {
  const toast = useToast();
  const { refreshSystem } = useApp();
  const status = useAsync(() => api.admin.remoteAccess(), []);
  const settings = useAsync(() => api.admin.settings(), []);
  const [publicUrl, setPublicUrl] = useState('');
  const [ra, setRa] = useState<ServerSettings['remoteAccess']>({ upnp: false, externalPort: null });
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!settings.data) return;
    setPublicUrl(settings.data.publicUrl ?? '');
    setRa(settings.data.remoteAccess ?? { upnp: false, externalPort: null });
  }, [settings.data]);

  const saved = settings.data;
  const dirty = !!saved && ((saved.publicUrl ?? '') !== publicUrl.trim() || !!saved.remoteAccess?.upnp !== ra.upnp || (saved.remoteAccess?.externalPort ?? null) !== ra.externalPort);

  const refresh = async () => {
    setRefreshing(true);
    try {
      status.setData(await api.admin.refreshRemoteAccess());
    } catch (e) {
      toast.error(e);
    } finally {
      setRefreshing(false);
    }
  };
  const save = async () => {
    setSaving(true);
    try {
      settings.setData(await api.admin.saveSettingsPatch({ publicUrl: publicUrl.trim().replace(/\/+$/, '') || null, remoteAccess: ra }));
      toast.success('Remote access settings saved');
      void refreshSystem();
      // Give the server a moment to apply the UPnP change, then show the new status.
      window.setTimeout(() => void refresh(), 800);
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };

  const st = status.data;
  return (
    <div>
      <AdminHeader help="admin-network"
        title="Remote access"
        subtitle="Reach your server from outside your home network."
        actions={
          <>
            <button className="btn" onClick={refresh} disabled={refreshing}><Icon name="refresh" size={16} className={refreshing ? 'spin' : ''} /> Refresh</button>
            <button className="btn btn-primary" onClick={save} disabled={!dirty || saving}>{saving ? <Spinner size={18} /> : 'Save changes'}</button>
          </>
        }
      />
      <div className="settings-card">
        <h2>Status</h2>
        {status.loading && !st ? <Skeleton h={140} /> : status.error ? <ErrorState message={status.error} onRetry={status.reload} /> : st ? (
          <div className="remote-grid">
            <dl className="kv-list">
              <StatusRow label="Local address"><code>{st.lanAddress}:{st.port}</code></StatusRow>
              <StatusRow label="Public URL">{st.publicUrl ? <a href={st.publicUrl} target="_blank" rel="noreferrer" className="link-strong">{st.publicUrl} <Icon name="external" size={12} /></a> : <span className="muted">Not set</span>}</StatusRow>
            </dl>
            <UpnpStatus st={st} />
          </div>
        ) : null}
      </div>

      <div className="settings-card">
        <h2>Settings</h2>
        {!saved ? (settings.error ? <p className="form-error">{settings.error}</p> : <Skeleton h={160} />) : (
          <div className="form-grid">
            <Field label="Public URL" hint="The address people use from outside, e.g. your reverse proxy’s HTTPS address. Used for invite links, apps, casting and webhooks.">
              <input className="input" value={publicUrl} onChange={(e) => setPublicUrl(e.target.value)} placeholder="https://media.example.com" spellCheck={false} autoCapitalize="none" />
            </Field>
            <Switch checked={ra.upnp} onChange={(v) => setRa({ ...ra, upnp: v })} label="Forward a port automatically (UPnP)" hint="Asks your router to open a port to Vibe. Many routers have UPnP off by default." />
            <Field label="External port" hint={`Leave empty to use the same port as the server${st ? ` (${st.port})` : ''}.`}>
              <input className="input" type="number" min={1} max={65535} value={ra.externalPort ?? ''} placeholder={st ? String(st.port) : 'Same as server'} disabled={!ra.upnp}
                onChange={(e) => setRa({ ...ra, externalPort: e.target.value === '' ? null : Math.min(65535, Math.max(1, Math.floor(Number(e.target.value)) || 1)) })} />
            </Field>
          </div>
        )}
      </div>

      <div className="settings-card guidance">
        <h2><Icon name="shield" size={18} /> Use HTTPS</h2>
        <p>UPnP exposes Vibe over plain HTTP, so passwords and streams travel unencrypted. For anything beyond a quick test, put Vibe behind a reverse proxy that handles HTTPS, then set the Public URL above to its address. With <a href="https://caddyserver.com" target="_blank" rel="noreferrer" className="link-strong">Caddy <Icon name="external" size={12} /></a> this is a two-line config and certificates are automatic:</p>
        <pre className="code-block"><code>{`media.example.com {
  reverse_proxy 127.0.0.1:${st?.port ?? 8484}
}`}</code></pre>
        <p className="muted">Point a DNS record for your domain at your home IP and forward ports 80 and 443 to the machine running Caddy (instead of using UPnP). Turning on two-factor authentication for admin accounts is strongly recommended once the server is reachable from the internet.</p>
        <h2><Icon name="server" size={18} /> Running in Docker?</h2>
        <p className="muted">UPnP discovery needs to reach your router, which only works with host networking (<code>network_mode: host</code> in docker-compose, or <code>--network host</code>). With the default bridge network the router won’t be found — forward the port on your router manually instead.</p>
      </div>
    </div>
  );
}
