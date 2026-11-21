# Publishing the Kinora apps

Publisher: an individual (your legal name shows as the developer). Accounts you already have: **Apple Developer** and **Google Play Console**.

| App | Store | Account | Cost | Package | Status |
|---|---|---|---|---|---|
| iPhone / iPad | App Store | Apple Developer ✅ | $99/yr (have) | `apps/mobile` (EAS build) | Ready to build |
| Apple TV | App Store (same listing or separate) | Apple Developer ✅ | included | `apps/mobile` with `EXPO_TV=1` | Ready to build |
| Android phone / tablet | Google Play | Play Console ✅ | paid | `apps/mobile` (EAS build) | Ready to build |
| Android TV / Google TV | Google Play (same app, TV form factor) | Play Console ✅ | included | `apps/mobile` with `EXPO_TV=1` | Ready to build |
| Fire TV | Amazon Appstore | **Amazon Developer (free) — create** | free | Android TV build (same APK/AAB) | Needs account |
| Samsung TV (Tizen) | Samsung Apps TV (Seller Office) | **Samsung Seller Office (free) — apply** | free | `tv/dist/tizen` → `.wgt` | Needs account |
| LG TV (webOS) | LG Content Store (Seller Lounge) | **LG Seller Lounge (free) — apply** | free | `tv/dist/webos` → `.ipk` | Needs account |
| Hisense (VIDAA) | VIDAA Store | **VIDAA partner programme — apply** | free | `tv/dist/vidaa` | In progress |
| Roku | Roku Channel Store | **Roku Developer (free) — create** | free | `apps/roku/dist/Kinora.zip` | In progress |

## Decide before submitting

1. **The name: Kinora** (decided; the product was called MediaMax until the rename, which was done before any store
   release, while renaming was free). Store listings use **"Kinora"**; if a store reports a clash, use a descriptive
   store name such as **"Kinora – Home Media Server"** and keep "Kinora" under the icon. Before submitting, search each
   store for "Kinora" and check the live trade-mark registers (USPTO TSDR, UK IPO, EUIPO) in classes 9 (software) and
   41 (entertainment).
2. **App identifiers** (permanent once published), all from one family:

   | Where | Identifier | Set in |
   |---|---|---|
   | iOS / iPadOS bundle id, Android package | `uk.burdujeni82.kinora` | `apps/mobile/branding/defaults.json` (single source of truth) |
   | Apple TV, Android TV / Google TV, Fire TV | `uk.burdujeni82.kinora` (same record / listing as the phone app) | same file (`EXPO_TV=1` builds) |
   | URL scheme | `kinora://` (primary) and `mediamax://` (still registered) | same file (`scheme`, `legacySchemes`) |
   | LG webOS app id | `uk.burdujeni82.kinora` | `tv/webos/appinfo.json` |
   | Samsung Tizen | widget `http://burdujeni82.uk/kinora`, application `KinoraTV01.Kinora` | `tv/tizen/config.xml` |
   | Hisense VIDAA | `uk.burdujeni82.kinora.vidaa` | `tv/vidaa/app.json` |
   | Roku | channel "Kinora", package `apps/roku/dist/Kinora.zip` | `apps/roku/manifest` |

   Apple and Google tie the id to the listing for good, so don't change these after the first upload. A white-label
   build gets its own ids (`npm run brand -- <server> <brand> --bundle-id com.example.media`).
3. **A privacy policy URL.** Every store requires one. The draft is in `docs/PRIVACY.md`; host it on your own domain (e.g. `https://burdujeni82.uk/privacy`) or GitHub Pages.
4. **A support URL and contact email** (shown publicly). A dedicated address is better than your personal one.

## Store art

Rendered from the brand sources by `node scripts/brand-export.mjs` into [`branding/kinora/png/store/`](../branding/kinora/png/store/):
App Store icon (1024, opaque), Play icon (512), Play feature graphic (1024×500), Android TV banner (1280×720), Fire TV
background (1920×1080), Samsung/LG icon (512) and Roku channel poster (540×405). The in-app icons, Apple TV layers and
top shelf, Roku focus icons and splash screens are written straight into each app (see
[`branding/kinora/README.md`](../branding/kinora/README.md)).

## What every store review needs

Kinora is a client for a server the user runs, so reviewers can't test it without one. Prepare once, reuse everywhere:

