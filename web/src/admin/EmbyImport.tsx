import { useEffect, useState } from 'react';
import type { EmbyImportConfig, EmbyImportJob, EmbyImportOptions, EmbyImportPreview, EmbyImportUserResult, EmbyMatchCount, EmbyPathMapping } from '@mediamax/shared';
import { embyImportApi } from '../api/embyImport';
import { useAsync, useServerEvent } from '../hooks';
import { useToast } from '../state/toast';
import { Badge, ErrorState, Field, ProgressBar, Skeleton, Spinner, Switch, useConfirm } from '../components/ui';
import { Icon } from '../components/Icon';
import { formatDate, formatDateTime, relativeTime } from '../utils/format';
import { copyText } from '../pages/SecuritySettings';
import { AdminHeader } from './AdminRoutes';

const MASK = '••••';
const DEFAULT_OPTIONS: EmbyImportOptions = {
  updateExisting: false, mergeExisting: true, includeDisabled: true, importWatched: true, importResume: true, importFavorites: true,
  importPlaylists: true, importCollections: true, linkExpiryDays: 30,
};
const ACTION: Record<string, { label: string; tone: 'success' | 'primary' | 'accent' | 'muted' | 'danger' | 'warning' }> = {
  create: { label: 'Create', tone: 'success' }, update: { label: 'Update', tone: 'primary' }, merge: { label: 'Merge data', tone: 'accent' }, skip: { label: 'Skip', tone: 'muted' },
  created: { label: 'Created', tone: 'success' }, updated: { label: 'Updated', tone: 'primary' }, merged: { label: 'Merged', tone: 'accent' }, skipped: { label: 'Skipped', tone: 'muted' }, error: { label: 'Failed', tone: 'danger' },
};

const ratio = (c: EmbyMatchCount) => (c.total ? `${c.matched} / ${c.total}` : '—');
const matchHint = (c: EmbyMatchCount) => `${c.byProviderId} by provider id, ${c.byPath} by file path, ${c.byTitle} by title & year, ${c.total - c.matched} not found`;

