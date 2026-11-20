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
| GET 🔑 | `/items/:id/similar?limit=12` | | `Item[]` |
| GET 🔑 | `/items/:id/next` | | `Item \| null` (next episode/track) |
| POST/DELETE 🔑 | `/items/:id/played` | | `UserItemData` (cascades to children) |
| POST/DELETE 🔑 | `/items/:id/favorite` | | `UserItemData` |
| POST 🔑 | `/items/:id/rating` | `{ rating: number \| null }` | `UserItemData` |
| POST 🔑 | `/items/:id/progress` | `ProgressReport` | `UserItemData` (≥90% ⇒ marked played) |
| PATCH 🛡️ | `/items/:id` | `UpdateItemRequest` | `Item` |
| POST 🛡️ | `/items/:id/refresh` | | `Item` (re-fetch metadata) |
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
| GET 🔑 | `/stream/hls/:sessionId/:segment` | | `.ts` segment |
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
| GET 🔑 | `/livetv/categories?sourceId=` | | `ChannelCategory[]` |
| PATCH 🛡️ | `/livetv/categories/:id` | `{ hidden?, sortOrder?, name? }` | `ChannelCategory` |
| GET 🔑 | `/livetv/channels` | `ChannelQuery` | `Paged<Channel>` |
| GET 🔑 | `/livetv/channels/:id` | | `Channel` |
| PATCH 🛡️ | `/livetv/channels/:id` | `{ number?, name?, hidden?, epgChannelId?, logoUrl? }` | `Channel` |
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

## WebSocket
`GET /api/v1/ws?token=` — server sends `ServerEvent` JSON frames, client may send `ClientEvent`.
SyncPlay (watch together): `syncplay.create` → server replies `syncplay.state` with a `code`; friends send `syncplay.join` with the room id or code; any member's `syncplay.command` is broadcast to everyone in the room.

## Profiles, avatars & parental controls
* `PublicProfile.pinLength` / `User.pinLength` — PIN pads auto-submit at this length (fallback 4).
* `POST /auth/me/avatar` (multipart `file`) → `User` · `DELETE /auth/me/avatar` · admin: `POST|DELETE /users/:id/avatar`.
* `ServerSettings.blockUnratedForRestricted` hides unrated titles from users with a `maxContentRating`.

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
* `GET /discover?q=&type=movie|show|all&page=` → `DiscoverResponse` (trending when `q` is empty; shows availability and request state).
* `GET /requests?status=&mine=true` → `MediaRequest[]` (non-admins see their own) · `POST /requests` `CreateMediaRequest` ·
  `POST /requests/:id/approve` 🛡️ · `POST /requests/:id/decline` 🛡️ `{ note }` · `DELETE /requests/:id` (own pending, or admin).
* `POST /requests/arr/test` 🛡️ `{ url, apiKey }` → `ArrOptions` (quality profiles + root folders for the settings UI).
* Configure `ServerSettings.requests` (Radarr/Sonarr, auto-approve users, weekly limit). Admin requests auto-approve.
  Approved requests are sent to Radarr/Sonarr and flip to `available` when the title appears in a library.
  Webhooks: `request.created`, `request.available`.

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
