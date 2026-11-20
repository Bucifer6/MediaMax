import type { HomeAssistantSettings, HomeAssistantStatus, HomeAssistantTestResult, NowPlayingStatus, StorageSettings, StorageStatus, Webhook, WebhookEvent } from '@mediamax/shared';
import { http } from './client';

/** Home Assistant / smart home and storage (disk spin-down) endpoints (kept apart from endpoints.ts). */
export const smartHomeApi = {
  homeAssistant: () => http.get<{ settings: HomeAssistantSettings; status: HomeAssistantStatus }>('/integrations/home-assistant'),
  saveHomeAssistant: (s: HomeAssistantSettings) => http.put<{ settings: HomeAssistantSettings; status: HomeAssistantStatus }>('/integrations/home-assistant', s),
  testMqtt: (s: HomeAssistantSettings) => http.post<HomeAssistantTestResult>('/integrations/home-assistant/test', s),
  publishDiscovery: () => http.post<{ ok: true; entities: number; status: HomeAssistantStatus }>('/integrations/home-assistant/discovery'),
  addHaWebhook: (haUrl: string, webhookId: string, events?: WebhookEvent[]) => http.post<{ webhook: Webhook; webhooks: Webhook[] }>('/integrations/home-assistant/webhook', { haUrl, webhookId, events }),
  testHaWebhook: (url: string) => http.post<{ ok: boolean; status: number | null; error?: string }>('/integrations/home-assistant/webhook/test', { url }),
  nowPlaying: () => http.get<NowPlayingStatus>('/status/now-playing'),
  storage: () => http.get<StorageStatus>('/storage'),
  saveStorage: (s: Partial<StorageSettings>) => http.put<StorageStatus>('/storage', s),
  runDeferred: (diskKey?: string) => http.post<{ ok: true; disks: number }>('/storage/run-deferred', diskKey ? { diskKey } : {}),
};
