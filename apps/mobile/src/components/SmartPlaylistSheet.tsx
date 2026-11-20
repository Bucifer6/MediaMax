/**
 * Simple rule builder for smart playlists: match all/any, rule rows (field,
 * operator, value), sort and limit, with a live preview from POST /smart/preview.
 * Saves with POST /smart (kind "playlist"), or PUT /smart/:id when editing.
 * Every control is a Focusable / Input so it works with the TV remote too.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, View } from 'react-native';
import type { Item, ItemSort, SmartFilter, SmartRule, SmartRuleField, SmartRuleOp } from '@/api/types';
import { invalidate } from '@/api/useQuery';
import { useApi } from '@/state/session';
import { useTheme } from '@/theme';
import { Button } from './Button';
import { Chip } from './Chip';
import { Focusable } from './Focusable';
import { Icon, type IconName } from './Icon';
import { Input } from './Input';
import { MediaCard } from './MediaCard';
import { OptionSheet } from './OptionSheet';
import { Sheet } from './Sheet';
import { T } from './Text';

type ValueKind = 'text' | 'number' | 'bool' | 'choice' | 'genre';

interface FieldDef {
  label: string;
  icon: IconName;
  ops: { op: SmartRuleOp; label: string }[];
  kind: ValueKind;
  /** For choice/bool fields: [value, label]. */
  choices?: [string | boolean, string][];
  defaultValue: SmartRule['value'];
  unit?: string;
  step?: number;
  min?: number;
  max?: number;
}

const THIS_YEAR = new Date().getFullYear();

const FIELDS: Partial<Record<SmartRuleField, FieldDef>> = {
  genre: { label: 'Genre', icon: 'pricetag-outline', ops: [{ op: 'is', label: 'is' }, { op: 'isNot', label: 'is not' }, { op: 'contains', label: 'contains' }], kind: 'genre', defaultValue: '' },
  year: { label: 'Year', icon: 'calendar-outline', ops: [{ op: 'is', label: 'is' }, { op: 'gte', label: 'from' }, { op: 'lte', label: 'up to' }, { op: 'between', label: 'between' }], kind: 'number', defaultValue: THIS_YEAR, step: 1, min: 1880, max: THIS_YEAR + 2 },
  rating: { label: 'Rating', icon: 'star-outline', ops: [{ op: 'gte', label: 'at least' }, { op: 'lte', label: 'at most' }, { op: 'between', label: 'between' }], kind: 'number', defaultValue: 7, step: 0.5, min: 0, max: 10 },
  addedDays: { label: 'Added', icon: 'time-outline', ops: [{ op: 'lte', label: 'within the last' }, { op: 'gte', label: 'more than' }], kind: 'number', defaultValue: 30, unit: 'days', step: 1, min: 0, max: 36500 },
  played: { label: 'Played', icon: 'checkmark-done-outline', ops: [{ op: 'is', label: 'is' }], kind: 'bool', choices: [[true, 'Played'], [false, 'Not played']], defaultValue: false },
  favorite: { label: 'Favourite', icon: 'heart-outline', ops: [{ op: 'is', label: 'is' }], kind: 'bool', choices: [[true, 'Favourite'], [false, 'Not favourite']], defaultValue: true },
  type: {
    label: 'Type',
    icon: 'albums-outline',
    ops: [{ op: 'is', label: 'is' }, { op: 'isNot', label: 'is not' }],
    kind: 'choice',
    choices: [['movie', 'Movie'], ['show', 'Show'], ['episode', 'Episode'], ['video', 'Video'], ['album', 'Album'], ['track', 'Song'], ['audiobook', 'Audiobook'], ['podcast', 'Podcast']],
    defaultValue: 'movie',
  },
  person: { label: 'Person', icon: 'person-outline', ops: [{ op: 'contains', label: 'includes' }, { op: 'isNot', label: 'excludes' }], kind: 'text', defaultValue: '' },
  resolution: {
    label: 'Resolution',
    icon: 'tv-outline',
    ops: [{ op: 'is', label: 'at least' }, { op: 'isNot', label: 'below' }],
    kind: 'choice',
    choices: [['4K', '4K'], ['1080p', '1080p'], ['720p', '720p'], ['480p', '480p'], ['SD', 'SD']],
    defaultValue: '1080p',
  },
};
const FIELD_ORDER: SmartRuleField[] = ['genre', 'year', 'rating', 'addedDays', 'played', 'favorite', 'type', 'person', 'resolution'];

