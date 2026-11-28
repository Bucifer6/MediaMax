# Vibe names and compatibility

Vibe was previously called Kinora and MediaMax. Server installs use Vibe names (see below, an upgrade moves an
existing install). Identifiers that apps on phones and TVs, store listings and integrations depend on keep their
older names, so installed apps keep signing in, updating and working with existing automation.

A search for the old names will therefore still return many results. They are not all missed display text. Do not
bulk-replace these names, or rename an existing installation's data by hand: setup and the server do that.

## What changed in the branding cleanup

- Outbound HTTP clients identify the product as `Vibe/<server version>`, through one shared User-Agent constant.
  This includes metadata, artwork, podcasts, notifications, webhooks, IPTV and tuner/guide clients. A provider's
  explicitly configured User-Agent still wins; an existing saved override is not overwritten.
- DLNA discovery advertises Vibe first and retains a Kinora product token for already-installed Roku clients.
  The updated Roku scanner accepts Vibe as well as either former name. A Vibe-only server advertisement would make
  older Roku apps stop discovering it.
- New backup downloads are named `vibe-<timestamp>-<reason>.tar.gz`. Existing `mediamax-…` archives remain listed,
  downloadable and deletable through the same API. Archives hold the database as `vibe.db` (`mediamax.db` in older ones; both restore).
  This filename change does not address the separately documented restore-safety QA findings.
- Network examples use Vibe router/backend labels and let you choose the upstream address. The standard Docker
  Compose file uses `vibe:8484`; the deploy kit still uses `mediamax:8484`. The example target does not rename a
  running container or change a saved reverse-proxy configuration.
- Sign-in example URLs/groups and example sender addresses use Vibe. The help article's incorrect Linux service
  data path is now `/var/lib/vibe`.
  New Unraid SSD examples use `/mnt/cache/appdata/vibe`.

## Server install names (moved to Vibe)

Server installs now use Vibe names throughout. Upgrading moves an existing install over; nothing has to be renamed
by hand, and the former names keep working where something outside Vibe may still use them.

| Installation or file | Now | How an existing install is moved |
| --- | --- | --- |
| Windows executable | `vibe.exe` (with `VibeTray.exe`) | Setup and `install-service.ps1` remove the old `kinora.exe`. |
| Windows service task | `Vibe` (boot-time service mode) | The old `Kinora` / `MediaMax` task is removed and the `Vibe` task registered with the same account. A task that ran as a Windows account needs that account's password once (`install-service.ps1 -User …`). |
| Windows registry | `HKLM\SOFTWARE\Vibe` (`ServiceMode`, `ServiceUser`, `UpdateRepo`) | Setup copies the values from `SOFTWARE\Kinora` and deletes that key. The server, tray app and updater also read the old key. |
| Windows firewall rules | `Vibe (HTTP <port>)`, `Vibe (DLNA discovery)` | The `Kinora*` / `MediaMax*` rules are replaced. |
| Windows program folder | `C:\Program Files\Vibe`; an install in `C:\Program Files\Kinora` is upgraded where it is | Not moved: the uninstaller and updater are registered for that folder. |
| Windows data | `%ProgramData%\Vibe` | With Vibe stopped, setup and `install-service.ps1` rename `%ProgramData%\Kinora` (or `\MediaMax`). If Windows refuses, the old folder stays and is used. |
| Linux standalone | executable `vibe`, unit `vibe.service`, user `vibe`, `/opt/vibe`, `/var/lib/vibe`, `~/.local/share/vibe` | An unmoved `kinora` / `mediamax` folder is used until it is moved; see `packaging/linux/README.txt`. |
| Database and log | `vibe.db`, `logs/vibe.log` | The server renames `mediamax.db` on its first start (after folding in its write-ahead log). Backups now hold `vibe.db`; older backups holding `mediamax.db` restore normally. |
| Environment variables | `VIBE_*` | `KINORA_*` and `MEDIAMAX_*` still work; `VIBE_*` wins, then `KINORA_*`. |
| Docker data | `/config` inside the container | Unchanged: the volume mapping decides where data lives. |
| Deploy kit | New installs use `/opt/vibe`; containers, network, `.env` keys and security configs keep `mediamax` names | Not changed here: the proxy, fail2ban and CrowdSec configuration depend on those names together. |
| GitHub repository | `Bucifer6/MediaMax` | Not renamed: downloads, updates and documentation use this URL. |

Not supported: installing a release from before this change over a migrated install. It would look for
`%ProgramData%\Kinora` and `mediamax.db` and start with an empty library. Restore a backup instead.

## Persistent application and integration identifiers

| Identifier | Retained names and reason |
| --- | --- |
| Mobile store identity | `uk.burdujeni82.kinora`, Expo slug `kinora`, and corresponding TV app IDs. Changing published IDs normally creates a separate app instead of an upgrade. |
| Deep links | `kinora://` and `mediamax://`. Existing sign-in, pairing and external-player links must keep opening installed apps. |
| Client/API headers | `X-Kinora-*`, with `X-MediaMax-*` support. Existing clients continue to authenticate and report device identity. |
| Package/import names | `@mediamax/*`, native namespaces and internal client class names. They are build contracts. A cosmetic partial rename would break imports or native linking. |
| Saved themes | IDs `mediamax` and `mediamax-light`; displayed as Vibe Rose and Vibe Rose Light. Keeping the IDs retains selected themes and viewer preferences. |
| Browser/mobile/Roku storage | Keys and registry sections containing `mediamax` or `Kinora`. Changing them without migration would lose saved server addresses, sessions, preferences or downloads. |
| Home Assistant/MQTT | Existing `mediamax` topic base and discovery identities. Renaming them can create duplicate entities or break automations. Administrators can explicitly configure a different topic base. |
| Protocol payload identifiers | Subsonic server type and webhook format value `mediamax`, importer client IDs and other stable keys. These are machine-readable values, even where the displayed product is Vibe. |
| Scan-ignore files | `.mediamaxignore`. Existing libraries rely on the marker to exclude folders. |

## Third-party registrations

Some outbound clients keep the name a service has them registered under: the OpenSubtitles and subs.ro
User-Agent (`Kinora v<version>`) and the Trakt client. Changing those needs a new registration with that service.

Historical review documents, fixtures and migration tests also retain the old names because those names are the
inputs they describe or verify.
