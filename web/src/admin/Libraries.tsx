import { useState } from 'react';
import type { DateAddedSource, Library } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useAsync, useServerEvent } from '../hooks';
import { Badge, Dropdown, EmptyState, ErrorState, Modal, ProgressBar, Skeleton, useConfirm } from '../components/ui';
import { Icon } from '../components/Icon';
import { DATE_ADDED_OPTIONS, LibraryForm } from '../components/LibraryForm';
import { isIptvLibrary, libraryIcon } from '../utils/items';
import { relativeTime } from '../utils/format';
import { AdminHeader } from './AdminRoutes';

export function LibrariesAdmin() {
  const { refreshLibraries } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const libs = useAsync(() => api.libraries.list(), []);
  const settings = useAsync(() => api.admin.settings(), []);
  const defaultDateAdded: DateAddedSource = settings.data?.defaultDateAdded ?? 'created';
  const [edit, setEdit] = useState<Library | 'new' | null>(null);
  const [scan, setScan] = useState<Record<string, { progress?: number; message?: string }>>({});

  useServerEvent((ev) => {
    if (ev.type === 'library.scan') {
      setScan((s) => {
        const n = { ...s };
        if (ev.status === 'finished') delete n[ev.libraryId];
        else n[ev.libraryId] = { progress: ev.progress, message: ev.message };
        return n;
      });
      if (ev.status === 'finished') libs.reload();
    } else if (ev.type === 'library.updated') libs.reload();
  });

  const list = [...(libs.data ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

  const doScan = async (l: Library, refreshMetadata = false) => {
    try {
      await api.libraries.scan(l.id, refreshMetadata);
      setScan((s) => ({ ...s, [l.id]: { progress: 0, message: 'Starting…' } }));
      toast.success(`${refreshMetadata ? 'Metadata refresh' : 'Scan'} started for ${l.name}`);
    } catch (e) {
      toast.error(e);
    }
  };
  const scanAll = async () => {
    try {
      await api.libraries.scanAll();
      toast.success('Scanning all libraries');
    } catch (e) {
      toast.error(e);
    }
  };
  const recalcDateAdded = async (l: Library) => {
    try {
      const r = await api.libraries.recalculateDateAdded(l.id);
      toast.success(l.dateAdded === 'scan' ? `${l.name} uses the scan time — choose a file time under Edit first` : `Date added updated for ${r.changed.toLocaleString()} item${r.changed === 1 ? '' : 's'}`);
    } catch (e) {
      toast.error(e);
    }
  };
  const saveDefaultDateAdded = async (v: DateAddedSource) => {
    try {
      settings.setData(await api.admin.saveSettingsPatch({ defaultDateAdded: v }));
      toast.success('Default for new libraries saved');
    } catch (e) {
      toast.error(e);
    }
  };
  const remove = async (l: Library) => {
    if (!(await confirm({ title: `Delete library "${l.name}"?`, message: 'Items are removed from MediaMax. Your files are not touched.', confirmLabel: 'Delete library', danger: true }))) return;
    try {
      await api.libraries.remove(l.id);
      libs.setData((d) => (d ?? []).filter((x) => x.id !== l.id));
      void refreshLibraries();
    } catch (e) {
      toast.error(e);
    }
  };
  const move = async (l: Library, dir: -1 | 1) => {
    const i = list.findIndex((x) => x.id === l.id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const reordered = [...list];
    [reordered[i], reordered[j]] = [reordered[j]!, reordered[i]!];
    const withOrder = reordered.map((x, idx) => ({ ...x, sortOrder: idx }));
    libs.setData(withOrder);
    try {
      await Promise.all(withOrder.filter((x, idx) => list[idx]?.id !== x.id).map((x) => api.libraries.update(x.id, { sortOrder: x.sortOrder })));
      void refreshLibraries();
    } catch (e) {
      toast.error(e);
      libs.reload();
    }
  };

  return (
    <div>
      <AdminHeader help="admin-libraries"
        title="Libraries"
        subtitle="Folders MediaMax watches for media. Xtream VOD & series libraries are created automatically from Live TV sources."
        actions={
          <>
            <button className="btn" onClick={scanAll}><Icon name="refresh" size={16} /> Scan all</button>
            <button className="btn btn-primary" onClick={() => setEdit('new')}><Icon name="plus" size={16} /> Add library</button>
          </>
        }
      />
      {settings.data && (
        <div className="lib-default-date muted">
          <label>
            Date added for new libraries{' '}
            <select className="select" value={defaultDateAdded} onChange={(e) => void saveDefaultDateAdded(e.target.value as DateAddedSource)}>
              {DATE_ADDED_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        </div>
      )}
      {libs.loading && !libs.data ? <Skeleton h={200} /> : libs.error ? <ErrorState message={libs.error} onRetry={libs.reload} /> : !list.length ? (
        <EmptyState icon="database" title="No libraries yet" message="Add a folder of movies, shows, music or photos." action={<button className="btn btn-primary" onClick={() => setEdit('new')}>Add library</button>} />
      ) : (
        <div className="lib-admin-list">
          {list.map((l, i) => {
            const sc = scan[l.id];
            const scanning = !!sc || l.scanning;
            const pct = sc?.progress != null ? sc.progress : null;
            return (
              <div key={l.id} className="lib-admin-card">
                <div className="lib-order">
                  <button className="btn-icon" disabled={i === 0} onClick={() => move(l, -1)} aria-label="Move up"><Icon name="chevronUp" size={16} /></button>
                  <button className="btn-icon" disabled={i === list.length - 1} onClick={() => move(l, 1)} aria-label="Move down"><Icon name="chevronDown" size={16} /></button>
                </div>
                <span className="lib-icon"><Icon name={libraryIcon(l.type)} size={26} /></span>
                <div className="lib-info">
                  <div className="lib-name">{l.name} {isIptvLibrary(l.type) && <Badge tone="accent">IPTV</Badge>} {!l.fetchMetadata && <Badge tone="muted">Local metadata</Badge>}</div>
                  <div className="muted lib-sub">
                    {l.itemCount.toLocaleString()} item{l.itemCount === 1 ? '' : 's'} · {l.type} · last scan {relativeTime(l.lastScanAt)}
                  </div>
                  {l.paths.length > 0 && <div className="lib-paths">{l.paths.map((p) => <code key={p}>{p}</code>)}</div>}
                  {scanning && (
                    <div className="lib-scan">
                      <ProgressBar value={pct ?? 0} className={pct == null ? 'indeterminate' : ''} />
                      <small className="muted">{sc?.message ?? 'Scanning…'} {pct != null ? `${Math.round(pct)}%` : ''}</small>
                    </div>
                  )}
                </div>
                <div className="lib-actions">
                  <button className="btn btn-sm" onClick={() => doScan(l)} disabled={scanning}>
                    <Icon name="refresh" size={14} className={scanning ? 'spin' : ''} /> Scan
                  </button>
                  <Dropdown
                    trigger={({ onClick }) => <button className="btn-icon" onClick={onClick} aria-label="More"><Icon name="more" /></button>}
                    items={[
                      { label: 'Edit', icon: 'edit', onClick: () => setEdit(l) },
                      { label: 'Refresh all metadata', icon: 'sparkles', onClick: () => doScan(l, true) },
                      ...(isIptvLibrary(l.type) || l.type === 'podcasts' ? [] : [{ label: 'Recalculate date added', icon: 'calendar' as const, onClick: () => void recalcDateAdded(l) }]),
                      { divider: true, label: '' },
                      { label: 'Delete', icon: 'trash', danger: true, onClick: () => remove(l) },
                    ]}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit === 'new' ? 'Add library' : `Edit ${edit ? edit.name : ''}`} size="lg">
        {edit && (
          <LibraryForm
            initial={edit === 'new' ? undefined : edit}
            defaultDateAdded={defaultDateAdded}
            onCancel={() => setEdit(null)}
            onSaved={(l) => {
              libs.setData((d) => {
                const arr = d ?? [];
                return arr.some((x) => x.id === l.id) ? arr.map((x) => (x.id === l.id ? l : x)) : [...arr, l];
              });
              setEdit(null);
              void refreshLibraries();
            }}
          />
        )}
      </Modal>
    </div>
  );
}
