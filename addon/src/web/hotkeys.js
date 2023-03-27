'use strict';

import './move-tab-popup.scss';
import Messages from '../js/messages.js';

let errorCounter = 0,
    hotkeys = [],
    foundHotKey = false;

const POPUP_ID = 'stg-move-tab-to-group-popup-wrapper';

browser.runtime.onMessage.addListener(changeHotkeysListener);

window.addEventListener('unload', unsubscribeAllListeners);

init();

async function init() {
    removeWindowListeners();

    let result = null;

    try {
        result = await browser.storage.local.get({hotkeys});

        if (!result) {
            throw Error;
        }
    } catch (e) {
        errorCounter++;

        if (errorCounter < 100) {
            setTimeout(init, 200);
        } else {
            console.error('[STG] can\'t load hotkeys from storage');
            errorCounter = 0;
        }

        return;
    }

    hotkeys = result.hotkeys;

    if (hotkeys.length) {
        addWindowListeners();
    }
}

function changeHotkeysListener(request) {
    if (request.action === 'update-hotkeys') {
        init();
    } else if (request.action === 'show-groups-popup') {
        showGroupsPopup(request);
    } else if (request.action === 'show-prompt') {
        showPrompt(request);
    }
}

function removeWindowListeners() {
    window.removeEventListener('keydown', checkKey);
    window.removeEventListener('keyup', resetFoundHotKey);
}

function addWindowListeners() {
    window.addEventListener('keydown', checkKey);
    window.addEventListener('keyup', resetFoundHotKey);
}

function unsubscribeAllListeners() {
    removeWindowListeners();
    browser.runtime.onMessage.removeListener(changeHotkeysListener);
}

function resetFoundHotKey() {
    foundHotKey = false;
}

function checkKey(e) {
    if (foundHotKey || [KeyEvent.DOM_VK_SHIFT, KeyEvent.DOM_VK_CONTROL, KeyEvent.DOM_VK_ALT, KeyEvent.DOM_VK_META].includes(e.keyCode)) { // not track only auxiliary keys
        return;
    }

    hotkeys.some(function(hotkey) {
        if (hotkey.ctrlKey === e.ctrlKey &&
            hotkey.shiftKey === e.shiftKey &&
            hotkey.altKey === e.altKey &&
            hotkey.metaKey === e.metaKey &&
            (
                (hotkey.keyCode && hotkey.keyCode === e.keyCode) ||
                (!hotkey.keyCode && !e.keyCode && hotkey.key.toUpperCase() === e.key.toUpperCase())
            )
        ) {
            foundHotKey = true;

            stopEvent(e);

            Messages.sendMessage(hotkey.action, {
                    groupId: hotkey.groupId,
                })
                .then(() => foundHotKey = false);

            return true;
        }
    });
}

function stopEvent(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
}

