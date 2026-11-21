import type { CSSProperties } from 'react';
import type { Branding, Theme, ThemeColors } from '@mediamax/shared';
import { DEFAULT_THEME, LUMEN_DISPLAY } from './defaults';

const CARD_WIDTHS = { small: 128, medium: 164, large: 212 } as const;

const COLOR_VARS: Record<keyof ThemeColors, string> = {
  primary: '--c-primary',
  primaryText: '--c-primary-text',
  background: '--c-bg',
  surface: '--c-surface',
  surfaceAlt: '--c-surface-alt',
  text: '--c-text',
  textMuted: '--c-text-muted',
  accent: '--c-accent',
  border: '--c-border',
  success: '--c-success',
  warning: '--c-warning',
  danger: '--c-danger',
  overlay: '--c-overlay',
};

export const COLOR_KEYS = Object.keys(COLOR_VARS) as (keyof ThemeColors)[];

export function posterRadius(theme: Theme): string {
  switch (theme.posterShape) {
    case 'square':
      return '2px';
    case 'pill':
      return `${Math.max(18, theme.radius * 2)}px`;
    default:
      return `${theme.radius}px`;
  }
}

/**
 * Headings use the Lumen display face (Bricolage Grotesque) when the theme uses the Lumen text face (Figtree) or the
 * old generic defaults; a theme with a font of its own (Playfair for Film Noir, Baloo for kids…) keeps it for headings.
 */
export function displayFont(font: string): string {
  return /^\s*'?(Figtree|Inter|Plus Jakarta Sans)\b/i.test(font) ? LUMEN_DISPLAY : font;
}

/** Compute the CSS custom properties for a theme. */
export function themeVars(theme: Theme): Record<string, string> {
  const t = { ...DEFAULT_THEME, ...theme, colors: { ...DEFAULT_THEME.colors, ...theme.colors } };
  const vars: Record<string, string> = {};
  for (const key of COLOR_KEYS) vars[COLOR_VARS[key]] = t.colors[key];
  vars['--radius'] = `${t.radius}px`;
  vars['--radius-sm'] = `${Math.max(2, Math.round(t.radius * 0.6))}px`;
  vars['--radius-lg'] = `${Math.round(t.radius * 1.6)}px`;
  vars['--poster-radius'] = posterRadius(t);
  vars['--card-w'] = `${CARD_WIDTHS[t.cardSize] ?? CARD_WIDTHS.medium}px`;
  vars['--font'] = t.fontFamily || DEFAULT_THEME.fontFamily;
  vars['--font-display'] = displayFont(vars['--font']);
  return vars;
}

export function themeStyle(theme: Theme): CSSProperties {
  return themeVars(theme) as unknown as CSSProperties;
}

const loadedFonts = new Set<string>();
export function loadFont(url: string | null | undefined) {
  if (!url || loadedFonts.has(url)) return;
  loadedFonts.add(url);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = url;
  link.dataset.mmFont = '1';
  document.head.appendChild(link);
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  const vars = themeVars(theme);
  for (const [k, v] of Object.entries(vars)) {
    // Card width goes through --card-w-theme so responsive CSS can scale it.
    root.style.setProperty(k === '--card-w' ? '--card-w-theme' : k, v);
  }
  root.dataset.mode = theme.mode;
  root.dataset.posterShape = theme.posterShape;
  root.dataset.cardSize = theme.cardSize;
  root.style.colorScheme = theme.mode;
  loadFont(theme.fontUrl);
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = theme.colors.background;
}

export function applyCustomCss(css: string) {
  let el = document.getElementById('mm-custom-css') as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = 'mm-custom-css';
    document.head.appendChild(el);
  }
  el.textContent = css || '';
}

export function applyBrandingChrome(b: Branding) {
  document.title = b.serverName || 'MediaMax';
  const href = b.faviconUrl || b.appIconUrl || b.logoUrl;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = href ? `${href}${href.includes('?') ? '&' : '?'}rev=${b.revision}` : '/favicon.svg';
  let apple = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
  if (b.appIconUrl) {
    if (!apple) {
      apple = document.createElement('link');
      apple.rel = 'apple-touch-icon';
      document.head.appendChild(apple);
    }
    apple.href = b.appIconUrl;
  }
}

export function resolveTheme(b: Branding, userThemeId: string | null | undefined): Theme {
  const themes = b.themes?.length ? b.themes : [DEFAULT_THEME];
  if (b.allowUserThemes && userThemeId) {
    const t = themes.find((x) => x.id === userThemeId);
    if (t) return t;
  }
  return themes.find((x) => x.id === b.defaultThemeId) ?? themes[0];
}
