import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function dir(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

const dataDir = path.resolve(process.env.MEDIAMAX_DATA ?? path.join(process.cwd(), 'data'));

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
  webDir: process.env.MEDIAMAX_WEB_DIR ?? path.resolve(here, '../../web/dist'),
  ffmpeg: process.env.MEDIAMAX_FFMPEG ?? 'ffmpeg',
  ffprobe: process.env.MEDIAMAX_FFPROBE ?? 'ffprobe',
  logLevel: process.env.MEDIAMAX_LOG_LEVEL ?? 'info',
  startedAt: Date.now(),
};
