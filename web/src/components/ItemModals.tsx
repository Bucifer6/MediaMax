import { useEffect, useRef, useState } from 'react';
import type { EpisodeOrder, Item, Marker, UpdateItemRequest } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useToast } from '../state/toast';
import { Field, Img, Modal, Spinner } from './ui';
import { Icon } from './Icon';
import { formatClock, parseClock } from '../utils/format';
import { CONTENT_RATINGS } from '../utils/items';
import { FixMatchPanel, canFixMatch } from './FixMatch';

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
    svc.list().then((l) => setLists(l.filter((x) => !x.smart))).catch(() => setLists([]));
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
                <small>{l.childCount} item{l.childCount === 1 ? '' : 's'}</small>
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
const MARKER_TYPES: Marker['type'][] = ['intro', 'credits', 'recap', 'preview', 'commercial'];
const FIELD_LABELS: Record<string, string> = {
  title: 'Title', sortTitle: 'Sort title', originalTitle: 'Original title', tagline: 'Tagline', year: 'Year',
  communityRating: 'Rating', contentRating: 'Content rating', overview: 'Overview', genres: 'Genres', studios: 'Studios',
  releaseDate: 'Release date', people: 'Cast & crew', trailerUrl: 'Trailer', poster: 'Poster', backdrop: 'Backdrop', logo: 'Logo', thumb: 'Thumbnail',
};

