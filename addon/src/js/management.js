(function() {
    'use strict';

    let extensions = {};

    async function init() {
        console.log('START management.init');

        let addons = await browser.management.getAll();

        addons
            .filter(({type}) => type === browser.management.ExtensionType.EXTENSION)
            .forEach(ext => extensions[ext.id] = ext);

        browser.management.onEnabled.addListener(onEnabled);
        browser.management.onDisabled.addListener(onDisabled);
        browser.management.onInstalled.addListener(onInstalled);
        browser.management.onUninstalled.addListener(onUninstalled);

        console.log('STOP management.init');
    }

    async function onEnabled({id, type}) {
        if (type !== browser.management.ExtensionType.EXTENSION) {
            return;
        }

        extensions[id].enabled = true;

        await utils.wait(100);

        extensions[id] = await browser.management.get(id);

        detectConflictedExtensions();
    }

    function onDisabled({id, type}) {
        if (type !== browser.management.ExtensionType.EXTENSION) {
            return;
        }

        extensions[id].enabled = false;
    }

    async function onInstalled({id, type}) {
        if (type !== browser.management.ExtensionType.EXTENSION) {
            return;
        }

        await utils.wait(100);

        extensions[id] = await browser.management.get(id);

        detectConflictedExtensions();
    }

    function onUninstalled({id, type}) {
        if (type !== browser.management.ExtensionType.EXTENSION) {
            return;
        }

        delete extensions[id];
    }

    function isEnabled(id) {
        return extensions[id]?.enabled;
    }

    async function detectConflictedExtensions() {
        if (CONFLICTED_EXTENSIONS.some(isEnabled)) {
            await openPopup('extensions-that-conflict-with-stg');
        }
    }

    function getExtensionIcon({icons} = {}) {
        if (Array.isArray(icons)) {
            let maxSize = Math.max(...icons.map(({size}) => size)),
                {url} = icons.find(icon => icon.size === maxSize);

            return url;
        }

        return '/icons/extension-generic.svg';
    }

    function getExtensionByUUID(uuid) {
        if (!uuid) {
            return;
        }

        for (let i in extensions) {
            if (extensions[i]?.hostPermissions?.some(url => url.includes(uuid))) {
                return extensions[i];
            }
        }
    }

    window.Management = {
        init,

        isEnabled,
        detectConflictedExtensions,
        getExtensionIcon,
        getExtensionByUUID,
    };

})();
