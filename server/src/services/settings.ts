import type { ArrInstance, ArrKind, ArrService, ServerSettings, RatingPosterSettings, SignInScreenSettings, SkipSegmentSettings, SubtitleSettings } from '@mediamax/shared';
import { db } from '../db.js';
import { config } from '../config.js';
import { newId } from '../util/ids.js';
import { badRequest } from '../util/errors.js';
import { productName } from '../util/product.js';
import { maskAgents, mergeAgents } from './notify/kinds.js';
import { aiFromStored, mergeAi, publicProviders, resolveProviderKeys, DEFAULT_AI } from './ai/settings.js';

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
  serverName: 'Vibe',
  publicUrl: null,
  tmdbApiKey: process.env.TMDB_API_KEY ?? null,
  metadataLanguage: 'en-US',
  scanIntervalMinutes: 360,
  epgRefreshHours: 12,
  liveTvSourceMode: 'failover',
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
    qsvApi: 'd3d11',
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
  subtitles: {
    providers: [{ id: 'opensubtitles', enabled: true }, { id: 'subsro', enabled: true }],
    subsRo: { apiKey: process.env.SUBSRO_API_KEY ?? null, baseUrl: 'https://api.subs.ro/v1.0' },
    languages: [],
    sync: false,
    minScore: 0,
    saveMode: 'data',
  },
  trakt: { clientId: process.env.TRAKT_CLIENT_ID ?? null, clientSecret: process.env.TRAKT_CLIENT_SECRET ?? null },
  dlna: { enabled: false, friendlyName: null, userId: null },
  lastfm: { apiKey: process.env.LASTFM_API_KEY ?? null, sharedSecret: process.env.LASTFM_SECRET ?? null },
  plugins: { repositories: [] },
  remoteAccess: { upnp: false, externalPort: null },
  backups: { intervalDays: 7, keep: 5 },
  updates: { autoCheck: true, autoInstall: true, includePrereleases: false },
  requests: { enabled: true, autoApproveUserIds: [], weeklyLimit: 10, radarr: null, sonarr: null },
  arr: [],
  notificationAgents: [],
  oidc: { enabled: false, issuer: null, clientId: null, clientSecret: null, buttonLabel: 'Sign in with SSO', autoCreateUsers: true, groupsClaim: 'groups', adminGroup: null, allowedGroup: null },
  sessionTimeoutDays: 90,
  defaultDateAdded: 'created',
  signInScreen: { showUsers: true, homeNetworkOnly: true },
  karaoke: { stemsEnabled: false, stemsModelUrl: null, stemsModelSha256: null, writeLrcSidecars: false },
  skipSegments: { introDb: false, aniSkip: false, introDbApiKey: null, parentalGuideUrl: null },
  simkl: { clientId: null },
  mdblist: { apiKey: null, ratings: false },
  ratingPosters: { urlTemplate: null, home: false, search: false, detail: false },
  ai: DEFAULT_AI,
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

