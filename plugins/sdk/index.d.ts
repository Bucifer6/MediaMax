/**
 * MediaMax plugin SDK — type definitions for plugin authors.
 *
 * A plugin is a folder (packaged as .tar.gz) with a `plugin.json` manifest and an ES module entry that
 * exports `activate(ctx)` (and optionally `deactivate()`). Plugins run inside the server process with
 * full trust — the same model as Jellyfin and Emby — so admins should only install plugins they trust.
 *
 *   export async function activate(ctx) {
 *     ctx.events.on('playback.start', (s) => ctx.log.info(`${s.ctx.user.displayName} started ${s.title}`));
 *     ctx.http.route('GET', '/hello', () => ({ hello: 'world' }), { auth: 'user' }); // → GET /api/v1/plugins/<id>/hello
 *   }
 */
import type { Item, PluginManifest, User } from '../../shared/src/types';

export type { PluginManifest };

export interface PluginRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  /** Signed-in user, or null for `auth: 'public'` routes called anonymously. */
  user: User | null;
  headers: Record<string, string | string[] | undefined>;
}

export interface PluginTask {
  id: string;
  name: string;
  description?: string;
  /** Run automatically every N minutes (omit for manual-only). */
  intervalMinutes?: number | null;
  run(progress: (percent: number) => void): Promise<void>;
}

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
  /** Return fields to fill. Only empty, unlocked fields are written. */
  fetch(item: Pick<Item, 'id' | 'type' | 'title' | 'year' | 'externalIds'> & { parentTitle: string | null; index: number | null; parentIndex: number | null }): Promise<PluginMetadata | null>;
}

/** Server events plugins can listen to (payload shapes follow the webhook payloads). */
export type PluginEvent =
  | 'playback.start' | 'playback.pause' | 'playback.resume' | 'playback.stop' | 'playback.scrobble'
  | 'library.new' | 'library.updated' | 'items.played' | 'user.login'
  | 'recording.completed' | 'recording.failed' | 'request.created' | 'request.updated' | 'request.available'
  | 'epg.refreshed';

export interface PluginContext {
  id: string;
  version: string;
  serverVersion: string;
  /** Private writable folder for this plugin. */
  dataDir: string;
  log: { debug(m: string): void; info(m: string): void; warn(m: string): void; error(m: string, e?: unknown): void };
  /** Values of the settings declared in plugin.json (edited by admins in the dashboard). */
  settings: { get<T = unknown>(key: string): T; all(): Record<string, unknown>; onChange(cb: (all: Record<string, unknown>) => void): void };
  /** Small persistent key/value store. */
  storage: { get<T = unknown>(key: string, fallback?: T): T; set(key: string, value: unknown): void; delete(key: string): void };
  events: { on(event: PluginEvent | string, handler: (payload: any) => void | Promise<void>): void };
  /** Routes are mounted at /api/v1/plugins/<id>/<path>; `:param` segments are supported. Default auth: 'user'. */
  http: { route(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, handler: (req: PluginRequest) => unknown | Promise<unknown>, opts?: { auth?: 'public' | 'user' | 'admin' }): void };
  /** Tasks appear in Admin → Scheduled tasks. */
  tasks: { register(task: PluginTask): void };
  metadata: { registerProvider(provider: MetadataProvider): void };
  /** Read-only library access (as the server's first administrator). */
  library: { getItem(id: string): Item | null; search(query: string, limit?: number): Item[] };
}

export type ActivateFn = (ctx: PluginContext) => void | Promise<void>;
