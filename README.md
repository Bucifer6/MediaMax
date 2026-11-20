# MediaMax

**One self-hosted server for your movies, TV, music, photos, live TV and IPTV, with apps that wear *your* brand.**

MediaMax brings together the features people love in Plex, Jellyfin and Emby, adds first-class
**Xtream Codes IPTV** (live, VOD, series, EPG and catch-up), and makes every client (web, iOS,
Android, Apple TV and Android TV) **fully skinnable from the server**: logo, colours, fonts, home
layout and feature toggles, applied live with no app rebuild.

See the full [feature matrix](docs/FEATURES.md) and the [API reference](docs/API.md).

```
┌──────────────────────────── MediaMax server (Node 22 · SQLite · FFmpeg) ────────────────────────────┐
│ Libraries: movies · TV · music · audiobooks · podcasts · photos · home videos ─ NFO/TMDB metadata   │
│ Playback: direct/remux/transcode · HW accel · on-demand HLS · trickplay · intro/credits detection   │
│ Live TV: Xtream Codes · M3U · HDHomeRun · XMLTV ─ catch-up ─ tuner sharing ─ DVR & series rules     │
│ Users: profiles/PINs · SSO (OIDC) · link codes · parental limits ─ Requests → Radarr/Sonarr         │
│ Smart collections · Wrapped stats · lyrics · OpenSubtitles · Trakt · Last.fm · DLNA · webhooks      │
│ Server-driven branding & themes ─ SyncPlay (watch together) ─ REST + WebSocket                      │
└───────────────────────────────────────────────┬──────────────────────────────────────────────────────┘
                 ┌──────────────────────────────┼───────────────────────────────┐
           Web app + Admin              iOS / Android (Expo)            Apple TV / Android TV
         (React, served by server)       phones & tablets                 10-foot focus UI
```

### Highlights
- **Everything in one place** — local libraries, Xtream/M3U IPTV (live, catch-up, VOD and series as real
  libraries), DVR, audiobooks with chapters, podcasts with auto-download, synced lyrics.
- **Your brand everywhere** — logos, colours, fonts, home rows and feature toggles drawn from the server by
  web, phone and TV apps, re-themed live. One command produces a white-label app build.
- **Smart playback** — per-device direct play/remux/transcode, instant seeking, hardware acceleration with
  software fallback, HDR tone mapping, scrub previews, skip intro/credits, Chromecast, watch-together.
- **Family-ready** — profiles with PINs, rating limits that understand US/UK/DE/AU ratings, per-library
  access, hidden channels, single sign-on with group-based admin rights.
- **Requests built in** — users discover trending titles and request them; approvals go straight to
  Radarr/Sonarr and the request flips to *available* when the title lands.
- **Smart collections & playlists** — rule-based lists (genre, decade, unwatched, recently added, 4K…).
- **DJ mode** — every track is analysed for tempo, key and energy. MediaMax then builds harmonic,
  beat-matched mixes along an energy curve and plays them non-stop on two decks with automatic crossfades.
- **In the car** — Apple CarPlay and Android Auto for music, audiobooks and podcasts, with continue
  listening, search and voice on Android Auto.
- **Serious live TV** — multiview (up to four channels at once), several merged EPG sources, DVR with
  priorities, tuner-conflict detection, day/time rules and comskip ad-break markers.
- **Your year in review** — per-user "Wrapped" plus admin statistics.
- **Plays well with others** — Trakt and Last.fm scrobbling, OpenSubtitles, DLNA for smart TVs and
  consoles, webhooks for Home Assistant/Discord.

## Install

