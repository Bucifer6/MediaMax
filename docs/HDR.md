# HDR and Dolby Vision

Kinora identifies the dynamic range of every video. Each device reports what it can show. The server then
direct-plays the HDR stream, plays its HDR10/HLG base layer, or tone-maps it to SDR.

## What Kinora detects

When it scans a file, Kinora reads the video stream with `ffprobe`. For PQ (HDR10) streams it also reads the
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

| Profile | Found in | Base layer | Kinora with a non-Dolby Vision device |
|---|---|---|---|
| **5** | Streaming services (Netflix, Disney+, Apple TV+ downloads), some WEB-DLs | **None.** The picture is in Dolby's IPTPQc2 colour space and looks green and purple without Dolby Vision. | Tone-mapped to SDR by transcoding. libplacebo applies the Dolby Vision reshaping (RPU) where FFmpeg has it; otherwise expect some colour error. |
| **7** | UHD Blu-ray remuxes (dual layer: MEL/FEL enhancement layer + RPU) | HDR10 | **Stream copy with the Dolby Vision NAL units removed** (`-bsf:v filter_units=remove_types=62\|63`). The video isn't re-encoded, so you get clean HDR10. Devices that list profile 7 get the file as-is. |
| **8.1** | WEB-DLs, re-encodes, many converted Blu-rays | HDR10 | Direct play. The device ignores the RPU and shows HDR10. |
| **8.2** | Rare | SDR | Direct play as SDR. |
| **8.4** | iPhone recordings, HLG broadcasts | HLG | Direct play when the device supports HLG; otherwise tone-mapped. |
| **10** (10.0, 10.1, 10.4) | AV1 streaming encodes | none (10.0), HDR10 (10.1), HLG (10.4) | Base layer (10.1/10.4) as AV1 HDR10/HLG; 10.0 is tone-mapped. |

Devices that support the profile get real Dolby Vision: by direct play, or by a remux that keeps the Dolby Vision
signalling (see below).

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
| DV 10 (AV1) | DV listing "10" (and AV1) | direct; **HDR10/HLG:** base layer; 10.0: tone-map |

A device "supports" a DV profile when it lists it in `dolbyVisionProfiles`. A device that sets `dolbyVision` without
a list is assumed to play profiles 5 and 8.x.

When the file can't be direct-played (for example MKV on Apple devices, or anything on the TV apps, which always
remux), a remux for a Dolby Vision device keeps real Dolby Vision. If this server's FFmpeg can't write the Dolby
Vision boxes (see "FFmpeg requirement"), the server falls back to the rules for a device without Dolby Vision:
profile 8.x plays its base layer, and profile 5 is tone-mapped.
| any HDR | SDR only | transcode + tone-map to SDR |

When HDR is transcoded for another reason (bitrate, burned-in subtitles), it is tone-mapped too. The transcoder
outputs 8-bit SDR. The tone-mapping path is chosen by the transcoder from what **Detect hardware** saw work: the
accelerator's GPU tone-mapper (VA-API, QSV, CUDA, OpenCL), then libplacebo (Vulkan), then the CPU (`zscale` + `tonemap`
Hable, which downscales first, so the expensive float conversion runs at the output size). OpenCL uses the BT.2390
curve on FFmpeg builds that have it (jellyfin-ffmpeg; detected from `ffmpeg -h filter=tonemap_opencl`) and Hable on
stock FFmpeg, which rejects `tonemap=bt2390`. **Dolby Vision profile 5** prefers libplacebo whenever detection saw it
work, even over a GPU tone-mapper, because only libplacebo applies the RPU reshaping; without it, profile 5 is tone-mapped
by the usual path and colours will be off.

Older apps that don't send `videoRange` keep the previous behaviour: the server's HDR tone-mapping setting (`transcoding.toneMapHdr`) decides.

## Real Dolby Vision over HLS (remux)

When the video is copied for a Dolby Vision device, the fMP4 init segment keeps the Dolby Vision configuration box
(`dvcC` for profiles 5 and 7, `dvvC` for 8 and 10), and the stream gets a real master playlist that announces Dolby
Vision. The signalling follows Dolby's ISO base media file format spec and Apple's HLS authoring spec:

| Profile | Sample entry | `CODECS` | `SUPPLEMENTAL-CODECS` | `VIDEO-RANGE` |
|---|---|---|---|---|
| 5 | `dvh1` + `dvcC` | `dvh1.05.LL` | | `PQ` |
| 7 (device lists 7) | `dvh1` + `dvcC` | `dvh1.07.LL` | | `PQ` |
| 8.1 | `hvc1` + `dvvC` | `hvc1.2.4.L153.B0` (read from the init segment) | `dvh1.08.LL/db1p` | `PQ` |
| 8.4 | `hvc1` + `dvvC` | `hvc1...` | `dvh1.08.LL/db4h` | `HLG` |
| 8.2 | `hvc1` + `dvvC` | `hvc1...` | `dvh1.08.LL/db2g` | `SDR` |
| 10.1 / 10.4 | `av01` + `dvvC` | `av01.0.LLM.10` | `dav1.10.LL/db1p` or `/db4h` | `PQ` / `HLG` |

