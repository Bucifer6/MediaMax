import type { ArrInstance, ArrKind, ArrService, ServerSettings } from '@mediamax/shared';
import { db } from '../db.js';
import { config } from '../config.js';
import { newId } from '../util/ids.js';
import { maskAgents, mergeAgents } from './notify/kinds.js';

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
    gpuIndex: 0,
    preferredCodecs: ['hevc', 'h264'],
    allowHevcEncoding: true,
    allowAv1Encoding: false,
    hardwareToneMapping: true,
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
  arr: [],
  notificationAgents: [],
  oidc: { enabled: false, issuer: null, clientId: null, clientSecret: null, buttonLabel: 'Sign in with SSO', autoCreateUsers: true, groupsClaim: 'groups', adminGroup: null, allowedGroup: null },
  sessionTimeoutDays: 90,
  karaoke: { stemsEnabled: false, stemsModelUrl: null, stemsModelSha256: null, writeLrcSidecars: false },
};

let cache: ServerSettings | null = null;

const ARR_KINDS: ArrKind[] = ['radarr', 'sonarr', 'lidarr', 'readarr', 'bazarr'];
const ARR_NAMES: Record<ArrKind, string> = { radarr: 'Radarr', sonarr: 'Sonarr', lidarr: 'Lidarr', readarr: 'Readarr', bazarr: 'Bazarr' };

/** The old single Radarr/Sonarr config as instances (used for the one-time migration and as a fallback). */
export function legacyArrInstances(req: Partial<ServerSettings['requests']> | undefined, ids: { radarr?: string; sonarr?: string } = {}): ArrInstance[] {
  const out: ArrInstance[] = [];
  for (const kind of ['radarr', 'sonarr'] as const) {
    const svc = req?.[kind] as ArrService | null | undefined;
    if (!svc?.url) continue;
    out.push({
      id: ids[kind] ?? `legacy-${kind}`, kind, name: ARR_NAMES[kind], url: svc.url, apiKey: svc.apiKey ?? '', enabled: true, is4k: false,
      qualityProfileId: svc.qualityProfileId ?? null, rootFolderPath: svc.rootFolder ?? null, searchOnAdd: svc.searchOnAdd ?? true,
      seasonFolders: true, tags: [], pathMappings: [],
    });
  }
  return out;
}

/** Validate and normalise *arr instances coming from the admin UI; "••••" keeps the stored API key. */
function normaliseArr(list: unknown, current: ArrInstance[]): ArrInstance[] {
  if (!Array.isArray(list)) return current;
  const seen = new Set<string>();
  return list.slice(0, 50).flatMap((raw): ArrInstance[] => {
    const x = (raw ?? {}) as Partial<ArrInstance>;
    if (!ARR_KINDS.includes(x.kind as ArrKind)) return [];
    let id = typeof x.id === 'string' && /^[\w-]{1,64}$/.test(x.id) ? x.id : newId();
    if (seen.has(id)) id = newId();
    seen.add(id);
    const prev = current.find((c) => c.id === id);
    const num = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)));
    const str = (v: unknown, max = 1000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
    const kind = x.kind as ArrKind;
    return [{
      id, kind, name: str(x.name, 80) ?? ARR_NAMES[kind],
      url: (str(x.url) ?? '').replace(/\/+$/, ''),
      apiKey: x.apiKey === SECRET_MASK ? prev?.apiKey ?? '' : str(x.apiKey, 200) ?? '',
      enabled: x.enabled !== false,
      is4k: !!x.is4k,
      qualityProfileId: num(x.qualityProfileId),
      rootFolderPath: str(x.rootFolderPath),
      languageProfileId: num(x.languageProfileId),
      metadataProfileId: num(x.metadataProfileId),
      tags: Array.isArray(x.tags) ? x.tags.map(Number).filter((n) => Number.isInteger(n)).slice(0, 50) : [],
      seasonFolders: x.seasonFolders !== false,
      monitor: str(x.monitor, 40) ?? undefined,
      searchOnAdd: x.searchOnAdd !== false,
      pathMappings: Array.isArray(x.pathMappings)
        ? x.pathMappings.map((m) => ({ remotePath: str(m?.remotePath) ?? '', localPath: str(m?.localPath) ?? '' })).filter((m) => m.remotePath && m.localPath).slice(0, 20)
        : [],
    }];
  });
}

export function getSettings(): ServerSettings {
  if (cache) return cache;
  const stored = getKv<Partial<ServerSettings>>('server', {});
  // One-time migration: the single Radarr/Sonarr under `requests` becomes the first entries of `arr`.
  // The old fields stay in place (and are still read as a fallback if `arr` is missing).
  if (stored.arr === undefined && (stored.requests?.radarr?.url || stored.requests?.sonarr?.url)) {
    stored.arr = legacyArrInstances(stored.requests, { radarr: newId(), sonarr: newId() });
    setKv('server', stored);
  }
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
    karaoke: { ...DEFAULT_SETTINGS.karaoke!, ...(stored.karaoke ?? {}) },
    webhooks: stored.webhooks ?? [],
    arr: Array.isArray(stored.arr) ? stored.arr : legacyArrInstances(stored.requests),
    notificationAgents: Array.isArray(stored.notificationAgents) ? stored.notificationAgents : [],
  };
  return cache;
}

