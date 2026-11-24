/**
 * "Play rules": what Your DJ, Mix / Endless and smart order may play. Saved presets (build, edit, delete, pick the
 * one in use) plus the restrictions an admin set for this profile, shown as locked chips ("Set by your admin").
 *
 * Opened from anywhere with `openPlayRules()` (Your DJ, the Mix buttons, Now Playing's Automix menu, Settings →
 * Playback); `PlayRulesHost` (mounted once by the music provider) renders the sheet.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { DjOrderSource, Item, UserPreferences } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { Icon } from './Icon';
import { Button, Chip, Field, Modal, StarRating, Switch, useConfirm } from './ui';
import { cleanRules, isEmptyRules, newPresetId, removePreset, ruleChips, rulesKey, rulesSummary, serializeRulesPrefs, setActivePreset, upsertPreset } from '../player/djRules';
import { djRulesPrefs, type DjRulePreset, type DjRules, type DjRulesPrefs } from '../player/djTypes';
import '../styles/yourdj.css';

const OPEN_EVENT = 'vibe:play-rules';
/** Open the Play rules sheet (optionally straight into a new preset). */
export function openPlayRules(opts: { create?: boolean } = {}) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: opts }));
}

/** Save the listener's DJ preferences (radioHost / yourDj / djRules), optimistic like the rest of Settings. */
export function useDjPrefsSave() {
  const { user, setUser } = useApp();
  const toast = useToast();
  return async (patch: Partial<UserPreferences>) => {
    if (!user) return;
    const prev = user;
    setUser({ ...user, preferences: { ...user.preferences, ...patch } });
    try {
      setUser(await api.auth.updateMe({ preferences: patch }));
    } catch (e) {
      setUser(prev);
      toast.error(e);
    }
  };
}

/** The listener's presets and the one in use, plus a setter that saves. */
export function useRulePresets() {
  const { user } = useApp();
  const save = useDjPrefsSave();
  const prefs = djRulesPrefs(user?.preferences);
  const setPrefs = (p: DjRulesPrefs) => save({ djRules: serializeRulesPrefs(p) });
  return { prefs, setPrefs, active: prefs.presets.find((p) => p.id === prefs.activePresetId) ?? null };
}

/** Admin-enforced rules for this profile (empty when none, or when the server doesn't know them). */
function useEnforced(open: boolean) {
  const [enforced, setEnforced] = useState<DjRules>({});
  useEffect(() => {
    if (!open) return;
    let off = false;
    api.dj.rules().then((r) => !off && setEnforced(r.enforced ?? {})).catch(() => !off && setEnforced({}));
    return () => {
      off = true;
    };
  }, [open]);
  return enforced;
}

export function PlayRulesHost() {
  const [open, setOpen] = useState<null | { create?: boolean }>(null);
  useEffect(() => {
    const h = (e: Event) => setOpen((e as CustomEvent<{ create?: boolean }>).detail ?? {});
    window.addEventListener(OPEN_EVENT, h);
    return () => window.removeEventListener(OPEN_EVENT, h);
  }, []);
  if (!open) return null;
  return <PlayRulesSheet create={!!open.create} onClose={() => setOpen(null)} />;
}

/** Locked chips for the admin's restrictions. */
export function EnforcedChips({ rules, names }: { rules: DjRules; names?: (s: DjOrderSource) => string }) {
  const chips = ruleChips(rules, names);
  if (!chips.length) return null;
  return (
    <div className="rules-enforced" role="group" aria-label="Set by your admin">
      <div className="rules-enforced-head"><Icon name="lock" size={14} /> Set by your admin <span>Always applies</span></div>
      <div className="rules-chips">
        {chips.map((c) => (
          <span key={`${c.field}:${c.value ?? ''}`} className="chip chip-sm chip-locked" title="Set by your admin"><Icon name="lock" size={12} /> {c.label}</span>
        ))}
      </div>
    </div>
  );
}

