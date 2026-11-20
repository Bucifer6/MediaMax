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
  | 'playlist'
  /** "Recommended for you": scored from the viewer's history, favourites, ratings and what similar viewers watched. */
  | 'recommended'
  /** "Because you watched <title>": titles most similar to one recently finished movie or show. */
  | 'because'
  /** "Top 10 on <server> this week": most-played titles across all users in the last 7 days (episodes roll up to shows). */
  | 'top10'
  /** "Popular right now": recent plays weighted by recency. */
  | 'trending'
  /** "My List": the viewer's watchlist. */
  | 'watchlist'
  /** "Coming soon": next airing episodes of shows in the viewer's libraries (needs TMDB). */
  | 'upcoming';

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
  /** Play muted trailer previews in the home hero and on card hover. Default true (clients also respect reduced-motion settings). */
  autoplayPreviews?: boolean;
  /** How text subtitles look (web/TV players). Default: medium, white, shadow, default font, bottom. */
  subtitleStyle?: SubtitleStyle;
  /** Music: crossfade between tracks in seconds (0–12; 0 = gapless, no fade). Consecutive tracks of one album never crossfade. */
  musicCrossfadeSec?: number;
}

/** Subtitle appearance, applied to text tracks (WebVTT `::cue`). */
export interface SubtitleStyle {
  size: 'small' | 'medium' | 'large' | 'xlarge';
  color: 'white' | 'yellow' | 'cyan' | 'green';
  /** none = plain text; shadow = outlined text, no box; box = translucent box; boxSolid = opaque black box. */
  background: 'none' | 'shadow' | 'box' | 'boxSolid';
  font: 'default' | 'serif' | 'mono' | 'rounded';
  /** raised = lifted above the bottom edge (clears burnt-in lower thirds and the control bar). */
  position: 'bottom' | 'raised';
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
  /** May ask for a 4K copy when requesting titles ("Also request in 4K"). Admins always can. */
  allowRequest4k: boolean;
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
  allowRequest4k?: boolean;
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
  /** On the viewer's watchlist ("My List"). */
  inWatchlist: boolean;
  /** The viewer said "Not interested": hidden from recommendation, because-you-watched and trending rows. */
  notInterested: boolean;
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
  /** IMDb / Rotten Tomatoes / Metacritic (OMDb) and TMDB ratings. */
  ratings?: ItemRatings | null;
  /** Shows: episode ordering used to match episodes (set on the Edit page; default aired). */
  episodeOrder?: EpisodeOrder;
  /** GET /items/:id only: extra artwork from fanart.tv / TheAudioDB. */
  extraArt?: { clearArtUrl?: string | null; discArtUrl?: string | null; bannerUrl?: string | null };
  /** Artists, GET /items/:id only: facts from TheAudioDB. */
  artistInfo?: { formedYear?: number | null; country?: string | null; mood?: string | null; style?: string | null };
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
  /** Shows only: episode ordering (TheTVDB); changing it re-matches the episodes. */
  episodeOrder?: EpisodeOrder;
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
  /** Deep link the client can use for "See all". `page` points at a built-in screen (My List, calendar). */
  link?: { libraryId?: string; itemId?: string; genre?: string; sort?: ItemSort; page?: 'watchlist' | 'calendar' };
  /** `because` rows: the title the row is based on. */
  seedItemId?: string;
  /** `upcoming` rows: one entry per item, in the same order (items are the shows). */
  calendar?: CalendarEntry[];
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
  /**
   * Muted trailer preview (home hero, card hover). Only for trailer extras: it doesn't replace other playback on the
   * device, isn't recorded in play history, and isn't scrobbled or sent to webhooks. Stop it with DELETE /playback/sessions/:id.
   */
  preview?: boolean;
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
  transcodeInfo: {
    videoCodec: string; audioCodec: string; bitrate: number | null; hwAccel: string;
    /** Set when the hardware transcode failed and this session fell back (e.g. "vaapi failed, used software: …"). */
    hwFallback?: string | null;
    /** HDR → SDR tone-mapping path in use, when tone-mapping. */
    toneMap?: string | null;
  } | null;
}

/* ------------------------------------------------------------------ */
/* Live TV & IPTV                                                      */
/* ------------------------------------------------------------------ */

export type LiveSourceType = 'xtream' | 'm3u' | 'hdhomerun' | 'tvheadend' | 'satip' | 'enigma2';

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
  /** The guide source (`EpgSource.id`) the channel's guide data comes from, when matched. */
  epgSourceId?: string | null;
  /** How the guide match was made: `manual`, `auto`, `review` (suggestion waiting for an admin) or `none`. */
  guideStatus?: GuideMatchStatus | null;
  /** Programme times are shifted by this many hours (manual time-shift, or +1 channels). */
  epgOffsetHours?: number;
  /** Admin channel lists with `guideStatus=true`: the channel has guide data from now on. */
  hasGuide?: boolean;
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
  /** Admin only: include `hasGuide` (a "missing guide" badge in admin lists). */
  guideStatus?: boolean;
}

/* ------------------------------ TV guide (EPG) providers ------------------------------ */

/** `xmltv` covers plain XMLTV URLs/files and the iptv-org / epg.pw presets. `provider` is a live source's own guide. */
export type EpgSourceKind = 'xmltv' | 'schedulesdirect' | 'hdhomerun' | 'provider';
export type GuideMatchStatus = 'manual' | 'auto' | 'review' | 'none';

export interface EpgSourceConfig {
  /** xmltv: http(s) URL (.xml, .xml.gz or .xml.xz). */
  url?: string | null;
  /** xmltv: absolute path of a local XMLTV file instead of a URL. */
  path?: string | null;
  /** xmltv: id of the built-in preset this guide came from (see GET /livetv/epg-presets). */
  preset?: string | null;
  /** xmltv: reinterpret the guide's times in this IANA zone (e.g. "Europe/London") or fixed offset ("+01:00"). */
  timezone?: string | null;
  /** schedulesdirect: account username. */
  username?: string | null;
  /** schedulesdirect: write-only. Send it to set it; responses only say `hasPassword`. */
  password?: string | null;
  /** schedulesdirect: days of guide data to fetch (1–21, default 7). */
  days?: number;
  /** schedulesdirect: also fetch programme artwork. */
  artwork?: boolean;
  /** hdhomerun: the HDHomeRun live source whose tuner provides the DeviceAuth. */
  liveSourceId?: string | null;
  /** hdhomerun: or a device address (http://192.168.1.50). */
  deviceUrl?: string | null;
}

export interface EpgSource {
  id: string;
  name: string;
  kind: EpgSourceKind;
  /** Kind-specific settings. Secrets are never returned. */
  config: EpgSourceConfig & { hasPassword?: boolean; lineups?: SdLineup[] };
  /** Higher wins: each channel takes its programmes from the highest-priority guide that has it; lower ones fill gaps. */
  priority: number;
  enabled: boolean;
  /** null = applies to every live source; otherwise only these live source ids. */
  liveSourceIds: string[] | null;
  /** Set when the guide belongs to one live source (its provider guide, or a URL from its `epgUrl` field). */
  ownerSourceId: string | null;
  /** `epgUrl` = created from the live source's EPG URL field; `provider` = the provider's own guide. Managed guides can only change priority/enabled. */
  managedBy: 'epgUrl' | 'provider' | null;
  refreshIntervalHours: number;
  lastRefreshAt: string | null;
  lastError: string | null;
  refreshing: boolean;
  channelCount: number;
  report: EpgSourceReport;
}

export interface EpgSourceReport {
  /** Guide channels in the source. */
  channels: number;
  /** Programmes stored (from 8 days ago to 14 days ahead). */
  programmes: number;
  /** Live channels whose guide currently comes from this source. */
  matchedChannels: number;
  /** Days of guide data ahead of now (latest programme end). */
  daysAhead: number;
  /** Duration of the last successful refresh. */
  lastDurationMs: number | null;
  /** Non-fatal notes from the last refresh (a URL that failed, a skipped lineup...). */
  warnings: string[];
}

