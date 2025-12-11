unit About;

// Author: Vitalii Bavykin
// Email: drive4ik+stghost@protonmail.com

interface

uses
  Winapi.Windows, System.SysUtils, System.Variants, System.Classes, Vcl.Controls, Vcl.Forms,
  Vcl.Dialogs, Vcl.StdCtrls, Vcl.ExtCtrls, Settings, Utils;

type
  TAboutForm = class(TForm)
    InfoLabel: TLabel;
    OKButton: TButton;
    AppImage: TImage;
    AppNameLabel: TLabel;
    AuthorLabel: TLabel;
    DescriptionLabel: TLabel;
    GiHubLinkLabel: TLinkLabel;
    HostLinkLabel: TLinkLabel;
    procedure OKButtonClick(Sender: TObject);
    procedure LabelLinkClick(Sender: TObject; const Link: string; LinkType: TSysLinkType);
    procedure FormShow(Sender: TObject);
    procedure FormKeyDown(Sender: TObject; var Key: Word;
      Shift: TShiftState);
  private
    { Private declarations }
  public
    { Public declarations }
  end;

var
  AboutForm: TAboutForm;

implementation

{$R *.dfm}

procedure TAboutForm.FormKeyDown(Sender: TObject; var Key: Word;
  Shift: TShiftState);
begin
  if Key = VK_ESCAPE then
    OKButton.Click;
end;

procedure TAboutForm.FormShow(Sender: TObject);
begin
  AppNameLabel.Caption:= Format('%s v%s', [ExeInfo.Base.ProductName, ExeInfo.FileVersion]);
  AuthorLabel.Caption:= ExeInfo.Base.LegalCopyright;
  DescriptionLabel.Caption:= ExeInfo.Base.FileDescription;
  AppImage.Picture.Icon.Handle:= GetExeInfo('', 0, 64).IconHandle;
  InfoLabel.Caption:= ExeInfo.Base.Comments;
  InfoLabel.AutoSize:= true;
end;

procedure TAboutForm.LabelLinkClick(Sender: TObject; const Link: string; LinkType: TSysLinkType);
begin
if LinkType = sltURL then
    OpenPath(Link);
end;

procedure TAboutForm.OKButtonClick(Sender: TObject);
begin
  Close;
end;

end.
