import os from 'node:os';
import type { ChildProcess } from 'node:child_process';

/**
 * Drop a background child process (thumbnails, trickplay, intro fingerprints …) to the lowest CPU priority
 * (nice 19 on Linux/macOS, IDLE class on Windows), so it only uses CPU time nothing else wants and never slows
 * playback, transcodes or the web UI. Best effort: failures (process already gone, no permission) are ignored.
 */
export function lowPriority<T extends ChildProcess>(p: T): T {
  try {
    if (p.pid) os.setPriority(p.pid, os.constants.priority.PRIORITY_LOW);
  } catch { /* ignore */ }
  return p;
}
