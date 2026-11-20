import { useState } from 'react';
import type { ChannelCategory, LiveSource } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useToast } from '../state/toast';
import { useAsync, useServerEvent } from '../hooks';
import { Badge, Dropdown, EmptyState, ErrorState, Modal, Skeleton, Switch, useConfirm } from '../components/ui';
import { Icon } from '../components/Icon';
import { AccountInfo, SourceForm } from '../components/SourceForm';
import { relativeTime } from '../utils/format';
import { AdminHeader } from './AdminRoutes';

function Categories({ source }: { source: LiveSource }) {
  const toast = useToast();
  const cats = useAsync(() => api.livetv.categories(source.id), [source.id]);
  const [filter, setFilter] = useState('');
  const list = [...(cats.data ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

  const patch = async (c: ChannelCategory, body: { hidden?: boolean; sortOrder?: number }) => {
    cats.setData((d) => (d ?? []).map((x) => (x.id === c.id ? { ...x, ...body } : x)));
    try {
      await api.livetv.updateCategory(c.id, body);
    } catch (e) {
      toast.error(e);
      cats.reload();
    }
  };
  const move = async (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const re = [...list];
    [re[i], re[j]] = [re[j]!, re[i]!];
    const updated = re.map((c, idx) => ({ ...c, sortOrder: idx }));
    cats.setData(updated);
    try {
      await Promise.all(updated.filter((c, idx) => list[idx]?.id !== c.id).map((c) => api.livetv.updateCategory(c.id, { sortOrder: c.sortOrder })));
    } catch (e) {
      toast.error(e);
      cats.reload();
    }
  };
  const setAll = async (hidden: boolean) => {
    const targets = list.filter((c) => c.hidden !== hidden && c.name.toLowerCase().includes(filter.toLowerCase()));
    cats.setData((d) => (d ?? []).map((x) => (targets.some((t) => t.id === x.id) ? { ...x, hidden } : x)));
    try {
      await Promise.all(targets.map((c) => api.livetv.updateCategory(c.id, { hidden })));
    } catch (e) {
      toast.error(e);
      cats.reload();
    }
  };

  if (cats.loading && !cats.data) return <Skeleton h={160} />;
  if (!list.length) return <p className="muted">No categories yet — refresh the source to import them.</p>;
  const shown = list.filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="cat-admin">
      <div className="toolbar">
        <input className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter categories" />
        <button className="btn btn-sm" onClick={() => setAll(false)}>Show all</button>
        <button className="btn btn-sm" onClick={() => setAll(true)}>Hide all</button>
        <span className="muted">{list.filter((c) => !c.hidden).length}/{list.length} visible</span>
      </div>
      <ul className="cat-admin-list">
        {shown.map((c) => {
          const i = list.indexOf(c);
          return (
            <li key={c.id} className={c.hidden ? 'dim' : ''}>
              <div className="lib-order">
                <button className="btn-icon" onClick={() => move(i, -1)} disabled={i === 0 || !!filter} aria-label="Move up"><Icon name="chevronUp" size={14} /></button>
                <button className="btn-icon" onClick={() => move(i, 1)} disabled={i === list.length - 1 || !!filter} aria-label="Move down"><Icon name="chevronDown" size={14} /></button>
              </div>
              <span className="cat-admin-name">{c.name}</span>
              <span className="muted">{c.channelCount} ch</span>
              <button className="btn-icon" onClick={() => patch(c, { hidden: !c.hidden })} aria-label={c.hidden ? 'Show' : 'Hide'} title={c.hidden ? 'Hidden — click to show' : 'Visible — click to hide'}>
                <Icon name={c.hidden ? 'eyeOff' : 'eye'} size={16} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function LiveSourcesAdmin() {
  const toast = useToast();
  const confirm = useConfirm();
  const sources = useAsync(() => api.livetv.sources(), []);
  const [edit, setEdit] = useState<LiveSource | 'new' | null>(null);
  const [cats, setCats] = useState<LiveSource | null>(null);
  useServerEvent((ev) => {
    if (ev.type === 'task.updated' && /epg|guide|channel|iptv|source/i.test(ev.task.id + ev.task.name) && !ev.task.running) sources.reload();
  });

  const upsert = (s: LiveSource) =>
    sources.setData((d) => {
      const arr = d ?? [];
      return arr.some((x) => x.id === s.id) ? arr.map((x) => (x.id === s.id ? s : x)) : [...arr, s];
    });

  const refresh = async (s: LiveSource) => {
    try {
      await api.livetv.refreshSource(s.id);
      toast.success(`Refreshing ${s.name} — channels, guide${s.importVod || s.importSeries ? ', VOD & series' : ''}`);
      window.setTimeout(() => sources.reload(), 4000);
    } catch (e) {
      toast.error(e);
    }
  };
  const toggle = async (s: LiveSource, patch: Partial<LiveSource>) => {
    upsert({ ...s, ...patch });
    try {
      upsert(await api.livetv.updateSource(s.id, patch as never));
    } catch (e) {
      toast.error(e);
      sources.reload();
    }
  };
  const remove = async (s: LiveSource) => {
    if (!(await confirm({ title: `Remove ${s.name}?`, message: 'Its channels, guide data and imported VOD/series libraries will be removed.', confirmLabel: 'Remove source', danger: true }))) return;
    try {
      await api.livetv.removeSource(s.id);
      sources.setData((d) => (d ?? []).filter((x) => x.id !== s.id));
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div>
      <AdminHeader title="Live TV sources" subtitle="Xtream Codes, M3U playlists and HDHomeRun tuners." actions={<button className="btn btn-primary" onClick={() => setEdit('new')}><Icon name="plus" size={16} /> Add source</button>} />
      {sources.loading && !sources.data ? <Skeleton h={200} /> : sources.error ? <ErrorState message={sources.error} onRetry={sources.reload} /> : !sources.data?.length ? (
        <EmptyState icon="antenna" title="No Live TV sources" message="Connect an IPTV provider to get channels, a TV guide, catch-up, VOD and DVR." action={<button className="btn btn-primary" onClick={() => setEdit('new')}>Add source</button>} />
      ) : (
        <div className="source-list">
          {sources.data.map((s) => (
            <div key={s.id} className={`source-card ${s.enabled ? '' : 'dim'}`}>
              <div className="source-head">
                <span className="lib-icon"><Icon name={s.type === 'hdhomerun' ? 'antenna' : s.type === 'xtream' ? 'zap' : 'list'} size={24} /></span>
                <div className="source-title">
                  <strong>{s.name}</strong>
                  <div className="muted">{s.type === 'xtream' ? 'Xtream Codes' : s.type === 'm3u' ? 'M3U' : 'HDHomeRun'} · {s.url}</div>
                </div>
                <input type="checkbox" className="switch" checked={s.enabled} onChange={(e) => toggle(s, { enabled: e.target.checked })} aria-label="Enabled" />
                <Dropdown
                  trigger={({ onClick }) => <button className="btn-icon" onClick={onClick} aria-label="More"><Icon name="more" /></button>}
                  items={[
                    { label: 'Edit', icon: 'edit', onClick: () => setEdit(s) },
                    { label: 'Categories', icon: 'layers', onClick: () => setCats(s) },
                    { label: 'Refresh now', icon: 'refresh', onClick: () => refresh(s) },
                    { divider: true, label: '' },
                    { label: 'Remove', icon: 'trash', danger: true, onClick: () => remove(s) },
                  ]}
                />
              </div>
              <div className="source-stats">
                <span><Icon name="tv" size={14} /> {s.channelCount.toLocaleString()} channels</span>
                <span><Icon name="clock" size={14} /> Refreshed {relativeTime(s.lastRefreshAt)} · every {s.refreshIntervalHours}h</span>
                {s.maxConnections != null && <span><Icon name="users" size={14} /> Max {s.maxConnections} streams</span>}
                {s.proxyStreams && <Badge tone="muted">Restreamed</Badge>}
              </div>
              {s.accountInfo && <AccountInfo info={s.accountInfo} />}
              {s.lastError && <div className="test-result fail compact"><Icon name="alert" size={16} /> {s.lastError}</div>}
              {s.type === 'xtream' && (
                <div className="source-toggles">
                  <Switch checked={s.importVod} onChange={(v) => toggle(s, { importVod: v })} label="Import VOD movies" />
                  <Switch checked={s.importSeries} onChange={(v) => toggle(s, { importSeries: v })} label="Import series" />
                </div>
              )}
              <div className="source-actions">
                <button className="btn btn-sm" onClick={() => refresh(s)}><Icon name="refresh" size={14} /> Refresh</button>
                <button className="btn btn-sm" onClick={() => setCats(s)}><Icon name="layers" size={14} /> Categories</button>
                <button className="btn btn-sm btn-ghost" onClick={() => setEdit(s)}><Icon name="edit" size={14} /> Edit</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit === 'new' ? 'Add Live TV source' : `Edit ${edit ? (edit as LiveSource).name : ''}`} size="lg">
        {edit && <SourceForm initial={edit === 'new' ? undefined : edit} onCancel={() => setEdit(null)} onSaved={(s) => { upsert(s); setEdit(null); }} />}
      </Modal>
      <Modal open={!!cats} onClose={() => setCats(null)} title={`Categories · ${cats?.name ?? ''}`} size="md">
        {cats && <Categories source={cats} />}
      </Modal>
    </div>
  );
}
