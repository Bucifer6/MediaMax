Vibe for Linux
================
Version @VERSION@

This folder holds everything Vibe needs. Nothing else has to be installed.

  vibe               the server (a single executable; Node.js is built in)
  web/               the web app it serves (keep it next to the executable)
  ffmpeg, ffprobe    static FFmpeg used for transcoding, thumbnails and live TV
  vibe.service       systemd unit to run Vibe at boot
  LICENSE            Vibe licence (MIT). FFmpeg is GPL: see FFMPEG-LICENSE.txt.

Full guide (Docker, NAS units, upgrades, backups): https://github.com/Bucifer6/MediaMax/blob/main/docs/INSTALL.md


Try it
------
  ./vibe

Then open http://<this machine>:8484 and follow the setup wizard. Data is stored in
~/.local/share/vibe (set VIBE_DATA to choose another folder). Stop with Ctrl+C.
If only ~/.local/share/kinora or ~/.local/share/mediamax exists (from before the rename to Vibe), that
folder is used as it is.


Install as a service (starts at boot)
-------------------------------------
  sudo mkdir -p /opt/vibe
  sudo cp -r ./* /opt/vibe/
  sudo useradd --system --home-dir /var/lib/vibe --shell /usr/sbin/nologin vibe
  sudo cp /opt/vibe/vibe.service /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now vibe

The service runs as the "vibe" user and keeps its data in /var/lib/vibe.
  Status and logs:   systemctl status vibe ; journalctl -u vibe -f
  Hardware transcoding (Intel/AMD):  sudo usermod -aG render,video vibe && sudo systemctl restart vibe
  Media folders must be readable by the vibe user.
  Firewall (if enabled):  sudo ufw allow 8484/tcp   or   sudo firewall-cmd --add-port=8484/tcp --permanent && sudo firewall-cmd --reload
  Settings (port, folders): sudo systemctl edit vibe, then add e.g.
      [Service]
      Environment=VIBE_PORT=9000


Upgrade
-------
  sudo systemctl stop vibe
  sudo rm -rf /opt/vibe/web
  sudo cp -r ./* /opt/vibe/
  sudo systemctl start vibe

Your data in /var/lib/vibe is kept. Take a backup first under Admin -> Backups.

Upgrading from kinora.service (or mediamax.service) of an earlier release: move the data and switch units.
  sudo systemctl disable --now kinora
  sudo useradd --system --home-dir /var/lib/vibe --shell /usr/sbin/nologin vibe
  sudo mv /var/lib/kinora /var/lib/vibe && sudo chown -R vibe:vibe /var/lib/vibe
  (then install vibe.service as above; /opt/kinora and /etc/systemd/system/kinora.service can be removed)
The server renames mediamax.db to vibe.db itself the first time it starts.


Settings
--------
  VIBE_DATA            data folder (database, caches, artwork, logs)
  VIBE_PORT            HTTP port (default 8484)
  VIBE_TRANSCODE_DIR   scratch space for streaming segments (default: <data>/transcodes)
  VIBE_RECORDINGS      DVR recordings folder (default: <data>/recordings)
  VIBE_FFMPEG / VIBE_FFPROBE   use a different FFmpeg (default: the one in this folder)
  VIBE_WEB_DIR         serve the web app from another folder (default: ./web)

The former KINORA_* and MEDIAMAX_* names still work; when more than one is set, VIBE_* wins.
