# Roadmap

This is a gap analysis against Plex/Plexamp, Jellyfin, Emby and the specialist apps people pair with them:
Channels DVR, TiviMate, Audiobookshelf, Navidrome, Infuse and Kodi. It was researched in November 2026.
**✅ = done**, ⏳ = in progress, the rest are planned. Size: S = days, M = 1–3 weeks, L = a month or more.

## Must-have before launch
1. ⏳ **Better native playback.** Use an mpv/VLCKit-class engine in the apps, *or* add a Jellyfin-compatible API so Infuse, Swiftfin
   and Kodi can connect. Add frame-rate/range matching and Dolby Vision profile awareness on TV apps. (L)
2. ✅ (UPnP + status; relay later) **Easy remote access**: UPnP/NAT-PMP port mapping, a reachability status and HTTPS guidance. A relay can follow. (S→L)
3. ✅ (Fire TV profile, Tizen + webOS wrappers, web TV mode; Roku later) **Smart-TV reach**: a Fire TV store build, then Samsung Tizen and LG webOS apps built from the web app. Roku comes later. (M–L)
4. ✅ (API) **Subsonic/OpenSubsonic API** so Symfonium, Feishin, Sonos and similar apps work. Plus gapless playback and loudness levelling. (M)
5. ✅ (built; needs device testing + Apple entitlement) **CarPlay & Android Auto**, with offline downloads playable in the car, audiobook/podcast controls, voice search and an in-app car mode. (M)
6. ✅ **Backup & restore** of the database, settings, branding and plugins. (S)
7. ✅ **DVR robustness**: ✅ priorities and tuner-conflict detection, ✅ day/time-slot rules, ✅ repeat skipping,
   ✅ commercial detection (comskip/EDL). Plus ✅ **IPTV multiview** (web; apps next). (M)
8. ⏳ (✅ AniList, ✅ MusicBrainz/Cover Art Archive, ✅ OMDb/IMDb plugins) **Metadata breadth**: TVDB episode orderings, anime (AniList/AniDB), music (MusicBrainz, TheAudioDB, fanart.tv), RT/IMDb
   ratings. Ship these as metadata-provider plugins. (M)
9. ⏳ **Audiobook basics**: sleep timer, ✅ bookmarks, ✅ series, Audnexus metadata, per-book speed. (S/M)
10. ✅ **Security & sharing**: TOTP two-factor, invite links, per-user stream/remote/transcode limits, API keys for integrations. (S)

## By area
**Playback & video:** HEVC/AV1 transcode output and multichannel passthrough · per-user and remote bandwidth caps ·
✅ remote control of other clients ("play on TV") · cinema mode (pre-rolls, trailers) · ✅ local extras (trailers, featurettes) ·
✅ user-visible movie editions · subtitle/audio sync offset · ✅ commercial/preview segment types · client-side ASS/PGS rendering.

**Music:** gapless · ReplayGain/loudness · crossfade · artist/album/track radio and mixes, later sonic similarity · music videos ·
public share links · bulk offline sync of albums and playlists · headless player.

**Live TV / DVR / IPTV:** ✅ multiview (web) · ✅ comskip markers · ✅ multiple EPG sources per playlist and a fuzzy EPG mapping UI · virtual
channels built from the library · post-processing (convert) · Schedules Direct · last-channel recall, number entry, mini guide,
reminders, channel PIN lock.

**Audiobooks & podcasts:** sleep timer, bookmarks with notes · series and order · Audnexus · chapter editor, merge to .m4b ·
smart rewind · podcast retention rules · Podcasting 2.0 chapters and transcripts · ebooks/comics (L).

**Library & metadata:** labels and richer filters/sorts (codec, HDR, audio language) · photo timeline, map, memories ·
person/studio pages · fix-match UI and merge/split versions · theme songs and backdrop videos.

**Users & sharing:** invite links · TOTP and passkeys · LDAP (plugin) · per-user concurrent stream limits · watchlist.

**Clients:** Fire TV, Tizen, webOS, Roku, Xbox · desktop app with mpv · home-screen widgets, Siri/Shortcuts, dynamic Top Shelf ·
Sonos/Alexa · Vision Pro.

**Admin:** backup/restore · Prometheus metrics · storage maintenance (auto-delete watched recordings and podcasts) ·
database optimise · notification agents (Discord ✅ via plugin; Telegram, email and push next).

**Integrations:** API keys · \*arr "Connect" rescans and Bazarr · Simkl/AniList scrobbling · Discord rich presence.

## Where Vibe is weaker today (honest list)
- **DVR rules** are title-substring only. There are no priorities, conflicts or comskip.
- **Transcode output** is H.264/AAC only. Dolby Vision is folded into a single HDR flag.
- **PGS subtitles** can only be burned in, and ASS is flattened to WebVTT.
- **Downloads** are one item at a time, on phones only.
- **SyncPlay** has no buffering wait or drift correction.
- **Audiobooks** lack a sleep timer, bookmarks and series. **Music** lacks gapless, crossfade and loudness.
- **Metadata** comes from TMDB only (plugins can now add more).
- **DLNA** is serve-only.
