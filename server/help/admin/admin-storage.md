---
title: Storage and disk spin-down
summary: Let NAS hard drives sleep while nobody is watching, and keep the server's own files on an SSD.
section: admin
audience: admin
keywords: storage, disks, nas, spin down, sleep, standby, hdparm, smartctl, maintenance window, disk-friendly mode, inotify, polling, ssd, unraid, synology, truenas
related: admin-libraries, admin-backups
order: 13
---

**Admin → Storage & disks** helps hard drives in a NAS stay asleep when nobody is watching.

## 1. Keep {{product}}'s own files on an SSD

The data folder (database, artwork cache, thumbnails, scrub previews, subtitles, backups) and the transcode folder are written all the time. Put them on an SSD or cache pool, not on the media disks.

- **Synology**: map `/config` (and the transcode folder) to an SSD volume.
- **Unraid**: use `/mnt/cache/appdata/mediamax`, not `/mnt/user/appdata`.
- **TrueNAS SCALE**: put config and transcode datasets on an SSD pool.

## 2. Detecting new files

**Detect new files** uses change notifications, which never wake a sleeping disk. Only choose polling for network shares whose changes aren't reported, and keep the interval long (**Poll every (minutes)**, at least 60).

## 3. Disk-friendly mode

Turn on **Only touch media disks in the maintenance window** and set **Window starts** and **Window ends** (for example 02:00–05:00, server time). Scheduled scans, thumbnail and preview generation, intro detection, DJ analysis and HDR detection then wait for the window. Playback, manual scans and scans caused by real file changes are never held back.

**Piggyback on awake disks** (on by default) runs a disk's waiting work while it's spinning anyway, for example because someone is watching something from it.

## 4. Disk state (Linux, optional)

**Check whether disks are asleep (Linux)** asks `hdparm` or `smartctl` without waking the drive. In Docker this needs access to the disk devices. Without these tools disks show *Idle* or *Unknown*; nothing breaks.

The **Libraries & disks** card shows each library's disks and their state (*Active*, *Idle*, *Standby (asleep)* or *Unknown*).
