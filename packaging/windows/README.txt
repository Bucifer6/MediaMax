Kinora for Windows (64-bit)
=============================
Version @VERSION@

Everything Kinora needs is in this folder. Nothing else has to be installed.

  kinora.exe            the server (Node.js is built in)
  web\                  the web app it serves (keep it next to kinora.exe)
  ffmpeg.exe, ffprobe.exe   FFmpeg, used for transcoding, thumbnails and live TV
  Kinora.cmd            starts Kinora and opens it in your browser
  install-service.ps1   runs Kinora at boot in the background (Task Scheduler, as SYSTEM)
  LICENSE.txt           Kinora licence (MIT). FFmpeg is GPL: see FFMPEG-LICENSE.txt.

Full guide (Docker, NAS units, upgrades, backups): https://github.com/Bucifer6/MediaMax/blob/main/docs/INSTALL.md


Try it
------
Double-click Kinora.cmd. A minimised "Kinora server" window starts and your browser opens
http://localhost:8484 where the setup wizard runs. Close that window to stop Kinora.

Windows SmartScreen may warn about an unrecognised app the first time: choose "More info" > "Run anyway".
If Windows Firewall asks, allow access on private networks so other devices can connect.


Run at boot (recommended for a home server)
-------------------------------------------
1. Extract this zip somewhere (for example your Downloads folder).
2. Open PowerShell as Administrator in that folder and run:

     powershell -ExecutionPolicy Bypass -File .\install-service.ps1

This copies Kinora to C:\Program Files\Kinora, registers a "Kinora" scheduled task that starts at
boot as SYSTEM (no sign-in needed) and opens TCP 8484 (and UDP 1900 for DLNA) in Windows Firewall.
Options: -Port 9000, -AllNetworkProfiles (also open the firewall on "Public" networks).

  Stop:       Disable-ScheduledTask Kinora; Stop-ScheduledTask Kinora
  Start:      Enable-ScheduledTask Kinora; Start-ScheduledTask Kinora
  Uninstall:  .\install-service.ps1 -Uninstall          (add -RemoveData to delete the data as well)

Running as SYSTEM, Kinora cannot see drive letters mapped by a user. Add NAS folders as UNC paths
(\\nas\media\movies); the NAS must allow this computer's account, or share the folder read-only to everyone.


Upgrade
-------
Take a backup first (Admin > Backups). Then extract the new zip and run install-service.ps1 from it
again: it stops Kinora, replaces the program files and starts it. Without the task, just replace
the files in this folder.


Where the data lives
--------------------
%ProgramData%\Kinora (usually C:\ProgramData\Kinora): database, artwork, branding, logs, backups.
A computer that ran MediaMax before keeps using %ProgramData%\MediaMax (as long as there is no
%ProgramData%\Kinora folder), so nothing has to be moved. Set the environment variable KINORA_DATA to
use another folder.

Other settings (environment variables): KINORA_PORT, KINORA_TRANSCODE_DIR, KINORA_RECORDINGS,
KINORA_FFMPEG / KINORA_FFPROBE (default: the copies in this folder), KINORA_WEB_DIR.
The original MEDIAMAX_* names still work; when both are set the KINORA_* one wins.
