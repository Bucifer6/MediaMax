# Audio: Dolby Atmos, DTS:X, passthrough, downmix and listening comforts

This page explains how MediaMax detects the audio in your files, how each player reports what it can play, how the
server picks the audio a device receives, and the listening options (night mode, dialogue boost, volume
normalisation, lip-sync). For HDR and Dolby Vision see [HDR.md](HDR.md). Subtitles and automatic quality are covered in
[PLAYBACK.md](PLAYBACK.md).

## What MediaMax detects

The scanner reads every audio track with ffprobe (`server/src/services/audio.ts`, `parseAudioStream`):

| Field | Example | Source |
|---|---|---|
| codec, profile | `truehd`, "Dolby TrueHD + Dolby Atmos" | `codec_name`, `profile` |
| channels, layout | 8, `7.1` | `channels`, `channel_layout` |
| sample rate, bit depth, bitrate | 48 kHz, 24-bit, 4.6 Mbps | `sample_rate`, `bits_per_raw_sample`, `bit_rate` / Matroska `BPS` tag |
| **Dolby Atmos** | TrueHD Atmos, E-AC-3 JOC | profile contains "Atmos" (ffmpeg 6.1 and later); on older ffmpeg, a track title such as "TrueHD Atmos 7.1" |
| **DTS:X** | "DTS-HD MA + DTS:X" | profile, or a track title with "DTS:X" |
| **DTS-HD MA** | "DTS-HD MA" | profile |
| lossless | TrueHD, DTS-HD MA, FLAC, ALAC, PCM | codec / profile |

The item page (**Media info**), the player's audio menu and its stats overlay (press `I`) show badges: **Dolby Atmos**,
**DTS:X**, **DTS-HD MA**, **TrueHD**, and **7.1** / **5.1**. Files scanned before this feature get the details the first
time they are played (one quick ffprobe of the audio tracks, which is then stored).

## How the server chooses the audio

Each playback request carries a device profile. Clients that send `maxAudioChannels` get the smart decision below.
Older clients without it keep the previous behaviour: the audio is copied when its codec is listed, and otherwise
transcoded to AAC 5.1 or stereo.

For the selected track, in this order:

1. **Copy** when the device decodes the format itself or passes it through to a receiver
   (`audioPassthrough`: `ac3`, `eac3`, `eac3-joc`, `truehd`, `dts`, `dts-hd`, `dts-x`). Atmos and DTS:X objects survive
   only when the bitstream reaches a receiver (passthrough), or with E-AC-3 JOC on a device that lists `eac3-joc`.
2. **DTS core.** If the device takes DTS but not DTS-HD, DTS-HD MA, DTS-HD HRA and DTS:X are reduced to their DTS
   core with `-c:a copy -bsf:a dca_core`. Nothing is re-encoded. DTS:X objects are lost.
3. **E-AC-3 5.1** at 640 kbps for multichannel sources (TrueHD Atmos, DTS on Apple devices, FLAC/PCM 7.1 and so on)
   when the device passes through or decodes E-AC-3 in multichannel. This covers TVs with soundbars over ARC/eARC,
   Apple TV and Android TV. FFmpeg's E-AC-3 encoder stops at 5.1 and can't write Atmos (JOC) metadata, so 7.1 becomes
   5.1 and Atmos becomes plain 5.1. When the receiver only takes AC-3, the server sends **AC-3 5.1**.
4. **AAC**: 7.1 at 512 kbps when the device outputs 8 channels and decodes multichannel AAC, 5.1 at 384 kbps for 6
   channels, otherwise **stereo** at 192 kbps with a proper downmix (below).

When the video can be copied but the audio can't, the server **remuxes**: the video is copied and only the audio is
re-encoded. This is cheap even on a NAS. The reason shows up in `PlaybackInfo.reasons`, `PlaybackInfo.audio`, the stats
overlay, the admin dashboard (sessions) and the server log. For example:

> TrueHD Atmos → E-AC-3 5.1: device can't play TrueHD
> DTS-HD MA → DTS core: device plays DTS but not DTS-HD

The adaptive (ABR) ladder accounts for the chosen audio bitrate (E-AC-3 640k, AAC 7.1 512k, or the copied track's own
bitrate). Its master playlist lists the right RFC 6381 codec (`mp4a.40.2`, `ec-3`, `ac-3`, `dtsc`, `mlpa`, `fLaC`).
For E-AC-3 it adds `#EXT-X-MEDIA:TYPE=AUDIO,…,CHANNELS="6"` without a URI, which means the audio is muxed into the
variant. For copied Atmos it uses `CHANNELS="16/JOC"`, the way Apple's HLS spec marks Atmos. Streams with E-AC-3,
AC-3, DTS, TrueHD, FLAC or Opus audio use fMP4 segments, because hls.js can't demux those from MPEG-TS. TrueHD in MP4
is written with `-strict -2`, after the video arguments.

### Stereo downmix

Going from 5.1, 6.1 or 7.1 to stereo uses an explicit Dolby Lo/Ro matrix (ATSC A/52 §7.8) instead of a plain `-ac 2`:

```
L = 1·FL + 0.707·FC + 0.5·BL       (7.1: 0.425·SL + 0.425·BL)
R = 1·FR + 0.707·FC + 0.5·BR
LFE dropped, then a peak limiter at −1 dBFS
```

