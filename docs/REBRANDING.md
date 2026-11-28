# Vibe names and compatibility

Vibe was previously called Kinora and MediaMax. The display brand is Vibe; some filenames and identifiers still use
the older names so an upgrade opens the same database, keeps signed-in devices, updates the same store app and
continues to work with existing automation.

A search for the old names will therefore still return many results. They are not all missed display text. Do not
bulk-replace these names or rename an existing installation's data by hand.

## What changed in the branding cleanup

- Outbound HTTP clients identify the product as `Vibe/<server version>`, through one shared User-Agent constant.
  This includes metadata, artwork, podcasts, notifications, webhooks, IPTV and tuner/guide clients. A provider's
  explicitly configured User-Agent still wins; an existing saved override is not overwritten.
- DLNA discovery advertises Vibe first and retains a Kinora product token for already-installed Roku clients.
  The updated Roku scanner accepts Vibe as well as either former name. A Vibe-only server advertisement would make
  older Roku apps stop discovering it.
- New backup downloads are named `vibe-<timestamp>-<reason>.tar.gz`. Existing `mediamax-…` archives remain listed,
  downloadable and deletable through the same API. The database **inside** the archive retains its original name.
  This filename change does not address the separately documented restore-safety QA findings.
- Network examples use Vibe router/backend labels and let you choose the upstream address. The standard Docker
  Compose file uses `vibe:8484`; the deploy kit still uses `mediamax:8484`. The example target does not rename a
  running container or change a saved reverse-proxy configuration.
- Sign-in example URLs/groups and example sender addresses use Vibe. The help article's incorrect Linux service
  data path was corrected from `/var/lib/mediamax` to `/var/lib/kinora`, with older-path guidance retained.
  New Unraid SSD examples use `/mnt/cache/appdata/vibe`.

## File paths and process names you may still see

| Installation or file | Current behavior | Why the old name remains |
| --- | --- | --- |
| GitHub repository | `Bucifer6/MediaMax` | This is the real repository URL used by downloads, updates and documentation. The repository itself has not been renamed. |
| Windows program folder | New installer: `C:\Program Files\Vibe`; upgrades keep the existing program folder, including `C:\Program Files\Kinora`. | Moving an existing installation would affect the updater, shortcuts and background task. |
| Windows executable/task | `kinora.exe`, scheduled task `Kinora`, registry key `SOFTWARE\Kinora`; visible tray/launcher names are Vibe. | Existing updater and service registrations target those identifiers. |
| Windows data | `%ProgramData%\Kinora`; an earlier `%ProgramData%\MediaMax` folder is reused when appropriate. | The app must keep using the database containing existing accounts and libraries. |
| Linux standalone executable | `kinora`, inside a `vibe-<version>-linux-<arch>.tar.gz` release. | Service units and upgrade scripts target that executable. |
| Linux standalone data | `~/.local/share/kinora`, with fallback to the earlier `mediamax` data directory. | Keeps existing accounts, settings and watch history. |
| Linux systemd install | Unit/user `kinora`, `/var/lib/kinora`, executable `/opt/kinora/kinora`. Older data may remain in `/var/lib/mediamax`. | Stable service identity, permissions and filesystem ownership. `STATE_DIRECTORY` or an explicit data override can select another folder. |
| Docker data | `/config` inside the container; the host folder is the user's volume mapping. | The volume determines where the actual data lives. Rebranding does not move it. |
| Deploy-kit folder | New installs use `/opt/vibe`; an existing `/opt/kinora` or `/opt/mediamax` installation can be reused. | Upgrades must use the existing configuration and volumes. |
| Deploy-kit containers/network/config | Names such as `mediamax`, `mediamax-caddy`, `mediamax.env` and the `mediamax` network remain. | Proxy connections, environment files, access-control rules and upgrade commands depend on them. The separate root/NAS Compose templates use `vibe`. |
| Database and main log | `mediamax.db`, `mediamax.log`. | Existing data, diagnostics, watchdog and log consumers use these names. |
| Security files | `deploy/nginx/mediamax*.conf`, fail2ban filters/jails, CrowdSec parser/scenario and `mediamax-dashboard` machine names. | They form one connected protection/deployment configuration. Renaming only some files can disable bans or break proxy startup. |
| Native module folders | `apps/mobile/modules/mediamax-media`, `mediamax-car` and matching Swift/Kotlin module names. | The JavaScript and native bridge registrations must agree. These are source/build identities, not app display names. |

Custom data folders, `XDG_DATA_HOME`, service overrides and container mappings can change the paths above. Inspect
the running server's configured data directory before changing storage. An old folder can contain the current,
correct Vibe database.

## Persistent application and integration identifiers

| Identifier | Retained names and reason |
| --- | --- |
| Mobile store identity | `uk.burdujeni82.kinora`, Expo slug `kinora`, and corresponding TV app IDs. Changing published IDs normally creates a separate app instead of an upgrade. |
| Deep links | `kinora://` and `mediamax://`. Existing sign-in, pairing and external-player links must keep opening installed apps. |
| Client/API headers | `X-Kinora-*`, with `X-MediaMax-*` support. Existing clients continue to authenticate and report device identity. |
| Environment variables | `KINORA_*` is the documented prefix; `MEDIAMAX_*` is still supported. `KINORA_*` wins when both are set. A `VIBE_*` prefix is not currently implemented. |
| Package/import names | `@mediamax/*`, native namespaces and internal client class names. They are build contracts. A cosmetic partial rename would break imports or native linking. |
| Saved themes | IDs `mediamax` and `mediamax-light`; displayed as Vibe Rose and Vibe Rose Light. Keeping the IDs retains selected themes and viewer preferences. |
| Browser/mobile/Roku storage | Keys and registry sections containing `mediamax` or `Kinora`. Changing them without migration would lose saved server addresses, sessions, preferences or downloads. |
| Home Assistant/MQTT | Existing `mediamax` topic base and discovery identities. Renaming them can create duplicate entities or break automations. Administrators can explicitly configure a different topic base. |
| Protocol payload identifiers | Subsonic server type and webhook format value `mediamax`, importer client IDs and other stable keys. These are machine-readable values, even where the displayed product is Vibe. |
| Scan-ignore files | `.mediamaxignore`. Existing libraries rely on the marker to exclude folders. |

## Scope of a future complete filesystem rename

A complete internal rename needs a coordinated migration: recognize both generations, select the existing data
before creating a new folder, update services/updaters and ownership together, preserve old app/link/API aliases,
and test upgrade plus rollback on Windows, Linux, Docker and the native clients. It should be a distinct migration
release, rather than a text replacement. This cleanup does not move user data, rename the repository or change
published application IDs.

Historical review documents, fixtures and migration tests also retain the old names because those names are the
inputs they describe or verify.
