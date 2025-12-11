unit Main;

// Author: Vitalii Bavykin
// Email: drive4ik+stghost@protonmail.com

interface

uses
  Winapi.Windows, Winapi.Messages, System.SysUtils, System.Variants, System.Classes,
  Vcl.Controls, Vcl.Forms, Vcl.StdCtrls, Vcl.ExtCtrls, System.Win.Registry, System.IOUtils,
  System.JSON, Vcl.Mask, About, Utils, Settings, Vcl.Samples.Spin, Vcl.ComCtrls;

type
  TMainForm = class(TForm)
    STGBackupFolderEdit: TLabeledEdit;
    STGBackupBrowseButton: TButton;
    CloseButton: TButton;
    AboutButton: TButton;
    LogsCheckBox: TCheckBox;
    NotesBackupFolderEdit: TLabeledEdit;
    NotesBackupBrowseButton: TButton;
    STGDeleteOldBackupEdit: TSpinEdit;
    STGDeleteOldBackupLabel: TLabel;
    PageControl1: TPageControl;
    STGTabSheet: TTabSheet;
    NotesTabSheet: TTabSheet;
    SettingsTabSheet: TTabSheet;
    NotesDeleteOldBackupLabel: TLabel;
    NotesDeleteOldBackupEdit: TSpinEdit;
    STGLinkLabel: TLinkLabel;
    NotesLinkLabel: TLinkLabel;
    STGKeepBackupFilesLabel: TLabel;
    STGKeepBackupFilesEdit: TSpinEdit;
    NotesKeepBackupFilesLabel: TLabel;
    NotesKeepBackupFilesEdit: TSpinEdit;
    procedure CloseButtonClick(Sender: TObject);
    procedure AboutButtonClick(Sender: TObject);
    procedure STGBackupBrowseButtonClick(Sender: TObject);
    procedure LogsCheckBoxClick(Sender: TObject);
    procedure STGBackupFolderEditChange(Sender: TObject);
    procedure FormCreate(Sender: TObject);
    procedure FormShow(Sender: TObject);
    procedure NotesBackupFolderEditChange(Sender: TObject);
    procedure NotesBackupBrowseButtonClick(Sender: TObject);
    procedure STGDeleteOldBackupEditChange(Sender: TObject);
    procedure NotesDeleteOldBackupEditChange(Sender: TObject);
    procedure LabelLinkClick(Sender: TObject; const Link: string; LinkType: TSysLinkType);
    procedure NotesKeepBackupFilesEditChange(Sender: TObject);
    procedure STGKeepBackupFilesEditChange(Sender: TObject);
  private
    { Private declarations }
  public
    { Public declarations }
  end;

var
  MainForm: TMainForm;
  IsFirstLaunch: Boolean;

function CreateManifest: string;
procedure AddRecordToRegistry(const ManifestPath: string);
procedure Log(const Msg: string; const Level: string = '');

implementation

{$R *.dfm}

function CreateManifest: string;
var
  Manifest: TJSONObject;
  AllowedExtensionsJSON: TJSONArray;
begin
  Result := ExeInfo.FilePath + 'manifest.json';

  Manifest := TJSONObject.Create;
  Manifest.AddPair('name', ExeInfo.Base.InternalName);
  Manifest.AddPair('description', ExeInfo.Base.FileDescription);
  Manifest.AddPair('path', ExeInfo.FileName);
  Manifest.AddPair('type', 'stdio');

  AllowedExtensionsJSON := TJSONArray.Create;
  for var Extension in AllowedExtensionsMap.Values do
    AllowedExtensionsJSON.Add(Extension.Id);

  Manifest.AddPair('allowed_extensions', AllowedExtensionsJSON);

  WriteJSONFile(Result, Manifest, 2);
  Manifest.Free;
end;

procedure AddRecordToRegistry(const ManifestPath: string);
const
  RegRoot = 'Software\Mozilla\NativeMessagingHosts';
var
  RegIni: TRegIniFile;
  Current: string;
begin
  RegIni := TRegIniFile.Create(RegRoot);
  try
    RegIni.RootKey := HKEY_CURRENT_USER;
    IsFirstLaunch:= not RegIni.KeyExists(ExeInfo.Base.InternalName);
    Current := RegIni.ReadString(ExeInfo.Base.InternalName, '', '');
    if not SameText(Current, ManifestPath) then
      RegIni.WriteString(ExeInfo.Base.InternalName, '', ManifestPath);
  finally
    RegIni.Free;
  end;
end;

procedure Log(const Msg: string; const Level: string = '');
var
  FullName: string;
  Line: string;
  Bytes: TBytes;
