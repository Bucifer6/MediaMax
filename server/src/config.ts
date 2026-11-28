import './env.js'; // must stay first: VIBE_* / KINORA_* environment variables override their MEDIAMAX_* twins
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { isSea } from 'node:sea';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));

function dir(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/**
 * Standalone builds (a Node single executable, see scripts/package.mjs) ship as one binary with the web
 * app in `web/` and a static ffmpeg/ffprobe right next to it. Source, npm and Docker installs never take
 * this branch, so their defaults are unchanged.
 */
const standalone = isSea();
const exeDir = path.dirname(process.execPath);
const exe = process.platform === 'win32' ? '.exe' : '';

/**
 * The data directory for a standalone install: a `Vibe` folder. The product was called Kinora and MediaMax before;
 * when only a folder with one of those names exists it is used as it is (the Windows setup program moves it to the
 * Vibe name on upgrade, see packaging/windows-installer/vibe.iss), so the library, users and settings are kept:
 *   Windows  %ProgramData%\Vibe                (then %ProgramData%\Kinora, %ProgramData%\MediaMax)
 *   systemd  STATE_DIRECTORY (/var/lib/vibe)    (then /var/lib/kinora, /var/lib/mediamax holding a database)
 *   Linux    ~/.local/share/vibe                (then ~/.local/share/kinora, ~/.local/share/mediamax)
 */
export function pickDataDir(candidates: string[], exists: (p: string) => boolean = fs.existsSync): string {
  return candidates.find((p) => exists(p)) ?? candidates[0];
}

/** Database file names, newest first: the server uses DB_FILE and renames a database left under an older name. */
export const DB_FILE = 'vibe.db';
export const LEGACY_DB_FILES = ['mediamax.db'];
const hasDb = (d: string) => [DB_FILE, ...LEGACY_DB_FILES].some((f) => fs.existsSync(path.join(d, f)));

function defaultDataDir(): string {
  if (!standalone) return path.join(process.cwd(), 'data');
  // Windows: a machine-wide folder, so the boot-time task (running as SYSTEM) and the user see the same data.
  if (process.platform === 'win32') {
    const base = process.env.ProgramData ?? 'C:\\ProgramData';
    return pickDataDir(['Vibe', 'Kinora', 'MediaMax'].map((n) => path.join(base, n)));
  }
  // systemd's StateDirectory= sets STATE_DIRECTORY (normally /var/lib/vibe).
  if (process.env.STATE_DIRECTORY) {
    const state = process.env.STATE_DIRECTORY.split(':')[0];
    // systemd creates the state directory before starting us, so look for a database rather than the folder.
    if (hasDb(state)) return state;
    return ['kinora', 'mediamax'].map((n) => path.join(path.dirname(state), n)).find(hasDb) ?? state;
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return pickDataDir(['vibe', 'kinora', 'mediamax'].map((n) => path.join(base, n)));
}

/**
 * The database is `vibe.db`. One still named `mediamax.db` (every install before this change) is renamed once, at
 * start-up before anything opens it: its write-ahead log is first folded into the file (a clean checkpoint, which also
 * removes the -wal/-shm files), so only the one file has to be renamed and no committed change can be left behind.
 * If that fails the server keeps using the old file, so nothing is lost.
 */
export function migrateDbFile(dataDir: string): string {
  const target = path.join(dataDir, DB_FILE);
  if (fs.existsSync(target)) return target;
  for (const name of LEGACY_DB_FILES) {
    const legacy = path.join(dataDir, name);
    if (!fs.existsSync(legacy)) continue;
    try {
      const d = new DatabaseSync(legacy);
      try {
        d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        d.exec('PRAGMA journal_mode=DELETE');
      } finally {
        d.close();
      }
      // Leaving journal_mode=WAL folds the log into the file (db.ts switches back to WAL when it opens it). A log that is still there with content means another
      // process has the database open: leave everything as it is.
      const wal = legacy + '-wal';
      if (fs.existsSync(wal) && fs.statSync(wal).size > 0) throw new Error('the database is in use');
      for (const suffix of ['-wal', '-shm']) fs.rmSync(legacy + suffix, { force: true });
      fs.renameSync(legacy, target);
      process.stdout.write(`${new Date().toISOString()} [INFO] config: renamed ${name} to ${DB_FILE}\n`);
      return target;
    } catch (e) {
      process.stderr.write(`${new Date().toISOString()} [WARN] config: could not rename ${name} to ${DB_FILE}, using it as it is: ${(e as Error).message}\n`);
      return legacy;
    }
  }
  return target;
}

/** Prefer the ffmpeg/ffprobe shipped beside a standalone binary, else whatever is on the PATH. */
function bundledTool(name: string): string {
  const local = path.join(exeDir, name + exe);
  return standalone && fs.existsSync(local) ? local : name;
}

const dataDir = path.resolve(process.env.MEDIAMAX_DATA ?? defaultDataDir());

export const config = {
  version: '0.7.2',
  port: Number(process.env.MEDIAMAX_PORT ?? process.env.PORT ?? 8484),
  host: process.env.MEDIAMAX_HOST ?? '0.0.0.0',
  dataDir: dir(dataDir),
  dbPath: process.env.MEDIAMAX_DB ? path.resolve(process.env.MEDIAMAX_DB) : migrateDbFile(dir(dataDir)),
  cacheDir: dir(path.join(dataDir, 'cache')),
  imageCacheDir: dir(path.join(dataDir, 'cache', 'images')),
  transcodeDir: dir(process.env.MEDIAMAX_TRANSCODE_DIR ?? path.join(dataDir, 'transcodes')),
  assetsDir: dir(path.join(dataDir, 'assets')),
  logDir: dir(path.join(dataDir, 'logs')),
  recordingsDir: process.env.MEDIAMAX_RECORDINGS ?? path.join(dataDir, 'recordings'),
  webDir: process.env.MEDIAMAX_WEB_DIR ?? (standalone ? path.join(exeDir, 'web') : path.resolve(here, '../../web/dist')),
  /** Help Centre articles (Markdown, server/help in the repo; `help/` next to a standalone binary). */
  helpDir: process.env.MEDIAMAX_HELP_DIR ?? (standalone ? path.join(exeDir, 'help') : path.resolve(here, '../help')),
  ffmpeg: process.env.MEDIAMAX_FFMPEG ?? bundledTool('ffmpeg'),
  ffprobe: process.env.MEDIAMAX_FFPROBE ?? bundledTool('ffprobe'),
  // Optional helper programs, set only through the environment (VIBE_PIPER, VIBE_WHISPER, VIBE_COMSKIP) like FFmpeg,
  // never through web settings: a Vibe admin account must not be able to make the server start a program of its choice.
  piper: process.env.MEDIAMAX_PIPER || 'piper',
  comskip: process.env.MEDIAMAX_COMSKIP || 'comskip',
  logLevel: process.env.MEDIAMAX_LOG_LEVEL ?? 'info',
  startedAt: Date.now(),
};