`LL` is the Dolby Vision level from the file (`dv_level`), zero-padded to two places. When the file has none, the
server uses 06 for 4K at 24–30 fps.

- **Profiles with a compatible base layer (8.x, 10.1, 10.4)** keep the standard `hvc1`/`av01` sample entry and add
  the `dvvC` box. A decoder without Dolby Vision plays the HDR10/HLG base layer. One with Dolby Vision finds the box:
  hls.js 1.6+ reads it and opens its `SourceBuffer` as `dvh1.08.LL` when `MediaSource.isTypeSupported` accepts that,
  Chromium-based engines with platform Dolby Vision (LG webOS) switch to their DV decoder on the box, and Media3 and
  AVPlayer recognise it too.
- **Profile 5** has no usable base layer, so it uses the `dvh1` sample entry, the same as Apple's HLS spec.
- **ExoPlayer (Android):** Media3 maps the HLS `CODECS` string straight to a decoder type. The Android app gets the DV
  codec in `CODECS` itself (`CODECS="dvh1.08.06,ec-3"`) instead of in `SUPPLEMENTAL-CODECS`. Apple devices, browsers
  and TVs get the Apple form.
- The codec strings come from the init segment FFmpeg wrote: the exact HEVC/AV1 profile and level, and the real audio
  codec (`ec-3`, `ac-3`, `mp4a.40.2`, `fLaC`, `Opus` ...). If the init segment has no Dolby Vision box after all, the
  playlist announces only the base layer.
- Remuxes for devices without Dolby Vision are unchanged: a plain `hvc1` stream with no DV box, served as before.

### FFmpeg requirement

FFmpeg writes the `dvcC`/`dvvC` box only when the copied stream carries Dolby Vision configuration side data **and**
`-strict unofficial` is set. Kinora adds `-strict unofficial` (and `-tag:v dvh1` for profiles 5 and 7) to Dolby
Vision remuxes only. On first use, the server checks that its FFmpeg build really writes the box. It remuxes a tiny
embedded HEVC file with an injected `dvvC` box through the HLS/fMP4 muxer, then looks for the box (about 100 ms, once
per start). FFmpeg 6.1 passes. The Docker image uses Debian bookworm's FFmpeg (5.1). The check decides there, and
the server log says which way it went ("FFmpeg keeps Dolby Vision configuration when remuxing").

FFmpeg can't write a `dav1` sample entry. Profile 10.0 (AV1 with no compatible base layer) is announced as `av01` +
`dvvC` with `dav1.10.LL` in `SUPPLEMENTAL-CODECS`.

## Device support

| Device | Player | HDR10 | HDR10+ | HLG | Dolby Vision | Notes |
|---|---|:-:|:-:|:-:|:-:|---|
| **Samsung TV (Tizen)** | Kinora player (hls.js / MSE) | ✅ | when MSE reports it (static HDR10 otherwise) | ✅ | ❌ (Samsung has no DV) | DV 8.1 plays as its HDR10 base layer. DV 7 is stripped to HDR10. DV 5 is tone-mapped. |
| **Hisense TV (VIDAA)** | Kinora player (hls.js / MSE) | ✅ where MSE reports it | when MSE reports it | ✅ where MSE reports it | ❌ by default (override: Yes) | Not yet tested on a set. Dolby Vision is never auto-detected on VIDAA: its browser is reported to hang on DV in MP4 (our remux is fMP4), so DV plays as its base layer unless the user turns the override on. |
| **LG TV (webOS)** | Kinora player (hls.js / MSE) | ✅ | ❌ | ✅ | ✅ 5, 8.1, 8.4 where MSE reports `dvh1` | Real Dolby Vision through our own engine (remux with `dvvC` + DV codecs). Detected with `MediaSource.isTypeSupported('video/mp4; codecs="dvh1.08.06"')`. If your model doesn't report it, use the override (below). Otherwise DV 8.x plays as HDR10. |
| **Android TV / Google TV / Shield / Fire TV** | Media3 (ExoPlayer) | ✅ | if the display says so | ✅ | ✅ with a DV decoder (5, 7, 8.x, 10 as the decoder lists them) | Uses the display's HDR types and the `video/dolby-vision` decoder profiles from `MediaCodecList`. Direct play for MKV/MP4. Remuxes keep DV, with the DV codec in `CODECS` for Media3. Audio passthrough comes from the HDMI sink. |
| **Apple TV 4K** | AVPlayer | ✅ | ❌ | ✅ | ✅ 5, 8.1, 8.4 | MKV is remuxed with DV kept (Apple HLS form). With **Match Content** on (tvOS 17+), the TV switches to Dolby Vision (only when real DV is delivered), HDR10 or HLG, and to the content's frame rate. |
| **iPhone / iPad** | AVPlayer | ✅ | ❌ | ✅ | ✅ 5, 8.1, 8.4 | HDR panels show HDR; others tone-map on the device. |
| **Safari (macOS)** | hls.js on ManagedMediaSource, or native HLS | ✅ | ❌ | ✅ | ✅ when `dvh1` is reported | |
| **Edge on Windows** | hls.js / MSE | ✅ on an HDR display | rarely | ✅ | when MSE reports `dvh1` (HEVC + Dolby Vision extensions, DV-capable display) | Not verified on real hardware. |
| **Chrome on Android TV / TV boxes** | hls.js / MSE | ✅ | rarely | ✅ | on some devices with a DV decoder | Depends on whether Chrome exposes the platform's DV decoder to MSE. |
| **Chrome / Edge (desktop, others)** | hls.js / MSE | ✅ on Windows/macOS or an HDR display | rarely | ✅ | ❌ | Detected with `MediaCapabilities.decodingInfo` (`transferFunction: 'pq'`, `hdrMetadataType`). Chrome without platform DV reports `dvh1` as unsupported, so DV plays as its base layer. |
| **Firefox, Chrome on Linux with an SDR screen** | hls.js / MSE | ❌ | ❌ | ❌ | ❌ | HDR is tone-mapped by the server. |

