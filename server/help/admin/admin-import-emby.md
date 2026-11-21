---
title: Moving users over from Emby
summary: Import Emby users, their permissions, watch history, resume points, favourites, playlists and collections, and send each person a set-password link.
section: admin
audience: admin
keywords: emby, migrate, migration, import, move, switch, users, watched, history, resume, favourites, favorites, playlists, collections, boxsets, password, api key, path mapping
related: admin-users, admin-libraries, admin-backups
order: 18
---

**Admin → Import from Emby** copies everything your Emby Server 4.x users need from Emby to {{product}}. Your Emby
server is only read, never changed, so you can keep both running while people move over.

## Before you start

1. Add your libraries to {{product}} and let the first scan finish: titles that aren't in a {{product}} library yet
   can't receive watch history.
2. In Emby, open **Settings → Advanced → API Keys** and create a key for {{product}}.

## Connect

Enter the Emby address (for example `http://192.168.1.20:8096`) and the API key, then **Test connection** and **Save**.
The key is stored on the server and never shown again.

If Emby sees your media under different paths than {{product}} (another computer, Windows drive letters, a
container), add **path mappings**, for example `D:\Movies` → `/mnt/d/Movies`. They are used to match files and
libraries.

## Preview

**Preview import** is a dry run: it reads Emby and shows what would happen without changing anything.

- **Libraries**: which {{product}} library each Emby library maps to, by folder (after path mappings) or by name.
  Users only get the libraries that match an Emby library they could see; *All libraries* in Emby stays *All*.
- **Users**: *Create* (new account), *Merge data* (an account with the same username exists, or was imported
  before: only watch data is added), *Update* (also overwrite its permissions) or *Skip*. Untick anyone you don't
  want to import.
- **Matched counts** for watched items, resume points, favourites, playlists and collections. Titles are matched by
  TMDB/IMDb/TVDB id first (episodes by their series' id plus season and episode number), then by file path, then by
  title and year. A few unmatched examples are listed to help you fix path mappings.

## What is copied

| Emby | {{product}} |
|---|---|
| Name | Username and display name (characters {{product}} doesn't allow become `_`) |
| Administrator, Disabled | Administrator, Disabled |
| Hide this user from login screens | Hidden from the sign-in picker |
| Allow remote connections | Allow streaming outside the home network |
| Live TV access / management | Live TV / DVR recording |
| Allow downloading | Downloads |
| Simultaneous stream limit (0 = unlimited) | Max simultaneous streams |
| Maximum parental rating | Maximum content rating |
| Library access | Library access (mapped libraries) |
| Watched, play count, last played | Watched (never un-watches; play counts only go up) |
| Resume position | Resume point (unless already watched here or newer) |
| Favourites (movies, episodes, series) | Favourites |
| Playlists | Playlists owned by that user |
| Collections | Collections |

## Passwords and set-password links

Emby doesn't reveal passwords, so new accounts get a random password nobody knows and a **one-time set-password
link**. After the import, the results list each link: **Copy link** per person, **Copy all links**, or **Download
CSV**. Links work once and expire after the number of days you chose. Treat them like passwords.

Running the import again issues fresh links to anyone who hasn't used theirs yet (older links stop working).
Accounts that already existed keep their password. Users disabled in Emby get no link.

## Running it again

The import runs in the background; you can leave the page. It is safe to run as often as you like, for example
after a library scan to pick up titles that were missing: accounts aren't duplicated, playlists and collections are
topped up rather than copied twice, and nothing already watched is ever reset. Every run is recorded under
**Admin → Activity & logs**.
