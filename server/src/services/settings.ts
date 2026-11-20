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
  dvr: { recordingsPath: config.recordingsDir, paddingBeforeMin: 1, paddingAfterMin: 5, commercialDetection: false, comskipPath: null, comskipIni: null },
  webhooks: [],
  cinema: { enabled: false, trailers: 2, unwatchedOnly: true, prerollLibraryId: null },
  aiDj: {
    enabled: true, chattiness: 'normal', hostName: 'Max',
    llm: { provider: 'none', url: null, model: null, apiKey: null, maxRequestsPerDay: 300 },
    tts: { provider: 'device', piperPath: null, voiceModel: null, speaker: null, url: null, model: null, voice: null, apiKey: null },
  },
  allowPasswordlessProfiles: true,
  blockUnratedForRestricted: false,
  trickplay: { enabled: false, intervalSeconds: 10, width: 320 },
  openSubtitles: { apiKey: process.env.OPENSUBTITLES_API_KEY ?? null, username: null, password: null, autoLanguages: [] },
  trakt: { clientId: process.env.TRAKT_CLIENT_ID ?? null, clientSecret: process.env.TRAKT_CLIENT_SECRET ?? null },
  dlna: { enabled: false, friendlyName: null, userId: null },
  lastfm: { apiKey: process.env.LASTFM_API_KEY ?? null, sharedSecret: process.env.LASTFM_SECRET ?? null },
  plugins: { repositories: [] },
  remoteAccess: { upnp: false, externalPort: null },
  backups: { intervalDays: 7, keep: 5 },
  requests: { enabled: true, autoApproveUserIds: [], weeklyLimit: 10, radarr: null, sonarr: null },
  oidc: { enabled: false, issuer: null, clientId: null, clientSecret: null, buttonLabel: 'Sign in with SSO', autoCreateUsers: true, groupsClaim: 'groups', adminGroup: null, allowedGroup: null },
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
    cinema: { ...DEFAULT_SETTINGS.cinema, ...(stored.cinema ?? {}) },
    aiDj: { ...DEFAULT_SETTINGS.aiDj, ...(stored.aiDj ?? {}), llm: { ...DEFAULT_SETTINGS.aiDj.llm, ...(stored.aiDj?.llm ?? {}) }, tts: { ...DEFAULT_SETTINGS.aiDj.tts, ...(stored.aiDj?.tts ?? {}) } },
    trickplay: { ...DEFAULT_SETTINGS.trickplay, ...(stored.trickplay ?? {}) },
    openSubtitles: { ...DEFAULT_SETTINGS.openSubtitles, ...(stored.openSubtitles ?? {}) },
    trakt: { ...DEFAULT_SETTINGS.trakt, ...(stored.trakt ?? {}) },
    dlna: { ...DEFAULT_SETTINGS.dlna, ...(stored.dlna ?? {}) },
    lastfm: { ...DEFAULT_SETTINGS.lastfm, ...(stored.lastfm ?? {}) },
    requests: { ...DEFAULT_SETTINGS.requests, ...(stored.requests ?? {}) },
    plugins: { ...DEFAULT_SETTINGS.plugins, ...(stored.plugins ?? {}) },
    remoteAccess: { ...DEFAULT_SETTINGS.remoteAccess, ...(stored.remoteAccess ?? {}) },
    backups: { ...DEFAULT_SETTINGS.backups, ...(stored.backups ?? {}) },
    oidc: { ...DEFAULT_SETTINGS.oidc, ...(stored.oidc ?? {}) },
    webhooks: stored.webhooks ?? [],
  };
  return cache;
}

export const SECRET_MASK = '••••';

/** Settings as sent to the admin UI: AI service keys are write-only. */
export function publicSettings(s: ServerSettings = getSettings()): ServerSettings {
  return {
    ...s,
    aiDj: { ...s.aiDj, llm: { ...s.aiDj.llm, apiKey: s.aiDj.llm.apiKey ? SECRET_MASK : null }, tts: { ...s.aiDj.tts, apiKey: s.aiDj.tts.apiKey ? SECRET_MASK : null } },
  };
}

export function updateSettings(patch: Partial<ServerSettings>): ServerSettings {
  const cur = getSettings();
  // The masked placeholder means "keep the stored key".
  if (patch.aiDj?.llm?.apiKey === SECRET_MASK) patch = { ...patch, aiDj: { ...patch.aiDj, llm: { ...patch.aiDj.llm, apiKey: cur.aiDj.llm.apiKey } } };
  if (patch.aiDj?.tts?.apiKey === SECRET_MASK) patch = { ...patch, aiDj: { ...patch.aiDj!, tts: { ...patch.aiDj!.tts!, apiKey: cur.aiDj.tts.apiKey } } };
  const next: ServerSettings = {
    ...cur,
    ...patch,
    transcoding: { ...cur.transcoding, ...(patch.transcoding ?? {}) },
    dvr: { ...cur.dvr, ...(patch.dvr ?? {}) },
    cinema: { ...cur.cinema, ...(patch.cinema ?? {}) },
    aiDj: { ...cur.aiDj, ...(patch.aiDj ?? {}), llm: { ...cur.aiDj.llm, ...(patch.aiDj?.llm ?? {}) }, tts: { ...cur.aiDj.tts, ...(patch.aiDj?.tts ?? {}) } },
    trickplay: { ...cur.trickplay, ...(patch.trickplay ?? {}) },
    openSubtitles: { ...cur.openSubtitles, ...(patch.openSubtitles ?? {}) },
    trakt: { ...cur.trakt, ...(patch.trakt ?? {}) },
    dlna: { ...cur.dlna, ...(patch.dlna ?? {}) },
    lastfm: { ...cur.lastfm, ...(patch.lastfm ?? {}) },
    requests: { ...cur.requests, ...(patch.requests ?? {}) },
    remoteAccess: { ...cur.remoteAccess, ...(patch.remoteAccess ?? {}) },
    backups: { ...cur.backups, ...(patch.backups ?? {}) },
    plugins: { repositories: (patch.plugins?.repositories ?? cur.plugins.repositories).map((u) => String(u).trim()).filter(Boolean).slice(0, 20) },
    oidc: { ...cur.oidc, ...(patch.oidc ?? {}) },
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
