Vibe for Linux
================
Version @VERSION@

This folder holds everything Vibe needs. Nothing else has to be installed.

  kinora             the server (a single executable; Node.js is built in)
  web/               the web app it serves (keep it next to the executable)
  ffmpeg, ffprobe    static FFmpeg used for transcoding, thumbnails and live TV
  kinora.service     systemd unit to run Vibe at boot
  LICENSE            Vibe licence (MIT). FFmpeg is GPL: see FFMPEG-LICENSE.txt.

Full guide (Docker, NAS units, upgrades, backups): https://github.com/Bucifer6/MediaMax/blob/main/docs/INSTALL.md


Try it
------
  ./kinora

Then open http://<this machine>:8484 and follow the setup wizard. Data is stored in
~/.local/share/kinora (set KINORA_DATA to choose another folder). Stop with Ctrl+C.
If ~/.local/share/mediamax exists from an earlier MediaMax install (and ~/.local/share/kinora does not),
that folder is used, so nothing has to be moved.


Install as a service (starts at boot)
-------------------------------------
  sudo mkdir -p /opt/kinora
  sudo cp -r ./* /opt/kinora/
  sudo useradd --system --home-dir /var/lib/kinora --shell /usr/sbin/nologin kinora
  sudo cp /opt/kinora/kinora.service /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now kinora

The service runs as the "kinora" user and keeps its data in /var/lib/kinora.
  Status and logs:   systemctl status kinora ; journalctl -u kinora -f
  Hardware transcoding (Intel/AMD):  sudo usermod -aG render,video kinora && sudo systemctl restart kinora
  Media folders must be readable by the kinora user.
  Firewall (if enabled):  sudo ufw allow 8484/tcp   or   sudo firewall-cmd --add-port=8484/tcp --permanent && sudo firewall-cmd --reload
  Settings (port, folders): sudo systemctl edit kinora, then add e.g.
      [Service]
      Environment=KINORA_PORT=9000


Upgrade
-------
  sudo systemctl stop kinora
  sudo rm -rf /opt/kinora/web
  sudo cp -r ./* /opt/kinora/
  sudo systemctl start kinora

Your data in /var/lib/kinora is kept. Take a backup first under Admin -> Backups.

Upgrading from MediaMax: the old mediamax.service (user "mediamax", data in /var/lib/mediamax) keeps
working with the new binary: copy the files to /opt/mediamax and rename the executable in ExecStart, or
switch to kinora.service and move the data:
  sudo systemctl disable --now mediamax
  sudo useradd --system --home-dir /var/lib/kinora --shell /usr/sbin/nologin kinora
  sudo mv /var/lib/mediamax /var/lib/kinora && sudo chown -R kinora:kinora /var/lib/kinora
  (then install kinora.service as above)


Settings
--------
  KINORA_DATA            data folder (database, caches, artwork, logs)
  KINORA_PORT            HTTP port (default 8484)
  KINORA_TRANSCODE_DIR   scratch space for streaming segments (default: <data>/transcodes)
  KINORA_RECORDINGS      DVR recordings folder (default: <data>/recordings)
  KINORA_FFMPEG / KINORA_FFPROBE   use a different FFmpeg (default: the one in this folder)
  KINORA_WEB_DIR         serve the web app from another folder (default: ./web)

Every setting also works under its original MEDIAMAX_* name; when both are set, KINORA_* wins.
