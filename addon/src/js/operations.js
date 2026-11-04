import Logger from './logger.js';
import {getFuncName} from './logger-utils.js';
import * as QueueCore from './queue-core.js';

const logger = new Logger('Operations');

const STUCK_AFTER = 5 * 60_000;

const SHARED_KEY = Symbol.for('__ext_operations_shared_state__');
const shared = self[SHARED_KEY] ??= {
    idleHandlers: new Set,
    runningCount: 0,
};

// a composite addon flow registers here for its whole duration (`using operation = Operations.start(name)`);
// consumers (the sub-groups mirror) hold their reactions off while isBusy() and catch up on idle. The
// guarantee lives in the dispose: an operation that throws still ends, idle always comes
export function start(name) {
    const entry = QueueCore.enter({
        label: `operation ${name}`,
        stuckAfter: STUCK_AFTER,
        trace: new Error,
    }, QueueCore.STATE_RUNNING);

    shared.runningCount++;

    const log = logger.start(name, 'running:', shared.runningCount);

    return {
        [Symbol.dispose]() {
            shared.runningCount--;
            QueueCore.leave(entry);

            if (!shared.runningCount) {
                for (const handler of shared.idleHandlers) {
                    try {
                        handler();
                    } catch (e) {
                        log.error('idle handler failed:', getFuncName(handler), e);
                    }
                }
            }

            log.stop('running:', shared.runningCount);
        },
    };
}

export function isBusy() {
    return shared.runningCount > 0;
}

export function onIdle(handler) {
    shared.idleHandlers.add(handler);
    return () => shared.idleHandlers.delete(handler);
}
