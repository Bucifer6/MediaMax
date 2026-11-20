---
title: Missing titles or wrong matches
summary: Why a movie, show or album doesn't appear, or shows the wrong poster and description.
section: troubleshooting
audience: everyone
keywords: missing, not showing, can't find, wrong poster, wrong match, wrong movie, metadata, scan, library, hidden, rating, episodes missing, duplicate
related: problem-with-a-title, admin-libraries, admin-metadata
order: 7
---

## For everyone

- **Search for it.** **Search** covers every library you can see.
- **You may not have access.** Your admin decides which libraries you see, and a maximum content rating hides titles above it (and, if set, titles without a rating). Kids profiles have a rating limit too.
- **It may not be added yet.** New files appear after the next scan. If your server takes requests, you can ask for it on **Discover**.
- **Wrong poster or description?** [Tell your admin](help:problem-with-a-title) so they can fix the match.

## For admins

### A title doesn't appear

1. Check the file is inside one of the library's folders, and that the server can read it (in Docker the folder must be mounted, and the container user needs read permission).
2. Press **Scan** on the library in **Admin → Libraries**.
3. Check the name follows the expected pattern, for example `Movies/Title (Year)/Title (Year).mkv` and `Show (Year)/Season 01/Show - S01E01.mkv`. Folders called `Trailers`, `Extras`, `Featurettes` or `Samples` are treated as extras, not titles.
4. Look in **Admin → Activity & logs → Server log** for scan errors.

### Wrong match

Open the title, choose **Edit metadata → Fix match…** and pick the right entry. To stop it happening again, add the year to the folder name, or `[tmdbid-12345]`.

### Episodes in the wrong order

For shows that use DVD or absolute numbering (common with anime), enable TheTVDB in **Admin → Server settings → Metadata**, then open the show, choose **Edit metadata** and set **Episode order** to *DVD order* or *Absolute order (anime)*.

See [Libraries, scanning and folder naming](help:admin-libraries) and [Metadata providers and Fix match](help:admin-metadata).
