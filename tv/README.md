# Samsung (Tizen) and LG (webOS) TV apps

These are thin wrapper apps. On first launch they ask for the MediaMax server address, check it, remember it, and then load the server's own web app in **TV mode** (`/?tv=1`). The app therefore always matches the server's version, branding and theme, and updating the server updates the TV app.

TV mode (`web/src/tv/spatial.ts` and `web/src/styles/tv.css`) works in any browser on a TV or set-top box, not just these wrappers. Open `http://<server>:8484/?tv=1` once and it is remembered. It provides:

- **D-pad navigation:** the arrow keys move focus to the nearest item in that direction, and OK activates it.
- **Back key:** closes the open dialog, or goes back a page.
- **Media keys:** play/pause, stop, fast-forward and rewind work in every player.
- **10-foot styling:** larger text, strong focus rings, focus-zoomed posters, and an overscan-safe margin.

## Build

```bash
node tv/build.mjs                                   # → tv/dist/tizen and tv/dist/webos
node tv/build.mjs --name "Smith Cinema" --icon brand/icon.png   # white-label
```

The script needs `ffmpeg` (already required by the server) to render the icons.

## Samsung Tizen

1. Install Tizen Studio with the TV extensions, then create a Samsung certificate profile in Certificate Manager.
2. Package:
   ```bash
   tizen package -t wgt -s <your-profile> -- tv/dist/tizen
   ```
3. Turn on developer mode on the TV (Apps → type 12345 → enter your PC's IP), then install:
   ```bash
   sdb connect <tv-ip> && tizen install -n MediaMax.wgt -t <tv-name>
   ```
4. Store release: submit the `.wgt` through Samsung Seller Office. Change `tizen:application id`/`package` in
   `tv/tizen/config.xml` to the ones Samsung assigns.

## LG webOS

1. Install the webOS TV CLI (`npm i -g @webos-tools/cli`) and turn on Developer Mode on the TV (the "Developer Mode" app).
2. Package and install:
   ```bash
   ares-package tv/dist/webos
   ares-setup-device            # add the TV
   ares-install -d <tv> tv.mediamax.app_0.1.0_all.ipk
   ```
3. Store release: submit the `.ipk` through the LG Seller Lounge. Change `id` in `tv/webos/appinfo.json` to your own reverse-DNS id.

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
| Back (Tizen 10009, webOS 461) | Close a menu, leave the player, or go back |

Tizen sends media, channel, colour, number, Info and Guide keys only to apps that register them. The wrapper
registers them with `tizen.tvinputdevice.registerKey` before it opens the server's web app. Registration belongs to
the app, so it should stay in force after the wrapper navigates there (not yet confirmed on a real TV). webOS, Android TV and Fire TV browsers send these
keys without registration. Settings → Playback lists the keys in TV mode. The native Android TV app handles the same
keys through the `mediamax-media` module (`apps/mobile/modules/mediamax-media`).

## Notes

- **Playback: our own engine, not the TV's player.** The TV apps play through MediaMax's JavaScript player: hls.js
  on Media Source Extensions, the same engine as in browsers. The TV's built-in player (Samsung AVPlay, the
  progressive `<video src>` pipeline) and its subtitle parser are not used, because they have been unreliable.
  hls.js does the demuxing, buffering, bitrate switching, track switching and error recovery. The TV's hardware
  decoder is used only through MSE `SourceBuffer`s. On Samsung and LG TVs the player asks the server to remux video
  to fMP4 HLS. The video is copied, not re-encoded, so MKV/HEVC/HDR10/E-AC-3 files keep full quality. The server
  transcodes only what MSE on that TV can't decode. The player detects this with `MediaSource.isTypeSupported` and
  `MediaCapabilities.decodingInfo`; Settings → Playback → **This device** shows the result.
- **HDR:** Samsung plays HDR10, HLG and (when MSE reports it) HDR10+. Samsung has no Dolby Vision, so DV 8.1 plays as
  HDR10. LG plays HDR10 and HLG; DV 8.x plays as its base layer. See [docs/HDR.md](../docs/HDR.md).
- **Samsung native player (AVPlay):** not included. It could be added later only as an opt-in, per-device fallback
  that is off by default.
- **Changing the server:** the wrapper reconnects to the saved server on launch. To switch servers, clear the app's data on the TV, or add `?change=1` to the wrapper URL when testing in a browser.
- **HTTPS:** a server behind HTTPS with a valid certificate works the same way. Self-signed certificates are rejected by both TV browsers.