function showGroupsPopup(data) {
    if (document.getElementById(POPUP_ID)) {
        return;
    }

    let wrapper = document.createElement('div'),
        closeGroupsPopup = wrapper.remove.bind(wrapper),
        isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

    wrapper.dataset.theme = (data.theme === 'auto' && isDark) ? 'dark' : data.theme;

    Object.assign(wrapper, {
        id: POPUP_ID,
        onclick: closeGroupsPopup,
        onkeydown: ({keyCode}) => KeyEvent.DOM_VK_ESCAPE === keyCode ? closeGroupsPopup() : null,
    });
    document.body.append(wrapper);

    let main = document.createElement('div');
    main.classList.add('stg-popup-main');
    wrapper.append(main);

    let header = document.createElement('div');
    header.classList = 'stg-popup-has-text stg-popup-header';
    Object.assign(header, {
        tabIndex: -1,
        innerText: data.popupTitle,
        onclick: e => e.stopPropagation(),
        onkeydown: function(e) {
            if (checkUpDownKeys(e)) {
                return;
            }

            if (KeyEvent.DOM_VK_DOWN === e.keyCode) {
                setFocusToNextElement(groupsWrapper.lastElementChild, 'down', e);
            } else if (KeyEvent.DOM_VK_UP === e.keyCode) {
                setFocusToNextElement(groupsWrapper.firstElementChild, 'up', e);
            }
        },
    });
    main.append(header);

    let groupsWrapper = document.createElement('div');
    groupsWrapper.classList.add('stg-popup-groups-wrapper');
    main.append(groupsWrapper);

    function checkUpDownKeys(e) {
        if ([KeyEvent.DOM_VK_PAGE_UP, KeyEvent.DOM_VK_HOME].includes(e.keyCode)) {
            setFocusToNextElement(groupsWrapper.lastElementChild, 'down', e);
            return true;
        } else if ([KeyEvent.DOM_VK_PAGE_DOWN, KeyEvent.DOM_VK_END].includes(e.keyCode)) {
            setFocusToNextElement(groupsWrapper.firstElementChild, 'up', e);
            return true;
        }
    }

    function createGroupNode(group, isEnabled) {
        let groupNode = document.createElement('div');
        groupNode.dataset.groupId = group.id;
        groupNode.classList.add('stg-popup-group');

        let imgNode = document.createElement('img');
        imgNode.src = group.iconUrl.startsWith('/icons') ? browser.runtime.getURL(group.iconUrl) : group.iconUrl;

        let figureNode = document.createElement('figure');
        figureNode.classList = 'group-icon';
        group.isSticky && figureNode.classList.add('is-sticky');
        figureNode.append(imgNode);

        groupNode.append(figureNode);

        if (group.contextualIdentity) {
            let containerImgNode = document.createElement('img');

            containerImgNode.title = group.contextualIdentity.name;
            containerImgNode.src = group.contextualIdentity.iconUrl;
            containerImgNode.style.fill = group.contextualIdentity.colorCode;

            let containerFigureNode = document.createElement('figure');
            containerFigureNode.classList = 'container-icon';
            containerFigureNode.append(containerImgNode);

            groupNode.append(containerFigureNode);
        }

        /*if (group.isArchive) {
            let archiveImgNode = document.createElement('img');

            archiveImgNode.classList = 'archive-icon';
            archiveImgNode.src = browser.runtime.getURL('/icons/archive.svg');

            groupNode.append(archiveImgNode);
        }*/

        let titleNode = document.createElement('span');
        titleNode.innerText = group.title;
        titleNode.classList.add('stg-popup-has-text');
        groupNode.append(titleNode);

        if (isEnabled) {
            groupNode.tabIndex = 0;

            groupNode.onmouseover = () => groupsWrapper.contains(document.activeElement) && header.focus();

            groupNode.onclick = function(sendData) {
                Messages.sendMessage(sendData).catch(e => console.error(e));
                closeGroupsPopup();
            }.bind(null, {
                ...data,
                action: data.popupAction,
                groupId: group.id,
            });

            groupNode.onkeydown = function(e) {
                if (checkUpDownKeys(e)) {
                    return;
                }

                if (e.key === 'Enter' || e.code === 'Space') {
                    stopEvent(e);
                    groupNode.click();
                } else if (e.key === 'Tab') {
                    setFocusToNextElement(groupNode, e.shiftKey ? 'up' : 'down', e);
                } else if (e.key === 'ArrowDown') {
                    setFocusToNextElement(groupNode, 'down', e);
                } else if (e.key === 'ArrowUp') {
                    setFocusToNextElement(groupNode, 'up', e);
                }
            };
        } else {
            groupNode.tabIndex = -1;
            groupNode.classList.add('stg-popup-disabled');
            groupNode.onclick = function(e) {
                e.stopPropagation();
                header.focus();
            };
        }

        return groupNode;
    }

    function setFocusToNextElement(node, vector = 'down', eventToStop = false) {
        if (eventToStop) {
            stopEvent(eventToStop);
        }

        let nodes = Array.from(groupsWrapper.children).filter(n => !n.classList.contains('stg-popup-disabled')),
            nodeIndex = nodes.indexOf(node);

        if ('down' === vector) {
            nodeIndex++;

            if (nodes[nodeIndex]) {
                nodes[nodeIndex].focus();
            } else {
                nodes[0].focus();
            }
        } else {
            if (-1 === nodeIndex) {
                nodeIndex = nodes.length;
            }

            nodeIndex--;

            if (nodes[nodeIndex]) {
                nodes[nodeIndex].focus();
            } else {
                nodes[nodes.length - 1].focus();
            }
        }
    }

    if (!Array.isArray(data.disableGroupIds)) {
        data.disableGroupIds = [];
    }

    data.groups.forEach(group => groupsWrapper.append(createGroupNode(group, !data.disableGroupIds.includes(group.id))));

    if (true !== data.disableNewGroupItem) {
        let newGroupNode = createGroupNode({
            id: 'new',
            title: browser.i18n.getMessage('createNewGroup'),
            iconUrl: browser.runtime.getURL('/icons/group-new.svg'),
        }, true);

        // newGroupNode.style.justifyContent = 'center';

        groupsWrapper.append(newGroupNode);
    }

    setTimeout(function() {
        wrapper.style.transform = 'none';
        wrapper.style.opacity = '1';
        wrapper.style.visibility = 'visible';

        if (data.focusedGroupId) {
            [...groupsWrapper.children].some(function(groupNode) {
                if (data.focusedGroupId == groupNode.dataset.groupId) {
                    groupNode.focus();
                    return true;
                }
            });
        } else {
            let hoveredElements = document.querySelectorAll(':hover');

            if (groupsWrapper.contains(hoveredElements[hoveredElements.length - 1])) {
                header.focus();
            } else {
                setFocusToNextElement(groupsWrapper.lastElementChild, 'down');
            }
        }

    }, 50);
}

let promptNowShowing = false;

async function showPrompt({promptTitle, value}) {
    if (promptNowShowing) {
        console.warn('[STG] prompt now showing');
        return;
    }

    promptNowShowing = true;

    let newValue = prompt(promptTitle, value || '');

    promptNowShowing = false;

    return newValue;
}
