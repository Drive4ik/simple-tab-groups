import Logger from './logger.js';
import {getFuncName} from './logger-utils.js';
import * as QueueCore from './queue-core.js';

const logger = new Logger('Operations');

const CHECKS_UNTIL_STUCK = 30;

const SHARED_KEY = Symbol.for('__ext_operations_shared_state__');
const shared = self[SHARED_KEY] ??= {
    idleHandlers: new Set,
    runningCount: 0,
};

// composite addon flows register here for their whole duration; consumers (the native-groups
// mirror) hold their reactions off while isBusy() and catch up on idle. The guarantee lives in
// the finally: an operation that throws still ends, idle always comes
export function run(name, fn) {
    const entry = QueueCore.enter({
        label: `operation ${name}`,
        checksUntilStuck: CHECKS_UNTIL_STUCK,
        trace: new Error,
    }, QueueCore.STATE_RUNNING);

    shared.runningCount++;

    const log = logger.start(name, 'running:', shared.runningCount);

    return Promise.try(fn).finally(() => {
        shared.runningCount--;
        QueueCore.leave(entry);

        if (!shared.runningCount) {
            for (const handler of shared.idleHandlers) {
                try {
                    handler();
                } catch (e) {
                    log.error('idle handler failed:', getFuncName(handler), String(e));
                }
            }
        }

        log.stop('running:', shared.runningCount);
    });
}

export function isBusy() {
    return shared.runningCount > 0;
}

export function onIdle(handler) {
    shared.idleHandlers.add(handler);
    return () => shared.idleHandlers.delete(handler);
}
