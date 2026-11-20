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
  /** Single sign-on, when the admin configured it. */
  oidc: { enabled: boolean; buttonLabel: string } | null;
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
  /** Media requests (Discover tab). */
  requests: boolean;
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
  /** Android TV launcher banner. */
  tvBannerUrl: string | null;
  /** Apple TV top shelf artwork. */
  topShelfUrl: string | null;
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
  | 'splashLogo'
  /** Android TV launcher banner (320x180). */
  | 'tvBanner'
  /** Apple TV top shelf image (1920x720 / 2320x720). */
  | 'topShelf';

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
  /** 6-digit authenticator code or a recovery code, when the account has two-factor enabled. */
  totpCode?: string;
}

export interface PinLoginRequest extends DeviceInfo {
  userId: string;
  pin?: string;
  totpCode?: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface PublicProfile {
  id: string;
  /** Username to use with `/auth/login` when the profile requires a password. */
  username: string;
  displayName: string;
  avatarUrl: string | null;
  hasPin: boolean;
  /** Number of digits in the PIN (so PIN pads can auto-submit). */
  pinLength: number | null;
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

/** Loudness levelling from ReplayGain / R128 tags (dB relative to the ReplayGain −18 LUFS reference). */
export interface ReplayGain {
  trackGainDb: number | null;
  trackPeak: number | null;
  albumGainDb: number | null;
  albumPeak: number | null;
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
  /** Music loudness levelling: album gain on album playback is the usual choice. Default 'auto'. */
  replayGain?: 'off' | 'track' | 'album' | 'auto';
  /** Play the server's cinema-mode intros (trailers, pre-roll) before movies. Default true when the server enables it. */
  cinemaMode?: boolean;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  avatarUrl: string | null;
  hasPin: boolean;
  pinLength: number | null;
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
  /** Allowed to stream from outside the local network. */
  allowRemote: boolean;
  /** Max simultaneous playback sessions (null = unlimited). */
  maxStreams: number | null;
  /** Two-factor authentication enabled. */
  totpEnabled: boolean;
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
  allowRemote?: boolean;
  maxStreams?: number | null;
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
  /** Audiobooks: one folder (or one .m4b) per book, grouped under the author. */
  | 'audiobooks'
  /** Podcast subscriptions (RSS); managed via /podcasts, has no folders. */
  | 'podcasts'
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

export interface PodcastSubscription {
  id: string;
  /** Item id of the podcast (browse/play it like any item). */
  itemId: string;
  feedUrl: string;
  title: string;
  imageUrl: string | null;
  episodeCount: number;
  lastRefreshAt: string | null;
  lastError: string | null;
  /** Download new episodes to the server automatically. */
  autoDownload: boolean;
}

export interface SubscribePodcastRequest {
  feedUrl: string;
  autoDownload?: boolean;
}

export interface PodcastSearchResult {
  title: string;
  author: string | null;
  feedUrl: string;
  imageUrl: string | null;
  genre: string | null;
}

export interface CreateLibraryRequest {
  name: string;
  type: Exclude<LibraryType, 'iptv-movies' | 'iptv-shows' | 'podcasts'>;
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
  | 'playlist'
  /** Audiobook (container of parts). Author in `people` (kind writer) and `grandparentTitle`-style `parentTitle`. */
  | 'audiobook'
  /** One file of an audiobook (child of `audiobook`). */
  | 'bookpart'
  /** Podcast show (container of episodes). */
  | 'podcast'
  /** Podcast episode (child of `podcast`, streamed from the feed's enclosure URL). */
  | 'podcastepisode';

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
  /** Movie edition, e.g. "Director's Cut", "Extended" (from `{edition-…}` or the filename). */
  edition: string | null;
}

export interface Marker {
  /** commercial: ad breaks from comskip or a `.edl` sidecar; preview: "next time on" scenes. */
  type: 'intro' | 'credits' | 'recap' | 'preview' | 'commercial';
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
  /** Populated on GET /items/:id only: fields protected from metadata refreshes. */
  lockedFields?: string[];
  /** Populated on GET /items/:id for media with embedded chapters (audiobooks, movies). */
  chapters?: Chapter[];
  /** Smart collection/playlist rules (null for manual lists). */
  smart?: SmartFilter | null;
  /** For local extras (trailers, featurettes…) attached to a movie or show — see GET /items/:id/extras. */
  extraType?: ExtraType;
  /** Book series (audiobooks) or movie collection order. */
  series?: { name: string; index: number | null } | null;
  /** Tracks: ReplayGain loudness tags, when the file has them. */
  replayGain?: ReplayGain | null;
}

export type ExtraType = 'trailer' | 'featurette' | 'behindthescenes' | 'deleted' | 'interview' | 'scene' | 'short' | 'other';

export interface Chapter {
  title: string;
  startMs: number;
  endMs: number;
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
  /** Items whose parent OR grandparent is this id (e.g. all tracks of an artist, all episodes of a show). */
  ancestorId?: string;
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
  /** Audiobooks in this series (sorted by series order). */
  series?: string;
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
  /** Position (ms) the client should seek to once playback starts. */
  startMs: number;
  /**
   * Media position (ms) that stream time 0 corresponds to. MediaMax always
   * produces full-timeline streams, so this is 0 for VOD; clients should
   * compute `mediaPosition = streamTime + streamStartMs`.
   */
  streamStartMs?: number;
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
  /** One or more XMLTV URLs (newline-separated), highest priority first; the provider's own guide fills gaps. */
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
  /** Multiview tile: keep this device's other multiview sessions running (max 4 per device; each counts toward stream limits). */
  multiview?: boolean;
}

/* ------------------------------------------------------------------ */
/* DVR                                                                 */
/* ------------------------------------------------------------------ */

export interface ArrService {
  url: string;
  apiKey: string;
  /** Quality profile id (see GET /requests/arr/:kind/options). */
  qualityProfileId: number | null;
  /** Root folder path for new titles. */
  rootFolder: string | null;
  /** Ask the service to search for the title immediately after adding. */
  searchOnAdd: boolean;
}

export interface ArrOptions {
  ok: boolean;
  message: string;
  qualityProfiles: { id: number; name: string }[];
  rootFolders: { path: string; freeSpace: number | null }[];
}

export interface DvrDefaults {
  paddingBeforeMin: number;
  paddingAfterMin: number;
}

/** Quality for `/stream/download/:itemId?quality=`. `original` = the untouched file. */
export type DownloadQuality = 'original' | '1080p' | '720p' | '480p';

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
  /** Higher wins when tuners/provider connections run out (manual: 90, rules: 0–99, 100 = top priority). */
  priority: number;
  /** Scheduled but would exceed the source's tuner/connection limit; won't record unless something else is cancelled. */
  conflict: boolean;
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
  /** 0-99; higher wins tuner conflicts. Default 50. */
  priority: number;
  /** Only airings on these weekdays (0 = Sunday … 6 = Saturday), local server time; null = any day. */
  daysOfWeek: number[] | null;
  /** Only airings starting within this local-time window ("HH:MM"); null = any time. */
  timeFrom: string | null;
  timeTo: string | null;
  /** Skip airings whose episode (number or episode title) was already recorded or scheduled by this rule. */
  skipRepeats: boolean;
}

export type CreateRecordingRuleRequest = Omit<RecordingRule, 'id' | 'enabled' | 'priority' | 'daysOfWeek' | 'timeFrom' | 'timeTo' | 'skipRepeats'> & {
  enabled?: boolean;
  priority?: number;
  daysOfWeek?: number[] | null;
  timeFrom?: string | null;
  timeTo?: string | null;
  skipRepeats?: boolean;
};

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
    /** Run comskip on finished recordings and add commercial markers (requires comskip on the server). */
    commercialDetection: boolean;
    /** Path to the comskip binary; defaults to `comskip` on PATH. */
    comskipPath: string | null;
    /** Optional comskip.ini; MediaMax supplies a minimal EDL-only ini otherwise. */
    comskipIni: string | null;
  };
  webhooks: Webhook[];
  aiDj: AiDjSettings;
  /** Cinema mode: trailers and a pre-roll before movies (players ask GET /items/:id/intros). */
  cinema: {
    enabled: boolean;
    /** How many trailers (local "Trailers" extras of other movies) to play first. */
    trailers: number;
    /** Only trailers for movies the viewer hasn't watched. */
    unwatchedOnly: boolean;
    /** A library of short pre-roll clips; one is picked at random and played last, right before the movie. */
    prerollLibraryId: string | null;
  };
  /** Allow sign-in from the public profile picker without a password. */
  allowPasswordlessProfiles: boolean;
  /** Hide items with no content rating from users who have a rating limit. */
  blockUnratedForRestricted: boolean;
  trickplay: {
    /** Generate scrub-preview thumbnails in the background. */
    enabled: boolean;
    intervalSeconds: number;
    width: number;
  };
  openSubtitles: {
    apiKey: string | null;
    username: string | null;
    password: string | null;
    /** Languages to fetch automatically for new media (ISO 639-1, e.g. ["en"]); empty = off. */
    autoLanguages: string[];
  };
  trakt: {
    clientId: string | null;
    clientSecret: string | null;
  };
  lastfm: {
    apiKey: string | null;
    sharedSecret: string | null;
  };
  /** Media requests and the download managers approved requests are sent to. */
  requests: {
    enabled: boolean;
    /** Requests from admins (and users listed here) are approved automatically. */
    autoApproveUserIds: string[];
    /** Max open requests per user per 7 days (0 = unlimited). */
    weeklyLimit: number;
    radarr: ArrService | null;
    sonarr: ArrService | null;
  };
  /** Single sign-on via any OpenID Connect provider (Authentik, Keycloak, Authelia, Google, Entra…). */
  oidc: {
    enabled: boolean;
    /** Issuer URL, e.g. https://auth.example.com/application/o/mediamax/ */
    issuer: string | null;
    clientId: string | null;
    clientSecret: string | null;
    buttonLabel: string;
    /** Create a MediaMax user on first SSO sign-in. */
    autoCreateUsers: boolean;
    /** Claim holding group names (default "groups"). */
    groupsClaim: string;
    /** Members of this group become administrators. */
    adminGroup: string | null;
    /** If set, only members of this group may sign in. */
    allowedGroup: string | null;
  };
  plugins: {
    /** Plugin repository index URLs (https). */
    repositories: string[];
  };
  remoteAccess: {
    /** Ask the router to forward a port via UPnP. */
    upnp: boolean;
    /** External port to map (default: same as the server port). */
    externalPort: number | null;
  };
  backups: {
    /** Automatic backup every N days (0 = off). */
    intervalDays: number;
    /** How many automatic backups to keep. */
    keep: number;
  };
  /** DLNA / UPnP media server for smart TVs, consoles and players on the local network. */
  dlna: {
    enabled: boolean;
    /** Name shown on TVs; defaults to the server name. */
    friendlyName: string | null;
    /** Browse as this user (library access & rating limits apply). Required — DLNA serves nothing until set. */
    userId: string | null;
  };
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
  | 'recording.failed'
  | 'request.created'
  | 'request.available';

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
  | { type: 'error'; message: string }
  /** A command from another of your devices (apply it to the local player). */
  | { type: 'remote.command'; fromDeviceName: string; action: RemoteAction; itemId?: string; channelId?: string; positionMs?: number; volume?: number }
  /** Your controllable devices changed (online/offline/now playing). */
  | { type: 'remote.targets'; targets: RemoteTarget[] };

export type ClientEvent =
  | { type: 'ping' }
  | { type: 'syncplay.create'; itemId?: string }
  | { type: 'syncplay.join'; room: string }
  | { type: 'syncplay.leave'; room: string }
  | { type: 'syncplay.command'; room: string; action: 'play' | 'pause' | 'seek' | 'load'; positionMs: number; itemId?: string }
  /** Control another of your own devices ("Play on…"). */
  | { type: 'remote.command'; targetDeviceId: string; action: RemoteAction; itemId?: string; channelId?: string; positionMs?: number; volume?: number }
  /** Players report what they're doing so other devices can show and control it. Send on change and every ~10 s while playing. */
  | { type: 'remote.state'; state: RemotePlayerState | null };

export type RemoteAction = 'play' | 'pause' | 'togglePause' | 'stop' | 'seek' | 'next' | 'previous' | 'setVolume' | 'playItem' | 'playChannel';

export interface RemotePlayerState {
  itemId: string | null;
  channelId: string | null;
  title: string | null;
  subtitle: string | null;
  posterUrl: string | null;
  positionMs: number;
  durationMs: number | null;
  paused: boolean;
  /** 0-100 */
  volume: number | null;
}

/** One of the user's online devices that can be controlled. `id` is the device row id. */
export interface RemoteTarget {
  id: string;
  deviceName: string;
  platform: Platform;
  state: RemotePlayerState | null;
}

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

/* ------------------------------------------------------------------ */
/* Trickplay (scrub preview thumbnails)                                */
/* ------------------------------------------------------------------ */

export interface TrickplayInfo {
  mediaId: string;
  /** Milliseconds between thumbnails. */
  intervalMs: number;
  /** Size of one thumbnail in px. */
  width: number;
  height: number;
  /** Thumbnails per sheet row / column. */
  columns: number;
  rows: number;
  /** Total thumbnails across all sheets. */
  count: number;
  /** Sprite sheet URLs (include `?token=`), in order. Thumbnail n is on sheet floor(n / (columns*rows)). */
  sheets: string[];
}

/* ------------------------------------------------------------------ */
/* Statistics / "Wrapped"                                              */
/* ------------------------------------------------------------------ */

export interface StatsTopEntry {
  itemId: string | null;
  title: string;
  subtitle: string | null;
  posterUrl: string | null;
  plays: number;
  minutes: number;
}

export interface UserStats {
  /** Year the stats cover, or null for all time. */
  year: number | null;
  totalMinutes: number;
  totalPlays: number;
  moviesWatched: number;
  episodesWatched: number;
  tracksPlayed: number;
  liveTvMinutes: number;
  /** Longest run of consecutive days with any playback. */
  longestStreakDays: number;
  /** Minutes per month (12 entries, Jan..Dec) — only when year is set. */
  minutesByMonth: number[];
  /** Minutes per weekday (7 entries, Sun..Sat). */
  minutesByWeekday: number[];
  /** Minutes per hour of day (24 entries). */
  minutesByHour: number[];
  topGenres: { genre: string; minutes: number }[];
  topMovies: StatsTopEntry[];
  topShows: StatsTopEntry[];
  topArtists: StatsTopEntry[];
  topChannels: StatsTopEntry[];
  /** A few short fun facts for the "Wrapped" screen. */
  highlights: string[];
}

export interface ServerStats {
  days: number;
  totalPlays: number;
  totalMinutes: number;
  byUser: { userId: string; userName: string; plays: number; minutes: number }[];
  byPlatform: { platform: string; plays: number }[];
  byMethod: { method: string; plays: number }[];
  topItems: StatsTopEntry[];
  /** Plays per day for the window (oldest first). */
  playsByDay: { date: string; plays: number; minutes: number }[];
}

/* ------------------------------------------------------------------ */
/* Online subtitles (OpenSubtitles)                                    */
/* ------------------------------------------------------------------ */

export interface RemoteSubtitle {
  /** Provider file id to pass to the download endpoint. */
  fileId: string;
  provider: 'opensubtitles';
  language: string;
  release: string | null;
  downloads: number;
  hearingImpaired: boolean;
  forced: boolean;
  aiTranslated: boolean;
  rating: number | null;
}

/* ------------------------------------------------------------------ */
/* Trakt                                                               */
/* ------------------------------------------------------------------ */

export interface TraktStatus {
  /** Admin has configured a Trakt app (client id/secret). */
  available: boolean;
  connected: boolean;
  username: string | null;
  scrobble: boolean;
}

export interface LastfmStatus {
  /** Admin configured a Last.fm API account. */
  available: boolean;
  connected: boolean;
  username: string | null;
  scrobble: boolean;
}

export interface LastfmAuthStart {
  /** Open this in a browser to approve MediaMax; then poll GET /lastfm until connected. */
  authUrl: string;
}

export interface TraktDeviceCode {
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  intervalSeconds: number;
}

/* ------------------------------------------------------------------ */
/* Lyrics                                                              */
/* ------------------------------------------------------------------ */

export interface LyricLine {
  /** Start time in ms; null for unsynced lyrics. */
  startMs: number | null;
  text: string;
}

export interface Lyrics {
  itemId: string;
  synced: boolean;
  source: 'lrc' | 'embedded' | 'txt';
  lines: LyricLine[];
}

/* ------------------------------------------------------------------ */
/* Media requests (Overseerr-style, with Radarr/Sonarr)                */
/* ------------------------------------------------------------------ */

export type RequestMediaType = 'movie' | 'show';
export type RequestStatus = 'pending' | 'approved' | 'declined' | 'processing' | 'available' | 'failed';

export interface DiscoverResult {
  tmdbId: string;
  mediaType: RequestMediaType;
  title: string;
  year: number | null;
  overview: string | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  rating: number | null;
  /** Already in a library (item id), if so. */
  availableItemId: string | null;
  /** An open request for this title, if any. */
  requestId: string | null;
  requestStatus: RequestStatus | null;
}

export interface MediaRequest {
  id: string;
  tmdbId: string;
  mediaType: RequestMediaType;
  title: string;
  year: number | null;
  posterUrl: string | null;
  /** Requested seasons for shows (empty = all). */
  seasons: number[];
  status: RequestStatus;
  requestedBy: { id: string; displayName: string };
  requestedAt: string;
  decidedBy: { id: string; displayName: string } | null;
  decidedAt: string | null;
  note: string | null;
  /** Library item once it has arrived. */
  itemId: string | null;
  error: string | null;
}

export interface CreateMediaRequest {
  tmdbId: string;
  mediaType: RequestMediaType;
  seasons?: number[];
  note?: string;
}

export interface DiscoverResponse {
  results: DiscoverResult[];
  page: number;
  totalPages: number;
}

/* ------------------------------------------------------------------ */
/* Smart collections / playlists                                       */
/* ------------------------------------------------------------------ */

export type SmartRuleField =
  | 'genre' | 'year' | 'rating' | 'contentRating' | 'addedDays' | 'played' | 'favorite' | 'person' | 'studio'
  | 'library' | 'type' | 'durationMin' | 'title' | 'resolution' | 'inProgress';

export type SmartRuleOp = 'is' | 'isNot' | 'contains' | 'gte' | 'lte' | 'between';

export interface SmartRule {
  field: SmartRuleField;
  op: SmartRuleOp;
  /** String, number, boolean, or [min,max] for `between`. */
  value: string | number | boolean | [number, number];
}

export interface SmartFilter {
  /** all = AND, any = OR. */
  match: 'all' | 'any';
  rules: SmartRule[];
  sort: ItemSort;
  order: 'asc' | 'desc';
  limit: number | null;
}

/**
 * Smart collections (admin, visible to everyone) and smart playlists (per user) are ordinary
 * `collection`/`playlist` items whose `smart` field is set; their children are computed live
 * for the viewing user (respecting their library access, rating limits and watch state).
 */
export interface CreateSmartListRequest {
  kind: 'collection' | 'playlist';
  title: string;
  overview?: string;
  filter: SmartFilter;
}

/* ------------------------------------------------------------------ */
/* Plugins                                                             */
/* ------------------------------------------------------------------ */

export type PluginSettingType = 'string' | 'secret' | 'number' | 'boolean' | 'select' | 'text';

export interface PluginSetting {
  key: string;
  label: string;
  type: PluginSettingType;
  default?: string | number | boolean | null;
  help?: string;
  /** For `select`. */
  options?: { value: string; label: string }[];
  required?: boolean;
}

export interface PluginManifest {
  /** Reverse-DNS style unique id, e.g. "com.example.discord-notify". */
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  homepage?: string;
  /** Entry module (ES module) relative to the plugin folder; exports `activate(ctx)`. */
  main: string;
  /** Minimum MediaMax server version (semver). */
  minServerVersion?: string;
  settings?: PluginSetting[];
  /** HTML page (relative path) shown inside the admin dashboard. */
  adminPage?: string;
  /** Capabilities the plugin declares, shown to the admin before install. */
  capabilities?: ('routes' | 'events' | 'tasks' | 'metadata' | 'adminPage' | 'network')[];
}

export type PluginStatus = 'active' | 'disabled' | 'error' | 'incompatible';

export interface PluginInfo {
  manifest: PluginManifest;
  status: PluginStatus;
  error: string | null;
  /** Current setting values (secrets masked as "••••••••"). */
  settings: Record<string, string | number | boolean | null>;
  source: 'repository' | 'upload' | 'local';
  /** Repository URL it was installed from, for updates. */
  repository: string | null;
  installedAt: string;
  /** Newer version available in a configured repository. */
  updateAvailable: string | null;
  /** `/api/v1/plugins/<id>/ui/<adminPage>?token=` when the plugin has an admin page. */
  adminPageUrl: string | null;
}

export interface PluginCatalogVersion {
  version: string;
  /** .tar.gz archive containing plugin.json at its root. */
  url: string;
  sha256: string;
  minServerVersion?: string;
  changelog?: string;
}

export interface PluginCatalogEntry {
  id: string;
  name: string;
  description: string;
  author: string;
  homepage?: string;
  repository: string;
  versions: PluginCatalogVersion[];
  installedVersion: string | null;
}

/** Shape of a plugin repository (a JSON file served over https). */
export interface PluginRepositoryIndex {
  name: string;
  plugins: Omit<PluginCatalogEntry, 'repository' | 'installedVersion'>[];
}

/* ------------------------------------------------------------------ */
/* API keys, two-factor, invites                                       */
/* ------------------------------------------------------------------ */

export interface ApiKey {
  id: string;
  name: string;
  /** First characters of the key, for recognising it. */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface CreatedApiKey extends ApiKey {
  /** Shown once. Send as `X-Api-Key: <key>` (or `?api_key=`); acts as the key's owner. */
  key: string;
}

export interface TotpSetup {
  /** Base32 secret for manual entry. */
  secret: string;
  /** otpauth:// URL to render as a QR code. */
  otpauthUrl: string;
}

export interface TotpEnabled {
  /** One-time recovery codes, shown once. */
  recoveryCodes: string[];
}

export interface InviteTemplate {
  libraryIds: string[] | null;
  maxContentRating: string | null;
  allowLiveTv: boolean;
  allowDownloads: boolean;
  allowTranscode: boolean;
  allowDvr: boolean;
  allowRemote: boolean;
  maxStreams: number | null;
}

export interface Invite {
  code: string;
  /** Full link to share: <publicUrl or origin>/invite/<code>. */
  url: string;
  note: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
  template: InviteTemplate;
}

export interface CreateInviteRequest {
  note?: string;
  expiresInDays?: number | null;
  maxUses?: number | null;
  template?: Partial<InviteTemplate>;
}

export interface InvitePreview {
  valid: boolean;
  serverName: string;
  message: string | null;
}

export interface AcceptInviteRequest extends DeviceInfo {
  username: string;
  password: string;
  displayName?: string;
}

/* ------------------------------------------------------------------ */
/* Backup & remote access                                              */
/* ------------------------------------------------------------------ */

export interface BackupInfo {
  id: string;
  createdAt: string;
  sizeBytes: number;
  /** "manual" | "scheduled" | "pre-restore". */
  reason: string;
}

export interface RemoteAccessStatus {
  lanAddress: string;
  port: number;
  publicUrl: string | null;
  upnp: {
    enabled: boolean;
    /** Router found and mapping active. */
    mapped: boolean;
    externalIp: string | null;
    externalPort: number | null;
    router: string | null;
    error: string | null;
    lastCheckedAt: string | null;
  };
}

/* ------------------------------------------------------------------ */
/* Audiobook bookmarks                                                 */
/* ------------------------------------------------------------------ */

export interface Bookmark {
  id: string;
  itemId: string;
  positionMs: number;
  note: string | null;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* DJ mode: track analysis, automatic mixes, continuous playback       */
/* ------------------------------------------------------------------ */

/** Per-track audio analysis used for beat/key-aware mixing. Times are in ms from the start of the file. */
export interface TrackAnalysis {
  itemId: string;
  /** Tempo in beats per minute (null when the track has no steady beat, e.g. ambient or speech). */
  bpm: number | null;
  /** 0–1: how sure the tempo estimate is. */
  bpmConfidence: number;
  /** Time of one beat of the beat grid (beats fall at beatOffsetMs + n × 60000/bpm). */
  beatOffsetMs: number | null;
  /** Timbre fingerprint (normalised MFCC means/deviations + spectral shape) for "sounds like" matching. */
  timbre: number[] | null;
  /** Musical key, e.g. "A minor". */
  key: string | null;
  /** Camelot wheel code, e.g. "8A" (minor = A, major = B). Neighbours on the wheel mix harmonically. */
  camelot: string | null;
  /** 0–1 overall intensity (loudness and density), comparable across the library. */
  energy: number;
  /** Integrated loudness estimate in dBFS. */
  loudnessDb: number | null;
  /** First audible moment (skips leading silence). */
  cueInMs: number;
  /** Last audible moment (drops trailing silence). */
  cueOutMs: number;
  /** End of a quieter intro, if there is one: a good point for the previous track to finish fading out. */
  introEndMs: number | null;
  /** Start of the outro (energy falls away): the natural place to start mixing into the next track. */
  outroStartMs: number | null;
  durationMs: number;
  analyzedAt: string;
}

/** Shape of the mix over time. */
export type DjEnergyCurve = 'steady' | 'build' | 'peak' | 'wave' | 'chill';

export interface DjMixRequest {
  /** AI DJ: describe the mix in plain language ("chilled 90s house for a Sunday morning"). Parsed into the fields below. */
  prompt?: string;
  /** Only tracks released in this range (inclusive). */
  yearFrom?: number;
  yearTo?: number;
  /** Skip tracks longer than this. */
  maxTrackMinutes?: number;
  /** Start from this track (or album/artist/playlist/genre item) and build around it. */
  seedItemId?: string;
  /** Only use tracks from these genres (case-insensitive). */
  genres?: string[];
  libraryId?: string;
  /** Target length; default 60. Ignored when `count` is given. */
  durationMin?: number;
  /** Exact number of tracks (used by continuous mode to top up the queue). */
  count?: number;
  curve?: DjEnergyCurve;
  bpmMin?: number;
  bpmMax?: number;
  /** Prefer key-compatible neighbours (Camelot wheel). Default true. */
  harmonic?: boolean;
  /** Tracks already played or queued (never repeated; the last one is the track to mix out of). */
  history?: string[];
  /** Minimum number of tracks between two songs by the same artist. Default 3. */
  artistGap?: number;
  /** Favourites and highly rated tracks get a boost. Default true. */
  preferFavorites?: boolean;
}

export interface DjTransition {
  /** Position in the outgoing track where the incoming one starts. */
  mixOutMs: number;
  /** Position in the incoming track to start playing from. */
  mixInMs: number;
  /** Length of the crossfade. */
  crossfadeMs: number;
  /** Playback rate for the incoming track to match tempo during the blend (1 = untouched; within ±8%). */
  tempoRatio: number;
  /** blend = long beat-matched mix; fade = plain crossfade; cut = quick swap (clashing keys or tempos). */
  style: 'blend' | 'fade' | 'cut';
  keyMatch: 'perfect' | 'compatible' | 'energy' | 'clash' | 'unknown';
  bpmDelta: number | null;
}

export interface DjMixTrack {
  item: Item;
  analysis: TrackAnalysis | null;
  /** How to get into this track from the previous one (null for the first track). */
  transition: DjTransition | null;
}

export interface DjMix {
  tracks: DjMixTrack[];
  durationMs: number;
  curve: DjEnergyCurve;
  /** Share of candidate tracks that have been analysed (0–1); mixes improve as analysis completes. */
  analyzedShare: number;
  /** AI DJ: what the request was understood as, e.g. "House · 1990s · chill · 60 min". */
  summary?: string;
  /** AI DJ: whether the prompt was understood by the language model or the built-in parser. */
  understoodBy?: 'llm' | 'rules';
  /** The resolved request (send it back for continuous top-ups). */
  request?: DjMixRequest;
  /** AI DJ: the prompt asked for a non-stop mix ("all night", "radio"). */
  continuous?: boolean;
}

/** AI DJ host: a short spoken link between two tracks. */
export interface DjHostRequest {
  /** Track that just finished (or is fading out); omit for the opening line. */
  previousItemId?: string;
  nextItemId: string;
  /** How many tracks have played in this mix so far. */
  position: number;
  /** The listener's mix prompt, for context. */
  prompt?: string;
  /** The listener's local hour (0–23), for greetings. */
  hour?: number;
}

export interface DjHostLine {
  text: string;
  /** Server-rendered speech (Piper); when absent, clients speak `text` with their own TTS. */
  audioUrl: string | null;
  /** Length of `audioUrl` when known. */
  durationMs: number | null;
  by: 'llm' | 'template';
}

export interface DjFeedback {
  itemId: string;
  kind: 'skip' | 'love';
}

/** AI DJ settings (Server settings → AI DJ). Everything is optional: with nothing configured the AI DJ uses
 *  its built-in prompt parser, templates and the device's own voice. */
export interface AiDjSettings {
  enabled: boolean;
  /**
   * Language model. 'ollama' = Ollama's API (local, free). 'openai' = any OpenAI-compatible API: self-hosted (LM Studio,
   * llama.cpp, LocalAI, vLLM) or hosted with free tiers / very low prices (Groq, Google Gemini, OpenRouter, Mistral,
   * Cerebras, DeepSeek, OpenAI). `apiKey` is write-only: reads return "••••" when one is set.
   */
  llm: {
    provider: 'none' | 'ollama' | 'openai'; url: string | null; model: string | null; apiKey: string | null;
    /** Cap on model calls per day (keeps hosted free tiers free); over the cap the DJ falls back to its built-in rules. 0 = no cap. */
    maxRequestsPerDay: number;
  };
  /**
   * Speech. 'device' = each app's built-in voice (free, no setup). 'piper' = Piper on this server (free, open-source).
   * 'openai' = any OpenAI-compatible /audio/speech API: self-hosted Kokoro-FastAPI / openedai-speech (free) or a hosted one.
   */
  tts: {
    provider: 'device' | 'piper' | 'openai';
    piperPath: string | null; voiceModel: string | null; speaker: number | null;
    url: string | null; model: string | null; voice: string | null; apiKey: string | null;
  };
  /** How often the host talks: 'rare' ≈ every 4–5 tracks, 'normal' ≈ every 2–3, 'chatty' = every track. */
  chattiness: 'rare' | 'normal' | 'chatty';
  /** Name the host introduces itself with. */
  hostName: string;
}

export interface DjStatus {
  analyzed: number;
  total: number;
  running: boolean;
  /** AI DJ availability for clients. */
  ai: { enabled: boolean; llm: boolean; serverVoice: boolean; hostName: string; chattiness: AiDjSettings['chattiness'] };
}

/** A one-click starting point for the whole server's look: theme + home screen rows + feature toggles. */
export interface StarterLook {
  id: string;
  name: string;
  description: string;
  themeId: string;
  homeRows: HomeRowConfig[];
  features: Partial<FeatureFlags>;
}
