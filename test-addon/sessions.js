import {POLL_WAIT, SETTLE_TIMEOUT} from './constants.js';
import {wait} from './test.js';
import {nameFromUrl} from './tabs.js';

export async function knownSessionIds() {
    const sessions = await browser.sessions.getRecentlyClosed();
    return new Set(sessions.map(session => (session.window ?? session.tab).sessionId));
}

export async function findClosedWindowSession(names, skip) {
    const started = Date.now();

    while (Date.now() - started < SETTLE_TIMEOUT) {
        for (const session of await browser.sessions.getRecentlyClosed()) {
            if (!session.window || skip.has(session.window.sessionId)) {
                continue;
            }

            const found = names.filter(name => session.window.tabs.some(tab => nameFromUrl(tab.url) === name));

            if (found.length === names.length) {
                return session;
            }
        }

        await wait(POLL_WAIT);
    }

    return null;
}

export async function findClosedTabSession(name, skip) {
    const started = Date.now();

    while (Date.now() - started < SETTLE_TIMEOUT) {
        for (const session of await browser.sessions.getRecentlyClosed()) {
            if (session.tab && !skip.has(session.tab.sessionId) && nameFromUrl(session.tab.url) === name) {
                return session;
            }
        }

        await wait(POLL_WAIT);
    }

    return null;
}
