---
title: Live TV won't play
summary: Channels that don't start, freeze, show "Channel unavailable" or have no guide.
section: troubleshooting
audience: everyone
keywords: live tv, channel unavailable, not playing, black screen, freezing, iptv, xtream, connections, guide missing, no information, epg, tuner, retry as hls
related: live-tv, admin-live-tv, admin-tv-guide
order: 8
---

## For everyone

- **"Channel unavailable"**: the channel may be off air, or the provider may be having problems. Try another channel; if none work, tell your admin.
- **Retry as HLS**: if a channel fails, the error offers **Retry as HLS**, which asks the server to repackage the stream. This often fixes channels that freeze or show a black picture in a browser.
- **Freezes after a while**: usually the connection to the provider. Try again in a moment.
- **Too many people watching**: IPTV providers and tuners allow a limited number of streams at once. If others are watching, a new channel may not start until someone stops. Multiview uses one connection per tile.
- **No guide information**: the channel isn't matched to a guide yet. Your admin can fix this.

## For admins

1. **Test the source.** **Admin → Live TV sources**: edit the source and press **Test** (Xtream shows the account status and expiry). Expired accounts are the most common cause.
2. **Check connection limits.** Set the provider's maximum connections on the source so {{product}} warns before exceeding it.
3. **Refresh now** on the source if channels changed.
4. **Read the log.** **Admin → Activity & logs → Server log** shows the provider's error (for example HTTP 403 or 509).
5. **Missing guide**: **Admin → TV guide → Guide matching**, filter by *unmatched* or *missing guide*. **Admin → Channels** marks channels with a *Missing guide* badge.
6. **Tuners in Docker**: HDHomeRun and SAT>IP discovery needs host networking, or add the tuner by its address.