/** Sign-in screen settings with every field a boolean (defaults for anything missing). */
export function signInScreenOf(v: Partial<SignInScreenSettings> | undefined): SignInScreenSettings {
  const d = DEFAULT_SETTINGS.signInScreen!;
  return { showUsers: typeof v?.showUsers === 'boolean' ? v.showUsers : d.showUsers, homeNetworkOnly: typeof v?.homeNetworkOnly === 'boolean' ? v.homeNetworkOnly : d.homeNetworkOnly };
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
    // Before subtitle providers existed, the automatic languages lived under openSubtitles.
    subtitles: normaliseSubtitles({ ...DEFAULT_SETTINGS.subtitles!, languages: stored.openSubtitles?.autoLanguages ?? [] }, stored.subtitles),
    trakt: { ...DEFAULT_SETTINGS.trakt, ...(stored.trakt ?? {}) },
    dlna: { ...DEFAULT_SETTINGS.dlna, ...(stored.dlna ?? {}) },
    lastfm: { ...DEFAULT_SETTINGS.lastfm, ...(stored.lastfm ?? {}) },
    requests: { ...DEFAULT_SETTINGS.requests, ...(stored.requests ?? {}) },
    plugins: { ...DEFAULT_SETTINGS.plugins, ...(stored.plugins ?? {}) },
    remoteAccess: { ...DEFAULT_SETTINGS.remoteAccess, ...(stored.remoteAccess ?? {}) },
    backups: { ...DEFAULT_SETTINGS.backups, ...(stored.backups ?? {}) },
    updates: { ...DEFAULT_SETTINGS.updates, ...(stored.updates ?? {}) },
    oidc: { ...DEFAULT_SETTINGS.oidc, ...(stored.oidc ?? {}) },
    karaoke: { ...DEFAULT_SETTINGS.karaoke!, ...(stored.karaoke ?? {}) },
    skipSegments: { ...DEFAULT_SETTINGS.skipSegments!, ...(stored.skipSegments ?? {}) },
    simkl: { ...DEFAULT_SETTINGS.simkl!, ...(stored.simkl ?? {}) },
    mdblist: { ...DEFAULT_SETTINGS.mdblist!, ...(stored.mdblist ?? {}) },
    ratingPosters: { ...DEFAULT_SETTINGS.ratingPosters!, ...(stored.ratingPosters ?? {}) },
    webhooks: stored.webhooks ?? [],
    arr: Array.isArray(stored.arr) ? stored.arr : legacyArrInstances(stored.requests),
    notificationAgents: Array.isArray(stored.notificationAgents) ? stored.notificationAgents : [],
    // Admin → AI; built from the DJ's language model the first time (aiDj.llm then mirrors ai.llm).
    ai: aiFromStored(stored),
  };
  cache.aiDj = { ...cache.aiDj, llm: { ...cache.ai!.llm } };
  // A server still carrying the former stock name shows the current one (a renamed server keeps its own name).
  cache.serverName = productName(cache.serverName);
  return cache;
}

export const SECRET_MASK = '••••';

/** Other write-only secrets: [section, key] (section null = top level). Sent masked, a masked value back keeps them. */
const SECRET_FIELDS: [keyof ServerSettings | null, string][] = [
  [null, 'tmdbApiKey'], ['openSubtitles', 'apiKey'], ['openSubtitles', 'password'], ['trakt', 'clientSecret'], ['lastfm', 'sharedSecret'], ['oidc', 'clientSecret'],
  ['skipSegments', 'introDbApiKey'], ['mdblist', 'apiKey'], ['ratingPosters', 'urlTemplate'],
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
    ...(s.subtitles ? { subtitles: { ...s.subtitles, subsRo: { ...s.subtitles.subsRo, apiKey: s.subtitles.subsRo.apiKey ? SECRET_MASK : null } } } : {}),
    ...(s.ai ? {
      ai: {
        ...s.ai, llm: { ...s.ai.llm, apiKey: s.ai.llm.apiKey ? SECRET_MASK : null }, autoSubtitles: { ...s.ai.autoSubtitles, apiKey: s.ai.autoSubtitles.apiKey ? SECRET_MASK : null },
        // Provider chains: keys are never sent, only whether one is stored.
        llmProviders: publicProviders(s.ai.llmProviders), ttsProviders: publicProviders(s.ai.ttsProviders),
      },
    } : {}),
  };
}

