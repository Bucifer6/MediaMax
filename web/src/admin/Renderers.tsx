import { useEffect, useState } from 'react';
import type { ManualRendererRequest, RendererAdminView, RendererSettings } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useToast } from '../state/toast';
import { useAsync } from '../hooks';
import { Badge, ErrorState, Field, Skeleton, Spinner, Switch } from '../components/ui';
import { Icon } from '../components/Icon';
import { relativeTime } from '../utils/format';
import { RENDERER_KIND_LABEL } from '../player/renderers';
import { AdminHeader } from './AdminRoutes';

/** Admin → Play to devices: DLNA / Sonos / Kodi renderers Vibe can send media to. */
export function RenderersAdmin() {
  const toast = useToast();
  const view = useAsync(() => api.renderers.admin(), []);
  const [s, setS] = useState<RendererSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<'kodi' | 'dlna'>('kodi');
  const [form, setForm] = useState<ManualRendererRequest>({ kind: 'kodi', host: '', port: 8080, username: '', password: '', descriptionUrl: '', name: '' });

  useEffect(() => {
    if (view.data) setS(view.data.settings);
  }, [view.data]);

  const v = view.data;
  const dirty = !!v && !!s && JSON.stringify(v.settings) !== JSON.stringify(s);
  const apply = (next: RendererAdminView) => {
    view.setData(next);
    setS(next.settings);
  };

  const save = async () => {
    if (!s) return;
    setSaving(true);
    try {
      apply(await api.renderers.saveSettings({ ...s, streamBaseUrl: s.streamBaseUrl?.trim() || null }));
      toast.success('Play to settings saved');
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };
  const search = async () => {
    setSearching(true);
    try {
      await api.renderers.discover();
      apply(await api.renderers.admin());
    } catch (e) {
      toast.error(e);
    } finally {
      setSearching(false);
    }
  };
  const add = async () => {
    setAdding(true);
    try {
      const body: ManualRendererRequest = kind === 'kodi'
        ? { kind, host: form.host?.trim(), port: Number(form.port) || 8080, username: form.username?.trim() || undefined, password: form.password || undefined, name: form.name?.trim() || undefined }
        : { kind, descriptionUrl: form.descriptionUrl?.trim(), name: form.name?.trim() || undefined };
      apply(await api.renderers.addManual(body));
      setForm({ ...form, host: '', password: '', descriptionUrl: '', name: '' });
      toast.success('Device added');
    } catch (e) {
      toast.error(e);
    } finally {
      setAdding(false);
    }
  };
  const remove = async (id: string) => {
    try {
      apply(await api.renderers.removeManual(id));
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div>
      <AdminHeader help="play-to-devices"
        title="Play to devices"
        subtitle="Send movies, shows and music from Vibe to TVs, speakers and Kodi boxes on your network."
        actions={
          <>
            <button className="btn" onClick={search} disabled={searching || !s?.enabled}><Icon name="refresh" size={16} className={searching ? 'spin' : ''} /> Search network</button>
            <button className="btn btn-primary" onClick={save} disabled={!dirty || saving}>{saving ? <Spinner size={18} /> : 'Save changes'}</button>
          </>
        }
      />
      {view.error ? <ErrorState message={view.error} onRetry={view.reload} /> : !v || !s ? <Skeleton h={220} /> : (
        <>
          <div className="settings-card">
            <h2>Settings</h2>
            <div className="form-grid">
              <Switch checked={s.enabled} onChange={(x) => setS({ ...s, enabled: x })} label="Enable Play to devices" hint="Find DLNA / UPnP TVs and receivers, Sonos speakers and Kodi on the local network and list them in every player’s cast menu." />
              <Switch checked={s.mdns} onChange={(x) => setS({ ...s, mdns: x })} disabled={!s.enabled} label="Find Kodi automatically (mDNS)" hint="Kodi announces its remote-control interface over Bonjour/mDNS. Turn off if you only use manually added Kodi boxes." />
              <Field label="Stream address for devices" hint="Devices fetch streams from this address. Leave empty to use this server’s LAN address. Set it if Vibe runs in Docker with port mapping or has several network cards.">
                <input className="input" value={s.streamBaseUrl ?? ''} onChange={(e) => setS({ ...s, streamBaseUrl: e.target.value })} placeholder="http://192.168.1.10:8484" spellCheck={false} autoCapitalize="none" disabled={!s.enabled} />
              </Field>
              <Switch checked={s.allowPublicHosts} onChange={(x) => setS({ ...s, allowPublicHosts: x })} disabled={!s.enabled} label="Allow devices outside private address ranges" hint="Off (recommended): manually added devices must be on 10.x, 172.16–31.x, 192.168.x or similar private addresses." />
            </div>
          </div>

          <div className="settings-card">
            <h2>Devices</h2>
            <p className="muted">{v.lastDiscoveryAt ? `Last searched ${relativeTime(v.lastDiscoveryAt)}.` : 'Not searched yet.'} Discovery uses SSDP{s.mdns ? ' and mDNS' : ''} and only works when Vibe shares the devices’ network (in Docker: host networking).</p>
            {v.renderers.length ? (
              <ul className="renderer-admin-list">
                {v.renderers.map((r) => (
                  <li key={r.id}>
                    <Icon name={r.kind === 'sonos' ? 'volume' : r.kind === 'kodi' ? 'monitor' : 'tv'} size={20} />
                    <div className="renderer-admin-text">
                      <strong>{r.name}</strong>
                      <small className="muted">{[RENDERER_KIND_LABEL[r.kind], r.manufacturer === RENDERER_KIND_LABEL[r.kind] ? null : r.manufacturer, r.model, r.host].filter(Boolean).join(' · ')}</small>
                    </div>
                    {r.nowPlaying && <Badge tone="primary">{r.nowPlaying.state} · {r.nowPlaying.userName}</Badge>}
                    {!r.supportsVideo && <Badge tone="muted">Audio only</Badge>}
                    {r.manual ? <Badge tone="accent">Added manually</Badge> : <Badge tone={r.online ? 'success' : 'muted'}>{r.online ? 'Found' : 'Not seen recently'}</Badge>}
                    {r.manual && v.manual.some((m) => m.id === r.id) && (
                      <button className="btn-icon" onClick={() => void remove(r.id)} aria-label={`Remove ${r.name}`}><Icon name="trash" size={18} /></button>
                    )}
                  </li>
                ))}
              </ul>
            ) : <p className="muted">No devices found yet.</p>}
          </div>

          <div className="settings-card">
            <h2>Add a device manually</h2>
            <div className="form-grid">
              <Field label="Type">
                <select className="input" value={kind} onChange={(e) => setKind(e.target.value as 'kodi' | 'dlna')}>
                  <option value="kodi">Kodi (JSON-RPC)</option>
                  <option value="dlna">DLNA / UPnP renderer or Sonos (description URL)</option>
                </select>
              </Field>
              <Field label="Name (optional)"><input className="input" value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={kind === 'kodi' ? 'Living room Kodi' : 'Bedroom TV'} /></Field>
              {kind === 'kodi' ? (
                <>
                  <Field label="Host or IP address" hint="In Kodi: Settings → Services → Control → Allow remote control via HTTP.">
                    <input className="input" value={form.host ?? ''} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="192.168.1.30" spellCheck={false} autoCapitalize="none" />
                  </Field>
                  <Field label="Port"><input className="input" type="number" min={1} max={65535} value={form.port ?? 8080} onChange={(e) => setForm({ ...form, port: Number(e.target.value) })} /></Field>
                  <Field label="Username"><input className="input" value={form.username ?? ''} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" placeholder="kodi" /></Field>
                  <Field label="Password"><input className="input" type="password" value={form.password ?? ''} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" /></Field>
                </>
              ) : (
                <Field label="Device description URL" hint="The LOCATION the device announces, e.g. http://192.168.1.20:1400/xml/device_description.xml for Sonos.">
                  <input className="input" value={form.descriptionUrl ?? ''} onChange={(e) => setForm({ ...form, descriptionUrl: e.target.value })} placeholder="http://192.168.1.20:1400/xml/device_description.xml" spellCheck={false} autoCapitalize="none" />
                </Field>
              )}
            </div>
            <button className="btn btn-primary" onClick={add} disabled={adding || !s.enabled || (kind === 'kodi' ? !form.host?.trim() : !form.descriptionUrl?.trim())}>
              {adding ? <Spinner size={18} /> : <Icon name="plus" size={16} />} Add device
            </button>
          </div>

          <div className="settings-card guidance">
            <h2><Icon name="shield" size={18} /> How streams reach devices</h2>
            <p className="muted">TVs and speakers can’t sign in, so each stream they receive uses a signed link that works for one item, only from your local network, and only while that playback runs. Playback counts toward the user’s stream limit, shows on the dashboard and updates their watch progress.</p>
          </div>
        </>
      )}
    </div>
  );
}
