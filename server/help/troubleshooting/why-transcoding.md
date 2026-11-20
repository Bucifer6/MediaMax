---
title: Why is it transcoding?
summary: What direct play, remux and transcode mean, and what every reason in the player's "Why" line means.
section: troubleshooting
audience: everyone
keywords: transcode, transcoding, remux, direct play, direct stream, why, reason, stats for nerds, not supported, codec, container, bitrate, tone-mapping, hdr, dolby vision, audio, cpu, quality
related: streaming-quality, hdr-dolby-vision, audio, admin-transcoding
order: 1
---

Press <kbd>I</kbd> in the player (or **Info** / **Blue** on a TV remote) to open *Stats for nerds*. The **Playback** line shows how the video reaches you, and the **Why** line lists the reasons. Each reason links to its explanation below.

## Direct play, remux and transcode {#methods}

| Method | What happens | Quality | Server load |
|---|---|---|---|
| **Direct play** | Your device plays the original file. | Original | None |
| **Direct stream (remux)** | The video is copied into a format your device accepts; sometimes only the audio is converted. | Original picture | Very low |
| **Transcode** | The server converts the video. | Can be lower | High (unless the server has a GPU) |

A remux is nothing to worry about. A transcode is normal for older devices and slow connections, but if it happens a lot, the tips below can help.

## Video codec not supported {#video-codec}

*"video codec hevc not supported"* (or `av1`, `vc1`, `mpeg2video`…): your device or browser can't decode this kind of video, so the server converts it to H.264.

- Chrome and Firefox on some computers can't play HEVC (H.265). Try the Edge or Safari browser, or the phone or TV app.
- Older TVs and streaming sticks often can't play AV1.

## 10-bit video not supported {#ten-bit}

*"10-bit hevc not supported"*: the device plays normal 8-bit video of this type but not the 10-bit version (common with HDR and anime). The server converts it to 8-bit.

## Resolution too high {#resolution}

*"resolution exceeds 1080p"* (or a width such as *"resolution exceeds 1920"*): the video is larger than your device or screen supports, for example 4K on a 1080p TV, so it is scaled down.

## HDR needs tone-mapping {#hdr-tone-mapping}

*"HDR10 needs tone-mapping for this SDR device"*, *"HLG needs tone-mapping…"*, *"Dolby Vision profile 5 needs tone-mapping…"* or *"…has no HDR10 fallback layer; tone-mapping"*: the video is HDR but your screen (or browser) can't show HDR, so the server converts the colours to SDR. Without this, the picture would look grey and washed out. See [HDR and Dolby Vision explained](help:hdr-dolby-vision).

## Dolby Vision remuxed to HDR10 {#dolby-vision-dual-layer}

*"Dolby Vision profile 7 (dual-layer) remuxed to its HDR10 base layer"*: a UHD Blu-ray style file whose extra Dolby Vision layers confuse most players. The server removes them without re-encoding, so you get clean HDR10 at full quality.

## Dolby Vision can't be remuxed {#dolby-vision-ffmpeg}

*"Dolby Vision 8 can't be remuxed with its Dolby Vision signalling by this FFmpeg"*: your device supports Dolby Vision, but the server's ffmpeg is too old to pass it through. You get the HDR10 version (or a tone-mapped one). Admins: update ffmpeg (the Docker image and releases include a suitable one).

## Audio format not supported {#audio-format}

*"audio codec dts not supported"*, *"TrueHD Atmos → E-AC-3 5.1: device can't play TrueHD"*, *"DTS-HD MA → DTS core: device plays DTS but not DTS-HD"*: the device can't play this sound format, so only the audio is converted. The picture is usually copied untouched (a remux). Dolby Atmos and DTS:X become ordinary surround.

## Audio processing requested {#audio-processing}

*"… : audio processing requested"*: you turned on **Night mode**, **Dialogue boost**, **Normalise volume** or a negative lip-sync delay, and this device can only get them from the server. Only the audio is re-encoded. Turn them off in **Settings → Playback → Audio** to get the original sound.

*"… : transcoding requested"* means a transcode was asked for (for example **Try lower quality** after an error), so the audio is converted along with the video.

## Container not supported {#container}

*"container mkv not supported"* (or `avi`, `ts`…): the device can't open this kind of file, but can play what's inside. The server repackages it (remux) without touching the picture.

## Bitrate too high {#bitrate}

*"bitrate 45000k exceeds 8000k"*: the file needs more bandwidth than your quality setting, your connection or the server's remote limit allows. Choose **Original** in the quality menu if your connection can handle it, or see [Buffering and slow streams](help:buffering).

## Non-default audio track {#audio-track}

*"non-default audio track selected"*: you picked an audio track other than the file's default, and this player can't switch tracks inside the original file, so the server repackages it with the track you chose.

## Transcoding not permitted {#transcoding-not-permitted}

*"transcoding not permitted"*: transcoding is turned off for your account or the whole server, so the original is sent anyway, even though your device may not play it. If it doesn't play, ask your admin.

## Burned-in subtitles {#subtitles-burn-in}

Picture-based subtitles (DVD, some broadcasts) that the player can't draw itself are drawn into the video by the server, which needs a transcode. Turn the subtitles off, or pick a text subtitle track, to avoid it.

## Too many transcodes?

Admins: a GPU makes transcoding cheap. See [Hardware transcoding and Detect hardware](help:admin-transcoding).
