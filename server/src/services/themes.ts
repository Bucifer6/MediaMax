import type { Theme } from '@mediamax/shared';

/**
 * The Lumen type pairing ships with the web app (self-hosted Figtree text + Bricolage Grotesque display, see
 * web/src/styles/fonts.css), so themes using it need no font URL. Themes with a font of their own keep it; the web
 * app then uses that face for headings too.
 */
export const LUMEN_FONT = "'Figtree Variable', 'Figtree', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

const base = { radius: 12, fontFamily: LUMEN_FONT, fontUrl: null, posterShape: 'rounded', cardSize: 'medium', heroStyle: 'carousel', builtIn: true } as const;

/** Default theme for new installs (existing installs keep what they had; see branding.ts). */
export const DEFAULT_THEME_ID = 'mediamax';

/** Built-in theme presets. Admins can duplicate and edit them in the Branding Studio. */
export const BUILTIN_THEMES: Theme[] = [
  // The Kinora brand themes (default for new installs): mint/teal primary, warm sand accent, the
  // Lumen type pairing. The ids stay 'mediamax' / 'mediamax-light' so existing settings and preferences keep working.
  {
    ...base, id: 'mediamax', name: 'Kinora', mode: 'dark', radius: 14,
    colors: { primary: '#63DEC5', primaryText: '#09251F', background: '#101416', surface: '#191F22', surfaceAlt: '#222B2E', text: '#F2F6F4', textMuted: '#A7B6B1', accent: '#DFBF86', border: '#34423F', success: '#65D39B', warning: '#E9BF6F', danger: '#FF8596', overlay: '#101416' },
  },
  {
    ...base, id: 'mediamax-light', name: 'Kinora Light', mode: 'light', radius: 14,
    colors: { primary: '#137665', primaryText: '#FFFFFF', background: '#F4F8F6', surface: '#FFFFFF', surfaceAlt: '#E5EFEB', text: '#162321', textMuted: '#52655F', accent: '#836126', border: '#D0DFD9', success: '#15803D', warning: '#B45309', danger: '#BF2948', overlay: '#F4F8F6' },
  },
  {
    ...base, id: 'midnight', name: 'Midnight', mode: 'dark',
    colors: { primary: '#6d4aff', primaryText: '#ffffff', background: '#0b0c10', surface: '#15171e', surfaceAlt: '#1e212b', text: '#f4f5f8', textMuted: '#9aa0ae', accent: '#22d3ee', border: '#2a2e3a', success: '#22c55e', warning: '#f59e0b', danger: '#ef4444', overlay: '#0b0c10' },
  },
  {
    ...base, id: 'cinema', name: 'Cinema Gold', mode: 'dark',
    colors: { primary: '#e5a00d', primaryText: '#111111', background: '#121212', surface: '#1c1c1c', surfaceAlt: '#262626', text: '#f2f2f2', textMuted: '#a3a3a3', accent: '#f97316', border: '#333333', success: '#4ade80', warning: '#facc15', danger: '#f87171', overlay: '#121212' },
  },
  {
    ...base, id: 'oceanic', name: 'Oceanic', mode: 'dark',
    colors: { primary: '#00a4dc', primaryText: '#04161f', background: '#101820', surface: '#17222d', surfaceAlt: '#1f2e3c', text: '#eef6fb', textMuted: '#8fa6b8', accent: '#aa5cc3', border: '#273a4b', success: '#34d399', warning: '#fbbf24', danger: '#fb7185', overlay: '#101820' },
  },
  {
    ...base, id: 'crimson', name: 'Crimson', mode: 'dark', heroStyle: 'carousel',
    colors: { primary: '#e50914', primaryText: '#ffffff', background: '#0a0a0a', surface: '#161616', surfaceAlt: '#222222', text: '#ffffff', textMuted: '#b3b3b3', accent: '#ff6b6b', border: '#2b2b2b', success: '#46d369', warning: '#f5c518', danger: '#ff4d4f', overlay: '#0a0a0a' },
  },
  {
    ...base, id: 'emerald', name: 'Emerald', mode: 'dark',
    colors: { primary: '#52b54b', primaryText: '#061305', background: '#0d1310', surface: '#151e19', surfaceAlt: '#1d2a23', text: '#effaf2', textMuted: '#93a99a', accent: '#a3e635', border: '#26362d', success: '#4ade80', warning: '#fbbf24', danger: '#f87171', overlay: '#0d1310' },
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
    colors: { primary: '#ff2e97', primaryText: '#1a0010', background: '#120724', surface: '#1d0e38', surfaceAlt: '#2a1550', text: '#fdf4ff', textMuted: '#b69ad6', accent: '#00f0ff', border: '#3b1f66', success: '#2dffb3', warning: '#ffd319', danger: '#ff4d6d', overlay: '#120724' },
  },
  {
    ...base, id: 'nordic', name: 'Nordic Frost', mode: 'dark', radius: 10,
    colors: { primary: '#88c0d0', primaryText: '#0f141c', background: '#1f2430', surface: '#272e3b', surfaceAlt: '#303849', text: '#eceff4', textMuted: '#a3adbf', accent: '#b48ead', border: '#3a4354', success: '#a3be8c', warning: '#ebcb8b', danger: '#bf616a', overlay: '#1f2430' },
  },
  {
    ...base, id: 'velvet', name: 'Velvet Night', mode: 'dark', radius: 14,
    colors: { primary: '#bd93f9', primaryText: '#16121f', background: '#16141f', surface: '#211e2e', surfaceAlt: '#2b2740', text: '#f8f8f2', textMuted: '#a9a3c4', accent: '#ff79c6', border: '#363150', success: '#50fa7b', warning: '#f1fa8c', danger: '#ff5555', overlay: '#16141f' },
  },
  {
    ...base, id: 'sunset', name: 'Sunset Boulevard', mode: 'dark', radius: 16,
    fontFamily: "'Poppins', system-ui, sans-serif", fontUrl: 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap',
    colors: { primary: '#ff7a45', primaryText: '#1a0d07', background: '#1a1014', surface: '#26171d', surfaceAlt: '#331f27', text: '#fff3ec', textMuted: '#c7a49a', accent: '#ffc857', border: '#3e2830', success: '#6ee7b7', warning: '#fbbf24', danger: '#fb7185', overlay: '#1a1014' },
  },
  {
    ...base, id: 'forest', name: 'Forest Cabin', mode: 'dark', radius: 10,
    fontFamily: "'Nunito Sans', system-ui, sans-serif", fontUrl: 'https://fonts.googleapis.com/css2?family=Nunito+Sans:wght@400;600;800&display=swap',
    colors: { primary: '#c9a227', primaryText: '#141208', background: '#111712', surface: '#18211a', surfaceAlt: '#212c23', text: '#eef3ea', textMuted: '#9fae9f', accent: '#8fbf6a', border: '#2a372c', success: '#86efac', warning: '#facc15', danger: '#f87171', overlay: '#111712' },
  },
  {
    ...base, id: 'arcade', name: 'Retro Arcade', mode: 'dark', radius: 4, posterShape: 'square', cardSize: 'small',
    fontFamily: "'Space Grotesk', system-ui, sans-serif", fontUrl: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&display=swap',
    colors: { primary: '#39ff14', primaryText: '#04110a', background: '#07090c', surface: '#0f1318', surfaceAlt: '#171d24', text: '#e6ffe0', textMuted: '#86a58a', accent: '#ff3cac', border: '#1f2a33', success: '#39ff14', warning: '#ffe600', danger: '#ff3860', overlay: '#07090c' },
  },
  {
    ...base, id: 'noir', name: 'Film Noir', mode: 'dark', radius: 2, posterShape: 'square', heroStyle: 'static',
    fontFamily: "'Playfair Display', Georgia, serif", fontUrl: 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;700;800&display=swap',
    colors: { primary: '#e8e3d9', primaryText: '#0c0c0c', background: '#0c0c0c', surface: '#161616', surfaceAlt: '#202020', text: '#f1ede4', textMuted: '#9c978d', accent: '#c8a96a', border: '#2a2a2a', success: '#9ccf8d', warning: '#d9b45a', danger: '#d46a6a', overlay: '#0c0c0c' },
  },
  {
    ...base, id: 'aurora', name: 'Aurora', mode: 'dark', radius: 20, cardSize: 'large',
    fontFamily: "'Manrope', system-ui, sans-serif", fontUrl: 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;800&display=swap',
    colors: { primary: '#2dd4bf', primaryText: '#03201c', background: '#0a1020', surface: '#121a2e', surfaceAlt: '#1a2440', text: '#eef6ff', textMuted: '#93a3c4', accent: '#a78bfa', border: '#24304d', success: '#34d399', warning: '#fcd34d', danger: '#f472b6', overlay: '#0a1020' },
  },
  {
    ...base, id: 'espresso', name: 'Espresso', mode: 'dark', radius: 12,
    colors: { primary: '#d4a373', primaryText: '#1a120b', background: '#15100c', surface: '#1f1812', surfaceAlt: '#2a2119', text: '#f6eee6', textMuted: '#b4a596', accent: '#e9c46a', border: '#352a21', success: '#90c695', warning: '#e9c46a', danger: '#e76f51', overlay: '#15100c' },
  },
  {
    ...base, id: 'slate', name: 'Slate Pro', mode: 'dark', radius: 8, heroStyle: 'static', cardSize: 'small',
    colors: { primary: '#60a5fa', primaryText: '#06162b', background: '#0f1115', surface: '#171a20', surfaceAlt: '#1f232b', text: '#e5e7eb', textMuted: '#9ca3af', accent: '#f59e0b', border: '#2a2f38', success: '#22c55e', warning: '#f59e0b', danger: '#ef4444', overlay: '#0f1115' },
  },
  {
    ...base, id: 'paper', name: 'Paper White', mode: 'light', radius: 10, heroStyle: 'static',
    fontFamily: "'Source Serif 4', Georgia, serif", fontUrl: 'https://fonts.googleapis.com/css2?family=Source+Serif+4:wght@400;600;700&display=swap',
    colors: { primary: '#1f2937', primaryText: '#ffffff', background: '#fbfaf7', surface: '#ffffff', surfaceAlt: '#f1efe9', text: '#1c1917', textMuted: '#6b6560', accent: '#b45309', border: '#e7e3da', success: '#15803d', warning: '#b45309', danger: '#b91c1c', overlay: '#fbfaf7' },
  },
  {
    ...base, id: 'sakura', name: 'Sakura', mode: 'light', radius: 18,
    fontFamily: "'Quicksand', system-ui, sans-serif", fontUrl: 'https://fonts.googleapis.com/css2?family=Quicksand:wght@500;600;700&display=swap',
    colors: { primary: '#db2777', primaryText: '#ffffff', background: '#fff7fa', surface: '#ffffff', surfaceAlt: '#fdeef4', text: '#3b1d2a', textMuted: '#8a6474', accent: '#7c3aed', border: '#f6dbe6', success: '#16a34a', warning: '#d97706', danger: '#dc2626', overlay: '#fff7fa' },
  },
  {
    ...base, id: 'mint', name: 'Fresh Mint', mode: 'light', radius: 14,
    colors: { primary: '#0f766e', primaryText: '#ffffff', background: '#f3fbf8', surface: '#ffffff', surfaceAlt: '#e6f5ef', text: '#0f2620', textMuted: '#55706a', accent: '#0369a1', border: '#d3ebe2', success: '#15803d', warning: '#b45309', danger: '#b91c1c', overlay: '#f3fbf8' },
  },
  {
    ...base, id: 'kids', name: 'Playground (Kids)', mode: 'light', radius: 24, posterShape: 'pill', cardSize: 'large',
    fontFamily: "'Baloo 2', system-ui, sans-serif", fontUrl: 'https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;600;800&display=swap',
    colors: { primary: '#2563eb', primaryText: '#ffffff', background: '#fffbea', surface: '#ffffff', surfaceAlt: '#fff1c2', text: '#1e293b', textMuted: '#64748b', accent: '#f97316', border: '#fde68a', success: '#16a34a', warning: '#ea580c', danger: '#dc2626', overlay: '#fffbea' },
  },
  {
    ...base, id: 'contrast', name: 'High Contrast', mode: 'dark', radius: 6, posterShape: 'square', cardSize: 'large', heroStyle: 'static',
    fontFamily: "'Atkinson Hyperlegible', system-ui, sans-serif", fontUrl: 'https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&display=swap',
    colors: { primary: '#ffd400', primaryText: '#000000', background: '#000000', surface: '#0d0d0d', surfaceAlt: '#1a1a1a', text: '#ffffff', textMuted: '#d6d6d6', accent: '#00e5ff', border: '#ffffff', success: '#00ff7f', warning: '#ffd400', danger: '#ff6b6b', overlay: '#000000' },
  },
  {
    ...base, id: 'stadium', name: 'Stadium (Sports)', mode: 'dark', radius: 8, heroStyle: 'static',
    fontFamily: "'Barlow', system-ui, sans-serif", fontUrl: 'https://fonts.googleapis.com/css2?family=Barlow:wght@500;600;800&display=swap',
    colors: { primary: '#22c55e', primaryText: '#04130a', background: '#0b0f0c', surface: '#121a14', surfaceAlt: '#1a241c', text: '#f0fdf4', textMuted: '#94a99a', accent: '#facc15', border: '#233026', success: '#22c55e', warning: '#facc15', danger: '#ef4444', overlay: '#0b0f0c' },
  },
  {
    ...base, id: 'festive', name: 'Festive', mode: 'dark', radius: 16,
    fontFamily: "'Poppins', system-ui, sans-serif", fontUrl: 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap',
    colors: { primary: '#d62828', primaryText: '#ffffff', background: '#0e1a14', surface: '#15251c', surfaceAlt: '#1d3226', text: '#fdf6e3', textMuted: '#b6c2b0', accent: '#f4c430', border: '#26402f', success: '#4ade80', warning: '#f4c430', danger: '#ff6b6b', overlay: '#0e1a14' },
  },
];
