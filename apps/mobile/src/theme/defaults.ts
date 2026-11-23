import Constants from 'expo-constants';
import type { Branding, FeatureFlags, Theme } from '@/api/types';

const primary = (Constants.expoConfig?.extra?.fallbackPrimaryColor as string | undefined) ?? '#63DEC5';

/** Dark or white button text, whichever reads better on `hex` (#rrggbb). */
function onColor(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#FFFFFF';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? '#FFFFFF' : '#09251F';
}

/** Used until /branding arrives (and when the server's theme is malformed): the Kinora brand theme. */
export const FALLBACK_THEME: Theme = {
  id: 'mediamax',
  name: 'Kinora',
  mode: 'dark',
  colors: {
    primary,
    primaryText: onColor(primary),
    background: '#101416',
    surface: '#191F22',
    surfaceAlt: '#222B2E',
    text: '#F2F6F4',
    textMuted: '#A7B6B1',
    accent: '#DFBF86',
    border: '#34423F',
    success: '#65D39B',
    warning: '#E9BF6F',
    danger: '#FF8596',
    overlay: '#101416',
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
