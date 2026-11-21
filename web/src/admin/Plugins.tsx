import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { PluginCatalogEntry, PluginInfo, PluginManifest, PluginSetting, PluginStatus } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useToast } from '../state/toast';
import { useAsync, type AsyncState } from '../hooks';
import { Badge, EmptyState, ErrorState, Field, Modal, Skeleton, Spinner, Switch, Tabs, useConfirm } from '../components/ui';
import { Icon } from '../components/Icon';
import { relativeTime } from '../utils/format';
import { AdminHeader } from './AdminRoutes';

type Tab = 'installed' | 'catalog' | 'repositories';
type SettingValue = string | number | boolean | null;

const DOCS_URL = 'https://github.com/Bucifer6/MediaMax/blob/main/docs/PLUGINS.md';
const MASK = '••••••••';

const STATUS_TONE: Record<PluginStatus, 'success' | 'muted' | 'danger' | 'warning'> = {
  active: 'success', disabled: 'muted', error: 'danger', incompatible: 'warning',
};
const SOURCE_LABEL: Record<PluginInfo['source'], string> = { repository: 'Repository', upload: 'Uploaded', local: 'Local folder' };
const CAP_LABEL: Record<NonNullable<PluginManifest['capabilities']>[number], string> = {
  routes: 'API routes', events: 'Events', tasks: 'Scheduled tasks', metadata: 'Metadata', subtitles: 'Subtitle provider', adminPage: 'Admin page', network: 'Network access',
};

/** Semver-ish compare: "1.10.0" > "1.9.2". Pre-release suffixes are ignored. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

function isHttpsUrl(v: string): boolean {
  try {
    const u = new URL(v);
    // https everywhere; plain http only for local development repositories (matches the server rule).
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname));
  } catch {
    return false;
  }
}

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer" className="link-strong">{children} <Icon name="external" size={12} /></a>;
}

function Capabilities({ caps }: { caps?: PluginManifest['capabilities'] }) {
  if (!caps?.length) return null;
  return (
    <ul className="plugin-caps" aria-label="Capabilities">
      {caps.map((c) => <li key={c}><Badge tone={c === 'network' ? 'warning' : 'accent'}>{CAP_LABEL[c] ?? c}</Badge></li>)}
    </ul>
  );
}

export function PluginsAdmin() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: Tab = raw === 'catalog' || raw === 'repositories' ? raw : 'installed';
  const setTab = (t: Tab) => setParams(t === 'installed' ? {} : { tab: t }, { replace: true });
  const installed = useAsync(() => api.plugins.list(), []);
  const [viewing, setViewing] = useState<PluginInfo | null>(null);

  if (viewing?.adminPageUrl) {
    return (
      <div>
        <AdminHeader help="admin-plugins"
          title={viewing.manifest.name}
          subtitle={`Admin page provided by the plugin · v${viewing.manifest.version}`}
          actions={<button className="btn" onClick={() => setViewing(null)}><Icon name="arrowLeft" size={16} /> Back to plugins</button>}
        />
        <iframe
          className="plugin-frame"
          src={viewing.adminPageUrl}
          title={`${viewing.manifest.name} admin page`}
          sandbox="allow-scripts allow-forms"
        />
      </div>
    );
  }

  return (
    <div>
      <AdminHeader help="admin-plugins" title="Plugins" subtitle="Extend the server with notifications, metadata providers, scheduled jobs and more." />
      <div className="callout-warning plugin-warning" role="note">
        <Icon name="alert" size={18} />
        <p><strong>Plugins run inside the server with full access</strong> to your media, users and network. Only install plugins from authors and repositories you trust.</p>
      </div>
      <Tabs<Tab>
        className="plugin-tabs"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'installed', label: <>Installed{installed.data ? ` (${installed.data.length})` : ''}</> },
          { value: 'catalog', label: 'Catalog' },
          { value: 'repositories', label: 'Repositories' },
        ]}
      />
      {tab === 'installed' && <InstalledTab state={installed} onOpen={setViewing} onBrowse={() => setTab('catalog')} />}
      {tab === 'catalog' && <CatalogTab installed={installed.data ?? []} onInstalled={installed.reload} onRepos={() => setTab('repositories')} />}
      {tab === 'repositories' && <RepositoriesTab />}
    </div>
  );
}

/* ------------------------------ Installed ------------------------------ */

