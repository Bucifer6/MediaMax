---
title: Libraries, scanning and folder naming
summary: Add libraries, name folders so titles match correctly, and control scanning.
section: admin
audience: admin
keywords: library, add library, folder, scan, rescan, naming, file names, movies, tv shows, music, audiobooks, photos, home videos, nfo, artwork, extras, trailers, editions, refresh metadata
related: admin-metadata, missing-items, admin-storage
order: 2
---

## Adding a library

1. **Admin → Libraries → Add library**.
2. Choose the type: **Movies**, **TV Shows**, **Music**, **Audiobooks**, **Photos** or **Home videos**.
3. Give it a name and add one or more **Folders**. The server must be able to read them (in Docker, the folders must be mounted into the container).
4. Leave **Fetch online metadata** on to get posters, plots and cast.

Each library has **Scan** (look for new and changed files) and, under **More**, **Edit**, **Refresh all metadata** and **Delete**. Use the arrows to change the order in the sidebar. Deleting a library never deletes your files.

## Naming folders and files

{{product}} understands the naming used by Plex, Jellyfin, Emby and Kodi.

**Movies** — one folder per movie:

```
Movies/The Matrix (1999)/The Matrix (1999).mkv
Movies/Blade Runner (1982)/Blade Runner (1982) - Director's Cut.mkv
Movies/Heat (1995) [tmdbid-949]/Heat.mkv
```

The year matters most. `{edition-Extended}` or words such as *Director's Cut* mark an edition. `[tmdbid-…]` or an IMDb id (`tt0133093`) forces the match.

**TV shows** — one folder per show, seasons inside:

```
TV Shows/Breaking Bad (2008)/Season 01/Breaking Bad - S01E01 - Pilot.mkv
TV Shows/Breaking Bad (2008)/Specials/Breaking Bad - S00E01.mkv
```

**Music** — `Artist/Album/01 - Track.flac`. Tags inside the files (artist, album, track number) take priority.

**Extras** — folders named `Trailers`, `Featurettes`, `Behind The Scenes`, `Deleted Scenes`, `Interviews` or `Extras` next to the video are shown as extras, not as separate titles.

## Local metadata

`.nfo` files, `poster.jpg`, `folder.jpg`, `fanart.jpg`, embedded tags and `.lrc` lyrics next to your media are used first. Libraries with **Fetch online metadata** off show a *Local metadata* badge.

## When scans happen

- New files are picked up automatically when the folder changes (on network shares this may need polling: see **Admin → Storage & disks**).
- A full scan runs every **Library scan interval** (**Admin → Server settings → General**, default 360 minutes).
- Press **Scan** to scan now.

### "Files skipped: unsupported character set"

Files whose names are not valid UTF-8 are skipped, because they would break playback links and subtitle matching. This usually happens with files copied from an old Windows PC or Samba share that used a legacy character set (such as Windows-1252 or Shift-JIS). The library shows how many were skipped and lists them (unreadable characters appear as `\xNN`); the server log has a warning for each. Rename them, for example with `convmv -f cp1252 -t utf8 -r --notest <folder>`, then press **Scan**.

Something missing or matched wrongly? See [Missing titles or wrong matches](help:missing-items).
