# Playback: subtitles and automatic quality

This page explains how Kinora players show subtitles and pick the stream quality, what you can change, and what
the server does behind the scenes. Audio (Dolby Atmos, DTS:X, passthrough, downmix, night mode, lip-sync) has its own
page: [AUDIO.md](AUDIO.md).

## Subtitles

Kinora players draw subtitles **themselves**. They never hand subtitles to the browser's or TV's built-in text-track
renderer or subtitle parser, which differ between devices and are unreliable on many smart TVs. This applies to the web
player in every browser, to TV mode on Samsung (Tizen) and LG (webOS), and to the phone, tablet and TV apps.

| Format | Web player and TV mode | Phone / tablet / TV apps |
|---|---|---|
| SRT, WebVTT (incl. positions, `line`/`position`/`align`, `<i> <b> <u>`, `<c.class>` colours, voices) | Our parser, drawn as text in your subtitle style | Our overlay, in your subtitle style |
| ASS / SSA | **libass** (full styling: fonts, colours, outlines, positioning, karaoke, rotation, animation), with fonts embedded in the MKV. Falls back to a simplified styled-text renderer on devices without WebAssembly | Text in your subtitle style |
| PGS (Blu-ray `.sup`) | Decoded by the player and drawn on a canvas | Burned in by the server (choose it under *Burned in (bitmap)*) |
| VobSub (DVD), DVB bitmap | Burned in by the server (marked *burn-in* in the menu) | Burned in by the server |
| DVB teletext (recordings) | Converted to text by the server | Converted to text by the server |
| Live TV captions (CEA-608/708) | Parsed by the stream engine, drawn by our renderer | Platform player |

**Burn-in** is a last resort: the player only asks the server to draw subtitles into the picture for bitmap formats it
cannot render. That needs a transcode, so it uses more server CPU: the bitmap is overlaid on the CPU, but with
hardware transcoding the GPU still decodes the video (the frames are copied to system memory for the overlay) and
encodes the result, so a 4K HEVC source is not decoded on the CPU.

### Changing how subtitles look

*Settings → Subtitles* (and *Subtitles → Subtitle style…* in the player) has:

- **Size**, **Colour**, **Background** (none, outline, translucent or solid box), **Font**, **Text edge** (outline, drop shadow, none)
- **Position** and **Lift from bottom** (5–20 % of the picture), e.g. to clear burnt-in lower thirds
- **ASS/SSA styling**: *Auto* (the file's own styles with libass where the device can run it), *Always the file's styles*
  (libass even on slower devices), or *My style* (plain text in your style)

On TVs (TV mode) text is larger and kept away from the screen edges. While the controls are showing, bottom subtitles
move up so they aren't hidden.

### Timing

Subtitles follow the video every frame, including at 0.5×–2× speed and while seeking. If they are early or late, use
**Sync & delay** in the subtitle menu, or press **G** (earlier) / **H** (later) in 0.1 s steps.

Long files: the server extracts only the selected track. Subtitles appear as soon as the first part is read, and the rest
fills in while you watch.

## Automatic quality (Auto)

**Auto** is the default quality. It measures your connection and keeps adjusting:

1. **At start** the player times a short download from the server (about half a second; the result is remembered for 10
   minutes per server and network). If the original file fits your connection it plays directly; otherwise the server
   transcodes at a fitting quality.
2. **While playing** the player keeps measuring how fast video arrives, how full its buffer is and whether frames are
   dropped. It lowers quality quickly when the connection gets worse (at once if the buffer is about to run out) and
   raises it one step at a time once the faster connection has lasted a while, so quality doesn't flap up and down.
3. When the quality drops a message says so, e.g. *"Lowered quality to 720p due to connection speed"*. Press **I** for
   *Stats for nerds*: the *Quality* line shows the mode, the current level and the estimated bandwidth.

Behind the scenes:

- **Transcodes are offered as several quality levels** (e.g. 1080p, 720p, 480p, 360p, never above the original). Only the
  level you are watching is encoded; when the player switches, the server starts that level from the current position,
  and the two line up exactly, so the switch is seamless. Levels nobody is watching stop after 20 seconds.
- **Direct play that becomes too slow** switches to a transcode at a fitting quality without stopping playback (the new
  stream loads while the old one keeps playing), and **switches back to the original** when the connection recovers.
- With a single hardware encoder (e.g. Raspberry Pi), changing level restarts the encoder at the new bitrate — still
  without a visible restart.
- The phone and TV apps send the measured bandwidth and let the system player (AVPlayer, ExoPlayer) switch between the
  quality levels.

You can still pick a fixed quality (*Original*, *1080p · 8 Mbps*, …) in the player's quality menu or as your default in
*Settings → Playback → Streaming quality*. A fixed choice turns Auto off for that playback.

### Server settings (admins)

*Admin → Settings → Transcoding → Adaptive streaming*:

- **Offer quality levels for transcodes**: the multi-level streams described above (on by default).
- **Remote bitrate limit**: caps the quality for viewers outside your network (local viewers are never capped unless
  their measurement says their connection is slower).
- **Stop idle quality levels after**: how long an unwatched level keeps encoding.