export interface CreateEpgSourceRequest {
  name: string;
  kind: Exclude<EpgSourceKind, 'provider'>;
  config: EpgSourceConfig;
  priority?: number;
  enabled?: boolean;
  liveSourceIds?: string[] | null;
  refreshIntervalHours?: number;
}
export type UpdateEpgSourceRequest = Partial<CreateEpgSourceRequest>;

export interface EpgPreset {
  id: string;
  provider: 'iptv-org' | 'epg.pw';
  country: string;
  countryName: string;
  name: string;
  url: string;
}

/** A channel inside a guide source. */
export interface EpgGuideChannel {
  epgSourceId: string;
  epgSourceName: string;
  id: string;
  name: string;
  altNames: string[];
  callsign: string | null;
  number: string | null;
  iconUrl: string | null;
  programmes: number;
}

export interface ChannelMatch {
  channelId: string;
  channelName: string;
  channelNumber: number | null;
  logoUrl: string | null;
  sourceId: string;
  sourceName: string;
  status: GuideMatchStatus;
  /** Current (or, for `review`, suggested) guide channel. */
  epgSourceId: string | null;
  epgSourceName: string | null;
  epgChannelId: string | null;
  epgChannelName: string | null;
  /** 0–1. */
  confidence: number | null;
  /** id, number, callsign, name, fuzzy, manual. */
  method: string | null;
  offsetHours: number;
  hasGuide: boolean;
}

export interface MatchingResponse {
  items: ChannelMatch[];
  total: number;
  counts: { all: number; matched: number; review: number; unmatched: number; missingGuide: number };
  thresholds: { auto: number; suggest: number };
}

export interface SetChannelMatchRequest {
  /** Pick a guide channel; omit both (or send null) to clear the manual match and go back to automatic matching. */
  epgSourceId?: string | null;
  epgChannelId?: string | null;
  /** Explicitly "no guide" for this channel. */
  none?: boolean;
  /** Shift this channel's programmes (hours, -24..24). null clears it. */
  offsetHours?: number | null;
}

