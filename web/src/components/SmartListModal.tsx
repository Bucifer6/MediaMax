import { useEffect, useMemo, useState } from 'react';
import type { Item, ItemSort, Paged, SmartFilter, SmartRule, SmartRuleField, SmartRuleOp } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useAsync, useDebounced } from '../hooks';
import { PosterCard, CardSkeleton } from './Cards';
import { Field, Modal, Spinner } from './ui';
import { Icon } from './Icon';

type ValueKind = 'genre' | 'text' | 'number' | 'bool' | 'library' | 'type' | 'resolution';

interface FieldDef {
  label: string;
  ops: SmartRuleOp[];
  kind: ValueKind;
  /** Unit shown after a number input. */
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}

export const SMART_FIELDS: Record<SmartRuleField, FieldDef> = {
  genre: { label: 'Genre', ops: ['is', 'isNot', 'contains'], kind: 'genre' },
  year: { label: 'Year', ops: ['is', 'isNot', 'gte', 'lte', 'between'], kind: 'number', min: 1880, max: 2100 },
  rating: { label: 'Rating', ops: ['gte', 'lte', 'between', 'is'], kind: 'number', min: 0, max: 10, step: 0.1, unit: '/ 10' },
  contentRating: { label: 'Content rating', ops: ['is', 'isNot'], kind: 'text', placeholder: 'PG-13' },
  addedDays: { label: 'Date added', ops: ['lte', 'gte'], kind: 'number', min: 0, unit: 'days' },
  played: { label: 'Watched', ops: ['is'], kind: 'bool' },
  favorite: { label: 'Favourite', ops: ['is'], kind: 'bool' },
  inProgress: { label: 'In progress', ops: ['is'], kind: 'bool' },
  person: { label: 'Person', ops: ['contains', 'isNot'], kind: 'text', placeholder: 'Actor, director…' },
  studio: { label: 'Studio', ops: ['is', 'isNot', 'contains'], kind: 'text', placeholder: 'Studio or network' },
  library: { label: 'Library', ops: ['is', 'isNot'], kind: 'library' },
  type: { label: 'Type', ops: ['is', 'isNot'], kind: 'type' },
  durationMin: { label: 'Duration', ops: ['gte', 'lte', 'between'], kind: 'number', min: 0, unit: 'min' },
  title: { label: 'Title', ops: ['contains', 'is', 'isNot'], kind: 'text', placeholder: 'Text' },
  resolution: { label: 'Resolution', ops: ['is', 'isNot'], kind: 'resolution' },
};

const FIELD_ORDER: SmartRuleField[] = ['genre', 'year', 'rating', 'addedDays', 'played', 'favorite', 'inProgress', 'person', 'studio', 'contentRating', 'library', 'type', 'durationMin', 'resolution', 'title'];

const OP_LABEL: Record<SmartRuleOp, string> = { is: 'is', isNot: 'is not', contains: 'contains', gte: 'is at least', lte: 'is at most', between: 'is between' };

export function opLabel(field: SmartRuleField, op: SmartRuleOp): string {
  if (field === 'addedDays') return op === 'lte' ? 'within the last' : op === 'gte' ? 'more than' : OP_LABEL[op];
  if (field === 'resolution') return op === 'is' ? 'is at least' : 'is below';
  return OP_LABEL[op];
}

const TYPES: { value: string; label: string }[] = [
  { value: 'movie', label: 'Movie' },
  { value: 'show', label: 'TV show' },
  { value: 'season', label: 'Season' },
  { value: 'episode', label: 'Episode' },
  { value: 'video', label: 'Video' },
  { value: 'artist', label: 'Artist' },
  { value: 'album', label: 'Album' },
  { value: 'track', label: 'Song' },
  { value: 'audiobook', label: 'Audiobook' },
  { value: 'podcast', label: 'Podcast' },
  { value: 'podcastepisode', label: 'Podcast episode' },
  { value: 'photo', label: 'Photo' },
];
const RESOLUTIONS = ['4K', '1080p', '720p', '480p', 'SD'];
const SORTS: { value: ItemSort; label: string }[] = [
  { value: 'addedAt', label: 'Date added' },
  { value: 'title', label: 'Title' },
  { value: 'year', label: 'Year' },
  { value: 'releaseDate', label: 'Release date' },
  { value: 'rating', label: 'Rating' },
  { value: 'lastPlayed', label: 'Last played' },
  { value: 'random', label: 'Random' },
];

