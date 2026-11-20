---
title: Hardware transcoding and Detect hardware
summary: Use the GPU to convert video, find the right method with Detect hardware, and tune the transcoding settings.
section: admin
audience: admin
keywords: transcoding, hardware acceleration, gpu, intel, quick sync, qsv, vaapi, amd, nvidia, nvenc, videotoolbox, raspberry pi, detect hardware, hevc, av1, tone mapping, hdr, concurrent transcodes, preset, docker, /dev/dri
related: hwaccel-problems, admin-adaptive-streaming, why-transcoding
order: 6
---

{{product}} converts (transcodes) video only when a device can't play the original. The CPU can do it, but a GPU is much faster and uses far less power.

## Turning it on

1. Give {{product}} access to the GPU (below).
2. Open **Admin → Server settings → Transcoding** and press **Detect hardware**.
3. The server lists the GPUs it can see and runs a 2-second test transcode with every method (H.264, HEVC and AV1 encoding, hardware decoding, 10-bit HEVC decoding and HDR tone-mapping). Each card shows what works, with its speed, or ffmpeg's error.
4. Press **Use this** on the recommended card, then **Save changes**.

Results are kept until the server restarts. Press **Re-run detection** after changing drivers or devices.

## Giving the server the GPU

| Setup | What to do |
|---|---|
| **Docker, Intel or AMD** | Add the device `/dev/dri:/dev/dri`. The image already contains the drivers. |
| **Docker, NVIDIA** | Install the NVIDIA Container Toolkit and give the container the GPU (`--gpus all`, capabilities `gpu,video`). `nvidia-smi` must work inside the container. |
| **Linux service** | Add the service user to the `render` and `video` groups and install the VA-API driver. |
| **Windows** | Install the current GPU driver. Nothing else is needed. |
| **Synology** | Map `/dev/dri`. If the test says *permission denied*, run `sudo chmod 666 /dev/dri/renderD128` (DSM resets it at boot; add it as a boot-up task). |
| **Raspberry Pi 4** | `v4l2m2m`, H.264 only, about one 1080p stream. The Pi 5 has no hardware encoder. |

## Other settings

| Setting | What it does |
|---|---|
| **Enable transcoding** | When off, devices must play the original or a remux. |
| **Preferred output codecs**, **Allow HEVC encoding**, **Allow AV1 encoding** | With a hardware encoder, devices that play HEVC or AV1 get it at about two-thirds of the H.264 bitrate. Never encoded on the CPU. |
| **Max concurrent transcodes** | Further transcodes wait or are refused. |
| **Encoder preset** | CPU encoding only: faster presets use less CPU but give a softer picture. |
| **Tone-map HDR to SDR** and **Tone-map on the GPU when possible** | Keeps colours right on SDR screens. |

If a hardware transcode fails to start, {{product}} retries in software automatically and shows *"Hardware transcoding failed, used software"* on the dashboard. See [Hardware transcoding isn't working](help:hwaccel-problems).
