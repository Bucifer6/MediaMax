# MediaMax REST API (v1)

All types referenced below live in [`shared/src/types.ts`](../shared/src/types.ts).

* Base path: `/api/v1`
* Auth: `Authorization: Bearer <token>` **or** `?token=<token>` (for `<video>`, HLS segments, WebSocket).
* Also accepted on every request (optional): headers `X-MediaMax-Device-Id`, `X-MediaMax-Device-Name`, `X-MediaMax-Platform`, `X-MediaMax-Version`.
* JSON in/out. Errors are `ApiError` with an HTTP status.
* 🔓 = public, 🔑 = any signed-in user, 🛡️ = admin only.

## System & setup
| Method | Path | Body | Returns |
|---|---|---|---|
| GET 🔓 | `/system/info` | | `SystemInfo` |
| POST 🔓 | `/setup` | `SetupRequest` (only while `setupRequired`) | `AuthResponse` |
| GET 🛡️ | `/system/stats` | | `DashboardStats` |
| GET 🛡️ | `/system/browse?path=/media` | | `DirectoryEntry[]` (folder picker for library paths) |
| GET 🛡️ | `/system/logs?lines=500` | | `{ lines: string[] }` |

## Branding & themes
| Method | Path | Body | Returns |
|---|---|---|---|
| GET 🔓 | `/branding` | | `Branding` |
| PUT 🛡️ | `/branding` | `Partial<Branding>` (no `revision`) | `Branding` |
| POST 🛡️ | `/branding/assets/:kind` | multipart file field `file`; `kind`: `BrandingAssetKind` | `Branding` |
| DELETE 🛡️ | `/branding/assets/:kind` | | `Branding` |
| POST 🛡️ | `/branding/themes` | `Theme` (id optional) | `Branding` |
| PUT 🛡️ | `/branding/themes/:id` | `Theme` | `Branding` |
| DELETE 🛡️ | `/branding/themes/:id` | | `Branding` |
| GET 🔓 | `/branding/custom.css` | | `text/css` (customCss + theme CSS variables) |

Clients must: fetch `/branding` before showing the login screen; apply the user's
`preferences.themeId` if `allowUserThemes` else `defaultThemeId`; re-fetch when
the WebSocket emits `branding.updated`.

## Auth
| Method | Path | Body | Returns |
|---|---|---|---|
| POST 🔓 | `/auth/login` | `LoginRequest` | `AuthResponse` |
| GET 🔓 | `/auth/profiles` | | `PublicProfile[]` (empty if `features.profilePicker` is off) |
| POST 🔓 | `/auth/profile-login` | `PinLoginRequest` | `AuthResponse` |
| POST 🔓 | `/auth/link/request` | `LinkCodeRequest` | `LinkCodeResponse` (TV shows the code) |
| GET 🔓 | `/auth/link/poll?pollToken=` | | `LinkPollResponse` (poll every 3s) |
| POST 🔑 | `/auth/link/approve` | `{ code }` | `{ ok: true, deviceName }` |
| POST 🔑 | `/auth/logout` | | `{ ok: true }` |
| GET 🔑 | `/auth/me` | | `User` |
| PATCH 🔑 | `/auth/me` | `UpdateMeRequest` | `User` |
| GET 🔑 | `/auth/devices` | | `Device[]` (own; admin sees all with `?all=true`) |
| DELETE 🔑 | `/auth/devices/:id` | | `{ ok: true }` (revokes token) |

## Users 🛡️
`GET /users` → `User[]` · `POST /users` `CreateUserRequest` → `User` · `PATCH /users/:id` `UpdateUserRequest` → `User` · `DELETE /users/:id`
`allowRequest4k` (default false) lets a non-admin tick "Also request in 4K" when a 4K Radarr/Sonarr exists.

## Libraries
| Method | Path | Body | Returns |
|---|---|---|---|
| GET 🔑 | `/libraries` | | `Library[]` (only those the user may see) |
| POST 🛡️ | `/libraries` | `CreateLibraryRequest` | `Library` |
| PATCH 🛡️ | `/libraries/:id` | `UpdateLibraryRequest` | `Library` |
| DELETE 🛡️ | `/libraries/:id` | | `{ ok: true }` |
| POST 🛡️ | `/libraries/:id/scan` | `{ refreshMetadata?: boolean }` | `{ ok: true }` (async; progress via WS) |
| POST 🛡️ | `/libraries/scan` | | scans all |

