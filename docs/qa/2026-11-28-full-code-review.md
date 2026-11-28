# Vibe full codebase QA

28 November 2026. Scope: the complete product, including the server, web, shared code, mobile and TV clients, import/integration paths, storage, backups and deployment. Baseline: main `e8b3e2605deb1351d6573242abeee6a15d1a662f` plus the playback improvements in PR 70.

**The product is not cleared for an unrestricted release.** Shared-profile offline downloads and backup restore still have confirmed high-priority defects. The review also found and fixed streaming permission, SSO validation, archive parsing and NAS responsiveness defects on the review branch. Nothing was merged or deployed.

This was a risk-based review across the product, supported by existing suites, new negative tests, browser fault injection and synthetic load tests. It was not a line-by-line verification of every file, a measured line-coverage audit or certification of physical devices.

## Remaining findings

### P1 Mobile offline downloads are not isolated by account or profile

Source: [downloads.tsx](https://github.com/Bucifer6/MediaMax/blob/codex/proven-playback-improvements/apps/mobile/src/state/downloads.tsx), particularly the shared storage key at line 119, records created at line 403, and visibility and lookup at lines 593–600. [VideoPlayerScreen.tsx](https://github.com/Bucifer6/MediaMax/blob/codex/proven-playback-improvements/apps/mobile/src/player/VideoPlayerScreen.tsx) uses the returned local URI for offline playback.

Download records have a server ID but no owner/profile ID. Switching from an adult to a child profile on the same server leaves the adult's download visible and exposes its file URI. Switching servers hides it from the list, but `get(itemId)` still searches every record and returns the previous server's file. The shared offline sync queue can also send another profile's local viewing state using the new profile's credentials.

Reproduction used the actual React DownloadsProvider in Chromium with deterministic storage, session and native-filesystem adapters. After switching adult → child, the child still received `Adult private download` and its local URI. After switching server A → server B, the list became empty but lookup still returned that URI. This proves the JavaScript isolation defect; it does not claim a physical-device playback test.

Required remediation: scope metadata, media paths, transfer tasks, rules and progress queues by server plus authenticated user/profile; stop or isolate old tasks on switching; apply the same scope to every lookup and mutation; define safe treatment of existing ownerless downloads. This requires a coordinated mobile-state migration and native regression checks, rather than a list-filter-only patch. It remains open.

### P1 Backup restore can replace good data with invalid data or lose the current database on failure

Source: [backup.ts](https://github.com/Bucifer6/MediaMax/blob/codex/proven-playback-improvements/server/src/services/backup.ts), lines 72–89, and [bootstrap-restore.ts](https://github.com/Bucifer6/MediaMax/blob/codex/proven-playback-improvements/server/src/bootstrap-restore.ts), lines 17–22.

Staging checks that the manifest says format 1 and that a file named `mediamax.db` exists. It does not check SQLite integrity or the expected schema. A generated archive containing plain text under that filename was accepted with `restartRequired: true`.

At startup, restore removes the existing database and WAL files before renaming the replacement. In a disposable data folder, a valid generated backup plus an injected destination-rename failure produced `originalDatabaseSurvived: false`. The pending archive and staging folder are removed in the failure cleanup as well. A pre-restore backup is normally made, but recovery is not automatic and the active database has already been removed. Folder replacement has the same remove-before-replace pattern.

Required remediation: read-only SQLite integrity/schema validation before staging, a prepared replacement on the destination filesystem, rollback copies or a restore journal, and restart/crash/failure tests for the database and asset directories. This remains open; do not use restore on valuable data until it is corrected and recovery is exercised.

### P2 Search and home latency grow under concurrent use

The existing benchmark was run against isolated generated data: 20,000 movies, 2,000 shows, 60,521 episodes, 80 users, 3,000 channels and 200,401 programmes. All 15 measured scenarios returned HTTP 200 and there were zero transport errors.

| Scenario | Sequential median | 10 concurrent requests p95 | 50 concurrent requests p95 |
| --- | --- | --- | --- |
| Home | 169.5 ms | 2,331 ms | 2,265 ms |
| Title search | 144.8 ms | 1,464.6 ms | 7,084.5 ms |
| People search | 183.2 ms | 1,633.2 ms | 8,381.9 ms |
| Six-hour guide across 500 channels | 63.3 ms | 566.8 ms | 2,399.3 ms |

The slow-query log points to item LIKE searches, programme/channel joins and repeated rating/count queries. Investigate full-text search, query plans and reducing synchronous database work before targeting larger installations. These are measurements from one Windows workstation (Node 24.19.0, i7-10700F), not capacity guarantees or a before/after performance claim. The quick benchmark uses a time budget and stops some scenarios early; it is not a sustained soak test.

## Defects fixed on the review branch

| Area | Confirmed failure before the fix | Result |
| --- | --- | --- |
| Streaming permissions | An existing HLS session still answered remotely after remote access was disabled, and after its user's library access was revoked. Both HLS URL aliases were affected. | Every playlist and segment request checks the current remote, item and channel permissions before touching the session. |
| Session lifecycle | Another authenticated user could refresh an encoder's activity by requesting its URL even though the request was rejected. A direct-stream `session` query also refreshed unrelated sessions. | Ownership checks precede activity updates. Direct files only refresh the owner's matching media session. |
| NAS responsiveness | Admin folder browsing used synchronous directory/stat calls; library creation/editing synchronously checked share paths. | Those operations now use asynchronous disk access. Tests instrument the actual routes to refuse blocking calls on the share. |
| Archive reliability | A negative tar directory size made the parser revisit the same header indefinitely. Invalid octal and truncated payloads were accepted. | Sizes and available payload bounds are checked before advancing. A separate-process regression safely reproduced the original hang and now returns promptly. |
| SSO validation | Missing, nonnumeric and zero expiry values passed. UserInfo with a different subject replaced the ID-token identity. | Expiry must be finite and numeric; expired tokens and mismatched UserInfo identities are rejected. Valid same-subject sign-in remains successful. |

The SSO checks follow [OpenID Connect Core sections 3.1.3.7 and 5.3.2](https://openid.net/specs/openid-connect-core-1_0.html). These tests use a controlled provider response; they do not establish that an anonymous caller can forge a valid production provider exchange.

Nine new regression groups cover these changes. The earlier byte-range and HLS teardown fixes remain in the branch. A real hls.js/Chromium test played generated H.264/AAC HLS, sought to four seconds, injected a fatal network error, closed the player and verified that the queued retry did not restart it. There were no page errors in that test.

## Validation coverage

| Area | Checks and observed result |
| --- | --- |
| Server/API | Complete Windows suite after the implementation changes: 710 tests, 684 pass, 23 fail, 3 skip. All 23 failures also occur in the earlier unchanged-main baseline; timing-sensitive tests vary between runs. The later added direct-session test passes in the nine-test focused run. The final Linux CI result is recorded on PR 70. |
| Web/shared | Complete production build and TypeScript checks pass. All 147 web tests pass. Shared-copy synchronization produces no drift. |
| Web end to end | The repository's fresh-install smoke test passed twice across 66 pages, including setup, generated media, scanning, profiles, library/discovery/admin routes and starting a video. The final run uses the rebuilt fixes. |
| Mobile/TV React Native | Clean locked installation, native dependency patch application, full TypeScript check and all 98 pure tests pass. The account-switch diagnostic separately confirms the offline isolation failure above. |
| Roku | Clean locked installation, BrightScript validation and a 50-file Vibe.zip build pass. No sideload or physical-device playback was performed. |
| Samsung/LG/VIDAA wrappers | All three wrapper builds pass. Vendor signing, store submission and TV hardware are not exercised. |
| Dependency advisories | Root audit reports zero known vulnerabilities. Clean mobile and Roku installations also report zero. This is an advisory-database result, not proof that dependencies are defect-free. |
| Deployment scripts | Three Bash scripts pass syntax checks with Bash. Two PowerShell scripts pass parser checks. The initial restricted Bash invocation was unusable; the unrestricted syntax checks succeeded. No installer, release, production deployment or restore was run against the user's installation. |
| Security/data review | Examined authentication and profile boundaries, route authorization, current playback permissions, URL/redirect guarding, plugin/archive paths, backup replacement, download ownership, request quotas, WebSockets, shared data types, scan behavior and installer/update paths. Existing route-table auth, key restrictions, SSRF, PIN/2FA, import and lifecycle suites are part of the full server run. |

The Windows failures include Unix-specific filesystem fixtures and paths, unavailable fpcalc, local FFmpeg/HDR differences and existing integration assertions. They must remain visible as portability/support gaps. A green Linux pipeline does not resolve them.

Physical iOS/Android/TV devices, audio receivers, actual tuners, real NAS sleep/wake behavior, GPU encoders and external identity/integration providers still require their environments. Browser mocks validate application behavior under controlled conditions; they do not substitute for those devices. Accessibility and visual usability were not exhaustively audited.

## Release decision

Keep PR 70 unmerged for user review. The scoped fixes improve the product, but successful tests do not clear the open download-privacy and restore-safety findings. Resolve those two P1 findings and validate their migrations/recovery behavior before calling the whole product production-ready. Address the measured search bottleneck according to the intended installation size.
