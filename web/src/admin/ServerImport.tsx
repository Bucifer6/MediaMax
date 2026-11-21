import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ImportConfig, ImportJob, ImportMatchCount, ImportOptions, ImportPathMapping, ImportPreview, ImportSource, ImportUserResult } from '@mediamax/shared';
import { importApi } from '../api/serverImport';
import { useAsync, useServerEvent } from '../hooks';
import { useToast } from '../state/toast';
import { Badge, ErrorState, Field, ProgressBar, Skeleton, Spinner, Switch, useConfirm } from '../components/ui';
import { Icon } from '../components/Icon';
import { formatDate, formatDateTime, relativeTime } from '../utils/format';
import { copyText } from '../pages/SecuritySettings';
import { AdminHeader } from './AdminRoutes';

const MASK = '••••';
const DEFAULT_OPTIONS: ImportOptions = {
  updateExisting: false, mergeExisting: true, includeDisabled: true, importWatched: true, importResume: true, importFavorites: true,
  importPlaylists: true, importCollections: true, importHistory: true, importMetadata: true, overwriteMetadata: false, linkExpiryDays: 30,
};
const ACTION: Record<string, { label: string; tone: 'success' | 'primary' | 'accent' | 'muted' | 'danger' | 'warning' }> = {
  create: { label: 'Create', tone: 'success' }, update: { label: 'Update', tone: 'primary' }, merge: { label: 'Merge data', tone: 'accent' }, skip: { label: 'Skip', tone: 'muted' },
  created: { label: 'Created', tone: 'success' }, updated: { label: 'Updated', tone: 'primary' }, merged: { label: 'Merged', tone: 'accent' }, skipped: { label: 'Skipped', tone: 'muted' }, error: { label: 'Failed', tone: 'danger' },
};

/** What differs per source in the form and texts. */
const SOURCES: Record<ImportSource, {
  name: string; product: string; urlHint: string; placeholder: string; keyLabel: string; keyHelp: React.ReactNode; favorites: boolean; disabled: boolean; history: string;
}> = {
  emby: {
    name: 'Emby', product: 'Emby Server 4.x', urlHint: 'For example http://192.168.1.20:8096 (add /emby if your server needs it).', placeholder: 'http://emby.local:8096',
    keyLabel: 'API key', keyHelp: <>In Emby open <strong>Settings → Advanced → API Keys</strong> and create a key for Kinora.</>,
    favorites: true, disabled: true, history: 'Needs the Playback Reporting plugin; skipped without it.',
  },
  jellyfin: {
    name: 'Jellyfin', product: 'Jellyfin 10.8 or later', urlHint: 'For example http://192.168.1.20:8096.', placeholder: 'http://jellyfin.local:8096',
    keyLabel: 'API key', keyHelp: <>In Jellyfin open <strong>Dashboard → API Keys</strong> and add a key for Kinora.</>,
    favorites: true, disabled: true, history: 'Needs the Playback Reporting plugin; skipped without it.',
  },
  plex: {
    name: 'Plex', product: 'Plex Media Server', urlHint: 'Your server on the home network, for example http://192.168.1.20:32400.', placeholder: 'http://plex.local:32400',
    keyLabel: 'Plex token (X-Plex-Token)',
    keyHelp: <>Sign in to Plex Web <strong>as the server owner</strong>, open any title, choose <strong>⋯ → Get Info → View XML</strong> and copy the value after <code>X-Plex-Token=</code> from the address bar. Users and shared libraries are read from plex.tv with it.</>,
    favorites: false, disabled: false, history: 'From the server’s viewing history (with the date each title was watched).',
  },
};
const SOURCE_ORDER: ImportSource[] = ['emby', 'jellyfin', 'plex'];
const isSource = (s: string | null): s is ImportSource => s === 'emby' || s === 'jellyfin' || s === 'plex';

const ratio = (c: ImportMatchCount, quick: boolean) => (!c.total ? '—' : quick ? String(c.total) : `${c.matched} / ${c.total}`);
const matchHint = (c: ImportMatchCount, quick: boolean) => (quick ? 'Quick preview: titles not matched yet' : `${c.byProviderId} by provider id, ${c.byPath} by file path, ${c.byTitle} by title & year, ${c.total - c.matched} not found`);

