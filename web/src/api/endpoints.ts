import type {
  ActiveSession, ActivityEntry, AuthResponse, Branding, BrandingAssetKind, Channel, ChannelCategory,
  ChannelQuery, CreateCollectionRequest, CreateLibraryRequest, CreateLiveSourceRequest, CreatePlaylistRequest,
  CreateRecordingRequest, CreateRecordingRuleRequest, CreateUserRequest, DashboardStats, Device, DirectoryEntry, DownloadQuality, DvrDefaults,
  GuideResponse, HomeResponse, Item, LastfmAuthStart, LastfmStatus, Lyrics, PodcastSearchResult, PodcastSubscription, SubscribePodcastRequest, ItemQuery, ItemSort, Library, LivePlayRequest, LiveSource, LoginRequest,
  Paged, PinLoginRequest, DownloadRule, PlaybackInfo, PlaybackPrepareRequest, PlaybackPrepareResult, PlaybackRequest, Program, ProgressReport, PublicProfile, Recording,
  RecordingRule, RecordingStatus, RemoteSubtitle, ScheduledTask, SearchResponse, ServerSettings, ServerStats, SetupRequest, SystemInfo,
  TestSourceResponse, Theme, TraktDeviceCode, TraktStatus, TrickplayInfo, UpdateItemRequest, UpdateLibraryRequest, UpdateLiveSourceRequest, UpdateMeRequest,
  UpdateUserRequest, User, UserItemData, UserStats,
  ArrOptions, CreateMediaRequest, DjMix, DjMixRequest, DjStatus, TrackAnalysis, DjHostRequest, DjHostLine, DjFeedback, StarterLook, ApiKey, CreatedApiKey, TotpSetup, TotpEnabled, Invite, CreateInviteRequest, InvitePreview, AcceptInviteRequest,
  CalendarResponse, NotificationsResponse,
  BackupInfo, UpdateStatus, RemoteAccessStatus, Bookmark, PluginCatalogEntry, PluginInfo, CreateSmartListRequest, DiscoverResponse, MediaRequest, RequestStatus, SmartFilter,
} from '@mediamax/shared';
import type { DjOrderRequest, DjOrderResponse, DjTransitionsRequest, DjTransitionsResponse } from '@mediamax/shared';
import type { ManualRendererRequest, Renderer, RendererAction, RendererAdminView, RendererCommandRequest, RendererPlayRequest, RendererSettings, RendererState } from '@mediamax/shared';
import type { ApplyMatchRequest, MatchSearchResponse, MetadataProviderId, MetadataSettings, MetadataSettingsResponse, MetadataTestResult } from '@mediamax/shared';
import type {
  AcoustIdCandidate, DiscographyResponse, IdentifyResponse, LbRecommendations, ListenBrainzStatus, ListenBrainzUpdate, MusicSettings, MusicSettingsResponse, RelatedArtistsResponse,
} from '@mediamax/shared';
import type { DjBreakRequest, DjBreakResponse, DjRulesResponse, DjSession, DjSessionStartRequest, DjSuggestions } from '@mediamax/shared';
import type { DjRequestResult } from '../player/djTypes';
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
    looks: () => http.get<StarterLook[]>('/branding/looks'),
    applyLook: (id: string) => http.post<Branding>(`/branding/looks/${enc(id)}/apply`),
  },

  auth: {
    login: (username: string, password: string, totpCode?: string) =>
      request<AuthResponse>('POST', '/auth/login', { body: { ...deviceInfo(), username, password, totpCode } satisfies LoginRequest, silent401: true }),
    profiles: () => http.get<PublicProfile[]>('/auth/profiles'),
    profileLogin: (userId: string, pin?: string, totpCode?: string) =>
      request<AuthResponse>('POST', '/auth/profile-login', { body: { ...deviceInfo(), userId, pin, totpCode } satisfies PinLoginRequest, silent401: true }),
    approveLink: (code: string) => http.post<{ ok: true; deviceName: string }>('/auth/link/approve', { code }),
    logout: () => request<Ok>('POST', '/auth/logout', { body: {}, silent401: true }),
    me: () => request<User>('GET', '/auth/me', { silent401: true }),
    updateMe: (body: UpdateMeRequest) => http.patch<User>('/auth/me', body),
    uploadAvatar: (file: File) => upload<User>('/auth/me/avatar', file),
    deleteAvatar: () => http.del<User>('/auth/me/avatar'),
    devices: (all = false) => http.get<Device[]>('/auth/devices', all ? { all: true } : undefined),
    revokeDevice: (id: string) => http.del<Ok>(`/auth/devices/${enc(id)}`),
    totpSetup: () => http.post<TotpSetup>('/auth/me/2fa/setup'),
    totpEnable: (code: string) => http.post<TotpEnabled>('/auth/me/2fa/enable', { code }),
    totpDisable: (code: string) => http.post<User>('/auth/me/2fa/disable', { code }),
    apiKeys: () => http.get<ApiKey[]>('/auth/api-keys'),
    createApiKey: (name: string) => http.post<CreatedApiKey>('/auth/api-keys', { name }),
    deleteApiKey: (id: string) => http.del<Ok>(`/auth/api-keys/${enc(id)}`),
  },

  invites: {
    list: () => http.get<Invite[]>('/invites'),
    create: (body: CreateInviteRequest) => http.post<Invite>('/invites', body),
    remove: (code: string) => http.del<Ok>(`/invites/${enc(code)}`),
    preview: (code: string) => request<InvitePreview>('GET', `/invites/${enc(code)}/preview`, { silent401: true }),
    accept: (code: string, body: Pick<AcceptInviteRequest, 'username' | 'password' | 'displayName'>) =>
      request<AuthResponse>('POST', `/invites/${enc(code)}/accept`, { body: { ...deviceInfo(), ...body } satisfies AcceptInviteRequest, silent401: true }),
  },

  users: {
    list: () => http.get<User[]>('/users'),
    create: (body: CreateUserRequest) => http.post<User>('/users', body),
    update: (id: string, body: UpdateUserRequest) => http.patch<User>(`/users/${enc(id)}`, body),
    remove: (id: string) => http.del<Ok>(`/users/${enc(id)}`),
    uploadAvatar: (id: string, file: File) => upload<User>(`/users/${enc(id)}/avatar`, file),
    deleteAvatar: (id: string) => http.del<User>(`/users/${enc(id)}/avatar`),
    resetTotp: (id: string) => http.del<User>(`/users/${enc(id)}/2fa`),
  },

  libraries: {
    list: () => http.get<Library[]>('/libraries'),
    create: (body: CreateLibraryRequest) => http.post<Library>('/libraries', body),
    update: (id: string, body: UpdateLibraryRequest) => http.patch<Library>(`/libraries/${enc(id)}`, body),
    remove: (id: string) => http.del<Ok>(`/libraries/${enc(id)}`),
    scan: (id: string, refreshMetadata = false) => http.post<Ok>(`/libraries/${enc(id)}/scan`, { refreshMetadata }),
    scanAll: () => http.post<Ok>('/libraries/scan'),
    recalculateDateAdded: (id: string) => http.post<Ok & { changed: number }>(`/libraries/${enc(id)}/recalculate-date-added`),
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
    intros: (id: string) => http.get<Item[]>(`/items/${enc(id)}/intros`),
    extras: (id: string) => http.get<Item[]>(`/items/${enc(id)}/extras`),
    bookmarks: (id: string, signal?: AbortSignal) => http.get<Bookmark[]>(`/items/${enc(id)}/bookmarks`, undefined, signal),
    addBookmark: (id: string, body: { positionMs: number; note?: string }) => http.post<Bookmark>(`/items/${enc(id)}/bookmarks`, body),
    removeBookmark: (id: string, bookmarkId: string) => http.del<Ok>(`/items/${enc(id)}/bookmarks/${enc(bookmarkId)}`),
    setWatchlist: (id: string, on: boolean) =>
      on ? http.post<UserItemData>(`/items/${enc(id)}/watchlist`) : http.del<UserItemData>(`/items/${enc(id)}/watchlist`),
    setNotInterested: (id: string, on: boolean) =>
      on ? http.post<UserItemData>(`/items/${enc(id)}/not-interested`) : http.del<UserItemData>(`/items/${enc(id)}/not-interested`),
  },

  discovery: {
    watchlist: (q: { limit?: number; offset?: number } = {}) => http.get<Paged<Item>>('/watchlist', q),
    calendar: (q: { from?: string; to?: string } = {}, signal?: AbortSignal) => http.get<CalendarResponse>('/calendar', q, signal),
    notifications: (limit = 30) => http.get<NotificationsResponse>('/notifications', { limit }),
    markRead: (ids?: string[]) => http.post<{ unread: number }>('/notifications/read', ids ? { ids } : {}),
  },

  subtitles: {
    search: (itemId: string, languages: string, signal?: AbortSignal) =>
      http.get<RemoteSubtitle[]>(`/items/${enc(itemId)}/subtitles/search`, { languages }, signal),
    download: (itemId: string, body: { fileId: string; language: string; provider?: string; hearingImpaired?: boolean; forced?: boolean; release?: string | null; score?: number | null }) =>
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

  dj: {
    mix: (body: DjMixRequest) => http.post<DjMix>('/dj/mix', body),
    status: () => http.get<DjStatus>('/dj/status'),
    analyze: () => http.post<Ok>('/dj/analyze'),
    analysis: (itemId: string) => http.get<TrackAnalysis | null>(`/items/${enc(itemId)}/analysis`),
    /** Lite automix: plan many transitions at once from stored analyses (local only, no AI). */
    transitions: (body: DjTransitionsRequest) => http.post<DjTransitionsResponse>('/dj/transitions', body),
    /** Put a source or a list of tracks in a mix-friendly order (local only, no AI); page with `history`. */
    order: (body: DjOrderRequest) => http.post<DjOrderResponse>('/dj/order', body),
    host: (body: DjHostRequest) => http.post<DjHostLine>('/dj/host', body),
    feedback: (body: DjFeedback) => http.post<Ok>('/dj/feedback', body),
    /* Your DJ: a personal set in themed segments (server picks; local only unless an admin configured AI). */
    session: (body: DjSessionStartRequest = {}) => http.post<DjSession>('/dj/session', { hour: new Date().getHours(), ...body }),
    sessionMore: (id: string, history: string[]) => http.post<DjSession>(`/dj/session/${enc(id)}/more`, { history, hour: new Date().getHours() }),
    sessionSwitch: (id: string, history: string[]) => http.post<DjSession>(`/dj/session/${enc(id)}/switch`, { history, hour: new Date().getHours() }),
    sessionRequest: (id: string, text: string, history: string[]) => http.post<DjRequestResult>(`/dj/session/${enc(id)}/request`, { text, history, hour: new Date().getHours() }),
    suggestions: () => http.get<DjSuggestions>('/dj/session/suggestions', { hour: new Date().getHours() }),
    /* Radio Host: ask for a talk break before a transition (null = stay quiet). */
    hostBreak: (body: DjBreakRequest, signal?: AbortSignal) => request<DjBreakResponse>('POST', '/dj/break', { body, signal }),
    /* DJ rules: the effective, admin-enforced and saved presets. */
    rules: () => http.get<DjRulesResponse>('/dj/rules'),
    aiTest: (kind: 'llm' | 'tts') => http.post<{ ok: true; reply?: string; ms?: number; audioUrl?: string; usage?: { used: number; max: number } }>('/dj/ai/test', { kind }),
  },

  playlists: {
    list: () => http.get<Item[]>('/playlists'),
    create: (body: CreatePlaylistRequest) => http.post<Item>('/playlists', body),
    addItems: (id: string, itemIds: string[]) => http.post<Ok>(`/playlists/${enc(id)}/items`, { itemIds }),
    removeItem: (id: string, itemId: string) => http.del<Ok>(`/playlists/${enc(id)}/items/${enc(itemId)}`),
    remove: (id: string) => http.del<Ok>(`/playlists/${enc(id)}`),
  },

  discover: {
    search: (q: { q?: string; type?: 'movie' | 'show' | 'all'; page?: number; hideAvailable?: boolean }, signal?: AbortSignal) =>
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

  downloads: {
    /** Smart download rules of all the user's devices. */
    rules: () => http.get<DownloadRule[]>('/downloads/rules'),
    removeRule: (id: string) => http.del<Ok>(`/downloads/rules/${enc(id)}`),
  },

  playback: {
    start: (itemId: string, body: PlaybackRequest) => http.post<PlaybackInfo>(`/playback/${enc(itemId)}`, body),
    /** Instant play: decide now and warm up the stream (no session is created). */
    prepare: (itemId: string, body: PlaybackPrepareRequest) => request<PlaybackPrepareResult>('POST', `/playback/${enc(itemId)}/prepare`, { body, silent401: true }),
    progress: (sessionId: string, body: ProgressReport, keepalive = false) =>
      request<Ok>('POST', `/playback/sessions/${enc(sessionId)}/progress`, { body, keepalive, silent401: true }),
    stop: (sessionId: string, keepalive = false) =>
      request<Ok>('DELETE', `/playback/sessions/${enc(sessionId)}`, { keepalive, silent401: true }),
    sessions: () => http.get<ActiveSession[]>('/sessions'),
    kill: (id: string, reason?: string) => http.del<Ok>(`/sessions/${enc(id)}`, { reason }),
    command: (id: string, body: { action: 'pause' | 'play' | 'togglePause' | 'message'; text?: string; header?: string }) =>
      http.post<Ok & { delivered: number }>(`/sessions/${enc(id)}/command`, body),
    downloadUrl: (itemId: string, quality: DownloadQuality = 'original') =>
      `/api/v1/stream/download/${enc(itemId)}${quality === 'original' ? '' : `?quality=${quality}`}`,
  },

  livetv: {
    sources: () => http.get<LiveSource[]>('/livetv/sources'),
    createSource: (body: CreateLiveSourceRequest) => http.post<LiveSource>('/livetv/sources', body),
    updateSource: (id: string, body: UpdateLiveSourceRequest) => http.patch<LiveSource>(`/livetv/sources/${enc(id)}`, body),
    removeSource: (id: string) => http.del<Ok>(`/livetv/sources/${enc(id)}`),
    testSource: (body: CreateLiveSourceRequest) => http.post<TestSourceResponse>('/livetv/sources/test', body),
    /** SAT>IP (SSDP) and HDHomeRun (UDP) devices on the server's LAN. */
    discoverTuners: () => http.get<import('@mediamax/shared').DiscoveredTuner[]>('/livetv/tuners/discover'),
    /** TVHeadend sources: finished recordings on the backend. */
    tunerRecordings: (sourceId: string) => http.get<import('@mediamax/shared').TunerRecording[]>(`/livetv/sources/${enc(sourceId)}/recordings`),
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
    updateRecording: (id: string, body: { priority?: number }) => http.patch<Recording>(`/dvr/recordings/${enc(id)}`, body),
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
    saveSettingsPatch: (patch: Partial<ServerSettings>) => http.put<ServerSettings>('/settings', patch),
    restart: () => http.post<Ok>('/admin/restart'),
    updates: () => http.get<UpdateStatus>('/admin/updates'),
    checkUpdates: () => http.post<UpdateStatus>('/admin/updates/check'),
    installUpdate: () => http.post<UpdateStatus>('/admin/updates/install'),
    backups: () => http.get<BackupInfo[]>('/admin/backups'),
    createBackup: () => http.post<BackupInfo>('/admin/backups'),
    removeBackup: (id: string) => http.del<Ok>(`/admin/backups/${enc(id)}`),
    restoreBackup: (id: string) => http.post<{ restartRequired: boolean }>(`/admin/backups/${enc(id)}/restore`),
    restoreUpload: (file: File) => upload<{ restartRequired: boolean }>('/admin/backups/restore-upload', file),
    backupDownloadUrl: (id: string) => `/api/v1/admin/backups/${enc(id)}/download`,
    remoteAccess: () => http.get<RemoteAccessStatus>('/admin/remote-access'),
    refreshRemoteAccess: () => http.post<RemoteAccessStatus>('/admin/remote-access/refresh'),
  },

  /** Built-in metadata providers (Server settings → Metadata) and Fix match. */
  metadata: {
    get: () => http.get<MetadataSettingsResponse>('/admin/metadata'),
    save: (s: Partial<MetadataSettings>) => http.put<MetadataSettingsResponse>('/admin/metadata', s),
    test: (id: MetadataProviderId, body: { apiKey?: string | null; pin?: string | null } = {}) => http.post<MetadataTestResult>(`/admin/metadata/${enc(id)}/test`, body),
    clearCache: (provider?: MetadataProviderId) => http.del<Ok>('/admin/metadata/cache', { provider }),
    searchMatch: (itemId: string, q: { provider?: MetadataProviderId; q?: string; year?: number | '' }) => http.get<MatchSearchResponse>(`/items/${enc(itemId)}/match`, q),
    applyMatch: (itemId: string, body: ApplyMatchRequest) => http.post<Item>(`/items/${enc(itemId)}/match`, body),
  },

  /** MusicBrainz discography / related artists, AcoustID "Identify by sound", ListenBrainz. */
  music: {
    discography: (artistId: string) => http.get<DiscographyResponse>(`/music/artists/${enc(artistId)}/discography`),
    related: (artistId: string) => http.get<RelatedArtistsResponse>(`/music/artists/${enc(artistId)}/related`),
    identifyStored: (itemId: string) => http.get<IdentifyResponse>(`/items/${enc(itemId)}/identify`),
    identify: (itemId: string) => http.post<IdentifyResponse>(`/items/${enc(itemId)}/identify`),
    applyIdentify: (itemId: string, candidate: AcoustIdCandidate) => http.post<Item>(`/items/${enc(itemId)}/identify/apply`, { candidate }),
    settings: () => http.get<MusicSettingsResponse>('/admin/music'),
    saveSettings: (s: Partial<MusicSettings>) => http.put<MusicSettingsResponse>('/admin/music', s),
    identifyUntagged: () => http.post<Ok>('/admin/music/identify-untagged'),
  },
  listenbrainz: {
    status: () => http.get<ListenBrainzStatus>('/listenbrainz'),
    save: (body: ListenBrainzUpdate) => http.put<ListenBrainzStatus>('/listenbrainz', body),
    disconnect: () => http.del<ListenBrainzStatus>('/listenbrainz'),
    flush: () => http.post<ListenBrainzStatus>('/listenbrainz/flush'),
    recommendations: (refresh = false) => http.get<LbRecommendations>('/listenbrainz/recommendations', refresh ? { refresh: '1' } : undefined),
    saveAsPlaylist: (listId: string) => http.post<{ id: string; count: number }>(`/listenbrainz/recommendations/${enc(listId)}/playlist`),
  },

  /** "Play to" network renderers (DLNA/UPnP TVs, Sonos, Kodi). */
  renderers: {
    list: () => http.get<Renderer[]>('/renderers'),
    discover: () => http.post<Renderer[]>('/renderers/discover'),
    state: (id: string) => http.get<RendererState>(`/renderers/${enc(id)}/state`),
    play: (id: string, body: RendererPlayRequest) => http.post<RendererState>(`/renderers/${enc(id)}/play`, body),
    command: (id: string, action: RendererAction, body: RendererCommandRequest = {}) => http.post<RendererState>(`/renderers/${enc(id)}/${action}`, body),
    admin: () => http.get<RendererAdminView>('/admin/renderers'),
    saveSettings: (s: Partial<RendererSettings>) => http.put<RendererAdminView>('/admin/renderers/settings', s),
    addManual: (body: ManualRendererRequest) => http.post<RendererAdminView>('/admin/renderers/manual', body),
    removeManual: (id: string) => http.del<RendererAdminView>(`/admin/renderers/manual/${enc(id)}`),
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
