/**
 * Typed Vibe REST client. One instance per (server, token) pair.
 * All shapes come from ./types (synced verbatim from shared/src/types.ts).
 */
import type {
  ApiError as ApiErrorBody,
  DownloadPlan,
  DownloadPlanRequest,
  DownloadRule,
  DownloadRuleInput,
  OfflineSyncEntry,
  OfflineSyncResult,
  PlaybackPrepareRequest,
  PlaybackPrepareResult,
  AuthResponse,
  Bookmark,
  Branding,
  Channel,
  ChannelCategory,
  ChannelQuery,
  CreateRecordingRequest,
  CreateMediaRequest,
  CreateRecordingRuleRequest,
  CreateSmartListRequest,
  Device,
  DeviceInfo,
  DiscoverResponse,
  DjBreakRequest,
  DjBreakResponse,
  DjFeedback,
  DjHostLine,
  DjHostRequest,
  DjMix,
  DjMixRequest,
  DjOrderRequest,
  DjOrderResponse,
  DjRulesResponse,
  DjSession,
  DjSessionNextRequest,
  DjSessionRequestBody,
  DjSessionRequestMiss,
  DjSessionStartRequest,
  DjSuggestions,
  DjStatus,
  DjTransitionsRequest,
  DjTransitionsResponse,
  DownloadQuality,
  DvrDefaults,
  GuideResponse,
  HomeResponse,
  Item,
  ItemQuery,
  ItemSort,
  Library,
  LinkCodeResponse,
  LinkPollResponse,
  LastfmAuthStart,
  LastfmStatus,
  LivePlayRequest,
  Lyrics,
  LoginRequest,
  MediaRequest,
  Paged,
  CalendarResponse,
  PinLoginRequest,
  PlaybackInfo,
  PlaybackRequest,
  PodcastSearchResult,
  PodcastSubscription,
  Program,
  ProgressReport,
  PublicProfile,
  AccountProfile,
  Recording,
  RecordingRule,
  RecordingStatus,
  RemoteSubtitle,
  RemoteTarget,
  RequestMediaType,
  RequestOptions as MediaRequestOptions,
  RequestTvInfo,
  RequestStatus,
  SearchResponse,
  SmartFilter,
  SystemInfo,
  TrackAnalysis,
  TraktDeviceCode,
  TraktStatus,
  TrickplayInfo,
  UpdateMeRequest,
  User,
  UserItemData,
  UserStats, TrackStems, StemsStatus } from './types';

export const API_PREFIX = '/api/v1';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

