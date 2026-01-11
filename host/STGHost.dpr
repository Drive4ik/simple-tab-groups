program STGHost;

// Author: Vitalii Bavykin
// Email: drive4ik+stghost@protonmail.com

{$R 'STGHost.res' 'STGHost.rc'}

uses
  Vcl.Forms,
  Winapi.Windows,
  System.SysUtils,
  System.JSON,
  Main in 'Main.pas' {MainForm},
  About in 'About.pas' {AboutForm},
  Utils in 'Utils.pas',
  Pipe in 'Pipe.pas',
  Settings in 'Settings.pas',
  VerInfo in 'VerInfo.pas',
  Logger in 'Logger.pas',
  GithubUpdater in 'GithubUpdater.pas';

{$IFDEF RELEASE}
  {$SETPEFlAGS IMAGE_FILE_RELOCS_STRIPPED or IMAGE_FILE_DEBUG_STRIPPED or
  IMAGE_FILE_LINE_NUMS_STRIPPED or IMAGE_FILE_LOCAL_SYMS_STRIPPED or
  IMAGE_FILE_REMOVABLE_RUN_FROM_SWAP or IMAGE_FILE_NET_RUN_FROM_SWAP}

  {$WEAKLINKRTTI ON}

  {$RTTI EXPLICIT METHODS([]) PROPERTIES([]) FIELDS([])}
{$ENDIF}

var
  hStdin: THandle;

begin
  Application.Initialize;
  Application.MainFormOnTaskbar := True;

  hStdin := GetStdHandle(STD_INPUT_HANDLE);
  if (hStdin <> INVALID_HANDLE_VALUE) and (GetFileType(hStdin) = FILE_TYPE_PIPE) then
  begin

//    AllocConsole;

    Log(sLineBreak);

    try
      const ExtensionId = ParamStr(2);

      if AllowedExtensionsMap.ContainsKey(ExtensionId) then
      begin
          var Extension: TExtension;
          AllowedExtensionsMap.TryGetValue(ExtensionId, Extension);
          Log(Format('Starting HandleNativeMessaging for %s ...', [ExtensionId]));
          var Response:= HandleNativeMessaging(ReadStdIn, Extension);
          WriteStdOut(Response.ToJSON);
          Log('Finished HandleNativeMessaging process');
      end
      else
          raise Exception.CreateFmt('invalid addon id: %s', [ExtensionId]);

    except
      on E: Exception do
      begin
        WriteStdOut(CreateResponseMessage(false, E.ToString).ToJSON);
      end;
    end;

    Exit;
  end;

  const ManifestPath = CreateManifest;
  AddRecordToRegistry(ManifestPath);

  Application.CreateForm(TMainForm, MainForm);
  Application.CreateForm(TAboutForm, AboutForm);
  Application.Run;
end.
