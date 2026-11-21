# Store listing draft (all stores)

Written from the code as of this branch. Paste, then adjust to taste. Character counts are given where a store
limits them. Keep the wording rules in [`PUBLISHING.md`](../PUBLISHING.md#what-every-store-review-needs): the app
**provides no content**; never mention IPTV, Xtream, "free channels" or other services' names (Plex, Jellyfin,
Netflix, …) in the listing, keywords or screenshots.

## Name and short texts

| Field | Text | Limit |
|---|---|---|
| App name | **Kinora** (if taken: **Kinora – Home Media Server**, 26) | Apple 30, Google 30, Amazon 250 |
| Apple subtitle | **Your own home cinema** (20) | 30 |
| Apple promotional text | Watch and listen to the movies, shows, music, audiobooks, podcasts and photos on your own Kinora server: at home, on the go and on the big screen. (146) | 170 |
| Google short description | Stream the movies, shows, music and photos on your own Kinora media server. (75) | 80 |
| Apple keywords | `media server,home cinema,movies,tv shows,music,audiobooks,podcasts,photos,self-hosted,4K,HDR,player` (99) | 100 |
| Category | Apple: **Entertainment** (secondary: Music). Google: **Video Players & Editors** or **Entertainment**. Amazon: Movies & TV. Samsung / LG: Video / Entertainment. Roku: Movies & TV (or "Personal media"). | |
| Support URL / e-mail | `[support URL]`, `[support e-mail]` (shown publicly: use a dedicated address) | |
| Privacy policy URL | `[https://your-domain/privacy]`: host [`docs/PRIVACY.md`](../PRIVACY.md) | required everywhere |

## Full description (Apple / Google / Amazon / Samsung / LG / Roku)

> Kinora is the app for your own home cinema. Connect it to a Kinora media server that you run at home or on your
> own hardware, and everything in your library is ready on your phone, tablet and TV.
>
> **Your library, beautifully presented**
> • Movies and TV shows with artwork, seasons, episodes and "Continue watching"
> • Music with albums, artists, playlists and background playback
> • Audiobooks and podcasts that remember where you stopped
> • Photo albums, full screen
> • Live TV and a programme guide from your own TV tuner, with recordings managed by your server
>
> **Plays what you have**
> • 4K, HDR10 and Dolby Vision where your screen supports them, with automatic conversion when it doesn't
> • Subtitles, audio-track choice, skip intro and up-next
> • Downloads for offline viewing on phones and tablets (when your server allows it)
> • AirPlay and Chromecast on phones; full remote-control navigation on TVs
>
> **Private by design**
> Kinora has no ads, no analytics and no tracking. The app talks only to the server you connect it to. Nothing
> about what you watch is sent to us.
>
> **Made for every screen**
> iPhone, iPad and Apple TV; Android phones, tablets, Android TV / Google TV and Fire TV; Samsung and LG TVs; Roku.
> Your server's own name, logo and colours appear in the app, and settings follow you from device to device.
>
> Kinora does not include any films, shows, music or channels. You need a Kinora server (free, open source:
> `[project URL]`) with your own media.

Keep the last paragraph: it is what store content reviewers look for in media-server clients.

### TV-store variants

- **Samsung / LG / VIDAA:** the TV app is a thin wrapper that opens the server's own web app in TV mode, so it
  always matches the server's version. Say so in the "what's new"/description if a store asks how updates work.
- **Roku:** the channel has no music, photos, audiobooks or podcasts yet (see `apps/roku/README.md`). Drop those
  bullets from the Roku listing.
- **Apple TV / Android TV / Fire TV:** no downloads, no Chromecast/AirPlay sending; drop those bullets.

## Privacy answers

### What the apps actually send, and to whom (from the code)

| Where | Call | When | Recipient |
|---|---|---|---|
| All apps | `/api/v1/*` REST calls, `/api/v1/ws` WebSocket, images, HLS/direct streams, downloads, subtitles, bandwidth test (`/api/v1/playback/bandwidth-test`) | Always | **The user's own Kinora server** (the address they type) |
| All apps | Headers `X-Kinora-Device-Id` (random id made on the device; Roku: its channel client id), `-Device-Name` (the OS device name, e.g. "Sam's iPhone"; Roku: model), `-Platform`, `-Version` | Every request | The user's own server |
| Phones (iOS/Android) | Google Cast SDK (`react-native-google-cast`, Default Media Receiver `CC1AD845`): local-network discovery of Chromecasts; on Android through Google Play services | When the phone app runs (not in TV builds) | Devices on the LAN; **Google** (SDK) |
| Phones | System browser / in-app browser to the server's sign-in provider (OIDC), Trakt or Last.fm linking pages, the server's help page, the server's support link, a title's trailer URL (often YouTube) | Only when the user taps the button | The site opened |
| Phones | Remote font file (`.ttf`/`.otf`) when the server's admin set one in the theme | Admin choice | The font host the admin chose |
| Phones | Profile picture: picked from the photo library, uploaded to `/auth/me/avatar` | User action | The user's own server |
| Samsung / LG / VIDAA | The wrapper checks `GET /api/v1/system/info`, then loads the server's web app (`/?tv=1`) | Always | The user's own server |
| Samsung / LG / VIDAA (web app) | Google Fonts CSS and font files | Only if the server's theme uses a web font (several built-in themes such as Synthwave, Film Noir or Paper White, or an admin-chosen font; the default Kinora theme does not) | **Google** (fonts.googleapis.com, fonts.gstatic.com) |
| Samsung / LG / VIDAA (web app) | `youtube-nocookie.com` embed | Only when the user opens a trailer that is a YouTube link | Google / YouTube |
| Roku | SSDP M-SEARCH on the LAN (server discovery), then the REST API | Always | LAN; the user's own server |

