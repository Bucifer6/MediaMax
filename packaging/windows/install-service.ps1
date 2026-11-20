<#
.SYNOPSIS
  Installs MediaMax to start at boot in the background (Windows Task Scheduler, running as SYSTEM).

.DESCRIPTION
  Run from an elevated PowerShell, in the folder you extracted the MediaMax zip to:

      powershell -ExecutionPolicy Bypass -File .\install-service.ps1

  The script:
    1. copies mediamax.exe, ffmpeg, ffprobe and the web app into -InstallDir (default C:\Program Files\MediaMax),
       a folder only administrators can change. A task that runs as SYSTEM must never start a program
       from a folder ordinary users can write to (such as Downloads);
    2. registers a scheduled task "MediaMax" that starts at boot as SYSTEM, has no run-time limit, and is
       started again within 5 minutes if it ever exits (to stop it for good: Disable-ScheduledTask MediaMax);
    3. opens the port in Windows Firewall (TCP, plus UDP 1900 for DLNA discovery);
    4. starts it now.

  Run it again from a newer zip to upgrade: it stops the task, replaces the program files and starts it
  again. Data (database, artwork, logs) lives in %ProgramData%\MediaMax and is never touched.

  Uses only what ships with Windows (Task Scheduler and Windows Firewall); no service wrapper.

.PARAMETER Uninstall
  Stops and removes the task and the firewall rules, and deletes -InstallDir. Data in %ProgramData%\MediaMax
  is kept unless -RemoveData is also given.

.PARAMETER Port
  HTTP port (default 8484). A non-default port is stored in the machine environment variable MEDIAMAX_PORT.

.PARAMETER AllNetworkProfiles
  Also open the firewall on networks Windows classifies as Public. By default only Private and Domain
  networks are opened.

.EXAMPLE
  .\install-service.ps1
.EXAMPLE
  .\install-service.ps1 -Port 9000 -AllNetworkProfiles
.EXAMPLE
  .\install-service.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [switch]$Uninstall,
  [switch]$RemoveData,
  [ValidateRange(1, 65535)][int]$Port = 8484,
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'MediaMax'),
  [switch]$AllNetworkProfiles
)

$ErrorActionPreference = 'Stop'
$TaskName = 'MediaMax'
$RuleName = 'MediaMax'
$DataDir = if ($env:MEDIAMAX_DATA) { $env:MEDIAMAX_DATA } else { Join-Path $env:ProgramData 'MediaMax' }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'Please run this script as Administrator (right-click PowerShell > Run as administrator).' -ForegroundColor Red
  exit 1
}

function Stop-MediaMax {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }
  # Also stop copies started by hand (MediaMax.cmd) from the install folder, so files can be replaced.
  $exe = Join-Path $InstallDir 'mediamax.exe'
  Get-Process -Name 'mediamax' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and ($_.Path -ieq $exe) } |
    Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

function Remove-FirewallRules {
  Get-NetFirewallRule -DisplayName "$RuleName*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
}

if ($Uninstall) {
  Stop-MediaMax
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'."
  }
  Remove-FirewallRules
  Write-Host 'Removed firewall rules.'
  if ([Environment]::GetEnvironmentVariable('MEDIAMAX_PORT', 'Machine')) {
    [Environment]::SetEnvironmentVariable('MEDIAMAX_PORT', $null, 'Machine')
  }
  $here = (Resolve-Path $PSScriptRoot).Path.TrimEnd('\')
  if (Test-Path $InstallDir) {
    if ($here -ieq (Resolve-Path $InstallDir).Path.TrimEnd('\')) {
      Write-Host "Leaving $InstallDir in place (this script is running from it). Delete the folder by hand."
    } else {
      Remove-Item -Recurse -Force $InstallDir
      Write-Host "Removed $InstallDir."
    }
  }
  if ($RemoveData) {
    if (Test-Path $DataDir) { Remove-Item -Recurse -Force $DataDir; Write-Host "Removed data in $DataDir." }
  } else {
    Write-Host "Your data is kept in $DataDir (use -RemoveData to delete it)."
  }
  exit 0
}

$source = (Resolve-Path $PSScriptRoot).Path.TrimEnd('\')
if (-not (Test-Path (Join-Path $source 'mediamax.exe'))) {
  Write-Host "mediamax.exe was not found next to this script ($source)." -ForegroundColor Red
  exit 1
}

# 1. Program files.
Stop-MediaMax
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$target = (Resolve-Path $InstallDir).Path.TrimEnd('\')
if ($source -ine $target) {
  if (Test-Path (Join-Path $target 'web')) { Remove-Item -Recurse -Force (Join-Path $target 'web') }
  Copy-Item -Path (Join-Path $source '*') -Destination $target -Recurse -Force
  Write-Host "Installed MediaMax to $target."
}
$exe = Join-Path $target 'mediamax.exe'
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

# 2. Port (only stored when it differs from the default, so a plain install changes no environment).
if ($Port -ne 8484) {
  [Environment]::SetEnvironmentVariable('MEDIAMAX_PORT', "$Port", 'Machine')
} elseif ([Environment]::GetEnvironmentVariable('MEDIAMAX_PORT', 'Machine')) {
  [Environment]::SetEnvironmentVariable('MEDIAMAX_PORT', $null, 'Machine')
}

# 3. Scheduled task: at boot, as SYSTEM, no time limit. Task Scheduler's "restart on failure" only covers a
#    launch that fails, so a second trigger re-checks every 5 minutes; with MultipleInstances IgnoreNew it
#    does nothing while MediaMax runs and starts it again if it has exited.
$action = New-ScheduledTaskAction -Execute $exe -WorkingDirectory $target
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5)
$trigger = @((New-ScheduledTaskTrigger -AtStartup), $watchdog)
$runAs = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $runAs -Settings $settings `
  -Description 'MediaMax media server (installed by install-service.ps1)' -Force | Out-Null
Write-Host "Registered scheduled task '$TaskName' (starts at boot as SYSTEM)."

# 4. Firewall.
Remove-FirewallRules
$profiles = if ($AllNetworkProfiles) { 'Any' } else { 'Domain,Private' }
New-NetFirewallRule -DisplayName "$RuleName (HTTP $Port)" -Direction Inbound -Action Allow -Protocol TCP `
  -LocalPort $Port -Program $exe -Profile $profiles | Out-Null
New-NetFirewallRule -DisplayName "$RuleName (DLNA discovery)" -Direction Inbound -Action Allow -Protocol UDP `
  -LocalPort 1900 -Program $exe -Profile $profiles | Out-Null
Write-Host "Opened TCP $Port and UDP 1900 in Windows Firewall ($profiles networks)."

# 5. Start now and wait for it to answer.
Start-ScheduledTask -TaskName $TaskName
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$Port/health" | Out-Null
    $ok = $true
    break
  } catch { Start-Sleep -Seconds 1 }
}
if ($ok) {
  Write-Host "MediaMax is running: http://localhost:$Port/" -ForegroundColor Green
} else {
  Write-Host "MediaMax did not answer yet. Check the logs in $DataDir\logs and Task Scheduler > '$TaskName'." -ForegroundColor Yellow
}
Write-Host "Data folder: $DataDir"
