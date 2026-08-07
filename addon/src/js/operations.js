import Logger from './logger.js';
import {getFuncName} from './logger-utils.js';

const logger = new Logger('Operations');

const running = new Set;
const idleHandlers = new Set;

// composite addon flows register here for their whole duration; consumers (the native-groups
// mirror) hold their reactions off while isBusy() and catch up on idle. The guarantee lives in
// the finally: an operation that throws still ends, idle always comes
export function run(name, fn) {
    const operation = {name};

    running.add(operation);
    logger.log('start', name, 'running:', running.size);

    return Promise.resolve().then(fn).finally(() => {
        running.delete(operation);
        logger.log('end', name, 'running:', running.size);

        if (!running.size) {
            for (const handler of idleHandlers) {
                try {
                    handler();
                } catch (e) {
                    logger.error('idle handler failed:', getFuncName(handler), String(e));
                }
            }
        }
    });
}

export function isBusy() {
    return running.size > 0;
}

export function onIdle(handler) {
    idleHandlers.add(handler);
    return () => idleHandlers.delete(handler);
}