function defaultValue(field: SmartRuleField, op: SmartRuleOp, genres: string[], libraryId?: string): SmartRule['value'] {
  const def = SMART_FIELDS[field];
  if (op === 'between') return field === 'year' ? [2000, new Date().getFullYear()] : field === 'rating' ? [7, 10] : [60, 120];
  switch (def.kind) {
    case 'bool': return true;
    case 'genre': return op === 'contains' ? '' : genres[0] ?? '';
    case 'library': return libraryId ?? '';
    case 'type': return 'movie';
    case 'resolution': return '1080p';
    case 'number': return field === 'addedDays' ? 30 : field === 'year' ? new Date().getFullYear() : field === 'rating' ? 7 : field === 'durationMin' ? 90 : 0;
    default: return '';
  }
}

/** Is the rule complete enough to send to the server? */
function ruleValid(r: SmartRule): boolean {
  const def = SMART_FIELDS[r.field];
  if (!def || !def.ops.includes(r.op)) return false;
  if (r.op === 'between') return Array.isArray(r.value) && r.value.every((n) => Number.isFinite(n));
  if (def.kind === 'number') return typeof r.value === 'number' && Number.isFinite(r.value);
  if (def.kind === 'bool') return typeof r.value === 'boolean';
  return typeof r.value === 'string' && r.value.trim() !== '';
}

const numOrNaN = (s: string) => (s.trim() === '' ? NaN : Number(s));

