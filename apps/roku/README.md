# MediaMax for Roku

A native Roku channel (BrightScript + SceneGraph) for MediaMax. Roku can't run the web app, so this channel talks to
the REST API (`/api/v1`, see [docs/API.md](../../docs/API.md)) directly and plays media in the Roku `Video` node.

It sends `X-MediaMax-Platform: roku` and `X-MediaMax-Device-Id` (the Roku's channel client id), so the server lists
its sessions and devices as **Roku**.

## Features

| Area | What it does |
|---|---|
| Server | Finds servers on the LAN with SSDP (needs **Settings → DLNA** on the server: MediaMax only answers M-SEARCH while its DLNA server runs), or takes a typed address (`192.168.1.20` → `http://192.168.1.20:8484`; `https://` URLs work too). Each candidate is checked with `GET /system/info`. |
| Sign-in | **Link code** (default): shows a 4-character code and `<server>/link`, polls `/auth/link/poll` every 3 s, gets a new code when it expires. Fallbacks: username + password on the on-screen keyboard (with the two-factor prompt when the account has TOTP), and the server's public profile picker (`features.profilePicker`) with a PIN pad. |
| Profiles | "Who's watching?" at launch and after sign-in when the account has profiles (`/auth/account/profiles`, `/auth/profiles/:id/switch`, PIN pad). |
| Home | The server's home rows (`GET /home`): posters, landscape cards for Continue watching / Next up / recordings with progress bars, live-channel rows, a header with the focused title's backdrop and overview. Refreshes when you come back from playback. |
| Libraries | Movies, shows, home videos and IPTV VOD libraries; poster grid paged 60 at a time; `*` cycles A–Z / recently added / release date / rating. |
| Detail | Movies, episodes, videos: resume / play from start, audio and subtitle track choice, watched and My List toggles. Shows: next-up button, seasons, episode list with progress. |
| Search | As you type (`GET /search`), titles and live channels. |
| Live TV | Categories, favourites, channel list with now / next (refreshed every minute), `*` toggles a favourite, plays through `/livetv/channels/:id/play` (HLS). |
| Settings | Max streaming quality, default subtitles (off / forced only / always), autoplay next episode, switch profile, change server, sign out. Shows what the device decodes. |

### Playback

* `POST /playback/:itemId` with a **device profile built at runtime** from `roDeviceInfo`
  ([`components/common/DeviceProfile.brs`](components/common/DeviceProfile.brs)): `CanDecodeVideo` for HEVC / HEVC Main 10 /
  VP9 / VP9 profile 2 / AV1 / MPEG-2, `GetVideoMode` for the largest useful resolution (4K only when the Roku outputs
  2160p), `GetDisplayProperties` for HDR10 / HDR10+ / HLG / Dolby Vision, `CanDecodeAudio` for AC-3 / E-AC-3 / FLAC / ALAC /
  Opus / Vorbis / LPCM decoding and AC-3 / E-AC-3 / DTS passthrough, `GetAudioOutputChannel` for stereo vs. surround.
  Containers: MP4 / MOV / M4V and MKV; everything else is remuxed to HLS by the server. `adaptive: true` lets transcodes
  use the server's rendition ladder.
* Text subtitles are side-loaded as WebVTT (`subtitleTracks`); bitmap subtitles (PGS, VobSub, DVB) are burned in by the
  server when chosen. The `*` key in the player switches subtitles (instantly for text tracks) and audio (restarts the
  stream at the current position).
* Progress: `POST /playback/sessions/:id/progress` every 10 s, on pause / resume and when stopping (with
  `subtitleIndex` / `audioIndex`, which current servers ignore), then `DELETE /playback/sessions/:id`. These final
  requests run from the scene so they complete after the player screen has closed.
* Skip Intro / Recap / Preview / Ad buttons from `markers`; intros are skipped automatically when the user's
  `skipIntros` preference is on. At the credits marker (or 25 s before the end) an **Up next** card appears and the next
  episode (`nextItemId`) starts after 15 s when autoplay is on.
* If the Roku fails to play a direct / remuxed stream, the channel retries once with `forceTranscode` at the same position.
* If the server answers a progress report with `{ ok: false }` (an admin stopped the stream, or the session was
  replaced), playback stops with a message.

### Not supported (compared with the web app)

* **Remote control / server messages**: Roku has no WebSocket client, and MediaMax has no polling endpoint for
  `remote.command` / `session.message`, so "Play on…" can't target a Roku and server messages aren't shown. A stream
  stopped by an admin is still noticed through the next progress report (within 10 s).
* Music, photos, audiobooks, podcasts, DVR management, requests (Discover), SyncPlay, karaoke and lyrics.
* The full EPG grid (`/livetv/guide`): Live TV shows now / next per channel instead. No catch-up.
* Trickplay thumbnails on the seek bar, the server's theme / branding colours (the channel uses the stock MediaMax look),
  single sign-on (OIDC needs a browser: use a link code instead).
* Settings are per device (Roku registry); they aren't synced to the account's preferences.
* H.264 profile / level limits aren't in the device profile (the server's profile format has no field for them). Older
  Rokus that can't decode, e.g., H.264 level 5.1 fall back to the automatic transcode retry.

