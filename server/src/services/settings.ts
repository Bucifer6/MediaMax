import type { ServerSettings } from '@mediamax/shared';
import { db } from '../db.js';
import { config } from '../config.js';
import { newId } from '../util/ids.js';

export function getKv<T>(key: string, fallback: T): T {
  const row = db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setKv(key: string, value: unknown) {
  db.upsert('settings', { key, value: JSON.stringify(value) }, 'key');
}

export const DEFAULT_SETTINGS: ServerSettings = {
  serverName: 'MediaMax',
  publicUrl: null,
  tmdbApiKey: process.env.TMDB_API_KEY ?? null,
  metadataLanguage: 'en-US',
  scanIntervalMinutes: 360,
  epgRefreshHours: 12,
  transcoding: {
    enabled: true,
    hwAccel: (process.env.MEDIAMAX_HWACCEL as ServerSettings['transcoding']['hwAccel']) ?? 'none',
    vaapiDevice: '/dev/dri/renderD128',
    maxConcurrent: 4,
    defaultBitrate: 8000,
    preset: 'veryfast',
    threads: 0,
    segmentSeconds: 4,
    toneMapHdr: true,
  },
  dvr: { recordingsPath: config.recordingsDir, paddingBeforeMin: 1, paddingAfterMin: 5 },
  webhooks: [],
  allowPasswordlessProfiles: true,
  blockUnratedForRestricted: false,
  sessionTimeoutDays: 90,
};

let cache: ServerSettings | null = null;

export function getSettings(): ServerSettings {
  if (cache) return cache;
  const stored = getKv<Partial<ServerSettings>>('server', {});
  cache = {
    ...DEFAULT_SETTINGS,
    ...stored,
    transcoding: { ...DEFAULT_SETTINGS.transcoding, ...(stored.transcoding ?? {}) },
    dvr: { ...DEFAULT_SETTINGS.dvr, ...(stored.dvr ?? {}) },
    webhooks: stored.webhooks ?? [],
  };
  return cache;
}

export function updateSettings(patch: Partial<ServerSettings>): ServerSettings {
  const cur = getSettings();
  const next: ServerSettings = {
    ...cur,
    ...patch,
    transcoding: { ...cur.transcoding, ...(patch.transcoding ?? {}) },
    dvr: { ...cur.dvr, ...(patch.dvr ?? {}) },
    webhooks: (patch.webhooks ?? cur.webhooks).map((w) => ({ ...w, id: w.id || newId() })),
  };
  setKv('server', next);
  cache = next;
  return next;
}

export function serverId(): string {
  let id = getKv<string | null>('serverId', null);
  if (!id) {
    id = newId();
    setKv('serverId', id);
  }
  return id;
}
