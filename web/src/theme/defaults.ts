import type { Branding, FeatureFlags, Theme, UserPreferences } from '@mediamax/shared';

/** Used until the server's branding arrives: the MediaMax brand theme (server/src/services/themes.ts). */
export const DEFAULT_THEME: Theme = {
  id: 'mediamax',
  name: 'MediaMax',
  mode: 'dark',
  colors: {
    primary: '#1FB6F5',
    primaryText: '#04101F',
    background: '#0A0F22',
    surface: '#121936',
    surfaceAlt: '#1A2247',
    text: '#F2F5FF',
    textMuted: '#9AA6CC',
    accent: '#E040F0',
    border: '#27315C',
    success: '#2FD07F',
    warning: '#F5B014',
    danger: '#FF5C7A',
    overlay: '#0A0F22',
  },
  radius: 14,
  fontFamily: "'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  fontUrl: 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap',
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
  splash: { backgroundColor: '#0A0F22', logoUrl: null },
  tvBannerUrl: null,
  topShelfUrl: null,
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
