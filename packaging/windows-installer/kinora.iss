; Vibe for Windows: setup program (Inno Setup 6).
;
; Built by scripts/build-installer.mjs on the Windows release runner from the same files as the zip:
;   iscc /DAppVersion=0.5.0 /DNumericVersion=0.5.0.0 /DSourceDir=<unpacked zip> /DTrayExe=<VibeTray.exe>
;        /DOutputDir=release /DOutputBase=vibe-0.5.0-windows-x64-setup kinora.iss
;
; What it does (like other Windows media servers):
;   - installs to C:\Program Files\Vibe; an upgrade keeps the folder already in use (C:\Program Files\Kinora for
;     installs made before this default changed, including ones set up by hand with install-service.ps1);
;   - "Tray app" mode (default): VibeTray.exe runs the server for the signed-in user, shows an icon in the
;     notification area and starts at sign-in;
;   - "Background service" mode: the boot-time "Kinora" scheduled task running as SYSTEM (install-service.ps1),
;     for a headless home server;
;   - opens the port in Windows Firewall, adds Start menu (and optionally desktop) shortcuts, and an
;     uninstaller in Settings > Apps that keeps the library data unless asked to delete it.
; Data lives in %ProgramData%\Kinora (or %ProgramData%\MediaMax after an upgrade from MediaMax) in both modes.
;
; Silent install: vibe-<version>-windows-x64-setup.exe /VERYSILENT [/TASKS="service"] [/PORT=9000]

#ifndef AppVersion
  #error Pass /DAppVersion=x.y.z
#endif
#ifndef NumericVersion
  #define NumericVersion "0.0.0.0"
#endif
#ifndef SourceDir
  #error Pass /DSourceDir=<folder with kinora.exe>
#endif
#ifndef TrayExe
  #define TrayExe SourceDir + "\VibeTray.exe"
#endif
#ifndef OutputDir
  #define OutputDir "release"
#endif
#ifndef OutputBase
  #define OutputBase "vibe-" + AppVersion + "-windows-x64-setup"
#endif

