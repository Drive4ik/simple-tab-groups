import '/js/prefixed-storage.js';
import * as Utils from '/js/utils.js';
import Logger from '/js/logger.js';
import {getDeviceId} from './device-id.js';
import {sanitizeGroupIconUrl} from './url-sync.js';
import DeltaLogStore from './delta-log-store.js';
import {isCaptureGateOpen} from './capture-gate-state.js';

const logger = new Logger('DeltaLog');

export const SCHEMA_VERSION = 1;

export const MAX_EVENTS = 10_000;

const STORAGE_KEY = 'syncDeltaLog';

export const OPS = Object.freeze({
    TAB_ADD: 'tab.add',
    TAB_MODIFY: 'tab.modify',
    TAB_MOVE: 'tab.move',
    TAB_REMOVE: 'tab.remove',
    GROUP_ADD: 'group.add',
    GROUP_MODIFY: 'group.modify',
    GROUP_MOVE: 'group.move',
    GROUP_REMOVE: 'group.remove',
    OPTION_SET: 'option.set',
    PINNED_ADD: 'pinned.add',
    PINNED_MODIFY: 'pinned.modify',
    PINNED_MOVE: 'pinned.move',
    PINNED_REMOVE: 'pinned.remove',
});

const VALID_OPS = new Set(Object.values(OPS));

let events = null;
let lastSeq = 0;

let loadingPromise = null;

let writeChain = Promise.resolve();

let metaPersisted = false;

let overflowHandler = null;

export function onOverflow(handler) {
    overflowHandler = handler;
}

function dropOverflow() {
    if (events.length <= MAX_EVENTS) {
        return 0;
    }

    const dropped = events.splice(0, events.length - MAX_EVENTS);
    return dropped[dropped.length - 1].seq;
}

function notifyOverflow(droppedThroughSeq) {
    logger.warn('event cap exceeded: dropped oldest events', {droppedThroughSeq, cap: MAX_EVENTS});
    try {
        overflowHandler?.(droppedThroughSeq);
    } catch (e) {
        logger.onCatch('onOverflow handler', false)(e);
    }
}

let storeOutOfSync = false;

function enqueueWrite(operation) {
    const write = writeChain.then(async () => {
        if (storeOutOfSync) {
            await DeltaLogStore.replaceEvents(events);
            storeOutOfSync = false;
        }
        return operation();
    });
    writeChain = write.then(() => {}, () => {
        storeOutOfSync = true;
    });
    return write;
}

function currentMeta() {
    return {v: SCHEMA_VERSION, deviceId: getDeviceId()};
}

function persistAppended(newEvents) {
    const droppedThroughSeq = dropOverflow();
    const eventsToPut = droppedThroughSeq
        ? newEvents.filter(event => event.seq > droppedThroughSeq)
        : newEvents;

    const write = enqueueWrite(async () => {
        if (!metaPersisted) {
            await DeltaLogStore.saveMeta(currentMeta());
            metaPersisted = true;
        }
        await DeltaLogStore.putEvents(eventsToPut);
        if (droppedThroughSeq) {
            await DeltaLogStore.deleteUpTo(droppedThroughSeq);
        }
    });

    if (droppedThroughSeq) {
        notifyOverflow(droppedThroughSeq);
    }

    return write;
}

function stripHistoricalGroupBloat(group) {
    if (!group || typeof group !== 'object') {
        return false;
    }

    let changed = false;

    if (typeof group.iconUrl === 'string' && sanitizeGroupIconUrl(group.iconUrl) === undefined) {
        delete group.iconUrl;
        changed = true;
    }

    for (const groupTab of Array.isArray(group.tabs) ? group.tabs : []) {
        if (groupTab && typeof groupTab === 'object' && Object.hasOwn(groupTab, 'thumbnail')) {
            delete groupTab.thumbnail;
            changed = true;
        }
    }

    return changed;
}

function stripEventBloat(event) {
    return stripHistoricalGroupBloat(event?.group);
}

