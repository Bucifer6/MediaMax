# Samsung (Tizen), LG (webOS) and Hisense (VIDAA) TV apps

These are thin wrapper apps. On first launch they ask for the Kinora server address, check it, remember it, and then load the server's own web app in **TV mode** (`/?tv=1`). The app therefore always matches the server's version, branding and theme, and updating the server updates the TV app.

TV mode (`web/src/tv/spatial.ts` and `web/src/styles/tv.css`) works in any browser on a TV or set-top box, not just these wrappers. Open `http://<server>:8484/?tv=1` once and it is remembered. It provides:

- **D-pad navigation:** the arrow keys move focus to the nearest item in that direction, and OK activates it.
- **Back key:** closes the open dialog, or goes back a page.
- **Media keys:** play/pause, stop, fast-forward and rewind work in every player.
- **10-foot styling:** larger text, strong focus rings, focus-zoomed posters, and an overscan-safe margin.

## Build

```bash
node tv/build.mjs                                   # → tv/dist/tizen, tv/dist/webos and tv/dist/vidaa
node tv/build.mjs --name "Smith Cinema" --icon brand/icon.png   # white-label
node tv/build.mjs --url https://tv.example.com/kinora/        # where you'll host tv/dist/vidaa (absolute URLs in vidaa-app.json)
```

Without options the wrappers use the stock Kinora artwork in `tv/shared/brand/` (app icon at 512/130/80 px and the 1920×1080 splash, rendered by `node scripts/brand-export.mjs`) and show the outlined Kinora wordmark on the start screen. With `--icon`, the script letterboxes your square icon with `ffmpeg` (already required by the server); with `--name`, the start screen shows your name as text.

## Samsung Tizen

1. Install Tizen Studio with the TV extensions, then create a Samsung certificate profile in Certificate Manager.
2. Package:
   ```bash
   tizen package -t wgt -s <your-profile> -- tv/dist/tizen
   ```
