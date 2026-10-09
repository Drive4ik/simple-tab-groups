import {Test} from './test.js';

export const GRANT_URL = browser.runtime.getURL('grant.html');
export const BOOKMARKS = {permissions: ['bookmarks']};

// the optional bookmarks permission for a test of any class: asked for on the grant page when it
// is missing, the page is closed after the answer
export async function requireBookmarks(t) {
    if (!await browser.permissions.contains(BOOKMARKS)) {
        const tab = await browser.tabs.create({url: GRANT_URL, active: true});

        await t.ask('A grant page opened. Click "Grant bookmarks permission" and ALLOW the prompt. Then T.visualAnswer("granted")');
        await browser.tabs.remove(tab.id).catch(() => {});
    }

    t.require('bookmarks permission granted', await browser.permissions.contains(BOOKMARKS));
    t.require('browser.bookmarks is present', Boolean(browser.bookmarks), 'the API did not appear after the grant: reload the add-on in about:debugging and run the test again');
}

export class MenusTest extends Test {
    constructor(options) {
        super(options);
        this.openedTabs = new Set();
    }

    create(properties) {
        return new Promise(resolve => {
            browser.menus.create(properties, () => {
                const {lastError} = browser.runtime;
                resolve(lastError ? {ok: false, error: lastError.message} : {ok: true});
            });
        });
    }

    async update(id, properties) {
        try {
            await browser.menus.update(id, properties);
            return {ok: true};
        } catch (error) {
            return {ok: false, error: error.message};
        }
    }

    async remove(id) {
        try {
            await browser.menus.remove(id);
            return {ok: true};
        } catch (error) {
            return {ok: false, error: error.message};
        }
    }

    async removeAll() {
        try {
            await browser.menus.removeAll();
            return {ok: true};
        } catch (error) {
            return {ok: false, error: error.message};
        }
    }

    async exists(id) {
        return (await this.update(id, {enabled: true})).ok;
    }

    hasBookmarks() {
        return browser.permissions.contains(BOOKMARKS);
    }

    revokeBookmarks() {
        return browser.permissions.remove(BOOKMARKS);
    }

    async openGrantPage() {
        const tab = await browser.tabs.create({url: GRANT_URL, active: true});
        this.openedTabs.add(tab.id);
        return tab;
    }

    async close() {
        await browser.menus.removeAll().catch(() => {});

        for (const tabId of this.openedTabs) {
            await browser.tabs.remove(tabId).catch(() => {});
        }

        this.openedTabs.clear();
    }
}
