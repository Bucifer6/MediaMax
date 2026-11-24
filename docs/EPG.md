# TV guide (EPG) providers

Vibe gets programme guides from **guide sources** and matches each live channel to a channel in one of them. Manage both under **Admin → TV guide**. The API is in [API.md](API.md#tv-guide-epg-providers).

## Guide sources

| Kind | What it is | Cost | Notes |
|---|---|---|---|
| XMLTV URL | Any XMLTV guide on the web | depends | gzip and xz are detected from the file contents. xz needs the `xz` tool, which the Docker image and most Linux systems have. |
| XMLTV file | A guide file on the server, e.g. one written by a grabber such as `tv_grab_*` or iptv-org/epg | free | Use an absolute path. |
| Community preset | iptv-org (`iptv-org.github.io/epg/guides/...`) and epg.pw (`epg.pw/xmltv/epg_<CC>.xml`) by country | free | Volunteer-run; availability varies. You can paste any URL instead. |
| Schedules Direct | `json.schedulesdirect.org/20141201` JSON API | about $35/year | Accurate US/Canada listings and more. Lineups are added by country + postcode. |
| HDHomeRun | SiliconDust's guide for your tuner (`api.hdhomerun.com/api/guide.php`) | free for owners | Uses the `DeviceAuth` from the tuner's `discover.json`. Matched by guide number. |
| Provider guide | Your IPTV provider's own guide (Xtream `xmltv.php`, M3U `url-tvg`), or the device EPG of a TVHeadend server (`/api/epg/events/grid`) or Enigma2 receiver (OpenWebif `/api/epgmulti`) | — | Created automatically, lowest priority (0). Tuner guides are keyed by the channel's own id (TVHeadend channel UUID, Enigma2 service reference), so matches are exact. See [TUNERS.md](TUNERS.md). |
| Live source EPG URL | URLs typed into a live source's *EPG URL* field | — | Each becomes a guide for that source only, priority 100. Edit them on the source. |

A guide can apply to **all** live sources or only to the ones you select.

### Priority and merging

Each channel takes its programmes from the highest-priority guide that matches it and has data. Lower guides fill the gaps. A manual match always wins. Downloads are staged and swapped in only when they succeed, so **a broken guide keeps its previous data and never empties the EPG**. The failure shows on the guide's card.

### Refresh schedule

Guides tied to a live source refresh with it. Other guides refresh on their own interval (default 12 h; HDHomeRun 4 h) from the *Refresh Live TV & IPTV* scheduled task (every 30 min it refreshes whatever is due). Any guide can be refreshed by hand. A Schedules Direct guide can be refreshed by hand at most once every 15 minutes.

### Schedules Direct rules

Vibe follows the documented client rules:

- **One token per 24 h.** The token is cached and only renewed when it is 23 h old or the server reports it expired (code 4006).
- **md5 checks.** `POST /schedules/md5` runs first. Only station-days whose md5 changed are downloaded with `POST /schedules`, and only programmes whose md5 changed with `POST /programs`.
- **Batching.** At most 5000 stations or programme ids per request (artwork: 500).
- **Requests run one at a time**, with a descriptive `User-Agent`.
- Lineups are re-downloaded only when their `modified` stamp changes.
- The minimum refresh interval is 12 h.
- Only the SHA1 of the password is stored, which is what `/token` takes.
- **Artwork (optional).** Only absolute image URLs are used, because SD's own `/image/` endpoint needs the token.

## Matching

Automatic matching runs after every guide refresh and channel sync:

1. **Exact tvg-id / Xtream `epg_channel_id`** equal to a guide channel id (confidence 100%).
2. **Guide number**, for HDHomeRun channels (99%).
3. **Callsign**, e.g. `WABC-DT` ↔ `WABC` (96%).
4. **Normalised name.** These are stripped before comparing:
   - country prefixes such as `UK:`, `US|`, `[DE]`, `|UK|`
   - quality tags such as HD, FHD, UHD, 4K, HEVC, ᴴᴰ
   - `+1`
   - punctuation and case

   Number words become digits ("One" → 1), and ids like `BBCOne.uk@HD` are split up. An exact name match scores 95%.
5. **Fuzzy similarity**: token overlap, trigram Dice and Jaro-Winkler. It is penalised when channel numbers differ ("BBC One" vs "BBC Two"), when countries differ, and when there is a near-tie ("Sky Sports" vs two Sky Sports channels).

Matches at **80%** or more are applied. Those from **50%** to 80% wait on the **Guide matching** page as suggestions. A `+1` channel matched to its base channel gets a one-hour shift.

On the matching page:

- **Filters:** all, unmatched, low confidence (suggestions and auto matches under 90%), and missing guide (no programmes from now on).
- **Accept all suggestions.**
- **Per-channel editor:** search across every guide's channel list, preview now/next with the chosen mapping and shift, set a time shift (±hours), mark "No guide", or go back to automatic.

Manual choices are stored with the channel and survive refreshes.

### Time zones

- **Per-channel shift:** from the matching editor.
- **Per-guide time-zone override (XMLTV):** the offsets written in the file are ignored and its times are read as local times in that zone (`Europe/London`, `America/New_York`, `+01:00`…).

### Measured accuracy

The test set in `server/test/fixtures/epg-match-set.ts` has 44 real-world IPTV names against an iptv-org style guide:

- 36 of 38 expected matches are applied automatically.
- One is queued as a correct suggestion ("Al Jazeera Eng").
- One is missed ("Nat Geo HD", an abbreviation).
- There are **no wrong automatic matches**.
- All 6 channels that should stay unmatched do.

## Guide quality

Each guide card shows:

- guide channels
- your channels using the guide
- programmes stored
- days of data ahead
- last refresh time and duration
- errors and warnings, such as one URL of a multi-URL guide failing

Admin → Channels marks channels with no guide data with a **Missing guide** badge.

## Testing without the real services

`server/test/epg.test.ts` runs the whole pipeline against mock servers that follow the published APIs:

- the Schedules Direct `token`, `status`, `headends`, `lineups`, `schedules/md5`, `schedules`, `programs` and `metadata/programs` calls
- the HDHomeRun `discover.json`, `lineup.json` and `guide.php` calls
- gzip and xz XMLTV

`KINORA_SD_URL` and `KINORA_HDHR_GUIDE_URL` point Vibe at other endpoints, for example a mock or a mirror.
