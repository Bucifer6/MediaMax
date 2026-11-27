import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { parseJson } from '../util/misc.js';
import { logger } from '../util/log.js';
import { scanLibrary } from './scanner.js';
import { DirWatcher, folderSignature } from './storage/dirwatch.js';
import { getStorageSettings, noteDiskAwake, stateForKey, diskKeyForPath } from './storage/storage.js';
import { inWindow } from './storage/window.js';
import type { StorageLibraryInfo } from '@mediamax/shared';

const log = logger('watcher');

interface LibWatch { key: string; mode: 'native' | 'poll' | 'off'; watchers: DirWatcher[]; directories: number; error: string | null }

const watched = new Map<string, LibWatch>();
const timers = new Map<string, NodeJS.Timeout>();
/** Changed top-level entries per library since its last watcher scan (with their root); null = scan it all. */
const pending = new Map<string, Map<string, { root: string; maybeFile: boolean }> | null>();
const signatures = new Map<string, string>();
let pollTimer: NodeJS.Timeout | null = null;
let pollEvery = 0;
/** Debounce for watcher scans (copies settle meanwhile); more changed folders than MAX_PATHS → a full scan. */
export const watchTiming = { settleMs: 30000 };
const MAX_PATHS = 50;

/**
 * The top-level folder a change under `root` belongs to (a show, a movie folder, an artist — what a scan groups by),
 * and whether the change was the top-level entry itself (then it may be a file directly in the root). Null: the root
 * itself changed, no telling what. Touches no disk.
 */
function unitOf(root: string, rel: string): { unit: string; maybeFile: boolean } | null {
  if (!rel || rel === '.') return null;
  const top = rel.split(/[\\/]/)[0];
  if (top === '..') return null;
  return { unit: path.join(root, top), maybeFile: top === rel };
}

/** Whether `p` is a folder, without blocking (false when it's gone or unreadable). */
const isDir = (p: string) => fs.promises.stat(p).then((st) => st.isDirectory(), () => false);

/**
 * The scan unit a change under `root` belongs to: its top-level folder. A change directly in the root (a file, or
 * something that vanished) also needs the root's own files. Asynchronous: on Windows this runs for every change on a
 * library folder, often a network share, and a blocking stat there froze the server whenever the share was slow.
 */
export async function changedUnits(root: string, rel: string): Promise<string[] | null> {
  const u = unitOf(root, rel);
  if (!u) return null;
  return !u.maybeFile || (await isDir(u.unit)) ? [u.unit] : [u.unit, root];
}

export function changed(libId: string, name: string, root: string, rel?: string) {
  clearTimeout(timers.get(libId));
  // Nothing touches the disk per event (an app writing into a library folder sends a stream of them): whether a
  // changed top-level entry is a folder is checked once, asynchronously, when the debounced scan starts.
  const u = rel === undefined ? null : unitOf(root, rel);
  const units = pending.has(libId) ? pending.get(libId)! : new Map<string, { root: string; maybeFile: boolean }>();
  if (!u || !units) pending.set(libId, null);
  else {
    units.set(u.unit, { root, maybeFile: !!units.get(u.unit)?.maybeFile || u.maybeFile });
    pending.set(libId, units.size > MAX_PATHS ? null : units);
  }
  // Wait for copies to settle before scanning. The disk is awake (something just changed on it), so this
  // scan — and any postponed work for the same disk — costs no extra spin-up.
  timers.set(libId, setTimeout(() => {
    timers.delete(libId);
    const units = pending.get(libId);
    pending.delete(libId);
    void scanPaths(units ?? null).then((paths) => {
      log.info(`Changes detected in "${name}", scanning${paths ? ` ${paths.length} folder(s)` : ''}`);
      return scanLibrary(libId, paths ? { paths } : {});
    }).then(() => noteDiskAwake(root, 5000));
  }, watchTiming.settleMs));
}