Settings → Playback → **This device** shows what was detected.

### Dolby Vision detection in the web player and TV apps

`web/src/player/capabilities.ts` checks each Dolby Vision codec string with `MediaSource.isTypeSupported` (and
`canPlayType` on Safari, which can play HLS natively): `dvh1.05.06` for profile 5, `dvh1.08.06` for 8.1/8.4,
`dvhe.07.06` or `dvh1.07.06` for 7, and `dav1.10.06` for 10. If `MediaCapabilities.decodingInfo` exists, it is asked
too, with `hdrMetadataType: 'smpteSt2094-10'`, `transferFunction: 'pq'` and `colorGamut: 'rec2020'`. A "no" counts
only when the same query without DV metadata says "yes" (the engine decodes the base layer only). Engines that don't
know these members, such as older webOS, keep the MSE answer. As for HDR, a desktop browser must also have an HDR
display or tone-map by itself.

What LG's webOS browser reports isn't documented by LG. Community reports say DV-capable models (2018+ OLED and many
NanoCell, webOS 4.x+, Chromium 53–94) answer `true` for `dvh1` through MSE, but this hasn't been verified on a TV for
this release. So **Settings → Playback → This device → Dolby Vision** has an override:

- **Auto (detect)**, the default: use what MSE reports.
- **Yes, this TV supports Dolby Vision**: claim profiles 5, 8.1 and 8.4. For a TV that shows Dolby Vision in its own
  apps while Kinora plays HDR10. With a profile 8 file, a wrong "Yes" is harmless: hls.js falls back to the HDR10
  base layer when MSE refuses `dvh1`. With a profile 5 file it isn't: the picture won't play or shows wrong colours.
- **No**: never claim Dolby Vision. DV 8.x plays as its base layer, and DV 5 is tone-mapped.

The choice is stored per device (browser storage).

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
- Subtitles are drawn by Kinora's own renderer, never by the TV's `<track>` support.

A Samsung AVPlay backend (Samsung's native player) could be added later as an **opt-in, per-device fallback that
is off by default**. It isn't included now.

## Limitations and follow-ups

- **Dolby Vision over MSE is unverified on real TVs.** The fMP4 output (box contents, sample entries, codec strings)
  is checked by the test suite against FFmpeg's own reading, and hls.js 1.7's handling was checked in its source. It
  hasn't been tried on an LG TV, an Android TV with a DV decoder, or an Apple TV for this release. If an LG model only
  switches to DV for a `dvh1` sample entry (not `hvc1` + `dvvC`), profile 8 would need the `dvh1` entry there too, the
  way Jellyfin does it. That is a one-line change in `doviSignal()` (server `dovi.ts`).
- **Profile 7 FEL/MEL** stays dual-layer when copied for a device that lists profile 7. Converting 7 → 8.1 needs
  `dovi_tool`.
- **Profile 10.0** can only be written with an `av01` sample entry (FFmpeg has no `dav1`).
- **Transcodes never keep Dolby Vision** (FFmpeg can't encode it). A lower-bitrate transcode of a DV file is SDR,
  tone-mapped.
- **Legacy clients** (no `videoRange` in their profile) get no DV signalling. A profile 5 file remuxed for them still
  shows wrong colours, as before.
- **HDR-preserving transcodes:** transcodes are SDR. A 10-bit HEVC/AV1 HDR10 encode for HDR clients would keep HDR
  when lowering the bitrate.
- **Android TV refresh-rate switching:** Media3 changes the frame rate only when the switch is seamless
  (`videoChangeFrameRateStrategy: 'onlyIfSeamless'`, the expo-video default). Full mode switching (Android 12+
  `Surface.setFrameRate` with `CHANGE_FRAME_RATE_ALWAYS`) needs access to the player's surface, which expo-video
  doesn't expose.
- **Samsung AVPlay:** see above. If it is added, it must stay opt-in.
