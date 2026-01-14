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
  System.Generics.Defaults,
  System.Math,
  System.IOUtils,
  System.DateUtils,
  System.Types,
  Vcl.Forms,
  Main,
  Utils,
  Logger,
  Settings,
  GithubUpdater;

type
  TBackupFileInfo = class
    Path: string;
    LastWriteUnix: Int64;
    Json: TJSONObject;
    destructor Destroy; override;
  end;

function CreateResponse(const ok: Boolean): TJSONObject;
function CreateResponseMessage(ok: Boolean; const msg: string): TJSONObject;
function CreateResponseLang(ok: Boolean; const Lang: string; Args: TJSONArray = nil; const extra: TJSONValue = nil): TJSONObject;
function CreateResponseJSON(ok: Boolean; const data: TJSONValue; const extra: TJSONValue = nil): TJSONObject;
function WriteStdOut(const payload: string): Boolean;
function ReadStdIn: string; // raises on error
function HandleNativeMessaging(const payload: string; const Extension: TExtension): TJSONObject;

implementation

const MAX_OUT_MSG_SIZE = 1024 * 1024 * 1; // 1 MB

destructor TBackupFileInfo.Destroy;
begin
  Json.Free;
  inherited;
end;

function CreateResponse(const ok: Boolean): TJSONObject;
begin
  Result := TJSONObject.Create;
  Result.AddPair('ok', ok);
end;

function CreateResponseMessage(ok: Boolean; const msg: string): TJSONObject;
begin
  Result := CreateResponse(ok);
  Result.AddPair('message', msg);
end;

function CreateResponseLang(ok: Boolean; const Lang: string; Args: TJSONArray = nil; const extra: TJSONValue = nil): TJSONObject;
begin
  if Args = nil then
    Args:= TJSONArray.Create;

  Result := CreateResponse(ok);
  Result.AddPair('lang', Lang);
  Result.AddPair('args', Args);
  MergeJSON(Result, extra);
end;

function CreateResponseJSON(ok: Boolean; const data: TJSONValue; const extra: TJSONValue = nil): TJSONObject;
begin
  Result := CreateResponse(ok);
  Result.AddPair('data', data);
  MergeJSON(Result, extra);
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

  if OutputBytesCount > MAX_OUT_MSG_SIZE then
  begin
    WriteStdOut(CreateResponseMessage(false, Format('WriteStdOut: output too large (%d bytes), limit %d',
      [OutputBytesCount, MAX_OUT_MSG_SIZE])).ToJSON);
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

    Log('Response: ' + payload.Substring(0, 300));
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

//  if (MsgLength = 0) or (MsgLength > MAX_MSG_SIZE) then
//    raise Exception.CreateFmt('Invalid message length: %d', [MsgLength]);

  SetLength(Payload, MsgLength);

  if not ReadFile(hIn, Payload[0], MsgLength, BytesRead, nil) then
    raise Exception.Create('Read payload failed: ' + SysErrorMessage(GetLastError));

  if BytesRead <> MsgLength then
    raise Exception.CreateFmt('Payload bytes read mismatch: expected %d, actual %d', [MsgLength, BytesRead]);

  Result := TEncoding.UTF8.GetString(Payload);
end;

function DeleteEmptyDirectories(const ARootPath: string): Boolean;
begin
  Result := False;

  if not TDirectory.Exists(ARootPath) then
    raise EDirectoryNotFoundException.CreateFmt('Directory not found: "%s"', [ARootPath]);

  var SubDirs := TDirectory.GetDirectories(ARootPath, '*', TSearchOption.soAllDirectories);

  if Length(SubDirs) = 0 then
    Exit;

  TArray.Sort<string>(SubDirs, TComparer<string>.Construct(
    function(const Left, Right: string): Integer
    begin
      Result := Length(Right) - Length(Left);
    end
  ));

  for var Dir in SubDirs do
  begin
    var Entries := TDirectory.GetFileSystemEntries(Dir);

    if Length(Entries) = 0 then
    begin
      try
        TDirectory.Delete(Dir);
        Result := True;
      except
        on E: Exception do
          Log(Format('Unable to delete directory "%s": %s', [Dir, sLineBreak + E.ToString]), 'error');
      end;
    end;
  end;
end;

function GetBackupFiles(const Extension: TExtension; parseOnlyLastBackup: Boolean): TObjectList<TBackupFileInfo>;
var
  Files: TStringDynArray;
  BackupFolder: string;
