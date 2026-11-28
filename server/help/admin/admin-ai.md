---
title: AI features (language model, automatic subtitles, Ask, recaps)
summary: Connect one language model for every AI feature, generate subtitles with speech-to-text at night, turn on semantic search and series recaps.
section: admin
audience: admin
keywords: ai, llm, language model, ollama, openai, groq, gemini, whisper, whisper.cpp, speech to text, transcription, automatic subtitles, auto-generated, translate, translation, romanian, embeddings, semantic search, ask, recap, previously on, night window
related: admin-transcoding, admin-storage, admin-backups
order: 19
---

**Admin → AI** holds everything AI in {{product}}. Every feature works without a language model; a model only makes
them smarter. Nothing here is required.

## The language model

One model is shared by the AI DJ, Ask, recaps and subtitle translation (before, it was set up under the AI DJ: your
existing DJ model was moved here automatically).

- **Ollama** or another self-hosted server (LM Studio, llama.cpp, LocalAI, vLLM) is free and private. A 3B model is
  enough for the DJ and Ask; for **Romanian subtitle translation** use a bigger one (7-8B or more), or a hosted service.
- Hosted services with free tiers (Groq, Gemini, OpenRouter, Mistral, Cerebras) or very low prices (DeepSeek, OpenAI)
  need an API key. The key is write-only: it is never shown again.
- **Daily limit** counts calls from all features together. Over the limit every feature quietly falls back to its
  built-in behaviour until midnight (UTC). 0 means no limit.
- Press **Test the model** after saving.

What a hosted service receives: DJ requests with song titles, Ask questions, the descriptions of the episodes being
recapped, and subtitle lines being translated. Nothing else from your library.

Under **Features** you can switch Ask, recaps, automatic subtitles and the DJ's use of the model on or off one by one.

## Automatic subtitles

The **Generate missing subtitles** task is a *last resort*: it only picks titles that still have no subtitle in your
languages after the **Download missing subtitles** task had 12 hours to find one. It is off by default.

For each title it takes the main dialogue track (not commentary), converts it to 16 kHz mono audio, splits it at
pauses, runs speech-to-text on each piece, tidies the timing and writes an SRT file. If the film speaks another
language than the one you want, the lines are translated by the language model in batches (timing never leaves the
server, line breaks are kept, Romanian gets proper ș and ț). English is the exception: whisper translates to English
by itself, no model needed. The result goes through the same clean-up as downloaded subtitles and shows up in every
player as **Auto-generated (AI)**, listed after downloaded and embedded subtitles.

### Engines

- **whisper.cpp on this server** (free). On Windows press **Download whisper.cpp** for the official release program,
  then **Download the model** you chose. On Linux or macOS install whisper.cpp from your package manager (for example
  `brew install whisper-cpp`) or build it. If `whisper-cli` is not on the PATH, set the `VIBE_WHISPER` environment
  variable to its full path and restart {{product}} (for security, admin pages can't choose a program to run). Older
  builds call the program `main`.
- **Speech-to-text API**: any OpenAI-compatible `/audio/transcriptions` endpoint, for example a self-hosted
  faster-whisper server (`http://localhost:8000/v1`) or OpenAI.

### How long does it take on a CPU?

Rough figures for whisper.cpp on a modern 6-core Intel desktop CPU using 3-4 threads (the default is half your cores, so
playback stays smooth). Older or laptop CPUs can be 2-3 times slower. Quick Sync does not help speech-to-text.

| Model | Download | Speed | A 2-hour film | Quality |
|---|---|---|---|---|
| tiny | 75 MB | ~20-40× real time | ~3-6 min | Rough; names and quiet lines suffer |
| base | 142 MB | ~10-20× real time | ~6-12 min | Good default for a CPU |
| small | 466 MB | ~3-6× real time | ~20-40 min | Clearly better |
| medium | 1.5 GB | ~1-2× real time | ~1-2 hours | Best of these; night runs only |

Translation adds a few minutes per film with a fast hosted model, and can take much longer with a large local model on
a CPU. A night window of 6 hours with the **base** model handles roughly 25-50 films.

### Night window, priority and progress

Jobs only start inside the night window (default 01:00-07:00, server time), one at a time, at low process priority.
At the end of the window the running job pauses and resumes the next night from the last finished piece; a restart
does the same. **Run now** processes the queue immediately, ignoring the window. The AI page shows the queue, the
running job with progress and an estimate of the time left, and what was done recently (with the reason when a title
was skipped, for example "needs a language model to translate").

You can also generate one title on demand: open **Find subtitles online** on its page and choose **Generate with AI**.

## Ask

Ask lets people search in their own words, in English or Romanian, from the search page (web, TV and phone): *"something
funny under 90 minutes we haven't seen"*, *"comedii românești din anii 2000"*, *"like Inception but lighter"*. A
built-in parser understands running time, decades and years, genres and moods, watched or not, ratings, spoken
language, people and "like ⟨title⟩" instantly. When it can't explain every word and a model is connected, the model
turns the question into the same kind of filter (checked strictly before it is used). Results always respect each
user's library access and parental limits.

**Semantic matching** (optional) also compares the question with plots and taglines, so descriptions like *"that heist
film with red jumpsuits"* work. Turn it on, choose where the embeddings come from, save, and the **Build search
embeddings** task processes your library in the background:

- **This server**: a small English model (about 25 MB) downloaded on first use and run on the CPU with the same
  runtime as AI karaoke. Expect around 10-20 minutes for 20,000 films, once.
- **The language-model server**: its embeddings endpoint, for example `nomic-embed-text` or `bge-m3` on Ollama.
  Multilingual models handle Romanian questions better.

## Recaps

When someone comes back to a series after a break (7 days by default) or starts a new season, the episode page and
the start of playback offer a **Previously on…** card. It is built only from the episodes that person already watched
before the one they are about to play, never later ones. With a model it is a short 3-5 sentence summary; without one
it is a tidy list of those episodes' descriptions. If the episode has a recap marker, **Play the recap clip** plays
just that part. Recaps are cached per person and episode.
