import { useState, type FormEvent } from 'react';
import type { CreateLiveSourceRequest, DiscoveredTuner, LiveSource, LiveSourceOptions, LiveSourceType, TestSourceResponse } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useToast } from '../state/toast';
import { Icon, type IconName } from './Icon';
import { Field, Spinner, Switch } from './ui';
import { formatDate } from '../utils/format';

export function AccountInfo({ info }: { info: NonNullable<LiveSource['accountInfo']> }) {
  const expires = info.expiresAt ? new Date(info.expiresAt) : null;
  const days = expires ? Math.round((expires.getTime() - Date.now()) / 86400000) : null;
  return (
    <div className="account-info">
      <span className={`badge ${info.status.toLowerCase() === 'active' ? 'badge-success' : 'badge-warning'}`}>{info.status}</span>
      {info.isTrial && <span className="badge badge-accent">Trial</span>}
      <span>
        <Icon name="users" size={14} /> {info.activeConnections}/{info.maxConnections} connections
      </span>
      <span className={days != null && days < 7 ? 'text-warning' : ''}>
        <Icon name="calendar" size={14} /> {expires ? `Expires ${formatDate(info.expiresAt)}${days != null ? ` (${days < 0 ? 'expired' : `${days}d`})` : ''}` : 'No expiry'}
      </span>
    </div>
  );
}

/** Hardware tuners and set-top boxes: always restreamed, device info instead of an IPTV account. */
export const TUNER_TYPES: LiveSourceType[] = ['tvheadend', 'satip', 'enigma2'];
export const isTuner = (t: LiveSourceType) => TUNER_TYPES.includes(t);

export const SOURCE_TYPES: { value: LiveSourceType; label: string; hint: string; icon: IconName }[] = [
  { value: 'xtream', label: 'Xtream Codes', hint: 'Live, VOD & series', icon: 'zap' },
  { value: 'm3u', label: 'M3U playlist', hint: 'Any IPTV playlist', icon: 'list' },
  { value: 'hdhomerun', label: 'HDHomeRun', hint: 'Antenna / cable tuner', icon: 'antenna' },
  { value: 'tvheadend', label: 'TVHeadend', hint: 'DVB backend server', icon: 'server' },
  { value: 'satip', label: 'SAT>IP', hint: 'Octopus, FRITZ!Box Cable…', icon: 'globe' },
  { value: 'enigma2', label: 'Enigma2', hint: 'Vu+, Dreambox (OpenWebif)', icon: 'monitor' },
];
export const sourceTypeInfo = (t: LiveSourceType) => SOURCE_TYPES.find((x) => x.value === t) ?? SOURCE_TYPES[1]!;

const URL_LABEL: Partial<Record<LiveSourceType, string>> = { xtream: 'Portal URL', m3u: 'Playlist URL', hdhomerun: 'Device URL', tvheadend: 'TVHeadend URL', satip: 'Device address', enigma2: 'Receiver URL' };
const URL_HINT: Partial<Record<LiveSourceType, string>> = {
  xtream: 'http://provider.example:8080', m3u: 'https://…/playlist.m3u', hdhomerun: 'http://192.168.1.50', tvheadend: 'http://192.168.1.10:9981', satip: 'http://192.168.178.1', enigma2: 'http://192.168.1.20',
};
const FRITZ_LISTS = [
  { id: 'tvhd', label: 'TV (HD)' },
  { id: 'tvsd', label: 'TV (SD)' },
  { id: 'radio', label: 'Radio' },
];

