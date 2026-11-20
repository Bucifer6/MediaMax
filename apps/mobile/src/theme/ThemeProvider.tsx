/**
 * Server-driven theme. Everything visual derives from the active `Theme`
 * (branding.defaultThemeId or the user's own pick) so that a branding change
 * pushed over the WebSocket re-themes the whole app instantly.
 */
import * as Font from 'expo-font';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import type { CardSize, PosterShape, Theme, ThemeColors } from '@/api/types';
import { FALLBACK_THEME } from './defaults';
import { isValidColor, withAlpha } from './color';

export interface CardMetrics {
  posterWidth: number;
  posterHeight: number;
  landscapeWidth: number;
  landscapeHeight: number;
  squareSize: number;
  channelWidth: number;
  channelHeight: number;
  gap: number;
}

export interface AppTheme {
  theme: Theme;
  colors: ThemeColors;
  dark: boolean;
  isTV: boolean;
  /** Window size. */
  width: number;
  height: number;
  /** Tablet / large phone in landscape. */
  wide: boolean;
  /** Scale a TV design value (authored for a 1280pt-wide screen); identity on phones. */
  s: (n: number) => number;
  radius: number;
  /** Font family to apply, or undefined for the system font. */
  font: string | undefined;
  fontBold: string | undefined;
  space: { xs: number; sm: number; md: number; lg: number; xl: number; xxl: number; gutter: number };
  text: { hero: number; title: number; heading: number; body: number; small: number; caption: number };
  card: CardMetrics;
  /** Corner radius for a card of the given size, honouring theme.posterShape. */
  shapeRadius: (w: number, h: number) => number;
  /** Translucent overlay colour helpers. */
  alpha: (c: string, a: number) => string;
}

const CARD_WIDTH: Record<'phone' | 'tv', Record<CardSize, number>> = {
  phone: { small: 96, medium: 118, large: 148 },
  tv: { small: 150, medium: 180, large: 220 },
};

function shapeRadiusFor(shape: PosterShape, base: number, w: number, h: number) {
  switch (shape) {
    case 'square':
      return Math.min(3, base);
    case 'pill':
      return Math.min(w, h) / 2;
    case 'rounded':
    default:
      return base;
  }
}

/** Remote fonts: native can only load real font files (ttf/otf), not Google Fonts CSS. */
function useRemoteFont(theme: Theme): string | undefined {
  const [loaded, setLoaded] = useState<Record<string, boolean>>({});
  const family = theme.fontFamily?.split(',')[0]?.replace(/["']/g, '').trim();
  const url = theme.fontUrl ?? null;
  const isFile = !!url && /\.(ttf|otf)(\?|$)/i.test(url);
  useEffect(() => {
    if (!family || !isFile || !url || loaded[family]) return;
    let alive = true;
    Font.loadAsync({ [family]: url })
      .then(() => alive && setLoaded((l) => ({ ...l, [family]: true })))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [family, url, isFile, loaded]);
  if (!family || family.toLowerCase() === 'system' || family.toLowerCase().includes('system-ui')) return undefined;
  // Only use families we actually loaded: an unknown family name errors on iOS.
  return loaded[family] ? family : undefined;
}

const ThemeContext = createContext<AppTheme | null>(null);

export function buildAppTheme(theme: Theme, width: number, height: number, font: string | undefined): AppTheme {
  const isTV = Platform.isTV;
  const colors: ThemeColors = { ...FALLBACK_THEME.colors };
  for (const k of Object.keys(colors) as (keyof ThemeColors)[]) {
    if (isValidColor(theme.colors?.[k])) colors[k] = theme.colors[k];
  }
  const tvScale = isTV ? width / 1280 : 1;
  const s = (n: number) => Math.round(n * tvScale);
  const wide = !isTV && width >= 700;
  const base = isTV ? CARD_WIDTH.tv[theme.cardSize] ?? 180 : CARD_WIDTH.phone[theme.cardSize] ?? 118;
  const posterWidth = isTV ? s(base) : Math.round(base * (wide ? 1.25 : 1));
  const landscapeWidth = Math.round(posterWidth * 1.9);
  const radius = isTV ? s(theme.radius ?? 12) : theme.radius ?? 12;
  const card: CardMetrics = {
    posterWidth,
    posterHeight: Math.round(posterWidth * 1.5),
    landscapeWidth,
    landscapeHeight: Math.round((landscapeWidth * 9) / 16),
    squareSize: Math.round(posterWidth * 1.15),
    channelWidth: Math.round(posterWidth * 1.7),
    channelHeight: Math.round(posterWidth * 1.15),
    gap: isTV ? s(22) : 12,
  };
  return {
    theme,
    colors,
    dark: theme.mode !== 'light',
    isTV,
    width,
    height,
    wide,
    s,
    radius,
    font,
    fontBold: font,
    space: isTV
      ? { xs: s(4), sm: s(8), md: s(16), lg: s(24), xl: s(36), xxl: s(56), gutter: s(56) }
      : { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48, gutter: wide ? 28 : 16 },
    text: isTV
      ? { hero: s(52), title: s(34), heading: s(24), body: s(17), small: s(15), caption: s(13) }
      : { hero: 30, title: 24, heading: 18, body: 15, small: 13, caption: 11 },
    card,
    shapeRadius: (w, h) => shapeRadiusFor(theme.posterShape, radius, w, h),
    alpha: withAlpha,
  };
}

export function ThemeProvider({ theme, children }: { theme: Theme; children: React.ReactNode }) {
  const { width, height } = useWindowDimensions();
  const font = useRemoteFont(theme);
  const value = useMemo(() => buildAppTheme(theme, width, height, font), [theme, width, height, font]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): AppTheme {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme outside ThemeProvider');
  return ctx;
}