export function buildQuery(q?: Query): string {
  if (!q) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Normalise what a user typed ("media.local:8096", "https://x/api/v1/") into candidate base URLs. */
export function candidateBaseUrls(input: string): string[] {
  let s = input.trim().replace(/\/+$/, '');
  s = s.replace(/\/api\/v1$/i, '');
  if (/^https?:\/\//i.test(s)) return [s];
  // Bare host: prefer https, fall back to http (LAN servers rarely have TLS).
  return [`https://${s}`, `http://${s}`];
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const outer = init.signal;
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener('abort', () => ctrl.abort());
  }
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Waits before each retry of a GET that failed at the network level. */
const NETWORK_RETRY_DELAYS_MS = [600, 2000];

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** A request that failed before reaching the server (no connection, DNS, timeout). */
export function isNetworkError(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'network';
}

/** Validate a server by calling /system/info. Returns the working base URL. */
export async function probeServer(input: string): Promise<{ baseUrl: string; info: SystemInfo }> {
  let lastErr: unknown = null;
  for (const base of candidateBaseUrls(input)) {
    try {
      const res = await fetchWithTimeout(`${base}${API_PREFIX}/system/info`, { headers: { Accept: 'application/json' } }, 7000);
      if (!res.ok) throw new ApiError(res.status, 'http', `Server answered ${res.status}`);
      const info = (await res.json()) as SystemInfo;
      if (!info || typeof info.id !== 'string' || !info.features) throw new ApiError(0, 'not_mediamax', 'That address is not a Vibe server');
      return { baseUrl: base, info };
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr instanceof ApiError) throw lastErr;
  throw new ApiError(0, 'unreachable', 'Could not reach the server. Check the address and that the server is running.');
}

export interface ClientOptions {
  baseUrl: string;
  token: string | null;
  device: DeviceInfo;
  onUnauthorized?: () => void;
}

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Do not trigger onUnauthorized for a 401 (e.g. login attempts). */
  allow401?: boolean;
}

export class MediaMaxClient {
  readonly baseUrl: string;
  readonly token: string | null;
  readonly device: DeviceInfo;
  private onUnauthorized?: () => void;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.device = opts.device;
    this.onUnauthorized = opts.onUnauthorized;
  }

  withToken(token: string | null): MediaMaxClient {
    return new MediaMaxClient({ baseUrl: this.baseUrl, token, device: this.device, onUnauthorized: this.onUnauthorized });
  }

  /** Headers for any request, including native players/downloaders. */
  headers(json = true): Record<string, string> {
    const h: Record<string, string> = {
      Accept: 'application/json',
      'X-Kinora-Device-Id': this.device.deviceId,
      'X-Kinora-Device-Name': this.device.deviceName,
      'X-Kinora-Platform': this.device.platform,
      'X-Kinora-Version': this.device.appVersion ?? '0',
    };
    if (json) h['Content-Type'] = 'application/json';
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  /** Make a server-relative path absolute. Leaves absolute URLs untouched. */
  absolute(pathOrUrl: string): string {
    if (/^[a-z]+:\/\//i.test(pathOrUrl)) return pathOrUrl;
    return `${this.baseUrl}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
  }

  /** Absolute image URL with optional width hint (server resizes & caches). */
  image(path: string | null | undefined, width?: number): string | null {
    if (!path) return null;
    const abs = this.absolute(path);
    if (!width || !abs.startsWith(this.baseUrl)) return abs;
    return `${abs}${abs.includes('?') ? '&' : '?'}w=${Math.round(width)}`;
  }

  /** Append ?token= for URLs handed to native components that cannot send headers. */
  withAuthQuery(pathOrUrl: string): string {
    const abs = this.absolute(pathOrUrl);
    if (!this.token || /[?&]token=/.test(abs)) return abs;
    return `${abs}${abs.includes('?') ? '&' : '?'}token=${encodeURIComponent(this.token)}`;
  }

  wsUrl(): string | null {
    if (!this.token) return null;
    return `${this.baseUrl.replace(/^http/i, 'ws')}${API_PREFIX}/ws?token=${encodeURIComponent(this.token)}`;
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${API_PREFIX}${path}${buildQuery(opts.query)}`;
    const init: RequestInit = { method, headers: this.headers(opts.body !== undefined), signal: opts.signal };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    // Reads are retried on a network failure. After a device has been idle (TV sticks and phones that
    // slept, Wi-Fi that is still reconnecting, a keep-alive connection the server or a proxy closed) the
    // first request often fails although the server is fine; the next attempt reconnects.
    const retryDelays = method === 'GET' || method === 'HEAD' ? NETWORK_RETRY_DELAYS_MS : [];
    let res!: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetchWithTimeout(url, init, opts.timeoutMs ?? 20000);
        break;
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        const delay = retryDelays[attempt];
        if (delay === undefined) throw new ApiError(0, 'network', 'Network error — is the server reachable?');
        await sleep(delay, opts.signal);
        if (opts.signal?.aborted) throw e;
      }
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const body = (data && typeof data === 'object' ? data : {}) as Partial<ApiErrorBody>;
      if (res.status === 401 && !opts.allow401) this.onUnauthorized?.();
      throw new ApiError(res.status, body.error ?? 'http', body.message ?? `Request failed (${res.status})`);
    }
    return data as T;
  }

  get<T>(path: string, query?: Query, signal?: AbortSignal) {
    return this.request<T>('GET', path, { query, signal });
  }
  post<T>(path: string, body?: unknown, opts: Omit<RequestOptions, 'body'> = {}) {
    return this.request<T>('POST', path, { ...opts, body: body ?? {} });
  }
  patch<T>(path: string, body?: unknown) {
    return this.request<T>('PATCH', path, { body: body ?? {} });
  }
  del<T>(path: string, query?: Query) {
    return this.request<T>('DELETE', path, { query });
  }
  put<T>(path: string, body?: unknown) {
    return this.request<T>('PUT', path, { body: body ?? {} });
  }

  /* ----------------------------- System ----------------------------- */
  systemInfo() {
    return this.get<SystemInfo>('/system/info');
  }
  branding() {
    return this.get<Branding>('/branding');
  }

  /* ------------------------------ Auth ------------------------------ */
  /** 401 `totp_required` when the account has two-factor on: call again with `totpCode` (6 digits or a recovery code). */
  login(username: string, password: string, totpCode?: string) {
    const body: LoginRequest = { ...this.device, username, password, totpCode: totpCode || undefined };
    return this.post<AuthResponse>('/auth/login', body, { allow401: true });
  }
  profiles() {
    return this.get<PublicProfile[]>('/auth/profiles');
  }
  profileLogin(userId: string, pin?: string, totpCode?: string) {
    const body: PinLoginRequest = { ...this.device, userId, pin, totpCode: totpCode || undefined };
    return this.post<AuthResponse>('/auth/profile-login', body, { allow401: true });
  }
  /** "Who's watching?": the signed-in account's profiles (owner first). */
  accountProfiles() {
    return this.get<AccountProfile[]>('/auth/account/profiles');
  }
  /** Switch this device to another profile of the account (401 `pin_required` / `pin_invalid` for PIN profiles). */
  switchProfile(id: string, pin?: string) {
    return this.post<AuthResponse>(`/auth/profiles/${encodeURIComponent(id)}/switch`, { pin }, { allow401: true });
  }
  linkRequest() {
    return this.post<LinkCodeResponse>('/auth/link/request', { ...this.device });
  }
  linkPoll(pollToken: string) {
    return this.request<LinkPollResponse>('GET', '/auth/link/poll', { query: { pollToken }, allow401: true });
  }
  linkApprove(code: string) {
    return this.post<{ ok: true; deviceName: string }>('/auth/link/approve', { code });
  }
  logout() {
    return this.post<{ ok: true }>('/auth/logout', {}, { allow401: true });
  }
  me() {
    return this.get<User>('/auth/me');
  }
  updateMe(body: UpdateMeRequest) {
    return this.patch<User>('/auth/me', body);
  }
  /** Upload a new avatar (multipart field `file`). `uri` is a local file URI, e.g. from expo-image-picker. */
  async uploadAvatar(file: { uri: string; name: string; type: string }): Promise<User> {
    const form = new FormData();
    // React Native's FormData accepts { uri, name, type } file parts.
    form.append('file', file as unknown as Blob);
    const headers = this.headers(false);
    let res: Response;
    try {
      res = await fetchWithTimeout(`${this.baseUrl}${API_PREFIX}/auth/me/avatar`, { method: 'POST', headers, body: form }, 60000);
    } catch {
      throw new ApiError(0, 'network', 'Network error — is the server reachable?');
    }
    const data = (await res.json().catch(() => null)) as (User & Partial<ApiErrorBody>) | null;
    if (!res.ok) {
      if (res.status === 401) this.onUnauthorized?.();
      throw new ApiError(res.status, data?.error ?? 'http', data?.message ?? `Upload failed (${res.status})`);
    }
    return data as User;
  }
  removeAvatar() {
    return this.del<User>('/auth/me/avatar');
  }
  devices() {
    return this.get<Device[]>('/auth/devices');
  }
  revokeDevice(id: string) {
    return this.del<{ ok: true }>(`/auth/devices/${encodeURIComponent(id)}`);
  }

  /* ---------------------------- Libraries --------------------------- */
  libraries() {
    return this.get<Library[]>('/libraries');
  }
  items(q: ItemQuery, signal?: AbortSignal) {
    return this.get<Paged<Item>>('/items', q as Query, signal);
  }
  item(id: string) {
    return this.get<Item>(`/items/${encodeURIComponent(id)}`);
  }
  /** Local trailers, featurettes, deleted scenes… attached to a movie. */
  extras(id: string) {
    return this.get<Item[]>(`/items/${encodeURIComponent(id)}/extras`);
  }
  /** Cinema mode: trailers / pre-roll to play before a movie ([] when off). */
  intros(id: string) {
    return this.get<Item[]>(`/items/${encodeURIComponent(id)}/intros`);
  }
  children(id: string, q: { sort?: ItemSort; order?: 'asc' | 'desc'; limit?: number; offset?: number } = {}) {
    return this.get<Paged<Item>>(`/items/${encodeURIComponent(id)}/children`, q);
  }
  similar(id: string, limit = 12) {
    return this.get<Item[]>(`/items/${encodeURIComponent(id)}/similar`, { limit });
  }
  next(id: string) {
    return this.get<Item | null>(`/items/${encodeURIComponent(id)}/next`);
  }
  setPlayed(id: string, played: boolean) {
    return played ? this.post<UserItemData>(`/items/${encodeURIComponent(id)}/played`) : this.del<UserItemData>(`/items/${encodeURIComponent(id)}/played`);
  }
  setFavorite(id: string, favorite: boolean) {
    return favorite ? this.post<UserItemData>(`/items/${encodeURIComponent(id)}/favorite`) : this.del<UserItemData>(`/items/${encodeURIComponent(id)}/favorite`);
  }
  /** My List (watchlist). */
  setWatchlist(id: string, on: boolean) {
    return on ? this.post<UserItemData>(`/items/${encodeURIComponent(id)}/watchlist`) : this.del<UserItemData>(`/items/${encodeURIComponent(id)}/watchlist`);
  }
  /** "Not interested": hidden from recommendation, because-you-watched and trending rows. */
  setNotInterested(id: string, on: boolean) {
    return on ? this.post<UserItemData>(`/items/${encodeURIComponent(id)}/not-interested`) : this.del<UserItemData>(`/items/${encodeURIComponent(id)}/not-interested`);
  }
  /** Upcoming episodes (TMDB) and recently added ones, by day (default: the last 7 days to 30 days ahead). */
  calendar(q: { from?: string; to?: string } = {}, signal?: AbortSignal) {
    return this.get<CalendarResponse>('/calendar', q, signal);
  }
  /** The viewer's My List, newest first. */
  watchlist(q: { limit?: number; offset?: number } = {}) {
    return this.get<Paged<Item>>('/watchlist', q);
  }
  rate(id: string, rating: number | null) {
    return this.post<UserItemData>(`/items/${encodeURIComponent(id)}/rating`, { rating });
  }
  itemProgress(id: string, report: ProgressReport) {
    return this.post<UserItemData>(`/items/${encodeURIComponent(id)}/progress`, report);
  }
  genres(libraryId?: string) {
    return this.get<string[]>('/genres', { libraryId });
  }
  home() {
    return this.get<HomeResponse>('/home');
  }
  search(q: string, limit = 40, signal?: AbortSignal) {
    return this.get<SearchResponse>('/search', { q, limit }, signal);
  }
  collections() {
    return this.get<Item[]>('/collections');
  }
  playlists() {
    return this.get<Item[]>('/playlists');
  }
  createPlaylist(title: string, itemIds: string[] = []) {
    return this.post<Item>('/playlists', { title, itemIds });
  }
  addToPlaylist(id: string, itemIds: string[]) {
    return this.post<{ ok: true }>(`/playlists/${encodeURIComponent(id)}/items`, { itemIds });
  }
  removeFromPlaylist(id: string, itemId: string) {
    return this.del<{ ok: true }>(`/playlists/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`);
  }
  deletePlaylist(id: string) {
    return this.del<{ ok: true }>(`/playlists/${encodeURIComponent(id)}`);
  }

  /* ---------------------------- Smart lists -------------------------- */
  /** Live preview of a smart filter: `total` is the full match count, `items` the first `limit`. */
  smartPreview(filter: SmartFilter, limit = 20) {
    return this.post<Paged<Item>>('/smart/preview', { filter, limit });
  }
  createSmartList(body: CreateSmartListRequest) {
    return this.post<Item>('/smart', body);
  }
  updateSmartList(id: string, body: { title?: string; overview?: string; filter?: SmartFilter }) {
    return this.request<Item>('PUT', `/smart/${encodeURIComponent(id)}`, { body });
  }

  /* ------------------------- Requests (Discover) ---------------------- */
  /** Trending when `q` is empty. */
  discover(q: { q?: string; type?: RequestMediaType | 'all'; page?: number }, signal?: AbortSignal) {
    return this.request<DiscoverResponse>('GET', '/discover', { query: q, signal, timeoutMs: 30000 });
  }
  /** What this user may request (permissions, 4K, remaining quota). */
  requestOptions() {
    return this.get<MediaRequestOptions>('/requests/options');
  }
  /** Seasons of a show with library/request status (request sheet). */
  requestTvInfo(tmdbId: string) {
    return this.get<RequestTvInfo>(`/requests/tv/${encodeURIComponent(tmdbId)}`);
  }
  /** Non-admins always get their own; admins get everyone's unless `mine`. */
  mediaRequests(q: { status?: RequestStatus; mine?: boolean } = {}) {
    return this.get<MediaRequest[]>('/requests', { status: q.status, mine: q.mine ? true : undefined });
  }
  createMediaRequest(body: CreateMediaRequest) {
    return this.post<MediaRequest>('/requests', body);
  }
  approveMediaRequest(id: string) {
    return this.post<MediaRequest>(`/requests/${encodeURIComponent(id)}/approve`);
  }
  declineMediaRequest(id: string, note?: string) {
    return this.post<MediaRequest>(`/requests/${encodeURIComponent(id)}/decline`, { note: note || undefined });
  }
  deleteMediaRequest(id: string) {
    return this.del<{ ok: true }>(`/requests/${encodeURIComponent(id)}`);
  }

  /* --------------------- Trickplay / subtitles ---------------------- */
  /** Scrub-preview sprite sheets. 404 (ApiError.status) until generated. */
  trickplay(itemId: string, mediaId?: string, signal?: AbortSignal) {
    return this.get<TrickplayInfo>(`/items/${encodeURIComponent(itemId)}/trickplay`, { mediaId }, signal);
  }
  searchSubtitles(itemId: string, languages: string[]) {
    return this.request<RemoteSubtitle[]>('GET', `/items/${encodeURIComponent(itemId)}/subtitles/search`, { query: { languages: languages.join(',') }, timeoutMs: 30000 });
  }
  downloadSubtitle(itemId: string, body: { fileId: string; language: string; hearingImpaired?: boolean; forced?: boolean }) {
    return this.post<Item>(`/items/${encodeURIComponent(itemId)}/subtitles/download`, body, { timeoutMs: 45000 });
  }

  /* ---------------------- Podcasts / lyrics ------------------------ */
  podcasts() {
    return this.get<PodcastSubscription[]>('/podcasts');
  }
  searchPodcasts(q: string, signal?: AbortSignal) {
    return this.request<PodcastSearchResult[]>('GET', '/podcasts/search', { query: { q }, signal, timeoutMs: 30000 });
  }
  subscribePodcast(feedUrl: string, autoDownload = false) {
    return this.post<PodcastSubscription>('/podcasts', { feedUrl, autoDownload }, { timeoutMs: 60000 });
  }
  updatePodcast(id: string, body: { autoDownload: boolean }) {
    return this.patch<PodcastSubscription>(`/podcasts/${encodeURIComponent(id)}`, body);
  }
  refreshPodcast(id: string) {
    return this.post<unknown>(`/podcasts/${encodeURIComponent(id)}/refresh`, {}, { timeoutMs: 60000 });
  }
  unsubscribePodcast(id: string) {
    return this.del<{ ok: true }>(`/podcasts/${encodeURIComponent(id)}`);
  }
  /* ----------------------- Audiobook bookmarks ---------------------- */
  bookmarks(itemId: string, signal?: AbortSignal) {
    return this.get<Bookmark[]>(`/items/${encodeURIComponent(itemId)}/bookmarks`, undefined, signal);
  }
  addBookmark(itemId: string, body: { positionMs: number; note?: string }) {
    return this.post<Bookmark>(`/items/${encodeURIComponent(itemId)}/bookmarks`, body);
  }
  removeBookmark(itemId: string, bookmarkId: string) {
    return this.del<{ ok: true }>(`/items/${encodeURIComponent(itemId)}/bookmarks/${encodeURIComponent(bookmarkId)}`);
  }

  /* -------------------------- Remote control ------------------------- */
  /** The user's other online devices (this one excluded) and what they're playing. */
  remoteTargets() {
    return this.get<RemoteTarget[]>('/remote/targets');
  }

  /** 404 (ApiError.status) when the track has no lyrics. */
  lyrics(itemId: string, signal?: AbortSignal) {
    return this.get<Lyrics>(`/items/${encodeURIComponent(itemId)}/lyrics`, undefined, signal);
  }
  /** Save this user's lyrics offset for a track (ms, + = lyrics earlier). */
  setLyricsOffset(itemId: string, offsetMs: number) {
    return this.request<{ offsetMs: number }>('PUT', `/items/${encodeURIComponent(itemId)}/lyrics/offset`, { body: { offsetMs } });
  }
  /** Karaoke stems prepared for a track, with the server's separation job while one is queued / running. */
  trackStems(itemId: string) {
    return this.get<TrackStems>(`/items/${encodeURIComponent(itemId)}/stems`);
  }
  /** AI stems availability; `engine: 'server'` means the server separates (admins can prepare from any app). */
  stemsStatus() {
    return this.get<StemsStatus>('/stems/status');
  }
  /** Admin: separate a track on the server (queued); poll trackStems() for progress. */
  prepareStemsOnServer(itemId: string) {
    return this.post<TrackStems>(`/items/${encodeURIComponent(itemId)}/stems/prepare`, {});
  }
  /** Admin: cancel that. */
  cancelStemsOnServer(itemId: string) {
    return this.del<{ cancelled: boolean }>(`/items/${encodeURIComponent(itemId)}/stems/prepare`);
  }
  /** Server-side karaoke mix (vocals 0–100 %), a seekable MP3 any device can play. */
  karaokeMixPath(itemId: string, vocals: number) {
    return `/api/v1/items/${encodeURIComponent(itemId)}/karaoke.mp3?vocals=${Math.round(vocals)}`;
  }

  /* ------------------------------ DJ mode ----------------------------- */
  /**
   * Build a beat/key-aware mix (one-off), or the next `count` tracks after `history` (continuous).
   * With `prompt` (AI DJ) the reply carries `summary`, `understoodBy`, the resolved `request` (send that back for
   * top-ups instead of the prompt) and `continuous`. 403 when a prompt is sent and the AI DJ is off on the server.
   */
  djMix(body: DjMixRequest, signal?: AbortSignal) {
    return this.post<DjMix>('/dj/mix', body, { timeoutMs: 60000, signal });
  }
  /** AI DJ host: a short spoken link into `nextItemId` (text, plus server-rendered speech when configured). */
  djHost(body: DjHostRequest, signal?: AbortSignal) {
    return this.post<DjHostLine>('/dj/host', body, { timeoutMs: 20000, signal });
  }
  /** AI DJ feedback: 'skip' steers future picks away, 'love' steers towards (and favourites the track). */
  djFeedback(body: DjFeedback) {
    return this.post<void>('/dj/feedback', body);
  }
  /** How much of the music library has been analysed. */
  djStatus() {
    return this.get<DjStatus>('/dj/status');
  }
  /** Automix (lite DJ): plan transitions between track pairs from stored analyses (local planner, no AI). */
  djTransitions(body: DjTransitionsRequest, signal?: AbortSignal) {
    return this.post<DjTransitionsResponse>('/dj/transitions', body, { timeoutMs: 15000, signal });
  }
  /** Automix "Mix": a source (library, genre, artist, album, playlist, folder) or ids in a mix-friendly order, paged via `history`. */
  djOrder(body: DjOrderRequest, signal?: AbortSignal) {
    return this.post<DjOrderResponse>('/dj/order', body, { timeoutMs: 30000, signal });
  }
  /* ----------------------- Your DJ / Radio Host (AI DJ) ----------------------- */
  /** Your DJ: start a personal set. 403 when the admin switched the AI DJ off. */
  djSession(body: DjSessionStartRequest, signal?: AbortSignal) {
    return this.post<DjSession>('/dj/session', body, { timeoutMs: 30000, signal });
  }
  /** The next batch (same segment while it has tracks, else the next one). 404 = the session ended: start a new one. */
  djSessionMore(id: string, body: DjSessionNextRequest, signal?: AbortSignal) {
    return this.post<DjSession>(`/dj/session/${encodeURIComponent(id)}/more`, body, { timeoutMs: 30000, signal });
  }
  /** "Switch it up": always a different segment kind. */
  djSessionSwitch(id: string, body: DjSessionNextRequest, signal?: AbortSignal) {
    return this.post<DjSession>(`/dj/session/${encodeURIComponent(id)}/switch`, body, { timeoutMs: 30000, signal });
  }
  /** A typed request; nothing within the rules = HTTP 200 `{ ok: false, message }`. */
  djSessionRequest(id: string, body: DjSessionRequestBody, signal?: AbortSignal) {
    return this.post<DjSession | DjSessionRequestMiss>(`/dj/session/${encodeURIComponent(id)}/request`, body, { timeoutMs: 30000, signal });
  }
  /** Three request chips (history + time of day); fine before a session exists. */
  djSuggestions(hour?: number, signal?: AbortSignal) {
    return this.get<DjSuggestions>('/dj/session/suggestions', { hour }, signal);
  }
  /** Radio Host / Your DJ commentary: a break for the coming transition (`break: null` most of the time). */
  djBreak(body: DjBreakRequest, signal?: AbortSignal) {
    return this.post<DjBreakResponse>('/dj/break', body, { timeoutMs: 20000, signal });
  }
  /** Play rules in effect: the active preset ∩ the admin's enforced restrictions (shown as locked chips). */
  djRules(signal?: AbortSignal) {
    return this.get<DjRulesResponse>('/dj/rules', undefined, signal);
  }
  /** BPM / key / energy / cue points of one track (analysed on demand). */
  trackAnalysis(itemId: string, signal?: AbortSignal) {
    return this.request<TrackAnalysis>('GET', `/items/${encodeURIComponent(itemId)}/analysis`, { signal, timeoutMs: 30000 });
  }

  /* ------------------------------- SSO ------------------------------ */
  /** Browser URL that starts an OpenID Connect sign-in and ends at `${redirect}#token=…`. */
  oidcStartUrl(redirect: string) {
    return `${this.baseUrl}${API_PREFIX}/auth/oidc/start${buildQuery({ redirect, deviceId: this.device.deviceId, deviceName: this.device.deviceName, platform: this.device.platform })}`;
  }

  /* ------------------------- Stats / Trakt -------------------------- */
  myStats(year?: number | null) {
    return this.get<UserStats>('/stats/me', { year: year ?? undefined });
  }
  trakt() {
    return this.get<TraktStatus>('/trakt');
  }
  traktConnect() {
    return this.post<TraktDeviceCode>('/trakt/connect');
  }
  traktSetScrobble(scrobble: boolean) {
    return this.patch<TraktStatus>('/trakt', { scrobble });
  }
  traktDisconnect() {
    return this.del<TraktStatus>('/trakt');
  }
  /** Also completes a pending connection after the user approved in the browser. */
  lastfm() {
    return this.get<LastfmStatus>('/lastfm');
  }
  lastfmConnect() {
    return this.post<LastfmAuthStart>('/lastfm/connect');
  }
  lastfmSetScrobble(scrobble: boolean) {
    return this.patch<LastfmStatus>('/lastfm', { scrobble });
  }
  lastfmDisconnect() {
    return this.del<LastfmStatus>('/lastfm');
  }

  /* ---------------------------- Playback ---------------------------- */
  playback(itemId: string, body: PlaybackRequest) {
    return this.post<PlaybackInfo>(`/playback/${encodeURIComponent(itemId)}`, body, { timeoutMs: 45000 });
  }
  /** Instant play: decide now and warm up the stream (no session is created). */
  preparePlayback(itemId: string, body: PlaybackPrepareRequest) {
    return this.post<PlaybackPrepareResult>(`/playback/${encodeURIComponent(itemId)}/prepare`, body, { timeoutMs: 15000 });
  }
  sessionProgress(sessionId: string, report: ProgressReport) {
    return this.post<{ ok: true }>(`/playback/sessions/${encodeURIComponent(sessionId)}/progress`, report);
  }
  stopSession(sessionId: string) {
    return this.del<{ ok: true }>(`/playback/sessions/${encodeURIComponent(sessionId)}`);
  }
  /* ------------------------- Smart downloads ------------------------ */
  downloadRules(scope: 'device' | 'all' = 'device') {
    return this.get<DownloadRule[]>('/downloads/rules', { scope });
  }
  putDownloadRule(showId: string, rule: DownloadRuleInput) {
    return this.put<DownloadRule>(`/downloads/rules/${encodeURIComponent(showId)}`, rule);
  }
  deleteDownloadRule(id: string) {
    return this.del<{ ok: true }>(`/downloads/rules/${encodeURIComponent(id)}`);
  }
  /** What this device should have for its rules, and the server state of the downloads it has. */
  downloadPlan(have: string[]) {
    return this.post<DownloadPlan>('/downloads/plan', { have } satisfies DownloadPlanRequest);
  }
  /** Replay offline progress / watched changes (newest change wins). */
  offlineSync(entries: OfflineSyncEntry[]) {
    return this.post<OfflineSyncResult>('/downloads/sync', { entries });
  }
  /** Download URL. Non-original qualities are converted on the fly (fragmented MP4 / .m4a, no Content-Length). */
  downloadUrl(itemId: string, quality: DownloadQuality = 'original') {
    const q = quality === 'original' ? '' : `?quality=${encodeURIComponent(quality)}`;
    return this.withAuthQuery(`${API_PREFIX}/stream/download/${encodeURIComponent(itemId)}${q}`);
  }

  /* ----------------------------- Live TV ---------------------------- */
  categories(sourceId?: string) {
    return this.get<ChannelCategory[]>('/livetv/categories', { sourceId });
  }
  channels(q: ChannelQuery = {}, signal?: AbortSignal) {
    return this.get<Paged<Channel>>('/livetv/channels', q as Query, signal);
  }
  channel(id: string) {
    return this.get<Channel>(`/livetv/channels/${encodeURIComponent(id)}`);
  }
  setChannelFavorite(id: string, favorite: boolean) {
    const p = `/livetv/channels/${encodeURIComponent(id)}/favorite`;
    return favorite ? this.post<{ favorite: boolean }>(p) : this.del<{ favorite: boolean }>(p);
  }
  channelPrograms(id: string, start?: string, end?: string) {
    return this.get<Program[]>(`/livetv/channels/${encodeURIComponent(id)}/programs`, { start, end });
  }
  guide(q: { start?: string; end?: string; categoryId?: string; favorite?: boolean; offset?: number; limit?: number }, signal?: AbortSignal) {
    return this.get<GuideResponse>('/livetv/guide', q, signal);
  }
  playChannel(id: string, body: LivePlayRequest = {}) {
    return this.post<PlaybackInfo>(`/livetv/channels/${encodeURIComponent(id)}/play`, body, { timeoutMs: 45000 });
  }

  /* ------------------------------- DVR ------------------------------ */
  recordings(status?: RecordingStatus) {
    return this.get<Recording[]>('/dvr/recordings', { status });
  }
  createRecording(body: CreateRecordingRequest) {
    return this.post<Recording>('/dvr/recordings', body);
  }
  /** `priority: 100` = "Make top priority" (always wins a tuner conflict). */
  updateRecording(id: string, body: { priority?: number }) {
    return this.patch<Recording>(`/dvr/recordings/${encodeURIComponent(id)}`, body);
  }
  deleteRecording(id: string) {
    return this.del<{ ok: true }>(`/dvr/recordings/${encodeURIComponent(id)}`);
  }
  dvrDefaults() {
    return this.get<DvrDefaults>('/dvr/defaults');
  }
  rules() {
    return this.get<RecordingRule[]>('/dvr/rules');
  }
  createRule(body: CreateRecordingRuleRequest) {
    return this.post<RecordingRule>('/dvr/rules', body);
  }
  deleteRule(id: string) {
    return this.del<{ ok: true }>(`/dvr/rules/${encodeURIComponent(id)}`);
  }
}
