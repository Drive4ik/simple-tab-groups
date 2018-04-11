(async function() {
    'use strict';

    let hotkeys = [],
        foundHotKey = false,
        changeHotkeysListener = function(request, sender) {
            if (sender.tab && sender.tab.incognito) {
                return;
            }

            if (request.updateHotkeys) {
                reloadHotKeys().then(init);
            }
        };

    browser.runtime.onMessage.addListener(changeHotkeysListener);

    async function reloadHotKeys() {
        let options = await browser.storage.local.get({
            hotkeys: [{
                ctrlKey: true,
                shiftKey: false,
                altKey: false,
                key: '`',
                keyCode: 192,
                action: {
                    id: 'load-next-group',
                },
            }, {
                ctrlKey: true,
                shiftKey: true,
                altKey: false,
                key: '~',
                keyCode: 192,
                action: {
                    id: 'load-prev-group',
                },
            }, ],
        });

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
                    })
                    .then(function(response) {
                        if (response && response.unsubscribe) {
                            resetWindowEvents();
                            browser.runtime.onMessage.removeListener(changeHotkeysListener);
                        }
                    });

                return true;
            }
        });
    }

})();
