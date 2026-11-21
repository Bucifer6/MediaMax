import fs from 'node:fs';
import path from 'node:path';
import type { BackupInfo, User } from '@mediamax/shared';
import { config } from '../config.js';
import { db } from '../db.js';
import { getSettings, serverId } from './settings.js';
import { createTarGz, extractTarGz, walkFiles } from '../util/tar.js';
import { badRequest, notFound } from '../util/errors.js';
import { logActivity } from './activity.js';
import { logger } from '../util/log.js';

const log = logger('backup');
/** Folders (under the data dir) included in backups. Caches, transcodes, trickplay and media are not. */
export const BACKUP_DIRS = ['assets', 'avatars', 'artwork', 'plugins', 'plugin-data', 'subtitles'];
const backupsDir = () => {
  const d = path.join(config.dataDir, 'backups');
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const ID_RE = /^mediamax-[\w-]+\.tar\.gz$/;

export function listBackups(): BackupInfo[] {
  return fs.readdirSync(backupsDir()).filter((f) => ID_RE.test(f)).map((f) => {
    const st = fs.statSync(path.join(backupsDir(), f));
    const reason = f.match(/-(manual|scheduled|pre-restore)\.tar\.gz$/)?.[1] ?? 'manual';
    return { id: f, createdAt: st.mtime.toISOString(), sizeBytes: st.size, reason };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function backupPath(id: string): string {
  if (!ID_RE.test(id)) throw notFound('Backup not found');
  const p = path.join(backupsDir(), id);
  if (!fs.existsSync(p)) throw notFound('Backup not found');
  return p;
}

export function createBackup(reason: 'manual' | 'scheduled' | 'pre-restore' = 'manual', actor?: User): BackupInfo {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tmpDb = path.join(backupsDir(), `.snapshot-${stamp}.db`);
  fs.rmSync(tmpDb, { force: true });
  // Consistent online snapshot of the database.
  db.exec(`VACUUM INTO '${tmpDb.replace(/'/g, "''")}'`);
  const manifest = path.join(backupsDir(), `.manifest-${stamp}.json`);
  fs.writeFileSync(manifest, JSON.stringify({ format: 1, serverId: serverId(), version: config.version, createdAt: new Date().toISOString(), reason }));
  try {
    const entries = [
      { name: 'backup.json', file: manifest },
      { name: 'mediamax.db', file: tmpDb },
      ...BACKUP_DIRS.flatMap((d) => walkFiles(path.join(config.dataDir, d), d)),
    ];
    const id = `mediamax-${stamp}-${reason}.tar.gz`;
    fs.writeFileSync(path.join(backupsDir(), id), createTarGz(entries));
    logActivity('backup', `Backup created (${reason})`, { userId: actor?.id, userName: actor?.displayName });
    pruneAutomatic();
    return listBackups().find((b) => b.id === id)!;
  } finally {
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(manifest, { force: true });
  }
}

function pruneAutomatic() {
  const keep = Math.max(1, getSettings().backups.keep);
  const auto = listBackups().filter((b) => b.reason === 'scheduled');
  for (const b of auto.slice(keep)) fs.rmSync(path.join(backupsDir(), b.id), { force: true });
}

export function deleteBackup(id: string) {
  fs.rmSync(backupPath(id), { force: true });
}

/** Validate an archive and stage it; it's applied on the next start (see bootstrap-restore.ts). */
export function stageRestore(archive: Buffer, actor: User): { restartRequired: true } {
  const check = path.join(config.dataDir, '.restore-check');
  fs.rmSync(check, { recursive: true, force: true });
  try {
    extractTarGz(archive, check, { maxFiles: 200000, maxBytes: 8 * 1024 * 1024 * 1024 });
    const mf = path.join(check, 'backup.json');
    if (!fs.existsSync(mf) || !fs.existsSync(path.join(check, 'mediamax.db'))) throw badRequest('That file is not a Kinora backup');
    const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
    if (m.format !== 1) throw badRequest('Unsupported backup format');
  } finally {
    fs.rmSync(check, { recursive: true, force: true });
  }
  createBackup('pre-restore', actor);
  fs.writeFileSync(path.join(config.dataDir, 'restore-pending.tar.gz'), archive);
  logActivity('backup', 'Restore staged — it will be applied when Kinora restarts', { userId: actor.id, userName: actor.displayName, severity: 'warning' });
  log.warn('Restore staged; restart Kinora to apply it');
  return { restartRequired: true };
}
