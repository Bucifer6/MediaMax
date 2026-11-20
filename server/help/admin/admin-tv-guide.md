---
title: TV guide sources and channel matching
summary: Add guide (EPG) sources and match your channels to them.
section: admin
audience: admin
keywords: tv guide, epg, xmltv, schedules direct, hdhomerun guide, iptv-org, epg.pw, matching, channel matching, time shift, time zone, missing guide, suggestions
related: admin-live-tv, live-tv-problems, live-tv
order: 9
---

**Admin → TV guide** has two tabs: **Guide sources** and **Guide matching**.

## Guide sources

| Kind | Notes |
|---|---|
| **XMLTV URL** or **file** | Any XMLTV guide (gzip and xz are detected). Files need an absolute path on the server. |
| **Community preset** | Free guides from iptv-org and epg.pw by country. Volunteer-run, so availability varies. |
| **Schedules Direct** | Accurate US/Canada listings and more (about $35 a year). Add lineups by country and postcode. |
| **HDHomeRun** | SiliconDust's guide for your tuner, free for owners. |
| **Provider guide** | Your IPTV provider's own guide, or a TVHeadend or Enigma2 receiver's guide. Created automatically. |

Each channel takes its programmes from the highest-priority guide that has data for it; lower guides fill gaps. A guide can apply to all live sources or only some. A guide that fails to download keeps its previous data, so the guide never goes empty; the error shows on its card.

## Guide matching

Matching runs after every guide refresh. Matches at 80 % confidence or more are applied automatically; those from 50 % to 80 % wait as suggestions.

- Filter by **unmatched**, **low confidence** or **missing guide**.
- **Accept all suggestions** when they look right.
- Open a channel to search every guide's channel list, preview now/next, set a **time shift** (±hours), mark **No guide**, or go back to automatic.

Manual choices survive refreshes.

## Times are wrong

- A whole guide is off by hours: set a time-zone override on the guide (for example `Europe/London`).
- One channel is off (for example a "+1" channel): set a time shift for that channel in the matching editor.
