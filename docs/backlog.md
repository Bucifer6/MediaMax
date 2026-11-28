# Backlog

Noticed but deliberately not done. Severity: High / Medium / Low.

- Medium — AutoSync alignment runs on the request thread (~0.3–0.6 s per film); move it to `server/src/threadpool.ts` if several viewers use it at once.
- Medium — `server/test/livetv-followups.test.ts` hangs on Windows (also on main); find the open handle.
- Low — AniSkip for anime without a MAL id in the NFO needs an id mapping (TMDB/TVDB → MAL); arm.haglund.dev was unreachable when tried.
- Low — Mobile player: AutoSync and admin "Mark segment" are web-only for now (the server endpoints are client-neutral).
- Low — Web: libass (ASS) only takes AutoSync's constant offset; rate / group fixes need the text renderer.
- Low — Web: the HDR comfort colour doesn't reach libass (ASS drawn with the file's own styles).
- Low — Parental guide URL and rating-poster template: block private / LAN addresses (admin-set today, so admin-trusted).
- Medium — Trakt custom lists and MDBList two-way watchlist sync are not imported yet (watchlist, history, ratings and resume points are).
- Low — Mobile: studio logos and rating posters are web-only for now (the API serves them to every client).
- Low — MDBList list rows show nothing on the very first Home load after a restart (the list loads in the background).
- Low — `server/test/date-added.test.ts:66` is flaky: `path LIKE '%S01E01.mkv'` matches two shows' episodes, so either row can come back (pre-existing).
- Low — Trakt and SIMKL share near-identical sign-in polling, status and pull-all code, and three copies of "item → outside ids"; fold into tracking.ts when a third service arrives.
- Low — After a Trakt / SIMKL sync, open apps don't get `userdata.updated` events (they refresh on the next load); a 50k-episode first sync runs as one blocking transaction.
- Low — Mobile: SIMKL connect is web-only for now.
