'use strict';

import storage from '../js/storage';

let hotkeys = [],
    foundHotKey = false,
    changeHotkeysListener = function(request, sender) {
        if (sender.tab && sender.tab.incognito) {
            unsubscribeFromAllEvents();
            return;
        }

        if (request.updateHotkeys) {
            reloadHotKeys().then(init);
        }
    };

browser.runtime.onMessage.addListener(changeHotkeysListener);

async function reloadHotKeys() {
    let options = await storage.get('hotkeys');

    hotkeys = options.hotkeys;
}

reloadHotKeys().then(init);

function init() {
    resetWindowEvents();

    if (hotkeys.length) {
        addWindowEvents();
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
    if (foundHotKey || !e.isTrusted || [KeyEvent.DOM_VK_SHIFT, KeyEvent.DOM_VK_CONTROL, KeyEvent.DOM_VK_ALT].includes(e.keyCode)) { // not track only auxiliary keys
        return;
    }

    hotkeys.some(function(hotkey) {
        if (hotkey.ctrlKey === e.ctrlKey &&
            hotkey.shiftKey === e.shiftKey &&
            hotkey.altKey === e.altKey &&
            (
                (hotkey.keyCode && hotkey.keyCode === e.keyCode) ||
                (!hotkey.keyCode && !e.keyCode && hotkey.key.toLowerCase() === e.key.toLowerCase())
            )
        ) {
            foundHotKey = true;

            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            browser.runtime.sendMessage({
                    runAction: hotkey.action,
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
