# Third-party notices

MediaMax includes code adapted from the following projects. Their licences are reproduced or referenced below.
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
