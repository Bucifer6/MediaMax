# Vibe plugins

Plugins extend the server, the same way Jellyfin and Emby plugins do. A plugin can:

- **listen to events**: playback start/pause/stop/scrobble, new media, sign-ins, DVR, requests…
- **add API routes**, mounted at `/api/v1/plugins/<id>/…`, as public, user or admin routes
- **add scheduled tasks**, which appear under *Admin → Scheduled tasks*
- **provide metadata**: fill missing plots, ratings, artwork and ids for movies, shows, music and audiobooks
- **declare settings**, which are rendered automatically in *Admin → Plugins*
- **ship an admin page**, an HTML page shown inside the dashboard (sandboxed)

> **Trust model:** plugins run inside the server process with full access, as in Jellyfin and Emby.
> Only install plugins from sources you trust. Packages from repositories are verified against the
> SHA-256 checksum in the repository index, and every install, upgrade and removal is written to the activity log.

## Installing

- **From a repository:** add repository URLs under *Admin → Plugins → Repositories*. These must be https,
  except localhost during development. Then pick a plugin from the catalogue.
- **Upload:** upload a `.tar.gz` package in *Admin → Plugins*.
- **Manually:** copy a plugin folder into `<data>/plugins/<id>/`. It shows up as a local plugin, disabled until you enable it.

Enabling, disabling, updating and changing settings all take effect immediately; no restart is needed.

## Writing a plugin

```
my-plugin/
  plugin.json      manifest
  index.js         ES module that exports activate(ctx)
  ui/index.html    optional admin page
```

`plugin.json`:

```json
{
  "id": "com.example.my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "What it does",
  "author": "You",
  "main": "index.js",
  "minServerVersion": "0.1.0",
  "adminPage": "ui/index.html",
  "capabilities": ["events", "routes", "network"],
  "settings": [
    { "key": "apiKey", "label": "API key", "type": "secret", "required": true },
    { "key": "mode", "label": "Mode", "type": "select", "default": "fast",
      "options": [{ "value": "fast", "label": "Fast" }, { "value": "thorough", "label": "Thorough" }] }
  ]
}
```

Setting types: `string`, `secret` (masked in the UI and API), `number`, `boolean`, `select` and `text`.

`index.js`:

```js
/** @type {import('mediamax/plugins/sdk').ActivateFn} */
export async function activate(ctx) {
  ctx.events.on('library.new', ({ itemIds }) => ctx.log.info(`${itemIds.length} new items`));

  ctx.http.route('GET', '/stats', () => ({ seen: ctx.storage.get('seen', 0) }), { auth: 'admin' });

  ctx.tasks.register({ id: 'nightly', name: 'My nightly job', intervalMinutes: 1440, run: async (progress) => { progress(100); } });

  ctx.metadata.registerProvider({
    name: 'My provider', types: ['movie'],
    fetch: async (item) => ({ overview: `Fetched for ${item.title}` }),
  });

  // Subtitle source: listed in Server settings → Subtitles; Vibe scores, unpacks, cleans and saves for you.
  ctx.subtitles.registerProvider({
    id: 'mysite', name: 'My subtitle site',
    configured: () => !!ctx.settings.get('apiKey'),
    search: async (q) => [{ id: '42', language: 'ro', release: 'Movie.2024.1080p.WEB-DL-GROUP' }],
    download: async (r) => ({ data: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nSalut\n'), fileName: `${r.id}.srt` }),
  });
}

export function deactivate() { /* close timers/sockets */ }
```

The full API is typed in [`plugins/sdk/index.d.ts`](../plugins/sdk/index.d.ts), and covers `ctx.settings`, `ctx.storage`,
`ctx.events`, `ctx.http`, `ctx.tasks`, `ctx.metadata`, `ctx.subtitles`, `ctx.library`, `ctx.log` and `ctx.dataDir`.

Working examples are in [`plugins/examples/`](../plugins/examples):

- **discord-notify** posts new media, playback and requests to a Discord channel. It shows events, routes, settings and an admin page.
- **local-subtitles** is a subtitle provider that searches a folder on the server (e.g. a shared archive of
  Romanian subtitles) by IMDb id or title. It shows `ctx.subtitles.registerProvider`, and its downloads go through the
  same archive, encoding, diacritics and sync pipeline as OpenSubtitles and Subs.ro.
- **omdb-ratings** is an OMDb metadata provider with a key-check task. It shows metadata providers, tasks and settings.
- **anilist** fills anime series and films from AniList: synopsis, genres, score, cover and banner, plus AniList/MAL ids. It needs no key, matches strictly on title and year, and keeps under AniList's rate limit.
- **musicbrainz** matches artists and albums to MusicBrainz. It adds MBIDs, genres and a short artist description, and fetches missing album covers from the Cover Art Archive. It sends one request per second, as MusicBrainz asks, with a configurable contact in the User-Agent.

## Publishing a repository

A repository is a JSON file served over https:

```json
{
  "name": "My plugins",
  "plugins": [{
    "id": "com.example.my-plugin", "name": "My Plugin", "description": "…", "author": "You",
    "versions": [{ "version": "1.0.0", "url": "https://…/my-plugin-1.0.0.tar.gz", "sha256": "…", "minServerVersion": "0.1.0" }]
  }]
}
```

`node plugins/pack.mjs https://your.host/path` packages every folder in `plugins/examples/` and writes
`plugins/dist/repository.json` with the checksums filled in. Use it as a template for your own repository.
