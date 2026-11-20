import type { Theme } from '@mediamax/shared';

const base = { radius: 12, fontFamily: "'Inter', system-ui, -apple-system, Segoe UI, Roboto, sans-serif", fontUrl: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap', posterShape: 'rounded', cardSize: 'medium', heroStyle: 'carousel', builtIn: true } as const;

/** Built-in theme presets. Admins can duplicate and edit them in the Branding Studio. */
export const BUILTIN_THEMES: Theme[] = [
  {
    ...base, id: 'midnight', name: 'Midnight', mode: 'dark',
    colors: { primary: '#7c5cff', primaryText: '#ffffff', background: '#0b0c10', surface: '#15171e', surfaceAlt: '#1e212b', text: '#f4f5f8', textMuted: '#9aa0ae', accent: '#22d3ee', border: '#2a2e3a', success: '#22c55e', warning: '#f59e0b', danger: '#ef4444', overlay: '#0b0c10' },
  },
  {
    ...base, id: 'cinema', name: 'Cinema Gold', mode: 'dark',
    colors: { primary: '#e5a00d', primaryText: '#111111', background: '#121212', surface: '#1c1c1c', surfaceAlt: '#262626', text: '#f2f2f2', textMuted: '#a3a3a3', accent: '#f97316', border: '#333333', success: '#4ade80', warning: '#facc15', danger: '#f87171', overlay: '#121212' },
  },
  {
    ...base, id: 'oceanic', name: 'Oceanic', mode: 'dark',
    colors: { primary: '#00a4dc', primaryText: '#ffffff', background: '#101820', surface: '#17222d', surfaceAlt: '#1f2e3c', text: '#eef6fb', textMuted: '#8fa6b8', accent: '#aa5cc3', border: '#273a4b', success: '#34d399', warning: '#fbbf24', danger: '#fb7185', overlay: '#101820' },
  },
  {
    ...base, id: 'crimson', name: 'Crimson', mode: 'dark', heroStyle: 'carousel',
    colors: { primary: '#e50914', primaryText: '#ffffff', background: '#0a0a0a', surface: '#161616', surfaceAlt: '#222222', text: '#ffffff', textMuted: '#b3b3b3', accent: '#ff6b6b', border: '#2b2b2b', success: '#46d369', warning: '#f5c518', danger: '#ff4d4f', overlay: '#0a0a0a' },
  },
  {
    ...base, id: 'emerald', name: 'Emerald', mode: 'dark',
    colors: { primary: '#52b54b', primaryText: '#ffffff', background: '#0d1310', surface: '#151e19', surfaceAlt: '#1d2a23', text: '#effaf2', textMuted: '#93a99a', accent: '#a3e635', border: '#26362d', success: '#4ade80', warning: '#fbbf24', danger: '#f87171', overlay: '#0d1310' },
  },
  {
    ...base, id: 'daylight', name: 'Daylight', mode: 'light',
    colors: { primary: '#4f46e5', primaryText: '#ffffff', background: '#f6f7fb', surface: '#ffffff', surfaceAlt: '#eef0f6', text: '#111827', textMuted: '#6b7280', accent: '#0ea5e9', border: '#e2e5ee', success: '#16a34a', warning: '#d97706', danger: '#dc2626', overlay: '#f6f7fb' },
  },
  {
    ...base, id: 'oled', name: 'Pure OLED', mode: 'dark', radius: 6, posterShape: 'square',
    colors: { primary: '#ffffff', primaryText: '#000000', background: '#000000', surface: '#0a0a0a', surfaceAlt: '#141414', text: '#ffffff', textMuted: '#8a8a8a', accent: '#3b82f6', border: '#1f1f1f', success: '#22c55e', warning: '#eab308', danger: '#ef4444', overlay: '#000000' },
  },
  {
    ...base, id: 'synthwave', name: 'Synthwave', mode: 'dark', radius: 18, posterShape: 'rounded',
    fontFamily: "'Outfit', system-ui, sans-serif", fontUrl: 'https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;800&display=swap',
    colors: { primary: '#ff2e97', primaryText: '#ffffff', background: '#120724', surface: '#1d0e38', surfaceAlt: '#2a1550', text: '#fdf4ff', textMuted: '#b69ad6', accent: '#00f0ff', border: '#3b1f66', success: '#2dffb3', warning: '#ffd319', danger: '#ff4d6d', overlay: '#120724' },
  },
];