function useSourceNames() {
  const { libraries } = useApp();
  const [playlists, setPlaylists] = useState<Item[]>([]);
  useEffect(() => {
    api.playlists.list().then(setPlaylists).catch(() => setPlaylists([]));
  }, []);
  const music = libraries.filter((l) => l.type === 'music');
  const name = (s: DjOrderSource) => (s.type === 'library' || s.type === 'folder' ? libraries.find((l) => l.id === s.id)?.name : s.type === 'playlist' ? playlists.find((p) => p.id === s.id)?.title : null) ?? (s.type === 'genre' ? s.id : s.type);
  return { music, playlists, name };
}

function PlayRulesSheet({ create, onClose }: { create: boolean; onClose: () => void }) {
  const { prefs, setPrefs } = useRulePresets();
  const enforced = useEnforced(true);
  const sources = useSourceNames();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<DjRulePreset | null>(create ? { id: '', name: '', rules: {} } : null);

  const choose = (id: string | null) => void setPrefs(setActivePreset(prefs, id));
  const save = (p: DjRulePreset, activate: boolean) => {
    const id = p.id || newPresetId();
    void setPrefs(upsertPreset(prefs, { ...p, id }, activate));
    setEditing(null);
  };
  const remove = async (p: DjRulePreset) => {
    if (!(await confirm({ title: `Delete "${p.name}"?`, message: 'Mixes and Your DJ will stop using these rules.', confirmLabel: 'Delete', danger: true }))) return;
    void setPrefs(removePreset(prefs, p.id));
    setEditing(null);
  };

  if (editing) {
    return (
      <PresetEditor
        preset={editing}
        isNew={!editing.id}
        isActive={!!editing.id && editing.id === prefs.activePresetId}
        enforced={enforced}
        sources={sources}
        onCancel={() => (create ? onClose() : setEditing(null))}
        onSave={save}
        onDelete={editing.id ? () => void remove(editing) : undefined}
        onClose={onClose}
      />
    );
  }
  return (
    <Modal open variant="sheet" size="md" title="Play rules" onClose={onClose} className="rules-sheet"
      footer={<Button variant="primary" icon="plus" onClick={() => setEditing({ id: '', name: '', rules: {} })}>New preset</Button>}>
      <p className="rules-lede">Choose what Your DJ, Mix and Endless may play. Requests and “Switch it up” stay within these rules too.</p>
      <EnforcedChips rules={enforced} names={sources.name} />
      <div className="rules-list" role="radiogroup" aria-label="Rules in use">
        <button type="button" role="radio" aria-checked={!prefs.activePresetId} className={`rules-option ${!prefs.activePresetId ? 'active' : ''}`} onClick={() => choose(null)}>
          <span className="rules-radio" aria-hidden />
          <span className="rules-option-text"><strong>Everything</strong><small>{isEmptyRules(enforced) ? 'Your whole music library' : 'Your library, within your admin’s limits'}</small></span>
        </button>
        {prefs.presets.map((p) => (
          <div key={p.id} className={`rules-option ${prefs.activePresetId === p.id ? 'active' : ''}`}>
            <button type="button" role="radio" aria-checked={prefs.activePresetId === p.id} className="rules-option-pick" onClick={() => choose(p.id)}>
              <span className="rules-radio" aria-hidden />
              <span className="rules-option-text"><strong>{p.name}</strong><small>{rulesSummary(p.rules, 3)}</small></span>
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`}><Icon name="edit" size={15} /> Edit</button>
          </div>
        ))}
      </div>
      {!prefs.presets.length && <p className="rules-empty">No presets yet. Make one for a mood (“Focus: ambient, no vocals over 100 BPM”) or a listener (“Kids: clean only”).</p>}
    </Modal>
  );
}

type Sources = ReturnType<typeof useSourceNames>;

function PresetEditor({ preset, isNew, isActive, enforced, sources, onCancel, onSave, onDelete, onClose }: {
  preset: DjRulePreset; isNew: boolean; isActive: boolean; enforced: DjRules; sources: Sources;
  onCancel: () => void; onSave: (p: DjRulePreset, activate: boolean) => void; onDelete?: () => void; onClose: () => void;
}) {
  const [name, setName] = useState(preset.name);
  const [r, setR] = useState<DjRules>(preset.rules);
  const [genres, setGenres] = useState<string[]>([]);
  useEffect(() => {
    const libs = sources.music.map((l) => l.id);
    Promise.all((libs.length ? libs : [undefined]).map((id) => api.items.genres(id).catch(() => [] as string[])))
      .then((all) => setGenres([...new Set(all.flat())].sort((a, b) => a.localeCompare(b))))
      .catch(() => setGenres([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources.music.length]);
  const set = (patch: Partial<DjRules>) => setR((x) => ({ ...x, ...patch }));
  const changed = name.trim() !== preset.name || rulesKey(r) !== rulesKey(preset.rules);
  const valid = name.trim().length > 0;
  const toggleSource = (s: DjOrderSource) => {
    const list = r.sources ?? [];
    const has = list.some((x) => x.type === s.type && x.id === s.id);
    set({ sources: has ? list.filter((x) => !(x.type === s.type && x.id === s.id)) : [...list, s] });
  };
  const hasSource = (s: DjOrderSource) => (r.sources ?? []).some((x) => x.type === s.type && x.id === s.id);
  const numIn = (v: string) => (v.trim() === '' ? undefined : Number(v));
  const energyPct = (v: number | undefined, d: number) => Math.round((v ?? d) * 100);
  const preview = ruleChips(cleanRules(r), sources.name);

  return (
    <Modal open variant="sheet" size="md" title={isNew ? 'New preset' : `Edit “${preset.name}”`} onClose={onClose} className="rules-sheet rules-editor"
      footer={(
        <>
          {onDelete && <Button variant="ghost" icon="trash" className="rules-delete" onClick={onDelete}>Delete</Button>}
          <span className="rules-foot-gap" />
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" disabled={!valid || (!isNew && !changed)} onClick={() => onSave({ id: preset.id, name: name.trim(), rules: cleanRules(r) }, isNew || isActive)}>
            {isNew ? 'Save and use' : 'Save'}
          </Button>
        </>
      )}>
      <EnforcedChips rules={enforced} names={sources.name} />
      <Field label="Name">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Focus, Kids, Sunday morning" maxLength={60} autoFocus />
      </Field>

      <fieldset className="rules-group">
        <legend>Genres</legend>
        <TagInput label="Only these genres" placeholder="Any genre" values={r.includeGenres ?? []} onChange={(v) => set({ includeGenres: v })} suggestions={genres} />
        <TagInput label="Never these genres" placeholder="None excluded" values={r.excludeGenres ?? []} onChange={(v) => set({ excludeGenres: v })} suggestions={genres} tone="exclude" />
      </fieldset>

      <fieldset className="rules-group">
        <legend>Artists</legend>
        <ArtistTagInput label="Only these artists" placeholder="Any artist" values={r.includeArtists ?? []} onChange={(v) => set({ includeArtists: v })} />
        <ArtistTagInput label="Never these artists" placeholder="None excluded" values={r.excludeArtists ?? []} onChange={(v) => set({ excludeArtists: v })} tone="exclude" />
      </fieldset>

      {(sources.music.length > 1 || sources.playlists.length > 0) && (
        <fieldset className="rules-group">
          <legend>Only from</legend>
          <div className="rules-chips">
            {sources.music.length > 1 && sources.music.map((l) => {
              const s: DjOrderSource = { type: 'library', id: l.id };
              return <Chip key={l.id} size="sm" icon="music" active={hasSource(s)} onClick={() => toggleSource(s)}>{l.name}</Chip>;
            })}
            {sources.playlists.slice(0, 24).map((p) => {
              const s: DjOrderSource = { type: 'playlist', id: p.id };
              return <Chip key={p.id} size="sm" icon="playlist" active={hasSource(s)} onClick={() => toggleSource(s)}>{p.title}</Chip>;
            })}
          </div>
          <p className="field-hint">None selected = your whole library.</p>
        </fieldset>
      )}

      <fieldset className="rules-group rules-grid">
        <legend>Sound</legend>
        <Field label="Released" hint="Year range">
          <span className="rules-range">
            <input className="input" type="number" inputMode="numeric" placeholder="From" min={1900} max={2100} value={r.yearMin ?? ''} onChange={(e) => set({ yearMin: numIn(e.target.value) })} aria-label="From year" />
            <span aria-hidden>–</span>
            <input className="input" type="number" inputMode="numeric" placeholder="To" min={1900} max={2100} value={r.yearMax ?? ''} onChange={(e) => set({ yearMax: numIn(e.target.value) })} aria-label="To year" />
          </span>
        </Field>
        <Field label="Tempo" hint="BPM, from the track analysis">
          <span className="rules-range">
            <input className="input" type="number" inputMode="numeric" placeholder="Min" min={40} max={220} value={r.bpmMin ?? ''} onChange={(e) => set({ bpmMin: numIn(e.target.value) })} aria-label="Minimum BPM" />
            <span aria-hidden>–</span>
            <input className="input" type="number" inputMode="numeric" placeholder="Max" min={40} max={220} value={r.bpmMax ?? ''} onChange={(e) => set({ bpmMax: numIn(e.target.value) })} aria-label="Maximum BPM" />
          </span>
        </Field>
        <Field label={`Energy · ${energyPct(r.energyMin, 0)}–${energyPct(r.energyMax, 1)} %`} hint="Calm to high-energy">
          <span className="rules-range rules-sliders">
            <input className="range" type="range" min={0} max={100} step={5} value={energyPct(r.energyMin, 0)} onChange={(e) => set({ energyMin: Math.min(Number(e.target.value), energyPct(r.energyMax, 1)) / 100 })} aria-label="Minimum energy" />
            <input className="range" type="range" min={0} max={100} step={5} value={energyPct(r.energyMax, 1)} onChange={(e) => set({ energyMax: Math.max(Number(e.target.value), energyPct(r.energyMin, 0)) / 100 })} aria-label="Maximum energy" />
          </span>
        </Field>
        <Field label="Longest song">
          <select className="select" value={r.maxDurationSec ?? ''} onChange={(e) => set({ maxDurationSec: numIn(e.target.value) })}>
            <option value="">Any length</option>
            {[180, 240, 300, 360, 480, 600].map((s) => <option key={s} value={s}>{s / 60} minutes</option>)}
          </select>
        </Field>
      </fieldset>

      <fieldset className="rules-group">
        <legend>Taste</legend>
        <Field label="Only songs you rated at least" hint={r.minRating ? 'Unrated songs are left out.' : 'Any rating (or none).'}>
          <span className="rules-rating">
            <StarRating value={r.minRating ?? null} onChange={(v) => set({ minRating: v || undefined })} size={22} />
            {r.minRating ? <button type="button" className="btn btn-ghost btn-xs" onClick={() => set({ minRating: undefined })}>Clear</button> : null}
          </span>
        </Field>
        <Switch checked={!!r.cleanOnly} onChange={(v) => set({ cleanOnly: v || undefined })} label="Clean only" hint="Leave out songs tagged explicit." />
      </fieldset>

      <div className="rules-preview" aria-live="polite">
        <span className="t-eyebrow">This preset</span>
        <div className="rules-chips">
          {preview.length ? preview.map((c) => <span key={`${c.field}:${c.value ?? ''}`} className="chip chip-sm">{c.label}</span>) : <span className="rules-none">No limits yet: everything plays.</span>}
        </div>
      </div>
    </Modal>
  );
}

/** Chips + a text field with suggestions (Enter or comma adds; Backspace on empty removes the last). */
function TagInput({ label, placeholder, values, onChange, suggestions, tone, onQuery }: {
  label: string; placeholder: string; values: string[]; onChange: (v: string[]) => void; suggestions: string[]; tone?: 'exclude'; onQuery?: (q: string) => void;
}) {
  const [q, setQ] = useState('');
  const [focus, setFocus] = useState(false);
  const [hi, setHi] = useState(0);
  const listId = useMemo(() => `tags-${Math.random().toString(36).slice(2, 8)}`, []);
  const blurTimer = useRef<number>(0);
  const lower = new Set(values.map((v) => v.toLowerCase()));
  const matches = q.trim()
    ? suggestions.filter((s) => !lower.has(s.toLowerCase()) && s.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 6)
    : [];
  const add = (v: string) => {
    const t = v.trim();
    if (!t || lower.has(t.toLowerCase())) return setQ('');
    onChange([...values, t]);
    setQ('');
    setHi(0);
  };
  const key = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      if (!q.trim()) return;
      e.preventDefault();
      add(matches[hi] ?? q);
    } else if (e.key === 'ArrowDown' && matches.length) {
      e.preventDefault();
      setHi((h) => (h + 1) % matches.length);
    } else if (e.key === 'ArrowUp' && matches.length) {
      e.preventDefault();
      setHi((h) => (h - 1 + matches.length) % matches.length);
    } else if (e.key === 'Backspace' && !q && values.length) onChange(values.slice(0, -1));
    else if (e.key === 'Escape' && q) {
      e.stopPropagation();
      setQ('');
    }
  };
  return (
    <div className={`tag-field ${tone === 'exclude' ? 'is-exclude' : ''}`}>
      <span className="field-label">{label}</span>
      <div className="tag-box" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
        {values.map((v) => (
          <span key={v} className={`chip chip-sm ${tone === 'exclude' ? 'chip-exclude' : 'active'}`}>
            {tone === 'exclude' && <Icon name="ban" size={12} />}{v}
            <button type="button" className="chip-remove" onClick={() => onChange(values.filter((x) => x !== v))} aria-label={`Remove ${v}`}><Icon name="x" size={12} /></button>
          </span>
        ))}
        <input
          value={q}
          placeholder={values.length ? '' : placeholder}
          onChange={(e) => {
            setQ(e.target.value);
            setHi(0);
            onQuery?.(e.target.value);
          }}
          onKeyDown={key}
          onFocus={() => {
            window.clearTimeout(blurTimer.current);
            setFocus(true);
          }}
          onBlur={() => {
            blurTimer.current = window.setTimeout(() => setFocus(false), 120);
            if (q.trim()) add(q);
          }}
          aria-label={label}
          role="combobox"
          aria-expanded={focus && matches.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
        />
      </div>
      {focus && matches.length > 0 && (
        <ul className="tag-suggest" id={listId} role="listbox">
          {matches.map((m, i) => (
            <li key={m} role="option" aria-selected={i === hi}>
              <button type="button" className={i === hi ? 'hi' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => add(m)}>{m}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Artist names with suggestions from a library search as you type. */
function ArtistTagInput(props: { label: string; placeholder: string; values: string[]; onChange: (v: string[]) => void; tone?: 'exclude' }) {
  const [names, setNames] = useState<string[]>([]);
  const timer = useRef<number>(0);
  const ctl = useRef<AbortController | null>(null);
  const query = (q: string) => {
    window.clearTimeout(timer.current);
    if (q.trim().length < 2) return;
    timer.current = window.setTimeout(() => {
      ctl.current?.abort();
      const c = new AbortController();
      ctl.current = c;
      api.items.search(q.trim(), 12, c.signal)
        .then((r) => setNames([...new Set(r.items.filter((i) => i.type === 'artist').map((i) => i.title))]))
        .catch(() => {});
    }, 200);
  };
  return <TagInput {...props} suggestions={names} onQuery={query} />;
}
