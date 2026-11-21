# Performance

How fast MediaMax is on a big install, how to measure it, what was changed to make it faster, and what is left.

The target is one home server with about 10 drives, 20,000 movies, 2,000 shows (60,000 episodes), a few thousand IPTV
channels with a large XMLTV guide, 80 users and up to 10 streams at once. The web app is also the Samsung and LG TV
app, so the client numbers below are taken with the CPU slowed down 4× to stand in for a TV.

## Measuring it yourself

All the tools live in `scripts/perf/` and use the built server (`npm run build` first).

| Command | What it does |
|---|---|
| `npm run perf` (`node scripts/perf/run.mjs`) | Seeds a synthetic large library straight into SQLite (once; it is cached in your temp folder), boots the server with `MEDIAMAX_PERF=1` and times the hot API endpoints: a sequential pass (latency and SQL statements per request), then 1, 10 and 50 concurrent clients spread over the 80 seeded users. Writes `scripts/perf/results/<label>.json`. |
| `node scripts/perf/compare.mjs before.json after.json --level=10` | Markdown before/after table of two runs. |
| `node scripts/perf/web.mjs` | Playwright and Chromium against the seeded server, CPU throttled 4×: Home first paint and time to the first rows, bytes downloaded, library grid and TV guide scroll frame rate and long tasks, Home → title → player. |
| `node scripts/perf/playback.mjs` | Generates short test files with ffmpeg and measures `POST /playback` → first media bytes for direct play, remux and transcode. |
| `node scripts/perf/trace.mjs /home` | Every SQLite statement one request runs, with timings (cold, then warm). |

Useful options: `--label=name`, `--repo=<other checkout>` (benchmark an older build side by side, which is how the
"before" numbers below were taken), `--scale=0.25` (smaller seed), `--quick`, `--only=home,search`.

Perf mode (`MEDIAMAX_PERF=1`) adds `X-MM-Queries` and `X-MM-Time` headers to every response and logs statements slower
than `MEDIAMAX_PERF_SLOW_MS` (default 20 ms). It is off by default and costs nothing when off.

### The seeded library

20,000 movies, 2,000 shows, 8,038 seasons, 60,521 episodes, each title with cast and crew (30,000 people), genres,
studios and media rows with full probe data (two audio tracks, two subtitle tracks); 80 users (every eighth one a
PG-13 profile) with watch history (30,000 user-data and play-history rows, shows in progress, a watchlist each);
3,000 IPTV channels in 40 categories with a 72-hour guide (200,000 programmes); 200 real artwork files.

### Test machine

A shared cloud VM: 4 vCPU Intel Xeon @ 2.1 GHz, Node 22.23, Linux. Other jobs ran on the same machine at times, so
treat single numbers as ±15%; the large differences are far outside that. The browser runs headless with software
rendering (no GPU), which makes painting slower than on a real TV and puts a ceiling on the frame rates below.

## Results

### Server API (`npm run perf`)

Sequential p50 latency, then p95 latency and throughput with 10 concurrent clients, SQL statements per request and
bytes on the wire. "Before" is the tree this work started from, run on the same seed and machine.

