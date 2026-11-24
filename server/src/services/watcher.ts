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
const signatures = new Map<string, string>();
let pollTimer: NodeJS.Timeout | null = null;
let pollEvery = 0;

function changed(libId: string, name: string, root: string) {
  clearTimeout(timers.get(libId));
  // Wait for copies to settle before scanning. The disk is awake (something just changed on it), so this
  // scan — and any postponed work for the same disk — costs no extra spin-up.
  timers.set(libId, setTimeout(() => {
    log.info(`Changes detected in "${name}", scanning`);
    void scanLibrary(libId).then(() => noteDiskAwake(root, 5000));
  }, 30000));
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
        const w = new DirWatcher(p, () => changed(lib.id, lib.name, p));
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
  for (const lib of db.all("SELECT id, name, paths FROM libraries WHERE type NOT LIKE 'iptv-%' AND type != 'podcasts'")) {
    for (const p of parseJson<string[]>(lib.paths, [])) {
      // Disk-friendly: only poll inside the window or when the disk is known to be awake.
      if (s.diskFriendly && !inWindow(new Date(), s.windowStart, s.windowEnd) && (await stateForKey(diskKeyForPath(p))) !== 'active') continue;
      const sig = await folderSignature(p);
      if (sig == null) continue;
      const k = `${lib.id}|${p}`;
      const prev = signatures.get(k);
      signatures.set(k, sig);
      if (prev !== undefined && prev !== sig) {
        triggered++;
        log.info(`Folder changes found in "${lib.name}" (poll), scanning`);
        void scanLibrary(lib.id);
      }
    }
  }
  return triggered;
}

export function watchInfo(libId: string): StorageLibraryInfo['watch'] {
  const w = watched.get(libId);
  return w ? { mode: w.mode, directories: w.directories, error: w.error } : { mode: getStorageSettings().watchMode, directories: 0, error: null };
}
