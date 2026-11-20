import crypto from 'node:crypto';
import path from 'node:path';
import type { ArrInstance, ArrKind, ArrPathMapping, ArrWebhookInfo } from '@mediamax/shared';
import { db } from '../../db.js';
import { getKv, getSettings, setKv } from '../settings.js';
import { isScanning, scanLibrary } from '../scanner.js';
import { checkAvailability } from '../requests.js';
import { logActivity } from '../activity.js';
import { parseJson } from '../../util/misc.js';
import { logger } from '../../util/log.js';
import { ARR_LABEL, allInstances, invalidate } from './client.js';

const log = logger('arr-webhook');

/* ------------------------------- token ------------------------------ */

const TOKEN_KEY = 'arrWebhookToken';

export function webhookToken(): string {
  let t = getKv<string | null>(TOKEN_KEY, null);
  if (!t) {
    t = crypto.randomBytes(24).toString('base64url');
    setKv(TOKEN_KEY, t);
  }
  return t;
}

export function regenerateWebhookToken(): string {
  setKv(TOKEN_KEY, crypto.randomBytes(24).toString('base64url'));
  return webhookToken();
}

/** Constant-time comparison (hashing first makes both sides the same length). */
export function tokenMatches(given: string): boolean {
  const a = crypto.createHash('sha256').update(String(given ?? '')).digest();
  const b = crypto.createHash('sha256').update(webhookToken()).digest();
  return crypto.timingSafeEqual(a, b);
}

export function webhookInfo(): ArrWebhookInfo {
  const token = webhookToken();
  const p = `/api/v1/arr/webhook/${token}`;
  const pub = getSettings().publicUrl?.replace(/\/+$/, '') || null;
  return { path: p, url: pub ? pub + p : null, token };
}

/* ------------------------------ payloads ---------------------------- */

const SCAN_EVENTS = new Set([
  'Download', 'Rename', 'Retag', 'TrackRetag', 'BookFileRetag', 'ImportComplete',
  'MovieDelete', 'MovieFileDelete', 'SeriesDelete', 'EpisodeFileDelete', 'SeriesAdd',
  'ArtistDelete', 'AlbumDelete', 'TrackFileDelete', 'AuthorDelete', 'BookDelete', 'BookFileDelete',
]);
const HEALTH_EVENTS = new Set(['Health', 'HealthRestored', 'ApplicationUpdate', 'ManualInteractionRequired']);

/** Which *arr sent this payload. */
export function payloadKind(p: any): Exclude<ArrKind, 'bazarr'> | null {
  if (p?.movie || p?.remoteMovie || p?.movieFile) return 'radarr';
  if (p?.series || p?.episodes || p?.episodeFile) return 'sonarr';
  if (p?.artist || p?.albums || p?.album || p?.trackFiles) return 'lidarr';
  if (p?.author || p?.book || p?.books || p?.bookFiles) return 'readarr';
  return null;
}

const isAbs = (p: unknown): p is string => typeof p === 'string' && (p.startsWith('/') || /^[a-z]:[\\/]/i.test(p) || p.startsWith('\\\\'));
const dirOf = (p: string) => (p.includes('\\') && !p.includes('/') ? p.replace(/\\[^\\]*$/, '') : path.posix.dirname(p));
const join = (a: string, b: string) => (a.includes('\\') && !a.includes('/') ? `${a.replace(/\\+$/, '')}\\${b}` : path.posix.join(a, b));

/**
 * The folders an event touched, as the *arr sees them: the title's folder (movie/series/artist/author),
 * plus the folders of any files it lists (a file's own folder catches season folders and album folders).
 */