export interface SdHeadend {
  headend: string;
  transport: string;
  location: string;
  lineups: { name: string; lineup: string }[];
}
export interface SdLineup {
  lineup: string;
  name: string;
  transport: string;
  location: string;
  isDeleted?: boolean;
}
export interface SdStatus {
  accountExpires: string | null;
  maxLineups: number | null;
  lastDataUpdate: string | null;
  systemStatus: string | null;
  messages: string[];
  lineups: SdLineup[];
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

/** @deprecated Single Radarr/Sonarr config; replaced by `ServerSettings.arr` (still read as a fallback). */
export interface ArrService {
  url: string;
  apiKey: string;
  /** Quality profile id (see POST /arr/test). */
  qualityProfileId: number | null;
  /** Root folder path for new titles. */
  rootFolder: string | null;
  /** Ask the service to search for the title immediately after adding. */
  searchOnAdd: boolean;
}

export interface ArrOptions {
  ok: boolean;
  message: string;
  /** App name and version reported by the instance (e.g. "Radarr", "5.14.0"). */
  appName?: string | null;
  version?: string | null;
  qualityProfiles: { id: number; name: string }[];
  rootFolders: { path: string; freeSpace: number | null }[];
  tags?: { id: number; label: string }[];
  /** Lidarr/Readarr metadata profiles. */
  metadataProfiles?: { id: number; name: string }[];
  /** Sonarr v3 language profiles (absent on Sonarr v4). */
  languageProfiles?: { id: number; name: string }[];
}

/* ------------------------------------------------------------------ */
/* *arr suite: Radarr, Sonarr, Lidarr, Readarr, Bazarr                 */
/* ------------------------------------------------------------------ */

export type ArrKind = 'radarr' | 'sonarr' | 'lidarr' | 'readarr' | 'bazarr';

/** Rewrites a path as the *arr sees it (`remotePath`) into the path MediaMax sees (`localPath`). */
export interface ArrPathMapping {
  remotePath: string;
  localPath: string;
}

/** One Radarr/Sonarr/Lidarr/Readarr/Bazarr server. */
export interface ArrInstance {
  id: string;
  kind: ArrKind;
  name: string;
  /** Base URL, e.g. http://radarr:7878 (LAN addresses are fine). */
  url: string;
  /** Write-only: settings reads return "••••" when a key is set; saving "••••" keeps the stored key. */
  apiKey: string;
  enabled: boolean;
  /** A 4K instance: used for "Also request in 4K". */
  is4k?: boolean;
  qualityProfileId?: number | null;
  rootFolderPath?: string | null;
  /** Sonarr v3 only. */
  languageProfileId?: number | null;
  /** Lidarr/Readarr. */
  metadataProfileId?: number | null;
  /** Tag ids applied to titles added from requests. */
  tags?: number[];
  /** Sonarr: put episodes in season folders (default true). */
  seasonFolders?: boolean;
  /** What to monitor when adding: Sonarr `all|future|missing|existing|firstSeason|latestSeason|none`, Lidarr/Readarr `all|future|none`. */
  monitor?: string;
  /** Start searching as soon as a title is added (default true). */
  searchOnAdd?: boolean;
  /** Docker-style path translation for webhook events. */
  pathMappings?: ArrPathMapping[];
}

/** Body of POST /arr/test. Pass `id` with apiKey "••••" to test a saved instance with its stored key. */
export interface ArrTestRequest {
  id?: string;
  kind: ArrKind;
  url: string;
  apiKey: string;
}

export interface ArrInstanceRef {
  id: string;
  kind: ArrKind;
  name: string;
  is4k: boolean;
  /** Link to the instance's web UI. */
  url: string;
}

/** One instance's slice of a dashboard list. Instances fail independently (`ok: false` + `error`). */
export interface ArrSection<T> {
  instance: ArrInstanceRef;
  ok: boolean;
  error: string | null;
  items: T[];
}

/** External ids used to match *arr titles with requests and library items. */
export interface ArrMediaIds {
  tmdbId?: string | null;
  tvdbId?: string | null;
  foreignArtistId?: string | null;
  foreignAlbumId?: string | null;
  foreignBookId?: string | null;
}

export interface ArrQueueItem {
  id: number;
  title: string;
  /** e.g. "S02E05 · Episode title", album or book title. */
  subtitle: string | null;
  quality: string | null;
  /** 0–100 */
  progress: number;
  size: number;
  sizeLeft: number;
  /** "hh:mm:ss" as reported by the download client. */
  timeLeft: string | null;
  estimatedCompletion: string | null;
  status: string;
  trackedState: string | null;
  warnings: string[];
  protocol: string | null;
  downloadClient: string | null;
  ids: ArrMediaIds;
}

export interface ArrCalendarEntry {
  /** Movie/episode/album/book id inside the *arr. */
  id: number;
  title: string;
  subtitle: string | null;
  /** ISO date/time of the release or air date. */
  date: string;
  /** e.g. "Digital release", "Airs", "Album release". */
  releaseType: string;
  hasFile: boolean;
  monitored: boolean;
}

export interface ArrWantedEntry {
  /** Id to pass to POST /arr/:instanceId/search. */
  id: number;
  title: string;
  subtitle: string | null;
  date: string | null;
}

export interface ArrHealthCheck {
  source: string;
  type: 'ok' | 'notice' | 'warning' | 'error';
  message: string;
  wikiUrl: string | null;
}

export interface ArrDisk {
  path: string;
  label: string | null;
  freeSpace: number;
  totalSpace: number;
}

export interface ArrHealthSection {
  instance: ArrInstanceRef;
  ok: boolean;
  error: string | null;
  version: string | null;
  checks: ArrHealthCheck[];
  disks: ArrDisk[];
}

export interface ArrListResponse<T> {
  sections: ArrSection<T>[];
  fetchedAt: string;
}

export interface ArrHealthResponse {
  sections: ArrHealthSection[];
  fetchedAt: string;
}

/** POST /arr/:instanceId/search. Without `command`, the kind's default is used (MoviesSearch, EpisodeSearch, AlbumSearch, BookSearch). */
export interface ArrSearchRequest {
  ids: number[];
  command?: 'MoviesSearch' | 'EpisodeSearch' | 'SeriesSearch' | 'SeasonSearch' | 'AlbumSearch' | 'ArtistSearch' | 'BookSearch' | 'AuthorSearch';
  /** SeasonSearch only. */
  seasonNumber?: number;
}

/** GET /arr/webhook (admin): what to paste into each *arr's Settings → Connect → Webhook. */
export interface ArrWebhookInfo {
  /** Path relative to the server, e.g. /api/v1/arr/webhook/<token>. */
  path: string;
  /** Full URL built from the server's public URL (when set). */
  url: string | null;
  token: string;
}

/** A library title as found in the *arr instances (GET /arr/item/:itemId, admin). */
export interface ArrItemMatch {
  instance: ArrInstanceRef;
  /** Movie/series/artist id inside the *arr. */
  arrId: number;
  title: string;
  /** Deep link into the *arr web UI. */
  webUrl: string;
  /** Command for "Search for upgrade". */
  searchCommand: NonNullable<ArrSearchRequest['command']>;
  hasFile: boolean | null;
}

export interface ArrItemInfo {
  matches: ArrItemMatch[];
  /** A Bazarr instance is enabled and this item is a movie/show/episode. */
  bazarr: boolean;
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

/**
 * Hardware transcoding method. VA-API covers both Intel and AMD GPUs on Linux (AMD = Mesa radeonsi);
 * `amf` is AMD on Windows, `qsv` is Intel Quick Sync (Linux via VA-API, Windows via D3D11),
 * `nvenc` is NVIDIA on Linux and Windows, `rkmpp` is Rockchip (RK3588 etc., needs an ffmpeg-rockchip build).
 */
export type HwAccel = 'none' | 'vaapi' | 'nvenc' | 'qsv' | 'videotoolbox' | 'v4l2m2m' | 'amf' | 'rkmpp';
/** Video codecs the transcoder can output. HEVC and AV1 are only produced with a hardware encoder. */
export type TranscodeVideoCodec = 'h264' | 'hevc' | 'av1';
/** How HDR is tone-mapped to SDR: on the GPU (vaapi/qsv/cuda/opencl/libplacebo) or on the CPU (`software` = zscale+tonemap). */
export type ToneMapPath = 'software' | 'libplacebo' | 'vaapi' | 'opencl' | 'qsv' | 'cuda';

export interface HwDevice {
  kind: 'dri' | 'nvidia' | 'v4l2' | 'rockchip' | 'apple' | 'windows-gpu';
  /** /dev/dri/renderD128, /dev/video11 … (null for Windows/macOS adapters). */
  path: string | null;
  name: string;
  /** Kernel driver (i915, xe, amdgpu, nvidia …) or VA-API driver from vainfo. */
  driver: string | null;
  vendor: 'intel' | 'amd' | 'nvidia' | 'apple' | 'broadcom' | 'rockchip' | 'unknown';
  /** GPU / adapter index (NVIDIA, Windows). */
  index: number | null;
}

export interface HwTestResult {
  works: boolean;
  /** Last lines of ffmpeg's error output when it failed, or why the test was skipped. */
  error: string | null;
  /** Frames per second the test ran at. */
  fps: number | null;
  /** True when the test was not run (missing encoder/filter/sample). */
  skipped?: boolean;
}

export interface HwMethodResult {
  /** Stable key for the UI, e.g. "vaapi:/dev/dri/renderD128". */
  id: string;
  hwAccel: HwAccel;
  label: string;
  /** Render node for VA-API/QSV on Linux. */
  device: string | null;
  /** GPU/adapter index for NVENC, and QSV/AMF on Windows. */
  gpuIndex: number | null;
  deviceName: string | null;
  /** The device/driver/encoder this method needs is present (a test was run). */
  available: boolean;
  /** H.264 hardware encoding works. */
  works: boolean;
  /** Why it is not available or does not work. */
  error: string | null;
  /** Encode tests per output codec (testsrc2 → scale → encode). */
  encode: Record<TranscodeVideoCodec, HwTestResult & { encoder: string | null }>;
  /** Hardware decode → scale → encode of an H.264 sample. */
  decode: HwTestResult | null;
  /** Hardware decode of a 10-bit HEVC sample. */
  tenBit: HwTestResult | null;
  /** The first tone-mapping path that works for this method, and everything tried. */
  toneMapping: { path: ToneMapPath | null; tried: (HwTestResult & { path: ToneMapPath })[] };
  /** H.264 encode speed (fps) — same as encode.h264.fps. */
  fps: number | null;
  recommended: boolean;
  notes: string[];
}

export interface HwDetectReport {
  ranAt: string;
  durationMs: number;
  platform: string;
  arch: string;
  ffmpeg: { path: string; version: string | null; hwaccels: string[]; encoders: string[]; filters: string[] };
  devices: HwDevice[];
  methods: HwMethodResult[];
  recommendation: { id: string; hwAccel: HwAccel; device: string | null; gpuIndex: number | null; reason: string };
}

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
    /** GPU / adapter index for NVENC, and for QSV/AMF on Windows (0 = first). */
    gpuIndex: number;
    /** Output codecs in order of preference; H.264 is always the final fallback. */
    preferredCodecs: TranscodeVideoCodec[];
    /** Encode HEVC (with a hardware encoder) for clients that can play it. */
    allowHevcEncoding: boolean;
    /** Encode AV1 (with a hardware encoder) for clients that can play it. */
    allowAv1Encoding: boolean;
    /** Tone-map HDR on the GPU when possible (else the CPU zscale+tonemap path). */
    hardwareToneMapping: boolean;
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
    /** @deprecated Per-user `requestPermissions` replace this (still read for users without stored permissions). */
    autoApproveUserIds: string[];
    /** @deprecated Seeds `defaultQuotas` when those were never saved. Max requests per user per 7 days (0 = unlimited). */
    weeklyLimit: number;
    /** @deprecated Moved to `ServerSettings.arr` (migrated once; still read as a fallback). */
    radarr: ArrService | null;
    /** @deprecated Moved to `ServerSettings.arr` (migrated once; still read as a fallback). */
    sonarr: ArrService | null;
  } & Partial<RequestSettingsExtra>;
  /** Radarr/Sonarr/Lidarr/Readarr/Bazarr instances (requests, downloads dashboard, webhooks). */
  arr: ArrInstance[];
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
  | 'request.available'
  | 'request.approved'
  | 'request.declined'
  | 'request.failed'
  | 'issue.created'
  | 'issue.resolved';

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
  | { type: 'remote.targets'; targets: RemoteTarget[] }
  /** A new in-app notification for you (e.g. a new episode of a show you watch). `unread` is your new unread total. */
  | { type: 'notification'; notification: AppNotification; unread: number };

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
  /** `lrclib`: fetched from LRCLIB (no local .lrc or embedded lyrics). */
  source: 'lrc' | 'embedded' | 'txt' | 'lrclib';
  lines: LyricLine[];
}

/* ------------------------------------------------------------------ */
/* Built-in metadata providers                                          */
/* ------------------------------------------------------------------ */

