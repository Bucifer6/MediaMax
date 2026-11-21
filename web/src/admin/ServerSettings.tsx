import { KaraokeSettingsPanel } from './KaraokeSettings';
import { AiDjSettingsPanel } from './AiDjSettings';
import { HardwareDetect } from './HardwareDetect';
import { MetadataSettingsPanel } from './MetadataSettings';
import { SubtitleSettingsPanel } from './SubtitleSettings';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { HwAccel, ServerSettings, StreamingSettings, TranscodeVideoCodec, User, Webhook, WebhookEvent } from '@mediamax/shared';
import { ArrSettingsPanel } from './ArrSettings';
import { ARR_ICON, ARR_NAME } from './Downloads';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useAsync } from '../hooks';
import { useToast } from '../state/toast';
import { ErrorState, Field, Skeleton, Spinner, Switch, Tabs } from '../components/ui';
import { Icon } from '../components/Icon';
import { AdminHeader } from './AdminRoutes';
import { NotificationAgentsPanel } from './NotificationAgents';
import { QuotaEditor, DEFAULT_QUOTAS } from './RequestPermissionsEditor';

type Tab = 'general' | 'transcoding' | 'cinema' | 'aidj' | 'karaoke' | 'dvr' | 'requests' | 'notifications' | 'arr' | 'sso' | 'trickplay' | 'subtitles' | 'trakt' | 'lastfm' | 'dlna' | 'webhooks' | 'metadata';
const HW: { value: HwAccel; label: string }[] = [
  { value: 'none', label: 'None (CPU)' },
  { value: 'vaapi', label: 'VA-API (Intel/AMD, Linux)' },
  { value: 'qsv', label: 'Intel Quick Sync (Linux/Windows)' },
  { value: 'nvenc', label: 'NVIDIA NVENC (Linux/Windows)' },
  { value: 'amf', label: 'AMD AMF (Windows)' },
  { value: 'videotoolbox', label: 'Apple VideoToolbox' },
  { value: 'v4l2m2m', label: 'V4L2 M2M (Raspberry Pi / ARM)' },
  { value: 'rkmpp', label: 'Rockchip MPP (RK3588, ffmpeg-rockchip)' },
];
/** Select value for the preferred codec order (H.264 always last). */
const codecOrderValue = (c: TranscodeVideoCodec[] | undefined) => [...(c ?? ['hevc', 'h264']).filter((x) => x !== 'h264'), 'h264'].join(',');
const CODEC_ORDERS: { value: string; label: string }[] = [
  { value: 'hevc,h264', label: 'HEVC, then H.264' },
  { value: 'av1,hevc,h264', label: 'AV1, then HEVC, then H.264' },
  { value: 'hevc,av1,h264', label: 'HEVC, then AV1, then H.264' },
  { value: 'h264', label: 'H.264 only' },
];
const EVENTS: WebhookEvent[] = ['playback.start', 'playback.pause', 'playback.resume', 'playback.stop', 'playback.scrobble', 'library.new', 'user.login', 'recording.completed', 'recording.failed', 'request.created', 'request.approved', 'request.declined', 'request.available', 'request.failed', 'issue.created', 'issue.resolved'];
const TRICKPLAY_DEFAULTS: ServerSettings['trickplay'] = { enabled: false, intervalSeconds: 10, width: 320 };
const OPENSUBS_DEFAULTS: ServerSettings['openSubtitles'] = { apiKey: null, username: null, password: null, autoLanguages: [] };
const TRAKT_DEFAULTS: ServerSettings['trakt'] = { clientId: null, clientSecret: null };
const LASTFM_DEFAULTS: ServerSettings['lastfm'] = { apiKey: null, sharedSecret: null };
const OIDC_DEFAULTS: ServerSettings['oidc'] = {
  enabled: false, issuer: null, clientId: null, clientSecret: null, buttonLabel: 'Sign in with SSO',
  autoCreateUsers: true, groupsClaim: 'groups', adminGroup: null, allowedGroup: null,
};
const DLNA_DEFAULTS: ServerSettings['dlna'] = { enabled: false, friendlyName: null, userId: null };
const REQUESTS_DEFAULTS: ServerSettings['requests'] = { enabled: true, autoApproveUserIds: [], weeklyLimit: 10, radarr: null, sonarr: null };

