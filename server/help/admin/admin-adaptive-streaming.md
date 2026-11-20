---
title: Adaptive streaming and bandwidth limits
summary: Quality levels for transcodes, the remote bitrate limit, and per-user stream limits.
section: admin
audience: admin
keywords: adaptive streaming, abr, renditions, quality levels, bitrate limit, remote, upload, bandwidth, streams, limit, segment
related: streaming-quality, admin-transcoding, buffering
order: 7
---

Settings are in **Admin → Server settings → Transcoding → Adaptive streaming**.

| Setting | What it does |
|---|---|
| **Offer quality levels (renditions) for transcodes** | Players on *Auto* get a 1080p / 720p / 480p / 360p ladder (never above the original) and switch with the connection. Only the level being watched is encoded. On by default. |
| **Remote bitrate limit (kbps)** | Caps quality for viewers outside your network, for example to protect your upload speed. Empty means no limit. Local viewers are never capped unless their own measurement says their connection is slower. |
| **Stop idle quality levels after (s)** | How long an unwatched level keeps encoding (default 20 s). |

## Choosing a remote limit

Your upload speed is shared by everyone watching from outside. Divide it by the number of people you expect to watch at once and leave some headroom. For example, with 40 Mbps upload and 3 remote viewers, a limit of about 10000 kbps each is safe.

## Per-user limits

In **Admin → Users**, **Max simultaneous streams** limits how many streams one account (with all its profiles) can run at once. Turning off **Allow transcoding** forces direct play for that user, which uses no server CPU but fails on devices that can't play the file.

## Other knobs

- **Default bitrate (kbps)**: the quality used when a player doesn't say what it wants.
- **HLS segment length (s)**: shorter segments start and switch faster; longer ones cope better with high latency. The default (4 s) suits most setups.

What users see is explained in [Streaming quality, Auto and data use](help:streaming-quality).