There are **no** analytics, crash-reporting, advertising or attribution SDKs, no OTA update service (no
`expo-updates`), and no calls to the developer. Two privacy improvements were made on this branch: the web app no
longer pre-connects to Google Fonts on every load (only a theme that uses a web font loads it), and the Google Cast
sender SDK is no longer loaded in TV browsers (LG webOS reports itself as Chrome, so it used to be).

### Apple App Privacy ("nutrition label")

**Data Not Collected**, with one check first:

- Data sent to the user's own server is not "collected": Apple counts data as collected when it is sent off the
  device in a way that lets **you or your partners** access it beyond servicing the request. You don't run or see
  users' servers.
- **Google Cast SDK (iPhone/iPad builds).** Google publishes a data-use disclosure for the iOS Cast SDK. Read the
  current version before answering; if it lists data types (for example device identifiers or diagnostics), declare
  them as collected by a third party, not linked to the user, not used for tracking. Alternatively, ship without
  Chromecast on iOS to keep "Data Not Collected" with no caveat.
- Tracking: **No** (no IDFA, no App Tracking Transparency prompt needed).

### Google Play Data safety

- Does your app collect or share any of the required user data types? **No**, with the same Cast caveat: Google's
  guidance says data handled by SDKs in your app counts, so check Google's Data safety notes for the Cast framework /
  Google Play services before submitting.
- Is all user data encrypted in transit? **Not always**: the app allows `http://` for home servers on the LAN
  (`usesCleartextTraffic`). Answer "No" (or answer only for HTTPS servers if the form allows it); this does not stop
  approval.
- Can users request deletion? Data lives on the user's own server; say "Data is not collected" (no deletion
  mechanism needed). Account deletion on the server: Admin → Users.

### Amazon, Samsung, LG, Roku

Same facts: no personal data collected by the developer; the app connects to a server the user specifies; no ads,
analytics or tracking. Roku's channel properties: no ads (no RAF), no data collection; Samsung/LG: link the hosted
privacy policy.

## Age rating

The apps contain no content; everything shown comes from the user's own server.

- **Apple** (age-rating questionnaire): answer **None** for every content descriptor, **No** for unrestricted web
  access, user-generated content, chat, gambling and in-app purchases. Expected rating: **4+**. If App Review
  pushes back ("users can play any media"), answer that content comes from the user's own library and that servers
  have per-user rating limits and PIN-protected profiles (Admin → Users → max content rating), then accept 12+/16+
  if they insist; don't argue past one reply.
- **Google (IARC)**: category "Reference, News or Educational"/"Other" (not a game); no violence, sexuality,
  language or controlled substances *in the app*; "Does the app allow users to interact or exchange content?"
  **No**; "Does the app share the user's location?" **No**; digital purchases **No**. Target audience: **18+ /
  not designed for children** (keeps you out of Families policy).
- **Amazon, Samsung, LG, Roku**: "General audience / All ages" for the app itself; same explanation if asked.

## Permissions (what each one is for)

| Platform | Permission | Why |
|---|---|---|
| iOS | Local Network (`NSLocalNetworkUsageDescription`) | Reach a Kinora server on the home network; Chromecast discovery |
| iOS | Photo library (`NSPhotoLibraryUsageDescription`, via image picker) | Optional: choose a profile picture. Asked only when the user taps "Change picture" |
| iOS | Background audio (`UIBackgroundModes: audio`) | Music, audiobooks and podcasts keep playing when the screen is locked |
| iOS | App Transport Security exception (`NSAllowsArbitraryLoads`, `NSAllowsLocalNetworking`) | Home servers often use `http://` on a local address |
| iOS | CarPlay audio entitlement; Siri (only if built with `siri: true`) | Audio in the car; "Play … in Kinora" |
| Android | `INTERNET`, `ACCESS_NETWORK_STATE` | Talk to the server; know when it's offline (downloads) |
| Android | `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `WAKE_LOCK` | Playback continues with the screen off, with a media notification |
| Android | Cleartext traffic | `http://` home servers |
| Android TV / Fire TV | Leanback launcher, touchscreen not required | TV form factor |
| Samsung Tizen | `internet`, `tv.inputdevice` | Reach the server; use the remote's media and colour keys |
| LG webOS | `time.query` | Clock in the TV top bar |
| Roku | (none declared) | |

The Android list is from `app.config.ts` plus what Expo modules add; after `npx expo prebuild -p android` confirm
it against `android/app/src/main/AndroidManifest.xml` (the merged manifest of the release build is what Play shows).

## Screenshots and video

See [`APP_REVIEW.md` → Screenshots](../APP_REVIEW.md#screenshots-and-preview-video) for the sizes each store needs
and which of the generated images fit which store.