const SORTS: { key: string; label: string; sort: ItemSort; order: 'asc' | 'desc' }[] = [
  { key: 'addedAt', label: 'Recently added', sort: 'addedAt', order: 'desc' },
  { key: 'title', label: 'Title', sort: 'title', order: 'asc' },
  { key: 'year', label: 'Newest', sort: 'year', order: 'desc' },
  { key: 'rating', label: 'Top rated', sort: 'rating', order: 'desc' },
  { key: 'lastPlayed', label: 'Last played', sort: 'lastPlayed', order: 'desc' },
  { key: 'random', label: 'Random', sort: 'random', order: 'asc' },
];
const LIMITS: (number | null)[] = [null, 25, 50, 100, 250];

function newRule(field: SmartRuleField, op?: SmartRuleOp): SmartRule {
  const def = FIELDS[field]!;
  const useOp = op && def.ops.some((o) => o.op === op) ? op : def.ops[0].op;
  let value = def.defaultValue;
  if (useOp === 'between' && typeof value === 'number') value = field === 'year' ? [2000, THIS_YEAR] : [value, def.max ?? value];
  return { field, op: useOp, value };
}

/** Rules the server can evaluate (text values filled in). */
function ruleIsComplete(r: SmartRule): boolean {
  if (typeof r.value === 'string') return r.value.trim().length > 0;
  if (Array.isArray(r.value)) return r.value.every((n) => Number.isFinite(n));
  if (typeof r.value === 'number') return Number.isFinite(r.value);
  return true;
}

const DEFAULT_FILTER: SmartFilter = { match: 'all', rules: [newRule('genre')], sort: 'addedAt', order: 'desc', limit: null };

type Picker = { kind: 'field' | 'op' | 'genre'; index: number } | null;

