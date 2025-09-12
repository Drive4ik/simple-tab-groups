
import './select-group-popup.css';
import {isValidHotkeyEvent, eventToHotkeyValue, NOT_SUPPORTED_CODE_KEYS} from '../js/hotkeys.js'; // ../js/ is required

let hotkeys = [],
    foundHotKey = false;

const POPUP_ID = 'stg-select-group-popup-wrapper';

browser.runtime.onMessage.addListener(onMessageListener);
window.addEventListener('keydown', checkKey);
window.addEventListener('keyup', resetFoundHotKey);

loadHotkeys();

async function loadHotkeys(errorCounter = 0) {
    try {
        ({hotkeys} = await browser.storage.local.get({hotkeys}));
    } catch (e) {
        errorCounter++;

        if (errorCounter < 100) {
            setTimeout(loadHotkeys, 200, errorCounter);
        } else {
            console.error('[STG] can\'t load hotkeys from storage');
        }
    }
}

function onMessageListener(request) {
    if (request.action === 'update-hotkeys') {
        hotkeys = request.hotkeys;
    } else if (request.action === 'show-groups-popup') {
        if (foundHotKey) {
            setTimeout(onMessageListener, 100, request);
        } else {
            showGroupsPopup(request);
        }
    } else if (request.action === 'show-prompt') {
        return showPrompt(request);
    }
}

function resetFoundHotKey() {
    foundHotKey = false;
}

function checkKey(event) {
    if (
        foundHotKey ||
        !hotkeys.length ||
        event.repeat ||
        NOT_SUPPORTED_CODE_KEYS.has(event.code) ||
        document.getElementById(POPUP_ID) ||
        !isValidHotkeyEvent(event)
    ) {
        return;
    }

    const hotkeyValue = eventToHotkeyValue(event);

    for (const hotkey of hotkeys) {
        if (hotkeyValue === hotkey.value) {
            foundHotKey = true;

            stopEvent(event);

            browser.runtime.sendMessage(hotkey).catch(() => {});

            break;
        }
    }
}

function stopEvent(e) {
    e.preventDefault();
    e.stopPropagation();
}

