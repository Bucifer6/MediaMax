---
title: What's this song?
summary: Identify the music playing in a movie or episode from your phone's second screen — straight from the file, or with the microphone.
section: watching
audience: everyone
keywords: song, music, identify, shazam, soundtrack, what song is this, acoustid, fingerprint, microphone, second screen
related: phone-remote, music
order: 20
---

On the phone remote's **Now playing** tab, tap **Identify** under **What's this song?**.

## How it works {#how}

{{product}} listens to the title's own audio — about 12 seconds around the moment the TV is at — and looks the sound up on AcoustID, the open music-recognition service. No microphone is needed, so the room can be as noisy as you like.

If you have the song in your music library, **In your library** takes you straight to it.

## Using the microphone {#microphone}

Some titles can't be listened to directly (for example IPTV streams with no local file), or there's no match. In a phone browser, tap **Use microphone** and hold the phone near the speakers for about 10 seconds. Your browser asks for microphone permission the first time; the recording is only used for the lookup and isn't kept.

The phone app identifies from the file only.

## It says it can't identify songs {#unavailable}

Song identification needs an AcoustID application key and the Chromaprint tool on the server. Ask your server admin to add them under **Server settings → Metadata → Music identification**.

Matching a short excerpt works best for songs that play clearly; dialogue or sound effects over the music can prevent a match.
