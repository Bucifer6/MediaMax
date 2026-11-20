---
title: Live TV sources and tuners
summary: Add Xtream Codes, M3U, HDHomeRun, TVHeadend, SAT>IP and Enigma2 sources, and set up recordings.
section: admin
audience: admin
keywords: live tv, iptv, xtream codes, m3u, playlist, hdhomerun, tvheadend, sat>ip, enigma2, tuner, connections, catch-up, vod, series, restream, dvr, recordings, padding, comskip, channels
related: admin-tv-guide, live-tv-problems, recordings
order: 8
---

Add sources under **Admin → Live TV sources → Add source**.

| Source | Notes |
|---|---|
| **Xtream Codes** | Enter the portal URL, username and password and press **Test** to see account status, expiry and counts. Imports live channels, and creates *Movies* and *Series* libraries from the provider's catalogue. |
| **M3U playlist** | Any M3U or M3U8 URL. `url-tvg`, `tvg-*` and `catchup-source` attributes are read. |
| **HDHomeRun** | Found automatically on the local network, or add it by address. |
| **TVHeadend** | Channels, guide and recordings from a TVHeadend server. |
| **SAT>IP** | Satellite and cable tuners that speak SAT>IP. |
| **Enigma2** | Receivers with OpenWebif (VU+, Dreambox…). |

## Good to know

- **Restreaming**: streams go through the server, which hides your provider credentials and shares one upstream connection per channel between viewers.
- **Connection limits**: set the provider's maximum connections on the source; {{product}} warns before it is exceeded.
- **Catch-up** is enabled on channels that support it.
- Each source has **Refresh now**, and refreshes on its own schedule.
- **Admin → Channels** lets you renumber, rename and hide channels, and shows a **Missing guide** badge where there is no guide data.

## Recordings (DVR)

**Admin → Server settings → DVR**:

- **Recordings folder** (keep it on a disk with plenty of space).
- **Default start padding** and **Default end padding** in minutes.
- **Detect commercials**: runs comskip on finished recordings and adds *Skip ad break* markers (comskip must be installed).

Users also need the **DVR recording** permission (**Admin → Users**).

## Docker and tuners

HDHomeRun and SAT>IP discovery use broadcast on the local network, which doesn't cross Docker's default bridge network. Use host networking or add the tuner by address. Next: set up the [TV guide](help:admin-tv-guide).