export type MetadataProviderId = 'tmdb' | 'tvdb' | 'fanart' | 'audiodb' | 'audnexus' | 'openlibrary' | 'googlebooks' | 'lrclib' | 'omdb' | 'musicbrainz';
/** Providers configured under Server settings → Metadata (TMDB keeps its key on the General tab). */
export type BuiltinProviderId = Exclude<MetadataProviderId, 'tmdb'>;
/** Episode ordering used to match a show's episodes (TheTVDB season types). */
export type EpisodeOrder = 'aired' | 'dvd' | 'absolute';
/** Third-party ratings: imdb and tmdb are 0–10, rottenTomatoes and metacritic 0–100. */
export interface ItemRatings {
  imdb?: number;
  rottenTomatoes?: number;
  metacritic?: number;
  tmdb?: number;
}
export interface MetadataProviderConfig {
  enabled: boolean;
  /** Write-only: reads return "••••" when a key is stored; sending "••••" back keeps it. */
  apiKey: string | null;
  /** TheTVDB subscriber PIN (optional, write-only like apiKey). */
  pin?: string | null;
}
export type ArtworkTarget = 'movie' | 'show' | 'artist' | 'album' | 'audiobook';
export interface MetadataSettings {
  providers: Record<BuiltinProviderId, MetadataProviderConfig>;
  /** Priority, highest first. Providers only fill empty, unlocked fields, so earlier ones win. */
  order: MetadataProviderId[];
  /** Preferred artwork source per type. `auto`: local art first, providers only fill gaps. */
  artwork: Record<ArtworkTarget, MetadataProviderId | 'auto'>;
  /** How long provider responses are cached (hours). */
  cacheTtlHours: number;
}
export interface MetadataProviderInfo {
  id: MetadataProviderId;
  name: string;
  types: ItemType[];
  key: 'required' | 'optional' | 'none';
  /** Supports a subscriber PIN (TheTVDB). */
  pin?: boolean;
  homepage: string;
  keyUrl: string | null;
  cost: string;
  description: string;
  rateLimit: string;
  /** Artwork targets this provider can supply art for. */
  artwork: ArtworkTarget[];
  enabled: boolean;
  /** Enabled and has the key it needs. */
  ready: boolean;
  /** Items this provider could still fill (null when not counted). */
  missing: number | null;
  missingLabel: string | null;
}
export interface MetadataSettingsResponse {
  settings: MetadataSettings;
  providers: MetadataProviderInfo[];
  cache: { entries: number; bytes: number };
}
export interface MetadataTestResult {
  ok: boolean;
  message: string;
  ms: number;
}
/** A "Fix match" search hit. */
export interface MatchCandidate {
  provider: MetadataProviderId;
  id: string;
  title: string;
  year: number | null;
  subtitle: string | null;
  overview: string | null;
  imageUrl: string | null;
}
export interface MatchSearchResponse {
  /** Providers that can be searched for this item type. */
  providers: MetadataProviderId[];
  provider: MetadataProviderId;
  results: MatchCandidate[];
}
export interface ApplyMatchRequest {
  provider: MetadataProviderId;
  id: string;
}

/* ------------------------------------------------------------------ */
/* Media requests (Overseerr-style, with Radarr/Sonarr)                */
/* ------------------------------------------------------------------ */

/** movie → Radarr, show → Sonarr, artist/album → Lidarr, book → Readarr. */
export type RequestMediaType = 'movie' | 'show' | 'artist' | 'album' | 'book';
/** Which seasons of a show to request. */
export type SeasonMode = 'all' | 'first' | 'latest' | 'specific';
export type RequestStatus = 'pending' | 'approved' | 'declined' | 'processing' | 'available' | 'failed';

export interface DiscoverResult {
  /** TMDB id for movies/shows; for music and books the same value as `externalId`. */
  tmdbId: string;
  /** TMDB id, MusicBrainz artist/album id (Lidarr) or Readarr foreign book id. */
  externalId: string;
  mediaType: RequestMediaType;
  title: string;
  /** Artist of an album, author of a book. */
  subtitle?: string | null;
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
  /** TMDB id (movies/shows) or the external id for music/books (same as `externalId`). */
  tmdbId: string;
  externalId: string;
  mediaType: RequestMediaType;
  title: string;
  /** Artist of an album, author of a book. */
  subtitle: string | null;
  year: number | null;
  posterUrl: string | null;
  /** Requested seasons for shows (empty = all). */
  seasons: number[];
  seasonMode: SeasonMode;
  /** Artist requests: monitor all albums or only future ones. */
  monitor: 'all' | 'future' | null;
  /** Also sent to the 4K instance. */
  also4k: boolean;
  /** Live download progress while it's in an *arr queue. */
  download: { progress: number; status: string; timeLeft: string | null; instance: string } | null;
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
  /** TMDB id for movies/shows. For music/books send `externalId` (either field is accepted). */
  tmdbId?: string;
  externalId?: string;
  mediaType: RequestMediaType;
  /** Title as shown in Discover; helps the Lidarr/Readarr lookup. */
  title?: string;
  /** Specific seasons (with seasonMode "specific", or alone for backwards compatibility). */
  seasons?: number[];
  seasonMode?: SeasonMode;
  /** Artist requests (default "all"). */
  monitor?: 'all' | 'future';
  /** Also request in 4K (admins, or users with allowRequest4k; needs a 4K instance). */
  also4k?: boolean;
  note?: string;
}

