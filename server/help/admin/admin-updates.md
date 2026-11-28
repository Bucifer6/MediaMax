---
title: Updating {{product}} and getting support
summary: How to update the server on Docker, Windows and Linux, and how to collect diagnostics for a bug report.
section: admin
audience: admin
keywords: update, upgrade, version, update now, automatic updates, install updates automatically, permission prompt, uac, check for updates, github, docker pull, release, new version, pre-release, diagnostics, logs, bug report, support, zip
related: admin-backups, admin-setup
order: 17
---

You're running version **{{version}}**. The version is shown on **Admin → Overview**.

## Finding new versions

{{product}} looks for a new release on GitHub every 12 hours. When there is one, **Admin → Overview** shows a banner
and **Admin → Updates** shows the new version and its release notes. Press **Check now** to look straight away.
Turn off **Check for new versions automatically** on that page to stop the checks, or turn on **Include
pre-releases** to be offered test versions too.

## Automatic updates (Windows)

On a server installed with the Windows setup program, **Install updates automatically** (on **Admin → Updates**, on
by default) installs a new version by itself once nothing is playing or recording. Nobody needs to be at the server
and Windows shows no permission prompt, in tray app and background service mode alike. Turn it off to install only
when you press **Update now**. A version that fails to install is tried again a day later at the soonest; the reason
is shown on **Admin → Updates**.

## Update now (Windows)

On a server installed with the Windows setup program, press **Update now** on **Admin → Updates** (from any
browser; you don't need to be at the server). The new setup program is downloaded from the GitHub release, checked
against the release's `SHA256SUMS.txt`, and run. Setup stops {{product}}, installs the new version in the same folder
(keeping tray app or background service mode and the port) and starts it again. Playback stops for a minute or two,
and the page reloads when the server is back.

Setup registers a **Vibe updater** scheduled task that runs as SYSTEM and that signed-in users may start but not
change. Updates go through it, so Windows doesn't ask for permission. It only ever installs a newer official release
from GitHub that matches its checksum. Its download, log (`setup.log`) and last result are in the `updates` folder
inside the {{product}} program folder.

- **Installed before the updater task existed, tray app mode:** the first update still makes Windows on the server
  ask for permission (choosing **No** cancels it). That update adds the task, and later ones need no prompt.
- **Same case, background service mode:** setup runs without asking, through a one-off **Vibe update** scheduled task.
- If the server does not come back, see `updates\setup.log` in the program folder (or `Setup Log *.txt` in the
  Windows temp folder), or run the setup program from the release page by hand.

Other installs can't replace themselves (a container image, or program files only an administrator can write), so
**Admin → Updates** shows the steps below instead.

## Before updating

Make a backup in **Admin → Backups** (see [Backups](help:admin-backups)).

## Updating by hand

| Install | How |
|---|---|
| **Deploy kit** (`install.sh`) | `sudo /opt/vibe/install.sh --upgrade` (`/opt/vibe` for installs made before the rename). It can also run weekly by itself (`--auto-upgrade`). |
| **Docker Compose** | `docker compose pull && docker compose up -d` |
| **Docker** | Pull the new image, then remove and re-create the container with the same volumes. |
| **NAS** (Synology, Unraid, TrueNAS…) | Update the container from the NAS's container or app manager. |
| **Windows** | Press **Update now** on **Admin → Updates**, or run the new `vibe-<version>-windows-x64-setup.exe` yourself: it stops Vibe, upgrades it in the folder it is already in and starts it again. With the portable zip, extract the new release and run `install-service.ps1` from it again (without the service, close it and replace the files). Your data in `C:\ProgramData\Vibe` is kept. |
| **Linux binary** | `sudo systemctl stop vibe`, remove the old `web` folder, copy the new release's files over the old ones, then `sudo systemctl start vibe`. |

The database is upgraded automatically on the first start. The web app, the Samsung and LG TV apps and this Help Centre update with the server. After an update, everyone sees a short *What's new* card once.

## Downloading diagnostics

When asking for help, **Admin → Activity & logs → Download diagnostics** creates a ZIP with:

- version, operating system, CPU, memory and disk space;
- ffmpeg version and the last **Detect hardware** report;
- network mode, library counts and scheduled task results;
- settings, with **every password, API key, token and webhook URL removed**;
- recent server logs, with tokens and credentials removed.

Look through it before sharing; it may still contain library names, folder paths and IP addresses.
