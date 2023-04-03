
import * as Utils from './utils.js';

const STG_ID = 'simple-tab-groups@drive4ik',
    STG_HOME_PAGE = 'https://addons.mozilla.org/firefox/addon/simple-tab-groups/',
    SUPPORTED_STG_ACTIONS = new Set(['i-am-back', 'group-loaded', 'group-unloaded', 'group-updated', 'group-removed']),
    TEMPORARY_CONTAINER = 'temporary-container';

browser.runtime.onMessageExternal.addListener((request, sender) => {
    if (sender.id !== STG_ID) {
        console.error(`Only STG support`);
        return;
    }

    if (SUPPORTED_STG_ACTIONS.has(request.action)) {
        reloadWindowActions();
    } else {
        throw Error(`unknown action: ${request.action}`);
    }
});

browser.action.onClicked.addListener(async () => {
    const currentGroupContainer = await getWindowGroupContainer(browser.windows.WINDOW_ID_CURRENT);

    if (currentGroupContainer) {
        if (TEMPORARY_CONTAINER === currentGroupContainer.cookieStoreId) {
            try {
                await sendExternalMessage({
                    action: 'create-temp-tab',
                });
            } catch (e) {
                Utils.notify('needInstallSTGExtension', browser.i18n.getMessage('needInstallSTGExtension'), {
                    timerSec: 10,
                    onClick: {
                        action: 'open-tab',
                        url: STG_HOME_PAGE,
                    },
                });
            }
        } else {
            createNewTab({
                cookieStoreId: currentGroupContainer.cookieStoreId,
            });
        }
    } else {
        createNewTab();
    }
});

async function createNewTab(createParams = {}) {
    await browser.tabs.create({
        active: true,
        ...createParams,
    });
}

async function getWindowGroup(windowId) {
    const {ok, error, group} = await sendExternalMessage({
        action: 'get-current-group',
        windowId,
    });

    if (ok) {
        return group;
    } else if (error) {
        Utils.notify(windowId, error);
    }
}

async function getWindowGroupContainer(windowId) {
    const currentGroup = await getWindowGroup(windowId);

    return currentGroup?.contextualIdentity;
}

async function updateAction(windowId, group) {
    const groupContainer = group?.contextualIdentity;
    const [{shortcut}] = await browser.commands.getAll();

    let titleParts = [browser.i18n.getMessage('newTabTitle')];

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

async function reloadWindowActions() {
    const windows = await browser.windows.getAll({
        windowTypes: [browser.windows.WindowType.NORMAL],
    });

    await Promise.all(windows.map(async win => {
        const group = await getWindowGroup(win.id);

        await updateAction(win.id, group);
    }));
}

function sendExternalMessage(data) {
    return browser.runtime.sendMessage(STG_ID, data);
}

// https://dxr.mozilla.org/mozilla-central/source/browser/components/contextualidentity/content
async function getIcon(container) {
    if (!container) {
        return browser.runtime.getURL('/icons/icon.svg');
    }

    const {icon, colorCode, cookieStoreId} = container;

    let svg = await fetch(`/icons/${icon}.svg`).then(req => req.text());

    if (cookieStoreId !== TEMPORARY_CONTAINER) {
        svg = svg.replaceAll('context-fill', colorCode);
    }

    return convertSvgToUrl(svg);
}

function convertSvgToUrl(svg) {
    return 'data:image/svg+xml;base64,' + b64EncodeUnicode(svg);
}

function b64EncodeUnicode(str) {
    // first we use encodeURIComponent to get percent-encoded UTF-8,
    // then we convert the percent encodings into raw bytes which
    // can be fed into btoa.
    return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g,
        function toSolidBytes(match, p1) {
            return String.fromCharCode('0x' + p1);
        }));
}

reloadWindowActions();
