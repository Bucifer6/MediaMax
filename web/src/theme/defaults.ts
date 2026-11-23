import type { Branding, FeatureFlags, Theme, UserPreferences } from '@mediamax/shared';

/** The Lumen type pairing, self-hosted in styles/fonts.css (server/src/services/themes.ts LUMEN_FONT). */
export const LUMEN_TEXT = "'Figtree Variable', 'Figtree', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
export const LUMEN_DISPLAY = "'Bricolage Grotesque Variable', 'Figtree Variable', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** Used until the server's branding arrives: the Kinora brand theme (server/src/services/themes.ts). */
export const DEFAULT_THEME: Theme = {
  id: 'mediamax',
  name: 'Kinora',
  mode: 'dark',
  colors: {
    primary: '#63DEC5',
    primaryText: '#09251F',
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
  fontFamily: LUMEN_TEXT,
  fontUrl: null,
  posterShape: 'rounded',
  cardSize: 'medium',
  heroStyle: 'carousel',
  builtIn: true,
};

export const DEFAULT_FEATURES: FeatureFlags = {
  liveTv: true,
  iptvVod: true,
  music: true,
  photos: true,
  downloads: true,
  syncPlay: true,
  dvr: true,
  profilePicker: true,
  linkCodes: true,
  requests: true,
};

export const DEFAULT_BRANDING: Branding = {
  serverName: 'Kinora',
  tagline: 'Your media. Everywhere.',
  logoUrl: null,
  logoWideUrl: null,
  faviconUrl: null,
  appIconUrl: null,
  loginBackgroundUrl: null,
  loginMessage: '',
  footerText: '',
  supportUrl: null,
  splash: { backgroundColor: '#101416', logoUrl: null },
  tvBannerUrl: null,
  topShelfUrl: null,
  defaultThemeId: DEFAULT_THEME.id,
  baseThemeId: DEFAULT_THEME.id,
  themeSchedules: [],
  activeThemeScheduleId: null,
  themes: [DEFAULT_THEME],
  allowUserThemes: true,
  homeRows: [],
  features: DEFAULT_FEATURES,
  customCss: '',
  revision: 0,
};

export const DEFAULT_PREFERENCES: UserPreferences = {
  audioLanguage: null,
  subtitleLanguage: null,
  subtitleMode: 'auto',
  autoplayNext: true,
  skipIntros: false,
  maxBitrate: null,
  themeId: null,
};
