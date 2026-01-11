object MainForm: TMainForm
  Left = 0
  Top = 0
  BorderIcons = [biSystemMenu, biMinimize]
  BorderStyle = bsSingle
  Caption = 'Simple Tab Groups Host'
  ClientHeight = 208
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
    208)
  TextHeight = 15
  object CloseButton: TButton
    Left = 419
    Top = 175
    Width = 88
    Height = 25
    Anchors = [akRight, akBottom]
    Caption = 'Close'
    TabOrder = 3
    OnClick = CloseButtonClick
  end
  object AboutButton: TButton
    Left = 8
    Top = 175
    Width = 88
    Height = 25
    Anchors = [akLeft, akBottom]
    Caption = 'About'
    TabOrder = 1
    OnClick = AboutButtonClick
  end
  object PageControl: TPageControl
    Left = 8
    Top = 8
    Width = 499
    Height = 161
    ActivePage = STGTabSheet
    Anchors = [akLeft, akTop, akRight, akBottom]
    TabOrder = 0
    object STGTabSheet: TTabSheet
      Caption = 'Simple Tab Groups'
      DesignSize = (
        491
        131)
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
        Top = 109
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
        491
        131)
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
        Top = 109
        Width = 107
        Height = 19
        Anchors = [akLeft, akBottom]
        Caption = 
          '<a href="https://addons.mozilla.org/firefox/addon/stg-plugin-gro' +
          'up-notes/">WebExtension page</a>'
        TabOrder = 3
        TabStop = True
        OnLinkClick = LabelLinkClick
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
    Top = 175
    Width = 143
    Height = 25
    Anchors = [akLeft, akBottom]
    Caption = 'Check for updates...'
    TabOrder = 2
    OnClick = CheckUpdatesButtonClick
  end
end
