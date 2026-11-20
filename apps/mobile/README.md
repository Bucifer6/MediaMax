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

**Amazon Fire TV.** Fire OS is Android, so the Android TV build runs there unchanged. TV builds already leave out
Google-only pieces such as Chromecast, and the D-pad/remote focus handling is shared. Use the `firetv` profile to
build a store APK for the Amazon Appstore:

```bash
eas build --profile firetv       # Amazon Appstore APK (sideload with: adb connect <fire-tv-ip> && adb install app.apk)
```

When you submit, choose the Fire TV device targets in the Amazon Developer Console and upload the TV banner (`androidTVBanner`
in the brand file, 320×180). Test on a real Fire TV Stick with developer options enabled; the Android TV emulator is
close enough for layout checks.

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
* **DVR:** record a programme, record a series (rule, using the server's padding from `GET /dvr/defaults`), cancel a recording, a recordings list grouped by status, and series rules. The list updates live from `recording.updated`.
* **Downloads** (phones; shown only when the server enables them and the user has `allowDownloads`):
  * Single items, whole seasons or whole albums via `/stream/download/:itemId`, using the expo-file-system `DownloadTask`.
  * Choose the quality per download (Original, 1080p, 720p or 480p; default in Settings › Download quality). Non-original qualities are converted by the server to H.264/AAC MP4 (`.m4a` for music). They have no `Content-Length`, so the list shows bytes downloaded with an indeterminate bar.
  * On iOS, originals in containers AVPlayer can't open (anything but mp4/m4v/mov/m4a/mp3/aac, e.g. MKV, AVI, TS, FLAC) are downloaded as 1080p automatically so they play offline.
  * Artwork is cached too.
  * Offline playback; resume positions sync back to the server when you're online again.
* **Discover & requests** (when the server turns on `features.requests`): a Discover tab on phones and in the TV top bar. It shows trending titles (`GET /discover`) with infinite scroll, or searches with a Movies / Shows / All toggle. Cards carry "In library", "Requested" and "Pending" badges; "In library" opens the item. The request sheet takes "All seasons" or chosen season numbers for shows, plus an optional note (`POST /requests`), and explains a weekly-limit (429), already-requested (409) or not-configured (400) answer. **My requests** (from Discover or Settings) shows status chips and lets you withdraw pending requests. Admins see everyone's requests with a status filter, Approve and Decline (with a note).
* **Smart playlists:** Library › Playlists › "New smart playlist" opens a rule builder: match all/any, rules on genre, year, rating, added within N days, played, favourite, type, person and resolution, plus sort and limit. A live preview (`POST /smart/preview`) shows the match count and the first titles before saving (`POST /smart`, kind `playlist`). Smart playlists can be edited from their page. Smart collections and playlists show a "Smart" badge and have no manual add/remove (the smart *collection* builder is admin-only and lives in the web admin).
* **Chromecast** (iPhone/iPad and Android phones only; see [Chromecast](#chromecast)).
* **CarPlay & Android Auto** (audio: music, audiobooks, podcasts; see [CarPlay & Android Auto](#carplay--android-auto)).
* **Settings:** edit your account name and profile picture (phones: pick a photo with expo-image-picker, uploaded to `POST /auth/me/avatar`), theme picker (when `allowUserThemes`; applies instantly), playback preferences, Link a TV, signed-in devices (with revoke), switch profile, switch server, sign out and about.
* **Feature flags:** Live TV, DVR, music, photos, IPTV VOD, downloads, requests (Discover), the profile picker and link codes are hidden when the server or the user's permissions turn them off.

## Chromecast

Phones and tablets can cast to a Chromecast or Google TV with [`react-native-google-cast`](https://react-native-google-cast.github.io/), using Google's Default Media Receiver (`CC1AD845`).

> **Cast needs a development build or an EAS build.** It is a native module added by a config plugin, so it does not work in **Expo Go**. Run `npx expo prebuild --clean && npx expo run:ios` (or `run:android`), or `eas build --profile ios|android`. In Expo Go, and in any build made without the plugin, the cast button simply does not appear.

* `app.config.ts` adds the `react-native-google-cast` plugin **only when `EXPO_TV` is unset**, and `react-native.config.js` unlinks the native module for TV builds (the Cast SDK has no tvOS build). The JS side (`src/cast`) loads the module lazily and only when its native part is registered, so TV builds and Expo Go never touch it.
* The cast button is in the video player's top bar and on the now-playing screen. On iOS the plugin also adds the local-network / Bonjour entries the Cast SDK needs.
* While connected, the app requests playback with a Chromecast profile (h264, aac/mp3, mp4 and HLS, max width 1920) and loads `<server> + PlaybackInfo.url` (it already carries the token) with `PlaybackInfo.mimeType`, title, subtitle, an absolute poster URL and the WebVTT subtitle tracks. Channels load as a LIVE stream (HLS forced).
* Local playback pauses and the player shows "Casting to <device>". Play/pause, seeking, subtitle, audio and quality changes go to the receiver, and progress is still reported to the server every 10 s from the receiver's media status. Music and spoken-word queues cast the same way and advance when a track ends.
* Disconnecting hands playback back to the phone at the same position, paused.

## CarPlay & Android Auto

The phone apps show up in **Apple CarPlay** and **Android Auto** as audio apps. Both platforms only allow audio in this category, so the car gets music, audiobooks and podcasts; video and live TV stay on the phone.

> **Needs a development build or an EAS build**, like Chromecast. The car integration is a local native module plus a config plugin, so it does not exist in **Expo Go**, and TV builds leave it out. Where the module is missing, the JS side does nothing.

### What the car shows

| Tab | Contents |
|---|---|
| Home | **Continue listening**: in-progress audiobook parts (one row per book) and podcast episodes, from the `continue` row of `/home` plus `/items?type=bookpart,podcastepisode&sort=lastPlayed`. **Recently played**: the last 10 tracks (`/items?type=track&sort=lastPlayed`). |
| Music | Shuffle all (200 random tracks), Playlists › tracks, Artists › albums › tracks |
| Audiobooks | In progress, then all books. Picking a book resumes it: `GET /items/:id/next` chooses the part, and the player resumes the saved position. |
| Podcasts | Subscribed shows › the 20 newest episodes, with progress |

* A tab only appears when the user can see a library of that kind. Music also needs the server's `features.music` flag. Signed-out, offline and "no audio libraries" states show a single message row.
* Lists are capped (200 artists or tracks, 100 books, 50 playlists or shows, 20 episodes), and both cars may shorten them further while driving. CarPlay allows 4 tabs and 5 levels for audio apps, and the tree fits within both limits.
* **Now Playing** shows artwork, title and artist. CarPlay's **Up Next** lists the rest of the queue.

  | Playing | Phone now-playing screen | Lock screen / notification | CarPlay | Android Auto |
  |---|---|---|---|---|
  | Music | prev / next, shuffle, repeat | prev / next (iOS; the Android notification has play/pause only) | prev / next | prev / next |
  | **Long music** (over 10 min: DJ mixes, live sets, concerts, long classical tracks) | −15 s / +30 s **and** prev / next (shuffle and repeat move to the chips row) | iOS: prev / next. Android: −15 s / +30 s | prev / next, plus −15 s / +30 s buttons under the controls | prev / next, plus −15 s / +30 s custom actions |
  | Audiobook / podcast | −15 s / +30 s, prev / next, speed | −15 s / +30 s | −15 s / +30 s, speed button | −15 s / +30 s, **speed button** (its icon shows the current speed) |

  The long-track threshold is one constant, `LONG_TRACK_MS` in `src/car/policy.ts`. On iOS the lock screen, Control Centre and AirPods/steering-wheel buttons keep previous/next for long tracks on purpose: iOS shows interval skip *instead of* track skip whenever both are enabled. MediaMax DJ mode plays its own crossfading players and short tracks, so it does not get these buttons.
* **Search and voice:**
  * Android Auto supports in-car search (`onSearch`), and Assistant requests such as "play *X* on MediaMax" (`onPlayFromSearch`). Both use `GET /search?q=`. Voice plays the best audio match: a track, an album, a playlist, an artist (shuffled), a book (resumed), or a show (its in-progress or newest episode). When Assistant sends structured extras (focus = artist / album / song / playlist, artist name, album name), they steer the pick ("play the album *Discovery* by Daft Punk" plays the album, not a same-named track). "Play MediaMax" with an empty query resumes the queue, or else continue listening, or else shuffles the music library. A request that cold-starts the app waits until the saved session has been restored.
  * **Assistant transport commands** reach the Android Auto session player: "pause", "next song", "skip forward 2 minutes" / "go back 30 seconds" (absolute seeks computed from the reported position, which is extrapolated natively while playing and clamped to the duration), "jump to 10 minutes", and, for audiobooks and podcasts, "play at 1.5x speed" (`setPlaybackParameters`, forwarded to JS as a `rate` command with the value, snapped to the app's speeds).
  * **Siri:** transport commands ("pause", "next", "skip ahead 30 seconds") go through `MPRemoteCommandCenter` as before; relative seeks on music use `changePlaybackPositionCommand`, which expo-audio keeps enabled. **"Play *X* in MediaMax"** (SiriKit `INPlayMediaIntent`, handled in the app) is implemented but **off by default**, because it needs the Siri capability; see [Siri](#siri-play--in-mediamax).
  * CarPlay shows a Search row on the Home tab on **iOS 27 and later**, because Apple only lets audio apps use the search template from iOS 27.
* Live TV and radio are not in the car. The shared player only queues library items, and channels would need their own playback path through `POST /livetv/channels/:id/play`.

### Architecture

```
            CarPlay (CPTemplateApplicationScene)        Android Auto (MediaBrowser / MediaController)
                         │                                            │
   ios/CarPlaySceneDelegate.swift + CarPlayController.swift   android/MediaMaxCarService.kt (Media3 MediaLibraryService)
                         │                                            │  + CarProxyPlayer (SimpleBasePlayer)
                         └──────────── modules/mediamax-car (Expo module "MediaMaxCar") ─────┘
                                 events: onGetChildren · onSearch · onPlay · onPlayFromSearch · onCommand
                                 calls:  resolveChildren · updateNowPlaying · invalidate · setReady
                                                      │
                            src/car/CarBridge.tsx (mounted inside MusicProvider) + src/car/tree.ts
                                                      │
                     src/state/music.tsx: the same expo-audio queue the phone UI, lock screen and Chromecast use
```

* **One player.** The car never plays audio itself. Anything picked in the car becomes `useMusic().playQueue(…)`, and every car button becomes `toggle` / `next` / `previous` / `skip` / `seek` / `setRate`. The phone's mini player, the lock screen, Chromecast hand-off and server progress reporting therefore keep working unchanged.
* **The browse tree lives in JS** (`src/car/tree.ts`). Native code asks for the children of an opaque id and renders what comes back: a tab bar of `CPListTemplate`s on CarPlay, and `MediaItem`s on Android Auto. Ids look like `tab:music`, `artist:<id>`, `book:<id>`, `episode:<id>` or `play:<context>:<index>:<itemId>`. Requests time out after 20 s, and the car then shows an error.
* **CarPlay Now Playing** is the shared `CPNowPlayingTemplate`. It reads expo-audio's `MPNowPlayingInfoCenter` metadata and `MPRemoteCommandCenter` handlers. A single expo-audio player cannot skip tracks, so after every `setActiveForLockScreen` the player calls `syncCarRemoteCommands` (`src/car/remote.ts`), and the module installs next/previous-track handlers that drive the JS queue. As a result, music on the iPhone lock screen now has working previous/next buttons as well. Spoken audio uses expo-audio's −15/+30 s skip commands, with the intervals set in `src/car/policy.ts` (`lockScreenOptions`). Extra buttons under the controls come from `updateNowPlaying`: a `CPNowPlayingPlaybackRateButton` for spoken audio, and two `CPNowPlayingImageButton`s (SF Symbols `gobackward.15` / `goforward.30`, sending `seekBy`) when `longTrack` is set.
* **Android Auto Now Playing** is the session of `MediaMaxCarService`. Its player is a `SimpleBasePlayer` that mirrors `updateNowPlaying` (position extrapolated natively) and forwards commands to JS. Media button preferences: spoken audio gets −15 s / +30 s in the previous/next slots plus a speed button (`CommandButton.ICON_PLAYBACK_SPEED_*` for 0.8/1/1.5/2×, the generic speed icon otherwise; tapping sends `rate`, and the icon follows the new speed); long music gets −15 s / +30 s in `SLOT_BACK_SECONDARY` / `SLOT_FORWARD_SECONDARY` with `SLOT_OVERFLOW` as fallback, so previous/next keep the main slots and Android Auto shows the skips as custom actions. `COMMAND_SET_SPEED_AND_PITCH` is reported for spoken audio only. expo-audio's own service still owns the phone notification and foreground state, so this service never posts a notification and only lives while Android Auto is bound to it.
* **Artwork on Android Auto** is served through `content://<package>.mediamax.artwork/…` (`ArtworkProvider`), because the car host does not load http(s) artwork. Only URLs the app handed out are fetched, and they are cached in `cacheDir/car-artwork`.
* **Cold starts.**
  * *CarPlay:* CarPlay may launch the app with only the CarPlay scene (iPhone locked). `MediaMaxCarSceneDelegate` then starts React Native into a placeholder window, so the whole app (session, player, bridge) runs. When the phone UI opens later, `MediaMaxPhoneSceneDelegate`, an `ExpoAppSceneDelegate` subclass that replaces the template's `SceneDelegate`, adopts that window instead of starting a second React root.
  * *Android Auto:* if Android Auto binds while the React Native runtime is not running (the process was started just for the car), the service reports "Open MediaMax on your phone to start listening" with an **Open MediaMax** action. As soon as the app is opened, the tree loads. See Limitations.
  * *Siri:* if Siri launches the app in the background for "Play … in MediaMax", the module starts React Native the same way as a CarPlay-first launch and holds the request until the JS bridge is ready.

### Files

| Path | What |
|---|---|
| `modules/mediamax-car/index.ts` | Typed JS API. The module is `null` in Expo Go, on web and on TV. |
| `modules/mediamax-car/ios/` | `MediaMaxCarModule.swift` (bridge), `CarPlayController.swift` (templates, Now Playing, search), `CarPlaySceneDelegate.swift` (CarPlay + phone scene delegates), `CarShared.swift` (records, events, remote commands), `SiriIntents.swift` (`INPlayMediaIntent` handler). The pod is iOS-only. |
| `modules/mediamax-car/android/` | `MediaMaxCarService.kt` (MediaLibraryService), `CarProxyPlayer.kt`, `ArtworkProvider.kt`, `CarBridge.kt`, `MediaMaxCarModule.kt`. Media3 1.9.1, the same version expo-audio uses. |
| `plugins/withMediaMaxCar.js` | Config plugin (see below) |
| `src/car/CarBridge.tsx`, `src/car/tree.ts`, `src/car/remote.ts` | JS side |
| `src/car/policy.ts` | Pure decisions: `LONG_TRACK_MS`, lock-screen options per platform, speed cycling / snapping, voice-search best match. Unit-tested by `npm test` (`tests/car-policy.test.mjs`, Node's test runner). |

### What the config plugin changes

`app.config.ts` adds `['./plugins/withMediaMaxCar', { isTV, siri }]` (`siri` from `MEDIAMAX_SIRI=1` or `"siri": true` in the brand's `brand.json`).

* **iOS:**
  * the `com.apple.developer.carplay-audio` entitlement
  * in `UIApplicationSceneManifest`, a `CPTemplateApplicationSceneSessionRoleApplication` scene (`MediaMaxCarSceneDelegate`), with the phone scene's delegate switched to `MediaMaxPhoneSceneDelegate`. The template's `SceneDelegate.swift` still compiles but is no longer used, so config plugins that edit it have no effect.
  * `UIBackgroundModes` includes `audio`
  * `AppDelegate.swift` gets `application(_:handlerFor:)`, which hands `INPlayMediaIntent` to `MediaMaxSiri` (always added so CI compiles it; it does nothing until the Info.plist lists the intent)
  * with `siri` only: `INIntentsSupported: [INPlayMediaIntent]`, `INSupportedMediaCategories` (music, audiobooks, podcasts), `NSSiriUsageDescription` and the `com.apple.developer.siri` entitlement
* **Android:**
  * `tv.mediamax.car.MediaMaxCarService` (exported, with the `androidx.media3.session.MediaLibraryService` and `android.media.browse.MediaBrowserService` intent filters)
  * the artwork provider
  * `<meta-data android:name="com.google.android.gms.car.application" android:resource="@xml/automotive_app_desc"/>`
  * `res/xml/automotive_app_desc.xml` containing `<automotiveApp><uses name="media"/></automotiveApp>`
* **TV (`EXPO_TV=1`):** none of the above. On Android, `settings.gradle` gets `expoAutolinking.exclude += 'mediamax-car'`. On tvOS, autolinking skips the iOS-only pod. `react-native.config.js` also unlinks it for TV, the same way as Chromecast.

Check the result without building:

```bash
npx expo config --type introspect | grep -n -i -E "carplay|SceneDelegate|MediaMaxCarService|automotive"
EXPO_TV=1 npx expo config --type introspect | grep -c -i carplay     # 0
```

### Build and test

```bash
npx expo prebuild --clean
npx expo run:ios          # or: npx expo run:android
```

**CarPlay (Simulator):**

1. Run the development build on an iPhone simulator.
2. Choose **Simulator › I/O › External Displays › CarPlay**. The MediaMax icon appears on the CarPlay home screen.
3. Test both launch orders: open the app on the phone first, and also launch it from the CarPlay window with the app killed (CarPlay-first). Then check that playback, the lock screen and the phone's mini player stay in sync.

The simulator works with the entitlement in a development build. Real cars need Apple's approval (see below). The CarPlay-first cold launch is best verified with a Release build. CarPlay-first launch of an `expo-dev-client` build has not been verified, because dev-launcher sets up its window differently.

**Android Auto (Desktop Head Unit):**

1. Install the **Android Auto Desktop Head Unit (DHU)** from the Android Studio SDK Manager (SDK Tools › Android Auto Desktop Head Unit Emulator).
2. On the phone or emulator (with Google Play), open Android Auto settings and tap the version 10 times to enable developer settings. Turn on **Unknown sources**, then choose **Start head unit server** from the overflow menu.
3. Run:

   ```bash
   adb forward tcp:5277 tcp:5277
   $ANDROID_SDK_ROOT/extras/google/auto/desktop-head-unit
   ```

4. Open MediaMax on the phone once, so that React Native is running, and then pick MediaMax in the DHU launcher. For voice, type `mic begin` in the DHU console and speak, for example "play Daft Punk on MediaMax".
5. `adb logcat | grep -i -E "MediaSession|MediaMaxCar"` shows the session traffic. Google's **Media Controller Test** app (github.com/googlesamples/android-media-controller) can also browse the service and send play-from-search requests without a car.

Side-loaded builds only appear in Android Auto with **Unknown sources** on. Builds from the Play Store (including internal testing) show up normally.

### Siri: "Play … in MediaMax"

Off by default. When on, Siri hands requests such as "Play *Discovery* by Daft Punk in MediaMax", "Play the audiobook *Dune* in MediaMax" or "Play MediaMax" to the app (in-app intent handling, no Intents extension). `SiriIntents.swift` resolves the request to a placeholder item and passes the `INMediaSearch` (title, artist, album, media type) to JS as `onPlayFromSearch`, which searches the server and plays the best match exactly like Android Auto voice requests. "Play MediaMax" resumes the queue (or continues listening).

To turn it on for a build:

1. In Certificates, IDs & Profiles, enable the **SiriKit** capability on the App ID (needs a paid Apple developer account) and regenerate the provisioning profiles, for example with `eas credentials`. EAS-managed credentials usually sync the capability by themselves from the entitlement.
2. Build with `MEDIAMAX_SIRI=1` (or `"siri": true` in `branding/<brand>/brand.json`), then `npx expo prebuild --clean`.
3. Check: `MEDIAMAX_SIRI=1 npx expo config --type introspect | grep -n -E "INPlayMediaIntent|developer.siri"`.
4. On the phone, ask Siri "Play *something* in MediaMax". The first time, iOS may ask whether MediaMax may use Siri.

Unsigned simulator builds (CI) compile either way, because the entitlement is only applied when signing. Siri media requests only work on a real device. Without the capability on the App ID, signed builds with the flag fail to sign, so leave it off for brands that don't have it. tvOS builds never get it.

### Account steps before release

* **Apple:** request the **CarPlay audio app** entitlement at <https://developer.apple.com/contact/carplay/> for the team that ships the app. After Apple grants it, enable the CarPlay capability on the App ID (Certificates, IDs & Profiles) and regenerate the provisioning profiles, for example with `eas credentials`. Without the grant, App Store and TestFlight builds that contain the entitlement fail to sign or are rejected, so for white-label builds request it per bundle id, or drop the plugin for brands that don't have it. Apple's CarPlay guidelines also apply: no lyrics on the car screen, and no prompts asking the driver to pick up the phone.
* **Google:** nothing to request. Media apps must pass the Android Auto quality review when submitted to Play. In Play Console, add the Android Auto form factor (Advanced settings › Form factors) before publishing.

### Limitations

* **Android Auto cold start:** the browse tree and the player live in the React Native app. If Android Auto starts the process without the app (for example after a reboot), the car shows "Open MediaMax on your phone to start listening" until the app has been opened once. After that it works in the background, also with the screen off. Removing this limit would mean starting a headless React Native surface from the service, or moving the queue into native code.
* There is no queue editing from the car, and Android Auto does not show its queue. Live TV and radio are not included.
* Siri "Play … in MediaMax" is behind the `siri` flag (see [Siri](#siri-play--in-mediamax)) and has not been tried on a device. Siri may ask the user to authorize MediaMax the first time; the app does not call `INPreferences.requestSiriAuthorization` itself.
* Long-music ±15/30 s on iOS: not on the lock screen or AirPods (by design, see above). Siri "skip ahead 30 seconds" during long music relies on iOS mapping it to `changePlaybackPositionCommand`.
* Android Auto's placement of custom actions (how many show next to previous/next before going to the overflow) is decided by the car host and varies between versions.
* Downloads are not used offline in the car browse tree. It needs the server, although a downloaded item that is already queued still plays offline.
* Native code was written against the iOS 26/27 CarPlay SDK and Media3 1.9.1 (checked against the Media3 1.9.1 sources), but it has only been type-checked on the JS side here; the Native apps CI workflow compiles it. Run the simulator/DHU checks above before shipping, including a long track (over 10 minutes), a podcast's speed button and Assistant voice commands on the DHU.

## File layout

```
apps/mobile
├── app/                      expo-router routes
│   ├── _layout.tsx           providers, auth guard, themed Stack, dynamic splash, floating mini player
│   ├── index.tsx             entry (guard redirects)
│   ├── connect.tsx           add / pick servers
│   ├── login.tsx             profiles + PIN, password, TV link code
│   ├── link-tv.tsx           phone approves a TV code
│   ├── (tabs)/               home, libraries, live, search, discover, downloads, settings (+ custom tab bar)
│   ├── requests.tsx          my requests / admin request queue
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
│   ├── cast/                 Chromecast: lazy module loader, CastProvider/useCast, CastButton, MediaInfo builder
│   ├── car/                  CarPlay / Android Auto: CarBridge (events <-> player), browse tree, remote commands,
│   │                         policy.ts (long-track skips, speeds, voice-search match)
│   ├── tv/                   remote events, back/menu handling, focus guide
│   └── utils/                formatting, navigation helpers, event bus
├── modules/mediamax-car/     local Expo module: CarPlay scene + templates, Siri intent (Swift), Android Auto MediaLibraryService (Kotlin)
├── plugins/withMediaMaxCar.js config plugin: CarPlay entitlement + scenes, Siri (opt-in), Android Auto service/manifest, TV exclusion
├── tests/                    `npm test`: Node unit tests for pure JS logic (src/car/policy.ts)
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
#    `npm run brand` does this for you when the server has a TV banner (Branding.tvBannerUrl)
#    and/or a top shelf image (Branding.topShelfUrl): it downloads them, resizes them with
#    @expo/image-utils, and derives the 2x / wide top-shelf sizes plus the three Apple TV icons
#    from icon.png (config-tv only applies Apple TV art when all seven exist). Files you add
#    by hand are never overwritten (brand.json > generatedAssets lists what the script owns).
#    If resizing fails (e.g. the server serves WebP/SVG), the script lists the files to add by hand.

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
* **PIN length:** the PIN pad auto-submits at the profile's `pinLength` (4 if the server doesn't say).
* **Downloads** fetch the original file unless a converted quality is chosen; on iOS, containers it can't play (for example MKV) are fetched as 1080p. The app does not read `X-MediaMax-Duration-Ms` (expo-file-system's download task doesn't expose response headers); it uses the item's `durationMs`.
* **Artist play-all** loads every track with one `GET /items?ancestorId=<artist>&type=track&sort=index&limit=500` call.
