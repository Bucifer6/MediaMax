import fs from 'node:fs';
import { db } from '../db.js';
import { parseJson } from '../util/misc.js';
import { logger } from '../util/log.js';
import { scanLibrary } from './scanner.js';

const log = logger('watcher');
const watchers = new Map<string, fs.FSWatcher[]>();
const timers = new Map<string, NodeJS.Timeout>();

/** Watch library folders and trigger a debounced rescan when files change. */
export function syncWatchers() {
  const libs = db.all("SELECT id, name, paths FROM libraries WHERE type NOT LIKE 'iptv-%'");
  const wanted = new Set(libs.map((l) => l.id));
  for (const [id, ws] of watchers) {
    if (!wanted.has(id)) {
      ws.forEach((w) => w.close());
      watchers.delete(id);
    }
  }
  for (const lib of libs) {
    if (watchers.has(lib.id)) continue;
    const ws: fs.FSWatcher[] = [];
    for (const p of parseJson<string[]>(lib.paths, [])) {
      try {
        const w = fs.watch(p, { recursive: true, persistent: false }, (_ev, file) => {
          if (file && /(^|[\\/])\.|\.(part|tmp|!qb|crdownload)$/i.test(String(file))) return;
          clearTimeout(timers.get(lib.id));
          // Wait for copies to settle before scanning.
          timers.set(lib.id, setTimeout(() => {
            log.info(`Changes detected in "${lib.name}", scanning`);
            void scanLibrary(lib.id);
          }, 30000));
        });
        w.on('error', (e) => log.debug(`Watcher error for ${p}: ${e.message}`));
        ws.push(w);
      } catch (e) {
        log.debug(`Cannot watch ${p}: ${(e as Error).message} (scheduled scans still apply)`);
      }
    }
    watchers.set(lib.id, ws);
  }
}
