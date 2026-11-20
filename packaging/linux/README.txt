MediaMax @VERSION@ for Linux
===========================

This folder holds everything MediaMax needs. Nothing else has to be installed.

  mediamax           the server (a single executable; Node.js is built in)
  web/               the web app it serves (keep it next to the executable)
  ffmpeg, ffprobe    static FFmpeg used for transcoding, thumbnails and live TV
  mediamax.service   systemd unit to run MediaMax at boot
  LICENSE            MediaMax licence (MIT). FFmpeg is GPL: see FFMPEG-LICENSE.txt.

Full guide (Docker, NAS units, upgrades, backups): https://github.com/Bucifer6/MediaMax/blob/main/docs/INSTALL.md


Try it
------
  ./mediamax

Then open http://<this machine>:8484 and follow the setup wizard. Data is stored in
~/.local/share/mediamax (set MEDIAMAX_DATA to choose another folder). Stop with Ctrl+C.


Install as a service (starts at boot)
-------------------------------------
  sudo mkdir -p /opt/mediamax
  sudo cp -r ./* /opt/mediamax/
  sudo useradd --system --home-dir /var/lib/mediamax --shell /usr/sbin/nologin mediamax
  sudo cp /opt/mediamax/mediamax.service /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now mediamax

The service runs as the "mediamax" user and keeps its data in /var/lib/mediamax.
  Status and logs:   systemctl status mediamax ; journalctl -u mediamax -f
  Hardware transcoding (Intel/AMD):  sudo usermod -aG render,video mediamax && sudo systemctl restart mediamax
  Media folders must be readable by the mediamax user.
  Firewall (if enabled):  sudo ufw allow 8484/tcp   or   sudo firewall-cmd --add-port=8484/tcp --permanent && sudo firewall-cmd --reload
  Settings (port, folders): sudo systemctl edit mediamax, then add e.g.
      [Service]
      Environment=MEDIAMAX_PORT=9000


Upgrade
-------
  sudo systemctl stop mediamax
  sudo rm -rf /opt/mediamax/web
  sudo cp -r ./* /opt/mediamax/
  sudo systemctl start mediamax

Your data in /var/lib/mediamax is kept. Take a backup first under Admin -> Backups.


Settings
--------
  MEDIAMAX_DATA            data folder (database, caches, artwork, logs)
  MEDIAMAX_PORT            HTTP port (default 8484)
  MEDIAMAX_TRANSCODE_DIR   scratch space for streaming segments (default: <data>/transcodes)
  MEDIAMAX_RECORDINGS      DVR recordings folder (default: <data>/recordings)
  MEDIAMAX_FFMPEG / MEDIAMAX_FFPROBE   use a different FFmpeg (default: the one in this folder)
  MEDIAMAX_WEB_DIR         serve the web app from another folder (default: ./web)
