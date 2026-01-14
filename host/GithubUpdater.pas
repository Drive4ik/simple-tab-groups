unit GithubUpdater;

interface

function GithubCheckLatestVersion(out Version: string): Boolean;
function GithubUpdateVersion(const Version: string; const RestartApp: Boolean = false): Boolean;

implementation

uses
  System.SysUtils, System.Classes, System.Net.HttpClient, System.Net.HttpClientComponent,
  System.JSON, System.Generics.Collections, System.Hash, System.IOUtils,
  Winapi.Windows, System.Math, Settings, Utils, Logger;

const RELEASES_API_URL = 'https://api.github.com/repos/Drive4ik/simple-tab-groups/releases';
const TAG_START: string = 'v';
const TAG_END = '-host';

function IsHostTag(const Tag: String): Boolean;
begin
  Result:= Tag.StartsWith(TAG_START) and Tag.EndsWith(TAG_END);
end;

function TagToVersion(const Tag: String): String;
begin
  Result:= Tag.Substring(TAG_START.Length, Max(0, Tag.Length - TAG_START.Length - TAG_END.Length));
end;

function VersionToTag(const Version: String): String;
begin
  Result:= TAG_START + Version + TAG_END;
end;

function IsEqualHash(const Digest: string; DataStream: TStream): Boolean;
var
  ActualHex : string;
  DigestParts: TArray<String>;
begin
  if not Assigned(DataStream) or (DataStream.Size = 0) then
    raise Exception.Create('Stream is empty');

  DigestParts:= Digest.Split([':']);
  if Length(DigestParts) <> 2 then
    raise Exception.Create('Invalid digest: ' + Digest);

  DataStream.Position := 0;

  if SameText('sha256', DigestParts[0]) then
    ActualHex := THashSHA2.GetHashString(DataStream, THashSHA2.TSHA2Version.SHA256)
  else
    raise Exception.Create('Unknown hash type: ' + DigestParts[0]);

  Result := SameText(ActualHex, DigestParts[1]);
end;

function Fetch(const Url: String; const Accept: String = 'application/vnd.github+json'): TMemoryStream;
var
  HTTP: TNetHTTPClient;
  Resp: IHTTPResponse;
begin
  Result := TMemoryStream.Create;

  HTTP := TNetHTTPClient.Create(nil);
  try
    HTTP.UserAgent := ExeInfo.Base.OriginalFileName;
    HTTP.Accept := Accept;
    HTTP.CustomHeaders['X-GitHub-Api-Version'] := '2022-11-28';
    HTTP.ConnectionTimeout := 15000;
    HTTP.ResponseTimeout   := 15000;

    Resp := HTTP.Get(Url, Result);

    Result.Position:= 0;

    if Resp.StatusCode <> 200 then
      raise Exception.Create(Resp.StatusCode.ToString + ' ' + Resp.StatusText);
  finally
    HTTP.Free;
  end;
end;

function MemoryStreamToString(DataStream: TMemoryStream): String;
begin
  DataStream.Position:= 0;

  const Reader = TStreamReader.Create(DataStream, TEncoding.UTF8);
  try
    Result := Reader.ReadToEnd;
  finally
    Reader.Free;
  end;
end;

function GetReleases: TJSONArray;
var
  MS: TMemoryStream;
  JSONText: string;
begin
  MS:= Fetch(RELEASES_API_URL);
  JSONText:= MemoryStreamToString(MS);
  MS.Free;

  Result := TJSONObject.ParseJSONValue(JSONText) as TJSONArray;
end;

function GetRelease(const Tag: String): TJSONObject;
var
  MS: TMemoryStream;
  JSONText: string;
begin
  MS:= Fetch(RELEASES_API_URL + '/tags/' + Tag, 'application/vnd.github+json');
  JSONText:= MemoryStreamToString(MS);
  MS.Free;

  Result := TJSONObject.ParseJSONValue(JSONText) as TJSONObject;
end;

function GithubCheckLatestVersion(out Version: string): Boolean;
var
  Releases: TJSONArray;
  Obj: TJSONObject;
  Tag: string;
begin
  Version := ExeInfo.FileVersion;

  Releases := GetReleases;

  try
    for var i := 0 to Releases.Count - 1 do
    begin
      Obj := Releases.Items[i] as TJSONObject;
      if Obj.TryGetValue<string>('tag_name', Tag) and IsHostTag(Tag) then
      begin
        // find only the latest NOT major version
        if CompareNumericVersions(TagToVersion(Tag), Version) >= 2 then
          Version:= TagToVersion(Tag);
      end;
    end;
  finally
    Releases.Free;
  end;

  Result:= CompareNumericVersions(Version, ExeInfo.FileVersion) > 0;
end;

function GithubUpdateVersion(const Version: string; const RestartApp: Boolean = false): Boolean;
var
  Release, AssetObj: TJSONObject;
  Assets: TJSONArray;
  AssetName, DownloadURL, ContentType, Digest, TmpFile, UpdateCmd: string;
  MS: TMemoryStream;
begin
  Result := False;

  Release:= GetRelease(VersionToTag(Version));

  try
    Assets := Release.GetValue('assets') as TJSONArray;
    if not Assigned(Assets) then
      raise Exception.Create('assets not found');

    for var i := 0 to Assets.Count - 1 do
    begin
      AssetObj := Assets.Items[i] as TJSONObject;

      if not AssetObj.TryGetValue<string>('name', AssetName) then
        Continue;

      if not SameText(AssetName, ExeInfo.Base.OriginalFileName) then
        Continue;

      if not AssetObj.TryGetValue<string>('browser_download_url', DownloadURL) then
        Continue;

      if not AssetObj.TryGetValue<string>('digest', Digest) then
        Continue;

      if not AssetObj.TryGetValue<string>('content_type', ContentType) then
        Continue;

      MS:= Fetch(DownloadURL, ContentType);

      if not IsEqualHash(Digest, MS) then
        raise Exception.Create('File hash does not match');

      TmpFile := TPath.GetTempFileName;

      MS.SaveToFile(TmpFile);
      MS.Free;

      UpdateCmd := Format(
        'cmd.exe /c for /L %%a in () do (' +
          '(tasklist|find "%s" >nul && TIMEOUT /T 1 /NOBREAK) || ' +
          '(move /Y "%s" "%s" >nul %s & exit)' +
        ')'
        , [
          ExeInfo.FileName,
          TmpFile, ExeInfo.FilePath + ExeInfo.FileName,
          if RestartApp then Format('&& (start "" "%s")', [ExeInfo.FilePath + ExeInfo.FileName]) else ''
        ]);

      Result := RunApp(UpdateCmd, SW_HIDE) = 0;

      Break;
    end;
  finally
    Release.Free;
  end;
end;

end.
