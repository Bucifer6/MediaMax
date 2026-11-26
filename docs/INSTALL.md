# Installing Vibe

Vibe is one server program that serves the web app, the API and the streams on **port 8484**. Install it
on the machine that holds (or can reach) your media, open `http://<that machine>:8484` in a browser and the
setup wizard creates the first administrator.

| You have | Use | Section |
|---|---|---|
| Synology, QNAP, Unraid, TrueNAS SCALE, OpenMediaVault | the Docker image | [NAS units](#nas-units) |
| A Linux server with Docker, reachable from the internet (HTTPS, CrowdSec/fail2ban) | the installer | [DEPLOY.md](DEPLOY.md) |
| Any Linux server with Docker | the Docker image | [Docker](#docker) |
| A Windows PC or server | the Windows installer | [Windows](#windows) |
| Linux without Docker (x64, or arm64 such as a Raspberry Pi 4/5 with a 64-bit OS) | the Linux archive | [Linux](#linux) |

Downloads are on the [Releases page](https://github.com/Bucifer6/MediaMax/releases/latest). The Windows and
Linux archives include FFmpeg; the Docker image includes [jellyfin-ffmpeg](https://github.com/jellyfin/jellyfin-ffmpeg)
(FFmpeg with the extra GPU tone-mapping and Rockchip support the hardware paths use) and Intel/AMD GPU drivers. The image is
`ghcr.io/bucifer6/vibe` for both `linux/amd64` and `linux/arm64`, tagged `latest` and with each version
(for example `0.2.0`).

Contents: [Docker](#docker) · [Windows](#windows) · [Linux](#linux) · [Synology](#synology) · [QNAP](#qnap) ·
[Unraid](#unraid) · [TrueNAS SCALE](#truenas-scale) · [OpenMediaVault](#openmediavault) ·
[Hardware transcoding](#hardware-transcoding) · [Where your data lives and backups](#where-your-data-lives-and-backups) ·
[Settings](#settings)

---

## Docker

> **Exposing Vibe to the internet?** `deploy/install.sh` sets up all of this plus HTTPS (Caddy or Nginx),
> CrowdSec or fail2ban and hardened defaults in one command; see **[DEPLOY.md](DEPLOY.md)**:
> `curl -fsSL https://raw.githubusercontent.com/Bucifer6/MediaMax/main/deploy/install.sh | sudo bash`

```yaml
# docker-compose.yml
services:
  vibe:
    image: ghcr.io/bucifer6/vibe:latest
    container_name: vibe
    restart: unless-stopped
    ports:
      - "8484:8484"
    environment:
      - PUID=1000            # user and group Vibe runs as (see below)
      - PGID=1000
      - TZ=Europe/London
    volumes:
      - ./config:/config                 # database, artwork, branding, logs, backups
      - ./recordings:/recordings         # DVR recordings
      - /path/to/movies:/media/movies:ro
      - /path/to/tv:/media/tv:ro
      - /path/to/music:/media/music:ro
    tmpfs:
      - /transcode:size=4G               # RAM disk for streaming segments
    # devices:
    #   - /dev/dri:/dev/dri              # Intel/AMD hardware transcoding
```

```bash
docker compose up -d
```

Or with plain Docker:

```bash
docker run -d --name vibe --restart unless-stopped -p 8484:8484 \
  -e PUID=1000 -e PGID=1000 -e TZ=Europe/London \
  -v /srv/vibe/config:/config -v /srv/vibe/recordings:/recordings \
  -v /srv/media:/media:ro \
  ghcr.io/bucifer6/vibe:latest
```

When you add a library in Vibe, use the path **inside** the container (`/media/movies`), not the host path.

**PUID / PGID.** With both set, Vibe runs as that user and group instead of root, so files it creates on
your shares (database, artwork, DVR recordings) belong to you, and it reads media with that user's rights. Find
the numbers with `id <username>` on the host. On start, the container gives `/config` to that user (once, when
the owner differs) and the top folder of `/recordings` and `/transcode`; it never changes the owner of your
media or existing recordings. It also joins the groups that own `/dev/dri` (and `/dev/nvidia0`) automatically, so
hardware transcoding keeps working. Add more groups (for example a group that may read a share) with
`KINORA_EXTRA_GIDS=1001,1002`. Leave both unset to run as root, as earlier images did. Docker's own
`user: "1000:1000"` also works; then `/config` must already be writable by that user.

**DLNA.** Smart TVs find DLNA servers by multicast, which does not cross Docker's bridge network. If you want
DLNA, replace `ports:` with `network_mode: host`.

**Upgrade.** Take a backup (Admin → Backups), then:

```bash
docker compose pull && docker compose up -d
```

To stay on a version, use a version tag (`ghcr.io/bucifer6/vibe:0.5.1`) instead of `latest`.

**Build it yourself** (also for arm64): `docker compose up -d --build` with the `docker-compose.yml` in the
repository, or `docker buildx build --platform linux/amd64,linux/arm64 -t vibe .`.

---

## Windows

Windows 10/11 or Server 2019+ (x64).

### Installer (recommended)

1. Download `vibe-<version>-windows-x64-setup.exe` from [Releases](https://github.com/Bucifer6/MediaMax/releases/latest)
   and run it. SmartScreen may warn about an unrecognised app the first time: **More info → Run anyway**.
2. Choose how Vibe should run:
   - **As a tray app** (default, for a PC you use): Vibe runs while you are signed in, with an icon next to the
     clock, and starts when you sign in (untick *Start Vibe when I sign in* to start it yourself from the Start menu).
     Double-click the icon to open Vibe; right-click it for *Restart server*, *Open data folder*, *Open logs*,
     *Start Vibe when I sign in* and *Exit*.
   - **As a background service** (for a home server): Vibe starts with Windows, before anyone signs in, as the
     **Kinora** task in Task Scheduler running as SYSTEM (the same setup as `install-service.ps1` below). If your
     media is on a NAS share that needs a password, enter a Windows account on the **Service account** page that
     follows: SYSTEM is usually refused by those shares and has no mapped drive letters. Add the share to a library by
     its network path (`\\nas\media`). Unattended: `/SERVICEUSER=nasuser /SERVICEPASSWORDFILE=C:\pw.txt` (the file is
     deleted).
3. Pick the port (default 8484). Setup opens it in Windows Firewall for Private/Domain networks (tick *Also allow
   connections on Public networks* to open it everywhere), adds a **Vibe** Start menu shortcut, and on the last page
   starts Vibe and opens the setup wizard in your browser.

**Upgrade:** press **Update now** on **Admin → Updates** when Vibe finds a new release (it checks GitHub every 12 hours),
or take a backup (Admin → Backups) and run the new setup yourself: it stops Vibe, replaces the program files,
keeps your choices and starts it again. It also takes over a folder set up by hand with the zip and
`install-service.ps1`. **Uninstall:** Settings → Apps → Vibe. It asks whether to delete your data as well (default:
keep it). You can switch between tray app and service by running setup again.

Unattended install: `vibe-<version>-windows-x64-setup.exe /VERYSILENT [/TASKS="service"] [/PORT=9000]`; uninstall
with `"C:\Program Files\Vibe\unins000.exe" /VERYSILENT` (keeps the data; older installs are in
`C:\Program Files\Kinora`).

### Portable zip

1. Download `vibe-<version>-windows-x64.zip` and extract it (right-click → Extract All).
2. **Try it:** double-click `Vibe.cmd`. It starts Vibe in a minimised window and opens your browser.
3. **Run at boot:** open PowerShell **as Administrator** in the extracted folder and run

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install-service.ps1
   ```

   This copies Vibe to `C:\Program Files\Vibe` (a folder only administrators can change; an earlier install in
   `C:\Program Files\Kinora` is updated where it is), registers a
   **Kinora** task (the name is kept from before the rename to Vibe) in Task Scheduler that starts at boot as SYSTEM without anyone signing in, opens TCP 8484 (and
   UDP 1900 for DLNA) in Windows Firewall for Private/Domain networks, and starts it. If Vibe ever exits,
   the task starts it again within 5 minutes. Options: `-Port 9000`, `-AllNetworkProfiles` (also open the
   firewall on networks Windows calls Public).

   It uses only Task Scheduler and Windows Firewall; there is no third-party service wrapper. Manage it in
   Task Scheduler, or:

   | | |
   |---|---|
   | Stop | `Disable-ScheduledTask Kinora; Stop-ScheduledTask Kinora` |
   | Start | `Enable-ScheduledTask Kinora; Start-ScheduledTask Kinora` |
   | Uninstall | `.\install-service.ps1 -Uninstall` (keeps your data; add `-RemoveData` to delete it) |

**Network shares.** Running as SYSTEM, Vibe can't see drive letters a user mapped. Add NAS folders as UNC
paths (`\\nas\media\movies`); the share must allow this computer's account (`DOMAIN\PCNAME$`) or guests to read.

**Upgrade (zip).** Back up (Admin → Backups), extract the new zip and run `install-service.ps1` from it again: it
stops Vibe, replaces the program files and starts it. Without the task, close Vibe and replace the files.

**Data:** `C:\ProgramData\Kinora` (`%ProgramData%\Kinora`), whether started by hand or by the task.

---

## Linux

For x64 and arm64 Linux with glibc 2.28 or newer (Debian 10+, Ubuntu 20.04+, RHEL/Rocky 8+, Raspberry Pi OS
64-bit). Nothing else to install: Node.js and FFmpeg are in the archive.

```bash
tar -xzf vibe-<version>-linux-x64.tar.gz      # or -linux-arm64
cd vibe-<version>-linux-x64
./kinora                                         # try it; Ctrl+C stops it
```

Run on its own like this, data goes to `~/.local/share/kinora`.

**Run at boot with systemd:**

```bash
sudo mkdir -p /opt/kinora && sudo cp -r ./* /opt/kinora/
sudo useradd --system --home-dir /var/lib/kinora --shell /usr/sbin/nologin kinora
sudo cp /opt/kinora/kinora.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kinora
```

The service runs as the dedicated `kinora` user, keeps its data in `/var/lib/kinora` (systemd creates it
with `StateDirectory=kinora`) and restarts on failure. Then:

- the `kinora` user needs read access to your media (for example `sudo setfacl -R -m u:kinora:rX /srv/media`,
  or add it to the group that owns the files);
- hardware transcoding: `sudo usermod -aG render,video kinora && sudo systemctl restart kinora`;
- logs: `journalctl -u kinora -f`;
- other settings: `sudo systemctl edit kinora` and add `Environment=KINORA_PORT=9000` under `[Service]`;
- firewall: `sudo ufw allow 8484/tcp` (or `firewall-cmd --add-port=8484/tcp --permanent && firewall-cmd --reload`).

**Upgrade:**

```bash
sudo systemctl stop kinora
sudo rm -rf /opt/kinora/web
sudo cp -r ./* /opt/kinora/       # from the new, extracted archive
sudo systemctl start kinora
```

**From source** (any OS with Node.js 22.5+ and FFmpeg on the PATH): `npm install && npm run build && npm start`.
Data then goes to `./data`.

---

## NAS units

Every NAS guide uses the Docker image with a ready-made compose file from the [`nas/`](../nas) folder. In all of
them: set **PUID/PGID** to the NAS user that owns your media (see [PUID / PGID](#docker)), map media folders
read-only, and add libraries using the container paths (`/media/...`).

### Synology

DSM 7.2 or newer with **Container Manager** (Package Center). Works on Intel and AMD "+" models and arm64
models that offer Container Manager. Template: [`nas/synology/docker-compose.yml`](../nas/synology/docker-compose.yml).

1. In **File Station**, create `docker/vibe` on `volume1` with the subfolders `config`, `transcode` and `recordings`.
2. Find your user's ids: **Control Panel → Terminal & SNMP → Enable SSH**, then `ssh you@nas` and `id you`.
   The first DSM user is usually `uid=1026`, group `users` is `100`. Use them as `PUID`/`PGID`. The user needs
   read permission on your media shared folders (Control Panel → Shared Folder → Edit → Permissions).
3. **Container Manager → Project → Create**: name `vibe`, path `/volume1/docker/vibe`, source
   **Create docker-compose.yml**, and paste the template. Change the `/volume1/...` media paths to your shared
   folders (for example `/volume1/video/Movies:/media/movies:ro`).
4. **Next → Done.** Container Manager pulls the image and starts it. Open `http://<nas>:8484`.

Hardware transcoding (Intel models with an iGPU, such as DS224+, DS423+, DS720+, DS920+, DS1520+): check
`ls -l /dev/dri` over SSH, uncomment the `devices:` lines, rebuild the project (**Action → Build**), then choose
**VA-API** (or **QSV**) in **Admin → Settings → Transcoding**. AMD Ryzen models (DS923+, DS1522+) have no GPU and
transcode in software. If FFmpeg reports `permission denied` on `/dev/dri/renderD128`, run once
`sudo chmod 666 /dev/dri/renderD128` (add it as a **Triggered Task** at boot in Task Scheduler, as root, since
DSM resets it on reboot).

Firewall: if the DSM firewall is on, allow TCP 8484. Reverse proxy / HTTPS: **Control Panel → Login Portal →
Advanced → Reverse Proxy** to `localhost:8484` (enable WebSocket headers under Custom Header), and set **Public
URL** in Admin → Settings.

Upgrade: **Container Manager → Project → vibe → Action → Stop**, then **Image → ghcr.io/bucifer6/vibe →
Update** (or **Action → Build** on the project, which pulls `latest` again), then **Start**.

### QNAP

QTS 5 / QuTS hero with **Container Station 3**. Template: [`nas/qnap/docker-compose.yml`](../nas/qnap/docker-compose.yml).

1. In **File Station**, create `Container/vibe` with `config`, `transcode` and `recordings`.
2. Find your ids over SSH: `id <username>` (users usually start at `1000`; the `everyone` group is `100`).
3. **Container Station → Applications → Create**, name `vibe`, paste the template, adjust the
   `/share/...` paths, **Validate**, then **Create**.
4. Open `http://<nas>:8484`.

Hardware transcoding on Intel models: uncomment `devices: - /dev/dri:/dev/dri`. Upgrade: **Applications →
vibe → ⋮ → Recreate** with "pull latest image" ticked (or edit the YAML to a new version tag).

### Unraid

Template: [`nas/unraid/vibe.xml`](../nas/unraid/vibe.xml) (Community Applications format).

1. Until Vibe is listed in **Apps**, copy the template to the flash drive as
   `/boot/config/plugins/dockerMan/templates-user/my-Vibe.xml` (for example with
   `wget -O /boot/config/plugins/dockerMan/templates-user/my-Vibe.xml https://raw.githubusercontent.com/Bucifer6/MediaMax/main/nas/unraid/vibe.xml`).
2. **Docker → Add Container → Template: Vibe**.
3. Check the paths: `/config` → `/mnt/user/appdata/vibe` (cache pool), `/media` → your media share,
   `/recordings`, and `/transcode` → `/tmp/vibe` (RAM). `PUID 99` / `PGID 100` (nobody/users) match Unraid's
   share permissions.
4. **Apply**, then **WebUI**.

Hardware transcoding: install **Intel GPU TOP** (Intel) or **Radeon TOP** (AMD) from Apps, then enter
`/dev/dri` in the template's **Intel/AMD GPU** field. For NVIDIA, install the **Nvidia Driver** plugin, add
`--runtime=nvidia` to **Extra Parameters** and the variables `NVIDIA_VISIBLE_DEVICES=all`,
`NVIDIA_DRIVER_CAPABILITIES=all`. Upgrade: **Docker → Check for Updates → apply update**.

### TrueNAS SCALE

TrueNAS SCALE 24.10 (Electric Eel) or newer, which runs apps on Docker. Template:
[`nas/truenas/docker-compose.yml`](../nas/truenas/docker-compose.yml).

1. **Datasets**: create `apps/vibe` (preset **Apps**) with child datasets `config` and `recordings`.
2. Ids: the template uses `568:568`, TrueNAS's built-in **apps** user. Give it read access to your media
   datasets (**Datasets → media → Permissions → Edit → Add item: User apps, Read**), or use your own user's ids.
3. **Apps → Discover Apps → ⋮ → Install via YAML**, name `vibe`, paste the template with your pool name
   instead of `tank`, **Save**.
4. Open `http://<truenas>:8484`.

GPU: Intel/AMD, uncomment `/dev/dri`. NVIDIA: **Apps → Configuration → Settings → Install NVIDIA Drivers**,
then uncomment the `deploy:` block. Upgrade: **Apps → vibe → Update** when offered, or **Edit** and pull.
On TrueNAS SCALE 24.04 and older (Kubernetes apps), use **Custom App** with image `ghcr.io/bucifer6/vibe`,
port 8484, the environment variables and host-path volumes from the template.

### OpenMediaVault

OMV 7 with **omv-extras** and the **openmediavault-compose** plugin. Template:
[`nas/openmediavault/docker-compose.yml`](../nas/openmediavault/docker-compose.yml).

1. **Storage → Shared Folders**: make sure you have folders for app data and media; note their absolute paths
   (`/srv/dev-disk-by-uuid-…/…`, shown in the shared folder list).
2. Ids: **Users → Users** shows the uid; `id <username>` in a shell. Typically `1000` and group `users` = `100`.
3. **Services → Compose → Files → Create**: name `vibe`, paste the template with your paths, **Save**, then
   select it and press **Up**.
4. Open `http://<omv>:8484`.

Upgrade: select the file and press **Pull**, then **Up**. Hardware transcoding: uncomment `/dev/dri`.

---

### NAS & disk spin-down

Vibe can leave NAS hard drives asleep while nobody is watching. Settings live in **Admin → Storage & disks**.

1. **Put Vibe's own files on an SSD.** The data folder (database, artwork cache, thumbnails, scrub previews, downloaded subtitles, backups) and the transcode folder are written all the time; keep them off the spinning array.
   * **Synology:** map `/config` (and `KINORA_TRANSCODE_DIR`) to a folder on an SSD volume, or at least a different volume from the media.
   * **Unraid:** use the cache pool — `/mnt/cache/appdata/vibe`, *not* `/mnt/user/appdata` (the FUSE user share can wake array disks). Set the appdata share to *Use cache pool: Only/Prefer*.
   * **TrueNAS SCALE:** put the app's config/transcode datasets on an SSD pool (or the apps pool), and media on the HDD pool.
   * **QNAP / OMV:** the same idea — config on the system SSD / cache volume.
2. **Don't poll.** File-change detection uses inotify on directories (no per-file watches, no polling) and never touches a sleeping disk. Only choose *Poll folder timestamps* for NFS/SMB mounts whose changes inotify cannot see, and keep the interval long (minimum 60 minutes). If inotify runs out of watches (very large libraries), raise `fs.inotify.max_user_watches` on the host (e.g. `sysctl fs.inotify.max_user_watches=524288`); the Storage page shows the error.
3. **Turn on disk-friendly mode** and pick a maintenance window (e.g. 02:00–05:00, server time — set `TZ` on Docker containers). Scheduled library scans, thumbnail and scrub-preview generation, intro detection, DJ analysis, OpenSubtitles matching and HDR detection then only start in the window (one at a time, scan first). Manual *Run now*, playback, the Home Assistant *Scan libraries* button and scans triggered by real file changes are never held back.
4. **Piggybacking** (on by default): when someone starts playing a file from a disk — or files change on it — Vibe runs that disk's share of the postponed work while the disk is spinning anyway. With disk-state checks, a disk something else woke up counts too.
5. **Disk-state awareness (Linux, optional):** Vibe maps each library folder to its block devices via `/proc/self/mountinfo` and `/sys` (partitions, md/Unraid array devices, LVM/LUKS). If `hdparm` or `smartctl` is installed and allowed (root, or `--device /dev/sdX` + `--cap-add SYS_RAWIO` in Docker), it asks `hdparm -C` / `smartctl -n standby`, which answer **without waking** the drive. Outside disk-friendly mode, scheduled work then skips sleeping disks and catches up when they wake. Without those tools the Storage page shows *Idle* (no I/O for 10 minutes, read from `/sys`) or *Unknown*; nothing breaks. ZFS pools, mergerfs/Unraid user shares and network shares are shown as one "disk" each with unknown state.
6. **Artwork next to media** (`poster.jpg`, `folder.jpg`…) is copied into the data folder the first time it is shown, so browsing never reads the media disk; rescans refresh the copy when the original changes.

Limits: a library scan walks the whole library (all of its folders), so on an Unraid user share a scan in the window spins up every disk the share spans — point libraries at `/mnt/user/...` only if you accept that, or use per-disk paths. Background jobs that are already running when the window ends are allowed to finish. Plugin tasks are not held to the window.

## Hardware transcoding

Software transcoding works everywhere. To use the GPU, give Vibe the device (see your platform below), then
open **Admin → Settings → Transcoding** and press **Detect hardware**. Vibe lists the GPUs it can see and the
encoders in its FFmpeg build, then runs a 2-second test transcode with every method: H.264, HEVC and AV1 encoding,
hardware decoding, 10-bit HEVC decoding and HDR → SDR tone mapping. Each card says what works (with the speed in fps)
or shows FFmpeg's error. Press **Use this** on the recommended card and **Save changes**. Results are saved
(`<data>/cache/hwdetect/report.json`) and reused after a restart as long as the transcoding device settings and the
FFmpeg build (`ffmpeg -version`) are unchanged; otherwise detection re-runs by itself in the background shortly after
start-up (set `KINORA_NO_HWDETECT=1` to turn that off). Press **Re-run detection** after changing drivers or devices.

The decode tests only pass when the GPU itself decoded (frames must come out of the hardware decoder), so
"Hardware decoding failed" on a card is real, not a guess. Intel GPUs that only have the low-power encoder (Jasper
Lake, Alder Lake-N / N100, Arc) are retried with `-low_power 1`; when that works, playback uses it too.

| Method | Platform | Hardware | Notes |
|---|---|---|---|
| `vaapi` | Linux | Intel (iHD/i965) and **AMD** (Mesa radeonsi) | AMD on Linux uses VA-API; the detect card says "VA-API (AMD Radeon)". Pick the render node if there are several. |
| `qsv` | Linux, Windows | Intel iGPU / Arc | Linux: through VA-API (`/dev/dri/renderD*`). Windows: through D3D11 (GPU index). |
| `nvenc` | Linux, Windows | NVIDIA GTX 10-series and newer | GPU index selects the card. GeForce drivers allow 8 encode sessions at once. |
| `amf` | Windows | AMD Radeon | `h264_amf` / `hevc_amf` / `av1_amf` with D3D11 decoding. |
| `videotoolbox` | macOS | Apple Silicon / Intel Macs | |
| `v4l2m2m` | Linux ARM | Raspberry Pi 4 | H.264 only, about one 1080p stream. The Pi 5 has **no** hardware encoder: use software. |
| `rkmpp` | Linux ARM | Rockchip RK3588/RK3568 | Needs an FFmpeg built with rkmpp/RGA (the Docker image's jellyfin-ffmpeg, or [ffmpeg-rockchip](https://github.com/nyanmisaka/ffmpeg-rockchip)); stock FFmpeg is detect-only. |

**HEVC and AV1 output.** With a hardware encoder, clients that can play HEVC (Safari, Chrome/Edge with HEVC
decoding, the iOS and Android apps) or AV1 get it instead of H.264, at about 65% (HEVC) / 60% (AV1) of the H.264
bitrate for the same quality. Those streams use fragmented-MP4 HLS segments, which these players need for HEVC/AV1;
H.264 stays on MPEG-TS. HEVC and AV1 are never encoded on the CPU. Set the order and turn them on or off under
**Preferred output codecs**, **Allow HEVC encoding** and **Allow AV1 encoding** (AV1 is off by default and needs
Intel Arc, NVIDIA RTX 40 or AMD RX 7000).

**HDR tone mapping on the GPU.** HDR sources are tone-mapped with `tonemap_vaapi` (VA-API, Intel only),
`vpp_qsv` (Quick Sync), `tonemap_cuda` (NVIDIA, jellyfin-ffmpeg builds) or `tonemap_opencl`, when the FFmpeg build
and driver support it; then with `libplacebo` (Vulkan) when the detect step saw it work; otherwise on the CPU
(`zscale` + `tonemap`, downscaling before the tone-map so 4K → 1080p stays real-time). `tonemap_opencl` uses the
BT.2390 curve only on builds that offer it (jellyfin-ffmpeg) and Hable on stock FFmpeg. Dolby Vision profile 5
sources prefer libplacebo, which applies the Dolby Vision reshaping. The detect step shows which path works.

**Interlaced sources** (1080i/576i TV recordings) are deinterlaced to full field rate on the GPU
(`deinterlace_vaapi`, `vpp_qsv`, `yadif_cuda`) or with `bwdif` on the CPU. This needs the file's field order,
which is recorded when a file is scanned, so rescan older interlaced recordings.

**Automatic fallback.** If a hardware transcode fails to start or dies in the first seconds, Vibe retries step by
step and logs why: CPU tone mapping instead of GPU tone mapping; H.264 instead of HEVC/AV1 on the same GPU (only
before anything was sent to the player); CPU decoding with the same GPU encoder; and finally fully in software. The
admin dashboard shows the reason on the session.

### Docker (Intel / AMD)

```yaml
services:
  vibe:
    devices:
      - /dev/dri:/dev/dri
    group_add:
      - "render"   # or the numeric id: stat -c %g /dev/dri/renderD128
      - "video"
```

With `PUID`/`PGID` set, the container joins the group that owns `/dev/dri/renderD*` at start by itself (see
PUID/PGID above), so `group_add` is only needed when you run it with Docker's own `user:`. Use the numeric group id
there if the host's render group name does not exist in the image. The image includes Intel's iHD and i965
drivers (amd64) and Mesa (all architectures), so Intel and AMD work without anything installed on the host besides the
kernel driver.

### Docker (NVIDIA)

Install the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
on the host, then:

```yaml
services:
  vibe:
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu, compute, video, utility]
```

(`docker run --gpus all -e NVIDIA_DRIVER_CAPABILITIES=compute,video,utility …` with plain Docker.) `video` enables
NVENC/NVDEC, `compute` the CUDA filters (`scale_cuda`, `yadif_cuda`, `tonemap_cuda`) and OpenCL, and `utility` provides
`nvidia-smi`, which must work inside the container for detection to find the GPU.

### Linux service

`sudo usermod -aG render,video kinora && sudo systemctl restart kinora`. Install the VA-API driver
(`intel-media-va-driver-non-free` or `mesa-va-drivers`) and optionally `vainfo` so detection can show the driver
name. NVIDIA: the proprietary driver (`nvidia-smi` must work).

### Synology, Unraid and other NAS units

- **Synology** (Intel models with an iGPU): map `/dev/dri` (see [Synology](#synology)). If the test says
  `permission denied` on `/dev/dri/renderD128`, run `sudo chmod 666 /dev/dri/renderD128` once (DSM resets it on
  reboot; add it as a boot-up Task). AMD Ryzen models have no GPU.
- **Unraid**: install **Intel GPU TOP** (Intel) or **Radeon TOP** (AMD), add the device `/dev/dri` to the
  container; for NVIDIA install the **Nvidia Driver** plugin, add `--runtime=nvidia` to Extra Parameters and set
  `NVIDIA_VISIBLE_DEVICES` (the GPU UUID) and `NVIDIA_DRIVER_CAPABILITIES=all`.
- **QNAP / TrueNAS / OpenMediaVault**: pass `/dev/dri` as above.

### Windows

Install the current GPU driver from NVIDIA, AMD (Adrenalin) or Intel (Arc & Iris Xe driver). The bundled FFmpeg
(BtbN build) includes NVENC, QSV, AMF and D3D11; nothing else is needed. With several GPUs, set the **GPU index**
(the order Windows lists them in Device Manager → Display adapters; Detect hardware shows each one).

### macOS

VideoToolbox works out of the box with Homebrew's FFmpeg.

### Raspberry Pi

Pi 4: `v4l2m2m` (H.264 encode, about one 1080p30 stream). In Docker add `--device /dev/video11` (encoder) and
`/dev/video10` (decoder) and the `video` group. Pi 5: software only (no hardware encoder); prefer direct play.

## Where your data lives and backups

| Install | Data folder |
|---|---|
| Docker / NAS | whatever you mapped to `/config` |
| Windows | `C:\ProgramData\Kinora` |
| Linux service | `/var/lib/kinora` |
| Linux, started by hand | `~/.local/share/kinora` |
| From source | `./data` |

`KINORA_DATA` overrides all of these. **Upgrading from MediaMax** (the product's former name): a standalone install
keeps using its existing folder (`C:\ProgramData\MediaMax`, `~/.local/share/mediamax`, or `/var/lib/mediamax` when
the Kinora folder holds no database yet) as long as the Kinora folder doesn't exist, so nothing has to be moved;
Docker and source installs use the folder you mapped / `./data` as before. The data folder holds the database (`mediamax.db`), artwork and branding
assets, avatars, subtitles, plugins, logs and `backups/`. Caches (`cache/`), streaming segments (`transcodes/`)
and your media are not needed for a restore. DVR recordings are wherever `KINORA_RECORDINGS` / `/recordings` points.

**Backups.** **Admin → Backups** creates a backup on demand or on a schedule (keeping the last N). A backup is
one `.tar.gz` in `<data>/backups/` with a consistent snapshot of the database plus artwork, branding, avatars,
subtitles and plugins; you can download it from the same page. Copy backups off the machine (Hyper Backup,
a NAS snapshot task, or any file backup of the `backups/` folder). To restore, upload or pick a backup on the same
page, then restart Vibe (`docker restart vibe`, `sudo systemctl restart kinora`, or on Windows
`Stop-ScheduledTask Kinora; Start-ScheduledTask Kinora`). The restore is applied as it starts, and a
"pre-restore" backup of what it replaced is kept.

**Moving to another machine or install type** (for example from Windows to a NAS): create a backup, install
Vibe on the new machine, restore the backup there and restart it. If the media lives at different paths
on the new machine, edit the libraries' folders in the admin dashboard.

## Settings

Environment variables (Docker `environment:`, `systemctl edit kinora`, or Windows system environment variables):

| Variable | Default | Purpose |
|---|---|---|
| `KINORA_PORT` | `8484` | HTTP port |
| `KINORA_DATA` | see above | Data folder |
| `KINORA_TRANSCODE_DIR` | `<data>/transcodes` (`/transcode` in Docker) | Streaming segment scratch space; a RAM disk is ideal |
| `KINORA_RECORDINGS` | `<data>/recordings` (`/recordings` in Docker) | DVR output |
| `KINORA_FFMPEG` / `KINORA_FFPROBE` | bundled copy next to the binary, else `ffmpeg` / `ffprobe` on the PATH | Use another FFmpeg (e.g. jellyfin-ffmpeg) |
| `KINORA_WEB_DIR` | `web/` next to the binary (`web/dist` from source) | Serve the web app from elsewhere |
| `KINORA_HWACCEL` | `none` | Initial hardware accelerator |
| `PUID` / `PGID` / `KINORA_EXTRA_GIDS` | unset (root) | Docker only: user, group and extra groups to run as |

Each variable also works under its original `MEDIAMAX_*` name (e.g. `MEDIAMAX_PORT`); when both are set, the
`KINORA_*` one wins. The full list is under "Configuration (environment variables)" in the
[README](../README.md#install).

## Play to devices

Every player's cast menu lists Chromecast, AirPlay (Safari / iOS) and the TVs, AV receivers, Sonos speakers and Kodi boxes on your
network. Pick one and Vibe streams straight to it: the original file when the device supports it, otherwise a converted
stream (H.264/AAC MPEG-TS for video, FLAC or MP3 for music). Your browser or phone becomes a remote (pause, seek, volume, stop),
and progress is saved as usual. Configure it in **Admin → Play to devices**.

* **Discovery** uses SSDP (UPnP) and mDNS on the local network, so in Docker use `network_mode: host`, like DLNA. If Vibe has
  several network cards or runs behind port mapping, set *Stream address for devices* to the URL devices should fetch from.
* **Kodi**: enable *Settings → Services → Control → Allow remote control via HTTP*. It is found automatically (mDNS) or can be
  added by host, port and the username/password set there.
* **Sonos** plays music only. Albums and playlists go to the Sonos queue; volume controls the whole group. Send to the group's
  coordinator if the speakers are grouped.
* **Security**: devices get signed, expiring, single-item links that only work from private addresses and only while that
  playback runs. Only admins can add devices by hand, and only on private addresses unless they allow otherwise.

## TV tuners and set-top boxes

Under **Admin → Live TV sources → Add source** you can also add your own broadcast hardware: a **TVHeadend** server, a **SAT>IP** server (Octopus NET, minisatip, AVM FRITZ!Box Cable…) or an **Enigma2** receiver (Vu+, Dreambox… with OpenWebif). Each has a *Test connection* button that shows the device, its tuner count and the channel count; TVHeadend and Enigma2 bring their own guide. Network discovery of SAT>IP servers and HDHomeRun tuners, and RTSP over UDP (FRITZ!Box), need host networking in Docker (`network_mode: host`). Details: [TUNERS.md](TUNERS.md).

## TV guide setup

Live TV needs a programme guide (EPG). Open **Admin → TV guide**:

1. **Guide sources → Add guide.** Pick one:
   - **XMLTV:** any guide URL or a file on the server (`.xml`, `.xml.gz`, `.xml.xz`). Most IPTV providers already include a guide; it appears here automatically as the provider guide.
   - **Free community guide:** iptv-org or epg.pw guides by country. These are free, volunteer-run services and their URLs can change.
   - **Schedules Direct:** a paid service (about $35 a year) with accurate listings, used by Plex, Channels DVR and MythTV. Enter your username and password, then add your lineup by country and postcode.
   - **HDHomeRun:** free guide data for HDHomeRun owners. Add the tuner as a Live TV source first, then pick it here.
   - TVHeadend and Enigma2 sources add their own guide automatically; SAT>IP sources need one of the guides above (an iptv-org guide for your country works well).
2. Set **priority** if you use more than one guide. The higher guide wins for each channel, and lower ones fill the gaps.
3. **Guide matching** shows how each channel was matched and how confident the match is. Accept the suggestions, or click the pencil icon to search every guide, preview now/next, and set a time shift for channels whose guide runs early or late. A whole guide in the wrong time zone has a time-zone override in its settings.

Channels without guide data get a **Missing guide** badge under Admin → Channels. Details: [EPG.md](EPG.md).

## Requests (replacing Overseerr / Jellyseerr)
Vibe has request management built in — you don't need a separate Overseerr or Jellyseerr.

1. **Admin → Server settings → General**: add a TMDB API key (movies/shows). **Media automation (*arr)**: add Radarr/Sonarr
   (and Lidarr/Readarr for music/books), press **Test**, pick quality profile and root folder. Mark a second Radarr/Sonarr as
   **4K** to offer 4K requests.
2. **Admin → Users → Default permissions**: choose what new users may request — per kind *No*, *Request* (needs approval) or
   *Auto* — and the default quota (e.g. 5 movies / 7 days, 6 seasons / 14 days). Change existing users individually or select
   several and use **Edit permissions**. Give trusted people **Manage requests** so they can approve without being admins.
3. **Admin → Server settings → Notifications**: add Discord, Telegram, ntfy, Gotify, Pushover, Slack, email or a JSON webhook,
   tick the events, press **Test**, then **Save changes**. Set the *Public URL* (General tab) so messages link back to Vibe.
4. People use **Discover** to request; managers approve on **Requests** (with **Edit** to change the server, profile, folder,
   tags or seasons first). Problems with a title are reported with the flag button on its page and handled under **Issues**.

Coming from Overseerr: the old per-server "auto-approve users" list and the 4K switch keep working for existing users until
you edit them; the old weekly limit becomes the default quota.

## Building the release archives yourself

```bash
npm ci && npm run build
node scripts/fetch-ffmpeg.mjs --target linux-x64 --out build/ffmpeg     # optional: static FFmpeg
node scripts/package.mjs --ffmpeg-dir build/ffmpeg                      # -> release/vibe-<version>-linux-x64.tar.gz
```

`scripts/package.mjs` bundles the server into one file with esbuild and turns it into a Node.js
[single executable application](https://nodejs.org/api/single-executable-applications.html). The web app and
FFmpeg sit next to the executable rather than inside it: the server serves the web app from disk and runs FFmpeg
as a separate program, so embedding them would mean unpacking them at every start. The release workflow
(`.github/workflows/release.yml`) builds the three archives on Windows, Linux x64 and Linux arm64 runners,
plus the Windows setup program (`scripts/build-installer.mjs`: Inno Setup, with the tray app in
`packaging/windows-installer`), smoke-tests each one, and publishes them with the multi-arch Docker image when a `v*` tag is pushed.

## Optional: AI DJ add-ons (free)

The AI DJ works with no extra setup. For richer requests and a more natural voice, run these free, open-source services next to the server. Pick the language model under **Admin → AI** (it is shared with Ask, recaps and subtitle translation) and the voice under **Admin → Server settings → AI DJ**:

```yaml
# Add to your docker-compose.yml next to the vibe service.
  ollama:                      # local language model (CPU is fine for small models)
    image: ollama/ollama
    volumes: [ "./ollama:/root/.ollama" ]
    restart: unless-stopped
  kokoro:                      # natural text-to-speech with an OpenAI-compatible API
    image: ghcr.io/remsky/kokoro-fastapi-cpu
    restart: unless-stopped
```

Then:

1. Run `docker compose exec ollama ollama pull llama3.2:3b`. A 3B model is enough for the DJ and Ask; for translating subtitles into Romanian use a larger model (e.g. `qwen2.5:7b` or `gemma2:9b`) or a hosted service.
2. In the AI DJ settings, choose **Ollama** and set the URL to `http://ollama:11434`.
3. Choose **Kokoro-FastAPI** and set the URL to `http://kokoro:8880/v1`.
4. Press **Test** on each.

**No spare CPU?** Use a hosted free tier instead (Groq, Google Gemini, OpenRouter's `:free` models, Mistral or Cerebras). Paste the API key and keep the **Daily limit** on, so you stay inside the free allowance. If you hit the limit, the DJ falls back to its built-in brain for the rest of the day.

**Piper** (another free, offline voice) runs inside the Vibe container:

1. Download the `piper` release for your CPU and a voice (`.onnx` plus `.onnx.json`) into `/config/voices/`.
2. Choose **Piper** in the AI DJ settings.
