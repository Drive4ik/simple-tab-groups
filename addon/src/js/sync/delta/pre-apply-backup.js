import * as Storage from '/js/storage.js';
import backgroundSelf from '/js/background.js';
import {summarizeOps} from './apply-engine.js';
import {
    storage,
    PRE_APPLY_BACKUP_SLOTS,
    PRE_APPLY_BACKUP_SLOT_KEY,
    preApplyBackupFilePath,
} from './sync-marks.js';

function planMutatesBrowser(plan) {
    return summarizeOps(plan.browserOps, plan.optionsToApply).mutatesBrowser;
}

export async function maybeBackupBeforeApply(plan, log) {
    if (!planMutatesBrowser(plan)) {
        return;
    }

    const {syncBackupBeforeApply, syncBackupFilePath, syncBackupLocation} = await Storage.get([
        'syncBackupBeforeApply',
        'syncBackupFilePath',
        'syncBackupLocation',
    ]);
    if (!syncBackupBeforeApply) {
        return;
    }

    const prevSlot = Number(storage[PRE_APPLY_BACKUP_SLOT_KEY]);
    const slot = Number.isInteger(prevSlot) && prevSlot >= 0 ? prevSlot % PRE_APPLY_BACKUP_SLOTS : 0;

    log.info('pre-apply safety backup', {slot});

    await backgroundSelf.createBackup(true, false, false, preApplyBackupFilePath(syncBackupFilePath, slot), syncBackupLocation);

    storage[PRE_APPLY_BACKUP_SLOT_KEY] = (slot + 1) % PRE_APPLY_BACKUP_SLOTS;
}
