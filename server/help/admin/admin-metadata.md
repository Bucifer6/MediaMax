---
title: Metadata providers and Fix match
summary: Configure TMDB and the other metadata providers, choose artwork sources, and correct wrong matches.
section: admin
audience: admin
keywords: metadata, tmdb, thetvdb, fanart.tv, theaudiodb, musicbrainz, audnexus, omdb, lrclib, open library, google books, artwork, posters, fix match, wrong match, edit metadata, lock, refresh metadata, episode order
related: admin-libraries, missing-items
order: 10
---

## Providers

**TMDB** is the main source for movies and shows: add its API key in **Admin → Server settings → General**. The other providers are in **Admin → Server settings → Metadata**:

| Provider | Fills | Key |
|---|---|---|
| TheTVDB | Shows, including aired, DVD or absolute episode order | Required |
| fanart.tv | Logos, clear art, backgrounds | Required (free) |
| TheAudioDB | Artist biographies and artwork | Required |
| MusicBrainz | Artist and album ids, genres | None |
| Audnexus, Open Library, Google Books | Audiobooks, chapters | None (Google Books optional) |
| LRCLIB | Synced lyrics | None |
| OMDb | IMDb, Rotten Tomatoes and Metacritic ratings | Required |

Providers run from top to bottom and only fill empty, unlocked fields. **Test** checks a key. Keys are write-only once saved. Providers without a key are on by default.

**Preferred artwork source** chooses which provider may replace downloaded artwork per type. Local artwork files and artwork you uploaded or locked are never replaced.

## Fixing a wrong match

1. Open the title and choose **Edit metadata → Fix match…** (admins only).
2. Search the provider and pick the right entry.
3. {{product}} drops the old match and its downloaded artwork, then fetches everything again. Locked fields and your own artwork stay.

For movies, adding the year to the folder name, or `[tmdbid-12345]`, prevents most wrong matches in the first place.

## Editing by hand

**Edit metadata** lets you change titles, plots, dates and more. Edited fields are locked so refreshes won't overwrite them. **Upload artwork** replaces posters and backgrounds. **Refresh metadata** on a title, or **Refresh all metadata** on a library (**Admin → Libraries → More**), fetches again.
