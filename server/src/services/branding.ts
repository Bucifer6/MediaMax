import fs from 'node:fs';
import path from 'node:path';
import type { Branding, BrandingAssetKind, HomeRowConfig, Theme, ThemeSchedule } from '@mediamax/shared';
import { getKv, setKv, getSettings } from './settings.js';
import { BUILTIN_THEMES, DEFAULT_THEME_ID } from './themes.js';
import { db } from '../db.js';
import { config } from '../config.js';
import { events } from './events.js';
import { badRequest, notFound } from '../util/errors.js';
import { newId } from '../util/ids.js';

export const DEFAULT_HOME_ROWS: HomeRowConfig[] = [
  { id: 'hero', type: 'hero', enabled: true, limit: 8 },
  { id: 'continue', type: 'continue', enabled: true, title: 'Continue Watching', limit: 20 },
  { id: 'nextup', type: 'nextup', enabled: true, title: 'Next Up', limit: 20 },
  { id: 'top10', type: 'top10', enabled: true, title: '', limit: 10 },
  { id: 'recommended', type: 'recommended', enabled: true, title: '', limit: 20 },
  { id: 'watchlist', type: 'watchlist', enabled: true, title: 'My List', limit: 20 },
  { id: 'live-now', type: 'live-now', enabled: true, title: 'On Now', limit: 20 },
  { id: 'because', type: 'because', enabled: true, title: '', limit: 20 },
  { id: 'recent', type: 'library-recent', enabled: true, title: '', limit: 20 },
  { id: 'trending', type: 'trending', enabled: true, title: '', limit: 20 },
  { id: 'upcoming', type: 'upcoming', enabled: true, title: '', limit: 20 },
  { id: 'favorites', type: 'favorites', enabled: true, title: 'Your Favourites', limit: 20 },
  { id: 'recordings', type: 'recordings', enabled: true, title: 'Recent Recordings', limit: 20 },
];

interface StoredBranding extends Omit<Branding, 'themes' | 'features' | 'revision' | 'baseThemeId' | 'activeThemeScheduleId'> {
  customThemes: Theme[];
  features: Partial<Branding['features']>;
  revision: number;
}

const DEFAULTS: StoredBranding = {
  serverName: 'MediaMax',
  tagline: 'Your movies, shows, music and live TV. Everywhere.',
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
  defaultThemeId: DEFAULT_THEME_ID,
  themeSchedules: [],
  customThemes: [],
  allowUserThemes: true,
  homeRows: DEFAULT_HOME_ROWS,
  features: {},
  customCss: '',
  revision: 1,
};

const DEFAULT_FEATURES: Branding['features'] = {
  liveTv: true, iptvVod: true, music: true, photos: true, downloads: true, syncPlay: true, dvr: true, profilePicker: true, linkCodes: true, requests: true,
};

/**
 * The MediaMax theme became the default in branding v2. Installs that were already set up keep the
 * theme they had (Midnight, the old default) unless an admin had picked one; new installs get MediaMax.
 * Runs once per database: the marker is written on the first look.
 */
let defaultsChecked = false;
function keepLegacyDefaultTheme() {
  if (defaultsChecked) return;
  defaultsChecked = true;
  if (getKv<number>('branding.defaultsVersion', 0) >= 2) return;
  const s = getKv<Partial<StoredBranding> | null>('branding', null);
  const hasAccounts = !!db.get('SELECT 1 AS x FROM users LIMIT 1');
  if (hasAccounts && !s?.defaultThemeId) setKv('branding', { ...(s ?? {}), defaultThemeId: 'midnight' });
  setKv('branding.defaultsVersion', 2);
}

function stored(): StoredBranding {
  keepLegacyDefaultTheme();
  const s = getKv<Partial<StoredBranding>>('branding', {});
  return { ...DEFAULTS, ...s, splash: { ...DEFAULTS.splash, ...(s.splash ?? {}) } };
}

const MONTH_DAY = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const pad2 = (n: number) => String(n).padStart(2, '0');

/** Whether "MM-DD" `md` falls in an inclusive window; a window ending before it starts wraps the year end. */
export function inDateWindow(md: string, start: string, end: string): boolean {
  return start <= end ? md >= start && md <= end : md >= start || md <= end;
}

