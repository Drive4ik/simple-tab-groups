unit Pipe;

// Author: Vitalii Bavykin
// Email: drive4ik+stghost@protonmail.com

interface

uses
  Winapi.Windows,
  System.SysUtils,
  System.JSON,
  System.Classes,
  System.Generics.Collections,
  System.IOUtils,
  System.DateUtils,
  System.Types,
  Vcl.Forms,
  Main,
  Utils,
  Settings;

type
  TBackupFileInfo = class
    Path: string;
    LastWriteUnix: Int64;
    Json: TJSONObject;
  end;

function CreateResponse(const ok: Boolean): TJSONObject;
function CreateResponseMessage(ok: Boolean; const msg: string): TJSONObject;
function CreateResponseLang(ok: Boolean; const Lang: string; Args: TJSONArray = nil): TJSONObject;
function CreateResponseJSON(ok: Boolean; const data: TJSONValue; const extra: TJSONValue = nil): TJSONObject;
function WriteStdOut(const payload: string): Boolean;
function ReadStdIn: string; // raises on error
function HandleNativeMessaging(const payload: string; const Extension: TExtension): TJSONObject;

implementation

uses
  System.Math, System.Generics.Defaults;

const MAX_MSG_SIZE = 100 * 1024 * 1024; // 100 MB

procedure LogShort(const Text: string; ok: Boolean);
var
  level: string;
begin
  if not ok then
    level:= 'error';

  Log(Text.Substring(0, 300), level);
end;

function CreateResponse(const ok: Boolean): TJSONObject;
begin
  Result := TJSONObject.Create;
  Result.AddPair('version', ExeInfo.Base.FileVersion);
  Result.AddPair('ok', ok);
end;

function CreateResponseMessage(ok: Boolean; const msg: string): TJSONObject;
begin
  Result := CreateResponse(ok);
  Result.AddPair('message', msg);
  LogShort(msg, ok);
end;

function CreateResponseLang(ok: Boolean; const Lang: string; Args: TJSONArray = nil): TJSONObject;
begin
  if Args = nil then
    Args:= TJSONArray.Create;

  Result := CreateResponse(ok);
  Result.AddPair('lang', Lang);
  Result.AddPair('args', Args);
  LogShort(Format('lang: %s, args: %s', [lang, Args.ToJSON]), ok);
end;

function CreateResponseJSON(ok: Boolean; const data: TJSONValue; const extra: TJSONValue = nil): TJSONObject;
begin
  Result := CreateResponse(ok);
  Result.AddPair('data', data);
  MergeJSON(Result, extra);
  LogShort(Format('data added to response: %s', [data.ToJSON]), ok);
end;

function WriteStdOut(const payload: string): Boolean;
var
  OutputBytes: TBytes;
  MsgLength: Cardinal;
  BytesWritten: Cardinal;
  hOut: THandle;
  Buffer: TMemoryStream;
  OutputBytesCount: Integer;
begin
  Result := False;

  hOut := GetStdHandle(STD_OUTPUT_HANDLE);
  if (hOut = 0) or (hOut = INVALID_HANDLE_VALUE) then
  begin
    Log('WriteStdOut: invalid stdout handle', 'error');
    Exit;
  end;

  OutputBytes := TEncoding.UTF8.GetBytes(payload);
  OutputBytesCount := Length(OutputBytes);

  if OutputBytesCount > MAX_MSG_SIZE then
  begin
    WriteStdOut(CreateResponseMessage(false, Format('WriteStdOut: output too large (%d bytes), limit %d',
      [OutputBytesCount, MAX_MSG_SIZE])).ToJSON);
    Exit;
  end;

  MsgLength := Cardinal(OutputBytesCount);

  Buffer := TMemoryStream.Create;
  try
    Buffer.WriteBuffer(MsgLength, SizeOf(MsgLength));
    if MsgLength > 0 then
      Buffer.WriteBuffer(OutputBytes[0], MsgLength);

    Buffer.Position := 0;

    if not WriteFile(hOut, Buffer.Memory^, Buffer.Size, BytesWritten, nil) then
    begin
      Log('WriteStdOut: WriteFile failed with error: ' + SysErrorMessage(GetLastError), 'error');
      Exit;
    end;

    if BytesWritten <> Buffer.Size then
    begin
      Log(Format('WriteStdOut: bytes written mismatch: expected %d, actual %d', [Buffer.Size, BytesWritten]), 'error');
      Exit;
    end;
  finally
    Buffer.Free;
  end;

  Result := True;
end;

function ReadStdIn: string;
var
  hIn: THandle;
  LengthBytes: array[0..3] of Byte;
  BytesRead: Cardinal;
  MsgLength: Cardinal;
  Payload: TBytes;
