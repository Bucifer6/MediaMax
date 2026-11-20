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

function defaultDataDir(): string {
  if (!standalone) return path.join(process.cwd(), 'data');
  // Windows: a machine-wide folder, so the boot-time task (running as SYSTEM) and the user see the same data.
  if (process.platform === 'win32') return path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'MediaMax');
  // systemd's StateDirectory= sets STATE_DIRECTORY (normally /var/lib/mediamax).
  if (process.env.STATE_DIRECTORY) return process.env.STATE_DIRECTORY.split(':')[0];
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'mediamax');
}

/** Prefer the ffmpeg/ffprobe shipped beside a standalone binary, else whatever is on the PATH. */
function bundledTool(name: string): string {
  const local = path.join(exeDir, name + exe);
  return standalone && fs.existsSync(local) ? local : name;
}

const dataDir = path.resolve(process.env.MEDIAMAX_DATA ?? defaultDataDir());

export const config = {
  version: '0.1.0',
  port: Number(process.env.MEDIAMAX_PORT ?? process.env.PORT ?? 8484),
  host: process.env.MEDIAMAX_HOST ?? '0.0.0.0',
  dataDir: dir(dataDir),
  dbPath: path.join(dataDir, 'mediamax.db'),
  cacheDir: dir(path.join(dataDir, 'cache')),
  imageCacheDir: dir(path.join(dataDir, 'cache', 'images')),
  transcodeDir: dir(process.env.MEDIAMAX_TRANSCODE_DIR ?? path.join(dataDir, 'transcodes')),
  assetsDir: dir(path.join(dataDir, 'assets')),
  logDir: dir(path.join(dataDir, 'logs')),
  recordingsDir: process.env.MEDIAMAX_RECORDINGS ?? path.join(dataDir, 'recordings'),
  webDir: process.env.MEDIAMAX_WEB_DIR ?? (standalone ? path.join(exeDir, 'web') : path.resolve(here, '../../web/dist')),
  ffmpeg: process.env.MEDIAMAX_FFMPEG ?? bundledTool('ffmpeg'),
  ffprobe: process.env.MEDIAMAX_FFPROBE ?? bundledTool('ffprobe'),
  logLevel: process.env.MEDIAMAX_LOG_LEVEL ?? 'info',
  startedAt: Date.now(),
};
