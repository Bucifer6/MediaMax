# Review pack and store media: credits and licences

Everything a store reviewer sees on the Kinora review server, and everything in the store screenshots and preview
video, is either **made by the Kinora project** or released by its author under **CC0 1.0**. Nothing needs
attribution, a licence fee or a permission request, and no third-party film, show, song, photo, logo or channel
appears anywhere.

The pack is built by [`scripts/review-pack/build-review-pack.mjs`](../../scripts/review-pack/build-review-pack.mjs).
Every built pack carries a `manifest.json` listing each file with its size, SHA-256, source and licence.

## Made by the Kinora project (CC0 1.0)

The Kinora project dedicates all of these to the public domain under
[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/). They are generated from code each time the
pack is built: no samples, stock footage, loops or photographs go into them.

| Item | What it is | How it is made |
|---|---|---|
| **Aurora Drift** (2026), 2:00, 1080p H.264, English subtitles | Motion-graphics short | ffmpeg `gradients` source + title card; score from the synthesiser below |
| **Lumen** (2026), 1:00, **4K HDR10**, 5.1 | HDR and surround test film | ffmpeg `gradients`, converted to BT.2020 / PQ with mastering metadata; HEVC Main 10 |
| **Kinora Calibration Reel** (2026), 1:00, 720p | Colour bars, test card, countdown | ffmpeg `smptehdbars`, `testsrc2`, `zoneplate`; 1 kHz tone and a sweep |
| **Paper Orbit** (2025), 1:30, 480p | SD short | ffmpeg `life` (Conway's Game of Life); synthesised score |
| **Pixel Tides** (2026), season 1, 3 episodes × 1:15, 720p | Generated TV series | ffmpeg `cellauto` (rule 110), `mandelbrot`, `zoneplate`; synthesised scores |
| **Glasshouse Signals – First Light**, 4 tracks | Album | Synthesiser vendored from OpenDJ (see below), MP3 with generated cover |
| **Kinora Story Lab – The Clockmaker's Garden**, 3 chapters | Audiobook | Original short story written for the pack; read by eSpeak NG |
| **Kinora Notes**, 2 episodes | Podcast (RSS feed + MP3) | Original script; two eSpeak NG voices over a quiet synthesised bed |
| 9 photos in *Generated Landscapes* and *Shapes and Light* | Photo library | Seeded canvas drawings rendered in Chromium |
| **Kinora Test Card**, **Kinora Ambient** + 7-day guide | Live TV test channels | Generated frames looped as HLS; XMLTV written by the seeder. Not real channels |
| Posters, backdrops, title cards, covers, channel logos | Artwork | Seeded canvas drawings rendered in Chromium |

All titles, artists, authors and story characters are invented. Text in the artwork is set in whatever sans-serif
font the build machine has (Inter, DejaVu Sans or Liberation Sans, all under free licences that allow this); no
font file is included in the pack.

The **Kinora name and logo** appear in title cards, channel logos and test-channel frames. They are Kinora's own
branding and are not part of the CC0 dedication.

## Downloaded, released by their authors under CC0 1.0

The licence was read on each track page on 2026-11-21 (each says *"licensed under a CC0 1.0 Universal License"*).
The build downloads the files, refuses any whose SHA-256 differs from the value below
([`downloads.json`](../../scripts/review-pack/downloads.json)), then copies the audio unchanged and replaces the
tags and cover art with generated ones. Credit is not required under CC0; it is given anyway.

| Track | Artist | Source page | Licence | SHA-256 of the downloaded file |
|---|---|---|---|---|
| Washed Up (from *Ocean Memory*) | HoliznaCC0 | [freemusicarchive.org](https://freemusicarchive.org/music/holiznacc0/ocean-memory-lo-fi-chill/washed-up/) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | `d75e34dea40ec7d7cbdcda3a66624eb5e72a829d58cac98d056aa941d9b747f7` (9,655,010 bytes) |
| Roof Tops (from *Summer Air*) | HoliznaCC0 | [freemusicarchive.org](https://freemusicarchive.org/music/holiznacc0/summer-air-lo-fi/roof-tops/) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | `f6e619fbfdc0898c409494d5c810d34d9cd29be2b75bb2d8c197e1edb37155b5` (8,902,309 bytes) |
| Snow Cakes with friends | Loyalty Freak Music | [freemusicarchive.org](https://freemusicarchive.org/music/Loyalty_Freak_Music/single/snow-cakes-with-friends/) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | `2c51dfce2cea560f372206fc2b3104027eda1a9b0e8766c1ce74e462f53ab779` (4,138,223 bytes) |

## Optional extra (not in the default pack): CC BY

`--with-open-movies` adds **Big Buck Bunny** (2008), © Blender Foundation, www.bigbuckbunny.org, under
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), in a separate library *Open Movies (CC BY)* with an
`ATTRIBUTION.txt` next to the file. If you use it on the review server or in store media, credit it as:
*"Big Buck Bunny © 2008 Blender Foundation | www.bigbuckbunny.org, CC BY 3.0"*. Its hash is not pinned yet (the
download host was not reachable while the pack was made); the build prints the hash on first download so you can
pin it in `downloads.json`. The default pack does not need it.

## Tools

| Tool | Licence | Use |
|---|---|---|
| OpenDJ demo synthesiser (`scripts/demo/make-demo-library.mjs` in OpenDJ, commit 1d85fa1) | MIT, © OpenDJ contributors | Vendored as [`scripts/review-pack/lib/opendj-synth.mjs`](../../scripts/review-pack/lib/opendj-synth.mjs) to make every score and the album |
| [eSpeak NG](https://github.com/espeak-ng/espeak-ng) | GPL-3.0-or-later | Speech for the audiobook and podcast. Only the program is GPL; the audio it outputs is not covered by the GPL, and no eSpeak NG code or data is shipped in the pack |
| [FFmpeg](https://ffmpeg.org) (with x264 / x265) | LGPL / GPL | Encoding and the built-in test sources; only its output is shipped |
| Chromium via [Playwright](https://playwright.dev) | BSD / Apache-2.0 | Renders the artwork and records the screenshots and preview video |

## Screenshots and the preview video

Recorded from Kinora's own web app (desktop and TV mode) by
[`scripts/review-pack/store-shots.mjs`](../../scripts/review-pack/store-shots.mjs), showing only the review pack
above, signed in as the review account ("App Review"). The interface fonts are Kinora's own bundled
Bricolage Grotesque and Figtree (SIL Open Font License 1.1, via Fontsource). The preview video's music is
*First Light* by Glasshouse Signals, from the generated album above.
