/*
The talk with external extensions, the plugins among them. Who may ask what and who is told what
is Constants.EXTENSIONS_WHITE_LIST: `getActions` — the actions an extension may send to the
background (onMessageExternal of background.js, checked by isAllowedRequest), `postActions` — the
actions the background posts to it (send). Nothing goes out before the add-on is inited: the
plugins take `i-am-back` as the start (docs/DESIGN-MESSAGES.md §4).
*/

import './prefixed-storage.js';
import Logger from './logger.js';
import * as Constants from './constants.js';
import * as Messages from './messages.js';
import * as Extensions from './extensions.js';
import * as Groups from './groups.js';
import * as Utils from './utils.js';

const logger = new Logger('External');
const mainStorage = localStorage.create(Constants.MODULES.BACKGROUND);
const offListeners = new Set();
const EXTERNAL_GROUP_UPDATE_KEYS = new Set([
    'title',
    'iconUrl',
    'iconColor',
    'iconViewType',
    'isArchive',
    'isSticky',
    'newTabContainer',
]);

export function send(action, data) {
    if (!mainStorage.inited) {
        logger.warn('send: addon not yet loaded', action);
        return;
    }

    const message = Messages.normalizeSendData(action, data);

    for (const [exId, {postActions}] of Object.entries(Constants.EXTENSIONS_WHITE_LIST)) {
        if (postActions.includes(message.action) && Extensions.isEnabled(exId)) {
            Messages.sendExternalMessage(exId, message);
        }
    }
}

export function isAllowedRequest(request, sender, extensionRules = {}) {
    // if (sender?.id?.startsWith('test-stg-action')) {
    //     return true;
    // }

    const extension = Constants.EXTENSIONS_WHITE_LIST[sender.id];

    if (!extension) {
        return false;
    }

    Object.assign(extensionRules, extension);

    if (!request || 'object' !== Utils.type(request)) {
        extensionRules.error = 'request is wrong';
        return false;
    }

    return extension.getActions.includes(request.action);
}

export function getTitle(extId) {
    return Constants.EXTENSIONS_WHITE_LIST[extId]?.title ?? 'Unknown';
}

export function addListeners() {
    offListeners.add(Groups.on('added', onAdded));
    offListeners.add(Groups.on('updated', onUpdated));
    offListeners.add(Groups.on('removed', onRemoved));
    offListeners.add(Groups.on('loaded', onLoaded));
    offListeners.add(Groups.on('unloaded', onUnloaded));
}

export function removeListeners() {
    offListeners.forEach(off => off());
    offListeners.clear();
}

function sendMappedGroup(action, group, data = {}) {
    send(action, {
        ...data,
        group: Groups.mapForExternalExtension(group),
    });
}

function onAdded({group, windowId}) {
    sendMappedGroup('group-added', group, {windowId});
}

function hasExternalGroupUpdateKeys(group) {
    return Object.keys(group).some(key => EXTERNAL_GROUP_UPDATE_KEYS.has(key));
}

function onUpdated({group, fullGroup}) {
    if (!hasExternalGroupUpdateKeys(group)) {
        return;
    }

    sendMappedGroup('group-updated', fullGroup);
}

function onRemoved({groupId, windowId}) {
    send('group-removed', {
        groupId,
        windowId,
    });
}

function onLoaded({groupId, windowId}) {
    send('group-loaded', {
        groupId,
        windowId,
    });
}

function onUnloaded({groupId, windowId}) {
    send('group-unloaded', {
        groupId,
        windowId,
    });
}
