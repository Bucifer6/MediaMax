import Constants from 'expo-constants';
import type { Branding, FeatureFlags, Theme } from '@/api/types';

const primary = (Constants.expoConfig?.extra?.fallbackPrimaryColor as string | undefined) ?? '#7C5CFF';

/** Used until /branding arrives (and when the server's theme is malformed). */
export const FALLBACK_THEME: Theme = {
  id: 'mediamax-midnight',
  name: 'Midnight',
  mode: 'dark',
  colors: {
    primary,
    primaryText: '#FFFFFF',
    background: '#0B0B12',
    surface: '#15151F',
    surfaceAlt: '#1F1F2C',
    text: '#F4F4F8',
    textMuted: '#9A9AB0',
    accent: '#22D3EE',
    border: '#2A2A3A',
    success: '#22C55E',
    warning: '#F59E0B',
    danger: '#EF4444',
    overlay: '#0B0B12',
  },
  radius: 12,
  fontFamily: 'System',
  fontUrl: null,
  posterShape: 'rounded',
  cardSize: 'medium',
  heroStyle: 'carousel',
  builtIn: true,
};

export const ALL_FEATURES: FeatureFlags = {
  liveTv: true,
  iptvVod: true,
  music: true,
  photos: true,
  downloads: true,
  syncPlay: false,
  dvr: true,
  profilePicker: true,
  linkCodes: true,
};

export function resolveTheme(branding: Branding | null, userThemeId: string | null | undefined): Theme {
  if (!branding || !branding.themes?.length) return FALLBACK_THEME;
  const pick = (id: string | null | undefined) => (id ? branding.themes.find((t) => t.id === id) : undefined);
  const chosen = (branding.allowUserThemes ? pick(userThemeId) : undefined) ?? pick(branding.defaultThemeId) ?? branding.themes[0];
  // Defensive merge so a partially-specified admin theme never crashes rendering.
  return {
    ...FALLBACK_THEME,
    ...chosen,
    colors: { ...FALLBACK_THEME.colors, ...(chosen.colors ?? {}) },
  };
}
