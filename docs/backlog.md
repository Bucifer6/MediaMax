# Backlog

Noticed but deliberately not done. Severity: High / Medium / Low.

- Medium — AutoSync alignment runs on the request thread (~0.3–0.6 s per film); move it to `server/src/threadpool.ts` if several viewers use it at once.
- Medium — `server/test/livetv-followups.test.ts` hangs on Windows (also on main); find the open handle.
- Low — AniSkip for anime without a MAL id in the NFO needs an id mapping (TMDB/TVDB → MAL); arm.haglund.dev was unreachable when tried.
- Low — Mobile player: AutoSync and admin "Mark segment" are web-only for now (the server endpoints are client-neutral).
- Low — Web: libass (ASS) only takes AutoSync's constant offset; rate / group fixes need the text renderer.
- Low — Web: the HDR comfort colour doesn't reach libass (ASS drawn with the file's own styles).
- Low — Parental guide URL: block private / LAN addresses (admin-set today, so admin-trusted).
