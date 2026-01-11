object AboutForm: TAboutForm
  Left = 0
  Top = 0
  BorderStyle = bsToolWindow
  Caption = 'About'
  ClientHeight = 241
  ClientWidth = 351
  Color = clBtnFace
  Font.Charset = DEFAULT_CHARSET
  Font.Color = clWindowText
  Font.Height = -12
  Font.Name = 'Segoe UI'
  Font.Style = []
  KeyPreview = True
  Position = poDesktopCenter
  OnKeyDown = FormKeyDown
  OnShow = FormShow
  DesignSize = (
    351
    241)
  TextHeight = 15
  object InfoLabel: TLabel
    Left = 8
    Top = 78
    Width = 335
    Height = 105
    Anchors = [akLeft, akTop, akRight, akBottom]
    AutoSize = False
    Caption = 'InfoLabel'
    WordWrap = True
    ExplicitHeight = 135
  end
  object AppImage: TImage
    Left = 8
    Top = 8
    Width = 64
    Height = 64
    Center = True
  end
  object AppNameLabel: TLabel
    Left = 78
    Top = 8
    Width = 82
    Height = 15
    Caption = 'AppNameLabel'
  end
  object AuthorLabel: TLabel
    Left = 78
    Top = 29
    Width = 65
    Height = 15
    Caption = 'AuthorLabel'
  end
  object DescriptionLabel: TLabel
    Left = 78
    Top = 50
    Width = 88
    Height = 15
    Caption = 'DescriptionLabel'
  end
  object OKButton: TButton
    Left = 255
    Top = 208
    Width = 88
    Height = 25
    Anchors = [akRight, akBottom]
    Caption = 'OK'
    TabOrder = 0
    OnClick = OKButtonClick
    ExplicitTop = 238
  end
  object GiHubLinkLabel: TLinkLabel
    Left = 8
    Top = 214
    Width = 38
    Height = 19
    Anchors = [akLeft, akBottom]
    Caption = 
      '<a href="https://github.com/Drive4ik/simple-tab-groups">GiHub</a' +
      '>'
    TabOrder = 2
    TabStop = True
    OnLinkClick = LabelLinkClick
    ExplicitTop = 244
  end
  object HomeLinkLabel: TLinkLabel
    Left = 8
    Top = 189
    Width = 66
    Height = 19
    Anchors = [akLeft, akBottom]
    Caption = 
      '<a href="https://github.com/Drive4ik/simple-tab-groups/releases"' +
      '>Home page</a>'
    TabOrder = 1
    TabStop = True
    OnLinkClick = LabelLinkClick
  end
end
