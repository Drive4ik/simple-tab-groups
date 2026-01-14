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
    Left = 419
    Top = 192
    Width = 88
    Height = 25
    Anchors = [akRight, akBottom]
    Caption = 'Close'
    TabOrder = 3
    OnClick = CloseButtonClick
    ExplicitLeft = 417
    ExplicitTop = 176
  end
  object AboutButton: TButton
    Left = 8
    Top = 192
    Width = 88
    Height = 25
    Anchors = [akLeft, akBottom]
    Caption = 'About'
    TabOrder = 1
    OnClick = AboutButtonClick
    ExplicitTop = 176
  end
  object PageControl: TPageControl
    Left = 8
    Top = 8
    Width = 499
    Height = 178
    ActivePage = STGTabSheet
    Anchors = [akLeft, akTop, akRight, akBottom]
    TabOrder = 0
    ExplicitWidth = 497
    ExplicitHeight = 162
    object STGTabSheet: TTabSheet
      Caption = 'Simple Tab Groups'
      DesignSize = (
        491
        148)
      object STGDeleteBackupDaysLabel: TLabel
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
        Left = 400
        Top = 24
        Width = 88
        Height = 25
        Anchors = [akTop, akRight]
        Caption = 'Browse...'
        TabOrder = 1
        OnClick = STGBackupBrowseButtonClick
        ExplicitLeft = 398
      end
      object STGBackupFolderEdit: TLabeledEdit
        Left = 3
        Top = 25
        Width = 391
        Height = 23
        Anchors = [akLeft, akTop, akRight]
        EditLabel.Width = 76
        EditLabel.Height = 15
        EditLabel.Caption = 'Backup folder:'
        TabOrder = 0
        Text = ''
        OnChange = STGBackupFolderEditChange
        ExplicitWidth = 389
      end
      object STGDeleteBackupDaysEdit: TSpinEdit
        Left = 239
        Top = 54
        Width = 102
        Height = 24
        MaxValue = 1000
        MinValue = 0
        TabOrder = 2
        Value = 0
        OnChange = STGDeleteBackupDaysEditChange
      end
      object STGLinkLabel: TLinkLabel
        Left = 3
        Top = 126
        Width = 107
        Height = 19
        Anchors = [akLeft, akBottom]
        Caption = 
          '<a href="https://addons.mozilla.org/firefox/addon/simple-tab-gro' +
          'ups/">WebExtension page</a>'
        TabOrder = 3
        TabStop = True
        OnLinkClick = LabelLinkClick
        ExplicitTop = 110
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
        491
        148)
      object NotesDeleteBackupDaysLabel: TLabel
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
        Width = 391
        Height = 23
        Anchors = [akLeft, akTop, akRight]
        EditLabel.Width = 76
        EditLabel.Height = 15
        EditLabel.Caption = 'Backup folder:'
        TabOrder = 0
        Text = ''
        OnChange = NotesBackupFolderEditChange
        ExplicitWidth = 389
      end
      object NotesBackupBrowseButton: TButton
        Left = 400
        Top = 24
        Width = 88
        Height = 25
        Anchors = [akTop, akRight]
        Caption = 'Browse...'
        TabOrder = 1
        OnClick = NotesBackupBrowseButtonClick
        ExplicitLeft = 398
      end
      object NotesDeleteBackupDaysEdit: TSpinEdit
        Left = 239
        Top = 54
        Width = 102
        Height = 24
        MaxValue = 1000
        MinValue = 0
        TabOrder = 2
        Value = 0
        OnChange = NotesDeleteBackupDaysEditChange
      end
      object NotesLinkLabel: TLinkLabel
        Left = 3
        Top = 126
        Width = 107
        Height = 19
        Anchors = [akLeft, akBottom]
        Caption = 
          '<a href="https://addons.mozilla.org/firefox/addon/stg-plugin-gro' +
          'up-notes/">WebExtension page</a>'
        TabOrder = 3
        TabStop = True
        OnLinkClick = LabelLinkClick
        ExplicitTop = 110
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
  object CheckUpdatesButton: TButton
    Left = 102
    Top = 192
    Width = 143
    Height = 25
    Anchors = [akLeft, akBottom]
    Caption = 'Check for updates...'
    TabOrder = 2
    OnClick = CheckUpdatesButtonClick
    ExplicitTop = 176
  end
end