begin
  hIn := GetStdHandle(STD_INPUT_HANDLE);
  if (hIn = 0) or (hIn = INVALID_HANDLE_VALUE) then
    raise Exception.Create('Invalid stdin handle');

  if not ReadFile(hIn, LengthBytes, SizeOf(LengthBytes), BytesRead, nil) then
    raise Exception.Create('Read length failed: ' + SysErrorMessage(GetLastError));

  if BytesRead <> SizeOf(LengthBytes) then
    raise Exception.CreateFmt('Unexpected length bytes read: %d', [BytesRead]);

  MsgLength := LengthBytes[0] or (LengthBytes[1] shl 8) or (LengthBytes[2] shl 16) or (LengthBytes[3] shl 24);

  if (MsgLength = 0) or (MsgLength > MAX_MSG_SIZE) then
    raise Exception.CreateFmt('Invalid message length: %d', [MsgLength]);

  SetLength(Payload, MsgLength);

  if not ReadFile(hIn, Payload[0], MsgLength, BytesRead, nil) then
    raise Exception.Create('Read payload failed: ' + SysErrorMessage(GetLastError));

  if BytesRead <> MsgLength then
    raise Exception.CreateFmt('Payload bytes read mismatch: expected %d, actual %d', [MsgLength, BytesRead]);

  Result := TEncoding.UTF8.GetString(Payload);
end;

function GetBackupFiles(const Extension: TExtension): TList<TBackupFileInfo>;
var
  Files: TStringDynArray;
  BackupFolder: string;
begin
  Result := TList<TBackupFileInfo>.Create;

  BackupFolder := GetBackupFolder(Extension);

  if not TDirectory.Exists(BackupFolder) then
    Exit;

  Files := TDirectory.GetFiles(BackupFolder, '*' + Extension.backupExt, TSearchOption.soAllDirectories);

  for var Path in Files do
  begin
    var FileJson := ReadJSONFile(Path);

    if not Assigned(FileJson) then
      Continue;

    if not (FileJson is TJSONObject) then
      Continue;

    if FileJson.GetValue<string>('id', '') <> Extension.Id then
    begin
      FileJson.Free;
      Continue;
    end;

    var Info := TBackupFileInfo.Create;
    Info.Path := Path;
    Info.LastWriteUnix := DateTimeToUnix(TFile.GetLastWriteTime(Path), False);
    Info.Json := FileJson as TJSONObject;

    Result.Add(Info);
  end;

  // sorting: latest at the top
  Result.Sort(
    TComparer<TBackupFileInfo>.Construct(
      function(const Left, Right: TBackupFileInfo): Integer
      begin
        Result := Sign(Right.LastWriteUnix - Left.LastWriteUnix);
      end
    )
  );
end;

function DeleteOldBackupFiles(const Extension: TExtension): Integer;
var
  BackupFiles: TList<TBackupFileInfo>;
  DeleteDays, KeepLatestFiles: Integer;
  CurrentTime: Int64;
  DeleteThreshold: Int64;
begin
  Result := 0;
  DeleteDays := GetDeleteOldBackupDays(Extension);
  KeepLatestFiles:= GetKeepBackupFiles(Extension);

  if DeleteDays = 0 then
    Exit;

  BackupFiles := GetBackupFiles(Extension);

  Log(format('DeleteOldBackupFiles: DeleteDays: %d, KeepLatestFiles: %d, Found files: %d',
    [DeleteDays, KeepLatestFiles, BackupFiles.Count]));

  try
    CurrentTime := DateTimeToUnix(Now, False);
    DeleteThreshold := CurrentTime - (DeleteDays * 24 * 60 * 60);

    for var i := KeepLatestFiles to BackupFiles.Count - 1 do
    begin
      var FileInfo := BackupFiles[i];
      if FileInfo.LastWriteUnix < DeleteThreshold then
      begin
        try
          TFile.Delete(FileInfo.Path);
          Inc(Result);
          Log(Format('DeleteOldBackupFiles: the file has been deleted: %s', [FileInfo.Path]));
        except
          on E: Exception do
            Log(Format('DeleteOldBackupFiles: failed to delete backup file: %s, error: %s',
              [FileInfo.Path, E.ToString]), 'error');
        end;
      end;
    end;
  finally
    BackupFiles.Free;
  end;
end;

function HandleSaveBackup(const json: TJSONObject; const Extension: TExtension): TJSONObject;
var
  FileFullPath, FilePath, FileNameBase, FileExt: string;
  data: TJSONObject;
