---
title: Backups and moving to another server
summary: Back up the server on a schedule, restore a backup, and move to new hardware.
section: admin
audience: admin
keywords: backup, restore, schedule, data folder, move, migrate, new server, disaster recovery, config
related: admin-updates, admin-storage
order: 14
---

## What a backup contains

A backup is one `.tar.gz` file with a consistent copy of the database (users, watch history, settings, libraries) plus artwork, branding, avatars, subtitles and plugins. Your media, caches and recordings are **not** included.

## Making backups

**Admin → Backups**:

- **Back up now**, or set **Automatic backups**: **Back up every (days)** and **Keep the newest** (older ones are deleted).
- **Download** any backup to keep a copy elsewhere.

Backups are stored in the `backups` folder inside the data folder. Copy that folder off the machine regularly (another disk, a NAS snapshot task, cloud storage): a backup on the same disk won't help if the disk fails.

| Install | Data folder |
|---|---|
| Docker / NAS | whatever you mapped to `/config` |
| Windows | `C:\ProgramData\Kinora` |
| Linux service | `/var/lib/kinora` |

The app is called {{product}}, but existing data names are retained for upgrades. Older installations may use
`C:\ProgramData\MediaMax` or `/var/lib/mediamax`. The database is still named `mediamax.db` inside the data folder;
do not rename or move it just to match the app's current name.

## Restoring

1. In **Admin → Backups**, choose **Restore** on a backup, or **Restore from file** to upload one.
2. Restart the server when asked. The restore is applied as it starts, and a *Before restore* backup of what it replaced is kept.

## Moving to another machine

1. Make and download a backup.
2. Install {{product}} on the new machine and open it.
3. Restore the backup there and restart.
4. If your media is at different paths on the new machine, edit each library's folders in **Admin → Libraries**.
