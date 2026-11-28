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
