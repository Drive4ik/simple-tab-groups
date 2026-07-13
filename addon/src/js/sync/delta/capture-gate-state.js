import * as Constants from '/js/constants.js';
import * as Storage from '/js/storage.js';
import * as SyncStorage from '/js/sync/sync-storage.js';
import {createCaptureGate} from './capture-gate.js';

async function loadInputs() {
    const {syncEnable, syncOptionsLocation} = await Storage.get(['syncEnable', 'syncOptionsLocation']);

    if (syncOptionsLocation === Constants.SYNC_STORAGE_FSYNC) {
        if (!SyncStorage.IS_AVAILABLE) {
            return {syncEnable, githubGistToken: ''};
        }
        const {githubGistToken} = await SyncStorage.get(['githubGistToken']);
        return {syncEnable, githubGistToken};
    }

    const {githubGistToken} = await Storage.get(['githubGistToken'], Constants.DEFAULT_SYNC_OPTIONS);
    return {syncEnable, githubGistToken};
}

const gate = createCaptureGate({loadInputs});

export function isCaptureGateOpen() {
    return gate.isOpen();
}

export function invalidateCaptureGate() {
    gate.invalidate();
}