[Setup]
AppId={{6F1C3B52-8E4A-4C1D-9B7E-2A5D0C9E4F17}
AppName=Vibe
AppVersion={#AppVersion}
AppVerName=Vibe {#AppVersion}
AppPublisher=Vibe
AppPublisherURL=https://github.com/Bucifer6/MediaMax
AppSupportURL=https://github.com/Bucifer6/MediaMax/issues
AppUpdatesURL=https://github.com/Bucifer6/MediaMax/releases/latest
VersionInfoVersion={#NumericVersion}
VersionInfoProductName=Vibe
VersionInfoDescription=Vibe media server setup
DefaultDirName={code:DefaultInstallDir}
DisableProgramGroupPage=yes
DisableDirPage=auto
DisableReadyPage=no
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
WizardStyle=modern
SetupIconFile=kinora.ico
UninstallDisplayIcon={app}\VibeTray.exe
UninstallDisplayName=Vibe
LicenseFile={#SourceDir}\LICENSE.txt
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBase}
Compression=lzma2/max
SolidCompression=yes
ChangesEnvironment=yes
; The installer stops Vibe itself (PrepareToInstall) before replacing files.
CloseApplications=no
SetupLogging=yes

[Messages]
WelcomeLabel2=This will install Vibe {#AppVersion}, your self-hosted media server, on this computer.%n%nIf Vibe (or MediaMax) is already installed it is upgraded in place; your library, users and settings are kept.

[Tasks]
Name: "tray"; Description: "As a tray app (recommended for a PC you use): runs while you are signed in, with an icon next to the clock"; GroupDescription: "How should Vibe run?"; Flags: exclusive
Name: "tray\autostart"; Description: "Start Vibe when I sign in"
Name: "service"; Description: "As a background service (for a home server): starts with Windows, before anyone signs in"; GroupDescription: "How should Vibe run?"; Flags: exclusive unchecked
Name: "publicfw"; Description: "Also allow connections on networks Windows calls Public"; GroupDescription: "Network:"; Flags: unchecked
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked

[InstallDelete]
; Old web app and help builds: their file names change with every release.
Type: filesandordirs; Name: "{app}\web"
Type: filesandordirs; Name: "{app}\help"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#TrayExe}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Vibe"; Filename: "{app}\VibeTray.exe"; Parameters: "--open"; WorkingDir: "{app}"; Comment: "Start Vibe and open it in your browser"
Name: "{autodesktop}\Vibe"; Filename: "{app}\VibeTray.exe"; Parameters: "--open"; WorkingDir: "{app}"; Comment: "Start Vibe and open it in your browser"; Tasks: desktopicon

[Run]
; Sign-in start is a per-user setting (HKCU Run), so set it as the user who started setup, not the elevated admin.
Filename: "{app}\VibeTray.exe"; Parameters: "--autostart on"; Flags: runasoriginaluser waituntilterminated; Tasks: tray\autostart
Filename: "{app}\VibeTray.exe"; Parameters: "--autostart off"; Flags: runasoriginaluser waituntilterminated; Tasks: not tray\autostart
Filename: "{app}\VibeTray.exe"; Parameters: "--open"; Description: "Start Vibe and open it in my browser"; Flags: postinstall nowait runasoriginaluser; Tasks: tray
Filename: "http://localhost:{code:GetPort}/"; Description: "Open Vibe in my browser"; Flags: postinstall shellexec nowait skipifsilent runasoriginaluser; Tasks: service

[Code]
const
  EnvKey = 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment';
  VibeKey = 'SOFTWARE\Kinora';
  TaskName = 'Kinora';

var
  PortPage: TInputQueryWizardPage;
  ServiceWasInstalled: Boolean;
  TasksPagePrepared: Boolean;

function PowerShell: String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

function RunHidden(const Exe, Params: String): Integer;
var
  Code: Integer;
begin
  Log('Running: ' + Exe + ' ' + Params);
  if not Exec(Exe, Params, '', SW_HIDE, ewWaitUntilTerminated, Code) then
    Code := -1;
  Log('Exit code: ' + IntToStr(Code));
  Result := Code;
end;

function RunPS(const Command: String): Integer;
begin
  Result := RunHidden(PowerShell, '-NoProfile -ExecutionPolicy Bypass -Command "' + Command + '"');
end;

function TaskExists: Boolean;
begin
  Result := RunHidden(ExpandConstant('{sys}\schtasks.exe'), '/Query /TN ' + TaskName) = 0;
end;

function CurrentPort: String;
var
  S: String;
begin
  Result := ExpandConstant('{param:PORT|}');
  if Result = '' then
    if RegQueryStringValue(HKLM, EnvKey, 'KINORA_PORT', S) and (S <> '') then Result := S
    else if RegQueryStringValue(HKLM, EnvKey, 'MEDIAMAX_PORT', S) and (S <> '') then Result := S
    else Result := '8484';
end;

// New installs go to Program Files\Vibe. A copy already in Program Files\Kinora (the default before the rename,
// also used by install-service.ps1 set-ups that have no setup record) is upgraded where it is. Upgrades of a setup
// install never get here: Inno Setup reuses the previous folder (UsePreviousAppDir).
function DefaultInstallDir(Param: String): String;
begin
  if FileExists(ExpandConstant('{autopf}\Kinora\kinora.exe')) then
    Result := ExpandConstant('{autopf}\Kinora')
  else
    Result := ExpandConstant('{autopf}\Vibe');
end;

function GetPort(Param: String): String;
begin
  if PortPage <> nil then Result := Trim(PortPage.Values[0]) else Result := CurrentPort;
end;

function InitializeSetup: Boolean;
begin
  ServiceWasInstalled := TaskExists;
  Result := True;
end;

procedure InitializeWizard;
begin
  PortPage := CreateInputQueryPage(wpSelectTasks, 'Network port',
    'Which port should Vibe use?',
    'Other devices on your network (phones, TVs, browsers) connect to this port. Keep 8484 unless something else already uses it.');
  PortPage.Add('&Port:', False);
  PortPage.Values[0] := CurrentPort;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  // A machine set up by hand with install-service.ps1 (no previous setup): keep it a service.
  if (CurPageID = wpSelectTasks) and not TasksPagePrepared then
  begin
    TasksPagePrepared := True;
    if ServiceWasInstalled and (WizardForm.PrevAppDir = '') then
      WizardSelectTasks('service');
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  P: Integer;
begin
  Result := True;
  if (PortPage <> nil) and (CurPageID = PortPage.ID) then
  begin
    P := StrToIntDef(Trim(PortPage.Values[0]), 0);
    if (P < 1) or (P > 65535) then
    begin
      MsgBox('Enter a port number between 1 and 65535.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

procedure StopVibe(const AppDir: String);
begin
  if FileExists(AppDir + '\VibeTray.exe') then
    RunHidden(AppDir + '\VibeTray.exe', '--quit');
  Sleep(1500);
  RunHidden(ExpandConstant('{sys}\taskkill.exe'), '/F /IM VibeTray.exe');
  if TaskExists then
    RunHidden(ExpandConstant('{sys}\schtasks.exe'), '/End /TN ' + TaskName);
  RunPS('Get-Process kinora,mediamax -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue');
  Sleep(1500);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopVibe(ExpandConstant('{app}'));
  Result := '';
end;

function DataDir: String;
var
  Fresh, Legacy, S: String;
begin
  if RegQueryStringValue(HKLM, EnvKey, 'KINORA_DATA', S) and (S <> '') then begin Result := S; exit; end;
  if RegQueryStringValue(HKLM, EnvKey, 'MEDIAMAX_DATA', S) and (S <> '') then begin Result := S; exit; end;
  Fresh := ExpandConstant('{commonappdata}\Kinora');
  Legacy := ExpandConstant('{commonappdata}\MediaMax');
  if not DirExists(Fresh) and DirExists(Legacy) then Result := Legacy else Result := Fresh;
end;

function ServiceScript(const Args: String): Integer;
begin
  Result := RunHidden(PowerShell, '-NoProfile -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{app}\install-service.ps1') + '" -InstallDir "' + ExpandConstant('{app}') + '" ' + Args);
end;

procedure SetPortVariable(const Port: String);
begin
  RegDeleteValue(HKLM, EnvKey, 'MEDIAMAX_PORT');
  if Port = '8484' then RegDeleteValue(HKLM, EnvKey, 'KINORA_PORT')
  else RegWriteExpandStringValue(HKLM, EnvKey, 'KINORA_PORT', Port);
end;

procedure SetupTrayMode(const Port: String);
var
  Dir, Profiles, Exe, Grant: String;
begin
  // Coming from service mode: remove the boot-time task (the script leaves {app} alone when run from it).
  if TaskExists then
    ServiceScript('-Uninstall');
  RegWriteDWordValue(HKLM, VibeKey, 'ServiceMode', 0);
  SetPortVariable(Port);

  // The server now runs as the signed-in user: let users write the data folder (it may have been created by
  // SYSTEM in service mode, or by this elevated setup).
  Dir := DataDir;
  ForceDirectories(Dir);
  Grant := '"' + Dir + '" /grant *S-1-5-32-545:(OI)(CI)M /Q';
  if ServiceWasInstalled then Grant := Grant + ' /T /C';
  RunHidden(ExpandConstant('{sys}\icacls.exe'), Grant);

  // Firewall: same rule names as install-service.ps1, so either one can remove them.
  Exe := ExpandConstant('{app}\kinora.exe');
  if WizardIsTaskSelected('publicfw') then Profiles := 'Any' else Profiles := 'Domain,Private';
  RunPS('Get-NetFirewallRule -DisplayName ''Kinora*'' -ErrorAction SilentlyContinue | Remove-NetFirewallRule; ' +
    'New-NetFirewallRule -DisplayName ''Kinora (HTTP ' + Port + ')'' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ' + Port +
    ' -Program ''' + Exe + ''' -Profile ' + Profiles + ' | Out-Null; ' +
    'New-NetFirewallRule -DisplayName ''Kinora (DLNA discovery)'' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 1900' +
    ' -Program ''' + Exe + ''' -Profile ' + Profiles + ' | Out-Null');
end;

procedure SetupServiceMode(const Port: String);
var
  Args: String;
begin
  Args := '-Port ' + Port;
  if WizardIsTaskSelected('publicfw') then Args := Args + ' -AllNetworkProfiles';
  if ServiceScript(Args) <> 0 then
    SuppressibleMsgBox('Vibe was installed, but registering the background service failed. ' +
      'See the setup log, or run install-service.ps1 from ' + ExpandConstant('{app}') + ' as administrator.',
      mbError, MB_OK, IDOK)
  else
    RegWriteDWordValue(HKLM, VibeKey, 'ServiceMode', 1);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Port: String;
begin
  if CurStep = ssPostInstall then
  begin
    Port := GetPort('');
    if WizardIsTaskSelected('service') then SetupServiceMode(Port) else SetupTrayMode(Port);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Args: String;
begin
  if CurUninstallStep = usUninstall then
  begin
    StopVibe(ExpandConstant('{app}'));
    Args := '-Uninstall';
    if not UninstallSilent then
      if MsgBox('Also delete your Vibe data (library database, users, settings, artwork and recordings in ' + DataDir + ')?' + #13#10#13#10 +
          'Choose No to keep it for a later reinstall.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        Args := Args + ' -RemoveData';
    // Removes the boot-time task (if any), the firewall rules and the port variable; keeps {app} for the uninstaller.
    ServiceScript(Args);
    RegDeleteValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'Vibe');
    RegDeleteKeyIncludingSubkeys(HKLM, VibeKey);
  end;
end;