/** External link that opens in a new tab. */
function Ext({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer" className="link-strong">{children} <Icon name="external" size={12} /></a>;
}

const PRESETS: ServerSettings['transcoding']['preset'][] = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'];

/** Help Centre article for each tab ("?" next to the title). */
const SETTINGS_HELP: Partial<Record<string, string>> = {
  transcoding: 'admin-transcoding', metadata: 'admin-metadata', requests: 'admin-requests', arr: 'admin-requests', notifications: 'admin-requests',
  dvr: 'admin-live-tv', sso: 'admin-users', aidj: 'dj-mode', dlna: 'play-to-devices', webhooks: 'admin-home-assistant',
};

export function ServerSettingsAdmin() {
  const toast = useToast();
  const { refreshSystem } = useApp();
  const [s, setS] = useState<ServerSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [params] = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => { const t = params.get('tab'); return t === 'arr' || t === 'requests' || t === 'notifications' || t === 'metadata' ? t : 'general'; });
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [runningTp, setRunningTp] = useState(false);
  const needUsers = tab === 'dlna' || tab === 'requests';
  const users = useAsync(async () => (needUsers ? api.users.list() : ([] as User[])), [needUsers]);
  const libs = useAsync(async () => (tab === 'cinema' ? api.libraries.list() : []), [tab]);

  const load = () => {
    setError(null);
    api.admin.settings().then((x) => { setS(x); setDirty(false); }).catch((e) => setError((e as Error).message));
  };
  useEffect(load, []);

  if (error) return <div><AdminHeader title="Server settings" /><ErrorState message={error} onRetry={load} /></div>;
  if (!s) return <div><AdminHeader title="Server settings" /><Skeleton h={400} /></div>;

  const set = (p: Partial<ServerSettings>) => { setS({ ...s, ...p }); setDirty(true); };
  const setT = (p: Partial<ServerSettings['transcoding']>) => set({ transcoding: { ...s.transcoding, ...p } });
  const st: StreamingSettings = { adaptive: true, renditionIdleSeconds: 20, remoteMaxBitrate: null, bandwidthTestMaxBytes: 20 * 1024 * 1024, ...(s.streaming ?? {}) };
  const setSt = (p: Partial<StreamingSettings>) => set({ streaming: { ...st, ...p } });
  const setD = (p: Partial<ServerSettings['dvr']>) => set({ dvr: { ...s.dvr, ...p } });
  const tp = { ...TRICKPLAY_DEFAULTS, ...(s.trickplay ?? {}) };
  const os = { ...OPENSUBS_DEFAULTS, ...(s.openSubtitles ?? {}) };
  const tk = { ...TRAKT_DEFAULTS, ...(s.trakt ?? {}) };
  const dl = { ...DLNA_DEFAULTS, ...(s.dlna ?? {}) };
  const lf = { ...LASTFM_DEFAULTS, ...(s.lastfm ?? {}) };
  const oi = { ...OIDC_DEFAULTS, ...(s.oidc ?? {}) };
  const rq = { ...REQUESTS_DEFAULTS, ...(s.requests ?? {}) };
  const setRq = (p: Partial<ServerSettings['requests']>) => set({ requests: { ...rq, ...p } });
  const setLf = (p: Partial<ServerSettings['lastfm']>) => set({ lastfm: { ...lf, ...p } });
  const setOi = (p: Partial<ServerSettings['oidc']>) => set({ oidc: { ...oi, ...p } });
  const callbackUrl = `${(s.publicUrl || window.location.origin).replace(/\/+$/, '')}/api/v1/auth/oidc/callback`;
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
      <AdminHeader help={SETTINGS_HELP[tab] ?? 'admin-setup'} title="Server settings" actions={<button className="btn btn-primary" onClick={() => void save()} disabled={!dirty || saving}>{saving ? <Spinner size={18} /> : 'Save changes'}</button>} />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { value: 'general', label: 'General' },
        { value: 'metadata', label: 'Metadata' },
        { value: 'transcoding', label: 'Transcoding' },
        { value: 'cinema', label: 'Cinema mode' },
        { value: 'aidj', label: 'AI DJ' },
        { value: 'karaoke', label: 'Karaoke & lyrics' },
        { value: 'dvr', label: 'DVR' },
        { value: 'requests', label: 'Requests' },
        { value: 'notifications', label: 'Notifications' },
        { value: 'arr', label: 'Media automation (*arr)' },
        { value: 'sso', label: 'SSO' },
        { value: 'trickplay', label: 'Trickplay' },
        { value: 'subtitles', label: 'Subtitles' },
        { value: 'trakt', label: 'Trakt' },
        { value: 'lastfm', label: 'Last.fm' },
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
                <Field label="Render device (Linux)"><input className="input mono" value={s.transcoding.vaapiDevice} onChange={(e) => setT({ vaapiDevice: e.target.value })} placeholder="/dev/dri/renderD128" /></Field>
              )}
              {(s.transcoding.hwAccel === 'nvenc' || s.transcoding.hwAccel === 'amf' || s.transcoding.hwAccel === 'qsv') && (
                <Field label="GPU index" hint="NVIDIA, and QSV/AMF on Windows. 0 = first GPU."><input className="input" type="number" min={0} max={15} value={s.transcoding.gpuIndex ?? 0} onChange={(e) => setT({ gpuIndex: Number(e.target.value) })} /></Field>
              )}
            </div>
            <HardwareDetect value={s.transcoding} onUse={setT} />
            <div className="form-row">
              <Field label="Preferred output codecs" hint="HEVC/AV1 are only encoded with a hardware encoder, for clients that can play them (at ~65% of the H.264 bitrate). H.264 is always the fallback.">
                <select className="select" value={codecOrderValue(s.transcoding.preferredCodecs)} onChange={(e) => setT({ preferredCodecs: e.target.value.split(',') as TranscodeVideoCodec[] })}>
                  {CODEC_ORDERS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </Field>
            </div>
            <Switch checked={s.transcoding.allowHevcEncoding ?? true} onChange={(v) => setT({ allowHevcEncoding: v })} label="Allow HEVC encoding" hint="Uses fMP4 HLS segments; supported by Safari, Chrome/Edge with HEVC decoding, and the mobile apps." />
            <Switch checked={s.transcoding.allowAv1Encoding ?? false} onChange={(v) => setT({ allowAv1Encoding: v })} label="Allow AV1 encoding" hint="Needs an AV1 hardware encoder (Intel Arc, NVIDIA RTX 40, AMD RX 7000) and an AV1-capable client." />
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
            <Switch checked={s.transcoding.hardwareToneMapping ?? true} onChange={(v) => setT({ hardwareToneMapping: v })} disabled={!s.transcoding.toneMapHdr} label="Tone-map on the GPU when possible" hint="VA-API, Quick Sync, CUDA or OpenCL tone-mapping; falls back to the CPU automatically." />
            <h3 className="section-title">Adaptive streaming</h3>
            <Switch
              checked={st.adaptive}
              onChange={(v) => setSt({ adaptive: v })}
              label="Offer quality levels (renditions) for transcodes"
              hint="Players on Auto quality get a 1080p/720p/480p/360p ladder and switch with the connection. Only the level being watched is encoded; with a single hardware encoder session, switches restart the encoder at the new bitrate."
            />
            <div className="form-row">
              <Field label="Remote bitrate limit (kbps)" hint="For clients outside your network. Empty = no limit. Local clients are never limited unless they measure a slower connection.">
                <input className="input" type="number" min={0} step={500} value={st.remoteMaxBitrate ?? ''} placeholder="No limit" onChange={(e) => setSt({ remoteMaxBitrate: e.target.value ? Number(e.target.value) : null })} />
              </Field>
              <Field label="Stop idle quality levels after (s)">
                <input className="input" type="number" min={5} max={300} value={st.renditionIdleSeconds} onChange={(e) => setSt({ renditionIdleSeconds: Number(e.target.value) })} />
              </Field>
            </div>
          </div>
        )}
        {tab === 'metadata' && <MetadataSettingsPanel />}
        {tab === 'aidj' && <AiDjSettingsPanel value={s.aiDj} onChange={(aiDj) => set({ aiDj })} />}
        {tab === 'karaoke' && <KaraokeSettingsPanel value={s.karaoke} onChange={(karaoke) => set({ karaoke })} dirty={dirty} />}
        {tab === 'cinema' && (
          <div className="form-grid">
            <p className="muted">
              Before a movie starts from the beginning, play trailers for other movies in your libraries (from their local <code>Trailers</code> folders or
              <code>-trailer</code> files), then one short pre-roll clip, like at the cinema. Viewers can skip straight to the movie, and turn it off in their playback settings.
            </p>
            <Switch checked={s.cinema.enabled} onChange={(v) => set({ cinema: { ...s.cinema, enabled: v } })} label="Enable cinema mode" />
            <div className="form-row">
              <Field label="Trailers before a movie"><input className="input" type="number" min={0} max={5} value={s.cinema.trailers} onChange={(e) => set({ cinema: { ...s.cinema, trailers: Number(e.target.value) } })} /></Field>
              <Field label="Pre-roll library" hint="A Videos library of short intro clips; one is picked at random. Hide it from users under Users → library access.">
                <select className="input" value={s.cinema.prerollLibraryId ?? ''} onChange={(e) => set({ cinema: { ...s.cinema, prerollLibraryId: e.target.value || null } })}>
                  <option value="">None</option>
                  {(libs.data ?? []).filter((l) => l.type === 'videos' || l.type === 'movies').map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </Field>
            </div>
            <Switch checked={s.cinema.unwatchedOnly} onChange={(v) => set({ cinema: { ...s.cinema, unwatchedOnly: v } })} label="Only trailers for movies the viewer hasn't seen" />
          </div>
        )}
        {tab === 'dvr' && (
          <div className="form-grid">
            <Field label="Recordings folder"><input className="input mono" value={s.dvr.recordingsPath} onChange={(e) => setD({ recordingsPath: e.target.value })} /></Field>
            <div className="form-row">
              <Field label="Default start padding (min)"><input className="input" type="number" min={0} value={s.dvr.paddingBeforeMin} onChange={(e) => setD({ paddingBeforeMin: Number(e.target.value) })} /></Field>
              <Field label="Default end padding (min)"><input className="input" type="number" min={0} value={s.dvr.paddingAfterMin} onChange={(e) => setD({ paddingAfterMin: Number(e.target.value) })} /></Field>
            </div>
            <Switch checked={!!s.dvr.commercialDetection} onChange={(v) => setD({ commercialDetection: v })} label="Detect commercials"
              hint="Runs comskip on finished recordings and adds “Skip ad break” markers. comskip must be installed on the server. Any video with a .edl file next to it gets markers too." />
            {s.dvr.commercialDetection && (
              <div className="form-row">
                <Field label="comskip binary"><input className="input mono" placeholder="comskip" value={s.dvr.comskipPath ?? ''} onChange={(e) => setD({ comskipPath: e.target.value || null })} /></Field>
                <Field label="comskip.ini (optional)"><input className="input mono" placeholder="Built-in EDL-only settings" value={s.dvr.comskipIni ?? ''} onChange={(e) => setD({ comskipIni: e.target.value || null })} /></Field>
              </div>
            )}
          </div>
        )}
        {tab === 'requests' && (
          <div className="form-grid">
            <p className="muted">
              People can request movies, shows, music and books from the <strong>Discover</strong> page. Approved requests are sent to Radarr (movies),
              Sonarr (shows), Lidarr (music) or Readarr (books) and marked available once the title shows up in a library. Movies and shows need a
              TMDB API key (General tab){s.tmdbApiKey ? '' : ' — none is set yet'}; music and books use Lidarr’s and Readarr’s own search.
            </p>
            <Switch checked={rq.enabled} onChange={(v) => setRq({ enabled: v })} label="Enable requests" hint="The Discover tab also has to be on in Branding → Features." />
            <div className="callout-info" style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <Icon name="users" size={18} />
              <p style={{ margin: 0 }}>
                Who can request what — movies, shows, 4K, music, books — and whose requests are approved automatically is set per user in{' '}
                <Link className="link-strong" to="/admin/users">Users</Link> (with bulk edit and default permissions for new users). Users with “Manage requests” can approve requests without being admins.
                {rq.autoApproveUserIds.length > 0 && <> {rq.autoApproveUserIds.length} user{rq.autoApproveUserIds.length === 1 ? ' was' : 's were'} auto-approved by the old setting and keep{rq.autoApproveUserIds.length === 1 ? 's' : ''} that until edited.</>}
              </p>
            </div>
            <fieldset className="settings-fieldset">
              <legend className="field-label">Default quota</legend>
              <small className="field-hint">For users without their own quota (set in Users). Admins are never limited.</small>
              <QuotaEditor value={rq.defaultQuotas ?? (rq.weeklyLimit ? { movie: { limit: rq.weeklyLimit, days: 7 }, show: { limit: rq.weeklyLimit, days: 7 }, music: { limit: rq.weeklyLimit, days: 7 }, book: { limit: rq.weeklyLimit, days: 7 } } : DEFAULT_QUOTAS)} onChange={(q) => setRq({ defaultQuotas: q })} />
            </fieldset>
            <Switch checked={rq.quotaExemptManagers !== false} onChange={(v) => setRq({ quotaExemptManagers: v })} label="Request managers have no quota" />
            <Switch checked={!!rq.quotaExemptAutoApprove} onChange={(v) => setRq({ quotaExemptAutoApprove: v })} label="No quota for auto-approved kinds" hint="Users with “Auto” for movies (say) aren't counted against the movie quota." />
            <div className="form-row">
              <Field label="Auto-approve highly rated titles" hint="Approve any movie/show request rated at least this on TMDB (0 = off). Permissions and quotas still apply.">
                <input className="input" type="number" min={0} max={10} step={0.1} value={rq.autoApproveMinRating ?? 0} onChange={(e) => setRq({ autoApproveMinRating: Math.max(0, Math.min(10, Number(e.target.value) || 0)) })} />
              </Field>
            </div>
            <Switch checked={!!rq.hideAvailable} onChange={(v) => setRq({ hideAvailable: v })} label="Hide titles already in the library on Discover by default" />
            <p className="muted" style={{ margin: 0 }}>Blacklisted titles are managed on the <Link className="link-strong" to="/requests">Requests</Link> page; notifications in the <button type="button" className="link-strong" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', font: 'inherit', color: 'inherit' }} onClick={() => setTab('notifications')}>Notifications</button> tab.</p>
            <div className="arr-card">
              <div className="arr-head">
                <strong><Icon name="download" size={18} /> Where requests go</strong>
                <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setTab('arr')}><Icon name="settings" size={14} /> Manage instances</button>
              </div>
              {(s.arr ?? []).filter((a) => a.kind !== 'bazarr').length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>No Radarr, Sonarr, Lidarr or Readarr yet. Approved requests stay “approved” until one is added in <strong>Media automation (*arr)</strong>.</p>
              ) : (
                <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
                  {(['radarr', 'sonarr', 'lidarr', 'readarr'] as const).map((k) => {
                    const list = (s.arr ?? []).filter((a) => a.kind === k && a.enabled);
                    const main = list.find((a) => !a.is4k) ?? list[0];
                    const uhd = list.find((a) => a.is4k);
                    return (
                      <li key={k}>
                        <Icon name={ARR_ICON[k]} size={13} /> {k === 'radarr' ? 'Movies' : k === 'sonarr' ? 'Shows' : k === 'lidarr' ? 'Music' : 'Books'}: {main ? <strong>{main.name}</strong> : `no ${ARR_NAME[k]}`}{uhd && uhd !== main ? <> · 4K: <strong>{uhd.name}</strong></> : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}
        {tab === 'notifications' && <NotificationAgentsPanel value={s.notificationAgents ?? []} onChange={(notificationAgents) => set({ notificationAgents })} />}
        {tab === 'arr' && <ArrSettingsPanel value={s.arr ?? []} onChange={(arr) => set({ arr })} publicUrl={s.publicUrl} />}
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
              Lets everyone search and download subtitles from the player and the item page. OpenSubtitles, Subs.ro and subtitle plugins
              are searched together; set them up below.
            </p>
            <h3 className="section-title">OpenSubtitles</h3>
            <p className="muted">
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
            <SubtitleSettingsPanel value={s.subtitles} onChange={(v) => set({ subtitles: v })} />
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
        {tab === 'lastfm' && (
          <div className="form-grid">
            <div className="howto">
              <strong><Icon name="info" size={16} /> How to set up Last.fm</strong>
              <ol>
                <li>Create an API account at <Ext href="https://www.last.fm/api/account/create">last.fm/api/account/create</Ext> (the callback URL can be left empty).</li>
                <li>Copy the <em>API key</em> and <em>Shared secret</em> here and save.</li>
                <li>Each user connects their own Last.fm account in <em>Settings → Connected services</em>; music they play is scrobbled.</li>
              </ol>
            </div>
            <div className="form-row">
              <Field label="API key"><input className="input mono" value={lf.apiKey ?? ''} onChange={(e) => setLf({ apiKey: e.target.value.trim() || null })} autoComplete="off" spellCheck={false} /></Field>
              <Field label="Shared secret"><input className="input mono" type="password" value={lf.sharedSecret ?? ''} onChange={(e) => setLf({ sharedSecret: e.target.value.trim() || null })} autoComplete="new-password" spellCheck={false} /></Field>
            </div>
          </div>
        )}
        {tab === 'sso' && (
          <div className="form-grid">
            <p className="muted">Let people sign in with an OpenID Connect provider such as Authentik, Keycloak, Authelia, Google or Microsoft Entra. Password and PIN sign-in keep working.</p>
            <Switch checked={oi.enabled} onChange={(v) => setOi({ enabled: v })} label="Enable single sign-on" hint="Shows a sign-in button on the login screen." />
            <div className="howto">
              <strong><Icon name="info" size={16} /> Redirect URI to register with your provider</strong>
              <div className="copy-row">
                <code className="mono">{callbackUrl}</code>
                <button type="button" className="btn btn-sm" onClick={() => { void navigator.clipboard?.writeText(callbackUrl); toast.success('Copied'); }}><Icon name="copy" size={14} /> Copy</button>
              </div>
              {!s.publicUrl && <p className="muted" style={{ marginTop: 8 }}>Set a Public URL on the General tab if people reach the server at a different address.</p>}
            </div>
            <Field label="Issuer URL" hint="The provider’s issuer; MediaMax reads /.well-known/openid-configuration from it.">
              <input className="input mono" value={oi.issuer ?? ''} onChange={(e) => setOi({ issuer: e.target.value.trim() || null })} placeholder="https://auth.example.com/application/o/mediamax/" spellCheck={false} />
            </Field>
            <div className="form-row">
              <Field label="Client ID"><input className="input mono" value={oi.clientId ?? ''} onChange={(e) => setOi({ clientId: e.target.value.trim() || null })} autoComplete="off" spellCheck={false} /></Field>
              <Field label="Client secret"><input className="input mono" type="password" value={oi.clientSecret ?? ''} onChange={(e) => setOi({ clientSecret: e.target.value.trim() || null })} autoComplete="new-password" spellCheck={false} /></Field>
            </div>
            <Field label="Button label"><input className="input" value={oi.buttonLabel} onChange={(e) => setOi({ buttonLabel: e.target.value })} placeholder="Sign in with SSO" /></Field>
            <Switch checked={oi.autoCreateUsers} onChange={(v) => setOi({ autoCreateUsers: v })} label="Create accounts on first sign-in" hint="When off, only people who already have a MediaMax account can use SSO." />
            <div className="form-row form-row-3">
              <Field label="Groups claim" hint="Usually “groups”."><input className="input mono" value={oi.groupsClaim} onChange={(e) => setOi({ groupsClaim: e.target.value })} placeholder="groups" spellCheck={false} /></Field>
              <Field label="Admin group" hint="Members become administrators."><input className="input" value={oi.adminGroup ?? ''} onChange={(e) => setOi({ adminGroup: e.target.value.trim() || null })} placeholder="mediamax-admins" /></Field>
              <Field label="Allowed group" hint="If set, only members may sign in."><input className="input" value={oi.allowedGroup ?? ''} onChange={(e) => setOi({ allowedGroup: e.target.value.trim() || null })} placeholder="mediamax-users" /></Field>
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
              <Field label="Browse as user" hint="Required. DLNA has no login, so it serves exactly what this user may see — library access and rating limits apply.">
                <select className="select" value={dl.userId ?? ''} onChange={(e) => setDl({ userId: e.target.value || null })}>
                  <option value="">Choose a user… (DLNA serves nothing until set)</option>
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
                <div className="row-gap">
                  <select className="select" value={w.format ?? 'mediamax'} onChange={(e) => setHook(i, { format: e.target.value as Webhook['format'] })} aria-label="Payload format">
                    <option value="mediamax">MediaMax JSON</option>
                    <option value="home-assistant">Home Assistant (flat JSON)</option>
                  </select>
                  {w.format === 'home-assistant' && <span className="muted">Flat payload for HA’s webhook trigger — see Admin → Smart home.</span>}
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
