<#
.SYNOPSIS
  Installs Vibe to start at boot in the background (Windows Task Scheduler, running as SYSTEM).

.DESCRIPTION
  Run from an elevated PowerShell, in the folder you extracted the Vibe zip to:

      powershell -ExecutionPolicy Bypass -File .\install-service.ps1

  The script:
    1. copies vibe.exe, ffmpeg, ffprobe and the web app into -InstallDir (default C:\Program Files\Vibe, or C:\Program Files\Kinora if an earlier install is there),
       a folder only administrators can change. A task that runs as SYSTEM must never start a program
       from a folder ordinary users can write to (such as Downloads);
    2. registers a scheduled task "Vibe" that starts at boot as SYSTEM, has no run-time limit, and is
       started again within 5 minutes if it ever exits (to stop it for good: Disable-ScheduledTask Vibe);
    3. opens the port in Windows Firewall (TCP, plus UDP 1900 for DLNA discovery);
    4. starts it now.

  Run it again from a newer zip to upgrade: it stops the task, replaces the program files and starts it
  again. Data (database, artwork, logs) lives in %ProgramData%\Vibe. On a machine set up before the rename to Vibe
  the old %ProgramData%\Kinora (or %ProgramData%\MediaMax) folder is renamed to %ProgramData%\Vibe while Vibe is
  stopped, and the old "Kinora"/"MediaMax" task and firewall rules are replaced by the Vibe ones. If the folder
  cannot be renamed it is left where it is and used from there.

  Uses only what ships with Windows (Task Scheduler and Windows Firewall); no service wrapper.

.PARAMETER Uninstall
  Stops and removes the task and the firewall rules, and deletes -InstallDir. Data in %ProgramData%\Vibe
  is kept unless -RemoveData is also given.

.PARAMETER Port
  HTTP port (default 8484). A non-default port is stored in the machine environment variable VIBE_PORT
  (the server also reads the former KINORA_PORT and MEDIAMAX_PORT; VIBE_PORT wins).

.PARAMETER User
  Run the service as this Windows account (for example "nasuser", "PC-NAME\nasuser" or "DOMAIN\nasuser")
  instead of SYSTEM. Needed for network shares (\\nas\media) that ask for a username and password: SYSTEM
  connects as the computer and is usually refused, and has no mapped drive letters. The account's password is
  read from -PasswordFile, or asked for. Use an administrator account if Admin > Updates should be able to install
  updates by itself.

.PARAMETER PasswordFile
  A file holding the -User account's password (one line). It is deleted after reading.

.PARAMETER System
  Go back to running the service as SYSTEM. Without -User or -System, an existing install keeps its account.

.PARAMETER AllNetworkProfiles
  Also open the firewall on networks Windows classifies as Public. By default only Private and Domain
  networks are opened.

.EXAMPLE
  .\install-service.ps1
.EXAMPLE
  .\install-service.ps1 -Port 9000 -AllNetworkProfiles
.EXAMPLE
  .\install-service.ps1 -User nasuser
.EXAMPLE
  .\install-service.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [switch]$Uninstall,
  [switch]$RemoveData,
  [ValidateRange(1, 65535)][int]$Port = 8484,
  # Default: Program Files\Vibe, or Program Files\Kinora when an earlier install is already there (see below).
  [string]$InstallDir = '',
  [switch]$AllNetworkProfiles,
  [string]$User = '',
  [string]$PasswordFile = '',
  [switch]$System
)

$ErrorActionPreference = 'Stop'
if (-not $InstallDir) {
  $legacyDir = Join-Path $env:ProgramFiles 'Kinora'
  $InstallDir = if ((Test-Path (Join-Path $legacyDir 'vibe.exe')) -or (Test-Path (Join-Path $legacyDir 'kinora.exe'))) { $legacyDir } else { Join-Path $env:ProgramFiles 'Vibe' }
}
$TaskName = 'Vibe'
$RuleName = 'Vibe'
# Names used before the rename to Vibe: their task, firewall rules and processes are replaced.
$LegacyNames = 'Kinora', 'MediaMax'
$EnvNames = 'VIBE', 'KINORA', 'MEDIAMAX'

