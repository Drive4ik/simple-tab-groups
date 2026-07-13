import * as Constants from '/js/constants.js';
import * as Storage from '/js/storage.js';
import * as Groups from '/js/groups.js';
import * as MenusMain from '/js/menus-main.js';
import Logger from '/js/logger.js';
import {createCloudProvider} from '../cloud/provider.js';
import * as SyncStorage from '../sync-storage.js';
import {CloudError, send} from '../cloud/cloud.js?can-do-synchronization';
import {runSyncApply, isUserActive, DEFAULT_SYNC_APPLY_WATCHDOG_MS} from './user-priority-lock.js';
import * as DeltaLog from './delta-log.js';
import {invalidateCaptureGate} from './capture-gate-state.js';
import {getDeviceId} from './device-id.js';
import {planSync, baselineFromSnapshot} from './plan-sync.js';
import {
    evaluateCompaction,
    selfFoldedSeq,
    truncateSelfEvents,
    resolveDeferredTruncation,
} from './compaction.js';
import {mapStateContainers, mapEventContainers} from './container-map.js';
import {
    SNAPSHOT_FILE_NAME,
    DELTA_FILE_PREFIX,
    FAVICON_FILE_PREFIX,
    deltaFileName,
    deviceIdFromDeltaFileName,
    favIconFileName,
} from './layout.js';
import {serializeFavIconMap, mergeFavIconMaps} from './favicon-map.js';
import {applyFavIconMap} from './favicon-file.js';
import {
    storage,
    lastPushedSeqKey,
    baselineKey,
    resetPendingKey,
    pendingTruncateKey,
    favIconMapKey,
    maxSeq,
    saveBaseline,
} from './sync-marks.js';
import {gatherLocalPending} from './local-state.js';
import {buildOutboundContainerMapping, translateInboundContainers} from './container-translation.js';
import {
    applyBrowserOps,
    applyOptions,
    summarizeOps,
    beginApplyPhase,
    getCurrentApplyPhase,
    resetApplyPhase,
} from './apply-engine.js';
import {maybeBackupBeforeApply} from './pre-apply-backup.js';
import {rescheduleSoonAfterDefer, rescheduleSoonAfterLockContention} from './alarm-reschedule.js';

const logger = new Logger('DeltaSync');

DeltaLog.onOverflow(() => {
    const selfDeviceId = getDeviceId();
    delete storage[baselineKey(selfDeviceId)];
    delete storage[lastPushedSeqKey(selfDeviceId)];
    delete storage[pendingTruncateKey(selfDeviceId)];
    delete storage[favIconMapKey(selfDeviceId)];
    storage[resetPendingKey(selfDeviceId)] = '1';
});

function favIconFileToWrite(selfDeviceId, favIconMap) {
    const serialized = serializeFavIconMap(favIconMap);
    const stored = storage[favIconMapKey(selfDeviceId)];

    if (serialized === stored) {
        return null;
    }
    if (!Object.keys(favIconMap.tabs || {}).length && stored == null) {
        return null;
    }

    return {name: favIconFileName(selfDeviceId), content: favIconMap, serialized};
}

async function resolveBaseSnapshot(Cloud, cycle) {
    const snapshot = await Cloud.readFile(SNAPSHOT_FILE_NAME, null, cycle);
    if (snapshot) {
        return {snapshot, snapshotExists: true};
    }

    return {snapshot: {groups: [], watermark: {}}, snapshotExists: false};
}

async function resolvePulledDeltaLogs(Cloud, cycle) {
    const files = await Cloud.readAllMatching(DELTA_FILE_PREFIX, null, cycle);

    return (files || []).map(({name, content}) => ({
        deviceId: content?.deviceId ?? deviceIdFromDeltaFileName(name),
        events: Array.isArray(content?.events) ? content.events : [],
    }));
}

async function resolvePulledFavIconFiles(Cloud, cycle) {
    const files = await Cloud.readAllMatching(FAVICON_FILE_PREFIX, null, cycle);
    return mergeFavIconMaps(files);
}

