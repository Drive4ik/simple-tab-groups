object MainForm: TMainForm
  Left = 0
  Top = 0
  BorderIcons = [biSystemMenu, biMinimize]
  BorderStyle = bsSingle
  Caption = 'Simple Tab Groups Host'
  ClientHeight = 222
  ClientWidth = 521
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
    521
    222)
  TextHeight = 15
  object CloseButton: TButton
    Left = 425
    Top = 189
    Width = 88
    Height = 25
    Anchors = [akRight, akBottom]
    Caption = 'Close'
    TabOrder = 2
    OnClick = CloseButtonClick
  end
  object AboutButton: TButton
    Left = 8
    Top = 189
    Width = 88
    Height = 25
    Anchors = [akLeft, akBottom]
    Caption = 'About'
    TabOrder = 1
    OnClick = AboutButtonClick
  end
  object PageControl1: TPageControl
    Left = 8
    Top = 8
    Width = 505
    Height = 175
    ActivePage = STGTabSheet
    Anchors = [akLeft, akTop, akRight, akBottom]
    TabOrder = 0
    object STGTabSheet: TTabSheet
      Caption = 'Simple Tab Groups'
      DesignSize = (
        497
        145)
      object STGDeleteOldBackupLabel: TLabel
        Left = 3
        Top = 57
        Width = 194
        Height = 15
        Caption = 'Delete backup files older than (days):'
      end
      object STGKeepBackupFilesLabel: TLabel
        Left = 3
        Top = 87
        Width = 230
        Height = 15
        Caption = 'but keep the number of recent backup files:'
        Enabled = False
      end
      object STGBackupBrowseButton: TButton
        Left = 406
        Top = 24
        Width = 88
        Height = 25
        Anchors = [akTop, akRight]
        Caption = 'Browse...'
        TabOrder = 1
        OnClick = STGBackupBrowseButtonClick
      end
      object STGBackupFolderEdit: TLabeledEdit
        Left = 3
        Top = 25
        Width = 397
        Height = 23
        Anchors = [akLeft, akTop, akRight]
        EditLabel.Width = 76
        EditLabel.Height = 15
        EditLabel.Caption = 'Backup folder:'
        TabOrder = 0
        Text = ''
        OnChange = STGBackupFolderEditChange
      end
      object STGDeleteOldBackupEdit: TSpinEdit
        Left = 239
        Top = 54
        Width = 102
        Height = 24
        MaxValue = 1000
        MinValue = 0
        TabOrder = 2
        Value = 0
        OnChange = STGDeleteOldBackupEditChange
      end
      object STGLinkLabel: TLinkLabel
        Left = 3
        Top = 123
        Width = 107
        Height = 19
        Anchors = [akLeft, akBottom]
        Caption = 
          '<a href="https://addons.mozilla.org/firefox/addon/simple-tab-gro' +
          'ups/">WebExtension page</a>'
        TabOrder = 3
        TabStop = True
        OnLinkClick = LabelLinkClick
      end
      object STGKeepBackupFilesEdit: TSpinEdit
        Left = 239
        Top = 84
        Width = 102
        Height = 24
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
        497
        145)
      object NotesDeleteOldBackupLabel: TLabel
        Left = 3
        Top = 57
        Width = 194
        Height = 15
        Caption = 'Delete backup files older than (days):'
      end
      object NotesKeepBackupFilesLabel: TLabel
        Left = 3
        Top = 87
        Width = 230
        Height = 15
        Caption = 'but keep the number of recent backup files:'
        Enabled = False
      end
      object NotesBackupFolderEdit: TLabeledEdit
        Left = 3
        Top = 25
        Width = 397
        Height = 23
        Anchors = [akLeft, akTop, akRight]
        EditLabel.Width = 76
        EditLabel.Height = 15
        EditLabel.Caption = 'Backup folder:'
        TabOrder = 0
        Text = ''
        OnChange = NotesBackupFolderEditChange
        ExplicitWidth = 429
      end
      object NotesBackupBrowseButton: TButton
        Left = 406
        Top = 24
        Width = 88
        Height = 25
        Anchors = [akTop, akRight]
        Caption = 'Browse...'
        TabOrder = 1
        OnClick = NotesBackupBrowseButtonClick
        ExplicitLeft = 438
      end
      object NotesDeleteOldBackupEdit: TSpinEdit
        Left = 239
        Top = 54
        Width = 102
        Height = 24
        MaxValue = 1000
        MinValue = 0
        TabOrder = 2
        Value = 0
        OnChange = NotesDeleteOldBackupEditChange
      end
      object NotesLinkLabel: TLinkLabel
        Left = 3
        Top = 123
        Width = 107
        Height = 19
        Anchors = [akLeft, akBottom]
        Caption = 
          '<a href="https://addons.mozilla.org/firefox/addon/stg-plugin-gro' +
          'up-notes/">WebExtension page</a>'
        TabOrder = 3
        TabStop = True
        OnLinkClick = LabelLinkClick
        ExplicitTop = 131
      end
      object NotesKeepBackupFilesEdit: TSpinEdit
        Left = 239
        Top = 84
        Width = 102
        Height = 24
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
      object LogsCheckBox: TCheckBox
        Left = 3
        Top = 3
        Width = 81
        Height = 19
        Caption = 'Save Logs'
        TabOrder = 0
        OnClick = LogsCheckBoxClick
      end
    end
  end
end