/** CSV with formula-injection guard (a cell starting with = + - @ is prefixed with '). */
function toCsv(rows: EmbyImportUserResult[]): string {
  const cell = (v: unknown) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['username', 'display_name', 'status', 'set_password_link', 'link_expires', 'watched', 'resume', 'favourites', 'playlists', 'unmatched', 'note'];
  const lines = rows.map((r) => [r.username, r.displayName, r.status, r.setPasswordUrl, r.setPasswordExpiresAt, r.watched, r.resume, r.favorites, r.playlists, r.unmatched, r.message].map(cell).join(','));
  return [head.join(','), ...lines].join('\r\n');
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ConnectionCard({ value, onSaved }: { value: EmbyImportConfig; onSaved: (c: EmbyImportConfig) => void }) {
  const toast = useToast();
  const [f, setF] = useState<EmbyImportConfig>(value);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => setF(value), [value]);
  const setMap = (i: number, patch: Partial<EmbyPathMapping>) => setF((x) => ({ ...x, pathMappings: x.pathMappings.map((m, j) => (j === i ? { ...m, ...patch } : m)) }));

  const save = async () => {
    setBusy('save');
    try {
      onSaved(await embyImportApi.saveConfig({ ...f, pathMappings: f.pathMappings.filter((m) => m.from.trim() && m.to.trim()) }));
      toast.success('Emby connection saved');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const runTest = async () => {
    setBusy('test');
    try {
      setTest(await embyImportApi.test({ url: f.url, apiKey: f.apiKey }));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-card">
      <h2>1. Connect to Emby</h2>
      <p className="muted">
        In Emby open <strong>Settings → Advanced → API Keys</strong> and create a key for MediaMax. The key is stored on this server and is never shown again.
      </p>
      <div className="form-row">
        <Field label="Emby server address" hint="For example http://192.168.1.20:8096 (add /emby if your server needs it).">
          <input className="input" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="http://emby.local:8096" spellCheck={false} autoCapitalize="none" />
        </Field>
        <Field label="API key">
          <input className="input" type="password" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} onFocus={(e) => f.apiKey === MASK && e.target.select()} autoComplete="off" spellCheck={false} />
        </Field>
      </div>
      <div className="field">
        <span className="field-label">Path mappings</span>
        <small className="field-hint">If Emby sees your media under different paths (another machine, Windows drive letters, a container), map them so files can be matched, e.g. <code>D:\Movies</code> → <code>/mnt/d/Movies</code>.</small>
        {f.pathMappings.map((m, i) => (
          <div key={i} className="row-gap">
            <input className="input grow" value={m.from} onChange={(e) => setMap(i, { from: e.target.value })} placeholder="Path on Emby" aria-label="Path on Emby" spellCheck={false} />
            <Icon name="next" size={16} />
            <input className="input grow" value={m.to} onChange={(e) => setMap(i, { to: e.target.value })} placeholder="Path on MediaMax" aria-label="Path on MediaMax" spellCheck={false} />
            <button className="btn-icon" onClick={() => setF((x) => ({ ...x, pathMappings: x.pathMappings.filter((_, j) => j !== i) }))} aria-label="Remove mapping"><Icon name="trash" size={16} /></button>
          </div>
        ))}
        <div><button className="btn btn-sm" onClick={() => setF((x) => ({ ...x, pathMappings: [...x.pathMappings, { from: '', to: '' }] }))}><Icon name="plus" size={14} /> Add mapping</button></div>
      </div>
      {test && <p className={test.ok ? 'muted' : 'form-error'} role="status"><Icon name={test.ok ? 'check' : 'alert'} size={14} /> {test.message}</p>}
      <div className="row-gap">
        <button className="btn" onClick={() => void runTest()} disabled={!!busy || !f.url}>{busy === 'test' ? <Spinner size={16} /> : <Icon name="zap" size={16} />} Test connection</button>
        <button className="btn btn-primary" onClick={() => void save()} disabled={!!busy}>{busy === 'save' ? <Spinner size={16} /> : 'Save'}</button>
      </div>
    </div>
  );
}

function OptionsCard({ o, set }: { o: EmbyImportOptions; set: (patch: Partial<EmbyImportOptions>) => void }) {
  return (
    <div className="settings-card">
      <h2>2. Choose what to bring over</h2>
      <div className="switch-group">
        <Switch checked={o.importWatched !== false} onChange={(v) => set({ importWatched: v })} label="Watched movies and episodes" hint="Never un-watches anything already watched here; play counts only go up." />
        <Switch checked={o.importResume !== false} onChange={(v) => set({ importResume: v })} label="Resume points" hint="Skipped when the title is already watched here or has a newer position." />
        <Switch checked={o.importFavorites !== false} onChange={(v) => set({ importFavorites: v })} label="Favourites" />
        <Switch checked={o.importPlaylists !== false} onChange={(v) => set({ importPlaylists: v })} label="Playlists" hint="Recreated for each user; re-runs add missing items instead of duplicating." />
        <Switch checked={o.importCollections !== false} onChange={(v) => set({ importCollections: v })} label="Collections" />
        <Switch checked={o.includeDisabled !== false} onChange={(v) => set({ includeDisabled: v })} label="Include users that are disabled in Emby" hint="They are created disabled, without a set-password link." />
        <Switch checked={o.mergeExisting !== false} onChange={(v) => set({ mergeExisting: v })} label="Merge watch data into existing accounts" hint="Accounts with the same username, or imported before." />
        <Switch checked={!!o.updateExisting} onChange={(v) => set({ updateExisting: v })} label="Also overwrite permissions of existing accounts" hint="Admin flag, library access, limits. Your own account is never demoted or disabled." />
      </div>
      <Field label="Set-password links expire after">
        <select className="select" value={o.linkExpiryDays ?? 30} onChange={(e) => set({ linkExpiryDays: Number(e.target.value) })}>
          {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
        </select>
      </Field>
    </div>
  );
}

function PreviewView({ p, selected, setSelected }: { p: EmbyImportPreview; selected: Set<string>; setSelected: (s: Set<string>) => void }) {
  const toggle = (id: string) => {
    const n = new Set(selected);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSelected(n);
  };
  const t = p.totals;
  return (
    <>
      <div className="stat-grid">
        <div className="stat"><span className="stat-value">{t.users}</span><span className="stat-label">Emby users</span></div>
        <div className="stat"><span className="stat-value">{t.create}</span><span className="stat-label">New accounts</span></div>
        <div className="stat"><span className="stat-value">{t.update + t.merge}</span><span className="stat-label">Existing accounts</span></div>
        <div className="stat" title={matchHint(t.watched)}><span className="stat-value">{ratio(t.watched)}</span><span className="stat-label">Watched items matched</span></div>
        <div className="stat" title={matchHint(t.resume)}><span className="stat-value">{ratio(t.resume)}</span><span className="stat-label">Resume points matched</span></div>
        <div className="stat" title={matchHint(t.favorites)}><span className="stat-value">{ratio(t.favorites)}</span><span className="stat-label">Favourites matched</span></div>
        <div className="stat" title={matchHint(p.collectionItems)}><span className="stat-value">{p.collections}</span><span className="stat-label">Collections ({ratio(p.collectionItems)} items)</span></div>
      </div>

      <h3 className="form-section-title">Libraries</h3>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Emby library</th><th>Folders</th><th>MediaMax library</th></tr></thead>
          <tbody>
            {p.libraries.map((l) => (
              <tr key={l.embyId}>
                <td><strong>{l.name}</strong></td>
                <td className="muted">{l.locations.join(', ') || '—'}</td>
                <td>{l.libraryName ? <>{l.libraryName} <Badge tone="muted">by {l.method}</Badge></> : <Badge tone="warning">No match</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {p.libraries.some((l) => !l.libraryId) && <p className="muted">Users only get MediaMax libraries that match an Emby library they could see. Add a path mapping or rename a library to match, then preview again.</p>}

      <h3 className="form-section-title">Users</h3>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="td-check"><input type="checkbox" aria-label="Select all users" checked={p.users.every((u) => selected.has(u.embyId))} onChange={(e) => setSelected(e.target.checked ? new Set(p.users.map((u) => u.embyId)) : new Set())} /></th>
              <th>User</th><th>Action</th><th>Access</th><th>Watched</th><th>Resume</th><th>Favourites</th><th>Playlists</th>
            </tr>
          </thead>
          <tbody>
            {p.users.map((u) => (
              <tr key={u.embyId} className={u.action === 'skip' || !selected.has(u.embyId) ? 'dim' : ''}>
                <td className="td-check"><input type="checkbox" aria-label={`Import ${u.username}`} checked={selected.has(u.embyId)} onChange={() => toggle(u.embyId)} /></td>
                <td>
                  <strong>{u.displayName}</strong>
                  <div className="muted">@{u.username}{u.renamedFrom && <> (Emby: {u.renamedFrom})</>}</div>
                  <div className="muted">{u.lastActivity ? `Active ${relativeTime(u.lastActivity)}` : 'Never active'}</div>
                </td>
                <td><Badge tone={ACTION[u.action].tone}>{ACTION[u.action].label}</Badge></td>
                <td>
                  <div className="badge-row">
                    {u.isAdmin && <Badge tone="primary">Admin</Badge>}
                    {u.disabled && <Badge tone="danger">Disabled</Badge>}
                    {u.hidden && <Badge tone="muted">Hidden</Badge>}
                    {!u.allowRemote && <Badge tone="warning">Home only</Badge>}
                    {u.allowLiveTv && <Badge tone="muted">Live TV</Badge>}
                    {u.allowDownloads && <Badge tone="muted">Downloads</Badge>}
                    <Badge tone="muted">{u.maxStreams == null ? 'Unlimited streams' : `${u.maxStreams} stream${u.maxStreams === 1 ? '' : 's'}`}</Badge>
                    {u.maxContentRating && <Badge tone="muted">≤ {u.maxContentRating}</Badge>}
                    <Badge tone="muted">{u.libraries === null ? 'All libraries' : u.libraries.length ? u.libraries.join(', ') : 'No libraries'}</Badge>
                    {u.unmappedFolders.length > 0 && <Badge tone="warning">Unmatched: {u.unmappedFolders.join(', ')}</Badge>}
                  </div>
                </td>
                <td title={matchHint(u.watched)}>{ratio(u.watched)}</td>
                <td title={matchHint(u.resume)}>{ratio(u.resume)}</td>
                <td title={matchHint(u.favorites)}>{ratio(u.favorites)}</td>
                <td title={matchHint(u.playlistItems)}>{u.playlists ? `${u.playlists} (${ratio(u.playlistItems)} items)` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {p.unmatchedSamples.length > 0 && (
        <details className="settings-card">
          <summary><strong>Some titles weren’t found in MediaMax</strong> <span className="muted">(examples)</span></summary>
          <p className="muted">Usually the title isn’t in a MediaMax library yet, or Emby’s file paths need a path mapping. Unmatched items are skipped; run the import again after a library scan to pick them up.</p>
          <ul>{p.unmatchedSamples.map((s) => <li key={s}>{s}</li>)}</ul>
        </details>
      )}
    </>
  );
}

function ResultsView({ job }: { job: EmbyImportJob }) {
  const toast = useToast();
  const withLinks = job.results.filter((r) => r.setPasswordUrl);
  const copy = async (text: string, what: string) => {
    if (await copyText(text)) toast.success(`${what} copied`);
    else toast.show('Could not copy', 'error');
  };
  const n = (s: EmbyImportUserResult['status']) => job.results.filter((r) => r.status === s).length;
  return (
    <div className="settings-card">
      <div className="admin-head">
        <div>
          <h2>Results</h2>
          <p className="muted">
            {job.finishedAt ? `Finished ${formatDateTime(job.finishedAt)}` : `Started ${formatDateTime(job.startedAt)}`} · {n('created')} created, {n('updated') + n('merged')} updated, {n('skipped')} skipped{n('error') ? `, ${n('error')} failed` : ''}
            {job.options.importCollections ? ` · collections: ${job.collections.created} new, ${job.collections.updated} updated` : ''}
          </p>
        </div>
        <div className="row-gap">
          {withLinks.length > 0 && <button className="btn" onClick={() => void copy(withLinks.map((r) => `${r.username}: ${r.setPasswordUrl}`).join('\n'), 'Links')}><Icon name="copy" size={16} /> Copy all links</button>}
          <button className="btn btn-primary" onClick={() => download(`emby-import-${job.startedAt.slice(0, 10)}.csv`, toCsv(job.results))}><Icon name="download" size={16} /> Download CSV</button>
        </div>
      </div>
      {withLinks.length > 0 && (
        <p className="muted">
          Send each person their link: it lets them choose a MediaMax password (Emby passwords can’t be copied). Links work once and expire {formatDate(withLinks[0].setPasswordExpiresAt)}.
          Treat them like passwords. Running the import again issues fresh links to anyone who hasn’t used theirs.
        </p>
      )}
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>User</th><th>Status</th><th>Set-password link</th><th>Watched</th><th>Resume</th><th>Favourites</th><th>Playlists</th><th>Not found</th></tr></thead>
          <tbody>
            {job.results.map((r) => (
              <tr key={r.embyId}>
                <td><strong>{r.displayName}</strong><div className="muted">@{r.username}</div>{r.message && <div className="muted">{r.message}</div>}</td>
                <td><Badge tone={ACTION[r.status].tone}>{ACTION[r.status].label}</Badge></td>
                <td>{r.setPasswordUrl ? <button className="btn btn-sm" onClick={() => void copy(r.setPasswordUrl!, 'Link')}><Icon name="copy" size={14} /> Copy link</button> : <span className="muted">—</span>}</td>
                <td>{r.watched}</td><td>{r.resume}</td><td>{r.favorites}</td><td>{r.playlists}</td><td>{r.unmatched}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Admin → Import from Emby: connect, preview (dry run), run as a background job, hand out set-password links. */
export function EmbyImportAdmin() {
  const toast = useToast();
  const confirm = useConfirm();
  const config = useAsync(() => embyImportApi.config(), []);
  const lastJob = useAsync(() => embyImportApi.job(), []);
  const [opts, setOpts] = useState<EmbyImportOptions>(DEFAULT_OPTIONS);
  const [preview, setPreview] = useState<EmbyImportPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const job = lastJob.data ?? null;
  const running = job?.status === 'running';
  const setJob = lastJob.setData;

  useServerEvent((ev) => {
    if (ev.type === 'embyImport.updated') lastJob.setData(ev.job);
  });
  // Poll as a fallback while a job runs (e.g. the realtime socket is down).
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => void embyImportApi.job().then((j) => setJob(j)).catch(() => undefined), 3000);
    return () => window.clearInterval(t);
  }, [running, setJob]);

  const setOpt = (patch: Partial<EmbyImportOptions>) => {
    setOpts((o) => ({ ...o, ...patch }));
    if ('updateExisting' in patch || 'mergeExisting' in patch || 'includeDisabled' in patch) setPreview(null);
  };

  const runPreview = async () => {
    setPreviewing(true);
    try {
      const p = await embyImportApi.preview(opts);
      setPreview(p);
      setSelected(new Set(p.users.filter((u) => u.action !== 'skip').map((u) => u.embyId)));
    } catch (e) {
      toast.error(e);
    } finally {
      setPreviewing(false);
    }
  };

  const start = async () => {
    if (!preview) return;
    const users = preview.users.filter((u) => selected.has(u.embyId) && u.action !== 'skip');
    const creates = users.filter((u) => u.action === 'create').length;
    if (!(await confirm({
      title: `Import ${users.length} user${users.length === 1 ? '' : 's'} from Emby?`,
      message: `${creates} new account${creates === 1 ? '' : 's'} will be created, each with a one-time set-password link. Existing watch data is only ever added to, never removed. You can run the import again later.`,
      confirmLabel: 'Start import',
    }))) return;
    try {
      lastJob.setData(await embyImportApi.run({ ...opts, userIds: users.map((u) => u.embyId) }));
    } catch (e) {
      toast.error(e);
    }
  };

  const configured = !!config.data?.url && !!config.data?.apiKey;
  const selectedCount = preview ? preview.users.filter((u) => selected.has(u.embyId) && u.action !== 'skip').length : 0;
  return (
    <div>
      <AdminHeader help="admin-import-emby" title="Import from Emby" subtitle="Move users, their permissions, watch history, resume points, favourites, playlists and collections from an Emby Server 4.x." />
      <div className="form-grid">
        {config.loading && !config.data ? <Skeleton h={220} /> : config.error ? <ErrorState message={config.error} onRetry={config.reload} /> : config.data && <ConnectionCard value={config.data} onSaved={(c) => { config.setData(c); setPreview(null); }} />}
        <OptionsCard o={opts} set={setOpt} />
        <div className="settings-card">
          <h2>3. Preview</h2>
          <p className="muted">A dry run: reads everything from Emby and shows what would happen, without changing anything. Large servers can take a minute.</p>
          <div className="row-gap">
            <button className="btn btn-primary" onClick={() => void runPreview()} disabled={!configured || previewing || running}>{previewing ? <><Spinner size={16} /> Reading Emby…</> : <><Icon name="eye" size={16} /> {preview ? 'Preview again' : 'Preview import'}</>}</button>
            {!configured && <span className="muted">Save the Emby address and API key first.</span>}
          </div>
          {preview && <PreviewView p={preview} selected={selected} setSelected={setSelected} />}
          {preview && (
            <div className="row-gap">
              <button className="btn btn-primary btn-lg" onClick={() => void start()} disabled={running || !selectedCount}><Icon name="upload" size={18} /> Import {selectedCount} user{selectedCount === 1 ? '' : 's'}</button>
            </div>
          )}
        </div>
        {job && running && (
          <div className="settings-card" role="status" aria-live="polite">
            <h2>Importing…</h2>
            <p className="muted">{job.phase}</p>
            <ProgressBar value={job.progress} />
            <p className="muted">You can leave this page; the import keeps running on the server.</p>
          </div>
        )}
        {job && job.status === 'error' && <p className="form-error">The last import stopped: {job.error}</p>}
        {job && !running && job.results.length > 0 && <ResultsView job={job} />}
      </div>
    </div>
  );
}