function LockToggle({ locked, onToggle, label }: { locked: boolean; onToggle: () => void; label: string }) {
  return (
    // A span (not a button) so it isn't the label's labelled control: clicking the label text still focuses the input.
    <span
      role="button"
      tabIndex={0}
      className={`lock-toggle ${locked ? 'locked' : ''}`}
      onClick={(e) => { e.preventDefault(); onToggle(); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
      title={locked ? `${label} is locked — metadata refreshes won't change it. Click to unlock.` : `Lock ${label.toLowerCase()} so metadata refreshes won't change it`}
      aria-pressed={locked}
      aria-label={locked ? `Unlock ${label}` : `Lock ${label}`}
    >
      <Icon name="lock" size={12} /> {locked ? 'Locked' : 'Lock'}
    </span>
  );
}

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
  const [locked, setLocked] = useState<Set<string>>(() => new Set(item.lockedFields ?? []));
  const autoLocked = useRef(new Set<string>());
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'form' | 'match'>('form');
  const [episodeOrder, setEpisodeOrder] = useState<EpisodeOrder>(item.episodeOrder ?? 'aired');

  useEffect(() => {
    if (!open) return;
    setView('form');
    setEpisodeOrder(item.episodeOrder ?? 'aired');
    setF(init());
    setLocked(new Set(item.lockedFields ?? []));
    autoLocked.current = new Set();
    setMarkers((item.markers ?? []).map((m) => ({ type: m.type, start: formatClock(m.startMs), end: formatClock(m.endMs) })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item.id]);

  const set = (k: keyof ReturnType<typeof init>, v: string) => {
    setF((x) => ({ ...x, [k]: v }));
    // Edited fields lock automatically (once) so a refresh doesn't undo the edit; admins can unlock again.
    if (!autoLocked.current.has(k)) {
      autoLocked.current.add(k);
      setLocked((l) => (l.has(k) ? l : new Set(l).add(k)));
    }
  };
  const toggleLock = (k: string) =>
    setLocked((l) => {
      const n = new Set(l);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const label = (k: keyof ReturnType<typeof init>, text: string) => (
    <span className="field-label-row">{text} <LockToggle locked={locked.has(k)} onToggle={() => toggleLock(k)} label={text} /></span>
  );
  const formKeys = Object.keys(init());
  const otherLocked = [...locked].filter((k) => !formKeys.includes(k));
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
    if (item.type === 'show' && episodeOrder !== (item.episodeOrder ?? 'aired')) body.episodeOrder = episodeOrder;
    const lockedList = [...locked];
    const before = [...new Set(item.lockedFields ?? [])];
    // Always send when edits were made (the server otherwise auto-locks every edited field).
    if (changed.length || lockedList.length !== before.length || lockedList.some((k) => !before.includes(k))) body.lockedFields = lockedList;
    if (!Object.keys(body).length) return onClose();
    setBusy(true);
    try {
      const updated = await api.items.update(item.id, body);
      onUpdated(updated);
      toast.success(body.episodeOrder ? 'Saved — re-matching episodes in the background' : 'Metadata saved');
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  if (view === 'match') {
    return (
      <Modal open={open} onClose={onClose} title={`${item.type === 'track' ? 'Identify by sound' : 'Fix match'} — ${item.title}`} size="lg">
        <FixMatchPanel item={item} onCancel={() => setView('form')} onDone={(i) => { onUpdated(i); onClose(); }} />
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Edit ${item.title}`}
      size="lg"
      footer={
        <>
          <span className="muted small"><Icon name="lock" size={12} /> Locked fields are kept when metadata is refreshed.</span>
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? <Spinner size={18} /> : 'Save'}</button>
        </>
      }
    >
      <div className="form-grid">
        {(canFixMatch(item) || item.type === 'show') && (
          <div className="form-row">
            {item.type === 'show' ? (
              <Field label="Episode order" hint="DVD and absolute orders come from TheTVDB (enable it under Server settings → Metadata). Saving re-matches the episodes.">
                <select className="select" value={episodeOrder} onChange={(e) => setEpisodeOrder(e.target.value as EpisodeOrder)}>
                  <option value="aired">Aired order</option>
                  <option value="dvd">DVD order</option>
                  <option value="absolute">Absolute order (anime)</option>
                </select>
              </Field>
            ) : <span />}
            {canFixMatch(item) && (
              <div className="field">
                <span className="field-label">{item.type === 'track' ? 'Untagged or wrongly tagged?' : 'Wrong title or artwork?'}</span>
                <button type="button" className="btn" onClick={() => setView('match')}>{item.type === 'track' ? <><Icon name="audio" size={16} /> Identify by sound…</> : <><Icon name="search" size={16} /> Fix match…</>}</button>
              </div>
            )}
          </div>
        )}
        <div className="form-row">
          <Field label={label('title', 'Title')}><input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} /></Field>
          <Field label={label('sortTitle', 'Sort title')}><input className="input" value={f.sortTitle} onChange={(e) => set('sortTitle', e.target.value)} /></Field>
        </div>
        <div className="form-row">
          <Field label={label('originalTitle', 'Original title')}><input className="input" value={f.originalTitle} onChange={(e) => set('originalTitle', e.target.value)} /></Field>
          <Field label={label('tagline', 'Tagline')}><input className="input" value={f.tagline} onChange={(e) => set('tagline', e.target.value)} /></Field>
        </div>
        <div className="form-row form-row-3">
          <Field label={label('year', 'Year')}><input className="input" type="number" value={f.year} onChange={(e) => set('year', e.target.value)} /></Field>
          <Field label={label('communityRating', 'Rating (0–10)')}><input className="input" type="number" step="0.1" min="0" max="10" value={f.communityRating} onChange={(e) => set('communityRating', e.target.value)} /></Field>
          <Field label={label('contentRating', 'Content rating')}>
            <input className="input" list="mm-ratings" value={f.contentRating} onChange={(e) => set('contentRating', e.target.value)} />
            <datalist id="mm-ratings">{CONTENT_RATINGS.map((r) => <option key={r} value={r} />)}</datalist>
          </Field>
        </div>
        <Field label={label('overview', 'Overview')}><textarea className="textarea" rows={5} value={f.overview} onChange={(e) => set('overview', e.target.value)} /></Field>
        <div className="form-row">
          <Field label={label('genres', 'Genres')} hint="Comma separated"><input className="input" value={f.genres} onChange={(e) => set('genres', e.target.value)} /></Field>
          <Field label={label('studios', 'Studios')} hint="Comma separated"><input className="input" value={f.studios} onChange={(e) => set('studios', e.target.value)} /></Field>
        </div>
        {otherLocked.length > 0 && (
          <div className="field">
            <span className="field-label">Other locked fields</span>
            <div className="badge-row">
              {otherLocked.map((k) => (
                <button key={k} type="button" className="lock-toggle locked" onClick={() => toggleLock(k)} title="Click to unlock">
                  <Icon name="lock" size={12} /> {FIELD_LABELS[k] ?? k} <Icon name="x" size={12} />
                </button>
              ))}
            </div>
          </div>
        )}
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
