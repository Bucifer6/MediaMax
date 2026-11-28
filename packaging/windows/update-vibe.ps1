# Vibe updater for installs made with the Windows setup program.
#
# Setup registers this script as the on-demand "Vibe updater" scheduled task, running as SYSTEM, and lets any
# signed-in Windows user start that task (but not change it). So Admin -> Updates (Update now, or automatic updates)
# can install a new release without anyone at the server and without a Windows permission prompt, in tray app mode
# as well as background service mode.
#
#   update-vibe.ps1 -Register      create or refresh the task (setup does this; needs administrator rights)
#   update-vibe.ps1 -Unregister    remove it (the uninstaller does this)
#   update-vibe.ps1                what the task runs: install the release asked for, if it is newer
#
# What a user can influence is only WHICH version to install: the version in <data folder>\update-request.json.
# This script fetches that release from the GitHub repository (HKLM\SOFTWARE\Vibe UpdateRepo, which only an
# administrator can set, else Bucifer6/MediaMax), only from GitHub's own download host, downloads its setup program
# into this program folder (writable by administrators only), checks it against the release's SHA256SUMS.txt and
# runs it silently. It never installs an older or the same version. The outcome is written to updates\result.json
# in this program folder, where the server reads it.
param(
  [switch]$Register,
  [switch]$Unregister
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$TaskName = 'Vibe updater'
$AppId = '{6F1C3B52-8E4A-4C1D-9B7E-2A5D0C9E4F17}_is1'
$AppDir = $PSScriptRoot
$WorkDir = Join-Path $AppDir 'updates'
$ResultFile = Join-Path $WorkDir 'result.json'

if ($Unregister) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  exit 0
}