let inProgress = false;

export async function resetSyncState() {
    if (inProgress) {
        return {ok: false, inProgress: true};
    }

    inProgress = true;

    const log = logger.start(resetSyncState);

    const selfDeviceId = getDeviceId();

    try {
        storage[resetPendingKey(selfDeviceId)] = '1';

        delete storage[baselineKey(selfDeviceId)];
        delete storage[lastPushedSeqKey(selfDeviceId)];
        delete storage[pendingTruncateKey(selfDeviceId)];
        delete storage[favIconMapKey(selfDeviceId)];

        await DeltaLog.clear();

        log.stop('reset local delta-sync state (cloud untouched)', {selfDeviceId});

        return {ok: true};
    } finally {
        inProgress = false;
    }
}

async function pushLocalPendingOnly(Cloud, selfDeviceId, localPendingEvents, lastPushedSeq, favIconMap, cycle, log) {
    const filesToWrite = {};

    if (localPendingEvents.length) {
        const {mapToPortable} = buildOutboundContainerMapping(null);
        const allEvents = await DeltaLog.getEvents();
        for (const event of allEvents) {
            mapEventContainers(event, mapToPortable);
        }

        filesToWrite[deltaFileName(selfDeviceId)] = {
            v: DeltaLog.SCHEMA_VERSION,
            deviceId: selfDeviceId,
            events: allEvents,
        };
    }

    const favIconWrite = favIconFileToWrite(selfDeviceId, favIconMap);
    if (favIconWrite) {
        filesToWrite[favIconWrite.name] = favIconWrite.content;
    }

    if (!Object.keys(filesToWrite).length) {
        return {pushed: false, faviconPushed: false};
    }

    await Cloud.writeFiles(filesToWrite, null, cycle);

    if (localPendingEvents.length) {
        storage[lastPushedSeqKey(selfDeviceId)] = maxSeq(localPendingEvents, lastPushedSeq);
    }
    if (favIconWrite) {
        storage[favIconMapKey(selfDeviceId)] = favIconWrite.serialized;
    }

    log.info('conditional fast path: pushed local pending without pull/apply', {
        events: localPendingEvents.length,
        favicons: favIconWrite ? Object.keys(favIconMap.tabs).length : 'unchanged',
    });

    return {pushed: localPendingEvents.length > 0, faviconPushed: !!favIconWrite};
}

