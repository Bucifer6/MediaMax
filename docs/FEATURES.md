# MediaMax feature matrix

How MediaMax compares with the features people use most in Plex, Jellyfin and Emby.
✅ = implemented in this repository · 🟡 = partial · 🗺️ = roadmap

## Libraries & metadata
| Feature | Plex | Jellyfin | Emby | MediaMax |
|---|:-:|:-:|:-:|:-:|
| Movies, TV, music, photos, home videos | ✅ | ✅ | ✅ | ✅ |
| Scene-style filename parsing (`Show.S01E02`, `1x02`, daily shows, multi-episode) | ✅ | ✅ | ✅ | ✅ |
| Multiple versions of one movie (4K + 1080p) | ✅ | ✅ | ✅ | ✅ |
| Movie editions (Director's Cut, Extended…) chosen before playing | ✅ (Pass) | 🟡 | 🟡 | ✅ |
| Local extras (trailers, featurettes, deleted scenes…) | ✅ | ✅ | ✅ | ✅ |
| Local NFO metadata (Kodi/Jellyfin/Emby format) | ✅ (PMS 1.43.2+) | ✅ | ✅ | ✅ |
| Local artwork (poster/fanart/logo/season posters) | ✅ | ✅ | ✅ | ✅ |
| Online metadata (TMDB) with cast, logos, trailers, ratings | ✅ | ✅ | ✅ | ✅ |
| Built-in metadata providers: TheTVDB, fanart.tv, TheAudioDB, Audnexus, Open Library, Google Books, LRCLIB, OMDb, MusicBrainz (Server settings → Metadata: enable, keys, priority, preferred artwork source, Test, cached + rate-limited) — see [METADATA.md](METADATA.md) | 🟡 | 🟡 (some plugins) | 🟡 (some plugins) | ✅ |
| Alternative episode orderings per show (aired / DVD / absolute, via TheTVDB) | ❌ | ✅ | ✅ | ✅ |
| IMDb / Rotten Tomatoes / Metacritic rating badges (OMDb) | ✅ | 🟡 (plugin) | 🟡 | ✅ |
| "Fix match" (search TMDB / TheTVDB / MusicBrainz / Audnexus / book providers and re-fetch) | ✅ | ✅ | ✅ | ✅ |
| Automatic box-set collections | ✅ | ✅ | ✅ | ✅ |
| Manual collections & per-user playlists | ✅ | ✅ | ✅ | ✅ |
| Smart (rule-based) collections & playlists | ✅ | ❌ | ✅ | ✅ |
| Edit metadata, lock fields, upload artwork | ✅ | ✅ | ✅ | ✅ |
| Embedded album art + tag-based music library | ✅ | ✅ | ✅ | ✅ |
| `.mediamaxignore` / `.plexignore` folders | ✅ | ✅ | ❌ | ✅ |
| Safe removal (no wipe when a drive is unmounted) | ✅ | 🟡 | 🟡 | ✅ |
| Real-time filesystem watching | ✅ | ✅ | ✅ | ✅ |
| Synced lyrics (LRC sidecars, embedded tags, LRCLIB fallback) | ✅ | ✅ | ✅ | ✅ |
| Subsonic/OpenSubsonic API (Symfonium, Feishin, play:Sub…) | ❌ | Plugin | ❌ | ✅ |
| ReplayGain / R128 loudness levelling (track & album) | ✅ (Plexamp) | 🟡 | 🟡 | ✅ |
| DJ mode: BPM/key/energy analysis, automatic beat-matched crossfades, harmonic auto-playlists, non-stop mixes | 🟡 (Plexamp sweet fades) | ❌ | ❌ | ✅ |
| Anime (AniList) and MusicBrainz/Cover Art Archive metadata | 🟡 | Plugin | Plugin | ✅ (MusicBrainz built in; AniList plugin) |
| Audiobooks (multi-file & .m4b, chapters, author/narrator, resume) | 🟡 | ✅ | ✅ | ✅ |
| Podcasts (RSS, iTunes directory search, OPML import, auto-download) | ✅ | Plugin? | Plugin? | ✅ |

## Playback
| Feature | Plex | Jellyfin | Emby | MediaMax |
|---|:-:|:-:|:-:|:-:|
| Direct play / remux / transcode decision per device | ✅ | ✅ | ✅ | ✅ |
| On-demand HLS segments (instant seek anywhere) | ✅ | ✅ | ✅ | ✅ |
| Hardware transcoding (VAAPI Intel/AMD, QSV Linux/Windows, NVENC Linux/Windows, AMF, VideoToolbox, V4L2, Rockchip MPP) | Pass | ✅ | Premiere | ✅ (free, auto-fallback to software) |
| Hardware detection with test transcodes and one-click setup | ❌ | ❌ | ❌ | ✅ |
| HEVC / AV1 transcode output for capable clients (fMP4 HLS) | ✅ | ✅ | Premiere | ✅ (hardware encoders) |
| HDR → SDR tone mapping | Pass | ✅ | Premiere | ✅ |
| Hardware HDR tone mapping (VA-API, QSV, CUDA, OpenCL) | Pass | ✅ | Premiere | ✅ (CPU fallback) |
| HDR format detection: HDR10, HDR10+, HLG, Dolby Vision profile/level/fallback layer ([docs/HDR.md](HDR.md)) | 🟡 | ✅ | 🟡 | ✅ |
| Per-device HDR decisions (direct play when the device supports the range, DV 8.x → HDR10/HLG base layer, tone-map otherwise) | 🟡 | ✅ | 🟡 | ✅ |
| Dolby Vision profile 7 (dual-layer) → HDR10 base layer by stream copy, no re-encode | ❌ | 🟡 | ❌ | ✅ |
| HDR10 / HDR10+ / HLG / Dolby Vision badges in item info and the player's info overlay | ✅ | ✅ | ✅ | ✅ |
| Apple TV display matching (range + frame rate) | ✅ | ✅ | ✅ | ✅ (tvOS 17+) |
| TV remote keys: media, channel ±, digits, colour keys, Info/Guide (Tizen, webOS, Android TV) | ✅ | 🟡 | 🟡 | ✅ |
| "Hardware failed, used software" shown on the session | ❌ | ❌ | ❌ | ✅ |
| Encoder throttling (pauses ffmpeg when far ahead) | ✅ | ✅ | ✅ | ✅ |
| Sidecar & embedded text subtitles → WebVTT | ✅ | ✅ | ✅ | ✅ |
| Image subtitle (PGS/VobSub) burn-in | ✅ | ✅ | ✅ | ✅ |
| Audio track selection & language preferences | ✅ | ✅ | ✅ | ✅ |
| Resume, watched state, continue watching, next up | ✅ | ✅ | ✅ | ✅ |
| Skip intro / credits (audio-fingerprint detection) | Pass | Plugin | Premiere | ✅ built in |
| Skip recaps, previews and ad breaks (comskip / `.edl` markers) | 🟡 | 🟡 (plugins) | 🟡 | ✅ |
| Cinema mode (trailers + pre-roll before a movie) | ✅ (Pass) | ✅ (plugin) | ✅ | ✅ |
| Remote control: "Play on…" another device | ✅ | ✅ | ✅ | ✅ |
| Auto-play next episode | ✅ | ✅ | ✅ | ✅ |
| Downloads for offline | Pass | ✅ | Premiere | ✅ (mobile apps) |
| Watch together | ✅ | ✅ | Plugin? | ✅ SyncPlay rooms with join codes |
| Chromecast (web + phone apps) | ✅ | ✅ | ✅ | ✅ |
| Play to DLNA / UPnP TVs and receivers (server-controlled, one cast menu with Chromecast) | ❌ | 🟡 (DLNA plugin) | ✅ | ✅ (transcodes to MPEG-TS / MP3 / FLAC when the device needs it) |
| Play to Sonos (queue playback, group volume) | ✅ | 🟡 (as DLNA) | 🟡 (as DLNA) | ✅ |
| Play to Kodi (JSON-RPC, mDNS discovery) | ❌ | 🟡 (as DLNA) | 🟡 (as DLNA) | ✅ |
| AirPlay from the web player (Safari) and iOS app | ✅ | ✅ | ✅ | ✅ |
| Seek-bar preview thumbnails (trickplay) | ✅ | ✅ | ✅ | ✅ |
| Online subtitle search & auto-download (OpenSubtitles, hash matching) | ✅ | Plugin | ✅ | ✅ |
| Converted downloads (device-friendly MP4 at 1080p/720p/480p) | Pass | ✅ | Premiere | ✅ |

## Live TV & IPTV
| Feature | Plex | Jellyfin | Emby | MediaMax |
|---|:-:|:-:|:-:|:-:|
| HDHomeRun tuners | ✅ | ✅ | ✅ | ✅ |
| HDHomeRun / SAT>IP network discovery (UDP 65001, SSDP) | ✅ | 🟡 | 🟡 | ✅ |
| TVHeadend backend (Digest/Basic login, channel tags, stream profiles, tuner count, its EPG, recordings list) | ❌ | Plugin | Plugin | ✅ |
| SAT>IP servers (DVB-S/S2/T/T2/C over RTSP; M3U of SAT>IP URLs; FRITZ!Box Cable lists; X_SATIPCAP tuner count) | ❌ | 🟡 | ❌ | ✅ |
| Enigma2 / OpenWebif receivers (bouquet picker, picons, streamauth, transcoding port, receiver EPG) | ❌ | Plugin | Plugin | ✅ |
| Concurrent streams limited to the device's tuner count | ✅ | ✅ | ✅ | ✅ |
| M3U playlists with XMLTV guide | 🟡 | ✅ | ✅ | ✅ |
| Several merged EPG sources per playlist, provider guide as fallback | 🟡 | ✅ | ✅ | ✅ |
| Guide sources as their own entity: XMLTV URL/file (gzip, xz), per-guide priority and time-zone override | 🟡 | ✅ | ✅ | ✅ |
| Schedules Direct (lineups by country + postcode, md5-cached downloads) | ✅ | ✅ | ✅ | ✅ |
| HDHomeRun guide data (free for owners, matched by guide number) | ✅ | 🟡 | 🟡 | ✅ |
| Free community guide picker (iptv-org, epg.pw by country) | ❌ | ❌ | ❌ | ✅ |
| Automatic fuzzy channel ↔ guide matching with confidence and a review queue | 🟡 | ❌ | 🟡 | ✅ |
| Guide matching page: search every guide, now/next preview, accept all, per-channel time shift | 🟡 | 🟡 | 🟡 | ✅ |
| Guide quality report (coverage, days ahead, errors) and "missing guide" badges | ❌ | ❌ | ❌ | ✅ |
| Multiview (up to four live channels at once) | ❌ | ❌ | ❌ | ✅ (web) |
| **Xtream Codes** login (live + VOD + series + EPG) | ❌ | Plugin | Plugin | ✅ native |
| Xtream VOD & series as real libraries (resume, search, watched) | ❌ | ❌ | ❌ | ✅ |
| Catch-up / timeshift (Xtream `tv_archive`, M3U `catchup-source`) | ❌ | ❌ | 🟡 | ✅ |
| Streaming XMLTV parser (huge guides, gzip) | — | ✅ | ✅ | ✅ |
| Guide grid, now/next, favourites, category hiding | ✅ | ✅ | ✅ | ✅ |
| Restream proxy (hides provider credentials) | — | ✅ | ✅ | ✅ |
| Tuner sharing (one upstream connection per channel for all viewers) | ✅ | 🟡 | ✅ | ✅ |
| Provider connection-limit awareness, account expiry display | ❌ | ❌ | ❌ | ✅ |
| DVR: one-off, series rules, new-only, keep-latest, padding | Pass | ✅ | Premiere | ✅ |
| DVR priorities, tuner-conflict detection, day/time-window rules, skip repeats | 🟡 | 🟡 | 🟡 | ✅ |
| Commercial detection on recordings (comskip) | ✅ (Pass) | Plugin | 🟡 | ✅ |

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
| Two-factor sign-in (TOTP) with recovery codes | ✅ | ❌ | ❌ | ✅ |
| Invite links with permission templates | ✅ | Add-on | ❌ | ✅ |
| Per-user stream limits & home-network-only accounts | ✅ | ✅ | ✅ | ✅ |
| API keys for integrations | ✅ | ✅ | ✅ | ✅ |
| Media requests (Overseerr-style): movies, shows (all/first/latest/specific seasons), music (Lidarr), books (Readarr), "also in 4K", live download progress | Add-on | Add-on | Add-on | ✅ built in |

## Clients & devices
| Feature | Plex | Jellyfin | Emby | MediaMax |
|---|:-:|:-:|:-:|:-:|
| Web, iOS, Android, Apple TV, Android TV apps | ✅ | ✅ | ✅ | ✅ |
| Apple CarPlay (music, audiobooks, podcasts) | Plexamp | Third-party | Premiere | ✅ |
| Android Auto (music, audiobooks, podcasts) | Plexamp | ✅ (no audiobooks) | Premiere | ✅ |
| Samsung Tizen, LG webOS (wrapper apps + web TV mode with D-pad navigation) | ✅ | ✅ | ✅ | ✅ |
| Amazon Fire TV | ✅ | ✅ | ✅ | ✅ (Android TV build) |
| Roku, Xbox | ✅ | 🟡 | ✅ | 🗺️ |
| Desktop/HTPC app (mpv-class player) | ✅ | ✅ | ✅ | 🗺️ |

## Customisation (MediaMax's headline feature)
| Feature | Plex | Jellyfin | Emby | MediaMax |
|---|:-:|:-:|:-:|:-:|
| Server name, logo, wide logo, favicon, splash, login background | ❌ | 🟡 (CSS) | 🟡 | ✅ |
| Full theme engine (13 colour tokens, radius, font, poster shape, card size, hero style) | ❌ | CSS only | ❌ | ✅ |
| Built-in theme presets + admin-made themes | ❌ | ❌ | ❌ | ✅ (8 presets) |
| Users pick from admin-approved themes | ❌ | ✅ | ❌ | ✅ |
| Server-driven home screen rows (order, type, library, genre, collection) | 🟡 | 🟡 | 🟡 | ✅ |
| Personal recommendations (taste profile + "viewers like you", local only) | ✅ | ❌ | ❌ | ✅ |
| "Because you watched…" and Top 10 / trending rows | 🟡 | ❌ | ❌ | ✅ |
| My List (watchlist) with home row | ✅ | 🟡 (favourites) | 🟡 | ✅ |
| 👍/👎 ratings and "Not interested" | 🟡 | ❌ | ❌ | ✅ |
| Upcoming-episodes calendar (TMDB air dates + new arrivals) | 🟡 | 🟡 (plugin) | ✅ | ✅ |
| In-app new-episode notifications (live over WebSocket) | ✅ | 🟡 | ✅ | ✅ |
| Muted trailer previews in the hero and on card hover | ✅ | ❌ | ❌ | ✅ (web) |
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
| Backup & restore | ❌ | ✅ | Premiere | ✅ |
| Automatic port forwarding (UPnP) + remote access status | ✅ | ❌ | ✅ | ✅ |
| Prometheus metrics | ❌ | Plugin | ❌ | ✅ |
| Real-time WebSocket events | ✅ | ✅ | ✅ | ✅ |
| Docker image with GPU passthrough | ✅ | ✅ | ✅ | ✅ |
| Plugin system (catalog/repositories, settings UI, events, routes, tasks, metadata providers) | ❌ | ✅ | ✅ | ✅ |
| DLNA / UPnP media server (smart TVs, consoles, VLC) | ✅ | ✅ | ✅ | ✅ (LAN-only, per-user access) |
| Trakt scrobbling & watched sync | Plugin | Plugin | Plugin | ✅ built in |
| Last.fm scrobbling | ✅ | Plugin | Plugin | ✅ built in |
| Viewing statistics & yearly "Wrapped" | Pass | Plugin | Plugin | ✅ |
| User avatars | ✅ | ✅ | ✅ | ✅ |
| Hide unrated content from restricted users | ✅ | ✅ | ✅ | ✅ |
| CI (typecheck, tests, web build, Docker smoke test) | — | ✅ | — | ✅ |
| *arr suite hub: several Radarr/Sonarr/Lidarr/Readarr/Bazarr instances (incl. 4K), Test buttons, profile/root-folder pickers | ❌ | ❌ | ❌ | ✅ |
| Instant, targeted library rescans from *arr webhooks (debounced, Docker path mappings) | Add-on | Plugin | ❌ | ✅ |
| Downloads dashboard: queues, 14-day calendar, wanted/missing with Search, *arr health and disk space | ❌ | ❌ | ❌ | ✅ |
| Home Assistant over MQTT discovery: now-playing sensor per device, active streams / transcodes / bandwidth, "someone is watching" binary sensor, recently added, Scan libraries button, playback event entity, LWT availability — see [HOME_ASSISTANT.md](HOME_ASSISTANT.md) | ❌ | Plugin | ❌ | ✅ (built-in MQTT client) |
| Home Assistant webhook preset (flat JSON for HA's webhook trigger, one-click setup) + REST `GET /status/now-playing` for REST sensors / Homepage | 🟡 (Pass webhooks) | Plugin | 🟡 | ✅ |
| NAS disk spin-down friendly: maintenance window for scans, thumbnails, trickplay, intro/DJ/HDR analysis and subtitle matching; piggybacks on disks that are awake (playback, file changes) | ❌ | ❌ | ❌ | ✅ |
| Per-library disk state (active / idle / standby via hdparm, smartctl or /sys, never wakes a disk), directory-only inotify watching, opt-in long-interval polling for network shares | ❌ | ❌ | ❌ | ✅ (Linux) |
| Media-folder artwork served from a cached copy in the data dir (browsing never wakes a media disk) | 🟡 | ❌ | ❌ | ✅ |

### Media automation (*arr suite)
MediaMax can be the hub of a Radarr/Sonarr/Lidarr/Readarr/Bazarr setup (**Admin → Server settings → Media automation (*arr)**):

* **Any number of instances per app**, each with name, URL, write-only API key, enabled flag, quality profile, root folder,
  metadata profile (Lidarr/Readarr), tags, monitor option, season folders and "search on add". The **Test** button checks
  `/system/status` and loads the profile, root-folder and tag pickers from the instance. Mark a Radarr/Sonarr as **4K** to
  offer "Also request in 4K" (admins, and users with the *Request in 4K* permission).
* **Requests** go to the first enabled non-4K instance of the right kind: movies → Radarr, shows → Sonarr (all, first,
  latest or specific seasons), artists/albums → Lidarr (artist: all or only future albums), books → Readarr. Discover has
  Movies / Shows / Music / Books tabs; Music and Books search Lidarr's and Readarr's own lookup (no TMDB key needed) and only
  appear when such an instance exists. Approval, auto-approve users and weekly limits work as before. While a request is in
  an *arr queue its status reads "Downloading 42%".
* **Webhooks**: add one *Webhook* connection per app (Settings → Connect → Webhook, triggers On Import / Upgrade / Rename /
  Delete) pointing at the URL shown in the settings tab. MediaMax works out the folder the event touched, maps it through
  the instance's path mappings (`/movies` → `/media/Movies`), rescans only the library that contains it, debounces bursts
  (a season pack is one scan within about 10 s) and then marks matching requests as available. Events are logged to
  Activity. The URL carries a random secret, compared in constant time; regenerate it from the settings tab.
* **Downloads dashboard** (**Admin → Downloads**): queue with quality, progress, size, time left, status and warnings
  (refreshes every 10 s), upcoming releases for the next 14 days, the top 50 missing titles with a **Search** button,
  health checks and disk space per instance (Bazarr included). An unreachable instance shows a red card; the others keep working.
* Existing single Radarr/Sonarr settings are migrated automatically (the old fields stay as a fallback).
* For item pages there is a ready-made admin component (`web/src/components/ArrItemActions.tsx`): "Open in Radarr/Sonarr/Lidarr",
  "Search for upgrade" and "Find subtitles with Bazarr", backed by `GET /arr/item/:id` and `POST /arr/item/:id/subtitles`.

## Roadmap
See the ranked [ROADMAP](ROADMAP.md) (gap analysis against Plex, Jellyfin, Emby, Channels DVR, TiviMate, Audiobookshelf, Navidrome/Plexamp, Infuse and Kodi).

<!-- legacy ideas -->
Plugin API · music videos · LDAP login · remote access relay.
