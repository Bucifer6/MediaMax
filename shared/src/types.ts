/**
 * MediaMax API contract.
 *
 * This file is the single source of truth for the shapes exchanged between the
 * server and every client (web, iOS, Android, TV). It has no runtime imports so
 * it can be copied verbatim into the mobile app (`npm run sync-types`).
 *
 * Conventions
 *  - Base path: `/api/v1`
 *  - Auth: `Authorization: Bearer <token>` header, or `?token=<token>` query
 *    parameter (needed for <video>/<img> tags and HLS segment requests).
 *  - Times are ISO-8601 strings, durations/positions are milliseconds.
 *  - IDs are opaque strings.
 *  - Image URLs returned by the server are server-relative paths
 *    (e.g. `/api/v1/images/abc`) and are publicly fetchable.
 *  - Errors: non-2xx with body `ApiError`.
 */

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}

export interface Paged<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

/* ------------------------------------------------------------------ */
/* System                                                              */
/* ------------------------------------------------------------------ */

export interface SystemInfo {
  id: string;
  name: string;
  version: string;
  setupRequired: boolean;
  /** Public URL configured by the admin, if any. */
  publicUrl: string | null;
  features: FeatureFlags;
}

export interface SetupRequest {
  serverName: string;
  username: string;
  password: string;
}

/* ------------------------------------------------------------------ */
/* Branding / theming (all drawn from the server by every client)      */
/* ------------------------------------------------------------------ */

export interface ThemeColors {
  primary: string;
  primaryText: string;
  background: string;
  surface: string;
  surfaceAlt: string;
  text: string;
  textMuted: string;
  accent: string;
  border: string;
  success: string;
  warning: string;
  danger: string;
  /** Overlay gradient start colour used over hero backdrops. */
  overlay: string;
}

export type PosterShape = 'rounded' | 'square' | 'pill';
export type CardSize = 'small' | 'medium' | 'large';
export type HeroStyle = 'carousel' | 'static' | 'none';

export interface Theme {
  id: string;
  name: string;
  mode: 'dark' | 'light';
  colors: ThemeColors;
  /** Corner radius in px for cards/buttons. */
  radius: number;
  /** CSS font-family (web) / font name (native, falls back to system). */
  fontFamily: string;
  /** Optional Google-Fonts-style URL the web client loads. */
  fontUrl?: string | null;
  posterShape: PosterShape;
  cardSize: CardSize;
  heroStyle: HeroStyle;
  /** Built-in presets cannot be deleted. */
  builtIn?: boolean;
}

export type HomeRowType =
  | 'hero'
  | 'continue'
  | 'nextup'
  | 'recent'
  | 'library-recent'
  | 'favorites'
  | 'collection'
  | 'genre'
  | 'live-now'
  | 'favorite-channels'
  | 'recordings'
  | 'playlist';

export interface HomeRowConfig {
  id: string;
  type: HomeRowType;
  /** Display title; clients fall back to a sensible default if empty. */
  title?: string;
  enabled: boolean;
  /** For library-recent. */
  libraryId?: string;
  /** For collection / playlist. */
  itemId?: string;
  /** For genre. */
  genre?: string;
  limit?: number;
}

export interface FeatureFlags {
  liveTv: boolean;
  iptvVod: boolean;
  music: boolean;
  photos: boolean;
  downloads: boolean;
  syncPlay: boolean;
  dvr: boolean;
  /** Show profile picker (Plex-Home style) on login screen. */
  profilePicker: boolean;
  /** TV/phone pairing via short link code. */
  linkCodes: boolean;
}

export interface Branding {
  serverName: string;
  tagline: string;
  logoUrl: string | null;
  /** Wide/horizontal logo used in headers & TV top bar. */
  logoWideUrl: string | null;
  faviconUrl: string | null;
  /** App icon / splash image suggestion for native apps. */
  appIconUrl: string | null;
  loginBackgroundUrl: string | null;
  loginMessage: string;
  footerText: string;
  supportUrl: string | null;
  splash: { backgroundColor: string; logoUrl: string | null };
  /** The default theme applied to everyone. */
  defaultThemeId: string;
  /** All themes available (presets + admin-made). */
  themes: Theme[];
  /** Let users pick a theme from `themes` for themselves. */
  allowUserThemes: boolean;
  homeRows: HomeRowConfig[];
  features: FeatureFlags;
  /** Extra CSS injected by the web client. */
  customCss: string;
  /** Bumped every time branding changes so clients can cache-bust. */
  revision: number;
}

