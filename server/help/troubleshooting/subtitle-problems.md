---
title: Subtitles missing or out of sync
summary: What to do when subtitles don't show, are early or late, look wrong or take a long time to appear.
section: troubleshooting
audience: everyone
keywords: subtitles, missing, not showing, out of sync, early, late, delay, wrong language, garbled, tiny, burn-in, slow, opensubtitles
related: subtitles, no-sound, why-transcoding
order: 4
---

## Subtitles don't appear

1. Check one is selected in the player's **Subtitles** menu (or press <kbd>C</kbd>).
2. If the menu is empty, the file has none. Try **Search online…** in the subtitles menu, if your server has it.
3. *Forced only* shows only signs and foreign-language lines. Choose a full track, or change **Settings → Playback → Subtitles**.
4. Long files: subtitles appear as soon as the first part has been read and fill in while you watch. Give it a few seconds.

## They're early or late

Use **Sync & delay** in the subtitle menu, or press <kbd>G</kbd> (earlier) and <kbd>H</kbd> (later) in 0.1-second steps. If they drift further out over time, the subtitle file was made for a different version of the video (for example a different frame rate or cut); try another track or download a matching one.

## They look wrong

- **Too small, hard to read**: change **Size**, **Background** and **Text edge** in **Settings → Playback → Subtitles**.
- **Hidden behind text in the picture**: set **Position** to *Raised* or increase **Lift from bottom**.
- **Fancy styles missing or too much**: set **ASS/SSA styling** to *Auto* for the file's own look, or *My style* for plain text.
- **Strange characters**: the subtitle file uses an unusual text encoding. Report it to your admin.

## Picking subtitles makes the video restart or reload

DVD and some broadcast subtitles are pictures that the player can't draw, so the server draws them into the video. That needs a conversion, which restarts the stream and uses more server power. Choose a text track if there is one.
