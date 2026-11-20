// Loaded before every test file (each runs in its own process): give each process a fresh private data dir,
// so parallel test files never open the same SQLite database at once, and a reused PID never inherits the
// database of an earlier run (fixed-id inserts would then fail with UNIQUE constraint errors).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
if (!process.env.MEDIAMAX_DATA) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mediamax-test-${process.pid}-`));
  process.env.MEDIAMAX_DATA = dir;
  process.on('exit', () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
}