if ($Register) {
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings -Force `
    -Description 'Installs a new Vibe release when Admin > Updates asks for one (checked against the release SHA256SUMS.txt).' | Out-Null
  # Administrators and SYSTEM: full control. Authenticated users: read and run only (the tray app runs as the
  # signed-in user, and a service may run as a non-administrator account).
  $svc = New-Object -ComObject 'Schedule.Service'
  $svc.Connect()
  $svc.GetFolder('\').GetTask($TaskName).SetSecurityDescriptor('D:(A;;FA;;;BA)(A;;FA;;;SY)(A;;GRGX;;;AU)', 0)
  # The download folder: administrators and SYSTEM may write, everyone else may only read (the server reads result.json).
  New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
  exit 0
}

# ------------------------------ running as the task ------------------------------

function Write-Result([bool]$Ok, [string]$Version, [string]$Message) {
  New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
  [pscustomobject]@{ ok = $Ok; version = $Version; message = $Message; at = (Get-Date).ToUniversalTime().ToString('o') } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultFile -Encoding UTF8
}

# Semantic version order, as the server's compareSemver: 1.10.0 > 1.9.3 and 1.2.0-beta.1 < 1.2.0.
function Split-Semver([string]$V) {
  $V = ($V.Trim() -replace '^[vV]', '') -replace '\+.*$', ''
  $i = $V.IndexOf('-')
  if ($i -ge 0) { $core = $V.Substring(0, $i); $pre = $V.Substring($i + 1) } else { $core = $V; $pre = '' }
  $nums = @($core.Split('.') | ForEach-Object { [long]("0" + ($_ -replace '\D', '')) })
  while ($nums.Count -lt 3) { $nums += 0 }
  @{ Core = $nums; Pre = $pre }
}

function Compare-Semver([string]$A, [string]$B) {
  $x = Split-Semver $A; $y = Split-Semver $B
  for ($i = 0; $i -lt 3; $i++) { if ($x.Core[$i] -ne $y.Core[$i]) { return [Math]::Sign($x.Core[$i] - $y.Core[$i]) } }
  $xp = @(); if ($x.Pre) { $xp = $x.Pre.Split('.') }
  $yp = @(); if ($y.Pre) { $yp = $y.Pre.Split('.') }
  if ($xp.Count -eq 0 -and $yp.Count -eq 0) { return 0 }
  if ($xp.Count -eq 0) { return 1 }
  if ($yp.Count -eq 0) { return -1 }
  for ($i = 0; $i -lt [Math]::Max($xp.Count, $yp.Count); $i++) {
    if ($i -ge $xp.Count) { return -1 }
    if ($i -ge $yp.Count) { return 1 }
    $p = $xp[$i]; $q = $yp[$i]
    $pn = $p -match '^\d+$'; $qn = $q -match '^\d+$'
    if ($pn -and $qn) { if ([long]$p -ne [long]$q) { return [Math]::Sign([long]$p - [long]$q) }; continue }
    if ($pn -ne $qn) { if ($pn) { return -1 } else { return 1 } }
    $c = [string]::CompareOrdinal($p, $q)
    if ($c -ne 0) { return [Math]::Sign($c) }
  }
  return 0
}

# Same data folder rule as the server and install-service.ps1.
function Get-DataDir {
  $envKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
  foreach ($n in 'VIBE_DATA', 'KINORA_DATA', 'MEDIAMAX_DATA') {
    $v = (Get-ItemProperty -Path $envKey -Name $n -ErrorAction SilentlyContinue).$n
    if ($v) { return [Environment]::ExpandEnvironmentVariables($v) }
  }
  # %ProgramData%\Vibe; a folder still named Kinora or MediaMax (not yet moved by setup) is used as it is.
  foreach ($n in 'Vibe', 'Kinora', 'MediaMax') {
    $d = Join-Path $env:ProgramData $n
    if (Test-Path $d) { return $d }
  }
  Join-Path $env:ProgramData 'Vibe'
}

$requested = ''
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $installed = (Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$AppId" -Name DisplayVersion -ErrorAction SilentlyContinue).DisplayVersion
  if (-not $installed) { throw 'Vibe is not installed by the setup program on this computer.' }

  $repo = $null
  foreach ($k in 'HKLM:\SOFTWARE\Vibe', 'HKLM:\SOFTWARE\Kinora') {
    if (-not $repo) { $repo = (Get-ItemProperty -Path $k -Name UpdateRepo -ErrorAction SilentlyContinue).UpdateRepo }
  }
  if (-not $repo -or $repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { $repo = 'Bucifer6/MediaMax' }

  # The version the server asked for (only a version number is taken from this user-writable file).
  $requestFile = Join-Path (Get-DataDir) 'update-request.json'
  if (Test-Path -LiteralPath $requestFile) {
    try { $requested = [string]((Get-Content -LiteralPath $requestFile -Raw -ErrorAction Stop | ConvertFrom-Json).version) } catch { $requested = '' }
    Remove-Item -LiteralPath $requestFile -Force -ErrorAction SilentlyContinue
  }
  if ($requested -and $requested -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { throw "Not a version number: $requested" }

  $headers = @{ 'Accept' = 'application/vnd.github+json'; 'User-Agent' = "VibeUpdater/$installed" }
  $api = "https://api.github.com/repos/$repo/releases"
  $release = $null
  if ($requested) {
    foreach ($tag in "v$requested", $requested) {
      try { $release = Invoke-RestMethod -UseBasicParsing -Headers $headers -Uri "$api/tags/$tag" -TimeoutSec 60; break } catch { }
    }
    if (-not $release) { throw "Release $requested was not found in $repo." }
  } else {
    $release = Invoke-RestMethod -UseBasicParsing -Headers $headers -Uri "$api/latest" -TimeoutSec 60
  }
  if ($release.draft) { throw 'That release is a draft.' }
  $version = ([string]$release.tag_name) -replace '^[vV]', ''
  if ($version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { throw "Unexpected release tag $($release.tag_name)." }
  if ((Compare-Semver $version $installed) -le 0) {
    Write-Result $true $installed "Vibe $installed is already up to date (newest asked for: $version)."
    exit 0
  }

  $setupName = "vibe-$version-windows-x64-setup.exe"
  $setupAsset = $release.assets | Where-Object { $_.name -eq $setupName } | Select-Object -First 1
  $sumsAsset = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' } | Select-Object -First 1
  if (-not $setupAsset -or -not $sumsAsset) { throw "Release $version has no $setupName or SHA256SUMS.txt." }
  foreach ($a in $setupAsset, $sumsAsset) {
    if ($a.browser_download_url -notmatch '^https://github\.com/') { throw "Refusing to download $($a.name) from $($a.browser_download_url)." }
  }

  New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
  Get-ChildItem -LiteralPath $WorkDir -Filter '*.exe' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  $sums = (Invoke-WebRequest -UseBasicParsing -Headers @{ 'User-Agent' = $headers['User-Agent'] } -Uri $sumsAsset.browser_download_url -TimeoutSec 120).Content
  if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
  $expected = $null
  foreach ($line in ($sums -split "`r?`n")) {
    if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$' -and $Matches[2] -eq $setupName) { $expected = $Matches[1].ToLowerInvariant(); break }
  }
  if (-not $expected) { throw "SHA256SUMS.txt has no checksum for $setupName." }

  $setup = Join-Path $WorkDir $setupName
  Invoke-WebRequest -UseBasicParsing -Headers @{ 'User-Agent' = $headers['User-Agent'] } -Uri $setupAsset.browser_download_url -OutFile $setup -TimeoutSec 1800
  $got = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($got -ne $expected) {
    Remove-Item -LiteralPath $setup -Force -ErrorAction SilentlyContinue
    throw 'Checksum mismatch: the downloaded setup program does not match SHA256SUMS.txt. Nothing was installed.'
  }

  # /FROMUPDATER=1: setup leaves this task alone and does not start the tray app as SYSTEM (the server's helper starts
  # it again for the signed-in user). Setup stops Vibe, upgrades it in place and, in service mode, starts it again.
  $log = Join-Path $WorkDir 'setup.log'
  $p = Start-Process -FilePath $setup -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=`"$log`"", '/FROMUPDATER=1' -PassThru -WindowStyle Hidden
  $p.WaitForExit()
  Remove-Item -LiteralPath $setup -Force -ErrorAction SilentlyContinue
  if ($p.ExitCode -ne 0) { throw "The setup program for $version stopped with exit code $($p.ExitCode). See $log." }
  Write-Result $true $version "Installed Vibe $version."
  exit 0
} catch {
  $msg = $_.Exception.Message
  try { Write-Result $false $requested $msg } catch { }
  exit 1
}
