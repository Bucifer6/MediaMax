import type { FastifyInstance } from 'fastify';
import type { HomeAssistantSettings, StorageSettings, Webhook, WebhookEvent } from '@mediamax/shared';
import { noCache, requireAdmin, requireUser } from '../http.js';
import { badRequest } from '../util/errors.js';
import { newId } from '../util/ids.js';
import { getSettings, updateSettings } from '../services/settings.js';
import { sendWebhook } from '../services/webhooks.js';
import { nowPlaying } from '../services/smarthome/nowplaying.js';
import { haStatus, publicHaSettings, publishDiscovery, saveHaSettings, testMqtt } from '../services/smarthome/homeassistant.js';
import { haWebhookPayload, haWebhookUrl } from '../services/smarthome/hawebhook.js';
import { getStorageSettings, saveStorageSettings, storageStatus, piggyback, allDiskKeys } from '../services/storage/storage.js';
import { syncWatchers, watchInfo } from '../services/watcher.js';
import { logActivity } from '../services/activity.js';

const HA_EVENTS: WebhookEvent[] = ['playback.start', 'playback.pause', 'playback.resume', 'playback.stop', 'library.new'];

/** Smart-home integrations (Home Assistant) and NAS storage / disk spin-down settings. */
export default async function smartHomeRoutes(app: FastifyInstance) {
  /* ------------------------- now playing (REST) ----------------------- */
  // For Home Assistant's REST sensor, Homepage/Homarr widgets…: authenticate with an API key
  // (X-Api-Key header or ?api_key=). Admin keys see every stream, other users only their own.
  app.get('/status/now-playing', async (req, reply) => {
    const a = requireUser(req);
    noCache(reply);
    return nowPlaying(a.user.isAdmin ? undefined : a.user.id);
  });

  /* --------------------------- Home Assistant ------------------------- */
  app.get('/integrations/home-assistant', async (req) => {
    requireAdmin(req);
    return { settings: publicHaSettings(), status: haStatus() };
  });
  app.put<{ Body: Partial<HomeAssistantSettings> }>('/integrations/home-assistant', async (req) => {
    const a = requireAdmin(req);
    try {
      await saveHaSettings(req.body ?? {});
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    logActivity('settings', 'Home Assistant settings changed', { userId: a.user.id });
    return { settings: publicHaSettings(), status: haStatus() };
  });
  app.post<{ Body: Partial<HomeAssistantSettings> }>('/integrations/home-assistant/test', async (req) => {
    requireAdmin(req);
    return testMqtt(req.body && Object.keys(req.body).length ? req.body : undefined);
  });
  app.post('/integrations/home-assistant/discovery', async (req) => {
    requireAdmin(req);
    try {
      const n = await publishDiscovery();
      return { ok: true, entities: n, status: haStatus() };
    } catch (e) {
      throw badRequest((e as Error).message);
    }
  });
  /** One-click preset: add a webhook in Home Assistant's format pointing at HA's /api/webhook/<id>. */
  app.post<{ Body: { haUrl?: string; webhookId?: string; events?: WebhookEvent[] } }>('/integrations/home-assistant/webhook', async (req) => {
    requireAdmin(req);
    let url: string;
    try {
      url = haWebhookUrl(String(req.body?.haUrl ?? ''), String(req.body?.webhookId ?? ''));
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    const events = Array.isArray(req.body?.events) && req.body.events.length ? req.body.events : HA_EVENTS;
    const hook: Webhook = { id: newId(), url, events, enabled: true, format: 'home-assistant', name: 'Home Assistant' };
    const cur = getSettings().webhooks;
    if (cur.some((w) => w.url === url)) throw badRequest('A webhook with this URL already exists');
    updateSettings({ webhooks: [...cur, hook] });
    return { webhook: hook, webhooks: getSettings().webhooks };
  });
  app.post<{ Body: { url?: string } }>('/integrations/home-assistant/webhook/test', async (req) => {
    requireAdmin(req);
    const url = String(req.body?.url ?? '');
    if (!/^https?:\/\//i.test(url)) throw badRequest('Webhook URL required');
    return sendWebhook(url, haWebhookPayload('test', {}));
  });

  /* ------------------------------ storage ----------------------------- */
  app.get('/storage', async (req, reply) => {
    requireAdmin(req);
    noCache(reply);
    return storageStatus(watchInfo);
  });
  app.put<{ Body: Partial<StorageSettings> }>('/storage', async (req) => {
    const a = requireAdmin(req);
    const before = getStorageSettings();
    const next = saveStorageSettings(req.body ?? {});
    if (before.watchMode !== next.watchMode || before.pollIntervalMinutes !== next.pollIntervalMinutes) {
      if (process.env.MEDIAMAX_NO_WATCH !== '1') syncWatchers();
    }
    logActivity('settings', `Storage settings changed (disk-friendly mode ${next.diskFriendly ? 'on' : 'off'})`, { userId: a.user.id });
    return storageStatus(watchInfo);
  });
  /** Run the postponed work now for every disk (or one disk key). */
  app.post<{ Body: { diskKey?: string } }>('/storage/run-deferred', async (req) => {
    requireAdmin(req);
    const keys = req.body?.diskKey ? [req.body.diskKey] : allDiskKeys();
    void (async () => {
      for (const k of keys) await piggyback(k);
    })();
    return { ok: true, disks: keys.length };
  });
}
