---
title: HDR and Dolby Vision explained
summary: What HDR10, HDR10+, HLG and Dolby Vision mean, and what happens when your screen doesn't support them.
section: watching
audience: everyone
keywords: hdr, hdr10, hdr10+, hlg, dolby vision, dv, sdr, tone mapping, washed out, colours, green purple, 4k, lg, profile
related: why-transcoding, streaming-quality, audio
order: 5
---

**HDR** (high dynamic range) videos have brighter highlights and richer colours than ordinary (**SDR**) video, but only look right on a screen that supports them.

| Badge | What it is |
|---|---|
| **HDR10** | The common HDR format. Most HDR TVs, phones and monitors support it. |
| **HDR10+** | HDR10 with scene-by-scene adjustments. Screens without HDR10+ show it as HDR10. |
| **HLG** | HDR used by broadcasters and phone cameras. |
| **Dolby Vision** | Dolby's HDR format. Most Dolby Vision files also contain an HDR10 version for other screens. |

## What happens on your screen

- **Your screen supports the format**: the video plays as it is.
- **Your screen supports HDR10 but not Dolby Vision**: you get the HDR10 version inside the file, usually without any conversion.
- **Your screen is SDR only**: the server converts the video to SDR ("tone-mapping") so colours look natural rather than dull and grey.

A few Dolby Vision files (profile 5, common in streaming downloads) have no HDR10 version and always need conversion on screens without Dolby Vision.

## Checking what your device supports

**Settings → Playback → This device** lists the HDR formats your device reported. In the player, press <kbd>I</kbd> (or **Info** / **Blue** on a TV remote): the *Dynamic range* line shows the source format and how it reaches your screen.

## LG TVs and Dolby Vision

Many LG TVs from 2018 onwards play Dolby Vision but don't tell apps. If your TV shows Dolby Vision in its own apps but {{product}} plays HDR10, set **Settings → Playback → This device → Dolby Vision** to *Yes*. If Dolby Vision videos look wrong (green and purple), set it to *No*.

## Colours look wrong?

- **Washed out or grey**: the screen may not be in HDR mode. Check the TV's picture settings, or that HDR is on in your computer's display settings.
- **Green and purple**: a Dolby Vision file is reaching a screen that can't show it. Set the Dolby Vision option above to *No*.