export function affectedPaths(p: any): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => isAbs(v) && out.add(String(v).replace(/[\\/]+$/, ''));
  const addFile = (file: any, folder?: string) => {
    if (!file) return;
    if (isAbs(file.path)) add(dirOf(file.path));
    else if (folder && file.relativePath) add(dirOf(join(folder, file.relativePath)));
  };
  // Radarr
  add(p?.movie?.folderPath);
  addFile(p?.movieFile, p?.movie?.folderPath);
  for (const f of p?.deletedFiles ?? []) addFile(f, p?.movie?.folderPath ?? p?.series?.path);
  // Sonarr
  add(p?.series?.path);
  addFile(p?.episodeFile, p?.series?.path);
  for (const f of p?.episodeFiles ?? []) addFile(f, p?.series?.path);
  for (const r of p?.renamedEpisodeFiles ?? []) addFile(r, p?.series?.path);
  for (const r of p?.renamedMovieFiles ?? []) addFile(r, p?.movie?.folderPath);
  // Lidarr
  add(p?.artist?.path);
  for (const f of p?.trackFiles ?? []) addFile(f, p?.artist?.path);
  if (p?.trackFile) addFile(p.trackFile, p?.artist?.path);
  // Readarr
  add(p?.author?.path);
  add(p?.book?.path);
  for (const f of p?.bookFiles ?? []) addFile(f, p?.author?.path);
  if (p?.bookFile) addFile(p.bookFile, p?.author?.path);
  return [...out];
}

/** Translate an *arr path with the first matching mapping (longest remote prefix wins). */
export function mapPath(p: string, mappings: ArrPathMapping[]): string {
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const winLike = (s: string) => s.includes('\\') || /^[a-z]:/i.test(s);
  const src = norm(p);
  const sorted = [...mappings].sort((a, b) => b.remotePath.length - a.remotePath.length);
  for (const m of sorted) {
    const remote = norm(m.remotePath);
    if (!remote) continue;
    const ci = winLike(m.remotePath) || winLike(p);
    const a = ci ? src.toLowerCase() : src;
    const b = ci ? remote.toLowerCase() : remote;
    if (a === b || a.startsWith(b + '/')) return norm(m.localPath) + src.slice(remote.length);
  }
  return winLike(p) ? src : p.replace(/\/+$/, '');
}

/** Libraries that contain a path (or that live inside it, e.g. a deleted root). */
export function librariesForPath(p: string): { id: string; name: string }[] {
  const target = path.resolve(p);
  return db.all('SELECT id, name, type, paths FROM libraries').filter((l) => {
    if (String(l.type).startsWith('iptv-') || l.type === 'podcasts') return false;
    return parseJson<string[]>(l.paths, []).some((root) => {
      const r = path.resolve(root);
      return target === r || target.startsWith(r + path.sep) || r.startsWith(target + path.sep);
    });
  }).map((l) => ({ id: l.id, name: l.name }));
}

/** The configured instance that sent a payload (by instanceName / applicationUrl), else all of that kind. */
function sendersOf(kind: ArrKind | null, p: any): ArrInstance[] {
  const list = allInstances().filter((i) => !kind || i.kind === kind);
  const name = String(p?.instanceName ?? '').toLowerCase();
  const app = String(p?.applicationUrl ?? '').replace(/\/+$/, '').toLowerCase();
  const exact = list.filter((i) => (name && i.name.toLowerCase() === name) || (app && i.url.toLowerCase() === app));
  return exact.length ? exact : list;
}

/* ----------------------------- debounce ----------------------------- */

let debounceMs = 10_000;
let scanFn: (libId: string) => Promise<void> = (id) => scanLibrary(id);
const pending = new Map<string, { timer: NodeJS.Timeout; reasons: Set<string> }>();
let lastRun: Promise<void> = Promise.resolve();

/** Tests: shorten the debounce window and observe scans. */
export function _configure(opts: { debounceMs?: number; scan?: (libId: string) => Promise<void> }) {
  if (opts.debounceMs !== undefined) debounceMs = opts.debounceMs;
  if (opts.scan) scanFn = opts.scan;
}
/** Tests: resolves once every scheduled scan has run. */
export async function _flush() {
  while (pending.size) await new Promise((r) => setTimeout(r, Math.max(5, debounceMs)));
  await lastRun;
}

