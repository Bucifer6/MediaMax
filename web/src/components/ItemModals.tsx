import { useEffect, useState } from 'react';
import type { Item, Marker, UpdateItemRequest } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useToast } from '../state/toast';
import { Field, Img, Modal, Spinner } from './ui';
import { Icon } from './Icon';
import { formatClock, parseClock } from '../utils/format';
import { CONTENT_RATINGS } from '../utils/items';

/* ---------------- Add to playlist / collection ---------------- */
export function AddToContainerModal({ open, onClose, items, kind }: { open: boolean; onClose: () => void; items: Item[]; kind: 'playlist' | 'collection' }) {
  const toast = useToast();
  const [lists, setLists] = useState<Item[] | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const svc = kind === 'playlist' ? api.playlists : api.collections;

  useEffect(() => {
    if (!open) return;
    setLists(null);
    svc.list().then(setLists).catch(() => setLists([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind]);

  const ids = items.map((i) => i.id);
  const add = async (list: Item) => {
    setBusy(true);
    try {
      await svc.addItems(list.id, ids);
      toast.success(`Added to ${list.title}`);
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const list = await svc.create({ title: title.trim(), itemIds: ids });
      toast.success(`Created ${list.title}`);
      setTitle('');
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Add to ${kind}`} size="sm">
      <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`New ${kind} name`} />
        <button className="btn btn-primary" disabled={busy || !title.trim()}>
          <Icon name="plus" size={16} /> Create
        </button>
      </form>
      <div className="pick-list">
        {lists === null ? (
          <div className="center-pad"><Spinner /></div>
        ) : lists.length === 0 ? (
          <p className="muted center-pad">No {kind}s yet</p>
        ) : (
          lists.map((l) => (
            <button key={l.id} className="pick-item" onClick={() => add(l)} disabled={busy}>
              <span className="pick-art"><Img src={l.posterUrl ?? l.thumbUrl} width={80} fallback={<Icon name={kind === 'playlist' ? 'playlist' : 'collection'} size={18} />} /></span>
              <span className="pick-text">
                <span>{l.title}</span>
                <small>{l.childCount} items</small>
              </span>
              <Icon name="plus" size={16} />
            </button>
          ))
        )}
      </div>
    </Modal>
  );
}

/* ---------------- Upload artwork ---------------- */
type ArtKind = 'poster' | 'backdrop' | 'logo' | 'thumb';
export function UploadArtworkModal({ open, onClose, item, onUpdated }: { open: boolean; onClose: () => void; item: Item; onUpdated: (i: Item) => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<ArtKind>('poster');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!file) return setPreview(null);
    const u = URL.createObjectURL(file);
    setPreview(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  const current: Record<ArtKind, string | null> = { poster: item.posterUrl, backdrop: item.backdropUrl, logo: item.logoUrl, thumb: item.thumbUrl };
  const submit = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const updated = await api.items.uploadImage(item.id, kind, file);
      onUpdated(updated);
      toast.success('Artwork updated');
      setFile(null);
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Upload artwork"
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={!file || busy}>{busy ? <Spinner size={18} /> : 'Upload'}</button>
        </>
      }
    >
      <div className="segmented">
        {(['poster', 'backdrop', 'logo', 'thumb'] as ArtKind[]).map((k) => (
          <button key={k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>{k[0]!.toUpperCase() + k.slice(1)}</button>
        ))}
      </div>
      <label className={`dropzone art-${kind}`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (f) setFile(f);
        }}
      >
        {preview ? <img src={preview} alt="" /> : current[kind] ? <Img src={current[kind]} width={600} /> : null}
        <span className="dropzone-label">
          <Icon name="upload" size={22} /> {file ? file.name : 'Drop an image or click to choose'}
        </span>
        <input type="file" accept="image/*" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
    </Modal>
  );
}

/* ---------------- Edit metadata ---------------- */
const MARKER_TYPES: Marker['type'][] = ['intro', 'credits', 'recap'];

export function EditMetadataModal({ open, onClose, item, onUpdated }: { open: boolean; onClose: () => void; item: Item; onUpdated: (i: Item) => void }) {
  const toast = useToast();
  const init = () => ({
    title: item.title,
    sortTitle: item.sortTitle,
    originalTitle: item.originalTitle ?? '',
    year: item.year?.toString() ?? '',
    overview: item.overview ?? '',
    tagline: item.tagline ?? '',
    contentRating: item.contentRating ?? '',
    genres: item.genres.join(', '),
    studios: item.studios.join(', '),
    communityRating: item.communityRating?.toString() ?? '',
  });
  const [f, setF] = useState(init);
  const [markers, setMarkers] = useState<{ type: Marker['type']; start: string; end: string }[]>([]);
  const [lock, setLock] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setF(init());
    setMarkers((item.markers ?? []).map((m) => ({ type: m.type, start: formatClock(m.startMs), end: formatClock(m.endMs) })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item.id]);

  const set = (k: keyof ReturnType<typeof init>, v: string) => setF((x) => ({ ...x, [k]: v }));
  const playable = item.type === 'movie' || item.type === 'episode' || item.type === 'video';

  const submit = async () => {
    const orig = init();
    const body: UpdateItemRequest = {};
    const changed: string[] = [];
    const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
    const num = (s: string) => (s.trim() === '' ? null : Number(s));
    const str = (s: string) => (s.trim() === '' ? null : s.trim());
    (Object.keys(f) as (keyof typeof f)[]).forEach((k) => {
      if (f[k] === orig[k]) return;
      changed.push(k);
      switch (k) {
        case 'title':
        case 'sortTitle':
          body[k] = f[k].trim();
          break;
        case 'year':
        case 'communityRating':
          body[k] = num(f[k]);
          break;
        case 'genres':
        case 'studios':
          body[k] = list(f[k]);
          break;
        default:
          body[k] = str(f[k]);
      }
    });
    if (playable) {
      const parsed: Marker[] = [];
      for (const m of markers) {
        const s = parseClock(m.start);
        const e = parseClock(m.end);
        if (s == null || e == null || e <= s) {
          toast.show(`Invalid ${m.type} marker times`, 'error');
          return;
        }
        parsed.push({ type: m.type, startMs: s, endMs: e });
      }
      const before = JSON.stringify(item.markers ?? []);
      if (JSON.stringify(parsed) !== before) body.markers = parsed;
    }
    if (lock && changed.length) body.lockedFields = changed;
    if (!Object.keys(body).length) return onClose();
    setBusy(true);
    try {
      const updated = await api.items.update(item.id, body);
      onUpdated(updated);
      toast.success('Metadata saved');
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Edit ${item.title}`}
      size="lg"
      footer={
        <>
          <label className="check-inline"><input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} /> Lock edited fields</label>
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? <Spinner size={18} /> : 'Save'}</button>
        </>
      }
    >
      <div className="form-grid">
        <div className="form-row">
          <Field label="Title"><input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} /></Field>
          <Field label="Sort title"><input className="input" value={f.sortTitle} onChange={(e) => set('sortTitle', e.target.value)} /></Field>
        </div>
        <div className="form-row">
          <Field label="Original title"><input className="input" value={f.originalTitle} onChange={(e) => set('originalTitle', e.target.value)} /></Field>
          <Field label="Tagline"><input className="input" value={f.tagline} onChange={(e) => set('tagline', e.target.value)} /></Field>
        </div>
        <div className="form-row form-row-3">
          <Field label="Year"><input className="input" type="number" value={f.year} onChange={(e) => set('year', e.target.value)} /></Field>
          <Field label="Rating (0–10)"><input className="input" type="number" step="0.1" min="0" max="10" value={f.communityRating} onChange={(e) => set('communityRating', e.target.value)} /></Field>
          <Field label="Content rating">
            <input className="input" list="mm-ratings" value={f.contentRating} onChange={(e) => set('contentRating', e.target.value)} />
            <datalist id="mm-ratings">{CONTENT_RATINGS.map((r) => <option key={r} value={r} />)}</datalist>
          </Field>
        </div>
        <Field label="Overview"><textarea className="textarea" rows={5} value={f.overview} onChange={(e) => set('overview', e.target.value)} /></Field>
        <div className="form-row">
          <Field label="Genres" hint="Comma separated"><input className="input" value={f.genres} onChange={(e) => set('genres', e.target.value)} /></Field>
          <Field label="Studios" hint="Comma separated"><input className="input" value={f.studios} onChange={(e) => set('studios', e.target.value)} /></Field>
        </div>
        {playable && (
          <div className="field">
            <span className="field-label">Markers <small className="muted">(h:mm:ss or m:ss) — power Skip Intro / Skip Credits</small></span>
            <div className="marker-list">
              {markers.map((m, i) => (
                <div key={i} className="marker-row">
                  <select className="select" value={m.type} onChange={(e) => setMarkers((ms) => ms.map((x, j) => (j === i ? { ...x, type: e.target.value as Marker['type'] } : x)))}>
                    {MARKER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <input className="input" value={m.start} onChange={(e) => setMarkers((ms) => ms.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} placeholder="0:30" aria-label="Start" />
                  <span className="muted">→</span>
                  <input className="input" value={m.end} onChange={(e) => setMarkers((ms) => ms.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} placeholder="1:45" aria-label="End" />
                  <button className="btn-icon" onClick={() => setMarkers((ms) => ms.filter((_, j) => j !== i))} aria-label="Remove marker"><Icon name="trash" size={16} /></button>
                </div>
              ))}
              <button className="btn btn-sm" onClick={() => setMarkers((ms) => [...ms, { type: ms.some((x) => x.type === 'intro') ? 'credits' : 'intro', start: '', end: '' }])}>
                <Icon name="plus" size={14} /> Add marker
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