A dialogue-only centre channel comes out of both speakers at −3 dB each, which is the same acoustic power as the
original centre speaker. Surrounds are mixed in at −6 dB, so music and effects don't bury the voices. The test suite
checks this against a real generated 5.1 file (`server/test/audio.test.ts`): centre → L/R at −3 dB, front-left → left
only, surround → −6 dB, LFE silent.

## Device matrix

| Device | Reports | Typical result |
|---|---|---|
| **Samsung TV (Tizen) / LG TV (webOS)**, TV speakers or a soundbar over HDMI ARC/eARC | AC-3 / E-AC-3 via MSE, 6 channels (the TV forwards Dolby to the soundbar) | E-AC-3 / AC-3 copied; TrueHD / DTS → E-AC-3 5.1; Atmos survives only as E-AC-3 JOC if the TV reports it |
| **Android TV / Google TV / Shield / Fire TV** + AV receiver (HDMI) | Passthrough formats of the HDMI sink (`AudioTrack.isDirectPlaybackSupported`, Android 13+ `getDirectProfilesForAttributes`, incl. DTS-HD MA / DTS:X on 14+), sink channel count | TrueHD Atmos, DTS:X, DTS-HD MA copied (bitstream, objects kept). Media3 passes through by default: expo-video's `DefaultRenderersFactory` uses `DefaultAudioSink` with the route's `AudioCapabilities`, so nothing needs configuring |
| Android TV + DTS-only soundbar | `dts` without `dts-hd` | DTS-HD MA / DTS:X → DTS core (copy) |
| **Apple TV 4K** | Decodes AC-3 / E-AC-3 incl. Atmos JOC, channels from `AVAudioSession.maximumOutputNumberOfChannels`, multichannel route | E-AC-3 (Atmos) copied; TrueHD, DTS, DTS-HD → E-AC-3 5.1. AVPlayer doesn't bitstream; Apple TV sends Atmos to the receiver itself (Dolby MAT) |
| **iPhone / iPad** | Same decoders, route channels, spatial audio (`isSpatialAudioEnabled`) | E-AC-3 Atmos plays as spatial audio on AirPods; TrueHD / DTS → E-AC-3 5.1 when the route is multichannel, else AAC stereo |
| **Chrome / Firefox** (desktop) | AAC / Opus / FLAC, usually 2 channels (`AudioContext.destination.maxChannelCount`) | Dolby / DTS → AAC stereo with the downmix above |
| **Edge (Windows), Safari (macOS)** | E-AC-3 / AC-3 decode; Safari also reports Atmos with `spatialRendering` | E-AC-3 copied; TrueHD / DTS → AAC (stereo) or E-AC-3 when the output is multichannel |

Browsers often report 2 output channels even when a 5.1 HDMI receiver is connected, so the count is only a hint.
Settings → Playback → **Audio** shows what this device reported.

## Listening comforts

Settings → Playback → **Audio** (web), Settings → Playback → Audio (apps), and the player's audio menu (web):

| Option | Server (when the audio is encoded) | Web player during direct play / copied audio |
|---|---|---|
| **Night mode** | `acompressor` (−24 dB threshold, 4:1, soft knee, +6 dB make-up) + limiter | Web Audio `DynamicsCompressorNode` with the same settings |
| **Dialogue boost** | Downmix with the centre at unity (fronts −3 dB, surrounds −8 dB); centre +3 dB on 5.1/7.1 output; +4 dB speech-band EQ around 2 kHz on stereo | Peaking EQ +5 dB at 2 kHz |
| **Normalise volume** | `loudnorm` single-pass, I = −16 LUFS, TP = −1.5 dB | not available, so the player asks the server for an audio-only re-encode |
| **Lip-sync delay** (per device) | `adelay` for positive values; `atrim` for negative values (sound earlier) | `DelayNode` for positive values only; negative values go to the server |

The comforts are saved in your user preferences (`audio`). The lip-sync delay is saved per device
(`audioDevices[deviceId]`). Players send them as `audioProcessing` with each playback request. The server applies
them whenever it encodes the audio anyway, and reports what it applied in `PlaybackInfo.audio.applied` so the web
player never applies anything twice. When an option can only be done on the server (normalise, a negative delay, or
any option on TV and phone apps, whose players have no audio-effect hooks), the player also sends
`forceAudioProcessing`. The server then re-encodes just the audio and still copies the video. This replaces a copied
Atmos/DTS:X bitstream with E-AC-3/AAC while the option is on. The per-item audio/subtitle sync in the web player's
"Sync & delay" menu is still there and adds to the device delay.

Web Audio can't touch a passthrough bitstream, and TV engines (Tizen, webOS) decode audio outside Web Audio's reach.
There the comforts always come from the server.

## Limitations

- FFmpeg can't encode Atmos (JOC) or DTS:X, and its E-AC-3 encoder stops at 5.1. Converted Atmos is plain 5.1.
- Apple players don't decode TrueHD or DTS. Those are always converted on iOS and tvOS.
- The master playlist muxes audio into each variant. It doesn't offer separate alternate-audio renditions, so the
  Atmos `CHANNELS="16/JOC"` tag describes the muxed track.
- Browsers can't report a 5.1 HDMI setup reliably. They get stereo unless they report more channels.
- The native capability code (Kotlin and Swift) is compile-checked by the app builds, not by the server test suite.
