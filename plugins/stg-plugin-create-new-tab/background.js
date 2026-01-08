
import * as Constants from './constants.js';
import * as Utils from './utils.js';

const TEMPORARY_CONTAINER = 'temporary-container';

browser.runtime.onMessageExternal.addListener((request, sender) => {
    if (sender.id !== Constants.STG_ID) {
        console.error(`Only STG support`);
        return;
    }

    switch(request.action) {
        case 'i-am-back':
            reloadWindowActions();
            break;
        case 'group-updated':
            if (request.group.windowId) {
                setWindowAction(request.group.windowId);
            }
            break;
        case 'group-loaded':
        case 'group-unloaded':
        case 'group-removed':
            setWindowAction(request.windowId);
            break;
    }
});

browser.action.onClicked.addListener(async () => {
    try {
        const {ok, error, group} = await getWindowGroup(browser.windows.WINDOW_ID_CURRENT);

        if (ok) {
            if (group.contextualIdentity) {
                if (TEMPORARY_CONTAINER === group.contextualIdentity.cookieStoreId) {
                    await Utils.sendExternalMessage('create-temp-tab', {
                        active: true,
                    });
                } else {
                    createNewTab({
                        cookieStoreId: group.contextualIdentity.cookieStoreId,
                    });
                }
            } else {
                createNewTab();
            }
        } else {
            createNewTab();
            Utils.notify('error', error);
        }
    } catch {
        createNewTab();
        Utils.notify('needInstallSTGExtension', browser.i18n.getMessage('needInstallSTGExtension'), {
            timerSec: 10,
            onClick: {
                action: 'open-tab',
                url: Constants.STG_HOME_PAGE,
            },
        });
    }
});

async function createNewTab(createParams = {}) {
    await browser.tabs.create({
        active: true,
        ...createParams,
    });
}

async function getWindowGroup(windowId) {
    return Utils.sendExternalMessage('get-current-group', {windowId});
}

async function reloadWindowActions() {
    const windows = await browser.windows.getAll({
        windowTypes: [browser.windows.WindowType.NORMAL],
    });

    await Promise.all(windows.map(win => setWindowAction(win.id)));
}

async function setWindowAction(windowId) {
    const {group} = await getWindowGroup(windowId).catch(() => ({}));
    const groupContainer = group?.contextualIdentity;
    const [{shortcut}] = await browser.commands.getAll();

    const titleParts = [browser.i18n.getMessage('newTabTitle')];

    if (groupContainer) {
        titleParts.push(`[${groupContainer.name}]`);
    }

    if (shortcut) {
        titleParts.push(`(${shortcut})`);
    }

    await browser.action.setIcon({
        path: await getIcon(groupContainer),
        windowId,
    });

    await browser.action.setTitle({
        title: titleParts.join(' '),
        windowId,
    });
}

// https://dxr.mozilla.org/mozilla-central/source/browser/components/contextualidentity/content
async function getIcon(container) {
    if (!container) {
        return browser.runtime.getURL('icons/icon.svg');
    }

    const {icon, colorCode, cookieStoreId} = container;

    let svg = await fetch(`/icons/${icon}.svg`).then(req => req.text());

    if (cookieStoreId !== TEMPORARY_CONTAINER) {
        svg = svg.replaceAll('fill="context-fill', `fill="${colorCode}`);
    }

    return Utils.convertSvgToUrl(svg);
}

async function setup() {
    reloadWindowActions();
}

browser.runtime.onStartup.addListener(setup);
browser.runtime.onInstalled.addListener(setup);
