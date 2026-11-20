# MediaMax

**One self-hosted server for your movies, TV, music, photos, live TV and IPTV, with apps that wear *your* brand.**

MediaMax brings together the features people love in Plex, Jellyfin and Emby, adds first-class
**Xtream Codes IPTV** (live, VOD, series, EPG and catch-up), and makes every client (web, iOS,
Android, Apple TV and Android TV) **fully skinnable from the server**: logo, colours, fonts, home
layout and feature toggles, applied live with no app rebuild.

See the full [feature matrix](docs/FEATURES.md) and the [API reference](docs/API.md).

```
┌──────────────────────────── MediaMax server (Node 22 · SQLite · FFmpeg) ────────────────────────────┐
│ Library scanner ─ NFO/artwork/TMDB ─ Intro detection ─ Transcoder (HW accel, on-demand HLS) ─ DVR   │
│ Live TV: Xtream Codes · M3U · HDHomeRun · XMLTV ─ Tuner sharing ─ Catch-up ─ VOD/series libraries   │
│ Users · Profiles/PINs · Link codes ─ Branding & themes ─ Webhooks ─ SyncPlay ─ REST + WebSocket     │
└───────────────────────────────────────────────┬──────────────────────────────────────────────────────┘
                 ┌──────────────────────────────┼───────────────────────────────┐
           Web app + Admin              iOS / Android (Expo)            Apple TV / Android TV
         (React, served by server)       phones & tablets                 10-foot focus UI
```

## Quick start

### Docker (recommended)
```bash
docker compose up -d --build
```
Edit the media paths in `docker-compose.yml` first. Then open `http://<server>:8484` and follow the setup wizard.
For Intel/AMD hardware transcoding, uncomment `devices: /dev/dri`. For NVIDIA, uncomment the GPU reservation,
then choose the accelerator in **Admin → Settings → Transcoding**.

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
| `MEDIAMAX_DATA` | `./data` | Database, caches, branding assets, logs |
| `MEDIAMAX_TRANSCODE_DIR` | `$DATA/transcodes` | HLS segment scratch space (a RAM disk is ideal) |
| `MEDIAMAX_RECORDINGS` | `$DATA/recordings` | DVR output folder |
| `MEDIAMAX_FFMPEG` / `MEDIAMAX_FFPROBE` | `ffmpeg` / `ffprobe` | Custom binaries (e.g. jellyfin-ffmpeg) |
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
docs/           API reference and feature matrix
```

## Testing
```bash
npm test
```
Runs the server unit tests: filename parsing, playback decisions, M3U/XMLTV/Xtream helpers and
audio-fingerprint matching.

## License
No license has been chosen yet. Add one before publishing or distributing builds.
