import * as Constants from './constants.js';

export const AUTO_BACKUP_LOCATIONS = Object.freeze({
    DOWNLOADS: 'downloads',
    HOST: 'host',
});

export const defaultOptions = Object.freeze({
    tabFaviconAsGroup: false,
    editorLineNumbers: false,
    editorLineWrapping: true,
    editorPreviewImages: true,
    editorPromptUrls: true,
    editorUseRTLDirection: false,
    autoBackupEnable: true,
    autoBackupIntervalValue: 1,
    autoBackupIntervalKey: Constants.INTERVAL_KEY.days, // minutes, hours, days
    autoBackupLocation: AUTO_BACKUP_LOCATIONS.DOWNLOADS,
    autoBackupFilePath: 'STG-notes-backups-FF-{ff-version}/STG-notes-backup {date-full} {time-short}',
});

export const BADGE_SYMBOL = '⭐️';

export const PERMISSIONS = Object.freeze({
    NATIVE_MESSAGING: {
        permissions: ['nativeMessaging'],
    },
});