/** GET /requests/options: which request kinds this server can handle. */
export interface RequestOptions {
  movies: boolean;
  shows: boolean;
  music: boolean;
  books: boolean;
  /** Kinds with a 4K instance the current user may use. */
  can4k: { movie: boolean; show: boolean };
  tmdb: boolean;
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

/* ------------------------------------------------------------------ */
/* Discovery: watchlist, calendar, notifications                       */
/* ------------------------------------------------------------------ */

/**
 * One calendar line. `upcoming`: a future episode from TMDB (`episode` is null, the file isn't here yet).
 * `added`: an episode recently added to a library (`episode` is the real item).
 */
export interface CalendarEntry {
  kind: 'upcoming' | 'added';
  /** YYYY-MM-DD air date (upcoming) or the date it was added (added). */
  date: string;
  show: Item;
  episode: Item | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  title: string | null;
  overview: string | null;
  /** The viewer watches this show (has played an episode) or has it on My List. */
  following: boolean;
}

/** TMDB status for a show ("Returning Series", "Ended", "Canceled", "In Production"…). */
export interface ShowSchedule {
  status: string | null;
  inProduction: boolean | null;
  lastAirDate: string | null;
  nextAirDate: string | null;
}

export interface CalendarResponse {
  from: string;
  to: string;
  /** false when no TMDB API key is configured: upcoming episodes are unavailable (recently added still work). */
  tmdbConfigured: boolean;
  entries: CalendarEntry[];
}

export type NotificationKind = 'new-episode' | 'request' | 'issue';

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  itemId: string | null;
  title: string;
  body: string | null;
  /** Artwork for the item (poster or episode thumbnail). */
  imageUrl: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationsResponse {
  items: AppNotification[];
  unread: number;
}

/* ------------------------------------------------------------------ */
/* Admin → Security: reverse proxy, CrowdSec, fail2ban, sign-in log    */
/* ------------------------------------------------------------------ */

export interface SecurityDashboardSettings {
  proxy: { kind: 'none' | 'caddy' | 'nginx'; accessLog: string | null };
  /** Public host name to check the HTTPS certificate of. */
  publicHost: string | null;
  crowdsec: { url: string | null; machineId: string | null; password: string | null };
  /** fail2ban control socket, normally the MediaMax bridge's socket. */
  fail2banSocket: string | null;
}

export interface SecurityCount { key: string; count: number; extra?: string | null }

export interface SecurityOverview {
  generatedAt: string;
  signIns: {
    failures24h: number;
    failures7d: number;
    lockouts24h: number;
    successes24h: number;
    byReason: SecurityCount[];
    topIps: SecurityCount[];
    topUsers: SecurityCount[];
    /** Failures per hour for the last 24 hours (oldest first). */
    hourly: number[];
    recent: { at: string; event: string; ip: string; user: string | null; reason: string | null }[];
  };
  proxy: null | {
    kind: 'caddy' | 'nginx';
    ok: boolean;
    error: string | null;
    lastRequestAt: string | null;
    requests24h: number;
    uniqueIps24h: number;
    bytes24h: number;
    status: { s2xx: number; s3xx: number; s4xx: number; s5xx: number };
    hourly: number[];
    topIps: SecurityCount[];
    topErrors: SecurityCount[];
  };
  certificate: null | { host: string; ok: boolean; error: string | null; validTo: string | null; daysLeft: number | null; issuer: string | null };
  crowdsec: null | {
    ok: boolean;
    error: string | null;
    decisions: { id: number; ip: string; type: string; origin: string; scenario: string; duration: string; country: string | null; asName: string | null }[];
    alerts: { id: number; scenario: string; at: string; ip: string | null; country: string | null; events: number }[];
  };
  fail2ban: null | {
    ok: boolean;
    error: string | null;
    jails: { name: string; currentlyFailed: number; totalFailed: number; currentlyBanned: number; totalBanned: number; bannedIps: string[] }[];
  };
}

export interface SecurityBanRequest {
  ip: string;
  /** Where to ban; unban without a tool removes the IP everywhere. */
  tool?: 'crowdsec' | 'fail2ban';
  jail?: string;
  /** CrowdSec duration, e.g. "4h", "7d". */
  duration?: string;
  reason?: string;
}

/* ------------------------------------------------------------------ */
/* Admin → Network: direct, behind your reverse proxy, or built-in HTTPS */
/* ------------------------------------------------------------------ */

export interface NetworkSettings {
  /**
   * direct  = clients connect straight to MediaMax (LAN, VPN, or port forward to 8484);
   * proxy   = behind your own reverse proxy (Nginx, Traefik, Caddy, NPM, Cloudflare Tunnel…);
   * builtin = MediaMax runs Caddy itself for automatic HTTPS (Let's Encrypt). Off unless chosen here.
   */
  mode: 'direct' | 'proxy' | 'builtin';
  /** Addresses/CIDRs whose X-Forwarded-For/-Proto headers are believed. Keywords: loopback, linklocal, uniquelocal. */
  trustedProxies: string[];
  builtinHttps: {
    domain: string | null;
    email: string | null;
    /** Ports Caddy listens on (inside the container when running in Docker). */
    httpPort: number;
    httpsPort: number;
    /** Use Let's Encrypt's staging CA while testing (untrusted certificates, generous rate limits). */
    staging: boolean;
    hsts: boolean;
  };
}

export interface NetworkStatus {
  settings: NetworkSettings;
  /** MEDIAMAX_TRUSTED_PROXIES from the environment overrides the saved list when set. */
  envTrustedProxies: string[] | null;
  /** How this very request reached MediaMax, to verify a proxy setup. */
  you: { ip: string; socketAddress: string; forwardedFor: string | null; forwardedProto: string | null; proxyTrusted: boolean; protocol: string; host: string };
  publicUrl: string | null;
  builtin: {
    /** A Caddy binary was found (bundled in Docker and release builds, or on PATH / MEDIAMAX_CADDY). */
    available: boolean;
    binary: string | null;
    version: string | null;
    running: boolean;
    error: string | null;
    /** Recent Caddy log messages (newest last). */
    log: string[];
    certificate: { ok: boolean; error: string | null; validTo: string | null; daysLeft: number | null; issuer: string | null } | null;
  };
}

/* ------------------------------------------------------------------ */
/* HDR / Dolby Vision & client video-range capabilities               */
/* (interfaces below extend DeviceProfile, MediaSource, PlaybackInfo   */
/*  through declaration merging, so this block stays append-only)      */
/* ------------------------------------------------------------------ */

/** Dynamic range of a video stream. `hdr10plus` and `dolbyvision` usually carry an HDR10 (or HLG/SDR) fallback. */
export type HdrFormat = 'sdr' | 'hdr10' | 'hdr10plus' | 'hlg' | 'dolbyvision';

/** Dolby Vision configuration record (from ffprobe's "DOVI configuration record" side data). */
export interface DolbyVisionInfo {
  /** 4, 5, 7, 8, 9, 10 … */
  profile: number;
  level: number | null;
  /**
   * Base-layer signal compatibility id: 0 = none (profile 5, IPTPQc2 — not watchable without DV),
   * 1 = HDR10, 2 = SDR, 4 = HLG, 6 = Blu-ray HDR10 (profile 7). Profile 8.1/8.2/8.4 = compat 1/2/4.
   */
  blCompatId: number | null;
  rpu: boolean;
  /** Enhancement layer present (profile 7 dual-layer: MEL/FEL). */
  el: boolean;
  bl: boolean;
}

export interface VideoRangeInfo {
  hdrFormat: HdrFormat;
  /** What a non-DV / non-HDR10+ player sees: the HDR10/HLG/SDR base layer, or `none` (DV profile 5). */
  fallback: 'hdr10' | 'hlg' | 'sdr' | 'none' | null;
  /** Label for UIs, e.g. "Dolby Vision 8.1", "HDR10+", "HLG". */
  label: string;
  bitDepth: number | null;
  pixFmt: string | null;
  /** Codec profile as ffprobe reports it, e.g. "Main 10". */
  codecProfile: string | null;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  colorSpace: string | null;
  frameRate: number | null;
  dolbyVision: DolbyVisionInfo | null;
  /** SMPTE ST 2086 mastering display: luminance in cd/m². */
  masteringDisplay: { minLuminance: number | null; maxLuminance: number | null } | null;
  /** MaxCLL / MaxFALL in cd/m². */
  contentLight: { maxCll: number; maxFall: number } | null;
}

/** What the client can decode *and* display correctly (it may tone-map itself — that counts as supported). */
export interface VideoRangeCapabilities {
  hdr10?: boolean;
  hdr10Plus?: boolean;
  hlg?: boolean;
  dolbyVision?: boolean;
  /** Dolby Vision profiles the client plays, e.g. ["5", "8.1", "8.4"]; "7" only for dual-layer capable players. */
  dolbyVisionProfiles?: string[];
  /** The attached display itself is HDR (informational; `hdr10` etc. are what decisions use). */
  hdrDisplay?: boolean;
}

export interface DeviceProfile {
  /** HDR support. Omitted = legacy client: MediaMax keeps its old behaviour (no range-based decisions). */
  videoRange?: VideoRangeCapabilities;
  maxHeight?: number | null;
  /** Video codecs the client decodes at 10-bit, e.g. ["hevc","av1","vp9"]. */
  tenBitCodecs?: string[];
  /** Audio formats passed through to an AV receiver (bitstream), e.g. ["ac3","eac3","eac3-joc","truehd","dts","dts-hd"]. */
  audioPassthrough?: string[];
  /** The player switches embedded audio tracks itself (Tizen AVPlay, ExoPlayer, AVPlayer), so a non-default track doesn't force a remux. */
  canSelectAudioTrack?: boolean;
  /** Which player backend sent this profile: "html5", "avplay", "webos", "exoplayer", "avplayer". */
  player?: string;
}

export interface MediaSource {
  /** HDR format details (null for SDR or media scanned before HDR detection). */
  videoRange?: VideoRangeInfo | null;
}

/** How the server delivers the video's dynamic range to this client. */
export type VideoRangeDelivery = 'sdr' | 'passthrough' | 'base-layer' | 'strip-dovi' | 'tonemap';

export interface PlaybackInfo {
  /** Why the server remuxes or transcodes (empty for direct play). */
  reasons?: string[];
  /** Source range and how it reaches the client (`base-layer`: DV/HDR10+ played as HDR10; `tonemap`: HDR → SDR). */
  videoRange?: { source: HdrFormat; label: string; delivery: VideoRangeDelivery } | null;
}

/* ------------------------------------------------------------------ */
/* Requests: Overseerr/Jellyseerr parity (permissions, quotas, issues)  */
/* ------------------------------------------------------------------ */

/** none = can't request; request = needs approval; auto = approved automatically. */
export type RequestPermissionLevel = 'none' | 'request' | 'auto';
/** The request kinds a permission can be set for. */
export type RequestPermissionKind = 'movie' | 'show' | 'movie4k' | 'show4k' | 'music' | 'book';

export interface RequestPermissions {
  movie: RequestPermissionLevel;
  show: RequestPermissionLevel;
  movie4k: RequestPermissionLevel;
  show4k: RequestPermissionLevel;
  /** Artists and albums (Lidarr). */
  music: RequestPermissionLevel;
  /** Books (Readarr). */
  book: RequestPermissionLevel;
  /** Request manager: may see, edit, approve, decline and delete everyone's requests, manage issues and the blacklist. */
  manageRequests: boolean;
  /** May report problems ("issues") with library items. */
  reportIssues: boolean;
  /** Titles this user adds to their Discover watchlist are requested automatically (permissions and quotas still apply). */
  watchlistAutoRequest: boolean;
}

/** `limit` requests (seasons for shows) per rolling `days`; limit 0 = unlimited. */
export interface RequestQuota {
  limit: number;
  days: number;
}
export interface RequestQuotas {
  movie: RequestQuota;
  /** Counts seasons, like Overseerr. */
  show: RequestQuota;
  /** Artists and albums. */
  music: RequestQuota;
  book: RequestQuota;
}
export type RequestQuotaKind = keyof RequestQuotas;

/** Remaining quota for one kind (GET /requests/options, GET /requests/quota). */
export interface RequestQuotaStatus {
  limit: number;
  days: number;
  used: number;
  /** null = unlimited. */
  remaining: number | null;
  /** When the oldest counted request leaves the window (null when nothing is counted). */
  resetsAt: string | null;
  /** Exempt (admin, or exempt by the server's quota settings). */
  exempt: boolean;
}

export interface User {
  /** Stored request permissions (admins act as if everything were "auto"). Older servers derive them from allowRequest4k + autoApproveUserIds. */
  requestPermissions?: RequestPermissions;
  /** Per-user quota override; null = the server defaults. */
  requestQuotas?: RequestQuotas | null;
}
export interface CreateUserRequest {
  requestPermissions?: Partial<RequestPermissions>;
  requestQuotas?: RequestQuotas | null;
}
export interface InviteTemplate {
  /** Request permissions for users joining with this invite (default: the server's default permissions). */
  requestPermissions?: RequestPermissions | null;
}

/** PATCH /users/bulk (admin): apply the same permissions/quotas to several users. */
export interface BulkUpdateUsersRequest {
  userIds: string[];
  requestPermissions?: Partial<RequestPermissions>;
  /** null resets to the server defaults; omit to leave unchanged. */
  requestQuotas?: RequestQuotas | null;
  allowLiveTv?: boolean;
  allowDownloads?: boolean;
  allowTranscode?: boolean;
  allowDvr?: boolean;
  allowRemote?: boolean;
}

export interface ServerSettings {
  notificationAgents: NotificationAgent[];
}
export interface RequestSettingsExtra {
  /** Permissions given to new users (created by an admin, invite or SSO). */
  defaultPermissions: RequestPermissions;
  /** Quotas for users without their own. Migrated from `weeklyLimit` when absent. */
  defaultQuotas: RequestQuotas;
  /** Users with "auto" for a kind aren't counted against that kind's quota. */
  quotaExemptAutoApprove: boolean;
  /** Request managers have no quota. */
  quotaExemptManagers: boolean;
  /** Global auto-approve rule: approve movie/show requests rated at least this on TMDB (0 = off). */
  autoApproveMinRating: number;
  /** Discover hides titles that are already in a library (per-user toggle overrides). */
  hideAvailable: boolean;
}

/** Overrides a manager can set before approving ("edit before approve"). Missing = the instance defaults. */
export interface RequestArrOverrides {
  instanceId?: string | null;
  /** 4K copy target (also4k requests). */
  instance4kId?: string | null;
  qualityProfileId?: number | null;
  rootFolderPath?: string | null;
  languageProfileId?: number | null;
  tags?: number[] | null;
}

export interface MediaRequest {
  /** Overrides set by a manager (managers only). */
  arr?: RequestArrOverrides | null;
  /** Units counted against the quota (seasons for shows). */
  quotaUnits?: number;
  /** Number of comments on the request. */
  commentCount?: number;
  /** The requester's own reason/notes vs. the manager's decline reason. */
  declineReason?: string | null;
}

/** PATCH /requests/:id (managers): change a request before approving it. */
export interface EditMediaRequest {
  seasons?: number[];
  seasonMode?: SeasonMode;
  also4k?: boolean;
  arr?: RequestArrOverrides;
}

/** POST /requests/:id/approve body (optional): edits applied first. */
export type ApproveMediaRequest = EditMediaRequest;

/** POST /requests/bulk (managers). */
export interface BulkRequestAction {
  ids: string[];
  action: 'approve' | 'decline' | 'delete' | 'retry';
  /** Decline reason. */
  note?: string;
  /** delete: also remove the titles from Radarr/Sonarr. */
  removeFromArr?: boolean;
}
export interface BulkRequestResult {
  ok: string[];
  failed: { id: string; error: string }[];
}

export interface RequestListQuery {
  status?: RequestStatus;
  mine?: boolean;
  mediaType?: RequestMediaType;
  userId?: string;
  sort?: 'requested' | 'updated' | 'title' | 'status';
  order?: 'asc' | 'desc';
}

/** One entry of a request's timeline (status changes and comments). */
export interface RequestActivity {
  id: string;
  kind: 'created' | 'approved' | 'declined' | 'processing' | 'failed' | 'available' | 'edited' | 'comment' | 'retried';
  user: { id: string; displayName: string } | null;
  body: string | null;
  createdAt: string;
}

/** GET /requests/tv/:tmdbId: seasons of a show with availability. */
export type SeasonAvailability = 'available' | 'partial' | 'requested' | 'pending' | 'missing';
export interface RequestSeasonInfo {
  seasonNumber: number;
  name: string;
  episodeCount: number;
  airDate: string | null;
  /** Episodes of this season in the library. */
  libraryEpisodes: number;
  status: SeasonAvailability;
}
export interface RequestTvInfo {
  tmdbId: string;
  title: string;
  seasons: RequestSeasonInfo[];
  /** Library show, if any. */
  itemId: string | null;
}

/** GET /requests/:id/arr-options (managers): pickers for "edit before approve". */
export interface RequestArrChoices {
  kind: ArrKind;
  instances: { id: string; name: string; is4k: boolean; defaults: RequestArrOverrides; options: ArrOptions }[];
}

export interface RequestOptions {
  /** The viewer's effective permissions. */
  permissions?: RequestPermissions;
  /** Remaining quota per kind. */
  quotas?: Record<RequestQuotaKind, RequestQuotaStatus>;
  /** May manage requests (admin or request manager). */
  canManage?: boolean;
  /** Server default for hiding titles already in the library. */
  hideAvailable?: boolean;
}

export interface DiscoverResult {
  /** On the admin blacklist (only managers see these; others never get them). */
  blacklisted?: boolean;
  /** On the viewer's Discover watchlist. */
  onWatchlist?: boolean;
  /** Shows: some seasons are in the library, others can still be requested. */
  partiallyAvailable?: boolean;
}

/** Admin blacklist: titles nobody can request. */
export interface BlacklistEntry {
  mediaType: RequestMediaType;
  externalId: string;
  title: string;
  reason: string | null;
  createdBy: { id: string; displayName: string } | null;
  createdAt: string;
}

/** Discover sliders (TMDB lists). */
export type DiscoverListKey =
  | 'trending' | 'popular-movies' | 'popular-shows' | 'upcoming-movies' | 'upcoming-shows' | 'top-movies' | 'top-shows'
  | `movie-genre-${number}` | `show-genre-${number}` | `studio-${number}` | `network-${number}`;
export interface DiscoverSlider {
  key: DiscoverListKey | 'recently-requested' | 'recently-added' | 'watchlist';
  title: string;
  results: DiscoverResult[];
}
export interface DiscoverGenre {
  id: number;
  name: string;
}
export interface DiscoverGenres {
  movie: DiscoverGenre[];
  show: DiscoverGenre[];
}
export interface DiscoverPerson {
  id: string;
  name: string;
  biography: string | null;
  birthday: string | null;
  deathday: string | null;
  placeOfBirth: string | null;
  knownFor: string | null;
  profileUrl: string | null;
  cast: (DiscoverResult & { character: string | null })[];
  crew: (DiscoverResult & { job: string | null })[];
}

/** Discover watchlist: titles (not necessarily in a library) a user wants. */
export interface DiscoverWatchlistEntry {
  mediaType: 'movie' | 'show';
  externalId: string;
  title: string;
  year: number | null;
  posterUrl: string | null;
  addedAt: string;
  requestId: string | null;
  /** Why auto-request didn't happen (no permission, quota, blacklist…). */
  autoRequestError: string | null;
  availableItemId: string | null;
}

/* Issues ("Report an issue") */
export type IssueKind = 'video' | 'audio' | 'subtitle' | 'other';
export type IssueStatus = 'open' | 'resolved';
export interface IssueComment {
  id: string;
  user: { id: string; displayName: string } | null;
  body: string;
  createdAt: string;
}
export interface Issue {
  id: string;
  kind: IssueKind;
  status: IssueStatus;
  /** The reported library item (movie, show, episode, album…). */
  itemId: string | null;
  /** Movie/show the item belongs to, for *arr actions. */
  rootItemId: string | null;
  mediaType: string;
  title: string;
  posterUrl: string | null;
  season: number | null;
  episode: number | null;
  message: string;
  createdBy: { id: string; displayName: string } | null;
  createdAt: string;
  updatedAt: string;
  resolvedBy: { id: string; displayName: string } | null;
  resolvedAt: string | null;
  commentCount: number;
  comments?: IssueComment[];
}
export interface CreateIssueRequest {
  itemId: string;
  kind: IssueKind;
  message: string;
  season?: number | null;
  episode?: number | null;
}

/* Notification agents (Discord, Slack, Telegram, ntfy, Gotify, Pushover, email, JSON webhook) */
export type NotifyEvent =
  | 'request.pending' | 'request.auto_approved' | 'request.approved' | 'request.declined' | 'request.available' | 'request.failed' | 'request.comment'
  | 'issue.created' | 'issue.comment' | 'issue.resolved' | 'issue.reopened' | 'test';
export type NotificationAgentKind = 'discord' | 'slack' | 'telegram' | 'ntfy' | 'gotify' | 'pushover' | 'email' | 'webhook';
export interface NotificationAgent {
  id: string;
  kind: NotificationAgentKind;
  name: string;
  enabled: boolean;
  events: NotifyEvent[];
  /** Kind-specific settings (webhookUrl, botToken, chatId, server, topic, token, userKey, smtp…). Secret fields read back as "••••". */
  config: Record<string, string>;
}
/** The fields each agent kind takes (GET /notify/agents/kinds). */
export interface NotificationAgentKindInfo {
  kind: NotificationAgentKind;
  label: string;
  fields: { key: string; label: string; secret?: boolean; required?: boolean; placeholder?: string; hint?: string }[];
}
export interface NotificationTestResult {
  ok: boolean;
  message: string;
}
export interface AppNotification {
  /** In-app path to open (e.g. "/requests?id=…", "/issues/…") for request and issue notifications. */
  link?: string | null;
}

/* ------------------------------------------------------------------ */
/* Home Assistant / smart home                                         */
/* ------------------------------------------------------------------ */

/** Payload shape a webhook sends: MediaMax's own (default) or a flat one made for Home Assistant's webhook trigger. */
export type WebhookFormat = 'mediamax' | 'home-assistant';

export interface Webhook {
  /** Omitted = 'mediamax'. */
  format?: WebhookFormat;
  /** Optional label shown in the admin list (e.g. "Home Assistant"). */
  name?: string;
}

export interface HomeAssistantMqttSettings {
  enabled: boolean;
  /** mqtt://host:1883 or mqtts://host:8883. */
  brokerUrl: string;
  username: string | null;
  /** Write-only: returned as "••••" when set. Send "••••" back to keep it. */
  password: string | null;
  /** Use TLS even with an mqtt:// URL (mqtts:// always does). */
  tls: boolean;
  /** Accept self-signed broker certificates. */
  tlsInsecure: boolean;
  /** Root of MediaMax's own topics (default "mediamax"). */
  baseTopic: string;
  /** Home Assistant discovery prefix (default "homeassistant"). */
  discoveryPrefix: string;
  /** Publish one now-playing sensor per playing device (default true). */
  perDeviceSensors: boolean;
}

export interface HomeAssistantSettings {
  mqtt: HomeAssistantMqttSettings;
}

export type MqttConnectionState = 'disabled' | 'connecting' | 'connected' | 'disconnected' | 'error';

export interface HomeAssistantStatus {
  mqtt: {
    state: MqttConnectionState;
    error: string | null;
    connectedAt: string | null;
    lastPublishAt: string | null;
    lastDiscoveryAt: string | null;
    /** Discovery configs published (entities Home Assistant should show). */
    entities: number;
    /** Topic that reports online/offline (retained, offline is the last will). */
    availabilityTopic: string | null;
  };
  /** Where to find the REST endpoint for HA's REST sensor / dashboards. */
  restPath: string;
}

export interface HomeAssistantTestResult {
  ok: boolean;
  message: string;
  latencyMs: number | null;
}

/** One playing (or paused) stream as reported to smart-home integrations. */
export interface NowPlayingEntry {
  sessionId: string;
  state: 'playing' | 'paused' | 'buffering';
  userId: string;
  user: string;
  deviceId: string;
  device: string;
  platform: string;
  itemId: string | null;
  mediaType: string | null;
  title: string;
  /** Show title for episodes, artist for tracks. */
  series: string | null;
  season: number | null;
  episode: number | null;
  year: number | null;
  /** Absolute when the server has a public URL, else server-relative. */
  posterUrl: string | null;
  positionSeconds: number;
  durationSeconds: number | null;
  progressPercent: number | null;
  transcode: boolean;
  method: string;
  hdr: boolean;
  bitrateKbps: number | null;
  startedAt: string;
}

export interface NowPlayingStatus {
  server: { id: string; name: string; version: string };
  /** True while at least one stream is playing (paused streams don't count). */
  watching: boolean;
  activeStreams: number;
  transcodes: number;
  directStreams: number;
  bandwidthKbps: number;
  sessions: NowPlayingEntry[];
  recentlyAdded: { id: string; type: string; title: string; series: string | null; year: number | null; addedAt: string; posterUrl: string | null }[];
  generatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Storage / NAS disk spin-down                                        */
/* ------------------------------------------------------------------ */

export type DiskPowerState = 'active' | 'idle' | 'standby' | 'unknown';

export interface StorageSettings {
  /** Only run background media-disk work inside the maintenance window (or piggybacked on playback). */
  diskFriendly: boolean;
  /** Local server time, "HH:MM". */
  windowStart: string;
  windowEnd: string;
  /** When a stream starts from a disk, run that disk's postponed jobs while it is spinning anyway. */
  piggyback: boolean;
  /** Linux: ask hdparm/smartctl (when available and permitted) whether disks are asleep; never wakes them. */
  checkDiskState: boolean;
  /** native = inotify/FSEvents (no polling); poll = check folder timestamps every pollIntervalMinutes; off = scheduled scans only. */
  watchMode: 'native' | 'poll' | 'off';
  /** Poll mode interval (minimum 60). */
  pollIntervalMinutes: number;
}

export interface StorageDiskInfo {
  /** Block device name, e.g. "sda" (null when unknown). */
  name: string;
  state: DiskPowerState;
  /** How the state was found: "hdparm", "smartctl", "sysfs" (I/O counters) or null. */
  method: string | null;
  rotational: boolean | null;
  checkedAt: string | null;
}

export interface StorageLibraryPath {
  path: string;
  mountPoint: string | null;
  fsType: string | null;
  source: string | null;
  /** Network share (NFS/SMB): disk state can't be seen from here. */
  network: boolean;
  /** Key used to group work per disk (mount device id). */
  diskKey: string;
  disks: StorageDiskInfo[];
  /** Overall state for the path (standby only if every disk under it sleeps). */
  state: DiskPowerState;
}

export interface StorageLibraryInfo {
  id: string;
  name: string;
  type: string;
  paths: StorageLibraryPath[];
  watch: { mode: 'native' | 'poll' | 'off'; directories: number; error: string | null };
}

export interface StorageDeferredTask {
  taskId: string;
  name: string;
  since: string;
  /** Disks that already caught up through piggybacking. */
  doneDisks: string[];
}

export interface StorageStatus {
  settings: StorageSettings;
  inWindow: boolean;
  nextWindowAt: string | null;
  /** Server-local time zone, so the window can be read correctly. */
  timeZone: string;
  serverTime: string;
  deferred: StorageDeferredTask[];
  piggybackRunning: string | null;
  tools: { hdparm: boolean; smartctl: boolean; mountinfo: boolean };
  libraries: StorageLibraryInfo[];
  /** Where artwork, thumbnails, trickplay, subtitles and the database live (should be an SSD). */
  dataDir: string;
  transcodeDir: string;
  /** Task ids that count as background media-disk work. */
  diskTasks: string[];
}

/* ------------------------------------------------------------------ */
/* "Play to" network renderers (DLNA/UPnP, Sonos, Kodi)                */
/* ------------------------------------------------------------------ */

export type RendererKind = 'dlna' | 'sonos' | 'kodi';

/** A device on the local network MediaMax can send media to. */
export interface Renderer {
  /** Stable id (derived from the device UDN or the manual entry). */
  id: string;
  kind: RendererKind;
  name: string;
  manufacturer: string | null;
  model: string | null;
  /** LAN host (IP) of the device. */
  host: string;
  iconUrl: string | null;
  /** Plays video (Sonos and audio-only DLNA renderers don't). */
  supportsVideo: boolean;
  /** Added by an administrator rather than discovered. */
  manual: boolean;
  online: boolean;
  lastSeenAt: string | null;
  /** What it's playing for MediaMax right now, if anything. */
  nowPlaying: { title: string; userName: string; state: RendererPlayState } | null;
}

export type RendererPlayState = 'idle' | 'buffering' | 'playing' | 'paused' | 'stopped';

export interface RendererState {
  rendererId: string;
  rendererName: string;
  state: RendererPlayState;
  /** Play session id (shows in the admin dashboard like any other stream). */
  sessionId: string | null;
  /** The user this playback belongs to (only they and admins may control it). */
  userId: string | null;
  itemId: string | null;
  title: string | null;
  subtitle: string | null;
  posterUrl: string | null;
  positionMs: number;
  durationMs: number | null;
  /** 0–100, null when the device doesn't report it. */
  volume: number | null;
  muted: boolean;
  /** direct = original file; transcode = MediaMax converts it for the device. */
  method: 'direct' | 'transcode' | null;
  /** Queue position for albums / playlists (1-based), null for a single item. */
  queue: { index: number; total: number } | null;
  error: string | null;
}

export interface RendererPlayRequest {
  itemId: string;
  startMs?: number;
  mediaId?: string;
  audioStreamIndex?: number;
  /** Text subtitle to show (DLNA: Samsung/LG CaptionInfo; Kodi: added as external subtitle). null = off. */
  subtitleStreamIndex?: number | null;
  /** Play these items in order (album / playlist). `itemId` must be one of them; playback starts there. */
  queueItemIds?: string[];
}

export type RendererAction = 'pause' | 'resume' | 'stop' | 'seek' | 'volume' | 'next' | 'previous';

export interface RendererCommandRequest {
  positionMs?: number;
  /** 0–100 */
  volume?: number;
  muted?: boolean;
}

/** Admin → Play to devices. */
export interface RendererSettings {
  /** Discover and control renderers at all (off = feature hidden). */
  enabled: boolean;
  /** Look for Kodi with mDNS (_xbmc-jsonrpc-h._tcp) as well as SSDP. */
  mdns: boolean;
  /** Allow manual devices on non-private addresses (off: LAN / private addresses only). */
  allowPublicHosts: boolean;
  /** Base URL devices use to fetch streams, e.g. http://192.168.1.10:8096 (default: this server's LAN address). */
  streamBaseUrl: string | null;
}

export interface ManualRendererRequest {
  kind: 'kodi' | 'dlna';
  name?: string;
  /** Kodi: host or IP. */
  host?: string;
  /** Kodi JSON-RPC port (default 8080). */
  port?: number;
  username?: string;
  password?: string;
  /** DLNA / Sonos: the device description URL, e.g. http://192.168.1.20:1400/xml/device_description.xml */
  descriptionUrl?: string;
}

export interface RendererAdminView {
  settings: RendererSettings;
  manual: { id: string; kind: 'kodi' | 'dlna'; name: string; host: string; port: number | null; username: string | null; hasPassword: boolean; descriptionUrl: string | null }[];
  renderers: Renderer[];
  lastDiscoveryAt: string | null;
}

/* ------------------------------------------------------------------ */
/* Hardware tuners & set-top boxes: TVHeadend, SAT>IP, Enigma2         */
/* (extends LiveSource / CreateLiveSourceRequest / TestSourceResponse  */
/*  through declaration merging, so this block stays append-only)      */
/* ------------------------------------------------------------------ */

/** Driver settings of tuner sources (`tvheadend`, `satip`, `enigma2`). Unknown keys are ignored. */
export interface LiveSourceOptions {
  /** All tuner types: limit concurrent streams (default: the device's tuner count). */
  maxStreams?: number | null;
  /** TVHeadend / Enigma2: HTTP auth scheme. `auto` answers whatever the device asks for (Digest or Basic). */
  authType?: 'auto' | 'basic' | 'digest' | null;
  /** TVHeadend: stream profile name (default `pass` = untouched MPEG-TS). */
  profile?: string | null;
  /** SAT>IP: `fritzbox` reads the FRITZ!Box's own lists; `m3u` reads `playlistUrl` (default: detected). */
  satipMode?: 'fritzbox' | 'm3u' | null;
  /** SAT>IP FRITZ!Box: which built-in lists to import (`tvhd`, `tvsd`, `radio`; default HD + SD). */
  fritzLists?: string[] | null;
  /** SAT>IP: M3U with rtsp:// or http://<ip>/?src=…&freq=… entries (`sat.ip` placeholder hosts are replaced by the device). */
  playlistUrl?: string | null;
  /** SAT>IP: RTSP transport FFmpeg uses (default: UDP for FRITZ!Box, TCP otherwise). */
  rtspTransport?: 'tcp' | 'udp' | null;
  /** SAT>IP: the UPnP description URL (from discovery); used for the tuner count. */
  descriptionUrl?: string | null;
  /** Enigma2: service references of the bouquets to import (default: the first bouquet). */
  bouquets?: string[] | null;
  /** Enigma2: streaming port (default 8001). */
  streamPort?: number | null;
  /** Enigma2: use the receiver's transcoding port instead (default 8002). */
  useTranscoding?: boolean | null;
  transcodePort?: number | null;
  /** Enigma2: OpenWebif "streamauth" is on — send the login to the streaming port too. */
  streamAuth?: boolean | null;
  /** Enigma2: days of guide to read (1–14, default 7). */
  guideDays?: number | null;
}

/** What a tuner source reported about the device at its last refresh / test. */
export interface TunerDeviceInfo {
  name: string | null;
  model: string | null;
  version: string | null;
  /** One line per tuner, e.g. "DVB-S2 ×2" or "Tuner A: DVB-S2 NIM". */
  tuners: string[];
}

export interface TunerBouquet {
  /** Enigma2 bouquet service reference. */
  ref: string;
  name: string;
}

export interface LiveSource {
  /** Tuner sources: driver settings (secrets are never in here). */
  options?: LiveSourceOptions;
  /** Tuner sources: tuners the device reported (`maxConnections` is the effective stream limit). */
  tunerCount?: number | null;
  deviceInfo?: TunerDeviceInfo | null;
}

export interface CreateLiveSourceRequest {
  options?: LiveSourceOptions;
  /** POST /livetv/sources/test only: an existing source whose saved password is used when none is sent. */
  sourceId?: string;
}

export interface TestSourceResponse {
  tunerCount?: number | null;
  deviceInfo?: TunerDeviceInfo | null;
  /** Enigma2: every TV bouquet on the receiver, for the bouquet picker. */
  bouquets?: TunerBouquet[];
  /** TVHeadend: stream profiles the user may pick. */
  profiles?: string[];
  warnings?: string[];
}

/** GET /livetv/tuners/discover: a device found on the LAN. */
export interface DiscoveredTuner {
  kind: 'satip' | 'hdhomerun';
  name: string;
  manufacturer: string | null;
  model: string | null;
  /** Address to use as the source URL. */
  address: string;
  descriptionUrl: string | null;
  tunerCount: number | null;
  /** SAT>IP X_SATIPCAP, e.g. "DVBS2-2,DVBT-2". */
  capabilities: string | null;
  isFritzBox: boolean;
  deviceId: string | null;
}

/** GET /livetv/sources/:id/recordings (TVHeadend): a finished recording on the backend. */
export interface TunerRecording {
  id: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  channelName: string | null;
  start: string | null;
  end: string | null;
  sizeBytes: number | null;
  status: string | null;
}