| Endpoint | p50 ms (seq) | p95 ms @10 | req/s @10 | SQL statements | Wire size |
|---|---|---|---|---|---|
| auth: /system/info (no auth) | 1.3 → **1.2** 1.1× | 5.4 → **7** | 3307 → **2757** | 4 → 4 | 0.3 KB → 0.3 KB |
| auth: /auth/me (token lookup) | 1.4 → **1.1** 1.3× | 7.2 → **8.2** | 2595 → **2754** | 4 → 4 | 1.1 KB → 1.1 KB |
| home | 498 → **74.4** 6.7× | 7758 → **424** | 2 → **30** | 135.9 → 113.9 | 297 KB → 45 KB (br) |
| home (restricted profile) | 504 → **51.1** 9.9× | 8675 → **372** | 2 → **32** | 120.4 → 97.8 | 270 KB → 39 KB (br) |
| browse movies: title p1 | 44.9 → **6.3** 7.1× | 797 → **77** | 22 → **194** | 8 → 7 | 107 KB → 16 KB (br) |
| browse movies: title deep page | 305 → **6.3** 48× | 5664 → **74.4** | 3 → **193** | 6 → 7 | 108 KB → 17 KB (br) |
| browse movies: added desc | 46.5 → **6.2** 7.5× | 852 → **58.7** | 21 → **207** | 6 → 7 | 108 KB → 17 KB (br) |
| browse movies: rating desc | 45.1 → **5.7** 7.9× | 799 → **60.9** | 21 → **211** | 6 → 7 | 108 KB → 17 KB (br) |
| browse movies: genre filter | 48 → **24.5** 2.0× | 846 → **245** | 21 → **47** | 6 → 7 | 108 KB → 17 KB (br) |
| browse movies: unwatched | 45.3 → **20.6** 2.2× | 864 → **220** | 21 → **53** | 6 → 7 | 107 KB → 16 KB (br) |
| browse movies: letter M | 26.6 → **7.3** 3.6× | 503 → **71.9** | 36 → **161** | 6 → 7 | 108 KB → 16 KB (br) |
| browse shows: title p1 | 19.6 → **6** 3.3× | 313 → **72.3** | 56 → **183** | 6 → 7 | 108 KB → 16 KB (br) |
| browse movies (restricted) | 47.3 → **21.3** 2.2× | 823 → **232** | 21 → **52** | 6.8 → 7.8 | 107 KB → 16 KB (br) |
| genres list | 25.3 → **0.8** 32× | 436 → **5** | 39 → **4290** | 6.2 → 5 | 0.2 KB → 0.2 KB |
| item: movie | 1.4 → **1.3** 1.1× | 15.8 → **18.8** | 1132 → **990** | 10 → 10 | 2.5 KB → 2.5 KB |
| item: movie similar | 58.2 → **16.3** 3.6× | 868 → **221** | 20 → **67** | 20.7 → 20.7 | 29 KB → 5.2 KB (br) |
| item: show | 1.4 → **1.4** 1.0× | 13.2 → **14.1** | 1271 → **1195** | 10 → 10 | 1.8 KB → 1.8 KB |
| item: show seasons | 1.5 → **1.5** 1.0× | 14.7 → **17.3** | 1149 → **997** | 10 → 11 | 3.2 KB → 3.2 KB |
| item: show next-up | 1.4 → **1.5** 0.9× | 25.8 → **17.1** | 743 → **995** | 12 → 13 | 1.0 KB → 1.0 KB |
| item: season episodes | 1.6 → **1.4** 1.1× | 14.9 → **14.6** | 1162 → **1170** | 10 → 11 | 6.0 KB → 6.0 KB |
| item: episode | 1.3 → **1.3** 1.0× | 16.1 → **13.3** | 1121 → **1304** | 10 → 10 | 1.7 KB → 1.7 KB |
| search "shadow" | 283 → **107** 2.6× | 5189 → **1142** | 3 → **9** | 11 → 12 | 87 KB → 15 KB (br) |
| search "Smith" (people) | 285 → **123** 2.3× | 4572 → **1317** | 4 → **8** | 11.5 → 11 | 54 KB → 8.9 KB (br) |
| watchlist | 2.8 → **4.1** 0.7× | 39.7 → **36.9** | 452 → **372** | 9 → 9 | 54 KB → 9.1 KB (br) |
| guide 6h x 500ch | 32.9 → **40.3** 0.8× | 475 → **363** | 37 → **31** | 9 → 9 | 1624 KB → 280 KB (br) |
| guide 6h x 60ch (web page) | 6.2 → **9.4** 0.7× | 96.1 → **94.4** | 175 → **123** | 9 → 9 | 194 KB → 33 KB (br) |
| channels (now/next) 200 | 10.4 → **13.8** 0.8× | 179 → **141** | 100 → **84** | 6 → 6 | 246 KB → 38 KB (br) |
| admin: system stats | 4 → **2.8** 1.4× | 59.9 → **37.9** | 285 → **452** | 10 → 10 | 0.2 KB → 0.2 KB |
| admin: stats/server 30d | 80.9 → **66.2** 1.2× | 1274 → **737** | 13 → **15** | 3 → 3 | 9.5 KB → 1.7 KB (br) |
| admin: sessions | 0.8 → **0.8** 1.0× | 6.1 → **4** | 4081 → **4935** | 2 → 2 | 0.0 KB → 0.0 KB |
| admin: activity | 1 → **0.8** 1.3× | 8.6 → **6** | 2650 → **3290** | 4 → 4 | 1.3 KB → 1.3 KB |
| admin: users | 1.9 → **2.8** 0.7× | 27.2 → **41.4** | 668 → **364** | 83 → 83 | 85 KB → 1.5 KB (br) |
| image: cached w=300 | 0.9 → **1.2** 0.8× | 10 → **11.1** | 2334 → **2391** | 1 → 1 | 15 KB → 15 KB |
| image: cached w=300 revalidate | 0.8 → **0.7** 1.1× | 9.3 → **7.6** | 2580 → **4680** | 1 → 1 | 15 KB → 0.0 KB |
| static: main JS chunk | 1.8 → **2.7** 0.7× | 25.4 → **22.2** | 725 → **667** | 0 → 0 | 389 KB → 59 KB (br) |