export function SmartPlaylistSheet({ visible, onClose, onSaved, existing }: { visible: boolean; onClose: () => void; onSaved?: (item: Item) => void; /** Edit this smart playlist instead of creating one. */ existing?: Item | null }) {
  const t = useTheme();
  const api = useApi();
  const [title, setTitle] = useState('');
  const [filter, setFilter] = useState<SmartFilter>(DEFAULT_FILTER);
  const [picker, setPicker] = useState<Picker>(null);
  const [genres, setGenres] = useState<string[] | null>(null);
  const [preview, setPreview] = useState<{ total: number; items: Item[] } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Reset when opened.
  useEffect(() => {
    if (!visible) return;
    setTitle(existing?.title ?? '');
    setFilter(existing?.smart ? { ...existing.smart, rules: existing.smart.rules.length ? existing.smart.rules : [newRule('genre')] } : DEFAULT_FILTER);
    setPreview(null);
    setPreviewError(null);
    setSaveError(null);
    setPicker(null);
  }, [visible, existing]);

  // Genre names for the genre picker.
  useEffect(() => {
    if (!visible || genres) return;
    api
      .genres()
      .then((g) => setGenres([...new Set(g)].sort((a, b) => a.localeCompare(b))))
      .catch(() => setGenres([]));
  }, [visible, genres, api]);

  const complete = useMemo(() => ({ ...filter, rules: filter.rules.filter(ruleIsComplete) }), [filter]);
  const incomplete = filter.rules.length - complete.rules.length;
  const filterKey = JSON.stringify(complete);

  // Live preview, debounced.
  useEffect(() => {
    if (!visible) return;
    if (!complete.rules.length) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      setPreviewing(true);
      api
        .smartPreview(complete, 12)
        .then((r) => {
          if (!alive) return;
          setPreview({ total: complete.limit ? Math.min(r.total, complete.limit) : r.total, items: r.items });
          setPreviewError(null);
        })
        .catch((e) => alive && setPreviewError(e instanceof Error ? e.message : 'Preview failed'))
        .finally(() => alive && setPreviewing(false));
    }, 500);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, filterKey, api]);

  const setRule = (i: number, rule: SmartRule) => setFilter((f) => ({ ...f, rules: f.rules.map((r, j) => (j === i ? rule : r)) }));
  const removeRule = (i: number) => setFilter((f) => ({ ...f, rules: f.rules.filter((_, j) => j !== i) }));
  const addRule = () => {
    const used = new Set(filter.rules.map((r) => r.field));
    const next = FIELD_ORDER.find((f) => !used.has(f)) ?? 'genre';
    setFilter((f) => ({ ...f, rules: [...f.rules, newRule(next)] }));
  };

  const save = async () => {
    const name = title.trim();
    if (!name) return setSaveError('Give the playlist a name.');
    if (!complete.rules.length) return setSaveError('Add at least one complete rule.');
    if (incomplete) return setSaveError('Fill in or remove the empty rules first.');
    setSaving(true);
    setSaveError(null);
    try {
      const item = existing ? await api.updateSmartList(existing.id, { title: name, filter: complete }) : await api.createSmartList({ kind: 'playlist', title: name, filter: complete });
      invalidate('playlists');
      invalidate('home');
      if (existing) {
        invalidate(`item:${existing.id}`);
        invalidate(`children:${existing.id}`);
      }
      onSaved?.(item);
      onClose();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not save the playlist');
    } finally {
      setSaving(false);
    }
  };

  // ----- picker sheet -----
  const pickRule = picker ? filter.rules[picker.index] : null;
  const pickerOptions =
    picker?.kind === 'field'
      ? FIELD_ORDER.map((f) => ({ key: f as string, label: FIELDS[f]!.label, icon: FIELDS[f]!.icon, selected: pickRule?.field === f }))
      : picker?.kind === 'op' && pickRule
        ? FIELDS[pickRule.field]!.ops.map((o) => ({ key: o.op as string, label: o.label, selected: pickRule.op === o.op }))
        : picker?.kind === 'genre'
          ? (genres ?? []).map((g) => ({ key: g, label: g, selected: pickRule?.value === g }))
          : [];
  const onPick = (key: string) => {
    const p = picker;
    setPicker(null);
    if (!p) return;
    const rule = filter.rules[p.index];
    if (!rule) return;
    if (p.kind === 'field') {
      if (key !== rule.field) setRule(p.index, newRule(key as SmartRuleField));
    } else if (p.kind === 'op') {
      const op = key as SmartRuleOp;
      const def = FIELDS[rule.field]!;
      let value = rule.value;
      if (op === 'between' && !Array.isArray(value)) value = newRule(rule.field, 'between').value;
      if (op !== 'between' && Array.isArray(value)) value = value[0];
      if (def.kind === 'number' && typeof value !== 'number' && !Array.isArray(value)) value = def.defaultValue;
      setRule(p.index, { ...rule, op, value });
    } else {
      setRule(p.index, { ...rule, value: key });
    }
  };

  const sortKey = SORTS.find((s) => s.sort === filter.sort && (s.sort === 'random' || s.order === filter.order))?.key ?? SORTS.find((s) => s.sort === filter.sort)?.key;

  return (
    <Sheet visible={visible} title={existing ? 'Edit smart playlist' : 'New smart playlist'} subtitle="Updates itself as your library changes" onClose={onClose} width={760}>
      <Input label="Name" value={title} onChangeText={setTitle} placeholder="e.g. Recent sci-fi" maxLength={120} returnKeyType="done" hasTVPreferredFocus />

      <View style={{ gap: t.space.sm }}>
        <T variant="caption" tone="muted" style={{ textTransform: 'uppercase' }}>
          Match
        </T>
        <View style={{ flexDirection: 'row', gap: t.space.sm, flexWrap: 'wrap' }}>
          <Chip label="All rules" selected={filter.match === 'all'} onPress={() => setFilter((f) => ({ ...f, match: 'all' }))} />
          <Chip label="Any rule" selected={filter.match === 'any'} onPress={() => setFilter((f) => ({ ...f, match: 'any' }))} />
        </View>
      </View>

      <View style={{ gap: t.space.sm }}>
        {filter.rules.map((rule, i) => (
          <RuleRow
            key={i}
            rule={rule}
            canRemove={filter.rules.length > 1}
            hasGenres={!!genres?.length}
            onChange={(r) => setRule(i, r)}
            onRemove={() => removeRule(i)}
            onPickField={() => setPicker({ kind: 'field', index: i })}
            onPickOp={() => setPicker({ kind: 'op', index: i })}
            onPickGenre={() => setPicker({ kind: 'genre', index: i })}
          />
        ))}
        {filter.rules.length < 25 ? <Button label="Add rule" icon="add" size="sm" variant="secondary" onPress={addRule} /> : null}
      </View>

      <View style={{ gap: t.space.sm }}>
        <T variant="caption" tone="muted" style={{ textTransform: 'uppercase' }}>
          Sort
        </T>
        <View style={{ flexDirection: 'row', gap: t.space.sm, flexWrap: 'wrap' }}>
          {SORTS.map((s) => (
            <Chip key={s.key} label={s.label} selected={sortKey === s.key} onPress={() => setFilter((f) => ({ ...f, sort: s.sort, order: s.order }))} />
          ))}
        </View>
        <T variant="caption" tone="muted" style={{ textTransform: 'uppercase' }}>
          Limit
        </T>
        <View style={{ flexDirection: 'row', gap: t.space.sm, flexWrap: 'wrap' }}>
          {LIMITS.map((l) => (
            <Chip key={String(l)} label={l ? `${l} items` : 'No limit'} selected={filter.limit === l} onPress={() => setFilter((f) => ({ ...f, limit: l }))} />
          ))}
        </View>
      </View>

      {/* Preview */}
      <View style={{ gap: t.space.sm, padding: t.space.md, borderRadius: t.radius, backgroundColor: t.alpha(t.colors.text, t.dark ? 0.05 : 0.04) }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
          <Icon name="eye-outline" color={t.colors.primary} size={t.isTV ? t.s(22) : 18} />
          <T weight="700" style={{ flex: 1 }}>
            {!complete.rules.length ? 'Preview' : preview ? `${preview.total.toLocaleString()} ${preview.total === 1 ? 'match' : 'matches'}` : 'Preview'}
          </T>
          {previewing ? <ActivityIndicator color={t.colors.primary} /> : null}
        </View>
        {previewError ? (
          <T variant="small" tone="danger">
            {previewError}
          </T>
        ) : !complete.rules.length ? (
          <T variant="small" tone="muted">
            Fill in a rule to see what matches.
          </T>
        ) : preview && !preview.items.length ? (
          <T variant="small" tone="muted">
            Nothing in your libraries matches these rules yet.
          </T>
        ) : null}
        {incomplete && complete.rules.length ? (
          <T variant="small" tone="warning">
            {incomplete === 1 ? 'One rule is' : `${incomplete} rules are`} empty and not included.
          </T>
        ) : null}
        {preview?.items.length && !previewError ? (
          <FlatList
            horizontal
            data={preview.items}
            keyExtractor={(x) => x.id}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: t.space.sm, paddingVertical: t.isTV ? t.s(8) : 0 }}
            renderItem={({ item }) => <MediaCard item={item} variant="poster" width={t.isTV ? t.s(90) : 78} onPress={() => undefined} showProgress={false} />}
          />
        ) : null}
      </View>

      {saveError ? (
        <T tone="danger" weight="600">
          {saveError}
        </T>
      ) : null}
      <View style={{ flexDirection: 'row', gap: t.space.sm, flexWrap: 'wrap' }}>
        <Button label={existing ? 'Save changes' : 'Create playlist'} icon="sparkles-outline" onPress={() => void save()} loading={saving} disabled={saving || !title.trim() || !complete.rules.length} />
        <Button label="Cancel" variant="secondary" onPress={onClose} />
      </View>

      <OptionSheet
        visible={!!picker}
        title={picker?.kind === 'field' ? 'Rule' : picker?.kind === 'op' ? 'Condition' : 'Genre'}
        options={pickerOptions}
        onSelect={onPick}
        onClose={() => setPicker(null)}
      />
    </Sheet>
  );
}

