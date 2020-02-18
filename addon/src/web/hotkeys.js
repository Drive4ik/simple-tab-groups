'use strict';

import './move-tab-popup.scss';

let errorCounter = 0,
    hotkeys = [],
    foundHotKey = false;

const popupId = 'stg-move-tab-to-group-popup-wrapper';

browser.runtime.onMessage.addListener(changeHotkeysListener);

init();

async function init() {
    resetWindowEvents();

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
        }

        return;
    }

    hotkeys = result.hotkeys;

    if (hotkeys.length) {
        addWindowEvents();
    }
}

function changeHotkeysListener(request, sender) {
    if (sender.id !== browser.runtime.id) {
        return;
    }

    if (request.action === 'update-hotkeys') {
        init();
    } else if ('show-groups-popup' === request.action) {
        showGroupsPopup(request);
    }
}

function resetWindowEvents() {
    window.removeEventListener('keydown', checkKey, false);
    window.removeEventListener('keyup', resetFoundHotKey, false);
}

function addWindowEvents() {
    window.addEventListener('keydown', checkKey, false);
    window.addEventListener('keyup', resetFoundHotKey, false);
}

function unsubscribeFromAllEvents() {
    resetWindowEvents();
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

            browser.runtime.sendMessage({
                    action: hotkey.action,
                    groupId: hotkey.groupId,
                })
                .then(function(response) {
                    foundHotKey = false;

                    if (response && response.unsubscribe) {
                        unsubscribeFromAllEvents();
                    }
                });

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
    if (window.top !== window || document.getElementById(popupId)) {
        return;
    }

    let wrapper = document.createElement('div'),
        closeGroupsPopup = wrapper.remove.bind(wrapper);

    if (data.enableDarkTheme) {
        wrapper.classList.add('dark-theme');
    }

    Object.assign(wrapper, {
        id: popupId,
        onclick: closeGroupsPopup,
        onkeydown: (e) => KeyEvent.DOM_VK_ESCAPE === e.keyCode ? closeGroupsPopup() : null,
    });
    document.body.append(wrapper);

    let main = document.createElement('div');
    main.classList.add('stg-popup-main');
    wrapper.append(main);

    let header = document.createElement('div');
    header.classList = 'stg-popup-has-text stg-popup-header';
    Object.assign(header, {
        tabIndex: -1,
        innerText: browser.i18n.getMessage(data.popupTitleLang),
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
        let groupNode = document.createElement('div'),
            imgNode = document.createElement('img'),
            titleNode = document.createElement('span');

        groupNode.dataset.groupId = group.id;

        groupNode.classList.add('stg-popup-group');

        imgNode.src = group.iconUrl.startsWith('/icons') ? browser.extension.getURL(group.iconUrl) : group.iconUrl;
        imgNode.classList = 'group-icon';
        groupNode.append(imgNode);

        if (group.contextualIdentity) {
            let containerImgNode = document.createElement('img');

            containerImgNode.classList = 'container-icon';
            containerImgNode.title = group.contextualIdentity.name;
            containerImgNode.src = group.contextualIdentity.iconUrl;
            containerImgNode.style.fill = group.contextualIdentity.colorCode;

            groupNode.append(containerImgNode);
        }

        if (group.isArchive) {
            let archiveImgNode = document.createElement('img');

            archiveImgNode.classList = 'archive-icon';
            archiveImgNode.src = browser.extension.getURL('/icons/archive.svg');

            groupNode.append(archiveImgNode);
        }

        titleNode.innerText = group.title;
        titleNode.classList.add('stg-popup-has-text');
        groupNode.append(titleNode);

        if (isEnabled) {
            groupNode.tabIndex = 0;

            groupNode.onmouseover = () => groupsWrapper.contains(document.activeElement) && header.focus();

            groupNode.onclick = async function(groupId, action) {
                let title = null;

                if ('new' === groupId) {
                    let {lastCreatedGroupPosition} = await browser.storage.local.get('lastCreatedGroupPosition');

                    title = prompt(
                        browser.i18n.getMessage('createNewGroup'),
                        browser.i18n.getMessage('newGroupTitle', lastCreatedGroupPosition + 1)
                    );

                    if (title === null || !title.length) {
                        return;
                    }
                }

                browser.runtime.sendMessage({groupId, action, title});
                closeGroupsPopup();
            }.bind(null, group.id, data.popupAction);

            groupNode.onkeydown = function(e) {
                if (checkUpDownKeys(e)) {
                    return;
                }

                if ([KeyEvent.DOM_VK_RETURN, KeyEvent.DOM_VK_SPACE].includes(e.keyCode)) {
                    stopEvent(e);
                    groupNode.click();
                } else if (KeyEvent.DOM_VK_TAB === e.keyCode) {
                    setFocusToNextElement(groupNode, e.shiftKey ? 'up' : 'down', e);
                } else if (KeyEvent.DOM_VK_DOWN === e.keyCode) {
                    setFocusToNextElement(groupNode, 'down', e);
                } else if (KeyEvent.DOM_VK_UP === e.keyCode) {
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
            iconUrl: browser.extension.getURL('/icons/group-new.svg'),
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
