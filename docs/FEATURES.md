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
| Synced lyrics (LRC sidecars, embedded tags incl. ID3 SYLT, LRCLIB fallback) | ✅ | ✅ | ✅ | ✅ |
| Word-by-word karaoke lyrics (enhanced LRC / SYLT word timing, wipe on line-timed lyrics) | ❌ | 🟡 | ❌ | ✅ |
| Lyrics editor (tap-to-sync, import/export .lrc) and per-user lyrics timing offsets | ❌ | 🟡 | ❌ | ✅ |
| Karaoke mode: instant vocal reduction + AI vocal separation (HT-Demucs stems, playable on every device) | ❌ | ❌ | ❌ | ✅ |
| Music visualisers (cover ring, bars, waveform, starfield, ambient) and TV music screensaver | ❌ | ❌ | ❌ | ✅ |
| Full-screen now playing (cover / lyrics / visualiser / karaoke) | ✅ | ✅ | ✅ | ✅ |
| Subsonic/OpenSubsonic API (Symfonium, Feishin, play:Sub…) | ❌ | Plugin | ❌ | ✅ |
| ReplayGain / R128 loudness levelling (track & album) | ✅ (Plexamp) | 🟡 | 🟡 | ✅ |
| DJ mode: BPM/key/energy analysis, automatic beat-matched crossfades, harmonic auto-playlists, non-stop mixes | 🟡 (Plexamp sweet fades) | ❌ | ❌ | ✅ |
| DJ phrase detection (intro/verse/build/drop/breakdown/outro on 8/16/32-bar lines); mixes start on phrase boundaries (outro → intro) | ❌ | ❌ | ❌ | ✅ |
| DJ transition styles: EQ bass swap, filter fade, echo-out, blend/fade/cut — chosen per pair, with an auto/smooth/energetic/minimal preference | ❌ | ❌ | ❌ | ✅ (full effects on web; volume-shaped on phone/TV) |
| DJ tempo matching with key lock (±8 % default, half/double time aware), glide back over N bars or stay | 🟡 (Plexamp sweet fades, no beat-matching) | ❌ | ❌ | ✅ (browser time-stretch or WSOLA AudioWorklet) |
| Hear a planned DJ transition rendered by the server (ffmpeg: bass swap, filter, echo, rubberband/atempo) | ❌ | ❌ | ❌ | ✅ |
| Anime (AniList) and MusicBrainz/Cover Art Archive metadata | 🟡 | Plugin | Plugin | ✅ (MusicBrainz built in; AniList plugin) |
| MusicBrainz Picard tags (recording/release/release-group/artist MBIDs): MBID-based album/artist grouping, recording ids filled from the release, release types | 🟡 | ✅ | ✅ | ✅ |
| Multi-artist credits ("A feat. B & C" with each artist linked, "Appears on", search by featured artist) | 🟡 | ✅ | 🟡 | ✅ |
| Artist discography by release type, missing albums from MusicBrainz with one-click Lidarr request, members / related / similar artists | 🟡 (no missing) | Plugin | 🟡 | ✅ |
| AcoustID "Identify by sound" for untagged tracks (DB only, files untouched; optional auto-apply) | ❌ | ❌ | Plugin | ✅ |
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
| Real Dolby Vision through remuxed HLS (fMP4 with `dvcC`/`dvvC`, `dvh1`/`hvc1` sample entry, DV `CODECS` / `SUPPLEMENTAL-CODECS` / `VIDEO-RANGE` in the master playlist): profiles 5, 8.1, 8.4, 10 (AV1), and 7 for devices that list it | 🟡 | ✅ | 🟡 | ✅ |
| Dolby Vision on LG webOS TVs and DV-capable browsers (MediaMax: through its own hls.js/MSE engine, detected with `MediaSource.isTypeSupported`/`MediaCapabilities`, with an Auto / Yes / No override per device) | ✅ | ✅ | 🟡 | ✅ |
| HDR10 / HDR10+ / HLG / Dolby Vision badges in item info and the player's info overlay | ✅ | ✅ | ✅ | ✅ |
| Audio format detection: Dolby Atmos (TrueHD / E-AC-3 JOC), DTS:X, DTS-HD MA, lossless, channel layout ([docs/AUDIO.md](AUDIO.md)) | 🟡 | 🟡 | 🟡 | ✅ |
| Dolby Atmos / DTS:X / DTS-HD MA / TrueHD / 7.1 badges in item info, the player's audio menu and stats | ✅ | 🟡 | 🟡 | ✅ |
| Per-device audio decisions: passthrough when the device or its receiver takes the format, else the best target it plays | 🟡 | 🟡 | 🟡 | ✅ |
| DTS-HD MA / DTS:X → DTS core by stream copy (no re-encode) for DTS-only soundbars | ❌ | ❌ | ❌ | ✅ |
| TrueHD (Atmos) / DTS → E-AC-3 5.1 for TVs + soundbars (ARC) and Apple TV | 🟡 | 🟡 | 🟡 | ✅ |
| AAC 7.1 / 5.1 transcodes by output channels; Dolby-style stereo downmix that keeps dialogue clear (level-tested) | 🟡 | 🟡 (downmix options) | 🟡 | ✅ |
| Audio-only re-encode when only the audio is the problem (video copied) | ✅ | ✅ | ✅ | ✅ |
| Night mode (dynamic range compression) and dialogue boost: server-side, or in the browser during direct play | 🟡 (boost voices, Plexamp-style loudness) | 🟡 (downmix "night mode") | ❌ | ✅ |
| Loudness normalisation for video (EBU R128) | 🟡 | 🟡 | ❌ | ✅ |
| Audio delay / lip-sync per device (browser delay during direct play, server shift for negative offsets) | 🟡 | ✅ (client) | 🟡 | ✅ |
| HLS master playlists list E-AC-3 as `ec-3`, Atmos as `CHANNELS="16/JOC"` | ✅ | 🟡 | ❓ | ✅ |
| Apple TV display matching (range + frame rate) | ✅ | ✅ | ✅ | ✅ (tvOS 17+) |
| TV remote keys: media, channel ±, digits, colour keys, Info/Guide (Tizen, webOS, Android TV) | ✅ | 🟡 | 🟡 | ✅ |
| "Hardware failed, used software" shown on the session | ❌ | ❌ | ❌ | ✅ |
| Encoder throttling (pauses ffmpeg when far ahead) | ✅ | ✅ | ✅ | ✅ |
| Sidecar & embedded text subtitles → WebVTT | ✅ | ✅ | ✅ | ✅ |
| Own subtitle renderer in every player, incl. Tizen/webOS TV mode — never the platform's text tracks or parser ([docs/PLAYBACK.md](PLAYBACK.md)) | 🟡 | 🟡 | 🟡 | ✅ |
| ASS/SSA with full styling in the browser (libass/WASM, embedded MKV fonts, karaoke, animation; simplified fallback without WASM) | 🟡 | ✅ | 🟡 | ✅ |
| PGS (Blu-ray) subtitles decoded in the browser, no transcode | ❌ | ✅ | ❌ | ✅ |
| Subtitles in original format (SRT/ASS/SUP) with partial extraction for long files, teletext → text | 🟡 | 🟡 | 🟡 | ✅ |
| Image subtitle (PGS/VobSub) burn-in | ✅ | ✅ | ✅ | ✅ (explicit last resort: VobSub/DVB, PGS on native apps) |
| Automatic quality: bandwidth probe at start, live throughput/buffer/dropped-frame ABR with hysteresis ([docs/PLAYBACK.md](PLAYBACK.md)) | ✅ | 🟡 | ✅ | ✅ |
| Adaptive transcodes: multi-rendition HLS ladder, renditions encoded lazily on demand with aligned segments | 🟡 | ❌ | 🟡 | ✅ |
| Direct play ↔ transcode switch on connection change, seamless (old stream plays while the new one loads) | 🟡 | ❌ | 🟡 | ✅ |
| Remote (WAN) bitrate limit; LAN unlimited unless measured otherwise | ✅ | ✅ | ✅ | ✅ |
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
| Trickplay in the native apps (phone drag, Android TV / Apple TV D-pad and Siri Remote seek) with chapter names, offline with downloads, data-saver mode | ✅ | 🟡 | ✅ | ✅ |
| Trickplay on Samsung/LG TV (web TV mode) while seeking with the remote | ✅ | 🟡 | 🟡 | ✅ |
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
| Account profiles under one login ("Who's watching?"): own history, My List, recommendations, settings; built-in avatars | ✅ (Home) | ❌ | 🟡 | ✅ |
| Kids profiles: rating limit, hide unrated, kids theme, no requests, Live TV off by default, PIN to leave | ✅ | ❌ | 🟡 | ✅ |
| Profiles share the account's stream limit and request quota; never more access than the owner | 🟡 | ❌ | ❌ | ✅ |
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

