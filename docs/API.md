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