- **A demo server** reachable from the internet over HTTPS, with **legal, freely redistributable content only** (public-domain films, Creative Commons shorts such as Blender Open Movies) and no IPTV channels. Reviewers reject apps when they see commercial films or live TV they think is unlicensed.
- **A reviewer account** on it (username + password), no 2FA, plus a link code flow that works.
- **Review notes** explaining: the app connects to the user's own Kinora server; enter `https://demo.<your-domain>` and the credentials; content on the demo server is public domain.
- **Content policy wording**: the app doesn't provide content; users stream their own media. Don't mention IPTV, Xtream or "free channels" anywhere in listings or screenshots — this is the most common reason media-server apps get rejected or pulled.
- **Screenshots** from the demo server (no copyrighted posters). The screenshot pipeline (`npm run screenshots`) already builds a fictional demo library; it can render store sizes.

## Apple (App Store: iPhone, iPad, Apple TV)

1. In App Store Connect create the app with your final name and bundle id. Category: *Entertainment*. Age rating questionnaire: unrestricted web access = No; user-generated content = No.
2. **App Privacy** ("nutrition label"): *Data Not Collected* — the app sends data only to the user's own server, which you don't operate. (If crash reporting is ever added, update this.)
3. **Export compliance**: already declared (`ITSAppUsesNonExemptEncryption: false`, HTTPS only).
4. **App Transport Security**: the app allows plain-HTTP connections for home servers on the LAN. In review notes say: "Users connect to self-hosted media servers on their home network, which commonly use http:// on local addresses." Jellyfin, Plex and Infuse are accepted on the same basis.
5. Build and submit with EAS (from `apps/mobile`):
   ```bash
   npx eas-cli build --profile ios --platform ios
   ```
   ```bash
   npx eas-cli submit --platform ios --latest
   ```
   Apple TV: build with `EXPO_TV=1` and add the tvOS platform to the same App Store record.
6. Ship to **TestFlight** first (up to 10,000 testers by link) so your users can try it while the public review runs.

## Google Play (phone, tablet, Android TV)

1. Personal developer accounts created after Nov 2023 must run a **closed test with at least 12 testers for 14 consecutive days** before production access. Start this immediately with your own users — it's the longest step.
2. Create the app, complete the **Data safety** form (no data collected or shared), content rating (IARC questionnaire), target audience (not for children), and "App access" with the demo server + reviewer account.
3. Build and upload:
   ```bash
   npx eas-cli build --profile android --platform android
   ```
   ```bash
   npx eas-cli submit --platform android --latest
   ```
4. **Android TV**: in Play Console → Advanced settings → Form factors, add Android TV. It needs a TV banner (1280×720: `branding/kinora/png/store/android-tv-banner-1280x720.png`), TV screenshots, and passes a separate TV quality review (D-pad navigation everywhere, no touch-only screens).

## Amazon Appstore (Fire TV)

Free account at developer.amazon.com. Upload the Android TV build (same AAB/APK), mark Fire TV devices as supported, add Fire TV screenshots (1920×1080) and the demo server details. Review is usually a few days.

## Samsung (Tizen)

Apply at seller.samsungapps.com as an individual seller (TV apps from individuals are accepted, but approval of the seller account can take a couple of weeks). Then: create a Samsung certificate in Tizen Studio, package `tv/dist/tizen` (see `tv/README.md`), and submit the `.wgt` with the demo server details. Samsung tests on real TVs, including D-pad, Back key and app exit behaviour.

## LG (webOS)

Register at seller.lgappstv.com. Package `tv/dist/webos` with `ares-package`, submit the `.ipk`. Expect pre-checks (icon sizes, app id format) and a functional review on a TV.

## Hisense (VIDAA)

VIDAA publishes third-party apps through its partner programme; apply via the VIDAA developer/partner site. See `tv/README.md` (VIDAA section) for packaging and test steps.

## Roku

Free account at developer.roku.com. Enable developer mode on a Roku, sideload `apps/roku/dist/Kinora.zip` to test, then package it on the device (Roku signs packages on-device) and publish as a **public** channel, or as a **beta/non-certified** channel shared by access code if you only want your own users (no certification needed, up to 20 testers, expires after 120 days).

## Suggested order

1. Today: fix the name and identifiers, host the privacy policy, set up the demo server with public-domain content.
2. Apple TestFlight + Google Play closed test (starts the 14-day clock) — your users can use both while reviews run.
3. Apply for Amazon, Samsung, LG, VIDAA and Roku accounts in parallel (approvals take days to weeks).
4. Public App Store + Play submissions once TestFlight feedback is in; then Fire TV, then the TV stores as accounts are approved.

## What I can do for you vs. what only you can do

- **I can:** set the name/identifiers in code, generate store icons, banners and screenshots at every required size, write listing text and review notes, prepare the privacy policy, build the packages, set up the EAS config, and walk you through each submission screen.
- **Only you can:** create and pay for accounts, verify your identity, accept store agreements, sign packages with certificates tied to your account, press Submit, and answer reviewer messages.
