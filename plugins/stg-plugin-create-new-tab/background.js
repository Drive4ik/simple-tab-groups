import Listeners from './listeners.js\
?onExtensionStart\
&action.onClicked\
&commands.onChanged\
&runtime.onMessageExternal\
';
import * as Constants from './constants.js';
import * as Utils from './utils.js';
import Notification from './notification.js';
import Lang from './lang.js';

const TEMPORARY_CONTAINER = 'temporary-container';

Listeners.runtime.onMessageExternal((request, sender) => {
    if (sender.id !== Constants.STG_ID) {
        console.error(`Only STG support`);
        return;
    }

    switch(request.action) {
        case 'i-am-back':
            reloadWindowActions();
            break;
        case 'group-updated':
            setWindowAction(request.group.windowId);
            break;
        case 'group-loaded':
        case 'group-unloaded':
        case 'group-removed':
            setWindowAction(request.windowId);
            break;
    }
});

Listeners.action.onClicked(async () => {
    try {
        const {ok, error, group} = await getWindowGroup(browser.windows.WINDOW_ID_CURRENT);

        if (ok) {
            if (group?.contextualIdentity?.cookieStoreId) {
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
            Notification(error);
        }
    } catch {
        createNewTab();
        Notification('needInstallSTGExtension', {
            tab: {
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
    if (!windowId) {
        return;
    }

    const {group} = await getWindowGroup(windowId).catch(() => ({}));
    const groupContainer = group?.contextualIdentity;
    const [{shortcut}] = await browser.commands.getAll();

    const titleParts = [Lang('newTabTitle')];

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
    if (!container?.icon) {
        return browser.runtime.getURL(Constants.MANIFEST.action.default_icon);
    }

    const {icon, colorCode, cookieStoreId} = container;

    // still unable to load from resource://usercontext-content/chill.svg (* ￣︿￣)
    let svg = await fetch(`/icons/${icon}.svg`).then(req => req.text());

    if (cookieStoreId === TEMPORARY_CONTAINER) {
        svg = svg.replaceAll('fill="context-fill', `fill="context-fill light-dark(#5b5b66,#fbfbfe)`);
    } else {
        svg = svg.replaceAll('fill="context-fill', `fill="${colorCode}`);
    }

    return Utils.convertSvgToUrl(svg);
}

async function setup() {
    reloadWindowActions();
}

Listeners.commands.onChanged(reloadWindowActions);

Listeners.onExtensionStart(setup);
