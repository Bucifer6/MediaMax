# Lyrics, karaoke and visualisers

## Lyrics

Vibe looks for lyrics in this order and uses the first **synced** hit (a plain-text hit keeps looking for a synced one further down):

1. **Edits made in Vibe** (administrators, full-screen player → *Edit lyrics*).
2. **Files next to the music**: `Song.lrc`, `Song.LRC`, `Song.mp3.lrc`, then `Song.txt`.
3. **Tags in the file**: ID3 `SYLT` (synced, with per-syllable timing — read straight from the tag because FFmpeg drops it), ID3 `USLT`, Vorbis/FLAC `LYRICS` / `UNSYNCEDLYRICS`, MP4 `©lyr`. A whole `.lrc` pasted into a tag is recognised and used as synced lyrics.
4. **LRCLIB** (lrclib.net), if turned on under *Server settings → Metadata*. It is only asked for artist, title, album and duration; hits and misses are cached.

Enhanced LRC word timing (`[00:12.00]<00:12.00>Word <00:12.40>by <00:12.90>word<00:13.50>`), several timestamps per line, metadata tags and `[offset:]` are understood.

**Karaoke highlighting.** With word timing each word fills as it is sung; with only line timing the highlight wipes across the line. The *Lyrics* view shows every line and scrolls smoothly; the *Karaoke* view shows the current and next lines in big type (10-foot friendly on TVs).

**Timing.** If lyrics run early or late, use *Lyrics timing −0.1 s / +0.1 s* in the full-screen player (saved per track for you) or set a global offset in *Settings → Music*. Positive values show lyrics earlier. The player also corrects for audio output latency.

**Editor (administrators).** Paste plain lyrics or an `.lrc`, switch to *Sync*, play the song and press <kbd>Space</kbd> as each line starts (<kbd>Backspace</kbd> undoes, <kbd>↑</kbd>/<kbd>↓</kbd> move the cursor, ±0.1 s nudges per line, *Shift all*). Import/export `.lrc`. Saved lyrics are stored in the database. With *Server settings → Karaoke & lyrics → Allow writing .lrc files* on (off by default: media folders are often read-only), the editor can also write `Song.lrc` next to the audio file.

## Karaoke (vocal removal)

Turn on **Karaoke** in the full-screen player (or the ✨ button in the mini player) and set the **Vocals** level (0–100 %, default 15 %). There are two modes:

| | Quick | AI stems |
|---|---|---|
| How | Centre-channel cancellation in Web Audio: the mid (L+R) signal above 150 Hz is turned down, the side (L−R) signal and the centred bass/kick below 150 Hz are kept | HT-Demucs splits the track into vocals, drums, bass and other; the server mixes them with the vocals turned down |
| Needs | Nothing — works instantly on any stereo track in the web/TV app (direct play through Web Audio) | One-time preparation per track in an administrator's browser |
| Quality | Removes centred lead vocals (measured: −41.7 dB on a centred test melody, panned instruments −2.3 dB, bass kept); also removes anything else in the centre; mono recordings lose everything above 150 Hz | Clean instrumental, backing vocals handled by the model |
| Devices | Web and TV mode (Web Audio) | Every device: web, TV, iOS/Android (they simply play a different audio file) |

### Preparing AI stems

