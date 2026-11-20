# HDR and Dolby Vision

MediaMax identifies the dynamic range of every video. Each device reports what it can show. The server then
direct-plays the HDR stream, plays its HDR10/HLG base layer, or tone-maps it to SDR.

## What MediaMax detects

When it scans a file, MediaMax reads the video stream with `ffprobe`. For PQ (HDR10) streams it also reads the
side data of the first frame. Only one frame is decoded. It records:

| Field | Source |
|---|---|
| `hdrFormat`: `sdr`, `hdr10`, `hdr10plus`, `hlg`, `dolbyvision` | Transfer characteristics (`smpte2084` = PQ, `arib-std-b67` = HLG). HDR10+ from `HDR Dynamic Metadata SMPTE2094-40` frame side data. Dolby Vision from the `DOVI configuration record` (or a `dvh1`/`dvhe` sample entry). |
| Dolby Vision profile, level, BL compatibility id, RPU/EL/BL flags | `dv_profile`, `dv_level`, `dv_bl_signal_compatibility_id`, `rpu/el/bl_present_flag` |
| Fallback layer | What a player without Dolby Vision or HDR10+ sees: `hdr10`, `hlg`, `sdr`, or `none` (Dolby Vision profile 5) |
| Mastering display, MaxCLL/MaxFALL | `Mastering display metadata`, `Content light level metadata` |
| Bit depth, codec profile, frame rate | `pix_fmt`, `profile`, `avg_frame_rate` |

The item page shows **HDR10**, **HDR10+**, **HLG** or **Dolby Vision** badges with the details, for example
"Dolby Vision 8.1 · level 6 · HDR10 fallback · 10-bit · MaxCLL 1000". The player's info overlay (press **I**, or the
**Info** or **Blue** key on a TV remote) shows the format, how it reaches your screen, and why the server remuxes or
transcodes.

Files scanned before this feature still have the plain "HDR" flag. The **Detect HDR formats** task (Admin → Tasks,
daily) re-probes only those files. A file is also checked the first time it plays.

## Dolby Vision profiles

| Profile | Found in | Base layer | MediaMax with a non-Dolby Vision device |
|---|---|---|---|
| **5** | Streaming services (Netflix, Disney+, Apple TV+ downloads), some WEB-DLs | **None.** The picture is in Dolby's IPTPQc2 colour space and looks green and purple without Dolby Vision. | Tone-mapped to SDR by transcoding. libplacebo applies the Dolby Vision reshaping (RPU) where FFmpeg has it; otherwise expect some colour error. |
| **7** | UHD Blu-ray remuxes (dual layer: MEL/FEL enhancement layer + RPU) | HDR10 | **Stream copy with the Dolby Vision NAL units removed** (`-bsf:v filter_units=remove_types=62\|63`). The video isn't re-encoded, so you get clean HDR10. Devices that list profile 7 get the file as-is. |
| **8.1** | WEB-DLs, re-encodes, many converted Blu-rays | HDR10 | Direct play. The device ignores the RPU and shows HDR10. |
| **8.2** | Rare | SDR | Direct play as SDR. |
| **8.4** | iPhone recordings, HLG broadcasts | HLG | Direct play when the device supports HLG; otherwise tone-mapped. |

**Why not convert profile 7 to 8.1?** That needs `dovi_tool` to rewrite the RPU, and FFmpeg can't do it alone.
Few devices play profile 7 FEL, so the HDR10 base layer is the most compatible choice. Converting with `dovi_tool`
is a possible later addition.

## Decision rules

The device sends `deviceProfile.videoRange` (`hdr10`, `hdr10Plus`, `hlg`, `dolbyVision`, `dolbyVisionProfiles`)
with each playback request, along with `tenBitCodecs`, `maxHeight` and `audioPassthrough`.

| Source | Device supports | Result |
|---|---|---|
| SDR | anything | normal rules (codec, container, bitrate) |
| HDR10 | HDR10 | direct play / remux |
| HDR10+ | HDR10+ | direct; **HDR10 only:** direct (its static HDR10 metadata is used) |
| HLG | HLG | direct |
| DV 8.x | DV with that profile | direct; **HDR10 (8.1) or HLG (8.4) only:** direct, base layer |
| DV 7 | DV listing "7" | direct; **HDR10:** remux with the RPU/EL removed |
| DV 5 | DV listing "5" | direct; **anything else:** transcode + tone-map |
| any HDR | SDR only | transcode + tone-map to SDR |

When HDR is transcoded for another reason (bitrate, burned-in subtitles), it is tone-mapped too. The transcoder
outputs 8-bit SDR. The hardware tone-mapping path (VA-API, QSV, CUDA, OpenCL, libplacebo, or the CPU fallback) is
chosen by the transcoder; see the hardware transcoding settings.