Notes:

- **Home**, the first thing every TV and browser loads, went from about half a second of SQLite work to 50–75 ms, and
  from 2 to 30 requests a second. With 10 people opening Home together the slowest wait went from 7.8 s to 0.4 s.
- **Library browsing** is now an index walk whatever the sort or page: deep pages (offset 6,000) went from 305 ms to
  6 ms.
- Small responses (a single title, an episode, a season) are unchanged: they are under 8 KB and not compressed.
  The large ones (guide, channel lists, the watchlist) take a few milliseconds longer over loopback because they are
  now compressed, and arrive much sooner over any real network: a 500-channel guide page is 1.6 MB uncompressed and
  280 KB with Brotli, 0.1 s instead of 0.5 s over 25 Mbit/s TV Wi-Fi.
- Search is 2.3–2.6× faster but still the slowest request (105–125 ms): see "What's left".

### Playback start (`node scripts/perf/playback.mjs`)

Median of 5 starts of a 1080p test file, from `POST /playback` until the first media bytes (HLS: master playlist,
media playlist and first segment) have arrived.

| Method | `POST /playback` | First media bytes |
|---|---|---|
| Direct play (H.264/AAC MP4) | 3 ms → **3 ms** | 8 ms → **8 ms** |
| Remux (H.264 + AC-3 MKV → HLS) | 410 ms → **249 ms** | 429 ms → **266 ms** |
| Transcode (MPEG-2 → H.264 HLS) | 13 ms → **9 ms** | 3,077 ms → **1,244 ms** |

### Web client and TV app (`node scripts/perf/web.mjs`, CPU 4× slower)

| Measure | Before | After |
|---|---|---|
| Home: first contentful paint | 472 ms | **420 ms** |
| Home: first title cards on screen | 1,118 ms | **839 ms** |
| Home: JS / CSS / API bytes on the wire | 550 / 231 / 321 KB | **105 / 31 / 52 KB** |
| Home: long tasks during load | 732 ms | **534 ms** |
| Home → title page (click a poster) | 513 ms | 547 ms |
| Title page → player on screen (click Play) | 218 ms | **183 ms** |
| Library (20,000 movies): frame rate while scrolling and loading pages | 8.2 fps (2,820 cards loaded) | **9.5 fps** (3,060 cards) |
| Library: long tasks during that scroll | 40.6 s | **31.6 s** |
| Library: frame rate scrolling back up through all cards | 6.4 fps | **7.4 fps** |
| TV guide: first programmes on screen | 1,739 ms | **854 ms** |
| TV guide: frame rate while scrolling and loading channels | 1.1 fps | **6.7 fps** |
| TV guide: long tasks during that scroll | 248.6 s | **31.9 s** |
| TV guide: horizontal scroll | 52.8 fps | **77.9 fps** |

"Home → title page" is unchanged within noise: the title page is now a separate chunk, loaded when a poster is hovered
or focused or when the browser is idle after Home, which hides the extra request in normal use but not in a test that
clicks immediately.

Bytes are what goes over the wire (compressed where the server compresses). Home numbers are medians of 7 cold loads,
the rest medians of 2 runs. The frame rates are low in absolute terms because the headless browser paints in software;
compare the columns, not the numbers with a real TV.

## What changed

### Database and queries (`server/src/db.ts`, `services/items.ts`, `services/recommend.ts`)

