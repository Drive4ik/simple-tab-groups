(function() {
    'use strict';
console.log('=====================================');
    let hotkeys = [],
        foundHotKey = false;

    async function loadHotKeys() {
        let options = await storage.get('hotkeys');
        hotkeys = options.hotkeys;
    }

    browser.runtime.onMessage.addListener(function(request, sender, sendResponse) {
        if (request.optionsUpdated && request.optionsUpdated.includes('hotkeys')) {
            loadHotKeys().then(init);
        }
    });

    loadHotKeys().then(init);

    function init() {
        removeWindowEvents();

        if (hotkeys.length) {
            addWindowEvents();
        }
    }

    function addWindowEvents() {
        window.addEventListener('keydown', checkKey, false);
        window.addEventListener('keyup', resetFoundHotKey, false);
    }

    function removeWindowEvents() {
        window.removeEventListener('keydown', checkKey, false);
        window.removeEventListener('keyup', resetFoundHotKey, false);
    }

    function resetFoundHotKey() {
        foundHotKey = false;
    }

    function checkKey(e) {
        if (foundHotKey) {
            return;
        }

        hotkeys.some(function(hotkey) {
            if (hotkey.ctrlKey == e.ctrlKey &&
                hotkey.shiftKey == e.shiftKey &&
                hotkey.altKey == e.altKey &&
                hotkey.charCode == e.charCode
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
