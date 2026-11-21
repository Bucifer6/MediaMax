import { useEffect, useState } from 'react';
import type { ArrInstance, ArrKind, ArrOptions, ArrPathMapping } from '@mediamax/shared';
import { arrApi } from '../api/arr';
import { useAsync } from '../hooks';
import { useToast } from '../state/toast';
import { Badge, Field, Modal, Skeleton, Spinner, Switch, useConfirm } from '../components/ui';
import { Icon } from '../components/Icon';
import { formatBytes } from '../utils/format';
import { ARR_ICON, ARR_NAME } from './Downloads';
import '../styles/arr.css';

const MASK = '••••';
const KINDS: { kind: ArrKind; what: string; port: number }[] = [
  { kind: 'radarr', what: 'Movies', port: 7878 },
  { kind: 'sonarr', what: 'TV shows', port: 8989 },
  { kind: 'lidarr', what: 'Music', port: 8686 },
  { kind: 'readarr', what: 'Books', port: 8787 },
  { kind: 'bazarr', what: 'Subtitles', port: 6767 },
];
const MONITOR: Partial<Record<ArrKind, { value: string; label: string }[]>> = {
  radarr: [{ value: 'movieOnly', label: 'Movie only' }, { value: 'movieAndCollection', label: 'Movie and collection' }, { value: 'none', label: 'None' }],
  sonarr: [{ value: 'all', label: 'All episodes' }, { value: 'future', label: 'Future episodes' }, { value: 'missing', label: 'Missing episodes' }, { value: 'existing', label: 'Existing episodes' }, { value: 'pilot', label: 'Pilot only' }, { value: 'none', label: 'None' }],
};

const newId = () => `arr-${Math.random().toString(36).slice(2, 10)}`;
const blank = (kind: ArrKind): ArrInstance => ({
  id: newId(), kind, name: ARR_NAME[kind], url: '', apiKey: '', enabled: true, is4k: false, qualityProfileId: null, rootFolderPath: null,
  metadataProfileId: null, languageProfileId: null, tags: [], seasonFolders: true, searchOnAdd: true, pathMappings: [],
});