begin
  if not IsLoggingEnabled then
    Exit;

  FullName := ExeInfo.FilePath + 'logs.log';

  if Msg = sLineBreak then
    Line := sLineBreak
  else
  begin
    Line := FormatDateTime('yyyy-mm-dd hh:nn:ss.zzz', Now) + ' ';
    if Level <> '' then
      Line := Line + '[' + Level + '] ';
    Line := Line + Msg + sLineBreak;
  end;

  const MaxLogSize: Int64 = 100 * 1024; // 100 KB

  if TFile.Exists(FullName) and (TFile.GetSize(FullName) > MaxLogSize) then
  begin
    Bytes := TFile.ReadAllBytes(FullName);
    var Half := Length(Bytes) div 2;
    Bytes := Copy(Bytes, Half, Length(Bytes) - Half);
    TFile.WriteAllBytes(FullName, Bytes);
  end;

  TFile.AppendAllText(FullName, Line, TEncoding.UTF8);
end;

procedure TMainForm.LabelLinkClick(Sender: TObject; const Link: string; LinkType: TSysLinkType);
begin
if LinkType = sltURL then
    OpenPath(Link);
end;

procedure TMainForm.AboutButtonClick(Sender: TObject);
begin
  AboutForm.ShowModal;
end;

procedure SelectBackupFolder(const Extension: TExtension; const Edit: TLabeledEdit);
var
  Folder: string;
begin
  Folder := SelectFolderModern('Select a folder for backups', GetBackupFolder(Extension));
  if Folder <> '' then
  begin
    Edit.Text := Folder;
    SetBackupFolder(Extension, Folder);
  end;
end;

procedure TMainForm.STGBackupBrowseButtonClick(Sender: TObject);
begin
  SelectBackupFolder(STG, STGBackupFolderEdit);
end;

procedure TMainForm.STGBackupFolderEditChange(Sender: TObject);
begin
  if STGBackupFolderEdit.Focused then
    SetBackupFolder(STG, STGBackupFolderEdit.Text);
end;

procedure TMainForm.STGDeleteOldBackupEditChange(Sender: TObject);
begin
  if STGDeleteOldBackupEdit.Focused then
    SetDeleteOldBackupDays(STG, STGDeleteOldBackupEdit.Value);

  STGKeepBackupFilesEdit.Enabled:= STGDeleteOldBackupEdit.Value > 0;
  STGKeepBackupFilesLabel.Enabled:= STGKeepBackupFilesEdit.Enabled;
end;

procedure TMainForm.STGKeepBackupFilesEditChange(Sender: TObject);
begin
  if STGKeepBackupFilesEdit.Focused then
    SetKeepBackupFiles(STG, STGKeepBackupFilesEdit.Value);
end;

procedure TMainForm.NotesBackupBrowseButtonClick(Sender: TObject);
begin
  SelectBackupFolder(NOTES, NotesBackupFolderEdit);
end;

procedure TMainForm.CloseButtonClick(Sender: TObject);
begin
  Close;
end;

procedure TMainForm.FormCreate(Sender: TObject);
begin
  Application.Title:= Format('%s v%s', [ExeInfo.Base.ProductName, ExeInfo.FileVersion]);
  MainForm.Caption:= Application.Title;

  STGBackupFolderEdit.Text := GetBackupFolder(STG, false);
  NotesBackupFolderEdit.Text := GetBackupFolder(NOTES, false);

  STGDeleteOldBackupEdit.Value:= GetDeleteOldBackupDays(STG);
  NotesDeleteOldBackupEdit.Value:= GetDeleteOldBackupDays(NOTES);

  STGKeepBackupFilesEdit.Value:= GetKeepBackupFiles(STG);
  NotesKeepBackupFilesEdit.Value:= GetKeepBackupFiles(NOTES);

  LogsCheckBox.Checked := IsLoggingEnabled;
end;

procedure TMainForm.FormShow(Sender: TObject);
begin
  if IsFirstLaunch then
    AboutButton.Click;
end;

procedure TMainForm.LogsCheckBoxClick(Sender: TObject);
begin
  if LogsCheckBox.Focused then
    SetLoggingEnabled(LogsCheckBox.Checked);
end;

procedure TMainForm.NotesBackupFolderEditChange(Sender: TObject);
begin
  if NotesBackupFolderEdit.Focused then
    SetBackupFolder(NOTES, NotesBackupFolderEdit.Text);
end;

procedure TMainForm.NotesDeleteOldBackupEditChange(Sender: TObject);
begin
  if NotesDeleteOldBackupEdit.Focused then
    SetDeleteOldBackupDays(NOTES, NotesDeleteOldBackupEdit.Value);

  NotesKeepBackupFilesEdit.Enabled:= NotesDeleteOldBackupEdit.Value > 0;
  NotesKeepBackupFilesLabel.Enabled:= NotesKeepBackupFilesEdit.Enabled;
end;

procedure TMainForm.NotesKeepBackupFilesEditChange(Sender: TObject);
begin
  if NotesKeepBackupFilesEdit.Focused then
    SetKeepBackupFiles(NOTES, NotesKeepBackupFilesEdit.Value);
end;

end.
