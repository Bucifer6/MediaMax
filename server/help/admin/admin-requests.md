---
title: Requests, *arr apps, Downloads and notifications
summary: Connect Radarr, Sonarr, Lidarr and Readarr, set request quotas and approval, follow downloads and send notifications.
section: admin
audience: admin
keywords: requests, radarr, sonarr, lidarr, readarr, bazarr, arr, media automation, quota, auto-approve, downloads, queue, calendar, wanted, notifications, discord, slack, telegram, ntfy, gotify, pushover, email, smtp, webhook, overseerr, jellyseerr, blacklist
related: requesting, admin-users, problem-with-a-title
order: 11
---

## 1. Connect your *arr apps

**Admin → Server settings → Media automation (*arr)**: add Radarr (movies), Sonarr (shows), Lidarr (music), Readarr (books) or Bazarr (subtitles) with its URL and API key, then pick the quality profile and root folder. Mark a second Radarr or Sonarr as **4K** for 4K requests. Path mappings translate the *arr's paths to the paths {{product}} sees.

{{product}} gives each *arr a webhook so finished downloads are imported and scanned straight away.

## 2. Turn on requests

**Admin → Server settings → Requests**:

- **Enable requests** (the Discover feature must also be on in **Branding studio → Features**).
- **Default quota**: how many requests per type over how many days, for users without their own quota.
- **Request managers have no quota**, **No quota for auto-approved kinds**.
- **Auto-approve highly rated titles**: approve movie and show requests rated at least this on TMDB.
- **Hide titles already in the library on Discover by default**.

Movies and shows need a TMDB API key. Who may request what, and whose requests are approved automatically, is set per user in **Admin → Users** (see [Users and permissions](help:admin-users)).

## 3. Handle requests

The **Requests** page lists everyone's requests. **Approve** or **Decline** (with a reason), change seasons or **Custom download settings**, use bulk actions, and manage the blacklist. Users with **Manage requests** can do this without being admins. The **Issues** page has the problems people reported.

## Downloads dashboard

**Admin → Downloads** shows each *arr's health, and tabs for the **Queue** (refreshed every 10 seconds), **Calendar** and **Wanted**.

## Notifications

**Admin → Server settings → Notifications**: add Discord, Slack, Telegram, ntfy, Gotify, Pushover, Email (SMTP) or a JSON webhook, and choose the events: new request, approved, declined, available, failed, comments, new issue, resolved and so on. Users also get notifications in the bell at the top of the screen.
