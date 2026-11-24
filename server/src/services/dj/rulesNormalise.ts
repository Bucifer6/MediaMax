/**
 * Pure validation of DJ rules and the AI DJ preferences (no database imports, so the auth service can use it).
 */
import type { DjOrderSource, DjRulePreset, DjRules, HostChattiness, RadioHostPrefs, UserPreferences, YourDjCommentary } from '@mediamax/shared';

const SOURCE_TYPES: DjOrderSource['type'][] = ['library', 'genre', 'artist', 'album', 'playlist', 'folder'];

const strList = (v: unknown, max = 50): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = [...new Set(v.map((x) => String(x ?? '').trim()).filter((x) => x && x.length <= 200))].slice(0, max);
  return out.length ? out : undefined;
};
const numIn = (v: unknown, lo: number, hi: number, round = true): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  const c = Math.max(lo, Math.min(hi, n));
  return round ? Math.round(c) : Math.round(c * 100) / 100;
};

/** Valid rules (unknown fields and junk dropped; empty lists removed). */
export function normaliseRules(v: unknown): DjRules {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const x = v as Record<string, unknown>;
  const r: DjRules = {};
  const set = <K extends keyof DjRules>(k: K, val: DjRules[K] | undefined) => {
    if (val !== undefined) r[k] = val;
  };
  set('includeGenres', strList(x.includeGenres));
  set('excludeGenres', strList(x.excludeGenres));
  set('includeArtists', strList(x.includeArtists));
  set('excludeArtists', strList(x.excludeArtists));
  if (Array.isArray(x.sources)) {
    const src = x.sources
      .filter((s): s is DjOrderSource => !!s && typeof s === 'object' && SOURCE_TYPES.includes((s as DjOrderSource).type) && typeof (s as DjOrderSource).id === 'string' && !!(s as DjOrderSource).id)
      .slice(0, 20)
      .map((s) => ({ type: s.type, id: s.id.slice(0, 200), ...(typeof s.path === 'string' && s.path ? { path: s.path.slice(0, 1000) } : {}), ...(typeof s.libraryId === 'string' && s.libraryId ? { libraryId: s.libraryId.slice(0, 64) } : {}) }));
    if (src.length) r.sources = src;
  }
  set('yearMin', numIn(x.yearMin, 1000, 3000));
  set('yearMax', numIn(x.yearMax, 1000, 3000));
  set('bpmMin', numIn(x.bpmMin, 20, 300));
  set('bpmMax', numIn(x.bpmMax, 20, 300));
  set('energyMin', numIn(x.energyMin, 0, 1, false));
  set('energyMax', numIn(x.energyMax, 0, 1, false));
  if (x.cleanOnly === true) r.cleanOnly = true;
  set('minRating', numIn(x.minRating, 0, 10, false));
  set('maxDurationSec', numIn(x.maxDurationSec, 10, 6 * 3600));
  return r;
}

export const rulesEmpty = (r: DjRules | null | undefined) => !r || Object.keys(r).length === 0;

/** Normalised presets for the preferences (at most 20). */
export function normalisePresets(v: unknown): UserPreferences['djRules'] | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const x = v as { activePresetId?: unknown; presets?: unknown };
  const seen = new Set<string>();
  const presets: DjRulePreset[] = (Array.isArray(x.presets) ? x.presets : [])
    .filter((p): p is DjRulePreset => !!p && typeof p === 'object')
    .map((p, i) => {
      let id = typeof p.id === 'string' && /^[\w-]{1,64}$/.test(p.id) ? p.id : `preset-${i + 1}`;
      while (seen.has(id)) id = `${id}-${i}`;
      seen.add(id);
      return { id, name: (typeof p.name === 'string' && p.name.trim() ? p.name.trim() : 'My rules').slice(0, 60), rules: normaliseRules(p.rules) };
    })
    .slice(0, 20);
  const active = typeof x.activePresetId === 'string' && presets.some((p) => p.id === x.activePresetId) ? x.activePresetId : null;
  return { activePresetId: active, presets };
}


const CHATTY: HostChattiness[] = ['off', 'intros', 'light', 'chatty'];
const COMMENTARY: YourDjCommentary[] = ['off', 'intros', 'full'];

/** Validate the radio host / Your DJ preferences in place (unknown values dropped). */
export function normaliseHostPrefs(prefs: Partial<UserPreferences>) {
  if (prefs.djRules !== undefined) {
    const r = normalisePresets(prefs.djRules);
    if (r) prefs.djRules = r;
    else delete prefs.djRules;
  }
  if (prefs.radioHost !== undefined) {
    const h = prefs.radioHost as Partial<RadioHostPrefs> | null;
    if (!h || typeof h !== 'object') delete prefs.radioHost;
    else {
      const c = (h.categories ?? {}) as Partial<RadioHostPrefs['categories']>;
      const b = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
      prefs.radioHost = {
        enabled: h.enabled === true,
        chattiness: CHATTY.includes(h.chattiness as HostChattiness) ? (h.chattiness as HostChattiness) : 'light',
        categories: { announce: b(c.announce, true), facts: b(c.facts, true), jokes: b(c.jokes, true), weather: b(c.weather, true), time: b(c.time, true), stats: b(c.stats, true) },
        voice: typeof h.voice === 'string' && h.voice.trim() ? h.voice.trim().slice(0, 200) : null,
      };
    }
  }
  if (prefs.yourDj !== undefined) {
    const y = prefs.yourDj as { commentary?: unknown } | null;
    prefs.yourDj = { commentary: COMMENTARY.includes(y?.commentary as YourDjCommentary) ? (y!.commentary as YourDjCommentary) : 'full' };
  }
}