export function updateSettings(patch: Partial<ServerSettings>): ServerSettings {
  const cur = getSettings();
  // The masked placeholder means "keep the stored key".
  if (patch.aiDj?.llm?.apiKey === SECRET_MASK) patch = { ...patch, aiDj: { ...patch.aiDj, llm: { ...patch.aiDj.llm, apiKey: cur.aiDj.llm.apiKey } } };
  if (patch.aiDj?.tts?.apiKey === SECRET_MASK) patch = { ...patch, aiDj: { ...patch.aiDj!, tts: { ...patch.aiDj!.tts!, apiKey: cur.aiDj.tts.apiKey } } };
  if (patch.ai?.llm?.apiKey === SECRET_MASK) patch = { ...patch, ai: { ...patch.ai, llm: { ...patch.ai.llm, apiKey: cur.ai!.llm.apiKey } } };
  if (patch.ai?.autoSubtitles?.apiKey === SECRET_MASK) patch = { ...patch, ai: { ...patch.ai!, autoSubtitles: { ...patch.ai!.autoSubtitles, apiKey: cur.ai!.autoSubtitles.apiKey } } };
  if (Array.isArray(patch.ai?.llmProviders)) patch = { ...patch, ai: { ...patch.ai!, llmProviders: resolveProviderKeys(patch.ai!.llmProviders, cur.ai?.llmProviders ?? [], SECRET_MASK) } };
  if (Array.isArray(patch.ai?.ttsProviders)) patch = { ...patch, ai: { ...patch.ai!, ttsProviders: resolveProviderKeys(patch.ai!.ttsProviders, cur.ai?.ttsProviders ?? [], SECRET_MASK) } };
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
    subtitles: normaliseSubtitles(cur.subtitles ?? DEFAULT_SETTINGS.subtitles!, patch.subtitles),
    trakt: { ...cur.trakt, ...(patch.trakt ?? {}) },
    dlna: { ...cur.dlna, ...(patch.dlna ?? {}) },
    lastfm: { ...cur.lastfm, ...(patch.lastfm ?? {}) },
    requests: { ...cur.requests, ...(patch.requests ?? {}) },
    remoteAccess: { ...cur.remoteAccess, ...(patch.remoteAccess ?? {}) },
    backups: { ...cur.backups, ...(patch.backups ?? {}) },
    updates: {
      autoCheck: !!(patch.updates?.autoCheck ?? cur.updates.autoCheck),
      autoInstall: !!(patch.updates?.autoInstall ?? cur.updates.autoInstall),
      includePrereleases: !!(patch.updates?.includePrereleases ?? cur.updates.includePrereleases),
    },
    plugins: { repositories: (patch.plugins?.repositories ?? cur.plugins.repositories).map((u) => String(u).trim()).filter(Boolean).slice(0, 20) },
    oidc: { ...cur.oidc, ...(patch.oidc ?? {}) },
    signInScreen: signInScreenOf({ ...cur.signInScreen, ...(patch.signInScreen ?? {}) }),
    karaoke: { ...DEFAULT_SETTINGS.karaoke!, ...(cur.karaoke ?? {}), ...(patch.karaoke ?? {}) },
    skipSegments: normaliseSkipSegments(cur.skipSegments ?? DEFAULT_SETTINGS.skipSegments!, patch.skipSegments),
    simkl: { clientId: patch.simkl?.clientId !== undefined ? (String(patch.simkl.clientId ?? '').trim().slice(0, 200) || null) : cur.simkl?.clientId ?? null },
    mdblist: {
      apiKey: patch.mdblist?.apiKey !== undefined ? (String(patch.mdblist.apiKey ?? '').trim().slice(0, 200) || null) : cur.mdblist?.apiKey ?? null,
      ratings: typeof patch.mdblist?.ratings === 'boolean' ? patch.mdblist.ratings : !!cur.mdblist?.ratings,
    },
    ratingPosters: normaliseRatingPosters(cur.ratingPosters ?? DEFAULT_SETTINGS.ratingPosters!, patch.ratingPosters),
    webhooks: (patch.webhooks ?? cur.webhooks).map((w) => ({ ...w, id: w.id || newId() })),
    arr: patch.arr !== undefined ? normaliseArr(patch.arr, cur.arr) : cur.arr,
    notificationAgents: patch.notificationAgents !== undefined ? mergeAgents(patch.notificationAgents, cur.notificationAgents, newId) : cur.notificationAgents ?? [],
    ai: mergeAi(cur.ai ?? DEFAULT_AI, patch, cur.aiDj.llm, cur.aiDj.tts),
  };
  // The DJ's language model is the shared one (kept in step for older apps and backups).
  next.aiDj = { ...next.aiDj, llm: { ...next.ai!.llm } };
  // Keep the legacy field in step so older code paths and backups see the same automatic languages.
  if (patch.subtitles?.languages) next.openSubtitles = { ...next.openSubtitles, autoLanguages: next.subtitles!.languages };
  else if (patch.openSubtitles?.autoLanguages && !patch.subtitles) next.subtitles = { ...next.subtitles!, languages: next.openSubtitles.autoLanguages };
  normaliseNumbers(next);
  setKv('server', next);
  cache = next;
  return next;
}

