import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Item, PluginCatalogEntry, PluginInfo, PluginManifest, PluginRepositoryIndex, User } from '@mediamax/shared';
import { config } from '../config.js';
import { db } from '../db.js';
import { getKv, setKv, getSettings } from './settings.js';
import { bus } from './events.js';
import { logger } from '../util/log.js';
import { badRequest, conflict, HttpError, notFound } from '../util/errors.js';
import { extractTarGz, flattenSingleRoot } from '../util/tar.js';
import { logActivity } from './activity.js';
import type { SubtitleProvider } from './subtitleProviders/types.js';

const log = logger('plugins');
export const pluginsDir = () => {
  const d = path.join(config.dataDir, 'plugins');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

/* ----------------------------- plugin API ---------------------------- */

export type PluginRouteAuth = 'public' | 'user' | 'admin';
export interface PluginRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  user: User | null;
  headers: Record<string, string | string[] | undefined>;
}
export type PluginRouteHandler = (req: PluginRequest) => unknown | Promise<unknown>;

export interface PluginTask {
  id: string;
  name: string;
  description?: string;
  intervalMinutes?: number | null;
  run: (progress: (pct: number) => void) => Promise<void>;
}

/** Fields a metadata provider may return; only unlocked, empty-or-provider-owned fields are applied. */
export interface PluginMetadata {
  overview?: string;
  tagline?: string;
  genres?: string[];
  communityRating?: number;
  contentRating?: string;
  posterUrl?: string;
  backdropUrl?: string;
  logoUrl?: string;
  externalIds?: Record<string, string>;
}
export interface MetadataProvider {
  name: string;
  types: ('movie' | 'show' | 'episode' | 'album' | 'artist' | 'audiobook')[];
  fetch: (item: Pick<Item, 'id' | 'type' | 'title' | 'year' | 'externalIds'> & { parentTitle: string | null; index: number | null; parentIndex: number | null }) => Promise<PluginMetadata | null>;
}

/** A subtitle source (see services/subtitleProviders/types.ts for the full contract). */
export type PluginSubtitleProvider = SubtitleProvider;

