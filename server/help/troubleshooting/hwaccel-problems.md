---
title: Hardware transcoding isn't working
summary: Detect hardware finds no GPU, tests fail, or transcodes fall back to the CPU.
section: troubleshooting
audience: admin
keywords: hardware acceleration, gpu, not working, permission denied, renderD128, /dev/dri, vaapi, qsv, nvenc, nvidia-smi, failed, software fallback, cpu 100%, detect hardware
related: admin-transcoding, why-transcoding
order: 9
---

Start with **Admin → Server settings → Transcoding → Detect hardware**. Each card shows what works or ffmpeg's exact error.

## No GPU found

| Setup | Check |
|---|---|
| Docker, Intel/AMD | The container has `devices: - /dev/dri:/dev/dri`, and `ls -l /dev/dri` on the host shows `renderD128`. |
| Docker, NVIDIA | The NVIDIA Container Toolkit is installed, the container has the GPU (`--gpus all`, capabilities `gpu,video`), and `nvidia-smi` works inside it. |
| Linux service | The service user is in the `render` and `video` groups; the VA-API driver is installed. |
| Windows | The GPU driver is current. With several GPUs, set the **GPU index**. |
| Synology AMD Ryzen models | No GPU: use software. |
| Raspberry Pi 5 | No hardware encoder: use software and prefer direct play. |

## "permission denied" on /dev/dri/renderD128

The server's user can't open the GPU. In Docker with `PUID`/`PGID`, the container joins the right group by itself; with Docker's own `user:`, add `group_add` with the render group's number (`stat -c %g /dev/dri/renderD128`). On Synology, run `sudo chmod 666 /dev/dri/renderD128` (and add it as a boot-up task, because DSM resets it).

## Tests pass but transcodes use the CPU

- Press **Use this** on the card **and** then **Save changes**.
- The dashboard says *"Hardware transcoding failed, used software"*: the GPU failed for that video. Check **Admin → Activity & logs → Server log** for ffmpeg's error. 10-bit HEVC and HDR tone-mapping are often the parts that fail; turn off **Tone-map on the GPU when possible** to keep the GPU for encoding.
- HEVC and AV1 are never encoded on the CPU; if the GPU can't encode them, H.264 is used.

## After changing drivers or hardware

Press **Re-run detection**: results are kept until the server restarts.
