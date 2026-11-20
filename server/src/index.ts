import './bootstrap-restore.js'; // must stay first: applies staged restores before the DB opens
import { config } from './config.js';
import { buildApp } from './app.js';
import { logger } from './util/log.js';
import { startScheduler, stopScheduler } from './services/tasks.js';
import { cleanupTranscodeDir, ffmpegAvailable } from './services/transcoder.js';
import { initWebhooks } from './services/webhooks.js';
import { initTrakt } from './services/trakt.js';
import { initLastfm } from './services/lastfm.js';
import { initListenBrainz } from './services/listenbrainz.js';
import { serverId } from './services/settings.js';
import { syncDlna, stopDlna } from './services/dlna.js';
import { startRemoteAccess, stopRemoteAccess } from './services/remote.js';
import { loadAll as loadPlugins } from './services/plugins.js';
import { initHomeAssistant, stopHomeAssistant } from './services/smarthome/homeassistant.js';
import { initStorage } from './services/storage/storage.js';
import { startRenderers, stopRenderers } from './services/renderers/index.js';
import { helpArticleCount } from './services/help.js';

const log = logger('main');

async function main() {
  if (!ffmpegAvailable()) log.warn('ffmpeg was not found — transcoding, live TV remuxing and DVR will not work. Set MEDIAMAX_FFMPEG.');
  cleanupTranscodeDir();
  initWebhooks();
  initTrakt();
  initLastfm();
  initListenBrainz();
  initStorage();
  const app = await buildApp();
  await app.listen({ port: config.port, host: config.host });
  log.info(`MediaMax ${config.version} (server ${serverId()}) listening on http://${config.host}:${config.port}`);
  log.info(`Data directory: ${config.dataDir}`);
  log.info(`Help Centre: ${helpArticleCount()} articles from ${config.helpDir}`);
  if (process.env.MEDIAMAX_NO_SCHEDULER !== '1') startScheduler();
  syncDlna();
  startRemoteAccess();
  initHomeAssistant();
  startRenderers();
  await loadPlugins().catch((e) => log.error('Plugin loading failed', e));
  const shutdown = async (sig: string) => {
    log.info(`${sig} received, shutting down`);
    stopScheduler();
    stopDlna();
    await stopHomeAssistant().catch(() => {});
    await stopRenderers();
    await stopRemoteAccess();
    await app.close();
    cleanupTranscodeDir();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// Never let one bad request/socket take the whole server down.
process.on('uncaughtException', (e) => log.error('Uncaught exception', e));
process.on('unhandledRejection', (e) => log.error('Unhandled rejection', e));

main().catch((e) => {
  log.error('Fatal startup error', e);
  process.exit(1);
});