function RuleValue({ rule, onChange, genres }: { rule: SmartRule; onChange: (v: SmartRule['value']) => void; genres: string[] }) {
  const { libraries } = useApp();
  const def = SMART_FIELDS[rule.field];
  const aria = `${def.label} value`;
  if (rule.op === 'between') {
    const [a, b] = Array.isArray(rule.value) ? rule.value : [NaN, NaN];
    const show = (n: number) => (Number.isFinite(n) ? String(n) : '');
    return (
      <span className="smart-range">
        <input className="input input-sm" type="number" min={def.min} max={def.max} step={def.step} value={show(a)} onChange={(e) => onChange([numOrNaN(e.target.value), b])} aria-label={`${def.label} from`} />
        <span className="muted">and</span>
        <input className="input input-sm" type="number" min={def.min} max={def.max} step={def.step} value={show(b)} onChange={(e) => onChange([a, numOrNaN(e.target.value)])} aria-label={`${def.label} to`} />
        {def.unit && <span className="muted smart-unit">{def.unit}</span>}
      </span>
    );
  }
  switch (def.kind) {
    case 'bool':
      return (
        <select className="select input-sm" value={rule.value === false ? 'no' : 'yes'} onChange={(e) => onChange(e.target.value === 'yes')} aria-label={aria}>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      );
    case 'genre':
      if (rule.op !== 'contains' && genres.length) {
        const v = String(rule.value ?? '');
        return (
          <select className="select input-sm" value={v} onChange={(e) => onChange(e.target.value)} aria-label={aria}>
            {!genres.includes(v) && <option value={v}>{v || 'Choose a genre…'}</option>}
            {genres.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        );
      }
      return <input className="input input-sm" value={String(rule.value ?? '')} onChange={(e) => onChange(e.target.value)} placeholder="Genre" aria-label={aria} />;
    case 'library':
      return (
        <select className="select input-sm" value={String(rule.value ?? '')} onChange={(e) => onChange(e.target.value)} aria-label={aria}>
          <option value="">Choose a library…</option>
          {libraries.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      );
    case 'type':
      return (
        <select className="select input-sm" value={String(rule.value ?? 'movie')} onChange={(e) => onChange(e.target.value)} aria-label={aria}>
          {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      );
    case 'resolution':
      return (
        <select className="select input-sm" value={String(rule.value ?? '1080p')} onChange={(e) => onChange(e.target.value)} aria-label={aria}>
          {RESOLUTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      );
    case 'number':
      return (
        <span className="smart-range">
          <input
            className="input input-sm"
            type="number"
            min={def.min}
            max={def.max}
            step={def.step}
            value={typeof rule.value === 'number' && Number.isFinite(rule.value) ? String(rule.value) : ''}
            onChange={(e) => onChange(numOrNaN(e.target.value))}
            aria-label={aria}
          />
          {def.unit && <span className="muted smart-unit">{rule.field === 'addedDays' && rule.op === 'gte' ? 'days ago' : def.unit}</span>}
        </span>
      );
    default:
      return <input className="input input-sm" value={String(rule.value ?? '')} onChange={(e) => onChange(e.target.value)} placeholder={def.placeholder} aria-label={aria} />;
  }
}

const EMPTY_FILTER: SmartFilter = { match: 'all', rules: [], sort: 'addedAt', order: 'desc', limit: null };

/**
 * Rule builder for smart collections / playlists. Creates (POST /smart) or, with `item`, edits (PUT /smart/:id).
 */
export function SmartListModal({
  open, onClose, kind, item, onSaved,
}: { open: boolean; onClose: () => void; kind: 'collection' | 'playlist'; item?: Item | null; onSaved: (item: Item) => void }) {
  const toast = useToast();
  const genres = useAsync(async () => (open ? api.items.genres().catch(() => [] as string[]) : ([] as string[])), [open]);
  const genreList = genres.data ?? [];
  const [title, setTitle] = useState('');
  const [overview, setOverview] = useState('');
  const [filter, setFilter] = useState<SmartFilter>(EMPTY_FILTER);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<Paged<Item> | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(item?.title ?? '');
    setOverview(item?.overview ?? '');
    setFilter(item?.smart ? { ...EMPTY_FILTER, ...item.smart, rules: item.smart.rules.map((r) => ({ ...r })) } : { ...EMPTY_FILTER, rules: [{ field: 'addedDays', op: 'lte', value: 30 }] });
    setPreview(null);
    setPreviewError(null);
  }, [open, item]);

  const validRules = filter.rules.filter(ruleValid);
  const incomplete = filter.rules.length - validRules.length;
  const sendable: SmartFilter = useMemo(() => ({ ...filter, rules: validRules }), [JSON.stringify(filter)]); // eslint-disable-line react-hooks/exhaustive-deps
  const debouncedKey = useDebounced(open ? JSON.stringify(sendable) : '', 450);

  useEffect(() => {
    if (!open || !debouncedKey) return;
    const f = JSON.parse(debouncedKey) as SmartFilter;
    if (!f.rules.length) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    api.smart
      .preview(f, 24)
      .then((p) => { if (!cancelled) { setPreview(p); setPreviewError(null); } })
      .catch((e) => { if (!cancelled) setPreviewError(errorMessage(e)); })
      .finally(() => { if (!cancelled) setPreviewLoading(false); });
    return () => { cancelled = true; };
  }, [debouncedKey, open]);

  const setRule = (i: number, r: Partial<SmartRule>) => setFilter((f) => ({ ...f, rules: f.rules.map((x, j) => (j === i ? { ...x, ...r } : x)) }));
  const changeField = (i: number, field: SmartRuleField) => {
    const op = SMART_FIELDS[field].ops[0];
    setRule(i, { field, op, value: defaultValue(field, op, genreList) });
  };
  const changeOp = (i: number, op: SmartRuleOp) => {
    const r = filter.rules[i];
    const wasRange = r.op === 'between';
    const isRange = op === 'between';
    const kindChanged = SMART_FIELDS[r.field].kind === 'genre' && (r.op === 'contains') !== (op === 'contains');
    setRule(i, { op, value: wasRange !== isRange || kindChanged ? defaultValue(r.field, op, genreList) : r.value });
  };
  const addRule = () => setFilter((f) => ({ ...f, rules: [...f.rules, { field: 'genre', op: 'is', value: defaultValue('genre', 'is', genreList) }] }));
  const removeRule = (i: number) => setFilter((f) => ({ ...f, rules: f.rules.filter((_, j) => j !== i) }));

  const canSave = title.trim() !== '' && validRules.length > 0 && incomplete === 0 && !saving;
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const saved = item
        ? await api.smart.update(item.id, { title: title.trim(), overview: overview.trim(), filter: sendable })
        : await api.smart.create({ kind, title: title.trim(), overview: overview.trim() || undefined, filter: sendable });
      toast.success(item ? 'Rules updated' : `Smart ${kind} created`);
      onSaved(saved);
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };

  const noun = kind === 'collection' ? 'collection' : 'playlist';
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      className="smart-modal"
      title={item ? `Edit rules — ${item.title}` : `New smart ${noun}`}
      footer={
        <>
          {incomplete > 0 && <span className="form-error smart-foot-msg">{incomplete} rule{incomplete > 1 ? 's need' : ' needs'} a value</span>}
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={!canSave}>
            {saving ? <Spinner size={16} /> : <Icon name="check" size={16} />} {item ? 'Save rules' : `Create smart ${noun}`}
          </button>
        </>
      }
    >
      <div className="smart-layout">
        <div className="form-grid smart-form">
          <div className="form-row">
            <Field label="Title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === 'collection' ? 'Recently added 4K' : 'Unwatched comedies'} autoFocus /></Field>
            <Field label="Description"><input className="input" value={overview} onChange={(e) => setOverview(e.target.value)} placeholder="Optional" /></Field>
          </div>

          <div className="smart-match">
            <span>Include items that match</span>
            <select className="select input-sm" value={filter.match} onChange={(e) => setFilter({ ...filter, match: e.target.value as SmartFilter['match'] })} aria-label="Match">
              <option value="all">all</option>
              <option value="any">any</option>
            </select>
            <span>of these rules:</span>
          </div>

          <ul className="smart-rules">
            {filter.rules.map((r, i) => (
              <li key={i} className={`smart-rule ${ruleValid(r) ? '' : 'invalid'}`}>
                <select className="select input-sm" value={r.field} onChange={(e) => changeField(i, e.target.value as SmartRuleField)} aria-label="Field">
                  {FIELD_ORDER.map((f) => <option key={f} value={f}>{SMART_FIELDS[f].label}</option>)}
                </select>
                <select className="select input-sm" value={r.op} onChange={(e) => changeOp(i, e.target.value as SmartRuleOp)} aria-label="Operator" disabled={SMART_FIELDS[r.field].ops.length < 2}>
                  {SMART_FIELDS[r.field].ops.map((op) => <option key={op} value={op}>{opLabel(r.field, op)}</option>)}
                </select>
                <div className="smart-value">
                  <RuleValue rule={r} genres={genreList} onChange={(value) => setRule(i, { value })} />
                </div>
                <button className="btn-icon" onClick={() => removeRule(i)} aria-label="Remove rule" title="Remove rule"><Icon name="trash" size={16} /></button>
              </li>
            ))}
          </ul>
          <div>
            <button className="btn btn-sm" onClick={addRule} disabled={filter.rules.length >= 25}><Icon name="plus" size={14} /> Add rule</button>
          </div>

          <div className="form-row form-row-3">
            <Field label="Sort by">
              <select className="select" value={filter.sort} onChange={(e) => setFilter({ ...filter, sort: e.target.value as ItemSort })}>
                {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </Field>
            <Field label="Order">
              <select className="select" value={filter.order} onChange={(e) => setFilter({ ...filter, order: e.target.value as SmartFilter['order'] })} disabled={filter.sort === 'random'}>
                <option value="desc">Descending</option>
                <option value="asc">Ascending</option>
              </select>
            </Field>
            <Field label="Limit" hint="Empty = no limit">
              <input className="input" type="number" min={1} max={1000} value={filter.limit ?? ''} onChange={(e) => setFilter({ ...filter, limit: e.target.value ? Math.max(1, Math.min(1000, Math.round(Number(e.target.value)) || 1)) : null })} placeholder="No limit" />
            </Field>
          </div>
        </div>

        <section className="smart-preview" aria-live="polite">
          <h3 className="smart-preview-head">
            Preview
            {preview && <span className="muted">{filter.limit ? Math.min(filter.limit, preview.total) : preview.total} item{preview.total === 1 ? '' : 's'}</span>}
            {previewLoading && <Spinner size={16} />}
          </h3>
          {!validRules.length ? (
            <p className="muted">Add a rule to see what matches.</p>
          ) : previewError ? (
            <p className="form-error">{previewError}</p>
          ) : !preview ? (
            <div className="grid smart-preview-grid">{Array.from({ length: 6 }).map((_, i) => <CardSkeleton key={i} />)}</div>
          ) : !preview.items.length ? (
            <p className="muted">Nothing matches these rules yet.</p>
          ) : (
            <div className={`grid smart-preview-grid ${previewLoading ? 'dim' : ''}`}>
              {preview.items.map((it) => <PosterCard key={it.id} item={it} width="100%" shape="poster" showProgress={false} />)}
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
