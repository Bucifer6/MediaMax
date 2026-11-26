---
title: Updating {{product}} and getting support
summary: How to update the server on Docker, Windows and Linux, and how to collect diagnostics for a bug report.
section: admin
audience: admin
keywords: update, upgrade, version, docker pull, release, new version, diagnostics, logs, bug report, support, zip
related: admin-backups, admin-setup
order: 17
---

You're running version **{{version}}**. The version is shown on **Admin → Overview**.

## Before updating

Make a backup in **Admin → Backups** (see [Backups](help:admin-backups)).

## Updating

| Install | How |
|---|---|
| **Deploy kit** (`install.sh`) | `sudo /opt/kinora/install.sh --upgrade`. It can also run weekly by itself (`--auto-upgrade`). |
| **Docker Compose** | `docker compose pull && docker compose up -d` |
| **Docker** | Pull the new image, then remove and re-create the container with the same volumes. |
| **NAS** (Synology, Unraid, TrueNAS…) | Update the container from the NAS's container or app manager. |
| **Windows** | Run the new `vibe-<version>-windows-x64-setup.exe`: it stops Vibe, upgrades it in the folder it is already in and starts it again. With the portable zip, extract the new release and run `install-service.ps1` from it again (without the service, close it and replace the files). Your data in `C:\ProgramData\Kinora` is kept. |
| **Linux binary** | `sudo systemctl stop mediamax`, remove the old `web` folder, copy the new release's files over the old ones, then `sudo systemctl start mediamax`. |

The database is upgraded automatically on the first start. The web app, the Samsung and LG TV apps and this Help Centre update with the server. After an update, everyone sees a short *What's new* card once.

## Downloading diagnostics

When asking for help, **Admin → Activity & logs → Download diagnostics** creates a ZIP with:

- version, operating system, CPU, memory and disk space;
- ffmpeg version and the last **Detect hardware** report;
- network mode, library counts and scheduled task results;
- settings, with **every password, API key, token and webhook URL removed**;
- recent server logs, with tokens and credentials removed.

Look through it before sharing; it may still contain library names, folder paths and IP addresses.
