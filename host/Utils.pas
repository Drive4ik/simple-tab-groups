unit Utils;

// Author: Vitalii Bavykin
// Email: drive4ik+stghost@protonmail.com

interface

uses
  Winapi.Windows, Vcl.Dialogs, Vcl.Forms, System.JSON, System.SysUtils, System.Classes, System.Win.Registry,
  VerInfo, System.IOUtils, Winapi.ShellAPI, System.NetEncoding, System.Math, Vcl.Controls;

function PrivateExtractIcons(lpszFile: PChar; nIconIndex, cxIcon, cyIcon: integer; phicon: PHANDLE; piconid: PDWORD; nicon, flags: DWORD): DWORD; stdcall; external 'user32.dll' name 'PrivateExtractIconsW';

type
  TEXEVersionDataExtended = record
    Base: TEXEVersionData;
    FileVersion: string;
    ProductVersion: string;
    FileName: string;
    FilePath: string;
    IconHandle: HICON;
  end;

function ReadJSONFile(const FilePath: string; const RaiseExc: Boolean = false): TJSONValue;
procedure WriteJSONFile(const FilePath: string; const json: TJSONValue; const Indent: Integer = 4;
  const LineBreakLF: Boolean = true);
function SelectFolderModern(const Title: string = 'Select folder'; const DefaultDir: string = ''): string;
function TrimVersion(const VerStr: string): string;
function GetExeInfo(const ExePath: string = ''; IconIndex: Integer = -1; IconSize: Integer = 16): TEXEVersionDataExtended;
function MergeJSON(const baseValue, extraValue: TJSONValue): TJSONValue;
function IsWindowsDarkTheme: Boolean;
function ExpandEnvStr(const Str: string): string;
function OpenPath(const Path: string): Boolean;
function EncodeBase64(const Input: string): string;
function DecodeBase64(const base64String: string): string;
function CompareNumericVersions(const A, B: string): Integer;
function RunApp(const aCmd: string; aShowMode: Integer = SW_SHOWNORMAL; aWait: Boolean = False; aWaitMs: Integer = 10000): DWORD;

implementation

function ReadJSONFile(const FilePath: string; const RaiseExc: Boolean = false): TJSONValue;
var
  FileContent: string;
begin
  FileContent:= TFile.ReadAllText(FilePath, TEncoding.UTF8);
  Result:= TJSONObject.ParseJSONValue(FileContent, false, RaiseExc);
end;

procedure WriteJSONFile(const FilePath: string; const json: TJSONValue; const Indent: Integer = 4;
  const LineBreakLF: Boolean = true);
var
  FileContent: string;
