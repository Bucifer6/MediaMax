# App review: demo server, review notes and store media

Store reviewers have to see Kinora working. Kinora's apps are clients for a server the user runs, so out of the box
a reviewer has nothing to connect to. This page sets that up once for every store (Apple, Google, Amazon, Samsung,
LG, Roku) with **content that raises no rights questions**, and holds the text to paste into each store's review
notes.

**In short:** run the **review server** (a separate, throwaway Kinora in Docker, seeded with the rights-free review
pack and one reviewer account), put its address and the account in each store's review notes, and use the generated
screenshots and preview video.

- [Why a review server and not a demo mode](#why-a-review-server-and-not-a-demo-mode)
- [What the stores require](#what-the-stores-require)
- [What reviewers see](#what-reviewers-see)
- [Host the review server](#host-the-review-server)
- [Review notes to paste](#review-notes-to-paste)
- [Step by step for reviewers, per platform](#step-by-step-for-reviewers-per-platform)
- [What to test](#what-to-test)
- [Permissions](#permissions)
- [Screenshots and preview video](#screenshots-and-preview-video)
- [Troubleshooting](#troubleshooting)

## Why a review server and not a demo mode

An in-app demo mode (bundled media, no server) was considered first, because it needs no infrastructure. It isn't
practical for Kinora:

- **The apps are thin clients.** Everything a reviewer would look at (home rows, libraries, artwork, search, the
  guide, playback with transcoding to HLS, subtitles, progress sync) comes from the server's REST API. A demo mode
  would mean writing a fake server inside four separate codebases: the Expo app (iOS, iPadOS, tvOS, Android,
  Android TV, Fire TV), the Roku channel (BrightScript), and the web app.
- **The Samsung, LG and VIDAA apps *are* the server's web app.** The wrapper asks for an address and loads the
  server's own UI (`tv/README.md`). There is nothing to put a demo mode into without a server.
- **Apple only accepts a demo mode "with prior approval"** when a demo account is impossible (Guideline 2.1). A demo
  account is possible here, so that's what Apple expects.

The review server needs no change to the apps, works the same for all nine clients, shows reviewers the real thing,
and exposes nothing personal: it is a separate Kinora instance on its own Docker volumes, with only the review pack
mounted (read-only), and it never sees the owner's own server or media.

## What the stores require

| Store | Requirement | Where the details go |
|---|---|---|
| **Apple** (iPhone, iPad, Apple TV) | [App Review Guideline 2.1 (a)](https://developer.apple.com/app-store/review/guidelines/#app-completeness): *"include demo account info (and turn on your back-end service!) if your app includes a login. If you are unable to provide a demo account due to legal or security obligations, you may include a built-in demo mode in lieu of a demo account with prior approval by Apple. Ensure the demo mode exhibits your app's full features and functionality."* Also 2.3.3/2.3.4: screenshots and previews must show the app in use. | App Store Connect → the version → **App Review Information**: *Sign-in required* ✓, user name, password, **Notes** |
| **Google Play** (phone, tablet, Android TV) | Play Console → **App content → App access**: if any part of the app is restricted (sign-in, a server address), give instructions and credentials so reviewers can reach all functionality, and keep them working; reviews fail with "Couldn't access app" otherwise. | App access → *All or some functionality is restricted* → **Add instructions** (name, user name, password, any other information) |
| **Amazon Appstore** (Fire TV) | Submissions that need a login must include working test credentials, or the app is rejected as "unable to test". | App submission → **Testing instructions** |
| **Samsung Seller Office** (Tizen TV) | TV certification tests the app on real TVs; apps that need an account must supply a test account. | Application → **Test account / Comments to the certification team** |
| **LG Seller Lounge** (webOS) | QA needs a test account for apps that require sign-in. | App registration → **Test account information / QA comments** |
| **Roku** | Certification requires that reviewers can reach the content; channels with sign-in must give test credentials (a public channel must also not show content it has no rights to). | Developer dashboard → the channel → **Support information / certification notes ("Test account")** |

Field names in the TV stores' forms change from time to time; look for "test account" or "testing instructions".
The Google, Amazon, Samsung, LG and Roku help pages could not be fetched from the machine this pack was built on,
so those rows describe each form as it's generally known; check the wording when you submit.

## What reviewers see

One account, **`appreview`** (name configurable), on a server called **Kinora Demo**:

| Library | Content (all CC0: see [`store/CREDITS.md`](store/CREDITS.md)) |
|---|---|
| Movies | *Aurora Drift* (1080p, English subtitles), *Lumen* (4K HDR10, 5.1), *Kinora Calibration Reel* (720p), *Paper Orbit* (480p) |
| TV Shows | *Pixel Tides*, season 1, three episodes with artwork and episode info |
| Music | *First Light* by Glasshouse Signals (4 generated tracks); 3 CC0 tracks by HoliznaCC0 and Loyalty Freak Music |
| Audiobooks | *The Clockmaker's Garden* (3 chapters, synthetic narration) |
| Podcasts | *Kinora Notes* (2 episodes, RSS) |
| Photos | 9 generated pictures in two albums |
| Live TV | *Kinora Test Card* and *Kinora Ambient*: generated loops with a 7-day guide (turn off with `REVIEW_LIVETV=0`) |

The account is a normal user (not an admin): it can stream from outside the home network, download, use Live TV,
and transcode; it can't record (DVR off), see admin pages or change other accounts. Features that would show
third-party content are switched off on the review server: **Discover / requests** (posters from TMDB), **IPTV
VOD**, and online metadata (every library has metadata fetching off, so nothing is looked up or matched online).

Every `REVIEW_RESET_HOURS` (6 by default) the seeder puts the account back: password, permissions, enabled, 2FA
off. If a reviewer changes the password or turns on 2FA, the next reviewer still gets in.

## Host the review server

You need: a small Linux host with Docker (1 vCPU / 1 GB RAM is enough; 2 GB disk), a DNS name for it, and HTTPS.
The owner's setup (Docker + Caddy, see [`DEPLOY.md`](DEPLOY.md#caddy)) fits. **Use a VPS or a host on its own
network, not your home LAN:** the review server allows Kinora to read feeds from private addresses (so it can read
the podcast and channels from the `fixtures` container), and a reviewer account could point a podcast subscription
at another private address.

### 1. Build the pack (on any machine with ffmpeg, eSpeak NG, zip and Playwright)

```bash
npm ci
npm install --no-save playwright@1.63.0 && npx playwright install chromium
npm run review-pack
```

This writes `dist/kinora-review-pack-<version>.zip` (about 150 MB) and its `.sha256`. It takes 15–30 minutes on
four cores; most of it is the 4K HDR film. It downloads only the three CC0 tracks, and stops if their SHA-256 has
changed. Add `--work=<dir>` to keep the work folder and reuse finished files on the next run.

### 2. Copy it to the server and fill in `.env`

```bash
scp dist/kinora-review-pack-0.1.0.zip you@review-host:
ssh you@review-host
unzip kinora-review-pack-0.1.0.zip && cd kinora-review-pack-0.1.0
cp .env.example .env && chmod 600 .env
openssl rand -base64 18      # run twice: one admin password, one reviewer password
nano .env                    # REVIEW_HOST, REVIEW_PUBLIC_URL, both passwords
```

Never commit `.env` or paste the passwords anywhere but the store forms. The seeder refuses to start while either
password is still the `change-me…` placeholder or shorter than 12 characters.

### 3. Start it

Behind the Caddy you already run (Kinora listens on `127.0.0.1:8495` only):

```bash
docker compose up -d
docker compose logs -f seed      # wait for "check: "appreview" can sign in; home has N rows" and "done"
```

Add the site to your Caddyfile and reload Caddy:

```caddyfile
kinora-review.example.com {
	reverse_proxy 127.0.0.1:8495 {
		flush_interval -1
	}
	request_body {
		max_size 64MB
	}
	header X-Robots-Tag "noindex, nofollow"
}
```

No Caddy on the host? `docker compose --profile https up -d` starts one in the stack that gets the certificate
itself (needs ports 80 and 443).

If your Caddy runs in Docker rather than on the host, `127.0.0.1:8495` is not reachable from it: put both stacks on
one Docker network and proxy to `kinora:8484` instead.

### 4. Check it like a reviewer

```bash
curl -s https://kinora-review.example.com/api/v1/system/info | head -c 300; echo
```

Then open `https://kinora-review.example.com` in a private browser window, sign in as the reviewer, and play a film,
an episode, a song, the podcast and a live channel. Install the apps (TestFlight, Play internal test) and do the same.

### 5. Keep it running during reviews

- Leave it up from submission until the app is live, and **for every update** you submit (reviewers test each
  version).
- Updates: build a new pack, unzip it next to the old one, copy `.env` across, `docker compose up -d` in the new
  folder (the volumes are named `kinora-review_*`, so the server's database carries over). To start completely
  fresh: `docker compose down -v`.
- `docker compose pull && docker compose up -d` picks up a new Kinora image; pin a version with `KINORA_IMAGE`.
- Want to watch what reviewers do? Sign in as the review admin: **Admin → Dashboard / Activity**.

### Security

- Kinora is published on loopback only; the only way in is HTTPS through Caddy.
- The reviewer is not an admin, cannot record, and is reset every few hours. The admin password never goes in a
  review note.
- `MEDIAMAX_ALLOW_PRIVATE_URLS=1` is set so Kinora can read the `fixtures` service; that is why the stack belongs
  on a VPS or an isolated host. The containers run with `no-new-privileges`.
- The server name, login message and content make it obvious this is a demo; `X-Robots-Tag: noindex` keeps it out
  of search engines.

## Review notes to paste

Replace `kinora-review.example.com`, the user name and the password with yours.

### Apple: App Review Information → Notes

```text
Kinora is a client for a personal media server that the user runs on their own hardware (like a home NAS). The app
contains no content; users play their own movies, shows, music, audiobooks, podcasts and photos.

We run a demo server for review. Every item on it was generated by us or is public domain (CC0), so there are no
third-party rights involved.

1. Open the app. On "Connect to your server", enter: https://kinora-review.example.com
2. Sign in with the user name and password above (Sign-in information).
   On Apple TV, choose "Password" on the sign-in screen (the default is a link code for signing in from a phone).
3. Home shows the demo library. Try: Movies > Lumen (4K HDR, 5.1), Aurora Drift (subtitles: open the player's
   subtitle menu), TV Shows > Pixel Tides (episodes, up next), Music > First Light (background playback, lock
   screen controls), Audiobooks, Podcasts > Kinora Notes, Photos, and Live TV (two generated test channels with a
   guide). On iPhone/iPad, Downloads lets you save an item for offline viewing.

App Transport Security: users connect to servers on their home network, which commonly use http:// on local
addresses, so the app allows arbitrary loads. The demo server uses HTTPS.

Local network permission: used to reach a server on the home network and to find Chromecast devices.
```

### Google Play: App content → App access → Add instructions

- **Name:** Demo server
- **Username / password:** the review account
- **Any other information:**

```text
Kinora connects to a media server that the user runs themselves; the app has no built-in content. Use our demo
server, where all content was generated by us or is public domain (CC0):
1. Open the app and enter the server address: https://kinora-review.example.com
2. Sign in with the username and password above.
3. Browse Movies, TV Shows, Music, Audiobooks, Podcasts, Photos and Live TV (generated test channels). Everything
   can be played. On Android TV, use the D-pad; on the sign-in screen choose "Password".
```

### Amazon Appstore (Fire TV): Testing instructions

```text
This app is a client for a personal media server (the user's own). Demo server for testing (all content generated
by us or CC0): https://kinora-review.example.com
User name: appreview   Password: <reviewer password>
On first launch enter the server address with the on-screen keyboard, then on the sign-in screen choose "Password"
and sign in. Use the remote's D-pad, Select, Back, Play/Pause, Rewind and Fast-forward.
```

### Samsung Seller Office / LG Seller Lounge: test account and comments

```text
The app is a TV client for a personal media server run by the user. Test server (content generated by us or CC0):
  Server address: https://kinora-review.example.com   (type it in full, with https://, on the first screen)
  User name: appreview
  Password: <reviewer password>
Steps: enter the address, press OK, sign in with the user name and password. Navigate with the arrow keys and OK;
Back closes dialogs and goes back; on the home screen Back twice exits the app. Media keys (play/pause, stop, rewind,
fast-forward) work in the player.
```

The TV start screen treats an address without a scheme as a home server (`http://…:8484`), so the note must give
the full `https://` address.

### Roku: certification notes / test account

```text
Kinora is a channel for a personal media server that the user runs. Test server (all content generated by us or
CC0): https://kinora-review.example.com
On the server screen choose "Enter server address..." and type the full address: https://kinora-review.example.com
On the sign-in screen choose "Username and password": appreview / <reviewer password>.
The channel covers movies, TV shows and live TV; music, photos and podcasts are not in the Roku channel yet.
```

## Step by step for reviewers, per platform

| Platform | First run | Sign in | Then |
|---|---|---|---|
| **iPhone / iPad** | "Connect to your server" → type the address → *Connect* | Branded *Kinora Demo* screen → *Password* → user name + password → *Sign in* | Tab bar: Home, Libraries, Search, Live, Downloads, Settings |
| **Apple TV** | Address with the Siri Remote keyboard | Sign-in shows a link code; choose **Password** (or approve the code from the phone app: Settings → Link a TV, or `https://<server>/link` in any browser) | Top bar; Menu goes back; ←/→ seek ±10 s in the player |
| **Android phone / tablet** | Same as iPhone | Same as iPhone | Same; Back button works everywhere |
| **Android TV / Google TV / Fire TV** | Address with the on-screen keyboard | **Password** chip, or the link code from a phone/browser | D-pad, Select, Back, media keys |
| **Samsung (Tizen) / LG (webOS) / VIDAA** | Start screen asks for the address (type `https://` too); it checks it and opens the server's TV-mode web app | Username + password (or "Link a device") | Arrow keys + OK; Back twice on Home exits; media keys in the player |
| **Roku** | Server screen (LAN discovery won't find the review server) → *Enter server address...* with `https://` | *Username and password* (or link code at `https://<server>/link`) | `*` on the remote toggles favourites/options |
| **Web** (not a store app) | Open the address in a browser | Username + password | — |

## What to test

A checklist for you before submitting, and the same flow reviewers follow:

- [ ] Connect by address, sign in with the review account (and on TVs: the Password option and the link code).
- [ ] Home loads with artwork; Continue watching appears after you stop a film part-way.
- [ ] **Movies:** Lumen shows the **4K / HDR10** badges and plays (SDR conversion on non-HDR screens); Aurora Drift
      plays with the **English subtitles** on; seek, pause, resume; Calibration Reel tone and bars.
- [ ] **TV:** Pixel Tides season and episodes; episode 1 → *Up next* to episode 2; resume.
- [ ] **Music:** First Light plays in order, shuffle, background playback, lock-screen / Control Centre controls,
      CarPlay/Android Auto if you have them.
- [ ] **Audiobooks:** chapters, resume where you stopped. **Podcasts:** Kinora Notes, both episodes play.
- [ ] **Photos:** both albums, full-screen, swipe/arrow keys.
- [ ] **Live TV:** both test channels play; the guide shows now/next; channel up/down on TVs.
- [ ] **Search:** "aurora", "pixel", "glasshouse".
- [ ] **Downloads** (phones): download Paper Orbit, turn on airplane mode, play it.
- [ ] **Sign out** and sign back in. Settings → Switch server works.
- [ ] TV apps: every screen reachable with the remote alone; Back never traps; Back on Home exits (Samsung/LG
      require this; tvOS Menu at top level goes to the TV's Home screen).
- [ ] No crashes with airplane mode on at launch (the app should show the server as unreachable and offer downloads).

## Permissions

Reviewers sometimes ask why a permission is there. The full table is in
[`store/LISTING.md` → Permissions](store/LISTING.md#permissions-what-each-one-is-for). In short:

- **Local network** (iOS): reach a server on the home network; find Chromecasts.
- **Photos** (iOS/Android, asked only on "Change picture"): pick a profile picture, uploaded to the user's server.
- **Background audio / foreground media service** (iOS/Android): music, audiobooks and podcasts keep playing with
  the screen off.
- **Cleartext HTTP / ATS exception**: home servers on `http://` local addresses.
- **TV input devices** (Tizen), **time** (webOS): remote keys; the clock in the top bar.

No camera, microphone, location, contacts, tracking (no ATT prompt), notifications or Bluetooth permission is
requested.

## Screenshots and preview video

### What is generated, and where it fits

`node scripts/review-pack/store-shots.mjs --pack=<unzipped pack>` boots a throwaway Kinora with the review pack,
signs in as the reviewer and records Kinora's own UI. Committed results (JPEG, no alpha channel):

| Folder | Size | Shows | Use it for |
|---|---|---|---|
| [`store/screenshots/tv/`](store/screenshots/tv/) | 1920×1080 | The web app in **TV mode**: home, 4K HDR film, series, player, guide, music, photos | **Samsung, LG, VIDAA** listings (their apps *are* this UI) |
| [`store/screenshots/web/`](store/screenshots/web/) | 2880×1800 | The web app on a desktop | Website, README, press. Not a store listing |
| [`store/screenshots/phone-web/`](store/screenshots/phone-web/) | 1320×2868 | The web app in a phone browser | Website only. **Not** for the App Store / Play listing: the phone apps are native and look different |
| `dist/store/kinora-tv-preview.mp4` (not committed; regenerate) | 1920×1080, 30 fps, H.264 High@4.0 at a 10 Mbit/s target (these simple frames encode to about 6–7), AAC 256 kbit/s 48 kHz stereo, 15–27 s | Browsing in TV mode, playing *Aurora Drift*, the HDR film page, the guide, an album | Samsung/LG promo where accepted; website. Its encoding meets Apple's app-preview spec, but an App Store preview must be captured from the iOS/tvOS app itself |

**iPhone, iPad, Apple TV, Android, Android TV, Fire TV and Roku** screenshots must come from those apps.
[`scripts/review-pack/native-shots.sh`](../scripts/review-pack/native-shots.sh) drives an iOS/tvOS simulator or an
Android emulator through deep links against the review server and saves PNGs; sign in by hand once first. Roku:
enable developer mode and use the device's screenshot utility (`http://<roku-ip>` → *Utilities → Screenshot*).

### Sizes the stores ask for

| Store | Screenshots | Video |
|---|---|---|
| **Apple** (from App Store Connect Help, *Screenshot specifications* and *App preview specifications*, read 2026-11-21) | 1–10 per size, JPEG/PNG, no alpha. **Required:** iPhone with Dynamic Island, medium display: **1206×2622** or 1179×2556 (iPhone 17 Pro simulator); **iPad 13-inch: 2064×2752** or 2048×2732. Optional larger iPhone: 1320×2868 / 1290×2796 / 1260×2736. **Apple TV: 1920×1080 or 3840×2160.** | Up to 3 previews per size, **15–30 s**, H.264 (High, ≤ L4.0, ≤ 30 fps, 10–12 Mbit/s) or ProRes 422 HQ, stereo AAC 256 kbit/s 44.1/48 kHz, ≤ 500 MB. tvOS previews landscape only |
| **Google Play** (Play Console help; not re-checked from this machine) | Phone: 2–8, JPEG or 24-bit PNG, 320–3840 px per side, long side ≤ 2× short side (≥ 1080 px for promotion). 7" and 10" tablet sets. **Android TV: 1920×1080 screenshots** plus the 1280×720 TV banner. Feature graphic 1024×500 (`branding/kinora/png/store/`) | A YouTube URL (promo video) |
| **Amazon Fire TV** | 3–10 at **1920×1080** (PNG/JPG); icons 512×512 and 114×114; background 1920×1080 (`branding/kinora/png/store/`) | Optional |
| **Samsung TV** | 1920×1080 (check the current count/format in Seller Office) | Optional |
| **LG webOS** | 1920×1080 (check Seller Lounge) | Optional |
| **Roku** | Channel poster 540×405 (`branding/kinora/png/store/`); screenshots 1920×1080 if the form asks | — |

Before uploading, look at every image: only the review pack, the *Kinora Demo* name and the *App Review* account
should be visible; no IP addresses, no personal names, no notifications, no real titles.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `seed` logs `REVIEW_PASSWORD … placeholder` | Fill in `.env` and `docker compose up -d` again |
| `seed` can't sign in as the admin after you changed `REVIEW_ADMIN_PASSWORD` | The admin was created with the first password. Change it back, or `docker compose down -v` to start fresh |
| Podcast missing, `podcast: … not allowed` | `MEDIAMAX_ALLOW_PRIVATE_URLS` must be `1` on the kinora service (it is in the compose file) |
| Live TV channels don't play | `docker compose logs testcard`; the HLS files are in the `fixtures-live` volume. Or set `REVIEW_LIVETV=0` |
| Reviewer locked out ("too many attempts") | Kinora locks an account for 15 minutes after 5 wrong passwords; it clears itself. A long, unusual user name keeps bots from causing this |
| Apps can't reach the server | `curl https://<host>/api/v1/system/info` from outside; check DNS, the Caddy site block and the port in `.env` |
| A reviewer reports missing content | The libraries rescan on every reset; `docker compose restart seed` rescans now |
