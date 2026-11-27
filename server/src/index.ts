import './threadpool.js'; // before any async fs call: sizes libuv's thread pool (see the file)
import './bootstrap-restore.js'; // must stay first after the thread pool: applies staged restores before the DB opens
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
import { stopAllSessions } from './services/playback.js';
import { stopActiveRecordings } from './services/dvr.js';
import { stopNetwork } from './services/network.js';
import { initHardwareDetection } from './services/hwdetect.js';
import { initUpdates } from './services/updates.js';
import { startWatchdog } from './util/watchdog.js';

const log = logger('main');

async function main() {
  startWatchdog(config.logDir); // first: stalls and crashes during start-up are recorded too
  if (!ffmpegAvailable()) log.warn('ffmpeg was not found — transcoding, live TV remuxing and DVR will not work. Set KINORA_FFMPEG.');
  cleanupTranscodeDir();
  initWebhooks();
  initTrakt();
  initLastfm();
  initListenBrainz();
  initStorage();
  const app = await buildApp();
  await app.listen({ port: config.port, host: config.host });
  log.info(`Vibe ${config.version} (server ${serverId()}) listening on http://${config.host}:${config.port}`);
  log.info(`Data directory: ${config.dataDir}`);
  log.info(`Help Centre: ${helpArticleCount()} articles from ${config.helpDir}`);
  if (process.env.MEDIAMAX_NO_SCHEDULER !== '1') startScheduler();
  syncDlna();
  startRemoteAccess();
  initHomeAssistant();
  startRenderers();
  initHardwareDetection(); // loads the cached GPU report, or re-detects in the background
  void initUpdates().catch((e) => log.warn(`Update set-up check failed: ${(e as Error).message}`)); // old downloads, the updater task
  await loadPlugins().catch((e) => log.error('Plugin loading failed', e));
  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${sig} received, shutting down`);
    // Don't hang on a stuck integration or a long-lived connection.
    setTimeout(() => process.exit(0), 10000).unref();
    stopScheduler();
    // Child processes (transcodes, recordings) are not killed with the server on every platform.
    stopAllSessions();
    stopActiveRecordings();
    stopDlna();
    await stopHomeAssistant().catch(() => {});
    await stopRenderers();
    await stopRemoteAccess();
    await stopNetwork();
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