export async function deltaSynchronization() {
    const syncResult = {ok: false};

    if (inProgress) {
        syncResult.inProgress = true;
        return syncResult;
    }

    const log = logger.start(deltaSynchronization);
    let lastProgress = 0;

    const progress = percent => {
        lastProgress = percent;
        send('sync-progress', {progress: percent});
    };

    let Cloud = null;
    let lockAcquired = false;

    try {
        inProgress = true;
        send('sync-start');
        progress(1);

        const {syncOptionsLocation, syncProvider} = await Storage.get(['syncOptionsLocation', 'syncProvider']);

        if (syncOptionsLocation === Constants.SYNC_STORAGE_FSYNC && !SyncStorage.IS_AVAILABLE) {
            const error = new CloudError('ffSyncNotSupported');
            storage.lastError = String(error);
            log.throwError('sync not supported', error);
        }

        const syncOptions = syncOptionsLocation === Constants.SYNC_STORAGE_FSYNC
            ? await SyncStorage.get()
            : await Storage.get(null, Constants.DEFAULT_SYNC_OPTIONS);

        invalidateCaptureGate();

        try {
            Cloud = createCloudProvider(syncProvider, syncOptions);
        } catch (error) {
            const cloudError = new CloudError(error.message, {cause: error});
            storage.lastError = String(cloudError);
            log.throwError('create cloud provider instance', cloudError);
        }

        const selfDeviceId = getDeviceId();

        progress(10);

        const {localState, priorBaseline, lastPushedSeq, favIconMap} =
            await gatherLocalPending(selfDeviceId, log);
        let localPendingEvents = await DeltaLog.getEventsSince(lastPushedSeq);

        const resetPending = !!storage[resetPendingKey(selfDeviceId)];

        const cycle = Cloud.beginSyncCycle ? await Cloud.beginSyncCycle() : null;
        const remoteUnchanged = !resetPending && !!cycle?.unchanged;
        if (remoteUnchanged) {
            const {pushed, faviconPushed} = await pushLocalPendingOnly(
                Cloud, selfDeviceId, localPendingEvents, lastPushedSeq, favIconMap, cycle, log,
            );

            Cloud.commitSyncCycle?.(cycle);

            progress(100);
            syncResult.ok = true;
            syncResult.progress = 100;
            syncResult.skippedPull = true;
            syncResult.changes = {local: false, cloud: pushed || faviconPushed};

            send('sync-end', syncResult);
            log.stop('remote unchanged: skipped pull/apply', {pushedLocalPending: pushed});
            return syncResult;
        }

        if (Cloud.acquireLock) {
            lockAcquired = await Cloud.acquireLock(selfDeviceId, null, cycle);
            if (!lockAcquired) {
                log.info('advisory lock held by a peer; skipping this cycle, retry soon');
                await rescheduleSoonAfterLockContention(log);

                progress(100);
                syncResult.ok = true;
                syncResult.progress = 100;
                syncResult.lockContended = true;
                syncResult.changes = {local: false, cloud: false};

                send('sync-end', syncResult);
                log.stop('advisory lock contended: skipped cycle');
                return syncResult;
            }
        }

        const {snapshot: pulledSnapshot, snapshotExists} = await resolveBaseSnapshot(Cloud, cycle);
        progress(30);
        const pulledDeltaLogs = await resolvePulledDeltaLogs(Cloud, cycle);
        const pulledFavIcons = await resolvePulledFavIconFiles(Cloud, cycle);
        progress(45);

        if (resetPending) {
            const cloudSelfWatermark = Number(pulledSnapshot?.watermark?.[selfDeviceId]) || 0;
            const pulledSelfLog = (pulledDeltaLogs || []).find(dl => dl.deviceId === selfDeviceId);
            const highestCloudSelfSeq = (pulledSelfLog?.events || []).reduce(
                (max, e) => (Number(e.seq) > max ? Number(e.seq) : max), 0,
            );
            const floor = Math.max(cloudSelfWatermark, highestCloudSelfSeq);
            const shifted = await DeltaLog.fastForwardSeqsAbove(floor);
            if (shifted) {
                localPendingEvents = await DeltaLog.getEventsSince(lastPushedSeq);
                log.info('E2: fast-forwarded local log above stale cloud watermark/delta after reset', {
                    cloudSelfWatermark,
                    highestCloudSelfSeq,
                    floor,
                    pendingEvents: localPendingEvents.length,
                });
            }
            delete storage[resetPendingKey(selfDeviceId)];
        }

        const pendingTruncateSeq = Number(storage[pendingTruncateKey(selfDeviceId)]) || 0;
        const {confirmed: deferredTruncateConfirmed, truncateSeq: confirmedTruncateSeq} =
            resolveDeferredTruncation(pendingTruncateSeq, pulledSnapshot?.watermark, selfDeviceId);

        const {shouldCompact, unfoldedCount} = evaluateCompaction(
            pulledDeltaLogs, pulledSnapshot?.watermark,
        );

        const {registry: containerRegistry, mapToPortable} = buildOutboundContainerMapping(pulledSnapshot.containers);
        mapStateContainers(localState, mapToPortable);
        for (const event of localPendingEvents) {
            mapEventContainers(event, mapToPortable);
        }

        progress(50);

        const plan = planSync({
            pulledSnapshot,
            pulledDeltaLogs,
            localPendingEvents,
            selfDeviceId,
            localState,
            priorBaseline,
            defaultGroupTitle: groupId => Groups.createTitle(null, groupId),
            pinnedGroupId: Groups.PINNED_GROUP_ID,
        });

        plan.resolvedSnapshot.containers = {...plan.resolvedSnapshot.containers, ...containerRegistry};

        const resolvedEmpty = (plan.resolvedSnapshot.groups || []).length === 0
            && (plan.resolvedSnapshot.pinnedTabs || []).length === 0;
        const localHasState = (localState.groups || []).length > 0
            || (localState.pinnedTabs || []).length > 0;
        if (resolvedEmpty && localHasState) {
            log.warn('resolved state empty but local has groups/pinned - suppressing removals this round');
            plan.browserOps.groupsToRemove = [];
            plan.browserOps.tabsToRemove = [];
            plan.browserOps.pinnedToRemove = [];
        }

        log.info('plan', {
            ops: {
                groupsToCreate: plan.browserOps.groupsToCreate.length,
                groupsToUpdate: plan.browserOps.groupsToUpdate.length,
                groupsToRemove: plan.browserOps.groupsToRemove.length,
                tabsToCreate: plan.browserOps.tabsToCreate.length,
                tabsToMove: plan.browserOps.tabsToMove.length,
                tabsToRemove: plan.browserOps.tabsToRemove.length,
                pinnedToCreate: plan.browserOps.pinnedToCreate.length,
                pinnedToMove: plan.browserOps.pinnedToMove.length,
                pinnedToRemove: plan.browserOps.pinnedToRemove.length,
            },
            willPush: !!plan.deltaFileToWrite,
        });

        progress(55);

        await translateInboundContainers(plan.browserOps, plan.optionsToApply, plan.resolvedSnapshot.containers, log);

        await maybeBackupBeforeApply(plan, log);

        resetApplyPhase();
        const applyStartedAt = Date.now();
        const applyOutcome = await runSyncApply(async () => {
            await applyBrowserOps(plan.browserOps, plan.resolvedSnapshot);

            const endOptions = beginApplyPhase('apply-options', log);
            await applyOptions(plan.optionsToApply);
            endOptions();

            const {groupsChanged} = summarizeOps(plan.browserOps, plan.optionsToApply);
            if (groupsChanged) {
                const endMenus = beginApplyPhase('menus-rebuild', log);
                const {groups: rebuiltGroups} = await Groups.load(null, false);
                await MenusMain.groupsUpdated(rebuiltGroups)
                    .catch(log.onCatch('cant rebuild group menus after delta sync', false));
                endMenus();
            }
            resetApplyPhase();
        }, {
            watchdogMs: DEFAULT_SYNC_APPLY_WATCHDOG_MS,
            onWatchdog: ({elapsedMs}) => {
                log.warn('SYNC APPLY WATCHDOG TRIPPED: apply exceeded the held-lock bound; releasing the user-priority lock so user actions recover. Apply continues detached.', {
                    stuckPhase: getCurrentApplyPhase(),
                    elapsedMs,
                    watchdogMs: DEFAULT_SYNC_APPLY_WATCHDOG_MS,
                    sinceApplyStartMs: Date.now() - applyStartedAt,
                });
            },
        });

        if (applyOutcome.deferred || applyOutcome.watchdog) {
            log.info('apply did not complete this cycle: skipping push/watermark/baseline; rescheduling sync soon', {
                deferred: applyOutcome.deferred === true,
                watchdog: applyOutcome.watchdog === true,
                userActive: isUserActive(),
            });
            await rescheduleSoonAfterDefer(log);

            syncResult.ok = true;
            syncResult.deferred = applyOutcome.deferred === true;
            syncResult.watchdog = applyOutcome.watchdog === true;
            syncResult.progress = lastProgress;
            syncResult.changes = {local: false, cloud: false};

            send('sync-end', syncResult);
            log.stop(applyOutcome.watchdog ? 'apply watchdog tripped: no push this cycle' : 'deferred to user');
            return syncResult;
        }

        await applyFavIconMap(pulledFavIcons);

        progress(85);

        const writeSnapshot = shouldCompact || !snapshotExists;

        const cloudSelfTruncateSeq = deferredTruncateConfirmed ? confirmedTruncateSeq : 0;

        const filesToWrite = {};
        if (writeSnapshot) {
            filesToWrite[SNAPSHOT_FILE_NAME] = plan.resolvedSnapshot;
        }
        if (plan.deltaFileToWrite) {
            const selfEvents = cloudSelfTruncateSeq > 0
                ? truncateSelfEvents(plan.deltaFileToWrite.events, cloudSelfTruncateSeq)
                : plan.deltaFileToWrite.events;
            filesToWrite[deltaFileName(selfDeviceId)] = {
                v: DeltaLog.SCHEMA_VERSION,
                deviceId: plan.deltaFileToWrite.deviceId,
                events: selfEvents,
            };
        }

        const favIconWrite = favIconFileToWrite(selfDeviceId, favIconMap);
        if (favIconWrite) {
            filesToWrite[favIconWrite.name] = favIconWrite.content;
        }

        if (Object.keys(filesToWrite).length) {
            await Cloud.writeFiles(filesToWrite, null, cycle);
        }

        if (plan.deltaFileToWrite) {
            storage[lastPushedSeqKey(selfDeviceId)] = maxSeq(plan.deltaFileToWrite.events, lastPushedSeq);
        }

        if (favIconWrite) {
            storage[favIconMapKey(selfDeviceId)] = favIconWrite.serialized;
        }

        if (deferredTruncateConfirmed && confirmedTruncateSeq > 0) {
            await DeltaLog.clearUpTo(confirmedTruncateSeq);
            delete storage[pendingTruncateKey(selfDeviceId)];
            log.info('deferred truncation CONFIRMED: cloud snapshot durably carries folded events; truncated own log', {
                truncatedUpToSeq: confirmedTruncateSeq,
                cloudSelfWatermark: Number(pulledSnapshot?.watermark?.[selfDeviceId]) || 0,
            });
        }

        if (shouldCompact) {
            const foldedSelfSeq = selfFoldedSeq(plan.newWatermark, selfDeviceId, lastPushedSeq);
            if (foldedSelfSeq > 0) {
                const newPending = Math.max(pendingTruncateSeq, foldedSelfSeq);
                storage[pendingTruncateKey(selfDeviceId)] = newPending;
                log.info('compaction: wrote snapshot base + recorded DEFERRED self-truncation marker', {
                    unfoldedCount,
                    pendingTruncateSeq: newPending,
                    newWatermark: plan.newWatermark,
                });
            } else {
                log.info('compaction: rewrote snapshot base (nothing foldable to defer-truncate)', {
                    unfoldedCount,
                    newWatermark: plan.newWatermark,
                });
            }
        }

        progress(90);

        saveBaseline(selfDeviceId, baselineFromSnapshot(plan.resolvedSnapshot));

        Cloud.commitSyncCycle?.(cycle);

        progress(100);

        syncResult.ok = true;
        syncResult.progress = 100;

        syncResult.changes = {
            local: summarizeOps(plan.browserOps, plan.optionsToApply).mutatesBrowser,
            cloud: !!plan.deltaFileToWrite || !!favIconWrite,
        };

        send('sync-end', syncResult);
        log.stop();
    } catch (e) {
        syncResult.langId = e.langId;
        syncResult.progress = lastProgress;
        Object.assign(syncResult, {message: String(e), stack: e.stack});

        send('sync-error', syncResult);
        log.logError('cant delta sync', e);
        log.stopError();
    } finally {
        if (lockAcquired && Cloud?.releaseLock) {
            await Cloud.releaseLock().catch(e =>
                log.warn('cant release advisory lock; TTL will reclaim it', String(e)));
        }
        inProgress = false;
        send('sync-finish', syncResult);
    }

    return syncResult;
}
