/**
 * AI DJ phase types (Your DJ, Radio Host, DJ rules) from the shared contract, plus small helpers that read the
 * listener's preferences with defaults filled in.
 */
import type {
  DjBreak, DjBreakKind, DjBreakRequest, DjRulePreset, DjRules, DjRulesResponse, DjSegment, DjSegmentKind, DjSession,
  DjSessionRequestMiss, HostChattiness, RadioHostPrefs, UserPreferences, YourDjCommentary,
} from '@mediamax/shared';

export type {
  DjBreak, DjBreakKind, DjBreakRequest, DjRulePreset, DjRules, DjRulesResponse, DjSegment, DjSegmentKind, DjSession,
  DjSessionRequestMiss, HostChattiness, RadioHostPrefs, YourDjCommentary,
};
export type DjBreakPlacement = DjBreak['placement'];
export type DjRequestResult = DjSession | DjSessionRequestMiss;
export type RadioHostCategories = RadioHostPrefs['categories'];
export type DjRulesPrefs = NonNullable<UserPreferences['djRules']>;
export interface DjVoice { id: string; name: string; provider?: string }

/** Radio Host voice preference meaning "always use this device's own speech". */
export const DEVICE_VOICE = 'device';

export const DEFAULT_HOST_CATEGORIES: RadioHostCategories = { announce: true, facts: true, jokes: false, weather: true, time: true, stats: true };
export const DEFAULT_RADIO_HOST: RadioHostPrefs = { enabled: false, chattiness: 'off', categories: DEFAULT_HOST_CATEGORIES, voice: null };

type Prefs = Partial<UserPreferences> | null | undefined;

/** The listener's Radio Host preferences with defaults filled in (off by default). */
export function radioHostPrefs(prefs: Prefs): RadioHostPrefs {
  const p = prefs?.radioHost;
  if (!p) return DEFAULT_RADIO_HOST;
  const chattiness: HostChattiness = p.enabled === false ? 'off' : (p.chattiness ?? 'off');
  return { enabled: chattiness !== 'off', chattiness, categories: { ...DEFAULT_HOST_CATEGORIES, ...(p.categories ?? {}) }, voice: p.voice ?? null };
}
export function yourDjCommentary(prefs: Prefs): YourDjCommentary {
  return prefs?.yourDj?.commentary ?? 'intros';
}
export function djRulesPrefs(prefs: Prefs): DjRulesPrefs {
  const p = prefs?.djRules;
  return { activePresetId: p?.activePresetId ?? null, presets: Array.isArray(p?.presets) ? p!.presets : [] };
}