## Requirements

* Roku OS 11 or newer (the channel uses the Standard keyboard, PIN pad and message dialogs).
* A MediaMax server reachable from the Roku. Link codes need the server's `linkCodes` feature flag (on by default).

## Build

```bash
cd apps/roku
npm install            # BrighterScript, for the static check below (this folder is not a root workspace)
npm run lint           # bsc: parses and validates every BrightScript / XML file
node build.mjs         # → apps/roku/dist/MediaMax.zip
node build.mjs --images  # re-render images/ from tv/shared/brand with ffmpeg, then zip
```

`build.mjs` zips `manifest`, `source/`, `components/` and `images/` with the server's ZIP writer
(`server/src/util/zip.ts`, loaded with Node's type stripping on Node ≥ 22.18; older Node versions use the `zip` CLI).

Images: focus icons 336×210 (FHD) and 290×218 (HD), splash 1920×1080 and 1280×720, all rendered from the stock artwork
in `tv/shared/brand/`. Replace them (same names and sizes) for a white-label channel and change `title` in `manifest`.

## Sideload

1. **Enable developer mode** on the Roku: with the remote press **Home ×3, Up ×2, Right, Left, Right, Left, Right**.
   Accept the agreement, set a developer password, and note the IP address it shows. The Roku reboots.
2. Install:
   ```bash
   node apps/roku/build.mjs --deploy 192.168.1.50 --password <dev-password>
   ```
   This POSTs the zip to `http://<roku-ip>/plugin_install` (multipart `mysubmit=Install`, `archive=@MediaMax.zip`)
   with HTTP digest authentication as user `rokudev`. You can also open `http://<roku-ip>` in a browser, sign in as
   `rokudev` and upload `dist/MediaMax.zip`, or use curl:
   ```bash
   curl --user rokudev:<dev-password> --digest -F "mysubmit=Install" -F "archive=@apps/roku/dist/MediaMax.zip" http://<roku-ip>/plugin_install
   ```
   The password can also come from `ROKU_DEV_PASSWORD`.

The sideloaded channel replaces any previous dev channel and appears at the end of the home screen row.

## Debug

* **BrightScript console:** `telnet <roku-ip> 8085` shows `print` output, runtime errors and a debugger prompt on crashes
  (`bt` backtrace, `var` locals, `cont` continue). Ports 8089–8093 carry the console of individual SceneGraph threads.
* **SceneGraph debug server:** `telnet <roku-ip> 8080` (`sgnodes all`, `chanperf`, `fps_display`).
* VS Code with the *BrightScript Language* extension (RokuCommunity) can deploy, set breakpoints and inspect nodes using
  the same `bsconfig.json`.
* Deep links for testing (ECP): `curl -d '' "http://<roku-ip>:8060/launch/dev?contentId=<itemId>&mediaType=movie"`
  (`episode` and `movie` start playback, `live` plays a channel id, anything else opens the detail screen).

## Package for the Roku Channel Store

1. Generate a signing key once: `telnet <roku-ip> 8080` → `genkey`. Keep the printed **DevID** and password safe; every
   update must be signed with the same key (back it up with the Packager's *Rekey* page, or `rekey` on 8080).
2. Sideload the build, then open `http://<roku-ip>/plugin_package`, enter an app name/version and the genkey password,
   and download the signed `.pkg`.
3. In the Roku Developer Dashboard create a channel (Public or Beta), upload the `.pkg`, add store artwork, and run the
   static analysis / certification checks. Bump `major_version` / `minor_version` / `build_version` in `manifest` for
   every upload.

Certification notes: the channel handles deep links (`contentId` + `mediaType`, also while running via `roInput`), the
Back key exits from Home, and playback stops when the player closes.

## Layout

```
apps/roku/
  manifest                  channel metadata, icons, splash, FHD UI
  source/main.brs           entry point: roSGScreen, deep links, roInput
  components/
    MainScene.*             globals, screen stack, startup / sign-in flow, toast, spinner, background requests
    common/                 Utils (registry, URLs, time), Api (task-based requests), Screen (focus, dialogs),
                            Content (API → ContentNode), DeviceProfile (roDeviceInfo → DeviceProfile)
    tasks/ApiTask.*         one HTTP request per task (roUrlTransfer, X-MediaMax-* headers, bearer token)
    tasks/DiscoveryTask.*   SSDP M-SEARCH over roDatagramSocket
    screens/                Server, SignIn, Profile, Home, Library, Detail, Search, LiveTv, Settings, Player
    items/                  PosterItem, EpisodeItem, ChannelItem, ProfileItem, NavItem (list / grid cells)
  images/                   generated from tv/shared/brand
  build.mjs                 zip + sideload
  bsconfig.json             BrighterScript config used by `npm run lint`
```

## Testing status

`npm run lint` (BrighterScript `bsc`) compiles the channel with no diagnostics, which catches syntax errors, reserved
words, missing functions and wrong script references, but not runtime behaviour. The server side of the integration
(platform `roku`, link-code sign-in with Roku headers, `decide()` against Roku device profiles) is covered by
`server/test/roku.test.ts`. Everything that needs a device (layout, focus, playback, SSDP, dialogs) must be tried on a
Roku.
