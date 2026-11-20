# MediaMax feature matrix

How MediaMax compares with the features people use most in Plex, Jellyfin and Emby.
✅ = implemented in this repository · 🟡 = partial · 🗺️ = roadmap

## Libraries & metadata
| Feature | Plex | Jellyfin | Emby | MediaMax |
|---|:-:|:-:|:-:|:-:|
| Movies, TV, music, photos, home videos | ✅ | ✅ | ✅ | ✅ |
| Scene-style filename parsing (`Show.S01E02`, `1x02`, daily shows, multi-episode) | ✅ | ✅ | ✅ | ✅ |
| Multiple versions of one movie (4K + 1080p) | ✅ | ✅ | ✅ | ✅ |
| Local NFO metadata (Kodi/Jellyfin/Emby format) | ❌ | ✅ | ✅ | ✅ |
| Local artwork (poster/fanart/logo/season posters) | ✅ | ✅ | ✅ | ✅ |
| Online metadata (TMDB) with cast, logos, trailers, ratings | ✅ | ✅ | ✅ | ✅ |
| Automatic box-set collections | ✅ | ✅ | ✅ | ✅ |
| Manual collections & per-user playlists | ✅ | ✅ | ✅ | ✅ |
| Edit metadata, lock fields, upload artwork | ✅ | ✅ | ✅ | ✅ |
| Embedded album art + tag-based music library | ✅ | ✅ | ✅ | ✅ |
| `.mediamaxignore` / `.plexignore` folders | ✅ | ✅ | ❌ | ✅ |
| Safe removal (no wipe when a drive is unmounted) | ✅ | 🟡 | 🟡 | ✅ |
| Real-time filesystem watching | ✅ | ✅ | ✅ | ✅ |
| Synced lyrics (LRC sidecars, embedded tags) | ✅ | ✅ | ✅ | ✅ |
| Audiobooks (multi-file & .m4b, chapters, author/narrator, resume) | 🟡 | ✅ | ✅ | ✅ |
| Podcasts (RSS, iTunes directory search, OPML import, auto-download) | ✅ | ❌ | ❌ | ✅ |

## Playback
| Feature | Plex | Jellyfin | Emby | MediaMax |
|---|:-:|:-:|:-:|:-:|
| Direct play / remux / transcode decision per device | ✅ | ✅ | ✅ | ✅ |
| On-demand HLS segments (instant seek anywhere) | ✅ | ✅ | ✅ | ✅ |
| Hardware transcoding (VAAPI, QSV, NVENC, VideoToolbox, V4L2) | Pass | ✅ | Premiere | ✅ (free, auto-fallback to software) |
| HDR → SDR tone mapping | Pass | ✅ | Premiere | ✅ |
| Encoder throttling (pauses ffmpeg when far ahead) | ✅ | ✅ | ✅ | ✅ |
| Sidecar & embedded text subtitles → WebVTT | ✅ | ✅ | ✅ | ✅ |
| Image subtitle (PGS/VobSub) burn-in | ✅ | ✅ | ✅ | ✅ |
| Audio track selection & language preferences | ✅ | ✅ | ✅ | ✅ |
| Resume, watched state, continue watching, next up | ✅ | ✅ | ✅ | ✅ |
| Skip intro / credits (audio-fingerprint detection) | Pass | Plugin | Premiere | ✅ built in |
| Auto-play next episode | ✅ | ✅ | ✅ | ✅ |
| Downloads for offline | Pass | ✅ | Premiere | ✅ (mobile apps) |
| Watch together | ✅ | ✅ | ❌ | ✅ SyncPlay rooms with join codes |
| Seek-bar preview thumbnails (trickplay) | ✅ | ✅ | ✅ | ✅ |
| Online subtitle search & auto-download (OpenSubtitles, hash matching) | ✅ | Plugin | ✅ | ✅ |
| Converted downloads (device-friendly MP4 at 1080p/720p/480p) | Pass | ✅ | Premiere | ✅ |