3. Turn on developer mode on the TV (Apps → type 12345 → enter your PC's IP), then install:
   ```bash
   sdb connect <tv-ip> && tizen install -n Kinora.wgt -t <tv-name>
   ```
4. Store release: submit the `.wgt` through Samsung Seller Office. Change `tizen:application id`/`package` in
   `tv/tizen/config.xml` to the ones Samsung assigns.

## LG webOS

1. Install the webOS TV CLI (`npm i -g @webos-tools/cli`) and turn on Developer Mode on the TV (the "Developer Mode" app).
2. Package and install:
   ```bash
   ares-package tv/dist/webos
   ares-setup-device            # add the TV
   ares-install -d <tv> uk.burdujeni82.kinora_0.1.0_all.ipk
   ```
3. Store release: submit the `.ipk` through the LG Seller Lounge. Change `id` in `tv/webos/appinfo.json` to your own reverse-DNS id.

## Hisense VIDAA

> 🧪 **Not yet tested on a VIDAA set.** VIDAA's developer documentation (the *WebApp Development Guide for VIDAA*) is
> handed out to partners and was not available while this was written, so the details below come from public
> community projects and from how the other wrappers work. Treat them as a starting point and check them on a TV.

VIDAA OS (Hisense, and Toshiba/Sharp sets that run VIDAA) runs apps in its own Chromium-based browser engine (older
firmware: Opera/Presto). Store apps are **hosted web apps**: VIDAA's launcher keeps a name, icons and a start URL for
each one, and there is no public package format to sign like `.wgt` or `.ipk`. So `tv/dist/vidaa` is a plain static
site (the same start screen as the other wrappers) plus `vidaa-app.json`, Kinora's own description of the app
(id, name, start URL, icons, splash) in the field names VIDAA's launcher uses. It is not an official VIDAA manifest.

There are two ways to run Kinora on VIDAA:

- **Hosted wrapper (store app or a launcher tile):** upload `tv/dist/vidaa` to any HTTPS host and register that URL.
  On launch it asks for the server address once and then opens `http://<server>:8484/?tv=1`. Because the wrapper is
  served over HTTPS and your server is usually plain `http://` on the LAN, the browser won't let the page check the
  address first (mixed content), so it goes straight to the server. If that fails, press Back to return to the form.
- **Direct (no wrapper):** register or bookmark `http://<server>:8484/?tv=1` itself. TV mode also turns on by itself
  on VIDAA (the user agent contains `VIDAA` or `Hisense`). Use this for one TV; use the wrapper for a store app that
  works with any server.

### Test on a TV

1. **TV browser:** open the VIDAA **Browser** app and go to `http://<server>:8484/?tv=1`, or to wherever you host
   `tv/dist/vidaa`. Bookmark it. This works on every model, but the Browser app may show a mouse pointer instead of
   using D-pad focus. TV mode still works with the arrow keys, OK and Back.
2. **Launcher tile (developer installs, unofficial):** community tools add a web app to the home screen of many
   VIDAA sets. They use VIDAA's own `Hisense_installApp(...)` call, or write the app list `websdk/Appinfo.json` via
   `HiUtils_createRequest`, from a page the TV trusts. Examples are [vidaa-edge](https://github.com/weinzii/vidaa-edge)
   (DNS-points `vidaahub.com` at your PC) and [Sidee](https://github.com/Empi9245/Sidee) (PIN pairing). Use the
   values from `vidaa-app.json` (built with `--url`). Hisense doesn't support these tools. Newer firmware has removed
   `Hisense_installApp`, and some projectors ignore third-party tiles. A tile opens the app in VIDAA's app view, with
   D-pad focus and no pointer.
3. Check: D-pad and OK move and click, Back closes menus and leaves the player, media and colour keys work in the
   player, and Settings → Playback → **This device** shows "Hisense VIDAA" with the codecs MSE reports.

### Store submission

Apply as a developer or content partner with VIDAA (the VIDAA partner / developer programme). VIDAA reviews apps and
publishes them itself. Give them the HTTPS URL of `tv/dist/vidaa`, the icons and splash from that folder, and the
values in `vidaa-app.json`. Change `Id` in `tv/vidaa/app.json` to the id VIDAA assigns. Expect them to ask for their
own icon sizes and a certification test pass. Their current requirements (icon sizes, whether a packaged HTML upload
is offered as well as a hosted URL, any SDK to include) could not be checked here.

## Remote control

TV mode (`web/src/tv/spatial.ts`) understands the full remote, whether the keys come from the TV's own remote,
HDMI-CEC (a soundbar or receiver remote) or a Bluetooth remote:

| Key | Action |
|---|---|
| Play / Pause / Play-Pause | Play or pause |
| Stop | Leave the player |
| Fast-forward / Rewind | Skip 10 s forward / back |
| Next / Previous track | Next episode / back 30 s. In Live TV: next / previous channel |
| Channel + / − | Change channel in Live TV |
| 0–9 | Live TV: type a channel number (it switches after 1.5 s). Videos: jump to 0–90 % |
| Info | Info overlay (playback method, HDR format, why it transcodes) |
| Guide | TV guide |
| Red / Green / Yellow / Blue | Subtitles / audio track / skip intro, credits or ad break / info (Live TV: channel list) |
| Back (Tizen 10009, webOS 461, VIDAA 8 / 461 / 27) | Close a menu, leave the player, or go back |

Tizen sends media, channel, colour, number, Info and Guide keys only to apps that register them. The wrapper
registers them with `tizen.tvinputdevice.registerKey` before it opens the server's web app. Registration belongs to
the app, so it should stay in force after the wrapper navigates there (not yet confirmed on a real TV). webOS, Android TV and Fire TV browsers send these
keys without registration. Settings → Playback lists the keys in TV mode. The native Android TV app handles the same
keys through the `mediamax-media` module (`apps/mobile/modules/mediamax-media`).

VIDAA is reported to send the same DTV/HbbTV key codes as webOS without registration: 415 play, 19 pause, 413 stop,
417/412 fast-forward/rewind, 403–406 colours, 457 Info, 48–57 digits. Back is 8 (Backspace) on most firmware, 461 on
some. A few firmwares are reported to send Escape (27), so on VIDAA TV mode treats Escape as Back too. Backspace in a
text field still deletes. On the start screen, Back exits through VIDAA's `Hisense_Exit()` (community projects report
that `window.close()` does nothing there). None of these codes have been checked on a set yet.

## Notes

- **Playback: our own engine, not the TV's player.** The TV apps play through Kinora's JavaScript player: hls.js
  on Media Source Extensions, the same engine as in browsers. The TV's built-in player (Samsung AVPlay, the
  progressive `<video src>` pipeline) and its subtitle parser are not used, because they have been unreliable.
  hls.js does the demuxing, buffering, bitrate switching, track switching and error recovery. The TV's hardware
  decoder is used only through MSE `SourceBuffer`s. On Samsung and LG TVs the player asks the server to remux video
  to fMP4 HLS. The video is copied, not re-encoded, so MKV/HEVC/HDR10/E-AC-3 files keep full quality. The server
  transcodes only what MSE on that TV can't decode. The player detects this with `MediaSource.isTypeSupported` and
  `MediaCapabilities.decodingInfo`; Settings → Playback → **This device** shows the result.
- **Subtitles: our own renderer.** Subtitles are fetched from the server in their original format and drawn by the
  player (SRT/WebVTT text in your style with 10-foot sizing; ASS with libass where the TV runs WebAssembly, else a
  simplified styled renderer; PGS decoded to a canvas). Native text tracks are never used. See
  [docs/PLAYBACK.md](../docs/PLAYBACK.md).
- **Automatic quality:** the player measures the connection and switches quality levels itself (hls.js variants, or
  direct play ↔ transcode), as in browsers.
- **HDR:** Samsung plays HDR10, HLG and (when MSE reports it) HDR10+. Samsung has no Dolby Vision, so DV 8.1 plays as
  HDR10. LG plays HDR10 and HLG, and real Dolby Vision where its player reports the Dolby Vision codecs (the server
  remuxes the stream with its Dolby Vision signalling); otherwise DV 8.x plays as its base layer. Hisense VIDAA plays
  HDR10 and HLG where MSE reports them. Dolby Vision is **off by default** on VIDAA even if MSE claims `dvh1`, because
  community reports say its browser hangs or shows a black picture on Dolby Vision in MP4, which is what our remux
  sends. DV plays as its HDR10/HLG base layer unless you set *This device supports Dolby Vision* to Yes. See
  [docs/HDR.md](../docs/HDR.md).
- **Samsung native player (AVPlay):** not included. It could be added later only as an opt-in, per-device fallback
  that is off by default.
- **Changing the server:** the wrapper reconnects to the saved server on launch. To switch servers, clear the app's data on the TV, or add `?change=1` to the wrapper URL when testing in a browser.
- **HTTPS:** a server behind HTTPS with a valid certificate works the same way. Self-signed certificates are rejected by the TV browsers.
- **VIDAA playback** uses the same hls.js/MSE path and remux-to-fMP4 as Samsung and LG. Community reports say VIDAA's engine decodes H.264, HEVC (incl. 10-bit), VP9, AAC, AC-3 and E-AC-3, and usually not AV1. Kinora still asks MSE on each set rather than assuming any of this.