begin
  Result := TObjectList<TBackupFileInfo>.Create(True);

  BackupFolder := GetBackupFolder(Extension);

  if not TDirectory.Exists(BackupFolder) then
    Exit;

  Files := TDirectory.GetFiles(BackupFolder, '*' + Extension.backupExt, TSearchOption.soAllDirectories);

  var FileInfos := TObjectList<TBackupFileInfo>.Create(True);
  try
    for var Path in Files do
    begin
      var Info := TBackupFileInfo.Create;
      Info.Path := Path;
      Info.LastWriteUnix := DateTimeToUnix(TFile.GetLastWriteTime(Path), False);
      Info.Json := nil;
      FileInfos.Add(Info);
    end;

    // sorting: latest at the top
    FileInfos.Sort(
      TComparer<TBackupFileInfo>.Construct(
        function(const Left, Right: TBackupFileInfo): Integer
        begin
          Result := Sign(Right.LastWriteUnix - Left.LastWriteUnix);
        end
      )
    );

    for var MetaInfo in FileInfos do
    begin
      var FileJson := ReadJSONFile(MetaInfo.Path);
      if not Assigned(FileJson) then
        Continue;

      if not (FileJson is TJSONObject) then
      begin
        FileJson.Free;
        Continue;
      end;

      if FileJson.GetValue<string>('id', '') <> Extension.Id then
      begin
        FileJson.Free;
        Continue;
      end;

      var Info := TBackupFileInfo.Create;
      Info.Path := MetaInfo.Path;
      Info.LastWriteUnix := MetaInfo.LastWriteUnix;
      Info.Json := FileJson as TJSONObject;

      Result.Add(Info);

      if parseOnlyLastBackup then
        Break;
    end;
  finally
    FileInfos.Free;
  end;
end;

function DeleteBackupFiles(const Extension: TExtension): Integer;
var
  BackupFiles: TObjectList<TBackupFileInfo>;
  DeleteDays, KeepLatestFiles: Integer;
  CurrentTime: Int64;
  DeleteThreshold: Int64;