function Get-EnvSetting([string]$Name) {
  foreach ($p in $EnvNames) {
    $v = [Environment]::GetEnvironmentVariable("${p}_$Name")
    if ($v) { return $v }
  }
  return $null
}

# Same rule as the server (server/src/config.ts): VIBE_DATA (or KINORA_DATA / MEDIAMAX_DATA), else %ProgramData%\Vibe,
# else a folder still named Kinora or MediaMax.
$CustomData = Get-EnvSetting 'DATA'
function Find-DataDir {
  if ($CustomData) { return $CustomData }
  foreach ($n in @('Vibe') + $LegacyNames) {
    $d = Join-Path $env:ProgramData $n
    if (Test-Path $d) { return $d }
  }
  return Join-Path $env:ProgramData 'Vibe'
}
$DataDir = Find-DataDir

# Rename %ProgramData%\Kinora (or \MediaMax) to %ProgramData%\Vibe. Only while Vibe is stopped, and only when no Vibe
# folder exists yet; if Windows refuses (a file still open), the old folder stays in use.
function Move-LegacyData {
  if ($CustomData) { return }
  $new = Join-Path $env:ProgramData 'Vibe'
  if (Test-Path $new) { return }
  foreach ($n in $LegacyNames) {
    $old = Join-Path $env:ProgramData $n
    if (-not (Test-Path $old)) { continue }
    try {
      Rename-Item -LiteralPath $old -NewName 'Vibe' -ErrorAction Stop
      Write-Host "Moved the data folder $old to $new."
      $script:DataDir = $new
    } catch {
      Write-Host "Could not rename $old to $new ($($_.Exception.Message)); Vibe keeps using $old." -ForegroundColor Yellow
    }
    return
  }
}

function Clear-PortVariables {
  foreach ($p in $EnvNames) {
    $v = "${p}_PORT"
    if ([Environment]::GetEnvironmentVariable($v, 'Machine')) { [Environment]::SetEnvironmentVariable($v, $null, 'Machine') }
  }
}

# Tasks registered before the rename ("Kinora", "MediaMax").
function Get-LegacyTasks { foreach ($n in $LegacyNames) { Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue } }

