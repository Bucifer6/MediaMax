/**
 * DJ rules ("Play rules"): what Your DJ, Mix / Endless and smart order may play (mobile port of
 * web/src/player/djRules.ts — keep the two in step). Pure helpers (no React Native imports) for editing saved presets,
 * cleaning them before they are saved (PATCH /auth/me { preferences: { djRules } }), and describing rules as chips.
 * Unit-tested in Node (tests/your-dj.test.mjs). The server applies the rules (and the admin's enforced ones).
 */
import type { DjOrderSource, DjRulePreset, DjRules, UserPreferences } from '../api/types';

export type DjRulesPrefs = NonNullable<UserPreferences['djRules']>;

/** The listener's saved presets and the one in use (defaults filled in). */
export function djRulesPrefs(prefs: Partial<UserPreferences> | null | undefined): DjRulesPrefs {
  const p = prefs?.djRules;
  return { activePresetId: p?.activePresetId ?? null, presets: Array.isArray(p?.presets) ? p!.presets : [] };
}

/** The preset id to send as `presetId` (never together with `rules`), or undefined for "everything". */
export function activePresetIdOf(prefs: Partial<UserPreferences> | null | undefined): string | undefined {
  const p = djRulesPrefs(prefs);
  const id = p.activePresetId;
  return id && p.presets.some((x) => x.id === id) ? id : undefined;
}

const list = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const t = x.trim().replace(/\s+/g, ' ');
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.length ? out : undefined;
};
const num = (v: unknown, lo: number, hi: number, int = false): number | undefined => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  const c = Math.max(lo, Math.min(hi, n));
  return int ? Math.round(c) : Math.round(c * 100) / 100;
};
/** Order a min/max pair (a swapped range is the same intent). */
function range(r: DjRules, lo: 'yearMin' | 'bpmMin' | 'energyMin', hi: 'yearMax' | 'bpmMax' | 'energyMax') {
  const a = r[lo];
  const b = r[hi];
  if (a != null && b != null && a > b) {
    r[lo] = b;
    r[hi] = a;
  }
}

/**
 * Rules as they are saved: trimmed, de-duplicated (case-insensitive) lists, numbers clamped to sane ranges, swapped
 * ranges put in order, a genre/artist both included and excluded only excluded, and empty fields dropped.
 */