/** CSV with formula-injection guard (a cell starting with = + - @ is prefixed with '). */
function toCsv(rows: ImportUserResult[]): string {
  const cell = (v: unknown) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['username', 'display_name', 'status', 'set_password_link', 'link_expires', 'watched', 'resume', 'favourites', 'playlists', 'history', 'unmatched', 'note'];
  const lines = rows.map((r) => [r.username, r.displayName, r.status, r.setPasswordUrl, r.setPasswordExpiresAt, r.watched, r.resume, r.favorites, r.playlists, r.history, r.unmatched, r.message].map(cell).join(','));
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

function ConnectionCard({ source, value, onSaved }: { source: ImportSource; value: ImportConfig; onSaved: (c: ImportConfig) => void }) {
  const toast = useToast();
  const S = SOURCES[source];
  const [f, setF] = useState<ImportConfig>(value);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => {
    setF(value);
    setTest(null);
  }, [value]);
  const setMap = (i: number, patch: Partial<ImportPathMapping>) => setF((x) => ({ ...x, pathMappings: x.pathMappings.map((m, j) => (j === i ? { ...m, ...patch } : m)) }));

  const save = async () => {
    setBusy('save');
    try {
      onSaved(await importApi.saveConfig(source, { ...f, pathMappings: f.pathMappings.filter((m) => m.from.trim() && m.to.trim()) }));
      toast.success(`${S.name} connection saved`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const runTest = async () => {
    setBusy('test');
    try {
      setTest(await importApi.test(source, { url: f.url, apiKey: f.apiKey }));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-card">
      <h2>2. Connect to {S.name}</h2>
      <p className="muted">{S.keyHelp} It is stored on this server and never shown again.</p>
      <div className="form-row">
        <Field label={`${S.name} server address`} hint={S.urlHint}>
          <input className="input" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder={S.placeholder} spellCheck={false} autoCapitalize="none" />
        </Field>
        <Field label={S.keyLabel}>
          <input className="input" type="password" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} onFocus={(e) => f.apiKey === MASK && e.target.select()} autoComplete="off" spellCheck={false} />
        </Field>
      </div>
      <div className="field">
        <span className="field-label">Path mappings</span>
        <small className="field-hint">If {S.name} sees your media under different paths (another machine, Windows drive letters, a container), map them so files can be matched, e.g. <code>D:\Movies</code> → <code>/mnt/d/Movies</code>.</small>
        {f.pathMappings.map((m, i) => (
          <div key={i} className="row-gap">
            <input className="input grow" value={m.from} onChange={(e) => setMap(i, { from: e.target.value })} placeholder={`Path on ${S.name}`} aria-label={`Path on ${S.name}`} spellCheck={false} />
            <Icon name="next" size={16} />
            <input className="input grow" value={m.to} onChange={(e) => setMap(i, { to: e.target.value })} placeholder="Path on Kinora" aria-label="Path on Kinora" spellCheck={false} />
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

function OptionsCard({ source, o, set }: { source: ImportSource; o: ImportOptions; set: (patch: Partial<ImportOptions>) => void }) {
  const S = SOURCES[source];
  return (
    <div className="settings-card">
      <h2>3. Choose what to bring over</h2>
      <div className="switch-group">
        <Switch checked={o.importWatched !== false} onChange={(v) => set({ importWatched: v })} label="Watched movies and episodes" hint="Never un-watches anything already watched here; play counts only go up." />
        <Switch checked={o.importResume !== false} onChange={(v) => set({ importResume: v })} label="Resume points" hint="Skipped when the title is already watched here or has a newer position." />
        {S.favorites && <Switch checked={o.importFavorites !== false} onChange={(v) => set({ importFavorites: v })} label="Favourites" />}
        <Switch checked={o.importHistory !== false} onChange={(v) => set({ importHistory: v })} label="Play history" hint={`${S.history} Feeds stats and Year in review; never added twice.`} />
        <Switch checked={o.importPlaylists !== false} onChange={(v) => set({ importPlaylists: v })} label="Playlists" hint="Recreated for each user; re-runs add missing items instead of duplicating." />
        <Switch checked={o.importCollections !== false} onChange={(v) => set({ importCollections: v })} label="Collections" />
        <Switch checked={!!o.importMetadata} onChange={(v) => set({ importMetadata: v })} label="Metadata and artwork" hint={`Descriptions, genres, cast, ratings, posters, backgrounds, logos, season posters and episode images from ${S.name}, for titles that match. Artwork is copied to this server.`} />
        {o.importMetadata && <Switch checked={!!o.overwriteMetadata} onChange={(v) => set({ overwriteMetadata: v })} label="Replace metadata Kinora already has" hint="Off: only fills in what is missing. Fields you locked on a title are never changed." />}
        {S.disabled && <Switch checked={o.includeDisabled !== false} onChange={(v) => set({ includeDisabled: v })} label={`Include users that are disabled in ${S.name}`} hint="They are created disabled, without a set-password link." />}
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

function PreviewView({ p, selected, setSelected }: { p: ImportPreview; selected: Set<string>; setSelected: (s: Set<string>) => void }) {
  const S = SOURCES[p.source];
  const q = p.quick;
  const toggle = (id: string) => {
    const n = new Set(selected);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSelected(n);
  };
  const t = p.totals;
  return (
    <>
      <p className="muted">
        {p.server.name} {p.server.version} · read in {p.seconds} s{q ? ' · quick preview: counts only, titles are matched during the import (run a full preview to see how)' : ''}
      </p>
      {p.notes.length > 0 && <ul className="muted">{p.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      <div className="stat-grid">
        <div className="stat"><span className="stat-value">{t.users}</span><span className="stat-label">{S.name} users</span></div>
        <div className="stat"><span className="stat-value">{t.create}</span><span className="stat-label">New accounts</span></div>
        <div className="stat"><span className="stat-value">{t.update + t.merge}</span><span className="stat-label">Existing accounts</span></div>
        <div className="stat" title={matchHint(t.watched, q)}><span className="stat-value">{ratio(t.watched, q)}</span><span className="stat-label">Watched items{q ? '' : ' matched'}</span></div>
        <div className="stat" title={matchHint(t.resume, q)}><span className="stat-value">{ratio(t.resume, q)}</span><span className="stat-label">Resume points{q ? '' : ' matched'}</span></div>
        {S.favorites && <div className="stat" title={matchHint(t.favorites, q)}><span className="stat-value">{ratio(t.favorites, q)}</span><span className="stat-label">Favourites{q ? '' : ' matched'}</span></div>}
        <div className="stat" title={matchHint(t.history, q)}><span className="stat-value">{ratio(t.history, q)}</span><span className="stat-label">History plays{q ? '' : ' matched'}</span></div>
        <div className="stat" title={matchHint(p.collectionItems, q)}><span className="stat-value">{p.collections}</span><span className="stat-label">Collections{q ? '' : ` (${ratio(p.collectionItems, q)} items)`}</span></div>
      </div>

      <h3 className="form-section-title">Libraries</h3>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>{S.name} library</th><th>Folders</th><th>Kinora library</th></tr></thead>
          <tbody>
            {p.libraries.map((l) => (
              <tr key={l.sourceId}>
                <td><strong>{l.name}</strong></td>
                <td className="muted">{l.locations.join(', ') || '—'}</td>
                <td>{l.libraryName ? <>{l.libraryName} <Badge tone="muted">by {l.method}</Badge></> : <Badge tone="warning">No match</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {p.libraries.some((l) => !l.libraryId) && <p className="muted">Users only get Kinora libraries that match a {S.name} library they could see. Add a path mapping or rename a library to match, then preview again.</p>}

      <h3 className="form-section-title">Users</h3>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="td-check"><input type="checkbox" aria-label="Select all users" checked={p.users.every((u) => selected.has(u.sourceId))} onChange={(e) => setSelected(e.target.checked ? new Set(p.users.map((u) => u.sourceId)) : new Set())} /></th>
              <th>User</th><th>Action</th><th>Access</th><th>Watched</th><th>Resume</th>{S.favorites && <th>Favourites</th>}<th>History</th><th>Playlists</th>
            </tr>
          </thead>
          <tbody>
            {p.users.map((u) => (
              <tr key={u.sourceId} className={u.action === 'skip' || !selected.has(u.sourceId) ? 'dim' : ''}>
                <td className="td-check"><input type="checkbox" aria-label={`Import ${u.username}`} checked={selected.has(u.sourceId)} onChange={() => toggle(u.sourceId)} /></td>
                <td>
                  <strong>{u.displayName}</strong>
                  <div className="muted">@{u.username}{u.renamedFrom && <> ({S.name}: {u.renamedFrom})</>}</div>
                  {p.source !== 'plex' && <div className="muted">{u.lastActivity ? `Active ${relativeTime(u.lastActivity)}` : 'Never active'}</div>}
                  {u.notes.map((n) => <div key={n} className="muted small">{n}</div>)}
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
                <td title={matchHint(u.watched, q)}>{ratio(u.watched, q)}</td>
                <td title={matchHint(u.resume, q)}>{ratio(u.resume, q)}</td>
                {S.favorites && <td title={matchHint(u.favorites, q)}>{ratio(u.favorites, q)}</td>}
                <td title={matchHint(u.history, q)}>{ratio(u.history, q)}</td>
                <td title={matchHint(u.playlistItems, q)}>{u.playlists ? (q ? String(u.playlists) : `${u.playlists} (${ratio(u.playlistItems, q)} items)`) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {p.unmatchedSamples.length > 0 && (
        <details className="settings-card">
          <summary><strong>Some titles weren’t found in Kinora</strong> <span className="muted">(examples)</span></summary>
          <p className="muted">Usually the title isn’t in a Kinora library yet, or {S.name}’s file paths need a path mapping. Unmatched items are skipped; run the import again after a library scan to pick them up.</p>
          <ul>{p.unmatchedSamples.map((s) => <li key={s}>{s}</li>)}</ul>
        </details>
      )}
    </>
  );
}

function ResultsView({ job }: { job: ImportJob }) {
  const toast = useToast();
  const S = SOURCES[job.source];
  const withLinks = job.results.filter((r) => r.setPasswordUrl);
  const copy = async (text: string, what: string) => {
    if (await copyText(text)) toast.success(`${what} copied`);
    else toast.show('Could not copy', 'error');
  };
  const n = (s: ImportUserResult['status']) => job.results.filter((r) => r.status === s).length;
  return (
    <div className="settings-card">
      <div className="admin-head">
        <div>
          <h2>Results: import from {S.name}</h2>
          <p className="muted">
            {job.finishedAt ? `Finished ${formatDateTime(job.finishedAt)}` : `Started ${formatDateTime(job.startedAt)}`} · {n('created')} created, {n('updated') + n('merged')} updated, {n('skipped')} skipped{n('error') ? `, ${n('error')} failed` : ''}
            {job.options.importCollections ? ` · collections: ${job.collections.created} new, ${job.collections.updated} updated` : ''}
            {job.metadata ? ` · metadata: ${job.metadata.updated} titles updated, ${job.metadata.images} images (${job.metadata.matched} of ${job.metadata.read} matched)` : ''}
          </p>
        </div>
        <div className="row-gap">
          {withLinks.length > 0 && <button className="btn" onClick={() => void copy(withLinks.map((r) => `${r.username}: ${r.setPasswordUrl}`).join('\n'), 'Links')}><Icon name="copy" size={16} /> Copy all links</button>}
          <button className="btn btn-primary" onClick={() => download(`${job.source}-import-${job.startedAt.slice(0, 10)}.csv`, toCsv(job.results))}><Icon name="download" size={16} /> Download CSV</button>
        </div>
      </div>
      {job.notes.length > 0 && <ul className="muted">{job.notes.map((x) => <li key={x}>{x}</li>)}</ul>}
      {withLinks.length > 0 && (
        <p className="muted">
          Send each person their link: it lets them choose a Kinora password ({S.name} passwords can’t be copied). Links work once and expire {formatDate(withLinks[0].setPasswordExpiresAt)}.
          Treat them like passwords. Running the import again issues fresh links to anyone who hasn’t used theirs.
        </p>
      )}
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>User</th><th>Status</th><th>Set-password link</th><th>Watched</th><th>Resume</th><th>Favourites</th><th>History</th><th>Playlists</th><th>Not found</th></tr></thead>
          <tbody>
            {job.results.map((r) => (
              <tr key={r.sourceId}>
                <td><strong>{r.displayName}</strong><div className="muted">@{r.username}</div>{r.message && <div className="muted">{r.message}</div>}</td>
                <td><Badge tone={ACTION[r.status].tone}>{ACTION[r.status].label}</Badge></td>
                <td>{r.setPasswordUrl ? <button className="btn btn-sm" onClick={() => void copy(r.setPasswordUrl!, 'Link')}><Icon name="copy" size={14} /> Copy link</button> : <span className="muted">—</span>}</td>
                <td>{r.watched}</td><td>{r.resume}</td><td>{r.favorites}</td><td>{r.history}</td><td>{r.playlists}</td><td>{r.unmatched}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Admin → Import from another server: pick Emby, Jellyfin or Plex, connect, preview (quick counts or a full dry run),
 * run as a background job, hand out set-password links.
 */
export function ServerImportAdmin() {
  const toast = useToast();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const lastJob = useAsync(() => importApi.job(), []);
  const job = lastJob.data ?? null;
  const running = job?.status === 'running';
  const source: ImportSource = isSource(params.get('source')) ? (params.get('source') as ImportSource) : running ? job!.source : 'emby';
  const S = SOURCES[source];
  const config = useAsync(() => importApi.config(source), [source]);
  const [opts, setOpts] = useState<ImportOptions>(DEFAULT_OPTIONS);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewing, setPreviewing] = useState<'quick' | 'full' | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const setJob = lastJob.setData;

  useServerEvent((ev) => {
    if (ev.type === 'import.updated') lastJob.setData(ev.job);
  });
  // Poll as a fallback while a job runs (e.g. the realtime socket is down).
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => void importApi.job().then((j) => setJob(j)).catch(() => undefined), 3000);
    return () => window.clearInterval(t);
  }, [running, setJob]);

  const pickSource = (s: ImportSource) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.set('source', s);
      return n;
    }, { replace: true });
    setPreview(null);
  };

  const setOpt = (patch: Partial<ImportOptions>) => {
    setOpts((o) => ({ ...o, ...patch }));
    if ('updateExisting' in patch || 'mergeExisting' in patch || 'includeDisabled' in patch) setPreview(null);
  };

  const runPreview = async (quick: boolean) => {
    setPreviewing(quick ? 'quick' : 'full');
    try {
      const p = await importApi.preview(source, opts, quick);
      setPreview(p);
      setSelected(new Set(p.users.filter((u) => u.action !== 'skip').map((u) => u.sourceId)));
    } catch (e) {
      toast.error(e);
    } finally {
      setPreviewing(null);
    }
  };

  const start = async () => {
    if (!preview) return;
    const users = preview.users.filter((u) => selected.has(u.sourceId) && u.action !== 'skip');
    const creates = users.filter((u) => u.action === 'create').length;
    const metadataOnly = !users.length && !!opts.importMetadata;
    if (!(await confirm(metadataOnly ? {
      title: `Import metadata and artwork from ${S.name}?`,
      message: opts.overwriteMetadata
        ? 'Metadata and artwork of matching titles will replace what this server has (locked fields stay as they are). No accounts are created.'
        : 'Missing metadata and artwork of matching titles will be filled in. Nothing this server already has is changed, and no accounts are created.',
      confirmLabel: 'Start import',
    } : {
      title: `Import ${users.length} user${users.length === 1 ? '' : 's'} from ${S.name}?`,
      message: `${creates} new account${creates === 1 ? '' : 's'} will be created, each with a one-time set-password link. Existing watch data is only ever added to, never removed.${opts.importMetadata ? ' Metadata and artwork of matching titles are imported too.' : ''} You can run the import again later.`,
      confirmLabel: 'Start import',
    }))) return;
    try {
      lastJob.setData(await importApi.run(source, { ...opts, userIds: users.map((u) => u.sourceId) }));
    } catch (e) {
      toast.error(e);
    }
  };

  const configured = !!config.data?.url && !!config.data?.apiKey;
  const shown = preview?.source === source ? preview : null;
  const selectedCount = shown ? shown.users.filter((u) => selected.has(u.sourceId) && u.action !== 'skip').length : 0;
  return (
    <div>
      <AdminHeader help="admin-import" title="Import from another server" subtitle="Move users, their permissions, watch history, resume points, favourites, playlists and collections from Emby, Jellyfin or Plex." />
      <div className="form-grid">
        <div className="settings-card">
          <h2>1. Where are you moving from?</h2>
          <div className="segmented" role="radiogroup" aria-label="Source server">
            {SOURCE_ORDER.map((s) => (
              <button key={s} type="button" role="radio" aria-checked={s === source} className={s === source ? 'active' : ''} onClick={() => pickSource(s)} disabled={running && job?.source !== s}>{SOURCES[s].name}</button>
            ))}
          </div>
          <p className="muted">{S.product}. The {S.name} server is only read, never changed.</p>
        </div>
        {config.loading && !config.data ? <Skeleton h={220} /> : config.error ? <ErrorState message={config.error} onRetry={config.reload} /> : config.data && <ConnectionCard source={source} value={config.data} onSaved={(c) => { config.setData(c); setPreview(null); }} />}
        <OptionsCard source={source} o={opts} set={setOpt} />
        <div className="settings-card">
          <h2>4. Preview</h2>
          <p className="muted">A dry run: reads {S.name} and shows what would happen, without changing anything. <strong>Quick</strong> only counts (seconds, even on big servers); <strong>Full</strong> reads and matches every title (can take a few minutes on large servers).</p>
          <div className="row-gap">
            <button className="btn" onClick={() => void runPreview(true)} disabled={!configured || !!previewing || running}>{previewing === 'quick' ? <><Spinner size={16} /> Counting…</> : <><Icon name="zap" size={16} /> Quick preview</>}</button>
            <button className="btn btn-primary" onClick={() => void runPreview(false)} disabled={!configured || !!previewing || running}>{previewing === 'full' ? <><Spinner size={16} /> Reading {S.name}…</> : <><Icon name="eye" size={16} /> {shown && !shown.quick ? 'Full preview again' : 'Full preview'}</>}</button>
            {!configured && <span className="muted">Save the {S.name} address and {S.keyLabel.toLowerCase()} first.</span>}
          </div>
          {shown && <PreviewView p={shown} selected={selected} setSelected={setSelected} />}
          {shown && (
            <div className="row-gap">
              <button className="btn btn-primary btn-lg" onClick={() => void start()} disabled={running || (!selectedCount && !opts.importMetadata)}><Icon name="upload" size={18} /> {selectedCount ? `Import ${selectedCount} user${selectedCount === 1 ? '' : 's'}` : 'Import metadata only'}</button>
            </div>
          )}
        </div>
        {job && running && (
          <div className="settings-card" role="status" aria-live="polite">
            <h2>Importing from {SOURCES[job.source].name}…</h2>
            <p className="muted">{job.phase}</p>
            <ProgressBar value={job.progress} />
            <p className="muted">You can leave this page; the import keeps running on the server.</p>
          </div>
        )}
        {job && job.status === 'error' && <p className="form-error">The last import from {SOURCES[job.source].name} stopped: {job.error}</p>}
        {job && !running && job.results.length > 0 && <ResultsView job={job} />}
      </div>
    </div>
  );
}