export interface PluginContext {
  id: string;
  version: string;
  serverVersion: string;
  dataDir: string;
  log: { debug(m: string): void; info(m: string): void; warn(m: string): void; error(m: string, e?: unknown): void };
  settings: { get<T = unknown>(key: string): T; all(): Record<string, unknown>; onChange(cb: (all: Record<string, unknown>) => void): void };
  storage: { get<T = unknown>(key: string, fallback?: T): T; set(key: string, value: unknown): void; delete(key: string): void };
  events: { on(event: string, handler: (payload: any) => void | Promise<void>): void };
  http: { route(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', routePath: string, handler: PluginRouteHandler, opts?: { auth?: PluginRouteAuth }): void };
  tasks: { register(task: PluginTask): void };
  metadata: { registerProvider(p: MetadataProvider): void };
  subtitles: { registerProvider(p: PluginSubtitleProvider): void };
  library: {
    getItem(id: string): Item | null;
    search(query: string, limit?: number): Item[];
  };
}

interface Loaded {
  manifest: PluginManifest;
  dir: string;
  routes: { method: string; parts: string[]; handler: PluginRouteHandler; auth: PluginRouteAuth }[];
  listeners: { event: string; fn: (p: any) => void }[];
  tasks: PluginTask[];
  providers: MetadataProvider[];
  subtitleProviders: SubtitleProvider[];
  settingsCbs: ((all: Record<string, unknown>) => void)[];
  deactivate?: () => unknown;
}

interface PluginState {
  enabled: boolean;
  source: PluginInfo['source'];
  repository: string | null;
  installedAt: string;
  settings: Record<string, unknown>;
}

const loaded = new Map<string, Loaded>();
const errors = new Map<string, string>();

const stateKey = (id: string) => `plugin:${id}`;
const getState = (id: string): PluginState | null => getKv<PluginState | null>(stateKey(id), null);
const setState = (id: string, s: PluginState) => setKv(stateKey(id), s);

const ID_RE = /^[a-z0-9][a-z0-9._-]{2,99}$/;

export function readManifest(dir: string): PluginManifest {
  const file = path.join(dir, 'plugin.json');
  if (!fs.existsSync(file)) throw badRequest('Plugin package has no plugin.json');
  let m: PluginManifest;
  try {
    m = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw badRequest('plugin.json is not valid JSON');
  }
  if (!m.id || !ID_RE.test(m.id)) throw badRequest('Plugin id must be lowercase letters, digits, dots, dashes (3-100 chars)');
  if (!m.name || !m.version || !m.main) throw badRequest('plugin.json needs name, version and main');
  const main = path.resolve(dir, m.main);
  if (!main.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(main)) throw badRequest(`Plugin entry "${m.main}" not found`);
  return m;
}

/** Compare dotted versions ("1.10.0" > "1.9.3"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

function settingValues(m: PluginManifest, stored: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of m.settings ?? []) out[s.key] = s.key in stored ? stored[s.key] : s.default ?? null;
  return out;
}

function makeContext(m: PluginManifest, dir: string, l: Loaded): PluginContext {
  const plog = logger(`plugin:${m.id}`);
  const kvKey = (k: string) => `pluginkv:${m.id}:${k}`;
  // Lazy imports avoid a cycle at module load.
  return {
    id: m.id,
    version: m.version,
    serverVersion: config.version,
    dataDir: (() => {
      const d = path.join(config.dataDir, 'plugin-data', m.id);
      fs.mkdirSync(d, { recursive: true });
      return d;
    })(),
    log: { debug: (x) => plog.debug(x), info: (x) => plog.info(x), warn: (x) => plog.warn(x), error: (x, e) => plog.error(x, e) },
    settings: {
      get: <T,>(key: string) => settingValues(m, getState(m.id)?.settings ?? {})[key] as T,
      all: () => settingValues(m, getState(m.id)?.settings ?? {}),
      onChange: (cb) => l.settingsCbs.push(cb),
    },
    storage: {
      get: <T,>(key: string, fallback?: T) => getKv<T>(kvKey(key), fallback as T),
      set: (key, value) => setKv(kvKey(key), value),
      delete: (key) => db.run('DELETE FROM settings WHERE key = ?', kvKey(key)),
    },
    events: {
      on: (event, handler) => {
        const fn = (payload: any) => {
          try {
            const r = handler(payload);
            if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch((e) => plog.warn(`event ${event} handler failed: ${(e as Error).message}`));
          } catch (e) {
            plog.warn(`event ${event} handler failed: ${(e as Error).message}`);
          }
        };
        bus.on(event, fn);
        l.listeners.push({ event, fn });
      },
    },
    http: {
      route: (method, routePath, handler, opts) => {
        const parts = routePath.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
        if (parts[0] === 'ui') throw new Error('Route paths starting with "ui" are reserved');
        l.routes.push({ method, parts, handler, auth: opts?.auth ?? 'user' });
      },
    },
    tasks: { register: (t) => l.tasks.push({ ...t, id: `${m.id}:${t.id}` }) },
    metadata: { registerProvider: (p) => l.providers.push(p) },
    subtitles: {
      registerProvider: (p) => {
        if (!p || typeof p.search !== 'function' || typeof p.download !== 'function') throw new Error('A subtitle provider needs search() and download()');
        const localId = String(p.id ?? '').trim();
        if (!/^[\w.-]{1,60}$/.test(localId)) throw new Error('Subtitle provider id must be 1-60 letters, digits, dots, dashes or underscores');
        // Namespaced by plugin id so two plugins can't collide (or shadow a built-in provider).
        l.subtitleProviders.push({
          id: `${m.id}:${localId}`,
          name: String(p.name || localId).slice(0, 80),
          configured: () => (typeof p.configured === 'function' ? !!p.configured() : true),
          search: (q) => Promise.resolve(p.search(q)),
          download: (r) => Promise.resolve(p.download(r)).then((f) => {
            if (!f || !Buffer.isBuffer(f.data) && !((f.data as unknown) instanceof Uint8Array)) throw new Error(`${p.name} download() must return { data: Buffer, fileName }`);
            return { data: Buffer.from(f.data), fileName: String(f.fileName ?? `${r.id}.srt`) };
          }),
        });
      },
    },
    library: {
      getItem: (id) => {
        const u = systemUser();
        if (!u) return null;
        try {
          return itemsApi!.getItem(u, id, false);
        } catch {
          return null;
        }
      },
      search: (q, limit = 20) => {
        const u = systemUser();
        return u ? itemsApi!.searchItems(u, q, limit) : [];
      },
    },
  };
}

/** Plugins read the library as the first administrator. */
function systemUser(): User | null {
  const r = db.get('SELECT id FROM users WHERE is_admin = 1 AND disabled = 0 ORDER BY created_at LIMIT 1');
  return r ? authApi!.getUser(r.id) : null;
}
let itemsApi: typeof import('./items.js') | null = null;
let authApi: typeof import('./auth.js') | null = null;

async function activate(id: string): Promise<void> {
  const dir = path.join(pluginsDir(), id);
  // Never run two copies: tear down any previous activation first (prevents leaked event listeners).
  await deactivate(id);
  errors.delete(id);
  let manifest: PluginManifest;
  try {
    manifest = readManifest(dir);
  } catch (e) {
    errors.set(id, (e as Error).message);
    return;
  }
  if (manifest.minServerVersion && compareVersions(config.version, manifest.minServerVersion) < 0) {
    errors.set(id, `Needs Kinora ${manifest.minServerVersion} or newer`);
    return;
  }
  itemsApi ??= await import('./items.js');
  authApi ??= await import('./auth.js');
  const l: Loaded = { manifest, dir, routes: [], listeners: [], tasks: [], providers: [], subtitleProviders: [], settingsCbs: [] };
  try {
    // Cache-bust so updates/re-enables load fresh code.
    const mod = await import(`${pathToFileURL(path.resolve(dir, manifest.main)).href}?v=${Date.now()}`);
    const activateFn = mod.activate ?? mod.default?.activate ?? mod.default;
    if (typeof activateFn !== 'function') throw new Error('Plugin entry must export an activate(ctx) function');
    l.deactivate = mod.deactivate ?? mod.default?.deactivate;
    await Promise.race([
      Promise.resolve(activateFn(makeContext(manifest, dir, l))),
      new Promise((_, rej) => setTimeout(() => rej(new Error('activate() timed out after 15s')), 15000)),
    ]);
    loaded.set(id, l);
    log.info(`Plugin ${manifest.name} ${manifest.version} activated`);
  } catch (e) {
    for (const { event, fn } of l.listeners) bus.off(event, fn);
    errors.set(id, (e as Error).message);
    log.error(`Plugin ${id} failed to activate`, e);
  }
}

async function deactivate(id: string) {
  const l = loaded.get(id);
  if (!l) return;
  loaded.delete(id);
  for (const { event, fn } of l.listeners) bus.off(event, fn);
  try {
    await Promise.race([Promise.resolve(l.deactivate?.()), new Promise((r) => setTimeout(r, 5000))]);
  } catch (e) {
    log.warn(`Plugin ${id} deactivate() failed: ${(e as Error).message}`);
  }
}

export async function loadAll() {
  for (const id of fs.readdirSync(pluginsDir())) {
    if (!fs.statSync(path.join(pluginsDir(), id)).isDirectory() || id.startsWith('.')) continue;
    let st = getState(id);
    if (!st) {
      // Dropped into the folder by hand: register as a local plugin, disabled until an admin enables it.
      st = { enabled: false, source: 'local', repository: null, installedAt: new Date().toISOString(), settings: {} };
      setState(id, st);
    }
    if (st.enabled) await activate(id);
  }
}

/* ----------------------------- admin API ----------------------------- */

const catalogCache: { at: number; entries: PluginCatalogEntry[] } = { at: 0, entries: [] };

function toInfo(id: string, token: string): PluginInfo | null {
  const dir = path.join(pluginsDir(), id);
  let manifest: PluginManifest;
  try {
    manifest = readManifest(dir);
  } catch {
    return null;
  }
  const st = getState(id) ?? { enabled: false, source: 'local' as const, repository: null, installedAt: new Date().toISOString(), settings: {} };
  const values = settingValues(manifest, st.settings);
  for (const s of manifest.settings ?? []) if (s.type === 'secret' && values[s.key]) values[s.key] = '••••••••';
  const err = errors.get(id) ?? null;
  const incompatible = manifest.minServerVersion && compareVersions(config.version, manifest.minServerVersion) < 0;
  const latest = catalogCache.entries.find((c) => c.id === id)?.versions.filter((v) => !v.minServerVersion || compareVersions(config.version, v.minServerVersion) >= 0)
    .sort((a, b) => compareVersions(b.version, a.version))[0];
  return {
    manifest,
    status: incompatible ? 'incompatible' : err ? 'error' : loaded.has(id) ? 'active' : 'disabled',
    error: err,
    settings: values as PluginInfo['settings'],
    source: st.source,
    repository: st.repository,
    installedAt: st.installedAt,
    updateAvailable: latest && compareVersions(latest.version, manifest.version) > 0 ? latest.version : null,
    // UI files are served relative to the admin page's folder.
    adminPageUrl: manifest.adminPage ? `/api/v1/plugins/${id}/ui/${path.basename(manifest.adminPage)}?token=${encodeURIComponent(token)}` : null,
  };
}

export function listPlugins(token: string): PluginInfo[] {
  return fs.readdirSync(pluginsDir()).filter((d) => !d.startsWith('.') && fs.statSync(path.join(pluginsDir(), d)).isDirectory())
    .map((id) => toInfo(id, token)).filter((x): x is PluginInfo => !!x).sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

export async function setEnabled(id: string, enabled: boolean, actor: User, token: string): Promise<PluginInfo> {
  const st = getState(id);
  if (!st || !fs.existsSync(path.join(pluginsDir(), id))) throw notFound('Plugin not installed');
  setState(id, { ...st, enabled });
  if (enabled) await activate(id);
  else await deactivate(id);
  logActivity('plugin', `Plugin ${id} ${enabled ? 'enabled' : 'disabled'}`, { userId: actor.id, userName: actor.displayName });
  return toInfo(id, token)!;
}

export async function updateSettings(id: string, values: Record<string, unknown>, token: string): Promise<PluginInfo> {
  const st = getState(id);
  if (!st) throw notFound('Plugin not installed');
  const manifest = readManifest(path.join(pluginsDir(), id));
  const next = { ...st.settings };
  for (const s of manifest.settings ?? []) {
    if (!(s.key in values)) continue;
    let v = values[s.key];
    if (s.type === 'secret' && v === '••••••••') continue;
    if (s.type === 'number') v = v === '' || v == null ? null : Number(v);
    if (s.type === 'boolean') v = v === true || v === 'true';
    if (s.type === 'select' && v != null && !(s.options ?? []).some((o) => o.value === v)) throw badRequest(`Invalid value for ${s.label}`);
    if (typeof v === 'string') v = v.slice(0, 10000);
    next[s.key] = v;
  }
  setState(id, { ...st, settings: next });
  const l = loaded.get(id);
  if (l) for (const cb of l.settingsCbs) {
    try {
      cb(settingValues(manifest, next));
    } catch (e) {
      log.warn(`Plugin ${id} settings callback failed: ${(e as Error).message}`);
    }
  }
  return toInfo(id, token)!;
}

async function installFromArchive(buf: Buffer, source: PluginInfo['source'], repository: string | null, expectedId?: string): Promise<string> {
  const tmp = path.join(pluginsDir(), `.tmp-${crypto.randomBytes(6).toString('hex')}`);
  try {
    extractTarGz(buf, tmp);
    flattenSingleRoot(tmp);
    const manifest = readManifest(tmp);
    if (expectedId && manifest.id !== expectedId) throw badRequest(`Package contains "${manifest.id}", expected "${expectedId}"`);
    const dest = path.join(pluginsDir(), manifest.id);
    const prev = getState(manifest.id);
    const wasEnabled = prev?.enabled ?? false;
    await deactivate(manifest.id);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
    setState(manifest.id, { enabled: wasEnabled, source, repository, installedAt: new Date().toISOString(), settings: prev?.settings ?? {} });
    if (wasEnabled) await activate(manifest.id);
    return manifest.id;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function installUpload(buf: Buffer, actor: User, token: string): Promise<PluginInfo> {
  const id = await installFromArchive(buf, 'upload', null);
  logActivity('plugin', `Plugin ${id} installed from upload`, { userId: actor.id, userName: actor.displayName, severity: 'warning' });
  return toInfo(id, token)!;
}

export async function installFromCatalog(id: string, version: string | undefined, actor: User, token: string): Promise<PluginInfo> {
  const entries = await catalog(true);
  const entry = entries.find((e) => e.id === id);
  if (!entry) throw notFound('Plugin not found in any configured repository');
  const compatible = entry.versions.filter((v) => !v.minServerVersion || compareVersions(config.version, v.minServerVersion) >= 0).sort((a, b) => compareVersions(b.version, a.version));
  const v = version ? compatible.find((x) => x.version === version) : compatible[0];
  if (!v) throw conflict('No version of this plugin is compatible with this server');
  if (!/^https:\/\//i.test(v.url) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(v.url)) throw badRequest('Plugin packages must be downloaded over https');
  const res = await fetch(v.url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new HttpError(502, `Download failed (HTTP ${res.status})`, 'download_failed');
  const buf = Buffer.from(await res.arrayBuffer());
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  if (hash.toLowerCase() !== String(v.sha256).toLowerCase()) throw new HttpError(400, 'Checksum mismatch: the downloaded package does not match the repository', 'checksum');
  const installed = await installFromArchive(buf, 'repository', entry.repository, id);
  logActivity('plugin', `Plugin ${entry.name} ${v.version} installed from ${entry.repository}`, { userId: actor.id, userName: actor.displayName });
  return toInfo(installed, token)!;
}

export async function uninstall(id: string, actor: User) {
  if (!fs.existsSync(path.join(pluginsDir(), id))) throw notFound('Plugin not installed');
  await deactivate(id);
  fs.rmSync(path.join(pluginsDir(), id), { recursive: true, force: true });
  db.run('DELETE FROM settings WHERE key = ? OR key LIKE ?', stateKey(id), `pluginkv:${id}:%`);
  errors.delete(id);
  logActivity('plugin', `Plugin ${id} uninstalled`, { userId: actor.id, userName: actor.displayName });
}

export async function catalog(force = false): Promise<PluginCatalogEntry[]> {
  if (!force && Date.now() - catalogCache.at < 10 * 60000) return withInstalled(catalogCache.entries);
  const entries: PluginCatalogEntry[] = [];
  for (const repo of getSettings().plugins.repositories) {
    try {
      if (!/^https:\/\//i.test(repo) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(repo)) throw new Error('repository must use https');
      const res = await fetch(repo, { signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const idx = (await res.json()) as PluginRepositoryIndex;
      for (const p of idx.plugins ?? []) {
        if (!p.id || !ID_RE.test(p.id) || entries.some((e) => e.id === p.id)) continue;
        entries.push({ ...p, repository: repo, installedVersion: null, versions: (p.versions ?? []).filter((v) => v.url && v.sha256 && v.version) });
      }
    } catch (e) {
      log.warn(`Plugin repository ${repo} unavailable: ${(e as Error).message}`);
    }
  }
  catalogCache.at = Date.now();
  catalogCache.entries = entries;
  return withInstalled(entries);
}

function withInstalled(entries: PluginCatalogEntry[]): PluginCatalogEntry[] {
  return entries.map((e) => {
    let installedVersion: string | null = null;
    try {
      installedVersion = readManifest(path.join(pluginsDir(), e.id)).version;
    } catch {
      /* not installed */
    }
    return { ...e, installedVersion };
  });
}

/* ------------------------- integration points ------------------------ */

export const pluginTasks = (): PluginTask[] => [...loaded.values()].flatMap((l) => l.tasks);
export const metadataProviders = (): MetadataProvider[] => [...loaded.values()].flatMap((l) => l.providers);
export const pluginSubtitleProviders = (): SubtitleProvider[] => [...loaded.values()].flatMap((l) => l.subtitleProviders);

export function findRoute(id: string, method: string, subPath: string): { handler: PluginRouteHandler; auth: PluginRouteAuth; params: Record<string, string> } | null {
  const l = loaded.get(id);
  if (!l) return null;
  const parts = subPath.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  for (const r of l.routes) {
    if (r.method !== method || r.parts.length !== parts.length) continue;
    const params: Record<string, string> = {};
    if (r.parts.every((p, i) => (p.startsWith(':') ? ((params[p.slice(1)] = decodeURIComponent(parts[i])), true) : p === parts[i]))) return { handler: r.handler, auth: r.auth, params };
  }
  return null;
}

export function pluginUiFile(id: string, rel: string): string | null {
  const l = loaded.get(id);
  if (!l || !l.manifest.adminPage) return null;
  const uiRoot = path.resolve(l.dir, path.dirname(l.manifest.adminPage));
  const file = path.resolve(uiRoot, rel);
  if (!file.startsWith(uiRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return file;
}

/** Ask metadata provider plugins to fill gaps for an item (after the built-in providers). */
export async function applyPluginMetadata(itemId: string) {
  const providers = metadataProviders();
  if (!providers.length) return;
  const row = db.get('SELECT i.*, p.title p_title FROM items i LEFT JOIN items p ON p.id = i.parent_id WHERE i.id = ?', itemId);
  if (!row) return;
  const locked = new Set<string>(JSON.parse(row.locked_fields || '[]'));
  const { registerImage } = await import('./images.js');
  for (const p of providers.filter((x) => x.types.includes(row.type))) {
    try {
      const m = await Promise.race([
        p.fetch({ id: row.id, type: row.type, title: row.title, year: row.year, externalIds: JSON.parse(row.external_ids || '{}'), parentTitle: row.p_title ?? null, index: row.idx, parentIndex: row.parent_idx }),
        new Promise<null>((r) => setTimeout(() => r(null), 20000)),
      ]);
      if (!m) continue;
      const patch: Record<string, unknown> = {};
      const fill = (field: string, col: string, v: unknown) => {
        if (v == null || locked.has(field) || (row[col] != null && row[col] !== '' && row[col] !== '[]')) return;
        patch[col] = Array.isArray(v) ? JSON.stringify(v) : v;
      };
      fill('overview', 'overview', m.overview);
      fill('tagline', 'tagline', m.tagline);
      fill('genres', 'genres', m.genres);
      fill('communityRating', 'community_rating', m.communityRating);
      fill('contentRating', 'content_rating', m.contentRating);
      if (m.posterUrl) fill('poster', 'poster', registerImage(m.posterUrl));
      if (m.backdropUrl) fill('backdrop', 'backdrop', registerImage(m.backdropUrl));
      if (m.logoUrl) fill('logo', 'logo', registerImage(m.logoUrl));
      if (m.externalIds) patch.external_ids = JSON.stringify({ ...m.externalIds, ...JSON.parse(row.external_ids || '{}') });
      if (Object.keys(patch).length) {
        db.update('items', itemId, patch);
        Object.assign(row, patch);
      }
    } catch (e) {
      log.warn(`Metadata provider ${p.name} failed for ${row.title}: ${(e as Error).message}`);
    }
  }
}
