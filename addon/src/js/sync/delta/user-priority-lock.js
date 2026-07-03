let tail = Promise.resolve();

let userActiveCount = 0;
let trailingTimer = null;
let trailingUntil = 0;

export const DEFAULT_TRAILING_MS = 400;

export const DEFAULT_SYNC_ACQUIRE_TIMEOUT_MS = 5_000;

export const DEFAULT_SYNC_APPLY_WATCHDOG_MS = 60_000;

export function isUserActive() {
    return userActiveCount > 0 || Date.now() < trailingUntil;
}

export function runExclusive(fn) {
    const {promise: gate, resolve: release} = withResolvers();
    const previous = tail;
    tail = gate;

    return (async () => {
        try {
            await previous;
        } catch {}
        try {
            return await fn();
        } finally {
            release();
        }
    })();
}

export function beginUserMutation(trailingMs = DEFAULT_TRAILING_MS) {
    userActiveCount++;
    trailingUntil = Math.max(trailingUntil, Date.now() + trailingMs);
}

export function endUserMutation(trailingMs = DEFAULT_TRAILING_MS) {
    if (userActiveCount > 0) {
        userActiveCount--;
    }
    if (userActiveCount === 0) {
        trailingUntil = Date.now() + trailingMs;
        if (trailingTimer) {
            clearTimeout(trailingTimer);
        }
        if (typeof setTimeout === 'function') {
            trailingTimer = setTimeout(() => {
                trailingTimer = null;
            }, trailingMs);
        }
    }
}

export function runUserMutation(fn, trailingMs = DEFAULT_TRAILING_MS) {
    beginUserMutation(trailingMs);
    return runExclusive(fn).finally(() => endUserMutation(trailingMs));
}

export async function runSyncApply(fn, {
    timeoutMs = DEFAULT_SYNC_ACQUIRE_TIMEOUT_MS,
    watchdogMs = DEFAULT_SYNC_APPLY_WATCHDOG_MS,
    onWatchdog,
} = {}) {
    if (isUserActive()) {
        return {deferred: true};
    }

    let acquired = false;
    let timedOut = false;

    const {promise: timeoutPromise, resolve: fireTimeout} = withResolvers();
    const timer = (typeof setTimeout === 'function')
        ? setTimeout(() => {
            timedOut = true;
            fireTimeout({deferred: true});
        }, timeoutMs)
        : null;

    const exclusive = runExclusive(async () => {
        if (timedOut) {
            return {deferred: true};
        }
        if (isUserActive()) {
            return {deferred: true};
        }
        acquired = true;

        const startedAt = Date.now();
        let settled = false;
        const {promise: watchdogPromise, resolve: fireWatchdog} = withResolvers();
        const watchdogTimer = (typeof setTimeout === 'function')
            ? setTimeout(() => {
                if (settled) {
                    return;
                }
                const elapsedMs = Date.now() - startedAt;
                if (typeof onWatchdog === 'function') {
                    try {
                        onWatchdog({elapsedMs});
                    } catch {}
                }
                fireWatchdog({deferred: false, watchdog: true});
            }, watchdogMs)
            : null;

        const guardedApply = Promise.resolve().then(fn)
            .then(result => ({deferred: false, result}))
            .finally(() => {
                settled = true;
                if (watchdogTimer) {
                    clearTimeout(watchdogTimer);
                }
            });

        guardedApply.catch(() => {});

        return Promise.race([guardedApply, watchdogPromise]);
    });

    try {
        const winner = await Promise.race([exclusive, timeoutPromise]);
        return acquired ? winner : {deferred: true};
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

function withResolvers() {
    if (typeof Promise.withResolvers === 'function') {
        return Promise.withResolvers();
    }
    let resolve, reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return {promise, resolve, reject};
}

export function __resetForTests() {
    tail = Promise.resolve();
    userActiveCount = 0;
    trailingUntil = 0;
    if (trailingTimer) {
        clearTimeout(trailingTimer);
        trailingTimer = null;
    }
}
