import { useState, type FormEvent } from 'react';
import type { CreateLiveSourceRequest, LiveSource, LiveSourceType, TestSourceResponse } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useToast } from '../state/toast';
import { Icon } from './Icon';
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
  const [test, setTest] = useState<TestSourceResponse | null>(null);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof CreateLiveSourceRequest>(k: K, v: CreateLiveSourceRequest[K]) => setF((x) => ({ ...x, [k]: v }));

  const payload = (): CreateLiveSourceRequest => {
    const p: CreateLiveSourceRequest = {
      ...f,
      name: f.name || (f.type === 'xtream' ? 'Xtream' : f.type === 'm3u' ? 'M3U playlist' : 'HDHomeRun'),
      username: f.username || null,
      epgUrl: f.epgUrl || null,
      userAgent: f.userAgent || null,
    };
    // Leave the stored password untouched when editing and the field is blank.
    if (initial && !f.password) delete p.password;
    else p.password = f.password || null;
    return p;
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await api.livetv.testSource(payload()));
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

  const types: { value: LiveSourceType; label: string; hint: string }[] = [
    { value: 'xtream', label: 'Xtream Codes', hint: 'Live, VOD & series' },
    { value: 'm3u', label: 'M3U playlist', hint: 'Any IPTV playlist' },
    { value: 'hdhomerun', label: 'HDHomeRun', hint: 'Antenna tuner' },
  ];

  return (
    <form onSubmit={submit} className="form-grid">
      <div className="type-picker">
        {types.map((t) => (
          <button type="button" key={t.value} className={`type-option ${f.type === t.value ? 'active' : ''}`} onClick={() => set('type', t.value)}>
            <Icon name={t.value === 'hdhomerun' ? 'antenna' : t.value === 'xtream' ? 'zap' : 'list'} size={24} />
            <span>{t.label}</span>
            <small>{t.hint}</small>
          </button>
        ))}
      </div>
      <div className="form-row">
        <Field label="Name">
          <input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="My IPTV" />
        </Field>
        <Field label={f.type === 'xtream' ? 'Portal URL' : f.type === 'm3u' ? 'Playlist URL' : 'Device URL'}>
          <input className="input" value={f.url} onChange={(e) => set('url', e.target.value)} required placeholder={f.type === 'xtream' ? 'http://provider.example:8080' : f.type === 'm3u' ? 'https://…/playlist.m3u' : 'http://192.168.1.50'} />
        </Field>
      </div>
      {f.type === 'xtream' && (
        <div className="form-row">
          <Field label="Username">
            <input className="input" value={f.username ?? ''} onChange={(e) => set('username', e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Password" hint={initial?.password ? 'Leave blank to keep the saved password' : undefined}>
            <input className="input" type="password" value={f.password ?? ''} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" placeholder={initial?.password ? '••••' : ''} />
          </Field>
        </div>
      )}
      {f.type !== 'hdhomerun' && (
        <Field label="EPG (XMLTV) URL" hint={f.type === 'xtream' ? 'Optional — defaults to the provider’s xmltv.php' : 'Optional'}>
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
        <Switch checked={!!f.proxyStreams} onChange={(v) => set('proxyStreams', v)} label="Restream through MediaMax" hint="Hides provider credentials; enables remux & transcode." />
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
                {[test.liveCount != null && `${test.liveCount} live channels`, test.vodCount != null && `${test.vodCount} movies`, test.seriesCount != null && `${test.seriesCount} series`].filter(Boolean).join(' · ')}
              </p>
            )}
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