Older apps that don't send `videoRange` keep the previous behaviour: the server's HDR tone-mapping setting (`transcoding.toneMapHdr`) decides.

## Device support

| Device | Player | HDR10 | HDR10+ | HLG | Dolby Vision | Notes |
|---|---|:-:|:-:|:-:|:-:|---|
| **Samsung TV (Tizen)** | MediaMax player (hls.js / MSE) | ✅ | when MSE reports it (static HDR10 otherwise) | ✅ | ❌ (Samsung has no DV) | DV 8.1 plays as HDR10. DV 7 is stripped to HDR10. DV 5 is tone-mapped. |
| **LG TV (webOS)** | MediaMax player (hls.js / MSE) | ✅ | ❌ | ✅ | base layer only | LG panels support DV, but our MSE stream is tagged `hvc1`, so DV 8.x plays as HDR10. See "Limitations". |
| **Android TV / Google TV / Shield / Fire TV** | Media3 (ExoPlayer) | ✅ | if the display says so | ✅ | ✅ with a DV decoder | Uses the display's HDR types and `video/dolby-vision` decoders from `MediaCodecList`. Audio passthrough comes from the HDMI sink. |
| **Apple TV 4K** | AVPlayer | ✅ | ❌ | ✅ | ✅ 5, 8.1, 8.4 | With **Match Content** on (tvOS 17+), the TV switches to the content's range and frame rate. |
| **iPhone / iPad** | AVPlayer | ✅ | ❌ | ✅ | ✅ 5, 8.1, 8.4 | HDR panels show HDR; others tone-map on the device. |
| **Safari (macOS)** | native HLS | ✅ | ❌ | ✅ | ✅ when `dvh1` is reported | |
| **Chrome / Edge** | hls.js / MSE | ✅ on Windows/macOS or an HDR display | rarely | ✅ | ❌ | Detected with `MediaCapabilities.decodingInfo` (`transferFunction: 'pq'`, `hdrMetadataType`). |
| **Firefox, Chrome on Linux with an SDR screen** | hls.js / MSE | ❌ | ❌ | ❌ | ❌ | HDR is tone-mapped by the server. |

Settings → Playback → **This device** shows what was detected.

## TV apps: our own player engine everywhere

The Samsung and LG apps don't use the TV's built-in player or subtitle parser. Both have been unreliable for us:
the TV's own `<video src>` pipeline and Samsung's AVPlay have patchy MKV support, buggy track switching and
seeking, and subtitle parsers that break on real-world files. The TV apps use the same engine as every
browser:

- **hls.js** demuxes and buffers the stream, picks the bitrate, switches tracks and recovers from errors in
  JavaScript.
- The TV's **hardware decoder** is used only through Media Source Extensions (`SourceBuffer`s). HEVC Main10,
  HDR10/HLG metadata and E-AC-3 pass through to the panel and the HDMI/eARC output.
- On a Samsung or LG TV, the web player never asks for progressive direct play of video. The server remuxes the
  file to fMP4 HLS instead. Video and audio are copied, so the CPU cost is small. MKV, HEVC, HDR10 and E-AC-3 then
  play at full quality.
- Capability detection probes MSE (`MediaSource.isTypeSupported`, `MediaCapabilities.decodingInfo` with
  `type: 'media-source'`). It doesn't ask what AVPlay could do. When MSE on that TV can't decode something, the
  server transcodes.
- Subtitles are drawn by MediaMax's own renderer, never by the TV's `<track>` support.

A Samsung AVPlay backend (Samsung's native player) could be added later as an **opt-in, per-device fallback that
is off by default**. It isn't included now.

## Limitations and follow-ups

- **Dolby Vision through MSE:** remuxed fMP4 is tagged `hvc1`, so browsers and TVs on the MSE path get the HDR10/HLG
  base layer of DV 8.x. Real DV over MSE (LG webOS, Chrome on some TVs) needs `dvh1` tagging and a `dvcC` box, so it
  isn't claimed yet. Profile 5 to those devices is tone-mapped.
- **HDR-preserving transcodes:** transcodes are SDR. A 10-bit HEVC/AV1 HDR10 encode for HDR clients would keep HDR
  when lowering the bitrate.
- **Android TV refresh-rate switching:** Media3 changes the frame rate only when the switch is seamless
  (`videoChangeFrameRateStrategy: 'onlyIfSeamless'`, the expo-video default). Full mode switching (Android 12+
  `Surface.setFrameRate` with `CHANGE_FRAME_RATE_ALWAYS`) needs access to the player's surface, which expo-video
  doesn't expose.
- **Samsung AVPlay:** see above. If it is added, it must stay opt-in.
