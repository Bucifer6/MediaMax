# Decisions

One line per decision: date — decision — why — who decided.

- 2026-11-28 — Deliver the Nuvio gap plan as one branch + PR per phase against Bucifer6/MediaMax — CI checks each phase on its own — owner.
- 2026-11-28 — IntroDB and AniSkip lookups are off until the admin turns them on — PRIVACY.md promises outside services only with the server owner's consent — Claude.
- 2026-11-28 — Saving segment timestamps ("Submit intro") and sending them to IntroDB is admin-only — it changes markers for everyone and uses the server's key, same as editing metadata — Claude.
- 2026-11-28 — Parental guide severities come from an admin-set URL template (default off); the card shows the content rating alone otherwise — the source Nuvio uses is an unknown third party and imdbapi.dev did not resolve — Claude.
- 2026-11-28 — AniSkip only for titles with a MyAnimeList id (NFO) — the id-mapping service (arm.haglund.dev) was unreachable; no extra outside service added — Claude.
- 2026-11-28 — Crowd segments never replace local markers; one marker per type, local → IntroDB → AniSkip — local detection matches the actual file — Claude.
- 2026-11-28 — Playback waits at most 1.2 s for crowd segments — never hold a stream up for an optional feature — Claude.
- 2026-11-28 — AutoSync returns a time map applied by the players (nothing saved) — no stream restart, works on every client, easy to undo — Claude.
- 2026-11-28 — `skipIntros` stays; `autoSkip` keys override it per segment, credits default off — older apps keep working — Claude.
- 2026-11-28 — "Original" audio uses TMDB `original_language` stored in `items.extra` (no schema change); unknown → the file's default track — Claude.
- 2026-11-28 — Phase PRs are stacked: each targets the previous phase's branch until that one merges — keeps each PR's diff to its own phase — Claude.
- 2026-11-28 — Trakt / SIMKL imports only add (watched, resume, My List, rating where unset) and never echo back — a sync can never lose or duplicate someone's data — Claude.
- 2026-11-28 — MDBList list rows are admin Home rows (Branding), not per-profile pins — same model as every other Home row; viewers can still hide them in Customize Home — Claude.
- 2026-11-28 — Rating posters are proxied through the server's image cache — the poster service's key would otherwise be visible to every viewer — Claude.
- 2026-11-28 — Episode ratings: IMDb via OMDb when the admin enabled OMDb, else TMDB — no new outside service; IMDb has no public API — Claude.
- 2026-11-28 — Trakt pull and push are separate opt-in switches, off for existing and new accounts; SIMKL sync is on once a viewer connects (connecting SIMKL is asking for sync) — PRIVACY.md consent wording — Claude.
- 2026-11-28 — Mobile adds expo-brightness and expo-screen-orientation (first-party Expo) for the brightness swipe and rotation lock; volume uses the player's own volume (no extra package) — Claude.
- 2026-11-28 — Picture mode is per device (localStorage on web), not a profile preference — a TV and a laptop want different ones — Claude.
- 2026-11-28 — Watch-together drift is corrected with a ±5 % rate change, seeking only beyond 2.5 s — invisible to viewers, no rebuffering — Claude.
- 2026-11-28 — External players get subtitle files (MX / Just Player / mpv "subs" extras, VLC "subtitles_location"); skip markers are not sent — no common intent extra exists for them — Claude.
