(async function() {
    'use strict';

    let hotkeys = [],
        foundHotKey = false,
        currentTab = null;

//     try {
//         currentTab = await browser.tabs.getCurrent();
//     } catch (e) {
//         console.warn(e);
//         return;
//     }


console.log('hotkeys load tab', currentTab);
//     if (!currentTab) {
//         throw new Error('[STG] currentTab not found');
//     }

//     if (!currentTab || currentTab.incognito) {
//         return;
//     }

    async function reloadHotKeys() {
        let options = await storage.get('hotkeys');
        hotkeys = options.hotkeys;
    }

    browser.runtime.onMessage.addListener(function(request, sender, sendResponse) {
        if (request.updateHotkeys) {
            console.log('hotkeys reload');
            reloadHotKeys().then(init);
        }
    });

    reloadHotKeys().then(init);

    function init() {
        window.removeEventListener('keydown', checkKey, false);
        window.removeEventListener('keyup', resetFoundHotKey, false);

        if (hotkeys.length) {
            console.log('hotkeys init');
            window.addEventListener('keydown', checkKey, false);
            window.addEventListener('keyup', resetFoundHotKey, false);
        }
    }

    function resetFoundHotKey() {
        foundHotKey = false;
    }

    function checkKey(e) {
        if (foundHotKey || [16, 17, 18].includes(e.keyCode)) {
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
                });

                return true;
            }
        });
    }

})();
