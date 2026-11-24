/**
 * "Play rules" on the phone: pick the preset Your DJ, Mix and Endless use, and create / edit / delete presets
 * (genres only / never, artists, years, BPM, energy, clean only, minimum rating, maximum length). The admin's
 * enforced restrictions for this profile (GET /dj/rules) are shown as locked chips: they always apply on top.
 * Simpler than the web editor (no source picker); presets are saved as the whole `djRules` preference object.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, View } from 'react-native';
import type { DjRulePreset, DjRules } from '@/api/types';
import { useQuery } from '@/api/useQuery';
import {
  cleanRules, cycleGenre, djRulesPrefs, genreState, newPresetId, numField, removePreset, ruleChips, rulesSummary, serializeRulesPrefs, setActivePreset,
  splitList, upsertPreset, type DjRulesPrefs,
} from '@/player/djRules';
import { useSession } from '@/state/session';
import { useTheme } from '@/theme';
import { Button } from './Button';
import { Chip } from './Chip';
import { Focusable } from './Focusable';
import { Icon } from './Icon';
import { Input } from './Input';
import { Sheet } from './Sheet';
import { T } from './Text';

/** The listener's presets and the one in use, plus a setter that saves the whole object. */
export function useRulePresets() {
  const { user, updatePreferences } = useSession();
  const prefs = djRulesPrefs(user?.preferences);
  const setPrefs = (p: DjRulesPrefs) => updatePreferences({ djRules: serializeRulesPrefs(p) });
  return { prefs, setPrefs, active: prefs.presets.find((p) => p.id === prefs.activePresetId) ?? null };
}

/** Admin-enforced rules for this profile ({} when none, offline, or unknown). */
export function useEnforcedRules(enabled: boolean): DjRules {
  const { api, status } = useSession();
  const [enforced, setEnforced] = useState<DjRules>({});
  useEffect(() => {
    if (!enabled || !api || status !== 'signed-in') return;
    const ctrl = new AbortController();
    api
      .djRules(ctrl.signal)
      .then((r) => setEnforced(r.enforced ?? {}))
      .catch(() => !ctrl.signal.aborted && setEnforced({}));
    return () => ctrl.abort();
  }, [enabled, api, status]);
  return enforced;
}