1. *Server settings → Karaoke & lyrics → Enable AI stem separation*. The default model is **HT-Demucs v4** (Meta's Demucs) as an ONNX export (npm package `demucs@1.0.0`, ≈ 100 MB download, 175 MB on disk); you can point *Model URL* at another export (`https://…/model.onnx`, or `https://…/archive.tgz#path/in/archive.onnx`) with its SHA-256. The default download is pinned: both the archive and the model are SHA-256 checked, and it is stored under `<data>/stems/models/`.
2. As an administrator, play the track and press **Prepare (AI)**: in the web app's full-screen player → Karaoke, or under the lyrics in the mobile / TV app.
   - **On the server** (the default wherever the platform allows: Windows x64/arm64, Linux x64/arm64 with glibc — including the Docker image — and Apple silicon Macs). The track is queued and separated by the server itself with **onnxruntime-node**, one track at a time, in a separate low-priority process: on the GPU where there is one (DirectML on Windows, Core ML on Macs, CUDA on Linux when NVIDIA's CUDA libraries are installed), otherwise on all CPU cores but two. You can close the app; the progress shows again when you come back. If a GPU fails or returns unusable audio (some integrated-GPU drivers do; every chunk is checked: the four stems must add up to the original), that track is redone on the CPU and the server stays on the CPU until it restarts.
   - **In the browser** (servers whose platform has no native runtime, or *Separate on → The administrator's browser*): open the web app on a computer (Chrome, Edge or Firefox; Safari 17+). The browser downloads the model from your server once, decodes the track, runs the model in a Web Worker with **onnxruntime-web** — on the GPU through **WebGPU** when available, otherwise WebAssembly on the CPU — and uploads the four stems to the server as it goes. Keep the tab open while it runs.

   *Cancel* stops either.
3. The server stores them as FLAC under `<data>/stems/<trackId>/` and renders mixes on demand (`/items/:id/karaoke.mp3?vocals=…`, cached per 5 % step). From then on **any device** — including TVs and phones that can't run the model — plays the karaoke version.

Speed: a recent GPU separates a 4-minute song in well under a minute; the CPU takes a few minutes (on the server, about twice the song's length on a 4-core desktop CPU). The first job after a server start also loads the model: a few seconds on the CPU, while DirectML compiles it first, which can take half a minute.

**Privacy.** All processing happens on your own server and in your own browser. The only external download is the model file itself (from npm's registry, or the URL you set), once. No audio leaves your network.

**Phones.** The mobile app shows word-by-word lyrics with timing adjustment, and plays the karaoke mix of tracks that have stems (*Karaoke* chip under the lyrics). When the server separates, administrators can also prepare a track from the phone or TV (*Prepare karaoke (AI)*); the work runs on the server, never on the phone.

## Visualisers

The full-screen player's *Visualiser* view has five styles: **Cover ring** (cover art with a spectrum ring and beat pulse), **Bars**, **Waveform** (mirrored oscilloscope), **Starfield** (speed follows the energy) and **Ambient** (soft blobs in the cover's colours — made for TVs). On TVs, select the stage and press ←/→ to switch styles.

- Audio is read with an `AnalyserNode` tapped after the output chain (night mode, vocal reduction): a fan-out that never changes what you hear.
- Beats come from the DJ analysis beat grid (`GET /items/:id/analysis`) when the track has been analysed, otherwise from onset detection on the spectrum.
- When there is no analyser data (no Web Audio on the device, or the browser plays the stream outside Web Audio), the animation is driven by the beat grid or a gentle clock instead.
- Rendering uses `requestAnimationFrame` on a 2D canvas, stops while the tab is hidden, renders at 1× pixel density on TVs and big screens, and switches to a calm, nearly static version with *prefers-reduced-motion*.

**TV music screensaver.** In TV mode, after a few minutes without a key press while music plays (*Settings → Music → TV music screensaver*, default 3 minutes, 0 = off), the Ambient visualiser fills the screen; any key returns.

**Mobile.** The mobile app has no visualiser: expo-audio's sample listener needs the microphone permission on Android, which is not worth asking for to draw bars.

## Licences

onnxruntime-node and onnxruntime-web (MIT, Microsoft) are not installed with Vibe. For server separation, the server downloads onnxruntime-node and onnxruntime-common from the npm registry the first time a track is prepared (pinned to version 1.31.1, each checked against its SHA-512 hash; only the JavaScript and this platform's binaries are kept, about 100 MB, under `<data>/stems/ort-node/`). For browser separation it downloads onnxruntime-web the same way (pinned to 1.23.2; only the browser files are kept, under `<data>/stems/ort/`) and serves it to the browser. Air-gapped servers can point `KINORA_ORT_NODE_DIR` at a folder containing `node_modules/onnxruntime-node` (with `onnxruntime-common`), and `KINORA_ORT_DIR` at a copy of onnxruntime-web's `dist/` folder; the Demucs model weights (Meta, MIT licence in facebookresearch/demucs) are downloaded only when an administrator enables AI separation — the ONNX export's packager notes they may be meant for personal and research use, so check before commercial use. The LRC parser, SYLT handling, stem DSP and visualiser ring are adapted from OpenDJ (MIT). See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
