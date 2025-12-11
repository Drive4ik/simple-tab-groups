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

function GetBackupFolder(const Extension: TExtension; const PreparePath: Boolean = true): string;
procedure SetBackupFolder(const Extension: TExtension; const Folder: string);
function GetDeleteOldBackupDays(const Extension: TExtension): Integer;
procedure SetDeleteOldBackupDays(const Extension: TExtension; const Value: Integer);
function GetKeepBackupFiles(const Extension: TExtension): Integer;
procedure SetKeepBackupFiles(const Extension: TExtension; const Value: Integer);
function IsLoggingEnabled: Boolean;
procedure SetLoggingEnabled(const enabled: boolean);

var
  ExeInfo: TEXEVersionDataExtended;
  AllowedExtensionsMap: TDictionary<string, TExtension>;

implementation

var
  SettingsIni: TCustomIniFile;

procedure InitAllowedExtensionsMap;
begin
  AllowedExtensionsMap := TDictionary<string, TExtension>.Create;

  for var Extension in [STG, NOTES] do
    AllowedExtensionsMap.AddOrSetValue(Extension.Id, Extension);
end;

procedure InitSettings;
const
  SettingsFileName = 'settings.ini';
begin
  ExeInfo:= GetExeInfo;

  if TFile.Exists(ExeInfo.FilePath + SettingsFileName) then
    SettingsIni := TMemIniFile.Create(ExeInfo.FilePath + SettingsFileName, TEncoding.Unicode)
  else begin
    SettingsIni := TRegistryIniFile.Create('Software\STGHost');
    TRegistryIniFile(SettingsIni).RegIniFile.RootKey := HKEY_CURRENT_USER;
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
end;

function GetDeleteOldBackupDays(const Extension: TExtension): Integer;
begin
  Result := Max(0, SettingsIni.ReadInteger(Extension.Id, 'DeleteBackupsAfterDays', 0));
end;

procedure SetDeleteOldBackupDays(const Extension: TExtension; const Value: Integer);
begin
  SettingsIni.WriteInteger(Extension.Id, 'DeleteBackupsAfterDays', Value);
end;

function GetKeepBackupFiles(const Extension: TExtension): Integer;
begin
  Result := Max(1, SettingsIni.ReadInteger(Extension.Id, 'KeepBackupFiles', 1));
end;

procedure SetKeepBackupFiles(const Extension: TExtension; const Value: Integer);
begin
  SettingsIni.WriteInteger(Extension.Id, 'KeepBackupFiles', Value);
end;

function IsLoggingEnabled: Boolean;
begin
  result := SettingsIni.ReadBool('', 'WriteLogs', false);
end;

procedure SetLoggingEnabled(const enabled: boolean);
begin
  SettingsIni.WriteBool('', 'WriteLogs', enabled);
end;

initialization
  InitAllowedExtensionsMap;
  InitSettings;

finalization
  SettingsIni.UpdateFile;
  AllowedExtensionsMap.Free;

end.