/** The *arr instances editor, plus the webhook URL and setup steps. Saved with the rest of the server settings. */
export function ArrSettingsPanel({ value, onChange, publicUrl }: { value: ArrInstance[]; onChange: (v: ArrInstance[]) => void; publicUrl: string | null }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<{ inst: ArrInstance; isNew: boolean } | null>(null);
  const [tests, setTests] = useState<Record<string, ArrOptions | 'busy'>>({});
  const hook = useAsync(() => arrApi.webhook(), []);

  const test = async (i: ArrInstance) => {
    setTests((t) => ({ ...t, [i.id]: 'busy' }));
    try {
      const r = await arrApi.test({ id: i.id, kind: i.kind, url: i.url, apiKey: i.apiKey });
      setTests((t) => ({ ...t, [i.id]: r }));
      if (r.ok) toast.success(`${i.name}: ${r.message}`);
      else toast.show(`${i.name}: ${r.message || 'connection failed'}`, 'error');
    } catch (e) {
      setTests((t) => {
        const { [i.id]: _gone, ...rest } = t;
        return rest;
      });
      toast.error(e);
    }
  };
  const remove = async (i: ArrInstance) => {
    if (!(await confirm({ title: `Remove ${i.name}?`, message: 'Requests and the downloads dashboard stop using it once you save.', confirmLabel: 'Remove', danger: true }))) return;
    onChange(value.filter((x) => x.id !== i.id));
  };
  const save = (inst: ArrInstance) => {
    onChange(value.some((x) => x.id === inst.id) ? value.map((x) => (x.id === inst.id ? inst : x)) : [...value, inst]);
    setEditing(null);
  };

  const base = (publicUrl || window.location.origin).replace(/\/+$/, '');
  const hookUrl = hook.data ? hook.data.url ?? base + hook.data.path : '';
  const regenerate = async () => {
    if (!(await confirm({ title: 'Make a new webhook URL?', message: 'The old URL stops working; update it in every *arr app.', confirmLabel: 'Regenerate', danger: true }))) return;
    try {
      hook.setData(await arrApi.regenerateWebhook());
      toast.success('New webhook URL created');
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div className="form-grid">
      <p className="muted">
        Connect Radarr (movies), Sonarr (TV), Lidarr (music), Readarr (books) and Bazarr (subtitles). Approved requests go to the first enabled
        non-4K instance of the right kind; a 4K instance also gets the request when someone ticks “Also request in 4K”. Several instances of
        each kind are fine. Their queues, calendars and health show up under <strong>Admin → Downloads</strong>.
      </p>

      {value.length === 0 ? (
        <div className="howto"><strong><Icon name="info" size={16} /> No instances yet</strong><p className="muted" style={{ margin: '6px 0 0' }}>Add your first *arr app below. You need its URL and API key (Settings → General → Security in each app).</p></div>
      ) : (
        <div className="arr-instances">
          {value.map((i) => {
            const t = tests[i.id];
            return (
              <div key={i.id} className={`arr-instance ${i.enabled ? '' : 'is-off'}`}>
                <Icon name={ARR_ICON[i.kind]} size={22} />
                <div className="arr-instance-main">
                  <div><strong>{i.name}</strong> <Badge tone="muted">{ARR_NAME[i.kind]}</Badge> {i.is4k && <Badge tone="accent">4K</Badge>} {!i.enabled && <Badge tone="muted">Off</Badge>}</div>
                  <div className="mono">{i.url || 'No URL'}{(i.pathMappings?.length ?? 0) > 0 && ` · ${i.pathMappings!.length} path mapping${i.pathMappings!.length > 1 ? 's' : ''}`}</div>
                </div>
                <div className="arr-instance-actions">
                  {t && t !== 'busy' && (t.ok ? <span className="arr-test-ok"><Icon name="check" size={13} /> {t.message}</span> : <span className="arr-test-bad" title={t.message}><Icon name="alert" size={13} /> Failed</span>)}
                  <button className="btn btn-sm" onClick={() => void test(i)} disabled={t === 'busy' || !i.url}>{t === 'busy' ? <Spinner size={14} /> : <Icon name="zap" size={14} />} Test</button>
                  <button className="btn btn-sm" onClick={() => setEditing({ inst: i, isNew: false })}><Icon name="edit" size={14} /> Edit</button>
                  <button className="btn-icon" onClick={() => void remove(i)} aria-label={`Remove ${i.name}`}><Icon name="trash" size={16} /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div><button className="btn" onClick={() => setEditing({ inst: blank('radarr'), isNew: true })}><Icon name="plus" size={16} /> Add instance</button></div>

      <div className="howto">
        <strong><Icon name="zap" size={16} /> Instant library updates (webhook)</strong>
        <p className="muted" style={{ margin: '6px 0 0' }}>
          When an *arr app imports, upgrades, renames or deletes something, it can tell Kinora right away. Kinora then rescans only the library
          that holds that folder (bursts such as a season pack become one scan) and marks matching requests as available.
        </p>
        {hook.loading && !hook.data ? <Skeleton h={38} /> : hook.error ? <p className="form-error">{hook.error}</p> : (
          <div className="copy-row">
            <code className="mono">{hookUrl}</code>
            <button type="button" className="btn btn-sm" onClick={() => { void navigator.clipboard?.writeText(hookUrl); toast.success('Copied'); }}><Icon name="copy" size={14} /> Copy</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => void regenerate()}><Icon name="refresh" size={14} /> New URL</button>
          </div>
        )}
        {!publicUrl && <p className="muted" style={{ marginTop: 8 }}>The *arr apps must reach this address. If they use another one (e.g. a Docker network name), replace the host; set a Public URL on the General tab to change the default.</p>}
        <ol className="arr-steps">
          <li>In each app open <strong>Settings → Connect</strong>, click <strong>+</strong> and choose <strong>Webhook</strong>.</li>
          <li>Name it “Kinora”, paste the URL above, method <strong>POST</strong>, no username or password.</li>
          <li>Tick the triggers listed below, click <strong>Test</strong> (it shows up under Admin → Activity), then <strong>Save</strong>.</li>
        </ol>
        <div className="arr-apps">
          <div className="arr-app-help"><strong><Icon name="film" size={14} /> Radarr</strong><p>On File Import, On File Upgrade, On Rename, On Movie Delete, On Movie File Delete (and On Grab for the queue).</p></div>
          <div className="arr-app-help"><strong><Icon name="shows" size={14} /> Sonarr</strong><p>On File Import, On File Upgrade, On Import Complete, On Rename, On Series Delete, On Episode File Delete.</p></div>
          <div className="arr-app-help"><strong><Icon name="music" size={14} /> Lidarr</strong><p>On Release Import, On Upgrade, On Rename, On Track Retag, On Artist Delete, On Album Delete.</p></div>
          <div className="arr-app-help"><strong><Icon name="book" size={14} /> Readarr</strong><p>On Release Import, On Upgrade, On Rename, On Book Retag, On Author Delete, On Book Delete, On Book File Delete.</p></div>
        </div>
        <p className="muted" style={{ marginTop: 10 }}>
          If an app sees your media at a different path than Kinora (common with Docker), add a <strong>path mapping</strong> to that instance,
          e.g. <code>/movies</code> → <code>/media/Movies</code>. Bazarr has no webhook; its health shows on the Downloads page.
        </p>
      </div>

      {editing && <InstanceModal key={editing.inst.id} initial={editing.inst} isNew={editing.isNew} onClose={() => setEditing(null)} onSave={save} />}
    </div>
  );
}

function InstanceModal({ initial, isNew, onClose, onSave }: { initial: ArrInstance; isNew: boolean; onClose: () => void; onSave: (i: ArrInstance) => void }) {
  const toast = useToast();
  const [v, setV] = useState<ArrInstance>(initial);
  const [opts, setOpts] = useState<ArrOptions | null>(null);
  const [testing, setTesting] = useState(false);
  const set = (p: Partial<ArrInstance>) => setV((x) => ({ ...x, ...p }));
  const kind = KINDS.find((k) => k.kind === v.kind)!;
  const isMusic = v.kind === 'lidarr' || v.kind === 'readarr';
  const video = v.kind === 'radarr' || v.kind === 'sonarr';

  const test = async () => {
    setTesting(true);
    try {
      const r = await arrApi.test({ id: v.id, kind: v.kind, url: v.url.trim(), apiKey: v.apiKey.trim() });
      setOpts(r);
      if (!r.ok) return;
      if (v.kind === 'bazarr') return;
      const p: Partial<ArrInstance> = {};
      if (!r.qualityProfiles.some((q) => q.id === v.qualityProfileId)) p.qualityProfileId = r.qualityProfiles[0]?.id ?? null;
      if (!r.rootFolders.some((f) => f.path === v.rootFolderPath)) p.rootFolderPath = r.rootFolders[0]?.path ?? null;
      if (r.metadataProfiles?.length && !r.metadataProfiles.some((m) => m.id === v.metadataProfileId)) p.metadataProfileId = r.metadataProfiles.find((m) => m.name !== 'None')?.id ?? r.metadataProfiles[0].id;
      if (r.languageProfiles?.length && !r.languageProfiles.some((m) => m.id === v.languageProfileId)) p.languageProfileId = r.languageProfiles[0].id;
      if (Object.keys(p).length) set(p);
    } catch (e) {
      toast.error(e);
    } finally {
      setTesting(false);
    }
  };
  // Load the pickers straight away for saved instances.
  useEffect(() => {
    if (!isNew && initial.url && initial.apiKey) void test();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const profiles = opts?.ok ? opts.qualityProfiles : v.qualityProfileId != null ? [{ id: v.qualityProfileId, name: `Profile #${v.qualityProfileId}` }] : [];
  const folders = opts?.ok ? opts.rootFolders : v.rootFolderPath ? [{ path: v.rootFolderPath, freeSpace: null }] : [];
  const metas = opts?.ok ? opts.metadataProfiles ?? [] : v.metadataProfileId != null ? [{ id: v.metadataProfileId, name: `Profile #${v.metadataProfileId}` }] : [];
  const tags = opts?.ok ? opts.tags ?? [] : [];
  const maps = v.pathMappings ?? [];
  const setMap = (i: number, p: Partial<ArrPathMapping>) => set({ pathMappings: maps.map((m, j) => (j === i ? { ...m, ...p } : m)) });
  const valid = /^https?:\/\/\S+$/i.test(v.url.trim()) && !!v.apiKey.trim() && !!v.name.trim();

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={isNew ? 'Add *arr instance' : `Edit ${initial.name}`}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!valid} onClick={() => onSave({ ...v, url: v.url.trim().replace(/\/+$/, ''), name: v.name.trim(), pathMappings: maps.filter((m) => m.remotePath.trim() && m.localPath.trim()) })}>
            <Icon name="check" size={16} /> {isNew ? 'Add' : 'Done'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        {isNew && (
          <div className="arr-kinds" role="group" aria-label="App">
            {KINDS.map((k) => (
              <button key={k.kind} type="button" className="arr-kind" aria-pressed={v.kind === k.kind} onClick={() => { setOpts(null); set({ kind: k.kind, name: v.name === ARR_NAME[v.kind] || !v.name ? ARR_NAME[k.kind] : v.name, is4k: false, monitor: undefined }); }}>
                <Icon name={ARR_ICON[k.kind]} size={22} /> {ARR_NAME[k.kind]} <small>{k.what}</small>
              </button>
            ))}
          </div>
        )}
        <div className="form-row">
          <Field label="Name"><input className="input" value={v.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} /></Field>
          <Field label="URL" hint="Include any URL base, e.g. http://nas:7878/radarr">
            <input className="input mono" value={v.url} onChange={(e) => set({ url: e.target.value })} placeholder={`http://${v.kind}:${kind.port}`} spellCheck={false} />
          </Field>
        </div>
        <Field label="API key" hint={`${ARR_NAME[v.kind]} → Settings → General → Security.${v.apiKey === MASK ? ' Leave as is to keep the saved key.' : ''}`}>
          <input className="input mono" type="password" autoComplete="off" value={v.apiKey} onChange={(e) => set({ apiKey: e.target.value })} onFocus={(e) => v.apiKey === MASK && e.target.select()} spellCheck={false} />
        </Field>
        <div className="row-gap">
          <button className="btn" onClick={() => void test()} disabled={testing || !v.url.trim() || !v.apiKey.trim()}>
            {testing ? <Spinner size={14} /> : <Icon name="zap" size={14} />} Test{v.kind !== 'bazarr' ? ' & load options' : ''}
          </button>
          {opts && (opts.ok ? <span className="arr-test-ok"><Icon name="check" size={13} /> {opts.message}</span> : <span className="form-error">{opts.message}</span>)}
        </div>
        <Switch checked={v.enabled} onChange={(c) => set({ enabled: c })} label="Enabled" />
        {video && <Switch checked={!!v.is4k} onChange={(c) => set({ is4k: c })} label="4K instance" hint="Used for “Also request in 4K”. Normal requests go to a non-4K instance." />}

        {v.kind !== 'bazarr' && (
          <>
            <div className="form-row">
              <Field label="Quality profile">
                <select className="select" value={v.qualityProfileId ?? ''} onChange={(e) => set({ qualityProfileId: e.target.value ? Number(e.target.value) : null })} disabled={!profiles.length}>
                  <option value="">{profiles.length ? 'First profile' : 'Test the connection first'}</option>
                  {profiles.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
                </select>
              </Field>
              <Field label="Root folder">
                <select className="select" value={v.rootFolderPath ?? ''} onChange={(e) => set({ rootFolderPath: e.target.value || null })} disabled={!folders.length}>
                  <option value="">{folders.length ? 'First root folder' : 'Test the connection first'}</option>
                  {folders.map((f) => <option key={f.path} value={f.path}>{f.path}{f.freeSpace != null ? ` (${formatBytes(f.freeSpace)} free)` : ''}</option>)}
                </select>
              </Field>
            </div>
            {(isMusic || (opts?.languageProfiles?.length ?? 0) > 0) && (
              <div className="form-row">
                {isMusic && (
                  <Field label="Metadata profile">
                    <select className="select" value={v.metadataProfileId ?? ''} onChange={(e) => set({ metadataProfileId: e.target.value ? Number(e.target.value) : null })} disabled={!metas.length}>
                      <option value="">{metas.length ? 'Default' : 'Test the connection first'}</option>
                      {metas.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
                    </select>
                  </Field>
                )}
                {(opts?.languageProfiles?.length ?? 0) > 0 && (
                  <Field label="Language profile" hint="Sonarr v3 only.">
                    <select className="select" value={v.languageProfileId ?? ''} onChange={(e) => set({ languageProfileId: e.target.value ? Number(e.target.value) : null })}>
                      {opts!.languageProfiles!.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
                    </select>
                  </Field>
                )}
              </div>
            )}
            {MONITOR[v.kind] && (
              <Field label="Monitor when adding" hint={v.kind === 'sonarr' ? 'Used when all seasons are requested; season choices in the request win.' : undefined}>
                <select className="select" value={v.monitor ?? ''} onChange={(e) => set({ monitor: e.target.value || undefined })}>
                  <option value="">Default ({MONITOR[v.kind]![0].label})</option>
                  {MONITOR[v.kind]!.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </Field>
            )}
            {tags.length > 0 && (
              <fieldset className="settings-fieldset">
                <legend className="field-label">Tags for added titles</legend>
                <div className="event-chips">
                  {tags.map((t) => {
                    const on = (v.tags ?? []).includes(t.id);
                    return (
                      <label key={t.id} className={`check-chip ${on ? 'on' : ''}`}>
                        <input type="checkbox" checked={on} onChange={(e) => set({ tags: e.target.checked ? [...(v.tags ?? []), t.id] : (v.tags ?? []).filter((x) => x !== t.id) })} /> {t.label}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            )}
            {v.kind === 'sonarr' && <Switch checked={v.seasonFolders !== false} onChange={(c) => set({ seasonFolders: c })} label="Season folders" />}
            <Switch checked={v.searchOnAdd !== false} onChange={(c) => set({ searchOnAdd: c })} label="Search on add" hint={`Ask ${ARR_NAME[v.kind]} to start searching as soon as a request is approved.`} />

            <fieldset className="settings-fieldset">
              <legend className="field-label">Path mappings</legend>
              <small className="field-hint">For webhooks: how a path in {ARR_NAME[v.kind]} (left) looks to Kinora (right). Only needed when they differ.</small>
              {maps.map((m, i) => (
                <div key={i} className="arr-mapping" style={{ marginTop: 8 }}>
                  <input className="input mono" value={m.remotePath} onChange={(e) => setMap(i, { remotePath: e.target.value })} placeholder={`/${v.kind === 'radarr' ? 'movies' : v.kind === 'sonarr' ? 'tv' : v.kind === 'lidarr' ? 'music' : 'books'}`} aria-label={`${ARR_NAME[v.kind]} path`} spellCheck={false} />
                  <Icon name="next" size={16} />
                  <input className="input mono" value={m.localPath} onChange={(e) => setMap(i, { localPath: e.target.value })} placeholder="/media/..." aria-label="Kinora path" spellCheck={false} />
                  <button className="btn-icon" onClick={() => set({ pathMappings: maps.filter((_, j) => j !== i) })} aria-label="Remove mapping"><Icon name="trash" size={16} /></button>
                </div>
              ))}
              <div style={{ marginTop: 8 }}><button className="btn btn-sm" onClick={() => set({ pathMappings: [...maps, { remotePath: '', localPath: '' }] })}><Icon name="plus" size={14} /> Add mapping</button></div>
            </fieldset>
          </>
        )}
      </div>
    </Modal>
  );
}
