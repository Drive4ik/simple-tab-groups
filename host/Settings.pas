unit Settings;

// Author: Vitalii Bavykin
// Email: drive4ik+stghost@protonmail.com

interface

uses
  Winapi.Windows, System.IniFiles, System.SysUtils, System.Win.Registry, System.IOUtils, Vcl.Forms, Utils,
  System.Generics.Collections, System.Math;

type
  TExtension = record
    Id: string;
    backupExt: string;
  end;

const STG: TExtension = (
  Id: 'simple-tab-groups@drive4ik';
  backupExt: '.json'
);

const NOTES: TExtension = (
  Id: 'stg-plugin-group-notes@drive4ik';
  backupExt: '.json'
);

procedure InitSettings;

function IsPortableMode: Boolean;
procedure SetPortableMode(const Enabled: Boolean);
procedure SaveSettings;

function GetBackupFolder(const Extension: TExtension; const PreparePath: Boolean = true): string;
procedure SetBackupFolder(const Extension: TExtension; const Folder: string);
function GetDeleteBackupDays(const Extension: TExtension): Integer;
procedure SetDeleteBackupDays(const Extension: TExtension; const Value: Integer);
function GetKeepBackupFiles(const Extension: TExtension): Integer;
procedure SetKeepBackupFiles(const Extension: TExtension; const Value: Integer);
function IsLoggingEnabled: Boolean;
procedure SetLoggingEnabled(const enabled: boolean);

var
  ExeInfo: TEXEVersionDataExtended;
  AllowedExtensionsMap: TDictionary<string, TExtension>;

implementation

const
  SettingsFileName = 'settings.ini';
  SettingsRegKey = '\Software\STGHost';

var
  SettingsIni: TCustomIniFile;

procedure InitAllowedExtensionsMap;
begin
  AllowedExtensionsMap := TDictionary<string, TExtension>.Create;

  for var Extension in [STG, NOTES] do
    AllowedExtensionsMap.AddOrSetValue(Extension.Id, Extension);
end;

function SettingsFilePath: string;
begin
  Result := ExeInfo.FilePath + SettingsFileName;
end;

function IsPortableMode: Boolean;
begin
  Result := TFile.Exists(SettingsFilePath);
end;

function CreateFileStorage: TCustomIniFile;
begin
  Result := TMemIniFile.Create(SettingsFilePath, TEncoding.UTF8);
end;

function CreateRegistryStorage: TCustomIniFile;
begin
  Result := TRegistryIniFile.Create(SettingsRegKey);
  TRegistryIniFile(Result).RegIniFile.RootKey := HKEY_CURRENT_USER;
end;

procedure SaveSettings;
begin
  SettingsIni.UpdateFile;
end;

procedure SaveSettingsIfGUI;
begin
  if not IsPipeMode then
    SaveSettings;
end;

procedure InitSettings;
begin
  ExeInfo:= GetExeInfo;
  try
    FreeAndNil(SettingsIni);

    if IsPortableMode then
      SettingsIni := CreateFileStorage
    else
      SettingsIni := CreateRegistryStorage;
  except
    on E: Exception do
    begin
      // don't know what to do, it happens when there are lot of calls
      Halt;
    end;
  end;
end;

procedure SetPortableMode(const Enabled: Boolean);
begin
  if Enabled = IsPortableMode then
    Exit;

  const Logging = IsLoggingEnabled;
  const PreviousStorage = SettingsIni;

  var NewStorage: TCustomIniFile;
  if Enabled then
    NewStorage := CreateFileStorage
  else
    NewStorage := CreateRegistryStorage;

  try
    SettingsIni := NewStorage;
    SetLoggingEnabled(Logging);

    for var Extension in AllowedExtensionsMap.Values do
    begin
      SettingsIni := PreviousStorage;
      const BackupFolder = GetBackupFolder(Extension, false);
      const DeleteBackupDays = GetDeleteBackupDays(Extension);
      const KeepBackupFiles = GetKeepBackupFiles(Extension);

      SettingsIni := NewStorage;
      SetBackupFolder(Extension, BackupFolder);
      SetDeleteBackupDays(Extension, DeleteBackupDays);
      SetKeepBackupFiles(Extension, KeepBackupFiles);
    end;

    SaveSettings;
  except
    SettingsIni := PreviousStorage;
    NewStorage.Free;

    if Enabled and TFile.Exists(SettingsFilePath) then
      TFile.Delete(SettingsFilePath);

    raise;
  end;

  try
    if Enabled then
      PreviousStorage.EraseSection(SettingsRegKey)
    else
      TFile.Delete(SettingsFilePath);
  finally
    PreviousStorage.Free;
  end;
end;

function GetBackupFolder(const Extension: TExtension; const PreparePath: Boolean = true): string;
begin
  Result := SettingsIni.ReadString(Extension.Id, 'BackupFolder', '').Trim;

  if not PreparePath then Exit;
  if Result = '' then Exit;

  Result:= ExpandEnvStr(Result);
  if Result = '' then Exit;

  Result:= ExpandFileName(Result);
  if Result = '' then Exit;

  Result:= IncludeTrailingPathDelimiter(Result);
end;

procedure SetBackupFolder(const Extension: TExtension; const Folder: string);
begin
  SettingsIni.WriteString(Extension.Id, 'BackupFolder', Folder.Trim);
  SaveSettingsIfGUI;
end;

function GetDeleteBackupDays(const Extension: TExtension): Integer;
begin
  Result := Max(0, SettingsIni.ReadInteger(Extension.Id, 'DeleteBackupDays', 30));
end;

procedure SetDeleteBackupDays(const Extension: TExtension; const Value: Integer);
begin
  SettingsIni.WriteInteger(Extension.Id, 'DeleteBackupDays', Value);
  SaveSettingsIfGUI;
end;

function GetKeepBackupFiles(const Extension: TExtension): Integer;
begin
  Result := Max(1, SettingsIni.ReadInteger(Extension.Id, 'KeepBackupFiles', 10));
end;

procedure SetKeepBackupFiles(const Extension: TExtension; const Value: Integer);
begin
  SettingsIni.WriteInteger(Extension.Id, 'KeepBackupFiles', Value);
  SaveSettingsIfGUI;
end;

function IsLoggingEnabled: Boolean;
begin
  result := SettingsIni.ReadBool('', 'WriteLogs', false);
end;

procedure SetLoggingEnabled(const enabled: boolean);
begin
  SettingsIni.WriteBool('', 'WriteLogs', enabled);
  SaveSettingsIfGUI;
end;

initialization
  InitAllowedExtensionsMap;
  InitSettings;

finalization
  FreeAndNil(SettingsIni);
  AllowedExtensionsMap.Free;

end.