/** The first enabled schedule whose window contains `now` (server local date) and whose theme exists. */
export function activeThemeSchedule(schedules: ThemeSchedule[], themes: Theme[], now = new Date()): ThemeSchedule | null {
  const md = `${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  return schedules.find((s) => s.enabled && inDateWindow(md, s.start, s.end) && themes.some((t) => t.id === s.themeId)) ?? null;
}

export function getBranding(now = new Date()): Branding {
  const s = stored();
  const { customThemes, ...rest } = s;
  const themes = [...BUILTIN_THEMES, ...customThemes];
  const baseThemeId = themes.some((t) => t.id === s.defaultThemeId) ? s.defaultThemeId : DEFAULT_THEME_ID;
  const active = activeThemeSchedule(s.themeSchedules ?? [], themes, now);
  return {
    ...rest,
    serverName: s.serverName || getSettings().serverName,
    themes,
    defaultThemeId: active?.themeId ?? baseThemeId,
    baseThemeId,
    themeSchedules: s.themeSchedules ?? [],
    activeThemeScheduleId: active?.id ?? null,
    features: { ...DEFAULT_FEATURES, ...s.features },
  };
}

function validateSchedules(list: unknown): ThemeSchedule[] {
  if (!Array.isArray(list)) throw badRequest('themeSchedules must be a list');
  const seen = new Set<string>();
  return list.slice(0, 50).map((raw) => {
    const x = (raw ?? {}) as Partial<ThemeSchedule>;
    const start = String(x.start ?? '').trim();
    const end = String(x.end ?? '').trim();
    if (!MONTH_DAY.test(start) || !MONTH_DAY.test(end)) throw badRequest('Theme schedule dates must be MM-DD, e.g. 10-20');
    if (typeof x.themeId !== 'string' || !x.themeId) throw badRequest('Theme schedule needs a theme');
    let id = typeof x.id === 'string' && /^[\w-]{1,64}$/.test(x.id) ? x.id : newId();
    if (seen.has(id)) id = newId();
    seen.add(id);
    return { id, name: String(x.name ?? '').trim().slice(0, 60) || 'Seasonal theme', enabled: x.enabled !== false, start, end, themeId: x.themeId };
  });
}

/**
 * Bump the branding revision when a seasonal theme starts or ends, so connected clients refetch it
 * (they refresh on `branding.updated` with a new revision). Called every few minutes by the scheduler.
 */
export function checkThemeSchedule(now = new Date()): boolean {
  const b = getBranding(now);
  const seen = getKv<string | null>('branding.activeSchedule', null);
  if ((b.activeThemeScheduleId ?? null) === seen) return false;
  setKv('branding.activeSchedule', b.activeThemeScheduleId ?? null);
  save(stored());
  return true;
}

function save(next: StoredBranding): Branding {
  next.revision = (next.revision ?? 0) + 1;
  setKv('branding', next);
  const b = getBranding();
  events.broadcast({ type: 'branding.updated', revision: b.revision });
  return b;
}

const HEX = /^#[0-9a-fA-F]{3,8}$/;

function validateTheme(t: Theme): Theme {
  if (!t.name) throw badRequest('Theme name required');
  if (t.mode !== 'dark' && t.mode !== 'light') throw badRequest('Theme mode must be dark or light');
  const base = BUILTIN_THEMES[0];
  const colors = { ...base.colors, ...(t.colors ?? {}) };
  for (const [k, v] of Object.entries(colors)) {
    if (typeof v !== 'string' || !(HEX.test(v) || v.startsWith('rgb') || v.startsWith('hsl'))) throw badRequest(`Invalid colour for ${k}`);
  }
  return {
    id: t.id || newId(),
    name: String(t.name).slice(0, 60),
    mode: t.mode,
    colors,
    radius: Math.max(0, Math.min(40, Number(t.radius ?? 12))),
    fontFamily: t.fontFamily || base.fontFamily,
    fontUrl: t.fontUrl ?? null,
    posterShape: (['rounded', 'square', 'pill'] as const).includes(t.posterShape) ? t.posterShape : 'rounded',
    cardSize: (['small', 'medium', 'large'] as const).includes(t.cardSize) ? t.cardSize : 'medium',
    heroStyle: (['carousel', 'static', 'none'] as const).includes(t.heroStyle) ? t.heroStyle : 'carousel',
    builtIn: false,
  };
}

export function updateBranding(patch: Partial<Branding>): Branding {
  const cur = stored();
  const next: StoredBranding = { ...cur };
  const strFields = ['serverName', 'tagline', 'loginMessage', 'footerText', 'customCss'] as const;
  for (const f of strFields) if (typeof patch[f] === 'string') (next as any)[f] = patch[f];
  const nullableStr = ['supportUrl', 'logoUrl', 'logoWideUrl', 'faviconUrl', 'appIconUrl', 'loginBackgroundUrl', 'tvBannerUrl', 'topShelfUrl'] as const;
  for (const f of nullableStr) if (patch[f] !== undefined) (next as any)[f] = patch[f] || null;
  if (patch.splash) next.splash = { ...cur.splash, ...patch.splash };
  if (patch.baseThemeId) next.defaultThemeId = patch.baseThemeId;
  else if (patch.defaultThemeId) {
    // Clients that echo the branding back send the effective (seasonal) theme: that must not become the default.
    const eff = getBranding();
    if (!(eff.activeThemeScheduleId && patch.defaultThemeId === eff.defaultThemeId && patch.defaultThemeId !== eff.baseThemeId)) next.defaultThemeId = patch.defaultThemeId;
  }
  if (patch.themeSchedules !== undefined) next.themeSchedules = validateSchedules(patch.themeSchedules);
  if (typeof patch.allowUserThemes === 'boolean') next.allowUserThemes = patch.allowUserThemes;
  if (patch.features) next.features = { ...cur.features, ...patch.features };
  if (Array.isArray(patch.homeRows)) {
    next.homeRows = patch.homeRows.map((r) => ({ ...r, id: r.id || newId(), enabled: r.enabled !== false }));
  }
  if (Array.isArray(patch.themes)) {
    // Allow bulk replace of custom themes.
    next.customThemes = patch.themes.filter((t) => !BUILTIN_THEMES.some((b) => b.id === t.id)).map(validateTheme);
  }
  return save(next);
}

export function upsertTheme(theme: Theme, id?: string): Branding {
  const cur = stored();
  if (id && BUILTIN_THEMES.some((b) => b.id === id)) throw badRequest('Built-in themes cannot be edited; duplicate it first');
  const t = validateTheme({ ...theme, id: id ?? (theme.id && !BUILTIN_THEMES.some((b) => b.id === theme.id) ? theme.id : '') });
  const others = cur.customThemes.filter((x) => x.id !== t.id);
  return save({ ...cur, customThemes: [...others, t] });
}

export function deleteTheme(id: string): Branding {
  const cur = stored();
  if (!cur.customThemes.some((t) => t.id === id)) throw notFound('Theme not found');
  return save({ ...cur, customThemes: cur.customThemes.filter((t) => t.id !== id), defaultThemeId: cur.defaultThemeId === id ? DEFAULT_THEME_ID : cur.defaultThemeId });
}

const ASSET_FIELD: Record<BrandingAssetKind, (b: StoredBranding, url: string | null) => void> = {
  logo: (b, u) => (b.logoUrl = u),
  logoWide: (b, u) => (b.logoWideUrl = u),
  favicon: (b, u) => (b.faviconUrl = u),
  appIcon: (b, u) => (b.appIconUrl = u),
  loginBackground: (b, u) => (b.loginBackgroundUrl = u),
  splashLogo: (b, u) => (b.splash = { ...b.splash, logoUrl: u }),
  tvBanner: (b, u) => (b.tvBannerUrl = u),
  topShelf: (b, u) => (b.topShelfUrl = u),
};

const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico', '.gif', '.avif']);

export function saveBrandingAsset(kind: BrandingAssetKind, filename: string, data: Buffer): Branding {
  if (!(kind in ASSET_FIELD)) throw badRequest('Unknown asset kind');
  const ext = path.extname(filename).toLowerCase() || '.png';
  if (!ALLOWED_EXT.has(ext)) throw badRequest('Unsupported image type');
  const name = `${kind}-${Date.now()}${ext}`;
  for (const f of fs.readdirSync(config.assetsDir)) if (f.startsWith(kind + '-')) fs.rmSync(path.join(config.assetsDir, f), { force: true });
  fs.writeFileSync(path.join(config.assetsDir, name), data);
  const cur = stored();
  ASSET_FIELD[kind](cur, `/api/v1/branding/assets/${name}`);
  return save(cur);
}

export function deleteBrandingAsset(kind: BrandingAssetKind): Branding {
  if (!(kind in ASSET_FIELD)) throw badRequest('Unknown asset kind');
  for (const f of fs.readdirSync(config.assetsDir)) if (f.startsWith(kind + '-')) fs.rmSync(path.join(config.assetsDir, f), { force: true });
  const cur = stored();
  ASSET_FIELD[kind](cur, null);
  return save(cur);
}

/** CSS variables for the default theme + custom CSS, for zero-JS embedding. */
export function brandingCss(): string {
  const b = getBranding();
  const t = b.themes.find((x) => x.id === b.defaultThemeId) ?? b.themes[0];
  const vars = Object.entries(t.colors).map(([k, v]) => `  --mm-${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}: ${v};`);
  vars.push(`  --mm-radius: ${t.radius}px;`, `  --mm-font: ${t.fontFamily};`);
  return `${t.fontUrl ? `@import url('${t.fontUrl}');\n` : ''}:root {\n${vars.join('\n')}\n}\n${b.customCss ?? ''}`;
}

/**
 * PWA manifest that follows the branding: the server's name and theme colours, and the uploaded app
 * icon when there is one (else the stock MediaMax icons in the web client, including a maskable one).
 */
export function webManifest() {
  const b = getBranding();
  const t = b.themes.find((x) => x.id === b.defaultThemeId) ?? b.themes[0];
  const icons = b.appIconUrl
    ? [{ src: b.appIconUrl, sizes: '512x512 1024x1024', purpose: 'any' }]
    : [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      ];
  return {
    name: b.serverName || 'MediaMax',
    short_name: (b.serverName || 'MediaMax').slice(0, 12),
    description: b.tagline,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: b.splash.backgroundColor || t.colors.background,
    theme_color: t.colors.background,
    icons,
  };
}
