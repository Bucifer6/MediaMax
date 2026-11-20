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

## Notes

- **Playback:** Tizen and webOS play HLS natively, and the web player's device profile asks the server for HLS, so most content direct-streams or remuxes. Codecs the TV can't decode are transcoded as usual.
- **Changing the server:** the wrapper reconnects to the saved server on launch. To switch servers, clear the app's data on the TV, or add `?change=1` to the wrapper URL when testing in a browser.
- **HTTPS:** a server behind HTTPS with a valid certificate works the same way. Self-signed certificates are rejected by both TV browsers.
