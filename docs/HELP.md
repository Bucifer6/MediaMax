# Help Centre: editing and adding articles

The in-app Help Centre (`/help` in the web app, **Settings → Help** in the phone and TV apps) is built from Markdown
files in [`server/help`](../server/help). They ship with the server (Docker image: `server/help`; release archives:
`help/` next to the binary; `VIBE_HELP_DIR` overrides the location) and are read and indexed once at startup.
Restart the server after editing them.

## Layout

```
server/help/
  sections.json                 section order, titles, icons, audience
  whats-new.md                  release notes shown once per user after an upgrade
  getting-started/welcome.md    one file per article; the file name is the slug (/help/welcome)
  watching/…  requests/…  tv/…  admin/…  troubleshooting/…
```

## Front-matter

```markdown
---
title: Subtitles: choosing, styling and timing
summary: One sentence shown in lists, search results and related links.
section: watching            # an id from sections.json (defaults to the folder name)
audience: everyone           # or admin: invisible (404) to everyone else, including search
keywords: captions, cc, sync # extra search terms, comma separated
related: subtitle-problems, audio
order: 3                     # position within the section
---
```

`whats-new.md` takes `title` and `version` only.

## Writing

- Plain language, short steps, the UI's exact labels in **bold** (`**Settings → Playback**`).
- `{{product}}` becomes the server name from the Branding studio, `{{version}}` the server version. Never write the
  product name literally: white-labelled servers show their own.
- Supported Markdown: `##`/`###` headings (custom anchor: `## Bitrate too high {#bitrate}`), paragraphs, `-` and
  `1.` lists (one nested level), pipe tables, fenced code, `>` quotes, `**bold**`, `*italic*`, `` `code` ``,
  `<kbd>K</kbd>`. Other HTML is shown as text: the renderer never injects HTML.
- Links: `[text](help:slug)` or `help:slug#anchor` for other articles, `/settings/playback` for app pages,
  `https://…` for the web. Links to admin-only articles render as plain text for non-admins.
- Keep the anchors in `troubleshooting/why-transcoding.md` in step with `web/src/utils/helpLinks.ts`, which maps
  the server's transcode reasons to them (the tests check both).

## Checks

`npm test -w server` (`server/test/help.test.ts`) checks front-matter, sections, `related` slugs, `help:` links and
anchors, placeholders, search ranking and audiences. `npm test -w web` checks that every article parses.

## Contextual help

`<HelpLink slug="subtitles" />` (web) adds a "?" button that opens an article; admin pages pass `help="…"` to
`AdminHeader`. The player's *Stats for nerds* links each "Why" reason to its section of *Why is it transcoding?*.

## Diagnostics

**Admin → Activity & logs → Download diagnostics** (`GET /api/v1/admin/diagnostics.zip`, admins only, once per 30 s)
bundles versions, OS/CPU/memory/disks, ffmpeg versions, the last hardware detection report, network mode, library
counts, scheduled tasks, settings and the last 5 MB of logs. Settings go through the existing write-only masking and
then a key-name redactor (passwords, keys, tokens, webhook URLs, hashes); URLs keep only scheme and host; log lines
lose tokens, API keys, credentials, `Authorization` headers and Xtream paths. Tables with credentials (users, API keys,
live sources, guide sources, linked accounts) are only counted.