function RuleRow({
  rule,
  canRemove,
  hasGenres,
  onChange,
  onRemove,
  onPickField,
  onPickOp,
  onPickGenre,
}: {
  rule: SmartRule;
  canRemove: boolean;
  hasGenres: boolean;
  onChange: (r: SmartRule) => void;
  onRemove: () => void;
  onPickField: () => void;
  onPickOp: () => void;
  onPickGenre: () => void;
}) {
  const t = useTheme();
  const def = FIELDS[rule.field];
  if (!def) {
    // A field this builder doesn't offer (e.g. made on the web): show it read-only.
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, padding: t.space.sm, borderRadius: t.radius, backgroundColor: t.colors.surfaceAlt }}>
        <T variant="small" tone="muted" style={{ flex: 1 }}>
          {rule.field} {rule.op} {Array.isArray(rule.value) ? rule.value.join('–') : String(rule.value)}
        </T>
        {canRemove ? <Button icon="trash-outline" size="sm" variant="ghost" onPress={onRemove} accessibilityLabel="Remove rule" /> : null}
      </View>
    );
  }
  const opLabel = def.ops.find((o) => o.op === rule.op)?.label ?? rule.op;
  return (
    <View style={{ gap: t.space.sm, padding: t.space.sm, borderRadius: t.radius, backgroundColor: t.colors.surfaceAlt }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, flexWrap: 'wrap' }}>
        <PickerChip icon={def.icon} label={def.label} onPress={onPickField} />
        {def.ops.length > 1 ? <PickerChip label={opLabel} onPress={onPickOp} /> : null}
        <View style={{ flex: 1 }} />
        {canRemove ? <Button icon="trash-outline" size="sm" variant="ghost" onPress={onRemove} accessibilityLabel={`Remove ${def.label} rule`} /> : null}
      </View>
      <RuleValue rule={rule} def={def} hasGenres={hasGenres} onChange={onChange} onPickGenre={onPickGenre} />
    </View>
  );
}

