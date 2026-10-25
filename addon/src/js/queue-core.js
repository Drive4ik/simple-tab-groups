// the list of everything running right now (queue turns, operations) and the stuck check over it:
// an entry that stays in one state longer than its stuckAfter is logged as stuck, once it ends - as released
import Logger from './logger.js';
import {getStack} from './logger-utils.js';

export const STATE_WAITING = 'waiting';
export const STATE_RUNNING = 'running';

const logger = new Logger('QueueCore');

const CHECK_INTERVAL = 10_000;
const REPORT_LIMIT = 10;
const STACK_LIMIT = 10;

const SHARED_KEY = Symbol.for('__ext_queue_core_shared_state__');
const shared = self[SHARED_KEY] ??= {
    entries: new Set,
    queueNames: new Set,
    checkTimer: null,
};

const {entries, queueNames} = shared;

export function registerQueue(name) {
    if (queueNames.has(name)) {
        throw new Error(`queue "${name}" already exists`);
    }

    queueNames.add(name);
}

export function setState(entry, state) {
    entry.state = state;
    entry.since = Date.now();
}

export function enter(entry, state) {
    setState(entry, state);
    entry.enteredAt = entry.since;
    entries.add(entry);
    shared.checkTimer ??= setTimeout(check, CHECK_INTERVAL);

    return entry;
}

export function leave(entry) {
    entries.delete(entry);

    if (entry.reported) {
        logger.warn('released', entry.label, 'seconds:', getSeconds(entry.enteredAt));
    }
}

function check() {
    shared.checkTimer = entries.size ? setTimeout(check, CHECK_INTERVAL) : null;

    const now = Date.now();
    const stuck = [...entries].filter(entry => !entry.reported && now - entry.since >= entry.stuckAfter);

    if (stuck.length) {
        report(stuck);
    }
}

function report(stuck) {
    const running = [...entries].filter(entry => entry.state === STATE_RUNNING);
    const reported = stuck.slice(0, REPORT_LIMIT);

    for (const entry of reported) {
        entry.reported = true;
    }

    logger.error(
        'stuck:', stuck.length, reported.map(entry => describe(entry, running)),
        'running:', running.length, running.slice(0, REPORT_LIMIT).map(entry => entry.label),
    );
}

function describe(entry, running) {
    const blocker = entry.state === STATE_WAITING
        ? running.find(other => other.queue === entry.queue && other.key === entry.key)
        : null;

    return {
        label: entry.label,
        state: entry.state,
        seconds: getSeconds(entry.since),
        stack: entry.trace && getStack(entry.trace, 1, 1 + STACK_LIMIT),
        blockedBy: blocker ? describe(blocker, running) : null,
    };
}

function getSeconds(since) {
    return Math.round((Date.now() - since) / 1000);
}