/**
 * Crowdsourced skip segments: switches, a write-only IntroDB key and an http(s) parental-guide URL template that
 * must contain {imdb}. A bad template is refused rather than silently stored.
 */
export function normaliseSkipSegments(cur: SkipSegmentSettings, patch: Partial<SkipSegmentSettings> | undefined | null): SkipSegmentSettings {
  const p = patch && typeof patch === 'object' ? patch : {};
  const key = p.introDbApiKey === undefined ? cur.introDbApiKey : typeof p.introDbApiKey === 'string' && p.introDbApiKey.trim() ? p.introDbApiKey.trim().slice(0, 200) : null;
  let url = cur.parentalGuideUrl;
  if (p.parentalGuideUrl !== undefined) {
    const v = typeof p.parentalGuideUrl === 'string' ? p.parentalGuideUrl.trim() : '';
    if (!v) url = null;
    else if (/^https?:\/\/[^\s]+$/i.test(v) && v.includes('{imdb}') && v.length <= 500) url = v;
    else throw badRequest('The parental guide URL must start with http:// or https:// and contain {imdb}');
  }
  return {
    introDb: typeof p.introDb === 'boolean' ? p.introDb : !!cur.introDb,
    aniSkip: typeof p.aniSkip === 'boolean' ? p.aniSkip : !!cur.aniSkip,
    introDbApiKey: key,
    parentalGuideUrl: url,
  };
}

/** Rating posters: an http(s) template with {imdb} or {tmdb} (it usually holds the service's key, so it is write-only). */
export function normaliseRatingPosters(cur: RatingPosterSettings, patch: Partial<RatingPosterSettings> | undefined | null): RatingPosterSettings {
  const p = patch && typeof patch === 'object' ? patch : {};
  let url = cur.urlTemplate;
  if (p.urlTemplate !== undefined) {
    const v = typeof p.urlTemplate === 'string' ? p.urlTemplate.trim() : '';
    if (!v) url = null;
    else if (/^https?:\/\/\S+$/i.test(v) && (v.includes('{imdb}') || v.includes('{tmdb}')) && v.length <= 500) url = v;
    else throw badRequest('The poster URL must start with http:// or https:// and contain {imdb} or {tmdb}');
  }
  const flag = (k: 'home' | 'search' | 'detail') => (typeof p[k] === 'boolean' ? (p[k] as boolean) : !!cur[k]);
  return { urlTemplate: url, home: flag('home'), search: flag('search'), detail: flag('detail') };
}

/** Whole number in [min, max]; anything else (NaN, '', a cleared form field) keeps the current value or the default. */
function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return Math.max(min, Math.min(max, fallback));
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * Numeric settings from the admin UI (a cleared number field arrives as 0 or ''): a 0 s HLS segment or trickplay
 * interval would break playback, so keep every number in a sane range.
 */
function normaliseNumbers(s: ServerSettings) {
  const d = DEFAULT_SETTINGS;
  s.scanIntervalMinutes = clampInt(s.scanIntervalMinutes, 0, 7 * 24 * 60, d.scanIntervalMinutes);
  s.epgRefreshHours = clampInt(s.epgRefreshHours, 1, 24 * 7, d.epgRefreshHours);
  if (s.liveTvSourceMode !== 'separate') s.liveTvSourceMode = 'failover';
  s.sessionTimeoutDays = clampInt(s.sessionTimeoutDays, 0, 3650, d.sessionTimeoutDays ?? 90); // 0 = never expire
  const t = s.transcoding;
  t.maxConcurrent = clampInt(t.maxConcurrent, 1, 64, d.transcoding.maxConcurrent);
  t.defaultBitrate = clampInt(t.defaultBitrate, 300, 200000, d.transcoding.defaultBitrate);
  t.segmentSeconds = clampInt(t.segmentSeconds, 1, 10, d.transcoding.segmentSeconds);
  t.threads = clampInt(t.threads, 0, 128, d.transcoding.threads);
  if (!['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'].includes(t.preset)) t.preset = d.transcoding.preset;
  if (!['scan', 'created', 'modified'].includes(s.defaultDateAdded as string)) s.defaultDateAdded = d.defaultDateAdded;
  s.trickplay.intervalSeconds = clampInt(s.trickplay.intervalSeconds, 2, 60, d.trickplay.intervalSeconds);
  s.trickplay.width = clampInt(s.trickplay.width, 80, 640, d.trickplay.width);
  s.cinema.trailers = clampInt(s.cinema.trailers, 0, 5, d.cinema.trailers);
  s.dvr.paddingBeforeMin = clampInt(s.dvr.paddingBeforeMin, 0, 120, d.dvr.paddingBeforeMin);
  s.dvr.paddingAfterMin = clampInt(s.dvr.paddingAfterMin, 0, 240, d.dvr.paddingAfterMin);
  s.backups.intervalDays = clampInt(s.backups.intervalDays, 0, 365, d.backups.intervalDays);
  s.backups.keep = clampInt(s.backups.keep, 1, 100, d.backups.keep);
}

