---
title: Plugins
summary: Install plugins from repositories to add notifications, metadata providers, scheduled jobs and more.
section: admin
audience: admin
keywords: plugins, extensions, repository, catalog, install, update, settings, developer
related: admin-metadata, admin-home-assistant
order: 15
---

**Admin → Plugins** has three tabs:

| Tab | What it's for |
|---|---|
| **Installed** | Plugins on this server: open one to change its settings, update it, turn it off or remove it. |
| **Catalog** | Plugins offered by your repositories. Install with one click. |
| **Repositories** | The plugin repository URLs the catalog comes from. |

Plugins can add notification services, metadata providers, scheduled tasks, extra API routes and settings pages.

## Safety

A plugin runs inside the server with the same access as {{product}} itself: it can read your libraries and settings. Only install plugins from sources you trust, and only add repositories you trust.

## Writing your own

Plugins are small JavaScript packages. See `docs/PLUGINS.md` and the examples in `plugins/examples` in the {{product}} source code.
