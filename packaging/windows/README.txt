Vibe for Windows (64-bit)
=============================
Version @VERSION@

Everything Vibe needs is in this folder. Nothing else has to be installed.

Prefer a normal Windows installer (tray icon, Start menu, uninstaller)? Download
vibe-@VERSION@-windows-x64-setup.exe from the same Releases page instead of this zip.

  vibe.exe              the server (Node.js is built in)
  web\                  the web app it serves (keep it next to vibe.exe)
  ffmpeg.exe, ffprobe.exe   FFmpeg, used for transcoding, thumbnails and live TV
  Vibe.cmd            starts Vibe and opens it in your browser
  install-service.ps1   runs Vibe at boot in the background (Task Scheduler, as SYSTEM)
  LICENSE.txt           Vibe licence (MIT). FFmpeg is GPL: see FFMPEG-LICENSE.txt.

Full guide (Docker, NAS units, upgrades, backups): https://github.com/Bucifer6/MediaMax/blob/main/docs/INSTALL.md


Try it
------
Double-click Vibe.cmd. A minimised "Vibe server" window starts and your browser opens
http://localhost:8484 where the setup wizard runs. Close that window to stop Vibe.

Windows SmartScreen may warn about an unrecognised app the first time: choose "More info" > "Run anyway".
If Windows Firewall asks, allow access on private networks so other devices can connect.


Run at boot (recommended for a home server)
-------------------------------------------
1. Extract this zip somewhere (for example your Downloads folder).
2. Open PowerShell as Administrator in that folder and run:

     powershell -ExecutionPolicy Bypass -File .\install-service.ps1

This copies Vibe to C:\Program Files\Vibe (or updates an earlier install in C:\Program Files\Kinora), registers a "Vibe"
scheduled task that starts at boot as SYSTEM (no sign-in needed) and opens TCP 8484 (and UDP 1900 for DLNA) in Windows Firewall.
Options: -Port 9000, -AllNetworkProfiles (also open the firewall on "Public" networks),
-User nasuser (run as that Windows account instead of SYSTEM, for NAS shares that need a password; asks for
its password, or -PasswordFile pw.txt), -System (back to SYSTEM).

  Stop:       Disable-ScheduledTask Vibe; Stop-ScheduledTask Vibe
  Start:      Enable-ScheduledTask Vibe; Start-ScheduledTask Vibe
  Uninstall:  .\install-service.ps1 -Uninstall          (add -RemoveData to delete the data as well)

Running as SYSTEM, Vibe cannot see drive letters mapped by a user. Add NAS folders as UNC paths
(\\nas\media\movies); the NAS must allow this computer's account, or share the folder read-only to everyone.


Upgrade
-------
Take a backup first (Admin > Backups). Then extract the new zip and run install-service.ps1 from it
again: it stops Vibe, replaces the program files and starts it. Without the task, just replace
the files in this folder.


Where the data lives
--------------------
%ProgramData%\Vibe (usually C:\ProgramData\Vibe): database (vibe.db), artwork, branding, logs, backups.
Upgrading a computer set up before the rename to Vibe (Kinora or MediaMax) moves %ProgramData%\Kinora or
%ProgramData%\MediaMax to %ProgramData%\Vibe while Vibe is stopped, and replaces the old "Kinora" task and
firewall rules; the database is renamed from mediamax.db to vibe.db the first time the new version starts.
Set the environment variable VIBE_DATA to use another folder.

Other settings (environment variables): VIBE_PORT, VIBE_TRANSCODE_DIR, VIBE_RECORDINGS,
VIBE_FFMPEG / VIBE_FFPROBE (default: the copies in this folder), VIBE_WEB_DIR.
The former KINORA_* and MEDIAMAX_* names still work; when more than one is set the VIBE_* one wins.