# An install made before the rename: remove its task, firewall rules and processes (its data is moved, see above).
function Remove-LegacyInstall {
  foreach ($t in Get-LegacyTasks) {
    Stop-ScheduledTask -TaskName $t.TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $t.TaskName -Confirm:$false
    Write-Host "Removed the old '$($t.TaskName)' scheduled task."
  }
  Get-Process -Name 'kinora', 'mediamax' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  foreach ($n in $LegacyNames) { Get-NetFirewallRule -DisplayName "$n*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule }
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'Please run this script as Administrator (right-click PowerShell > Run as administrator).' -ForegroundColor Red
  exit 1
}

# The account an existing service runs as (kept on upgrade unless -User or -System says otherwise).
# A task from before the rename counts too: its account carries over to the new "Vibe" task.
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$legacyTask = Get-LegacyTasks | Select-Object -First 1
$existingUser = if ($existingTask) { $existingTask.Principal.UserId } elseif ($legacyTask) { $legacyTask.Principal.UserId } else { $null }
$isAccount = $existingUser -and $existingUser -notmatch '^(NT AUTHORITY\\)?SYSTEM$'

function Stop-Vibe {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }
  # Also stop copies started by hand (Vibe.cmd, the tray app) from the install folder, so files can be replaced.
  $dir = $InstallDir.TrimEnd('\')
  Get-Process -Name 'vibe', 'kinora' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and ((Split-Path $_.Path -Parent) -ieq $dir) } |
    Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

function Remove-FirewallRules {
  Get-NetFirewallRule -DisplayName "$RuleName (*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
}

if ($Uninstall) {
  Stop-Vibe
  foreach ($t in Get-LegacyTasks) { Unregister-ScheduledTask -TaskName $t.TaskName -Confirm:$false }
  foreach ($n in $LegacyNames) { Get-NetFirewallRule -DisplayName "$n*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule }
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'."
  }
  Remove-FirewallRules
  Write-Host 'Removed firewall rules.'
  Clear-PortVariables
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
if (-not (Test-Path (Join-Path $source 'vibe.exe'))) {
  Write-Host "vibe.exe was not found next to this script ($source)." -ForegroundColor Red
  exit 1
}

# A service from before the rename that runs as a Windows account: the new "Vibe" task needs that account's password.
if (-not $existingTask -and $legacyTask -and $isAccount -and -not $User -and -not $System) {
  Write-Host "The old '$($legacyTask.TaskName)' task runs as $existingUser. Run this script again with -User $existingUser" -ForegroundColor Red
  Write-Host '(and its password, or -PasswordFile), or with -System to run Vibe as SYSTEM. Nothing was changed.' -ForegroundColor Red
  exit 2
}

# 1. Program files.
Stop-Vibe
Remove-LegacyInstall
Move-LegacyData
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$target = (Resolve-Path $InstallDir).Path.TrimEnd('\')
if ($source -ine $target) {
  if (Test-Path (Join-Path $target 'web')) { Remove-Item -Recurse -Force (Join-Path $target 'web') }
  Copy-Item -Path (Join-Path $source '*') -Destination $target -Recurse -Force
  # Renamed in earlier releases: Kinora.cmd became Vibe.cmd, kinora.exe became vibe.exe.
  foreach ($old in 'Kinora.cmd', 'kinora.exe') { Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $target $old) }
  Write-Host "Installed Vibe to $target."
}
$exe = Join-Path $target 'vibe.exe'
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

# 2. Port (only stored when it differs from the default, so a plain install changes no environment).
Clear-PortVariables
if ($Port -ne 8484) {
  [Environment]::SetEnvironmentVariable('VIBE_PORT', "$Port", 'Machine')
}

# 3. Scheduled task: at boot, as SYSTEM (or -User), no time limit. Task Scheduler's "restart on failure" only covers a
#    launch that fails, so a second trigger re-checks every 5 minutes; with MultipleInstances IgnoreNew it
#    does nothing while Vibe runs and starts it again if it has exited.
$action = New-ScheduledTaskAction -Execute $exe -WorkingDirectory $target
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5)
$trigger = @((New-ScheduledTaskTrigger -AtStartup), $watchdog)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
$description = 'Vibe media server (installed by install-service.ps1)'
if ($User) {
  # A Windows account: its password is stored by Task Scheduler (Windows grants it "log on as a batch job"), so the
  # server can sign in to network shares as that account even when nobody is signed in.
  $plain = $null
  if ($PasswordFile) {
    $plain = (Get-Content -Raw -LiteralPath $PasswordFile).TrimEnd("`r", "`n")
    Remove-Item -Force -LiteralPath $PasswordFile -ErrorAction SilentlyContinue
  } else {
    $secure = Read-Host -AsSecureString "Password for $User"
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  }
  try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -User $User `
      -Password $plain -RunLevel Highest -Description $description -Force -ErrorAction Stop | Out-Null
  } catch {
    Write-Host "Could not register the service as '$User': $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Check the user name and password (for a Microsoft account, the account password, not the PIN).' -ForegroundColor Red
    exit 2
  } finally { $plain = $null }
  # The server writes its database, artwork and logs here as that account.
  & icacls $DataDir /grant "${User}:(OI)(CI)M" /T /C /Q | Out-Null
  Write-Host "Registered scheduled task '$TaskName' (starts at boot as $User)."
} elseif (-not $System -and $existingTask -and $isAccount) {
  # Upgrade of a service that runs as a Windows account: keep it (re-registering would need its password). The
  # program path is unchanged, so the task still starts the new version.
  Write-Host "Keeping scheduled task '$TaskName' (runs as $existingUser)."
} else {
  $runAs = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $runAs -Settings $settings `
    -Description $description -Force | Out-Null
  Write-Host "Registered scheduled task '$TaskName' (starts at boot as SYSTEM)."
}

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
  Write-Host "Vibe is running: http://localhost:$Port/" -ForegroundColor Green
} else {
  Write-Host "Vibe did not answer yet. Check the logs in $DataDir\logs and Task Scheduler > '$TaskName'." -ForegroundColor Yellow
}
Write-Host "Data folder: $DataDir"
