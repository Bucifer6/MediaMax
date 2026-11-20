import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Channel } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useToast } from '../state/toast';
import { useAsync, useDebounced } from '../hooks';
import { EmptyState, Field, Img, Modal, Skeleton } from '../components/ui';
import { Icon } from '../components/Icon';
import { AdminHeader } from './AdminRoutes';

const PAGE = 100;

function ChannelEditor({ channel, onClose, onSaved }: { channel: Channel; onClose: () => void; onSaved: (c: Channel) => void }) {
  const toast = useToast();
  const [f, setF] = useState({ number: channel.number?.toString() ?? '', name: channel.name, epgChannelId: channel.epgChannelId ?? '', logoUrl: channel.logoUrl ?? '', hidden: channel.hidden });
  const save = async () => {
    try {
      const c = await api.livetv.updateChannel(channel.id, {
        number: f.number === '' ? null : Number(f.number),
        name: f.name,
        epgChannelId: f.epgChannelId || null,
        logoUrl: f.logoUrl || null,
        hidden: f.hidden,
      });
      onSaved(c);
      toast.success('Channel saved');
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Edit ${channel.name}`} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={save}>Save</button></>}>
      <div className="form-grid">
        <div className="form-row">
          <Field label="Number"><input className="input" type="number" value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} /></Field>
          <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        </div>
        <Field label="EPG channel ID" hint={<>A guide channel id, looked up in your guides by priority. The <Link to="/admin/guide?tab=matching">Guide matching</Link> page lets you search every guide, pick one and shift times.</>}><input className="input" value={f.epgChannelId} onChange={(e) => setF({ ...f, epgChannelId: e.target.value })} /></Field>
        <Field label="Logo URL">
          <div className="logo-field">
            <span className="ch-logo"><Img src={f.logoUrl} width={80} fallback={<Icon name="tv" size={16} />} /></span>
            <input className="input" value={f.logoUrl} onChange={(e) => setF({ ...f, logoUrl: e.target.value })} />
          </div>
        </Field>
        <label className="check-inline"><input type="checkbox" checked={f.hidden} onChange={(e) => setF({ ...f, hidden: e.target.checked })} /> Hidden from users</label>
      </div>
    </Modal>
  );
}

export function ChannelsAdmin() {
  const toast = useToast();
  const sources = useAsync(() => api.livetv.sources().catch(() => []), []);
  const [sourceId, setSourceId] = useState('');
  const cats = useAsync(() => api.livetv.categories(sourceId || undefined).catch(() => []), [sourceId]);
  const [categoryId, setCategoryId] = useState('');
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 250);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState<Channel | null>(null);
  const req = useRef(0);

  const load = async (offset: number) => {
    const id = ++req.current;
    setLoading(true);
    try {
      const r = await api.livetv.channels({ sourceId: sourceId || undefined, categoryId: categoryId || undefined, search: q || undefined, limit: PAGE, offset, withEpg: false, guideStatus: true });
      if (id !== req.current) return;
      setChannels((c) => (offset ? [...c, ...r.items] : r.items));
      setTotal(r.total);
    } catch (e) {
      toast.error(e);
    } finally {
      if (id === req.current) setLoading(false);
    }
  };
  useEffect(() => {
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, categoryId, q]);

  const quick = async (c: Channel, body: { hidden?: boolean; number?: number | null }) => {
    setChannels((l) => l.map((x) => (x.id === c.id ? { ...x, ...body } : x)));
    try {
      await api.livetv.updateChannel(c.id, body);
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div>
      <AdminHeader help="admin-tv-guide" title="Channels" subtitle={`${total.toLocaleString()} channels — renumber, rename, hide or fix guide mapping.`} actions={<Link className="btn" to="/admin/guide?tab=matching"><Icon name="guide" size={16} /> Guide matching</Link>} />
      <div className="toolbar">
        <div className="search-mini"><Icon name="search" size={16} /><input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search channels" /></div>
        <select className="select" value={sourceId} onChange={(e) => { setSourceId(e.target.value); setCategoryId(''); }}>
          <option value="">All sources</option>
          {(sources.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">All categories</option>
          {(cats.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      {loading && !channels.length ? <Skeleton h={300} /> : !channels.length ? <EmptyState icon="tv" title="No channels" /> : (
        <div className="table-wrap">
          <table className="table channels-table">
            <thead><tr><th style={{ width: 90 }}>#</th><th>Channel</th><th>Category</th><th>Guide</th><th>Visible</th><th /></tr></thead>
            <tbody>
              {channels.map((c) => (
                <tr key={c.id} className={c.hidden ? 'dim' : ''}>
                  <td>
                    <input className="input input-sm" type="number" defaultValue={c.number ?? ''} onBlur={(e) => {
                      const v = e.target.value === '' ? null : Number(e.target.value);
                      if (v !== c.number) void quick(c, { number: v });
                    }} aria-label="Channel number" />
                  </td>
                  <td>
                    <div className="user-cell">
                      <span className="ch-logo"><Img src={c.logoUrl} width={80} fallback={<span className="ch-logo-text">{c.name.slice(0, 3)}</span>} /></span>
                      <span>{c.name} {c.hasArchive && <span className="badge badge-muted">Catch-up {c.archiveDays}d</span>}</span>
                    </div>
                  </td>
                  <td className="muted">{c.categoryName ?? '—'}</td>
                  <td>
                    {c.epgChannelId ? <code>{c.epgChannelId}</code> : <span className="text-warning">{c.guideStatus === 'review' ? 'Suggestion waiting' : 'Unmapped'}</span>}
                    {c.epgOffsetHours ? <span className="muted"> {c.epgOffsetHours > 0 ? '+' : ''}{c.epgOffsetHours} h</span> : null}
                    {c.hasGuide === false && <Link to="/admin/guide?tab=matching" className="badge badge-danger ch-guide-missing" title="No programmes from now on — fix it on the Guide matching page">Missing guide</Link>}
                  </td>
                  <td><input type="checkbox" className="switch" checked={!c.hidden} onChange={(e) => quick(c, { hidden: !e.target.checked })} aria-label="Visible" /></td>
                  <td className="td-actions"><button className="btn-icon" onClick={() => setEdit(c)} aria-label="Edit"><Icon name="edit" size={16} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {channels.length < total && (
            <div className="center-pad"><button className="btn" onClick={() => load(channels.length)} disabled={loading}>Load more ({total - channels.length} remaining)</button></div>
          )}
        </div>
      )}
      {edit && <ChannelEditor channel={edit} onClose={() => setEdit(null)} onSaved={(c) => { setChannels((l) => l.map((x) => (x.id === c.id ? c : x))); setEdit(null); }} />}
    </div>
  );
}
