# Vibe playback comparison and improvements

Reviewed on 28 November 2026 against MediaMax `main` at `fb03052fe125039d4ea48c7dc68a9783ef034880` (v0.6.10), then rebased onto `e8b3e2605deb1351d6573242abeee6a15d1a662f` (v0.6.11) after main advanced. The useful next step is to strengthen the existing playback system with precise HTTP behavior and reliable player cleanup. Replacing the playback architecture would discard substantial existing capability without evidence of a benefit.

## Repository state and naming

`Bucifer6/MediaMax` is public and MIT licensed. [The README](../README.md) explicitly records the sequence MediaMax → Kinora → Vibe. Vibe is the current product name, not another repository, branch or isolated component. Package names and compatibility interfaces retain the older names.

The existing local checkout was clean on `codex/kinora-ui-redesign` at `12cedc5`. It was not a current baseline: its remote main was still `19ab679`. After fetching, this work started on `codex/proven-playback-improvements` from `fb03052`. The redesign branch remains available. [Live TV PR 68](https://github.com/Bucifer6/MediaMax/pull/68) was open at the start and was merged independently during this work; this branch was then rebased onto its resulting main commit. This PR adds no tuner, surfing, hero or UI redesign changes and is left unmerged.

## Source comparisons

These are comparisons of specific source paths, not claims that the complete upstream products have been audited or benchmarked.

| Upstream source | Vibe source and finding | Reuse decision |
| --- | --- | --- |
| [Jellyfin StreamBuilder](https://github.com/jellyfin/jellyfin/blob/51a3e2d462f9417ab9302b07e220b3eceb503143/MediaBrowser.Model/Dlna/StreamBuilder.cs) separates direct play, direct stream and transcoding; evaluates codec/profile constraints; records failure reasons; ranks sources. | `server/src/services/playback.ts:decide` already separates direct/remux/transcode and returns reasons. `audio.ts`, `hdr.ts`, `dovi.ts` and `abr.ts` refine audio, range and bandwidth decisions. | Keep this architecture. A future improvement is structured reason identifiers and container-specific profile rules, with a device/media fixture matrix. Do not port the GPL implementation into MIT files. |
| [Kodi HttpRangeUtils](https://github.com/xbmc/xbmc/blob/1eae04d85d47de716ceef007d2e0531469f6df37/xbmc/utils/HttpRangeUtils.cpp) parses the range unit and positions explicitly and provides multipart response helpers. | `server/src/routes/playback.ts:sendFileRange` used an unanchored expression that accepted garbage around a range and silently selected the first range in a multipart request. | Implement full-header validation independently. Support one range; ignore multipart requests in their entirety until multipart responses are implemented. Kodi is a reference for explicit parsing, not a source to copy verbatim or assume bug-free. |
| [Navidrome stream handler](https://github.com/navidrome/navidrome/blob/42c7046e9f77b5ef089a0dddba24c9f05d4db4e6/server/subsonic/stream.go) delegates decisions and closes streams; [media_streamer.go](https://github.com/navidrome/navidrome/blob/42c7046e9f77b5ef089a0dddba24c9f05d4db4e6/core/stream/media_streamer.go) delegates seekable HTTP serving to Go's `http.ServeContent`. [decider.go](https://github.com/navidrome/navidrome/blob/42c7046e9f77b5ef089a0dddba24c9f05d4db4e6/core/stream/decider.go) checks bitrate before direct-play profiles. | Vibe also has separate routes, decisions and encoder jobs, but owns its HTTP range implementation. Its shared file helper serves direct media, downloads and other cached media. | Bring HTTP semantics up to an explicit tested contract. Preserve Vibe's existing streaming and transcoding separation. |
| [hls.js ErrorController](https://github.com/video-dev/hls.js/blob/c4637e53bbd4d1d0838d5b1e954ab1fc7af355bb/src/controller/error-controller.ts) manages request retries, alternate levels and fatal stopping; destruction unregisters listeners. | `web/src/player/engine.ts` already uses hls.js and bounded application recovery, but its delayed `startLoad()` survived `destroy()`. Repeated fatal events could queue several retries. The installed client is hls.js 1.7.4; upstream head is an architectural reference, not a version upgrade. | Retain the dependency and existing retry budget. Add explicit ownership and cancellation for the application's retry timer. |
| [FFmpeg HLS muxer](https://github.com/FFmpeg/FFmpeg/blob/b34f7f33f3ff4f1794cdacc9edaecc7979a3ca16/libavformat/hlsenc.c) implements temporary-file publication and independent-segment flags. | `server/src/services/transcoder.ts:buildArgs` already uses `independent_segments+temp_file` for VOD and forces time-based segment keyframes. `abr.ts` starts renditions lazily at aligned segments. | Keep using the mature muxer instead of writing segment muxing code. Validate hardware and real-client switching before changing codec or timestamp behavior. |

Vibe's scanner already skips probes when size/mtime and probe state match, and limits concurrent probing with a pool. It is not necessary to add these patterns again. This comparison concentrated on playback and delivery; it does not establish scanner parity with all three projects.

## Implemented behavior

`server/src/util/byteRange.ts` now distinguishes a supported range, an unsatisfiable range and an ignored header. It handles suffixes, open ends and very large decimal values without unsafe numeric conversion. File responses reject directories, publish `Last-Modified`, respect date-based `If-Range`, ignore `Range` for HEAD, and avoid opening a file stream for HEAD. ETag validators fall back to the complete representation because this helper does not issue ETags. Multipart and malformed headers receive a complete 200 response; valid ranges outside the representation receive 416. These choices follow [HTTP Semantics sections 13 and 14](https://www.rfc-editor.org/rfc/rfc9110.html).

For example, `bytes=0-1,4-5` previously returned only bytes 0–1 with 206; it now returns the complete representation with 200. A stale `If-Range` previously still returned partial content; it now returns the complete file. Large valid bounds are clamped before conversion to JavaScript file offsets.

`web/src/player/hlsRecovery.ts` owns the application retry timer. Destroying a player or reaching a terminal error cancels it, duplicate network failures share the pending retry, and terminal callbacks fire once. The existing shared recovery budget and 1/2/3-second network delays remain bounded. No source or dependency upgrade is included.

## Licenses and source provenance

| Project or dependency | License and compatibility decision |
| --- | --- |
| Vibe | [MIT](../LICENSE). All new implementation and tests are independently written under this existing license. No upstream source was copied or translated. |
| Jellyfin server | [GPL v2 text](https://github.com/jellyfin/jellyfin/blob/51a3e2d462f9417ab9302b07e220b3eceb503143/LICENSE). Reuse architectural ideas; importing covered source would require applicable GPL distribution terms rather than an MIT-only claim. |
| Kodi range implementation | Its file header states GPL-2.0-or-later. Same restriction on importing source. |
| Navidrome | [GPL v3 text](https://github.com/navidrome/navidrome/blob/42c7046e9f77b5ef089a0dddba24c9f05d4db4e6/LICENSE). Keep it as an architectural reference, without incorporating its implementation. |
| hls.js | [Apache-2.0](https://github.com/video-dev/hls.js/blob/c4637e53bbd4d1d0838d5b1e954ab1fc7af355bb/LICENSE). Existing dependency can coexist with MIT application code; distributed dependency code retains its license and applicable notices. |
| FFmpeg | [LGPL-2.1-or-later by default; optional GPL components change the build's license](https://ffmpeg.org/legal.html). Vibe invokes the executable separately. Binary distribution still requires compliance for the actual build. No FFmpeg code or binaries are added here. |
| Existing Android decoder | `apps/mobile/modules/mediamax-media/android/build.gradle` includes `org.jellyfin.media3:media3-ffmpeg-decoder:1.9.0+1` unless `VIBE_FFMPEG=0`. [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md) explicitly says these APKs are GPL-3.0 as a whole. The repository's MIT license does not describe every bundled artifact's license. This PR does not change that packaging. |

## Validation and remaining work

Local validation used Windows, Node 24.19.0 and FFmpeg 9.0.2. The new server tests exercise real Fastify responses and body bytes; the client tests advance a mocked clock to verify retry cancellation and limits.

| Check | Result |
| --- | --- |
| `npm run build` | Shared, server and web builds pass, including TypeScript checks. |
| `npm test -w web` | 147 pass, including four new recovery tests. |
| `npm test` with local networking enabled on the original v0.6.10 base, repeated after `npm ci` | 700 tests: 673 pass, 24 fail, 3 skip. All six new file-response test groups pass. |
| Final server suite after rebasing onto v0.6.11 | 702 tests: 675 pass, 24 fail, 3 skip. The build and all 147 web tests also pass again on this base. |
| Unchanged v0.6.10 main server, same environment, existing tests only | 694 tests: 666 pass, 25 fail, 3 skip. All 24 failures in the changed run also fail on unchanged main; main additionally has a date-added failure. No claim is made that this PR fixes that extra intermittent failure. |
| Focused server playback suite | 65 pass: file responses, NAS artwork, streaming, renderers, playback decisions and audio. |
| New file-response tests against the original handler | Five of six fail before the change; all six pass with the improved handler. |

Existing failures include Unix path assumptions (`/t/seg%d.ts` versus Windows separators), invalid UTF-8 filename and symlink fixtures, Linux sysfs fixtures, unavailable `fpcalc`, FFmpeg HDR/filter/encoder differences, and a tuner timeout/Windows cleanup lock. Other failures in EPG, Home Assistant, WebSocket, artwork, plugin archive and subtitle conversion tests also reproduce on main and remain unresolved. The restricted initial run could not reach test provider servers and was superseded by the networking-enabled run. Linux CI is still required; these local results are not a green full-suite claim.

Before merge, require the repository's Linux CI and assess any existing server failures separately. Native device, NAS, HDR/GPU, Docker packaging and Android license-delivery validation require their corresponding environments. This change makes no measured startup-speed or transcoding-throughput claim.

The next highest-value work is a shared device/media compatibility fixture matrix, structured playback reasons, and a single cancellation contract for remote proxy streams and converted downloads. The latter currently use request-close hooks and deserve socket-level disconnect tests before changing their lifecycle. Cache and prewarm capacity also merit load tests before expansion. These are follow-up candidates, not untested behavior added to this PR.
