import type { Branding, FeatureFlags, Theme, UserPreferences } from '@mediamax/shared';

export const DEFAULT_THEME: Theme = {
  id: 'midnight',
  name: 'Midnight',
  mode: 'dark',
  colors: {
    primary: '#e5a00d',
    primaryText: '#111111',
    background: '#0b0d12',
    surface: '#151922',
    surfaceAlt: '#1e2430',
    text: '#f4f6fb',
    textMuted: '#9aa3b5',
    accent: '#5b8cff',
    border: '#2a3140',
    success: '#2fbf71',
    warning: '#f5a524',
    danger: '#f04f5a',
    overlay: '#0b0d12',
  },
  radius: 10,
  fontFamily: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  fontUrl: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap',
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
};

export const DEFAULT_BRANDING: Branding = {
  serverName: 'MediaMax',
  tagline: 'Your media. Everywhere.',
  logoUrl: null,
  logoWideUrl: null,
  faviconUrl: null,
  appIconUrl: null,
  loginBackgroundUrl: null,
  loginMessage: '',
  footerText: '',
  supportUrl: null,
  splash: { backgroundColor: '#0b0d12', logoUrl: null },
  defaultThemeId: DEFAULT_THEME.id,
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
