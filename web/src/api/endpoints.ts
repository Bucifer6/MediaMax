import type {
  ActiveSession, ActivityEntry, AuthResponse, Branding, BrandingAssetKind, Channel, ChannelCategory,
  ChannelQuery, CreateCollectionRequest, CreateLibraryRequest, CreateLiveSourceRequest, CreatePlaylistRequest,
  CreateRecordingRequest, CreateRecordingRuleRequest, CreateUserRequest, DashboardStats, Device, DirectoryEntry, DownloadQuality, DvrDefaults,
  GuideResponse, HomeResponse, Item, LastfmAuthStart, LastfmStatus, Lyrics, PodcastSearchResult, PodcastSubscription, SubscribePodcastRequest, ItemQuery, ItemSort, Library, LivePlayRequest, LiveSource, LoginRequest,
  Paged, PinLoginRequest, PlaybackInfo, PlaybackRequest, Program, ProgressReport, PublicProfile, Recording,
  RecordingRule, RecordingStatus, RemoteSubtitle, ScheduledTask, SearchResponse, ServerSettings, ServerStats, SetupRequest, SystemInfo,
  TestSourceResponse, Theme, TraktDeviceCode, TraktStatus, TrickplayInfo, UpdateItemRequest, UpdateLibraryRequest, UpdateLiveSourceRequest, UpdateMeRequest,
  UpdateUserRequest, User, UserItemData, UserStats,
  ArrOptions, CreateMediaRequest, PluginCatalogEntry, PluginInfo, CreateSmartListRequest, DiscoverResponse, MediaRequest, RequestStatus, SmartFilter,
} from '@mediamax/shared';
import { http, request, upload } from './client';
import { deviceInfo } from './device';

type Ok = { ok: true };
const enc = encodeURIComponent;