### Requests vs. Overseerr / Jellyseerr
MediaMax has the request app built in — no separate Overseerr/Jellyseerr container, no second user database.

| Feature | Overseerr | Jellyseerr | MediaMax |
|---|:-:|:-:|:-:|
| Per-user request permissions per kind (movies, shows, 4K movies, 4K shows) | ✅ | ✅ | ✅ (+ music & books) |
| Auto-approve per user and kind | ✅ | ✅ | ✅ (`none` / `request` / `auto`) |
| Request managers (approve without being admin) | ✅ | ✅ | ✅ |
| Default permissions for new users, bulk edit | ✅ | ✅ | ✅ (also via invites / SSO) |
| Quotas: N movies / N seasons per X days, per user and default | ✅ | ✅ | ✅ (+ music, books; exemptions) |
| Remaining quota shown when requesting | ✅ | ✅ | ✅ |
| Approve / decline with reason, bulk actions, filters & sort | ✅ | ✅ | ✅ |
| Edit before approve (server, quality profile, root folder, tags, language profile, seasons) | ✅ | ✅ | ✅ |
| Retry failed requests, delete with "also remove from Radarr/Sonarr" | ✅ | ✅ | ✅ |
| Per-season availability, request missing seasons of partially available shows | ✅ | ✅ | ✅ |
| Request timeline and comments between requester and admins | 🟡 | 🟡 | ✅ |
| Notifications: in-app, Discord, Slack, Telegram, ntfy, Gotify, Pushover, email, webhook — per-event toggles and Test | ✅ | ✅ | ✅ |
| Issues: report video/audio/subtitle problems per item/season/episode, comments, resolve/reopen | ✅ | ✅ | ✅ (+ Radarr/Sonarr/Bazarr actions) |
| Discover sliders: trending, popular, upcoming, top rated, genres, studios/networks | ✅ | ✅ | ✅ |
| Person pages with filmography and request buttons | ✅ | ✅ | ✅ |
| Recently requested / recently added rows, hide available | ✅ | ✅ | ✅ |
| Blacklist titles | ❌ | ✅ | ✅ |
| Watchlist auto-request | ✅ (Plex watchlist) | 🟡 | ✅ (Discover watchlist) |
| Auto-approve titles rated ≥ X | ❌ | ❌ | ✅ |
| Music and book requests (Lidarr/Readarr) | ❌ | 🟡 | ✅ |

