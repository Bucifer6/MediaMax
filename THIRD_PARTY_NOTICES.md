# Third-party notices

Kinora includes code adapted from the following projects. Their licences are reproduced or referenced below.
Packages installed from npm carry their own licence files in `node_modules`.

## OpenDJ

- What: DJ phrase detection (song structure on 8/16/32-bar lines), phrase-aligned mix points, the transition styles
  (EQ bass swap, filter fade, echo-out) and the WSOLA key-lock time-stretch.
- Where: `server/src/services/dj/phrases.ts`, parts of `server/src/services/dj/mix.ts` (`chooseFx`, `bassSwapPoint`)
  and `server/src/services/dj/render.ts`, `web/src/player/djWsola.ts`, `web/src/player/djKeylock.worklet.ts`,
  `web/src/player/djMixer.ts`.
- Source: Adapted from OpenDJ (MIT, github.com/Bucifer6/OpenDJ) — `public/js/audio/analysis-core.js`,
  `public/js/automix.js`, `public/js/audio/worklets.js`.
- Licence: MIT License

  Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
  documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
  rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
  persons to whom the Software is furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
  Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
  WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
  COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
  OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Lyrics, karaoke and visualisers

Kinora itself is MIT licensed (see [LICENSE](LICENSE)). This file lists third-party code and models used by the
lyrics, karaoke and visualiser features. Other dependencies are listed in each workspace's `package.json` and carry
their own licences; FFmpeg is run as a separate program (LGPL/GPL).

### OpenDJ — adapted source code

- Project: OpenDJ, <https://github.com/Bucifer6/OpenDJ> — MIT License.
- Adapted from OpenDJ (MIT, github.com/Bucifer6/OpenDJ):
  - LRC parser / writer, word-timing state and helpers → `shared/src/lrc.ts` (copied to `server/src/services/lrc.ts`,
    `web/src/lyrics/lrc.ts`, `apps/mobile/src/player/lrc.ts`)
  - ID3 SYLT → lines, lyrics source order, text decoding → `server/src/services/id3.ts`, `server/src/services/lyrics.ts`
  - Lyrics editor model (tap-to-sync) → `web/src/lyrics/editorModel.ts`, `web/src/lyrics/LyricsEditor.tsx`
  - Karaoke display → `web/src/lyrics/KaraokeLyrics.tsx`
  - Stem DSP (FFT, HT-Demucs STFT/iSTFT, chunking, overlap-add), ONNX runner and stub, separation worker, preparation
    flow → `web/src/stems/*`
  - Model download / SHA-256 verification / tar extraction and the per-track stem cache → `server/src/services/stems.ts`
  - Mid/side "quick stems" split → `web/src/player/karaokeFx.ts`
  - Cover art + spectrum ring + beat pulse visualiser → `web/src/visualizer/styles.ts` (`ring`), `withAlpha`
- Licence text (MIT): Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
  associated documentation files, to deal in the Software without restriction, including without limitation the
  rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, subject to
  the copyright notice and this permission notice being included in all copies or substantial portions of the
  Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

### ONNX Runtime Web (`onnxruntime-web` 1.23.2)

- Used to run the AI stem-separation model in the browser (WebGPU / WebAssembly). Not shipped with Kinora: the
  server downloads the pinned npm tarball the first time AI separation is used, verifies its SHA-512 integrity, keeps
  only `dist/ort*.mjs` / `ort*.wasm` and serves them same-origin (`/api/v1/stems/ort/…`). Not bundled into the web app.
- MIT License, © Microsoft Corporation — <https://github.com/microsoft/onnxruntime>.
- Its own npm dependencies are not downloaded (the browser build bundles what it needs).

### HT-Demucs model (downloaded on demand, not bundled)

- Stem-separation model from Meta's Demucs, <https://github.com/facebookresearch/demucs> — code and pretrained
  weights released under the MIT License.
- Default download: the ONNX export published as the npm package `demucs@1.0.0`
  (<https://registry.npmjs.org/demucs/-/demucs-1.0.0.tgz>, packaged by github.com/bakkot/demucs-js), member
  `package/htdemucs.onnx`. Pinned: archive SHA-256 `83aadd00d48cd2a0c2e81e2a35616f4fa41a41f5c07efcc4a5c1959377b4ec42`,
  model SHA-256 `da9e5101ee0804d04933974b59d8aae9c862e80e14f2f24e7c74cae76bdbe748` (174,263,526 bytes).
- Downloaded only after an administrator enables *AI stem separation*. The export's packager describes the weights as
  being for personal and research use; check the terms before commercial use, or set *Model URL* to a model whose
  licence suits you.

### LRCLIB

- Optional online lyrics source (<https://lrclib.net>), off unless enabled under Server settings → Metadata. Lyrics
  retrieved from it remain subject to their rights holders' terms.

## ASS subtitle renderer (`jassub` 2.5.38, bundled in the web app)

- What: renders styled ASS/SSA subtitles in the web player (a Web Worker running libass compiled to WebAssembly).
- Where: served from the web build as jassub's worker and `.wasm` files; used by `web/src/player/subtitles/assRenderer.ts`.
- Source: jassub (github.com/ThaUnknown/jassub), which bundles:
  - **libass** — ISC licence
  - **FreeType** — FreeType Licence (FTL) or GPL-2.0-or-later (used here under the FTL)
  - **HarfBuzz** — MIT ("Old MIT") licence
  - **FriBidi** — LGPL-2.1-or-later
  - jassub's own code — MIT
- Licence expression declared by the package: `LGPL-2.1-or-later AND (FTL OR GPL-2.0-or-later) AND MIT AND
  MIT-Modern-Variant AND ISC AND NTP AND Zlib AND BSL-1.0`.
- LGPL note: FriBidi is used unmodified and runs inside a separately loaded WebAssembly module, so it can be replaced
  with a modified build; its source is available from github.com/fribidi/fribidi. jassub's licence files are served
  next to the worker in the web build.