export const SECRET_MASK = '••••';

/** Other write-only secrets: [section, key] (section null = top level). Sent masked, a masked value back keeps them. */
const SECRET_FIELDS: [keyof ServerSettings | null, string][] = [
  [null, 'tmdbApiKey'], ['openSubtitles', 'apiKey'], ['openSubtitles', 'password'], ['trakt', 'clientSecret'], ['lastfm', 'sharedSecret'], ['oidc', 'clientSecret'],
];

/** Settings as sent to the admin UI: service keys, passwords and client secrets are write-only. */
export function publicSettings(s: ServerSettings = getSettings()): ServerSettings {
  const maskSvc = (v: ArrService | null) => (v ? { ...v, apiKey: v.apiKey ? SECRET_MASK : '' } : v);
  const masked: Record<string, any> = { ...s };
  for (const [sec, key] of SECRET_FIELDS) {
    if (sec === null) masked[key] = masked[key] ? SECRET_MASK : masked[key];
    else if (masked[sec]?.[key]) masked[sec] = { ...masked[sec], [key]: SECRET_MASK };
  }
  return {
    ...(masked as ServerSettings),
    requests: { ...s.requests, radarr: maskSvc(s.requests.radarr), sonarr: maskSvc(s.requests.sonarr) },
    arr: s.arr.map((a) => ({ ...a, apiKey: a.apiKey ? SECRET_MASK : '' })),
    notificationAgents: maskAgents(s.notificationAgents),
    aiDj: { ...s.aiDj, llm: { ...s.aiDj.llm, apiKey: s.aiDj.llm.apiKey ? SECRET_MASK : null }, tts: { ...s.aiDj.tts, apiKey: s.aiDj.tts.apiKey ? SECRET_MASK : null } },
  };
}

export function updateSettings(patch: Partial<ServerSettings>): ServerSettings {
  const cur = getSettings();
  // The masked placeholder means "keep the stored key".
  if (patch.aiDj?.llm?.apiKey === SECRET_MASK) patch = { ...patch, aiDj: { ...patch.aiDj, llm: { ...patch.aiDj.llm, apiKey: cur.aiDj.llm.apiKey } } };
  if (patch.aiDj?.tts?.apiKey === SECRET_MASK) patch = { ...patch, aiDj: { ...patch.aiDj!, tts: { ...patch.aiDj!.tts!, apiKey: cur.aiDj.tts.apiKey } } };
  for (const [sec, key] of SECRET_FIELDS) {
    const p = patch as Record<string, any>;
    if (sec === null) {
      if (p[key] === SECRET_MASK) patch = { ...patch, [key]: (cur as Record<string, any>)[key] };
    } else if (p[sec]?.[key] === SECRET_MASK) {
      patch = { ...patch, [sec]: { ...p[sec], [key]: (cur as Record<string, any>)[sec]?.[key] ?? null } };
    }
  }
  for (const k of ['radarr', 'sonarr'] as const) {
    const svc = patch.requests?.[k];
    if (svc && svc.apiKey === SECRET_MASK) patch = { ...patch, requests: { ...patch.requests!, [k]: { ...svc, apiKey: cur.requests[k]?.apiKey ?? '' } } };
  }
  const next: ServerSettings = {
    ...cur,
    ...patch,
    transcoding: normaliseTranscoding({ ...cur.transcoding, ...(patch.transcoding ?? {}) }),
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
    karaoke: { ...DEFAULT_SETTINGS.karaoke!, ...(cur.karaoke ?? {}), ...(patch.karaoke ?? {}) },
    webhooks: (patch.webhooks ?? cur.webhooks).map((w) => ({ ...w, id: w.id || newId() })),
    arr: patch.arr !== undefined ? normaliseArr(patch.arr, cur.arr) : cur.arr,
    notificationAgents: patch.notificationAgents !== undefined ? mergeAgents(patch.notificationAgents, cur.notificationAgents, newId) : cur.notificationAgents ?? [],
  };
  setKv('server', next);
  cache = next;
  return next;
}

const HW_ACCELS = ['none', 'vaapi', 'nvenc', 'qsv', 'videotoolbox', 'v4l2m2m', 'amf', 'rkmpp'];
const OUT_CODECS = ['h264', 'hevc', 'av1'];

function normaliseTranscoding(t: ServerSettings['transcoding']): ServerSettings['transcoding'] {
  const codecs = Array.isArray(t.preferredCodecs) ? t.preferredCodecs.filter((c) => OUT_CODECS.includes(c)) : DEFAULT_SETTINGS.transcoding.preferredCodecs;
  return {
    ...t,
    hwAccel: HW_ACCELS.includes(t.hwAccel) ? t.hwAccel : 'none',
    gpuIndex: Math.max(0, Math.min(15, Math.floor(Number(t.gpuIndex) || 0))),
    preferredCodecs: [...new Set(codecs)],
  };
}

export function serverId(): string {
  let id = getKv<string | null>('serverId', null);
  if (!id) {
    id = newId();
    setKv('serverId', id);
  }
  return id;
}
