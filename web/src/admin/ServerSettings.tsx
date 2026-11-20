import { useEffect, useState, type ReactNode } from 'react';
import type { HwAccel, ServerSettings, User, Webhook, WebhookEvent } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useAsync } from '../hooks';
import { useToast } from '../state/toast';
import { ErrorState, Field, Skeleton, Spinner, Switch, Tabs } from '../components/ui';
import { Icon } from '../components/Icon';
import { AdminHeader } from './AdminRoutes';

type Tab = 'general' | 'transcoding' | 'dvr' | 'trickplay' | 'subtitles' | 'trakt' | 'dlna' | 'webhooks';
const HW: { value: HwAccel; label: string }[] = [
  { value: 'none', label: 'None (CPU)' },
  { value: 'vaapi', label: 'VA-API (Intel/AMD, Linux)' },
  { value: 'qsv', label: 'Intel Quick Sync' },
  { value: 'nvenc', label: 'NVIDIA NVENC' },
  { value: 'videotoolbox', label: 'Apple VideoToolbox' },
  { value: 'v4l2m2m', label: 'V4L2 M2M (Raspberry Pi / ARM)' },
];
const EVENTS: WebhookEvent[] = ['playback.start', 'playback.pause', 'playback.resume', 'playback.stop', 'playback.scrobble', 'library.new', 'user.login', 'recording.completed', 'recording.failed'];
const TRICKPLAY_DEFAULTS: ServerSettings['trickplay'] = { enabled: false, intervalSeconds: 10, width: 320 };
const OPENSUBS_DEFAULTS: ServerSettings['openSubtitles'] = { apiKey: null, username: null, password: null, autoLanguages: [] };
const TRAKT_DEFAULTS: ServerSettings['trakt'] = { clientId: null, clientSecret: null };
const DLNA_DEFAULTS: ServerSettings['dlna'] = { enabled: false, friendlyName: null, userId: null };

/** "en, fr ,de" → ["en","fr","de"] */
function parseLanguages(text: string): string[] {
  return Array.from(new Set(text.split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean)));
}

