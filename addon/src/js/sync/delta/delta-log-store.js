/**
 * IndexedDB-backed store for this device's delta event log.
 *
 * The log lives here instead of `browser.storage.local` so that writing it does not
 * fan out through `storage.local.onChanged`: Firefox structure-clones the full old and
 * new value once per registered listener and holds those copies, which for the ~10 MB
 * log drove resident memory to ~1.6 GB. IndexedDB writes are point updates that no
 * `onChanged` listener observes.
 *
 * Layout: one record per event (key = the event's `seq`) plus a small meta record
 * (`{v, deviceId}` under key `'self'`), so appending is a point write instead of a
 * rewrite of the whole log. A pre-existing single-record `deltaLog` store (the v1
 * layout, whole `{v, deviceId, events}` object under one key) is split into this
 * layout inside the version-upgrade transaction on first open.
 *
 * @module sync/delta/delta-log-store
 */

const DB_NAME = 'stg-delta-sync';
const DB_VERSION = 2;
const LEGACY_STORE_NAME = 'deltaLog';
const LEGACY_RECORD_KEY = 'self';
const META_STORE_NAME = 'deltaLogMeta';
const META_KEY = 'self';
const EVENTS_STORE_NAME = 'deltaLogEvents';

let openPromise = null;

function migrateLegacyRecord(db, tx) {
    if (!db.objectStoreNames.contains(LEGACY_STORE_NAME)) {
        return;
    }

    const request = tx.objectStore(LEGACY_STORE_NAME).get(LEGACY_RECORD_KEY);

    request.onsuccess = () => {
        const record = request.result;

        if (record) {
            tx.objectStore(META_STORE_NAME).put({v: record.v, deviceId: record.deviceId}, META_KEY);

            const events = Array.isArray(record.events) ? record.events : [];
            for (const event of events) {
                if (Number.isFinite(event?.seq)) {
                    tx.objectStore(EVENTS_STORE_NAME).put(event, event.seq);
                }
            }
        }

        db.deleteObjectStore(LEGACY_STORE_NAME);
    };
}

function openDb() {
    return openPromise ??= new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(META_STORE_NAME)) {
                db.createObjectStore(META_STORE_NAME);
            }
            if (!db.objectStoreNames.contains(EVENTS_STORE_NAME)) {
                db.createObjectStore(EVENTS_STORE_NAME);
            }
            migrateLegacyRecord(db, request.transaction);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('delta-log IndexedDB open blocked'));
    }).catch(err => {
        openPromise = null;
        throw err;
    });
}

function requestToPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function writeTx(db, applyWrites) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction([META_STORE_NAME, EVENTS_STORE_NAME], 'readwrite');
        applyWrites(tx);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

async function load() {
    const db = await openDb();
    const tx = db.transaction([META_STORE_NAME, EVENTS_STORE_NAME], 'readonly');
    const [meta, events] = await Promise.all([
        requestToPromise(tx.objectStore(META_STORE_NAME).get(META_KEY)),
        requestToPromise(tx.objectStore(EVENTS_STORE_NAME).getAll()),
    ]);
    return {meta, events};
}

async function saveMeta(meta) {
    const db = await openDb();
    return writeTx(db, tx => tx.objectStore(META_STORE_NAME).put(meta, META_KEY));
}

async function putEvents(events) {
    if (!events.length) {
        return;
    }

    const db = await openDb();
    return writeTx(db, tx => {
        const store = tx.objectStore(EVENTS_STORE_NAME);
        for (const event of events) {
            store.put(event, event.seq);
        }
    });
}

async function deleteUpTo(seq) {
    const db = await openDb();
    return writeTx(db, tx => tx.objectStore(EVENTS_STORE_NAME).delete(IDBKeyRange.upperBound(seq)));
}

async function replaceEvents(events) {
    const db = await openDb();
    return writeTx(db, tx => {
        const store = tx.objectStore(EVENTS_STORE_NAME);
        store.clear();
        for (const event of events) {
            store.put(event, event.seq);
        }
    });
}

export default {load, saveMeta, putEvents, deleteUpTo, replaceEvents};