## Items
| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET 🔑 | `/items` | `ItemQuery` as query string | `Paged<Item>` |
| GET 🔑 | `/items/:id` | | `Item` (with `media`, `markers`) |
| GET 🔑 | `/items/:id/children` | `sort`, `order`, `limit`, `offset` | `Paged<Item>` (seasons of a show, episodes of a season, albums, tracks, collection/playlist members) |
| GET 🔑 | `/items/:id/similar?limit=12` | | `Item[]` (movies/shows: the recommendation engine's similarity, see Discovery) |
| GET 🔑 | `/items/:id/next` | | `Item \| null` (next episode/track) |
| POST/DELETE 🔑 | `/items/:id/played` | | `UserItemData` (cascades to children) |
| POST/DELETE 🔑 | `/items/:id/favorite` | | `UserItemData` |
| POST 🔑 | `/items/:id/rating` | `{ rating: number \| null }` | `UserItemData` (👍 = 10, 👎 = 2) |
| POST/DELETE 🔑 | `/items/:id/watchlist` | | `UserItemData` (My List) |
| POST/DELETE 🔑 | `/items/:id/not-interested` | | `UserItemData` |
| POST 🔑 | `/items/:id/progress` | `ProgressReport` | `UserItemData` (≥90% ⇒ marked played) |
| PATCH 🛡️ | `/items/:id` | `UpdateItemRequest` | `Item` |
| POST 🛡️ | `/items/:id/refresh` | | `Item` (re-fetch metadata: TMDB, then the built-in providers, then plugins) |
| GET 🛡️ | `/items/:id/match?provider=&q=&year=` | | `MatchSearchResponse` (Fix match search; see Metadata providers) |
| POST 🛡️ | `/items/:id/match` | `ApplyMatchRequest` `{ provider, id }` | `Item` (re-fetched from that match) |
| POST 🛡️ | `/items/:id/images/:kind` | multipart `file` (`poster`/`backdrop`/`logo`/`thumb`) | `Item` |
| DELETE 🛡️ | `/items/:id` | | `{ ok: true }` (removes from DB only) |
| GET 🔑 | `/genres?libraryId=` | | `string[]` |
| GET 🔑 | `/home` | | `HomeResponse` (driven by `Branding.homeRows`) |
| GET 🔑 | `/search?q=&limit=` | | `SearchResponse` |
| GET 🔓 | `/images/:imageId?w=` | | image bytes (cached) |

`GET /items/:id/next` on a show or season returns its next-up episode (in progress → next unwatched → first).

### Collections & playlists
* `GET /collections` → `Item[]` · `POST /collections` 🛡️ `CreateCollectionRequest` → `Item` · `POST /collections/:id/items` 🛡️ `{ itemIds }` · `DELETE /collections/:id/items/:itemId` 🛡️ · `DELETE /collections/:id` 🛡️
* `GET /playlists` → `Item[]` (own) · `POST /playlists` `CreatePlaylistRequest` → `Item` · `POST /playlists/:id/items` `{ itemIds }` · `DELETE /playlists/:id/items/:itemId` · `DELETE /playlists/:id`
* Members of either: `GET /items/:id/children`.

## Playback & streaming
| Method | Path | Body | Returns |
|---|---|---|---|
| POST 🔑 | `/playback/:itemId` | `PlaybackRequest` | `PlaybackInfo` |
| POST 🔑 | `/playback/sessions/:sessionId/progress` | `ProgressReport` | `{ ok: true }` (send every ~10s and on pause/stop) |
| DELETE 🔑 | `/playback/sessions/:sessionId` | | `{ ok: true }` (stop, kills transcode) |
| GET 🔑 | `/stream/direct/:mediaId` | Range supported | file bytes |
| GET 🔑 | `/stream/hls/:sessionId/master.m3u8` | | HLS playlist |
| GET 🔑 | `/stream/hls/:sessionId/:segment` | | `segN.ts` (H.264, MPEG-TS) or `segN.m4s` + `init.mp4` (HEVC/AV1, fMP4; the playlist has `#EXT-X-MAP`) |
| GET 🔑 | `/stream/subtitles/:mediaId/:index.vtt` | | WebVTT |
| GET 🔑 | `/stream/download/:itemId` | | original file as attachment (needs `allowDownloads`) |
| GET 🛡️ | `/sessions` | | `ActiveSession[]` |
| DELETE 🛡️ | `/sessions/:id` | `?reason=` | `{ ok: true }` |

`PlaybackInfo.url` is server-relative and already contains `?token=`; prepend the server base URL.
For seeking in a transcoded stream beyond what's generated, call `POST /playback/:itemId` again with `startMs`.

## Live TV / IPTV
| Method | Path | Body | Returns |
|---|---|---|---|
| GET 🛡️ | `/livetv/sources` | | `LiveSource[]` |
| POST 🛡️ | `/livetv/sources` | `CreateLiveSourceRequest` | `LiveSource` (refresh kicked off) |
| PATCH 🛡️ | `/livetv/sources/:id` | `UpdateLiveSourceRequest` | `LiveSource` |
| DELETE 🛡️ | `/livetv/sources/:id` | | `{ ok: true }` |
| POST 🛡️ | `/livetv/sources/test` | `CreateLiveSourceRequest` | `TestSourceResponse` |
| POST 🛡️ | `/livetv/sources/:id/refresh` | | `{ ok: true }` (channels + EPG + VOD/series) |
| GET 🛡️ | `/livetv/tuners/discover` | | `DiscoveredTuner[]` (SAT>IP via SSDP, HDHomeRun via UDP 65001; ~2.5 s) |
| GET 🛡️ | `/livetv/sources/:id/recordings` | | `TunerRecording[]` (TVHeadend finished recordings) |
| GET 🛡️ | `/livetv/sources/:id/recordings/:recId/file` | `Range` supported | the recording file, proxied from TVHeadend |

Tuner sources (`type` `tvheadend`, `satip`, `enigma2`) take driver settings in `options` (`LiveSourceOptions`: `profile`, `authType`, `satipMode`, `fritzLists`, `playlistUrl`, `rtspTransport`, `descriptionUrl`, `bouquets`, `streamPort`, `useTranscoding`, `transcodePort`, `streamAuth`, `guideDays`, `maxStreams`). They are always restreamed (`proxyStreams` is forced on); `LiveSource` adds `options`, `tunerCount` and `deviceInfo`, and `maxConnections` is the effective stream limit. `POST /livetv/sources/test` returns `tunerCount`, `deviceInfo`, `bouquets` (Enigma2), `profiles` (TVHeadend) and `warnings`; send `sourceId` to test an existing source with its saved password. See [TUNERS.md](TUNERS.md).
| GET 🔑 | `/livetv/categories?sourceId=` | | `ChannelCategory[]` |
| PATCH 🛡️ | `/livetv/categories/:id` | `{ hidden?, sortOrder?, name? }` | `ChannelCategory` |
| GET 🔑 | `/livetv/channels` | `ChannelQuery` | `Paged<Channel>` |
| GET 🔑 | `/livetv/channels/:id` | | `Channel` |
| PATCH 🛡️ | `/livetv/channels/:id` | `{ number?, name?, hidden?, epgChannelId?, logoUrl? }` | `Channel` (a bare `epgChannelId` is looked up in the guides by priority) |
| PUT 🛡️ | `/livetv/channels/:id/match` | `SetChannelMatchRequest` | `ChannelMatch` |
| POST/DELETE 🔑 | `/livetv/channels/:id/favorite` | | `{ favorite }` |
| GET 🔑 | `/livetv/channels/:id/programs?start=&end=` | | `Program[]` |
| GET 🔑 | `/livetv/guide?start=&end=&categoryId=&favorite=&offset=&limit=` | | `GuideResponse` (default: now-30m → +6h) |
| POST 🔑 | `/livetv/channels/:id/play` | `LivePlayRequest` | `PlaybackInfo` |
| GET 🔑 | `/livetv/stream/:channelId` | `?catchupStart=&duration=` | proxied MPEG-TS |
| GET 🔑 | `/livetv/hls/:sessionId/:file` | | remuxed HLS |

Xtream VOD & series are imported into virtual libraries (`iptv-movies`, `iptv-shows`) so they
browse, search, resume and play exactly like local media through `/items` and `/playback`.

## DVR
`GET /dvr/recordings?status=` → `Recording[]` · `POST /dvr/recordings` `CreateRecordingRequest` → `Recording` · `DELETE /dvr/recordings/:id` (cancel or delete) · `GET /dvr/rules` → `RecordingRule[]` · `POST /dvr/rules` · `PATCH /dvr/rules/:id` · `DELETE /dvr/rules/:id`.

## Admin
* `GET/PUT /settings` 🛡️ `ServerSettings`
* `GET /tasks` 🛡️ `ScheduledTask[]` · `POST /tasks/:id/run` 🛡️
* `GET /activity?limit=&offset=` 🛡️ `Paged<ActivityEntry>`
* `POST /settings/webhooks/test` 🛡️ `{ url }`

### Smart home & storage
* `GET /status/now-playing` (any user; API key via `X-Api-Key` or `?api_key=`) → `NowPlayingStatus { watching, activeStreams, transcodes, bandwidthKbps, sessions[], recentlyAdded[] }`. Admins see every stream, other users their own.
* `GET /integrations/home-assistant` 🛡️ → `{ settings: HomeAssistantSettings (password masked "••••"), status: HomeAssistantStatus }` · `PUT` 🛡️ same body → reconnects.
* `POST /integrations/home-assistant/test` 🛡️ `HomeAssistantSettings` (unsaved allowed) → `HomeAssistantTestResult` · `POST /integrations/home-assistant/discovery` 🛡️ → re-publish discovery.
* `POST /integrations/home-assistant/webhook` 🛡️ `{ haUrl, webhookId, events? }` → adds a `format: "home-assistant"` webhook · `POST /integrations/home-assistant/webhook/test` 🛡️ `{ url }`.
* `GET /storage` 🛡️ → `StorageStatus` (settings, window, postponed tasks, per-library mounts / disks / power state, watcher info) · `PUT /storage` 🛡️ `Partial<StorageSettings>` · `POST /storage/run-deferred` 🛡️ `{ diskKey? }`.

## Hardware transcoding detection (🛡️)
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/admin/transcoding/detect` | | `{ report: HwDetectReport \| null }` — the last run in this server session |
| POST | `/admin/transcoding/detect` | | `{ report: HwDetectReport }` — runs now (concurrent calls share one run; takes seconds to a minute) |

`HwDetectReport` = `{ ranAt, durationMs, platform, arch, ffmpeg: { version, hwaccels, encoders, filters }, devices: HwDevice[],
methods: HwMethodResult[], recommendation: { id, hwAccel, device, gpuIndex, reason } }`. Each `HwMethodResult` has `available`
(device/encoder present), `works` (H.264 encode), `error`, `encode.{h264,hevc,av1}` / `decode` / `tenBit` test results
(`{ works, error, fps, skipped? }`), `toneMapping: { path, tried[] }` and `notes`. Apply one by saving `transcoding.hwAccel`
plus `vaapiDevice` (VA-API/QSV on Linux) or `gpuIndex` (NVENC, QSV/AMF on Windows) with `PUT /settings`.
Related settings in `ServerSettings.transcoding`: `preferredCodecs` (e.g. `["hevc","h264"]`), `allowHevcEncoding`,
`allowAv1Encoding`, `hardwareToneMapping`, `gpuIndex`. `ActiveSession.transcodeInfo` adds `hwFallback` (why a session left
the hardware path) and `toneMap`.

## Discovery: recommendations, My List, calendar, notifications
| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET 🔑 | `/watchlist?limit=100&offset=` | | `Paged<Item>` (newest first) |
| POST/DELETE 🔑 | `/items/:id/watchlist` | | `UserItemData` (adding clears "not interested") |
| POST/DELETE 🔑 | `/items/:id/not-interested` | | `UserItemData` (also removes it from My List) |
| GET 🔑 | `/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD` | default: last 7 days → next 30, max 120 days | `CalendarResponse` |
| GET 🔑 | `/notifications?limit=50&unread=true` | | `NotificationsResponse` |
| POST 🔑 | `/notifications/read` | `{ ids?: string[] }` (omit for all) | `{ unread }` |

* `UserItemData.inWatchlist` and `UserItemData.notInterested` come with every item.
* **Home row types** (`HomeRowType`, set in `Branding.homeRows`): `recommended`, `because` (row has `seedItemId`; title placeholder
  `{title}`), `top10` (`{server}` placeholder; clients show big rank numbers), `trending`, `watchlist` (`link.page = 'watchlist'`), and
  `upcoming` (`calendar: CalendarEntry[]`, one per item, `link.page = 'calendar'`). Rows with too little data are left out.
* **How recommendations are scored.** Each movie/show is a weighted feature vector: genres (shared weight, so many-genre titles
  aren't favoured), the first 8 billed actors, directors/creators, studios/networks and decade. A viewer's taste profile sums the
  vectors of their titles, weighted by signal: watched (1, or up to 1.5 for many episodes; older plays fade over ~4 months), in
  progress 0.5, favourite +1.5, 👍/rating ≥ 8 +1.5, My List +0.4, 👎/rating ≤ 4 → −2, "not interested" → negative. Candidates
  (capped at a few hundred) come from SQL: titles sharing top genres, the top people (indexed `item_people` table), titles watched by
  viewers with overlapping history (cosine similarity of watch sets on this server, episodes rolled up to shows), and popular titles.
  Score = profile match (normalised) + 0.6 × collaborative + 0.15 × community rating + a small freshness bonus. Watched, in-progress
  and "not interested" titles are excluded, and every query applies library access and parental limits.
* **Because you watched** picks one of the viewer's 3 most recent finished movies (or shows with ≥ 3 finished episodes), rotating
  daily, and ranks by the same similarity (cosine of feature vectors) plus "people who watched X also watched Y".
* **Top 10**: distinct viewers over the last 7 days (plays break ties), episodes roll up to their show, plays under 2 minutes
  ignored. **Trending**: plays in the last 14 days, each worth e^(−age / 72 h); hides the viewer's "not interested" titles.
* Results are cached per viewer for 10 minutes and dropped when they play, rate, favourite or change My List.
* **Calendar**: when a show's TMDB metadata refreshes, its `next_episode_to_air`, status, `in_production` and `last_air_date` are
  stored; the daily **Refresh TV schedules** task keeps them current. `CalendarResponse.tmdbConfigured` is false without a TMDB key
  (recently added episodes still appear). `CalendarEntry.following` = the viewer watched the show or has it on My List.
* **Notifications**: when a scan adds episodes of a show you've watched (or have on My List), you get one notification per show
  ("3 new episodes of …"), pushed live as the `notification` WebSocket event.
* **Trailer previews**: `POST /playback/:trailerId` with `{ preview: true }` (trailer extras only) starts a muted-preview session that
  runs beside other playback on the device, isn't in history/stats, the admin dashboard, scrobbles or webhooks. Stop it with
  `DELETE /playback/sessions/:id`. Users can turn previews off with the `autoplayPreviews` preference.

## WebSocket
`GET /api/v1/ws?token=` — server sends `ServerEvent` JSON frames, client may send `ClientEvent`.
SyncPlay (watch together): `syncplay.create` → server replies `syncplay.state` with a `code`; friends send `syncplay.join` with the room id or code; any member's `syncplay.command` is broadcast to everyone in the room.

## Profiles, avatars & parental controls
* `PublicProfile.pinLength` / `User.pinLength` — PIN pads auto-submit at this length (fallback 4).
* `POST /auth/me/avatar` (multipart `file`) → `User` · `DELETE /auth/me/avatar` · admin: `POST|DELETE /users/:id/avatar`.
* `ServerSettings.blockUnratedForRestricted` hides unrated titles from users with a `maxContentRating`.

## Account profiles ("Who's watching?")
A profile is a managed user owned by an account (`User.parentUserId` = the owner's id). It has no password or username sign-in:
a device signs in as the owner and switches. Profile users carry `ownerName`, `isKids`, `profileColor`, `avatarId`, `hideUnrated`;
owners carry `profileCount` (> 0 → show the picker after sign-in). A profile's effective limits never exceed the owner's
(library intersection, stricter rating, owner's stream limit shared by the account, never admin).

| Method | Path | Body | Returns |
|---|---|---|---|
| GET 🔓 | `/avatars` | | `BuiltinAvatar[]` |
| GET 🔓 | `/avatars/:id.svg` | | SVG image |
| GET 🔑 | `/auth/account/profiles` | | `AccountProfile[]` — owner first, `current` marks this session |
| POST 🔑 | `/auth/profiles/:id/switch` | `SwitchProfileRequest` `{ pin? }` | `AuthResponse` for the target, on this device; the previous session on the device ends. 401 `pin_required` / `pin_invalid`, 429 `pin_locked` after 5 wrong PINs (15 min). Works from the owner's or any profile's session of the account; switching back to the owner needs the owner's PIN if set |
| GET 🔑 | `/profiles/settings` | | `ProfileSettings` |
| GET 👤 | `/profiles` | | `Profile[]` (the owner's) |
| POST 👤 | `/profiles` | `CreateProfileRequest` | `Profile` — 409 `profile_limit` over `maxPerAccount` |
| GET / PATCH / DELETE 👤 | `/profiles/:id` | `UpdateProfileRequest` | `Profile` (owner or admin) |
| POST / DELETE 👤 | `/profiles/:id/avatar` | multipart `file` | `Profile` |
| GET / POST 🛡️ | `/users/:id/profiles` | `CreateProfileRequest` | profiles of any account |

👤 = the account owner's own session (or an admin). Profile sessions get 403 `profile_session` on these, on `/auth/me/2fa/*`,
`/auth/api-keys*`, `/auth/link/approve`, and on `PATCH /auth/me` with `password`, `pin` or `displayName` (preferences,
`avatarId` and `profileColor` are allowed). `POST /auth/logout` from a profile signs the whole account out of that device.
`PATCH /auth/me` also takes `avatarId` / `profileColor` for anyone (the owner's picker tile).
* Request permissions: `requestPermissions: null` inherits the owner's (never `manageRequests`); owners can only lower
  levels, admins can set anything. Kids profiles start with none. `requestQuotas` (admin only): null = counts toward the
  owner's quota together with the owner and every other sharing profile.
* Kids: `maxContentRating` defaults to `ProfileSettings.kidsDefaultRating`, `hideUnrated` to `kidsHideUnrated`; Live TV
  only when `kidsLiveTv` is on (channels have no ratings). `kidsTheme` sets the profile's theme to the built-in `kids` theme.
* `ServerSettings.profiles: ProfileSettings` (`PUT /settings`) — `enabled`, `maxPerAccount` (incl. the owner, default 6),
  `kidsLiveTv`, `kidsDefaultRating`, `kidsHideUnrated`.
* Deleting an account deletes its profiles; disabling it or changing its password signs its profiles out too.
* Sessions, stats, activity and request lists name profiles "Owner › Profile".

## Extra item endpoints
* `GET /items?ancestorId=` — children *and* grandchildren (all tracks of an artist, all episodes of a show), grouped by parent when `sort=index`.
* `Item.lockedFields` on `GET /items/:id`.
* `GET /stream/download/:itemId?quality=original|1080p|720p|480p` — non-original returns a fragmented H.264/AAC MP4 (no Content-Length; `X-MediaMax-Duration-Ms` header).
* `GET /dvr/defaults` → `DvrDefaults` (any signed-in user).

## Trickplay (seek-bar previews)
* `GET /items/:id/trickplay[?mediaId=]` → `TrickplayInfo` (404 until generated). Thumbnail *n* (time = n × intervalMs) is on sheet `floor(n / (columns×rows))` at column `n % columns`, row `floor(n / columns) % rows`.
* `GET /trickplay/:mediaId/:sheet.jpg?token=` — sprite sheet.
* Generated by the **Generate scrub previews** task when `ServerSettings.trickplay.enabled`.

## Statistics
* `GET /stats/me?year=2026` → `UserStats` (omit `year` for all time) — powers the "Wrapped" screen.
* `GET /stats/users/:id?year=` 🛡️ → `UserStats` · `GET /stats/server?days=30` 🛡️ → `ServerStats`.

## Online subtitles (OpenSubtitles)
* `GET /items/:id/subtitles/search?languages=en,fr` → `RemoteSubtitle[]` (hash matches first).
* `POST /items/:id/subtitles/download` `{ fileId, language, hearingImpaired?, forced? }` → `Item` (new track appears in `media[].subtitleStreams`).
* `DELETE /items/:id/subtitles/:index` 🛡️ removes a downloaded subtitle.
* Configure `ServerSettings.openSubtitles` (API key, optional account, auto-download languages).

## Trakt
* `GET /trakt` → `TraktStatus` · `POST /trakt/connect` → `TraktDeviceCode` (show `userCode` + `verificationUrl`; poll `GET /trakt` until `connected`) · `PATCH /trakt` `{ scrobble }` · `DELETE /trakt`.
* Admin sets `ServerSettings.trakt.clientId/clientSecret` (create an app at trakt.tv/oauth/applications). Playback start/pause/stop and "mark watched" are scrobbled automatically.

## Lyrics
* `GET /items/:id/lyrics` → `Lyrics` (from `.lrc`/`.txt` sidecars or embedded tags; `synced` lines carry `startMs`). 404 when none.
  When neither exists and LRCLIB is enabled (Server settings → Metadata), lyrics come from LRCLIB (`source: "lrclib"`) and are cached.

## Metadata providers (🛡️)
Built-in providers, configured on Server settings → Metadata (see [METADATA.md](METADATA.md) for keys and costs).
Settings are stored separately from `ServerSettings` (settings key `metadata`).

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/admin/metadata` | | `MetadataSettingsResponse` `{ settings, providers, cache }` — keys/PINs are `"••••"` when set |
| PUT | `/admin/metadata` | `Partial<MetadataSettings>` | `MetadataSettingsResponse` (send `"••••"` to keep a stored key, `null` to remove it) |
| POST | `/admin/metadata/:provider/test` | `{ apiKey?, pin? }` (unsaved form values; `"••••"` = stored) | `MetadataTestResult` `{ ok, message, ms }` (always a live request) |
| DELETE | `/admin/metadata/cache?provider=` | | `{ ok: true }` |
| GET | `/items/:id/match?provider=&q=&year=` | | `MatchSearchResponse` `{ providers, provider, results: MatchCandidate[] }` |
| POST | `/items/:id/match` | `{ provider, id }` | `Item` |

`MetadataSettings`:
```jsonc
{
  "providers": {                       // BuiltinProviderId → config
    "tvdb":        { "enabled": true,  "apiKey": "••••", "pin": null },
    "fanart":      { "enabled": true,  "apiKey": "••••" },
    "audiodb":     { "enabled": false, "apiKey": null },
    "audnexus":    { "enabled": true,  "apiKey": null },
    "openlibrary": { "enabled": true,  "apiKey": null },
    "googlebooks": { "enabled": true,  "apiKey": null },   // key optional
    "lrclib":      { "enabled": true,  "apiKey": null },
    "omdb":        { "enabled": true,  "apiKey": "••••" },
    "musicbrainz": { "enabled": true,  "apiKey": null }
  },
  "order": ["tmdb", "tvdb", "musicbrainz", "audnexus", "omdb", "fanart", "audiodb", "googlebooks", "openlibrary", "lrclib"],
  "artwork": { "movie": "auto", "show": "fanart", "artist": "audiodb", "album": "auto", "audiobook": "audnexus" },
  "cacheTtlHours": 168
}
```
* Providers only fill **empty, unlocked** fields, in `order` (TMDB always runs first for movies/shows). Artwork: `auto` fills
  gaps; naming a provider lets it replace downloaded (remote) art for that type. Local and locked art is never replaced.
* Fix match: `provider` is one of the item type's searchable providers (`movie` → `tmdb`; `show` → `tmdb`, `tvdb`;
  `artist`/`album` → `musicbrainz`; `audiobook` → `audnexus` (query = ASIN), `googlebooks`, `openlibrary`). Applying drops the
  old match's ids and downloaded art and refreshes in replace mode (unlocked fields take the new match's values).
* New `Item` fields: `ratings?: { imdb?, rottenTomatoes?, metacritic?, tmdb? }` (imdb/tmdb 0–10, RT/MC 0–100);
  `episodeOrder?: 'aired' | 'dvd' | 'absolute'` (shows; set with `PATCH /items/:id` `{ episodeOrder }`, which re-matches
  the episodes); on `GET /items/:id`: `extraArt?: { clearArtUrl, discArtUrl, bannerUrl }`, `artistInfo?: { formedYear,
  country, mood, style }`, and Audnexus `chapters` for audiobooks without embedded chapters.
* "Refresh all metadata" (task `refresh-metadata`, or `POST /libraries/:id/scan { refreshMetadata: true }`) runs TMDB and
  every enabled provider for movies, shows, artists, albums and audiobooks, with progress.

## Single sign-on (OpenID Connect)
* `SystemInfo.oidc` is non-null when SSO is configured — show a button labelled `buttonLabel`.
* Open `GET /api/v1/auth/oidc/start?redirect=<url>&deviceId=&deviceName=&platform=` **in a browser**. After sign-in the
  browser is sent to `<redirect>#token=<token>` (or `#error=<message>`). `redirect` must be on the server's own origin /
  `publicUrl`, or use the `mediamax://` scheme (native apps: open with an auth session and read the fragment).
* Configure `ServerSettings.oidc` (issuer, client id/secret, auto-create users, admin group, allowed group). Register
  `<publicUrl>/api/v1/auth/oidc/callback` as the redirect URI at your provider.

## Audiobooks
* Library type `audiobooks`: folders `Author/Book/parts…` or `Author/Book.m4b`. Items: `audiobook` (container, author in
  `parentTitle` and `people`, narrator as `people` role "Narrator") → `bookpart` (playable).
* `Item.chapters` (on `GET /items/:id`) lists embedded chapters. `GET /items/:bookId/next` resumes the right part.

## Podcasts
* `GET /podcasts` → `PodcastSubscription[]` · `POST /podcasts` `SubscribePodcastRequest` · `PATCH /podcasts/:id` `{ autoDownload }` ·
  `POST /podcasts/:id/refresh` · `DELETE /podcasts/:id` (subscriber or admin).
* `GET /podcasts/search?q=` → `PodcastSearchResult[]` (iTunes directory; a pasted URL is returned as-is).
* `POST /podcasts/import` `{ opml }` → `{ added, skipped, failed }`.
* Shows are `podcast` items with `podcastepisode` children in an automatic **Podcasts** library; play/resume/mark played
  like any item. `GET /items/:podcastId/next` = in-progress or newest unplayed episode. Feeds refresh hourly.

## Last.fm
* `GET /lastfm` → `LastfmStatus` (also completes a pending connection) · `POST /lastfm/connect` → `LastfmAuthStart` (open
  `authUrl`, then poll `GET /lastfm`) · `PATCH /lastfm` `{ scrobble }` · `DELETE /lastfm`.
* Admin sets `ServerSettings.lastfm.apiKey/sharedSecret` (create an API account at last.fm/api/account/create).
  "Now playing" is sent on start; tracks are scrobbled after half their length or 4 minutes.

## Requests (Discover)
* `GET /discover?q=&type=movie|show|all&page=` → `DiscoverResponse` (TMDB; trending when `q` is empty; shows availability and request state).
* `GET /discover/arr?kind=music|books&q=` → `DiscoverResponse` — searches Lidarr (`/api/v1/artist/lookup` + `/api/v1/album/lookup`)
  or Readarr (`/api/v1/book/lookup`); no TMDB key needed. Results have `mediaType` `artist`, `album` or `book` and an `externalId`
  (MusicBrainz artist/album id, Readarr foreign book id).
* `GET /requests/options` → `RequestOptions` (`music`/`books` when a Lidarr/Readarr exists, `can4k.movie/show` for this user, `tmdb`).
* `GET /requests?status=&mine=true` → `MediaRequest[]` (non-admins see their own). While a request is in an *arr queue,
  `download` is `{ progress, status, timeLeft, instance }` (matched by TMDB/TVDB/MusicBrainz/foreign book id).
* `POST /requests` `CreateMediaRequest`:
  `{ mediaType: 'movie'|'show'|'artist'|'album'|'book', tmdbId | externalId, title?, seasonMode?: 'all'|'first'|'latest'|'specific', seasons?, monitor?: 'all'|'future', also4k?, note? }`.
  `also4k` needs a 4K Radarr/Sonarr and an admin or a user with `allowRequest4k`. Weekly limits and auto-approve apply to every kind.
* `POST /requests/:id/approve` 🧑‍⚖️ (optional `EditMediaRequest` body, applied first) · `POST /requests/:id/decline` 🧑‍⚖️ `{ reason }` (`note` still accepted) ·
  `POST /requests/:id/retry` 🧑‍⚖️ · `DELETE /requests/:id?removeFromArr=true` (own pending, or manager; `removeFromArr` deletes the movie/series from
  every Radarr/Sonarr, files kept) → `{ ok, removedFrom }`. 🧑‍⚖️ = admin or a user with `requestPermissions.manageRequests`.
  Approval sends the title to the first enabled non-4K instance of its kind (and the 4K instance when `also4k`); the request
  becomes `processing`, or `failed` with `error` when every instance refused.
* `POST /requests/arr/test` 🛡️ `{ url, apiKey, kind? }` → `ArrOptions` (legacy; use `POST /arr/test`).

### Permissions, quotas, approval workflow (Overseerr parity)
* `User.requestPermissions: RequestPermissions` — `movie|show|movie4k|show4k|music|book: 'none'|'request'|'auto'`, `manageRequests`,
  `reportIssues`, `watchlistAutoRequest`. `User.requestQuotas: RequestQuotas | null` (null = server default). Both are accepted by
  `POST /users`, `PATCH /users/:id` and `PATCH /users/bulk` 🛡️ `BulkUpdateUsersRequest` (`{ userIds, requestPermissions?, requestQuotas?, allow*? }`).
  `allowRequest4k` is kept (derived) and old clients toggling it update the 4K permissions. Requests a user may not make → **403**
  (`code: request_permission`, or `blacklisted`); over quota → **429** (`code: request_limit`).
* `ServerSettings.requests` adds `defaultPermissions`, `defaultQuotas`, `quotaExemptManagers` (default true), `quotaExemptAutoApprove`,
  `autoApproveMinRating` (0 = off) and `hideAvailable`. `autoApproveUserIds`/`weeklyLimit` are deprecated fallbacks.
* `GET /requests/options` adds `permissions`, `quotas` (`Record<kind, RequestQuotaStatus>`: `limit, days, used, remaining, resetsAt, exempt`),
  `canManage`, `hideAvailable`. `GET /requests/quota` → the quotas alone.
* `GET /requests?status=&mediaType=&userId=&sort=requested|updated|title|status&order=asc|desc&mine=true` — managers see everyone's.
  `MediaRequest` adds `arr` (overrides, managers only), `quotaUnits`, `commentCount`, `declineReason`.
* `GET /requests/:id` · `PATCH /requests/:id` 🧑‍⚖️ `EditMediaRequest` `{ seasonMode?, seasons?, also4k?, arr?: { instanceId, instance4kId, qualityProfileId, rootFolderPath, languageProfileId, tags } }`
  (pending/failed/declined only) · `GET /requests/:id/arr-options` 🧑‍⚖️ → `RequestArrChoices` (instances with defaults and their profiles/folders/tags).
* `POST /requests/bulk` 🧑‍⚖️ `{ ids, action: 'approve'|'decline'|'retry'|'delete', note?, removeFromArr? }` → `{ ok: string[], failed: { id, error }[] }`.
* `GET /requests/:id/activity` → `RequestActivity[]` (timeline: created, approved, processing, failed, available, declined, edited, retried, comment) ·
  `POST /requests/:id/comments` `{ body }` (requester or manager).
* `GET /requests/tv/:tmdbId` → `RequestTvInfo` — seasons with `episodeCount`, `libraryEpisodes`, `status: available|partial|requested|pending|missing`.
  `POST /requests` for a show only requests seasons that are neither in the library nor already requested (409 when none are left).
* Blacklist 🧑‍⚖️: `GET /requests/blacklist` · `POST /requests/blacklist` `{ mediaType, externalId, title?, reason? }` · `DELETE /requests/blacklist/:type/:id`.

### Discover extras
* `GET /discover?…&hideAvailable=true` · `GET /discover/sliders?hideAvailable=` → `DiscoverSlider[]` (watchlist, recently-added, recently-requested, trending,
  popular/upcoming/top movies & shows) · `GET /discover/list/:key?page=` (`trending`, `popular-movies`, `popular-shows`, `upcoming-movies`, `upcoming-shows`,
  `top-movies`, `top-shows`, `movie-genre-<id>`, `show-genre-<id>`, `studio-<id>`, `network-<id>`) → `DiscoverResponse & { title }` ·
  `GET /discover/genres` · `GET /discover/people?q=` · `GET /discover/person/:id` → `DiscoverPerson` (cast/crew as Discover cards).
  `DiscoverResult` adds `blacklisted` (managers only see these), `onWatchlist`, `partiallyAvailable`.
* Watchlist: `GET /discover/watchlist` → `DiscoverWatchlistEntry[]` · `POST /discover/watchlist` `{ mediaType, tmdbId }` (auto-requests with the
  `watchlistAutoRequest` permission; the failure reason is kept in `autoRequestError`) · `DELETE /discover/watchlist/:type/:tmdbId`.

### Issues
* `GET /issues?status=open|resolved&kind=&mine=true` (managers: all; others: own) · `GET /issues/count` → `{ open }` · `GET /issues/:id` (with `comments`).
* `POST /issues` `{ itemId, kind: 'video'|'audio'|'subtitle'|'other', message, season?, episode? }` (needs `reportIssues`; episodes are filed against
  their show with season/episode set) · `POST /issues/:id/comments` `{ body }` · `POST /issues/:id/resolve` · `POST /issues/:id/reopen` ·
  `DELETE /issues/:id` (manager, or the reporter while there are no comments).

### Notifications for requests & issues
* In-app notifications (`AppNotification.kind` `request` | `issue`, with `link`) go to managers (new request, failed, new issue) and to the
  requester/reporter (approved, declined with reason, available, replies, resolved).
* `ServerSettings.notificationAgents: NotificationAgent[]` — `{ id, kind: discord|slack|telegram|ntfy|gotify|pushover|email|webhook, name, enabled,
  events: NotifyEvent[], config }`; secret config fields read back as `••••` (saving the mask keeps them). `GET /notify/agents/kinds` 🛡️ lists the fields;
  `POST /notify/agents/test` 🛡️ (a saved agent by id, or a draft) → `{ ok, message }`.
* Webhook events `request.approved`, `request.declined`, `request.failed`, `issue.created`, `issue.resolved` join `request.created` / `request.available`.
* `ServerSettings.requests`: `enabled`, `autoApproveUserIds`, `weeklyLimit`. Download managers live in `ServerSettings.arr`
  (below); the old `requests.radarr` / `requests.sonarr` are migrated once and still read as a fallback.
  Webhooks: `request.created`, `request.available`.

## *arr suite: Radarr, Sonarr, Lidarr, Readarr, Bazarr
`ServerSettings.arr: ArrInstance[]` — `{ id, kind: 'radarr'|'sonarr'|'lidarr'|'readarr'|'bazarr', name, url, apiKey, enabled, is4k?,
qualityProfileId?, rootFolderPath?, languageProfileId? (Sonarr v3), metadataProfileId? (Lidarr/Readarr), tags?, seasonFolders?, monitor?,
searchOnAdd?, pathMappings?: { remotePath, localPath }[] }`. Saved with `PUT /settings`. **API keys are write-only**: reads return
`"••••"` when a key is set, and saving `"••••"` keeps the stored key. Instance URLs may be LAN/private addresses.
API prefixes: Radarr/Sonarr `/api/v3`, Lidarr/Readarr `/api/v1`, Bazarr `/api` (header `X-Api-Key`).

All 🛡️:
* `POST /arr/test` `ArrTestRequest { id?, kind, url, apiKey }` → `ArrOptions` (`ok`, `message`, `version`, `qualityProfiles`,
  `rootFolders`, `tags`, `metadataProfiles`, `languageProfiles`). Pass the instance `id` with `apiKey: "••••"` to test with the saved key.
* `GET /arr/queue` → `ArrListResponse<ArrQueueItem>` (cached 10 s) · `GET /arr/calendar?days=14` → `ArrListResponse<ArrCalendarEntry>` (30 s) ·
  `GET /arr/wanted` → `ArrListResponse<ArrWantedEntry>` (top 50 missing per instance, 30 s) ·
  `GET /arr/health` → `ArrHealthResponse` (health checks + disk space, Bazarr included, 30 s).
  Each response holds one `section` per enabled instance: `{ instance, ok, error, items }`. An unreachable instance is
  `ok: false` with an `error`; the others are unaffected.
* `POST /arr/:instanceId/search` `ArrSearchRequest { ids, command?, seasonNumber? }` → `{ ok, command, commandId }`. Default command
  per kind: `MoviesSearch`, `EpisodeSearch`, `AlbumSearch`, `BookSearch`; also `SeriesSearch`, `SeasonSearch`, `ArtistSearch`, `AuthorSearch`.
* `GET /arr/item/:itemId` → `ArrItemInfo { matches: ArrItemMatch[], bazarr }` — the movie/show/artist in each instance
  (TMDB id → Radarr, TVDB id → Sonarr, name → Lidarr) with `webUrl` ("Open in …") and `searchCommand` ("Search for upgrade").
* `POST /arr/item/:itemId/subtitles` → `{ ok, message }` — asks Bazarr to search missing subtitles for a movie (via its Radarr id)
  or a show (via its Sonarr id; episodes and seasons use their show).
* `GET /arr/webhook` → `ArrWebhookInfo { path, url, token }` · `POST /arr/webhook/regenerate` → new `ArrWebhookInfo`.

### *arr webhooks
`POST /arr/webhook/:token` 🔓 — the token is a random secret (stored in the settings table, compared in constant time; a wrong
token is a 401 and an `AUTH_FAIL reason=arr_webhook` security event). Set it up in each app:

1. **Settings → Connect → + → Webhook**. Name "MediaMax", URL = `GET /arr/webhook`'s `url` (or your server address + `path`),
   method POST, no username/password.
2. Triggers — Radarr: On File Import, On File Upgrade, On Rename, On Movie Delete, On Movie File Delete (On Grab optional).
   Sonarr: On File Import, On File Upgrade, On Import Complete, On Rename, On Series Delete, On Episode File Delete.
   Lidarr: On Release Import, On Upgrade, On Rename, On Track Retag, On Artist Delete, On Album Delete.
   Readarr: On Release Import, On Upgrade, On Rename, On Book Retag, On Author Delete, On Book Delete, On Book File Delete.
3. **Test** (logged under Activity as "webhook test received"), then **Save**.

Handling, by `eventType`:
* `Download` (import/upgrade), `Rename`, `Retag`, `ImportComplete`, `MovieDelete`, `MovieFileDelete`, `SeriesDelete`,
  `EpisodeFileDelete`, `ArtistDelete`, `AlbumDelete`, `TrackFileDelete`, `AuthorDelete`, `BookDelete`, `BookFileDelete` →
  the affected folders are taken from `movie.folderPath`, `series.path`, `artist.path`, `author.path`/`book.path` and the
  folders of any listed files (`movieFile.path`, or `relativePath` joined to the title folder; `episodeFile`, `trackFiles`,
  `bookFiles`). Each path is mapped through the sending instance's `pathMappings` (longest `remotePath` prefix wins;
  Windows paths compare case-insensitively), and the library whose folder contains it is rescanned. Events for the same
  library within ~10 s collapse into one scan; afterwards the request availability check runs, so requests flip to
  `available` straight away. If no library contains the path, a warning is logged suggesting a path mapping.
* `Test` → logged. `Grab` → logged, queue cache refreshed. `Health`, `HealthRestored`, `ApplicationUpdate`,
  `ManualInteractionRequired` → logged, health cache refreshed. Anything else is ignored with `200`.
* The sending instance is recognised by `instanceName` / `applicationUrl`; otherwise all instances of that kind's mappings are tried.
* Response: `{ ok, event, kind, libraries, paths }`.

## Smart collections & playlists
* `POST /smart/preview` `{ filter, limit }` → `Paged<Item>` · `POST /smart` `CreateSmartListRequest` → `Item` ·
  `PUT /smart/:id` `{ title?, overview?, filter? }`. Smart collections are admin-only; smart playlists belong to their creator.
* Children (`GET /items/:id/children`) are computed live for the viewer. `Item.smart` holds the `SmartFilter`.
* Rule fields: genre, studio, person, year, rating, durationMin, addedDays (lte = within N days, gte = older),
  contentRating, played, favorite, inProgress, library, type, title, resolution (4K/1080p/720p/480p/SD).

## Plugins
See [PLUGINS.md](PLUGINS.md). Management (🛡️): `GET /admin/plugins` → `PluginInfo[]` · `GET /admin/plugins/catalog?refresh=true` →
`PluginCatalogEntry[]` · `POST /admin/plugins/install` `{ id, version? }` · `POST /admin/plugins/upload` (multipart `file`, .tar.gz) ·
`POST /admin/plugins/:id/enable|disable` · `PUT /admin/plugins/:id/settings` `{ key: value }` · `DELETE /admin/plugins/:id`.
Repositories: `ServerSettings.plugins.repositories`. Plugin routes: `/api/v1/plugins/<id>/<path>`; admin pages:
`PluginInfo.adminPageUrl` (render in a sandboxed iframe).

## Security & sharing
* **API keys** (for Home Assistant, scripts): `GET/POST /auth/api-keys` (`{ name }` → `CreatedApiKey`, key shown once) ·
  `DELETE /auth/api-keys/:id`. Send `X-Api-Key: mmk_…` (or `?api_key=`); the key acts as its owner.
* **Two-factor (TOTP)**: `POST /auth/me/2fa/setup` → `TotpSetup` · `POST /auth/me/2fa/enable` `{ code }` → `TotpEnabled` (recovery codes) ·
  `POST /auth/me/2fa/disable` `{ code }` · admin reset `DELETE /users/:id/2fa`. Sign-in returns 401 `totp_required` until
  `LoginRequest.totpCode` / `PinLoginRequest.totpCode` is sent (a PIN never replaces the second factor).
* **Invites**: `GET/POST /invites` 🛡️ (`CreateInviteRequest` → `Invite` with `url`) · `DELETE /invites/:code` 🛡️ ·
  `GET /invites/:code/preview` 🔓 → `InvitePreview` · `POST /invites/:code/accept` 🔓 `AcceptInviteRequest` → `AuthResponse`.
  New users get the invite's `template` (libraries, rating limit, permissions, `maxStreams`, `allowRemote`).
* **Per-user limits**: `User.maxStreams` (429 `stream_limit` when exceeded) and `User.allowRemote` (403 `remote_not_allowed` off-LAN).

## Backups, remote access, metrics (🛡️)
* `GET/POST /admin/backups` → `BackupInfo[]` / new backup · `GET /admin/backups/:id/download` · `DELETE /admin/backups/:id` ·
  `POST /admin/backups/:id/restore` or `POST /admin/backups/restore-upload` (multipart) → `{ restartRequired: true }`;
  the restore is applied on the next start (a `pre-restore` backup is taken first). `POST /admin/restart` exits so Docker/systemd restarts it.
  Scheduled backups: `ServerSettings.backups`.
* `GET /admin/remote-access` → `RemoteAccessStatus` · `POST /admin/remote-access/refresh`. UPnP port mapping: `ServerSettings.remoteAccess`
  (needs host networking in Docker).
* `GET /metrics` — Prometheus text format (admin token or API key).

## Audiobooks extras
* Bookmarks: `GET/POST /items/:id/bookmarks` (`{ positionMs, note? }` → `Bookmark`) · `DELETE /items/:id/bookmarks/:bookmarkId`.
* Series: `Item.series = { name, index }` (from `series`/`mvnm` tags or `Author/Series/01 - Book` folders); `GET /items?series=<name>`.

## Subsonic / OpenSubsonic
`/rest/<method>.view` (GET or form POST, `f=json` or XML). Auth: `u` + `p` (plain or `enc:<hex>`) or OpenSubsonic `apiKey`
(a MediaMax API key). Salted-token auth (`t`/`s`) returns error 41 (passwords are never stored in plaintext). Implemented:
ping, getLicense, getOpenSubsonicExtensions, getUser, getMusicFolders, getGenres, getIndexes, getArtists, getArtist, getAlbum,
getSong, getMusicDirectory, getAlbumList2, getRandomSongs, getSongsByGenre, search3, getStarred2, star, unstar, scrobble,
getPlaylists, getPlaylist, createPlaylist, updatePlaylist, deletePlaylist, getLyrics, getLyricsBySongId, getNowPlaying,
getScanStatus, stream (raw or `format=mp3|opus&maxBitRate=`), download, getCoverArt.

## Remote control ("Play on…")
* `GET /remote/targets` → `RemoteTarget[]` — your other online devices and what they're playing.
* Players send `{ type: 'remote.state', state: RemotePlayerState | null }` over the WebSocket on change and every ~10 s.
* Controllers send `{ type: 'remote.command', targetDeviceId, action, itemId?, channelId?, positionMs?, volume? }`; the target device
  receives `remote.command` (with `fromDeviceName`) and applies it. Everyone gets `remote.targets` pushes when devices come and go.
  Only the same user's devices can be controlled.

## Play to devices (DLNA / UPnP renderers, Sonos, Kodi)
The server discovers renderers on the LAN (SSDP `MediaRenderer:1` / Sonos `ZonePlayer:1`, mDNS `_xbmc-jsonrpc-h._tcp`), controls them
(AVTransport / RenderingControl SOAP, Kodi JSON-RPC) and tracks the playback as a normal session (watch progress, scrobbling,
dashboard, stream limits). Types: `Renderer`, `RendererState`, `RendererPlayRequest`, `RendererCommandRequest`, `RendererSettings`.
* 🔑 `GET /renderers` → `Renderer[]` (cached; a stale cache starts a background search). Empty when the feature is off.
* 🔑 `POST /renderers/discover` → `Renderer[]` — search now (SSDP + mDNS, ~3 s; at most every 10 s).
* 🔑 `POST /renderers/:id/play` `RendererPlayRequest` → `RendererState` — `{ itemId, startMs?, mediaId?, audioStreamIndex?, subtitleStreamIndex?, queueItemIds? }`.
  An album / playlist / season id plays its children. `startMs` defaults to the resume point. 409 `renderer_busy` when the device is
  playing for another user; 403 when a transcode is needed and the user may not transcode; 400 for video on an audio-only device.
* 🔑 `POST /renderers/:id/{pause|resume|stop|next|previous}`, `POST /renderers/:id/seek` `{ positionMs }`,
  `POST /renderers/:id/volume` `{ volume?: 0–100, muted? }` → `RendererState`. Only the user who started playback (or an admin).
* 🔑 `GET /renderers/:id/state` → `RendererState` (poll ~1.5 s while playing). `GET /renderers/:id/icon` proxies the device icon.
* 🛡️ `GET /admin/renderers` → `RendererAdminView`; `PUT /admin/renderers/settings` `Partial<RendererSettings>`;
  `POST /admin/renderers/manual` `ManualRendererRequest` (`{ kind: 'kodi', host, port?, username?, password? }` or
  `{ kind: 'dlna', descriptionUrl }`, private addresses only unless `allowPublicHosts`); `DELETE /admin/renderers/manual/:id`.
* 🔓 `GET /renderers/stream/:key/:token.:ext` — what devices fetch. The token is an HMAC-signed claim (one media file, format,
  start offset, expiry); it is refused from non-LAN addresses and stops working when the playback ends. `.srt` tokens serve
  subtitles (also announced via DIDL `sec:CaptionInfoEx` and the `CaptionInfo.sec` header for Samsung / LG).

## Editions & extras
* `MediaSource.edition` — e.g. "Director's Cut" (from `{edition-…}` or `Movie (2010) - Director's Cut.mkv`); several editions are
  several `media` entries on one movie.
* `GET /items/:id/extras` → `Item[]` (type `video`, `extraType` trailer/featurette/behindthescenes/deleted/interview/scene/short/other),
  from Plex/Jellyfin-style folders (`Trailers/`, `Featurettes/`, `Behind The Scenes/`, `Extras/`…) or `-trailer`-style suffixes.
  Extras never appear in library lists or search.

## DVR priorities, rule filters and tuner conflicts

Recordings and rules carry a `priority` (0–100, higher wins). Manual recordings default to 90 and rules to 50 (0–99), so `PATCH /dvr/recordings/:id {"priority":100}` always makes a recording win. "Make top priority" in the apps does this.

Rules (`POST /dvr/rules`) accept these optional fields:

| Field | Meaning |
|---|---|
| `daysOfWeek` | `[0..6]` (0 = Sunday); only match programmes starting on these days |
| `timeFrom` / `timeTo` | `"HH:MM"` 24-hour window (server local time); may wrap past midnight, e.g. `22:00`–`02:00` |
| `skipRepeats` | default `true`; skip episodes already recorded (by episode number, else title + subtitle) |
| `priority` | rule priority, passed on to the recordings it schedules |

Every change to the schedule (create, cancel, rule delete, rule run) re-checks each live source's `maxConnections`. Recordings are given slots in order: recordings already in progress first, then by priority, then oldest first. A recording that cannot get a slot has `conflict: true`, and a `recording.updated` event is sent. If it is still in conflict at start time, it fails with a clear error. Cancelling another recording frees its slot straight away.

## TV guide (EPG) providers

Guides are their own entity, `EpgSource` (all endpoints 🛡️ admin). Kinds: `xmltv` (URL or local file, gzip and xz detected from the file's magic bytes; the iptv-org / epg.pw presets are `xmltv` with `config.preset`), `schedulesdirect`, `hdhomerun`, and `provider` (a live source's own guide, created automatically). See [EPG.md](EPG.md) for setup.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/livetv/epg-sources` | | `EpgSource[]` (highest priority first, with `report`) |
| POST | `/livetv/epg-sources` | `CreateEpgSourceRequest` | `EpgSource` (refresh kicked off; Schedules Direct logins are checked first, 400 on bad credentials) |
| GET | `/livetv/epg-sources/:id` | | `EpgSource` |
| PATCH / PUT | `/livetv/epg-sources/:id` | `UpdateEpgSourceRequest` | `EpgSource` |
| DELETE | `/livetv/epg-sources/:id` | | `{ ok: true }` (guide data removed; channels fall back to other guides) |
| POST | `/livetv/epg-sources/:id/refresh` | | `{ ok: true }`; 429 for Schedules Direct within 15 min of the last refresh |
| GET | `/livetv/epg-sources/:id/sd/status` | | `SdStatus` (account expiry, lineups, system status) |
| GET | `/livetv/epg-sources/:id/sd/headends?country=USA&postalcode=10001` | | `SdHeadend[]` |
| PUT / DELETE | `/livetv/epg-sources/:id/sd/lineups/:lineup` | | `{ status: SdStatus, changesRemaining }` |
| GET | `/livetv/epg-presets` | | `EpgPreset[]` (built-in iptv-org / epg.pw guides by country) |
| GET | `/livetv/epg-channels?q=&epgSourceId=&limit=` | | `EpgGuideChannel[]` across all guides, ranked by name similarity |
| GET | `/livetv/epg-preview?epgSourceId=&epgChannelId=&offsetHours=` | | `{ now, next, upcoming: Program[] }` |
| GET | `/livetv/matching?filter=all\|matched\|unmatched\|low\|missing&sourceId=&search=&offset=&limit=` | | `MatchingResponse` (`items`, `counts`, `thresholds`) |
| PUT | `/livetv/channels/:id/match` | `{ epgSourceId, epgChannelId }` or `{ none: true }` or `{ epgChannelId: null }` (back to automatic), plus `offsetHours` | `ChannelMatch` |
| POST | `/livetv/matching/accept-all` | `{ sourceId?, minConfidence? }` | `{ accepted }` |
| POST | `/livetv/matching/rematch` | | `{ ok: true }` |

`GET /livetv/channels?guideStatus=true` (admins) adds `hasGuide` to each channel. `Channel` also carries `epgSourceId`, `guideStatus` and `epgOffsetHours`.

**Credentials are write-only.** A Schedules Direct `config.password` is accepted on create/update, stored only as the SHA1 hex digest SD's `/token` call expects, and never returned. Responses only say `config.hasPassword`. Provider-guide URLs (which contain Xtream credentials) are returned redacted.

**Priority merging.** A higher `priority` wins per channel and lower guides fill gaps: for each channel, the highest-priority guide with an automatic match that has programmes is used. A manual match always wins. Each guide's data is staged and swapped in only after the guide loads, so a broken guide keeps its previous programmes and never empties the EPG. Defaults: global guides 50, URLs from a live source's `epgUrl` 100, 99… (in field order), the provider's own guide 0.

**`epgUrl` compatibility.** A live source's `epgUrl` field still works: each URL becomes an `xmltv` guide with `managedBy: "epgUrl"` and `ownerSourceId` set, applying only to that source. Existing fields are migrated on startup. These guides, and the `provider` guide, can only change `priority` and `enabled`; edit the URLs on the live source. They refresh with their live source. Other guides refresh on their own `refreshIntervalHours` from the "Refresh Live TV & IPTV" scheduled task (Schedules Direct: at least 12 h).

**Matching.** Channel names are normalised: country prefixes (`UK:`, `|US|`, `[DE]`), quality tags (HD/FHD/UHD/4K/HEVC…), `+1`, punctuation, number words, and camelCase guide ids (`BBCOne.uk@HD`). Candidates are then tried in order: exact guide id (tvg-id, confidence 1.0), tuner guide number (HDHomeRun sources, 0.99), callsign (0.96), exact normalised name (0.95), and fuzzy similarity (token Dice, trigram Dice and Jaro-Winkler). Mismatched numbers, countries and near-ties are penalised. A match at 0.80 or above is applied (`auto`). One from 0.50 to 0.80 waits as a suggestion (`review`). A `+1` channel matched to its base channel gets a +60 min shift automatically. Manual matches live in `channels.custom` (`epgSourceId`, `epgChannelId`, `epgNone`, `epgOffsetHours`), so they survive refreshes.

**Time shift.** `offsetHours` (−24…24, quarter-hour steps) per channel is served from shifted programme copies, so the guide, now/next, search and the DVR all see shifted times. For XMLTV guides with the wrong time zone, set `config.timezone` (an IANA zone or `+01:00`): the file's offsets are ignored and its times are read as wall-clock times in that zone.

**Quality report.** `EpgSource.report` gives `channels`, `programmes`, `matchedChannels` (channels using this guide), `daysAhead`, `lastDurationMs` and `warnings` (e.g. one URL of a multi-URL guide failed). Failures are in `lastError`.

**Big guides.** Guides with more than 3000 channels store programmes only for channels that are matched or suggested. A manual match to another channel of such a guide triggers a refresh.

## Commercial and preview markers

`Marker.type` can also be `preview` ("next time on" scenes) or `commercial` (ad breaks). Players show "Skip ad break" or "Skip preview". When auto-skip is on, intros, recaps and ad breaks are skipped automatically.

- **Sidecar EDL:** a Kodi/MythTV/comskip `.edl` file next to any video (same base name) is imported on every scan. Each line is `start end action`, in seconds. Actions `0` (cut) and `3` (commercial) become `commercial` markers.
- **DVR:** with `settings.dvr.commercialDetection` on, finished recordings are passed to comskip (`dvr.comskipPath`, default `comskip` on PATH). If `dvr.comskipIni` is not set, MediaMax supplies an EDL-only ini. The resulting `.edl` is imported straight away and deleted along with the recording.

## IPTV multiview

`POST /livetv/channels/:id/play` with `{"multiview": true}` starts a multiview tile. Normally a new playback on a device replaces that device's previous one. Multiview tiles from the same device run side by side instead, up to 4 (the oldest is stopped beyond that). Any normal playback on the device still replaces them all. Each tile counts toward the user's `maxStreams`. It uses a provider connection only when nobody else is already watching that channel, because tuners are shared. Catch-up streams cannot be multiview tiles.

The web app's multiview is at `/watch/multiview?ch=<id>,<id>,…`. Click a tile (or press 1–4 or Tab) to move the sound to it, double-click a tile to open it in the full player, and press F for full screen.

## ReplayGain / loudness levelling

Music tracks carry `replayGain: { trackGainDb, trackPeak, albumGainDb, albumPeak }` when the file has `REPLAYGAIN_*` tags. Opus `R128_*_GAIN` tags are converted to the ReplayGain −18 LUFS reference. The OpenSubsonic `replayGain` field on songs carries the same values, so Symfonium, Feishin and similar apps can level volume. Each user picks a mode with the `replayGain` preference (`off`, `track`, `album`, or `auto`, the default, which uses album gain when playing an album in order and track gain otherwise). Tags are read on scan; run a full refresh to pick them up for files that were already scanned.

## Cinema mode (trailers and pre-rolls)

`GET /items/:id/intros` returns the videos to play before a movie: up to `settings.cinema.trailers` local trailers for *other* movies (unwatched ones only, when `unwatchedOnly` is set), then one random clip from `cinema.prerollLibraryId`. It returns `[]` when cinema mode is off, when the item is not a movie, or when the user has turned off the `cinemaMode` preference. Results respect parental limits and library access. The web player chains intros as `/play/<intro>?then=<movie>&intros=<rest>`, and "Skip to movie" jumps straight to the feature.

## DJ mode

MediaMax analyses every music track and can build and play continuous, beat-matched mixes.

**Analysis.** The scheduled task "Analyse music for DJ mode" runs every 6 hours. `POST /dj/analyze` (admin) runs it now, and `GET /dj/status` reports `{analyzed, total, running}`. `GET /items/:id/analysis` returns a `TrackAnalysis` and analyses the track on demand (about 0.5 s per track). Each track gets:

- tempo (`bpm`, with `bpmConfidence`) and a beat grid (`beatOffsetMs`)
- musical key and its Camelot code (`key`, `camelot`)
- `energy` (0–1) and `loudnessDb`
- cue-in/out (leading and trailing silence skipped)
- intro end and outro start

Analysis is pure TypeScript DSP on PCM decoded by ffmpeg. Tempo comes from spectral-flux onsets, autocorrelation and a beat-grid fit across the whole track. Key comes from chroma matched against Krumhansl–Kessler profiles. Tracks without a steady beat get `bpm: null`.

**Mixes.** `POST /dj/mix` with a `DjMixRequest` returns a `DjMix`.

- **Seed:** `seedItemId` is a track, album, artist or playlist. Without one, the mix starts from a favourite or a highly rated track.
- **Filters:** `genres`, `libraryId`, `bpmMin`/`bpmMax`. Half and double time count, so 70 BPM matches 140.
- **Shape:** `curve` is `steady`, `build`, `peak`, `wave` or `chill`; `durationMin` sets the length.
- **Mixing rules:** `harmonic` (default true), `artistGap` (default 3), `preferFavorites` (default true).
- **Continuous mode:** send `history` (ids already played or queued) plus `count` to get the next tracks. Tracks are never repeated, and the energy curve keeps moving.

Tracks are ordered by scoring each candidate on:

- key compatibility on the Camelot wheel (same key, ±1, relative major/minor, or a +2 "energy boost")
- tempo distance
- distance from the energy-curve target (by percentile within the library)
- genre overlap
- favourites and ratings

Every track after the first carries a `transition` describing how to mix into it:

- **When:** start the incoming track at `mixInMs` (on its beat grid) when the outgoing track reaches `mixOutMs`, which is snapped to a bar line of the outgoing track.
- **How long:** crossfade over `crossfadeMs`.
- **Tempo:** play the incoming track at `tempoRatio` during the blend, then ease it back to 1.0.
- **Style:** `blend` (beat-matched, 16–32 beats), `fade`, or `cut` for a clashing key and tempo. `keyMatch` and `bpmDelta` are included for display.

The web app's DJ page (`/dj`) runs two decks on Web Audio with equal-power crossfades, preloads the next track at its mix-in point, and tops up non-stop mixes automatically.

## AI DJ

The AI DJ is free by default and works offline. Admins can connect free or cheap AI services under **Server settings → AI DJ**.

- **Ask in plain words:** `POST /dj/mix {"prompt": "chilled 90s house for a Sunday morning"}`. The built-in parser understands:
  - genres, including synonyms (EDM, hip hop/rap, R&B, DnB…), matched against your library's genres
  - decades and years ("90s", "the eighties", "since 2015")
  - moods, mapped to energy curves (chill, party, workout, build-up, waves)
  - tempo ("fast", "124 bpm"), mix length, and "nothing over 5 minutes"
  - "like/start with \<artist, album or song\>"

  The response adds `summary`, `understoodBy` (`llm`/`rules`), `continuous` and the resolved `request`; reuse that request for continuous top-ups. If the filters match nothing, they are relaxed instead of failing.
- **Language model (optional):** `aiDj.llm.provider` is `ollama`, or `openai` for any OpenAI-compatible API:
  - **Self-hosted, free:** LM Studio, llama.cpp, LocalAI, vLLM.
  - **Hosted free tiers:** Groq, Google Gemini (`…/v1beta/openai`), OpenRouter `:free` models, Mistral, Cerebras.
  - **Very cheap hosted:** DeepSeek, OpenAI mini models.

  Model replies are validated (genres must exist in your library) and merged with the parser's results. `maxRequestsPerDay` (default 300) caps calls so free tiers stay free. Over the cap, the built-in DJ takes over silently. API keys are write-only: settings reads return `••••`.
- **The host:** `POST /dj/host {previousItemId?, nextItemId, position, prompt?, hour}` returns `{text, audioUrl, by}`. Text comes from varied templates or the model. The model is told to use only the facts it is given: title, artist, year, BPM, key, energy, your play count and favourite status.
- **Voice:** `aiDj.tts.provider` is one of:
  - `device`: the browser, phone or TV speaks it, free
  - `piper`: open-source neural TTS on the server, free
  - `openai`: any OpenAI-compatible `/audio/speech` API, such as self-hosted Kokoro-FastAPI (free) or a hosted API (cheap)

  Clips are cached as MP3 and served from `GET /dj/voice/:file`. Clients duck the music to about 30% while the host speaks.
- **Taste:** `POST /dj/feedback {itemId, kind: 'skip'|'love'}`. Skipped tracks and artists are played less for 60 days, and "love" also favourites the track.
- **Sounds-like:** analysis v2 adds a 26-number timbre fingerprint (MFCC 1–12 mean and deviation, spectral centroid and flatness). Mixes prefer tracks that sound like the previous one and the seed. `GET /dj/status` reports `ai: {enabled, llm, serverVoice, hostName, chattiness}`.

## Security dashboard (admin)

- `GET /admin/security[?refresh=1]` returns a `SecurityOverview`, cached for 15 s. It covers sign-in failures from MediaMax's security log (24 h and 7 d, by reason, top IPs, targeted users, an hourly histogram and recent events), proxy stats from the Caddy JSON or Nginx combined access log (24 h), the HTTPS certificate (expiry, issuer, trust), CrowdSec active decisions and alerts, and fail2ban jails with their banned IPs. Any part that isn't configured is `null`.
- `GET/PUT /admin/security/settings` reads and writes `SecurityDashboardSettings`. Defaults come from the `MEDIAMAX_PROXY_KIND`, `MEDIAMAX_PROXY_LOG`, `MEDIAMAX_PUBLIC_HOST`, `MEDIAMAX_CROWDSEC_URL`, `MEDIAMAX_CROWDSEC_MACHINE_ID`, `MEDIAMAX_CROWDSEC_PASSWORD` and `MEDIAMAX_FAIL2BAN_SOCKET` environment variables. The CrowdSec password is write-only.
- `POST /admin/security/ban {ip, tool: 'crowdsec'|'fail2ban', jail?, duration?, reason?}` bans an IP or CIDR. Your own address is refused.
- `GET /admin/network` returns `NetworkStatus`: the saved `NetworkSettings` (mode `direct`|`proxy`|`builtin`, trusted proxies, built-in HTTPS domain/email/ports/staging/HSTS), any `MEDIAMAX_TRUSTED_PROXIES` override, how this request arrived (`you`), and the built-in Caddy status (binary, version, running, last error, recent log, certificate).
- `PUT /admin/network` saves a partial `NetworkSettings`. Trusted-proxy changes apply immediately; choosing `builtin` validates the domain and starts Caddy (400 if no Caddy binary is found).
- `POST /admin/security/unban {ip, tool?, jail?}` unbans an address. Without `tool` it removes the address from CrowdSec and every fail2ban jail, and returns `removedFrom`.