begin
  if Indent > 0 then
    FileContent:= json.Format(Indent)
  else
    FileContent:= json.ToJSON;

  if LineBreakLF then
    FileContent := StringReplace(FileContent, sLineBreak, #10, [rfReplaceAll]);

  TFile.WriteAllText(FilePath, FileContent); // add TEncoding.UTF8 encoding will add BOM mark
end;

function ExtractExeIcon(const fileName: String; iconIndex: Integer; iconSize: Integer = 16): HICON;
var
  nIconId : DWORD;
begin
  PrivateExtractIcons(PWideChar(fileName), iconIndex, iconSize, iconSize, @result, @nIconId, 1, LR_LOADFROMFILE);
end;

function SelectFolderModern(const Title: string = 'Select folder'; const DefaultDir: string = ''): string;
var
  Dialog: TFileOpenDialog;
begin
  Result := '';

  Dialog := TFileOpenDialog.Create(nil);
  try
    Dialog.Title := Title;
    Dialog.Options := [fdoPickFolders, fdoPathMustExist, fdoForceFileSystem];
    Dialog.DefaultFolder := DefaultDir;
    if Dialog.Execute then
      Result := Dialog.FileName;
  finally
    Dialog.Free;
  end;
end;

function TrimVersion(const VerStr: string): string;
var
  Parts: TArray<string>;
begin
  Parts := VerStr.Split(['.']);
  while (Length(Parts) > 2) and (Parts[High(Parts)] = '0') do
    SetLength(Parts, Length(Parts) - 1);
  Result := string.Join('.', Parts);
end;

function GetExeInfo(const ExePath: string = ''; IconIndex: Integer = -1; IconSize: Integer = 16): TEXEVersionDataExtended;
var
  FileName: string;
begin
  Result := Default(TEXEVersionDataExtended);

  if ExePath <> '' then
    FileName := ExePath
  else
    FileName := Application.ExeName;

  if not FileExists(FileName) then
    Exit;

  Result.Base := GetEXEVersionData(FileName);
  Result.FileName := ExtractFileName(FileName);
  Result.FilePath := ExtractFilePath(FileName);
  Result.FileVersion := TrimVersion(Result.Base.FileVersion);
  Result.ProductVersion := TrimVersion(Result.Base.ProductVersion);

  if IconIndex >= 0 then
    Result.IconHandle := ExtractExeIcon(FileName, IconIndex, IconSize);
end;

function MergeJSON(const baseValue, extraValue: TJSONValue): TJSONValue;
begin
  Result := baseValue;

  if (baseValue = nil) or (extraValue = nil) then
    Exit;

  // Object + Object: merge/replace pairs
  if (baseValue is TJSONObject) and (extraValue is TJSONObject) then
  begin
    var BaseObj := TJSONObject(baseValue);
    for var Pair in TJSONObject(extraValue) do
    begin
      BaseObj.RemovePair(Pair.JsonString.Value).Free;
      BaseObj.AddPair(Pair.Clone as TJSONPair);
    end;
    Exit;
  end;

  // Array + Array: append clones
  if (baseValue is TJSONArray) and (extraValue is TJSONArray) then
  begin
    var BaseArr := TJSONArray(baseValue);
    for var Item in TJSONArray(extraValue) do
      BaseArr.AddElement(Item.Clone as TJSONValue);
    Exit;
  end;

  // Object + scalar/array -> add as 'extra'
  if baseValue is TJSONObject then
  begin
    TJSONObject(baseValue).AddPair('extra', extraValue.Clone as TJSONValue);
    Exit;
  end;

  // Array + scalar/object -> append clone
  if baseValue is TJSONArray then
  begin
    TJSONArray(baseValue).AddElement(extraValue.Clone as TJSONValue);
    Exit;
  end;
  // For scalar base, leave as-is
end;

function IsWindowsDarkTheme: Boolean;
const
  RegKey = 'Software\Microsoft\Windows\CurrentVersion\Themes\Personalize';
  RegValue = 'AppsUseLightTheme';
var
  Reg: TRegistry;
begin
  Result := False;
  Reg := TRegistry.Create(KEY_READ);
  try
    Reg.RootKey := HKEY_CURRENT_USER;
    if Reg.OpenKeyReadOnly(RegKey) and Reg.ValueExists(RegValue) then
      Result := Reg.ReadInteger(RegValue) = 0;
  finally
    Reg.Free;
  end;
end;

function ExpandEnvStr(const Str: string): string;
var
  BufSize: DWORD;
begin
  BufSize := ExpandEnvironmentStrings(PChar(Str), nil, 0);
  if BufSize = 0 then Exit('');
  SetLength(Result, BufSize - 1);
  if ExpandEnvironmentStrings(PChar(Str), PChar(Result), BufSize) = 0 then
    Result := '';
end;

function OpenPath(const Path: string): Boolean;
begin
  result:= ShellExecute(0, 'open', PWideChar(Path), nil, nil, SW_SHOWNORMAL) > 32 ;
end;

function EncodeBase64(const Input: string): string;
begin
  var enc := TBase64Encoding.Create(-1);
  try
    Result := enc.Encode(Input);
  finally
    enc.Free;
  end;
end;

function DecodeBase64(const base64String: string): string;
begin
  Result:= TNetEncoding.Base64.Decode(base64String);
end;

{ A < B : - index of version type (major=-1, minor=-2...)
  A > B : + index of version type (major=1, minor=2...)
  A = B : 0 }
function CompareNumericVersions(const A, B: string): Integer;
var
  PartsA, PartsB: TArray<String>;
  MaxLen, NA, NB: Integer;
begin
  PartsA := A.Split(['.']);
  PartsB := B.Split(['.']);

  MaxLen := Max(Length(PartsA), Length(PartsB));

  for var i := 0 to MaxLen - 1 do
  begin
    if i < Length(PartsA) then
      NA := StrToIntDef(PartsA[i], 0)
    else
      NA := 0;

    if i < Length(PartsB) then
      NB := StrToIntDef(PartsB[i], 0)
    else
      NB := 0;

    if NA < NB then Exit(-(i + 1));
    if NA > NB then Exit(i + 1);
  end;

  Result := 0;
end;

function RunApp(const aCmd: string; aShowMode: Integer = SW_SHOWNORMAL;
  aWait: Boolean = False; aWaitMs: Integer = 10000): DWORD;
var
  StartUpInfo: TStartUpInfo;
  ProcessInfo: TProcessInformation;
  WaitCode, CreationFlags: DWORD;
begin
  Result := 0;

  ZeroMemory(@StartupInfo, SizeOf(TStartupInfo));
  StartUpInfo.cb := SizeOf(StartUpInfo);
  StartUpInfo.wShowWindow := aShowMode;
  StartUpInfo.dwFlags := STARTF_USESHOWWINDOW;

  ZeroMemory(@ProcessInfo, SizeOf(TProcessInformation));

  CreationFlags := NORMAL_PRIORITY_CLASS;

  if not aWait then
    CreationFlags := CreationFlags or CREATE_BREAKAWAY_FROM_JOB;

  if not CreateProcess(nil, PChar(aCmd), nil, nil, False, CreationFlags,
    nil, nil, StartUpInfo, ProcessInfo) then
    RaiseLastOSError;

  try
    if aWait then
    begin
      WaitCode := WaitForSingleObject(ProcessInfo.hProcess, aWaitMs);

      if WaitCode = WAIT_FAILED then
        RaiseLastOSError;

      if WaitCode = WAIT_TIMEOUT then
        Result := STILL_ACTIVE
      else
      begin
        if not GetExitCodeProcess(ProcessInfo.hProcess, Result) then
          RaiseLastOSError;
      end;
    end;
  finally
    CloseHandle(ProcessInfo.hThread);
    CloseHandle(ProcessInfo.hProcess);
  end;
end;

end.
