@echo off
rem Starts MediaMax (if it isn't running already) and opens it in your browser.
rem To start MediaMax at boot without anyone signed in, run install-service.ps1 instead.
setlocal
cd /d "%~dp0"
if "%MEDIAMAX_PORT%"=="" set "MEDIAMAX_PORT=8484"
set "URL=http://localhost:%MEDIAMAX_PORT%/"
set "PING=try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:%MEDIAMAX_PORT%/health' | Out-Null; exit 0 } catch { exit 1 }"

powershell -NoProfile -Command "%PING%"
if %errorlevel%==0 goto open

rem Installed as a background task? Start that one, so the data stays owned by the same account.
schtasks /Query /TN "MediaMax" >nul 2>&1
if %errorlevel%==0 (
  schtasks /Run /TN "MediaMax" >nul 2>&1
  if errorlevel 1 (
    echo MediaMax is installed as a background task but is not running.
    echo Start it from an administrator prompt with:  schtasks /Run /TN MediaMax
    pause
    exit /b 1
  )
) else (
  echo Starting MediaMax. Close the "MediaMax server" window to stop it.
  start "MediaMax server" /min "%~dp0mediamax.exe"
)

echo Waiting for MediaMax to start...
powershell -NoProfile -Command "for ($i = 0; $i -lt 60; $i++) { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:%MEDIAMAX_PORT%/health' | Out-Null; exit 0 } catch { Start-Sleep -Milliseconds 500 } }; exit 1"
if errorlevel 1 (
  echo MediaMax did not start. Look at the "MediaMax server" window or the logs in %ProgramData%\MediaMax\logs.
  pause
  exit /b 1
)

:open
start "" "%URL%"
endlocal
