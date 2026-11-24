import type { Branding, FeatureFlags, Theme, UserPreferences } from '@mediamax/shared';

/** The Vibe type pairing, self-hosted in styles/fonts.css (server/src/services/themes.ts LUMEN_FONT). */
export const LUMEN_TEXT = "'Figtree Variable', 'Figtree', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
/** Display face (headings, hero and title-page titles): Outfit. Never for body or small text. */
export const LUMEN_DISPLAY = "'Outfit Variable', 'Figtree Variable', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** Used until the server's branding arrives: the Vibe brand theme (server/src/services/themes.ts). */
export const DEFAULT_THEME: Theme = {
  id: 'mediamax',
  name: 'Vibe Rose',
  mode: 'dark',
  brandGradient: ['#FF8A5C', '#E2498A', '#7C5CFF'],
  colors: {
    primary: '#D23A72',
    primaryText: '#FFFFFF',
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
  fontFamily: LUMEN_TEXT,
  fontUrl: null,
  posterShape: 'rounded',
  cardSize: 'medium',
  heroStyle: 'static',
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
  serverName: 'Vibe',
  tagline: 'Your media. Everywhere.',
  logoUrl: null,
  logoWideUrl: null,
  faviconUrl: null,
  appIconUrl: null,
  loginBackgroundUrl: null,
  loginMessage: '',
  footerText: '',
  supportUrl: null,
  splash: { backgroundColor: '#0C0C10', logoUrl: null },
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
