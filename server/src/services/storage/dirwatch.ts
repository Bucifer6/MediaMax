/**
 * Directory-only change watching. Node's recursive fs.watch on Linux stats and watches every single file (one
 * inotify watch per file, a stat of the whole library at start-up); this watches directories only — inotify on a
 * directory already reports its files — so start-up is one readdir per folder, no per-file stat, and far fewer
 * watches. inotify itself never touches the disk, so sleeping disks stay asleep. macOS and Windows use the native
 * recursive watcher.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { withTimeout } from '../../util/timeout.js';

/** Folders nobody wants scanned (NAS metadata, recycle bins, snapshots). */
export const IGNORED_DIRS = /^(\..*|@eaDir|@Recycle|#recycle|#snapshot|\$RECYCLE\.BIN|System Volume Information|lost\+found|\.snapshots?)$/i;
const IGNORED_FILES = /(^|[\\/])\.|\.(part|tmp|!qb|crdownload|partial|aria2)$/i;

export interface DirWatchResult { directories: number; error: string | null }

/** Folder walks (walkFolders) give the event loop a turn every this many folders, and read this many at once. */
const YIELD_EVERY = 200;
const WALK_CONCURRENCY = 4;
/** How long a library root gets to answer before it counts as unreachable (a sleeping network share can take minutes). */
export const rootCheck = { timeoutMs: 15000 };

/** Whether `root` can be reached, without blocking and without waiting on an unreachable share for long. */
const reachable = (root: string) => withTimeout(fs.promises.access(root).then(() => true, () => false), rootCheck.timeoutMs, false);

export class DirWatcher {
  private watchers = new Map<string, fs.FSWatcher>();
  private error: string | null = null;
  private closed = false;

  constructor(private readonly root: string, private readonly onChange: (rel: string) => void, private readonly maxDirs = 100000) {}

  async start(): Promise<DirWatchResult> {
    if (process.platform === 'darwin' || process.platform === 'win32') {
      // fs.watch opens the folder synchronously: on a sleeping network share that blocks the whole server until
      // Windows gives up. Check (asynchronously, with a time limit) that it answers first; syncWatchers retries later.
      if (!(await reachable(this.root))) {
        this.error = 'Folder not reachable (network share offline or asleep?)';
        return this.result();
      }
      if (this.closed) return this.result();
      try {
        const w = fs.watch(this.root, { recursive: true, persistent: false }, (_ev, file) => {
          if (file && !IGNORED_FILES.test(String(file)) && !String(file).split(/[\\/]/).some((p) => IGNORED_DIRS.test(p))) this.onChange(String(file));
        });
        w.on('error', (e) => {
          this.error = e.message;
        });
        this.watchers.set(this.root, w);
      } catch (e) {
        this.error = (e as Error).message;
      }
      return this.result();
    }
    await this.addTree(this.root);
    return this.result();
  }

  result(): DirWatchResult {
    return { directories: this.watchers.size, error: this.error };
  }

  private async addTree(dir: string) {
    await walkFolders(dir, (d) => {
      if (this.closed) return 'stop';
      if (this.watchers.has(d)) return 'skip';
      if (this.watchers.size >= this.maxDirs) {
        this.error = `Stopped at ${this.maxDirs} folders`;
        return 'stop';
      }
      return this.watchDir(d) ? 'descend' : 'skip';
    });
  }

  private watchDir(d: string): boolean {
    try {
      const w = fs.watch(d, { persistent: false }, (ev, name) => this.event(d, ev, name ? String(name) : null));
      w.on('error', () => this.drop(d));
      this.watchers.set(d, w);
      return true;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOSPC') this.error = 'inotify watch limit reached — raise fs.inotify.max_user_watches (see docs: NAS & disk spin-down)';
      else if (d === this.root) this.error = err.message;
      return false;
    }
  }

  private event(dir: string, ev: string, name: string | null) {
    if (this.closed) return;
    if (name && (IGNORED_FILES.test(name) || IGNORED_DIRS.test(name))) return;
    const full = name ? path.join(dir, name) : dir;
    if (ev === 'rename' && name) {
      // Something appeared or vanished: watch a new folder, drop the watches of one that's gone. Never a blocking
      // stat in an event handler: on a slow disk or share it would hold up every request.
      void fs.promises.stat(full).then((st) => {
        if (st.isDirectory() && !this.closed) void this.addTree(full);
      }, () => this.dropTree(full));
    }
    this.onChange(path.relative(this.root, full));
  }

  private drop(d: string) {
    this.watchers.get(d)?.close();
    this.watchers.delete(d);
  }

  private dropTree(d: string) {
    const prefix = d + path.sep;
    for (const k of [...this.watchers.keys()]) if (k === d || k.startsWith(prefix)) this.drop(k);
  }

  close() {
    this.closed = true;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }
}

/**
 * Poll-mode signature: folder modification times only (adding/removing/renaming a file changes its folder's
 * mtime), so no per-file stat. Used for network shares where inotify sees nothing. A digest (SHA-1 per folder and
 * time), not the joined list: that was a multi-MB string per big library, kept between polls.
 */
export async function folderSignature(root: string, maxDirs = 100000): Promise<string | null> {
  if (!(await reachable(root))) return null;
  // Folders are read a few at a time, in no fixed order: each folder's digest is XORed into the total, so the same
  // tree always gives the same signature (paths are unique, so entries can't cancel out).
  const sum = Buffer.alloc(20);
  let n = 0;
  await walkFolders(root, async (d) => {
    if (n >= maxDirs) return 'stop';
    n++;
    try {
      const digest = crypto.createHash('sha1').update(`${d}:${(await fs.promises.stat(d)).mtimeMs}`).digest();
      for (let i = 0; i < 20; i++) sum[i] ^= digest[i];
      return 'descend';
    } catch {
      return 'skip'; // vanished
    }
  });
  return sum.toString('hex');
}

/**
 * Walk the folders below `root` (NAS metadata / recycle folders left out) without blocking the event loop: folders
 * are read asynchronously, a few at once (one after another takes several times as long as a sync walk), with a
 * turn for other work every YIELD_EVERY folders. `visit` decides per folder: read its subfolders, skip them, or stop.
 */
async function walkFolders(root: string, visit: (dir: string) => WalkStep | Promise<WalkStep>) {
  const stack = [root];
  let n = 0;
  let busy = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped) {
      if (++n % YIELD_EVERY === 0) await nextTurn();
      const d = stack.pop();
      if (d === undefined) {
        if (!busy) return;
        await nextTurn(); // other workers are still reading folders that may add more
        continue;
      }
      busy++;
      try {
        const step = await visit(d);
        if (step === 'stop') stopped = true;
        if (step !== 'descend') continue;
        for (const e of await fs.promises.readdir(d, { withFileTypes: true })) if (e.isDirectory() && !IGNORED_DIRS.test(e.name)) stack.push(path.join(d, e.name));
      } catch {
        /* unreadable or vanished */
      } finally {
        busy--;
      }
    }
  };
  await Promise.all(Array.from({ length: WALK_CONCURRENCY }, worker));
}
type WalkStep = 'descend' | 'skip' | 'stop';
