import Constants from 'expo-constants';
import type { Branding, FeatureFlags, Theme } from '@/api/types';

const primary = (Constants.expoConfig?.extra?.fallbackPrimaryColor as string | undefined) ?? '#D23A72';

/** Dark or white button text, whichever reads better on `hex` (#rrggbb). */
function onColor(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#FFFFFF';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? '#FFFFFF' : '#0B0A1F';
}

/** Used until /branding arrives (and when the server's theme is malformed): the Vibe brand theme. */
export const FALLBACK_THEME: Theme = {
  id: 'mediamax',
  name: 'Vibe',
  mode: 'dark',
  colors: {
    primary,
    primaryText: onColor(primary),
    background: '#0C0C10',
    surface: '#15151B',
    surfaceAlt: '#1D1D25',
    text: '#F2F1F6',
    textMuted: '#B4B2C2',
    accent: '#8C6BFF',
    border: '#2A2A33',
    success: '#3DD68C',
    warning: '#F5B53D',
    danger: '#FF5D6C',
    overlay: '#0C0C10',
  },
  radius: 14,
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
  // Off until the server says otherwise: it needs TMDB plus Radarr/Sonarr configured.
  requests: false,
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
