import './env.js'; // must stay first: KINORA_* environment variables override their MEDIAMAX_* twins
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { isSea } from 'node:sea';

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
 * The data directory for a standalone install. Kinora's own folder is the default, but a folder left by an earlier
 * Kinora install is used when it exists and the Kinora one does not, so upgrading keeps the library, users and
 * settings without moving anything:
 *   Windows  %ProgramData%\Kinora              (legacy %ProgramData%\MediaMax)
 *   systemd  STATE_DIRECTORY (/var/lib/kinora)  (legacy /var/lib/mediamax)
 *   Linux    ~/.local/share/kinora               (legacy ~/.local/share/mediamax)
 */
export function pickDataDir(preferred: string, legacy: string, exists: (p: string) => boolean = fs.existsSync): string {
  return !exists(preferred) && exists(legacy) ? legacy : preferred;
}

function defaultDataDir(): string {
  if (!standalone) return path.join(process.cwd(), 'data');
  // Windows: a machine-wide folder, so the boot-time task (running as SYSTEM) and the user see the same data.
  if (process.platform === 'win32') {
    const base = process.env.ProgramData ?? 'C:\\ProgramData';
    return pickDataDir(path.join(base, 'Kinora'), path.join(base, 'MediaMax'));
  }
  // systemd's StateDirectory= sets STATE_DIRECTORY (normally /var/lib/kinora).
  if (process.env.STATE_DIRECTORY) {
    const state = process.env.STATE_DIRECTORY.split(':')[0];
    // systemd creates the state directory before starting us, so look for a database rather than the folder.
    const legacy = path.join(path.dirname(state), 'mediamax');
    return !fs.existsSync(path.join(state, 'mediamax.db')) && fs.existsSync(path.join(legacy, 'mediamax.db')) ? legacy : state;
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return pickDataDir(path.join(base, 'kinora'), path.join(base, 'mediamax'));
}

/** Prefer the ffmpeg/ffprobe shipped beside a standalone binary, else whatever is on the PATH. */
function bundledTool(name: string): string {
  const local = path.join(exeDir, name + exe);
  return standalone && fs.existsSync(local) ? local : name;
}

const dataDir = path.resolve(process.env.MEDIAMAX_DATA ?? defaultDataDir());

export const config = {
  version: '0.2.0',
  port: Number(process.env.MEDIAMAX_PORT ?? process.env.PORT ?? 8484),
  host: process.env.MEDIAMAX_HOST ?? '0.0.0.0',
  dataDir: dir(dataDir),
  // The database keeps its original file name (renaming it would orphan existing installs).
  dbPath: path.join(dataDir, 'mediamax.db'),
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
  logLevel: process.env.MEDIAMAX_LOG_LEVEL ?? 'info',
  startedAt: Date.now(),
};
