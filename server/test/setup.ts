// Loaded before every test file (each runs in its own process): give each process a private data dir,
// so parallel test files never open the same SQLite database at once.
import os from 'node:os';
import path from 'node:path';
process.env.MEDIAMAX_DATA ??= path.join(os.tmpdir(), `mediamax-test-${process.pid}`);
