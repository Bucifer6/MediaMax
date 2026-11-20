MediaMax for Windows (64-bit)
=============================
Version @VERSION@

Everything MediaMax needs is in this folder. Nothing else has to be installed.

  mediamax.exe          the server (Node.js is built in)
  web\                  the web app it serves (keep it next to mediamax.exe)
  ffmpeg.exe, ffprobe.exe   FFmpeg, used for transcoding, thumbnails and live TV
  MediaMax.cmd          starts MediaMax and opens it in your browser
  install-service.ps1   runs MediaMax at boot in the background (Task Scheduler, as SYSTEM)
  LICENSE.txt           MediaMax licence (MIT). FFmpeg is GPL: see FFMPEG-LICENSE.txt.

Full guide (Docker, NAS units, upgrades, backups): https://github.com/Bucifer6/MediaMax/blob/main/docs/INSTALL.md


Try it
------
Double-click MediaMax.cmd. A minimised "MediaMax server" window starts and your browser opens
http://localhost:8484 where the setup wizard runs. Close that window to stop MediaMax.

Windows SmartScreen may warn about an unrecognised app the first time: choose "More info" > "Run anyway".
If Windows Firewall asks, allow access on private networks so other devices can connect.


Run at boot (recommended for a home server)
-------------------------------------------
1. Extract this zip somewhere (for example your Downloads folder).
2. Open PowerShell as Administrator in that folder and run:

     powershell -ExecutionPolicy Bypass -File .\install-service.ps1

This copies MediaMax to C:\Program Files\MediaMax, registers a "MediaMax" scheduled task that starts at
boot as SYSTEM (no sign-in needed) and opens TCP 8484 (and UDP 1900 for DLNA) in Windows Firewall.
Options: -Port 9000, -AllNetworkProfiles (also open the firewall on "Public" networks).

  Stop:       Disable-ScheduledTask MediaMax; Stop-ScheduledTask MediaMax
  Start:      Enable-ScheduledTask MediaMax; Start-ScheduledTask MediaMax
  Uninstall:  .\install-service.ps1 -Uninstall          (add -RemoveData to delete the data as well)

Running as SYSTEM, MediaMax cannot see drive letters mapped by a user. Add NAS folders as UNC paths
(\\nas\media\movies); the NAS must allow this computer's account, or share the folder read-only to everyone.


Upgrade
-------
Take a backup first (Admin > Backups). Then extract the new zip and run install-service.ps1 from it
again: it stops MediaMax, replaces the program files and starts it. Without the task, just replace
the files in this folder.


Where the data lives
--------------------
%ProgramData%\MediaMax (usually C:\ProgramData\MediaMax): database, artwork, branding, logs, backups.
Set the environment variable MEDIAMAX_DATA to use another folder.

Other settings (environment variables): MEDIAMAX_PORT, MEDIAMAX_TRANSCODE_DIR, MEDIAMAX_RECORDINGS,
MEDIAMAX_FFMPEG / MEDIAMAX_FFPROBE (default: the copies in this folder), MEDIAMAX_WEB_DIR.