## Clients & devices
| Feature | Plex | Jellyfin | Emby | MediaMax |
|---|:-:|:-:|:-:|:-:|
| Web, iOS, Android, Apple TV, Android TV apps | ✅ | ✅ | ✅ | ✅ |
| Apple CarPlay (music, audiobooks, podcasts) | Plexamp | Third-party | Premiere | ✅ (±15/30 s for audiobooks, podcasts and long mixes alongside next/previous, speed button; Siri "Play … in MediaMax" opt-in) |
| Android Auto (music, audiobooks, podcasts) | Plexamp | ✅ (no audiobooks) | Premiere | ✅ (±15/30 s for audiobooks, podcasts and long mixes alongside next/previous, speed button; Google Assistant "play …", seek and speed by voice) |
| Samsung Tizen, LG webOS (wrapper apps + web TV mode with D-pad navigation) | ✅ | ✅ | ✅ | ✅ |
| Amazon Fire TV | ✅ | ✅ | ✅ | ✅ (Android TV build) |
| Roku, Xbox | ✅ | 🟡 | ✅ | 🗺️ |
| Desktop/HTPC app (mpv-class player) | ✅ | ✅ | ✅ | 🗺️ |

## Customisation (MediaMax's headline feature)
| Feature | Plex | Jellyfin | Emby | MediaMax |
|---|:-:|:-:|:-:|:-:|
| Server name, logo, wide logo, favicon, splash, login background | ❌ | 🟡 (CSS) | 🟡 | ✅ |
| Full theme engine (13 colour tokens, radius, font, poster shape, card size, hero style) | ❌ | CSS only | ❌ | ✅ |
| Built-in theme presets + admin-made themes | ❌ | ❌ | ❌ | ✅ (26 themes, all WCAG AA) |
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
| ListenBrainz scrobbling (MBIDs, offline queue, love/hate feedback) + weekly playlists & recommendations matched to the library | ❌ | Plugin | Plugin | ✅ built in |
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
  appear when such an instance exists. While a request is in an *arr queue its status reads "Downloading 42%".

