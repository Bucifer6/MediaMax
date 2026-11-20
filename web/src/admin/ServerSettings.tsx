import { useEffect, useState } from 'react';
import type { HwAccel, ServerSettings, Webhook, WebhookEvent } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { ErrorState, Field, Skeleton, Spinner, Switch, Tabs } from '../components/ui';
import { Icon } from '../components/Icon';
import { AdminHeader } from './AdminRoutes';

type Tab = 'general' | 'transcoding' | 'dvr' | 'webhooks';
const HW: { value: HwAccel; label: string }[] = [
  { value: 'none', label: 'None (CPU)' },
  { value: 'vaapi', label: 'VA-API (Intel/AMD, Linux)' },
  { value: 'qsv', label: 'Intel Quick Sync' },
  { value: 'nvenc', label: 'NVIDIA NVENC' },
  { value: 'videotoolbox', label: 'Apple VideoToolbox' },
  { value: 'v4l2m2m', label: 'V4L2 M2M (Raspberry Pi / ARM)' },
];
const EVENTS: WebhookEvent[] = ['playback.start', 'playback.pause', 'playback.resume', 'playback.stop', 'playback.scrobble', 'library.new', 'user.login', 'recording.completed', 'recording.failed'];
const PRESETS: ServerSettings['transcoding']['preset'][] = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'];

