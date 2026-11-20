# Metadata providers

MediaMax reads local metadata first (NFO files, embedded tags, `cover.jpg`/`poster.jpg`/`fanart.jpg`, `.lrc` files), then
asks online services for what is still missing. **TMDB** is the main source for movies and shows; on top of that MediaMax
ships nine **built-in providers**, so you get rich metadata without installing plugins.

Configure them in **Admin → Server settings → Metadata**:

* **Enable** each provider and enter its **API key** where one is needed. Keys are write-only: once saved the field shows
  "Saved"; type to replace it or press × to remove it. The API never returns a key (it sends `••••`).
* **Test** makes a live request with the key in the form (saved or not) and shows what came back.
* **Priority**: providers run top to bottom and only fill **empty, unlocked** fields, so the first one that has a value wins.
  TMDB always runs first for movies and shows. MusicBrainz sits above fanart.tv and TheAudioDB by default because its
  MBIDs let those two find exact matches.
* **Preferred artwork source** per type (movies, shows, artists, albums, audiobooks): *Automatic* keeps local and TMDB art
  and lets providers fill gaps. Choosing a provider lets it replace *downloaded* artwork. Local artwork files and artwork you
  locked or uploaded are never replaced.
* **Cache**: every response (including "not found") is stored in the `metadata_cache` table. Hits are kept for the
  configured number of hours (default 168 = 7 days) and misses for up to 24 hours. Use *Clear cache* to forget everything.
* The **missing** counter on each provider shows how many items in libraries with metadata enabled it could still fill
  (for example "audiobooks without an ASIN"). **Refresh all metadata** runs every enabled provider for every library. You
  can follow its progress in *Scheduled tasks*.

Everything is free or has a free tier.