## Live TV & IPTV
| Feature | Plex | Jellyfin | Emby | MediaMax |
|---|:-:|:-:|:-:|:-:|
| HDHomeRun tuners | ✅ | ✅ | ✅ | ✅ |
| M3U playlists with XMLTV guide | 🟡 | ✅ | ✅ | ✅ |
| **Xtream Codes** login (live + VOD + series + EPG) | ❌ | Plugin | Plugin | ✅ native |
| Xtream VOD & series as real libraries (resume, search, watched) | ❌ | ❌ | ❌ | ✅ |
| Catch-up / timeshift (Xtream `tv_archive`, M3U `catchup-source`) | ❌ | ❌ | 🟡 | ✅ |
| Streaming XMLTV parser (huge guides, gzip) | — | ✅ | ✅ | ✅ |
| Guide grid, now/next, favourites, category hiding | ✅ | ✅ | ✅ | ✅ |
| Restream proxy (hides provider credentials) | — | ✅ | ✅ | ✅ |
| Tuner sharing (one upstream connection per channel for all viewers) | ✅ | 🟡 | ✅ | ✅ |
| Provider connection-limit awareness, account expiry display | ❌ | ❌ | ❌ | ✅ |
| DVR: one-off, series rules, new-only, keep-latest, padding | Pass | ✅ | Premiere | ✅ |

## Users & access
| Feature | Plex | Jellyfin | Emby | MediaMax |
|---|:-:|:-:|:-:|:-:|
| Multiple users, admin roles | ✅ | ✅ | ✅ | ✅ |
| Profile picker with PINs (Plex Home style) | Pass | 🟡 | ✅ | ✅ |
| Per-user library access, rating limits, permissions | ✅ | ✅ | ✅ | ✅ |
| TV sign-in with a short link code | ✅ | ✅ (Quick Connect) | ❌ | ✅ |
| Device list and remote sign-out | ✅ | ✅ | ✅ | ✅ |
| No cloud account required, fully self-hosted | ❌ | ✅ | 🟡 | ✅ |
| Single sign-on (OpenID Connect) with group → admin mapping | ❌ | Plugin | ❌ | ✅ |

## Customisation (MediaMax's headline feature)
| Feature | Plex | Jellyfin | Emby | MediaMax |
|---|:-:|:-:|:-:|:-:|
| Server name, logo, wide logo, favicon, splash, login background | ❌ | 🟡 (CSS) | 🟡 | ✅ |
| Full theme engine (13 colour tokens, radius, font, poster shape, card size, hero style) | ❌ | CSS only | ❌ | ✅ |
| Built-in theme presets + admin-made themes | ❌ | ❌ | ❌ | ✅ (8 presets) |
| Users pick from admin-approved themes | ❌ | ✅ | ❌ | ✅ |
| Server-driven home screen rows (order, type, library, genre, collection) | 🟡 | 🟡 | 🟡 | ✅ |
| Feature toggles that hide areas in every app | ❌ | ❌ | ❌ | ✅ |
| **Native apps re-skin live from the server** (no rebuild) | ❌ | ❌ | ❌ | ✅ |
| Custom CSS for the web client | ❌ | ✅ | ✅ | ✅ |

## Administration
| Feature | Plex | Jellyfin | Emby | MediaMax |
|---|:-:|:-:|:-:|:-:|
| Dashboard with live sessions, kill stream | ✅ | ✅ | ✅ | ✅ |
| Scheduled tasks with progress | ✅ | ✅ | ✅ | ✅ |
| Activity log | ✅ | ✅ | ✅ | ✅ |
| Webhooks (playback, library, login, DVR events) | Pass | Plugin | ✅ | ✅ |
| Real-time WebSocket events | ✅ | ✅ | ✅ | ✅ |
| Docker image with GPU passthrough | ✅ | ✅ | ✅ | ✅ |
| DLNA / UPnP media server (smart TVs, consoles, VLC) | ✅ | ✅ | ✅ | ✅ (LAN-only, per-user access) |
| Trakt scrobbling & watched sync | Plugin | Plugin | Plugin | ✅ built in |
| Last.fm scrobbling | ✅ | Plugin | Plugin | ✅ built in |
| Viewing statistics & yearly "Wrapped" | Pass | Plugin | Plugin | ✅ |
| User avatars | ✅ | ✅ | ✅ | ✅ |
| Hide unrated content from restricted users | ✅ | ✅ | ✅ | ✅ |
| CI (typecheck, tests, web build, Docker smoke test) | — | ✅ | — | ✅ |

## Roadmap ideas
Chromecast sender in apps · music videos · plugin API · LDAP login · remote access relay.