export function ServerSettingsAdmin() {
  const toast = useToast();
  const { refreshSystem } = useApp();
  const [s, setS] = useState<ServerSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('general');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  const load = () => {
    setError(null);
    api.admin.settings().then((x) => { setS(x); setDirty(false); }).catch((e) => setError((e as Error).message));
  };
  useEffect(load, []);

  if (error) return <div><AdminHeader title="Server settings" /><ErrorState message={error} onRetry={load} /></div>;
  if (!s) return <div><AdminHeader title="Server settings" /><Skeleton h={400} /></div>;

  const set = (p: Partial<ServerSettings>) => { setS({ ...s, ...p }); setDirty(true); };
  const setT = (p: Partial<ServerSettings['transcoding']>) => set({ transcoding: { ...s.transcoding, ...p } });
  const setD = (p: Partial<ServerSettings['dvr']>) => set({ dvr: { ...s.dvr, ...p } });
  const setHook = (i: number, p: Partial<Webhook>) => set({ webhooks: s.webhooks.map((w, j) => (j === i ? { ...w, ...p } : w)) });

  const save = async () => {
    setSaving(true);
    try {
      setS(await api.admin.saveSettings(s));
      setDirty(false);
      toast.success('Settings saved');
      void refreshSystem();
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };
  const test = async (w: Webhook) => {
    setTesting(w.id);
    try {
      const r = await api.admin.testWebhook(w.url);
      if (r.ok) toast.success(`Webhook responded${r.status ? ` (${r.status})` : ''}`);
      else toast.show(`Webhook test failed: ${r.error ?? r.message ?? (r.status ? `HTTP ${r.status}` : 'no response')}`, 'error');
    } catch (e) {
      toast.error(e);
    } finally {
      setTesting(null);
    }
  };

  return (
    <div>
      <AdminHeader title="Server settings" actions={<button className="btn btn-primary" onClick={save} disabled={!dirty || saving}>{saving ? <Spinner size={18} /> : 'Save changes'}</button>} />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ value: 'general', label: 'General' }, { value: 'transcoding', label: 'Transcoding' }, { value: 'dvr', label: 'DVR' }, { value: 'webhooks', label: 'Webhooks' }]} />
      <div className="settings-card">
        {tab === 'general' && (
          <div className="form-grid">
            <div className="form-row">
              <Field label="Server name"><input className="input" value={s.serverName} onChange={(e) => set({ serverName: e.target.value })} /></Field>
              <Field label="Public URL" hint="Used for links, remote apps and webhooks."><input className="input" value={s.publicUrl ?? ''} onChange={(e) => set({ publicUrl: e.target.value || null })} placeholder="https://media.example.com" /></Field>
            </div>
            <div className="form-row">
              <Field label="TMDB API key" hint="Enables posters, backdrops, cast and descriptions."><input className="input mono" value={s.tmdbApiKey ?? ''} onChange={(e) => set({ tmdbApiKey: e.target.value || null })} autoComplete="off" /></Field>
              <Field label="Metadata language"><input className="input" value={s.metadataLanguage} onChange={(e) => set({ metadataLanguage: e.target.value })} placeholder="en-US" /></Field>
            </div>
            <div className="form-row form-row-3">
              <Field label="Library scan interval (min)"><input className="input" type="number" min={0} value={s.scanIntervalMinutes} onChange={(e) => set({ scanIntervalMinutes: Number(e.target.value) })} /></Field>
              <Field label="EPG refresh (hours)"><input className="input" type="number" min={1} value={s.epgRefreshHours} onChange={(e) => set({ epgRefreshHours: Number(e.target.value) })} /></Field>
              <Field label="Session timeout (days)"><input className="input" type="number" min={1} value={s.sessionTimeoutDays} onChange={(e) => set({ sessionTimeoutDays: Number(e.target.value) })} /></Field>
            </div>
            <Switch checked={s.allowPasswordlessProfiles} onChange={(v) => set({ allowPasswordlessProfiles: v })} label="Allow passwordless profiles" hint="Profiles without a password can be entered from the profile picker (optionally with a PIN)." />
            <Switch checked={!!s.blockUnratedForRestricted} onChange={(v) => set({ blockUnratedForRestricted: v })} label="Hide unrated titles from users with a rating limit" hint="Parental controls: titles with no content rating are hidden from anyone who has a maximum content rating set." />
          </div>
        )}
        {tab === 'transcoding' && (
          <div className="form-grid">
            <Switch checked={s.transcoding.enabled} onChange={(v) => setT({ enabled: v })} label="Enable transcoding" hint="When off, clients must direct play or remux." />
            <div className="form-row">
              <Field label="Hardware acceleration">
                <select className="select" value={s.transcoding.hwAccel} onChange={(e) => setT({ hwAccel: e.target.value as HwAccel })}>
                  {HW.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
                </select>
              </Field>
              {(s.transcoding.hwAccel === 'vaapi' || s.transcoding.hwAccel === 'qsv') && (
                <Field label="VA-API device"><input className="input mono" value={s.transcoding.vaapiDevice} onChange={(e) => setT({ vaapiDevice: e.target.value })} placeholder="/dev/dri/renderD128" /></Field>
              )}
            </div>
            <div className="form-row form-row-3">
              <Field label="Max concurrent transcodes"><input className="input" type="number" min={1} value={s.transcoding.maxConcurrent} onChange={(e) => setT({ maxConcurrent: Number(e.target.value) })} /></Field>
              <Field label="Default bitrate (kbps)"><input className="input" type="number" min={500} step={500} value={s.transcoding.defaultBitrate} onChange={(e) => setT({ defaultBitrate: Number(e.target.value) })} /></Field>
              <Field label="Encoder preset">
                <select className="select" value={s.transcoding.preset} onChange={(e) => setT({ preset: e.target.value as ServerSettings['transcoding']['preset'] })}>
                  {PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </Field>
            </div>
            <div className="form-row">
              <Field label="Threads" hint="0 = automatic"><input className="input" type="number" min={0} value={s.transcoding.threads} onChange={(e) => setT({ threads: Number(e.target.value) })} /></Field>
              <Field label="HLS segment length (s)"><input className="input" type="number" min={1} max={10} value={s.transcoding.segmentSeconds} onChange={(e) => setT({ segmentSeconds: Number(e.target.value) })} /></Field>
            </div>
            <Switch checked={s.transcoding.toneMapHdr} onChange={(v) => setT({ toneMapHdr: v })} label="Tone-map HDR to SDR" hint="Keeps colours correct on non-HDR screens when transcoding." />
          </div>
        )}
        {tab === 'dvr' && (
          <div className="form-grid">
            <Field label="Recordings folder"><input className="input mono" value={s.dvr.recordingsPath} onChange={(e) => setD({ recordingsPath: e.target.value })} /></Field>
            <div className="form-row">
              <Field label="Default start padding (min)"><input className="input" type="number" min={0} value={s.dvr.paddingBeforeMin} onChange={(e) => setD({ paddingBeforeMin: Number(e.target.value) })} /></Field>
              <Field label="Default end padding (min)"><input className="input" type="number" min={0} value={s.dvr.paddingAfterMin} onChange={(e) => setD({ paddingAfterMin: Number(e.target.value) })} /></Field>
            </div>
          </div>
        )}
        {tab === 'webhooks' && (
          <div className="form-grid">
            <p className="muted">MediaMax POSTs a JSON payload to each URL when the selected events happen.</p>
            {s.webhooks.map((w, i) => (
              <div key={w.id} className="webhook-card">
                <div className="webhook-head">
                  <input className="input mono" value={w.url} onChange={(e) => setHook(i, { url: e.target.value })} placeholder="https://example.com/hook" />
                  <input type="checkbox" className="switch" checked={w.enabled} onChange={(e) => setHook(i, { enabled: e.target.checked })} aria-label="Enabled" />
                  <button className="btn btn-sm" onClick={() => test(w)} disabled={!w.url || testing === w.id}>{testing === w.id ? <Spinner size={14} /> : <Icon name="zap" size={14} />} Test</button>
                  <button className="btn-icon" onClick={() => set({ webhooks: s.webhooks.filter((_, j) => j !== i) })} aria-label="Remove"><Icon name="trash" size={16} /></button>
                </div>
                <div className="event-chips">
                  {EVENTS.map((ev) => (
                    <label key={ev} className={`check-chip ${w.events.includes(ev) ? 'on' : ''}`}>
                      <input type="checkbox" checked={w.events.includes(ev)} onChange={(e) => setHook(i, { events: e.target.checked ? [...w.events, ev] : w.events.filter((x) => x !== ev) })} /> {ev}
                    </label>
                  ))}
                </div>
              </div>
            ))}
            <button className="btn" onClick={() => set({ webhooks: [...s.webhooks, { id: Math.random().toString(36).slice(2, 10), url: '', events: ['playback.start', 'playback.stop'], enabled: true }] })}>
              <Icon name="plus" size={16} /> Add webhook
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