/** External link that opens in a new tab. */
function Ext({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer" className="link-strong">{children} <Icon name="external" size={12} /></a>;
}

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
  const [langText, setLangText] = useState<string | null>(null);
  const [runningTp, setRunningTp] = useState(false);
  const users = useAsync(async () => (tab === 'dlna' ? api.users.list() : ([] as User[])), [tab === 'dlna']);

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
  const tp = { ...TRICKPLAY_DEFAULTS, ...(s.trickplay ?? {}) };
  const os = { ...OPENSUBS_DEFAULTS, ...(s.openSubtitles ?? {}) };
  const tk = { ...TRAKT_DEFAULTS, ...(s.trakt ?? {}) };
  const dl = { ...DLNA_DEFAULTS, ...(s.dlna ?? {}) };
  const setTp = (p: Partial<ServerSettings['trickplay']>) => set({ trickplay: { ...tp, ...p } });
  const setOs = (p: Partial<ServerSettings['openSubtitles']>) => set({ openSubtitles: { ...os, ...p } });
  const setTk = (p: Partial<ServerSettings['trakt']>) => set({ trakt: { ...tk, ...p } });
  const setDl = (p: Partial<ServerSettings['dlna']>) => set({ dlna: { ...dl, ...p } });
  const setHook = (i: number, p: Partial<Webhook>) => set({ webhooks: s.webhooks.map((w, j) => (j === i ? { ...w, ...p } : w)) });

  const save = async (quiet = false): Promise<boolean> => {
    setSaving(true);
    try {
      setS(await api.admin.saveSettings(s));
      setDirty(false);
      setLangText(null);
      if (!quiet) toast.success('Settings saved');
      void refreshSystem();
      return true;
    } catch (e) {
      toast.error(e);
      return false;
    } finally {
      setSaving(false);
    }
  };
  const runTrickplay = async () => {
    setRunningTp(true);
    try {
      if (dirty && !(await save(true))) return;
      await api.admin.runTask('trickplay');
      toast.success('Generating scrub previews — follow progress in Scheduled tasks');
    } catch (e) {
      toast.error(e);
    } finally {
      setRunningTp(false);
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
      <AdminHeader title="Server settings" actions={<button className="btn btn-primary" onClick={() => void save()} disabled={!dirty || saving}>{saving ? <Spinner size={18} /> : 'Save changes'}</button>} />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { value: 'general', label: 'General' },
        { value: 'transcoding', label: 'Transcoding' },
        { value: 'dvr', label: 'DVR' },
        { value: 'trickplay', label: 'Trickplay' },
        { value: 'subtitles', label: 'OpenSubtitles' },
        { value: 'trakt', label: 'Trakt' },
        { value: 'dlna', label: 'DLNA' },
        { value: 'webhooks', label: 'Webhooks' },
      ]} />
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
        {tab === 'trickplay' && (
          <div className="form-grid">
            <p className="muted">Trickplay thumbnails show a preview of the picture while you hover or drag the seek bar. They’re built in the background from keyframes and take a little disk space per title.</p>
            <Switch checked={tp.enabled} onChange={(v) => setTp({ enabled: v })} label="Generate scrub previews" hint="New and existing movies and episodes get thumbnails during the scheduled task." />
            <div className="form-row">
              <Field label="Interval (seconds)" hint="Time between thumbnails. Lower = smoother previews, more disk.">
                <input className="input" type="number" min={2} max={60} value={tp.intervalSeconds} onChange={(e) => setTp({ intervalSeconds: Number(e.target.value) })} />
              </Field>
              <Field label="Thumbnail width (px)" hint="120–480. 320 looks good on most screens.">
                <input className="input" type="number" min={120} max={480} step={10} value={tp.width} onChange={(e) => setTp({ width: Number(e.target.value) })} />
              </Field>
            </div>
            <div className="settings-inline-action">
              <div>
                <strong>Generate now</strong>
                <p className="muted">Runs the “Generate scrub previews” task right away{dirty ? ' (saves your changes first)' : ''}.</p>
              </div>
              <button className="btn" onClick={runTrickplay} disabled={runningTp || saving || !tp.enabled} title={tp.enabled ? undefined : 'Enable scrub previews first'}>
                {runningTp ? <Spinner size={16} /> : <Icon name="play" size={16} />} Run now
              </button>
            </div>
          </div>
        )}
        {tab === 'subtitles' && (
          <div className="form-grid">
            <p className="muted">
              Lets everyone search and download subtitles from OpenSubtitles.com from the player and the item page.
              Create a free API consumer at <Ext href="https://www.opensubtitles.com/consumers">opensubtitles.com/consumers</Ext> and paste its key below.
            </p>
            <Field label="API key">
              <input className="input mono" value={os.apiKey ?? ''} onChange={(e) => setOs({ apiKey: e.target.value.trim() || null })} autoComplete="off" spellCheck={false} />
            </Field>
            <div className="form-row">
              <Field label="Username" hint="Optional. An account raises the daily download limit.">
                <input className="input" value={os.username ?? ''} onChange={(e) => setOs({ username: e.target.value || null })} autoComplete="off" />
              </Field>
              <Field label="Password">
                <input className="input" type="password" value={os.password ?? ''} onChange={(e) => setOs({ password: e.target.value || null })} autoComplete="new-password" />
              </Field>
            </div>
            <Field label="Download automatically" hint="Two-letter language codes, comma separated (e.g. en, es). New media without a matching subtitle gets one automatically. Leave empty to turn off.">
              <input
                className="input"
                value={langText ?? os.autoLanguages.join(', ')}
                onChange={(e) => { setLangText(e.target.value); setOs({ autoLanguages: parseLanguages(e.target.value) }); }}
                onBlur={() => setLangText(null)}
                placeholder="en, es"
                spellCheck={false}
              />
            </Field>
          </div>
        )}
        {tab === 'trakt' && (
          <div className="form-grid">
            <div className="howto">
              <strong><Icon name="info" size={16} /> How to set up Trakt</strong>
              <ol>
                <li>Sign in at <Ext href="https://trakt.tv/oauth/applications">trakt.tv/oauth/applications</Ext> and choose <em>New application</em>.</li>
                <li>Give it a name (e.g. “{s.serverName || 'MediaMax'}”) and set the <em>Redirect URI</em> to <code>urn:ietf:wg:oauth:2.0:oob</code>.</li>
                <li>Save, then copy the <em>Client ID</em> and <em>Client Secret</em> here.</li>
                <li>Each user connects their own account in <em>Settings → Connected services</em>.</li>
              </ol>
            </div>
            <div className="form-row">
              <Field label="Client ID"><input className="input mono" value={tk.clientId ?? ''} onChange={(e) => setTk({ clientId: e.target.value.trim() || null })} autoComplete="off" spellCheck={false} /></Field>
              <Field label="Client secret"><input className="input mono" type="password" value={tk.clientSecret ?? ''} onChange={(e) => setTk({ clientSecret: e.target.value.trim() || null })} autoComplete="new-password" spellCheck={false} /></Field>
            </div>
          </div>
        )}
        {tab === 'dlna' && (
          <div className="form-grid">
            <p className="muted">
              Share your libraries with smart TVs, game consoles, VLC and other DLNA / UPnP players on your <strong>local network</strong>. They find the server automatically — no app needed.
            </p>
            <Switch checked={dl.enabled} onChange={(v) => setDl({ enabled: v })} label="Enable DLNA server" />
            <div className="form-row">
              <Field label="Friendly name" hint="What TVs show in their source list.">
                <input className="input" value={dl.friendlyName ?? ''} onChange={(e) => setDl({ friendlyName: e.target.value || null })} placeholder={s.serverName || 'MediaMax'} />
              </Field>
              <Field label="Browse as user" hint="Library access and rating limits of this user apply.">
                <select className="select" value={dl.userId ?? ''} onChange={(e) => setDl({ userId: e.target.value || null })}>
                  <option value="">First administrator</option>
                  {(users.data ?? []).filter((u) => !u.disabled || u.id === dl.userId).map((u) => (
                    <option key={u.id} value={u.id}>{u.displayName || u.username}{u.isAdmin ? ' (admin)' : ''}{u.maxContentRating ? ` · up to ${u.maxContentRating}` : ''}</option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="callout-warning">
              <Icon name="alert" size={18} />
              <p>DLNA has <strong>no sign-in</strong>: anyone on your network can browse and play everything the chosen user can see. Pick a user whose library access and rating limit suit the whole household (for example a family profile), and only enable this on a network you trust. DLNA never leaves your LAN.</p>
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