function showGroupsPopup(data) {
    if (document.getElementById(POPUP_ID)) {
        return;
    }

    const wrapper = document.createElement('aside');
    const closeGroupsPopup = wrapper.remove.bind(wrapper);

    if (data.colorScheme === 'auto') {
        wrapper.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } else {
        wrapper.dataset.theme = data.colorScheme;
    }

    wrapper.id = POPUP_ID;
    wrapper.onclick = closeGroupsPopup;
    wrapper.onkeydown = ({code}) => code === 'Escape' ? closeGroupsPopup() : null;
    document.body.append(wrapper);

    const main = document.createElement('div');
    main.classList.add('stg-popup-main');
    wrapper.append(main);

    const header = document.createElement('div');
    header.classList = 'stg-popup-has-text stg-popup-header';
    header.tabIndex = -1;
    header.innerText = data.popupTitle;
    header.onclick = e => e.stopPropagation();
    header.onkeydown = e => {
        if (checkUpDownKeys(e)) {
            return;
        }

        if (e.code === 'ArrowDown') {
            setFocusToNextElement(groupsWrapper.lastElementChild, 'down', e);
        } else if (e.code === 'ArrowUp') {
            setFocusToNextElement(groupsWrapper.firstElementChild, 'up', e);
        }
    };
    main.append(header);

    const groupsWrapper = document.createElement('div');
    groupsWrapper.classList.add('stg-popup-groups-wrapper');
    main.append(groupsWrapper);

    function checkUpDownKeys(e) {
        if (['PageUp', 'Home'].includes(e.code)) {
            setFocusToNextElement(groupsWrapper.lastElementChild, 'down', e);
            return true;
        } else if (['PageDown', 'End'].includes(e.code)) {
            setFocusToNextElement(groupsWrapper.firstElementChild, 'up', e);
            return true;
        }
    }

    function createGroupNode(group, isEnabled) {
        const groupNode = document.createElement('div');
        groupNode.dataset.groupId = group.id;
        groupNode.classList.add('stg-popup-group');

        const imgNode = document.createElement('img');
        imgNode.src = group.iconUrl.startsWith('/icons') ? browser.runtime.getURL(group.iconUrl) : group.iconUrl;

        const figureNode = document.createElement('figure');
        figureNode.classList = 'group-icon';
        group.isSticky && figureNode.classList.add('is-sticky');
        figureNode.append(imgNode);

        groupNode.append(figureNode);

        if (group.contextualIdentity?.iconUrl) {
            const containerFigureNode = document.createElement('figure');
            containerFigureNode.title = group.contextualIdentity.name;
            containerFigureNode.classList = `container-icon userContext-icon identity-icon-${group.contextualIdentity.icon} identity-color-${group.contextualIdentity.color}`;

            groupNode.append(containerFigureNode);
        }

        /*if (group.isArchive) {
            let archiveImgNode = document.createElement('img');

            archiveImgNode.classList = 'archive-icon';
            archiveImgNode.src = browser.runtime.getURL('/icons/archive.svg');

            groupNode.append(archiveImgNode);
        }*/

        const titleNode = document.createElement('span');
        titleNode.innerText = group.title;
        titleNode.classList.add('stg-popup-has-text');
        groupNode.append(titleNode);

        if (isEnabled) {
            groupNode.tabIndex = 0;

            groupNode.onmouseover = () => groupsWrapper.contains(document.activeElement) && header.focus();

            groupNode.onclick = () => {
                browser.runtime.sendMessage({
                    ...data,
                    action: data.popupAction,
                    groupId: group.id,
                }).catch(() => {});
                closeGroupsPopup();
            };

            groupNode.onkeydown = e => {
                if (checkUpDownKeys(e)) {
                    return;
                }

                if (e.code.includes('Enter') || e.code === 'Space') {
                    stopEvent(e);
                    groupNode.click();
                } else if (e.code === 'Tab') {
                    setFocusToNextElement(groupNode, e.shiftKey ? 'up' : 'down', e);
                } else if (e.code === 'ArrowDown') {
                    setFocusToNextElement(groupNode, 'down', e);
                } else if (e.code === 'ArrowUp') {
                    setFocusToNextElement(groupNode, 'up', e);
                }
            };
        } else {
            groupNode.tabIndex = -1;
            groupNode.classList.add('stg-popup-disabled');
            groupNode.onclick = e => {
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

        const nodes = Array.from(groupsWrapper.children).filter(n => !n.classList.contains('stg-popup-disabled'));

        let nodeIndex = nodes.indexOf(node);

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

    data.disableGroupIds ??= [];

    for (const group of data.groups) {
        const node = createGroupNode(group, !data.disableGroupIds.includes(group.id));
        groupsWrapper.append(node);
    }

    if (true !== data.disableNewGroupItem) {
        const newGroupNode = createGroupNode({
            id: 'new',
            title: browser.i18n.getMessage('createNewGroup'),
            iconUrl: browser.runtime.getURL('/icons/group-new.svg'),
        }, true);

        // newGroupNode.style.justifyContent = 'center';

        groupsWrapper.append(newGroupNode);
    }

    setTimeout(() => {
        wrapper.style.transform = 'none';
        wrapper.style.opacity = '1';
        wrapper.style.visibility = 'visible';

        if (data.focusedGroupId) {
            [...groupsWrapper.children].some(groupNode => {
                if (data.focusedGroupId == groupNode.dataset.groupId) {
                    groupNode.focus();
                    return true;
                }
            });
        } else {
            const hoveredElements = document.querySelectorAll(':hover');

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

    const newValue = prompt(promptTitle, value || '');

    promptNowShowing = false;

    return newValue;
}