Pick the build for your system from the [latest release](https://github.com/Bucifer6/MediaMax/releases/latest).
FFmpeg is included in every option.

| Platform | Install |
|---|---|
| **Docker** (amd64, arm64) | `docker run -d -p 8484:8484 -v "$PWD/config:/config" -v /path/to/media:/media:ro ghcr.io/bucifer6/mediamax` |
| **Synology, QNAP, Unraid, TrueNAS SCALE, OpenMediaVault** | ready-made templates in [`nas/`](nas) |
| **Windows** x64 | `mediamax-<version>-windows-x64.zip`: run `MediaMax.cmd`, or `install-service.ps1` to start at boot |
| **Linux** x64 / arm64 | `mediamax-<version>-linux-<arch>.tar.gz`: run `./mediamax`, or install the included systemd unit |

Then open `http://<server>:8484` and follow the setup wizard. Step-by-step guides, hardware transcoding, upgrades
and backups: **[docs/INSTALL.md](docs/INSTALL.md)**.

### From source
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
The server listens on port **8484**, and serves the web app and the API from the same port.

For development:
```bash
npm run dev:server
```
```bash
npm run dev:web
```

### Configuration (environment variables)
| Variable | Default | Purpose |
|---|---|---|
| `MEDIAMAX_PORT` | `8484` | HTTP port |
| `MEDIAMAX_DATA` | `./data` ([binaries and Docker](docs/INSTALL.md#where-your-data-lives-and-backups) differ) | Database, caches, branding assets, logs |
| `MEDIAMAX_TRANSCODE_DIR` | `$DATA/transcodes` | HLS segment scratch space (a RAM disk is ideal) |
| `MEDIAMAX_RECORDINGS` | `$DATA/recordings` | DVR output folder |
| `MEDIAMAX_FFMPEG` / `MEDIAMAX_FFPROBE` | bundled copy (release binaries), else `ffmpeg` / `ffprobe` on the PATH | Custom binaries (e.g. jellyfin-ffmpeg) |
| `MEDIAMAX_HWACCEL` | `none` | Initial hardware accelerator |
| `TMDB_API_KEY` | | Online metadata (also settable in the admin UI) |
| `MEDIAMAX_LOG_LEVEL` | `info` | `debug` for verbose logs |
| `MEDIAMAX_TRUSTED_PROXIES` | loopback + private ranges | Comma list of proxy IPs/CIDRs whose `X-Forwarded-*` headers are trusted |
| `MEDIAMAX_ALLOW_PRIVATE_URLS` | off | Set to `1` to allow podcast feeds/artwork hosted on your LAN (blocked by default as SSRF protection) |
| `TRAKT_CLIENT_ID` / `TRAKT_CLIENT_SECRET`, `LASTFM_API_KEY` / `LASTFM_SECRET`, `OPENSUBTITLES_API_KEY` | | Optional integrations (also settable in the admin UI) |

## Adding IPTV
**Admin → Live TV → Add source → Xtream Codes**, then enter the portal URL, username and password and press
**Test**. You'll see the account status, expiry and channel/VOD/series counts. On save, MediaMax:

1. imports live channels and categories, then streams the provider's XMLTV guide into the EPG;
2. creates **"<name> Movies"** and **"<name> Series"** libraries from the VOD catalogue (these browse, search,
   resume and play exactly like local media, and details and episodes load on demand);
3. restreams through the server by default (hiding your credentials), shares one upstream connection
   between everyone watching the same channel, and warns before you exceed the provider's connection limit;
4. enables **catch-up** on channels with `tv_archive`.

M3U playlists (with `url-tvg`, `tvg-*`, `catchup-source`) and HDHomeRun tuners are supported too.

## Branding your server
**Admin → Branding studio** controls everything the apps display:
- server name, tagline, login message, footer and support link;
- logo, wide logo, favicon, app icon, splash logo and login background;
- themes: 8 built-in presets, or build your own (13 colour tokens, corner radius, font, poster shape,
  card size, hero style), and optionally let users choose between them;
- the home screen: drag rows into order, and pick Continue Watching, Next Up, On Now, recently added
  per library, a genre, a collection, a playlist or recordings;
- feature toggles: hide Live TV, IPTV VOD, music, photos, downloads, DVR, watch-together, the profile
  picker or link codes everywhere at once;
- custom CSS for the web app.

Every connected app receives a `branding.updated` event and re-themes instantly.

## Use your favourite music apps (Subsonic)
MediaMax speaks the **Subsonic / OpenSubsonic API** at `http://<server>:8484/rest`, so music players such as
Symfonium, Feishin, play:Sub, Amperfy, Substreamer and Sonos bridges can browse, search, stream (with on-the-fly
transcoding), star, scrobble, edit playlists and show synced lyrics. Many of these apps also offer CarPlay, Android
Auto, gapless playback and offline sync. Sign in with your MediaMax username and password. If you use two-factor
sign-in, create an API key (*Settings → API keys*) and pick "API key" in apps that support OpenSubsonic API-key auth.

## Plugins
Extend MediaMax with plugins (*Admin → Plugins*): install from repositories or upload a package. See
[docs/PLUGINS.md](docs/PLUGINS.md) to write your own; examples live in [`plugins/examples`](plugins/examples).

## Security notes
- Put MediaMax behind HTTPS (Caddy, Traefik, nginx) when exposing it to the internet and set **Public URL** in settings.
- Passwordless profiles are only allowed for non-admin, non-SSO accounts; administrators must keep a password.
- Sign-in attempts are locked per account after 5 failures (15 minutes), regardless of client IP.
- Content from IPTV playlists and podcast feeds is treated as untrusted: only network URLs are accepted, images must
  be raster images, and user-added feeds can't reach private addresses.
- DLNA has no login: it only answers devices directly on the LAN (never through a proxy) and serves exactly what the
  chosen "browse as" user may see.

## Repository layout
```
shared/         API contract (TypeScript types used by every client)
server/         MediaMax server (Fastify, node:sqlite, FFmpeg)
web/            Web app and admin dashboard (React + Vite)
apps/mobile/    iOS, Android, tvOS and Android TV apps (Expo / React Native)
docs/           API reference, feature matrix and install guide
nas/            Docker templates for Synology, QNAP, Unraid, TrueNAS SCALE and OpenMediaVault
packaging/      Files shipped in the Windows and Linux release archives
scripts/        Release packaging (single executable, FFmpeg download), e2e smoke test
```

## Testing
```bash
npm test
```
Runs the server unit tests: filename parsing, playback decisions, M3U/XMLTV/Xtream helpers and
audio-fingerprint matching.

## License
MediaMax is open source under the [MIT License](LICENSE). You're free to use, modify and redistribute it,
including publishing your own branded builds of the apps, as long as the licence notice is kept.

Third-party services you connect (TMDB, Trakt, Last.fm, OpenSubtitles, IPTV providers) have their own terms;
make sure your use of them complies. FFmpeg is used as a separate program and is licensed under the LGPL/GPL.
