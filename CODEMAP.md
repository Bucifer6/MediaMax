# Code map: Vibe (MediaMax)
Updated: 2026-11-28 (branch claude/phase1-subtitles-skip)

## What this is
Vibe is a self-hosted media server (movies, TV, live TV/IPTV, DVR, music, audiobooks, podcasts) plus white-label clients:
a React web/TV app and an Expo (React Native) phone/TV app. Node 22.5+ / Fastify / SQLite on the server; one repo,
npm workspaces (`shared`, `server`, `web`) plus the separate `apps/mobile` project.

This map is new and only covers the areas changed so far in detail; other areas are listed by folder with a one-line
summary until they are touched (open question: which areas matter most to map next).

## How it fits together
```
client (web/, apps/mobile/, tv/)
  → HTTP /api/v1/... (server/src/routes/*.ts: requireUser/requireAdmin + assertCanSee per item)
    → services (server/src/services/*.ts) → SQLite (server/src/db.ts, migrations inline)
  ← WebSocket events (services/events.ts → routes/ws.ts)
outside services: TMDB + built-in metadata providers (services/metadata/http.ts: one fetch with cache, rate limits,
  base-URL overrides for tests), IntroDB / AniSkip (services/skipSegments.ts), Trakt, OpenSubtitles, Last.fm …
```
Shared API contract: `shared/src/types.ts` (interfaces are extended by declaration merging further down the file).

## Run and test
- Install: `npm ci` (root) and `npm ci` in `apps/mobile`.
- Build: `npm run build` (shared → server → web). The server type-checks against `shared/dist`, so rebuild shared after editing types.
- Copies of shared code: `node scripts/sync-types.mjs` (CI fails if they drift).
- Server tests: `npm test` (all) · one file: `cd server && node --import tsx --import ./test/setup.ts --test test/<name>.test.ts`.
- Web tests: `npm test -w web` · Mobile: `cd apps/mobile && npx tsc --noEmit && npm test`.

## Areas
### Shared contract (`shared/src/`)
- Does: API types; pure code copied verbatim into the other projects.
- Key files: `types.ts` (API contract), `playerPrefs.ts` (track choice, auto-skip, SDH/RTL clean-up, HDR colours, AutoSync map),
  `lrc.ts`, `stems/`.
- Watch out: edit only the `shared/src` copy; `scripts/sync-types.mjs` writes `server/src/services/playerPrefs.ts`,
  `web/src/player/playerPrefs.ts`, `apps/mobile/src/player/playerPrefs.ts` and `apps/mobile/src/api/types.ts`.

### Preferences & users (`server/src/services/auth.ts`)
- Does: users, sessions, per-profile `UserPreferences` (`mergePrefs` validates and merges every PATCH /me).
- Watch out: `normalizeSubtitleStyle` — preset fields come from fixed lists, free-form fields (scale, colours, outline …) are
  clamped; a free-form field sent as `null` is cleared. Language prefs are only checked when they change, so old stored values survive.

### Playback (`server/src/services/playback.ts`)
- Does: playback decision (direct / remux / transcode), sessions, `PlaybackInfo`.
- Uses: `playerPrefs.pickAudio` (primary, secondary, 'original' via `items.originalLanguageOf`), `skipSegments.markersForPlayback`.
- Watch out: the plan cache key includes the audio-language prefs; add any new decision input to it.

### Skip segments & parental guide (`server/src/services/skipSegments.ts`)
- Does: IntroDB / AniSkip lookups merged under local markers; admin marker submission (+ IntroDB upload); parental guide card data.
- Owns data: writes `items.markers` only on an admin submission (`source: 'user'`); crowd answers live in `metadata_cache`.
- Side effects: outbound HTTP to api.introdb.app / api.aniskip.com / the admin's guide URL, only when enabled in `ServerSettings.skipSegments`.
- Watch out: IntroDB wants the **series** IMDb id for episodes; AniSkip needs a MAL id (NFO `<uniqueid type="mal">`).

### Subtitles (`server/src/services/subtitles.ts`, `autosync.ts`, `subtitleProviders/`)
- Does: extraction/conversion and serving of tracks; online search/download; AutoSync (`autosync.ts`, pure alignment + route glue).
- Watch out: AutoSync runs on the request thread (~0.3–0.6 s for a film); see docs/backlog.md.

### Web player (`web/src/player/`)
- Key files: `VideoPlayer.tsx` (the player), `subtitles/SubtitleOverlay.tsx` + `textRenderer.ts` (our own subtitle renderer),
  `subtitles/prepare.ts` (SDH + AutoSync map applied to parsed cues), `SegmentTools.tsx` (parental guide card, admin segment marking),
  `subtitleStyle.ts` (style presets / preview).
- Watch out: libass (ASS via WASM) only takes a constant offset, so AutoSync's rate/group fixes apply in text mode only.

### Mobile/TV app (`apps/mobile/`)
- Key files: `src/player/VideoPlayerScreen.tsx` (player, own VTT overlay), `app/settings/playback.tsx`, `src/components/MediaCard.tsx`.
- Watch out: separate npm project; types come from the synced `src/api/types.ts`.

### Other areas (not yet mapped in detail)
`server/src/services/`: livetv/, dvr.ts, music/, dj/, ai/, arr/, metadata/, plugins.ts, trakt.ts, syncplay.ts, smarthome/ …
`web/src/`: admin/, pages/, components/, tv/ · `plugins/` (SDK + examples) · `tv/` (Tizen/webOS packaging) · `docker/`, `packaging/`.

## Change -> retest
| If you change... | Also check... | Tests to run |
|---|---|---|
| `shared/src/playerPrefs.ts` | run sync-types; web + mobile players' track choice and skip | `server/test/playback-prefs.test.ts`, web + mobile test suites |
| `UserPreferences` / `SubtitleStyle` fields | `auth.ts mergePrefs` / `normalizeSubtitleStyle`, web Settings, mobile settings | `playback-prefs.test.ts`, `home-layout.test.ts` |
| `ServerSettings` sections | `settings.ts` getSettings/updateSettings/publicSettings (masking) | `playback-prefs.test.ts`, `qa-api.test.ts` |
| playback start (`startPlayback`) | markers, track choice, warm-up | `qa-playback.test.ts`, `instant-play.test.ts` |

## Shared things
- Env overrides for outside services: `MEDIAMAX_<SERVICE>_API_BASE` (e.g. `MEDIAMAX_INTRODB_API_BASE`, `MEDIAMAX_ANISKIP_API_BASE`).
- Write-only secrets: `settings.ts SECRET_FIELDS` + `SECRET_MASK` ('••••'): a masked value sent back keeps the stored one.
- Errors: `server/src/util/errors.ts` (`HttpError`, `badRequest`, `forbidden`, `notFound`).