function ensureLoaded() {
    return loadingPromise ??= (async () => {
        const {meta, events: storedEvents} = await DeltaLogStore.load();
        metaPersisted = Boolean(meta);

        let legacyLog = null;
        if (!meta && storedEvents.length === 0) {
            const stored = await browser.storage.local.get(STORAGE_KEY);
            legacyLog = stored[STORAGE_KEY] ?? null;
        }

        events = legacyLog
            ? (Array.isArray(legacyLog.events) ? legacyLog.events : [])
            : storedEvents;
        lastSeq = events.length ? events[events.length - 1].seq : 0;

        let changed = false;
        for (const event of events) {
            if (stripEventBloat(event)) {
                changed = true;
            }
        }

        const droppedThroughSeq = dropOverflow();

        if (legacyLog) {
            logger.info('migrated delta log from storage.local to IndexedDB', {events: events.length});
            await enqueueWrite(async () => {
                await DeltaLogStore.saveMeta(currentMeta());
                metaPersisted = true;
                await DeltaLogStore.replaceEvents(events);
            });
            await browser.storage.local.remove(STORAGE_KEY);
        } else if (changed || droppedThroughSeq) {
            if (changed) {
                logger.info('migrated stored delta log: stripped historical thumbnails/icons', {events: events.length});
            }
            await enqueueWrite(async () => {
                if (droppedThroughSeq) {
                    await DeltaLogStore.deleteUpTo(droppedThroughSeq);
                }
                if (changed) {
                    await DeltaLogStore.putEvents(events);
                }
            });
        }

        if (droppedThroughSeq) {
            notifyOverflow(droppedThroughSeq);
        }
    })().catch(err => {
        loadingPromise = null;
        throw err;
    });
}

export async function append(op, payload = {}) {
    if (!VALID_OPS.has(op)) {
        logger.error('append: unknown op', op);
        return;
    }

    if (!await isCaptureGateOpen()) {
        return;
    }

    await ensureLoaded();

    const event = {
        seq: ++lastSeq,
        ts: Utils.unixNowMs(),
        op,
        ...payload,
    };

    events.push(event);

    await persistAppended([event]);

    return event;
}

export async function appendMany(items) {
    if (!Array.isArray(items) || items.length === 0) {
        return [];
    }

    if (!await isCaptureGateOpen()) {
        return [];
    }

    await ensureLoaded();

    const appended = [];

    for (const item of items) {
        if (!VALID_OPS.has(item.op)) {
            logger.error('appendMany: unknown op', item.op);
            continue;
        }

        const event = {
            ...item,
            seq: ++lastSeq,
            ts: Utils.unixNowMs(),
        };

        events.push(event);
        appended.push(event);
    }

    if (appended.length) {
        await persistAppended(appended);
    }

    return appended;
}

export async function getEvents() {
    await ensureLoaded();
    return structuredClone(events);
}

export async function getEventsSince(seq) {
    await ensureLoaded();
    return structuredClone(events.filter(event => event.seq > seq));
}

export async function clearUpTo(seq) {
    await ensureLoaded();
    events = events.filter(event => event.seq > seq);
    await enqueueWrite(() => DeltaLogStore.deleteUpTo(seq));
}

export async function getLastSeq() {
    await ensureLoaded();
    return lastSeq;
}

export async function clear() {
    await ensureLoaded();
    events = [];
    lastSeq = 0;
    loadingPromise = null;
    await enqueueWrite(() => DeltaLogStore.replaceEvents([]));
}

export async function fastForwardSeqsAbove(minSeq) {
    await ensureLoaded();

    if (!Number.isFinite(minSeq)) {
        return false;
    }

    const lowest = events.length
        ? events.reduce((min, e) => (e.seq < min ? e.seq : min), Infinity)
        : lastSeq + 1;

    if (lowest > minSeq) {
        return false;
    }

    const offset = (minSeq + 1) - lowest;
    for (const event of events) {
        event.seq += offset;
    }
    lastSeq += offset;

    const shifted = events.slice();
    await enqueueWrite(() => DeltaLogStore.replaceEvents(shifted));
    return true;
}
