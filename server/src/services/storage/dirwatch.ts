/**
 * Directory-only change watching. Node's recursive fs.watch on Linux stats and watches every single file (one
 * inotify watch per file, a stat of the whole library at start-up); this watches directories only — inotify on a
 * directory already reports its files — so start-up is one readdir per folder, no per-file stat, and far fewer
 * watches. inotify itself never touches the disk, so sleeping disks stay asleep. macOS and Windows use the native
 * recursive watcher.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Folders nobody wants scanned (NAS metadata, recycle bins, snapshots). */
export const IGNORED_DIRS = /^(\..*|@eaDir|@Recycle|#recycle|#snapshot|\$RECYCLE\.BIN|System Volume Information|lost\+found|\.snapshots?)$/i;
const IGNORED_FILES = /(^|[\\/])\.|\.(part|tmp|!qb|crdownload|partial|aria2)$/i;

export interface DirWatchResult { directories: number; error: string | null }

export class DirWatcher {
  private watchers = new Map<string, fs.FSWatcher>();
  private error: string | null = null;
  private closed = false;

  constructor(private readonly root: string, private readonly onChange: (rel: string) => void, private readonly maxDirs = 100000) {}

  start(): DirWatchResult {
    if (process.platform === 'darwin' || process.platform === 'win32') {
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
    this.addTree(this.root);
    return this.result();
  }

  result(): DirWatchResult {
    return { directories: this.watchers.size, error: this.error };
  }

  private addTree(dir: string) {
    const stack = [dir];
    while (stack.length && !this.closed) {
      const d = stack.pop()!;
      if (this.watchers.has(d)) continue;
      if (this.watchers.size >= this.maxDirs) {
        this.error = `Stopped at ${this.maxDirs} folders`;
        return;
      }
      if (!this.watchDir(d)) continue;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) if (e.isDirectory() && !IGNORED_DIRS.test(e.name)) stack.push(path.join(d, e.name));
    }
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
      // Something appeared or vanished: the disk is awake anyway, so a stat is free.
      let isDir = false;
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch {
        this.dropTree(full);
      }
      if (isDir) this.addTree(full);
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
 * mtime), so no per-file stat. Used for network shares where inotify sees nothing.
 */
export function folderSignature(root: string, maxDirs = 100000): string | null {
  if (!fs.existsSync(root)) return null;
  const parts: string[] = [];
  const stack = [root];
  let n = 0;
  while (stack.length && n < maxDirs) {
    const d = stack.pop()!;
    n++;
    try {
      parts.push(`${d}:${fs.statSync(d).mtimeMs}`);
      for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && !IGNORED_DIRS.test(e.name)) stack.push(path.join(d, e.name));
    } catch {
      /* vanished */
    }
  }
  return parts.sort().join('|');
}