| Provider | Fills | Key | Cost / limits |
|---|---|---|---|
| [TMDB](https://www.themoviedb.org) | Movies & shows: titles, plots, cast, posters, backdrops, logos, trailers, collections, TMDB rating | Required (General tab) | Free for non-commercial use |
| [TheTVDB](https://thetvdb.com) | Shows: overview, genres, network, artwork, season posters; **episode titles/overviews/dates/thumbnails in aired, DVD or absolute order** | Required (+ optional subscriber PIN) | Free personal keys; "user-supported" keys need the user's subscriber PIN |
| [fanart.tv](https://fanart.tv) | Movies/shows: HD logos, clear art, backgrounds, disc art, banners, thumbs, season posters. Artists: backgrounds, logos, thumbs. Albums: covers, CD art (by MusicBrainz id) | Required (free personal key) | Free |
| [TheAudioDB](https://www.theaudiodb.com) | Artists: biography, genre, mood, style, formed year, country, thumb/fanart/logo/banner. Albums: description, genre, year, cover, CD art | Required (`2` works for testing) | Free key; 30 requests/minute (enforced) |
| [Audnexus](https://audnex.us) | Audiobooks: title, authors, narrators, series + position, description, genres, publisher, release date, cover, **chapters** | None | Free |
| [Open Library](https://openlibrary.org) | Audiobooks (book fallback): description, cover, first publish year, ISBN, subjects | None | Free |
| [Google Books](https://books.google.com) | Audiobooks (book fallback): description, cover, publish date, ISBN, categories, publisher | Optional | Free; without a key a small shared quota, with a free key 1,000 requests/day |
| [LRCLIB](https://lrclib.net) | Tracks: synced lyrics when there is no `.lrc` file or embedded lyrics | None | Free |
| [OMDb](https://www.omdbapi.com) | Movies/shows: **IMDb, Rotten Tomatoes and Metacritic ratings** (badges on the item page); fills missing plot, genres, content rating, poster | Required | Free key: 1,000 requests/day (enforced) |
| [MusicBrainz](https://musicbrainz.org) + [Cover Art Archive](https://coverartarchive.org) | Artists & albums: MBIDs, genres, short artist description; album cover only when the album has none | None | Free; **1 request/second** (enforced) |

The providers that need no key are **on by default**. The ones that need a key stay off until you enter one.

## Getting the keys

**TMDB.** Create a free account at themoviedb.org, then go to *Settings → API* (<https://www.themoviedb.org/settings/api>)
and request a developer key (choose "personal/non-commercial"). Either the *API Key (v3)* or the *Read Access Token* works.
Paste it on the **General** tab, or set `TMDB_API_KEY`.

**TheTVDB.** Create an account at thetvdb.com and request a v4 API key at <https://thetvdb.com/api-information>. Personal,
non-commercial keys are free. If you get a *user-supported* key, or are told a PIN is required, also enter your **subscriber
PIN** (from your TheTVDB subscription) in the PIN field. TheTVDB's licensing changes from time to time, so check its current
terms. Env var: `TVDB_API_KEY`.

**fanart.tv.** Sign up at fanart.tv, then open <https://fanart.tv/get-an-api-key/> and copy your **personal API key**.
Env var: `FANART_API_KEY`.

**TheAudioDB.** The public test key `2` works for trying it out (limited data). For a personal key, see
<https://www.theaudiodb.com/free_key> (Patreon supporters get a premium key). Env var: `AUDIODB_API_KEY`.

**Google Books (optional).** In the Google Cloud console create a project, enable the *Books API*
(<https://console.cloud.google.com/apis/library/books.googleapis.com>) and create an *API key* under *Credentials*.
Restrict it to the Books API. Env var: `GOOGLE_BOOKS_API_KEY`.

**OMDb.** Request a free key at <https://www.omdbapi.com/apikey.aspx> (it is e-mailed to you and needs one click to
activate). The free key allows 1,000 requests a day. MediaMax stops calling OMDb for the rest of the day once that is used
up, and the cache avoids repeat lookups. Env var: `OMDB_API_KEY`.

**Audnexus, Open Library, LRCLIB and MusicBrainz** need no key.

The env vars only seed the defaults; a key saved in the UI wins.

## Episode orderings (TheTVDB)

Some shows, anime especially, are released in an order different from how they aired. Open a show, choose **Edit metadata**
and set **Episode order**:

* **Aired order**: the default. TMDB matches episodes; TheTVDB only fills gaps.
* **DVD order**: episodes are matched against TheTVDB's DVD order (`S01E01` = the first DVD episode).
* **Absolute order (anime)**: episode numbers are absolute (`Show - 105.mkv` → episode 105). Files in season 1, or with no
  season, are matched by absolute number.

Saving re-matches the episodes in the background. With DVD or absolute order (or when TMDB isn't configured), TheTVDB's
titles, overviews, air dates and thumbnails replace the unlocked episode fields. The setting is stored per show in the item's
`extra.episodeOrder` and survives rescans. Enable TheTVDB first.

## Audiobooks and ASINs

Audnexus looks books up by **Audible ASIN** only; it has no title search. MediaMax finds the ASIN, in this order:

1. an ASIN already on the item (set by **Fix match**);
2. the folder or file name: `Project Hail Mary [B08G9PRS1K]`, `Project Hail Mary (B08G9PRS1K).m4b`, or
   `B08G9PRS1K - Project Hail Mary` (10-digit ISBN-style ASINs of older books must be in brackets);
3. the first file's `ASIN` / `AUDIBLE_ASIN` tag (as written by tools such as Libation, OpenAudible or Mp3tag).

MediaMax does **not** use Audible's undocumented catalogue search. When no ASIN is found, **Google Books** and
**Open Library** fill the description, cover, year, ISBN and subjects by title + author ("(Unabridged)" and similar noise is
stripped). To pin a book to the exact Audible edition, open it, choose **Edit metadata → Fix match**, pick *Audnexus (ASIN)*
and paste the ASIN from the book's Audible URL (`audible.com/pd/…/B08G9PRS1K`).

Audnexus chapters are shown on the book when the files have no embedded chapters. The series and position fill in when the
folder layout and tags don't name one.

## Fix match

For movies, shows, artists, albums and audiobooks: **Edit metadata → Fix match…**. Search the provider for the item's type
(TMDB or TheTVDB for shows; MusicBrainz for music; Audnexus by ASIN, Google Books or Open Library for audiobooks) and pick
the right entry. MediaMax drops the old match's ids and downloaded artwork, then re-fetches everything in *replace* mode:
unlocked fields take the new match's values. Locked fields and local or uploaded artwork stay. Seasons and episodes follow
their show.

## Lyrics (LRCLIB)

When a track has no `.lrc`/`.txt` file next to it and no embedded lyrics, MediaMax asks LRCLIB by track title, artist, album
and duration. Synced lyrics are preferred, then plain lyrics. Hits and misses are cached, so each track is looked up at most
once per cache period. Turn the LRCLIB toggle off to stop all lookups.

## Ratings (OMDb)

OMDb adds `Item.ratings` = `{ imdb, rottenTomatoes, metacritic }`, and TMDB adds `tmdb`. The web item page shows them as
badges next to the star rating.

## Plugins

The example plugins **omdb-ratings** and **musicbrainz** keep working: plugin providers run after the built-in ones and also
fill only empty fields, so running both is harmless. You can uninstall them once the built-in providers are enabled.

## Privacy and network use

* Requests carry only search terms (titles, years, artist/album names, track durations) and ids (TMDB/IMDb/TheTVDB ids,
  MBIDs, ASINs). They never carry user names, play history or file paths.
* Every request sends `User-Agent: MediaMax/<version>`, has a 15-second timeout, waits and retries after `429`/`503`, and goes
  through a per-service client-side rate limit (MusicBrainz 1/s, TheAudioDB 30/min, Open Library ~2/s, others ~5–10/s).
* Images from providers are downloaded and cached by the server (through the SSRF guard for third-party URLs), so clients
  never contact the providers.
* A first scan of a large music library takes a while because of MusicBrainz's 1 request/second (about 2 requests per album
  or artist). Later scans only look up new items.

## Self-hosted mirrors and testing

Each service's base URL can be overridden with an env var (used by the test suite's mock servers):
`MEDIAMAX_TVDB_API_BASE`, `MEDIAMAX_FANART_API_BASE`, `MEDIAMAX_AUDIODB_API_BASE`, `MEDIAMAX_AUDNEXUS_API_BASE`,
`MEDIAMAX_OPENLIBRARY_API_BASE`, `MEDIAMAX_OPENLIBRARY_COVERS_BASE`, `MEDIAMAX_GOOGLEBOOKS_API_BASE`,
`MEDIAMAX_LRCLIB_API_BASE`, `MEDIAMAX_OMDB_API_BASE`, `MEDIAMAX_MUSICBRAINZ_API_BASE`, `MEDIAMAX_COVERART_API_BASE`
(and `MEDIAMAX_TMDB_API_BASE` for TMDB).
