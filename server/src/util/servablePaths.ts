import path from 'node:path';
import { db } from '../db.js';
import { config } from '../config.js';
import { getSettings } from '../services/settings.js';
import { parseJson } from './misc.js';

/**
 * Folders the server may read files from when answering a request: the library folders, the data folder (cache,
 * uploads, stems, models), the DVR recordings folder and the bundled web files. Paths reach the file-serving code
 * from the database (scanned media, registered artwork), never directly from a request, but a path outside every one
 * of these folders is refused anyway: a bad row or a future bug must not turn into reading arbitrary files.
 */
let cached: { at: number; roots: string[] } | null = null;
const TTL_MS = 5000;

const asPrefix = (root: string) => {
  const r = path.resolve(root);
  return r.endsWith(path.sep) ? r : r + path.sep;
};

export function servableRoots(): string[] {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.roots;
  const libs = db.all<{ paths: string }>('SELECT paths FROM libraries').flatMap((l) => parseJson<string[]>(l.paths, []));
  let recordings: string | null = null;
  try {
    recordings = getSettings().dvr?.recordingsPath ?? null;
  } catch {
    recordings = null;
  }
  const roots = [...libs, config.dataDir, config.recordingsDir, recordings, config.webDir, process.env.MEDIAMAX_ORT_DIR]
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    .map(asPrefix);
  cached = { at: now, roots: [...new Set(roots)] };
  return cached.roots;
}

/** Drop the cached folder list (a library was added or changed; tests). */
export function forgetServableRoots() {
  cached = null;
}

/**
 * `p` resolved to an absolute path when it lies inside one of `servableRoots()` (or `extraRoots`), else null.
 * Exact prefix match on the resolved path (no `..` escapes; a sibling such as D:\Movies2 never matches D:\Movies).
 */
export function confinedPath(p: string, extraRoots: string[] = []): string | null {
  const resolved = path.resolve(p);
  for (const prefix of [...servableRoots(), ...extraRoots.map(asPrefix)]) {
    if (resolved.startsWith(prefix)) return resolved;
  }
  return null;
}