function PickerChip({ label, icon, onPress }: { label: string; icon?: IconName; onPress: () => void }) {
  const t = useTheme();
  return (
    <Focusable
      onPress={onPress}
      ringRadius={999}
      focusScale={t.isTV ? 1.06 : 1}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: t.isTV ? t.s(8) : 7, paddingHorizontal: t.isTV ? t.s(14) : 12, borderRadius: 999, borderWidth: 1, borderColor: t.colors.border, backgroundColor: t.colors.surface }}
    >
      {icon ? <Icon name={icon} size={t.isTV ? t.s(18) : 15} color={t.colors.primary} /> : null}
      <T variant="small" weight="700">
        {label}
      </T>
      <Icon name="chevron-down" size={t.isTV ? t.s(16) : 13} color={t.colors.textMuted} />
    </Focusable>
  );
}

function RuleValue({ rule, def, hasGenres, onChange, onPickGenre }: { rule: SmartRule; def: FieldDef; hasGenres: boolean; onChange: (r: SmartRule) => void; onPickGenre: () => void }) {
  const t = useTheme();
  const set = (value: SmartRule['value']) => onChange({ ...rule, value });

  if (def.kind === 'bool' || def.kind === 'choice') {
    return (
      <View style={{ flexDirection: 'row', gap: t.space.xs, flexWrap: 'wrap' }}>
        {def.choices!.map(([v, label]) => (
          <Chip key={String(v)} label={label} selected={rule.value === v || (typeof v === 'string' && typeof rule.value === 'string' && v.toLowerCase() === rule.value.toLowerCase())} onPress={() => set(v)} />
        ))}
      </View>
    );
  }
  if (def.kind === 'genre' && hasGenres && rule.op !== 'contains') {
    return <PickerChip icon="pricetag-outline" label={typeof rule.value === 'string' && rule.value ? rule.value : 'Choose a genre'} onPress={onPickGenre} />;
  }
  if (def.kind === 'text' || def.kind === 'genre') {
    return (
      <Input
        value={typeof rule.value === 'string' ? rule.value : String(rule.value ?? '')}
        onChangeText={(v) => set(v)}
        placeholder={def.kind === 'genre' ? 'Genre name' : 'Actor, director, …'}
        autoCorrect={false}
        maxLength={200}
        returnKeyType="done"
      />
    );
  }
  // number / between
  if (rule.op === 'between') {
    const [a, b] = Array.isArray(rule.value) ? rule.value : [Number(rule.value) || 0, Number(rule.value) || 0];
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, flexWrap: 'wrap' }}>
        <NumberField value={a} def={def} onChange={(n) => set([n, b])} />
        <T tone="muted">and</T>
        <NumberField value={b} def={def} onChange={(n) => set([a, n])} />
      </View>
    );
  }
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
      <NumberField value={typeof rule.value === 'number' ? rule.value : Number(rule.value) || 0} def={def} onChange={(n) => set(n)} />
      {def.unit ? (
        <T tone="muted">
          {def.unit}
          {rule.field === 'addedDays' && rule.op === 'gte' ? ' ago' : ''}
        </T>
      ) : null}
    </View>
  );
}

/** − [value] + : steppers for the D-pad, typing for phones. */
function NumberField({ value, def, onChange }: { value: number; def: FieldDef; onChange: (n: number) => void }) {
  const t = useTheme();
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const step = def.step ?? 1;
  const clamp = (n: number) => Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, Math.round(n / step) * step));
  const commit = (s: string) => {
    const n = Number(s.replace(',', '.'));
    if (s.trim() === '' || !Number.isFinite(n)) return setText(String(value));
    onChange(clamp(n));
  };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.xs }}>
      <Button icon="remove" size="sm" variant="secondary" onPress={() => onChange(clamp(value - step))} accessibilityLabel="Decrease" />
      <View style={{ width: t.isTV ? t.s(110) : 84 }}>
        <Input value={text} onChangeText={setText} onEndEditing={(e) => commit(e.nativeEvent.text)} onSubmitEditing={(e) => commit(e.nativeEvent.text)} keyboardType="decimal-pad" returnKeyType="done" style={{ textAlign: 'center' }} />
      </View>
      <Button icon="add" size="sm" variant="secondary" onPress={() => onChange(clamp(value + step))} accessibilityLabel="Increase" />
    </View>
  );
}