- **Two-step paged queries.** Item lists (library pages, Home rows, search, smart lists) first fetch the matching ids
  with the filter, sort and `LIMIT`, then load the full rows for just that page. SQLite computes every selected column
  for every row it sorts, and the item `SELECT` has correlated subqueries (child count, unplayed episodes per viewer);
  a sorted page of 60 used to run them for the whole library.
- **Only the joins a query uses.** The viewer's `user_data`, the watchlist and the parent rows are joined only when the
  filter or sort refers to them. SQLite did not drop the unused `LEFT JOIN`s, so a `COUNT(*)` of a 20,000-movie
  library probed `user_data` 20,000 times (33 ms → 0.6 ms).
- **Indexes** (one new migration): `items(library_id, type, sort_title | added_at | rating)`, `items(type, added_at)`,
  `items(type, rating)`, `items(grandparent_id, added_at)`, then `ANALYZE`.
- A query already limited to one library the viewer may see skips the library-access clause (it is true for every row),
  so it can be answered from the indexes; the "not an extra" test is skipped when videos aren't requested; the title
  tie-break is not repeated when the sort is already by title (a repeated `ORDER BY` term forced a sort).
- `ud.favorite = 1` / `ud.played = 1` instead of `COALESCE(ud.x, 0) = 1` (same rows): the favourites row now starts
  from the viewer's own rows instead of scanning every title (190 ms → under 1 ms).
- **Next Up**: one query for all recently watched shows instead of two per show (up to 120 statements).
- **Featured (hero) row**: recently added titles come from an index range; the whole library is only shuffled when
  there aren't enough new titles. Same ordering rule as before.
- **Search**: a plain substring test on the raw cast JSON runs before the JSON is parsed (exact for search terms
  without characters JSON escapes; other terms use the old path).
- **Genre lists** are cached per library and access rules until any item is added, removed or re-tagged (a counter
  kept by temporary triggers on the one database connection).
- **Recommendations / "More like this"**: candidates walk the `(type, rating)` index best-first per type and stop,
  instead of testing the genres of every title and sorting them all.
- The recordings Home row loads its items in one query.
- **SQLite settings**: 64 MB page cache (the default is 2 MB; the database of a library this size is a few hundred MB),
  256 MB memory-mapped reads, `temp_store = MEMORY`. WAL, `synchronous = NORMAL` and `busy_timeout` were already set.

### HTTP (`server/src/app.ts`, `routes/library.ts`, `services/images.ts`, `web/vite.config.ts`)

- **Response compression**: JSON, HTML and XML bodies over 8 KB are compressed with Brotli (or gzip) when the client
  accepts it; very large bodies use the fastest level. Streams are never compressed: media, HLS segments and
  playlists, images and downloads go out untouched.
- **Pre-compressed static files**: the web build writes `.br` and `.gz` next to every JS, CSS and WebAssembly file and
  the server sends them (`@fastify/static` `preCompressed`).
- **Immutable assets actually cached**: hashed files under `/assets/` are sent with
  `Cache-Control: public, max-age=31536000, immutable`. They always were meant to be, but `@fastify/static`'s own
  default header (`max-age=0`) overwrote it, so every page load revalidated every chunk.
- **Artwork**: weak `ETag` and `Last-Modified`, `304 Not Modified` on revalidation, a week of caching with
  `stale-while-revalidate`; the file checks on this path are asynchronous.
- `index.html` is held in memory until the file changes.

### Background work (`services/scanner.ts`, `util/misc.ts`, `services/events.ts`)

- **Library scans no longer freeze the server.** The folder walk was fully synchronous (`readdirSync`/`statSync` over
  every drive), blocking every request for as long as it took; it is asynchronous now. A rescan of unchanged files
  only awaited promises that were already resolved, which never let a request in until the whole library was done;
  the scan worker pool now yields to the event loop every ~15 ms.
- WebSocket broadcasts are serialised once for all recipients (session updates were already throttled to 300 ms and
  scan progress to 750 ms).

### Playback start (`services/transcoder.ts`, `routes/playback.ts`)