/** Locked chips for the admin's restrictions. */
export function EnforcedChips({ rules }: { rules: DjRules }) {
  const t = useTheme();
  const chips = ruleChips(rules);
  if (!chips.length) return null;
  return (
    <View style={{ gap: t.space.xs }} accessibilityLabel="Set by your admin">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Icon name="lock-closed" size={14} color={t.colors.textMuted} />
        <T variant="caption" tone="muted">Set by your admin · always applies</T>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {chips.map((c) => (
          <View key={`${c.field}:${c.value ?? ''}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: t.alpha(t.colors.text, 0.06), borderWidth: 1, borderColor: t.colors.border }}>
            <Icon name="lock-closed" size={11} color={t.colors.textMuted} />
            <T variant="caption" tone="muted">{c.label}</T>
          </View>
        ))}
      </View>
    </View>
  );
}

/** Genres of the music libraries this profile can see (for the genre chips). */
function useMusicGenres(enabled: boolean): string[] {
  const libs = useQuery(enabled ? 'libraries' : null, (a) => a.libraries());
  const music = (libs.data ?? []).filter((l) => l.type === 'music');
  const first = music[0]?.id ?? null;
  const g = useQuery(enabled && first ? `genres:${first}` : null, (a) => a.genres(first!), { staleMs: 300000 });
  return (g.data ?? []).slice(0, 60);
}

export function PlayRulesSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useTheme();
  const { prefs, setPrefs } = useRulePresets();
  const enforced = useEnforcedRules(visible);
  const [editing, setEditing] = useState<DjRulePreset | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) {
      setEditing(null);
      setError(null);
    }
  }, [visible]);

  const save = (p: DjRulesPrefs) => {
    setError(null);
    setPrefs(p).catch(() => setError('Could not save your play rules. Check your connection and try again.'));
  };
  const choose = (id: string | null) => save(setActivePreset(prefs, id));
  const remove = (p: DjRulePreset) =>
    Alert.alert(`Delete "${p.name}"?`, 'Mixes and Your DJ will stop using these rules.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          save(removePreset(prefs, p.id));
          setEditing(null);
        },
      },
    ]);

  // One sheet (a second Modal while the first one closes misbehaves on iOS): the list, or the editor.
  if (editing) {
    return (
      <Sheet visible={visible} title={editing.id ? 'Edit preset' : 'New preset'} onClose={onClose}>
      <PresetEditor
        key={editing.id || 'new'}
        visible={visible}
        preset={editing}
        enforced={enforced}
        onCancel={() => setEditing(null)}
        onDelete={editing.id ? () => remove(editing) : undefined}
        onSave={(p, activate) => {
          save(upsertPreset(prefs, { ...p, id: p.id || newPresetId() }, activate));
          setEditing(null);
        }}
      />
      </Sheet>
    );
  }

  return (
    <Sheet visible={visible} title="Play rules" subtitle="What Your DJ, Mix and Endless may play. Requests and “Switch it up” stay within these rules too." onClose={onClose}>
      {error ? <T tone="danger" variant="small">{error}</T> : null}
      <PresetRow name="Everything" summary="Your whole music library" selected={!prefs.activePresetId} onPress={() => choose(null)} />
      {prefs.presets.map((p) => (
        <PresetRow key={p.id} name={p.name} summary={rulesSummary(p.rules, 3)} selected={prefs.activePresetId === p.id} onPress={() => choose(p.id)} onEdit={() => setEditing(p)} />
      ))}
      <Button label="New preset" icon="add" variant="secondary" onPress={() => setEditing({ id: '', name: '', rules: {} })} />
      <EnforcedChips rules={enforced} />
      <T variant="caption" tone="muted">Changes apply from the next song.</T>
      <View style={{ height: t.space.xs }} />
    </Sheet>
  );
}

function PresetRow({ name, summary, selected, onPress, onEdit }: { name: string; summary: string; selected: boolean; onPress: () => void; onEdit?: () => void }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
      <Focusable
        onPress={onPress}
        accessibilityRole="radio"
        accessibilityState={{ selected }}
        style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: t.space.md, padding: t.space.sm, borderRadius: t.radius, backgroundColor: selected ? t.alpha(t.colors.primary, 0.14) : 'transparent' }}
      >
        <Icon name={selected ? 'radio-button-on' : 'radio-button-off'} color={selected ? t.colors.primary : t.colors.textMuted} size={20} />
        <View style={{ flex: 1 }}>
          <T weight="700" numberOfLines={1}>{name}</T>
          <T variant="caption" tone="muted" numberOfLines={1}>{summary}</T>
        </View>
      </Focusable>
      {onEdit ? (
        <Focusable onPress={onEdit} ringRadius={999} style={{ padding: 8 }} accessibilityLabel={`Edit ${name}`}>
          <Icon name="create-outline" size={20} color={t.colors.textMuted} />
        </Focusable>
      ) : null}
    </View>
  );
}

const ENERGY: { key: string; label: string; min?: number; max?: number }[] = [
  { key: 'any', label: 'Any' },
  { key: 'calm', label: 'Calm', max: 0.5 },
  { key: 'lively', label: 'Lively', min: 0.6 },
];
const RATINGS: { key: number; label: string }[] = [
  { key: 0, label: 'Any' },
  { key: 6, label: '3★+' },
  { key: 8, label: '4★+' },
  { key: 10, label: '5★' },
];
const LENGTHS: { key: number; label: string }[] = [
  { key: 0, label: 'Any' },
  { key: 240, label: '4 min' },
  { key: 300, label: '5 min' },
  { key: 420, label: '7 min' },
  { key: 600, label: '10 min' },
];

function PresetEditor({
  visible, preset, enforced, onSave, onCancel, onDelete,
}: {
  visible: boolean;
  preset: DjRulePreset;
  enforced: DjRules;
  onSave: (p: DjRulePreset, activate: boolean) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const t = useTheme();
  const genres = useMusicGenres(visible);
  const [name, setName] = useState(preset.name);
  const [rules, setRules] = useState<DjRules>(preset.rules);
  const [incArtists, setIncArtists] = useState((preset.rules.includeArtists ?? []).join(', '));
  const [excArtists, setExcArtists] = useState((preset.rules.excludeArtists ?? []).join(', '));
  const [yearMin, setYearMin] = useState(preset.rules.yearMin?.toString() ?? '');
  const [yearMax, setYearMax] = useState(preset.rules.yearMax?.toString() ?? '');
  const [bpmMin, setBpmMin] = useState(preset.rules.bpmMin?.toString() ?? '');
  const [bpmMax, setBpmMax] = useState(preset.rules.bpmMax?.toString() ?? '');
  const [extraGenre, setExtraGenre] = useState('');
  const set = (patch: Partial<DjRules>) => setRules((r) => ({ ...r, ...patch }));
  // Genres already in the rules but not in the library list (typed ones, other libraries) stay visible.
  const genreChips = useMemo(() => {
    const seen = new Set<string>();
    return [...(rules.includeGenres ?? []), ...(rules.excludeGenres ?? []), ...genres].filter((g) => {
      const k = g.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [genres, rules.includeGenres, rules.excludeGenres]);
  const energyKey = rules.energyMax != null && rules.energyMax <= 0.5 ? 'calm' : rules.energyMin != null && rules.energyMin >= 0.6 ? 'lively' : 'any';

  const build = (): DjRulePreset => ({
    id: preset.id,
    name: name.trim() || 'My rules',
    rules: cleanRules({
      ...rules,
      includeArtists: splitList(incArtists),
      excludeArtists: splitList(excArtists),
      yearMin: numField(yearMin),
      yearMax: numField(yearMax),
      bpmMin: numField(bpmMin),
      bpmMax: numField(bpmMax),
    }),
  });

  return (
    <>
      <Input label="Name" value={name} onChangeText={setName} placeholder="e.g. Kids, Focus, Party" maxLength={60} />

      <Section title="Genres" hint="Tap once for “only”, twice for “never”.">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {genreChips.map((g) => {
            const st = genreState(rules, g);
            return <Chip key={g} label={st === 'only' ? `Only ${g}` : st === 'never' ? `No ${g}` : g} icon={st === 'only' ? 'checkmark' : st === 'never' ? 'close' : undefined} selected={st !== 'any'} onPress={() => setRules((r) => cycleGenre(r, g))} />;
          })}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
          <View style={{ flex: 1 }}>
            <Input value={extraGenre} onChangeText={setExtraGenre} placeholder="Another genre" returnKeyType="done"
              onSubmitEditing={() => {
                const g = extraGenre.trim();
                if (g) setRules((r) => cycleGenre(r, g));
                setExtraGenre('');
              }} />
          </View>
        </View>
      </Section>

      <Section title="Artists" hint="Names separated by commas.">
        <Input value={incArtists} onChangeText={setIncArtists} placeholder="Only these artists" autoCapitalize="words" />
        <Input value={excArtists} onChangeText={setExcArtists} placeholder="Never these artists" autoCapitalize="words" />
      </Section>

      <Section title="Years">
        <Row>
          <View style={{ flex: 1 }}><Input value={yearMin} onChangeText={setYearMin} placeholder="From (e.g. 1990)" keyboardType="number-pad" maxLength={4} /></View>
          <View style={{ flex: 1 }}><Input value={yearMax} onChangeText={setYearMax} placeholder="To (e.g. 1999)" keyboardType="number-pad" maxLength={4} /></View>
        </Row>
      </Section>

      <Section title="Tempo (BPM)" hint="Only analysed tracks are used while a range is set.">
        <Row>
          <View style={{ flex: 1 }}><Input value={bpmMin} onChangeText={setBpmMin} placeholder="Min" keyboardType="number-pad" maxLength={3} /></View>
          <View style={{ flex: 1 }}><Input value={bpmMax} onChangeText={setBpmMax} placeholder="Max" keyboardType="number-pad" maxLength={3} /></View>
        </Row>
      </Section>

      <Section title="Energy">
        <Row>
          {ENERGY.map((e) => <Chip key={e.key} label={e.label} selected={energyKey === e.key} onPress={() => set({ energyMin: e.min, energyMax: e.max })} />)}
        </Row>
      </Section>

      <Section title="Your rating">
        <Row>
          {RATINGS.map((r) => <Chip key={r.key} label={r.label} selected={(rules.minRating ?? 0) === r.key} onPress={() => set({ minRating: r.key || undefined })} />)}
        </Row>
      </Section>

      <Section title="Longest song">
        <Row>
          {LENGTHS.map((l) => <Chip key={l.key} label={l.label} selected={(rules.maxDurationSec ?? 0) === l.key} onPress={() => set({ maxDurationSec: l.key || undefined })} />)}
        </Row>
      </Section>

      <Focusable onPress={() => set({ cleanOnly: !rules.cleanOnly })} accessibilityRole="switch" accessibilityState={{ checked: !!rules.cleanOnly }} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, paddingVertical: t.space.sm }}>
        <Icon name={rules.cleanOnly ? 'checkbox' : 'square-outline'} color={rules.cleanOnly ? t.colors.primary : t.colors.textMuted} />
        <View style={{ flex: 1 }}>
          <T weight="700">Clean only</T>
          <T variant="caption" tone="muted">Leave out songs tagged explicit.</T>
        </View>
      </Focusable>

      <EnforcedChips rules={enforced} />

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm, marginTop: t.space.sm }}>
        <Button label="Save and use" icon="checkmark" onPress={() => onSave(build(), true)} />
        <Button label="Save" variant="secondary" onPress={() => onSave(build(), false)} />
        <Button label="Cancel" variant="ghost" onPress={onCancel} />
        {onDelete ? <Button label="Delete" icon="trash-outline" variant="danger" onPress={onDelete} /> : null}
      </View>
    </>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ gap: t.space.xs }}>
      <T variant="caption" tone="muted" style={{ textTransform: 'uppercase' }}>{title}</T>
      {hint ? <T variant="caption" tone="muted">{hint}</T> : null}
      {children}
    </View>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{children}</View>;
}