export function cleanRules(input: DjRules | null | undefined): DjRules {
  const r: DjRules = {};
  if (!input) return r;
  const exG = list(input.excludeGenres);
  const exA = list(input.excludeArtists);
  const notIn = (xs: string[] | undefined, ex: string[] | undefined) => {
    if (!xs || !ex) return xs;
    const e = new Set(ex.map((x) => x.toLowerCase()));
    const k = xs.filter((x) => !e.has(x.toLowerCase()));
    return k.length ? k : undefined;
  };
  const inG = notIn(list(input.includeGenres), exG);
  const inA = notIn(list(input.includeArtists), exA);
  if (inG) r.includeGenres = inG;
  if (exG) r.excludeGenres = exG;
  if (inA) r.includeArtists = inA;
  if (exA) r.excludeArtists = exA;
  if (Array.isArray(input.sources)) {
    const seen = new Set<string>();
    const src = input.sources.filter((s): s is DjOrderSource => !!s && typeof s.type === 'string' && typeof s.id === 'string' && !!s.id).filter((s) => {
      const k = `${s.type}:${s.id}:${s.path ?? ''}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (src.length) r.sources = src;
  }
  const y0 = num(input.yearMin, 1900, 2100, true);
  const y1 = num(input.yearMax, 1900, 2100, true);
  if (y0 != null) r.yearMin = y0;
  if (y1 != null) r.yearMax = y1;
  range(r, 'yearMin', 'yearMax');
  const b0 = num(input.bpmMin, 40, 220, true);
  const b1 = num(input.bpmMax, 40, 220, true);
  if (b0 != null) r.bpmMin = b0;
  if (b1 != null) r.bpmMax = b1;
  range(r, 'bpmMin', 'bpmMax');
  const e0 = num(input.energyMin, 0, 1);
  const e1 = num(input.energyMax, 0, 1);
  // A full 0–1 range is no limit at all.
  if (e0 != null && e0 > 0) r.energyMin = e0;
  if (e1 != null && e1 < 1) r.energyMax = e1;
  range(r, 'energyMin', 'energyMax');
  if (input.cleanOnly === true) r.cleanOnly = true;
  const mr = num(input.minRating, 0, 10, true);
  if (mr != null && mr > 0) r.minRating = mr;
  const md = num(input.maxDurationSec, 30, 7200, true);
  if (md != null) r.maxDurationSec = md;
  return r;
}

export function isEmptyRules(r: DjRules | null | undefined): boolean {
  return Object.keys(cleanRules(r)).length === 0;
}

/** Stable JSON of cleaned rules (key order fixed), for "has this changed?" checks. */
export function rulesKey(r: DjRules | null | undefined): string {
  const c = cleanRules(r) as Record<string, unknown>;
  return JSON.stringify(Object.keys(c).sort().map((k) => [k, c[k]]));
}

export const newPresetId = (): string => `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A preset name that isn't taken yet ("Kids", "Kids 2"…). */
export function uniqueName(base: string, presets: DjRulePreset[], exceptId?: string): string {
  const name = base.trim() || 'My rules';
  const taken = new Set(presets.filter((p) => p.id !== exceptId).map((p) => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`.toLowerCase())) return `${name} ${i}`;
}

/** Add or replace a preset (cleaned, named uniquely). Returns new prefs; `activate` makes it the one in use. */
export function upsertPreset(prefs: DjRulesPrefs, preset: DjRulePreset, activate = false): DjRulesPrefs {
  const clean: DjRulePreset = { id: preset.id || newPresetId(), name: uniqueName(preset.name, prefs.presets, preset.id), rules: cleanRules(preset.rules) };
  const i = prefs.presets.findIndex((p) => p.id === clean.id);
  const presets = i >= 0 ? prefs.presets.map((p, j) => (j === i ? clean : p)) : [...prefs.presets, clean];
  return { activePresetId: activate ? clean.id : (prefs.activePresetId ?? null), presets };
}

/** Delete a preset; deleting the one in use turns rules off. */
export function removePreset(prefs: DjRulesPrefs, id: string): DjRulesPrefs {
  return { activePresetId: prefs.activePresetId === id ? null : (prefs.activePresetId ?? null), presets: prefs.presets.filter((p) => p.id !== id) };
}

/** Choose the preset in use (null = no rules of your own; an unknown id also means none). */
export function setActivePreset(prefs: DjRulesPrefs, id: string | null): DjRulesPrefs {
  return { ...prefs, activePresetId: id && prefs.presets.some((p) => p.id === id) ? id : null };
}

/** What is saved in preferences.djRules: cleaned presets, at most 50, and a valid active id. */
export function serializeRulesPrefs(prefs: DjRulesPrefs): DjRulesPrefs {
  const presets = prefs.presets.slice(0, 50).map((p) => ({ id: p.id, name: p.name.trim().slice(0, 60) || 'My rules', rules: cleanRules(p.rules) }));
  const active = prefs.activePresetId && presets.some((p) => p.id === prefs.activePresetId) ? prefs.activePresetId : null;
  return { activePresetId: active, presets };
}

/** Read whatever was saved (old, partial or hand-edited data) back into valid prefs. */
export function parseRulesPrefs(raw: unknown): DjRulesPrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as { activePresetId?: unknown; presets?: unknown };
  const presets = (Array.isArray(o.presets) ? o.presets : [])
    .filter((p): p is DjRulePreset => !!p && typeof p === 'object' && typeof (p as DjRulePreset).id === 'string')
    .map((p) => ({ id: p.id, name: typeof p.name === 'string' && p.name.trim() ? p.name : 'My rules', rules: cleanRules(p.rules) }));
  return serializeRulesPrefs({ activePresetId: typeof o.activePresetId === 'string' ? o.activePresetId : null, presets });
}

const fmtMin = (sec: number) => (sec % 60 === 0 ? `${sec / 60} min` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`);
const pct = (v: number) => `${Math.round(v * 100)} %`;

export interface RuleChip {
  /** Field the chip stands for (and the value to remove, for list fields). */
  field: keyof DjRules;
  value?: string;
  label: string;
}

/** One short chip per limit ("Only: Jazz", "No: Metal", "1990–1999", "Clean only"…), in a fixed order. */
export function ruleChips(input: DjRules | null | undefined, sourceName: (s: DjOrderSource) => string = (s) => s.id): RuleChip[] {
  const r = cleanRules(input);
  const out: RuleChip[] = [];
  for (const g of r.includeGenres ?? []) out.push({ field: 'includeGenres', value: g, label: `Only ${g}` });
  for (const g of r.excludeGenres ?? []) out.push({ field: 'excludeGenres', value: g, label: `No ${g}` });
  for (const a of r.includeArtists ?? []) out.push({ field: 'includeArtists', value: a, label: `Only ${a}` });
  for (const a of r.excludeArtists ?? []) out.push({ field: 'excludeArtists', value: a, label: `No ${a}` });
  for (const s of r.sources ?? []) out.push({ field: 'sources', value: `${s.type}:${s.id}`, label: `From ${sourceName(s)}` });
  if (r.yearMin != null || r.yearMax != null) {
    out.push({ field: 'yearMin', label: r.yearMin != null && r.yearMax != null ? `${r.yearMin}–${r.yearMax}` : r.yearMin != null ? `${r.yearMin} or later` : `Up to ${r.yearMax}` });
  }
  if (r.bpmMin != null || r.bpmMax != null) {
    out.push({ field: 'bpmMin', label: r.bpmMin != null && r.bpmMax != null ? `${r.bpmMin}–${r.bpmMax} BPM` : r.bpmMin != null ? `${r.bpmMin}+ BPM` : `Up to ${r.bpmMax} BPM` });
  }
  if (r.energyMin != null || r.energyMax != null) {
    out.push({ field: 'energyMin', label: `Energy ${pct(r.energyMin ?? 0)}–${pct(r.energyMax ?? 1)}` });
  }
  if (r.cleanOnly) out.push({ field: 'cleanOnly', label: 'Clean only' });
  if (r.minRating != null) out.push({ field: 'minRating', label: `Rated ${r.minRating / 2}★ or more` });
  if (r.maxDurationSec != null) out.push({ field: 'maxDurationSec', label: `Up to ${fmtMin(r.maxDurationSec)}` });
  return out;
}

/** Remove one chip's limit from rules (the × on an editable chip). */
export function withoutChip(input: DjRules, chip: RuleChip): DjRules {
  const r: DjRules = { ...input };
  switch (chip.field) {
    case 'includeGenres': case 'excludeGenres': case 'includeArtists': case 'excludeArtists':
      r[chip.field] = (r[chip.field] ?? []).filter((x) => x.toLowerCase() !== (chip.value ?? '').toLowerCase());
      break;
    case 'sources':
      r.sources = (r.sources ?? []).filter((s) => `${s.type}:${s.id}` !== chip.value);
      break;
    case 'yearMin': delete r.yearMin; delete r.yearMax; break;
    case 'bpmMin': delete r.bpmMin; delete r.bpmMax; break;
    case 'energyMin': delete r.energyMin; delete r.energyMax; break;
    default: delete r[chip.field];
  }
  return cleanRules(r);
}

/** Short summary of a preset for pickers: "Only Jazz · 1990–1999 · +2". */
export function rulesSummary(r: DjRules | null | undefined, max = 2): string {
  const chips = ruleChips(r);
  if (!chips.length) return 'No limits';
  const head = chips.slice(0, max).map((c) => c.label).join(' · ');
  return chips.length > max ? `${head} · +${chips.length - max}` : head;
}

/* ------------------------------------------------------------------ phone editor helpers */

/** "Metallica, ABBA ,abba" → ["Metallica", "ABBA"] (trimmed, de-duplicated case-insensitively). */
export function splitList(text: string): string[] {
  return cleanRules({ includeGenres: text.split(/[,;\n]/) }).includeGenres ?? [];
}

/** A genre chip's state in the editor. */
export type GenreState = 'any' | 'only' | 'never';
export function genreState(r: DjRules, genre: string): GenreState {
  const k = genre.toLowerCase();
  if ((r.excludeGenres ?? []).some((g) => g.toLowerCase() === k)) return 'never';
  if ((r.includeGenres ?? []).some((g) => g.toLowerCase() === k)) return 'only';
  return 'any';
}
/** Tap a genre chip: any → only → never → any. */
export function cycleGenre(r: DjRules, genre: string): DjRules {
  const k = genre.toLowerCase();
  const st = genreState(r, genre);
  const inc = (r.includeGenres ?? []).filter((g) => g.toLowerCase() !== k);
  const exc = (r.excludeGenres ?? []).filter((g) => g.toLowerCase() !== k);
  if (st === 'any') inc.push(genre);
  else if (st === 'only') exc.push(genre);
  return cleanRules({ ...r, includeGenres: inc, excludeGenres: exc });
}

/** A whole-number field from a text input: '' = not set. */
export function numField(text: string): number | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}