function Discover({ kind, onPick }: { kind: 'satip' | 'hdhomerun'; onPick: (d: DiscoveredTuner) => void }) {
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<DiscoveredTuner[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      setFound((await api.livetv.discoverTuners()).filter((d) => d.kind === kind));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tuner-discover">
      <button type="button" className="btn btn-sm" onClick={run} disabled={busy}>
        {busy ? <Spinner size={14} /> : <Icon name="search" size={14} />} Find {kind === 'satip' ? 'SAT>IP servers' : 'HDHomeRun tuners'} on the network
      </button>
      {err && <span className="text-warning">{err}</span>}
      {found && !found.length && <span className="muted">Nothing found. Discovery needs the server on the same network (Docker: host networking) — enter the address instead.</span>}
      {found?.map((d) => (
        <button type="button" key={(d.deviceId ?? '') + d.address} className="check-chip" onClick={() => onPick(d)}>
          <Icon name={kind === 'satip' ? 'globe' : 'antenna'} size={14} /> <strong>{d.name}</strong>
          <span className="muted">{d.address.replace(/^https?:\/\//, '')}{d.tunerCount ? ` · ${d.tunerCount} tuners` : ''}{d.capabilities ? ` · ${d.capabilities}` : ''}</span>
        </button>
      ))}
    </div>
  );
}

export function SourceForm({ initial, onSaved, onCancel, compact }: { initial?: LiveSource; onSaved: (s: LiveSource) => void; onCancel?: () => void; compact?: boolean }) {
  const toast = useToast();
  const [f, setF] = useState<CreateLiveSourceRequest>({
    name: initial?.name ?? '',
    type: initial?.type ?? 'xtream',
    url: initial?.url ?? '',
    username: initial?.username ?? '',
    password: initial?.password ? '' : '',
    epgUrl: initial?.epgUrl ?? '',
    enabled: initial?.enabled ?? true,
    proxyStreams: initial?.proxyStreams ?? true,
    importVod: initial?.importVod ?? true,
    importSeries: initial?.importSeries ?? true,
    userAgent: initial?.userAgent ?? '',
    refreshIntervalHours: initial?.refreshIntervalHours ?? 12,
  });
  const [opts, setOpts] = useState<LiveSourceOptions>(initial?.options ?? {});
  const [test, setTest] = useState<TestSourceResponse | null>(null);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof CreateLiveSourceRequest>(k: K, v: CreateLiveSourceRequest[K]) => setF((x) => ({ ...x, [k]: v }));
  const setOpt = <K extends keyof LiveSourceOptions>(k: K, v: LiveSourceOptions[K]) => setOpts((x) => ({ ...x, [k]: v }));
  const tuner = isTuner(f.type);
  const hasLogin = f.type === 'xtream' || f.type === 'tvheadend' || f.type === 'enigma2';

  const payload = (): CreateLiveSourceRequest => {
    const p: CreateLiveSourceRequest = {
      ...f,
      name: f.name || sourceTypeInfo(f.type).label,
      username: f.username || null,
      epgUrl: f.epgUrl || null,
      userAgent: f.userAgent || null,
    };
    if (tuner) p.options = opts;
    // Leave the stored password untouched when editing and the field is blank.
    if (initial && !f.password) delete p.password;
    else p.password = f.password || null;
    return p;
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const r = await api.livetv.testSource({ ...payload(), ...(initial ? { sourceId: initial.id } : {}) });
      setTest(r);
      if (r.ok && f.type === 'tvheadend' && r.profiles?.length && !opts.profile) setOpt('profile', r.profiles.includes('pass') ? 'pass' : r.profiles[0]);
    } catch (e) {
      setTest({ ok: false, message: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const s = initial ? await api.livetv.updateSource(initial.id, payload()) : await api.livetv.createSource(payload());
      toast.success(initial ? 'Source updated' : 'Source added — importing channels');
      onSaved(s);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const pickDevice = (d: DiscoveredTuner) => {
    set('url', d.address);
    if (!f.name) set('name', d.name);
    if (d.kind === 'satip') setOpts((x) => ({ ...x, descriptionUrl: d.descriptionUrl, satipMode: d.isFritzBox ? 'fritzbox' : x.satipMode ?? 'm3u' }));
  };

  const bouquets = test?.bouquets ?? [];
  const selectedBouquets = opts.bouquets ?? [];
  const toggleBouquet = (ref: string) => setOpt('bouquets', selectedBouquets.includes(ref) ? selectedBouquets.filter((b) => b !== ref) : [...selectedBouquets, ref]);
  const fritzLists = opts.fritzLists?.length ? opts.fritzLists : ['tvhd', 'tvsd'];
  const satipMode = opts.satipMode ?? 'm3u';

  return (
    <form onSubmit={submit} className="form-grid">
      {!initial && (
        <div className="type-picker">
          {SOURCE_TYPES.map((t) => (
            <button type="button" key={t.value} className={`type-option ${f.type === t.value ? 'active' : ''}`} onClick={() => { set('type', t.value); setTest(null); }}>
              <Icon name={t.icon} size={24} />
              <span>{t.label}</span>
              <small>{t.hint}</small>
            </button>
          ))}
        </div>
      )}
      {(f.type === 'satip' || f.type === 'hdhomerun') && <Discover kind={f.type} onPick={pickDevice} />}
      <div className="form-row">
        <Field label="Name">
          <input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder={tuner ? sourceTypeInfo(f.type).label : 'My IPTV'} />
        </Field>
        <Field label={URL_LABEL[f.type] ?? 'URL'} hint={f.type === 'enigma2' ? 'OpenWebif address; streams come from port 8001' : f.type === 'satip' ? 'IP address of the SAT>IP server' : undefined}>
          <input className="input" value={f.url} onChange={(e) => set('url', e.target.value)} required placeholder={URL_HINT[f.type]} />
        </Field>
      </div>
      {hasLogin && (
        <div className="form-row">
          <Field label="Username" hint={f.type === 'xtream' ? undefined : 'Optional — only if the device asks for a login'}>
            <input className="input" value={f.username ?? ''} onChange={(e) => set('username', e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Password" hint={initial?.password ? 'Leave blank to keep the saved password' : undefined}>
            <input className="input" type="password" value={f.password ?? ''} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" placeholder={initial?.password ? '••••' : ''} />
          </Field>
        </div>
      )}

      {f.type === 'tvheadend' && (
        <div className="form-row">
          <Field label="Stream profile" hint="“pass” sends the untouched broadcast; other profiles are TVHeadend’s own transcodes.">
            {test?.profiles?.length ? (
              <select className="select" value={opts.profile ?? 'pass'} onChange={(e) => setOpt('profile', e.target.value)}>
                {test.profiles.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            ) : (
              <input className="input" value={opts.profile ?? ''} onChange={(e) => setOpt('profile', e.target.value)} placeholder="pass" />
            )}
          </Field>
          <Field label="Authentication">
            <select className="select" value={opts.authType ?? 'auto'} onChange={(e) => setOpt('authType', e.target.value as LiveSourceOptions['authType'])}>
              <option value="auto">Automatic (Digest or plain)</option>
              <option value="digest">Digest</option>
              <option value="basic">Plain (Basic)</option>
            </select>
          </Field>
        </div>
      )}

      {f.type === 'satip' && (
        <>
          <Field label="Channel list">
            <div className="chip-row">
              <label className={`check-chip ${satipMode === 'fritzbox' ? 'on' : ''}`}>
                <input type="radio" name="satip-mode" checked={satipMode === 'fritzbox'} onChange={() => setOpt('satipMode', 'fritzbox')} /> FRITZ!Box built-in lists
              </label>
              <label className={`check-chip ${satipMode === 'm3u' ? 'on' : ''}`}>
                <input type="radio" name="satip-mode" checked={satipMode === 'm3u'} onChange={() => setOpt('satipMode', 'm3u')} /> M3U with SAT&gt;IP URLs
              </label>
            </div>
          </Field>
          {satipMode === 'fritzbox' ? (
            <Field label="FRITZ!Box lists" hint="Run the cable channel scan in the FRITZ!Box first (DVB-C → Channel list).">
              <div className="chip-row">
                {FRITZ_LISTS.map((l) => (
                  <label key={l.id} className={`check-chip ${fritzLists.includes(l.id) ? 'on' : ''}`}>
                    <input type="checkbox" checked={fritzLists.includes(l.id)} onChange={() => setOpt('fritzLists', fritzLists.includes(l.id) ? fritzLists.filter((x) => x !== l.id) : [...fritzLists, l.id])} /> {l.label}
                  </label>
                ))}
              </div>
            </Field>
          ) : (
            <Field label="Channel list URL" hint="rtsp://… or http://<ip>/?src=1&freq=… entries; a “sat.ip” host is replaced by the device address.">
              <input className="input" value={opts.playlistUrl ?? ''} onChange={(e) => setOpt('playlistUrl', e.target.value)} placeholder="https://…/astra19.2.m3u" />
            </Field>
          )}
          <div className="form-row">
            <Field label="RTSP transport" hint="FRITZ!Box only streams over UDP (needs host networking in Docker).">
              <select className="select" value={opts.rtspTransport ?? ''} onChange={(e) => setOpt('rtspTransport', (e.target.value || null) as LiveSourceOptions['rtspTransport'])}>
                <option value="">Automatic</option>
                <option value="tcp">TCP (interleaved)</option>
                <option value="udp">UDP</option>
              </select>
            </Field>
            <Field label="Device description URL" hint="Filled in by discovery; used for the tuner count.">
              <input className="input" value={opts.descriptionUrl ?? ''} onChange={(e) => setOpt('descriptionUrl', e.target.value)} placeholder="http://192.168.178.1:49000/satipdesc.xml" />
            </Field>
          </div>
        </>
      )}

      {f.type === 'enigma2' && (
        <>
          <Field label="Bouquets" hint={bouquets.length ? 'Channels of the ticked bouquets are imported (default: the first).' : 'Test the connection to load the receiver’s bouquets.'}>
            {bouquets.length ? (
              <div className="chip-row">
                {bouquets.map((b) => (
                  <label key={b.ref} className={`check-chip ${selectedBouquets.includes(b.ref) ? 'on' : ''}`}>
                    <input type="checkbox" checked={selectedBouquets.includes(b.ref)} onChange={() => toggleBouquet(b.ref)} /> {b.name}
                  </label>
                ))}
              </div>
            ) : (
              <p className="muted">{selectedBouquets.length ? `${selectedBouquets.length} bouquet(s) selected.` : 'First bouquet.'}</p>
            )}
          </Field>
          <div className="form-row">
            <Field label="Streaming port">
              <input className="input" type="number" min={1} max={65535} value={(opts.useTranscoding ? opts.transcodePort : opts.streamPort) ?? ''} placeholder={opts.useTranscoding ? '8002' : '8001'}
                onChange={(e) => setOpt(opts.useTranscoding ? 'transcodePort' : 'streamPort', e.target.value ? Number(e.target.value) : null)} />
            </Field>
            <Field label="Guide days">
              <input className="input" type="number" min={1} max={14} value={opts.guideDays ?? ''} placeholder="7" onChange={(e) => setOpt('guideDays', e.target.value ? Number(e.target.value) : null)} />
            </Field>
          </div>
          <div className="switch-group">
            <Switch checked={!!opts.streamAuth} onChange={(v) => setOpt('streamAuth', v)} label="Stream authentication" hint="Turn on when OpenWebif’s “streamauth” protects port 8001." />
            <Switch checked={!!opts.useTranscoding} onChange={(v) => setOpt('useTranscoding', v)} label="Use the receiver’s transcoding port" hint="Boxes with a hardware encoder (port 8002) send H.264 instead of the raw broadcast." />
          </div>
        </>
      )}

      {tuner && (
        <Field label="Max simultaneous streams" hint="Default: the number of tuners the device reports.">
          <input className="input" type="number" min={1} max={64} value={opts.maxStreams ?? ''} placeholder={test?.tunerCount ? String(test.tunerCount) : initial?.tunerCount ? String(initial.tunerCount) : 'Auto'} onChange={(e) => setOpt('maxStreams', e.target.value ? Number(e.target.value) : null)} />
        </Field>
      )}

      {f.type !== 'hdhomerun' && (
        <Field label="EPG (XMLTV) URL" hint={f.type === 'xtream' ? 'Optional — defaults to the provider’s xmltv.php' : f.type === 'tvheadend' || f.type === 'enigma2' ? 'Optional — the device’s own guide is used automatically; XMLTV URLs here take priority' : f.type === 'satip' ? 'Optional — or add an iptv-org / XMLTV guide under TV guide; channels are matched by name' : 'Optional'}>
          <input className="input" value={f.epgUrl ?? ''} onChange={(e) => set('epgUrl', e.target.value)} placeholder="https://…/epg.xml.gz" />
        </Field>
      )}
      {!compact && (
        <div className="form-row">
          <Field label="User-Agent override">
            <input className="input" value={f.userAgent ?? ''} onChange={(e) => set('userAgent', e.target.value)} placeholder="Default" />
          </Field>
          <Field label="Refresh every (hours)">
            <input className="input" type="number" min={1} max={168} value={f.refreshIntervalHours ?? 12} onChange={(e) => set('refreshIntervalHours', Number(e.target.value))} />
          </Field>
        </div>
      )}
      <div className="switch-group">
        {f.type === 'xtream' && <Switch checked={!!f.importVod} onChange={(v) => set('importVod', v)} label="Import VOD movies" hint="Creates a browsable movie library." />}
        {f.type === 'xtream' && <Switch checked={!!f.importSeries} onChange={(v) => set('importSeries', v)} label="Import series" hint="Creates a browsable TV library." />}
        {!tuner && <Switch checked={!!f.proxyStreams} onChange={(v) => set('proxyStreams', v)} label="Restream through MediaMax" hint="Hides provider credentials; enables remux & transcode." />}
        {!compact && <Switch checked={!!f.enabled} onChange={(v) => set('enabled', v)} label="Enabled" />}
      </div>
      {test && (
        <div className={`test-result ${test.ok ? 'ok' : 'fail'}`}>
          <Icon name={test.ok ? 'checkCircle' : 'alert'} size={20} />
          <div>
            <strong>{test.ok ? 'Connection successful' : 'Connection failed'}</strong>
            <p>{test.message}</p>
            {test.ok && (
              <p className="muted">
                {[test.liveCount != null && `${test.liveCount} live channels`, test.tunerCount != null && `${test.tunerCount} tuners`, test.vodCount != null && `${test.vodCount} movies`, test.seriesCount != null && `${test.seriesCount} series`].filter(Boolean).join(' · ')}
              </p>
            )}
            {test.deviceInfo?.tuners.length ? <p className="muted">{test.deviceInfo.tuners.join(' · ')}</p> : null}
            {test.warnings?.map((w) => <p key={w} className="text-warning">{w}</p>)}
            {test.accountInfo && <AccountInfo info={test.accountInfo} />}
          </div>
        </div>
      )}
      <div className="form-actions">
        {onCancel && <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>}
        <button type="button" className="btn" onClick={runTest} disabled={testing || !f.url}>
          {testing ? <Spinner size={16} /> : <Icon name="zap" size={16} />} Test connection
        </button>
        <button className="btn btn-primary" disabled={busy || !f.url}>{busy ? <Spinner size={18} /> : initial ? 'Save' : 'Add source'}</button>
      </div>
    </form>
  );
}
