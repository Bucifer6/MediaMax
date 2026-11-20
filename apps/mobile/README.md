# MediaMax apps: iOS, Android, Apple TV and Android TV

One Expo codebase (SDK 58, TypeScript, expo-router) builds four apps: the phone/tablet apps for iOS and Android, and the 10-foot TV apps for tvOS and Android TV.

The apps are **white-label**. Everything visual comes from the server at runtime: server name, logos, splash, colours, fonts, corner radius, poster shape, card size, hero style, home-row layout, feature toggles and the login message. When an admin changes branding, every connected app **re-themes live**: the server sends `branding.updated` over the WebSocket and the app refetches `/api/v1/branding`. Only the OS-level icon, bundle name and native splash are fixed at build time. See [White-labelling](#white-labelling).

This package is **standalone**. It is not an npm workspace member and has its own `package-lock.json`.

## Quick start

```bash
cd apps/mobile
npm install
npm run sync-types        # copies shared/src/types.ts -> src/api/types.ts (never edit the copy)
npx tsc --noEmit          # must be clean

# Phones / tablets (development build; Expo Go cannot load the native modules we use)
npx expo prebuild --clean
npx expo run:ios          # or: npx expo run:android
```

On first launch, enter your server address, such as `192.168.1.20:8096` or `https://media.example.com`. If you leave out the scheme, the app tries `https://` first and then `http://`. The app validates the address with `GET /api/v1/system/info`, remembers every server you add, and then shows the branded login screen.

## TV builds (Apple TV / Android TV)

TV builds use the [react-native-tvos](https://github.com/react-native-tvos/react-native-tvos) fork of React Native, plus the `@react-native-tvos/config-tv` config plugin. The plugin is already listed in `app.config.ts`. It only changes the native projects when `EXPO_TV=1`.

### 1. Alias `react-native` to `react-native-tvos`

The fork is a drop-in replacement published under another name. You install it *as* `react-native` with an npm alias:

```jsonc
// package.json (TV flavour)
"react-native": "npm:react-native-tvos@0.88.1-0"
```

The fork supports phones as well, so you can keep the alias permanently. By default this repo stays on stock React Native and switches with a script:

```bash
npm run tv:on     # rewrites the dependency to npm:react-native-tvos@<matching> and runs npm install
npm run tv:off    # back to stock react-native
```

`scripts/tv-deps.mjs` keeps the fork on the same React Native version that the Expo SDK pins (`package.json > mediamax.reactNativeTvos`). Use a `0.88.x-y` fork release for SDK 58. `expo.install.exclude` stops `expo install` and `expo-doctor` from complaining about the alias.

### 2. Prebuild and run

```bash
npm run tv:on
npm run prebuild:tv       # EXPO_TV=1 expo prebuild --clean  -> tvOS target + leanback manifest
npm run ios:tv            # Apple TV simulator
npm run android:tv        # Android TV emulator / device
npm run tv:off            # before committing
```

### 3. EAS

`eas.json` has a `tvos` profile and an `androidtv` profile, each with simulator/APK variants. Both set `EXPO_TV=1`. The `eas-build-pre-install` npm hook runs `scripts/tv-deps.mjs auto`. On EAS, that hook swaps in the tvOS fork whenever `EXPO_TV` is set, and drops the lockfile so the alias resolves.

```bash
eas build --profile ios          # App Store (iPhone/iPad)
eas build --profile android      # Play Store (AAB)
eas build --profile tvos         # Apple TV
eas build --profile androidtv    # Android TV (AAB); androidtv-apk for sideloading
```

### How the TV UI differs

The app checks `Platform.isTV` at runtime and switches layouts. It is not a separate code tree.

| | Phone / tablet | TV |
|---|---|---|
| Navigation | Bottom tab bar (blurred on iOS) with a mini player | Top nav bar. Focusing a tab switches to it, Apple-TV style. Logo and clock on the bar. |
| Home | Paged hero carousel, then rows | Full-screen backdrop that cross-fades to the **focused** card, with the logo, metadata and synopsis in a big spotlight area |
| Cards | Press-in feedback | Spring scale plus a glowing ring in the theme's primary colour (`Focusable`) |
| Login | Profiles, then password | **Link code by default.** The TV shows a big code and polls `/auth/link/poll` every 3 s. Approve it from a phone (Settings › Link a TV) or a browser (`<server>/link`). |
| Player | Tap for controls, drag the scrubber, PiP, AirPlay | D-pad: ←/→ seeks ±10 s, long-press ±30 s, select or play/pause toggles, ↑/↓ shows controls. Live TV: ↑/↓ and channel keys zap. With the seek bar focused, ←/→ dials in a target. |
| Back | Gesture / hardware back | Android TV back and the tvOS Menu button go through `BackHandler`. The Menu key is enabled only when there is somewhere to go back to, so at the top level Menu exits to the Home screen as Apple requires. |

All sizes on TV come from `t.s(n)`, which scales values authored for a 1280-pt-wide screen. Apple TV (1920 pt) and Android TV (960 dp) therefore look the same.

TV-only APIs (`useTVEventHandler`, `TVEventControl`, `TVFocusGuideView`) are looked up at runtime in `src/tv/index.tsx`. That way the code type-checks against stock React Native and runs on both.

Caveats on TV: there are no downloads, haptics or PiP. expo-secure-store is replaced by AsyncStorage for the token. expo-router's optional native module (link previews) is iOS-only, but the JS router works on tvOS.

## Features

* **Servers:** add several servers and switch between them. Each server keeps its own token (in SecureStore), cached branding and cached user. The last branding is cached, so the next cold start shows the right brand immediately (the "dynamic splash"). The app also works **offline** with downloads when the server is unreachable.
* **Login:** branded background, logo and message. Sign in with a profile picker plus PIN pad (`/auth/profile-login`), with username and password, or with a TV link code. Every request sends `X-MediaMax-Device-Id/Name/Platform/Version` from a generated, persistent device id. The platform is `ios`, `android`, `tvos` or `androidtv`.
* **Home:** rows come from the server via `/home`: hero, continue watching (with progress), next up, recently added, favourites, collections, genres, live-now and favourite-channel cards, recordings and playlists. Each row honours the theme's `cardSize`, `posterShape` and `heroStyle`.
* **Libraries:** a grid with infinite scroll, sort and order, a genre picker, and watched/unwatched/favourites filters. Music libraries have Albums, Artists and Songs tabs.
* **Detail pages:**
  * movie, episode and video: play or resume, restart, mark watched, favourite, download, trailer, cast and similar items
  * show: season picker, episode list and next up
  * album and playlist: track list, play and shuffle
  * artist: albums and play-all
  * collection: grid
* **Search:** debounced, grouped by type, includes channels and programmes, remembers recent searches.
* **Video player:** `expo-video` with a custom overlay.
  * It calls `POST /playback/:id` with an iOS or Android device profile: HLS; h264/hevc (plus vp9 on Android); aac/ac3/eac3/…
  * Controls: scrubber with marker ticks, audio picker, subtitle picker, and a quality menu. The quality menu re-requests playback with a new `maxBitrate`.
  * Server subtitles: the app fetches the WebVTT sidecars and renders them itself.
  * Markers: Skip Intro, Skip Recap and Skip Credits buttons. Intros skip automatically when `skipIntros` is on.
  * **Up Next** countdown, either from the credits marker or in the last 25 s.
  * Progress reports every 10 s, on pause and on exit. On exit the app also stops the server session.
  * PiP and background audio; AirPlay on iOS.
* **Music:** expo-audio queue with shuffle and repeat, lock-screen and Control Centre metadata, background playback, a mini player above the tab bar and on stack screens, and a full now-playing screen.
* **Live TV:**
  * Categories, favourites, and a channel list with now/next and a progress bar.
  * **EPG grid:** virtualised rows. Channel cells and the header stay pinned by native-driven transforms. Every programme is focusable on TV, and a preview panel shows the focused programme.
  * Live player with zapping and a channel list.
  * Catch-up for archive channels ("Start over" or "Watch (catch-up)").
* **DVR:** record a programme, record a series (rule), cancel a recording, a recordings list grouped by status, and series rules. The list updates live from `recording.updated`.
* **Downloads** (phones; shown only when the server enables them and the user has `allowDownloads`):
  * Single items, whole seasons or whole albums via `/stream/download/:itemId`, using the expo-file-system `DownloadTask`.
  * Artwork is cached too.
  * Offline playback; resume positions sync back to the server when you're online again.
* **Settings:** edit your account name, theme picker (when `allowUserThemes`; applies instantly), playback preferences, Link a TV, signed-in devices (with revoke), switch profile, switch server, sign out and about.
* **Feature flags:** Live TV, DVR, music, photos, IPTV VOD, downloads, the profile picker and link codes are hidden when the server or the user's permissions turn them off.

## File layout

```
apps/mobile
├── app/                      expo-router routes
│   ├── _layout.tsx           providers, auth guard, themed Stack, dynamic splash, floating mini player
│   ├── index.tsx             entry (guard redirects)
│   ├── connect.tsx           add / pick servers
│   ├── login.tsx             profiles + PIN, password, TV link code
│   ├── link-tv.tsx           phone approves a TV code
│   ├── (tabs)/               home, libraries, live, search, downloads, settings (+ custom tab bar)
│   ├── library/[id].tsx      library grid
│   ├── item/[id].tsx         detail dispatcher (movie/show/season/episode/album/artist/playlist/collection)
│   ├── player/[id].tsx       VOD player
│   ├── live/[id].tsx         live / catch-up player
│   ├── live/guide.tsx        EPG grid
│   ├── live/recordings.tsx   DVR
│   ├── music.tsx             now playing
│   ├── photo/[id].tsx        photo viewer
│   └── settings/             theme, playback, devices
├── src/
│   ├── api/                  client.ts (typed REST), types.ts (synced contract), ws.ts, device.ts,
│   │                         storage.ts, profiles.ts (device profiles), useQuery.ts
│   ├── theme/                ThemeProvider (server Theme -> tokens), colour helpers, fallback theme
│   ├── state/                session (servers/auth/branding/WS), music (queue), downloads
│   ├── components/           Focusable, Button, MediaCard, ChannelCard, Row, Hero, TabBar, OptionSheet,
│   │                         ProgramSheet, PinPad, MiniPlayer, BrandSplash, …
│   ├── screens/detail/       detail page variants
│   ├── player/               VideoPlayerScreen, Scrubber, WebVTT parser
│   ├── tv/                   remote events, back/menu handling, focus guide
│   └── utils/                formatting, navigation helpers, event bus
├── scripts/brand.mjs         produce a white-label brand folder from a server
├── scripts/tv-deps.mjs       react-native <-> react-native-tvos alias switch
├── app.config.ts             dynamic config (EXPO_TV, MEDIAMAX_BRAND)
└── eas.json                  ios / android / tvos / androidtv profiles
```

## White-labelling

### What's runtime and what's build time

| Runtime (from `/api/v1/branding`, live-updating) | Build time (native, needs a new build) |
|---|---|
| Server name, tagline, login message, footer, support link | App name under the icon |
| Logo, wide logo, login background | App icon, Android adaptive icon |
| Splash colour and logo (shown as an in-app splash right after the native one) | Native launch screen |
| Theme: colours, light/dark, radius, poster shape, card size, hero style, font | Bundle id / package name, URL scheme |
| Home rows, feature flags, user-selectable themes | Apple TV layered icons / top shelf, Android TV banner |

The server's `appIconUrl` and `splash` fields are *suggestions* for that build-time step.

### Producing a branded build

```bash
# 1. Pull the brand from a live server
npm run brand -- https://media.acme.com acme --bundle-id com.acme.media [--lock]
#    -> branding/acme/brand.json, icon.png, splash.png

# 2. (TV) add exact-size images to branding/acme/ if you want custom TV art:
#    tv-banner.png (320x180), tv-icon.png, appletv-icon-1280x768.png, appletv-icon-400x240.png,
#    appletv-icon-800x480.png, appletv-topshelf-1920x720.png, appletv-topshelf-3840x1440.png,
#    appletv-topshelfwide-2320x720.png, appletv-topshelfwide-4640x1440.png

# 3. Build with the brand selected
MEDIAMAX_BRAND=acme eas build --profile ios
MEDIAMAX_BRAND=acme eas build --profile androidtv
```

`app.config.ts` reads `branding/<brand>/brand.json` and the brand's images, and falls back to the stock MediaMax assets for anything missing. On EAS, set `MEDIAMAX_BRAND` in the profile's `env` (or as an EAS environment variable) and commit the brand folder, or upload it with your CI.

* `--lock` bakes in the server URL and hides "switch server". The connect screen is skipped and the app always talks to that server.
* Without `--lock`, the URL only pre-fills the first server.
* You can also set `MEDIAMAX_SERVER_URL` / `MEDIAMAX_LOCK_SERVER=1` directly.

The icon must be a 1024×1024 PNG (iOS rejects transparency); prebuild resizes it for every density. If the server serves SVG or WebP, convert it first.

## Assumptions and notes

* `PlaybackInfo.url` is server-relative and already contains `?token=`. The app prepends the base URL and also sends the auth and device headers.
* **Transcode offset:** when the server starts a transcode at `startMs`, the HLS timeline may start at 0 or at `startMs`. The player compares the loaded stream duration with `durationMs` to tell which, and maps positions accordingly. Seeks that fall outside a transcode's generated range re-request `POST /playback/:id` with `startMs`, as the API doc suggests.
* **Subtitles:** server sidecar subtitles (`SubtitleTrack.url`, WebVTT) are rendered by the app, so they work on every platform. The app always requests `subtitleStreamIndex: null`, so nothing is burned in. In-manifest HLS subtitle tracks are offered too.
* **Fonts:** native apps can only load `Theme.fontUrl` when it points at a real `.ttf` or `.otf` file. Google-Fonts CSS URLs fall back to the system font.
* **PIN length:** the PIN pad auto-submits at 4 digits.
* **Downloads** fetch the original file. Containers that iOS can't play (for example MKV) won't play offline on iOS.
