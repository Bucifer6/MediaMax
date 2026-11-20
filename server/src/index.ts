import { config } from './config.js';
import { buildApp } from './app.js';
import { logger } from './util/log.js';
import { startScheduler, stopScheduler } from './services/tasks.js';
import { cleanupTranscodeDir, ffmpegAvailable } from './services/transcoder.js';
import { initWebhooks } from './services/webhooks.js';
import { initTrakt } from './services/trakt.js';
import { serverId } from './services/settings.js';

const log = logger('main');

async function main() {
  if (!ffmpegAvailable()) log.warn('ffmpeg was not found — transcoding, live TV remuxing and DVR will not work. Set MEDIAMAX_FFMPEG.');
  cleanupTranscodeDir();
  initWebhooks();
  initTrakt();
  const app = await buildApp();
  await app.listen({ port: config.port, host: config.host });
  log.info(`MediaMax ${config.version} (server ${serverId()}) listening on http://${config.host}:${config.port}`);
  log.info(`Data directory: ${config.dataDir}`);
  if (process.env.MEDIAMAX_NO_SCHEDULER !== '1') startScheduler();
  const shutdown = async (sig: string) => {
    log.info(`${sig} received, shutting down`);
    stopScheduler();
    await app.close();
    cleanupTranscodeDir();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  log.error('Fatal startup error', e);
  process.exit(1);
});
