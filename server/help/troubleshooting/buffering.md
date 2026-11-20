---
title: Buffering and slow streams
summary: What to try when videos stop to load, start slowly or look blurry.
section: troubleshooting
audience: everyone
keywords: buffering, loading, spinning, slow, stutter, stops, pauses, lag, blurry, low quality, wifi, bandwidth, playback error
related: streaming-quality, why-transcoding, remote-connection
order: 2
---

## Quick fixes

1. **Use Auto quality.** In the player's quality menu choose **Auto**, or set it as your default in **Settings → Playback → Streaming quality**. *Original* sends the full file even on a slow connection.
2. **Check your connection.** Wi-Fi far from the router is the most common cause. Try a cable, move closer, or test on another device.
3. **Pause for a moment.** Letting a few seconds load can get you past a busy patch.
4. **Pick a lower quality** for this video, for example *720p · 4 Mbps*.

## Find the cause with Stats for nerds

Press <kbd>I</kbd> in the player:

| Line | What to look at |
|---|---|
| **Network** | Your measured connection speed. |
| **Bitrate** | What the video needs. If it's higher than *Network*, it will buffer. |
| **Buffer** | Seconds loaded ahead. Near 0 means it's about to stop. |
| **Dropped frames** | A high percentage means your device, not the network, can't keep up. Try a lower quality or another app or browser. |
| **Playback** / **Why** | A transcode can buffer when the server is busy. See [Why is it transcoding?](help:why-transcoding). |

## It only happens away from home

The server's upload speed limits everyone watching from outside. Choose a lower quality, or ask your admin about a remote bitrate limit that suits the connection.

## It happens to everyone

If several people see buffering at once, the server may be overloaded by transcodes. Tell your admin; they can check **Admin → Overview** for active sessions.

## "Playback error"

Choose **Try lower quality** in the error message, which asks the server to convert the video. If it keeps failing, tell your admin about the title (see [Telling your admin about a problem](help:problem-with-a-title)).
