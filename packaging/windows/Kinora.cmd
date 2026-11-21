@echo off
rem Starts Kinora (if it isn't running already) and opens it in your browser.
rem To start Kinora at boot without anyone signed in, run install-service.ps1 instead.
setlocal
cd /d "%~dp0"
rem KINORA_PORT wins over the original MEDIAMAX_PORT (both are read by the server).
set "KPORT=%KINORA_PORT%"
if "%KPORT%"=="" set "KPORT=%MEDIAMAX_PORT%"
if "%KPORT%"=="" set "KPORT=8484"
set "URL=http://localhost:%KPORT%/"
set "PING=try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:%KPORT%/health' | Out-Null; exit 0 } catch { exit 1 }"

powershell -NoProfile -Command "%PING%"
if %errorlevel%==0 goto open

rem Installed as a background task? Start that one, so the data stays owned by the same account.
schtasks /Query /TN "Kinora" >nul 2>&1
if %errorlevel%==0 (
  schtasks /Run /TN "Kinora" >nul 2>&1
  if errorlevel 1 (
    echo Kinora is installed as a background task but is not running.
    echo Start it from an administrator prompt with:  schtasks /Run /TN Kinora
    pause
    exit /b 1
  )
) else (
  echo Starting Kinora. Close the "Kinora server" window to stop it.
  start "Kinora server" /min "%~dp0kinora.exe"
)

echo Waiting for Kinora to start...
powershell -NoProfile -Command "for ($i = 0; $i -lt 60; $i++) { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:%KPORT%/health' | Out-Null; exit 0 } catch { Start-Sleep -Milliseconds 500 } }; exit 1"
if errorlevel 1 (
  echo Kinora did not start. Look at the "Kinora server" window or the logs in %ProgramData%\Kinora\logs (or %ProgramData%\MediaMax\logs after an upgrade).
  pause
  exit /b 1
)

:open
start "" "%URL%"
endlocal
