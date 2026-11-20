import { useEffect, useState } from 'react';
import type { ArtworkTarget, BuiltinProviderId, MetadataProviderId, MetadataProviderInfo, MetadataSettings, MetadataSettingsResponse, MetadataTestResult } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useToast } from '../state/toast';
import { Badge, ErrorState, Field, Skeleton, Spinner, Switch } from '../components/ui';
import { Icon } from '../components/Icon';
import { formatBytes } from '../utils/format';
import '../styles/metadata.css';
import { MusicIdentificationSettings } from './MusicIdentification';

const MASK = '••••';
const TARGETS: { value: ArtworkTarget; label: string }[] = [
  { value: 'movie', label: 'Movies' },
  { value: 'show', label: 'Shows' },
  { value: 'artist', label: 'Artists' },
  { value: 'album', label: 'Albums' },
  { value: 'audiobook', label: 'Audiobooks' },
];
const TYPE_LABEL: Record<string, string> = { movie: 'Movies', show: 'Shows', season: 'Seasons', episode: 'Episodes', artist: 'Artists', album: 'Albums', audiobook: 'Audiobooks', track: 'Lyrics' };

/** Server settings → Metadata: built-in providers (enable, keys, priority, artwork source, Test). Saves on its own. */
export function MetadataSettingsPanel() {
  const toast = useToast();
  const [resp, setResp] = useState<MetadataSettingsResponse | null>(null);
  const [s, setS] = useState<MetadataSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<MetadataProviderId | null>(null);
  const [results, setResults] = useState<Partial<Record<MetadataProviderId, MetadataTestResult>>>({});
  const [refreshing, setRefreshing] = useState(false);

  const apply = (r: MetadataSettingsResponse) => {
    setResp(r);
    setS(r.settings);
    setDirty(false);
  };
  const load = () => {
    setError(null);
    api.metadata.get().then(apply).catch((e) => setError((e as Error).message));
  };
  useEffect(load, []);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!resp || !s) return <Skeleton h={400} />;

  const info = (id: MetadataProviderId) => resp.providers.find((p) => p.id === id);
  const ordered = s.order.map(info).filter((p): p is MetadataProviderInfo => !!p);
  const setP = (id: BuiltinProviderId, patch: Partial<MetadataSettings['providers'][BuiltinProviderId]>) => {
    setS({ ...s, providers: { ...s.providers, [id]: { ...s.providers[id], ...patch } } });
    setDirty(true);
  };
  const move = (id: MetadataProviderId, dir: -1 | 1) => {
    const order = [...s.order];
    const i = order.indexOf(id);
    const j = i + dir;
    // TMDB always runs first for movies and shows; it stays at the top.
    if (j < 1 || j >= order.length || id === 'tmdb') return;
    [order[i], order[j]] = [order[j], order[i]];
    setS({ ...s, order });
    setDirty(true);
  };

  const save = async (quiet = false) => {
    setSaving(true);
    try {
      apply(await api.metadata.save(s));
      if (!quiet) toast.success('Metadata settings saved');
      return true;
    } catch (e) {
      toast.error(e);
      return false;
    } finally {
      setSaving(false);
    }
  };
  const test = async (id: MetadataProviderId) => {
    setTesting(id);
    try {
      const cfg = id === 'tmdb' ? undefined : s.providers[id as BuiltinProviderId];
      const r = await api.metadata.test(id, cfg ? { apiKey: cfg.apiKey, pin: cfg.pin ?? null } : {});
      setResults((x) => ({ ...x, [id]: r }));
    } catch (e) {
      setResults((x) => ({ ...x, [id]: { ok: false, message: (e as Error).message, ms: 0 } }));
    } finally {
      setTesting(null);
    }
  };
  const refreshAll = async () => {
    setRefreshing(true);
    try {
      if (dirty && !(await save(true))) return;
      await api.admin.runTask('refresh-metadata');
      toast.success('Refreshing all metadata — follow progress in Scheduled tasks');
    } catch (e) {
      toast.error(e);
    } finally {
      setRefreshing(false);
    }
  };
  const clearCache = async () => {
    try {
      await api.metadata.clearCache();
      setResp({ ...resp, cache: { entries: 0, bytes: 0 } });
      toast.success('Metadata cache cleared');
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div className="md-settings">
      <div className="md-toolbar">
        <p className="muted md-intro">
          Built-in providers fill in what TMDB and your local files don't have. They only fill <b>empty, unlocked</b> fields, in the order below
          (artwork can follow a preferred source). Responses are cached and each service's rate limit is respected.
        </p>
        <div className="md-toolbar-actions">
          <button className="btn" onClick={() => void refreshAll()} disabled={refreshing}>{refreshing ? <Spinner size={16} /> : <Icon name="refresh" size={16} />} Refresh all metadata</button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={!dirty || saving}>{saving ? <Spinner size={18} /> : 'Save metadata settings'}</button>
        </div>
      </div>

      <h3 className="md-h">Providers <small className="muted">— priority order, highest first</small></h3>
      <div className="md-list">
        {ordered.map((p, i) => {
          const isTmdb = p.id === 'tmdb';
          const cfg = isTmdb ? null : s.providers[p.id as BuiltinProviderId];
          const res = results[p.id];
          const enabled = isTmdb ? p.enabled : cfg!.enabled;
          const needsKey = p.key === 'required' && !isTmdb && !cfg!.apiKey;
          return (
            <section key={p.id} className={`md-card ${enabled ? '' : 'md-off'}`}>
              <div className="md-card-head">
                <div className="md-order">
                  <button className="btn-icon" onClick={() => move(p.id, -1)} disabled={isTmdb || i <= 1} aria-label={`Move ${p.name} up`}><Icon name="chevronUp" size={16} /></button>
                  <span className="md-rank">{i + 1}</span>
                  <button className="btn-icon" onClick={() => move(p.id, 1)} disabled={isTmdb || i === ordered.length - 1} aria-label={`Move ${p.name} down`}><Icon name="chevronDown" size={16} /></button>
                </div>
                <div className="md-title">
                  <strong>{p.name}</strong>
                  <span className="md-badges">
                    {p.key === 'none' ? <Badge tone="success">No key</Badge> : p.key === 'optional' ? <Badge tone="muted">Optional key</Badge> : <Badge tone="primary">API key</Badge>}
                    {p.types.filter((t) => TYPE_LABEL[t] && t !== 'season' && t !== 'episode').map((t) => <Badge key={t} tone="muted">{TYPE_LABEL[t]}</Badge>)}
                    {enabled && (p.ready ? <Badge tone="success"><Icon name="check" size={11} /> Active</Badge> : needsKey ? <Badge tone="warning">Needs a key</Badge> : null)}
                  </span>
                </div>
                {isTmdb ? (
                  <span className="muted small">Key on the General tab</span>
                ) : (
                  <Switch checked={cfg!.enabled} onChange={(v) => setP(p.id as BuiltinProviderId, { enabled: v })} label={<span className="sr-only">Enable {p.name}</span>} />
                )}
              </div>
              <p className="md-desc">{p.description}</p>
              {!isTmdb && p.key !== 'none' && (
                <div className={`form-row ${p.pin ? '' : 'md-row-1'}`}>
                  <Field label={p.key === 'optional' ? 'API key (optional)' : 'API key'} hint={p.keyUrl ? <a href={p.keyUrl} target="_blank" rel="noreferrer" className="link-strong">Get a key <Icon name="external" size={12} /></a> : undefined}>
                    <SecretInput value={cfg!.apiKey} onChange={(v) => setP(p.id as BuiltinProviderId, { apiKey: v })} label={`${p.name} API key`} />
                  </Field>
                  {p.pin && (
                    <Field label="Subscriber PIN (optional)" hint="Only for TheTVDB subscriber keys.">
                      <SecretInput value={cfg!.pin ?? null} onChange={(v) => setP(p.id as BuiltinProviderId, { pin: v })} label="TheTVDB PIN" />
                    </Field>
                  )}
                </div>
              )}
              <div className="md-foot">
                <span className="muted small"><Icon name="info" size={12} /> {p.cost} {p.rateLimit}</span>
                {p.missing != null && p.missingLabel && (
                  <span className={`small ${p.missing ? '' : 'muted'}`} title="Items in libraries with metadata enabled">
                    <Icon name="database" size={12} /> {p.missing.toLocaleString()} {p.missingLabel}
                  </span>
                )}
                <span className="spacer" />
                {res && <span className={`small md-test ${res.ok ? 'ok' : 'fail'}`}><Icon name={res.ok ? 'checkCircle' : 'alert'} size={13} /> {res.message}{res.ms ? ` (${res.ms} ms)` : ''}</span>}
                <button className="btn btn-sm" onClick={() => void test(p.id)} disabled={testing === p.id}>{testing === p.id ? <Spinner size={14} /> : <Icon name="zap" size={14} />} Test</button>
              </div>
            </section>
          );
        })}
      </div>

      <h3 className="md-h">Preferred artwork source</h3>
      <p className="muted small">"Automatic" keeps local and TMDB art and lets providers fill gaps. Choosing a source lets it replace downloaded art (local files and locked artwork are never replaced).</p>
      <div className="md-art">
        {TARGETS.map((t) => (
          <Field key={t.value} label={t.label}>
            <select className="select" value={s.artwork[t.value]} onChange={(e) => { setS({ ...s, artwork: { ...s.artwork, [t.value]: e.target.value as MetadataProviderId | 'auto' } }); setDirty(true); }}>
              <option value="auto">Automatic</option>
              {resp.providers.filter((p) => p.artwork.includes(t.value)).map((p) => <option key={p.id} value={p.id}>{p.name}{p.ready ? '' : ' (not active)'}</option>)}
            </select>
          </Field>
        ))}
      </div>

      <h3 className="md-h">Cache</h3>
      <div className="md-cache">
        <Field label="Keep provider responses for (hours)" hint="0 turns the cache off. Misses (not found) are kept for at most a day.">
          <input className="input" type="number" min={0} max={2160} value={s.cacheTtlHours} onChange={(e) => { setS({ ...s, cacheTtlHours: Math.max(0, Number(e.target.value) || 0) }); setDirty(true); }} />
        </Field>
        <span className="muted small">{resp.cache.entries.toLocaleString()} cached responses · {formatBytes(resp.cache.bytes)}</span>
        <button className="btn btn-sm" onClick={() => void clearCache()} disabled={!resp.cache.entries}><Icon name="trash" size={14} /> Clear cache</button>
      </div>

      <MusicIdentificationSettings />
    </div>
  );
}

/** Write-only key field: a stored key comes back as "••••"; typing replaces it, the × removes it. */
export function SecretInput({ value, onChange, label }: { value: string | null; onChange: (v: string | null) => void; label: string }) {
  const stored = value === MASK;
  return (
    <div className="md-secret">
      <input
        className="input mono"
        type="password"
        autoComplete="off"
        aria-label={label}
        value={stored ? '' : value ?? ''}
        placeholder={stored ? 'Saved — type to replace' : 'Not set'}
        onChange={(e) => onChange(e.target.value || (stored ? MASK : null))}
      />
      {(stored || value) && <button type="button" className="btn-icon" onClick={() => onChange(null)} aria-label={`Remove ${label}`} title="Remove"><Icon name="x" size={14} /></button>}
    </div>
  );
}
