
import {isValidHotkeyEvent, eventToHotkeyValue, NOT_SUPPORTED_CODE_KEYS} from '../js/hotkeys.js'; // ../js/ is required

const POPUP_ID = 'stg-select-group-dialog';
const isMainFrame = window.top === window;
const isOwnPage = location.protocol === 'moz-extension:';
const hotkeys = [];
let foundHotKey = false;
let popupHost = null; // the <div> whose closed shadow root holds the dialog while it is open

browser.runtime.onMessage.addListener(onMessageListener);
loadHotkeys();

// Set up key event listeners for both main frame and iframes
setKeyListeners();

async function loadHotkeys(errorCounter = 0) {
    try {
        hotkeys.length = 0;
        const result = await browser.storage.local.get({hotkeys});
        hotkeys.push(...result.hotkeys);
    } catch (e) {
        if (++errorCounter < 100) {
            setTimeout(loadHotkeys, 200, errorCounter);
        } else {
            console.error('[STG] Can\'t load hotkeys from storage', e);
        }
    }
}

function onMessageListener(request) {
    if (request.action === 'update-hotkeys') {
        hotkeys.length = 0;
        hotkeys.push(...request.hotkeys);
    } else if (request.action === 'show-groups-popup') {
        if (isMainFrame) {
            if (foundHotKey) {
                setTimeout(onMessageListener, 100, request);
            } else {
                showGroupsPopup(request);
            }
        }
    } else if (request.action === 'show-prompt') {
        if (isMainFrame) {
            return showPrompt(request);
        }
    }
}

async function sendMessageToBackground(data) {
    return await browser.runtime.sendMessage(data).catch(console.error);
}

function setKeyListeners() {
    setEventsToNode(window);

    if (document.body?.tagName !== 'BODY') { // if frameset
        setEventsToNode(document.documentElement);
        setEventsToNode(document.body);
        setEventsToNode(document);
    }
}

function setEventsToNode(node, eventOptions = {capture: true}) {
    node?.addEventListener('keydown', checkKey, eventOptions);
    node?.addEventListener('keyup', resetFoundHotKey, eventOptions);
    node?.addEventListener('blur', resetFoundHotKey, eventOptions); // then <dialog> opeded - it captures focus
}

function resetFoundHotKey() {
    foundHotKey = false;
}

function checkKey(event) {
    if (!event.isTrusted || event.repeat || foundHotKey || !hotkeys.length) {
        return;
    }

    if (NOT_SUPPORTED_CODE_KEYS.has(event.code)) {
        return;
    }

    if (popupHost?.isConnected) {
        return;
    }

    if (!isValidHotkeyEvent(event)) {
        return;
    }

    const hotkeyValue = eventToHotkeyValue(event);
    const hotkey = hotkeys.find(h => h.value === hotkeyValue);

    if (!hotkey) {
        return;
    }

    foundHotKey = true;
    stopEvent(event);

    sendMessageToBackground({
        action: hotkey.action,
        groupId: hotkey.groupId,
    });
}

function stopEvent(e) {
    e.preventDefault();
    e.stopPropagation();
}

function getBody() {
    return document.body?.tagName === 'BODY' ? document.body : document.documentElement;
}

function setNextFocus(node, vector = 'down', filterFunc = n => !n.disabled) {
    const nodes = [...node.parentElement.children].filter(filterFunc);

    let nodeIndex = nodes.indexOf(node);

    if ('down' === vector) {
        nodeIndex++;

        if (nodes[nodeIndex]) {
            nodes[nodeIndex].focus();
        } else {
            nodes[0].focus();
        }
    } else {
        if (nodeIndex === -1) {
            nodeIndex = nodes.length;
        }

        nodeIndex--;

        if (nodes[nodeIndex]) {
            nodes[nodeIndex].focus();
        } else {
            nodes.at(-1).focus();
        }
    }
}

