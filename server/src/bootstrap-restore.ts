/**
 * Applies a staged backup restore BEFORE the database is opened. Imported first by index.ts.
 * Uses only node built-ins + the tar helper so it runs before any service module loads.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { extractTarGz } from './util/tar.js';

const pending = path.join(config.dataDir, 'restore-pending.tar.gz');
if (fs.existsSync(pending)) {
  const staging = path.join(config.dataDir, '.restore-staging');
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    extractTarGz(fs.readFileSync(pending), staging, { maxFiles: 200000, maxBytes: 8 * 1024 * 1024 * 1024 });
    const dbFile = process.env.MEDIAMAX_DB ?? config.dbPath;
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
    fs.renameSync(path.join(staging, 'mediamax.db'), dbFile);
    for (const d of ['assets', 'avatars', 'artwork', 'plugins', 'plugin-data', 'subtitles']) {
      const target = path.join(config.dataDir, d);
      fs.rmSync(target, { recursive: true, force: true });
      if (fs.existsSync(path.join(staging, d))) fs.renameSync(path.join(staging, d), target);
    }
    process.stdout.write(`${new Date().toISOString()} [INFO] restore: backup restored\n`);
  } catch (e) {
    process.stderr.write(`${new Date().toISOString()} [ERROR] restore: failed to apply staged backup: ${(e as Error).message}\n`);
  } finally {
    fs.rmSync(pending, { force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