begin
  const BackupFolder = GetBackupFolder(Extension);

  if not TDirectory.Exists(BackupFolder) then
    Exit(CreateResponseLang(false, 'invalidBackupFolder', TJSONArray.Create.Add(BackupFolder)));

  FileFullPath := ExpandFileName(BackupFolder + json.GetValue<string>('filePath'));
  FilePath:= ExtractFilePath(FileFullPath);
  FileNameBase:= ExtractFileName(FileFullPath);
  FileExt:= ExtractFileExt(FileFullPath);

  if not FileFullPath.StartsWith(BackupFolder) then
    Exit(CreateResponseLang(false, 'errBackupOutsideAllowedFolder', TJSONArray.Create.Add(FilePath)));
    // You cannot save backups outside the allowed folder! You are attempting to save to the folder "%s" folder.

  if FileNameBase = '' then
    Exit(CreateResponseLang(false, 'invalidBackupFileName'));

  if not SameText(FileExt, extension.backupExt) then
    Exit(CreateResponseLang(false, 'errBackupFileInvalidExt', TJSONArray.Create.Add(FileExt)));

  data:= json.GetValue<TJSONObject>('data');

  // add extension id
  data.AddPair('id', Extension.Id);

  WriteJSONFile(FileFullPath, data);

  Result:= CreateResponseMessage(true, 'File saved to: ' + FileFullPath);

  DeleteOldBackupFiles(Extension);
end;

function HandleGetLastBackup(const json: TJSONObject; const Extension: TExtension): TJSONObject;
var
  LatestBackupInfo: TBackupFileInfo;
  BackupFiles: TList<TBackupFileInfo>;
  ExtraJson: TJSONObject;
begin
  const BackupFolder = GetBackupFolder(Extension);

  if not TDirectory.Exists(BackupFolder) then
    Exit(CreateResponseLang(false, 'invalidBackupFolder', TJSONArray.Create.Add(BackupFolder)));

  BackupFiles := GetBackupFiles(Extension);
  try
    if BackupFiles.Count = 0 then
      Exit(CreateResponseLang(false, 'noBackupFilesFound'));

    LatestBackupInfo := BackupFiles[0];

    // remove extension id
    LatestBackupInfo.Json.RemovePair('id');

    ExtraJson:= TJSONObject.Create
      .AddPair('relativeFilePath', ExtractRelativePath(BackupFolder, LatestBackupInfo.Path))
      .AddPair('lastWriteUnix', LatestBackupInfo.LastWriteUnix);

    Result := CreateResponseJSON(true, LatestBackupInfo.Json.Clone as TJSONObject, ExtraJson);

    ExtraJson.Free;
  finally
    BackupFiles.Free;
  end;
end;

function HandleGetBackupFolder(const json: TJSONObject; const Extension: TExtension): TJSONObject;
begin
  const BackupFolder = GetBackupFolder(Extension);

  if not TDirectory.Exists(BackupFolder) then
    Exit(CreateResponseLang(false, 'invalidBackupFolder', TJSONArray.Create.Add(BackupFolder)));

  Result:= CreateResponseJSON(true, TJSONString.Create(BackupFolder));
end;

function HandleOpenBackupFolder(const json: TJSONObject; const Extension: TExtension): TJSONObject;
begin
  const BackupFolder = GetBackupFolder(Extension);

  if not TDirectory.Exists(BackupFolder) then
    Exit(CreateResponseLang(false, 'invalidBackupFolder', TJSONArray.Create.Add(BackupFolder)));

  OpenPath(BackupFolder);

  Result := CreateResponseMessage(true, 'Success');
end;

function HandleSelectBackupFolder(const json: TJSONObject; const Extension: TExtension): TJSONObject;
begin
//  show MainForm and taskbar button
//  Application.CreateForm(TMainForm, MainForm);
//  MainForm.Close;
//  Application.Run;

  var BackupFolder := SelectFolderModern(json.GetValue<string>('dialogTitle'), GetBackupFolder(Extension));
  if BackupFolder <> '' then
  begin
    SetBackupFolder(Extension, BackupFolder);
    Result := CreateResponseMessage(true, 'Success');
  end else
    Result := CreateResponseMessage(false, 'rejected');
end;

function HandleNativeMessaging(const payload: string; const Extension: TExtension): TJSONObject;
type
  TActionHandler = function(const json: TJSONObject; const Extension: TExtension): TJSONObject;
var
  json: TJSONObject;
begin
  InitSettings;

  json := TJSONObject.ParseJSONValue(payload, true, true) as TJSONObject;

  const action = json.GetValue<string>('action', '');

  var Handlers := TDictionary<string, TActionHandler>.Create;
  try
    Handlers.Add('save-backup', HandleSaveBackup);
    Handlers.Add('get-last-backup', HandleGetLastBackup);
    Handlers.Add('get-backup-folder', HandleGetBackupFolder);
    Handlers.Add('open-backup-folder', HandleOpenBackupFolder);
    Handlers.Add('select-backup-folder', HandleSelectBackupFolder);

    var handler: TActionHandler;
    if Handlers.TryGetValue(action, handler) then
    begin
      Log('action: ' + action);
      result := handler(json, Extension);
    end
    else
      raise Exception.CreateFmt('invalid action: %s', [action]);
  finally
    json.Free;
    Handlers.Free;
  end;
end;

end.