begin
  Result := 0;
  DeleteDays := GetDeleteBackupDays(Extension);
  KeepLatestFiles:= GetKeepBackupFiles(Extension);

  if DeleteDays = 0 then
    Exit;

  BackupFiles := GetBackupFiles(Extension, False);

  Log(format('DeleteBackupFiles: DeleteDays: %d, KeepLatestFiles: %d, Found files: %d',
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
          Log(Format('DeleteBackupFiles: the file has been deleted: %s', [FileInfo.Path]));
        except
          on E: Exception do
            Log(Format('DeleteBackupFiles: failed to delete backup file: %s, error: %s',
              [FileInfo.Path, E.ToString]), 'error');
        end;
      end;
    end;
  finally
    BackupFiles.Free;
  end;
end;

function HandleGetVersion(const json: TJSONObject; const Extension: TExtension): TJSONObject;
begin
  Result:= CreateResponseJSON(true, TJSONString.Create(ExeInfo.FileVersion));
end;

function HandleUpdate(const json: TJSONObject; const Extension: TExtension): TJSONObject;
var
  Version, msg: String;
  UpdateResult: Boolean;
begin
  UpdateResult:= False;

  Version := json.GetValue<String>('version');

  if Version = 'latest' then
  begin
    if GithubCheckLatestVersion(Version) then
      UpdateResult:= GithubUpdateVersion(Version, false);
  end
  else
    UpdateResult:= GithubUpdateVersion(Version, false);

  if UpdateResult then
    msg:= 'Success'
  else
    msg:= Format('Version "%s" not found on GitHub', [json.GetValue<String>('version')]);

  Result := CreateResponseMessage(UpdateResult, msg);
end;

function HandleSaveBackup(const json: TJSONObject; const Extension: TExtension): TJSONObject;
var
  FileFullPath, FilePath, FileNameBase, FileExt: string;
  data: TJSONObject;
begin
  const BackupFolder = GetBackupFolder(Extension);

  if not TDirectory.Exists(BackupFolder) then
    Exit(CreateResponseLang(false, 'hostInvalidBackupFolder', TJSONArray.Create.Add(BackupFolder)));

  FileFullPath := ExpandFileName(BackupFolder + json.GetValue<string>('filePath'));
  FilePath:= ExtractFilePath(FileFullPath);
  FileNameBase:= ExtractFileName(FileFullPath);
  FileExt:= ExtractFileExt(FileFullPath);

  if not FileFullPath.StartsWith(BackupFolder) then
    Exit(CreateResponseLang(false, 'hostErrBackupOutsideAllowedFolder', TJSONArray.Create.Add(FilePath)));

  if FileNameBase = '' then
    Exit(CreateResponseLang(false, 'hostInvalidBackupFileName'));

  if not SameText(FileExt, extension.backupExt) then
    Exit(CreateResponseMessage(false, Format('invalid extension: "%s"', [FileExt])));

  TDirectory.CreateDirectory(FilePath);

  const IsTestSave = json.GetValue<Boolean>('test', false);

  if IsTestSave then
  begin
    data:= TJSONObject.Create;
    Log('is test saving');
  end
  else
  begin
    data:= json.GetValue<TJSONObject>('data');

    // add extension id
    data.AddPair('id', Extension.Id);
  end;

  WriteJSONFile(FileFullPath, data);

  Result:= CreateResponseJSON(true, TJSONString.Create(FileFullPath));

  if IsTestSave then
    TFile.Delete(FileFullPath)
  else
    DeleteBackupFiles(Extension);

  DeleteEmptyDirectories(BackupFolder);
end;

function HandleGetLastBackup(const json: TJSONObject; const Extension: TExtension): TJSONObject;
var
  LatestBackupInfo: TBackupFileInfo;
  BackupFiles: TObjectList<TBackupFileInfo>;
  ExtraJson: TJSONObject;
  jsonStr, base64Str, chunkStr: string;
  overheadBytes, availableBytes, totalBytes, partIndex, currentChunkLen, startPos, chunkSize, totalParts: NativeInt;

  // Calculate overhead (without payload) for current ExtraJson
  function CalculateOverheadBytes(const aExtra: TJSONObject): Integer;
  var
    dummy: TJSONObject;
  begin
    dummy := CreateResponseJSON(true, TJSONString.Create(''), aExtra);
    try
      Result := TEncoding.UTF8.GetByteCount(dummy.ToJSON);
    finally
      dummy.Free;
    end;
  end;

begin
  const BackupFolder = GetBackupFolder(Extension);

  if not TDirectory.Exists(BackupFolder) then
    Exit(CreateResponseLang(false, 'hostInvalidBackupFolder', TJSONArray.Create.Add(BackupFolder)));

  BackupFiles := GetBackupFiles(Extension, True);

  ExtraJson := TJSONObject.Create;

  try
    if BackupFiles.Count = 0 then
      Exit(CreateResponseLang(false, 'hostNoBackupFilesFound'));

    LatestBackupInfo := BackupFiles[0];

    // remove extension id
    LatestBackupInfo.Json.RemovePair('id').Free;

    // base extra info
    ExtraJson
      .AddPair('relativeFilePath', ExtractRelativePath(BackupFolder, LatestBackupInfo.Path))
      .AddPair('lastWriteUnix', LatestBackupInfo.LastWriteUnix)
      // used to calculate overhead
      .AddPair('encoding', TJSONArray.Create.Add('base64').Add('json'))
      .AddPair('nextPartIndex', 101)
      .AddPair('lastPartIndex', 102);

    // compute how many bytes are available for the actual data by building an empty response
    overheadBytes := CalculateOverheadBytes(ExtraJson);

    // remove temp values used only for overhead calculation
    for var key in ['encoding', 'nextPartIndex', 'lastPartIndex'] do
      ExtraJson.RemovePair(key).Free;

    availableBytes := MAX_OUT_MSG_SIZE - overheadBytes;

    jsonStr := LatestBackupInfo.Json.ToJSON;

    // if it fits, return as object without encoding
    if TEncoding.UTF8.GetByteCount(jsonStr) <= availableBytes then
      Exit(CreateResponseJSON(true, LatestBackupInfo.Json.Clone as TJSONObject, ExtraJson));

    // otherwise return the requested partIndex
    partIndex := json.GetValue<Integer>('partIndex', 0);

    base64Str := EncodeBase64(jsonStr);
    totalBytes := Length(base64Str);

    chunkSize := availableBytes;

    startPos := partIndex * chunkSize;
    if (startPos < 0) or (startPos >= totalBytes) then
      raise Exception.Create('invalid partIndex');

    currentChunkLen := Min(totalBytes - startPos, chunkSize);

    // Since base64 is ASCII, Copy by characters is safe
    chunkStr := Copy(base64Str, startPos + 1, currentChunkLen);

    totalParts := (totalBytes + chunkSize - 1) div chunkSize;

    ExtraJson.AddPair('encoding', TJSONArray.Create.Add('base64').Add('json'));
    if (partIndex + 1) < totalParts then
      ExtraJson.AddPair('nextPartIndex', TJSONNumber.Create(partIndex + 1));
    ExtraJson.AddPair('lastPartIndex', TJSONNumber.Create(totalParts - 1));

    Result := CreateResponseJSON(true, TJSONString.Create(chunkStr), ExtraJson);
  finally
    BackupFiles.Free;
    ExtraJson.Free;
  end;
end;

function HandleGetBackupFolder(const json: TJSONObject; const Extension: TExtension): TJSONObject;
begin
  const BackupFolder = GetBackupFolder(Extension);

  if not TDirectory.Exists(BackupFolder) then
  begin
    const extra = TJSONObject.Create(TJSONPair.Create('data', BackupFolder));
    Exit(CreateResponseLang(false, 'hostInvalidBackupFolder', TJSONArray.Create.Add(BackupFolder), extra));
  end;

  Result:= CreateResponseJSON(true, TJSONString.Create(BackupFolder));
end;

function HandleOpenBackupFolder(const json: TJSONObject; const Extension: TExtension): TJSONObject;
begin
  const BackupFolderResponse = HandleGetBackupFolder(json, Extension);

  if not BackupFolderResponse.GetValue<Boolean>('ok') then
    Exit(BackupFolderResponse);

  OpenPath(BackupFolderResponse.GetValue<string>('data'));

  Result := CreateResponse(true);
end;

function HandleSelectBackupFolder(const json: TJSONObject; const Extension: TExtension): TJSONObject;
begin
//  show MainForm and taskbar button
//  Application.CreateForm(TMainForm, MainForm);
//  MainForm.Close;
//  Application.Run;

  var BackupFolder := SelectFolderModern(json.GetValue<string>('dialogTitle'), GetBackupFolder(Extension));
  if BackupFolder <> '' then
    SetBackupFolder(Extension, BackupFolder);

  Result := HandleGetBackupFolder(json, Extension);
end;

function HandleGetSettings(const json: TJSONObject; const Extension: TExtension): TJSONObject;
var
  SettingsJSON: TJSONObject;
begin
  SettingsJSON:= TJSONObject.Create;
  SettingsJSON.AddPair('backupFolderResponse', HandleGetBackupFolder(json, Extension));
  SettingsJSON.AddPair('deleteBackupDays', GetDeleteBackupDays(Extension));
  SettingsJSON.AddPair('keepBackupFiles', GetKeepBackupFiles(Extension));

  Result:= CreateResponseJSON(true, SettingsJSON);
end;

function HandleSetSettings(const json: TJSONObject; const Extension: TExtension): TJSONObject;
begin
  const SettingsJSON = json.GetValue('settings') as TJSONObject;

  const SavedSettings = TJSONObject.Create;

  // Handle deleteBackupDays
  const deleteBackupDaysJSON = SettingsJSON.GetValue('deleteBackupDays');
  if Assigned(deleteBackupDaysJSON) then
  begin
    SetDeleteBackupDays(Extension, deleteBackupDaysJSON.GetValue<Integer>);
    SavedSettings.AddPair('deleteBackupDays', GetDeleteBackupDays(Extension));
  end;

  // Handle keepBackupFiles
  const keepBackupFilesJSON = SettingsJSON.GetValue('keepBackupFiles');
  if Assigned(keepBackupFilesJSON) then
  begin
    SetKeepBackupFiles(Extension, keepBackupFilesJSON.GetValue<Integer>);
    SavedSettings.AddPair('keepBackupFiles', GetKeepBackupFiles(Extension));
  end;

  Result := CreateResponseJSON(true, SavedSettings);
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
    Handlers.Add('get-version', HandleGetVersion);
    Handlers.Add('update', HandleUpdate);
    Handlers.Add('save-backup', HandleSaveBackup);
    Handlers.Add('get-last-backup', HandleGetLastBackup);
    Handlers.Add('get-backup-folder', HandleGetBackupFolder);
    Handlers.Add('open-backup-folder', HandleOpenBackupFolder);
    Handlers.Add('select-backup-folder', HandleSelectBackupFolder);
    Handlers.Add('get-settings', HandleGetSettings);
    Handlers.Add('set-settings', HandleSetSettings);

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