function showGroupsPopup(data) {
    if (popupHost?.isConnected) {
        return;
    }

    const activeElement = document.activeElement;

    const host = document.createElement('div');
    const shadow = isOwnPage ? null : host.attachShadow({mode: 'closed'}); // a web page sees an empty <div>, not the groups; an own page styles the dialog by its <link>
    const root = shadow ?? document;
    const dialog = document.createElement('dialog');

    function closeGroupsPopup() {
        host.remove();
        popupHost = null;
        activeElement?.focus();
    }

    dialog.dataset.theme = data.colorScheme;
    dialog.id = POPUP_ID;
    dialog.tabIndex = -1;
    dialog.closedBy = 'any'; // a click outside the dialog closes it, the close listener does the rest
    dialog.addEventListener('close', closeGroupsPopup);
    dialog.addEventListener('keydown', e => {
        e.stopPropagation();

        const activeGroup = [...groups.children].find(node => node === root.activeElement);

        if (['PageUp', 'Home'].includes(e.code)) {
            stopEvent(e);
            setNextFocus(groups.lastElementChild, 'down');
        } else if (['PageDown', 'End'].includes(e.code)) {
            stopEvent(e);
            setNextFocus(groups.firstElementChild, 'up');
        } else if (e.code === 'Tab') {
            stopEvent(e);
            const group = activeGroup ?? (e.shiftKey ? groups.firstElementChild : groups.lastElementChild);
            setNextFocus(group, e.shiftKey ? 'up' : 'down');
        } else if (e.code === 'ArrowDown') {
            stopEvent(e);
            setNextFocus(activeGroup ?? groups.lastElementChild, 'down');
        } else if (e.code === 'ArrowUp') {
            stopEvent(e);
            setNextFocus(activeGroup ?? groups.firstElementChild, 'up');
        }
    });

    const main = document.createElement('div');
    main.classList = 'stg-main';
    dialog.append(main);

    const header = document.createElement('h2');
    header.id = `${POPUP_ID}-header`;
    header.classList = 'stg-header stg-has-text';
    header.innerText = data.popupTitle;
    main.append(header);
    dialog.setAttribute('aria-labelledby', header.id);

    const groups = document.createElement('section');
    groups.classList = 'stg-groups';
    groups.setAttribute('role', 'list');
    groups.addEventListener('mouseover', () => {
        if (root.activeElement !== dialog && groups.contains(root.activeElement)) {
            dialog.focus();
        }
    }, {passive: true});
    main.append(groups);

    function createGroupNode(group, isDisabled = false) {
        const groupNode = document.createElement('button');
        groupNode.classList = 'stg-group';
        groupNode.disabled = isDisabled;
        groupNode.setAttribute('role', 'listitem');
        groupNode.autofocus = group.id === data.focusedGroupId;

        if (!isDisabled) {
            groupNode.addEventListener('click', event => {
                if (!event.isTrusted) {
                    return;
                }

                sendMessageToBackground({
                    action: data.popupAction,
                    groupId: group.id,
                });
                closeGroupsPopup();
            });
        }

        const ariaLabelParts = [group.title];
        if (group.contextualIdentity?.name && !group.contextualIdentity.cookieStoreId.includes('default')) {
            ariaLabelParts.push(group.contextualIdentity.name);
        }
        if (group.isArchive) {
            ariaLabelParts.push(browser.i18n.getMessage('archiveGroup'));
        }
        groupNode.setAttribute('aria-label', ariaLabelParts.join(', '));

        const figureNode = document.createElement('figure');
        figureNode.classList.toggle('stg-group-sticky', group.isSticky);

        if (group.iconUrl) {
            const imgNode = document.createElement('img');
            imgNode.src = group.iconUrl;
            imgNode.alt = group.title;
            figureNode.append(imgNode);
        } else {
            figureNode.classList.add(`stg-icon-${group.icon}`); // an icon of the addon comes by the stylesheet, not by an <img> with the uuid
        }

        groupNode.append(figureNode);

        if (group.contextualIdentity?.iconUrl) {
            const containerFigureNode = document.createElement('figure');
            containerFigureNode.title = group.contextualIdentity.name;
            containerFigureNode.classList = `container-icon userContext-icon identity-icon-${group.contextualIdentity.icon} identity-color-${group.contextualIdentity.color}`;
            containerFigureNode.setAttribute('role', 'img');
            groupNode.append(containerFigureNode);
        }

        if (group.isArchive) {
            const archiveFigureNode = document.createElement('figure');
            archiveFigureNode.classList = 'stg-icon-archive';
            archiveFigureNode.title = browser.i18n.getMessage('archiveGroup');
            archiveFigureNode.setAttribute('role', 'img');
            groupNode.append(archiveFigureNode);
        }

        const titleNode = document.createElement('span');
        titleNode.classList = 'stg-has-text';
        titleNode.innerText = group.title;
        groupNode.append(titleNode);

        return groupNode;
    }

    for (const group of data.groups) {
        const node = createGroupNode(group, data.disableGroupIds?.includes(group.id));
        groups.append(node);
    }

    if (data.disableNewGroupItem !== true) {
        const newGroupNode = createGroupNode({
            id: 'new',
            title: browser.i18n.getMessage('createNewGroup'),
            icon: 'group-new',
        });

        groups.append(newGroupNode);
    }

    (shadow ?? host).append(dialog);
    getBody().append(host);
    popupHost = host;
    dialog.showModal();

    if (!data.focusedGroupId) {
        const hoveredElements = root.querySelectorAll(':hover');

        if (groups.contains(hoveredElements[hoveredElements.length - 1])) {
            dialog.focus();
        } else {
            setNextFocus(groups.lastElementChild, 'down');
        }
    }
}

let promptNowShowing = false;

async function showPrompt({promptTitle, value}) {
    if (promptNowShowing) {
        console.warn('[STG] prompt now showing');
        return;
    }

    promptNowShowing = true;

    const newValue = prompt(promptTitle, value || '');

    promptNowShowing = false;

    return newValue;
}