export type BrandingAssetKind =
  | 'logo'
  | 'logoWide'
  | 'favicon'
  | 'appIcon'
  | 'loginBackground'
  | 'splashLogo';

/* ------------------------------------------------------------------ */
/* Auth & users                                                        */
/* ------------------------------------------------------------------ */

export type Platform = 'web' | 'ios' | 'android' | 'tvos' | 'androidtv' | 'other';

export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  platform: Platform;
  appVersion?: string;
}

export interface LoginRequest extends DeviceInfo {
  username: string;
  password: string;
}

export interface PinLoginRequest extends DeviceInfo {
  userId: string;
  pin?: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface PublicProfile {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  hasPin: boolean;
  /** If false the profile can be entered with the PIN alone (or nothing). */
  requiresPassword: boolean;
}

export interface LinkCodeRequest extends DeviceInfo {}
export interface LinkCodeResponse {
  /** Short code shown on the TV, e.g. "K7PQ". */
  code: string;
  pollToken: string;
  expiresAt: string;
}
export interface LinkPollResponse {
  status: 'pending' | 'linked' | 'expired';
  token?: string;
  user?: User;
}

export interface UserPreferences {
  audioLanguage: string | null;
  subtitleLanguage: string | null;
  subtitleMode: 'off' | 'auto' | 'always' | 'forced';
  autoplayNext: boolean;
  skipIntros: boolean;
  /** Max streaming bitrate in kbps; null = original. */
  maxBitrate: number | null;
  themeId: string | null;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  avatarUrl: string | null;
  hasPin: boolean;
  /** Profiles without a password can be entered from the profile picker. */
  hasPassword: boolean;
  /** Max content rating allowed (e.g. "PG-13", "TV-14"); null = unrestricted. */
  maxContentRating: string | null;
  /** null = all libraries. */
  libraryIds: string[] | null;
  allowLiveTv: boolean;
  allowDownloads: boolean;
  allowTranscode: boolean;
  allowDvr: boolean;
  disabled: boolean;
  preferences: UserPreferences;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface CreateUserRequest {
  username: string;
  displayName?: string;
  password?: string;
  pin?: string;
  isAdmin?: boolean;
  maxContentRating?: string | null;
  libraryIds?: string[] | null;
  allowLiveTv?: boolean;
  allowDownloads?: boolean;
  allowTranscode?: boolean;
  allowDvr?: boolean;
}

export type UpdateUserRequest = Partial<CreateUserRequest> & { disabled?: boolean };

export interface UpdateMeRequest {
  displayName?: string;
  currentPassword?: string;
  password?: string;
  /** Empty string clears the PIN. */
  pin?: string;
  preferences?: Partial<UserPreferences>;
}

export interface Device {
  id: string;
  deviceId: string;
  deviceName: string;
  platform: Platform;
  appVersion: string | null;
  userId: string;
  userName: string;
  lastSeenAt: string;
  current?: boolean;
}

/* ------------------------------------------------------------------ */
/* Libraries                                                           */
/* ------------------------------------------------------------------ */

export type LibraryType =
  | 'movies'
  | 'shows'
  | 'music'
  | 'photos'
  | 'videos'
  /** Virtual libraries populated from an Xtream source. */
  | 'iptv-movies'
  | 'iptv-shows';

export interface Library {
  id: string;
  name: string;
  type: LibraryType;
  paths: string[];
  /** For iptv-* libraries. */
  sourceId: string | null;
  itemCount: number;
  lastScanAt: string | null;
  scanning: boolean;
  /** Use online metadata (TMDB) for this library. */
  fetchMetadata: boolean;
  /** Admin-defined sort order for menus. */
  sortOrder: number;
  createdAt: string;
}

export interface CreateLibraryRequest {
  name: string;
  type: Exclude<LibraryType, 'iptv-movies' | 'iptv-shows'>;
  paths: string[];
  fetchMetadata?: boolean;
}

export type UpdateLibraryRequest = Partial<CreateLibraryRequest> & { sortOrder?: number };

/* ------------------------------------------------------------------ */
/* Items                                                               */
/* ------------------------------------------------------------------ */

export type ItemType =
  | 'movie'
  | 'show'
  | 'season'
  | 'episode'
  | 'artist'
  | 'album'
  | 'track'
  | 'photo'
  | 'video'
  | 'collection'
  | 'playlist';

export interface Person {
  name: string;
  role: string | null;
  kind: 'actor' | 'director' | 'writer' | 'producer';
  imageUrl: string | null;
}

export interface UserItemData {
  played: boolean;
  playCount: number;
  positionMs: number;
  favorite: boolean;
  lastPlayedAt: string | null;
  /** 0-10 user rating. */
  rating: number | null;
  /** For containers (show/season): number of unplayed children. */
  unplayedCount?: number;
}

export interface AudioStream {
  index: number;
  codec: string;
  language: string | null;
  title: string | null;
  channels: number;
  default: boolean;
}

export interface SubtitleStream {
  index: number;
  codec: string;
  language: string | null;
  title: string | null;
  default: boolean;
  forced: boolean;
  /** true = sidecar file (srt/vtt/ass), false = embedded. */
  external: boolean;
}

export interface MediaSource {
  id: string;
  container: string | null;
  durationMs: number;
  size: number;
  bitrate: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  /** e.g. "4K", "1080p", "720p", "SD". */
  resolutionLabel: string | null;
  hdr: boolean;
  audioStreams: AudioStream[];
  subtitleStreams: SubtitleStream[];
  /** true when the file lives on a remote IPTV provider. */
  remote: boolean;
}

export interface Marker {
  type: 'intro' | 'credits' | 'recap';
  startMs: number;
  endMs: number;
}

export interface Item {
  id: string;
  libraryId: string | null;
  type: ItemType;
  title: string;
  sortTitle: string;
  originalTitle: string | null;
  year: number | null;
  overview: string | null;
  tagline: string | null;
  /** Community rating 0-10. */
  communityRating: number | null;
  contentRating: string | null;
  durationMs: number | null;
  genres: string[];
  studios: string[];
  people: Person[];
  posterUrl: string | null;
  backdropUrl: string | null;
  logoUrl: string | null;
  thumbUrl: string | null;
  parentId: string | null;
  grandparentId: string | null;
  parentTitle: string | null;
  grandparentTitle: string | null;
  /** Season/episode/track/disc number. */
  index: number | null;
  parentIndex: number | null;
  childCount: number;
  addedAt: string;
  releaseDate: string | null;
  externalIds: { tmdb?: string; imdb?: string; tvdb?: string; xtream?: string };
  userData: UserItemData;
  /** Populated on GET /items/:id only. */
  media?: MediaSource[];
  markers?: Marker[];
  trailerUrl?: string | null;
}

export type ItemSort =
  | 'title'
  | 'addedAt'
  | 'year'
  | 'releaseDate'
  | 'rating'
  | 'lastPlayed'
  | 'random'
  | 'index';

export interface ItemQuery {
  libraryId?: string;
  parentId?: string;
  /** Comma separated list allowed. */
  type?: ItemType | string;
  genre?: string;
  year?: number;
  search?: string;
  played?: boolean;
  favorite?: boolean;
  sort?: ItemSort;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  /** Return items whose sortTitle starts with this letter ('#' for digits). */
  letter?: string;
}

export interface UpdateItemRequest {
  title?: string;
  sortTitle?: string;
  originalTitle?: string | null;
  year?: number | null;
  overview?: string | null;
  tagline?: string | null;
  contentRating?: string | null;
  genres?: string[];
  studios?: string[];
  communityRating?: number | null;
  /** Locked fields are not overwritten by metadata refreshes. */
  lockedFields?: string[];
  markers?: Marker[];
}

export interface ProgressReport {
  positionMs: number;
  durationMs?: number;
  state: 'playing' | 'paused' | 'stopped';
  sessionId?: string;
}

export interface HomeRow {
  id: string;
  type: HomeRowType;
  title: string;
  items: Item[];
  channels?: Channel[];
  /** Deep link the client can use for "See all". */
  link?: { libraryId?: string; itemId?: string; genre?: string; sort?: ItemSort };
}

export interface HomeResponse {
  rows: HomeRow[];
}

export interface SearchResponse {
  items: Item[];
  channels: Channel[];
  programs: Program[];
}

export interface CreateCollectionRequest {
  title: string;
  overview?: string;
  itemIds?: string[];
}

export interface CreatePlaylistRequest {
  title: string;
  itemIds?: string[];
}

/* ------------------------------------------------------------------ */
/* Playback                                                            */
/* ------------------------------------------------------------------ */

export interface DeviceProfile {
  /** kbps; null = unlimited. */
  maxBitrate?: number | null;
  maxWidth?: number | null;
  /** e.g. ["h264","hevc","vp9","av1"]. */
  videoCodecs?: string[];
  /** e.g. ["aac","mp3","ac3","eac3","opus","flac"]. */
  audioCodecs?: string[];
  /** e.g. ["mp4","mkv","webm","mov","ts"]. */
  containers?: string[];
  supportsHls?: boolean;
}

export interface PlaybackRequest {
  mediaId?: string;
  startMs?: number;
  audioStreamIndex?: number;
  subtitleStreamIndex?: number | null;
  /** Burn the chosen subtitle into the video (forces transcode). */
  burnSubtitles?: boolean;
  forceTranscode?: boolean;
  deviceProfile?: DeviceProfile;
}

export type PlayMethod = 'direct' | 'remux' | 'transcode' | 'live';

export interface SubtitleTrack {
  index: number;
  language: string | null;
  title: string | null;
  default: boolean;
  forced: boolean;
  /** WebVTT URL including token. */
  url: string;
}

export interface PlaybackInfo {
  sessionId: string;
  itemId: string | null;
  channelId: string | null;
  method: PlayMethod;
  /** Absolute-path URL including `?token=` — prepend server base URL. */
  url: string;
  mimeType: string;
  isHls: boolean;
  startMs: number;
  durationMs: number | null;
  audioStreams: AudioStream[];
  subtitles: SubtitleTrack[];
  markers: Marker[];
  /** Next episode/track for autoplay. */
  nextItemId: string | null;
  title: string;
  subtitle: string | null;
  posterUrl: string | null;
  backdropUrl: string | null;
}

export interface ActiveSession {
  id: string;
  userId: string;
  userName: string;
  deviceName: string;
  platform: Platform;
  itemId: string | null;
  channelId: string | null;
  title: string;
  subtitle: string | null;
  posterUrl: string | null;
  method: PlayMethod;
  state: 'playing' | 'paused' | 'buffering';
  positionMs: number;
  durationMs: number | null;
  startedAt: string;
  remoteAddress: string | null;
  transcodeInfo: { videoCodec: string; audioCodec: string; bitrate: number | null; hwAccel: string } | null;
}

/* ------------------------------------------------------------------ */
/* Live TV & IPTV                                                      */
/* ------------------------------------------------------------------ */

export type LiveSourceType = 'xtream' | 'm3u' | 'hdhomerun';

export interface LiveSource {
  id: string;
  name: string;
  type: LiveSourceType;
  /** Xtream: portal base URL (http://host:port). M3U: playlist URL. HDHomeRun: device URL. */
  url: string;
  username: string | null;
  /** Never returned in full; masked as "••••" when set. */
  password: string | null;
  /** Optional XMLTV URL. Xtream sources default to their xmltv.php. */
  epgUrl: string | null;
  enabled: boolean;
  /** Restream through MediaMax (hides provider creds, allows remux/transcode). */
  proxyStreams: boolean;
  /** Import Xtream VOD movies into a virtual library. */
  importVod: boolean;
  /** Import Xtream series into a virtual library. */
  importSeries: boolean;
  /** Override the HTTP User-Agent sent to the provider. */
  userAgent: string | null;
  refreshIntervalHours: number;
  maxConnections: number | null;
  lastRefreshAt: string | null;
  lastError: string | null;
  channelCount: number;
  /** Xtream account info captured at last refresh. */
  accountInfo: XtreamAccountInfo | null;
}

export interface XtreamAccountInfo {
  status: string;
  expiresAt: string | null;
  activeConnections: number;
  maxConnections: number;
  isTrial: boolean;
}

export interface CreateLiveSourceRequest {
  name: string;
  type: LiveSourceType;
  url: string;
  username?: string | null;
  password?: string | null;
  epgUrl?: string | null;
  enabled?: boolean;
  proxyStreams?: boolean;
  importVod?: boolean;
  importSeries?: boolean;
  userAgent?: string | null;
  refreshIntervalHours?: number;
}

export type UpdateLiveSourceRequest = Partial<CreateLiveSourceRequest>;

export interface TestSourceResponse {
  ok: boolean;
  message: string;
  liveCount?: number;
  vodCount?: number;
  seriesCount?: number;
  accountInfo?: XtreamAccountInfo | null;
}

export interface ChannelCategory {
  id: string;
  sourceId: string;
  name: string;
  channelCount: number;
  /** Admin can hide categories. */
  hidden: boolean;
  sortOrder: number;
}

export interface Program {
  id: string;
  channelId: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  start: string;
  end: string;
  category: string | null;
  iconUrl: string | null;
  episodeNum: string | null;
  isNew: boolean;
  /** A recording is scheduled/exists for this program. */
  recordingId?: string | null;
}

export interface Channel {
  id: string;
  sourceId: string;
  number: number | null;
  name: string;
  logoUrl: string | null;
  categoryId: string | null;
  categoryName: string | null;
  /** Catch-up / timeshift (Xtream tv_archive). */
  hasArchive: boolean;
  archiveDays: number;
  favorite: boolean;
  hidden: boolean;
  epgChannelId: string | null;
  nowPlaying?: Program | null;
  next?: Program | null;
}

export interface ChannelQuery {
  sourceId?: string;
  categoryId?: string;
  search?: string;
  favorite?: boolean;
  limit?: number;
  offset?: number;
  /** Include nowPlaying/next. Default true. */
  withEpg?: boolean;
}

export interface GuideResponse {
  start: string;
  end: string;
  channels: Channel[];
  programs: Program[];
}

export interface LivePlayRequest {
  /** ISO time to start a catch-up (archive) stream. */
  catchupStart?: string;
  /** Minutes of catch-up to request. */
  catchupDurationMin?: number;
  /** Force remux to HLS (useful for browsers that can't play MPEG-TS). */
  forceHls?: boolean;
}

/* ------------------------------------------------------------------ */
/* DVR                                                                 */
/* ------------------------------------------------------------------ */

export type RecordingStatus = 'scheduled' | 'recording' | 'completed' | 'failed' | 'cancelled';

export interface Recording {
  id: string;
  channelId: string;
  channelName: string;
  programId: string | null;
  title: string;
  description: string | null;
  start: string;
  end: string;
  status: RecordingStatus;
  /** Library item created once completed. */
  itemId: string | null;
  ruleId: string | null;
  error: string | null;
  sizeBytes: number | null;
  createdBy: string;
}

export interface CreateRecordingRequest {
  channelId: string;
  programId?: string;
  title?: string;
  start?: string;
  end?: string;
  paddingBeforeMin?: number;
  paddingAfterMin?: number;
}

export interface RecordingRule {
  id: string;
  /** Record any program whose title contains this (case-insensitive). */
  titleMatch: string;
  /** null = any channel. */
  channelId: string | null;
  newOnly: boolean;
  keepLatest: number | null;
  paddingBeforeMin: number;
  paddingAfterMin: number;
  enabled: boolean;
}

export type CreateRecordingRuleRequest = Omit<RecordingRule, 'id' | 'enabled'> & { enabled?: boolean };

/* ------------------------------------------------------------------ */
/* Admin: settings, tasks, activity                                    */
/* ------------------------------------------------------------------ */

export type HwAccel = 'none' | 'vaapi' | 'nvenc' | 'qsv' | 'videotoolbox' | 'v4l2m2m';

export interface ServerSettings {
  serverName: string;
  publicUrl: string | null;
  tmdbApiKey: string | null;
  metadataLanguage: string;
  scanIntervalMinutes: number;
  epgRefreshHours: number;
  transcoding: {
    enabled: boolean;
    hwAccel: HwAccel;
    vaapiDevice: string;
    maxConcurrent: number;
    /** Default target bitrate (kbps) when a client gives none. */
    defaultBitrate: number;
    preset: 'ultrafast' | 'superfast' | 'veryfast' | 'faster' | 'fast' | 'medium';
    threads: number;
    segmentSeconds: number;
    toneMapHdr: boolean;
  };
  dvr: {
    recordingsPath: string;
    paddingBeforeMin: number;
    paddingAfterMin: number;
  };
  webhooks: Webhook[];
  /** Allow sign-in from the public profile picker without a password. */
  allowPasswordlessProfiles: boolean;
  sessionTimeoutDays: number;
}

export type WebhookEvent =
  | 'playback.start'
  | 'playback.pause'
  | 'playback.resume'
  | 'playback.stop'
  | 'playback.scrobble'
  | 'library.new'
  | 'user.login'
  | 'recording.completed'
  | 'recording.failed';

export interface Webhook {
  id: string;
  url: string;
  events: WebhookEvent[];
  enabled: boolean;
}

export interface ScheduledTask {
  id: string;
  name: string;
  description: string;
  intervalMinutes: number | null;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastResult: 'ok' | 'error' | null;
  lastError: string | null;
  running: boolean;
  progress: number | null;
}

export interface ActivityEntry {
  id: string;
  at: string;
  userId: string | null;
  userName: string | null;
  type: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
}

export interface DashboardStats {
  libraries: number;
  movies: number;
  shows: number;
  episodes: number;
  tracks: number;
  channels: number;
  users: number;
  activeSessions: number;
  transcodes: number;
  recordingsScheduled: number;
  diskFreeBytes: number | null;
  version: string;
  uptimeSeconds: number;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

/* ------------------------------------------------------------------ */
/* Realtime (WebSocket `/api/v1/ws?token=`)                            */
/* ------------------------------------------------------------------ */

export type ServerEvent =
  | { type: 'hello'; serverId: string; userId: string }
  | { type: 'library.scan'; libraryId: string; status: 'started' | 'progress' | 'finished'; progress?: number; message?: string }
  | { type: 'library.updated'; libraryId: string }
  | { type: 'sessions.updated'; sessions: ActiveSession[] }
  | { type: 'branding.updated'; revision: number }
  | { type: 'userdata.updated'; itemId: string; userData: UserItemData }
  | { type: 'task.updated'; task: ScheduledTask }
  | { type: 'recording.updated'; recording: Recording }
  | { type: 'session.terminated'; sessionId: string; reason: string }
  | { type: 'syncplay.state'; room: SyncPlayRoom }
  | { type: 'syncplay.command'; room: string; action: 'play' | 'pause' | 'seek' | 'load'; positionMs: number; itemId?: string; at: number; by: string }
  | { type: 'error'; message: string };

export type ClientEvent =
  | { type: 'ping' }
  | { type: 'syncplay.create'; itemId?: string }
  | { type: 'syncplay.join'; room: string }
  | { type: 'syncplay.leave'; room: string }
  | { type: 'syncplay.command'; room: string; action: 'play' | 'pause' | 'seek' | 'load'; positionMs: number; itemId?: string };

export interface SyncPlayRoom {
  id: string;
  /** Short code friends type to join. */
  code: string;
  ownerId: string;
  members: { userId: string; displayName: string }[];
  itemId: string | null;
  state: 'playing' | 'paused';
  positionMs: number;
  updatedAt: number;
}
