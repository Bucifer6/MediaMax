<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="branding/mediamax/wordmark-tagline-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="branding/mediamax/wordmark-tagline-light.svg">
  <img alt="MediaMax: Stream without limits." src="branding/mediamax/wordmark-tagline-light.svg" width="460">
</picture>

**One self-hosted server for movies, TV, music, audiobooks, podcasts, photos, live TV and IPTV, with apps that wear *your* brand.**

[![Built with Claude Code](https://img.shields.io/badge/Built%20with-Claude%20Code-D97757?logo=anthropic&logoColor=white)](https://claude.com/claude-code)
[![License: MIT](https://img.shields.io/badge/License-MIT-2362FA.svg)](LICENSE)
[![CI](https://github.com/Bucifer6/MediaMax/actions/workflows/ci.yml/badge.svg)](https://github.com/Bucifer6/MediaMax/actions/workflows/ci.yml)
[![Native apps](https://github.com/Bucifer6/MediaMax/actions/workflows/apps.yml/badge.svg)](https://github.com/Bucifer6/MediaMax/actions/workflows/apps.yml)

[Features](#features) · [Screenshots](#screenshots) · [Themes](#themes) · [Install](#install) · [Apps](#apps) · [Docs](#documentation) · [Built with Claude Code](#built-with-claude-code)

![MediaMax home screen](docs/screenshots/home.jpg)

</div>

MediaMax brings together the features people love in **Plex, Jellyfin and Emby** and the polish of the big streaming services. It adds first-class **Xtream Codes IPTV** and **TV tuners**, a beat-matching **DJ mode** with an optional **AI DJ**, built-in **requests** and **profiles**, **Home Assistant** and **Play to** support, and a **one-command secure deployment** that fits next to the reverse proxy you already run. Every client (web, iOS, Android, Apple TV, Android TV, Fire TV, Samsung and LG TVs) takes its logo, colours, fonts, home layout and features from your server, applied live with no app rebuild.

> [!NOTE]
> **This entire project, from the server and web app to the mobile and TV apps, deployment kit, docs and tests, was designed and written by [Claude Code](https://claude.com/claude-code)**, Anthropic's agentic coding tool, working from a short brief. See [Built with Claude Code](#built-with-claude-code).

---

## Features

<table>
<tr><td width="50%" valign="top">

**🎬 Libraries & playback**
- Movies, TV, music, audiobooks, podcasts, photos, home videos
- Local NFO/artwork, TMDB, plus TheTVDB, fanart.tv, TheAudioDB, Audnexus, MusicBrainz and more ([docs/METADATA.md](docs/METADATA.md))
- Direct play, remux or transcode per device, with on-demand HLS and instant seeking
- **Hardware transcoding** (VA-API, QSV, NVENC, AMF, VideoToolbox, V4L2, Rockchip) with one-click detection and test transcodes
- **Automatic quality**: bandwidth probe at start, adaptive multi-rendition transcodes and seamless direct-play ↔ transcode switching ([docs/PLAYBACK.md](docs/PLAYBACK.md))
- Our own subtitle renderer in every player (SRT/WebVTT, ASS with libass and embedded fonts, PGS), with styling and sync
- Skip intro, credits, recaps and ad breaks; editions and extras; cinema mode; watch-together rooms
- **Trickplay** scrub previews on the web, Samsung/LG TVs, phones, Android TV and Apple TV, offline too
- OpenSubtitles search, picture-in-picture, stats overlay that explains every playback decision

</td><td width="50%" valign="top">

**🌈 Picture & sound**
- HDR10, HDR10+, HLG and **Dolby Vision** detection (profile, level, fallback layer) with badges ([docs/HDR.md](docs/HDR.md))
- **Real Dolby Vision** through a remux that keeps the Dolby Vision signalling, for devices that decode it (LG TVs, Safari and other Dolby Vision browsers, Android, Apple TV); the HDR10/HLG base layer or a natural SDR tone-map for everything else
- Dolby Atmos, DTS:X and DTS-HD MA detection; passthrough to your receiver when the device can take it, and **smart fallbacks** when it can't (DTS core by stream copy, E-AC-3 5.1 for soundbars, a clear stereo downmix) ([docs/AUDIO.md](docs/AUDIO.md))
- Night mode, dialogue boost, loudness normalisation and per-device lip-sync

</td></tr>
<tr><td valign="top">

**📺 Live TV, IPTV & tuners**
- **Xtream Codes**, M3U and HDHomeRun, with VOD and series as real libraries
- **TVHeadend, SAT>IP and Enigma2** receivers, limited to the device's tuner count ([docs/TUNERS.md](docs/TUNERS.md))
- TV guide from XMLTV, Schedules Direct, HDHomeRun and community guides, with **fuzzy channel matching** and a review page ([docs/EPG.md](docs/EPG.md))
- Catch-up and timeshift, plus tuner sharing (one upstream connection per channel)
- **Multiview**: up to four channels at once
- DVR with series rules, priorities, conflict detection and comskip ad markers

</td><td valign="top">

**🎧 Music, lyrics & DJ**
- Gapless playback, crossfade, ReplayGain, song and artist radio
- **MusicBrainz**: Picard tags, multi-artist credits, discographies with missing albums, AcoustID "identify by sound"
- **Lyrics & karaoke**: word-by-word highlighting, a lyrics editor, instant vocal removal and AI vocal separation (the onnxruntime-web runtime is downloaded on first use and checked against its SHA-512 hash) ([docs/KARAOKE.md](docs/KARAOKE.md))
- **Visualisers** in the full-screen player and a music screensaver on TVs
- **DJ mode**: BPM, key, energy and phrase analysis; harmonic mixes that change track on phrase boundaries with beat-matched EQ bass swaps, filter fades and echo-outs, tempo-matched with key lock
- **AI DJ**: ask in plain words ("chilled 90s house, 1 hour"); a voice host talks between songs. Free by default; can use local models (Ollama) or free and cheap hosted APIs
- Last.fm and ListenBrainz scrobbling, Subsonic/OpenSubsonic API for Symfonium, Feishin, Sonos and more
- **CarPlay and Android Auto**: ±15/30 s skips for audiobooks, podcasts and long mixes, a speed button, and voice commands

</td></tr>
<tr><td valign="top">

**🙋 Requests, discovery & profiles**
- **Built-in requests** (Overseerr/Jellyseerr-style) into Radarr, Sonarr, Lidarr and Readarr: per-user permissions per kind, quotas, auto-approve, request managers, edit-before-approve, comments and notifications
- **Issues**: report video, audio or subtitle problems; admins reply and resolve
- Recommended for you, Because you watched, Top 10, trailer previews, upcoming-episodes calendar, My List, per-user "Wrapped"
- **Profiles** ("Who's watching?") with PINs and **kids mode** (rating limit, kids theme, no requests)
- **Help Centre** built into every server, with search and keyboard shortcuts ([docs/HELP.md](docs/HELP.md))

</td><td valign="top">

**📡 Play to & smart home**
- **Play to** DLNA/UPnP TVs and receivers, **Kodi** and **Sonos** from the server, alongside Chromecast and **AirPlay**, in one cast menu
- **Home Assistant** over MQTT discovery: now-playing sensors per device, "someone is watching", streams and bandwidth, plus a webhook preset and a REST sensor ([docs/HOME_ASSISTANT.md](docs/HOME_ASSISTANT.md))
- **NAS disk spin-down**: background work waits for a maintenance window or a disk that is already awake ([docs/INSTALL.md](docs/INSTALL.md#nas--disk-spin-down))
- **TV remote keys** on Samsung, LG and Android TV: media keys, channel ±, digits, colour keys, Info and Guide

</td></tr>
<tr><td valign="top">

**🔐 Network & security**
- **No reverse proxy by default**: MediaMax drops in behind the Nginx, Traefik, Caddy or tunnel you already run. Choose *Direct*, *Behind my reverse proxy* or **built-in HTTPS** (bundled Caddy, free certificate) on the admin **Network** page ([docs/DEPLOY.md](docs/DEPLOY.md#network--https-admin--network))
- **Security dashboard**: sign-in attempts, proxy traffic, HTTPS certificate, and CrowdSec/fail2ban bans with one-click unban
- Two-factor sign-in, invite links, single sign-on (OIDC), API keys, per-user stream limits, home-network-only accounts
- Hardened by an audit: content security policy, SSRF-safe fetching with DNS pinning, sessions revoked on password change, remote-streaming rules on every media endpoint

</td><td valign="top">

**🧩 Integrations, admin & branding**
- *arr hub (several Radarr/Sonarr/Lidarr/Readarr/Bazarr instances) with a **downloads dashboard** and instant imports
- Trakt, OpenSubtitles, Bazarr, DLNA server, webhooks, notification agents (Discord, Telegram, ntfy, email…), Prometheus metrics
- Plugin system, backups and restore, UPnP port mapping, scheduled tasks, activity log
- **Branding studio** and 26 themes; every app re-skins live from the server. The MediaMax **brand kit** (logo, app icons, splash and store art) lives in [`branding/mediamax`](branding/mediamax/README.md)

</td></tr>
</table>

The full comparison with Plex, Jellyfin and Emby is in **[docs/FEATURES.md](docs/FEATURES.md)**.

## Screenshots

All screenshots come from a fictional demo library and are regenerated with `npm run screenshots` (see [Development & testing](#development--testing)).

**Watching**

| | |
|---|---|
| ![Movie details](docs/screenshots/item-movie.jpg) **Movie details**: editions, extras, cast, ratings | ![Show](docs/screenshots/item-show.jpg) **TV shows**: seasons, next up, upcoming episodes |
| ![Player](docs/screenshots/player.jpg) **Player**: skip markers, subtitles, audio and quality menus | ![Dolby Vision in the player](docs/screenshots/player-hdr.jpg) **Stats for nerds**: a Dolby Vision 8.1 film with E-AC-3 5.1, and why this browser gets a tone-mapped transcode |
| ![Trickplay](docs/screenshots/trickplay.jpg) **Trickplay**: a preview of every point on the seek bar | ![Play to](docs/screenshots/play-to.jpg) **Play to** Kodi, DLNA TVs and Sonos from the player |
| ![TV guide](docs/screenshots/livetv-guide.jpg) **TV guide** with catch-up and one-click recording | ![Multiview](docs/screenshots/multiview.jpg) **Multiview**: four live channels at once |
| ![Calendar](docs/screenshots/calendar.jpg) **Calendar** of new and upcoming episodes | ![My List](docs/screenshots/my-list.jpg) **My List** |

**Music & DJ**

| | |
|---|---|
| ![Music](docs/screenshots/music.jpg) **Music** with gapless playback and radio | ![Lyrics](docs/screenshots/lyrics.jpg) **Lyrics** highlighted word by word, with karaoke controls |
| ![Visualiser](docs/screenshots/visualiser.jpg) **Visualisers**: cover ring, bars, waveform, starfield, ambient | ![AI DJ](docs/screenshots/dj-ask.jpg) **AI DJ**: describe the mix, the host does the rest |
| ![DJ booth](docs/screenshots/dj.jpg) **DJ mode**: beat-matched two-deck mixing, mid bass swap | ![DJ set list](docs/screenshots/dj-mix.jpg) **The set list**: each transition's style, phrase and tempo change |

**Requests & household**

| | |
|---|---|
| ![Who's watching?](docs/screenshots/profiles.jpg) **Profiles** with PINs and a kids profile | ![Discover](docs/screenshots/discover.jpg) **Discover**: request what isn't in the library yet |
| ![Requests](docs/screenshots/requests.jpg) **Requests** waiting for approval | ![Issues](docs/screenshots/issues.jpg) **Issues**: viewers report problems, admins reply and resolve |
| ![Help Centre](docs/screenshots/help.jpg) **Help Centre**, built into every server | ![Downloads](docs/screenshots/admin-downloads.jpg) **Downloads**: Radarr and Sonarr queues, upcoming and missing |

**Running the server**

| | |
|---|---|
| ![Admin](docs/screenshots/admin-dashboard.jpg) **Admin dashboard**: live sessions, stats, tasks | ![Network](docs/screenshots/admin-network.jpg) **Network**: Direct by default, your own proxy, or built-in HTTPS |
| ![Security](docs/screenshots/admin-security.jpg) **Security**: sign-ins, CrowdSec, fail2ban, proxy and certificate | ![Smart home](docs/screenshots/admin-smarthome.jpg) **Smart home**: Home Assistant over MQTT |
| ![Storage](docs/screenshots/admin-storage.jpg) **Storage**: let NAS disks sleep | ![Guide matching](docs/screenshots/guide-matching.jpg) **Guide matching**: every channel matched to the guide, with confidence |
| ![Branding studio](docs/screenshots/branding-studio.jpg) **Branding studio**: live preview, every app re-skins | ![Starter looks](docs/screenshots/starter-looks.jpg) **Starter looks**: one click to a whole new feel |

<p align="center">
  <img src="docs/screenshots/mobile-home.jpg" alt="Phone" height="420">
  &nbsp;&nbsp;
  <img src="docs/screenshots/tv-mode.jpg" alt="TV mode" height="420">
  <br><em>On a phone, and on a TV with remote-control navigation</em>
</p>

## Themes

26 built-in themes, each with its own colours, font, card shape and hero style, and every one meets **WCAG AA contrast**. New servers start on the **MediaMax** theme (the brand's cyan, blue and magenta with Plus Jakarta Sans); admins pick the default, can let people choose their own, or design new ones in the Branding Studio. **Starter looks** (Home Cinema, Family & Kids, Music Lover, Live TV & IPTV, Minimal, Easy to See) set the theme, home rows and features in one click.

![Theme gallery](docs/screenshots/themes-grid.jpg)

<details>
<summary>All 26 themes</summary>

| Dark | | | Light & special |
|---|---|---|---|
| **MediaMax** (default) | | | **MediaMax Light** |
| Midnight | Cinema Gold | Oceanic | Daylight |
| Crimson | Emerald | Pure OLED | Paper White |
| Synthwave | Nordic Frost | Velvet Night | Sakura |
| Sunset Boulevard | Forest Cabin | Retro Arcade | Fresh Mint |
| Film Noir | Aurora | Espresso | Playground (Kids) |
| Slate Pro | Stadium (Sports) | Festive | High Contrast (accessibility) |

</details>

## Install

FFmpeg is included in every option. Then open `http://<server>:8484` and follow the setup wizard.

| Platform | How |
|---|---|
| **Linux server, secure & public** | `curl -fsSL https://raw.githubusercontent.com/Bucifer6/MediaMax/main/deploy/install.sh \| sudo bash` sets up Docker, **CrowdSec** and/or **fail2ban**, your media folders read-only, hardware transcoding and hardened defaults. It installs **no reverse proxy by default** (`--proxy none`), so it fits behind the one you already run; add `--proxy caddy` or `--proxy nginx` for HTTPS with a free certificate, `--proxy tunnel` for Cloudflare Tunnel, or `--builtin-https` to turn on MediaMax's own HTTPS later from **Admin → Network**. See [docs/DEPLOY.md](docs/DEPLOY.md) |
| **Docker** (amd64, arm64) | `docker run -d -p 8484:8484 -v "$PWD/config:/config" -v /path/to/media:/media:ro ghcr.io/bucifer6/mediamax` |
| **NAS**: Synology, QNAP, Unraid, TrueNAS SCALE, OpenMediaVault | ready-made templates in [`nas/`](nas) |
| **Windows** x64 | `mediamax-<version>-windows-x64.zip` from [Releases](https://github.com/Bucifer6/MediaMax/releases/latest): run `MediaMax.cmd`, or `install-service.ps1` to start at boot |
| **Linux** x64 / arm64 | `mediamax-<version>-linux-<arch>.tar.gz`: run `./mediamax`, or install the included systemd unit |

Step-by-step guides, hardware transcoding, upgrades and backups are in **[docs/INSTALL.md](docs/INSTALL.md)**. Optional free add-ons for the AI DJ (Ollama, Kokoro, Piper) are covered there too.

<details>
<summary><b>From source</b></summary>

Requires **Node.js 22.5+** and **FFmpeg** on the PATH.

```bash
npm install
```
```bash
npm run build
```
```bash
npm start
```

The server listens on port **8484** and serves the web app and API. For development, run `npm run dev:server` and `npm run dev:web`.

</details>

<details>
<summary><b>Configuration (environment variables)</b></summary>

| Variable | Default | Purpose |
|---|---|---|
| `MEDIAMAX_PORT` | `8484` | HTTP port |
| `MEDIAMAX_HOST` | `0.0.0.0` | Address to listen on (`127.0.0.1` behind a local reverse proxy) |
| `MEDIAMAX_DATA` | `./data` ([binaries and Docker](docs/INSTALL.md#where-your-data-lives-and-backups) differ) | Database, caches, branding assets, logs |
| `MEDIAMAX_TRANSCODE_DIR` | `$DATA/transcodes` | HLS segment scratch space (a RAM disk is ideal) |
| `MEDIAMAX_RECORDINGS` | `$DATA/recordings` | DVR output folder |
| `MEDIAMAX_FFMPEG` / `MEDIAMAX_FFPROBE` | bundled, else on the PATH | Custom binaries (e.g. jellyfin-ffmpeg) |
| `MEDIAMAX_HWACCEL` | `none` | Initial hardware accelerator |
| `MEDIAMAX_TRUSTED_PROXIES` | loopback + private ranges | Proxies whose `X-Forwarded-*` headers are trusted |
| `TMDB_API_KEY` | | Online metadata (also settable in the admin UI) |
| `OPENSUBTITLES_API_KEY`, `SUBSRO_API_KEY`, `TRAKT_CLIENT_ID` / `TRAKT_CLIENT_SECRET`, `LASTFM_API_KEY` / `LASTFM_SECRET`, `ACOUSTID_API_KEY` | | Initial integration keys (the admin UI can set them too) |
| `MEDIAMAX_WEB_DIR` / `MEDIAMAX_HELP_DIR` | bundled | Serve the web app / Help Centre articles from another folder |
| `MEDIAMAX_ALLOW_PRIVATE_URLS` | unset | `1` lets podcast feeds and other user-supplied URLs point at LAN addresses |
| `MEDIAMAX_CADDY` | bundled in Docker and release archives | Caddy binary for **built-in HTTPS** (Admin → Network) |
| `MEDIAMAX_ORT_DIR` | downloaded on first use | A local copy of onnxruntime-web for AI vocal separation on air-gapped servers |
| `MEDIAMAX_LOG_LEVEL` | `info` | `debug` for verbose logs |

More, including the security dashboard and integration variables, is in [docs/INSTALL.md](docs/INSTALL.md) and [docs/DEPLOY.md](docs/DEPLOY.md).

</details>

## Apps

| Client | Status |
|---|---|
| **Web** (any browser) | ✅ Served by the server; responsive down to phones |
| **Samsung (Tizen), LG (webOS) & Hisense (VIDAA)** | ✅ Wrapper apps in [`tv/`](tv) that load the web app in TV mode (VIDAA: 🧪 hosted web app, not yet tested on a set): D-pad navigation, remote keys, and MediaMax's own hls.js/MSE player and subtitle renderer instead of the TV's ([tv/README.md](tv/README.md)) |
| **iOS / iPadOS, Android** | 🧪 Built from [`apps/mobile`](apps/mobile) with Expo. Compiled in CI ([Native apps](https://github.com/Bucifer6/MediaMax/actions/workflows/apps.yml)); store release needs your developer accounts |
| **Apple TV, Android TV, Fire TV** | 🧪 Same codebase, TV builds compiled in CI; installable Android TV/Fire TV APKs are produced on every change |
| **Roku** | 🧪 Native BrightScript/SceneGraph channel in [`apps/roku`](apps/roku): link-code sign-in, profiles, home rows, libraries, search, Live TV, direct play / HLS with a device profile read from the Roku at runtime. Passes BrighterScript's static checks; not yet run on a Roku ([apps/roku/README.md](apps/roku/README.md)) |
| **CarPlay, Android Auto** | 🧪 Native module in the mobile app: browse, search, ±15/30 s for audiobooks, podcasts and long mixes, speed, Assistant voice commands, opt-in Siri "Play … in MediaMax"; CarPlay needs Apple's audio entitlement |
| **Subsonic apps, DLNA players** | ✅ Through the built-in Subsonic API and DLNA server |

🧪 means it compiles and is ready for device testing and store submission; it hasn't been through store review yet. Debug-signed Android APKs can be downloaded from the latest [Native apps](https://github.com/Bucifer6/MediaMax/actions/workflows/apps.yml) run. White-labelling (your own name, icon and colours in the store) is one command; see [apps/mobile/README.md](apps/mobile/README.md).

## Documentation

| | |
|---|---|
| **Help Centre** | Built into every server: open **Help** in the sidebar (`/help`). Articles live in [`server/help`](server/help); see [docs/HELP.md](docs/HELP.md) to edit them |
| [docs/INSTALL.md](docs/INSTALL.md) | Install on Docker, NAS, Windows and Linux; NAS disk spin-down; upgrades, backups, hardware transcoding; Play to devices |
| [docs/DEPLOY.md](docs/DEPLOY.md) | One-command secure deployment and the admin **Network** page: no proxy by default, Caddy/Nginx, your own proxy, built-in HTTPS, CrowdSec, fail2ban, Cloudflare Tunnel, Tailscale |
| [docs/FEATURES.md](docs/FEATURES.md) | Feature-by-feature comparison with Plex, Jellyfin, Emby and Overseerr/Jellyseerr |
| [docs/PLAYBACK.md](docs/PLAYBACK.md) | Subtitles (formats, styling, sync) and automatic quality (bandwidth detection, adaptive streaming) |
| [docs/HDR.md](docs/HDR.md) | HDR10, HDR10+, HLG and Dolby Vision: detection, per-device decisions, real Dolby Vision over HLS |
| [docs/AUDIO.md](docs/AUDIO.md) | Dolby Atmos, DTS:X, passthrough, fallbacks, downmix, night mode, dialogue boost, lip-sync |
| [docs/KARAOKE.md](docs/KARAOKE.md) | Lyrics, word-by-word karaoke, AI vocal separation and visualisers |
| [docs/TUNERS.md](docs/TUNERS.md) | TVHeadend, SAT>IP and Enigma2 tuners |
| [docs/EPG.md](docs/EPG.md) | TV guide sources and channel matching |
| [docs/METADATA.md](docs/METADATA.md) | TMDB and the built-in metadata providers (TheTVDB, fanart.tv, MusicBrainz…) |
| [docs/HOME_ASSISTANT.md](docs/HOME_ASSISTANT.md) | Home Assistant: MQTT discovery sensors, webhook preset, REST now-playing, automation YAML |
| [docs/API.md](docs/API.md) | REST and WebSocket API reference |
| [docs/PLUGINS.md](docs/PLUGINS.md) | Writing plugins; examples in [`plugins/examples`](plugins/examples) |
| [docs/ROADMAP.md](docs/ROADMAP.md) | What's next |
| [apps/mobile/README.md](apps/mobile/README.md) | Building the phone, tablet, TV and car apps |
| [tv/README.md](tv/README.md) | The Samsung and LG TV apps |
| [apps/roku/README.md](apps/roku/README.md) | The Roku channel: build, sideload, debug, package |
| [branding/mediamax/README.md](branding/mediamax/README.md) | The MediaMax brand kit: logo, colours, app icons and store art |

<details>
<summary><b>Adding IPTV</b></summary>

Go to **Admin → Live TV sources → Add source → Xtream Codes**, enter the portal URL, username and password, and press **Test**. You'll see the account status, expiry and channel/VOD/series counts. On save, MediaMax:

1. imports live channels and categories and loads the provider's guide (add more guide sources, and check how channels were matched, under **Admin → TV guide**);
2. creates **"<name> Movies"** and **"<name> Series"** libraries from the VOD catalogue, which browse, search, resume and play like local media;
3. restreams through the server (hiding your credentials), shares one upstream connection per channel, and warns before you exceed the provider's connection limit;
4. enables **catch-up** on channels that support it.

M3U playlists (`url-tvg`, `tvg-*`, `catchup-source`), HDHomeRun, TVHeadend, SAT>IP and Enigma2 work too ([docs/TUNERS.md](docs/TUNERS.md)).

</details>

<details>
<summary><b>Profiles ("Who's watching?")</b></summary>

Give everyone in the household their own profile under one account, Netflix / Plex Home style. Each profile has its own watch progress, history, Continue Watching, Next Up, My List, ratings, recommendations, subtitle/audio and theme settings.

1. Sign in as the account owner and open **Settings → Profiles → Add profile**. Pick a built-in avatar (or upload a picture), a colour and a name. Optionally set a 4–8 digit **PIN**, a **maturity rating limit**, which **libraries** it sees, an audio/subtitle language, and whether it may use Live TV and downloads.
2. Turn on **Kids profile** for children: it starts with a rating limit (PG by default), hides unrated titles, uses the playful kids theme, has no Discover/requests and no Live TV (unless the admin allows it). Leaving a kids profile for the owner's asks for the owner's PIN when one is set.
3. From now on every device shows **Who's watching?** after signing in (big tiles; arrow keys / D-pad work in TV mode). Switch any time from the avatar menu → **Switch profile** (Settings → Switch profile in the phone/TV apps).

Profiles never have more access than their owner: library access is the owner's subset, the stricter rating limit wins, and the owner's stream limit is shared by the whole account. Profile sessions can't open the admin dashboard, change the account password/2FA/API keys, link devices or manage profiles, even if the owner is an admin. Requests inherit the owner's permissions and count toward the owner's quota unless an admin gives the profile its own (Admin → Users shows profiles nested under their owner; **Profile settings** there sets the per-account limit, default 6, and the kids defaults).

</details>

<details>
<summary><b>Branding your server</b></summary>

**Admin → Branding studio** controls everything the apps show:

- server name, tagline, login message, footer and support link;
- logo, wide logo, favicon, app icon, splash and login background (until you upload your own, the MediaMax logo from [`branding/mediamax/`](branding/mediamax/README.md) is used);
- themes, starter looks, and your own themes (13 colour tokens, radius, font, poster shape, card size, hero style);
- the home screen rows and their order;
- feature toggles that hide areas in every app;
- custom CSS.

Every connected app receives a `branding.updated` event and re-themes instantly.

</details>

<details>
<summary><b>Use your favourite music apps (Subsonic)</b></summary>

MediaMax speaks the **Subsonic / OpenSubsonic API** at `http://<server>:8484/rest`. Players such as Symfonium, Feishin, play:Sub, Amperfy, Substreamer and Sonos bridges can browse, search, stream (with transcoding and ReplayGain), star, scrobble, edit playlists and show synced lyrics. Sign in with your MediaMax username and password, or with an API key if you use two-factor sign-in.

</details>

<details>
<summary><b>Security notes</b></summary>

- Use the [deploy kit](docs/DEPLOY.md), your own reverse proxy (pick *Behind my reverse proxy* in **Admin → Network** so only your proxy's `X-Forwarded-For` is believed) or **built-in HTTPS**, and set **Public URL** in settings.
- Failed sign-ins are written to a security log that fail2ban and CrowdSec read. Accounts lock for 15 minutes after 5 failures, whatever the client IP.
- Administrators always need a password; passwordless profiles are for non-admin, non-SSO accounts only.
- Content from IPTV playlists and podcast feeds is treated as untrusted: only network URLs are accepted, images must be raster images, and user-added feeds can't reach private addresses.
- API keys for AI and integration services are write-only in the admin UI.
- The web app ships a content security policy; server-side fetches of user-supplied URLs pin the address they checked, so DNS rebinding can't reach your LAN; changing your password signs out your other devices; "allow remote streaming" off is enforced on every media endpoint.
- Play to streams use signed, per-item links that only work from your local network while playback runs.

</details>

## Repository layout

```
shared/        API contract (TypeScript types used by every client)
server/        MediaMax server (Fastify, node:sqlite, FFmpeg)
web/           Web app and admin dashboard (React + Vite)
apps/mobile/   iOS, Android, Apple TV, Android TV and Fire TV apps (Expo / React Native) + CarPlay/Android Auto
apps/roku/     Roku channel (BrightScript + SceneGraph)
tv/            Samsung Tizen, LG webOS and Hisense VIDAA wrapper apps
deploy/        One-command installer, Caddy/Nginx, CrowdSec and fail2ban configs
nas/           Templates for Synology, QNAP, Unraid, TrueNAS SCALE and OpenMediaVault
packaging/     Files shipped in the Windows and Linux release archives
plugins/       Plugin SDK and examples
scripts/       Release packaging, end-to-end smoke test and user journeys, screenshot generator
branding/      The MediaMax brand kit (logo, icons, splash and store art)
docs/          Install, deploy, API, features, playback, HDR, audio, tuners, plugins
```

## Development & testing

```bash
npm test
```

That runs the server unit tests: parsing, playback decisions, IPTV/XMLTV, DSP for DJ mode, recommendations, security, and more; `npm test -w web` runs the web app's tests. CI also builds the web app, type-checks and compiles the native apps, builds the Docker image and a standalone binary, and runs a browser smoke test over every page (`node scripts/e2e-smoke.cjs`). `node scripts/e2e-journeys.mjs` walks through what people actually do (first run, admin, viewer, TV remote, phone, kids profile, errors) in a real browser against a real server, with local stand-ins for TMDB, Radarr, Sonarr, ListenBrainz and an IPTV provider.

To refresh the screenshots above:

```bash
npm run screenshots
```

It generates fictional demo media and artwork (including a Dolby Vision film and word-timed lyrics), boots a throwaway server against local mocks (IPTV provider, TMDB, Radarr/Sonarr, an MQTT broker, Kodi and DLNA devices), and captures every screen. It needs FFmpeg with libx265 and Playwright's Chromium; no internet connection is required.

## Built with Claude Code

MediaMax was built end to end by **[Claude Code](https://claude.com/claude-code)**, Anthropic's agentic coding tool. It started from a short brief: *"build a media server that combines Plex, Jellyfin and Emby with Xtream IPTV, apps for phones and TVs, all customisable from the server."*

Claude Code designed the architecture and wrote the server, web app, mobile, TV and car apps, deployment kit, tests and documentation. It worked through the usual engineering loop: building features, running unit tests, end-to-end browser tests and real tools (FFmpeg, CrowdSec, fail2ban, Caddy, Nginx), reading CI logs and fixing what failed. For larger pieces it ran several agents in parallel, each on a separate part of the codebase. Every change went through pull requests with CI before merging.

The project's owner steered the direction with feature requests; the code is Claude Code's.

## License

MediaMax is open source under the [MIT License](LICENSE). You're free to use, modify and redistribute it, including publishing your own branded builds of the apps, as long as the licence notice is kept.

Third-party services you connect (TMDB, Trakt, Last.fm, OpenSubtitles, IPTV providers, Schedules Direct, AI providers) have their own terms; make sure your use of them complies. FFmpeg is used as a separate program and is licensed under the LGPL/GPL. Bundled and downloadable third-party components (onnxruntime-web, the optional HT-Demucs model) and code adapted from OpenDJ are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

<div align="center"><sub>Made with <a href="https://claude.com/claude-code">Claude Code</a></sub></div>