/** The folders a watcher scan covers (changedUnits for each changed entry), or null for a full scan. */
async function scanPaths(units: Map<string, { root: string; maybeFile: boolean }> | null): Promise<string[] | null> {
  if (!units) return null;
  const list = [...units];
  const dirs = await Promise.all(list.map(([unit, u]) => (u.maybeFile ? isDir(unit) : true)));
  const out = new Set<string>();
  list.forEach(([unit, u], k) => {
    out.add(unit);
    if (!dirs[k]) out.add(u.root);
  });
  return out.size > MAX_PATHS ? null : [...out];
}

/** Watch library folders (inotify on directories only; never polls) and trigger a debounced rescan on changes. */
export function syncWatchers() {
  const mode = getStorageSettings().watchMode;
  const libs = db.all("SELECT id, name, paths FROM libraries WHERE type NOT LIKE 'iptv-%' AND type != 'podcasts'");
  const wanted = new Map(libs.map((l) => [l.id, `${mode}|${l.paths}`]));
  for (const [id, w] of watched) {
    if (wanted.get(id) !== w.key) {
      w.watchers.forEach((x) => x.close());
      watched.delete(id);
    }
  }
  for (const lib of libs) {
    if (watched.has(lib.id)) continue;
    const entry: LibWatch = { key: `${mode}|${lib.paths}`, mode, watchers: [], directories: 0, error: null };
    if (mode === 'native') {
      for (const p of parseJson<string[]>(lib.paths, [])) {
        const w = new DirWatcher(p, (rel) => changed(lib.id, lib.name, p, rel));
        entry.watchers.push(w);
        // The folder walk is asynchronous (a big library has tens of thousands of folders); counts fill in as it ends.
        void w.start().then((r) => {
          entry.directories += r.directories;
          if (r.error) {
            entry.error = r.error;
            log.debug(`Cannot fully watch ${p}: ${r.error} (scheduled scans still apply)`);
          }
        });
      }
    }
    watched.set(lib.id, entry);
  }
  syncPolling();
}

/** Poll mode (opt-in, for network shares inotify can't see): compare folder timestamps every N minutes. */
function syncPolling() {
  const s = getStorageSettings();
  const every = s.watchMode === 'poll' ? Math.max(60, s.pollIntervalMinutes) : 0;
  if (every === pollEvery) return;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  pollEvery = every;
  if (!every) return;
  pollTimer = setInterval(() => void pollOnce(), every * 60000);
  pollTimer.unref();
}

export async function pollOnce(): Promise<number> {
  const s = getStorageSettings();
  let triggered = 0;
  const libs = db.all("SELECT id, name, paths FROM libraries WHERE type NOT LIKE 'iptv-%' AND type != 'podcasts'");
  // Every root is read at once: one share that is asleep or slow (each gets a time limit) mustn't hold up the others.
  // Results are then handled in library order, as before.
  const roots = libs.flatMap((lib) => parseJson<string[]>(lib.paths, []).map((p) => ({ lib, p })));
  const sigs = await Promise.all(roots.map(async ({ p }) => {
    // Disk-friendly: only poll inside the window or when the disk is known to be awake.
    if (s.diskFriendly && !inWindow(new Date(), s.windowStart, s.windowEnd) && (await stateForKey(diskKeyForPath(p))) !== 'active') return null;
    return folderSignature(p);
  }));
  roots.forEach(({ lib, p }, i) => {
    const sig = sigs[i];
    if (sig == null) return;
    const k = `${lib.id}|${p}`;
    const prev = signatures.get(k);
    signatures.set(k, sig);
    if (prev !== undefined && prev !== sig) {
      triggered++;
      log.info(`Folder changes found in "${lib.name}" (poll), scanning`);
      void scanLibrary(lib.id);
    }
  });
  return triggered;
}

export function watchInfo(libId: string): StorageLibraryInfo['watch'] {
  const w = watched.get(libId);
  return w ? { mode: w.mode, directories: w.directories, error: w.error } : { mode: getStorageSettings().watchMode, directories: 0, error: null };
}