- The first segment of a transcode is served as soon as ffmpeg has written it. Segments are written to a temporary
  name and renamed when complete (`hls_flags temp_file`), so an existing segment is a finished one; the server also
  waited for the *next* segment to appear, adding a full segment (4 s of video) of encoding to every start and seek.
  Live streams keep the old rule.
- Wait loops poll every 40 ms while a stream starts (150–200 ms before).
- Finding the newest segment resumes from the last one found instead of checking every segment file from the start
  of the run (thousands of synchronous file checks per request late in a film).

### Web client (`web/src/`)

- **Smaller first load**: the title page, library, search, login, setup and device-link pages are now route chunks;
  Home stays in the main bundle. The full-screen Now Playing overlay (visualiser, lyrics editor) is its own chunk, the
  AI vocal-separation code loads only when a track is prepared, and the app shell no longer creates the DJ engine just
  to show the "mix playing" dot. Main JS 398 KB → 215 KB (60 KB with Brotli); CSS 236 KB → 212 KB (31 KB).
- **Prefetching**: once Home's rows are on screen the title, library and search chunks load in idle time; hovering or
  focusing a link loads its page chunk (a D-pad focus on a poster loads the title page); hovering or focusing a play
  button (`data-play`) loads the player chunk, and the title page's Play button is focused when it opens.
- Route chunks load inside the shell, so the navigation stays on screen instead of the whole app blanking to a
  spinner on the first visit to a page.
- **No re-render storms while music plays**: every poster card subscribed to the whole music player state through
  `usePlayItem`, which changes on every audio `timeupdate`, so every card on screen re-rendered about four times a
  second. Cards now use a stable "actions" context.
- **Hover blur only while visible**: each card's hidden "My List" button had a `backdrop-filter` blur that the
  browser still processed per card per frame; it roughly halved the scroll frame rate of a long grid.
- **TV guide**: rows are memoised (opening a programme or loading more channels no longer re-renders every row and
  programme), only newly loaded channels are sorted, rows scrolled out of view skip layout and paint
  (`content-visibility`, fixed row height, the focused row always renders fully), and programme times use one shared
  `Intl.DateTimeFormat` with a cache instead of `toLocaleTimeString` thousands of times per render.
- **Home** shows the last response straight away when you come back to it and refreshes it in the background; the
  featured titles stay the same instead of swapping under you.
- Images already used `loading="lazy"`, `decoding="async"` and server-resized widths (`?w=`), and hls.js / mpegts.js
  were already loaded on demand; those were left as they were.

TV D-pad navigation was checked with Playwright in TV mode (`?tv=1`) on Home, the library grid and the guide: the
focus path is identical to the old build, focused cards render unclipped, and the focused element is always scrolled
into view.

## What's left

- **Search** (100–130 ms): `LIKE '%term%'` on titles, cast and 200,000 programme titles cannot use an index. An FTS5
  trigram index (substring search with an index, SQLite 3.34+) on item titles/people and programme titles would make
  it a few milliseconds; it needs triggers to stay in sync and a migration that builds the index.
- **Very long library grids**: the grid keeps every loaded card in the page (D-pad navigation finds the next card in
  the page), so scrolling gets slower as thousands load. True windowing with spatial-navigation support (render a
  window of rows, keep the focused one, map D-pad moves onto the data) is the next step. `content-visibility` was
  tried on grid cards and measured slower.
- **Guide payload**: a 500-channel page is 1.6 MB of JSON because every programme carries its description. Loading
  descriptions on demand (the programme dialog) would cut it by about two thirds.
- **Genre filter and "unwatched" counts** (20–25 ms): they test JSON genres or the viewer's data for every title. A
  genre join table, or caching counts by the items version counter, would make them indexed.
- **Admin user list**: 83 statements for 80 users (one per user). Fast enough (3 ms) but easy to batch.
- **Server statistics** (70 ms): aggregates 30 days of play history in JavaScript; could be grouped in SQL.
- **Remux start** (~430 ms): ffmpeg's first segment has to be complete before the playlist lists it. A shorter first
  segment (`-hls_init_time`) would start remuxes sooner.
- **hls.js** (600 KB) loads when the stream info arrives; it could load in parallel with `POST /playback` on clients
  that will use it.
- Branding and settings are read and parsed from SQLite about 30 times per Home request (cheap, but avoidable with a
  cache invalidated on save).
