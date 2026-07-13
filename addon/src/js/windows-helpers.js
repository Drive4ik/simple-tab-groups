
import Logger from './logger.js';
import * as Cache from './cache.js';

const logger = new Logger('Windows');

export async function get(windowId = browser.windows.WINDOW_ID_CURRENT) {
    const log = logger.start(get, {windowId});

    const win = await browser.windows.get(windowId)
        .then(Cache.loadWindowSession)
        .catch(log.onCatch(['get', windowId]));

    log.assert(win, 'windowId', windowId, 'not found');
    log.stop(win);
    return win;
}
