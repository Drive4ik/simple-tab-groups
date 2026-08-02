object MainForm: TMainForm
  Left = 0
  Top = 0
  BorderIcons = [biSystemMenu, biMinimize]
  BorderStyle = bsSingle
  Caption = 'Simple Tab Groups Host'
  ClientHeight = 225
  ClientWidth = 515
  Color = clBtnFace
  Font.Charset = DEFAULT_CHARSET
  Font.Color = clWindowText
  Font.Height = -12
  Font.Name = 'Segoe UI'
  Font.Style = []
  Position = poDesktopCenter
  OnCreate = FormCreate
  OnShow = FormShow
  DesignSize = (
    515
    225)
  TextHeight = 15
  object CloseButton: TButton
    Left = 420
    Top = 193
    Width = 88
    Height = 25
    Anchors = [akRight, akBottom]
    Caption = 'Close'
    TabOrder = 3
    OnClick = CloseButtonClick
  end
  object AboutButton: TButton
    Left = 7
    Top = 193
    Width = 88
    Height = 25
    Anchors = [akLeft, akBottom]
    Caption = 'About'
    TabOrder = 1
    OnClick = AboutButtonClick
  end
  object PageControl: TPageControl
    Left = 7
    Top = 7
    Width = 501
    Height = 179
    ActivePage = STGTabSheet
    Anchors = [akLeft, akTop, akRight, akBottom]
    TabOrder = 0
    object STGTabSheet: TTabSheet
      Caption = 'Simple Tab Groups'
      DesignSize = (
        493
        149)
      object STGDeleteBackupDaysLabel: TLabel
        Left = 3
        Top = 57
        Width = 194
        Height = 15
        Caption = 'Delete backup files older than (days):'
      end
      object STGKeepBackupFilesLabel: TLabel
        Left = 3
        Top = 86
        Width = 230
        Height = 15
        Caption = 'but keep the number of recent backup files:'
        Enabled = False
      end
      object STGBackupBrowseButton: TButton
        Left = 401
        Top = 24
        Width = 89
        Height = 25
        Anchors = [akTop, akRight]
        Caption = 'Browse...'
        TabOrder = 1
        OnClick = STGBackupBrowseButtonClick
        ExplicitLeft = 402
      end
      object STGBackupFolderEdit: TLabeledEdit
        Left = 3
        Top = 25
        Width = 393
        Height = 23
        Anchors = [akLeft, akTop, akRight]
        EditLabel.Width = 76
        EditLabel.Height = 15
        EditLabel.Caption = 'Backup folder:'
        TabOrder = 0
        Text = ''
        OnChange = STGBackupFolderEditChange
      end
      object STGDeleteBackupDaysEdit: TSpinEdit
        Left = 239
        Top = 54
        Width = 102
        Height = 23
        MaxValue = 1000
        MinValue = 0
        TabOrder = 2
        Value = 0
        OnChange = STGDeleteBackupDaysEditChange
      end
      object STGLinkLabel: TLinkLabel
        Left = 3
        Top = 127
        Width = 108
        Height = 19
        Anchors = [akLeft, akBottom]
        Caption = 
          '<a href="https://addons.mozilla.org/firefox/addon/simple-tab-gro' +
          'ups/">WebExtension page</a>'
        TabOrder = 3
        TabStop = True
        OnLinkClick = LabelLinkClick
        ExplicitTop = 129
      end
      object STGKeepBackupFilesEdit: TSpinEdit
        Left = 239
        Top = 84
        Width = 102
        Height = 23
        Enabled = False
        MaxValue = 1000
        MinValue = 1
        TabOrder = 4
        Value = 1
        OnChange = STGKeepBackupFilesEditChange
      end
    end
    object NotesTabSheet: TTabSheet
      Caption = 'Group Notes'
      ImageIndex = 1
      DesignSize = (
        493
        149)
      object NotesDeleteBackupDaysLabel: TLabel
        Left = 3
        Top = 57
        Width = 194
        Height = 15
        Caption = 'Delete backup files older than (days):'
      end
      object NotesKeepBackupFilesLabel: TLabel
        Left = 3
        Top = 86
        Width = 230
        Height = 15
        Caption = 'but keep the number of recent backup files:'
        Enabled = False
      end
      object NotesBackupFolderEdit: TLabeledEdit
        Left = 3
        Top = 25
        Width = 393
        Height = 23
        Anchors = [akLeft, akTop, akRight]
        EditLabel.Width = 76
        EditLabel.Height = 15
        EditLabel.Caption = 'Backup folder:'
        TabOrder = 0
        Text = ''
        OnChange = NotesBackupFolderEditChange
      end
      object NotesBackupBrowseButton: TButton
        Left = 401
        Top = 24
        Width = 89
        Height = 25
        Anchors = [akTop, akRight]
        Caption = 'Browse...'
        TabOrder = 1
        OnClick = NotesBackupBrowseButtonClick
        ExplicitLeft = 402
      end
      object NotesDeleteBackupDaysEdit: TSpinEdit
        Left = 239
        Top = 54
        Width = 102
        Height = 23
        MaxValue = 1000
        MinValue = 0
        TabOrder = 2
        Value = 0
        OnChange = NotesDeleteBackupDaysEditChange
      end
      object NotesLinkLabel: TLinkLabel
        Left = 3
        Top = 127
        Width = 108
        Height = 19
        Anchors = [akLeft, akBottom]
        Caption = 
          '<a href="https://addons.mozilla.org/firefox/addon/stg-plugin-gro' +
          'up-notes/">WebExtension page</a>'
        TabOrder = 3
        TabStop = True
        OnLinkClick = LabelLinkClick
        ExplicitTop = 129
      end
      object NotesKeepBackupFilesEdit: TSpinEdit
        Left = 239
        Top = 84
        Width = 102
        Height = 23
        Enabled = False
        MaxValue = 1000
        MinValue = 1
        TabOrder = 4
        Value = 1
        OnChange = NotesKeepBackupFilesEditChange
      end
    end
    object SettingsTabSheet: TTabSheet
      Caption = 'Settings'
      ImageIndex = 2
      object PortableCheckBox: TCheckBox
        Left = 3
        Top = 3
        Width = 81
        Height = 19
        Caption = 'Portable'
        TabOrder = 0
        OnClick = PortableCheckBoxClick
      end
      object LogsCheckBox: TCheckBox
        Left = 3
        Top = 29
        Width = 81
        Height = 19
        Caption = 'Save Logs'
        TabOrder = 1
        OnClick = LogsCheckBoxClick
      end
    end
  end
  object CheckUpdatesButton: TButton
    Left = 102
    Top = 193
    Width = 142
    Height = 25
    Anchors = [akLeft, akBottom]
    Caption = 'Check for updates...'
    TabOrder = 2
    OnClick = CheckUpdatesButtonClick
  end
end
