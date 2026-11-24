/**
 * Vibe plugin SDK — type definitions for plugin authors.
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

/** What Vibe knows about the title a subtitle search is for. */
export interface SubtitleQuery {
  item: { id: string; type: string; title: string; year: number | null };
  media: { id: string; path: string | null; size: number | null } | null;
  /** ISO 639-1 codes, lower case (e.g. ["ro", "en"]). Never empty. */
  languages: string[];
  /** The item's own ids (imdb with its "tt"); for an episode these are often missing. */
  imdbId: string | null;
  tmdbId: string | null;
  /** For episodes: the show's ids and title. */
  showImdbId: string | null;
  showTmdbId: string | null;
  showTitle: string | null;
  season: number | null;
  episode: number | null;
  /** Movie title, or the show title for an episode. */
  title: string;
  year: number | null;
  /** Media file name, e.g. "Show.S01E02.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv" — Vibe scores releases against it. */
  releaseName: string | null;
  /** OpenSubtitles-style movie hash of the media file, when available. */
  movieHash: string | null;
}

export interface SubtitleSearchResult {
  /** Your id for this subtitle; passed back to download(). */
  id: string;
  /** ISO 639-1 where possible ("ro"). */
  language: string;
  /** Release text the subtitle was made for (used for scoring: group, source, resolution, SxxEyy). */
  release: string | null;
  fileName?: string | null;
  downloads?: number;
  hearingImpaired?: boolean;
  forced?: boolean;
  aiTranslated?: boolean;
  rating?: number | null;
  /** You matched the file hash: scored 100. */
  hashMatch?: boolean;
  /** Known archive type of the download ('rar' results are flagged when the server has no unrar/7z). */
  archive?: 'zip' | 'rar' | '7z' | null;
  /** Anything else you need at download time. */
  extra?: Record<string, unknown>;
}

/**
 * A subtitle source. Vibe fans searches out to every enabled provider (admin-ordered in Server settings →
 * Subtitles), scores and merges the results, and runs every download through the same pipeline: archives are
 * unpacked (ZIP built in; RAR/7z with unrar/7z), the right episode is picked from season packs, the text is
 * converted to UTF-8 with diacritics and adverts fixed, optionally synced with alass, then saved.
 */
export interface SubtitleProvider {
  /** Unique within your plugin; stored as "<plugin id>:<id>". */
  id: string;
  name: string;
  /** Return false while credentials are missing (the provider is then skipped). */
  configured?(): boolean;
  search(query: SubtitleQuery): Promise<SubtitleSearchResult[]>;
  /** The subtitle file or an archive (zip/rar/7z) of them; fileName's extension helps format detection. */
  download(result: SubtitleSearchResult): Promise<{ data: Buffer | Uint8Array; fileName: string }>;
}

/** Server events plugins can listen to. Payloads are the server's own event objects (e.g. playback events carry `ctx.user`); see plugins/examples. */
export type PluginEvent =
  | 'playback.start' | 'playback.pause' | 'playback.resume' | 'playback.stop' | 'playback.scrobble'
  | 'library.new' | 'items.played' | 'user.login'
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
  /** Subtitle sources appear in Admin → Server settings → Subtitles next to OpenSubtitles and Subs.ro. */
  subtitles: { registerProvider(provider: SubtitleProvider): void };
  /** Read-only library access (as the server's first administrator). */
  library: { getItem(id: string): Item | null; search(query: string, limit?: number): Item[] };
}

export type ActivateFn = (ctx: PluginContext) => void | Promise<void>;