### Requests: permissions, quotas, approval, issues
* **Permissions** (**Admin → Users → Edit**, *Default permissions*, or select several users → *Edit permissions*): for movies,
  shows, 4K movies, 4K shows, music and books each user gets **No** (Discover hides the request button, the API answers 403),
  **Request** (needs approval) or **Auto** (approved and sent to the *arr right away). Plus *Manage requests* (a non-admin
  request manager who can approve, decline, edit and delete requests, handle issues and the blacklist), *Report issues* and
  *Auto-request from watchlist*. New users (admin-created, invites, SSO) get the default permissions; invites can carry their
  own. Users from before this existed keep what they had: the old *Request in 4K* switch and the auto-approve user list
  are read as a fallback until the user is edited.
* **Quotas**: per user or the server default, "N per X days" for movies, TV (counts **seasons**, like Overseerr), music and
  books, over a rolling window; declined requests don't count. Admins are never limited; request managers and users with
  *Auto* for a kind can be exempt. The remaining quota shows on Discover, in the request dialog and on *My requests*. The old
  weekly limit seeds the default quota.
* **Approval** (**Requests**): filter by status, type and user, sort, select and bulk approve/decline/delete, decline with a
  reason, **Edit** to change seasons, 4K and the Radarr/Sonarr instance, quality profile, root folder, language profile and
  tags before approving, **Retry** failed requests, and delete with *Also remove from Radarr/Sonarr*. Each request has a
  timeline (requested, approved, sent, failed, available, edited) and comments between requester and managers. Global rule:
  auto-approve movie/show requests rated at least X on TMDB (Admin → Server settings → Requests).
* **Shows**: the request dialog lists every season with its library and request status; for partially available shows only
  the missing seasons are offered and requested, and the request turns *available* once every requested season has arrived.
* **Blacklist**: managers blacklist a title from its Discover card; nobody can request it and it's hidden from Discover.
* **Notifications**: in-app (bell) for new requests (to managers), approved / declined with reason / available (to the
  requester), failed (to managers), comments, and issues. **Admin → Server settings → Notifications** adds Discord, Slack,
  Telegram, ntfy, Gotify, Pushover, email (SMTP) and JSON-webhook agents with per-event toggles and a Test button; the JSON
  webhooks gain `request.approved/declined/failed` and `issue.created/resolved`.
* **Issues**: *Report issue* (flag button on an item page) for video, audio, subtitle or other problems, for a whole title or
  a season/episode, with a message. Managers see all issues under **Issues**, reply, resolve and reopen; reporters see their
  own. The issue page links to the *arr actions (search for upgrade, Bazarr subtitles) when the title matches an instance.
* **Discover**: sliders for your watchlist, recently added, recently requested, trending, popular / upcoming / top-rated
  movies and shows, genre lists (also by studio `studio-<id>` and network `network-<id>`), people search and person pages
  with request buttons, and a *Hide what's in the library* toggle. The heart menu on a card adds it to your Discover
  watchlist; with *Auto-request from watchlist* that also requests it.
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
