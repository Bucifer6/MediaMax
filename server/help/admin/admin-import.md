---
title: Moving over from Emby, Jellyfin or Plex
summary: Import users, their permissions, watch history, resume points, favourites, playlists and collections from Emby, Jellyfin or Plex, and send each person a set-password link.
section: admin
audience: admin
keywords: emby, jellyfin, plex, migrate, migration, import, move, switch, users, watched, history, resume, favourites, favorites, playlists, collections, boxsets, password, api key, plex token, x-plex-token, path mapping, playback reporting
related: admin-users, admin-libraries, admin-backups
order: 18
---

**Admin → Import from another server** copies what your users need from **Emby Server 4.x**, **Jellyfin 10.8+** or
**Plex Media Server** to {{product}}. The old server is only read, never changed, so you can keep both running while
people move over. Pick the server you're coming from at the top of the page; each keeps its own settings.

## Before you start

1. Add your libraries to {{product}} and let the first scan finish: titles that aren't in a {{product}} library yet
   can't receive watch history.
2. Get a key for the old server:
   - **Emby**: *Settings → Advanced → API Keys*, create a key.
   - **Jellyfin**: *Dashboard → API Keys*, add a key.
   - **Plex**: the **server owner's** token. Sign in to Plex Web as the owner, open any title, choose
     *⋯ → Get Info → View XML* and copy the value after `X-Plex-Token=` in the address bar.

## Connect

Enter the server address and the key, then **Test connection** and **Save**. The key (or token) is stored on the
server and never shown again.

- Emby / Jellyfin: usually `http://192.168.1.20:8096` (some Emby setups need `/emby` at the end).
- Plex: the server on your home network, usually `http://192.168.1.20:32400`. {{product}} also asks
  **plex.tv** (over the internet) for your users, the libraries you share with them and their access tokens.

If the old server sees your media under different paths than {{product}} (another computer, Windows drive letters, a
container), add **path mappings**, for example `D:\Movies` → `/mnt/d/Movies`. They are used to match files and
libraries.

## Preview

Both previews are dry runs: they read the old server and change nothing.

- **Quick preview** only asks for counts (watched, resume points, favourites, history, playlists per user). It takes
  seconds even with tens of thousands of titles and dozens of users.
- **Full preview** reads and matches every title, so you can see how many will be found and why others won't.

The preview shows:

- **Libraries**: which {{product}} library each old library maps to, by folder (after path mappings) or by name.
  Users only get the libraries that match a library they could see; *all libraries* stays *all*.
- **Users**: *Create* (new account), *Merge data* (an account with the same username exists, or was imported
  before: only watch data is added), *Update* (also overwrite its permissions) or *Skip*. Untick anyone you don't
  want to import. Notes under a name explain anything that couldn't be copied exactly.
- **Matched counts**. Titles are matched by TMDB/IMDb/TVDB id first (episodes by their series' id plus season and
  episode number), then by file path, then by title and year. A few unmatched examples help you fix path mappings.

## What is copied

| | Emby | Jellyfin | Plex |
|---|---|---|---|
| Username, display name | ✓ | ✓ | Plex username (managed users: their name) and title |
| Administrator | ✓ | ✓ | The server owner |
| Disabled | ✓ | ✓ | — |
| Shown on the sign-in screen | Unless *hidden from login screens* | Unless *hidden* | Plex Home members |
| Streaming outside the home | *Allow remote connections* | *Allow remote connections* | Always allowed |
| Max simultaneous streams | *Simultaneous stream limit* | *Maximum active sessions* | Unlimited |
| Live TV / DVR | ✓ | ✓ | *Allow Live TV* |
| Downloads | ✓ | ✓ | *Allow downloads (sync)* |
| Maximum content rating | Parental rating | Parental rating | Rating filter of the share; restricted users without one get PG |
| Library access | ✓ | ✓ | Shared libraries |
| Watched, play count, last played | ✓ | ✓ | ✓ (each user's own) |
| Resume position | ✓ | ✓ | ✓ (users with a share token) |
| Favourites | ✓ | ✓ | Plex has none |
| Play history | Playback Reporting plugin | Playback Reporting plugin | Server viewing history |
| Playlists | ✓ | ✓ | Video playlists (users with a share token) |
| Collections | ✓ | ✓ | ✓ |

Watched titles are never un-watched here, play counts only go up, and a resume point is skipped when the title is
already watched in {{product}} or has a newer position. Jellyfin *blocked tags* can't be copied; the results say so.

### Plex users

- **Friends** you share the server with: {{product}} uses the access token plex.tv keeps for each share to read
  that person's own watched flags, resume points and playlists.
- **Managed Plex Home users** usually have no such token. For them, watched titles (with the date) come from the
  server's viewing history; resume points and playlists can't be read.
- Plex has no per-user remote-access or stream limits, so imported Plex users have none. Plex e-mail addresses are
  not stored.

### Play history

History rows feed your users' stats and *Year in review*. Plex keeps them on the server. Emby and Jellyfin only have
them with the **Playback Reporting** plugin; without it the import simply skips history and says so.

## Passwords and set-password links

The old server doesn't reveal passwords, so new accounts get a random password nobody knows and a **one-time
set-password link**. After the import, the results list each link: **Copy link** per person, **Copy all links**,
or **Download CSV**. Links work once and expire after the number of days you chose. Treat them like passwords.

Running the import again issues fresh links to anyone who hasn't used theirs yet (older links stop working).
Accounts that already existed keep their password. Disabled users get no link.

## Running it again

The import runs in the background with progress per step; you can leave the page. It is safe to run as often as you
like, for example after a library scan to pick up titles that were missing: accounts aren't duplicated, playlists and
collections are topped up rather than copied twice, history rows aren't added twice, and nothing already watched is
ever reset. Only one import runs at a time. Every run is recorded under **Admin → Activity & logs**.