/**
 * Merge a (partial) subtitle settings patch onto `cur`: "••••" keeps the stored Subs.ro key, the provider list is
 * de-duplicated, numbers are clamped and languages lower-cased.
 */
export function normaliseSubtitles(cur: SubtitleSettings, patch: Partial<SubtitleSettings> | undefined | null): SubtitleSettings {
  const p = (patch ?? {}) as Partial<SubtitleSettings>;
  const subsRoPatch = (p.subsRo ?? {}) as Partial<SubtitleSettings['subsRo']>;
  const apiKey = subsRoPatch.apiKey === SECRET_MASK ? cur.subsRo.apiKey : subsRoPatch.apiKey !== undefined ? (typeof subsRoPatch.apiKey === 'string' && subsRoPatch.apiKey.trim() ? subsRoPatch.apiKey.trim().slice(0, 200) : null) : cur.subsRo.apiKey;
  const baseUrl = typeof subsRoPatch.baseUrl === 'string' && /^https?:\/\/\S+$/i.test(subsRoPatch.baseUrl.trim()) ? subsRoPatch.baseUrl.trim().replace(/\/+$/, '') : cur.subsRo.baseUrl || DEFAULT_SETTINGS.subtitles!.subsRo.baseUrl;
  const seen = new Set<string>();
  const providers = (Array.isArray(p.providers) ? p.providers : cur.providers ?? [])
    .filter((x) => x && typeof x.id === 'string' && /^[\w.:-]{1,200}$/.test(x.id) && !seen.has(x.id) && !!seen.add(x.id))
    .slice(0, 50)
    .map((x) => ({ id: x.id, enabled: x.enabled !== false }));
  for (const d of DEFAULT_SETTINGS.subtitles!.providers) if (!seen.has(d.id)) providers.push({ ...d });
  const languages = Array.isArray(p.languages) ? p.languages : cur.languages ?? [];
  return {
    providers,
    subsRo: { apiKey, baseUrl },
    languages: [...new Set(languages.map((l) => String(l).trim().toLowerCase()).filter((l) => /^[a-z]{2,3}(-[a-z]{2})?$/.test(l)))].slice(0, 20),
    sync: p.sync !== undefined ? !!p.sync : !!cur.sync,
    minScore: clampInt(p.minScore !== undefined ? p.minScore : cur.minScore, 0, 100, cur.minScore ?? 0),
    saveMode: (p.saveMode ?? cur.saveMode) === 'sidecar' ? 'sidecar' : 'data',
  };
}

const HW_ACCELS = ['none', 'vaapi', 'nvenc', 'qsv', 'videotoolbox', 'v4l2m2m', 'amf', 'rkmpp'];
const OUT_CODECS = ['h264', 'hevc', 'av1'];

function normaliseTranscoding(t: ServerSettings['transcoding']): ServerSettings['transcoding'] {
  const codecs = Array.isArray(t.preferredCodecs) ? t.preferredCodecs.filter((c) => OUT_CODECS.includes(c)) : DEFAULT_SETTINGS.transcoding.preferredCodecs;
  return {
    ...t,
    hwAccel: HW_ACCELS.includes(t.hwAccel) ? t.hwAccel : 'none',
    gpuIndex: Math.max(0, Math.min(15, Math.floor(Number(t.gpuIndex) || 0))),
    qsvApi: t.qsvApi === 'dxva2' ? 'dxva2' : 'd3d11',
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