export const api = {
  system: {
    info: () => http.get<SystemInfo>('/system/info'),
    setup: (body: SetupRequest) => http.post<AuthResponse>('/setup', body),
    stats: () => http.get<DashboardStats>('/system/stats'),
    browse: (path?: string) => http.get<DirectoryEntry[]>('/system/browse', { path }),
    logs: (lines = 500) => http.get<{ lines: string[] }>('/system/logs', { lines }),
  },

  branding: {
    get: () => http.get<Branding>('/branding'),
    update: (patch: Partial<Omit<Branding, 'revision'>>) => http.put<Branding>('/branding', patch),
    uploadAsset: (kind: BrandingAssetKind, file: File) => upload<Branding>(`/branding/assets/${kind}`, file),
    deleteAsset: (kind: BrandingAssetKind) => http.del<Branding>(`/branding/assets/${kind}`),
    createTheme: (theme: Omit<Theme, 'id'> & { id?: string }) => http.post<Branding>('/branding/themes', theme),
    updateTheme: (theme: Theme) => http.put<Branding>(`/branding/themes/${enc(theme.id)}`, theme),
    deleteTheme: (id: string) => http.del<Branding>(`/branding/themes/${enc(id)}`),
  },

  auth: {
    login: (username: string, password: string) =>
      request<AuthResponse>('POST', '/auth/login', { body: { ...deviceInfo(), username, password } satisfies LoginRequest, silent401: true }),
    profiles: () => http.get<PublicProfile[]>('/auth/profiles'),
    profileLogin: (userId: string, pin?: string) =>
      request<AuthResponse>('POST', '/auth/profile-login', { body: { ...deviceInfo(), userId, pin } satisfies PinLoginRequest, silent401: true }),
    approveLink: (code: string) => http.post<{ ok: true; deviceName: string }>('/auth/link/approve', { code }),
    logout: () => request<Ok>('POST', '/auth/logout', { body: {}, silent401: true }),
    me: () => request<User>('GET', '/auth/me', { silent401: true }),
    updateMe: (body: UpdateMeRequest) => http.patch<User>('/auth/me', body),
    uploadAvatar: (file: File) => upload<User>('/auth/me/avatar', file),
    deleteAvatar: () => http.del<User>('/auth/me/avatar'),
    devices: (all = false) => http.get<Device[]>('/auth/devices', all ? { all: true } : undefined),
    revokeDevice: (id: string) => http.del<Ok>(`/auth/devices/${enc(id)}`),
  },

  users: {
    list: () => http.get<User[]>('/users'),
    create: (body: CreateUserRequest) => http.post<User>('/users', body),
    update: (id: string, body: UpdateUserRequest) => http.patch<User>(`/users/${enc(id)}`, body),
    remove: (id: string) => http.del<Ok>(`/users/${enc(id)}`),
    uploadAvatar: (id: string, file: File) => upload<User>(`/users/${enc(id)}/avatar`, file),
    deleteAvatar: (id: string) => http.del<User>(`/users/${enc(id)}/avatar`),
  },

  libraries: {
    list: () => http.get<Library[]>('/libraries'),
    create: (body: CreateLibraryRequest) => http.post<Library>('/libraries', body),
    update: (id: string, body: UpdateLibraryRequest) => http.patch<Library>(`/libraries/${enc(id)}`, body),
    remove: (id: string) => http.del<Ok>(`/libraries/${enc(id)}`),
    scan: (id: string, refreshMetadata = false) => http.post<Ok>(`/libraries/${enc(id)}/scan`, { refreshMetadata }),
    scanAll: () => http.post<Ok>('/libraries/scan'),
  },

  items: {
    query: (q: ItemQuery, signal?: AbortSignal) => http.get<Paged<Item>>('/items', q, signal),
    get: (id: string) => http.get<Item>(`/items/${enc(id)}`),
    children: (id: string, q: { sort?: ItemSort; order?: 'asc' | 'desc'; limit?: number; offset?: number } = {}) =>
      http.get<Paged<Item>>(`/items/${enc(id)}/children`, q),
    similar: (id: string, limit = 12) => http.get<Item[]>(`/items/${enc(id)}/similar`, { limit }),
    next: (id: string) => http.get<Item | null>(`/items/${enc(id)}/next`),
    setPlayed: (id: string, played: boolean) =>
      played ? http.post<UserItemData>(`/items/${enc(id)}/played`) : http.del<UserItemData>(`/items/${enc(id)}/played`),
    setFavorite: (id: string, fav: boolean) =>
      fav ? http.post<UserItemData>(`/items/${enc(id)}/favorite`) : http.del<UserItemData>(`/items/${enc(id)}/favorite`),
    rate: (id: string, rating: number | null) => http.post<UserItemData>(`/items/${enc(id)}/rating`, { rating }),
    progress: (id: string, body: ProgressReport) => http.post<UserItemData>(`/items/${enc(id)}/progress`, body),
    update: (id: string, body: UpdateItemRequest) => http.patch<Item>(`/items/${enc(id)}`, body),
    refresh: (id: string) => http.post<Item>(`/items/${enc(id)}/refresh`),
    uploadImage: (id: string, kind: 'poster' | 'backdrop' | 'logo' | 'thumb', file: File) =>
      upload<Item>(`/items/${enc(id)}/images/${kind}`, file),
    remove: (id: string) => http.del<Ok>(`/items/${enc(id)}`),
    genres: (libraryId?: string) => http.get<string[]>('/genres', { libraryId }),
    home: () => http.get<HomeResponse>('/home'),
    search: (q: string, limit = 24, signal?: AbortSignal) => http.get<SearchResponse>('/search', { q, limit }, signal),
    lyrics: (id: string, signal?: AbortSignal) => http.get<Lyrics>(`/items/${enc(id)}/lyrics`, undefined, signal),
    trickplay: (id: string, mediaId?: string, signal?: AbortSignal) => http.get<TrickplayInfo>(`/items/${enc(id)}/trickplay`, { mediaId }, signal),
  },

  subtitles: {
    search: (itemId: string, languages: string, signal?: AbortSignal) =>
      http.get<RemoteSubtitle[]>(`/items/${enc(itemId)}/subtitles/search`, { languages }, signal),
    download: (itemId: string, body: { fileId: string; language: string; hearingImpaired?: boolean; forced?: boolean }) =>
      http.post<Item>(`/items/${enc(itemId)}/subtitles/download`, body),
    remove: (itemId: string, index: number) => http.del<Item>(`/items/${enc(itemId)}/subtitles/${index}`),
  },

  podcasts: {
    list: () => http.get<PodcastSubscription[]>('/podcasts'),
    search: (q: string, signal?: AbortSignal) => http.get<PodcastSearchResult[]>('/podcasts/search', { q }, signal),
    subscribe: (body: SubscribePodcastRequest) => http.post<PodcastSubscription>('/podcasts', body),
    update: (id: string, body: { autoDownload: boolean }) => http.patch<PodcastSubscription>(`/podcasts/${enc(id)}`, body),
    refresh: (id: string) => http.post<PodcastSubscription>(`/podcasts/${enc(id)}/refresh`),
    remove: (id: string) => http.del<Ok>(`/podcasts/${enc(id)}`),
    importOpml: (opml: string) => http.post<{ added: number; skipped: number; failed: number | string[] }>('/podcasts/import', { opml }),
  },

  stats: {
    me: (year?: number | null, signal?: AbortSignal) => http.get<UserStats>('/stats/me', { year: year ?? undefined }, signal),
    user: (userId: string, year?: number | null, signal?: AbortSignal) =>
      http.get<UserStats>(`/stats/users/${enc(userId)}`, { year: year ?? undefined }, signal),
    server: (days: number, signal?: AbortSignal) => http.get<ServerStats>('/stats/server', { days }, signal),
  },

  lastfm: {
    status: () => http.get<LastfmStatus>('/lastfm'),
    connect: () => http.post<LastfmAuthStart>('/lastfm/connect'),
    update: (body: { scrobble: boolean }) => http.patch<LastfmStatus>('/lastfm', body),
    disconnect: () => http.del<LastfmStatus>('/lastfm'),
  },

  trakt: {
    status: () => http.get<TraktStatus>('/trakt'),
    connect: () => http.post<TraktDeviceCode>('/trakt/connect'),
    update: (body: { scrobble: boolean }) => http.patch<TraktStatus>('/trakt', body),
    disconnect: () => http.del<TraktStatus>('/trakt'),
  },

  collections: {
    list: () => http.get<Item[]>('/collections'),
    create: (body: CreateCollectionRequest) => http.post<Item>('/collections', body),
    addItems: (id: string, itemIds: string[]) => http.post<Ok>(`/collections/${enc(id)}/items`, { itemIds }),
    removeItem: (id: string, itemId: string) => http.del<Ok>(`/collections/${enc(id)}/items/${enc(itemId)}`),
    remove: (id: string) => http.del<Ok>(`/collections/${enc(id)}`),
  },

  playlists: {
    list: () => http.get<Item[]>('/playlists'),
    create: (body: CreatePlaylistRequest) => http.post<Item>('/playlists', body),
    addItems: (id: string, itemIds: string[]) => http.post<Ok>(`/playlists/${enc(id)}/items`, { itemIds }),
    removeItem: (id: string, itemId: string) => http.del<Ok>(`/playlists/${enc(id)}/items/${enc(itemId)}`),
    remove: (id: string) => http.del<Ok>(`/playlists/${enc(id)}`),
  },

  discover: {
    search: (q: { q?: string; type?: 'movie' | 'show' | 'all'; page?: number }, signal?: AbortSignal) =>
      http.get<DiscoverResponse>('/discover', q, signal),
  },

  requests: {
    list: (q: { status?: RequestStatus; mine?: boolean } = {}) => http.get<MediaRequest[]>('/requests', q),
    create: (body: CreateMediaRequest) => http.post<MediaRequest>('/requests', body),
    approve: (id: string) => http.post<MediaRequest>(`/requests/${enc(id)}/approve`),
    decline: (id: string, note?: string) => http.post<MediaRequest>(`/requests/${enc(id)}/decline`, { note }),
    remove: (id: string) => http.del<Ok>(`/requests/${enc(id)}`),
    testArr: (url: string, apiKey: string) => http.post<ArrOptions>('/requests/arr/test', { url, apiKey }),
  },

  smart: {
    preview: (filter: SmartFilter, limit = 24) => http.post<Paged<Item>>('/smart/preview', { filter, limit }),
    create: (body: CreateSmartListRequest) => http.post<Item>('/smart', body),
    update: (id: string, body: { title?: string; overview?: string; filter?: SmartFilter }) => http.put<Item>(`/smart/${enc(id)}`, body),
  },

  playback: {
    start: (itemId: string, body: PlaybackRequest) => http.post<PlaybackInfo>(`/playback/${enc(itemId)}`, body),
    progress: (sessionId: string, body: ProgressReport, keepalive = false) =>
      request<Ok>('POST', `/playback/sessions/${enc(sessionId)}/progress`, { body, keepalive, silent401: true }),
    stop: (sessionId: string, keepalive = false) =>
      request<Ok>('DELETE', `/playback/sessions/${enc(sessionId)}`, { keepalive, silent401: true }),
    sessions: () => http.get<ActiveSession[]>('/sessions'),
    kill: (id: string, reason?: string) => http.del<Ok>(`/sessions/${enc(id)}`, { reason }),
    downloadUrl: (itemId: string, quality: DownloadQuality = 'original') =>
      `/api/v1/stream/download/${enc(itemId)}${quality === 'original' ? '' : `?quality=${quality}`}`,
  },

  livetv: {
    sources: () => http.get<LiveSource[]>('/livetv/sources'),
    createSource: (body: CreateLiveSourceRequest) => http.post<LiveSource>('/livetv/sources', body),
    updateSource: (id: string, body: UpdateLiveSourceRequest) => http.patch<LiveSource>(`/livetv/sources/${enc(id)}`, body),
    removeSource: (id: string) => http.del<Ok>(`/livetv/sources/${enc(id)}`),
    testSource: (body: CreateLiveSourceRequest) => http.post<TestSourceResponse>('/livetv/sources/test', body),
    refreshSource: (id: string) => http.post<Ok>(`/livetv/sources/${enc(id)}/refresh`),
    categories: (sourceId?: string) => http.get<ChannelCategory[]>('/livetv/categories', { sourceId }),
    updateCategory: (id: string, body: { hidden?: boolean; sortOrder?: number; name?: string }) =>
      http.patch<ChannelCategory>(`/livetv/categories/${enc(id)}`, body),
    channels: (q: ChannelQuery = {}, signal?: AbortSignal) => http.get<Paged<Channel>>('/livetv/channels', q, signal),
    channel: (id: string) => http.get<Channel>(`/livetv/channels/${enc(id)}`),
    updateChannel: (id: string, body: { number?: number | null; name?: string; hidden?: boolean; epgChannelId?: string | null; logoUrl?: string | null }) =>
      http.patch<Channel>(`/livetv/channels/${enc(id)}`, body),
    setFavorite: (id: string, fav: boolean) =>
      fav ? http.post<{ favorite: boolean }>(`/livetv/channels/${enc(id)}/favorite`) : http.del<{ favorite: boolean }>(`/livetv/channels/${enc(id)}/favorite`),
    programs: (id: string, start?: string, end?: string) => http.get<Program[]>(`/livetv/channels/${enc(id)}/programs`, { start, end }),
    guide: (q: { start?: string; end?: string; categoryId?: string; favorite?: boolean; offset?: number; limit?: number }, signal?: AbortSignal) =>
      http.get<GuideResponse>('/livetv/guide', q, signal),
    play: (id: string, body: LivePlayRequest = {}) => http.post<PlaybackInfo>(`/livetv/channels/${enc(id)}/play`, body),
  },

  dvr: {
    defaults: () => http.get<DvrDefaults>('/dvr/defaults'),
    recordings: (status?: RecordingStatus) => http.get<Recording[]>('/dvr/recordings', { status }),
    record: (body: CreateRecordingRequest) => http.post<Recording>('/dvr/recordings', body),
    removeRecording: (id: string) => http.del<Ok>(`/dvr/recordings/${enc(id)}`),
    rules: () => http.get<RecordingRule[]>('/dvr/rules'),
    createRule: (body: CreateRecordingRuleRequest) => http.post<RecordingRule>('/dvr/rules', body),
    updateRule: (id: string, body: Partial<RecordingRule>) => http.patch<RecordingRule>(`/dvr/rules/${enc(id)}`, body),
    removeRule: (id: string) => http.del<Ok>(`/dvr/rules/${enc(id)}`),
  },

  admin: {
    settings: () => http.get<ServerSettings>('/settings'),
    saveSettings: (s: ServerSettings) => http.put<ServerSettings>('/settings', s),
    testWebhook: (url: string) => http.post<{ ok: boolean; status?: number | null; error?: string; message?: string }>('/settings/webhooks/test', { url }),
    tasks: () => http.get<ScheduledTask[]>('/tasks'),
    runTask: (id: string) => http.post<Ok>(`/tasks/${enc(id)}/run`),
    activity: (limit = 50, offset = 0) => http.get<Paged<ActivityEntry>>('/activity', { limit, offset }),
    saveRepositories: (repositories: string[]) => http.put<ServerSettings>('/settings', { plugins: { repositories } }),
  },

  plugins: {
    list: () => http.get<PluginInfo[]>('/admin/plugins'),
    catalog: (refresh = false) => http.get<PluginCatalogEntry[]>('/admin/plugins/catalog', { refresh: refresh || undefined }),
    install: (id: string, version?: string) => http.post<PluginInfo>('/admin/plugins/install', { id, version }),
    upload: (file: File) => upload<PluginInfo>('/admin/plugins/upload', file),
    setEnabled: (id: string, enabled: boolean) => http.post<PluginInfo>(`/admin/plugins/${enc(id)}/${enabled ? 'enable' : 'disable'}`),
    saveSettings: (id: string, values: Record<string, string | number | boolean | null>) => http.put<PluginInfo>(`/admin/plugins/${enc(id)}/settings`, values),
    uninstall: (id: string) => http.del<Ok>(`/admin/plugins/${enc(id)}`),
  },
};