/** Queue a rescan of one library; bursts within the window collapse into a single scan. */
export function scheduleScan(libId: string, reason: string) {
  const cur = pending.get(libId);
  if (cur) {
    cur.reasons.add(reason);
    return;
  }
  const entry = { reasons: new Set([reason]), timer: setTimeout(() => void run(libId), debounceMs) };
  entry.timer.unref?.();
  pending.set(libId, entry);
}

async function run(libId: string) {
  const entry = pending.get(libId);
  pending.delete(libId);
  const job = (async () => {
    const lib = db.get<{ name: string }>('SELECT name FROM libraries WHERE id = ?', libId);
    if (!lib) return;
    try {
      // scanLibrary() joins a scan that's already running, which may have walked the folder before the
      // import landed; scan again afterwards so the new files are seen.
      if (isScanning(libId)) await scanFn(libId).catch(() => undefined);
      await scanFn(libId);
      const reasons = [...(entry?.reasons ?? [])];
      log.info(`Rescanned "${lib.name}" after ${reasons.join(', ')}`);
      const n = checkAvailability();
      if (n) log.info(`${n} request(s) are now available`);
    } catch (e) {
      log.warn(`Rescan of "${lib.name}" after an *arr event failed: ${(e as Error).message}`);
    }
  })();
  lastRun = lastRun.then(() => job);
  await job;
}

/* ------------------------------ handler ----------------------------- */

export interface WebhookResult {
  ok: true;
  event: string;
  kind: ArrKind | null;
  libraries: string[];
  paths: string[];
}

export function handleWebhook(p: any): WebhookResult {
  const event = String(p?.eventType ?? 'Unknown');
  const kind = payloadKind(p);
  const app = kind ? ARR_LABEL[kind] : 'An *arr app';
  const senders = sendersOf(kind, p);
  const from = p?.instanceName ? `${app} (${p.instanceName})` : app;
  const title = p?.movie?.title ?? p?.series?.title ?? p?.artist?.name ?? p?.artist?.artistName ?? p?.author?.name ?? p?.author?.authorName ?? p?.book?.title ?? null;
  const result: WebhookResult = { ok: true, event, kind, libraries: [], paths: [] };

  if (event === 'Test') {
    logActivity('arr.webhook', `${from} webhook test received`);
    return result;
  }
  if (event === 'Grab') {
    invalidate('queue:');
    logActivity('arr.webhook', `${from} grabbed ${title ?? 'a release'}${p?.release?.quality ? ` (${p.release.quality})` : ''}`);
    return result;
  }
  if (HEALTH_EVENTS.has(event)) {
    invalidate('health:');
    logActivity('arr.webhook', `${from}: ${p?.message ?? event}`, { severity: event === 'Health' ? 'warning' : 'info' });
    return result;
  }
  if (!SCAN_EVENTS.has(event)) {
    log.debug(`Ignoring ${event} from ${from}`);
    return result;
  }

  invalidate('queue:');
  invalidate('wanted:');
  invalidate('calendar');
  const mappings = senders.flatMap((s) => s.pathMappings ?? []);
  const local = [...new Set(affectedPaths(p).map((x) => mapPath(x, mappings)))];
  result.paths = local;
  const libs = new Map<string, string>();
  for (const lp of local) for (const l of librariesForPath(lp)) libs.set(l.id, l.name);
  const verb = event === 'Download' ? (p?.isUpgrade ? 'upgraded' : 'imported') : event === 'Rename' ? 'renamed' : /Delete/.test(event) ? 'deleted' : event.toLowerCase();
  if (!libs.size) {
    logActivity('arr.webhook', `${from} ${verb} ${title ?? 'something'}, but no library contains ${local[0] ?? 'its folder'}${local.length ? ' (add a path mapping if the *arr sees a different path)' : ''}`, { severity: 'warning' });
    return result;
  }
  for (const [id] of libs) scheduleScan(id, `${event} of ${title ?? 'a title'}`);
  result.libraries = [...libs.values()];
  logActivity('arr.webhook', `${from} ${verb} ${title ?? 'a title'}; rescanning ${[...libs.values()].join(', ')}`);
  return result;
}