function UploadButton({ onUploaded }: { onUploaded: (p: PluginInfo) => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (f: File) => {
    if (!/\.(tar\.gz|tgz)$/i.test(f.name)) {
      toast.show('Choose a .tar.gz plugin package', 'error');
      return;
    }
    setBusy(true);
    try {
      const p = await api.plugins.upload(f);
      toast.success(`Installed ${p.manifest.name} ${p.manifest.version}`);
      onUploaded(p);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className="btn" onClick={() => input.current?.click()} disabled={busy}>
        {busy ? <Spinner size={16} /> : <Icon name="upload" size={16} />} Upload plugin
      </button>
      <input
        ref={input}
        type="file"
        accept=".tar.gz,.tgz,application/gzip,application/x-gzip"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void pick(f);
        }}
      />
    </>
  );
}

function InstalledTab({ state, onOpen, onBrowse }: { state: AsyncState<PluginInfo[]>; onOpen: (p: PluginInfo) => void; onBrowse: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<PluginInfo | null>(null);
  const replace = (p: PluginInfo) => state.setData((l) => ((l ?? []).some((x) => x.manifest.id === p.manifest.id) ? (l ?? []).map((x) => (x.manifest.id === p.manifest.id ? p : x)) : [...(l ?? []), p]));
  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try {
      await fn();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const toggle = (p: PluginInfo, enabled: boolean) => run(p.manifest.id, async () => {
    const next = await api.plugins.setEnabled(p.manifest.id, enabled);
    replace(next);
    if (next.status === 'error') toast.show(`${p.manifest.name} failed to start: ${next.error ?? 'unknown error'}`, 'error');
    else toast.success(`${p.manifest.name} ${enabled ? 'enabled' : 'disabled'}`);
  });
  const update = (p: PluginInfo) => run(p.manifest.id, async () => {
    const next = await api.plugins.install(p.manifest.id, p.updateAvailable ?? undefined);
    replace(next);
    toast.success(`${p.manifest.name} updated to ${next.manifest.version}`);
  });
  const uninstall = async (p: PluginInfo) => {
    if (!(await confirm({ title: `Uninstall ${p.manifest.name}?`, message: 'The plugin, its settings and its stored data will be removed from the server.', confirmLabel: 'Uninstall', danger: true }))) return;
    await run(p.manifest.id, async () => {
      await api.plugins.uninstall(p.manifest.id);
      state.setData((l) => (l ?? []).filter((x) => x.manifest.id !== p.manifest.id));
      toast.success(`${p.manifest.name} uninstalled`);
    });
  };

  const list = [...(state.data ?? [])].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  return (
    <>
      <div className="toolbar plugin-toolbar">
        <UploadButton onUploaded={replace} />
        <button className="btn btn-ghost" onClick={state.reload} disabled={state.loading}><Icon name="refresh" size={16} className={state.loading ? 'spin' : ''} /> Refresh</button>
      </div>
      {state.loading && !state.data ? <Skeleton h={260} /> : state.error ? <ErrorState message={state.error} onRetry={state.reload} /> : !list.length ? (
        <EmptyState
          icon="puzzle"
          title="No plugins installed"
          message="Install one from the catalog, or upload a .tar.gz package."
          action={<button className="btn btn-primary" onClick={onBrowse}><Icon name="compass" size={16} /> Browse catalog</button>}
        />
      ) : (
        <div className="plugin-grid">
          {list.map((p) => {
            const m = p.manifest;
            const isBusy = busy === m.id;
            return (
              <article key={m.id} className={`plugin-card status-${p.status}`} aria-busy={isBusy}>
                <div className="plugin-head">
                  <div className="plugin-icon"><Icon name="puzzle" size={22} /></div>
                  <div className="plugin-title">
                    <h3>{m.name} <span className="muted plugin-version">v{m.version}</span></h3>
                    <p className="muted">{m.author ? `by ${m.author}` : m.id}</p>
                  </div>
                  <Badge tone={STATUS_TONE[p.status]} className="plugin-status">{p.status}</Badge>
                </div>
                {m.description && <p className="plugin-desc">{m.description}</p>}
                {p.error && <p className="form-error plugin-error"><Icon name="alert" size={14} /> {p.error}</p>}
                <Capabilities caps={m.capabilities} />
                <div className="plugin-meta">
                  <span><Icon name={p.source === 'repository' ? 'globe' : p.source === 'upload' ? 'upload' : 'folder'} size={13} /> {SOURCE_LABEL[p.source]}</span>
                  <span><Icon name="clock" size={13} /> Installed {relativeTime(p.installedAt)}</span>
                  {m.homepage && <Ext href={m.homepage}>Homepage</Ext>}
                </div>
                {p.updateAvailable && (
                  <div className="plugin-update">
                    <span><Icon name="sparkles" size={14} /> Version {p.updateAvailable} is available</span>
                    <button className="btn btn-primary btn-sm" onClick={() => update(p)} disabled={isBusy}>
                      <Icon name="download" size={14} /> Update to {p.updateAvailable}
                    </button>
                  </div>
                )}
                <div className="plugin-foot">
                  <Switch
                    label="Enabled"
                    checked={p.status !== 'disabled'}
                    disabled={isBusy}
                    onChange={(v) => toggle(p, v)}
                  />
                  <div className="plugin-actions">
                    {p.adminPageUrl && (
                      <button className="btn btn-sm" onClick={() => onOpen(p)}><Icon name="external" size={14} /> Open</button>
                    )}
                    {!!m.settings?.length && (
                      <button className="btn btn-sm" onClick={() => setEditing(p)}><Icon name="settings" size={14} /> Settings</button>
                    )}
                    <button className="btn btn-ghost btn-sm plugin-remove" onClick={() => uninstall(p)} disabled={isBusy} aria-label={`Uninstall ${m.name}`}>
                      <Icon name="trash" size={14} /> Uninstall
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {editing && <SettingsModal plugin={editing} onClose={() => setEditing(null)} onSaved={(p) => { replace(p); setEditing(null); }} />}
    </>
  );
}

/* ------------------------------ Settings modal ------------------------------ */

function initialValue(s: PluginSetting, current: SettingValue | undefined): SettingValue {
  const v = current !== undefined ? current : s.default ?? null;
  if (s.type === 'boolean') return v === true || v === 'true';
  if (s.type === 'number') return v == null ? '' : String(v);
  if (s.type === 'select') return v == null ? '' : String(v);
  return v == null ? '' : String(v);
}

function SettingsModal({ plugin, onClose, onSaved }: { plugin: PluginInfo; onClose: () => void; onSaved: (p: PluginInfo) => void }) {
  const toast = useToast();
  const defs = useMemo(() => plugin.manifest.settings ?? [], [plugin]);
  const [values, setValues] = useState<Record<string, SettingValue>>(() => Object.fromEntries(defs.map((s) => [s.key, initialValue(s, plugin.settings[s.key])])));
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const formId = `plugin-settings-${plugin.manifest.id}`;
  const set = (key: string, v: SettingValue) => {
    setValues((x) => ({ ...x, [key]: v }));
    setTouched((t) => new Set(t).add(key));
    setErrors((e) => {
      if (!(key in e)) return e;
      const { [key]: _drop, ...rest } = e;
      return rest;
    });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const out: Record<string, SettingValue> = {};
    for (const s of defs) {
      const v = values[s.key];
      if (s.type === 'secret' && !touched.has(s.key)) {
        if (s.required && !v) errs[s.key] = 'Required';
        continue; // unchanged secret: keep server value
      }
      if (s.type === 'number' && v !== '' && v != null && !Number.isFinite(Number(v))) errs[s.key] = 'Enter a number';
      if (s.required && s.type !== 'boolean' && (v === '' || v == null)) errs[s.key] = 'Required';
      out[s.key] = s.type === 'number' ? (v === '' || v == null ? null : Number(v)) : v;
    }
    setErrors(errs);
    if (Object.keys(errs).length) {
      document.getElementById(`${formId}-${Object.keys(errs)[0]}`)?.focus();
      return;
    }
    setSaving(true);
    try {
      const next = await api.plugins.saveSettings(plugin.manifest.id, out);
      toast.success(`${plugin.manifest.name} settings saved`);
      onSaved(next);
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const label = (s: PluginSetting) => <>{s.label}{s.required && <span className="plugin-req" aria-hidden="true"> *</span>}</>;
  return (
    <Modal
      open
      onClose={onClose}
      title={`${plugin.manifest.name} settings`}
      size="md"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" form={formId} className="btn btn-primary" disabled={saving}>{saving ? <Spinner size={16} /> : <Icon name="check" size={16} />} Save</button>
        </>
      }
    >
      <form id={formId} className="form-grid" onSubmit={submit} noValidate>
        {defs.some((s) => s.required) && <p className="muted plugin-req-note"><span className="plugin-req">*</span> Required</p>}
        {defs.map((s) => {
          const id = `${formId}-${s.key}`;
          const v = values[s.key];
          const err = errors[s.key];
          const hint = err ? <span className="form-error">{err}</span> : s.help;
          const common = { id, 'aria-required': s.required || undefined, 'aria-invalid': !!err || undefined };
          switch (s.type) {
            case 'boolean':
              return <Switch key={s.key} label={label(s)} hint={s.help} checked={v === true} onChange={(x) => set(s.key, x)} />;
            case 'secret': {
              const isSet = !touched.has(s.key) && v === MASK;
              return (
                <Field key={s.key} label={label(s)} hint={hint ?? (isSet ? 'A value is saved. Type to replace it.' : undefined)}>
                  <input
                    {...common}
                    className="input"
                    type="password"
                    autoComplete="new-password"
                    value={String(v ?? '')}
                    placeholder={isSet ? MASK : ''}
                    onFocus={(e) => isSet && e.currentTarget.select()}
                    onChange={(e) => set(s.key, e.target.value)}
                  />
                </Field>
              );
            }
            case 'number':
              return (
                <Field key={s.key} label={label(s)} hint={hint}>
                  <input {...common} className="input" type="number" inputMode="decimal" value={String(v ?? '')} onChange={(e) => set(s.key, e.target.value)} />
                </Field>
              );
            case 'select':
              return (
                <Field key={s.key} label={label(s)} hint={hint}>
                  <select {...common} className="select" value={String(v ?? '')} onChange={(e) => set(s.key, e.target.value || null)}>
                    {(!s.required || !v) && <option value="">{s.required ? 'Choose…' : 'None'}</option>}
                    {(s.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </Field>
              );
            case 'text':
              return (
                <Field key={s.key} label={label(s)} hint={hint}>
                  <textarea {...common} className="textarea" rows={5} value={String(v ?? '')} onChange={(e) => set(s.key, e.target.value)} />
                </Field>
              );
            default:
              return (
                <Field key={s.key} label={label(s)} hint={hint}>
                  <input {...common} className="input" type="text" value={String(v ?? '')} onChange={(e) => set(s.key, e.target.value)} />
                </Field>
              );
          }
        })}
      </form>
    </Modal>
  );
}

/* ------------------------------ Catalog ------------------------------ */

function CatalogTab({ installed, onInstalled, onRepos }: { installed: PluginInfo[]; onInstalled: () => void; onRepos: () => void }) {
  const toast = useToast();
  const [refresh, setRefresh] = useState(0);
  const settings = useAsync(() => api.admin.settings(), []);
  const repos = settings.data?.plugins?.repositories ?? [];
  const hasRepos = repos.length > 0;
  const catalog = useAsync(async () => (hasRepos ? api.plugins.catalog(refresh > 0) : ([] as PluginCatalogEntry[])), [refresh, hasRepos]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const byId = useMemo(() => new Map(installed.map((p) => [p.manifest.id, p])), [installed]);

  const install = async (e: PluginCatalogEntry, version: string) => {
    setBusy(e.id);
    try {
      const p = await api.plugins.install(e.id, version);
      toast.success(`Installed ${p.manifest.name} ${p.manifest.version}${p.status === 'disabled' ? '. Enable it on the Installed tab.' : ''}`);
      catalog.setData((l) => (l ?? []).map((x) => (x.id === e.id ? { ...x, installedVersion: p.manifest.version } : x)));
      onInstalled();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  if (settings.loading && !settings.data) return <Skeleton h={260} />;
  if (settings.error) return <ErrorState message={settings.error} onRetry={settings.reload} />;
  if (!hasRepos) {
    return (
      <EmptyState
        icon="globe"
        title="No repositories configured"
        message="Add a plugin repository URL to browse and install plugins from it."
        action={<button className="btn btn-primary" onClick={onRepos}><Icon name="plus" size={16} /> Add a repository</button>}
      />
    );
  }

  const needle = q.trim().toLowerCase();
  const list = (catalog.data ?? [])
    .filter((e) => !needle || `${e.name} ${e.description} ${e.author} ${e.id}`.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <div className="toolbar plugin-toolbar">
        <div className="search-mini plugin-search">
          <Icon name="search" size={16} />
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search plugins" aria-label="Search plugins" />
        </div>
        <button className="btn" onClick={() => setRefresh((r) => r + 1)} disabled={catalog.loading}>
          <Icon name="refresh" size={16} className={catalog.loading ? 'spin' : ''} /> Refresh
        </button>
      </div>
      {catalog.loading && !catalog.data ? <Skeleton h={260} /> : catalog.error ? <ErrorState message={catalog.error} onRetry={() => setRefresh((r) => r + 1)} /> : !list.length ? (
        <EmptyState icon="search" title={needle ? 'No matching plugins' : 'The catalog is empty'} message={needle ? 'Try a different search.' : 'Your repositories list no plugins. Check the URLs on the Repositories tab, then refresh.'} />
      ) : (
        <div className="plugin-grid">
          {list.map((e) => {
            const latest = [...e.versions].sort((a, b) => compareVersions(b.version, a.version))[0];
            const inst = byId.get(e.id);
            const current = e.installedVersion ?? inst?.manifest.version ?? null;
            const state = !current ? 'new' : latest && compareVersions(latest.version, current) > 0 ? 'update' : 'current';
            return (
              <article key={`${e.repository}:${e.id}`} className="plugin-card">
                <div className="plugin-head">
                  <div className="plugin-icon"><Icon name="puzzle" size={22} /></div>
                  <div className="plugin-title">
                    <h3>{e.name} {latest && <span className="muted plugin-version">v{latest.version}</span>}</h3>
                    <p className="muted">{e.author ? `by ${e.author}` : e.id}</p>
                  </div>
                  {state === 'current' && <Badge tone="success" className="plugin-status plugin-state"><Icon name="check" size={12} /> Up to date</Badge>}
                  {state === 'update' && <Badge tone="primary" className="plugin-status plugin-state">Update available</Badge>}
                </div>
                {e.description && <p className="plugin-desc">{e.description}</p>}
                {inst?.manifest.capabilities?.length ? <Capabilities caps={inst.manifest.capabilities} /> : null}
                <div className="plugin-meta">
                  {current && <span><Icon name="checkCircle" size={13} /> Installed v{current}</span>}
                  {latest?.minServerVersion && <span>Needs server {latest.minServerVersion}+</span>}
                  <span title={e.repository} className="plugin-repo"><Icon name="globe" size={13} /> {hostOf(e.repository)}</span>
                  {e.homepage && <Ext href={e.homepage}>Homepage &amp; capabilities</Ext>}
                </div>
                {latest?.changelog && state !== 'current' && <p className="muted plugin-changelog"><strong>What's new:</strong> {latest.changelog}</p>}
                <div className="plugin-foot">
                  <span className="muted plugin-versions">{e.versions.length} version{e.versions.length === 1 ? '' : 's'}</span>
                  {latest && state !== 'current' && (
                    <button className="btn btn-primary btn-sm" onClick={() => install(e, latest.version)} disabled={busy === e.id}>
                      {busy === e.id ? <Spinner size={14} /> : <Icon name="download" size={14} />} {state === 'update' ? `Update to ${latest.version}` : `Install ${latest.version}`}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/* ------------------------------ Repositories ------------------------------ */

function RepositoriesTab() {
  const toast = useToast();
  const confirm = useConfirm();
  const settings = useAsync(() => api.admin.settings(), []);
  const [repos, setRepos] = useState<string[] | null>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (settings.data) setRepos(settings.data.plugins?.repositories ?? []);
  }, [settings.data]);

  const save = async (next: string[], msg: string) => {
    setSaving(true);
    try {
      const s = await api.admin.saveRepositories(next);
      setRepos(s.plugins?.repositories ?? next);
      toast.success(msg);
      return true;
    } catch (e) {
      toast.error(e);
      return false;
    } finally {
      setSaving(false);
    }
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const v = url.trim();
    if (!isHttpsUrl(v)) return setError('Enter a full https:// URL (http:// is allowed for localhost only)');
    if (repos?.includes(v)) return setError('This repository is already in the list');
    setError(null);
    if (await save([...(repos ?? []), v], 'Repository added')) setUrl('');
  };
  const remove = async (r: string) => {
    if (!(await confirm({ title: 'Remove repository?', message: <>Plugins already installed from <code>{r}</code> stay installed, but won't receive updates.</>, confirmLabel: 'Remove', danger: true }))) return;
    await save((repos ?? []).filter((x) => x !== r), 'Repository removed');
  };

  if (settings.loading && !settings.data) return <Skeleton h={220} />;
  if (settings.error) return <ErrorState message={settings.error} onRetry={settings.reload} />;
  return (
    <div className="form-grid plugin-repos">
      <p className="muted">The catalog lists every plugin from these repository index files. Only https URLs are accepted.</p>
      {repos && repos.length > 0 ? (
        <ul className="repo-list">
          {repos.map((r) => (
            <li key={r}>
              <Icon name="globe" size={16} />
              <span className="repo-url mono">{r}</span>
              <button className="btn btn-ghost btn-sm" onClick={() => remove(r)} disabled={saving} aria-label={`Remove ${r}`}>
                <Icon name="trash" size={14} /> Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="repo-empty muted">No repositories yet.</p>
      )}
      <form className="repo-add" onSubmit={add} noValidate>
        <input
          id="repo-url"
          aria-label="Repository URL"
          className="input"
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => { setUrl(e.target.value); setError(null); }}
          placeholder="https://example.com/plugins/repository.json"
          aria-invalid={!!error || undefined}
          aria-describedby={error ? 'repo-url-error' : undefined}
        />
        <button type="submit" className="btn btn-primary" disabled={saving || !url.trim()}>
          {saving ? <Spinner size={16} /> : <Icon name="plus" size={16} />} Add
        </button>
      </form>
      {error && <p id="repo-url-error" className="form-error" role="alert">{error}</p>}
      <div className="howto">
        <strong><Icon name="info" size={16} /> Publishing a repository</strong>
        <ol>
          <li>Package each plugin as a <em>.tar.gz</em> with <code>plugin.json</code> at its root.</li>
          <li>Serve a JSON index over https listing each plugin's versions, download URLs and SHA-256 checksums.</li>
          <li><code>node plugins/pack.mjs https://your.host/path</code> builds the packages and the index for you.</li>
        </ol>
        <p className="plugin-docs-link"><Ext href={DOCS_URL}>Read the plugin guide</Ext></p>
      </div>
    </div>
  );
}
